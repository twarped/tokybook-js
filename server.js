import express from 'express';
import { pipeBook, startTokyBookProxy } from './tokybook.js';

// start the tokybook proxy server
const tokybookProxy = startTokyBookProxy()
const tokybookProxyOrigin = `http://${tokybookProxy.hostname}:${tokybookProxy.port}`
console.log('tokybook proxy running on:', tokybookProxyOrigin)

const app = express();
const PORT = 3000;

// serve static files from public/static at root path
app.use(express.static('public/static'));

// root route returns hello world
app.get('/', (req, res) => {
  // send index.html from public directory using absolute path
  res.sendFile(import.meta.dir + '/public/index.html');
});

app.get('/download/book', async (req, res) => {
  const { url } = req.query;

  let duration = 0;
  let start = Date.now();
  let bookDetails;
  // prepare response as a streaming attachment; set disposition once details are available
  // make onError idempotent so multiple callers don't double-report the same error
  let errorReported = false
  const onError = (err) => {
    if (errorReported) return
    errorReported = true
    try {
      console.error('stream error:', err);
      if (!res.headersSent) {
        res.setHeader('content-type', 'text/plain');
        res.statusCode = 500;
      }
      // write the error and end the response
      if (res.writableEnded) return;
      res.write(`ERROR: ${err && err.message ? err.message : String(err)}\n`);
    } catch (writeErr) {
      // best-effort
      console.error('failed to write error to response', writeErr);
    } finally {
      try { res.end(); } catch (e) { }
    }
  };

  try {
    // call pipeBook with the url and a writable stream
    const { done, abort } = pipeBook(url, res, details => {
      bookDetails = details;
      console.log(bookDetails);
      // set filename when details arrive
      if (!res.headersSent) {
        res.setHeader('content-disposition', `attachment; filename="${bookDetails.title.replace(/[^A-Za-z0-9\-\.\_]/g, '')}.zip"; filename*=UTF-8''${encodeURIComponent(bookDetails.title)}.zip`);
      }
    }, tracks => {
      console.log(`found ${tracks.length} tracks${bookDetails ? ` for book: ${bookDetails.title}` : ''}`);
    }, (track, duration) => {
      console.log(`finished track ${track.number} in ${Math.round(duration / 1000)}s`);
    }, onError, tokybookProxyOrigin);

    // handle client disconnects; only abort if response not finished
    req.on('close', () => {
      if (!res.writableFinished) {
        console.log('aborting due to premature disconnect');
        abort();
      }
    })

    await done
    duration = Date.now() - start;
    if (bookDetails) {
      console.log(`finished downloading book: ${bookDetails.title} in ${Math.round(duration / (100 * 60)) / 10} minutes`);
    }
  } catch (err) {
    // final catch for unexpected thrown errors
    onError(err || 'unknown error');
  }
});

// start server
app.listen(PORT, () => {
  // log server start
  console.log('website running on port', PORT);
  console.log(`ctrl/cmd-click here -> http://localhost:${PORT}/`)
});
