import { spawn } from 'child_process'
import { Readable, PassThrough } from 'stream'
import { finished } from 'stream/promises'
import archiver from 'archiver';


function decodeHtmlEntities(str) {
  return str.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>');
}

export async function getBookDetails(url) {
  const headers = {
    'referer': url,
    'x-audiobook-id': '',
    'x-playback-token': ''
  };
  const details = {
    title: '',
    author: '',
    narrators: [],
    cover: '',
  }
  console.log("getting details for: ", url)
  let html = await (await fetch({
    url,
    headers,
  })).text();
  const secrets = html.match(/data-book-id="(.*)"\s*data-token="(.*)"/);
  headers['x-audiobook-id'] = secrets[1];
  headers['x-playback-token'] = secrets[2];
  details.title = decodeHtmlEntities(html.match(/<title>(.*?)<\/title>/)[1]);
  details.author = decodeHtmlEntities(html.match(/<!-- Author Info -->.*?>([^<]+)<\/p>/ms)[1]);
  const narratorsGroup = html.match(/Narrators:<\/span>.*?<\/div>/ms);
  if (narratorsGroup) {
    details.narrators = [...narratorsGroup[0].matchAll(/<a[^>]*>(.*?)<\/a>/g)].map(m => decodeHtmlEntities(m[1]));
  }
  const coverPath = html.match(/<!-- Left Column: Cover Image -->.*?<img src="(.*?)".*?<\/div>/ms)[1];
  details.cover = coverPath.startsWith('http') ? coverPath : 'https://tokybook.com' + coverPath;
  return { headers, details }
}

function isMp3(track) {
  if (track.src.endsWith('.mp3'))
    return true;
  return false;
}

export async function getTracks(headers, details) {
  const html = await (await fetch({
    url: 'https://tokybook.com/player',
    headers,
  })).text();

  // track.src -> playlist file or mp3
  let tracks = [...html.matchAll(/data-track-src="([^\"]+)/g)]
  // attach the request headers to each track so downstream code (ffmpeg/fetch)
  // can reuse them when fetching playlist/segments
  tracks = tracks.map(([_, src], i) => ({
    src: isMp3({ src }) ? src : 'https://tokybook.com' + src,
    name: details ? `${details.title} - Chapter ${i + 1}` : src.split('/').pop().split('.').slice(0, -1).join('') + '.mp3',
    isMp3: isMp3({ src }),
    number: i + 1,
    headers
  }));

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

  console.log("compiling track: ", track.name)

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

export function pipeBook(url, writableStream, onDetails, onTrackFinish, onError) {
  // return an object with a done promise and abort function so callers can cancel
  const activeProcs = new Set()
  let archive

  const done = (async () => {
    // get details and tracks
    let headers, details
    try {
      const result = await getBookDetails(url)
      headers = result.headers
      details = result.details
    } catch (err) {
      if (onError) onError(err)
      throw err
    }
    if (onDetails) onDetails({ headers, details })

    let tracks
    try {
      tracks = await getTracks(headers, details)
    } catch (err) {
      if (onError) onError(err)
      throw err
    }

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
        try { archive.abort(); } catch (e) {}
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
        try { archive.abort(); } catch (e) {}
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
    try { if (archive) archive.abort() } catch (e) {}
    for (const p of activeProcs) {
      try { p._killedByAbort = true; p.kill('SIGTERM') } catch (e) {}
    }
    // give processes a moment, then force kill
    setTimeout(() => {
      for (const p of activeProcs) {
        try { if (!p.killed) { p._killedByAbort = true; p.kill('SIGKILL') } } catch (e) {}
      }
      activeProcs.clear()
    }, 250)
  }

  return { done, abort }
}
