// Tests for scripts/build-site.mjs, scripts/lib/archive.mjs and scripts/verify-live.mjs.
// Everything runs against SED_ROOT sandboxes in os.tmpdir(); the real state/, docs/ and work/ are never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildSite } from '../scripts/build-site.mjs';
import {
  escapeHtml, escapeXml, jsonForScript, renderTemplate, streakOf, missingDatesBetween, buildArchive,
  renderFeed, renderSitemap, renderRobots, normalizeSiteUrl, absoluteUrl, FEED_LIMIT,
  normalizeKaizen, kaizenTeaser, summarizeKaizen, renderKaizenPage, renderKaizenJson,
} from '../scripts/lib/archive.mjs';
import { verifyLive, archiveUrl } from '../scripts/verify-live.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_ROOT = path.resolve(HERE, '..');
const BUILD_CLI = path.join(REAL_ROOT, 'scripts', 'build-site.mjs');
const VERIFY_CLI = path.join(REAL_ROOT, 'scripts', 'verify-live.mjs');

const SITE_URL = 'https://example.test/site/';
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; base-uri 'none'; form-action 'none'";

const INDEX_TEMPLATE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>{{SITE_NAME}}</title>
<meta name="description" content="{{SITE_TAGLINE}}"><link rel="canonical" href="{{SITE_URL}}"></head>
<body data-generated="{{GENERATED_AT}}"><ul id="plain">
{{NOSCRIPT_LIST}}
</ul>
<script type="application/json" id="archive">{{ARCHIVE_JSON}}</script>
</body></html>
`;
const NOT_FOUND_TEMPLATE = '<!doctype html><html lang="en"><head><title>Lost - {{SITE_NAME}}</title></head><body><a href="{{SITE_URL}}">home</a></body></html>\n';
const GALLERY_CSS = 'body { color: #123; }\n/* verbatim ☃ */\n';
const GALLERY_JS = '"use strict";\nconsole.log("gallery ☃");\n';

// ---------- fixtures ----------

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function makePng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) {
    row[1 + x * 3] = 11;
    row[2 + x * 3] = 16 + (x % 40);
    row[3 + x * 3] = 32;
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}
const TINY_PNG = makePng(1, 1);
const FULL_PNG = makePng(1200, 630);

function fingerprint(over = {}) {
  return {
    category: 'math-puzzle', mechanic: 'toy', tone: ['playful'], tech: ['canvas2d'],
    tags: ['automaton', 'cells', 'palette'], keywords: ['grid', 'rules', 'seed'], slot: 'wildcard', political: false, ...over,
  };
}

function projectJson({ date, slug, title = 'Probe', tier = 1, category = 'math-puzzle', ...over }) {
  return {
    schema: 1, date, slug, title, tagline: `Tagline for ${title}`, description: `Description of ${title}.`, tier,
    fingerprint: fingerprint({ category }), palette: ['#0b1020', '#ff3d6e', '#ffd166'], entry: 'index.html', thumb: 'thumb.png',
    network: [], sources: [{ title: 'Example', url: 'https://example.com/' }], makingOf: 'Test fixture.',
    stats: { files: 3, bytes: 1000, ownLoc: 10 }, credits: 'Built by the Sonnet Every Day team', ...over,
  };
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Probe</title>
</head>
<body>
<a class="sed-back" href="../../">&larr; Sonnet Every Day</a>
<main><h1>Probe</h1></main>
</body>
</html>
`;

function makeSandbox({ config = {}, templates = true, assets = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sed-sitegen-'));
  const cfg = { ...JSON.parse(fs.readFileSync(path.join(REAL_ROOT, 'config.json'), 'utf8')), siteUrl: SITE_URL, ...config };
  const put = (rel, content) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  };
  put('config.json', JSON.stringify(cfg, null, 2));
  fs.mkdirSync(path.join(root, 'ops'), { recursive: true });
  fs.copyFileSync(path.join(REAL_ROOT, 'ops', 'taxonomy.json'), path.join(root, 'ops', 'taxonomy.json'));
  put('state/history.json', JSON.stringify({ schema: 1, startDate: cfg.startDate, entries: [] }));
  fs.mkdirSync(path.join(root, 'docs', 'd'), { recursive: true });
  if (templates) {
    put('site-src/index.template.html', INDEX_TEMPLATE);
    put('site-src/404.template.html', NOT_FOUND_TEMPLATE);
  }
  if (assets) {
    put('site-src/gallery.css', GALLERY_CSS);
    put('site-src/gallery.js', GALLERY_JS);
  }
  const prior = process.env.SED_ROOT;
  process.env.SED_ROOT = root;
  const box = {
    root, cfg, put,
    p: (...parts) => path.join(root, ...parts),
    read: (rel) => fs.readFileSync(path.join(root, rel), 'utf8'),
    readJson: (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')),
    exists: (rel) => fs.existsSync(path.join(root, rel)),
    cleanup() {
      if (prior === undefined) delete process.env.SED_ROOT;
      else process.env.SED_ROOT = prior;
      fs.rmSync(root, { recursive: true, force: true });
    },
    /** Writes docs/d/<date>-<slug>/ and its history entry (history is rewritten in one go by addAll). */
    project(spec) {
      const { thumb, page, ...meta } = spec;
      const dir = `docs/d/${meta.date}-${meta.slug}`;
      put(`${dir}/project.json`, JSON.stringify(projectJson(meta), null, 2));
      put(`${dir}/index.html`, page ?? PAGE);
      put(`${dir}/thumb.png`, thumb ?? TINY_PNG);
      return { dir, entry: historyEntry(meta, box.cfg.startDate) };
    },
    /** Creates projects (and history) for the given specs. */
    addAll(specs) {
      const entries = specs.map((s) => box.project(s).entry);
      put('state/history.json', JSON.stringify({ schema: 1, startDate: cfg.startDate, entries }, null, 2));
      return entries;
    },
    docsSnapshot() {
      const out = {};
      const walk = (rel) => {
        for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
          const r = path.posix.join(rel, e.name);
          if (e.isDirectory()) walk(r);
          else out[r] = fs.readFileSync(path.join(root, r)).toString('base64');
        }
      };
      walk('docs');
      return out;
    },
  };
  return box;
}

function historyEntry({ date, slug, title = 'Probe', tier = 1, category = 'math-puzzle', countsForNovelty }, startDate) {
  const n = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000) + 1;
  return {
    n, date, slug, title, tagline: `Tagline for ${title}`, tier, fingerprint: fingerprint({ category }), path: `d/${date}-${slug}/`,
    publishedAt: `${date}T10:30:00.000Z`, countsForNovelty: countsForNovelty ?? tier <= 2,
  };
}

const NOW = new Date('2026-10-13T11:00:00Z'); // 07:00 EDT on 2026-10-13
const okValidator = async () => ({ ok: true, errors: [], warnings: [] });

async function withBox(opts, fn) {
  const box = makeSandbox(opts);
  try {
    await fn(box);
  } finally {
    box.cleanup();
  }
}

function inlineArchive(html) {
  const m = /<script type="application\/json" id="archive">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, 'inline archive script block present');
  return JSON.parse(m[1]);
}

/** Tiny strict-enough XML well-formedness check (tags nest, attributes quoted, only known entities, no raw `<` or bad chars). */
function assertWellFormedXml(xml) {
  assert.match(xml, /^<\?xml version="1\.0" encoding="utf-8"\?>\n/);
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(xml, /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/);
  const stack = [];
  const re = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|<\?xml[^?]*\?>|([^<]+)/g;
  let roots = 0;
  let m;
  let pos = 0;
  while ((m = re.exec(xml))) {
    assert.equal(m.index, pos, `unparseable markup near offset ${pos}: ${xml.slice(pos, pos + 40)}`);
    pos = re.lastIndex;
    if (m[5] !== undefined) {
      assert.ok(m[5].trim() === '' || stack.length > 0, 'text outside the root element');
      for (const ref of m[5].matchAll(/&([^;\s]*);?/g)) assert.match(ref[0], /^&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);$/, `bad entity ${ref[0]}`);
    } else if (m[2]) {
      for (const attr of m[3].matchAll(/"([^"]*)"/g)) {
        for (const ref of attr[1].matchAll(/&([^;\s]*);?/g)) assert.match(ref[0], /^&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);$/);
      }
      if (m[1]) assert.equal(stack.pop(), m[2], `mismatched closing tag </${m[2]}>`);
      else {
        if (!m[4]) stack.push(m[2]);
        if (stack.length === (m[4] ? 0 : 1)) roots++;
      }
    }
  }
  assert.equal(pos, xml.length);
  assert.deepEqual(stack, []);
  assert.equal(roots, 1, 'exactly one root element');
}

