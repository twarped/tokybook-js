// minimal client: open the server download endpoint in a new tab so the browser handles streaming
const input = document.getElementById('url-input');
const btn = document.getElementById('download-btn');

function startBrowserDownload(url) {
  const params = new URLSearchParams({ url });
  const downloadUrl = `/download/book?${params.toString()}`;
  // open in new tab/window so the browser streams to disk and respects content-disposition
  const w = window.open(downloadUrl, '_blank', 'noopener');
  if (!w) {
    // popup blocked; fallback to creating an anchor and clicking it
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}

btn.addEventListener('click', () => {
  const url = input.value.trim();
  if (!url) { setStatus('please enter a valid url'); return; }
  startBrowserDownload(url);
});

input.addEventListener('keydown', (e) => { if (e.key === 'Enter') btn.click(); });
