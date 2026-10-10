// Local preview of the gallery against the sample data (or any archive.json).
// Usage: node site-src/dev/preview.mjs [archive.json] [--ledger kaizen.json] [--port 4173]
// The swarm's diary is at /kaizen/ (sample ledger: site-src/dev/kaizen.sample.json).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from '../../scripts/lib/common.mjs';
import { SITE_SRC, readSource, renderIndex, render404, renderKaizen } from './render.mjs';

const args = parseArgs();
const file = args._[0] || path.join(SITE_SRC, 'dev', 'archive.sample.json');
const ledgerFile = typeof args.ledger === 'string' ? args.ledger : path.join(SITE_SRC, 'dev', 'kaizen.sample.json');
const port = Number(args.port) || 4173;
const types = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const archive = JSON.parse(fs.readFileSync(file, 'utf8'));
  const send = (status, type, body) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
  if (url.pathname === '/' || url.pathname === '/index.html') return send(200, 'text/html; charset=utf-8', renderIndex(readSource('index.template.html'), archive, { siteUrl: `http://localhost:${port}/` }));
  if (url.pathname === '/404.html') return send(200, 'text/html; charset=utf-8', render404(readSource('404.template.html'), archive, { siteUrl: `http://localhost:${port}/` }));
  if (url.pathname === '/kaizen/' || url.pathname === '/kaizen/index.html') {
    return send(200, 'text/html; charset=utf-8', renderKaizen(readSource('kaizen.template.html'), archive, JSON.parse(fs.readFileSync(ledgerFile, 'utf8'))));
  }
  if (url.pathname === '/archive.json') return send(200, 'application/json', JSON.stringify(archive));
  const asset = url.pathname.match(/^\/assets\/((?:gallery|kaizen)\.(?:css|js))$/);
  if (asset) return send(200, types[path.extname(asset[1])], readSource(asset[1]));
  if (url.pathname.startsWith('/d/')) return send(200, 'text/html; charset=utf-8', '<!doctype html><title>Sample project</title><p>Sample project page. <a href="../../">Back</a>');
  return send(404, 'text/plain', 'not found');
}).listen(port, () => console.error(`gallery preview on http://localhost:${port}/`));
