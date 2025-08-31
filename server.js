import express from 'express';
import { pipeBook } from './tokybook.js';

const app = express();
const PORT = 3000;

// serve static files from public/static at root path
app.use(express.static('public/static'));

// root route returns hello world
app.get('/', (req, res) => {
  // send index.html from public directory using absolute path
  res.sendFile(process.cwd() + '/public/index.html');
});

app.get('/download/book', async (req, res) => {
  const { url } = req.query;
  let bookDetails;
  // prepare response as a streaming attachment; set disposition once details are available
  // onError will write error messages into the response and end it
  const onError = (err) => {
    try {
      console.error('stream error:', err);
      if (!res.headersSent) {
        res.setHeader('content-type', 'text/plain');
        res.statusCode = 500;
      }
      // write the error and end the response
      res.write(`ERROR: ${err && err.message ? err.message : String(err)}\n`);
    } catch (writeErr) {
      // best-effort
      console.error('failed to write error to response', writeErr);
    } finally {
      try { res.end(); } catch (e) {}
    }
  };

  try {
    // call pipeBook with the url and a writable stream
    const { done, abort } = pipeBook(url, res, (details) => {
      console.log(details);
      bookDetails = details;
      // set filename when details arrive
      if (!res.headersSent) {
        res.setHeader('content-disposition', `attachment; filename="${bookDetails.details.title}.zip"`);
      }
    }, (track, duration) => {
      console.log(`finished track ${track.number} in ${Math.round(duration / 1000)}s`);
    }, onError);

    // if client disconnects, abort work
    req.on('close', () => {
      console.log('client disconnected, aborting')
      try { abort() } catch (e) { console.error('abort failed', e) }
      try { res.destroy(); } catch (e) {}
    })

    await done
    if (bookDetails && bookDetails.details) {
      console.log(`finished downloading book: ${bookDetails.details.title}`);
    }
  } catch (err) {
    // final catch for unexpected thrown errors
    onError(err || 'unknown error');
  }
});

// start server
app.listen(PORT, () => {
  // log server start
  console.log(`server running on port ${PORT}`);
});