// ---------- pure helpers ----------

test('escapeHtml and escapeXml cover the markup characters and drop illegal characters', () => {
  assert.equal(escapeHtml(`<a href="x" b='y'>&</a>`), '&lt;a href=&quot;x&quot; b=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  assert.equal(escapeXml(`<a b='y'>"&`), '&lt;a b=&apos;y&apos;&gt;&quot;&amp;');
  assert.equal(escapeXml('a\u0000b\u0008c\u000bd￿e\ud800f'), 'abcdef');
  assert.equal(escapeXml('tab\tnl\ncr\r'), 'tab\tnl\ncr\r');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(42), '42');
});

test('jsonForScript can never break out of a script block and round-trips exactly', () => {
  const nasty = { t: '</script><script>alert(1)</script><!-- &     <img onerror=x>', n: [1, null, true], u: 'café 😀' };
  const out = jsonForScript(nasty);
  for (const bad of ['<', '>', '&', ' ', ' ']) assert.ok(!out.includes(bad), `output must not contain ${JSON.stringify(bad)}`);
  assert.deepEqual(JSON.parse(out), nasty);
});

test('renderTemplate replaces every placeholder in a single pass without interpreting values', () => {
  const archive = {
    site: { name: 'A & B $& "q"', tagline: 'tag $1 {{SITE_URL}}', url: 'https://x.test/' },
    generatedAt: '2026-10-13T11:00:00.000Z', days: [{ path: 'd/a/', title: '{{SITE_NAME}}', date: '2026-10-13', tagline: '' }],
  };
  const { html, unknown, missing } = renderTemplate('{{SITE_NAME}}|{{SITE_TAGLINE}}|{{SITE_URL}}|{{GENERATED_AT}}|{{NOSCRIPT_LIST}}|{{ARCHIVE_JSON}}|{{NOPE}}', archive);
  const parts = html.split('|');
  assert.equal(parts[0], 'A &amp; B $&amp; &quot;q&quot;');
  assert.equal(parts[1], 'tag $1 {{SITE_URL}}', 'values are not re-scanned for placeholders');
  assert.equal(parts[2], 'https://x.test/');
  assert.equal(parts[3], archive.generatedAt);
  assert.match(parts[4], /^<li><a href="d\/a\/">\{\{SITE_NAME\}\}<\/a> <time datetime="2026-10-13">2026-10-13<\/time><\/li>$/);
  assert.deepEqual(JSON.parse(parts[5]), archive);
  assert.equal(parts[6], '{{NOPE}}');
  assert.deepEqual(unknown, ['{{NOPE}}']);
  assert.deepEqual(missing, []);
  assert.deepEqual(renderTemplate('plain', archive).missing.sort(), ['ARCHIVE_JSON', 'GENERATED_AT', 'NOSCRIPT_LIST', 'SITE_NAME', 'SITE_TAGLINE', 'SITE_URL']);
});

test('streakOf counts consecutive dates ending at the latest, across month and DST boundaries', () => {
  assert.equal(streakOf([]), 0);
  assert.equal(streakOf(['2026-10-09']), 1);
  assert.equal(streakOf(['2026-10-09', '2026-10-10', '2026-10-12']), 1);
  assert.equal(streakOf(['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-09']), 4);
  assert.equal(streakOf(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-10-01']), 5);
  assert.equal(streakOf(['2027-02-28', '2027-03-01', '2027-03-02']), 3);
});

test('missingDatesBetween lists the gaps in a closed range', () => {
  assert.deepEqual(missingDatesBetween('2026-10-09', '2026-10-13', ['2026-10-09', '2026-10-11', '2026-10-13']), ['2026-10-10', '2026-10-12']);
  assert.deepEqual(missingDatesBetween('2026-10-09', '2026-10-08', []), []);
  assert.deepEqual(missingDatesBetween('2026-10-09', '2026-10-09', []), ['2026-10-09']);
});

test('normalizeSiteUrl and absoluteUrl', () => {
  assert.equal(normalizeSiteUrl('https://a.test/x'), 'https://a.test/x/');
  assert.equal(normalizeSiteUrl('https://a.test/x/?q=1#h'), 'https://a.test/x/');
  assert.throws(() => normalizeSiteUrl('not a url'), /siteUrl/);
  assert.throws(() => normalizeSiteUrl('ftp://a.test/'), /http/);
  assert.equal(absoluteUrl('https://a.test/x/', 'd/2026-10-09-a b/thumb.png'), 'https://a.test/x/d/2026-10-09-a%20b/thumb.png');
  assert.equal(absoluteUrl('https://a.test/x/', 'd/2026-10-09-a/'), 'https://a.test/x/d/2026-10-09-a/');
});

test('buildArchive derives day numbers, stats and the missing-date list', () => {
  const config = { name: 'Site', startDate: '2026-10-09' };
  const mk = (date, slug, tier, category) => ({ entry: historyEntry({ date, slug, tier, category }, config.startDate), project: projectJson({ date, slug, tier, category }) });
  const archive = buildArchive({
    projects: [mk('2026-10-09', 'a', 1, 'cards-odds'), mk('2026-10-11', 'b', 3, 'cards-odds'), mk('2026-10-12', 'c', 1, 'generative-art')],
    config, siteUrl: SITE_URL, now: NOW, through: '2026-10-13',
  });
  assert.deepEqual(archive.days.map((d) => [d.n, d.date]), [[4, '2026-10-12'], [3, '2026-10-11'], [1, '2026-10-09']]);
  assert.deepEqual(archive.stats, {
    days: 5, projects: 3, streak: 2, categories: { 'cards-odds': 2, 'generative-art': 1 }, tiers: { 1: 2, 3: 1 },
    firstDate: '2026-10-09', lastDate: '2026-10-12', missingDates: ['2026-10-10', '2026-10-13'],
  });
  assert.equal(archive.generatedAt, NOW.toISOString());
  assert.equal(archive.site.url, SITE_URL);
  assert.ok(archive.site.tagline.length > 10);
  assert.equal(archive.days[0].thumb, 'd/2026-10-12-c/thumb.png');
  assert.equal(archive.days[0].path, 'd/2026-10-12-c/');
  const empty = buildArchive({ projects: [], config, siteUrl: SITE_URL, now: NOW, through: '2026-10-08' });
  assert.deepEqual(empty.stats, { days: 0, projects: 0, streak: 0, categories: {}, tiers: {}, firstDate: null, lastDate: null, missingDates: [] });
});

// ---------- buildSite ----------

test('buildSite writes the whole site from history and project.json', async () => {
  await withBox({}, async (box) => {
    box.addAll([
      { date: '2026-10-09', slug: 'first-toy', title: 'First Toy', category: 'cards-odds' },
      { date: '2026-10-10', slug: 'second-toy', title: 'Second Toy', category: 'hockey-sports' },
      { date: '2026-10-12', slug: 'ideas-day', title: 'Ideas Day', tier: 3, category: 'cards-odds' },
    ]);
    const res = await buildSite({ now: NOW, validate: okValidator });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.projects, 3);
    assert.deepEqual(res.omitted, []);

    for (const f of ['index.html', 'archive.json', 'feed.xml', 'sitemap.xml', 'robots.txt', '404.html', '.nojekyll', 'assets/gallery.css', 'assets/gallery.js']) {
      assert.ok(box.exists(`docs/${f}`), `docs/${f} exists`);
    }
    assert.equal(box.read('docs/.nojekyll'), '');
    assert.equal(box.read('docs/assets/gallery.css'), GALLERY_CSS, 'css copied verbatim');
    assert.equal(box.read('docs/assets/gallery.js'), GALLERY_JS, 'js copied verbatim');

    const archive = box.readJson('docs/archive.json');
    assert.equal(archive.schema, 1);
    assert.equal(archive.generatedAt, NOW.toISOString());
    assert.deepEqual(archive.site, { name: 'Sonnet Every Day', tagline: archive.site.tagline, url: SITE_URL, startDate: '2026-10-09' });
    assert.deepEqual(archive.days.map((d) => d.date), ['2026-10-12', '2026-10-10', '2026-10-09']);
    assert.deepEqual(archive.days.map((d) => d.n), [4, 2, 1]);
    // 07:00 on Oct 13 is before the 08:00 deadline, so Oct 13 is not yet "missing"; Oct 11 is.
    assert.deepEqual(archive.stats, {
      days: 4, projects: 3, streak: 1, categories: { 'cards-odds': 2, 'hockey-sports': 1 }, tiers: { 1: 2, 3: 1 },
      firstDate: '2026-10-09', lastDate: '2026-10-12', missingDates: ['2026-10-11'],
    });
    assert.deepEqual(Object.keys(archive.days[0]), [
      'n', 'date', 'slug', 'path', 'title', 'tagline', 'description', 'tier', 'category', 'mechanic', 'tone', 'tech', 'tags', 'palette', 'thumb',
    ]);
    assert.equal(archive.days[0].thumb, 'd/2026-10-12-ideas-day/thumb.png');

    const index = box.read('docs/index.html');
    assert.deepEqual(inlineArchive(index), archive, 'inline JSON equals archive.json');
    assert.match(index, /<title>Sonnet Every Day<\/title>/);
    assert.match(index, /<link rel="canonical" href="https:\/\/example\.test\/site\/">/);
    assert.match(index, /data-generated="2026-10-13T11:00:00\.000Z"/);
    assert.match(index, /<li><a href="d\/2026-10-12-ideas-day\/">Ideas Day<\/a> <time datetime="2026-10-12">2026-10-12<\/time>/);
    assert.ok(index.indexOf('Ideas Day') < index.indexOf('Second Toy') && index.indexOf('Second Toy') < index.indexOf('First Toy'), 'noscript list is newest first');
    assert.doesNotMatch(index, /\{\{[A-Z_]+\}\}/);
    assert.match(box.read('docs/404.html'), /<title>Lost - Sonnet Every Day<\/title>/);
    assert.match(box.read('docs/404.html'), /href="https:\/\/example\.test\/site\/"/);
    assert.deepEqual(fs.readdirSync(box.p('docs')).filter((f) => f.endsWith('.tmp')), []);
    assert.deepEqual(fs.readdirSync(box.p('docs', 'assets')).filter((f) => f.endsWith('.tmp')), []);
  });
});

test('buildSite on an empty history still produces a valid site', async () => {
  await withBox({}, async (box) => {
    const res = await buildSite({ now: new Date('2026-10-09T08:00:00Z'), validate: okValidator });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.projects, 0);
    const archive = box.readJson('docs/archive.json');
    assert.deepEqual(archive.days, []);
    assert.equal(archive.stats.lastDate, null);
    assertWellFormedXml(box.read('docs/feed.xml'));
    assertWellFormedXml(box.read('docs/sitemap.xml'));
    assert.deepEqual(inlineArchive(box.read('docs/index.html')).days, []);
  });
});

