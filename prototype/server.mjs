// Zero-dependency static server for the clickable UX prototype (no npm install needed).
// Usage: node prototype/server.mjs   →   http://localhost:4321
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const PORT = Number(process.env.PORT ?? 4321);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const FILES = new Set(['index.html', 'app.css', 'app.js', 'legacy.html']);

// Send the same security headers as production (vercel.json) so CSP problems show up locally.
const vercel = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
const SECURITY_HEADERS = Object.fromEntries(
  (vercel.headers?.find((h) => h.source === '/(.*)')?.headers ?? []).map(({ key, value }) => [key.toLowerCase(), value]),
);

createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!FILES.has(name)) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    return;
  }
  const ext = name.slice(name.lastIndexOf('.'));
  const body = await readFile(new URL(`./${name}`, import.meta.url));
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': TYPES[ext] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Prototype running at http://localhost:${PORT}`);
});
