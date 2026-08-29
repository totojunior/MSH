/* Local test server that declares utf-8, so the browser does not guess the
   encoding from the OS locale. python -m http.server does not, and a Korean
   locale guesses EUC-KR, which mangles every em dash in the copy. */
const http=require('http'),fs=require('fs'),path=require('path');
const ROOT=path.resolve(__dirname,'..');
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8'};
http.createServer((req,res)=>{
  const f=path.join(ROOT,decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/,'')||'trolley.html');
  fs.readFile(f,(e,d)=>{
    if(e){res.writeHead(404);return res.end('not found');}
    res.writeHead(200,{'Content-Type':TYPES[path.extname(f)]||'application/octet-stream','Cache-Control':'no-store'});
    res.end(d);
  });
}).listen(8766,'127.0.0.1',()=>console.log('serving '+ROOT+' on http://127.0.0.1:8766 (utf-8)'));
