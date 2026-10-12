// Tests for the headless-browser QA harness, the static server, the PNG optimizer and the page shell.
// Everything runs against the REAL installed Chromium (PLAYWRIGHT_BROWSERS_PATH, default /opt/pw-browsers).
// Fixtures live in tests/fixtures/qa-*; projects that get a thumbnail are copied to a temp dir first.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadFactor } from './helpers/cpu.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CHECK = path.join(ROOT, 'scripts', 'qa', 'browser-check.mjs');
const SERVE = path.join(ROOT, 'scripts', 'qa', 'serve.mjs');
const SHELL = path.join(ROOT, 'ops', 'templates', 'page-shell.html');
const EXAMPLE = path.join(ROOT, 'ops', 'templates', 'project.json.example');
const README = path.join(ROOT, 'ops', 'templates', 'project.json.README.md');
const FIXTURES = path.join(HERE, 'fixtures');
const BROWSERS = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sed-qa-test-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const { startServer, mimeFor } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'qa', 'serve.mjs')).href);
const png = await import(pathToFileURL(path.join(ROOT, 'scripts', 'qa', 'png-optimize.mjs')).href);
const { isTopLevelNavigation } = await import(pathToFileURL(CHECK).href);

/* ------------------------------------------------------------------------------------------------
 * helpers
 * ---------------------------------------------------------------------------------------------- */

