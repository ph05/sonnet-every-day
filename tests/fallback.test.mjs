// Tests for scripts/fallback.mjs, scripts/lib/png.mjs, scripts/lib/postcard.mjs and site-src/fallback/**.
// Everything runs against SED_ROOT sandboxes in os.tmpdir(); the real state/, docs/ and work/ are never touched.
import './helpers/env.mjs';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { tmpDir } from './helpers/env.mjs';
import { REPO_ROOT, TEST_CONFIG } from './helpers/sandbox.mjs';
import { Canvas, crc32, encodePng, measureText, parseColor, quantize } from '../scripts/lib/png.mjs';
import { sceneApi, buildScene, renderPostcardThumb, fillTemplate, escapeHtml, jsonForScript } from '../scripts/lib/postcard.mjs';
import { hashStr, mulberry32 } from '../scripts/lib/common.mjs';
import { cleanText, cleanUrl, normalizeIdeas, DIMENSIONS } from '../scripts/fallback.mjs';
import { validateProject } from '../scripts/validate.mjs';

const FALLBACK_CLI = path.join(REPO_ROOT, 'scripts', 'fallback.mjs');
const DATE = '2026-10-09';

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

/** Minimal PNG decoder (8-bit, non-interlaced, color types 2, 3, 6): enough to verify our encoder. */
function decodePng(buf) {
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'signature');
  let off = 8;
  let ihdr = null;
  let plte = null;
  const idat = [];
  let sawEnd = false;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    assert.equal(buf.readUInt32BE(off + 8 + len), crc32(buf.subarray(off + 4, off + 8 + len)), `crc of ${type}`);
    if (type === 'IHDR') ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], type: data[9] };
    else if (type === 'PLTE') plte = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') sawEnd = true;
    off += 12 + len;
  }
  assert.ok(sawEnd, 'IEND');
  assert.equal(ihdr.depth, 8);
  const bpp = { 2: 3, 3: 1, 6: 4 }[ihdr.type];
  assert.ok(bpp, `color type ${ihdr.type}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = ihdr.w * bpp;
  assert.equal(raw.length, (stride + 1) * ihdr.h);
  const px = Buffer.alloc(stride * ihdr.h);
  for (let y = 0; y < ihdr.h; y++) {
    const f = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const v = raw[y * (stride + 1) + 1 + i];
      const a = i >= bpp ? px[y * stride + i - bpp] : 0;
      const b = y ? px[(y - 1) * stride + i] : 0;
      const c = i >= bpp && y ? px[(y - 1) * stride + i - bpp] : 0;
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
      px[y * stride + i] = (v + add) & 255;
    }
  }
  const rgba = Buffer.alloc(ihdr.w * ihdr.h * 4);
  for (let p = 0; p < ihdr.w * ihdr.h; p++) {
    if (ihdr.type === 3) {
      const k = px[p] * 3;
      rgba.set([plte[k], plte[k + 1], plte[k + 2], 255], p * 4);
    } else if (ihdr.type === 2) rgba.set([px[p * 3], px[p * 3 + 1], px[p * 3 + 2], 255], p * 4);
    else rgba.set(px.subarray(p * 4, p * 4 + 4), p * 4);
  }
  return { width: ihdr.w, height: ihdr.h, colorType: ihdr.type, rgba, paletteSize: plte ? plte.length / 3 : 0 };
}

const pixelAt = (img, x, y) => [...img.rgba.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)];

function makeIdeas(date = DATE, { evil = false, count = 10 } = {}) {
  const cats = ['cards-odds', 'hockey-sports', 'pop-culture', 'humor-satire', 'science-sim', 'math-puzzle', 'music-audio', 'generative-art', 'tools-utility', 'modding-games'];
  const mechs = ['solver', 'simulator', 'toy', 'generator', 'game', 'visualizer', 'instrument', 'calculator', 'tool', 'editor'];
  const slots = ['interest', 'interest', 'currentEvents', 'humor', 'wildcard', 'wildcard', 'wildcard', 'wildcard', 'wildcard', 'interest'];
  const titles = ['Range Weather Report', 'Glass Tempo', 'Joker Forge', 'Rinkside Rumor Mill', 'Pendulum Choir', 'Parity Garden', 'Ledger Of Lies', 'Tiny Planetarium', 'Hand Of Thirteen', 'Fridge Magnet Quartet'];
  const ideas = titles.slice(0, count).map((t, i) => ({
    id: `i${String(i + 1).padStart(2, '0')}`,
    title: evil && i === 3 ? 'Rinkside <script>alert(1)</script> Rumor "Mill" & co' : t,
    pitch: `A ${mechs[i]} that turns ${t.toLowerCase()} into something you can poke. It runs offline and rewards curiosity quickly.`,
    whyNow: 'The season just opened.',
    origin: { agent: 'pulse', lens: 'hockey-now' },
    fingerprint: { category: cats[i], mechanic: mechs[i], tone: ['playful'], tech: ['svg'], tags: ['alpha-beta', 'gamma', 'delta'], keywords: ['one', 'two', 'three'], slot: slots[i], political: false },
    research: {
      summary: 'Summary of the research.',
      sources: [
        { title: 'Primary', url: evil && i === 3 ? 'javascript:alert(1)' : `https://example.org/ref/${i}?a=1&b="x"`, note: 'Core numbers.', verified: true },
        { title: 'Second', url: `https://en.wikipedia.org/wiki/Topic_${i}`, note: 'Context.', verified: false },
        { title: 'Insecure', url: 'http://insecure.example/x', note: 'dropped' },
      ],
      facts: [{ claim: 'Sourced claim', sourceIndex: 0, asOf: date }, { claim: 'Orphan claim', sourceIndex: 9, asOf: 'yesterday' }],
      inspirations: ['A classic toy'],
    },
    design: { coreLoop: 'Poke and observe.', sophisticationHooks: ['Seeded randomness'], dataNeeds: 'bundled', scopeForOneDay: 'One screen.', risks: ['Scope'] },
    durable: i % 2 === 0,
    scores: { sophistication: 5 + (i % 5), delight: 6 + (i % 4), distinctness: 7 - (i % 3), feasibility: 8 - (i % 6), timeliness: 4 + (i % 7), interestFit: 9 - (i % 4), polishPotential: 6, safety: 10, clarity: 5 + (i % 3) },
    total: 50 + ((i * 7) % 25) + (i === 3 ? 10 : 0), // the pick (i04) scores 81, above the old cap of 80 (select totals run 0 to 100)
    noveltyCheck: { ok: i !== 6, conflicts: i === 6 ? [{ kind: 'tag-overlap', detail: 'overlaps a past build' }] : [] },
  }));
  return { schema: 1, date, lenses: [], carryoverIn: null, ideas, chosenId: 'i04', carryoverOutId: 'i07', rejectedNotes: [{ title: 'Something dull', reason: 'Seen it.' }], rationale: 'Funniest and most buildable in a day.', selectedAt: `${date}T08:00:00Z` };
}

/** The shortlist exactly as ops/workflows/ideate.js writes it: every score and total 0, nothing chosen (select has not run). */
function makeUnscoredShortlist(date = DATE) {
  const doc = makeIdeas(date);
  for (const i of doc.ideas) {
    i.scores = Object.fromEntries(DIMENSIONS.map((d) => [d, 0]));
    i.total = 0;
  }
  return { ...doc, chosenId: null, carryoverOutId: null, rejectedNotes: [], rationale: '', selectedAt: null, generatedBy: 'ideate', count: doc.ideas.length };
}