test('a missing history.json is an empty history, a corrupt one is a loud failure that leaves docs/ alone', async () => {
  await withBox({}, async (box) => {
    fs.rmSync(box.p('state', 'history.json'));
    assert.equal((await buildSite({ now: NOW, validate: okValidator })).ok, true);
  });
  await withBox({}, async (box) => {
    box.addAll([{ date: '2026-10-09', slug: 'a' }]);
    assert.equal((await buildSite({ now: NOW, validate: okValidator })).ok, true);
    const before = box.docsSnapshot();
    box.put('state/history.json', '{"schema":1, "entries": ');
    const bad = await buildSite({ now: NOW, validate: okValidator });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /history/);
    box.put('state/history.json', '{"schema":1,"entries":5}');
    const bad2 = await buildSite({ now: NOW, validate: okValidator });
    assert.equal(bad2.ok, false);
    assert.match(bad2.error, /corrupt/);
    assert.deepEqual(box.docsSnapshot(), before, 'docs/ untouched');
  });
});

test('buildSite is byte-identical on a repeat run with the same now, and does not rewrite unchanged files', async () => {
  await withBox({}, async (box) => {
    box.addAll([
      { date: '2026-10-09', slug: 'a', title: 'A' },
      { date: '2026-10-10', slug: 'b', title: 'B' },
    ]);
    const first = await buildSite({ now: NOW, validate: okValidator });
    assert.ok(first.changed.length >= 8);
    const snap = box.docsSnapshot();
    const mtime = fs.statSync(box.p('docs', 'index.html')).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    const second = await buildSite({ now: NOW, validate: okValidator });
    assert.deepEqual(second.changed, []);
    assert.deepEqual(box.docsSnapshot(), snap);
    assert.equal(fs.statSync(box.p('docs', 'index.html')).mtimeMs, mtime);
    const third = await buildSite({ now: new Date(NOW.getTime() + 60_000), validate: okValidator });
    assert.ok(third.changed.includes('archive.json'), 'a different now changes generatedAt');
    const archive = box.readJson('docs/archive.json');
    assert.equal(archive.generatedAt, '2026-10-13T11:01:00.000Z');
  });
});

test('hostile titles cannot break out of the inline JSON, HTML or feed', async () => {
  await withBox({}, async (box) => {
    const title = '</script><script>alert(1)</script> <b>"&  \'';
    box.addAll([{ date: '2026-10-09', slug: 'evil', title }]);
    box.put('docs/d/2026-10-09-evil/project.json', JSON.stringify(projectJson({
      date: '2026-10-09', slug: 'evil', title, tagline: '<img src=x onerror=alert(1)>', description: ']]> & <!-- --> \u0000\u0008 ok',
      palette: ['#000"><script>'],
    })));
    const res = await buildSite({ now: NOW, validate: okValidator });
    assert.equal(res.ok, true, res.error);
    const index = box.read('docs/index.html');
    assert.equal(index.split('</script>').length, 2, 'exactly one closing script tag, the real one');
    assert.doesNotMatch(index, /<script>alert/);
    assert.doesNotMatch(index, /<img src=x/);
    assert.deepEqual(inlineArchive(index).days[0].title, title, 'JSON round-trips the hostile title');
    assert.match(index, /<li><a href="d\/2026-10-09-evil\/">&lt;\/script&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt; &lt;b&gt;&quot;&amp;/);
    const feed = box.read('docs/feed.xml');
    assertWellFormedXml(feed);
    assert.doesNotMatch(feed, /<script>/);
    assert.match(feed, /<summary>\]\]&gt; &amp; &lt;!-- --&gt;  ok<\/summary>/);
  });
});

