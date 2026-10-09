#!/usr/bin/env node
// Tiny static file server for QA runs.
//   serve.mjs <dir> [--port N]
// Binds to 127.0.0.1 only, serves nothing outside <dir>, never caches, and prints one JSON line
// ({ok, url, port, dir}) once it is listening. Importable: startServer() is what browser-check uses.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, print, die } from '../lib/common.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

export function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** Resolve a request path to a file inside `root`, or null if it escapes, is missing or is not a file. */
function resolveFile(root, urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (rel.includes('\0')) return null;
  let full = path.join(root, path.normalize('/' + rel));
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  try {
    let st = fs.statSync(full);
    if (st.isDirectory()) {
      full = path.join(full, 'index.html');
      st = fs.statSync(full);
    }
    // realpath check so a symlink inside the project cannot serve files from elsewhere
    const real = fs.realpathSync(full);
    if (real !== root && !real.startsWith(root + path.sep)) return null;
    return st.isFile() ? { file: real, size: st.size } : null;
  } catch {
    return null;
  }
}

/**
 * Start serving `dir`. `onRequest({method, path, status, bytes})` is called once per response.
 * Resolves to {server, port, url, dir, close()}.
 */
export function startServer(dir, { port = 0, host = '127.0.0.1', onRequest } = {}) {
  const root = fs.realpathSync(path.resolve(dir));
  if (!fs.statSync(root).isDirectory()) throw new Error(`not a directory: ${dir}`);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const done = (status, bytes) => {
      if (onRequest) {
        try {
          onRequest({ method: req.method, path: u.pathname, status, bytes });
        } catch { /* a faulty observer must not break serving */ }
      }
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return done(405, 0);
    }
    const hit = resolveFile(root, u.pathname);
    if (!hit) {
      const body = 'Not found';
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body);
      return done(404, 0);
    }
    res.writeHead(200, {
      'Content-Type': mimeFor(hit.file),
      'Content-Length': hit.size,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') {
      res.end();
      return done(200, 0);
    }
    const stream = fs.createReadStream(hit.file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
    res.on('close', () => done(200, hit.size));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({
        server,
        port: addr.port,
        url: `http://${host}:${addr.port}/`,
        dir: root,
        close: () =>
          new Promise((r) => {
            server.close(() => r());
            server.closeAllConnections();
          }),
      });
    });
  });
}

async function main() {
  const flags = parseArgs();
  const dir = flags._[0];
  if (!dir) die('usage: serve.mjs <dir> [--port N]', 2);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) die(`not a directory: ${dir}`, 2);
  const port = flags.port === undefined ? 0 : Number(flags.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) die(`bad --port value: ${flags.port}`, 2);
  let srv;
  try {
    srv = await startServer(dir, { port });
  } catch (err) {
    die(`cannot listen: ${err.message}`, 1);
  }
  print({ ok: true, url: srv.url, port: srv.port, dir: srv.dir });
  const stop = () => srv.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => die(err.stack || String(err)));
}
