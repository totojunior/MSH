/* serve.js — 로컬 확인용 정적 서버. utf-8 을 명시적으로 선언한다.
 * python -m http.server 는 charset 을 안 붙여서, 한국어 로케일 브라우저가
 * EUC-KR 로 추측하고 본문을 전부 깨뜨린다.
 *
 *   node SR2/NZ/src/serve.js      ->  http://127.0.0.1:8767/
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');   // .../SR2/NZ
const PORT = 8767;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
};

http
  .createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    if (rel.endsWith('/')) rel += 'index.html';
    const f = path.join(ROOT, rel);
    if (!f.startsWith(ROOT)) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    fs.readFile(f, (e, d) => {
      if (e) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('not found: ' + rel);
      }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(d);
    });
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log('serving ' + ROOT + ' on http://127.0.0.1:' + PORT + '/ (utf-8)');
  });