test('feed.xml is a valid Atom feed with absolute URLs, newest 30 entries only', async () => {
  await withBox({}, async (box) => {
    const specs = [];
    for (let i = 0; i < 36; i++) {
      const date = new Date(Date.UTC(2026, 9, 9 + i)).toISOString().slice(0, 10);
      specs.push({ date, slug: `toy-${i}`, title: `Toy #${i} & friends`, category: i % 2 ? 'cards-odds' : 'generative-art' });
    }
    box.addAll(specs);
    const res = await buildSite({ now: new Date('2026-11-20T15:00:00Z'), validate: okValidator });
    assert.equal(res.ok, true, res.error);
    const feed = box.read('docs/feed.xml');
    assertWellFormedXml(feed);
    assert.match(feed, /<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom">/);
    assert.equal((feed.match(/<entry>/g) ?? []).length, FEED_LIMIT);
    assert.match(feed, /<id>https:\/\/example\.test\/site\/<\/id>/);
    assert.match(feed, /<link rel="self" type="application\/atom\+xml" href="https:\/\/example\.test\/site\/feed\.xml"\/>/);
    assert.match(feed, /<id>https:\/\/example\.test\/site\/d\/2026-11-13-toy-35\/<\/id>/);
    assert.match(feed, /<title>Day 36: Toy #35 &amp; friends<\/title>/);
    assert.match(feed, /<link rel="enclosure" type="image\/png" href="https:\/\/example\.test\/site\/d\/2026-11-13-toy-35\/thumb\.png"\/>/);
    assert.ok(!feed.includes('toy-5/'), 'oldest entries are cut');
    assert.ok(feed.includes('toy-6/'));
    assert.match(feed, /<updated>2026-11-13T10:30:00\.000Z<\/updated>\n {2}<link rel="self"/, 'feed updated = newest entry');
    for (const m of feed.matchAll(/href="([^"]+)"/g)) assert.match(m[1], /^https:\/\/example\.test\/site\//);
  });
});

test('sitemap.xml and robots.txt', async () => {
  await withBox({}, async (box) => {
    box.addAll([{ date: '2026-10-09', slug: 'a' }, { date: '2026-10-10', slug: 'b' }]);
    await buildSite({ now: NOW, validate: okValidator });
    const sm = box.read('docs/sitemap.xml');
    assertWellFormedXml(sm);
    assert.match(sm, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
    assert.deepEqual([...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]), [
      'https://example.test/site/', 'https://example.test/site/d/2026-10-10-b/', 'https://example.test/site/d/2026-10-09-a/',
    ]);
    assert.match(sm, /<loc>https:\/\/example\.test\/site\/<\/loc>\n {4}<lastmod>2026-10-10<\/lastmod>/);
    assert.equal(box.read('docs/robots.txt'), 'User-agent: *\nAllow: /\n\nSitemap: https://example.test/site/sitemap.xml\n');
    assert.equal(renderRobots('https://a.test/'), 'User-agent: *\nAllow: /\n\nSitemap: https://a.test/sitemap.xml\n');
    assert.match(renderSitemap({ site: { url: 'https://a.test/' }, stats: { lastDate: null }, days: [] }), /<loc>https:\/\/a\.test\/<\/loc>\n {2}<\/url>/);
    assert.match(renderFeed({ archive: { site: { url: 'https://a.test/', name: 'N', tagline: 'T' }, generatedAt: '2026-01-01T00:00:00.000Z', days: [] } }), /<updated>2026-01-01T00:00:00\.000Z<\/updated>/);
  });
});

test('failing projects are omitted with their errors, never fatal, and their directories survive', async () => {
  await withBox({}, async (box) => {
    box.addAll([
      { date: '2026-10-09', slug: 'good' },
      { date: '2026-10-10', slug: 'rejected' },
      { date: '2026-10-11', slug: 'crashes' },
      { date: '2026-10-12', slug: 'mismatch' },
      { date: '2026-10-13', slug: 'unparseable' },
    ]);
    box.put('docs/d/2026-10-12-mismatch/project.json', JSON.stringify(projectJson({ date: '2026-10-12', slug: 'other' })));
    box.put('docs/d/2026-10-13-unparseable/project.json', '{nope');
    const entries = box.readJson('state/history.json').entries;
    entries.push({ ...entries[0], date: '2026-10-14', slug: 'ghost', path: 'd/2026-10-14-ghost/' });
    entries.push({ ...entries[0], date: 'garbage', slug: '../etc', path: 'x' });
    box.put('state/history.json', JSON.stringify({ schema: 1, startDate: '2026-10-09', entries }));
    box.put('docs/d/2026-10-20-orphan/project.json', '{}');
    const before = box.docsSnapshot();

    const validate = async (dir) => {
      if (dir.endsWith('2026-10-10-rejected')) return { ok: false, errors: ['csp: no CSP', 'thumb: too big'], warnings: [] };
      if (dir.endsWith('2026-10-11-crashes')) throw new Error('boom');
      return { ok: true, errors: [], warnings: ['size: a bit large'] };
    };
    const res = await buildSite({ now: new Date('2026-10-15T14:00:00Z'), validate });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.projects, 1);
    const byPath = Object.fromEntries(res.omitted.map((o) => [o.path, o.errors]));
    assert.deepEqual(byPath['d/2026-10-10-rejected/'], ['csp: no CSP', 'thumb: too big']);
    assert.match(byPath['d/2026-10-11-crashes/'][0], /validator crashed: boom/);
    assert.match(byPath['d/2026-10-12-mismatch/'][0], /does not match/);
    assert.match(byPath['d/2026-10-13-unparseable/'][0], /project\.json is unreadable/);
    assert.match(byPath['d/2026-10-14-ghost/'][0], /project\.json is unreadable/);
    assert.equal(res.omitted.length, 6);
    assert.ok(res.warnings.some((w) => w.startsWith('omitted d/2026-10-10-rejected/: csp: no CSP; thumb: too big')));
    assert.ok(res.warnings.includes('d/2026-10-09-good/: size: a bit large'), 'validator warnings are passed through');
    assert.ok(res.warnings.some((w) => w.includes('2026-10-20-orphan')), 'orphan directories are reported');

    const archive = box.readJson('docs/archive.json');
    assert.deepEqual(archive.days.map((d) => d.slug), ['good']);
    assert.deepEqual(archive.stats.missingDates, ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15']);
    for (const slug of ['rejected', 'crashes', 'mismatch', 'unparseable']) {
      const dir = [...fs.readdirSync(box.p('docs', 'd'))].find((n) => n.endsWith(slug));
      assert.ok(dir, `${slug} directory still exists`);
    }
    for (const [file, b64] of Object.entries(before)) {
      if (file.startsWith('docs/d/')) assert.equal(fs.readFileSync(box.p(file)).toString('base64'), b64, `${file} unchanged`);
    }
  });
});

test('a history path that differs from the directory only warns', async () => {
  await withBox({}, async (box) => {
    const [entry] = box.addAll([{ date: '2026-10-09', slug: 'a' }]);
    box.put('state/history.json', JSON.stringify({ schema: 1, startDate: '2026-10-09', entries: [{ ...entry, path: 'd/elsewhere/' }] }));
    const res = await buildSite({ now: NOW, validate: okValidator });
    assert.equal(res.projects, 1);
    assert.ok(res.warnings.some((w) => /differs from the directory/.test(w)));
    assert.equal(box.readJson('docs/archive.json').days[0].path, 'd/2026-10-09-a/');
  });
});

test('structural fallback (no validator) accepts a sound project and rejects broken ones', async () => {
  await withBox({}, async (box) => {
    box.addAll([
      { date: '2026-10-09', slug: 'sound' },
      { date: '2026-10-10', slug: 'no-thumb' },
      { date: '2026-10-11', slug: 'bad-thumb' },
      { date: '2026-10-12', slug: 'no-entry' },
      { date: '2026-10-13', slug: 'bad-tier', tier: 9 },
    ]);
    fs.rmSync(box.p('docs/d/2026-10-10-no-thumb/thumb.png'));
    box.put('docs/d/2026-10-11-bad-thumb/thumb.png', 'GIF89a');
    fs.rmSync(box.p('docs/d/2026-10-12-no-entry/index.html'));
    const res = await buildSite({ now: new Date('2026-10-13T20:00:00Z'), validate: false });
    assert.equal(res.ok, true, res.error);
    assert.deepEqual(box.readJson('docs/archive.json').days.map((d) => d.slug), ['sound']);
    const byPath = Object.fromEntries(res.omitted.map((o) => [o.path, o.errors.join(' ')]));
    assert.match(byPath['d/2026-10-10-no-thumb/'], /thumbnail thumb\.png is missing/);
    assert.match(byPath['d/2026-10-11-bad-thumb/'], /not a PNG/);
    assert.match(byPath['d/2026-10-12-no-entry/'], /entry page index\.html is missing/);
    assert.match(byPath['d/2026-10-13-bad-tier/'], /tier must be 1\.\.4/);
  });
});

test('the real validate.mjs is used by default (when present): valid project listed, invalid omitted', async (t) => {
  if (!fs.existsSync(path.join(REAL_ROOT, 'scripts', 'validate.mjs'))) return t.skip('validate.mjs not present');
  await withBox({}, async (box) => {
    box.addAll([
      { date: '2026-10-09', slug: 'valid', tier: 3, thumb: FULL_PNG },
      { date: '2026-10-10', slug: 'no-backlink', tier: 3, thumb: FULL_PNG, page: PAGE.replace('<a class="sed-back" href="../../">&larr; Sonnet Every Day</a>', '') },
    ]);
    const res = await buildSite({ now: new Date('2026-10-10T20:00:00Z') });
    assert.equal(res.ok, true, res.error);
    assert.deepEqual(box.readJson('docs/archive.json').days.map((d) => d.slug), ['valid'], JSON.stringify(res.omitted));
    assert.equal(res.omitted.length, 1);
    assert.equal(res.omitted[0].path, 'd/2026-10-10-no-backlink/');
    assert.ok(res.omitted[0].errors.length > 0);
    assert.ok(!res.warnings.some((w) => /could not be loaded|does not export/.test(w)));
  });
});

test('missing gallery inputs fail loudly and leave docs/ untouched', async () => {
  for (const missing of ['site-src/gallery.js', 'site-src/gallery.css', 'site-src/index.template.html', 'site-src/404.template.html']) {
    await withBox({}, async (box) => {
      box.addAll([{ date: '2026-10-09', slug: 'a' }]);
      fs.rmSync(box.p(missing));
      const before = box.docsSnapshot();
      const res = await buildSite({ now: NOW, validate: okValidator });
      assert.equal(res.ok, false);
      assert.ok(res.error.includes(missing), res.error);
      assert.match(res.error, /Nothing in docs\/ was changed/);
      assert.deepEqual(box.docsSnapshot(), before);
    });
  }
});

test('bad config.siteUrl and bad now are reported, not thrown', async () => {
  await withBox({ config: { siteUrl: 'nope' } }, async () => {
    const res = await buildSite({ now: NOW, validate: okValidator });
    assert.equal(res.ok, false);
    assert.match(res.error, /siteUrl/);
  });
  await withBox({}, async () => {
    const res = await buildSite({ now: 'not a date', validate: okValidator });
    assert.equal(res.ok, false);
    assert.match(res.error, /now/);
  });
});

test('missingDates use the local calendar date in the configured time zone (DST-safe)', async () => {
  await withBox({}, async (box) => {
    box.addAll([{ date: '2026-10-30', slug: 'a' }, { date: '2026-10-31', slug: 'b' }]);
    const run = async (iso) => {
      const res = await buildSite({ now: new Date(iso), validate: okValidator });
      assert.equal(res.ok, true, res.error);
      return box.readJson('docs/archive.json').stats;
    };
    const since = (stats) => stats.missingDates.filter((d) => d >= '2026-10-30');
    // 05:30 UTC on Nov 1 is 01:30 EDT (before the fall-back); before 08:00 so Nov 1 is not yet missing.
    assert.deepEqual(since(await run('2026-11-01T05:30:00Z')), []);
    // 11:30 UTC on Nov 1 is 06:30 EST (after the fall-back): still before the deadline.
    assert.deepEqual(since(await run('2026-11-01T11:30:00Z')), []);
    // 13:30 UTC on Nov 1 is 08:30 EST: Nov 1 is past the deadline and unpublished.
    assert.deepEqual(since(await run('2026-11-01T13:30:00Z')), ['2026-11-01']);
    // 04:30 UTC on Nov 2 is 23:30 EST on Nov 1: the UTC date is Nov 2 but the local date is Nov 1.
    assert.deepEqual(since(await run('2026-11-02T04:30:00Z')), ['2026-11-01']);
    // 13:30 UTC on Nov 2 is 08:30 EST on Nov 2.
    assert.deepEqual(since(await run('2026-11-02T13:30:00Z')), ['2026-11-01', '2026-11-02']);
    // An old --now never hides data that already exists.
    const old = await run('2026-10-01T12:00:00Z');
    assert.equal(old.lastDate, '2026-10-31');
    assert.deepEqual(old.missingDates.filter((d) => d >= '2026-10-09' && d < '2026-10-30'), missingDatesBetween('2026-10-09', '2026-10-29', []));
  });
});

test('today counts as published once it is in history, even before the deadline', async () => {
  await withBox({}, async (box) => {
    box.addAll([{ date: '2026-10-09', slug: 'a' }, { date: '2026-10-10', slug: 'b' }]);
    await buildSite({ now: new Date('2026-10-10T09:00:00Z'), validate: okValidator });
    const stats = box.readJson('docs/archive.json').stats;
    assert.deepEqual(stats.missingDates, []);
    assert.equal(stats.streak, 2);
    assert.equal(stats.days, 2);
  });
});

test('duplicate history dates keep the last entry and warn', async () => {
  await withBox({}, async (box) => {
    const [e] = box.addAll([{ date: '2026-10-09', slug: 'a' }]);
    box.put('state/history.json', JSON.stringify({ schema: 1, startDate: '2026-10-09', entries: [{ ...e, slug: 'stale' }, e] }));
    const res = await buildSite({ now: NOW, validate: okValidator });
    assert.equal(res.projects, 1);
    assert.ok(res.warnings.some((w) => /more than one entry for 2026-10-09/.test(w)));
  });
});

test('templates with unknown or missing placeholders produce warnings, not failures', async () => {
  await withBox({}, async (box) => {
    box.put('site-src/index.template.html', '<html><body>{{SITE_NAME}} {{WHAT}}</body></html>');
    box.addAll([{ date: '2026-10-09', slug: 'a' }]);
    const res = await buildSite({ now: NOW, validate: okValidator });
    assert.equal(res.ok, true);
    assert.ok(res.warnings.some((w) => /ARCHIVE_JSON/.test(w)));
    assert.ok(res.warnings.some((w) => /\{\{WHAT\}\}/.test(w)));
    assert.equal(box.read('docs/index.html'), '<html><body>Sonnet Every Day {{WHAT}}</body></html>');
  });
});

test('smoke build against the real site-src templates when they exist', async (t) => {
  const src = path.join(REAL_ROOT, 'site-src');
  const files = ['index.template.html', '404.template.html', 'gallery.css', 'gallery.js'];
  if (!files.every((f) => fs.existsSync(path.join(src, f)))) return t.skip('site-src is not populated yet');
  await withBox({}, async (box) => {
    for (const f of files) box.put(`site-src/${f}`, fs.readFileSync(path.join(src, f)));
    box.addAll([
      { date: '2026-10-09', slug: 'first', title: 'First </script> & "Toy"' },
      { date: '2026-10-10', slug: 'second', title: 'Second' },
    ]);
    const res = await buildSite({ now: NOW, validate: okValidator });
    assert.equal(res.ok, true, res.error);
    assert.ok(!res.warnings.some((w) => /placeholder/.test(w)), res.warnings.join('\n'));
    const index = box.read('docs/index.html');
    assert.doesNotMatch(index, /\{\{[A-Z_]+\}\}/);
    assert.equal(inlineArchive(index).days.length, 2);
    assert.doesNotMatch(box.read('docs/404.html'), /\{\{[A-Z_]+\}\}/);
    assert.equal(box.read('docs/assets/gallery.js'), fs.readFileSync(path.join(src, 'gallery.js'), 'utf8'));
  });
});

test('performance: 1000 projects build in under 3 seconds (validator stubbed, and structural fallback)', async (t) => {
  await withBox({}, async (box) => {
    const specs = [];
    for (let i = 0; i < 1000; i++) {
      const date = new Date(Date.UTC(2026, 9, 9 + i)).toISOString().slice(0, 10);
      specs.push({ date, slug: `project-${i}`, title: `Project number ${i}`, category: i % 3 ? 'cards-odds' : 'science-sim' });
    }
    box.addAll(specs);
    const now = new Date(Date.UTC(2026, 9, 9 + 1000, 15));
    for (const validate of [okValidator, false]) {
      fs.rmSync(box.p('docs', 'archive.json'), { force: true });
      const t0 = performance.now();
      const res = await buildSite({ now, validate });
      const ms = performance.now() - t0;
      assert.equal(res.ok, true, res.error);
      assert.equal(res.projects, 1000);
      assert.ok(ms < 3000, `took ${Math.round(ms)} ms`);
      t.diagnostic?.(`validate=${validate === false ? 'structural' : 'stub'}: ${Math.round(ms)} ms`);
    }
    assert.equal(box.readJson('docs/archive.json').stats.streak, 1000);
    assert.equal((box.read('docs/feed.xml').match(/<entry>/g) ?? []).length, FEED_LIMIT);
  });
});

// ---------- build-site CLI ----------

function runCliAsync(script, args, box, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, SED_ROOT: box.root, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      let json = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        // leave null; assertions show stdout
      }
      resolve({ code, json, stdout, stderr });
    });
  });
}

