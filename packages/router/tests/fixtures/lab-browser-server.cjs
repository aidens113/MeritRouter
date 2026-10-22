const http = require('node:http');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=', 'base64');
const server=http.createServer((req, res) => {
  const route = new URL(req.url, 'http://127.0.0.1').pathname;
  const foreign = `http://127.0.0.1:${process.env.TRAP_PORT}`;
  if(route==='/release'){res.end('released');setTimeout(()=>{server.close();setInterval(()=>{},1000)},10);return;}
  if (route === '/redirect') { res.writeHead(302, {location:foreign+'/redirect'});res.end();return; }
  if (route === '/style.css') { res.writeHead(200, {'content-type':'text/css'});res.end('body{background:rgb(240,248,255);font-family:sans-serif} h1{color:navy}');return; }
  if (route === '/pixel.png') { res.writeHead(200, {'content-type':'image/png'});res.end(png);return; }
  if (route === '/slow') { res.writeHead(200, {'content-type':'text/html'});res.flushHeaders();setTimeout(()=>res.end('<h1>slow</h1>'),10000);return; }
  res.writeHead(200, {'content-type':'text/html; charset=utf-8'});
  if (route === '/large') {res.end('<h1>'+ 'x'.repeat(10000)+'</h1>');return;}
  if (route === '/foreign') {res.end(`<title>Foreign fixture</title><h1 id="message">Static fixture</h1><img src="${foreign}/image"><link rel="preconnect" href="${foreign}">`);return;}
  if (route === '/hydrated') {res.end(`<title>Hydration fixture</title><h1 id="base">Server markup</h1><script>document.body.innerHTML+='<p id="hydrated">Hydrated</p>';fetch('${foreign}/script');new WebSocket('ws://127.0.0.1:${process.env.TRAP_PORT}/ws');</script>`);return;}
  res.end('<!doctype html><html><head><title>Static fixture</title><link rel="stylesheet" href="/style.css"></head><body><h1 id="message">Hello static lab</h1><img src="/pixel.png"></body></html>');
}).listen(Number(process.env.PORT),'127.0.0.1');
