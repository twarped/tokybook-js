import { spawn } from 'child_process'
import { Readable, PassThrough } from 'stream'
import { finished } from 'stream/promises'
import archiver from 'archiver';

export async function getBookDetails(url) {
  const slug = JSON.stringify(url.match(/tokybook.com\/post\/([^\/?]+)/)[1]);
  console.log("getting details for: ", slug)
  return await (await fetch({
    url: 'https://tokybook.com/api/v1/search/post-details',
    method: "POST",
    headers: {
      'content-type': 'application/json'
    },
    body: `{"dynamicSlugId":${slug}}`
  })).json()
}

function isMp3(src) {
  if (src.startsWith('http://') || src.startsWith('https://'))
    return true;
  return false;
}

export function startTokyBookProxy(port = 0) {
  return Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname + url.search;

      // modify request headers in-place
      req.headers.set("host", "tokybook.com");
      // add custom authentication header for tokybook
      req.headers.set("x-track-src", path);
      // tell upstream: no compression
      req.headers.set("accept-encoding", "identity");

      return fetch(`https://tokybook.com${path}`, req);
    }
  });
}
// origin is just the http://localhost:port to tokybook proxy
export async function getTracks(bookDetails, origin) {
  // track.src -> playlist file or mp3
  let playlist = await (await fetch({
    url: 'https://tokybook.com/api/v1/playlist',
    method: 'post',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      audioBookId: bookDetails.audioBookId,
      postDetailToken: bookDetails.postDetailToken
    })
  })).json()

  // attach the request headers to each track so downstream code (ffmpeg/fetch)
  // can reuse them when fetching playlist/segments
  let tracks = playlist.tracks.map(({ src }, i, _isMp3) => (_isMp3 = isMp3(src), src = _isMp3 ? src : `${origin}/api/v1/public/audio/${src}`, {
    src,
    name: bookDetails ? `${bookDetails.title} - Chapter ${i + 1}.mp3` : src.split('/').pop().split('.').slice(0, -1).join('') + '.mp3',
    number: i + 1,
    isMp3: _isMp3,
    headers: {
      'x-audiobook-id': playlist.audioBookId,
      'x-stream-token': playlist.streamToken,
    }
  }))

  return tracks;
}

export async function compileTrack(track, onError) {
  // stream raw mp3 if the track is already an mp3
  if (track.isMp3) {
    try {
      const response = await fetch(track.src, { headers: track.headers })
      if (!response.ok) {
        const err = new Error(`failed to fetch track ${track.src}: ${response.status} ${response.statusText}`)
        if (onError) onError(err)
        throw err
      }
      // return a Readable from the web response; no ffmpeg proc to manage here
      return Readable.fromWeb(response.body)
    } catch (err) {
      if (onError) onError(err)
      throw err
    }
  }

  // build header string for ffmpeg (CRLF-terminated lines)
  const headersObj = track.headers || {}
  const headerLines = Object.entries(headersObj).map(([k, v]) =>
    k.split('-').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('-') + ': ' + v
  ).join('\r\n') + (Object.keys(headersObj).length ? '\r\n' : '')

  console.log('compiling track: ', track.name)

  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    // pass headers to ffmpeg so it and the segment requests include the tokens
    ...(headerLines ? ['-headers', headerLines] : []),
    '-i', track.src,
    '-vn', // no video
    '-c:a', 'libmp3lame',
    '-b:a', '128k',
    '-f', 'mp3',
    '-' // output to stdout
  ])

  // handle ffmpeg errors and forward to onError
  ffmpeg.on('error', (err) => { if (onError) onError(err) })
  if (ffmpeg.stderr) {
    ffmpeg.stderr.on('data', (c) => console.error('ffmpeg:', String(c)))
  }
  // handle process close: if killed by signal, assume abort and don't surface as error
  ffmpeg.on('close', (code, signal) => {
    // if we previously marked this process as killed by our abort flow,
    // treat this as intentional and don't surface an error.
    if (ffmpeg._killedByAbort) {
      console.log('ffmpeg closed after abort')
      return
    }
    if (signal) {
      // process terminated by signal (likely from abort); don't call onError
      console.log(`ffmpeg killed by signal ${signal}`)
      return
    }
    if (code !== 0) {
      const err = new Error(`ffmpeg exited with code ${code}`)
      if (onError) onError(err)
    }
  })

  // pipe ffmpeg stdout through a PassThrough so callers get a controllable stream
  const pass = new PassThrough()
  if (ffmpeg.stdout) ffmpeg.stdout.pipe(pass)
  // attach the ffmpeg process to the stream so callers can kill it
  pass.ffmpegProc = ffmpeg

  return pass
}

// origin is just the tokybook proxy http://hostname:port
export function pipeBook(url, writableStream, onDetails, onTracks, onTrackFinish, onError, origin) {
  // return an object with a done promise and abort function so callers can cancel
  const activeProcs = new Set()
  let archive

  const done = (async () => {
    // get details and tracks
    let bookDetails
    try {
      bookDetails = await getBookDetails(url)
    } catch (err) {
      if (onError) onError(err)
      throw err
    }
    if (onDetails) onDetails(bookDetails)

    let tracks
    try {
      tracks = await getTracks(bookDetails, origin)
    } catch (err) {
      if (onError) onError(err)
      throw err
    }
    if (onTracks) onTracks(tracks)

    // create zip archive
    archive = archiver('zip', { zlib: { level: 9 } })
    archive.pipe(writableStream)

    archive.on('warning', (w) => { if (onError) onError(w) })
    archive.on('error', (err) => {
      // suppress expected QUEUECLOSED errors during an intentional abort
      if (isAborting && err && err.code === 'QUEUECLOSED') return
      if (onError) onError(err)
    })

    for (let i = 0; i < tracks.length; i++) {
      const start = Date.now()
      const track = tracks[i]
      let stream
      try {
        stream = await compileTrack(track, onError)
      } catch (err) {
        if (onError) onError(err)
        try { archive.abort(); } catch (e) { }
        throw err
      }

      // if stream has an ffmpeg process attached, track it for abort
      if (stream && stream.ffmpegProc) activeProcs.add(stream.ffmpegProc)

      // append each track as a file in the zip
      archive.append(stream, { name: track.name })

      // wait for this stream to be fully consumed or error using finished()
      try {
        if (stream && typeof stream.pipe === 'function') {
          await finished(stream)
        }
      } catch (err) {
        if (onError) onError(err)
        try { archive.abort(); } catch (e) { }
        throw err
      } finally {
        // cleanup tracked proc
        if (stream && stream.ffmpegProc) activeProcs.delete(stream.ffmpegProc)
      }

      const duration = Date.now() - start
      if (onTrackFinish) onTrackFinish(track, duration, tracks)
    }

    try {
      await archive.finalize()
    } catch (err) {
      if (onError) onError(err)
      throw err
    }
  })()

  let isAborting = false
  const abort = () => {
    isAborting = true
    try { if (archive) archive.abort() } catch (e) { }
    for (const p of activeProcs) {
      try { p._killedByAbort = true; p.kill('SIGTERM') } catch (e) { }
    }
    // give processes a moment, then force kill
    setTimeout(() => {
      for (const p of activeProcs) {
        try { if (!p.killed) { p._killedByAbort = true; p.kill('SIGKILL') } } catch (e) { }
      }
      activeProcs.clear()
    }, 250)
  }

  return { done, abort }
}