function runCli(script, args, box, env = {}) {
  const r = spawnSync(process.execPath, [script, ...args], { env: { ...process.env, SED_ROOT: box.root, ...env }, encoding: 'utf8', timeout: 60_000 });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    // leave null; the assertion will show stdout
  }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

test('build-site CLI prints exactly one JSON document and honours --now / SED_NOW', async () => {
  await withBox({}, async (box) => {
    box.addAll([{ date: '2026-10-09', slug: 'cli', tier: 3, thumb: FULL_PNG }]);
    const r = runCli(BUILD_CLI, ['--now', '2026-10-09T15:00:00Z'], box);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.equal(r.json.ok, true, r.stdout);
    assert.equal(r.json.projects, 1);
    assert.equal(r.json.generatedAt, '2026-10-09T15:00:00.000Z');
    assert.deepEqual(r.json.omitted, []);
    const again = runCli(BUILD_CLI, [], box, { SED_NOW: '2026-10-09T15:00:00Z' });
    assert.equal(again.json.generatedAt, '2026-10-09T15:00:00.000Z');
    assert.deepEqual(again.json.changed, []);
  });
});

test('build-site CLI exit codes: 1 on a fatal build error, 2 on a bad --now', async () => {
  await withBox({}, async (box) => {
    fs.rmSync(box.p('site-src', 'gallery.js'));
    const r = runCli(BUILD_CLI, ['--now', '2026-10-09T15:00:00Z'], box);
    assert.equal(r.code, 1);
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, /gallery\.js/);
    const bad = runCli(BUILD_CLI, ['--now', 'yesterday-ish'], box);
    assert.equal(bad.code, 2);
    assert.equal(bad.json.ok, false);
  });
});