function makeSandbox({ ideas = true } = {}) {
  const root = tmpDir('sed-fallback-');
  const put = (rel, content) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), typeof content === 'string' || Buffer.isBuffer(content) ? content : `${JSON.stringify(content, null, 2)}\n`);
  };
  put('config.json', TEST_CONFIG);
  fs.mkdirSync(path.join(root, 'ops'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'ops', 'taxonomy.json'), path.join(root, 'ops', 'taxonomy.json'));
  put('state/history.json', { schema: 1, startDate: DATE, entries: [] });
  if (ideas) put(`state/ideas/${DATE}.json`, makeIdeas());
  return {
    root,
    put,
    p: (...parts) => path.join(root, ...parts),
    read: (rel) => fs.readFileSync(path.join(root, rel), 'utf8'),
    json: (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')),
    exists: (rel) => fs.existsSync(path.join(root, rel)),
    cli(args, env = {}) {
      const r = spawnSync(process.execPath, [FALLBACK_CLI, ...args], { env: { ...process.env, SED_ROOT: root, ...env }, encoding: 'utf8', timeout: 120_000 });
      let json = null;
      try {
        json = JSON.parse(r.stdout);
      } catch { /* leave null */ }
      return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

const NOW = '2026-10-09T11:35:00Z';

// ---------------------------------------------------------------------------------------------
// png.mjs
// ---------------------------------------------------------------------------------------------

describe('png encoder', () => {
  test('crc32 matches the standard check value', () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  });

  test('round-trips RGB and RGBA images exactly', () => {
    const w = 37;
    const h = 23;
    const rgb = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) rgb.set([(i * 7) & 255, (i * 13) & 255, (i * 29) & 255, 255], i * 4);
    const a = decodePng(encodePng(w, h, rgb));
    assert.equal(a.colorType, 2);
    assert.deepEqual([...a.rgba], [...rgb]);

    const rgba = new Uint8ClampedArray(rgb);
    for (let i = 0; i < w * h; i++) rgba[i * 4 + 3] = (i * 5) & 255;
    const b = decodePng(encodePng(w, h, rgba));
    assert.equal(b.colorType, 6);
    assert.deepEqual([...b.rgba], [...rgba]);
  });

  test('rejects wrong buffer sizes and dimensions', () => {
    assert.throws(() => encodePng(4, 4, new Uint8Array(10)), /expected 64 RGBA bytes/);
    assert.throws(() => encodePng(0, 4, new Uint8Array(0)), /bad dimensions/);
  });

  test('maxBytes steps down until the file fits and stays a valid PNG', () => {
    const cv = new Canvas(400, 300, '#102030');
    cv.fillLinearGradient(0, 0, 400, 300, [[0, '#102030'], [0.5, '#a03070'], [1, '#f0c040']]);
    cv.glow(200, 150, 180, '#40e0d0', 0.9);
    // noisy detail that does not compress losslessly
    const rng = mulberry32(5);
    for (let i = 0; i < 400; i++) cv.fillCircle(rng() * 400, rng() * 300, 2 + rng() * 6, [rng() * 255, rng() * 255, rng() * 255], 0.8);
    const full = encodePng(400, 300, cv.data);
    const small = encodePng(400, 300, cv.data, { maxBytes: Math.floor(full.length / 3) });
    assert.ok(small.length < full.length, `${small.length} < ${full.length}`);
    const img = decodePng(small);
    assert.equal(img.width, 400);
    assert.equal(img.height, 300);
  });

  test('quantize respects the palette size and maps every pixel', () => {
    const cv = new Canvas(64, 64, '#000000');
    cv.fillLinearGradient(0, 0, 64, 64, [[0, '#ff0000'], [1, '#0000ff']]);
    const { palette, indices } = quantize(64, 64, cv.data, 16);
    assert.ok(palette.length / 3 <= 16);
    assert.equal(indices.length, 64 * 64);
    for (const idx of indices) assert.ok(idx < palette.length / 3);
  });
});

describe('software rasterizer', () => {
  test('circles are anti-aliased: solid inside, background outside, partial on the edge', () => {
    const cv = new Canvas(40, 40, '#000000');
    cv.fillCircle(20, 20, 10, '#ffffff');
    assert.deepEqual(cv.pixel(20, 20), [255, 255, 255]);
    assert.deepEqual(cv.pixel(2, 2), [0, 0, 0]);
    let partial = 0;
    for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) { const v = cv.pixel(x, y)[0]; if (v > 0 && v < 255) partial++; }
    assert.ok(partial >= 20, `${partial} anti-aliased edge pixels`);
  });

  test('alpha, additive and multiply blending', () => {
    const cv = new Canvas(4, 4, '#404040');
    cv.fillRect(0, 0, 4, 4, '#ffffff', 0.5);
    assert.ok(Math.abs(cv.pixel(1, 1)[0] - 159.5) <= 1);
    const add = new Canvas(2, 2, '#202020');
    add.fillRect(0, 0, 2, 2, '#202020', 1, 'add');
    assert.equal(add.pixel(0, 0)[0], 64);
    const mul = new Canvas(2, 2, '#ffffff');
    mul.fillRect(0, 0, 2, 2, '#808080', 1, 'multiply');
    assert.ok(Math.abs(mul.pixel(0, 0)[0] - 128) <= 1);
  });

  test('polygon fill covers its area (and winding is not required)', () => {
    const cv = new Canvas(100, 100, '#000000');
    cv.fillPolygon([10, 10, 90, 10, 90, 90, 10, 90], '#ffffff');
    let lit = 0;
    for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) if (cv.pixel(x, y)[0] > 127) lit++;
    assert.ok(Math.abs(lit - 6400) <= 40, `area ${lit}`);
    const ccw = new Canvas(100, 100, '#000000');
    ccw.fillPolygon([10, 90, 90, 90, 90, 10, 10, 10], '#ffffff');
    assert.deepEqual(ccw.pixel(50, 50), [255, 255, 255]);
  });

  test('translucent polylines do not darken where their own segments overlap', () => {
    const cv = new Canvas(60, 20, '#000000');
    cv.strokePath([5, 10, 30, 10, 30, 10, 5, 10, 55, 10], 4, '#ffffff', 0.5);
    const v = cv.pixel(20, 10)[0];
    assert.ok(Math.abs(v - 127.5) <= 2, `stroke value ${v}`);
  });

  test('gradients hit their end colors and glows fall off to nothing', () => {
    const cv = new Canvas(100, 10, '#000000');
    cv.fillLinearGradient(0, 0, 100, 0, [[0, '#ff0000'], [1, '#0000ff']]);
    assert.ok(cv.pixel(0, 5)[0] > 250 && cv.pixel(99, 5)[2] > 250);
    const g = new Canvas(100, 100, '#000000');
    g.glow(50, 50, 40, '#ffffff', 1);
    assert.ok(g.pixel(50, 50)[0] > 240);
    assert.equal(g.pixel(2, 2)[0], 0);
  });

  test('bitmap text: measures, scales, and draws recognisable glyphs', () => {
    assert.equal(measureText('AB', 1), 11);
    assert.equal(measureText('AB', 3), 33);
    assert.equal(measureText('', 3), 0);
    const cv = new Canvas(20, 12, '#000000');
    cv.text('I', 1, 1, { scale: 1, spacing: 1 });
    // 'I' is .###. / ..#.. x5 / .###.: its stem is the third column
    assert.deepEqual(cv.pixel(1 + 2, 1 + 3), [255, 255, 255]);
    assert.deepEqual(cv.pixel(1, 1 + 3), [0, 0, 0]);
    assert.deepEqual(cv.pixel(1 + 1, 1), [255, 255, 255]);
    const big = new Canvas(40, 30, '#000000');
    big.text('I', 0, 0, { scale: 3 });
    assert.deepEqual(big.pixel(7, 10), [255, 255, 255]);
    // lower case and accents are folded; unknown characters draw a box rather than throwing
    const a = new Canvas(30, 10, '#000000');
    const b = new Canvas(30, 10, '#000000');
    a.text('cafe', 0, 0);
    b.text('CAFÉ', 0, 0);
    assert.deepEqual([...a.data], [...b.data]);
    assert.doesNotThrow(() => a.text('中文', 0, 0));
  });

  test('parseColor accepts hex and arrays and rejects junk', () => {
    assert.deepEqual(parseColor('#f80'), [255, 136, 0, 1]);
    assert.deepEqual(parseColor([1, 2, 3, 0.5]), [1, 2, 3, 0.5]);
    assert.throws(() => parseColor('red'), /bad color/);
  });
});

// ---------------------------------------------------------------------------------------------
// postcard scene
// ---------------------------------------------------------------------------------------------

function addDays(date, n) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

