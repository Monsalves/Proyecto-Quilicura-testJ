import http from 'node:http';
import { readFile } from 'node:fs/promises';

const port = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 4173);
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
};

function contentType(pathname) {
  if (pathname === '/' || pathname === '/index.html') {
    return mime['.html'];
  }
  const extension = pathname.slice(pathname.lastIndexOf('.'));
  return mime[extension] || 'text/plain; charset=utf-8';
}

function fileFor(pathname) {
  if (pathname === '/' || pathname === '/index.html') {
    return new URL('../../index.html', import.meta.url);
  }
  if (pathname.startsWith('/src/frontend/')) {
    return new URL(`../frontend/${pathname.slice('/src/frontend/'.length)}`, import.meta.url);
  }
  return null;
}

const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  const target = fileFor(pathname);
  if (!target) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('not found');
    return;
  }
  try {
    const body = await readFile(target);
    response.writeHead(200, { 'Content-Type': contentType(pathname) });
    response.end(body);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`frontend dev server on http://127.0.0.1:${port}`);
});