test('importing build-site.mjs has no side effects', () => {
  const r = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(path.join(REAL_ROOT, 'scripts', 'build-site.mjs'))}).then((m) => console.log(typeof m.buildSite))`], {
    env: { ...process.env, SED_ROOT: os.tmpdir() }, encoding: 'utf8',
  });
  assert.equal(r.stdout.trim(), 'function');
});

// ---------- verify-live ----------

function serve(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/site/`,
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
      });
    });
  });
}

const archiveBody = (dates) => JSON.stringify({ schema: 1, days: dates.map((date) => ({ date })) });

test('archiveUrl accepts a site base or an archive.json url', () => {
  assert.equal(archiveUrl('https://a.test/x').toString(), 'https://a.test/x/archive.json');
  assert.equal(archiveUrl('https://a.test/x/').toString(), 'https://a.test/x/archive.json');
  assert.equal(archiveUrl('https://a.test/x/archive.json?y=1#z').toString(), 'https://a.test/x/archive.json?y=1');
  assert.throws(() => archiveUrl('file:///etc/passwd'), /protocol/);
});

test('verifyLive: live on the first check', async () => {
  const seen = [];
  const srv = await serve((req, res) => {
    seen.push(req.url);
    res.setHeader('content-type', 'application/json');
    res.end(archiveBody(['2026-10-08', '2026-10-09']));
  });
  try {
    const r = await verifyLive({ date: '2026-10-09', url: srv.url, timeoutS: 5, intervalS: 0.05 });
    assert.deepEqual({ ok: r.ok, live: r.live, status: r.status, checked: r.checked }, { ok: true, live: true, status: 200, checked: 1 });
    assert.match(seen[0], /^\/site\/archive\.json\?cb=\d+$/);
  } finally {
    await srv.close();
  }
});

test('verifyLive keeps polling through 404s and stale archives until the date appears', async () => {
  let hits = 0;
  const srv = await serve((req, res) => {
    hits++;
    if (hits === 1) {
      res.statusCode = 404;
      return res.end('nope');
    }
    if (hits === 2) return res.end('<html>not json</html>');
    res.end(archiveBody(hits === 3 ? ['2026-10-08'] : ['2026-10-08', '2026-10-09']));
  });
  try {
    const r = await verifyLive({ date: '2026-10-09', url: srv.url, timeoutS: 10, intervalS: 0.05 });
    assert.equal(r.live, true);
    assert.equal(r.ok, true);
    assert.equal(r.checked, 4);
  } finally {
    await srv.close();
  }
});

test('verifyLive times out as ok:false when the site answers but never lists the date', async () => {
  const srv = await serve((req, res) => res.end(archiveBody(['2026-10-08'])));
  try {
    const r = await verifyLive({ date: '2026-10-09', url: srv.url, timeoutS: 0.4, intervalS: 0.1 });
    assert.equal(r.ok, false);
    assert.equal(r.live, false);
    assert.equal(r.status, 200);
    assert.equal(r.reason, 'not-listed');
    assert.ok(r.checked >= 2);
  } finally {
    await srv.close();
  }
});

test('verifyLive reports a persistent 404 as not live (ok:false)', async () => {
  const srv = await serve((req, res) => {
    res.statusCode = 404;
    res.end('missing');
  });
  try {
    const r = await verifyLive({ date: '2026-10-09', url: srv.url, timeoutS: 0, intervalS: 0.1 });
    assert.deepEqual({ ok: r.ok, live: r.live, status: r.status, checked: r.checked, reason: r.reason }, { ok: false, live: false, status: 404, checked: 1, reason: 'http-404' });
  } finally {
    await srv.close();
  }
});

test('verifyLive: an unreachable site is ok:true, live:null', async () => {
  const srv = await serve((req, res) => res.end('x'));
  const url = srv.url;
  await srv.close(); // nothing listens on that port any more
  const r = await verifyLive({ date: '2026-10-09', url, timeoutS: 0.3, intervalS: 0.1 });
  assert.equal(r.ok, true);
  assert.equal(r.live, null);
  assert.equal(r.reason, 'unreachable');
  assert.equal(r.status, null);
  assert.ok(r.checked >= 1);
});

test('verifyLive aborts a hanging request instead of waiting for it', async () => {
  const srv = await serve(() => { /* never answers */ });
  try {
    const t0 = Date.now();
    const r = await verifyLive({ date: '2026-10-09', url: srv.url, timeoutS: 0.5, intervalS: 0.1, requestTimeoutS: 0.2 });
    assert.ok(Date.now() - t0 < 3000, 'returned promptly');
    assert.equal(r.ok, true);
    assert.equal(r.live, null);
    assert.equal(r.reason, 'unreachable');
    assert.ok(r.checked >= 2, 'timed-out requests are retried');
  } finally {
    await srv.close();
  }
});

test('verify-live CLI: live, not live, unreachable and usage errors', async () => {
  await withBox({}, async (box) => {
    const srv = await serve((req, res) => res.end(archiveBody(['2026-10-09'])));
    try {
      const live = await runCliAsync(VERIFY_CLI, ['--date', '2026-10-09', '--url', srv.url, '--timeout-s', '3'], box);
      assert.equal(live.code, 0, live.stdout + live.stderr);
      assert.equal(live.json.live, true);
      assert.equal(live.json.checked, 1);

      const notLive = await runCliAsync(VERIFY_CLI, ['--date', '2026-10-10', '--url', srv.url, '--timeout-s', '0'], box);
      assert.equal(notLive.code, 1);
      assert.equal(notLive.json.ok, false);
      assert.equal(notLive.json.live, false);
    } finally {
      await srv.close();
    }
    const unreachable = runCli(VERIFY_CLI, ['--date', '2026-10-09', '--url', 'http://127.0.0.1:9/', '--timeout-s', '0'], box);
    assert.equal(unreachable.code, 0);
    assert.deepEqual({ ok: unreachable.json.ok, live: unreachable.json.live, reason: unreachable.json.reason }, { ok: true, live: null, reason: 'unreachable' });
    for (const args of [['--date', 'tomorrow'], ['--timeout-s', '-3'], ['--timeout-s', 'abc'], ['--url', 'ftp://x/']]) {
      const bad = runCli(VERIFY_CLI, args, box);
      assert.equal(bad.code, 2, args.join(' '));
      assert.equal(bad.json.ok, false);
    }
  });
});

test('verify-live CLI defaults to today (local date) and config.siteUrl', async () => {
  const srv = await serve((req, res) => res.end(archiveBody(['2026-11-02'])));
  try {
    await withBox({ config: { siteUrl: srv.url } }, async (box) => {
      // 04:30 UTC on Nov 2 is still Nov 1 in New York.
      const early = await runCliAsync(VERIFY_CLI, ['--now', '2026-11-02T04:30:00Z', '--timeout-s', '0'], box);
      assert.equal(early.code, 1);
      assert.equal(early.json.date, '2026-11-01');
      const later = await runCliAsync(VERIFY_CLI, ['--now', '2026-11-02T15:00:00Z', '--timeout-s', '0'], box);
      assert.equal(later.code, 0, later.stdout);
      assert.equal(later.json.date, '2026-11-02');
      assert.equal(later.json.live, true);
    });
  } finally {
    await srv.close();
  }
});

// ---------- the swarm's diary (docs/kaizen/) ----------

const SHA_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const SHA_B = 'b2c3d4e5f60718293a4b5c6d7e8f901234567890';

function ledgerEntry(over) {
  const date = over.date ?? '2026-10-10';
  const agent = over.agent ?? 'pulse';
  return {
    id: `${date}-${agent}`, date, agent, title: `Title of ${agent}`, observation: `Observation of ${agent}.`, category: 'clarity',
    files: ['ops/roles/pulse.md'], sha: SHA_A, status: 'applied', linesChanged: 6, question: null, reason: null, ...over,
  };
}

const DIARY_FILES = ['kaizen.template.html', 'kaizen.css', 'kaizen.js'];
function withDiaryFiles(box) {
  for (const f of DIARY_FILES) box.put(`site-src/${f}`, fs.readFileSync(path.join(REAL_ROOT, 'site-src', f)));
}
const putLedger = (box, entries) => box.put('ops/kaizen/INDEX.json', JSON.stringify({ schema: 1, entries }));

