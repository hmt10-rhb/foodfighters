// Optional: `node serve.js` then open http://localhost:8080 — the game also works by double-clicking index.html
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff' };
const PORT = 8080;

http.createServer((req, res) => {
  const file = path.join(__dirname, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!file.startsWith(__dirname)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    // ETag/Last-Modified (2026-07-24): mirrors what Vercel already sends
    // for every static asset in production — added so the force-reload
    // overlay's version check (checkForUpdate()/captureBootVersion() in
    // game.js, which compares game.js's own ETag) has something real to
    // read while testing locally too. Without these headers the check
    // silently never fires (bootGameJsVersion stays null forever) — never
    // noticed before since production always had them, only this local
    // dev server lacked them.
    const etag = '"' + crypto.createHash('md5').update(data).digest('hex') + '"';
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'ETag': etag,
      'Last-Modified': fs.statSync(file).mtime.toUTCString(),
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}).listen(PORT, () => console.log(`Food Fighters running at http://localhost:${PORT}`));