let counter = 0;
const scratch = (name) => {
  const dir = path.join(TMP, `${name}-${++counter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const copyFixture = (name) => {
  const dest = path.join(scratch('proj'), name);
  fs.cpSync(path.join(FIXTURES, `qa-${name}`), dest, { recursive: true });
  return dest;
};
const fixture = (name) => path.join(FIXTURES, `qa-${name}`);

// The suites that drive Chromium wait on the browser and on fixed in-page timers (a whole run is about 3 s of CPU in 6 to 19 s of wall time).
// Every run has its own fixture copy, --out directory and process mark, so these suites run side by side (and the independent tests of two of
// them in pairs): 193 s of waiting became about 45. They are registered together under one parent at the end of the file.
const browserSuites = [];
const browserSuite = (name, opts, fn) => browserSuites.push(typeof opts === 'function' ? { name, opts: {}, fn: opts } : { name, opts, fn });

/**
 * Every CLI run gets this marker in its environment; Chromium and its helpers inherit it, so any live process
 * carrying it after a run has finished is a leak (other test files may be running their own browsers).
 */
const MARK = `sed-qa-test-${process.pid}-${Date.now()}`;
let runCounter = 0;

/** The live processes (other than this one) whose environment carries `mark`. Every runCheck() has a mark of its own, so suites that run side by side do not see each other's browsers. */
function markedPids(mark = MARK) {
  const found = [];
  for (const pid of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    if (Number(pid) === process.pid) continue;
    try {
      if (fs.readFileSync(`/proc/${pid}/environ`, 'latin1').includes(`SED_QA_MARK=${mark}\0`)) found.push(pid);
    } catch { /* exited, or not ours to read */ }
  }
  return found;
}

async function waitForNoLeaks(mark = MARK, ms = 5000) {
  const end = Date.now() + ms;
  let left = markedPids(mark);
  while (left.length && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 200));
    left = markedPids(mark);
  }
  return left;
}

/** Run browser-check as a CLI. Resolves {code, json, stderr, ms, out, mark} (`mark` is what waitForNoLeaks() looks for after this run). */
function runCheck(args, { env = {}, timeoutMs = 120000, noOut = false } = {}) {
  const out = scratch('out');
  const full = noOut || args.includes('--out') ? args : [...args, '--out', out];
  const started = Date.now();
  const mark = `${MARK}-run${++runCounter}`;
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [CHECK, ...full],
      { env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: BROWSERS, SED_QA_MARK: mark, ...env }, timeout: timeoutMs, maxBuffer: 32 << 20 },
      (err, stdout, stderr) => {
        let json;
        try {
          json = JSON.parse(stdout);
        } catch (e) {
          return reject(new Error(`stdout is not one JSON document: ${e.message}\n--- stdout\n${stdout.slice(0, 2000)}\n--- stderr\n${stderr.slice(0, 2000)}`));
        }
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, json, stderr, ms: Date.now() - started, out, mark });
      },
    );
  });
}

/** Decode a PNG (color types 2 and 3, all bit depths used here) to RGBA, verifying every chunk CRC. */
function decodePng(buf) {
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature');
  let pos = 8;
  let width;
  let height;
  let depth;
  let type;
  let plte = null;
  const idat = [];
  let sawEnd = false;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const name = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    assert.equal(buf.readUInt32BE(pos + 8 + len), zlib.crc32(buf.subarray(pos + 4, pos + 8 + len)), `${name} CRC`);
    if (name === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      type = data[9];
    } else if (name === 'PLTE') plte = data;
    else if (name === 'IDAT') idat.push(data);
    else if (name === 'IEND') sawEnd = true;
    pos += 12 + len;
  }
  assert.ok(sawEnd, 'IEND present');
  const channels = type === 2 ? 3 : 1;
  const bpp = Math.max(1, (channels * depth) / 8);
  const stride = Math.ceil((width * channels * depth) / 8);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  assert.equal(raw.length, (stride + 1) * height, 'decompressed size');
  const rows = [];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const row = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let add = 0;
      if (f === 1) add = a;
      else if (f === 2) add = b;
      else if (f === 3) add = (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[i] = (row[i] + add) & 255;
    }
    rows.push(row);
    prev = row;
  }
  const rgba = Buffer.alloc(width * height * 4, 255);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (type === 2) {
        rgba[o] = rows[y][x * 3];
        rgba[o + 1] = rows[y][x * 3 + 1];
        rgba[o + 2] = rows[y][x * 3 + 2];
      } else {
        const perByte = 8 / depth;
        const byte = rows[y][Math.floor(x / perByte)];
        const idx = depth === 8 ? byte : (byte >> (8 - depth * ((x % perByte) + 1))) & ((1 << depth) - 1);
        rgba[o] = plte[idx * 3];
        rgba[o + 1] = plte[idx * 3 + 1];
        rgba[o + 2] = plte[idx * 3 + 2];
      }
    }
  }
  return { width, height, depth, type, rgba, paletteSize: plte ? plte.length / 3 : 0 };
}

const pixel = (img, x, y) => [...img.rgba.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)];
const errorCodes = (r) => r.json.errors.map((e) => e.split(':')[0]);
const warningCodes = (r) => r.json.warnings.map((e) => e.split(':')[0]);

/* ------------------------------------------------------------------------------------------------
 * serve.mjs
 * ---------------------------------------------------------------------------------------------- */

describe('serve.mjs', () => {
  const dir = scratch('site');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>hi</h1>');
  fs.writeFileSync(path.join(dir, 'sub', 'index.html'), '<h1>sub</h1>');
  fs.writeFileSync(path.join(dir, 'app.js'), 'export {};');
  fs.writeFileSync(path.join(dir, 'data.json'), '{"a":1}');
  fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([1, 2, 3]));
  const secret = path.join(scratch('secret'), 'secret.txt');
  fs.writeFileSync(secret, 'top secret');
  fs.symlinkSync(secret, path.join(dir, 'leak.txt'));
  const seen = [];
  let srv;
  before(async () => {
    srv = await startServer(dir, { onRequest: (r) => seen.push(r) });
  });
  after(() => srv.close());

  const get = (p, init) => fetch(srv.url + p.replace(/^\//, ''), init);

  test('serves files with the right types and no caching', async () => {
    const root = await get('/');
    assert.equal(root.status, 200);
    assert.match(root.headers.get('content-type'), /^text\/html/);
    assert.equal(root.headers.get('cache-control'), 'no-store');
    assert.equal(await root.text(), '<h1>hi</h1>');
    assert.equal(await (await get('/sub/')).text(), '<h1>sub</h1>');
    assert.match((await get('/app.js')).headers.get('content-type'), /^text\/javascript/);
    assert.match((await get('/data.json')).headers.get('content-type'), /^application\/json/);
    assert.equal((await get('/blob.bin')).headers.get('content-type'), 'application/octet-stream');
    assert.equal(mimeFor('x.WOFF2'), 'font/woff2');
  });

  test('404s, HEAD and method handling', async () => {
    assert.equal((await get('/nope.html')).status, 404);
    const head = await get('/app.js', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), '10');
    assert.equal((await get('/app.js', { method: 'POST', body: 'x' })).status, 405);
    assert.ok(seen.some((r) => r.status === 404 && r.path === '/nope.html'));
  });

  test('cannot escape the served directory', async () => {
    for (const p of ['/../secret.txt', '/%2e%2e/%2e%2e/etc/passwd', '/..%2f..%2fetc/passwd', '/sub/../../etc/passwd', '/%00', '/leak.txt']) {
      const res = await get(p);
      assert.equal(res.status, 404, p);
      assert.doesNotMatch(await res.text(), /top secret|root:/);
    }
    // a raw request line that tries traversal without any client-side normalisation
    const raw = await new Promise((resolve) => {
      const chunks = [];
      import('node:net').then(({ default: net }) => {
        const s = net.connect(srv.port, '127.0.0.1', () => s.write('GET /../../../../etc/passwd HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
        s.on('data', (d) => chunks.push(d));
        s.on('close', () => resolve(Buffer.concat(chunks).toString()));
      });
    });
    assert.match(raw, /^HTTP\/1\.1 404/);
  });

  test('binds to loopback only and picks a random port', async () => {
    assert.match(srv.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const other = await startServer(dir);
    assert.notEqual(other.port, srv.port);
    await other.close();
  });

  test('CLI prints one JSON document, serves, and stops on SIGTERM', async () => {
    const child = spawn(process.execPath, [SERVE, dir, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const first = await new Promise((resolve, reject) => {
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d;
        try {
          resolve(JSON.parse(buf));
        } catch { /* wait for the rest */ }
      });
      child.on('error', reject);
      setTimeout(() => reject(new Error('serve.mjs printed nothing')), 8000).unref();
    });
    assert.equal(first.ok, true);
    assert.equal((await fetch(first.url)).status, 200);
    const exited = new Promise((r) => child.on('exit', (code, sig) => r({ code, sig })));
    child.kill('SIGTERM');
    const { code } = await exited;
    assert.equal(code, 0);
    await assert.rejects(fetch(first.url));
  });

  test('CLI usage errors exit 2', () => {
    for (const args of [[], [path.join(dir, 'missing')], [dir, '--port', 'abc']]) {
      let status = 0;
      let out = '';
      try {
        execFileSync(process.execPath, [SERVE, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        status = err.status;
        out = err.stdout;
      }
      assert.equal(status, 2, JSON.stringify(args));
      assert.equal(JSON.parse(out).ok, false);
    }
  });
});

/* ------------------------------------------------------------------------------------------------
 * png-optimize.mjs
 * ---------------------------------------------------------------------------------------------- */

describe('png-optimize', () => {
  const W = 64;
  const H = 48;
  const gradient = Buffer.alloc(W * H * 4, 255);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      gradient[o] = (x * 4) & 255;
      gradient[o + 1] = (y * 5) & 255;
      gradient[o + 2] = ((x + y) * 2) & 255;
    }
  }

  test('truecolor encoding round-trips exactly', () => {
    const img = decodePng(png.encodeRgbPng(gradient, W, H));
    assert.equal(img.width, W);
    assert.equal(img.height, H);
    assert.deepEqual(img.rgba, gradient);
  });

  test('palette encoding uses the smallest depth and stays close to the source', () => {
    for (const [colors, depth] of [[2, 1], [4, 2], [16, 4], [64, 8]]) {
      const { palette, indices } = png.quantize(gradient, W, H, colors);
      assert.ok(palette.length / 3 <= colors);
      const img = decodePng(png.encodeIndexedPng(indices, palette, W, H));
      assert.equal(img.depth, depth, `${colors} colors`);
      assert.ok(img.paletteSize <= colors);
      let err = 0;
      for (let i = 0; i < W * H; i++) for (let c = 0; c < 3; c++) err += Math.abs(img.rgba[i * 4 + c] - gradient[i * 4 + c]);
      const mean = err / (W * H * 3);
      assert.ok(mean < 255 / Math.cbrt(colors) + 6, `mean error ${mean} with ${colors} colors`);
    }
  });

  test('flat images quantize losslessly', () => {
    const flat = Buffer.alloc(W * H * 4, 255);
    for (let i = 0; i < W * H; i++) {
      const left = (i % W) < W / 2;
      flat[i * 4] = left ? 16 : 240;
      flat[i * 4 + 1] = left ? 32 : 200;
      flat[i * 4 + 2] = left ? 64 : 8;
    }
    const { palette, indices } = png.quantize(flat, W, H, 256);
    assert.equal(palette.length / 3, 2);
    assert.deepEqual(decodePng(png.encodeIndexedPng(indices, palette, W, H)).rgba, flat);
  });

  test('resampleBlocky keeps the dimensions and reduces detail', () => {
    const out = png.resampleBlocky(gradient, W, H, 0.25);
    assert.equal(out.length, gradient.length);
    const colors = new Set();
    for (let i = 0; i < W * H; i++) colors.add(out.readUIntBE(i * 4, 3));
    assert.ok(colors.size <= 16 * 12);
  });

  test('fitPng returns the first ladder step that fits and always terminates on noise', () => {
    const noise = Buffer.alloc(300 * 200 * 4, 255);
    let s = 99;
    for (let i = 0; i < noise.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        noise[i + c] = s >>> 24;
      }
    }
    const loose = png.fitPng(noise, 300, 200, 10_000_000);
    assert.deepEqual(loose.step, { scale: 1, colors: 0 }, 'a generous cap keeps the lossless encoding');
    const tight = png.fitPng(noise, 300, 200, 30_000);
    assert.ok(tight.buf && tight.buf.length <= 30_000, 'noise is squeezed under a tight cap');
    assert.ok(tight.step.scale < 1 || tight.step.colors <= 16);
    assert.equal(png.readPngSize(tight.buf).width, 300);
    const impossible = png.fitPng(noise, 300, 200, 100);
    assert.equal(impossible.buf, null);
    assert.ok(impossible.smallest > 100);
    assert.equal(png.fitPng(noise, 300, 200, 10_000_000, { isExpired: () => true }).buf, null);
  });

  test('readPngSize rejects non-PNG data', () => {
    assert.equal(png.readPngSize(Buffer.from('not a png at all, definitely not, padding padding padding')), null);
    assert.equal(png.readPngSize(Buffer.alloc(10)), null);
  });
});

/* ------------------------------------------------------------------------------------------------
 * browser-check.mjs: the route handler's request classification (no browser needed)
 * ---------------------------------------------------------------------------------------------- */

describe('browser-check: top-level navigation detection', () => {
  const NO_FRAME = 'Frame for this navigation request is not available, because the request was issued before the frame is created.';
  const frameless = (nav) => ({ isNavigationRequest: () => nav, frame() { throw new Error(NO_FRAME); } });
  const framed = (nav, parent) => ({ isNavigationRequest: () => nav, frame: () => ({ parentFrame: () => parent }) });

  test('request.frame() throwing (a popup\'s first navigation, a service worker) never escapes the route handler', () => {
    assert.equal(isTopLevelNavigation(frameless(true)), true, 'a popup\'s own first navigation is top-level');
    assert.equal(isTopLevelNavigation(frameless(false)), false, 'a frameless request that is no navigation (a worker) is not');
    assert.equal(isTopLevelNavigation({ isNavigationRequest() { throw new Error('gone'); }, frame: () => ({ parentFrame: () => null }) }), false);
  });

  test('requests with a frame: only a main-frame navigation is top-level', () => {
    assert.equal(isTopLevelNavigation(framed(true, null)), true, 'main frame navigation');
    assert.equal(isTopLevelNavigation(framed(true, {})), false, 'iframe navigation');
    assert.equal(isTopLevelNavigation(framed(false, null)), false, 'subresource of the main frame');
    assert.equal(isTopLevelNavigation(framed(false, {})), false, 'subresource of an iframe');
  });
});

/* ------------------------------------------------------------------------------------------------
 * browser-check.mjs against real Chromium
 * ---------------------------------------------------------------------------------------------- */

browserSuite('browser-check: clean sample', () => {
  let r;
  let strays;
  before(async () => {
    r = await runCheck([fixture('clean'), '--seconds', '6', '--seed', '7']);
    strays = await waitForNoLeaks(r.mark);
  });

  test('passes with no errors and no warnings', () => {
    assert.equal(r.code, 0, JSON.stringify(r.json.errors));
    assert.equal(r.json.ok, true);
    assert.deepEqual(r.json.errors, []);
    assert.deepEqual(r.json.warnings, []);
  });

  test('prints one report that matches report.json, with screenshots on disk', () => {
    const onDisk = JSON.parse(fs.readFileSync(path.join(r.out, 'report.json'), 'utf8'));
    assert.equal(onDisk.ok, true);
    assert.deepEqual(onDisk.errors, r.json.errors);
    for (const name of ['desktop-light', 'desktop-dark', 'mobile-light', 'mobile-dark', 'mobile-320', 'reduced-motion']) {
      const file = path.join(r.out, 'shots', `${name}.png`);
      assert.ok(fs.statSync(file).size > 1000, name);
      assert.ok(r.json.shots.includes(file), `${name} listed in shots`);
    }
    const mobile = png.readPngSize(fs.readFileSync(path.join(r.out, 'shots', 'mobile-light.png')));
    assert.deepEqual(mobile, { width: 780, height: 1688 }, 'mobile shots are 390x844 at 2x');
    const desktop = png.readPngSize(fs.readFileSync(path.join(r.out, 'shots', 'desktop-light.png')));
    assert.deepEqual(desktop, { width: 1280, height: 800 });
  });

  test('collects the documented metrics', () => {
    const m = r.json.metrics;
    assert.equal(m.seed, 7);
    assert.match(m.browser, /^\d+\./);
    for (const pass of ['desktop-light', 'desktop-dark', 'mobile-light', 'mobile-dark', 'mobile-320', 'reduced-motion']) {
      assert.ok(m.passes[pass], pass);
      assert.ok(m.passes[pass].domNodes > 10, `${pass} domNodes`);
      assert.equal(typeof m.passes[pass].loadMs, 'number', `${pass} load timing`);
      assert.equal(m.passes[pass].overflowPx, 0, `${pass} overflow`);
      // A task over 50 ms counts as "long", and on a clean page that only happens when the renderer was descheduled: on a busy machine
      // the old check (count === 0) failed in 2 of 3 concurrent runs of this file, with tasks of about 100 ms. The probe itself is pinned
      // by the 400 ms fixture below (always seen, more load only makes it longer); here the clean page must not come near that, and a page
      // that keeps the main thread busy in many short bursts (a task per frame, each under 250 ms) still fails on the count.
      const long = m.passes[pass].longTasks;
      assert.ok(Number.isInteger(long.count) && typeof long.totalMs === 'number' && long.count <= 2 && long.maxMs < 250, `${pass} long tasks ${JSON.stringify(long)}`);
    }
    const d = m.passes['desktop-light'];
    assert.equal(d.focusable, 7);
    assert.deepEqual(d.headings, { total: 2, h1: 1 });
    assert.ok(d.contrast.sampled >= 5 && d.contrast.failing === 0 && d.contrast.min >= 4.5);
    assert.ok(d.keyboard.tabStops >= 6 && d.keyboard.missingIndicator === 0 && d.keyboard.trapped === false);
    assert.equal(m.passes['reduced-motion'].reducedMotion.matches, true);
    assert.equal(m.passes['reduced-motion'].reducedMotion.infinite, 0);
    assert.deepEqual(m.nonLocalRequests, []);
    assert.deepEqual(m.cspViolations, []);
    assert.equal(m.consoleErrors + m.pageErrors, 0);
    assert.ok(m.server.requests >= 10 && m.server.notFound.length === 0);
  });

  test('the monkey ran on desktop and mobile with a reproducible seed', () => {
    const { monkey } = r.json.metrics;
    assert.ok(monkey['monkey-desktop'].actions > 20, 'desktop actions');
    assert.ok(monkey['monkey-mobile'].actions > 10, 'mobile actions');
    assert.equal(monkey['monkey-desktop'].seed, 7);
    assert.notEqual(monkey['monkey-mobile'].seed, 7);
    assert.ok(monkey['monkey-mobile'].byKind.tap > 0, 'touch taps on the mobile pass');
    assert.ok(fs.existsSync(path.join(r.out, 'shots', 'monkey-desktop-end.png')));
    assert.ok(monkey['monkey-desktop'].log.length <= 12, 'stdout carries only the tail of the action log');
    const full = JSON.parse(fs.readFileSync(path.join(r.out, 'report.json'), 'utf8')).metrics.monkey['monkey-desktop'].log;
    assert.ok(full.length > 20, 'report.json carries the whole log');
  });

  test('same seed, same action sequence', async () => {
    const again = await runCheck([fixture('clean'), '--seconds', '4', '--seed', '7']);
    const logOf = (res) => JSON.parse(fs.readFileSync(path.join(res.out, 'report.json'), 'utf8')).metrics.monkey['monkey-desktop'].log;
    const a = logOf(r);
    const b = logOf(again);
    const n = Math.min(a.length, b.length, 25);
    assert.ok(n >= 15);
    assert.deepEqual(a.slice(0, n), b.slice(0, n));
    const other = await runCheck([fixture('clean'), '--seconds', '4', '--seed', '8']);
    assert.notDeepEqual(logOf(other).slice(0, n), a.slice(0, n), 'a different seed explores differently');
  });

  test('leaves no browser processes behind', () => {
    assert.deepEqual(strays, []);
  });
});

browserSuite('browser-check: defects are flagged', { concurrency: 2 }, () => {
  test('console errors, uncaught errors and broken local resources', async () => {
    const r = await runCheck([fixture('console-errors'), '--seconds', '4']);
    assert.equal(r.code, 1);
    assert.equal(r.json.ok, false);
    const text = r.json.errors.join('\n');
    assert.match(text, /console-error: deliberate console error/);
    assert.match(text, /page-error: deliberate uncaught error/);
    assert.match(text, /http-error: 404 for \/missing\.png/);
    assert.match(text, /page-error: boom from click/, 'the monkey presses the button that throws');
    assert.ok(r.json.metrics.consoleErrors >= 1 && r.json.metrics.pageErrors >= 2);
    assert.ok(r.json.metrics.server.notFound.includes('/missing.png'));
  });

  test('an external request is a violation (request interception, no CSP)', async () => {
    const r = await runCheck([fixture('external'), '--no-monkey']);
    assert.equal(r.code, 1);
    const text = r.json.errors.join('\n');
    assert.match(text, /non-local-request: GET https:\/\/tracker\.qa-external\.invalid\/pixel\.gif \(image\)/);
    assert.match(text, /non-local-request: GET https:\/\/api\.qa-external\.invalid\/collect \(fetch\)/);
    assert.equal(r.json.metrics.cspViolations.length, 0, 'no CSP, so only interception sees it');
    assert.ok(r.json.metrics.nonLocalRequests.some((q) => q.host === 'tracker.qa-external.invalid' && q.declared === false));
  });

  test('an external request blocked by the CSP is still a violation (CSP event)', async () => {
    const r = await runCheck([fixture('external-csp'), '--no-monkey']);
    assert.equal(r.code, 1);
    const text = r.json.errors.join('\n');
    assert.match(text, /csp-violation: connect-src blocked https:\/\/api\.qa-external-csp\.invalid\/collect/);
    assert.match(text, /non-local-request: GET https:\/\/api\.qa-external-csp\.invalid\/collect/);
    assert.ok(r.json.metrics.cspViolations.length >= 1);
    assert.doesNotMatch(text, /console-error/, 'the CSP refusal is reported once, not also as a console error');
  });

  test('a declared network host is blocked during QA but only warns', async () => {
    const dir = path.join(scratch('declared'), 'declared');
    fs.mkdirSync(dir);
    const html = fs.readFileSync(path.join(fixture('external-csp'), 'index.html'), 'utf8')
      .replace("connect-src 'self'", "connect-src 'self' https://api.declared.invalid")
      .replace('api.qa-external-csp.invalid', 'api.declared.invalid');
    fs.writeFileSync(path.join(dir, 'index.html'), html);
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ network: ['api.declared.invalid'] }));
    const r = await runCheck([dir, '--no-monkey']);
    assert.equal(r.code, 0, JSON.stringify(r.json.errors));
    assert.match(r.json.warnings.join('\n'), /declared-network-blocked: GET https:\/\/api\.declared\.invalid\/collect/);
    assert.ok(r.json.metrics.nonLocalRequests.every((q) => q.declared === true));
  });

  test('horizontal overflow at 390px is an error; at 320px a warning for the extra width only', async () => {
    const r = await runCheck([fixture('overflow'), '--no-monkey']);
    assert.equal(r.code, 1);
    const overflow = r.json.errors.filter((e) => e.startsWith('horizontal-overflow'));
    assert.equal(overflow.length, 1);
    assert.match(overflow[0], /510px wider than the 390px viewport.*div\.wide/);
    assert.equal(r.json.metrics.passes['mobile-light'].overflowPx, 510);
    assert.equal(r.json.metrics.passes['desktop-light'].overflowPx, 0);
    assert.match(r.json.warnings.join('\n'), /horizontal-overflow: content is 580px wider than the 320px viewport/);
  });

  test('missing alt text, names, labels and lang are errors; low contrast is a warning', async () => {
    const r = await runCheck([fixture('noalt'), '--no-monkey']);
    assert.equal(r.code, 1);
    const codes = errorCodes(r);
    for (const c of ['missing-lang', 'img-missing-alt', 'button-missing-name', 'link-missing-name', 'field-missing-label']) {
      assert.ok(codes.includes(c), `${c} in ${JSON.stringify(codes)}`);
    }
    assert.match(r.json.warnings.join('\n'), /low-contrast: .*p\.muted.*1\.66:1/);
  });

  test('left-over page-shell placeholders are an error', async () => {
    const dir = path.join(scratch('shell-raw'), 'raw');
    fs.mkdirSync(dir);
    fs.copyFileSync(SHELL, path.join(dir, 'index.html'));
    const r = await runCheck([dir, '--no-monkey']);
    assert.equal(r.code, 1);
    assert.match(r.json.errors.join('\n'), /shell-placeholder: 3 element\(s\)/);
    assert.equal(errorCodes(r).filter((c) => c !== 'shell-placeholder').length, 0, JSON.stringify(r.json.errors));
  });
});

browserSuite('browser-check: robustness', () => {
  test('the leak detector can see a marked process (so "no leaks" means something)', async () => {
    const sleeper = spawn('sleep', ['30'], { env: { ...process.env, SED_QA_MARK: MARK }, stdio: 'ignore' });
    try {
      assert.ok(markedPids().includes(String(sleeper.pid)));
    } finally {
      sleeper.kill('SIGKILL');
    }
    assert.deepEqual(await waitForNoLeaks(), []);
  });

  test('an infinite loop at load is a timeout, never a hang, and leaves nothing running', async () => {
    const r = await runCheck([fixture('hang'), '--seconds', '3', '--page-timeout', '2500']);
    assert.equal(r.code, 1);
    assert.match(r.json.errors.join('\n'), /page-timeout: the page did not finish loading within 2500ms/);
    assert.ok(r.ms < 30000 * loadFactor(), `took ${r.ms}ms`);
    assert.ok(r.json.metrics.skipped.includes('monkey-desktop'), 'later passes are skipped once the page hangs');
    assert.deepEqual(await waitForNoLeaks(r.mark), []);
  });

  test('a page that freezes after loading is detected by the heartbeat', async () => {
    const r = await runCheck([fixture('hang-late'), '--seconds', '3', '--page-timeout', '5000']);
    assert.equal(r.code, 1);
    assert.match(r.json.errors.join('\n'), /unresponsive: the page stopped responding after it loaded/);
    assert.ok(r.ms < 30000 * loadFactor(), `took ${r.ms}ms`);
    assert.deepEqual(await waitForNoLeaks(r.mark), []);
  });

  test('the hard overall timeout wins over a generous page timeout', async () => {
    const r = await runCheck([fixture('hang'), '--seconds', '3', '--page-timeout', '120000', '--timeout', '6']);
    assert.equal(r.code, 1);
    assert.match(r.json.errors.join('\n'), /overall-timeout: QA did not finish within the 6s hard limit/);
    assert.equal(r.json.timedOut, true);
    assert.ok(r.ms < 40000 * loadFactor(), `took ${r.ms}ms`);
    assert.deepEqual(await waitForNoLeaks(r.mark), []);
  });

  test('a tiny budget skips passes instead of overrunning', async () => {
    const r = await runCheck([fixture('clean'), '--seconds', '60', '--timeout', '8']);
    assert.ok(r.ms < 35000 * loadFactor(), `took ${r.ms}ms`);
    assert.ok((r.json.metrics.monkey?.['monkey-desktop']?.durationMs ?? 0) < 8000, 'the monkey never exceeds the budget');
  });

  test('a monkey click on a target=_blank cited-source link opens a popup: tolerated and reported, never a crash of the run', async () => {
    // request.frame() throws for a popup's first navigation request; unguarded, that ended the process with no report at all.
    const r = await runCheck([fixture('popup'), '--seconds', '3', '--seed', '1']);
    assert.equal(r.code, 0, JSON.stringify(r.json.errors));
    assert.equal(r.json.ok, true);
    assert.ok(r.json.warnings.some((w) => /^popup: /.test(w)), 'QA says a window was opened and closed it');
    assert.doesNotMatch(r.json.errors.join('\n'), /non-local-request/, 'following a cited-source link is not a policy violation');
    assert.deepEqual(r.json.metrics.nonLocalRequests, []);
    assert.deepEqual(await waitForNoLeaks(r.mark), []);
  });

  test('a page that blocks the main thread for 400 ms shows up in the long-task metrics of every pass', async () => {
    const r = await runCheck([fixture('longtask'), '--no-monkey']);
    assert.equal(r.code, 0, JSON.stringify(r.json.errors));
    const passes = Object.entries(r.json.metrics.passes);
    assert.equal(passes.length, 6);
    for (const [pass, m] of passes) {
      // lower bounds only: a loaded machine can make the task longer, never shorter
      assert.ok(m.longTasks.count >= 1 && m.longTasks.maxMs >= 350 && m.longTasks.totalMs >= m.longTasks.maxMs, `${pass}: ${JSON.stringify(m.longTasks)}`);
    }
  });

  test('without Chromium it answers no-browser quickly', async () => {
    const r = await runCheck([fixture('clean')], { env: { PLAYWRIGHT_BROWSERS_PATH: path.join(TMP, 'no-such-browsers') } });
    assert.equal(r.code, 1);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error, 'no-browser');
    assert.match(r.json.errors[0], /^no-browser: /);
    assert.deepEqual(r.json.shots, []);
    assert.ok(r.ms < 60000 * loadFactor(), `took ${r.ms}ms`);
    assert.ok(fs.existsSync(path.join(r.out, 'report.json')));
  });

  test('a missing entry page fails without launching a browser', async () => {
    const dir = scratch('empty');
    const r = await runCheck([dir]);
    assert.equal(r.code, 1);
    assert.match(r.json.errors[0], /^missing-entry: index\.html does not exist/);
  });

  test('usage errors exit 2 with a JSON document', async () => {
    const o = () => scratch('o');
    const cases = [
      [],
      [fixture('clean')],
      ['/no/such/dir', '--out', o()],
      [fixture('clean'), '--out', o(), '--seconds', 'x'],
      [fixture('clean'), '--out', o(), '--timeout', '1'],
    ];
    for (const args of cases) {
      const r = await runCheck(args, { noOut: true, timeoutMs: 20000 });
      assert.equal(r.code, 2, JSON.stringify(args));
      assert.equal(r.json.ok, false);
      assert.ok(r.json.error);
    }
  });
});

browserSuite('browser-check: thumbnails', { concurrency: 2 }, () => {
  const sandboxWithCap = (cap) => {
    const root = scratch('sed-root');
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ limits: { thumbMaxBytes: cap } }));
    return root;
  };

  test('a normal page gets a 1200x630 PNG under the cap straight from the screenshot', async () => {
    const dir = copyFixture('clean');
    const r = await runCheck([dir, '--no-monkey', '--thumb']);
    assert.equal(r.code, 0, JSON.stringify(r.json.errors));
    const file = path.join(dir, 'thumb.png');
    const buf = fs.readFileSync(file);
    assert.ok(buf.length <= 307200 && buf.length > 2000);
    const img = decodePng(buf);
    assert.equal(img.width, 1200);
    assert.equal(img.height, 630);
    assert.equal(r.json.metrics.thumb.strategy, 'screenshot');
    assert.equal(r.json.metrics.thumb.path, file);
    assert.ok(r.json.shots.includes(file));
    assert.deepEqual(pixel(img, 1100, 600), [246, 245, 241], 'the light desktop page background');
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'no temp files left behind');
  });

  test('an incompressible page is shrunk under the cap (palette and resolution ladder)', async () => {
    const dir = copyFixture('noisy');
    const r = await runCheck([dir, '--no-monkey', '--thumb']);
    assert.equal(r.code, 0, JSON.stringify(r.json.errors));
    const buf = fs.readFileSync(path.join(dir, 'thumb.png'));
    assert.ok(buf.length <= 307200, `${buf.length} bytes`);
    const img = decodePng(buf);
    assert.deepEqual([img.width, img.height], [1200, 630]);
    assert.ok(r.json.metrics.thumb.rawBytes > 1_000_000);
    assert.notEqual(r.json.metrics.thumb.strategy, 'screenshot');
    assert.match(r.json.warnings.join('\n'), /thumb-reduced: the raw screenshot was \d+ bytes/);
  });

  test('a mildly oversized page keeps full resolution (lossless first, then palette)', async () => {
    const dir = copyFixture('clean');
    const r = await runCheck([dir, '--no-monkey', '--thumb'], { env: { SED_ROOT: sandboxWithCap(12000) } });
    assert.equal(r.code, 0, JSON.stringify(r.json.errors));
    const buf = fs.readFileSync(path.join(dir, 'thumb.png'));
    assert.ok(buf.length <= 12000, `${buf.length} bytes`);
    const img = decodePng(buf);
    assert.deepEqual([img.width, img.height], [1200, 630]);
    assert.doesNotMatch(r.json.metrics.thumb.strategy, /detail/, r.json.metrics.thumb.strategy);
    assert.deepEqual(pixel(img, 1100, 600), [246, 245, 241], 'colours survive re-encoding');
  });

  test('a cap nothing can meet is an error and no thumbnail is written', async () => {
    const dir = copyFixture('clean');
    const r = await runCheck([dir, '--no-monkey', '--thumb'], { env: { SED_ROOT: sandboxWithCap(60) } });
    assert.equal(r.code, 1);
    assert.match(r.json.errors.join('\n'), /thumb-too-large: could not get the thumbnail under 60 bytes/);
    assert.equal(fs.existsSync(path.join(dir, 'thumb.png')), false);
  });

  test('waits for window.__sedThumbReady before taking the screenshot', async () => {
    const dir = copyFixture('ready');
    const r = await runCheck([dir, '--no-monkey', '--thumb', '--thumb-settle', '100']);
    assert.equal(r.code, 0, JSON.stringify(r.json.errors));
    assert.equal(r.json.metrics.thumb.ready, 'ready');
    const img = decodePng(fs.readFileSync(path.join(dir, 'thumb.png')));
    assert.deepEqual(pixel(img, 600, 500), [10, 125, 58], 'the page had switched to its ready state (green)');
  });

  test('a __sedThumbReady that never settles cannot stall the run', async () => {
    const dir = copyFixture('ready');
    fs.writeFileSync(path.join(dir, 'index.html'), fs.readFileSync(path.join(dir, 'index.html'), 'utf8').replace('}, 1500);', '}, 600000);'));
    const r = await runCheck([dir, '--no-monkey', '--thumb', '--thumb-settle', '50', '--thumb-ready-timeout', '1200']);
    assert.equal(r.code, 0, JSON.stringify(r.json.errors));
    assert.equal(r.json.metrics.thumb.ready, 'timeout');
    assert.match(r.json.warnings.join('\n'), /thumb-ready-timeout/);
    assert.ok(fs.existsSync(path.join(dir, 'thumb.png')));
    const img = decodePng(fs.readFileSync(path.join(dir, 'thumb.png')));
    assert.deepEqual(pixel(img, 600, 500), [34, 34, 34], 'still the unready (grey) frame');
  });

  test('no thumbnail for a page that hangs or is blank', async () => {
    const hang = copyFixture('hang');
    const r1 = await runCheck([hang, '--no-monkey', '--thumb', '--page-timeout', '2500']);
    assert.equal(r1.code, 1);
    assert.match(r1.json.errors.join('\n'), /thumb-failed/);
    assert.equal(fs.existsSync(path.join(hang, 'thumb.png')), false);

    const blank = path.join(scratch('blank'), 'blank');
    fs.mkdirSync(blank);
    fs.writeFileSync(path.join(blank, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Blank</title></head><body></body></html>');
    const r2 = await runCheck([blank, '--no-monkey', '--thumb']);
    assert.equal(r2.code, 1);
    assert.match(r2.json.errors.join('\n'), /blank-page/);
    assert.match(r2.json.errors.join('\n'), /thumb-failed: the page is blank/);
    assert.equal(fs.existsSync(path.join(blank, 'thumb.png')), false);
  });

  test('a flag placed before the directory still works', async () => {
    const dir = copyFixture('clean');
    const r = await runCheck(['--thumb', dir, '--no-monkey']);
    assert.equal(r.code, 0, JSON.stringify(r.json.errors));
    assert.ok(fs.existsSync(path.join(dir, 'thumb.png')));
  });
});

/* ------------------------------------------------------------------------------------------------
 * The page shell and the project.json template
 * ---------------------------------------------------------------------------------------------- */

browserSuite('page shell and project template', () => {
  const buildProject = ({ fill }) => {
    const dir = path.join(scratch('shell'), '2026-10-09-example-project');
    fs.mkdirSync(dir);
    let html = fs.readFileSync(SHELL, 'utf8');
    if (fill) {
      html = html
        .replace(/\n\s*<div class="sed-placeholder" data-sed-placeholder>.*?<\/div>\n/, '\n  <p class="sed-prose">Hello from the shell.</p>\n')
        .replace('<p class="sed-making-of" data-sed-placeholder>', '<p class="sed-making-of">')
        .replace('<li data-sed-placeholder>', '<li>');
    }
    fs.writeFileSync(path.join(dir, 'index.html'), html);
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(EXAMPLE, 'utf8')), tier: 4 }, null, 2));
    return dir;
  };

  test('the shell carries the exact CSP, viewport, lang, title and back link from the contract', () => {
    const html = fs.readFileSync(SHELL, 'utf8');
    const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)[1];
    assert.equal(
      csp,
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; base-uri 'none'; form-action 'none'",
    );
    assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<style>'), 'CSP precedes everything that loads');
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    assert.match(html, /<title>[^<]+<\/title>/);
    assert.match(html, /<a class="sed-back" href="\.\.\/\.\.\/">&larr; Sonnet Every Day<\/a>/);
    assert.match(html, /<details class="sed-about">/);
    assert.match(html, /<noscript>/);
    assert.match(html, /prefers-color-scheme: dark/);
    assert.match(html, /prefers-reduced-motion: reduce/);
    assert.match(html, /:focus-visible/);
    assert.match(html, /class="sed-skip"/);
    assert.match(html, /__sedThumbReady/);
    assert.equal((html.replace(/<!--[\s\S]*?-->/g, '').match(/<main\b/g) ?? []).length, 1);
    assert.doesNotMatch(html.replace(/<!--[\s\S]*?-->/g, ''), /https?:\/\/(?!example\.com\/source)/, 'no external resource in the shell itself');
  });

  test('a filled-in shell passes validate.mjs project', async () => {
    const dir = buildProject({ fill: true });
    fs.writeFileSync(path.join(dir, 'thumb.png'), png.encodeRgbPng(Buffer.alloc(1200 * 630 * 4, 200), 1200, 630));
    const { validateProject } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'validate.mjs')).href);
    const res = await validateProject(dir, { tier: 4 });
    assert.deepEqual(res.errors, []);
    assert.deepEqual(res.warnings, []);
    assert.equal(res.ok, true);
  });

  test('a filled-in shell is clean under browser-check (contrast, focus, overflow, reduced motion, monkey)', async () => {
    const dir = buildProject({ fill: true });
    const r = await runCheck([dir, '--seconds', '4', '--thumb']);
    assert.equal(r.code, 0, JSON.stringify(r.json.errors));
    assert.deepEqual(r.json.errors, []);
    assert.deepEqual(r.json.warnings, []);
    const d = r.json.metrics.passes['desktop-light'];
    assert.ok(d.contrast.sampled >= 5 && d.contrast.min >= 4.5, JSON.stringify(d.contrast));
    assert.ok(r.json.metrics.passes['desktop-dark'].contrast.min >= 4.5);
    assert.ok(d.keyboard.tabStops >= 3 && d.keyboard.missingIndicator === 0);
    assert.equal(r.json.metrics.passes['mobile-320'].overflowPx, 0);
    // the thumbnail validates too
    const { validateProject } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'validate.mjs')).href);
    const res = await validateProject(dir, { tier: 4 });
    assert.deepEqual(res.errors, []);
  });

  test('project.json.example is complete, valid and documented', async () => {
    const example = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
    const doc = fs.readFileSync(README, 'utf8');
    for (const key of Object.keys(example)) assert.ok(doc.includes(`\`${key}\``), `README documents ${key}`);
    for (const key of Object.keys(example.fingerprint)) assert.ok(doc.includes(key), `README documents fingerprint.${key}`);
    assert.equal(example.schema, 1);
    assert.ok(example.tagline.length <= 120);
    const dir = buildProject({ fill: true });
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ ...example, tier: 4 }));
    fs.writeFileSync(path.join(dir, 'thumb.png'), png.encodeRgbPng(Buffer.alloc(1200 * 630 * 4, 90), 1200, 630));
    const { validateProject } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'validate.mjs')).href);
    const res = await validateProject(dir, { tier: 4 });
    assert.deepEqual(res.errors.filter((e) => /project-json|fingerprint/.test(e)), []);
  });
});

describe('browser suites, side by side', { concurrency: 4 }, () => {
  for (const { name, opts, fn } of browserSuites) describe(name, opts, fn);
});