test('normalizeKaizen sorts newest first, validates, links to GitHub and skips junk', () => {
  const raw = { schema: 1, entries: [
    ledgerEntry({ date: '2026-10-10', agent: 'pulse', title: 'First of the day' }),
    ledgerEntry({ date: '2026-10-11', agent: 'cards', title: 'Cards on day two', sha: SHA_B }),
    ledgerEntry({ date: '2026-10-10', agent: 'lab', title: 'Second of the day', sha: 'not-a-sha' }),
    ledgerEntry({ date: '2026-10-12', agent: 'jester', status: 'proposed', files: ['ops/kaizen/proposals/2026-10-12-jester.md'], title: 'A proposal' }),
    ledgerEntry({ date: '2026-02-30', agent: 'critic' }),
    ledgerEntry({ date: '2026-10-10', agent: 'Bad Agent!' }),
    ledgerEntry({ date: '2026-10-10', agent: 'clerk', status: 'sparkling' }),
    ledgerEntry({ date: '2026-10-10', agent: 'engineer', title: '   ' }),
    'junk', null,
  ] };
  const res = normalizeKaizen(raw, { repo: 'ph05/sonnet-every-day', workBranch: 'claude/sonnet-every-day' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.entries.map((e) => e.id), ['2026-10-12-jester', '2026-10-11-cards', '2026-10-10-lab', '2026-10-10-pulse'],
    'newest date first; within a date the later ledger line first');
  assert.equal(res.warnings.length, 6, res.warnings.join('\n'));
  const [prop, cards, lab, pulse] = res.entries;
  assert.equal(pulse.commitUrl, `https://github.com/ph05/sonnet-every-day/commit/${SHA_A}`);
  assert.equal(cards.commitUrl, `https://github.com/ph05/sonnet-every-day/commit/${SHA_B}`);
  assert.equal(lab.sha, null);
  assert.equal(lab.commitUrl, null);
  assert.equal(prop.proposalUrl, 'https://github.com/ph05/sonnet-every-day/blob/claude/sonnet-every-day/ops/kaizen/proposals/2026-10-12-jester.md');
  assert.equal(pulse.persona, 'Pulse');
  assert.match(pulse.role, /scout/);
  assert.equal(normalizeKaizen({ schema: 1, entries: [] }).entries.length, 0);
  assert.deepEqual(normalizeKaizen(undefined), { ok: true, entries: [], warnings: [] });
  assert.equal(normalizeKaizen({ entries: 'nope' }).ok, false);
  assert.equal(normalizeKaizen([]).ok, false);
});

test('normalizeKaizen refuses to build GitHub links from a bad repo or sha and caps long text', () => {
  const long = 'x'.repeat(5000);
  const res = normalizeKaizen({ entries: [ledgerEntry({ title: long, observation: long, files: Array.from({ length: 100 }, (_, i) => `ops/f${i}.md`), linesChanged: -4 })] }, { repo: 'evil/../repo?x=1' });
  const [e] = res.entries;
  assert.equal(e.commitUrl, null);
  assert.ok(res.warnings.some((w) => /config\.repo/.test(w)));
  assert.ok(e.title.length <= 200 && e.title.endsWith('…'));
  assert.ok(e.observation.length <= 1200);
  assert.equal(e.files.length, 40);
  assert.equal(e.linesChanged, 0);
  const dup = normalizeKaizen({ entries: [ledgerEntry({ title: 'one' }), ledgerEntry({ title: 'two' })] }, { repo: 'a/b' });
  assert.deepEqual(dup.entries.map((x) => x.title), ['two']);
  assert.ok(dup.warnings.some((w) => /more than one entry/.test(w)));
});

test('kaizenTeaser reports the newest applied kaizen and how many landed; summarizeKaizen counts', () => {
  const { entries } = normalizeKaizen({ entries: [
    ledgerEntry({ date: '2026-10-10', agent: 'pulse' }),
    ledgerEntry({ date: '2026-10-11', agent: 'cards', status: 'rejected', reason: 'too many lines' }),
    ledgerEntry({ date: '2026-10-11', agent: 'lab', title: 'Lab wins' }),
    ledgerEntry({ date: '2026-10-12', agent: 'jester', status: 'proposed' }),
  ] }, { repo: 'a/b' });
  assert.deepEqual(kaizenTeaser(entries), { latest: { date: '2026-10-11', agent: 'lab', title: 'Lab wins' }, count: 2 });
  assert.equal(kaizenTeaser([]), null);
  assert.equal(kaizenTeaser(entries.filter((e) => e.status !== 'applied')), null);
  const stats = summarizeKaizen(entries);
  assert.deepEqual([stats.entries, stats.applied, stats.rejected, stats.proposed, stats.linesChanged, stats.members], [4, 2, 1, 1, 12, 4]);
  assert.equal(stats.firstDate, '2026-10-10');
  assert.equal(stats.lastDate, '2026-10-12');
  const base = { name: 'S', startDate: '2026-10-09' };
  const archive = buildArchive({ projects: [], config: base, siteUrl: SITE_URL, now: NOW, through: '2026-10-08', kaizen: kaizenTeaser(entries) });
  assert.deepEqual(archive.kaizen, kaizenTeaser(entries));
  assert.equal('kaizen' in buildArchive({ projects: [], config: base, siteUrl: SITE_URL, now: NOW, through: '2026-10-08' }), false, 'backward compatible');
});

test('the diary page escapes hostile ledger text in every context', () => {
  const evil = '</script><img src=x onerror=alert(1)> "quoted" \'single\' & <b>bold</b>';
  const template = fs.readFileSync(path.join(REAL_ROOT, 'site-src', 'kaizen.template.html'), 'utf8');
  const { entries } = normalizeKaizen({ entries: [
    ledgerEntry({ title: evil, observation: evil, reason: evil, question: evil, category: evil, files: [evil], status: 'rejected' }),
    ledgerEntry({ agent: 'jester', title: evil, observation: evil, status: 'proposed', files: [`ops/kaizen/proposals/2026-10-10-jester.md`] }),
  ] }, { repo: 'a/b' });
  const archive = { site: { name: evil, url: SITE_URL, startDate: '2026-10-09' }, generatedAt: NOW.toISOString() };
  const { html, unknown, missing } = renderKaizenPage(template, { archive, entries });
  assert.deepEqual(unknown, []);
  assert.deepEqual(missing, []);
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<b>bold/);
  assert.doesNotMatch(html, /\{\{[A-Z_]+\}\}/);
  assert.equal((html.match(/<script/g) ?? []).length, 2, 'only the two template scripts (theme bootstrap, kaizen.js) exist');
  assert.match(html, /&lt;\/script&gt;&lt;img src=x onerror=alert\(1\)&gt;/);
  const json = JSON.parse(renderKaizenJson({ archive, entries, repo: 'a/b', workBranch: 'main' }));
  assert.equal(json.entries[0].title.slice(0, 9), '</script>', 'JSON keeps raw text; it is data, not markup');
});

test('the diary page renders entries by day, with statuses, files and commit links', () => {
  const template = fs.readFileSync(path.join(REAL_ROOT, 'site-src', 'kaizen.template.html'), 'utf8');
  const { entries } = normalizeKaizen({ entries: [
    ledgerEntry({ date: '2026-10-10', agent: 'pulse', title: 'Applied one', question: 'Why though?' }),
    ledgerEntry({ date: '2026-10-10', agent: 'cards', title: 'Rejected one', status: 'rejected', reason: 'touched a protected path', sha: null }),
    ledgerEntry({ date: '2026-10-11', agent: 'lab', title: 'Many files', files: ['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md', 'g.md', 'h.md'] }),
    ledgerEntry({ date: '2026-10-11', agent: 'jester', title: 'Wishlist item', status: 'proposed', files: ['ops/kaizen/proposals/2026-10-11-jester.md'] }),
  ] }, { repo: 'ph05/sonnet-every-day', workBranch: 'claude/sonnet-every-day' });
  const archive = { site: { name: 'Sonnet Every Day', url: SITE_URL, startDate: '2026-10-09' }, generatedAt: NOW.toISOString() };
  const { html } = renderKaizenPage(template, { archive, entries });
  const log = html.slice(html.indexOf('id="log"'), html.indexOf('id="proposals"'));
  assert.ok(log.indexOf('Many files') < log.indexOf('Applied one'), 'newest day first');
  assert.equal((log.match(/class="day"/g) ?? []).length, 2);
  assert.match(log, /<time datetime="2026-10-11"><span class="d-day">11<\/span>/);
  assert.match(log, /Day 3/);
  assert.match(log, /data-agent="pulse" data-category="clarity" data-status="applied"/);
  assert.match(log, /badge-rejected/);
  assert.match(log, /Why it was rejected\.<\/strong> touched a protected path/);
  assert.match(log, /Still wondering\.<\/strong> Why though\?/);
  assert.match(log, new RegExp(`href="https://github\\.com/ph05/sonnet-every-day/commit/${SHA_A}"`));
  assert.match(log, /\+2 more/);
  assert.ok(!log.includes('Wishlist item'), 'proposals are not in the log');
  const proposals = html.slice(html.indexOf('id="proposals"'));
  assert.match(proposals, /Proposals for the owner/);
  assert.match(proposals, /Wishlist item/);
  assert.match(proposals, /Read the proposal/);
  assert.doesNotMatch(proposals.slice(proposals.indexOf('<li class="entry')), /data-status/, 'status filter never hides proposals');
  assert.match(html, /16 line|6 lines changed/);
  assert.match(html, /<button type="button" class="chip" data-key="agent" data-value="pulse"/);
});