describe('postcard scene', () => {
  test('the scene script uses the same hash and PRNG as common.mjs', () => {
    const api = sceneApi();
    for (const s of ['', 'a', '2026-10-09', 'postcard:2026-10-09']) assert.equal(api.hashStr(s), hashStr(s));
    const x = mulberry32(12345);
    const y = api.mulberry32(12345);
    for (let i = 0; i < 20; i++) assert.equal(x(), y());
  });

  test('is deterministic per date and different across dates', () => {
    const api = sceneApi();
    const a1 = api.toSvg(buildScene(DATE));
    const a2 = api.toSvg(buildScene(DATE));
    assert.equal(a1, a2);
    const seen = new Set();
    for (let i = 0; i < 12; i++) seen.add(api.toSvg(buildScene(addDays(DATE, i))));
    assert.equal(seen.size, 12);
    assert.deepEqual(buildScene(DATE).palette, buildScene(DATE).palette);
  });

  test('has at least seven composition families, all used in any run of eight days, never on consecutive days', () => {
    const api = sceneApi();
    assert.ok(api.FAMILIES.length >= 7);
    const families = [];
    for (let i = 0; i < 400; i++) families.push(buildScene(addDays(DATE, i)).family);
    for (let i = 1; i < families.length; i++) assert.notEqual(families[i], families[i - 1], `repeat on day ${i}`);
    assert.equal(new Set(families).size, api.FAMILIES.length);
    const epochDay = Math.floor(Date.parse(`${DATE}T00:00:00Z`) / 86400000);
    const first = (api.FAMILIES.length - (epochDay % api.FAMILIES.length)) % api.FAMILIES.length;
    const block = families.slice(first, first + api.FAMILIES.length);
    assert.equal(new Set(block).size, api.FAMILIES.length, 'a full cycle shows each family once');
  });

  test('every family yields finite, well-formed items at several moments, and valid SVG', () => {
    const api = sceneApi();
    const kinds = new Set(['bg', 'glow', 'circle', 'path', 'segs', 'poly', 'rect']);
    const found = new Set();
    for (let i = 0; found.size < api.FAMILIES.length && i < 40; i++) {
      const scene = buildScene(addDays(DATE, i));
      if (found.has(scene.family)) continue;
      found.add(scene.family);
      for (const t of [0, scene.stillT, 13.7, 61]) {
        const items = scene.frame(t);
        assert.ok(items.length > 5, `${scene.family} has items`);
        assert.equal(items[0].k, 'bg');
        for (const it of items) {
          assert.ok(kinds.has(it.k), `${scene.family}: kind ${it.k}`);
          for (const key of ['x', 'y', 'r', 'w', 'h', 'a']) if (key in it && typeof it[key] === 'number') assert.ok(Number.isFinite(it[key]), `${scene.family}.${it.k}.${key}`);
          if (it.p) {
            assert.ok(it.p.length >= 2 && it.p.length % 2 === 0, `${scene.family}: point list`);
            for (const v of it.p) assert.ok(Number.isFinite(v), `${scene.family}: finite points`);
          }
          for (const key of ['c', 'f', 's']) if (it[key]) assert.match(it[key], /^#[0-9a-f]{6}$/, `${scene.family}: color ${it[key]}`);
        }
      }
      const svg = api.toSvg(scene);
      assert.match(svg, /^<svg [^>]*viewBox="0 0 1200 630"/);
      assert.ok(svg.endsWith('</svg>'));
      assert.ok(!/<script|javascript:|on\w+=/i.test(svg));
      assert.ok(svg.length < 600_000, `${scene.family} svg is ${svg.length} bytes`);
    }
    assert.equal(found.size, api.FAMILIES.length);
  });

  test('the note is honest, human, and deterministic', () => {
    const api = sceneApi();
    const seenNotes = new Set();
    for (let i = 0; i < 40; i++) {
      const scene = buildScene(addDays(DATE, i));
      const note = api.buildNote(scene);
      assert.equal(note, api.buildNote(scene));
      assert.match(note, /didn't|did not|never got done|came up short|ran out of road/i);
      assert.match(note, /tomorrow/i);
      assert.ok(note.length < 420, 'a short note');
      assert.ok(!/[—–]/.test(note), 'no dashes as punctuation');
      seenNotes.add(note);
    }
    assert.ok(seenNotes.size > 20, 'notes vary');
  });

  test('thumbnails are 1200x630, under the cap, and look different from day to day', () => {
    const a = renderPostcardThumb({ date: DATE, day: 1 });
    const b = renderPostcardThumb({ date: addDays(DATE, 1), day: 2 });
    for (const png of [a, b]) {
      const img = decodePng(png);
      assert.equal(img.width, 1200);
      assert.equal(img.height, 630);
      assert.ok(png.length <= 300_000, `${png.length} bytes`);
      assert.ok(png.length > 20_000, 'not a flat placeholder');
    }
    assert.ok(!a.equals(b));
    assert.ok(a.equals(renderPostcardThumb({ date: DATE, day: 1 })), 'deterministic');
  });
});

// ---------------------------------------------------------------------------------------------
// sanitizing
// ---------------------------------------------------------------------------------------------

describe('sanitizing untrusted ideas', () => {
  test('cleanText strips controls and bidi tricks, collapses whitespace, clips, redacts token-shaped strings', () => {
    assert.equal(cleanText('  a\u0000b\n\n c‮ d​ '), 'a b c d');
    assert.equal(cleanText(12), '12');
    assert.equal(cleanText({ x: 1 }), '');
    assert.equal(cleanText(null), '');
    const long = cleanText('x'.repeat(50), 10);
    assert.equal(long.length, 10);
    assert.ok(long.endsWith('…'));
    assert.ok(!cleanText(`key ghp_${'a'.repeat(30)} end`).includes('ghp_'));
    assert.ok(!cleanText('-----BEGIN PRIVATE KEY-----').includes('-----BEGIN'));
    // never splits a surrogate pair when clipping
    const clipped = cleanText('🏒'.repeat(10), 5);
    assert.ok(!/[\ud800-\udbff]$/.test(clipped.slice(0, -1)));
  });

  test('cleanUrl keeps plain https links and nothing else', () => {
    assert.equal(cleanUrl('https://example.org/a?b=1#frag'), 'https://example.org/a?b=1');
    assert.equal(cleanUrl(' https://Example.org '), 'https://example.org/');
    for (const bad of ['http://example.org', 'javascript:alert(1)', 'data:text/html,hi', 'https://user:pw@example.org/', 'https://localhost/', 'https://127.0.0.1/', 'https://[::1]/', 'ftp://example.org', 'https://exa mple.org', '', null, 42, `https://example.org/${'a'.repeat(700)}`, `https://example.org/?k=ghp_${'a'.repeat(30)}`]) {
      assert.equal(cleanUrl(bad), null, String(bad));
    }
    assert.ok(!cleanUrl('https://example.org/a"onmouseover="x').includes('"'));
  });

  test('normalizeIdeas: shapes, scores, ids, pick and carry-over', () => {
    const { doc, warnings } = normalizeIdeas(makeIdeas(), { date: DATE, source: 'x' });
    assert.equal(doc.ideas.length, 10);
    assert.equal(doc.chosenId, 'i04');
    assert.equal(doc.pickKind, 'chosen');
    assert.equal(doc.carryoverOutId, 'i07');
    assert.equal(doc.ideas.find((i) => i.id === 'i07').carry, true);
    assert.deepEqual(doc.dimensions, DIMENSIONS);
    assert.equal(doc.rationale, 'Funniest and most buildable in a day.');
    const first = doc.ideas[0];
    assert.equal(first.research.sources.length, 3);
    assert.equal(first.research.sources[0].verified, true);
    assert.equal(first.research.sources[1].verified, false);
    assert.deepEqual([first.research.sources[2].url, first.research.sources[2].verified], [null, false], 'an http:// link loses its URL and is never "verified"');
    assert.deepEqual(first.research.facts[0], { claim: 'Sourced claim', source: 0, asOf: DATE });
    assert.deepEqual(first.research.facts[1], { claim: 'Orphan claim', source: null, asOf: '' });
    assert.equal(doc.ideas[6].novelty.ok, false);
    assert.deepEqual(doc.ideas[6].novelty.conflicts, ['tag-overlap: overlaps a past build']);
    assert.ok(Array.isArray(warnings));

    // a bare array, no pick recorded: the top score is shown and labelled as such
    const arr = makeIdeas().ideas;
    const bare = normalizeIdeas(arr, { date: DATE }).doc;
    assert.equal(bare.pickKind, 'top-score');
    assert.equal(bare.rationale, '');
    const top = [...bare.ideas].sort((a, b) => b.total - a.total)[0];
    assert.equal(bare.chosenId, top.id);

    // the "shortlist" key works; out-of-range scores are clamped; duplicate and missing ids are repaired
    const odd = normalizeIdeas({ shortlist: [
      { id: 'a', title: 'One', scores: { sophistication: 99, delight: -4, safety: 'x' } },
      { id: 'a', title: 'Two' },
      { title: 'Three', scores: {} },
      { title: '' },
      'junk',
    ] }, { date: DATE });
    assert.deepEqual(odd.doc.ideas.map((i) => i.title), ['One', 'Two', 'Three']);
    assert.equal(new Set(odd.doc.ideas.map((i) => i.id)).size, 3);
    assert.equal(odd.doc.ideas[0].scores.sophistication, 10);
    assert.equal(odd.doc.ideas[0].scores.delight, 0);
    assert.equal(odd.doc.ideas[0].scored, true);
    assert.equal(odd.doc.ideas[1].scored, false);
    assert.equal(odd.warnings.length, 2);

    assert.throws(() => normalizeIdeas({ nothing: 1 }), /no "ideas" array/);
    assert.throws(() => normalizeIdeas({ ideas: [{ pitch: 'no title' }] }), /no usable idea/);
    assert.equal(normalizeIdeas({ ideas: Array.from({ length: 30 }, (_, i) => ({ title: `t${i}` })) }).doc.ideas.length, 12);
  });

  test('scores: select\'s nine criteria and its 0 to 100 total are shown as they are (a total above 80 is no longer replaced)', () => {
    assert.deepEqual(DIMENSIONS, ['sophistication', 'delight', 'distinctness', 'feasibility', 'timeliness', 'interestFit', 'polishPotential', 'safety', 'clarity']);
    const nine = (v) => Object.fromEntries(DIMENSIONS.map((d) => [d, v]));
    const { doc } = normalizeIdeas({ chosenId: 'i01', ideas: [
      { id: 'i01', title: 'Chosen', total: 83, scores: nine(7.8) },
      { id: 'i02', title: 'Runner-up', total: 79.5, scores: nine(8) },
      { id: 'i03', title: 'Top of the scale', total: 100, scores: nine(9) },
      { id: 'i04', title: 'Off the scale', total: 101, scores: nine(6) },
      { id: 'i05', title: 'No total, eight old scores', scores: { ...nine(7), clarity: undefined } },
    ] }, { date: DATE });
    assert.equal(doc.max, 100);
    assert.deepEqual(doc.dimensions, DIMENSIONS);
    assert.deepEqual(doc.ideas.map((i) => i.total), [83, 79.5, 100, 60, 70], 'select totals as they are; a damaged one or none: the mean of the given scores times ten');
    assert.equal(doc.ideas[0].scores.clarity, 7.8);
    assert.equal(doc.ideas[4].scores.clarity, 0, 'a missing criterion draws as 0 but does not drag the mean down');
  });

  test('an unscored shortlist (select never ran) has no ranking and no pick', () => {
    const { doc } = normalizeIdeas(makeUnscoredShortlist(), { date: DATE, source: 'work/x' });
    assert.equal(doc.ranked, false);
    assert.equal(doc.chosenId, null);
    assert.equal(doc.pickKind, 'none');
    assert.equal(doc.ideas.length, 10);
    assert.ok(doc.ideas.every((i) => i.scored === false && i.total === 0));
    assert.deepEqual(doc.ideas.map((i) => i.id), makeUnscoredShortlist().ideas.map((i) => i.id), 'delivery order is kept');

    // one scored idea is enough to rank; a recorded pick is honoured even if it has no scores
    const mixed = makeUnscoredShortlist();
    mixed.ideas[3].total = 61;
    mixed.ideas[3].scores.delight = 9;
    const m = normalizeIdeas(mixed, { date: DATE }).doc;
    assert.equal(m.ranked, true);
    assert.equal(m.chosenId, 'i04');
    assert.equal(m.pickKind, 'top-score');
    const chosen = normalizeIdeas({ ...makeUnscoredShortlist(), chosenId: 'i02' }, { date: DATE }).doc;
    assert.deepEqual([chosen.ranked, chosen.chosenId, chosen.pickKind], [false, 'i02', 'chosen']);
  });

  test('template and JSON escaping helpers', () => {
    assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
    assert.equal(fillTemplate('<p>{{A}}</p>{{&B}}', { A: '<b>', B: '<i>' }), '<p>&lt;b&gt;</p><i>');
    assert.throws(() => fillTemplate('{{MISSING}}', {}), /MISSING/);
    const js = jsonForScript({ s: '</script><!-- &  ' });
    assert.ok(!/<|>|&/.test(js));
    assert.equal(JSON.parse(js).s, '</script><!-- &  ');
  });
});

// ---------------------------------------------------------------------------------------------
// CLI: ideas-day, postcard, notice
// ---------------------------------------------------------------------------------------------

describe('fallback.mjs ideas-day', () => {
  test('publishes a valid Tier 3 project and registers a non-novelty history entry', async () => {
    const box = makeSandbox();
    try {
      const r = box.cli(['ideas-day', '--date', DATE, '--now', NOW]);
      assert.equal(r.code, 0, r.stderr + r.stdout);
      assert.equal(r.json.ok, true);
      assert.equal(r.json.tier, 3);
      assert.equal(r.json.validated, true);
      assert.equal(r.json.path, `docs/d/${DATE}-ideas-day/`);
      const dir = box.p('docs', 'd', `${DATE}-ideas-day`);
      for (const f of ['index.html', 'project.json', 'thumb.png', 'ideas.json', 'ideas.js', 'ideas.css']) assert.ok(fs.existsSync(path.join(dir, f)), f);

      const v = await validateProject(dir, { tier: 3 });
      assert.deepEqual(v.errors, []);
      const pj = box.json(`docs/d/${DATE}-ideas-day/project.json`);
      assert.equal(pj.tier, 3);
      assert.equal(pj.slug, 'ideas-day');
      assert.ok(pj.tagline.length <= 120);
      assert.deepEqual(pj.network, []);
      assert.ok(pj.sources.length >= 1 && pj.sources.every((s) => s.url.startsWith('https://')));
      assert.ok(pj.stats.files >= 6 && pj.stats.bytes > 1000);

      const thumb = decodePng(fs.readFileSync(path.join(dir, 'thumb.png')));
      assert.equal(thumb.width, 1200);
      assert.equal(thumb.height, 630);
      assert.ok(fs.statSync(path.join(dir, 'thumb.png')).size <= 300_000);

      const copy = JSON.parse(fs.readFileSync(path.join(dir, 'ideas.json'), 'utf8'));
      assert.equal(copy.ideas.length, 10);
      assert.equal(copy.chosenId, 'i04');

      const h = box.json('state/history.json');
      assert.equal(h.entries.length, 1);
      assert.equal(h.entries[0].tier, 3);
      assert.equal(h.entries[0].countsForNovelty, false);
      assert.equal(h.entries[0].path, `d/${DATE}-ideas-day/`);
      assert.equal(h.entries[0].n, 1);
      assert.ok(!box.exists(`work/${DATE}/tmp/fallback`), 'staging is cleaned up');
    } finally {
      box.cleanup();
    }
  });

  test('the page carries the honest banner, the pick, and the required page-shell conventions', () => {
    const box = makeSandbox();
    try {
      assert.equal(box.cli(['ideas-day', '--date', DATE, '--now', NOW]).code, 0);
      const html = box.read(`docs/d/${DATE}-ideas-day/index.html`);
      assert.ok(html.includes("Today's build didn't finish. Here is what the team was weighing."));
      assert.match(html, /<html lang="en">/);
      assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
      assert.match(html, /<a class="sed-back" href="\.\.\/\.\.\/">/);
      assert.match(html, /http-equiv="Content-Security-Policy"[^>]*connect-src 'self'/);
      assert.ok(!/connect-src[^;]*\*/.test(html));
      assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<link rel="stylesheet"'));
      const css = box.read(`docs/d/${DATE}-ideas-day/ideas.css`);
      assert.match(css, /prefers-color-scheme: dark/);
      assert.match(css, /prefers-reduced-motion: reduce/);
      assert.match(css, /:focus-visible/);
      assert.match(html, /<noscript>/);
      assert.ok(html.includes('Rinkside Rumor Mill'), 'the no-script list names the ideas');
      assert.match(html, /\(the pick\)/);
    } finally {
      box.cleanup();
    }
  });

  test('an unscored shortlist is published as an unranked list: no invented pick, score line or chart', async () => {
    const box = makeSandbox({ ideas: false });
    try {
      box.put(`work/${DATE}/ideas/shortlist.json`, makeUnscoredShortlist());
      const r = box.cli(['ideas-day', '--date', DATE, '--now', NOW]);
      assert.equal(r.code, 0, r.stderr + r.stdout);
      assert.equal(r.json.validated, true);
      const dir = `docs/d/${DATE}-ideas-day`;
      const html = box.read(`${dir}/index.html`);
      assert.ok(html.includes("Today's build didn't finish. Here is what the team was weighing."));
      assert.ok(!/highest|top score|\(the pick\)|score \d/i.test(html.replace(/<script[\s\S]*?<\/script>/g, '')), 'no ranking language outside the data');
      assert.match(html, /had not been scored, so there is no pick/);
      const pj = box.json(`${dir}/project.json`);
      assert.ok(!/highest|scores/i.test(pj.tagline + pj.description));
      assert.match(pj.description, /had not been scored/);
      const data = box.json(`${dir}/ideas.json`);
      assert.deepEqual([data.ranked, data.chosenId, data.pickKind], [false, null, 'none']);
      const thumb = decodePng(fs.readFileSync(box.p(dir, 'thumb.png')));
      assert.deepEqual([thumb.width, thumb.height], [1200, 630]);
      assert.equal((await validateProject(box.p(dir), { tier: 3 })).errors.length, 0);
      const notice = box.cli(['notice', '--date', DATE, '--reason', 'select never ran', '--now', NOW]);
      assert.equal(notice.json.notice.intendedWinner, null, 'no winner is claimed for the carry-over settle');
      // the same shortlist after select ran: ranked again, pick shown
      box.put(`state/ideas/${DATE}.json`, makeIdeas());
      assert.equal(box.cli(['ideas-day', '--date', DATE, '--now', NOW]).code, 0);
      assert.match(box.read(`${dir}/index.html`), /\(the pick\)/);
      assert.equal(box.json(`${dir}/ideas.json`).ranked, true);
    } finally {
      box.cleanup();
    }
  });

  test('hostile idea text never becomes markup and hostile links are dropped', async () => {
    const box = makeSandbox({ ideas: false });
    try {
      const ideas = makeIdeas(DATE, { evil: true });
      ideas.ideas[0].pitch = `<img src=x onerror=alert(1)> ${'ghp_'}${'a'.repeat(30)} ‮ reversed`;
      ideas.ideas[1].research.sources.push({ title: '<b>x</b>', url: 'https://evil.example/"><script>alert(1)</script>', verified: true });
      ideas.rationale = '</script><script>alert(2)</script>';
      box.put(`state/ideas/${DATE}.json`, ideas);
      const r = box.cli(['ideas-day', '--date', DATE, '--now', NOW]);
      assert.equal(r.code, 0, r.stderr + r.stdout);
      const html = box.read(`docs/d/${DATE}-ideas-day/index.html`);
      assert.ok(!html.includes('<script>alert'), 'no injected script element');
      assert.ok(!html.includes('<img src=x'), 'no injected element');
      assert.ok(!html.includes('javascript:'));
      assert.ok(!/ghp_a{30}/.test(html));
      assert.ok(!html.includes('‮'));
      const dataBlock = /<script type="application\/json" id="ideas-data">([\s\S]*?)<\/script>/.exec(html);
      assert.ok(dataBlock, 'data block present and closes exactly once');
      assert.ok(!/<|>/.test(dataBlock[1]));
      const data = JSON.parse(dataBlock[1]);
      assert.equal(data.rationale, '</script><script>alert(2)</script>');
      assert.ok(data.ideas[3].research.sources.every((s) => s.url === null || s.url.startsWith('https://')));
      assert.ok((await validateProject(box.p('docs', 'd', `${DATE}-ideas-day`), { tier: 3 })).ok);
    } finally {
      box.cleanup();
    }
  });

  test('falls back to work/<D>/ideas/shortlist.json, and skips a corrupt final file', () => {
    const box = makeSandbox({ ideas: false });
    try {
      box.put(`work/${DATE}/ideas/shortlist.json`, { ideas: makeIdeas().ideas });
      const a = box.cli(['ideas-day', '--date', DATE, '--now', NOW]);
      assert.equal(a.code, 0, a.stderr);
      assert.equal(a.json.source, `work/${DATE}/ideas/shortlist.json`);
      const doc = box.json(`docs/d/${DATE}-ideas-day/ideas.json`);
      assert.equal(doc.pickKind, 'top-score');
      assert.equal(doc.source, `work/${DATE}/ideas/shortlist.json`);

      box.put(`state/ideas/${DATE}.json`, '{ not json');
      const b = box.cli(['ideas-day', '--date', DATE, '--now', NOW]);
      assert.equal(b.code, 0, b.stderr);
      assert.equal(b.json.source, `work/${DATE}/ideas/shortlist.json`);
      assert.ok(b.json.warnings.some((w) => w.startsWith(`skipped state/ideas/${DATE}.json`)));
    } finally {
      box.cleanup();
    }
  });

  test('prefers state/ideas/<D>.json over the shortlist', () => {
    const box = makeSandbox();
    try {
      box.put(`work/${DATE}/ideas/shortlist.json`, { ideas: [{ title: 'Shortlist only' }] });
      const r = box.cli(['ideas-day', '--date', DATE, '--now', NOW]);
      assert.equal(r.json.source, `state/ideas/${DATE}.json`);
      assert.equal(r.json.ideas, 10);
    } finally {
      box.cleanup();
    }
  });

  test('exits 1 with a clear error when there are no usable ideas', () => {
    const box = makeSandbox({ ideas: false });
    try {
      const r = box.cli(['ideas-day', '--date', DATE, '--now', NOW]);
      assert.equal(r.code, 1);
      assert.equal(r.json.ok, false);
      assert.match(r.json.error, /no usable ideas for 2026-10-09/);
      assert.ok(!box.exists(`docs/d/${DATE}-ideas-day`));
      assert.equal(box.json('state/history.json').entries.length, 0);
    } finally {
      box.cleanup();
    }
  });

  test('is idempotent and never leaves a stale old directory behind', () => {
    const box = makeSandbox();
    try {
      const a = box.cli(['ideas-day', '--date', DATE, '--now', NOW]);
      const b = box.cli(['ideas-day', '--date', DATE, '--now', NOW]);
      assert.equal(a.code, 0);
      assert.equal(b.code, 0);
      assert.equal(b.json.replacedHistory, true);
      assert.equal(box.json('state/history.json').entries.length, 1);
      assert.deepEqual(fs.readdirSync(box.p('docs', 'd')), [`${DATE}-ideas-day`]);
    } finally {
      box.cleanup();
    }
  });

  test('an invalid page is never published: the old directory survives a failed validation', () => {
    const box = makeSandbox();
    try {
      assert.equal(box.cli(['ideas-day', '--date', DATE, '--now', NOW]).code, 0);
      const before = box.read(`docs/d/${DATE}-ideas-day/index.html`);
      // a config whose size cap is impossible makes every generated thumbnail "too large"
      const cfg = { ...TEST_CONFIG, limits: { ...TEST_CONFIG.limits, thumbMaxBytes: 2000 } };
      box.put('config.json', cfg);
      const r = box.cli(['ideas-day', '--date', DATE, '--now', NOW]);
      assert.equal(r.code, 1);
      assert.match(r.json.error, /failed validation/);
      assert.equal(box.read(`docs/d/${DATE}-ideas-day/index.html`), before);
      assert.ok(!box.exists(`work/${DATE}/tmp/fallback`) || fs.readdirSync(box.p('work', DATE, 'tmp', 'fallback')).length === 0);
    } finally {
      box.cleanup();
    }
  });
});

describe('fallback.mjs postcard', () => {
  test('publishes a valid Tier 4 project that needs no research', async () => {
    const box = makeSandbox({ ideas: false });
    try {
      const r = box.cli(['postcard', '--date', DATE, '--now', NOW]);
      assert.equal(r.code, 0, r.stderr + r.stdout);
      assert.equal(r.json.tier, 4);
      assert.equal(r.json.validated, true);
      const dir = box.p('docs', 'd', `${DATE}-postcard`);
      for (const f of ['index.html', 'project.json', 'thumb.png', 'postcard.css', 'postcard.js', 'postcard-scene.js']) assert.ok(fs.existsSync(path.join(dir, f)), f);
      assert.deepEqual((await validateProject(dir, { tier: 4 })).errors, []);
      const pj = box.json(`docs/d/${DATE}-postcard/project.json`);
      assert.equal(pj.tier, 4);
      assert.equal(pj.fingerprint.category, 'generative-art');
      assert.ok(pj.palette.length >= 2);
      const h = box.json('state/history.json');
      assert.equal(h.entries[0].tier, 4);
      assert.equal(h.entries[0].countsForNovelty, false);
      const html = box.read(`docs/d/${DATE}-postcard/index.html`);
      assert.match(html, /<svg [^>]*viewBox="0 0 1200 630"/, 'static SVG fallback is in the page');
      assert.match(html, /didn't|did not|never got done|came up short|ran out of road/i);
      assert.match(html, /tomorrow/i);
      assert.match(html, /<a class="sed-back" href="\.\.\/\.\.\/">/);
      const css = box.read(`docs/d/${DATE}-postcard/postcard.css`);
      assert.match(css, /prefers-reduced-motion: reduce/);
      assert.match(css, /prefers-color-scheme: dark/);
      assert.match(css, /:focus-visible/);
      assert.equal(decodePng(fs.readFileSync(path.join(dir, 'thumb.png'))).width, 1200);
    } finally {
      box.cleanup();
    }
  });

  test('is deterministic: the same date produces identical files', () => {
    const a = makeSandbox({ ideas: false });
    const b = makeSandbox({ ideas: false });
    try {
      a.cli(['postcard', '--date', DATE, '--now', NOW]);
      b.cli(['postcard', '--date', DATE, '--now', '2026-10-09T11:50:00Z']);
      for (const f of ['index.html', 'thumb.png', 'postcard-scene.js', 'postcard.js']) {
        assert.ok(fs.readFileSync(a.p('docs', 'd', `${DATE}-postcard`, f)).equals(fs.readFileSync(b.p('docs', 'd', `${DATE}-postcard`, f))), f);
      }
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });

  test('validates for a spread of dates (every family)', async () => {
    const box = makeSandbox({ ideas: false });
    try {
      const families = new Set();
      for (let i = 0; i < 16; i++) {
        const date = addDays(DATE, i);
        const r = box.cli(['postcard', '--date', date, '--now', `${date}T12:00:00Z`]);
        assert.equal(r.code, 0, r.stderr + r.stdout);
        families.add(r.json.family);
        assert.ok(r.json.thumbBytes <= 300_000);
        assert.deepEqual((await validateProject(box.p('docs', 'd', `${date}-postcard`), { tier: 4 })).errors, []);
      }
      assert.equal(families.size, 8);
    } finally {
      box.cleanup();
    }
  });
});

describe('a corrupt state/history.json never stops a fallback page', () => {
  const MARKERS = '<<<<<<< HEAD\n{"schema":1,"entries":[]}\n=======\n{"schema":1,"entries":[{"n":1}]}\n>>>>>>> origin\n';

  test('the postcard quarantines the bad file and carries on with a fresh history', () => {
    const box = makeSandbox({ ideas: false });
    try {
      box.put('state/history.json', MARKERS);
      const r = box.cli(['postcard', '--date', DATE, '--now', NOW]);
      assert.equal(r.code, 0, r.stderr + r.stdout);
      assert.ok(r.json.warnings.some((w) => /history\.json was unreadable/.test(w)), r.stdout);
      assert.equal(box.read('state/history.json.corrupt-1'), MARKERS, 'the evidence is kept');
      const h = box.json('state/history.json');
      assert.deepEqual(h.entries.map((e) => [e.date, e.tier, e.countsForNovelty]), [[DATE, 4, false]]);
      assert.equal(h.startDate, DATE);
    } finally {
      box.cleanup();
    }
  });

  test('earlier published days are rebuilt from docs/d, keeping what a committed copy knew', async () => {
    const box = makeSandbox({ ideas: false });
    try {
      const earlier = '2026-10-10';
      const entry = { n: 2, date: earlier, slug: 'real-thing', title: 'Real Thing', tagline: 'tag', tier: 1, fingerprint: { category: 'math-puzzle' }, path: `d/${earlier}-real-thing/`, publishedAt: '2026-10-10T11:00:00.000Z', countsForNovelty: true };
      box.put(`docs/d/${earlier}-real-thing/project.json`, { schema: 1, date: earlier, slug: 'real-thing', title: 'Real Thing', tagline: 'tag', tier: 1, fingerprint: { category: 'math-puzzle' } });
      box.put('docs/d/2026-10-11-junk/project.json', '{ not json');
      box.put('state/history.json', { schema: 1, startDate: DATE, entries: [entry] });
      const { execFileSync } = await import('node:child_process');
      const g = (...a) => execFileSync('git', a, { cwd: box.root, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.invalid' } });
      g('init', '-q');
      g('add', '-A');
      g('commit', '-q', '-m', 'seed');
      box.put('state/history.json', MARKERS);
      const r = box.cli(['postcard', '--date', DATE, '--now', NOW]);
      assert.equal(r.code, 0, r.stderr + r.stdout);
      const h = box.json('state/history.json');
      assert.deepEqual(h.entries.map((e) => e.date), [DATE, earlier]);
      assert.deepEqual(h.entries.find((e) => e.date === earlier), entry, 'n, publishedAt and countsForNovelty survive');
      assert.ok(r.json.warnings.some((w) => /rebuilt from docs\/d and the last commit/.test(w)), r.stdout);
    } finally {
      box.cleanup();
    }
  });

  test('a history that parses but has no entries array is repaired too, and a healthy one is never touched', () => {
    const box = makeSandbox({ ideas: false });
    try {
      const before = box.read('state/history.json');
      assert.equal(box.cli(['postcard', '--date', DATE, '--now', NOW]).code, 0);
      assert.ok(!box.exists('state/history.json.corrupt-1'), 'a readable history is never quarantined');
      assert.notEqual(box.read('state/history.json'), before);

      const other = makeSandbox({ ideas: true });
      try {
        other.put('state/history.json', { schema: 1, entries: 'nope' });
        const r = other.cli(['ideas-day', '--date', DATE, '--now', NOW]);
        assert.equal(r.code, 0, r.stderr + r.stdout);
        assert.ok(other.exists('state/history.json.corrupt-1'));
        assert.equal(other.json('state/history.json').entries[0].tier, 3);
        other.put('state/history.json', '{ again');
        assert.equal(other.cli(['ideas-day', '--date', DATE, '--now', NOW]).code, 0);
        assert.ok(other.exists('state/history.json.corrupt-2'), 'a second quarantine does not overwrite the first');
      } finally {
        other.cleanup();
      }
    } finally {
      box.cleanup();
    }
  });
});

describe('tier precedence', () => {
  test('Ideas Day replaces a Postcard (and removes its directory); a Postcard never replaces Ideas Day', () => {
    const box = makeSandbox();
    try {
      assert.equal(box.cli(['postcard', '--date', DATE, '--now', NOW]).code, 0);
      assert.ok(box.exists(`docs/d/${DATE}-postcard`));
      const up = box.cli(['ideas-day', '--date', DATE, '--now', NOW]);
      assert.equal(up.code, 0);
      assert.deepEqual(up.json.removed, [`docs/d/${DATE}-postcard`]);
      assert.ok(!box.exists(`docs/d/${DATE}-postcard`));
      assert.equal(box.json('state/history.json').entries[0].slug, 'ideas-day');

      const down = box.cli(['postcard', '--date', DATE, '--now', NOW]);
      assert.equal(down.code, 1);
      assert.equal(down.json.action, 'refused');
      assert.ok(box.exists(`docs/d/${DATE}-ideas-day`));
      assert.ok(!box.exists(`docs/d/${DATE}-postcard`));
      assert.equal(box.json('state/history.json').entries[0].tier, 3);
    } finally {
      box.cleanup();
    }
  });

  test('never touches a better published tier (history entry or run file), and keeps its directory', () => {
    const box = makeSandbox();
    try {
      box.put('state/history.json', { schema: 1, startDate: DATE, entries: [{ n: 1, date: DATE, slug: 'big-build', title: 'Big', tagline: 't', tier: 1, fingerprint: {}, path: `d/${DATE}-big-build/`, publishedAt: NOW, countsForNovelty: true }] });
      box.put(`docs/d/${DATE}-big-build/index.html`, '<html></html>');
      for (const cmd of ['ideas-day', 'postcard']) {
        const r = box.cli([cmd, '--date', DATE, '--now', NOW]);
        assert.equal(r.code, 1);
        assert.equal(r.json.action, 'refused');
        assert.equal(r.json.tier, 1);
      }
      assert.ok(box.exists(`docs/d/${DATE}-big-build/index.html`));
      assert.equal(box.json('state/history.json').entries[0].slug, 'big-build');

      const other = makeSandbox();
      try {
        other.put(`state/runs/${DATE}.json`, { schema: 1, date: DATE, status: 'published', targetTier: 1, tier: 2, phase: 'done' });
        assert.equal(other.cli(['postcard', '--date', DATE, '--now', NOW]).json.action, 'refused');
      } finally {
        other.cleanup();
      }
    } finally {
      box.cleanup();
    }
  });

  test('does not delete a tier 1 or 2 directory that happens to share the fallback name', () => {
    const box = makeSandbox();
    try {
      box.put(`docs/d/${DATE}-postcard/project.json`, { tier: 2 });
      const r = box.cli(['ideas-day', '--date', DATE, '--now', NOW]);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(r.json.removed, []);
      assert.ok(box.exists(`docs/d/${DATE}-postcard/project.json`));
    } finally {
      box.cleanup();
    }
  });
});

describe('fallback.mjs notice and usage', () => {
  test('notice writes work/<D>/fallback-notice.json and accumulates reasons', () => {
    const box = makeSandbox();
    try {
      const a = box.cli(['notice', '--date', DATE, '--reason', 'primary session died at 06:10', '--now', NOW]);
      assert.equal(a.code, 0, a.stderr);
      assert.equal(a.json.file, `work/${DATE}/fallback-notice.json`);
      const b = box.cli(['notice', '--date', DATE, '--reason', 'closer took over', '--now', '2026-10-09T11:36:00Z']);
      const n = box.json(`work/${DATE}/fallback-notice.json`);
      assert.equal(n.schema, 1);
      assert.equal(n.date, DATE);
      assert.deepEqual(n.reasons.map((r) => r.reason), ['primary session died at 06:10', 'closer took over']);
      assert.equal(n.intendedWinner.id, 'i04');
      assert.equal(n.intendedWinner.title, 'Rinkside Rumor Mill');
      assert.equal(n.ideasSource, `state/ideas/${DATE}.json`);
      assert.deepEqual(n.tiersAvailable, { 3: true, 4: true });
      assert.equal(n.published, null);
      assert.equal(b.json.ok, true);

      box.cli(['ideas-day', '--date', DATE, '--now', NOW]);
      box.cli(['notice', '--date', DATE, '--reason', 'again', '--now', NOW]);
      assert.equal(box.json(`work/${DATE}/fallback-notice.json`).published.tier, 3);
    } finally {
      box.cleanup();
    }
  });

  test('notice without ideas reports tier 3 as unavailable', () => {
    const box = makeSandbox({ ideas: false });
    try {
      assert.equal(box.cli(['notice', '--date', DATE, '--reason', 'x', '--now', NOW]).code, 0);
      const n = box.json(`work/${DATE}/fallback-notice.json`);
      assert.equal(n.intendedWinner, null);
      assert.deepEqual(n.tiersAvailable, { 3: false, 4: true });
    } finally {
      box.cleanup();
    }
  });

  test('usage errors exit 2 with a JSON error', () => {
    const box = makeSandbox();
    try {
      for (const args of [[], ['nope'], ['notice', '--date', DATE], ['postcard', '--date', 'tomorrow'], ['postcard', '--now', 'garbage']]) {
        const r = box.cli(args);
        assert.equal(r.code, 2, JSON.stringify(args));
        assert.equal(r.json.ok, false);
      }
    } finally {
      box.cleanup();
    }
  });

  test('the date defaults to today in the configured time zone, and the scripts import without side effects', async () => {
    const box = makeSandbox({ ideas: false });
    try {
      // 02:00Z on the 10th is still the 9th in New York
      const r = box.cli(['postcard', '--now', '2026-10-10T02:00:00Z']);
      assert.equal(r.json.date, DATE);
      assert.equal(r.json.path, `docs/d/${DATE}-postcard/`);
    } finally {
      box.cleanup();
    }
    const before = fs.existsSync(path.join(REPO_ROOT, 'docs', 'd'));
    await import('../scripts/fallback.mjs');
    await import('../scripts/deadman.mjs');
    assert.equal(fs.existsSync(path.join(REPO_ROOT, 'docs', 'd')), before);
  });
});

// ---------------------------------------------------------------------------------------------
// real browser (skipped when Playwright or Chromium is unavailable)
// ---------------------------------------------------------------------------------------------

function findChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  try {
    for (const d of fs.readdirSync(base).filter((n) => /^chromium-\d+$/.test(n))) {
      const exe = path.join(base, d, 'chrome-linux', 'chrome');
      if (fs.existsSync(exe)) return exe;
    }
  } catch { /* none */ }
  return null;
}

function loadPlaywright() {
  const candidates = [];
  try {
    const root = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' }).stdout.trim();
    if (root) candidates.push(root);
  } catch { /* no npm */ }
  for (const c of candidates) {
    try {
      return createRequire(`${c}/`)('playwright');
    } catch { /* try next */ }
  }
  return null;
}

function serve(dir) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
  const server = http.createServer((req, res) => {
    let p = path.join(dir, decodeURIComponent(req.url.split('?')[0]));
    if (p.endsWith(path.sep)) p = path.join(p, 'index.html');
    fs.readFile(p, (err, body) => {
      if (err) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': types[path.extname(p)] ?? 'application/octet-stream' });
      res.end(body);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` })));
}

const pw = loadPlaywright();
const chrome = findChromium();
const browserTest = pw && chrome ? test : test.skip;

describe('in a real browser', () => {
  browserTest('Ideas Day: renders safely, sorts, filters, expands, deep-links, and has no console errors or overflow at 360px', async () => {
    const box = makeSandbox({ ideas: false });
    const ideas = makeIdeas(DATE, { evil: true });
    box.put(`state/ideas/${DATE}.json`, ideas);
    assert.equal(box.cli(['ideas-day', '--date', DATE, '--now', NOW]).code, 0);
    const { server, url } = await serve(box.p('docs', 'd', `${DATE}-ideas-day`));
    const browser = await pw.chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
    try {
      const ctx = await browser.newContext({ viewport: { width: 360, height: 800 } });
      const page = await ctx.newPage();
      const problems = [];
      const external = [];
      page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text()); });
      page.on('pageerror', (e) => problems.push(e.message));
      page.on('request', (r) => { if (!r.url().startsWith(url) && !r.url().startsWith('data:')) external.push(r.url()); });
      let dialogs = 0;
      page.on('dialog', async (d) => { dialogs++; await d.dismiss(); });
      await page.goto(url);
      assert.equal(await page.locator('li.idea').count(), 10);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, 'no horizontal overflow at 360px');
      assert.ok(await page.locator('#pick h2').innerText().then((t) => t.includes('<script>')), 'hostile title shows as text');
      assert.equal(await page.locator('script', { hasText: 'alert(1)' }).count(), 0);

      const titles = () => page.locator('li.idea:not([hidden]) .t-title').allInnerTexts();
      const byScore = await titles();
      await page.selectOption('#sort', 'title');
      const byTitle = await titles();
      assert.notDeepEqual(byTitle, byScore);
      assert.equal(byTitle[0].toLowerCase() <= byTitle[1].toLowerCase(), true);
      await page.click('#dir');
      assert.equal((await titles())[0], byTitle[byTitle.length - 1]);
      await page.selectOption('#sort', 'total');
      assert.deepEqual(await titles(), byScore);

      await page.fill('#q', 'planetarium');
      assert.deepEqual(await titles(), ['Tiny Planetarium']);
      assert.match(await page.locator('#count').innerText(), /Showing 1 of 10/);
      await page.fill('#q', 'zzzz-nothing');
      assert.equal(await page.locator('#empty').isVisible(), true);
      await page.click('#reset');
      assert.equal((await titles()).length, 10);
      await page.selectOption('#cat', 'hockey-sports');
      assert.deepEqual(await titles(), ['Glass Tempo']);
      await page.click('#reset');

      const first = page.locator('li.idea .toggle').first();
      assert.equal(await first.getAttribute('aria-expanded'), 'false');
      await first.click();
      assert.equal(await first.getAttribute('aria-expanded'), 'true');
      const panel = page.locator('li.idea .dossier').first();
      assert.equal(await panel.isVisible(), true);
      assert.ok(await panel.locator('svg.radar').count() === 1);
      assert.ok((await panel.locator('svg.radar').innerHTML()).includes('>CLAR<'), 'the clarity axis is labelled');
      assert.ok((await panel.innerText()).includes('Clarity'), 'the score bars name clarity');
      assert.ok(await panel.locator('a[href^="https://"]').count() >= 1);
      assert.equal(await panel.locator('a[rel="noopener noreferrer nofollow"]').count(), await panel.locator('a').count());
      assert.ok((await panel.innerText()).includes('unverified'));
      await page.click('#toggle-all');
      assert.equal(await page.locator('li.idea .dossier:visible').count(), 10);
      await page.click('#toggle-all');
      assert.equal(await page.locator('li.idea .dossier:visible').count(), 0);

      // the pick's total above 80 is shown as select wrote it, out of 100
      assert.match(await page.locator('#pick').innerText(), /Team score 81 of 100/);
      await page.goto(`${url}#idea-i06`);
      assert.equal(await page.locator('#idea-i06 .toggle').getAttribute('aria-expanded'), 'true');
      await page.keyboard.press('/');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'q');
      assert.equal(dialogs, 0);
      assert.deepEqual(external, []);
      assert.deepEqual(problems, []);

      const dark = await browser.newContext({ viewport: { width: 1200, height: 800 }, colorScheme: 'dark', reducedMotion: 'reduce' });
      const dpage = await dark.newPage();
      await dpage.goto(url);
      const bg = await dpage.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const [r, g, b] = bg.match(/\d+/g).map(Number);
      assert.ok(r + g + b < 200, `dark background ${bg}`);
    } finally {
      await browser.close();
      server.close();
      box.cleanup();
    }
  });

  browserTest('Ideas Day from an unscored shortlist: no pick, no scores, no radar, still sortable and error-free', async () => {
    const box = makeSandbox({ ideas: false });
    box.put(`work/${DATE}/ideas/shortlist.json`, makeUnscoredShortlist());
    assert.equal(box.cli(['ideas-day', '--date', DATE, '--now', NOW]).code, 0);
    const { server, url } = await serve(box.p('docs', 'd', `${DATE}-ideas-day`));
    const browser = await pw.chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
    try {
      const page = await (await browser.newContext({ viewport: { width: 360, height: 800 } })).newPage();
      const problems = [];
      page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text()); });
      page.on('pageerror', (e) => problems.push(e.message));
      await page.goto(url);
      assert.equal(await page.locator('li.idea').count(), 10);
      const body = await page.locator('body').innerText();
      assert.ok(!/highest|top score|team score|of 100\b/i.test(body), `ranking language on the page: ${body.slice(0, 300)}`);
      assert.equal(await page.locator('#pick h2').innerText(), 'No pick was made');
      assert.equal((await page.locator('.pick-label').innerText()).toLowerCase(), 'not ranked yet');
      assert.equal(await page.locator('#pick svg').count(), 0, 'no radar in the hero');
      assert.equal(await page.locator('li.idea .total').count(), 0, 'no per-idea score');
      assert.equal(await page.locator('li.idea.is-pick').count(), 0);
      assert.deepEqual(await page.locator('#sort option').allInnerTexts(), ['Shortlist order', 'Title (A to Z)']);
      assert.equal(await page.locator('#sort').inputValue(), 'order');
      const titles = () => page.locator('li.idea:not([hidden]) .t-title').allInnerTexts();
      const delivered = await titles();
      assert.equal(delivered[0], 'Range Weather Report');
      await page.selectOption('#sort', 'title');
      assert.notDeepEqual(await titles(), delivered);
      await page.click('#reset');
      assert.deepEqual(await titles(), delivered);
      await page.click('#toggle-all');
      assert.equal(await page.locator('li.idea .dossier:visible').count(), 10);
      assert.equal(await page.locator('.dossier svg.radar').count(), 0, 'no radar in any dossier');
      assert.ok((await page.locator('.dossier').first().innerText()).includes('Not scored'));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
      assert.deepEqual(problems, []);
    } finally {
      await browser.close();
      server.close();
      box.cleanup();
    }
  });

  browserTest('Postcard: animates on canvas, keeps the SVG for reduced motion, pauses, saves, no console errors', async () => {
    const box = makeSandbox({ ideas: false });
    assert.equal(box.cli(['postcard', '--date', DATE, '--now', NOW]).code, 0);
    const { server, url } = await serve(box.p('docs', 'd', `${DATE}-postcard`));
    const browser = await pw.chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
    try {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
      const page = await ctx.newPage();
      const problems = [];
      const external = [];
      page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text()); });
      page.on('pageerror', (e) => problems.push(e.message));
      page.on('request', (r) => { if (!r.url().startsWith(url) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) external.push(r.url()); });
      await page.goto(url);
      await page.waitForSelector('#stage canvas', { state: 'attached' });
      await page.waitForFunction(() => document.querySelector('#stage canvas').style.visibility === 'visible');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, 'no overflow at 390px');
      const sig = () => page.evaluate(() => { const c = document.querySelector('#stage canvas'); return c.toDataURL().length + ':' + c.toDataURL().slice(-60); });
      const s1 = await sig();
      await page.waitForTimeout(700);
      assert.notEqual(await sig(), s1, 'the canvas animates');
      await page.click('#play');
      assert.equal(await page.getAttribute('#play', 'aria-pressed'), 'false');
      const frozen = await sig();
      await page.waitForTimeout(500);
      assert.equal(await sig(), frozen, 'pause freezes the frame');
      const [download] = await Promise.all([page.waitForEvent('download'), page.click('#save')]);
      assert.equal(download.suggestedFilename(), `postcard-${DATE}.png`);
      const saved = fs.readFileSync(await download.path());
      assert.equal(decodePng(saved).width, 1200);
      assert.deepEqual(external, []);
      assert.deepEqual(problems, []);

      const calm = await browser.newContext({ viewport: { width: 1000, height: 700 }, reducedMotion: 'reduce' });
      const cpage = await calm.newPage();
      await cpage.goto(url);
      await cpage.waitForTimeout(600);
      assert.equal(await cpage.locator('#stage canvas').count(), 0, 'reduced motion does not start the animation');
      assert.equal(await cpage.locator('#stage svg').isVisible(), true);
      assert.equal(await cpage.locator('#play').innerText(), 'Play animation');

      const nojs = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1000, height: 700 } });
      const npage = await nojs.newPage();
      await npage.goto(url);
      assert.equal(await npage.locator('#stage svg').isVisible(), true);
      assert.equal(await npage.locator('#controls').isVisible(), false);
    } finally {
      await browser.close();
      server.close();
      box.cleanup();
    }
  });
});