test('buildSite renders the diary, teaser, sitemap entry and feed link from the ledger', async () => {
  await withBox({}, async (box) => {
    withDiaryFiles(box);
    box.addAll([{ date: '2026-10-09', slug: 'first-toy', title: 'First Toy' }]);
    putLedger(box, [
      ledgerEntry({ date: '2026-10-10', agent: 'pulse', title: 'Older kaizen' }),
      ledgerEntry({ date: '2026-10-11', agent: 'cards', title: 'Newest kaizen', sha: SHA_B }),
      ledgerEntry({ date: '2026-10-11', agent: 'lab', status: 'proposed', files: ['ops/kaizen/proposals/2026-10-11-lab.md'], title: 'Please unlock this' }),
    ]);
    const res = await buildSite({ now: NOW, validate: okValidator });
    assert.equal(res.ok, true, res.error);
    assert.deepEqual(res.diary, { entries: 3, rendered: true });
    assert.deepEqual(res.warnings, []);
    for (const f of ['kaizen/index.html', 'kaizen/kaizen.json', 'assets/kaizen.css', 'assets/kaizen.js']) assert.ok(box.exists(`docs/${f}`), f);
    assert.equal(box.read('docs/assets/kaizen.js'), fs.readFileSync(path.join(REAL_ROOT, 'site-src', 'kaizen.js'), 'utf8'));
    const page = box.read('docs/kaizen/index.html');
    assert.doesNotMatch(page, /\{\{[A-Z_]+\}\}/);
    assert.match(page, /Newest kaizen/);
    assert.match(page, /Please unlock this/);
    assert.match(page, new RegExp(`https://github\\.com/ph05/sonnet-every-day/commit/${SHA_B}`));
    assert.match(page, /<link rel="canonical" href="https:\/\/example\.test\/site\/kaizen\/">/);
    const kz = box.readJson('docs/kaizen/kaizen.json');
    assert.equal(kz.schema, 1);
    assert.equal(kz.repo, 'ph05/sonnet-every-day');
    assert.deepEqual(kz.entries.map((e) => e.id), ['2026-10-11-lab', '2026-10-11-cards', '2026-10-10-pulse']);
    assert.equal(kz.stats.applied, 2);
    assert.equal(kz.entries.every((e) => !('hue' in e)), true);
    assert.deepEqual(box.readJson('docs/archive.json').kaizen, { latest: { date: '2026-10-11', agent: 'cards', title: 'Newest kaizen' }, count: 2 });
    const sitemap = box.read('docs/sitemap.xml');
    assert.match(sitemap, /<loc>https:\/\/example\.test\/site\/kaizen\/<\/loc>\s*<lastmod>2026-10-11<\/lastmod>/);
    assertWellFormedXml(sitemap);
    const feed = box.read('docs/feed.xml');
    assert.match(feed, /<link rel="related" type="text\/html" title="The swarm’s diary" href="https:\/\/example\.test\/site\/kaizen\/"\/>/);
    assertWellFormedXml(feed);

    const snap = box.docsSnapshot();
    const again = await buildSite({ now: NOW, validate: okValidator });
    assert.deepEqual(again.changed, []);
    assert.deepEqual(box.docsSnapshot(), snap, 'byte-identical on a repeat run');
  });
});

test('no ledger yet: the diary is an empty state, there is no teaser, and nothing fails', async () => {
  await withBox({}, async (box) => {
    withDiaryFiles(box);
    box.addAll([{ date: '2026-10-09', slug: 'a' }]);
    for (const setup of [() => {}, () => putLedger(box, [])]) {
      setup();
      const res = await buildSite({ now: NOW, validate: okValidator });
      assert.equal(res.ok, true, res.error);
      assert.deepEqual(res.warnings, []);
      const page = box.read('docs/kaizen/index.html');
      assert.match(page, /The first page is still blank/);
      assert.match(page, /No proposals waiting/);
      assert.doesNotMatch(page, /id="filters"|id="log"/);
      assert.equal('kaizen' in box.readJson('docs/archive.json'), false);
      assert.equal(box.readJson('docs/kaizen/kaizen.json').entries.length, 0);
    }
  });
});

test('a corrupt ledger keeps the published diary and warns; the rest of the site still builds', async () => {
  await withBox({}, async (box) => {
    withDiaryFiles(box);
    box.addAll([{ date: '2026-10-09', slug: 'a' }]);
    putLedger(box, [ledgerEntry({ title: 'Survivor' })]);
    assert.equal((await buildSite({ now: NOW, validate: okValidator })).ok, true);
    const published = box.read('docs/kaizen/index.html');
    for (const bad of ['{ not json', JSON.stringify({ entries: 'no' }), JSON.stringify([1, 2])]) {
      box.put('ops/kaizen/INDEX.json', bad);
      const res = await buildSite({ now: new Date(NOW.getTime() + 60_000), validate: okValidator });
      assert.equal(res.ok, true, res.error);
      assert.ok(res.warnings.some((w) => /diary was not rebuilt/.test(w) && /keeping the published page/.test(w)), res.warnings.join('\n'));
      assert.equal(box.read('docs/kaizen/index.html'), published);
      assert.match(box.read('docs/sitemap.xml'), /site\/kaizen\//, 'the existing page stays in the sitemap');
      assert.equal(res.diary.rendered, false);
    }
  });
});

test('without the diary templates the build still succeeds, warns, and lists no diary page', async () => {
  await withBox({}, async (box) => {
    box.addAll([{ date: '2026-10-09', slug: 'a' }]);
    putLedger(box, [ledgerEntry({})]);
    const res = await buildSite({ now: NOW, validate: okValidator });
    assert.equal(res.ok, true, res.error);
    assert.ok(res.warnings.some((w) => /diary was not built/.test(w) && /kaizen\.template\.html/.test(w)), res.warnings.join('\n'));
    assert.equal(box.exists('docs/kaizen'), false);
    assert.doesNotMatch(box.read('docs/sitemap.xml'), /kaizen/);
    assert.doesNotMatch(box.read('docs/feed.xml'), /kaizen/);
    assert.equal('kaizen' in box.readJson('docs/archive.json'), false);
  });
});

test('a ledger with junk entries builds the diary from the good ones and warns about the rest', async () => {
  await withBox({}, async (box) => {
    withDiaryFiles(box);
    box.addAll([{ date: '2026-10-09', slug: 'a' }]);
    putLedger(box, [ledgerEntry({ title: 'Good one' }), { date: 'yesterday', agent: 'x', title: 'bad date', status: 'applied' }, 42]);
    const res = await buildSite({ now: NOW, validate: okValidator });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.warnings.filter((w) => /entry \d skipped/.test(w)).length, 2);
    assert.match(box.read('docs/kaizen/index.html'), /Good one/);
    assert.equal(res.diary.entries, 1);
  });
});

test('renderSitemap and renderFeed take the diary as an optional extra', () => {
  const archive = buildArchive({ projects: [], config: { name: 'S', startDate: '2026-10-09' }, siteUrl: SITE_URL, now: NOW, through: '2026-10-08' });
  assert.doesNotMatch(renderSitemap(archive), /kaizen/);
  assert.doesNotMatch(renderFeed({ archive }), /kaizen/);
  assert.match(renderSitemap(archive, [{ path: 'kaizen/' }]), /<loc>https:\/\/example\.test\/site\/kaizen\/<\/loc>\s*<\/url>/);
  assert.match(renderFeed({ archive, diary: true }), /rel="related"/);
});
