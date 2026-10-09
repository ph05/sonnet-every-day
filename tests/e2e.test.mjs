// End-to-end scenarios: whole simulated days driven through the REAL scripts, with a fake clock (SED_NOW),
// a bare git remote and one fresh clone per "session" (every routine firing is a new container in production).
// Nothing here touches the real state/, docs/ or work/: the repo is copied into a seeded bare remote first.
//
// Days:        (a) happy path   (b, b2..b5) primary dies, wdA/wdB take over   (c..c4) live primary, quiet watchdogs, directives
//              (d) wdB from scratch, Ideas Day   (e, e2) closer and deadman   (f, f2) double fire   (g, g2) late upgrade
//              (h) DST   (i) corrupt run file   (j) carry-over over 3 days   (k) 32 days of fixtures and fallbacks
// Seams:       (l) the built site in a real browser   (m..m4) docs name real commands, fields, sections, tools
//              (n, n2) OPERATING.md recipes   (o) CONTRACT 5 file shapes   (p) missing work branch   (q, q2) budget, QA output
//              (s) failed runs
// Set SED_E2E_SHOTS=<dir> to keep the browser test's screenshots and SED_E2E_KEEP_SITE=<dir> to keep (k)'s built docs/.
import './helpers/env.mjs';
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { etIso, tmpDir } from './helpers/env.mjs';
import { BRANCH, git, gitTry } from './helpers/git.mjs';
import { startServer } from '../scripts/qa/serve.mjs';
import { Canvas } from '../scripts/lib/png.mjs';
import { addDays, dayNumber, hashStr, mulberry32 } from '../scripts/lib/common.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const BENIGN = path.join(HERE, 'fixtures', 'gate-benign', '2026-10-09-sample-toy');
const PLAYBOOK = fs.readFileSync(path.join(REPO, 'ops', 'PLAYBOOK.md'), 'utf8');
const CONFIG = JSON.parse(fs.readFileSync(path.join(REPO, 'config.json'), 'utf8'));
const TAXONOMY = JSON.parse(fs.readFileSync(path.join(REPO, 'ops', 'taxonomy.json'), 'utf8'));
const SITE_URL = CONFIG.siteUrl;
const D1 = CONFIG.startDate; // 2026-10-09, day 1
const CATEGORIES = Object.keys(TAXONOMY.categories);
const MECHANICS = TAXONOMY.mechanics;
const SLOTS = Object.keys(TAXONOMY.slots);

// ---------------------------------------------------------------------------------------------
// the world: a seeded bare remote, and boxes (= one clone each = one session's container)
// ---------------------------------------------------------------------------------------------

const SKIP_DIRS = new Set(['.git', 'node_modules', 'tests']);
const RUNTIME_DIRS = ['docs/d', 'work', 'state/runs', 'state/ideas', 'state/reports', 'state/smoke', 'state/heartbeats'];

/** Copy of the working tree that a fresh clone would contain: code, config and seeds, but no runtime output. */
function repoFilter(src) {
  const rel = path.relative(REPO, src).split(path.sep).join('/');
  if (!rel) return true;
  if (rel.split('/').some((seg) => SKIP_DIRS.has(seg))) return false;
  return !RUNTIME_DIRS.some((dir) => rel.startsWith(`${dir}/`) && !rel.endsWith('.gitkeep'));
}

let SEED_REMOTE = null;
const TO_CLEAN = [];

function seedRemote() {
  const base = tmpDir('sed-e2e-seed-');
  TO_CLEAN.push(base);
  const remote = path.join(base, 'remote.git');
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', remote]);
  const src = path.join(base, 'src');
  fs.cpSync(REPO, src, { recursive: true, filter: repoFilter });
  git(src, 'init', '-q', '-b', 'main');
  git(src, 'add', '-A');
  git(src, 'commit', '-q', '-m', 'seed: repo copy for e2e');
  git(src, 'remote', 'add', 'origin', remote);
  git(src, 'push', '-q', 'origin', 'main');
  git(src, 'checkout', '-q', '-b', BRANCH);
  git(src, 'push', '-q', 'origin', BRANCH);
  return remote;
}

const wrapResult = (r) => {
  let json = null;
  const text = (r.stdout ?? '').trim();
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { __unparseable: text };
    }
  }
  return { code: r.status ?? r.code, json, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

class World {
  constructor() {
    this.base = tmpDir('sed-e2e-');
    TO_CLEAN.push(this.base);
    this.remote = path.join(this.base, 'remote.git');
    fs.cpSync(SEED_REMOTE, this.remote, { recursive: true });
    this.boxes = new Map();
    this.n = 0;
  }

  /** A new session's checkout of the work branch. */
  box(name) {
    const dir = path.join(this.base, `${name}-${++this.n}`);
    execFileSync('git', ['clone', '-q', '--branch', BRANCH, this.remote, dir], { stdio: 'ignore' });
    const box = new Box(this, name, dir);
    this.boxes.set(name, box);
    return box;
  }

  remoteSha() {
    return git(this.remote, 'rev-parse', `refs/heads/${BRANCH}`);
  }
  remoteLog(n = 100) {
    return git(this.remote, 'log', `-${n}`, '--format=%s', `refs/heads/${BRANCH}`).split('\n').filter(Boolean);
  }
  remoteFile(rel) {
    return git(this.remote, 'show', `refs/heads/${BRANCH}:${rel}`);
  }
  remoteJson(rel) {
    return JSON.parse(this.remoteFile(rel));
  }
  remoteHasFile(rel) {
    return gitTry(this.remote, 'cat-file', '-e', `refs/heads/${BRANCH}:${rel}`).ok;
  }
  remoteTree(prefix) {
    return git(this.remote, 'ls-tree', '-r', '--name-only', `refs/heads/${BRANCH}`, '--', prefix).split('\n').filter(Boolean);
  }
}

class Box {
  constructor(world, name, root) {
    this.world = world;
    this.name = name;
    this.root = root;
    this.now = null;
  }

  /** Set the fake clock to HH:MM America/New_York on `date`. */
  at(date, hhmm) {
    this.now = etIso(date, hhmm);
    return this;
  }
  p(...parts) {
    return path.join(this.root, ...parts);
  }
  env(extra = {}) {
    return { ...process.env, SED_ROOT: this.root, SED_NO_SLEEP: '1', ...(this.now ? { SED_NOW: this.now } : {}), ...extra };
  }
  cli(script, args = [], { env, input } = {}) {
    const file = script.endsWith('.mjs') ? script : `scripts/${script}.mjs`;
    const r = spawnSync(process.execPath, [file, ...args], { cwd: this.root, env: this.env(env), encoding: 'utf8', input, timeout: 240_000 });
    return wrapResult(r);
  }
  cliAsync(script, args = [], { env } = {}) {
    const file = script.endsWith('.mjs') ? script : `scripts/${script}.mjs`;
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [file, ...args], { cwd: this.root, env: this.env(env) });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('close', (code) => resolve(wrapResult({ status: code, stdout, stderr })));
    });
  }
  state(args, opts) {
    return this.cli('state', args, opts);
  }
  /** Runs a command that must exit 0 with ok !== false; returns its JSON. */
  must(script, args, opts) {
    const r = this.cli(script, args, opts);
    assert.equal(r.code, 0, `${script} ${args.join(' ')} exited ${r.code}\n${r.stdout}\n${r.stderr}`);
    assert.notEqual(r.json?.ok, false, `${script} ${args.join(' ')} said ok:false\n${r.stdout}`);
    return r.json;
  }
  mustState(args, opts) {
    return this.must('state', args, opts);
  }
  sync(message) {
    const r = this.mustState(['sync', '-m', message, '--no-sleep']);
    assert.equal(r.ok, true, JSON.stringify(r));
    return r;
  }
  git(...args) {
    return git(this.root, ...args);
  }
  dirty() {
    return this.git('status', '--porcelain');
  }
  exists(rel) {
    return fs.existsSync(this.p(rel));
  }
  read(rel) {
    return fs.readFileSync(this.p(rel), 'utf8');
  }
  json(rel) {
    return JSON.parse(this.read(rel));
  }
  write(rel, content) {
    fs.mkdirSync(path.dirname(this.p(rel)), { recursive: true });
    fs.writeFileSync(this.p(rel), typeof content === 'string' || Buffer.isBuffer(content) ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  run(date) {
    return this.json(`state/runs/${date}.json`);
  }
  history() {
    return this.json('state/history.json');
  }
  archive() {
    return this.json('docs/archive.json');
  }

  // --- playbook steps ---------------------------------------------------------------------
  begin(role, session, date, extra = []) {
    return this.mustState(['begin', '--role', role, '--session', session, '--date', date, ...extra]);
  }
  phaseStart(phase, session, date) {
    return this.mustState(['phase-start', '--phase', phase, '--session', session, '--date', date]);
  }
  phaseDone(phase, { session, role, date, note = 'ok' }) {
    return this.mustState(['phase-done', '--phase', phase, '--note', note, '--session', session, '--role', role, '--date', date]);
  }
  /** phase-start, work(), phase-done, sync: one checkpoint of the playbook's phase loop. */
  checkpoint(phase, { session, role, date, note = 'ok', work }) {
    this.phaseStart(phase, session, date);
    if (work) work();
    const done = this.phaseDone(phase, { session, role, date, note });
    this.sync(`sed(${date}): ${role} ${phase} done: ${note}`);
    return done;
  }
  finish(tier, slug, { by, date, extra = [] }) {
    return this.state(['finish', '--status', 'published', '--tier', String(tier), '--url', `${SITE_URL}d/${date}-${slug}/`, '--by', by, '--date', date, ...extra]);
  }
  /** Run one of the playbook's inline tools (Appendix A) exactly as printed there. */
  snippet(id, env = {}) {
    const r = spawnSync(process.execPath, ['--input-type=module', '-'], { cwd: this.root, env: this.env(env), input: playbookSnippet(id), encoding: 'utf8', timeout: 120_000 });
    return wrapResult(r);
  }
  /** Install a fixture project into docs/d, as the package step does after validation. */
  install(dir) {
    fs.mkdirSync(this.p('docs', 'd'), { recursive: true });
    const dest = this.p('docs', 'd', path.basename(dir));
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(dir, dest, { recursive: true });
    return dest;
  }
}

function playbookSnippet(id) {
  const m = new RegExp(`### ${id} [^\\n]*\\n[\\s\\S]*?\`\`\`bash\\n([\\s\\S]*?)\\n\`\`\``).exec(PLAYBOOK);
  assert.ok(m, `PLAYBOOK.md has no snippet ${id}`);
  const lines = m[1].split('\n');
  assert.match(lines[0], /node --input-type=module - <<'EOF'$/, `${id}: unexpected first line`);
  assert.equal(lines[lines.length - 1], 'EOF', `${id}: heredoc must end with EOF`);
  return lines.slice(1, -1).join('\n');
}

// ---------------------------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------------------------

const SYLLABLES = ['am', 'ba', 'co', 'du', 'el', 'fi', 'ga', 'hu', 'in', 'jo', 'ka', 'lu', 'me', 'no', 'or', 'pi', 'qua', 'ro', 'su', 'ti', 'um', 'vo', 'wi', 'xe', 'yo', 'zu'];
const NOUNS = ['glacier', 'harbor', 'lantern', 'meadow', 'nebula', 'orchid', 'pebble', 'quartz', 'ripple', 'saffron', 'tundra', 'velvet', 'willow', 'zephyr', 'cinder', 'drizzle', 'echo', 'fable', 'gadget', 'hollow'];
const PALETTES = [
  ['#0b1020', '#ff3d6e', '#ffd166'], ['#101820', '#4ecdc4', '#ff6b6b'], ['#1b1b2f', '#e43f5a', '#f9d56e'], ['#0f2027', '#2c7a7b', '#fbd38d'],
  ['#14121f', '#9b5de5', '#f15bb5'], ['#0d1b1e', '#55dde0', '#f7b267'], ['#1a1423', '#e0aaff', '#80ed99'], ['#111d13', '#a7c957', '#f2e8cf'],
];

function ideaWord(rnd, n = 2) {
  let w = '';
  for (let i = 0; i < n; i++) w += SYLLABLES[Math.floor(rnd() * SYLLABLES.length)];
  return w;
}

/**
 * A CONTRACT 5.3 ideas document with exactly 10 distinct ideas. Deterministic per (date, salt); categories step by 2 around
 * the taxonomy so ten of them are distinct, tags/keywords/titles are random so they never collide with earlier days.
 * Even-indexed ideas are durable. `carryoverIn` (an Idea) replaces i10 and is marked origin.agent 'carryover'.
 */
function makeIdeasDoc(date, { salt = 0, shift = 3 * dayNumber(date, D1), carryoverIn = null, chosenId = 'i04', carryoverOutId = 'i07', final = true } = {}) {
  const rnd = mulberry32(hashStr(`${date}/${salt}`));
  const ideas = Array.from({ length: 10 }, (_, i) => {
    const id = `i${String(i + 1).padStart(2, '0')}`;
    const title = `${ideaWord(rnd)} ${NOUNS[Math.floor(rnd() * NOUNS.length)]}`.replace(/^./, (c) => c.toUpperCase());
    const scores = Object.fromEntries(['sophistication', 'delight', 'distinctness', 'feasibility', 'timeliness', 'interestFit', 'polishPotential', 'safety'].map((d) => [d, 4 + Math.floor(rnd() * 6)]));
    return {
      id,
      title,
      pitch: `A ${MECHANICS[(shift + i) % MECHANICS.length]} that turns ${title.toLowerCase()} into something you can poke. It runs offline and rewards curiosity within seconds.`,
      whyNow: 'The season just opened.',
      origin: { agent: ['pulse', 'cards', 'lab', 'jester'][i % 4], lens: 'hockey-now' },
      fingerprint: {
        category: CATEGORIES[(shift + i * 2) % CATEGORIES.length],
        mechanic: MECHANICS[(shift + i) % MECHANICS.length],
        tone: ['playful'],
        tech: ['canvas2d'],
        tags: [ideaWord(rnd, 3), ideaWord(rnd, 3), ideaWord(rnd, 3)],
        keywords: [ideaWord(rnd, 3), ideaWord(rnd, 3), ideaWord(rnd, 3)],
        slot: SLOTS[i % SLOTS.length],
        political: false,
      },
      research: {
        summary: 'Summary of the research.',
        sources: [{ title: 'Primary', url: `https://example.org/ref/${date}/${i}`, note: 'Core numbers.', verified: true }],
        facts: [{ claim: 'Sourced claim', sourceIndex: 0, asOf: date }],
        inspirations: ['A classic toy'],
      },
      design: { coreLoop: 'Poke and observe.', sophisticationHooks: ['Seeded randomness'], dataNeeds: 'bundled', scopeForOneDay: 'One screen.', risks: ['Scope'] },
      durable: i % 2 === 0,
      scores,
      total: Object.values(scores).reduce((a, b) => a + b, 0),
      noveltyCheck: { ok: true, conflicts: [] },
    };
  });
  if (carryoverIn) ideas[9] = { ...carryoverIn, id: 'i10', origin: { agent: 'carryover', lens: 'carryover', carriedFrom: carryoverIn.savedFrom ?? null } };
  return {
    schema: 1,
    date,
    lenses: [{ agent: 'pulse', lensId: 'hockey-now', provocation: ['glass', 'tempo', 'ledger'] }],
    carryoverIn: carryoverIn ?? null,
    ideas,
    ...(final ? { chosenId, carryoverOutId } : {}),
    rejectedNotes: [{ title: 'Something dull', reason: 'Seen it.' }],
    rationale: 'Funniest and most buildable in a day.',
    selectedAt: `${date}T09:00:00.000Z`,
  };
}

// The pure-Node encoder behind fallback.mjs is thorough but takes seconds per 1200x630 image; fixtures only need a valid,
// small PNG, so use one Sub-filtered pass over colours quantised to 5 bits (about 60 KB).
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function pngChunk(type, data) {
  let crc = 0xffffffff;
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  for (const b of body) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([head, body, tail]);
}
function quickPng(width, height, rgba) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    raw[row] = 1;
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 3; c++) {
        const v = rgba[(y * width + x) * 4 + c] & 0xf8;
        const left = x ? rgba[(y * width + x - 1) * 4 + c] & 0xf8 : 0;
        raw[row + 1 + x * 3 + c] = (v - left) & 255;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })), pngChunk('IEND', Buffer.alloc(0))]);
}

function thumbFor(title, palette) {
  const [c0, c1, c2] = palette;
  const cv = new Canvas(1200, 630, c0);
  cv.fillLinearGradient(0, 0, 1200, 630, [[0, c0], [1, c1]]);
  cv.glow(900, 160, 380, c2, 0.5);
  cv.vignette(0.4);
  cv.text(String(title).toUpperCase().slice(0, 18), 72, 250, { scale: 9, color: '#ffffff' });
  return quickPng(1200, 630, cv.data);
}

/**
 * A complete, valid project directory <parent>/<date>-<slug>/ cloned from the validator's benign fixture
 * (1082 own lines, so it passes at tier 1) with its own title, palette, fingerprint and thumbnail.
 */
function makeProject(parent, { date, slug, title = 'Sample Toy', tier = 1, palette = PALETTES[0], category = 'math-puzzle', mechanic = 'toy', slot = 'wildcard', tags = ['automaton', 'cells', 'palette'] } = {}) {
  const dir = path.join(parent, `${date}-${slug}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(parent, { recursive: true });
  fs.cpSync(BENIGN, dir, { recursive: true });
  const pj = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  Object.assign(pj, {
    date,
    slug,
    title,
    tagline: `${title}: a tiny automaton, day ${dayNumber(date, D1)}.`,
    description: `${title} is a cellular automaton with a palette picker.`,
    tier,
    palette,
    fingerprint: { ...pj.fingerprint, category, mechanic, slot, tags, keywords: ['grid', 'rules', 'seed'] },
  });
  fs.writeFileSync(path.join(dir, 'project.json'), `${JSON.stringify(pj, null, 2)}\n`);
  const safe = String(title).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8').replace('<title>Sample Toy</title>', `<title>${safe}</title>`).replace('<h1>Sample Toy</h1>', `<h1>${safe}</h1>`);
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  fs.writeFileSync(path.join(dir, 'thumb.png'), thumbFor(title, palette));
  return dir;
}

/** The build workflow's output: the site without project.json and thumb.png. */
function buildSiteDir(box, date, slug, opts = {}) {
  const tmp = tmpDir('sed-e2e-build-');
  TO_CLEAN.push(tmp);
  const dir = makeProject(tmp, { date, slug, ...opts });
  const dest = box.p('work', date, 'build', 'site');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(dir, dest, { recursive: true });
  fs.rmSync(path.join(dest, 'project.json'));
  fs.rmSync(path.join(dest, 'thumb.png'));
  return { projectJson: JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')), dest, thumb: fs.readFileSync(path.join(dir, 'thumb.png')) };
}


/** Structural XML check: balanced tags, no bare ampersands or stray angle brackets in text. */
function assertWellFormedXml(xml, label) {
  assert.ok(xml.startsWith('<?xml'), `${label}: needs an XML declaration`);
  const body = xml.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const stack = [];
  let last = 0;
  for (const m of body.matchAll(/<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/g)) {
    const text = body.slice(last, m.index);
    assert.ok(!/[<>]/.test(text), `${label}: stray angle bracket in text "${text.slice(0, 60)}"`);
    assert.ok(!/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(text + m[3]), `${label}: bare ampersand near "${(text + m[3]).slice(0, 80)}"`);
    last = m.index + m[0].length;
    if (m[4]) continue;
    if (m[1]) assert.equal(stack.pop(), m[2], `${label}: mismatched </${m[2]}>`);
    else stack.push(m[2]);
  }
  assert.ok(!/[<>]/.test(body.slice(last)), `${label}: trailing garbage`);
  assert.deepEqual(stack, [], `${label}: unclosed elements`);
}

/** Every file under `dir` as {relPath: sha1}, for "this directory was not touched" comparisons. */
function treeHash(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else out[path.relative(dir, abs)] = String(hashStr(fs.readFileSync(abs).toString('latin1'))) + ':' + fs.statSync(abs).size;
    }
  };
  walk(dir);
  return out;
}

const DEFAULT_SHOTS = process.env.SED_E2E_SHOTS || null; // keep the browser test's screenshots here
const KEEP_SITE = process.env.SED_E2E_KEEP_SITE || null; // copy (k)'s built docs/ here for manual inspection
let BUILT_SITE = null; // set by (k) for the browser test (l)

async function loadPlaywright() {
  const unwrap = (mod) => (mod.chromium ? mod : mod.default);
  try {
    return unwrap(await import('playwright'));
  } catch {
    /* fall through to the global install */
  }
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    const require = createRequire(path.join(globalRoot, 'noop.js'));
    return unwrap(await import(pathToFileURL(require.resolve('playwright')).href));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// documentation lint: every `node scripts/...` command in the docs must name a real script, subcommand and flag
// ---------------------------------------------------------------------------------------------

const readRepo = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const listDir = (rel, ext) => fs.readdirSync(path.join(REPO, rel)).filter((f) => f.endsWith(ext)).map((f) => `${rel}/${f}`);
const DOC_FILES = [
  'ops/PLAYBOOK.md', 'ops/OPERATING.md', 'ops/FAILURE_MODES.md', 'README.md',
  ...listDir('ops/templates', '.md'), ...listDir('ops/prompts', '.md'), ...listDir('ops/roles', '.md'), ...listDir('ops/rubrics', '.md'),
  ...listDir('ops/workflows', '.js'), ...listDir('.github/workflows', '.yml'),
];
const STATE_THROTTLE_SUBS = new Set(['get', 'down', 'up', 'set', 'day-clean']);

/** {subcommand: Set(flags)} for state.mjs, read from its handler bodies. */
function stateFlagTable() {
  const text = readRepo('scripts/state.mjs');
  const body = text.slice(text.indexOf('const handlers = {'), text.indexOf('/** Runs one CLI invocation'));
  const heads = [...body.matchAll(/^ {2}(?:async )?(?:'([\w-]+)'|([\w-]+))\(\{[^)]*\}\) \{$/gm)];
  const table = new Map();
  heads.forEach((m, i) => {
    const block = body.slice(m.index, i + 1 < heads.length ? heads[i + 1].index : body.length);
    const flags = new Set(['date', 'now']);
    for (const f of block.matchAll(/(?:req|opt)\(flags, '([\w-]+)'\)/g)) flags.add(f[1]);
    for (const f of block.matchAll(/flags\.([a-z]\w*)/g)) flags.add(f[1]);
    for (const f of block.matchAll(/flags\['([\w-]+)'\]/g)) flags.add(f[1]);
    table.set(m[1] ?? m[2], flags);
  });
  table.get('sync')?.add('m');
  return table;
}

/** {subcommand: Set(flags)} from the usage lines in a script's header comment ('' = no subcommand), or null. */
function headerUsage(script) {
  const lines = readRepo(script).split('\n').slice(0, 40);
  const groups = [];
  for (const line of lines) {
    const head = /^\/\/ {2,}[\w-]+\.mjs\s*(.*)$/.exec(line);
    if (head) groups.push(head[1]);
    else if (/^\/\/ {10,}\S/.test(line) && groups.length) groups[groups.length - 1] += ` ${line.slice(2)}`;
  }
  if (!groups.length) return null;
  const table = new Map();
  for (const g of groups) {
    const first = g.trim().split(/\s+/)[0] ?? '';
    const subs = /^[a-z][\w|-]*$/.test(first) ? first.split('|') : [''];
    const flags = [...g.matchAll(/--([a-z][\w-]*)/g)].map((m) => m[1]);
    for (const sub of subs) table.set(sub, new Set([...(table.get(sub) ?? []), ...flags, 'now']));
  }
  return table;
}

/** Every `node scripts/x.mjs ...` in the documentation, with file and line. */
function docCommands() {
  const rows = [];
  for (const file of DOC_FILES) {
    readRepo(file).split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/node\s+(scripts\/[\w/.-]+\.mjs)([^`\n]*)/g)) rows.push({ file, line: i + 1, script: m[1], rest: m[2] });
    });
  }
  return rows;
}

function lintCommand({ script, rest }, stateTable) {
  if (!fs.existsSync(path.join(REPO, script))) return [`script ${script} does not exist`];
  const problems = [];
  const toks = rest.trim().split(/\s+/).filter(Boolean);
  const flags = [...rest.matchAll(/(?<![\w-])--([a-z][a-z0-9-]*)/g)].map((m) => m[1]);
  const isPlaceholder = (t) => /^[<[]/.test(t ?? '');
  if (script === 'scripts/state.mjs') {
    const alternatives = (toks[0] ?? '').split('|');
    for (const sub of alternatives) {
      if (!stateTable.has(sub)) problems.push(`state.mjs has no subcommand "${sub}"`);
      else for (const f of flags) if (!stateTable.get(sub).has(f)) problems.push(`state.mjs ${sub} does not take --${f}`);
    }
    if (alternatives[0] === 'throttle' && toks[1] && !isPlaceholder(toks[1]) && !toks[1].startsWith('-')) {
      for (const sub of toks[1].split('|')) if (!STATE_THROTTLE_SUBS.has(sub)) problems.push(`state.mjs throttle has no "${sub}"`);
    }
    return problems;
  }
  const usage = headerUsage(script);
  if (!usage) {
    const text = readRepo(script);
    for (const f of flags) if (!new RegExp(`['"\`]${f}['"\`]|--${f}\\b`).test(text)) problems.push(`${script} never mentions --${f}`);
    return problems;
  }
  const hasSubs = [...usage.keys()].some((k) => k !== '');
  const first = toks[0] ?? '';
  const subs = hasSubs ? first.split('|') : [''];
  for (const sub of subs) {
    if (!usage.has(sub)) {
      problems.push(`${script} has no subcommand "${first}" (usage lists ${[...usage.keys()].join(', ')})`);
      continue;
    }
    for (const f of flags) if (!usage.get(sub).has(f)) problems.push(`${script} ${sub} does not take --${f} (usage lists ${[...usage.get(sub)].join(', ')})`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// CONTRACT section 5 shapes, checked on files produced by the real scripts
// ---------------------------------------------------------------------------------------------

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const PHASES = ['preflight', 'ideate', 'select', 'spec', 'build', 'qa', 'revise', 'package', 'publish', 'done'];
const EVENT_KINDS = ['note', 'error', 'takeover', 'degrade', 'rate-limit', 'budget'];

function fingerprintProblems(fp, at) {
  const p = [];
  if (!isObj(fp)) return [`${at}: fingerprint is not an object`];
  if (!(fp.category in TAXONOMY.categories)) p.push(`${at}: category ${fp.category}`);
  if (!MECHANICS.includes(fp.mechanic)) p.push(`${at}: mechanic ${fp.mechanic}`);
  if (!Array.isArray(fp.tone) || !fp.tone.length || fp.tone.some((t) => !TAXONOMY.tones.includes(t))) p.push(`${at}: tone`);
  if (!SLOTS.includes(fp.slot)) p.push(`${at}: slot ${fp.slot}`);
  for (const k of ['tags', 'keywords']) {
    if (!Array.isArray(fp[k]) || fp[k].length < 3 || fp[k].length > 12 || fp[k].some((t) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(t))) p.push(`${at}: ${k} must be 3 to 12 lowercase kebab strings`);
  }
  if (!Array.isArray(fp.tech)) p.push(`${at}: tech`);
  if (typeof fp.political !== 'boolean') p.push(`${at}: political`);
  return p;
}

function runProblems(run) {
  const p = [];
  const chk = (ok, msg) => ok || p.push(`run: ${msg}`);
  chk(run.schema === 1, 'schema');
  chk(isDate(run.date), 'date');
  chk(['in_progress', 'published', 'failed'].includes(run.status), `status ${run.status}`);
  chk([1, 2, 3, 4].includes(run.targetTier), 'targetTier');
  chk(run.tier === null || [1, 2, 3, 4].includes(run.tier), 'tier');
  chk(PHASES.includes(run.phase), `phase ${run.phase}`);
  chk(Array.isArray(run.phasesDone) && run.phasesDone.every((e) => PHASES.includes(e.phase) && ISO.test(e.at) && typeof e.by === 'string'), 'phasesDone entries {phase, at, by}');
  chk(isObj(run.attempts) && Object.values(run.attempts).every(Number.isInteger), 'attempts');
  chk(run.lease === null || (isObj(run.lease) && ['holder', 'session', 'acquiredAt', 'heartbeatAt'].every((k) => typeof run.lease[k] === 'string')), 'lease');
  chk(Array.isArray(run.directives) && run.directives.every((d) => ['scope-cut', 'ship-now'].includes(d.kind) && [1, 2, 3, 4].includes(d.tier) && typeof d.by === 'string' && ISO.test(d.at) && typeof d.ack === 'boolean'), 'directives');
  chk(run.chosen === null || (isObj(run.chosen) && ['ideaId', 'slug', 'title'].every((k) => typeof run.chosen[k] === 'string')), 'chosen');
  chk(typeof run.throttle === 'string' && run.throttle in CONFIG.budget.levels, 'throttle');
  chk(isObj(run.spend) && Number.isInteger(run.spend.outputTokens) && Number.isInteger(run.spend.agentCalls) && isObj(run.spend.byPhase), 'spend');
  chk(run.publishedAt === null || ISO.test(run.publishedAt), 'publishedAt');
  chk(run.publishedUrl === null || /^https?:\/\//.test(run.publishedUrl), 'publishedUrl');
  chk(Array.isArray(run.events) && run.events.length <= 200 && run.events.every((e) => ISO.test(e.at) && typeof e.by === 'string' && EVENT_KINDS.includes(e.kind) && typeof e.msg === 'string'), `events {at, by, kind in ${EVENT_KINDS}, msg}`);
  if (run.status === 'published') chk(run.tier !== null && run.publishedAt !== null && run.publishedUrl !== null, 'published runs carry tier, publishedAt and publishedUrl');
  return p;
}

function historyProblems(history) {
  const p = [];
  if (history.schema !== 1 || !isDate(history.startDate) || !Array.isArray(history.entries)) return ['history: schema/startDate/entries'];
  const dates = new Set();
  for (const e of history.entries) {
    const at = `history ${e.date}`;
    if (dates.has(e.date)) p.push(`${at}: two entries for one date`);
    dates.add(e.date);
    if (e.n !== dayNumber(e.date, history.startDate)) p.push(`${at}: n=${e.n}`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(e.slug)) p.push(`${at}: slug`);
    if (typeof e.title !== 'string' || !e.title) p.push(`${at}: title`);
    if (typeof e.tagline !== 'string' || e.tagline.length > 120) p.push(`${at}: tagline <= 120 chars`);
    if (![1, 2, 3, 4].includes(e.tier)) p.push(`${at}: tier`);
    if (e.path !== `d/${e.date}-${e.slug}/`) p.push(`${at}: path ${e.path}`);
    if (!ISO.test(e.publishedAt)) p.push(`${at}: publishedAt`);
    if (e.countsForNovelty !== (e.tier <= 2)) p.push(`${at}: countsForNovelty must be ${e.tier <= 2} for tier ${e.tier}`);
    p.push(...fingerprintProblems(e.fingerprint, at));
  }
  return p;
}

function pngSize(buf) {
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function projectProblems(dir, entry) {
  const p = [];
  const pj = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  const at = `project ${path.basename(dir)}`;
  if (pj.schema !== 1) p.push(`${at}: schema`);
  if (pj.date !== entry.date || pj.slug !== entry.slug || path.basename(dir) !== `${pj.date}-${pj.slug}`) p.push(`${at}: date/slug/dir mismatch`);
  for (const k of ['title', 'tagline', 'description', 'makingOf', 'credits']) if (typeof pj[k] !== 'string' || !pj[k]) p.push(`${at}: ${k}`);
  if (pj.tagline.length > 120) p.push(`${at}: tagline too long`);
  if (pj.tier !== entry.tier) p.push(`${at}: tier ${pj.tier} vs history ${entry.tier}`);
  if (!Array.isArray(pj.palette) || pj.palette.length < 2 || pj.palette.length > 8 || pj.palette.some((c) => !/^#[0-9a-fA-F]{6}$/.test(c))) p.push(`${at}: palette`);
  if (pj.entry !== 'index.html' || pj.thumb !== 'thumb.png') p.push(`${at}: entry/thumb`);
  if (!Array.isArray(pj.network) || !Array.isArray(pj.sources)) p.push(`${at}: network/sources`);
  if (!isObj(pj.stats) || !['files', 'bytes', 'ownLoc'].every((k) => Number.isInteger(pj.stats[k]))) p.push(`${at}: stats`);
  p.push(...fingerprintProblems(pj.fingerprint, at));
  const thumb = fs.readFileSync(path.join(dir, 'thumb.png'));
  const { width, height } = pngSize(thumb);
  if (width !== 1200 || height !== 630) p.push(`${at}: thumb is ${width}x${height}`);
  if (thumb.length > CONFIG.limits.thumbMaxBytes) p.push(`${at}: thumb is ${thumb.length} bytes`);
  return p;
}

function archiveProblems(a, history) {
  const p = [];
  const chk = (ok, msg) => ok || p.push(`archive: ${msg}`);
  chk(a.schema === 1 && ISO.test(a.generatedAt), 'schema/generatedAt');
  chk(isObj(a.site) && ['name', 'tagline', 'url', 'startDate'].every((k) => typeof a.site[k] === 'string'), 'site');
  chk(isObj(a.stats) && ['days', 'projects', 'streak'].every((k) => Number.isInteger(a.stats[k])) && isObj(a.stats.categories) && isDate(a.stats.firstDate) && isDate(a.stats.lastDate) && Array.isArray(a.stats.missingDates), 'stats');
  chk(Array.isArray(a.days) && a.days.length === history.entries.length, 'one day per history entry');
  const dates = a.days.map((d) => d.date);
  chk(dates.every((d, i) => i === 0 || dates[i - 1] > d), 'sorted by date descending');
  for (const d of a.days) {
    const e = history.entries.find((x) => x.date === d.date);
    chk(Boolean(e), `${d.date} is in history`);
    if (!e) continue;
    chk(d.n === e.n && d.slug === e.slug && d.path === e.path && d.title === e.title && d.tagline === e.tagline && d.tier === e.tier, `${d.date}: n/slug/path/title/tagline/tier come from history`);
    chk(typeof d.description === 'string' && d.category === e.fingerprint.category && d.mechanic === e.fingerprint.mechanic, `${d.date}: description/category/mechanic`);
    chk(['tone', 'tech', 'tags', 'palette'].every((k) => Array.isArray(d[k])), `${d.date}: tone/tech/tags/palette`);
    chk(d.thumb === `${d.path}thumb.png`, `${d.date}: thumb`);
  }
  return p;
}

const doneMarker = (box, date, phase) => box.write(`work/${date}/${phase}/DONE.json`, { ok: true, phase, at: box.now });

// ---------------------------------------------------------------------------------------------
// the playbook's package step (10.1 + 10.2) on top of `work/<D>/build/site`
// ---------------------------------------------------------------------------------------------

/** `thumb` (a Buffer) stands in for the model-free thumbnail tool (A3), which takes seconds; omit it to run A3 for real. */
function packageProject(box, { date, slug, tier, projectJson, thumb = null }) {
  box.write(`work/${date}/package/project.json`, { ...projectJson, tier, stats: { files: 0, bytes: 0, ownLoc: 0 } });
  const stage = `work/${date}/tmp/pkg/${date}-${slug}`;
  fs.rmSync(box.p('work', date, 'tmp', 'pkg'), { recursive: true, force: true });
  fs.mkdirSync(box.p('work', date, 'tmp', 'pkg'), { recursive: true });
  fs.cpSync(box.p('work', date, 'build', 'site'), box.p(stage), { recursive: true });
  fs.copyFileSync(box.p('work', date, 'package', 'project.json'), box.p(stage, 'project.json'));
  if (thumb) fs.writeFileSync(box.p(stage, 'thumb.png'), thumb);
  else {
    const a3 = box.snippet('A3', { DIR: box.p(stage) });
    assert.equal(a3.code, 0, a3.stdout + a3.stderr);
    assert.equal(a3.json.ok, true);
  }
  const v1 = box.must('validate', ['project', stage, '--tier', String(tier)]);
  assert.deepEqual(v1.errors, []);
  const pj = box.json(`${stage}/project.json`);
  pj.stats = v1.stats;
  box.write(`${stage}/project.json`, pj);
  box.write(`work/${date}/package/project.json`, pj);
  const v2 = box.must('validate', ['project', stage, '--tier', String(tier)]);
  assert.deepEqual(v2.errors, []);
  assert.equal(v2.stats.files, v1.stats.files + 0);
  return stage;
}

/** Steps 2 to 5 of 10.2: install, history add, build-site, validate repo. */
function installAndRegister(box, stage, slug, date) {
  const dest = box.install(box.p(stage));
  const added = box.must('history', ['add', '--project', `docs/d/${date}-${slug}`]);
  const built = box.must('build-site', []);
  assert.deepEqual(built.omitted, [], `build-site omitted: ${JSON.stringify(built.omitted)}`);
  assert.deepEqual(built.warnings, [], 'build-site must not fall back to structural checks or warn on a healthy repo');
  const repo = box.must('validate', ['repo']);
  return { dest, added, built, repo };
}

/**
 * A tier 1/2 day from `begin` to `finish` (from the given phase on) by the given operator, following PLAYBOOK 8 to 10.
 * `ideas` = { chosenId?, carryoverOutId?, carryoverIn?, salt? } shapes the ideas documents; the built project takes
 * its fingerprint from the chosen idea. `clockDate` is the local date on the fake clock (a rerun of a past day happens later).
 * `realThumb` runs the playbook's own thumbnail tool (A3) instead of using the fixture's thumbnail.
 */
function runBuiltDay(box, { date, slug, title, role, session, tier = 1, from = 'preflight', until = 'publish', times = {}, ideas = {}, carry = true, clockDate = date, realThumb = false }) {
  const finalDoc = makeIdeasDoc(date, ideas);
  const chosen = finalDoc.ideas.find((i) => i.id === finalDoc.chosenId);
  chosen.title = title;
  const shortlistDoc = { ...finalDoc, chosenId: null, carryoverOutId: null };
  const ctx = { session, role, date };
  const order = ['preflight', 'ideate', 'select', 'spec', 'build', 'qa', 'revise', 'package', 'publish'];
  let built = null;
  const fixture = () => (built ??= buildSiteDir(box, date, slug, {
    title,
    tier,
    palette: PALETTES[dayNumber(date, D1) % PALETTES.length],
    category: chosen.fingerprint.category,
    mechanic: chosen.fingerprint.mechanic,
    slot: chosen.fingerprint.slot,
    tags: chosen.fingerprint.tags,
  }));
  const steps = {
    preflight: () => box.checkpoint('preflight', { ...ctx, note: 'preflight ok', work: () => {
      box.must('lenses', ['--date', date]);
      box.must('novelty', ['mix', '--date', date]);
      box.must('history', ['digest', '--limit', '90', '--text', '--date', date]);
    } }),
    ideate: () => box.checkpoint('ideate', { ...ctx, note: '10 ideas', work: () => {
      box.write(`work/${date}/ideas/shortlist.json`, shortlistDoc);
      const a1 = box.snippet('A1', { FILE: `work/${date}/ideas/shortlist.json`, D: date, MODE: 'shortlist' });
      assert.equal(a1.code, 0, `A1 shortlist: ${a1.stdout}${a1.stderr}`);
      assert.equal(a1.json.count, 10);
      doneMarker(box, date, 'ideate');
    } }),
    select: () => box.checkpoint('select', { ...ctx, note: `chose ${title}`, work: () => {
      box.write(`state/ideas/${date}.json`, finalDoc);
      const a1 = box.snippet('A1', { FILE: `state/ideas/${date}.json`, D: date, MODE: 'final', SLUG: slug });
      assert.equal(a1.code, 0, `A1 final: ${a1.stdout}${a1.stderr}`);
      const c = box.mustState(['choose', '--idea-id', finalDoc.chosenId, '--slug', slug, '--title', title, '--session', session, '--date', date]);
      assert.equal(c.chosen.slug, slug);
      doneMarker(box, date, 'select');
    } }),
    spec: () => box.checkpoint('spec', { ...ctx, work: () => {
      box.write(`work/${date}/spec/SPEC.md`, `# Spec for ${title}\n`);
      doneMarker(box, date, 'spec');
    } }),
    build: () => box.checkpoint('build', { ...ctx, note: 'build ok', work: () => {
      fixture();
      doneMarker(box, date, 'build');
    } }),
    qa: () => box.checkpoint('qa', { ...ctx, note: 'qa verdict ship S1=0 S2=0', work: () => {
      box.write(`work/${date}/qa/report.json`, { schema: 1, date, revision: 0, verdict: 'ship', counts: { S1: 0, S2: 0, S3: 1, S4: 0 }, browser: { ok: true, error: null }, defects: [] });
      doneMarker(box, date, 'qa');
    } }),
    revise: () => {
      box.phaseDone('revise', { ...ctx, note: 'skipped: no S1/S2' });
    },
    package: () => {
      box.phaseStart('package', session, date);
      const stage = packageProject(box, { date, slug, tier, projectJson: fixture().projectJson, thumb: realThumb ? null : fixture().thumb });
      installAndRegister(box, stage, slug, date);
      if (carry) {
        const settle = box.snippet('A2', { D: date, TIER: String(tier) });
        assert.equal(settle.code, 0, settle.stdout + settle.stderr);
      }
      box.write(`state/reports/${date}.md`, `# Day ${dayNumber(date, D1)}: ${title}\n\nTier ${tier}.\n`);
      assert.equal(box.must('validate', ['repo']).ok, true);
      box.phaseDone('package', { ...ctx, note: `package ${title}` });
      box.sync(`sed(${date}): ${role} package done: ${title}`);
    },
    publish: () => {
      box.phaseStart('publish', session, date);
      const fin = box.finish(tier, slug, { by: role, date });
      assert.equal(fin.code, 0, fin.stdout + fin.stderr);
      assert.equal(fin.json.action, 'published');
      box.sync(`sed(${date}): ${role} published tier ${tier}: ${title}`);
    },
  };
  const defaultTime = { preflight: '03:57', ideate: '04:38', select: '04:52', spec: '05:12', build: '06:05', qa: '06:25', revise: '06:26', package: '06:40', publish: '06:48' };
  for (const phase of order.slice(order.indexOf(from), order.indexOf(until) + 1)) {
    box.at(clockDate, times[phase] ?? defaultTime[phase]);
    steps[phase]();
  }
}

// ---------------------------------------------------------------------------------------------
// the suite
// ---------------------------------------------------------------------------------------------

before(() => {
  SEED_REMOTE = seedRemote();
});
after(() => {
  for (const dir of TO_CLEAN) fs.rmSync(dir, { recursive: true, force: true });
});

describe('e2e', () => {
  test('(a) happy path: primary 03:55 to published tier 1, site rebuilt, remote has every commit', async () => {
    const w = new World();
    const box = w.box('primary');
    const D = D1;
    const S = 'session-primary-a';

    box.at(D, '03:55');
    const begin = box.begin('primary', S, D);
    assert.equal(begin.action, 'proceed');
    assert.equal(begin.targetTier, 1);
    assert.equal(begin.resumePhase, 'preflight');
    assert.equal(begin.wrote, true);
    assert.equal(box.run(D).lease.session, S);
    box.sync(`sed(${D}): primary begin proceed`);
    assert.equal(w.remoteJson(`state/runs/${D}.json`).lease.holder, 'primary');

    // preflight tools answer on a day-one repo
    box.at(D, '03:57');
    const lenses = box.must('lenses', ['--date', D]);
    assert.equal(lenses.agents.length, 8);
    const mix = box.must('novelty', ['mix', '--date', D]);
    assert.deepEqual(mix.owed.sort(), [...SLOTS].sort());
    assert.match(box.cli('history', ['digest', '--text', '--date', D]).stdout, /no past projects yet/);

    // ideate's shortlist and select's document pass the playbook's own ideas-check (A1) on the way
    runBuiltDay(box, { date: D, slug: 'ember-engine', title: 'Ember Engine', role: 'primary', session: S, realThumb: true });

    const run = box.run(D);
    assert.equal(run.status, 'published');
    assert.equal(run.tier, 1);
    assert.equal(run.publishedUrl, `${SITE_URL}d/${D}-ember-engine/`);
    assert.deepEqual(run.phasesDone.map((p) => p.phase), ['preflight', 'ideate', 'select', 'spec', 'build', 'qa', 'revise', 'package', 'done']);
    assert.equal(run.chosen.slug, 'ember-engine');
    assert.equal(run.events.filter((e) => ['error', 'degrade', 'takeover'].includes(e.kind)).length, 0);

    // docs/archive.json lists the day, locally and on the remote
    for (const archive of [box.archive(), w.remoteJson('docs/archive.json')]) {
      assert.equal(archive.stats.projects, 1);
      assert.equal(archive.days[0].date, D);
      assert.equal(archive.days[0].slug, 'ember-engine');
      assert.equal(archive.days[0].tier, 1);
      assert.equal(archive.days[0].thumb, `d/${D}-ember-engine/thumb.png`);
      assert.equal(archive.days[0].n, 1);
    }
    assert.ok(w.remoteHasFile(`docs/d/${D}-ember-engine/index.html`));
    assert.ok(w.remoteHasFile('docs/index.html'));
    assert.ok(w.remoteHasFile('docs/feed.xml'));
    assert.match(w.remoteFile('docs/index.html'), /Ember Engine/);
    assert.equal(w.remoteJson('state/history.json').entries.length, 1);

    // every checkpoint reached the remote, the tree is clean
    const log = w.remoteLog();
    for (const phase of ['preflight', 'ideate', 'select', 'spec', 'build', 'qa']) {
      assert.ok(log.some((m) => m.includes(`primary ${phase} done`)), `no commit for ${phase}: ${log.join(' | ')}`);
    }
    assert.ok(log.some((m) => m.includes('published tier 1')));
    assert.deepEqual(w.remoteTree(`work/${D}/tmp`), [], 'staging copies and QA output under work/<D>/tmp are gitignored');
    assert.ok(w.remoteHasFile(`work/${D}/package/project.json`));
    assert.equal(box.dirty(), '');
    assert.equal(box.git('rev-parse', 'HEAD'), w.remoteSha());

    // the carry-over settle saved select's runner-up (i07, durable) for tomorrow
    const carry = w.remoteJson('state/carryover.json');
    assert.equal(carry.savedOn, D);
    assert.equal(carry.carriedCount, 1);
    assert.equal(carry.idea.id, 'i07');

    // verify-live against the site as GitHub Pages would serve it
    const srv = await startServer(box.p('docs'));
    try {
      const live = await box.cliAsync('verify-live', ['--date', D, '--url', srv.url, '--timeout-s', '20']);
      assert.equal(live.code, 0, live.stdout + live.stderr);
      assert.equal(live.json.live, true);
      const missing = await box.cliAsync('verify-live', ['--date', '2026-10-10', '--url', srv.url, '--timeout-s', '1', '--interval-s', '1']);
      assert.equal(missing.json.live, false);
    } finally {
      await srv.close();
    }

    // a clean day: A5 says so, day-clean counts it
    const clean = box.snippet('A5', { D });
    assert.equal(clean.json.clean, true, clean.stdout);
    assert.equal(box.mustState(['throttle', 'day-clean', '--date', D]).cleanDays, 1);

    // later sessions of the day change nothing
    for (const [role, hhmm] of [['wdA', '05:32'], ['wdB', '06:47'], ['closer', '07:27']]) {
      const other = w.box(role);
      other.at(D, hhmm);
      const r = other.begin(role, `session-${role}`, D);
      assert.equal(r.action, 'exit-published', role);
      assert.equal(r.wrote, false);
      assert.equal(other.dirty(), '', `${role} left changes behind`);
    }
    const dead = w.box('deadman');
    dead.at(D, '07:41');
    const dm = dead.must('deadman', ['--date', D, '--no-sleep']);
    assert.equal(dm.action, 'none');
    assert.equal(dead.dirty(), '');
    assert.equal(w.remoteSha(), box.git('rev-parse', 'HEAD'));

    // a brand-new checkout of the remote is a valid repo
    const fresh = w.box('fresh');
    assert.equal(fresh.must('validate', ['repo']).ok, true);
    const status = fresh.at(D, '09:00').mustState(['status', '--date', D]);
    assert.equal(status.status, 'published');
  });

  test('(b) primary dies after ideate: wdA takes over at 05:32, resumes at select and ships tier 2', () => {
    const w = new World();
    const D = D1;
    const prim = w.box('primary');
    prim.at(D, '03:55');
    prim.begin('primary', 'session-primary', D);
    prim.sync(`sed(${D}): primary begin`);
    runBuiltDay(prim, { date: D, slug: 'quartz-orchard', title: 'Quartz Orchard', role: 'primary', session: 'session-primary', until: 'ideate' });
    // the container dies in the middle of select, leaving half-written staging that was already committed
    prim.at(D, '04:42');
    prim.phaseStart('select', 'session-primary', D);
    prim.write(`work/${D}/select/partial.txt`, 'half a judge panel\n');
    prim.sync(`sed(${D}): primary select started`);
    const deadSha = w.remoteSha();

    const A = w.box('wdA');
    A.at(D, '05:32');
    const take = A.begin('wdA', 'session-wdA', D);
    assert.equal(take.action, 'takeover');
    assert.equal(take.resumePhase, 'select');
    assert.equal(take.targetTier, 2, 'a 05:32 takeover is tier 2 by the clock');
    assert.match(take.reason, /stale/i);
    assert.equal(take.run.lease.holder, 'wdA');
    assert.equal(A.exists(`work/${D}/select/partial.txt`), false, 'the interrupted phase staging is wiped');
    assert.ok(A.exists(`work/${D}/ideas/shortlist.json`), 'finished phases keep their output');
    assert.ok(take.run.events.some((e) => e.kind === 'takeover' || /takeover/i.test(e.msg)), JSON.stringify(take.run.events));
    A.sync(`sed(${D}): wdA begin takeover`);

    // the old primary wakes up on a fresh checkout: it is refused everywhere
    const Z = w.box('zombie');
    Z.at(D, '05:50');
    const beat = Z.mustState(['beat', '--role', 'primary', '--session', 'session-primary', '--phase', 'select', '--date', D]);
    assert.equal(beat.leaseHeld, false);
    const refused = Z.state(['phase-done', '--phase', 'select', '--session', 'session-primary', '--role', 'primary', '--date', D]);
    assert.equal(refused.code, 1);
    assert.match(refused.json.error, /lease is held by/);
    assert.equal(Z.dirty(), '', 'refused commands write nothing');

    // wdA finishes the day as tier 2
    runBuiltDay(A, {
      date: D, slug: 'quartz-orchard', title: 'Quartz Orchard', role: 'wdA', session: 'session-wdA', tier: 2, from: 'select',
      times: { select: '05:40', spec: '05:55', build: '06:20', qa: '06:35', revise: '06:36', package: '06:45', publish: '06:55' },
    });
    const run = A.run(D);
    assert.equal(run.status, 'published');
    assert.equal(run.tier, 2);
    assert.deepEqual(run.phasesDone.filter((p) => ['preflight', 'ideate'].includes(p.phase)).map((p) => p.by), ['primary', 'primary']);
    assert.ok(run.phasesDone.filter((p) => ['select', 'spec', 'build', 'qa', 'package'].includes(p.phase)).every((p) => p.by === 'wdA'));
    assert.equal(JSON.parse(A.read(`docs/d/${D}-quartz-orchard/project.json`)).tier, 2);
    assert.equal(w.remoteJson('docs/archive.json').days[0].tier, 2);
    assert.notEqual(w.remoteSha(), deadSha);

    // the zombie's own checkout is behind: when it syncs a late write the conflict is detected, nothing is overwritten
    prim.at(D, '05:51');
    // (--no-fetch: this container is partitioned, it cannot see wdA's takeover yet)
    prim.mustState(['beat', '--role', 'primary', '--session', 'session-primary', '--phase', 'select', '--date', D, '--no-fetch']);
    const before = w.remoteSha();
    const lateSync = prim.state(['sync', '-m', 'zombie write', '--no-sleep']);
    const late = lateSync.json;
    assert.equal(lateSync.code, 1);
    assert.equal(late.pushed, false, JSON.stringify(late));
    assert.equal(late.reason, 'displaced', 'the lease race is lost: not a text conflict to resolve by hand');
    assert.equal(late.remoteLease.session, 'session-wdA');
    assert.deepEqual(late.conflicts, [`state/runs/${D}.json`]);
    assert.equal(prim.git('status', '--porcelain', '--', 'state'), '', 'the rebase was aborted and the tree is intact');
    assert.equal(w.remoteSha(), before, 'a conflicted zombie push must not touch the remote');
    assert.equal(w.remoteJson(`state/runs/${D}.json`).lease.holder, 'wdA');
  });

  test('(b2) a phase that finished (DONE.json) but was never checkpointed is credited on takeover', () => {
    const w = new World();
    const D = D1;
    const prim = w.box('primary');
    prim.at(D, '03:55');
    prim.begin('primary', 'session-primary', D);
    prim.sync('begin');
    runBuiltDay(prim, { date: D, slug: 'quartz-orchard', title: 'Quartz Orchard', role: 'primary', session: 'session-primary', until: 'ideate' });
    prim.at(D, '04:50');
    prim.phaseStart('select', 'session-primary', D);
    const finalDoc = makeIdeasDoc(D);
    finalDoc.ideas[3].title = 'Quartz Orchard';
    prim.write(`state/ideas/${D}.json`, finalDoc);
    prim.write(`work/${D}/select/DONE.json`, { ok: true, phase: 'select', date: D, chosenId: 'i04', title: 'Quartz Orchard', slug: 'quartz-orchard', carryoverOutId: 'i07' });
    prim.sync('select output written, container died before phase-done');

    const A = w.box('wdA');
    A.at(D, '05:32');
    const take = A.begin('wdA', 'session-wdA', D);
    assert.equal(take.action, 'takeover');
    assert.deepEqual(take.recovered.map((r) => r.phase ?? r), ['select']);
    assert.equal(take.resumePhase, 'spec');
    assert.ok(A.run(D).phasesDone.some((p) => p.phase === 'select'));
    assert.ok(A.exists(`state/ideas/${D}.json`), 'recovered output is kept');
    // run.chosen was never recorded: the new operator records the selection from select's DONE.json, as PLAYBOOK 4 says
    assert.equal(take.run.chosen, null);
    const marker = A.json(`work/${D}/select/DONE.json`);
    const c = A.mustState(['choose', '--idea-id', marker.chosenId, '--slug', marker.slug, '--title', marker.title, '--session', 'session-wdA', '--date', D]);
    assert.equal(c.chosen.slug, 'quartz-orchard');
    const a1 = A.snippet('A1', { FILE: `state/ideas/${D}.json`, D, MODE: 'final', SLUG: marker.slug });
    assert.equal(a1.code, 0, a1.stdout);
  });

  test('(c) primary alive: wdA and wdB exit-alive and commit nothing', () => {
    const w = new World();
    const D = D1;
    const S = 'session-primary';
    const prim = w.box('primary');
    prim.at(D, '03:55');
    prim.begin('primary', S, D);
    prim.sync('begin');
    runBuiltDay(prim, { date: D, slug: 'cinder-fable', title: 'Cinder Fable', role: 'primary', session: S, until: 'spec' });
    prim.at(D, '05:15');
    prim.phaseStart('build', S, D);
    prim.at(D, '05:30');
    prim.mustState(['beat', '--role', 'primary', '--session', S, '--phase', 'build', '--date', D]);
    prim.sync('beat in build');
    const tip = w.remoteSha();

    const A = w.box('wdA');
    A.at(D, '05:32');
    const a = A.begin('wdA', 'session-wdA', D);
    assert.equal(a.action, 'exit-alive');
    assert.equal(a.wrote, false);
    assert.equal(a.directiveAdded, false);
    assert.equal(A.dirty(), '', 'a quiet exit leaves the tree untouched');
    assert.equal(w.remoteSha(), tip);

    // build finishes, qa is running, the primary beats at 06:40
    prim.at(D, '06:10');
    prim.phaseDone('build', { session: S, role: 'primary', date: D });
    prim.phaseStart('qa', S, D);
    prim.at(D, '06:40');
    prim.mustState(['beat', '--role', 'primary', '--session', S, '--phase', 'qa', '--date', D]);
    prim.sync('beat in qa');
    const tip2 = w.remoteSha();
    const B = w.box('wdB');
    B.at(D, '06:47');
    const b = B.begin('wdB', 'session-wdB', D);
    assert.equal(b.action, 'exit-alive');
    assert.equal(b.wrote, false);
    assert.equal(b.directiveAdded, false, 'qa is past the phases wdB cuts');
    assert.equal(B.dirty(), '');
    assert.equal(w.remoteSha(), tip2);
    const st = B.mustState(['status', '--date', D]);
    assert.equal(st.lease.alive, true);
    assert.equal(st.phase, 'qa');

    // the primary's beat is also visible through its status; the primary itself resumes cleanly
    prim.at(D, '06:50');
    const again = prim.begin('primary', S, D);
    assert.equal(again.action, 'resume');
  });

  test('(c2) the out-of-process heartbeat from a pulse loop keeps a silent primary alive for wdA', () => {
    const w = new World();
    const D = D1;
    const S = 'session-primary';
    const prim = w.box('primary');
    prim.at(D, '03:55');
    prim.begin('primary', S, D);
    prim.sync('begin');
    runBuiltDay(prim, { date: D, slug: 'cinder-fable', title: 'Cinder Fable', role: 'primary', session: S, until: 'ideate' });
    prim.at(D, '04:40');
    prim.phaseStart('select', S, D);
    prim.sync('select started');
    // no orchestrator activity for 50 minutes (a long workflow), but the Haiku pulse runs heartbeat.mjs
    prim.at(D, '05:21');
    const hbDir = path.join(w.base, 'hb-clone');
    const beat = prim.must('heartbeat', ['--role', 'primary', '--session', S, '--phase', 'select', '--wait', '0', '--date', D], { env: { SED_HB_DIR: hbDir } });
    assert.equal(beat.pushed, true, JSON.stringify(beat));
    assert.ok(w.remoteHasFile(`state/heartbeats/${D}/${S}.json`));
    assert.equal(w.remoteJson(`state/heartbeats/${D}/${S}.json`).session, S);

    const A = w.box('wdA');
    A.at(D, '05:32');
    const a = A.begin('wdA', 'session-wdA', D);
    assert.equal(a.action, 'exit-alive', `without the heartbeat this lease is 52 minutes old: ${a.reason}`);
    // the same silence with a heartbeat from a different session proves nothing and the lease is taken over
    const w2 = new World();
    const p2 = w2.box('primary');
    p2.at(D, '03:55');
    p2.begin('primary', S, D);
    p2.sync('begin');
    p2.at(D, '05:21');
    p2.must('heartbeat', ['--role', 'primary', '--session', 'some-other-session', '--phase', 'select', '--wait', '0', '--date', D], { env: { SED_HB_DIR: path.join(w2.base, 'hb-clone') } });
    const A2 = w2.box('wdA');
    A2.at(D, '05:32');
    assert.equal(A2.begin('wdA', 'session-wdA', D).action, 'takeover');
  });

  test('(c3) a primary still in ideate at 05:32 gets a scope-cut directive from wdA and obeys it', () => {
    const w = new World();
    const D = D1;
    const S = 'session-primary';
    const prim = w.box('primary');
    prim.at(D, '03:55');
    prim.begin('primary', S, D);
    prim.sync('begin');
    prim.checkpoint('preflight', { session: S, role: 'primary', date: D });
    prim.at(D, '04:10');
    prim.phaseStart('ideate', S, D);
    prim.at(D, '05:25');
    prim.mustState(['beat', '--role', 'primary', '--session', S, '--phase', 'ideate', '--date', D]);
    prim.sync('beat in ideate');

    const A = w.box('wdA');
    A.at(D, '05:32');
    const a = A.begin('wdA', 'session-wdA', D);
    assert.equal(a.action, 'exit-alive');
    assert.equal(a.directiveAdded, true);
    assert.deepEqual(a.run.directives.map((d) => [d.kind, d.tier, d.by]), [['scope-cut', 2, 'wdA']]);
    A.sync(`sed(${D}): wdA scope-cut directive`);

    prim.at(D, '05:34');
    prim.sync('primary sync pulls the directive');
    const beat = prim.mustState(['beat', '--role', 'primary', '--session', S, '--phase', 'ideate', '--date', D]);
    assert.equal(beat.leaseHeld, true);
    assert.equal(beat.targetTier, 2, 'the directive raises the target tier at once');
    assert.equal(beat.directives.length, 1);
    prim.mustState(['ack-directive', '--kind', 'scope-cut', '--date', D]);
    assert.equal(prim.mustState(['beat', '--role', 'primary', '--session', S, '--phase', 'ideate', '--date', D]).directives.length, 0);
    // the primary goes compact and keeps going; wdB later finds the same directive and adds no duplicate
    prim.at(D, '05:40');
    prim.phaseDone('ideate', { session: S, role: 'primary', date: D });
    prim.phaseStart('select', S, D);
    prim.at(D, '06:40');
    prim.mustState(['beat', '--role', 'primary', '--session', S, '--phase', 'select', '--date', D]);
    prim.sync('ack and progress');
    const B = w.box('wdB');
    B.at(D, '06:47');
    const b = B.begin('wdB', 'session-wdB', D);
    assert.equal(b.action, 'exit-alive');
    assert.equal(b.directiveAdded, false);
    assert.equal(b.run.directives.filter((d) => d.kind === 'scope-cut').length, 1);
    assert.equal(B.dirty(), '');
  });


  test('(d) primary never ran: wdB at 06:47 starts from scratch and ships an Ideas Day (tier 3) from a fixture shortlist', () => {
    const w = new World();
    const D = D1;
    const S = 'session-wdB';
    const B = w.box('wdB');
    B.at(D, '06:47');
    const begin = B.begin('wdB', S, D);
    assert.equal(begin.action, 'proceed');
    assert.equal(begin.targetTier, 3, '06:47 is past t2Until');
    assert.equal(begin.resumePhase, 'preflight');
    B.sync(`sed(${D}): wdB begin proceed`);

    B.at(D, '06:50');
    B.checkpoint('preflight', { session: S, role: 'wdB', date: D, note: 'preflight ok' });

    // compact ideate: a shortlist (one hostile title) and no final ideas document
    B.at(D, '06:58');
    const doc = makeIdeasDoc(D, { final: false });
    doc.ideas[0].total = 99;
    doc.ideas[2].title = 'Evil </script><script>alert(1)</script> Title';
    doc.ideas[2].research.sources[0].url = 'javascript:alert(1)';
    B.phaseStart('ideate', S, D);
    B.write(`work/${D}/ideas/shortlist.json`, doc);
    const a1 = B.snippet('A1', { FILE: `work/${D}/ideas/shortlist.json`, D, MODE: 'shortlist' });
    assert.equal(a1.code, 0, a1.stdout + a1.stderr);
    doneMarker(B, D, 'ideate');
    const ideateDone = B.phaseDone('ideate', { session: S, role: 'wdB', date: D, note: '10 ideas' });
    assert.equal(ideateDone.next, 'package', 'a tier 3 run goes from ideate straight to package');
    B.sync(`sed(${D}): wdB ideate done`);

    B.at(D, '07:05');
    B.phaseStart('package', S, D);
    const day = B.must('fallback', ['ideas-day', '--date', D]);
    assert.equal(day.tier, 3);
    assert.equal(day.slug, 'ideas-day');
    assert.equal(day.path, `docs/d/${D}-ideas-day/`);
    B.must('fallback', ['notice', '--date', D, '--reason', 'primary never started']);
    assert.ok(B.exists(`work/${D}/fallback-notice.json`));
    const built = B.must('build-site', []);
    assert.deepEqual(built.omitted, []);
    assert.equal(B.must('validate', ['repo']).ok, true);
    assert.equal(B.must('validate', ['project', `docs/d/${D}-ideas-day`, '--tier', '3']).ok, true);

    // the page: all ten ideas shipped as sanitized data, nothing from the hostile title or URL survived as markup
    const page = B.read(`docs/d/${D}-ideas-day/index.html`);
    assert.ok(!page.includes('<script>alert(1)'), 'hostile title must not become markup');
    assert.ok(!/href="javascript:/i.test(page));
    assert.equal(B.json(`docs/d/${D}-ideas-day/ideas.json`).ideas.length, 10);
    assert.ok(!B.read(`docs/d/${D}-ideas-day/ideas.json`).includes('javascript:'));
    const pj = B.json(`docs/d/${D}-ideas-day/project.json`);
    assert.equal(pj.tier, 3);

    // the degraded day saves the intended winner (highest total, durable) for tomorrow
    const settle = B.snippet('A2', { D, TIER: '3' });
    assert.equal(settle.json.action, 'saved', settle.stdout);
    assert.equal(settle.json.savedId, 'i01');
    assert.equal(B.json('state/carryover.json').carriedCount, 1);
    assert.equal(B.must('validate', ['repo']).ok, true);

    B.phaseDone('package', { session: S, role: 'wdB', date: D, note: 'ideas day' });
    B.sync(`sed(${D}): wdB package done: ideas day`);
    B.phaseStart('publish', S, D);
    const fin = B.finish(3, 'ideas-day', { by: 'wdB', date: D });
    assert.equal(fin.json.action, 'published');
    B.sync(`sed(${D}): wdB published tier 3`);

    assert.equal(B.run(D).tier, 3);
    const entry = w.remoteJson('state/history.json').entries.find((e) => e.date === D);
    assert.equal(entry.tier, 3);
    assert.equal(entry.countsForNovelty, false);
    assert.equal(entry.slug, 'ideas-day');
    const archive = w.remoteJson('docs/archive.json');
    assert.deepEqual([archive.days[0].tier, archive.days[0].slug], [3, 'ideas-day']);
    assert.ok(w.remoteHasFile(`docs/d/${D}-ideas-day/thumb.png`));
    // a tier 3 day does not burn a category: tomorrow's novelty gate sees an empty history
    const mix = B.at(addDays(D, 1), '03:57').must('novelty', ['mix', '--date', addDays(D, 1)]);
    assert.deepEqual(mix.categoryCounts, {});
    // not a clean day: no day-clean for a fallback
    assert.equal(B.snippet('A5', { D }).json.clean, false);
  });

  test('(e) nothing at all: closer at 07:27 gets tier 4, deadman publishes the Postcard, second run is a no-op', () => {
    const w = new World();
    const D = D1;
    const C = w.box('closer');
    C.at(D, '07:27');
    const begin = C.begin('closer', 'session-closer', D);
    assert.equal(begin.action, 'proceed');
    assert.equal(begin.targetTier, 4);
    const out = C.must('deadman', ['--force', '--date', D, '--no-sleep']);
    assert.equal(out.action, 'published');
    assert.equal(out.tier, 4);
    assert.equal(out.slug, 'postcard');
    assert.equal(out.sync.pushed, true, JSON.stringify(out.sync));
    assert.deepEqual(out.warnings, [], 'deadman must not silently skip a step (missing module, unreadable run file, failed build-site)');
    assert.equal(out.siteBuilt, true);
    assert.equal(out.url, `${SITE_URL}d/${D}-postcard/`);

    const run = w.remoteJson(`state/runs/${D}.json`);
    assert.equal(run.status, 'published');
    assert.equal(run.tier, 4);
    assert.equal(run.publishedUrl, out.url);
    assert.ok(run.events.some((e) => e.kind === 'degrade'));
    assert.equal(w.remoteJson('state/history.json').entries[0].countsForNovelty, false);
    for (const f of ['index.html', 'project.json', 'thumb.png']) assert.ok(w.remoteHasFile(`docs/d/${D}-postcard/${f}`), f);
    assert.deepEqual([w.remoteJson('docs/archive.json').days[0].tier, w.remoteJson('docs/archive.json').days[0].slug], [4, 'postcard']);
    assert.equal(C.must('validate', ['project', `docs/d/${D}-postcard`, '--tier', '4']).ok, true);
    assert.equal(C.must('validate', ['repo']).ok, true);
    assert.ok(C.exists(`work/${D}/fallback-notice.json`));
    assert.equal(C.dirty(), '');

    const tip = w.remoteSha();
    assert.equal(C.begin('closer', 'session-closer', D).action, 'exit-published');
    const again = C.must('deadman', ['--force', '--date', D, '--no-sleep']);
    assert.equal(again.action, 'none');
    assert.equal(again.reason, 'already-published');
    assert.equal(w.remoteSha(), tip);
    assert.equal(C.dirty(), '');

    // the carry-over settle after a postcard with no ideas on disk leaves the store alone
    const settle = C.snippet('A2', { D, TIER: '4' });
    assert.equal(settle.json.action, 'unchanged', settle.stdout);
  });

  test('(e2) deadman alone (the GitHub Action path): quiet before 07:30, tier 3 when ideas exist, tier 4 otherwise', () => {
    const D = D1;
    // before 07:30 and without --force nothing happens
    const w = new World();
    const early = w.box('action');
    early.at(D, '07:29');
    const none = early.must('deadman', ['--date', D, '--no-sleep']);
    assert.equal(none.action, 'none');
    assert.equal(none.reason, 'too-early');
    assert.equal(early.dirty(), '');
    assert.equal(w.remoteSha(), early.git('rev-parse', 'HEAD'));

    // 07:41, nothing on disk: Postcard
    const late = w.box('action2');
    late.at(D, '07:41');
    const out = late.must('deadman', ['--date', D, '--no-sleep']);
    assert.equal(out.action, 'published');
    assert.equal(out.tier, 4);
    assert.equal(out.sync.pushed, true);
    assert.deepEqual(out.warnings, []);

    // with a researched shortlist on the remote: Ideas Day, even though no run file exists
    const w2 = new World();
    const seed = w2.box('seed');
    seed.at(D, '05:00');
    seed.write(`work/${D}/ideas/shortlist.json`, makeIdeasDoc(D, { final: false }));
    seed.sync('shortlist only');
    const action = w2.box('action');
    action.at(D, '07:41');
    const out3 = action.must('deadman', ['--date', D, '--no-sleep']);
    assert.equal(out3.action, 'published');
    assert.equal(out3.tier, 3);
    assert.equal(out3.slug, 'ideas-day');
    assert.deepEqual(out3.warnings, []);
    assert.equal(out3.runAction, 'proceed');
    assert.equal(w2.remoteJson(`state/runs/${D}.json`).status, 'published');
    assert.equal(action.must('validate', ['repo']).ok, true);
  });

  test('(f) double fire: concurrent begins on one checkout produce exactly one proceed, every time', async () => {
    const w = new World();
    const box = w.box('primary');
    const dates = Array.from({ length: 6 }, (_, i) => addDays(D1, i));
    for (const D of dates) {
      box.at(D, '03:55');
      const sessions = ['s1', 's2', 's3', 's4'].map((s) => `${s}-${D}`);
      const results = await Promise.all(sessions.map((s) => box.cliAsync('state', ['begin', '--role', 'primary', '--session', s, '--date', D])));
      for (const r of results) assert.equal(r.code, 0, r.stdout + r.stderr);
      const actions = results.map((r) => r.json.action).sort();
      assert.deepEqual(actions, ['exit-alive', 'exit-alive', 'exit-alive', 'proceed'], `${D}: ${actions}`);
      const winner = sessions[results.findIndex((r) => r.json.action === 'proceed')];
      const run = box.run(D);
      assert.equal(run.lease.session, winner);
      assert.equal(run.events.filter((e) => /run created/.test(e.msg)).length, 1);
      for (const r of results.filter((x) => x.json.action === 'exit-alive')) assert.equal(r.json.wrote, false);
    }
    const strays = fs.readdirSync(box.p('state', 'runs')).filter((f) => !/^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f !== '.gitkeep');
    assert.deepEqual(strays, [], 'no lock or temp files may be left behind');
    // every run file is valid JSON
    for (const D of dates) assert.equal(box.run(D).date, D);
  });

  test('(f2) double fire in two containers: the second push loses (displaced) and the remote shows who owns the day', () => {
    const w = new World();
    const D = D1;
    const one = w.box('first');
    const two = w.box('second');
    one.at(D, '03:55');
    two.at(D, '03:55');
    assert.equal(one.begin('primary', 'session-one', D).action, 'proceed');
    assert.equal(two.begin('primary', 'session-two', D).action, 'proceed', 'separate checkouts cannot see each other yet');
    one.sync('one begin');
    const tip = w.remoteSha();
    const lost = two.state(['sync', '-m', 'two begin', '--no-sleep']);
    assert.equal(lost.code, 1);
    assert.equal(lost.json.pushed, false);
    assert.equal(lost.json.reason, 'displaced');
    assert.equal(lost.json.remoteLease.session, 'session-one');
    assert.equal(w.remoteSha(), tip, 'the loser must not overwrite the winner');
    // PLAYBOOK R1 step 1: the remote run file shows another holder with a fresh lease, so the loser stops
    two.git('fetch', 'origin', BRANCH);
    const remoteRun = JSON.parse(two.git('show', `origin/${BRANCH}:state/runs/${D}.json`));
    assert.equal(remoteRun.lease.session, 'session-one');
    assert.equal(remoteRun.lease.holder, 'primary');
    assert.equal(w.remoteJson(`state/runs/${D}.json`).lease.session, 'session-one');
    // a third session started now sees the winner's lease on the remote
    const three = w.box('third');
    three.at(D, '04:05');
    assert.equal(three.begin('wdA', 'session-three', D).action, 'exit-alive');
  });

  test('(g) a late primary replaces the closer\'s Ideas Day: conflict, R1, late finisher; history replaced, fallback dir removed', () => {
    const w = new World();
    const D = D1;
    const S = 'session-primary';
    const prim = w.box('primary');
    prim.at(D, '03:55');
    prim.begin('primary', S, D);
    prim.sync('begin');
    runBuiltDay(prim, { date: D, slug: 'saffron-lantern', title: 'Saffron Lantern', role: 'primary', session: S, until: 'qa' });
    prim.at(D, '07:05');
    prim.phaseStart('package', S, D);
    prim.at(D, '07:10');
    prim.phaseStart('package', S, D); // the package step has failed once already: no rescue, the closer goes for the Ideas Day
    prim.sync('package started');

    // 07:27: the closer force-degrades (the lease is fresh, but the clock is past t3Until) and ships the Ideas Day
    const C = w.box('closer');
    C.at(D, '07:27');
    const fd = C.begin('closer', 'session-closer', D);
    assert.equal(fd.action, 'force-degrade');
    assert.equal(fd.targetTier, 3, 'ideate was done, so the fallback is the Ideas Day');
    assert.ok(fd.run.directives.some((d) => d.kind === 'ship-now'));
    const dm = C.must('deadman', ['--force', '--date', D, '--no-sleep']);
    assert.equal(dm.action, 'published');
    assert.equal(dm.tier, 3);
    assert.equal(w.remoteJson('state/history.json').entries[0].slug, 'ideas-day');
    assert.equal(C.snippet('A2', { D, TIER: '3' }).code, 0);
    C.sync('closer settle');
    assert.ok(w.remoteHasFile(`docs/d/${D}-ideas-day/index.html`));

    // 07:50: the primary's workflow returns. Its next checkpoint sync collides with the closer's run file.
    prim.at(D, '07:50');
    prim.write(`work/${D}/package/notes.txt`, 'late work\n');
    prim.mustState(['beat', '--role', 'primary', '--session', S, '--phase', 'package', '--date', D, '--no-fetch']); // not yet aware of the closer
    const collide = prim.state(['sync', '-m', 'primary checkpoint', '--no-sleep']);
    assert.equal(collide.code, 1);
    assert.equal(collide.json.reason, 'displaced');
    assert.ok(collide.json.conflicts.includes(`state/runs/${D}.json`));

    // PLAYBOOK R1: look at the remote run file (another holder, published), then rebase taking the remote side
    prim.git('fetch', 'origin', BRANCH);
    const remoteRun = JSON.parse(prim.git('show', `origin/${BRANCH}:state/runs/${D}.json`));
    assert.equal(remoteRun.status, 'published');
    assert.equal(remoteRun.tier, 3);
    const rebase = gitTry(prim.root, 'rebase', `origin/${BRANCH}`);
    assert.equal(rebase.ok, false, 'the same conflict shows up in the manual rebase');
    const conflicted = prim.git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
    assert.ok(conflicted.includes(`state/runs/${D}.json`), conflicted.join(','));
    for (const f of conflicted) {
      prim.git('checkout', '--ours', '--', f);
      prim.git('add', f);
    }
    const cont = gitTry(prim.root, '-c', 'core.editor=true', 'rebase', '--continue');
    assert.equal(cont.ok, true, `rebase --continue: ${cont.out}`);
    assert.equal(prim.git('status', '--porcelain'), '');

    // the operator now sees the published fallback and is no longer the lease holder
    const st = prim.mustState(['status', '--date', D]);
    assert.equal(st.status, 'published');
    assert.equal(st.tier, 3);
    const blocked = prim.state(['phase-done', '--phase', 'package', '--session', S, '--role', 'primary', '--date', D]);
    assert.equal(blocked.code, 1, 'a displaced operator cannot run lease-guarded commands');

    // PLAYBOOK 11: stage and validate first, then install, history add, finish (upgraded), build-site, validate repo, settle, sync
    const { projectJson } = buildSiteDir(prim, D, 'saffron-lantern', { title: 'Saffron Lantern', tier: 1, palette: PALETTES[3] });
    const stage = packageProject(prim, { date: D, slug: 'saffron-lantern', tier: 1, projectJson });
    prim.install(prim.p(stage));
    const added = prim.must('history', ['add', '--project', `docs/d/${D}-saffron-lantern`]);
    assert.equal(added.replaced, true, 'the fallback entry is replaced, not duplicated');
    const up = prim.finish(1, 'saffron-lantern', { by: 'primary', date: D });
    assert.equal(up.code, 0, up.stdout);
    assert.equal(up.json.action, 'upgraded');
    assert.deepEqual(up.json.removedDirs.map((d) => path.basename(d)), [`${D}-ideas-day`]);
    assert.equal(prim.exists(`docs/d/${D}-ideas-day`), false);
    assert.deepEqual(prim.must('build-site', []).omitted, []);
    assert.equal(prim.must('validate', ['repo']).ok, true);
    const settle = prim.snippet('A2', { D, TIER: '1' });
    assert.equal(settle.json.action, 'saved', settle.stdout);
    assert.equal(settle.json.savedId, 'i07');
    prim.sync(`sed(${D}): primary late finisher upgrades to tier 1`);

    // the remote is consistent
    const history = w.remoteJson('state/history.json');
    assert.equal(history.entries.length, 1);
    assert.deepEqual([history.entries[0].slug, history.entries[0].tier, history.entries[0].countsForNovelty, history.entries[0].n], ['saffron-lantern', 1, true, 1]);
    assert.deepEqual(w.remoteTree('docs/d').map((f) => f.split('/')[2]).filter((v, i, a) => a.indexOf(v) === i), [`${D}-saffron-lantern`]);
    const archive = w.remoteJson('docs/archive.json');
    assert.equal(archive.days.length, 1);
    assert.deepEqual([archive.days[0].slug, archive.days[0].tier], ['saffron-lantern', 1]);
    assert.ok(!w.remoteFile('docs/feed.xml').includes('ideas-day'));
    const run = w.remoteJson(`state/runs/${D}.json`);
    assert.equal(run.tier, 1);
    assert.equal(run.publishedUrl, `${SITE_URL}d/${D}-saffron-lantern/`);
    assert.equal(w.remoteJson('state/carryover.json').idea.id, 'i07');
    const fresh = w.box('fresh');
    assert.equal(fresh.must('validate', ['repo']).ok, true);

    // never downgrade, never re-upgrade into a no-op
    prim.at(D, '08:05');
    const down = prim.finish(3, 'ideas-day', { by: 'closer', date: D });
    assert.equal(down.code, 1);
    assert.equal(down.json.action, 'refused');
    const same = prim.finish(1, 'saffron-lantern', { by: 'primary', date: D });
    assert.equal(same.code, 0);
    assert.equal(same.json.action, 'noop');
    assert.equal(prim.run(D).tier, 1);
  });

  test('(g2) the upgrade window closes at 23:59 local; a better tier is never replaced by a worse one', () => {
    const w = new World();
    const D = D1;
    const C = w.box('closer');
    C.at(D, '07:41');
    assert.equal(C.must('deadman', ['--date', D, '--no-sleep']).tier, 4);
    C.at(D, '23:59');
    const late = C.finish(2, 'x', { by: 'primary', date: D });
    assert.equal(late.code, 1);
    assert.equal(late.json.action, 'refused');
    assert.equal(C.run(D).tier, 4);
    C.at(D, '23:58');
    // finish only accepts a tier whose page and history entry exist
    C.write(`docs/d/${D}-x/index.html`, '<html></html>');
    const hist = C.history();
    hist.entries = [{ ...hist.entries[0], slug: 'x', tier: 2, path: `d/${D}-x/` }];
    C.write('state/history.json', hist);
    const ok = C.finish(2, 'x', { by: 'primary', date: D });
    assert.equal(ok.code, 0, ok.stdout);
    assert.equal(ok.json.action, 'upgraded');
    assert.deepEqual(ok.json.removedDirs.map((d) => path.basename(d)), [`${D}-postcard`]);
    assert.equal(C.exists(`docs/d/${D}-postcard`), false);
  });


  test('(h) DST: tier-by-time, run dates and staleness use local wall-clock cutoffs but absolute instants', () => {
    const FALL = '2026-11-01'; // 01:00-02:00 happens twice, the day has 25 hours
    const SPRING = '2027-03-14'; // 02:00-03:00 does not exist, the day has 23 hours
    const w = new World();
    const box = w.box('probe');
    const table = [['03:55', 1], ['04:44', 1], ['04:45', 2], ['06:44', 2], ['06:45', 3], ['07:24', 3], ['07:25', 4], ['23:30', 4]];
    for (const D of [D1, FALL, SPRING]) {
      for (const [hhmm, tier] of table) {
        box.at(D, hhmm);
        const t = box.must('state', ['today']);
        assert.equal(t.date, D, `${D} ${hhmm}: run date`);
        assert.equal(t.time, hhmm);
        assert.equal(t.dayNumber, dayNumber(D, D1));
        assert.equal(t.targetTierIfStartedNow, tier, `${D} ${hhmm}`);
        assert.equal(t.minutesToDeadline, 480 - t.minutes);
      }
      // the date follows the local calendar, not UTC: late evening local is already tomorrow in UTC
      box.at(D, '22:30');
      const evening = box.must('state', ['today']);
      assert.equal(evening.date, D);
      assert.equal(evening.time, '22:30');
      assert.equal(new Date(box.now).toISOString().slice(0, 10), addDays(D, 1), 'the fixture really is the next UTC day');
      const mix = box.must('novelty', ['mix', '--date', D]);
      assert.equal(mix.window.to, addDays(D, -1));
      assert.equal(box.must('lenses', ['--date', D]).date, D);
    }

    // begin without --date derives the run date from the local clock, even at 01:30 on the repeated hour
    const first = w.box('fall-first');
    first.now = '2026-11-01T05:30:00.000Z'; // 01:30 EDT
    assert.equal(first.mustState(['today']).time, '01:30');
    const second = w.box('fall-second');
    second.now = '2026-11-01T06:30:00.000Z'; // 01:30 EST, an hour later on the wall clock
    assert.equal(second.mustState(['today']).time, '01:30');
    assert.equal(second.mustState(['today']).date, FALL);

    // fall back: a heartbeat at 01:10 EDT (05:10Z) and a check at 01:20 EST (06:20Z) look 10 minutes apart on the wall
    // clock but are 70 real minutes apart: the lease is stale
    const fall = new World();
    const p1 = fall.box('primary');
    p1.now = '2026-11-01T05:10:00.000Z';
    p1.begin('primary', 'session-primary', FALL);
    p1.sync('begin');
    const wd1 = fall.box('wdA');
    wd1.now = '2026-11-01T06:20:00.000Z';
    const a1 = wd1.begin('wdA', 'session-wdA', FALL);
    assert.equal(a1.action, 'takeover', a1.reason);
    // while a check 25 real minutes later is fresh although the wall clock went backwards
    const fall2 = new World();
    const p2 = fall2.box('primary');
    p2.now = '2026-11-01T05:50:00.000Z'; // 01:50 EDT
    p2.begin('primary', 'session-primary', FALL);
    p2.sync('begin');
    const wd2 = fall2.box('wdA');
    wd2.now = '2026-11-01T06:15:00.000Z'; // 01:15 EST
    assert.equal(wd2.begin('wdA', 'session-wdA', FALL).action, 'exit-alive');

    // spring forward: 01:50 EST (06:50Z) to 03:10 EDT (07:10Z) is 20 real minutes although the wall clock jumped 80
    const spring = new World();
    const p3 = spring.box('primary');
    p3.now = '2027-03-14T06:50:00.000Z';
    p3.begin('primary', 'session-primary', SPRING);
    p3.sync('begin');
    const wd3 = spring.box('wdA');
    wd3.now = '2027-03-14T07:10:00.000Z';
    assert.equal(wd3.mustState(['today']).time, '03:10');
    assert.equal(wd3.begin('wdA', 'session-wdA', SPRING).action, 'exit-alive');

    // the whole safety net works on both DST days: deadman at 07:41 local publishes and the site is consistent
    for (const D of [FALL, SPRING]) {
      const world = new World();
      const c = world.box('closer');
      c.at(D, '07:41');
      const out = c.must('deadman', ['--date', D, '--no-sleep']);
      assert.equal(out.action, 'published', JSON.stringify(out));
      const run = world.remoteJson(`state/runs/${D}.json`);
      assert.equal(run.tier, 4);
      assert.equal(run.publishedAt, c.now);
      const archive = world.remoteJson('docs/archive.json');
      assert.equal(archive.days[0].date, D);
      assert.equal(archive.days[0].n, dayNumber(D, D1));
      assert.equal(archive.stats.days, dayNumber(D, D1));
      assert.equal(archive.stats.missingDates.length, dayNumber(D, D1) - 1);
      assert.equal(archive.stats.missingDates[0], D1);
      assert.equal(archive.stats.missingDates.at(-1), addDays(D, -1));
    }
  });

  test('(i) a corrupt run file is quarantined by begin, the day restarts, nothing crashes', () => {
    const D = D1;
    const variants = {
      'truncated JSON': '{"schema":1,"date":"2026-10-09","status":"in_prog',
      'empty file': '',
      'binary junk': Buffer.from([0, 255, 254, 1, 2, 3, 200, 0]),
      'array instead of object': '[]',
      'wrong date inside': JSON.stringify({ schema: 1, date: '2020-01-01', status: 'in_progress', phase: 'preflight', phasesDone: [], lease: { holder: 'primary', session: 'x', acquiredAt: '2020-01-01T00:00:00Z', heartbeatAt: '2020-01-01T00:00:00Z' }, events: [] }),
    };
    for (const [label, bad] of Object.entries(variants)) {
      const w = new World();
      const src = w.box('src');
      src.at(D, '04:10');
      src.write(`state/runs/${D}.json`, bad);
      src.sync(`corrupt run file (${label})`);

      const A = w.box('wdA');
      A.at(D, '05:32');
      // read-only and lease-guarded commands fail politely: JSON on stdout, a message, no stack trace, file untouched
      const before = fs.readFileSync(A.p('state', 'runs', `${D}.json`));
      const ps = A.state(['phase-start', '--phase', 'ideate', '--session', 's', '--date', D]);
      assert.equal(ps.code, 1, `${label}: ${ps.stdout}`);
      assert.equal(ps.json.ok, false);
      assert.match(ps.json.error, /corrupt|begin/i);
      assert.ok(!/at .*\.mjs:\d+/.test(ps.stdout), 'no stack trace on stdout');
      const st = A.state(['status', '--date', D]);
      assert.ok(st.json && typeof st.json === 'object' && !st.json.__unparseable, `${label}: status output ${st.stdout}`);
      assert.deepEqual(fs.readFileSync(A.p('state', 'runs', `${D}.json`)), before);
      // the repo validator reports it
      const repo = A.cli('validate', ['repo']);
      assert.equal(repo.json.ok, false, `${label}: validate repo should flag the run file`);
      assert.ok(repo.json.errors.some((e) => /run/i.test(e) && new RegExp(D).test(e)), repo.stdout);

      // begin recovers
      const begin = A.begin('wdA', 'session-wdA', D);
      assert.equal(begin.action, 'proceed', `${label}: ${begin.reason}`);
      assert.equal(begin.targetTier, 2);
      assert.ok(begin.corrupt, `${label}: begin reports the quarantined file`);
      const quarantined = fs.readdirSync(A.p('state', 'runs')).filter((f) => f.startsWith(`${D}.json.corrupt-`));
      assert.equal(quarantined.length, 1, `${label}: ${fs.readdirSync(A.p('state', 'runs'))}`);
      assert.deepEqual(fs.readFileSync(A.p('state', 'runs', quarantined[0])), before, 'the bad bytes are preserved for inspection');
      const run = A.run(D);
      assert.equal(run.lease.holder, 'wdA');
      assert.ok(run.events.some((e) => e.kind === 'error' && /corrupt/i.test(e.msg)), JSON.stringify(run.events));
      assert.equal(A.must('validate', ['repo']).ok, true, `${label}: the quarantined copy is not a run file`);
      A.sync(`sed(${D}): wdA recovered from a corrupt run file`);
      assert.ok(w.remoteHasFile(`state/runs/${D}.json.corrupt-1`));
      // and the day can be finished normally from here
      A.checkpoint('preflight', { session: 'session-wdA', role: 'wdA', date: D });
      assert.equal(A.run(D).phase, 'ideate');
    }

    // deadman copes too: a corrupt run file never blocks the safety net
    const w = new World();
    const src = w.box('src');
    src.at(D, '07:41');
    src.write(`state/runs/${D}.json`, '{"schema":1,');
    src.sync('corrupt');
    const c = w.box('action');
    c.at(D, '07:41');
    const out = c.must('deadman', ['--date', D, '--no-sleep']);
    assert.equal(out.action, 'published', JSON.stringify(out));
    assert.equal(w.remoteJson(`state/runs/${D}.json`).status, 'published');

    // a writer killed mid-write leaves only a *.tmp file: ignored by git and by the state scripts
    const w2 = new World();
    const b = w2.box('primary');
    b.at(D, '03:55');
    b.write(`state/runs/${D}.json.4242.1790000000000.tmp`, '{"half":');
    assert.equal(b.begin('primary', 'session-primary', D).action, 'proceed');
    assert.equal(b.git('status', '--porcelain', '--', 'state/runs').includes('.tmp'), false);
  });

  test('(j) carry-over over three days: saved once, re-enters once, cannot be saved again; repo validator guards the file', () => {
    const w = new World();
    const D2 = addDays(D1, 1);
    const D3 = addDays(D1, 2);
    const D4 = addDays(D1, 3);
    const carryFile = 'state/carryover.json';

    // day 1: select names i07 (durable) as the carry-over; the built idea is i04
    const day1 = w.box('day1');
    day1.at(D1, '03:55');
    day1.begin('primary', 'session-1', D1);
    day1.sync('begin');
    runBuiltDay(day1, { date: D1, slug: 'ember-engine', title: 'Ember Engine', role: 'primary', session: 'session-1' });
    const saved1 = w.remoteJson(carryFile);
    assert.deepEqual([saved1.idea.id, saved1.savedOn, saved1.carriedCount, saved1.idea.durable], ['i07', D1, 1, true]);

    // day 2: preflight rule R1 lets it in (durable, within maxCarries); it fills the pool as i10 with origin.agent carryover.
    // select builds i04 again and names the carried-in idea as the carry-out once more: the settle tool refuses a second carry
    const day2 = w.box('day2');
    day2.at(D2, '03:55');
    const carried = day2.json(carryFile);
    assert.ok(carried.idea.durable && carried.carriedCount <= CONFIG.ideation.carryover.maxCarries, 'R1 passes the idea in');
    day2.begin('primary', 'session-2', D2);
    day2.sync('begin');
    runBuiltDay(day2, {
      date: D2, slug: 'cinder-fable', title: 'Cinder Fable', role: 'primary', session: 'session-2', carry: false,
      ideas: { carryoverIn: carried.idea, carryoverOutId: 'i10' },
    });
    const doc2 = day2.json(`state/ideas/${D2}.json`);
    assert.equal(doc2.ideas.length, 10);
    assert.equal(doc2.ideas.find((i) => i.id === 'i10').origin.agent, 'carryover');
    const settle2 = day2.snippet('A2', { D: D2, TIER: '1' });
    assert.equal(settle2.json.action, 'cleared', settle2.stdout);
    assert.match(settle2.json.refused, /already carried/);
    assert.deepEqual(day2.json(carryFile), { schema: 1, idea: null, savedOn: null, carriedCount: 0 });
    assert.equal(day2.must('validate', ['repo']).ok, true);
    // idempotent
    assert.equal(day2.snippet('A2', { D: D2, TIER: '1' }).json.action, 'cleared');

    // day 3: the store is empty; a fresh durable runner-up is saved again, a non-durable one is refused
    const day3 = w.box('day3');
    day3.at(D3, '03:55');
    day3.begin('primary', 'session-3', D3);
    day3.sync('begin');
    runBuiltDay(day3, { date: D3, slug: 'glacier-hollow', title: 'Glacier Hollow', role: 'primary', session: 'session-3', carry: false, ideas: { carryoverOutId: 'i05' } });
    const s3 = day3.snippet('A2', { D: D3, TIER: '1' });
    assert.deepEqual([s3.json.action, s3.json.savedId, s3.json.carriedCount], ['saved', 'i05', 1], s3.stdout);
    day3.write(`state/ideas/${D3}.json`, { ...day3.json(`state/ideas/${D3}.json`), carryoverOutId: 'i02' });
    const nd = day3.snippet('A2', { D: D3, TIER: '1' });
    assert.equal(nd.json.action, 'cleared');
    assert.match(nd.json.refused, /not durable/);
    day3.write(`state/ideas/${D3}.json`, { ...day3.json(`state/ideas/${D3}.json`), carryoverOutId: 'i04' });
    const built3 = day3.snippet('A2', { D: D3, TIER: '1' }).json;
    assert.equal(built3.action, 'cleared');
    assert.match(built3.basis, /was built/, 'the idea that was built is never carried');
    day3.write(`state/ideas/${D3}.json`, { ...day3.json(`state/ideas/${D3}.json`), carryoverOutId: 'i05' });
    assert.equal(day3.snippet('A2', { D: D3, TIER: '1' }).json.action, 'saved');
    day3.sync('settled');

    // day 4 degrades to Ideas Day: the intended winner (durable i09) replaces the stored idea
    const day4 = w.box('day4');
    day4.at(D4, '07:27');
    day4.write(`state/ideas/${D4}.json`, makeIdeasDoc(D4, { chosenId: 'i09', carryoverOutId: 'i03' }));
    const s4 = day4.snippet('A2', { D: D4, TIER: '3' });
    assert.deepEqual([s4.json.action, s4.json.savedId, s4.json.carriedCount], ['saved', 'i09', 1], s4.stdout);
    assert.equal(day4.json(carryFile).idea.id, 'i09');
    assert.equal(day4.must('validate', ['repo']).ok, true);

    // validate repo catches every way carryover.json can violate the invariants
    const good = day4.json(carryFile);
    const bad = {
      'two ideas': { ...good, idea: [good.idea, good.idea] },
      'carried twice': { ...good, carriedCount: 2 },
      'non-durable idea': { ...good, idea: { ...good.idea, durable: false } },
      'idea without savedOn': { ...good, savedOn: null },
      'negative count': { ...good, carriedCount: -1 },
      'not an object': [],
    };
    for (const [label, doc] of Object.entries(bad)) {
      day4.write(carryFile, doc);
      const r = day4.cli('validate', ['repo']);
      assert.equal(r.json.ok, false, `validate repo must reject: ${label}\n${r.stdout}`);
      assert.ok(r.json.errors.some((e) => /carryover/i.test(e)), `${label}: ${JSON.stringify(r.json.errors)}`);
    }
    day4.write(carryFile, '{ not json');
    assert.equal(day4.cli('validate', ['repo']).json.ok, false);
    day4.write(carryFile, good);
    assert.equal(day4.must('validate', ['repo']).ok, true);
  });

  test('(k) 32 simulated days of fixtures, postcards and an Ideas Day: build-site is fast, archive and feeds are exact', () => {
    const w = new World();
    const box = w.box('days');
    const days = 32;
    const gap = 12;
    const tmp = tmpDir('sed-e2e-days-');
    TO_CLEAN.push(tmp);
    const published = [];
    for (let i = 0; i < days; i++) {
      const D = addDays(D1, i);
      if (i === gap) continue;
      box.at(D, '06:50');
      if (i === 19) {
        box.write(`state/ideas/${D}.json`, makeIdeasDoc(D));
        const r = box.must('fallback', ['ideas-day', '--date', D]);
        assert.deepEqual(r.warnings, [], 'a clean ideas document gives a clean Ideas Day');
        published.push({ i, D, tier: 3, slug: r.slug });
      } else if (i % 6 === 3) {
        const r = box.must('fallback', ['postcard', '--date', D]);
        assert.deepEqual(r.warnings, []);
        published.push({ i, D, tier: 4, slug: r.slug });
      } else {
        const slug = `${NOUNS[i % NOUNS.length]}-${i}`;
        const title = i === 5 ? 'Salt & Pepper <Mill>' : `Toy ${NOUNS[i % NOUNS.length]} ${i}`;
        const dir = makeProject(tmp, {
          date: D, slug, title, tier: i % 7 === 0 ? 2 : 1, palette: PALETTES[i % PALETTES.length],
          category: CATEGORIES[(i * 5) % CATEGORIES.length], mechanic: MECHANICS[i % MECHANICS.length], slot: SLOTS[i % SLOTS.length],
          tags: [ideaWord(mulberry32(i + 1), 3), ideaWord(mulberry32(i + 100), 3), ideaWord(mulberry32(i + 200), 3)],
        });
        box.install(dir);
        box.must('history', ['add', '--project', `docs/d/${D}-${slug}`]);
        published.push({ i, D, tier: i % 7 === 0 ? 2 : 1, slug, title });
      }
    }
    const last = published.at(-1).D;
    assert.equal(last, addDays(D1, days - 1));
    box.at(last, '08:05');

    const dBefore = treeHash(box.p('docs', 'd'));
    const t0 = Date.now();
    const built = box.must('build-site', []);
    const buildMs = Date.now() - t0;
    assert.deepEqual(built.omitted, [], JSON.stringify(built.omitted));
    assert.deepEqual(built.warnings, []);
    assert.equal(built.projects, published.length);
    assert.ok(buildMs < 30_000, `build-site took ${buildMs} ms for ${published.length} projects`);
    assert.deepEqual(treeHash(box.p('docs', 'd')), dBefore, 'build-site never writes into docs/d');

    const archive = box.archive();
    assert.equal(archive.days.length, published.length);
    assert.equal(archive.stats.projects, published.length);
    assert.equal(archive.stats.days, days);
    assert.deepEqual(archive.stats.missingDates, [addDays(D1, gap)]);
    assert.equal(archive.stats.firstDate, D1);
    assert.equal(archive.stats.lastDate, last);
    assert.equal(archive.stats.streak, days - gap - 1, 'the streak counts back from the last day to the gap');
    assert.deepEqual(archive.days.map((d) => d.date), published.map((p) => p.D).reverse(), 'newest first');
    assert.deepEqual(archive.days.map((d) => d.n), published.map((p) => p.i + 1).reverse());
    const history = box.history();
    assert.equal(history.entries.length, published.length);
    const cats = {};
    for (const e of history.entries) cats[e.fingerprint.category] = (cats[e.fingerprint.category] ?? 0) + 1;
    assert.deepEqual(archive.stats.categories, cats, 'category counts come straight from history');
    assert.deepEqual(archive.stats.tiers, { 1: published.filter((p) => p.tier === 1).length, 2: published.filter((p) => p.tier === 2).length, 3: 1, 4: published.filter((p) => p.tier === 4).length });
    for (const d of archive.days) {
      assert.ok(fs.existsSync(box.p('docs', d.path, 'index.html')), d.path);
      assert.equal(d.thumb, `${d.path}thumb.png`);
      assert.match(d.palette[0], /^#[0-9a-f]{6}$/i);
    }
    assert.equal(archive.days.find((d) => d.date === addDays(D1, 5)).title, 'Salt & Pepper <Mill>');

    // the feed lists the newest 30 with absolute URLs, the sitemap everything, both are well-formed XML
    const feed = box.read('docs/feed.xml');
    assertWellFormedXml(feed, 'feed.xml');
    assertWellFormedXml(box.read('docs/sitemap.xml'), 'sitemap.xml');
    const entries = [...feed.matchAll(/<entry>[\s\S]*?<\/entry>/g)].map((m) => m[0]);
    assert.equal(entries.length, 30);
    const feedLinks = entries.map((e) => /<link[^>]*href="([^"]+)"/.exec(e)[1]);
    assert.deepEqual(feedLinks, archive.days.slice(0, 30).map((d) => `${SITE_URL}${d.path}`));
    assert.ok(feed.includes('Salt &amp; Pepper &lt;Mill&gt;'), 'titles are XML-escaped in the feed');
    assert.ok(!feed.includes(`${D1}-`), 'the oldest day has fallen out of the 30-entry feed');
    const sitemap = box.read('docs/sitemap.xml');
    assert.equal([...sitemap.matchAll(/<loc>/g)].length, published.length + 1);
    assert.match(box.read('docs/robots.txt'), /Sitemap: .*sitemap\.xml/i);
    assert.ok(box.exists('docs/.nojekyll'));
    assert.ok(box.exists('docs/404.html'));

    // the page embeds exactly the archive that build-site wrote
    const html = box.read('docs/index.html');
    const inline = /<script type="application\/json" id="archive">([\s\S]*?)<\/script>/.exec(html);
    assert.ok(inline, 'inline archive JSON present');
    assert.deepEqual(JSON.parse(inline[1]), archive);
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(html), 'no placeholder left in index.html');
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(box.read('docs/404.html')));
    for (const p of published.slice(-5)) assert.ok(html.includes(`d/${p.D}-${p.slug}/`), `noscript list links ${p.slug}`);

    // a second build changes nothing, byte for byte
    const hashes = treeHash(box.p('docs'));
    const again = box.must('build-site', []);
    assert.deepEqual(again.changed, []);
    assert.deepEqual(treeHash(box.p('docs')), hashes);

    // the whole repo validates, and a fresh checkout of the pushed result does too
    const t1 = Date.now();
    assert.equal(box.must('validate', ['repo']).ok, true);
    const validateMs = Date.now() - t1;
    assert.ok(validateMs < 60_000, `validate repo took ${validateMs} ms`);
    box.sync('thirty days');
    const fresh = w.box('fresh');
    assert.equal(fresh.archive().stats.projects, published.length);
    process.stderr.write(`[e2e] (k) ${published.length} projects: build-site ${buildMs} ms, validate repo ${validateMs} ms\n`);

    if (KEEP_SITE) fs.cpSync(box.p('docs'), KEEP_SITE, { recursive: true });
    BUILT_SITE = { docs: box.p('docs'), published, last };
  });


  test('(l) the built site in a real browser: gallery in four themes, project and fallback pages, no errors, no off-origin requests', async (t) => {
    if (!BUILT_SITE) return t.skip('scenario (k) did not build a site');
    const pw = await loadPlaywright();
    if (!pw) return t.skip('playwright is not installed');
    process.env.PLAYWRIGHT_BROWSERS_PATH ||= '/opt/pw-browsers';
    let browser;
    try {
      browser = await pw.chromium.launch();
    } catch (err) {
      return t.skip(`chromium unavailable: ${String(err.message).split('\n')[0]}`);
    }
    const shots = DEFAULT_SHOTS ?? tmpDir('sed-e2e-shots-');
    if (!DEFAULT_SHOTS) TO_CLEAN.push(shots);
    fs.mkdirSync(shots, { recursive: true });
    const srv = await startServer(BUILT_SITE.docs);
    try {
      const { published } = BUILT_SITE;
      const first = (tier) => published.find((p) => p.tier === tier);
      const problems = [];
      const open = async (viewport, colorScheme, url, { javaScriptEnabled = true } = {}) => {
        const ctx = await browser.newContext({ viewport, colorScheme, javaScriptEnabled });
        const page = await ctx.newPage();
        page.on('console', (m) => ['error', 'warning'].includes(m.type()) && problems.push(`console ${m.type()} at ${url}: ${m.text()}`));
        page.on('pageerror', (e) => problems.push(`pageerror at ${url}: ${e.message}`));
        page.on('requestfailed', (r) => problems.push(`request failed at ${url}: ${r.url()}`));
        page.on('request', (r) => {
          const u = r.url();
          if (!u.startsWith(srv.url) && !u.startsWith('data:') && !u.startsWith('blob:')) problems.push(`off-origin request at ${url}: ${u}`);
        });
        const res = await page.goto(srv.url + url, { waitUntil: 'load' });
        assert.equal(res.status(), 200, url);
        return { ctx, page };
      };

      for (const [name, viewport] of [['desktop', { width: 1280, height: 800 }], ['mobile', { width: 390, height: 844 }]]) {
        for (const scheme of ['light', 'dark']) {
          const { ctx, page } = await open(viewport, scheme, '');
          await page.waitForSelector('#grid .card');
          const cards = await page.locator('#grid .card').count();
          assert.ok(cards >= 8, `${name}/${scheme}: ${cards} cards`);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${name}/${scheme}: horizontal overflow`);
          assert.equal(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches), scheme === 'dark');
          assert.match(await page.title(), /Sonnet Every Day/);
          await page.screenshot({ path: path.join(shots, `gallery-${name}-${scheme}.png`), fullPage: false });
          // thumbnails are lazy: scroll through the page, then every card image must have loaded from the right path
          const height = await page.evaluate(() => document.documentElement.scrollHeight);
          for (let y = 0; y < height; y += 600) {
            await page.evaluate((top) => window.scrollTo(0, top), y);
            await page.waitForTimeout(60);
          }
          await page.waitForFunction(() => [...document.querySelectorAll('#grid .card img')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 15_000 });
          await page.evaluate(() => window.scrollTo(0, 0));
          if (name === 'desktop' && scheme === 'light') await page.screenshot({ path: path.join(shots, 'gallery-desktop-light-full.png'), fullPage: true });
          await ctx.close();
        }
      }

      // 320 px wide: still no horizontal scroll
      {
        const { ctx, page } = await open({ width: 320, height: 640 }, 'light', '');
        await page.waitForSelector('#grid .card');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, '320px overflow');
        await ctx.close();
      }

      // without JavaScript the server-rendered list still links the projects
      {
        const { ctx, page } = await open({ width: 800, height: 700 }, 'light', '', { javaScriptEnabled: false });
        const links = await page.$$eval('noscript a, a', (as) => as.map((a) => a.getAttribute('href')).filter((h) => /^d\//.test(h ?? '')));
        assert.ok(links.length >= 8, `noscript list has ${links.length} project links`);
        await ctx.close();
      }

      // follow a card to its project and back via the gallery link every project carries
      {
        const { ctx, page } = await open({ width: 1280, height: 800 }, 'light', '');
        await page.waitForSelector('#grid .card .card-link');
        const href = await page.locator('#grid .card .card-link').first().getAttribute('href');
        await page.goto(srv.url + href, { waitUntil: 'load' });
        await page.waitForSelector('a.sed-back');
        await page.click('a.sed-back');
        await page.waitForSelector('#grid .card');
        assert.equal(new URL(page.url()).pathname, '/');
        await ctx.close();
      }

      // the three kinds of project page
      const pages = [
        ['fixture', first(1)],
        ['ideas-day', first(3)],
        ['postcard', first(4)],
      ];
      for (const [kind, p] of pages) {
        assert.ok(p, `no ${kind} day in the built site`);
        for (const [name, viewport, scheme] of [['desktop-light', { width: 1280, height: 800 }, 'light'], ['mobile-dark', { width: 390, height: 844 }, 'dark']]) {
          const { ctx, page } = await open(viewport, scheme, `d/${p.D}-${p.slug}/`);
          await page.waitForTimeout(kind === 'postcard' ? 1200 : 400);
          assert.equal(await page.locator('a[href="../../"]').count() > 0, true, `${kind}: back link`);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${kind}/${name}: horizontal overflow`);
          await page.screenshot({ path: path.join(shots, `page-${kind}-${name}.png`) });
          await ctx.close();
        }
      }

      // the 404 page
      {
        // 404.html carries <base href=siteUrl> because GitHub Pages serves it at any depth: answer the real host from the local copy
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        await ctx.route(`${SITE_URL}**`, async (route) => route.fulfill({ response: await ctx.request.get(route.request().url().replace(SITE_URL, srv.url)) }));
        const page = await ctx.newPage();
        page.on('pageerror', (e) => problems.push(`pageerror at 404: ${e.message}`));
        page.on('requestfailed', (r) => problems.push(`request failed at 404: ${r.url()}`));
        await page.goto(`${srv.url}404.html`, { waitUntil: 'load' });
        await page.waitForTimeout(300);
        assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).fontFamily), 'Times New Roman', 'the 404 page is styled by the gallery stylesheet');
        assert.equal(await page.locator('a[href]').count() > 0, true);
        await page.screenshot({ path: path.join(shots, 'page-404.png') });
        await ctx.close();
      }
      assert.deepEqual(problems, []);
    } finally {
      await srv.close();
      await browser.close();
    }
  });


  test('(m) every `node scripts/...` command in the docs and workflows names a real script, subcommand and flag', () => {
    const rows = docCommands();
    assert.ok(rows.length > 90, `only ${rows.length} commands found: the extractor is broken`);
    const table = stateFlagTable();
    assert.deepEqual([...table.keys()].sort(), ['ack-directive', 'beat', 'begin', 'choose', 'directive', 'event', 'fail', 'finish', 'phase-done', 'phase-start', 'spend', 'status', 'sync', 'throttle', 'today']);
    const problems = [];
    for (const row of rows) for (const p of lintCommand(row, table)) problems.push(`${row.file}:${row.line}: ${p} :: node ${row.script}${row.rest.trimEnd().slice(0, 80)}`);
    assert.deepEqual(problems, []);
    // the commands the playbook leans on most are all there
    const used = new Set(rows.filter((r) => r.file === 'ops/PLAYBOOK.md').map((r) => r.script.replace(/^scripts\//, '')));
    for (const must of ['state.mjs', 'validate.mjs', 'history.mjs', 'build-site.mjs', 'fallback.mjs', 'deadman.mjs', 'verify-live.mjs', 'heartbeat.mjs', 'lenses.mjs', 'novelty.mjs', 'qa/browser-check.mjs']) assert.ok(used.has(must), `PLAYBOOK never calls ${must}`);
    // the linter itself can fail: a typo is caught
    const state = lintCommand({ script: 'scripts/state.mjs', rest: ' phase-start --phasee P' }, table);
    assert.match(state[0], /does not take --phasee/);
    assert.match(lintCommand({ script: 'scripts/history.mjs', rest: ' adds --project x' }, table)[0], /no subcommand/);
    assert.match(lintCommand({ script: 'scripts/nope.mjs', rest: '' }, table)[0], /does not exist/);
  });

  test('(m2) the fields the playbook tells operators to read are really in the output', () => {
    const w = new World();
    const box = w.box('primary');
    const D = D1;
    const S = 'session-doc';
    const has = (obj, keys, label) => {
      for (const k of keys) assert.ok(k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), obj) !== undefined, `${label}: documented field "${k}" is missing from ${JSON.stringify(Object.keys(obj))}`);
    };
    box.at(D, '03:55');
    has(box.mustState(['today', '--date', D]), ['date', 'time', 'minutes', 'minutesToDeadline', 'targetTierIfStartedNow', 'dayNumber'], 'today');
    const begin = box.begin('primary', S, D);
    has(begin, ['ok', 'action', 'role', 'targetTier', 'resumePhase', 'reason', 'wrote', 'directiveAdded', 'run', 'lease', 'recovered', 'cleaned', 'levelConfig', 'throttle', 'levelConfig.outputTokens', 'levelConfig.reviseLoops'], 'begin');
    has(box.phaseStart('preflight', S, D), ['attempt', 'maxAttempts', 'overLimit', 'targetTier', 'directives'], 'phase-start');
    has(box.mustState(['beat', '--role', 'primary', '--session', S, '--phase', 'preflight', '--date', D]), ['leaseHeld', 'directives', 'targetTier', 'status', 'spend', 'spend.overCap'], 'beat');
    const sp = box.mustState(['spend', '--tokens', '1000', '--calls', '2', '--phase', 'preflight', '--session', S, '--date', D]);
    has(sp, ['spend.remainingTokens', 'overCap', 'spend.capTokens'], 'spend');
    assert.equal(sp.spend.capTokens, CONFIG.budget.levels.balanced.outputTokens - CONFIG.budget.reserveForPublishTokens, 'cap = level outputTokens - reserveForPublishTokens (PLAYBOOK 6.5)');
    has(box.mustState(['directive', '--kind', 'scope-cut', '--tier', '2', '--by', 'primary', '--date', D]), ['added', 'targetTier'], 'directive');
    // the event kinds the playbook names are all accepted, anything else is a usage error
    for (const kind of ['note', 'error', 'takeover', 'degrade', 'rate-limit', 'budget']) has(box.mustState(['event', '--kind', kind, '--msg', `doc check ${kind}`, '--by', 'primary', '--date', D]), ['events'], `event ${kind}`);
    assert.equal(box.state(['event', '--kind', 'bogus', '--msg', 'x', '--by', 'primary', '--date', D]).code, 2);
    has(box.mustState(['ack-directive', '--kind', 'scope-cut', '--date', D]), ['acked', 'pending'], 'ack-directive');
    has(box.phaseDone('preflight', { session: S, role: 'primary', date: D }), ['phase', 'alreadyDone', 'next', 'phasesDone', 'targetTier'], 'phase-done');
    const status = box.mustState(['status', '--date', D]);
    has(status, ['status', 'phase', 'phaseMinutes', 'targetTier', 'minutesToDeadline', 'lease.alive', 'directives', 'spend', 'nextAction', 'throttle', 'levelConfig'], 'status');
    box.write(`state/ideas/${D}.json`, makeIdeasDoc(D));
    has(box.mustState(['choose', '--idea-id', 'i04', '--slug', 'Quartz Orchard!', '--title', 'Quartz Orchard', '--session', S, '--date', D]), ['chosen', 'slugNormalized', 'chosen.slug'], 'choose');
    has(box.mustState(['throttle', 'get']), ['level', 'levelConfig'], 'throttle get');
    has(box.sync('doc check'), ['ok', 'pushed', 'sha'], 'sync');
    const hb = box.must('heartbeat', ['--role', 'primary', '--session', S, '--phase', 'ideate', '--wait', '0', '--date', D], { env: { SED_HB_DIR: path.join(w.base, 'hb') } });
    has(hb, ['ok', 'pushed', 'at'], 'heartbeat');
    has(box.must('lenses', ['--date', D]), ['ok', 'agents'], 'lenses');
    has(box.must('novelty', ['mix', '--date', D]), ['ok', 'owed', 'categoryCounts', 'politicsAllowed', 'summary'], 'novelty mix');
    const digest = box.cli('history', ['digest', '--limit', '90', '--text', '--date', D]);
    assert.equal(digest.code, 0);
    assert.throws(() => JSON.parse(digest.stdout), '--text prints plain lines, not JSON');
    assert.equal(digest.stdout.trim(), '(no past projects yet)');

    // a published fallback gives the fields of the publish sequence
    box.at(D, '07:41');
    const fb = box.must('fallback', ['postcard', '--date', D]);
    has(fb, ['ok', 'tier', 'slug', 'path', 'files', 'validated', 'warnings', 'history'], 'fallback postcard');
    has(box.must('validate', ['project', `docs/d/${D}-postcard`, '--tier', '4']), ['ok', 'errors', 'warnings', 'stats.files', 'stats.bytes', 'stats.ownLoc'], 'validate project');
    has(box.must('build-site', []), ['ok', 'projects', 'omitted', 'warnings'], 'build-site');
    const fin = box.finish(4, 'postcard', { by: 'primary', date: D }).json;
    has(fin, ['ok', 'action', 'tier', 'publishedUrl', 'removedDirs'], 'finish');
    has(box.mustState(['status', '--date', D]), ['status', 'tier', 'publishedUrl'], 'status after finish');
    const dm = box.must('deadman', ['--date', D, '--no-sleep']);
    has(dm, ['ok', 'action'], 'deadman');
  });


  test('(n) OPERATING.md: remove a bad day, reset it and rebuild it by hand', () => {
    const w = new World();
    const box = w.box('owner');
    const [D1a, D2a] = [D1, addDays(D1, 1)];
    // two published days through the real flow
    box.at(D1a, '03:55');
    box.begin('primary', 's1', D1a);
    runBuiltDay(box, { date: D1a, slug: 'ember-engine', title: 'Ember Engine', role: 'primary', session: 's1' });
    box.at(D2a, '03:55');
    box.begin('primary', 's2', D2a);
    runBuiltDay(box, { date: D2a, slug: 'cinder-fable', title: 'Cinder Fable', role: 'primary', session: 's2' });
    assert.equal(box.archive().stats.projects, 2);

    // the recipe, verbatim
    box.at(D2a, '12:00');
    box.must('history', ['remove', '--date', D1a]);
    fs.rmSync(box.p('docs', 'd', `${D1a}-ember-engine`), { recursive: true, force: true });
    assert.deepEqual(box.must('build-site', []).omitted, []);
    assert.equal(box.must('validate', ['repo']).ok, true);
    box.sync(`remove bad day ${D1a}`);
    const archive = w.remoteJson('docs/archive.json');
    assert.deepEqual(archive.days.map((d) => d.date), [D2a]);
    assert.deepEqual(archive.stats.missingDates, [D1a], 'the gallery lists the removed date as a missing day');
    assert.equal(archive.days[0].n, 2, 'day numbers come from the calendar, not from list position');

    // a published run is never touched by a new run: the run file has to go
    assert.equal(box.state(['begin', '--role', 'manual', '--session', 'owner', '--date', D1a, '--target-tier', '1']).json.action, 'exit-published');
    fs.rmSync(box.p('state', 'runs', `${D1a}.json`), { force: true });
    fs.rmSync(box.p('state', 'ideas', `${D1a}.json`), { force: true });
    fs.rmSync(box.p('work', D1a), { recursive: true, force: true });
    box.sync(`reset ${D1a} for a rerun`);
    assert.equal(w.remoteHasFile(`state/runs/${D1a}.json`), false);
    assert.equal(w.remoteHasFile(`work/${D1a}/build/site/index.html`), false);
    const rerun = box.begin('manual', 'owner', D1a, ['--target-tier', '1']);
    assert.equal(rerun.action, 'proceed');
    assert.equal(rerun.targetTier, 1, 'a manual run ignores the clock');
    assert.equal(rerun.run.lease.holder, 'manual');
    // the removed day is free to be built again, with the same slug even
    const mix = box.must('novelty', ['mix', '--date', D1a]);
    assert.equal(mix.ok, true);
    runBuiltDay(box, { date: D1a, slug: 'ember-engine', title: 'Ember Engine', role: 'manual', session: 'owner', clockDate: addDays(D2a, 1) });
    assert.equal(w.remoteJson('state/history.json').entries.map((e) => e.date).join(), `${D1a},${D2a}`);
    assert.equal(w.remoteJson('docs/archive.json').stats.missingDates.length, 0);
  });

  test('(n2) OPERATING.md: throttle by hand, and manual runs respect published days and live sessions', () => {
    const w = new World();
    const box = w.box('owner');
    const D = D1;
    box.at(D, '12:00');
    const set = box.mustState(['throttle', 'set', '--level', 'lean', '--reason', 'saving usage this week']);
    assert.equal(set.to ?? set.level, 'lean', JSON.stringify(set));
    box.sync('throttle: lean');
    assert.equal(w.remoteJson('state/throttle.json').level, 'lean');
    const lean = box.at(D, '03:55').begin('primary', 'p', D);
    assert.equal(lean.targetTier, 1);
    assert.equal(lean.levelConfig.reviseLoops, 0);
    assert.equal(lean.levelConfig.outputTokens, 1_500_000);
    assert.equal(lean.run.throttle, 'lean');

    // minimal forces a compact build even at 03:55, and tells a running primary through a scope-cut directive
    box.mustState(['throttle', 'set', '--level', 'minimal', '--reason', 'out of room']);
    const run = box.run(D);
    assert.equal(run.throttle, 'minimal');
    assert.ok(run.directives.some((d) => d.kind === 'scope-cut' && d.tier === 2), JSON.stringify(run.directives));
    assert.equal(box.mustState(['beat', '--role', 'primary', '--session', 'p', '--phase', 'preflight', '--date', D]).targetTier, 2);
    const w2 = new World();
    const b2 = w2.box('owner');
    b2.at(D, '12:00');
    b2.mustState(['throttle', 'set', '--level', 'minimal', '--reason', 'out of room']);
    assert.equal(b2.at(D, '03:55').begin('primary', 'p', D).targetTier, 2, 'minimal.forceTier is a floor on a new run');

    // manual runs: exit-alive against a live session, --force takes it over, a published day is never touched
    const m = box.at(D, '04:10').state(['begin', '--role', 'manual', '--session', 'owner', '--date', D, '--target-tier', '1']);
    assert.equal(m.json.action, 'exit-alive');
    const forced = box.state(['begin', '--role', 'manual', '--session', 'owner', '--date', D, '--target-tier', '1', '--force']);
    assert.equal(forced.json.action, 'takeover');
    assert.equal(forced.json.run.lease.holder, 'manual');
    assert.equal(box.state(['begin', '--role', 'primary', '--session', 'p', '--date', D, '--target-tier', '1']).code, 2, '--target-tier is for manual runs only');
    box.mustState(['throttle', 'down', '--reason', 'rate-limit: 429 from the API']);
    assert.equal(box.json('state/throttle.json').level, 'minimal', 'down never goes below the floor');
    box.mustState(['throttle', 'set', '--level', 'balanced', '--reason', 'back to normal']);
    assert.equal(box.mustState(['throttle', 'get']).level, 'balanced');
  });


  test('(m3) cross-references in the docs resolve: PLAYBOOK and CONTRACT sections, FM ids, repo paths', () => {
    const headings = (file) => new Set([...readRepo(file).matchAll(/^(?:#{2,4} |\*\*)(\d+(?:\.\d+)?[a-z]?)[. ]/gm)].map((m) => m[1]));
    const sections = { PLAYBOOK: headings('ops/PLAYBOOK.md'), CONTRACT: headings('ops/CONTRACT.md') };
    const docs = [...DOC_FILES, 'ops/CONTRACT.md'];
    const fm = new Set([...readRepo('ops/FAILURE_MODES.md').matchAll(/^\| (FM-\d+) \|/gm)].map((m) => m[1]));
    assert.ok(fm.size >= 70 && sections.PLAYBOOK.size > 40 && sections.CONTRACT.size > 20, 'the extractors found nothing');
    const problems = [];
    for (const file of docs) {
      readRepo(file).split('\n').forEach((line, i) => {
        const at = `${file}:${i + 1}`;
        for (const m of line.matchAll(/(PLAYBOOK|CONTRACT)(?:\.md)?\)?[^§\n]{0,30}?§\s?(\d+(?:\.\d+)?[a-z]?)/g)) if (!sections[m[1]].has(m[2])) problems.push(`${at}: ${m[1]} §${m[2]} does not exist`);
        if (file === 'ops/PLAYBOOK.md' && !/CONTRACT/.test(line)) for (const m of line.matchAll(/§(\d+(?:\.\d+)?[a-z]?)/g)) if (!sections.PLAYBOOK.has(m[1])) problems.push(`${at}: §${m[1]} does not exist`);
        for (const m of line.matchAll(/\bFM-(\d+)(?:\s*(?:to|-|–)\s*(?:FM-)?(\d+))?/g)) for (const n of [m[1], m[2]].filter(Boolean)) if (!fm.has(`FM-${n}`)) problems.push(`${at}: FM-${n} does not exist`);
        for (const m of line.matchAll(/`((?:ops|scripts|site-src|tests|\.github)\/[^`\s]*)`/g)) {
          const rel = m[1].replace(/[.,;:)]+$/, '').replace(/\/$/, '');
          if (/[<*{]|\.\.\./.test(rel)) continue;
          if (!fs.existsSync(path.join(REPO, rel))) problems.push(`${at}: path ${rel} does not exist`);
        }
      });
    }
    assert.deepEqual(problems, []);
    // the FM table is dense: ids are unique and consecutive, so inserting a row cannot silently shift the references
    const ids = [...readRepo('ops/FAILURE_MODES.md').matchAll(/^\| FM-(\d+) \|/gm)].map((m) => Number(m[1]));
    assert.deepEqual(ids, ids.map((_, i) => i + 1));
  });


  test('(o) CONTRACT 5: run, history, project, archive, ideas, carry-over and heartbeat files have the documented shapes on every tier', () => {
    const w = new World();
    const box = w.box('days');
    const [T1, T3, T4] = [D1, addDays(D1, 1), addDays(D1, 2)];
    box.at(T1, '03:55');
    box.begin('primary', 'session-1', T1);
    runBuiltDay(box, { date: T1, slug: 'ember-engine', title: 'Ember Engine', role: 'primary', session: 'session-1' });
    // tier 3 and tier 4 days through the safety net (with and without ideas)
    box.write(`state/ideas/${T3}.json`, makeIdeasDoc(T3));
    box.at(T3, '07:41');
    assert.equal(box.must('deadman', ['--date', T3, '--no-sleep']).tier, 3);
    box.at(T4, '05:20');
    const hb = box.must('heartbeat', ['--role', 'primary', '--session', 'session-4', '--phase', 'ideate', '--wait', '0', '--date', T4, '--note', 'shape check'], { env: { SED_HB_DIR: path.join(w.base, 'hb') } });
    assert.equal(hb.pushed, true);
    box.at(T4, '07:41');
    assert.equal(box.must('deadman', ['--date', T4, '--no-sleep']).tier, 4);
    box.git('pull', '--rebase', '--autostash', 'origin', BRANCH);

    const problems = [];
    for (const D of [T1, T3, T4]) problems.push(...runProblems(box.run(D)).map((x) => `${D} ${x}`));
    const history = box.history();
    problems.push(...historyProblems(history));
    assert.deepEqual(history.entries.map((e) => [e.date, e.tier]), [[T1, 1], [T3, 3], [T4, 4]]);
    for (const e of history.entries) problems.push(...projectProblems(box.p('docs', e.path), e));
    problems.push(...archiveProblems(box.archive(), history));
    assert.deepEqual(problems, []);

    // ideas documents (5.3) and the carry-over store (5.4)
    for (const D of [T1, T3]) {
      const doc = box.json(`state/ideas/${D}.json`);
      assert.equal(doc.schema, 1);
      assert.equal(doc.date, D);
      assert.equal(doc.ideas.length, 10);
      assert.ok(Array.isArray(doc.lenses) && doc.lenses.every((l) => l.agent && l.lensId && Array.isArray(l.provocation)));
      assert.ok(doc.ideas.some((i) => i.id === doc.chosenId));
      assert.ok(Array.isArray(doc.rejectedNotes) && typeof doc.rationale === 'string' && ISO.test(doc.selectedAt));
      for (const idea of doc.ideas) {
        assert.deepEqual(fingerprintProblems(idea.fingerprint, idea.id), []);
        assert.ok(typeof idea.durable === 'boolean' && isObj(idea.scores) && Object.keys(idea.scores).length === 8 && isObj(idea.noveltyCheck));
        assert.ok(Array.isArray(idea.research.sources) && Array.isArray(idea.research.facts) && isObj(idea.design));
      }
    }
    const carry = box.json('state/carryover.json');
    assert.deepEqual(Object.keys(carry).sort(), ['carriedCount', 'idea', 'savedOn', 'schema']);
    assert.ok(carry.idea === null || (carry.idea.durable === true && carry.carriedCount <= CONFIG.ideation.carryover.maxCarries));

    // the heartbeat file (6.1b) and the fallback notice (6.8)
    const beat = w.remoteJson(`state/heartbeats/${T4}/session-4.json`);
    assert.deepEqual(Object.keys(beat).sort(), ['at', 'holder', 'note', 'phase', 'session']);
    assert.deepEqual([beat.holder, beat.session, beat.phase, beat.note], ['primary', 'session-4', 'ideate', 'shape check']);
    assert.ok(ISO.test(beat.at));
    for (const D of [T3, T4]) assert.ok(isObj(box.json(`work/${D}/fallback-notice.json`)));
    assert.equal(box.json('state/throttle.json').level, 'balanced');
  });


  test('(b3) primary dies in build: wdB at 06:47 takes over and ships the Ideas Day with the chosen idea as the pick', () => {
    const w = new World();
    const D = D1;
    const prim = w.box('primary');
    prim.at(D, '03:55');
    prim.begin('primary', 'session-primary', D);
    prim.sync('begin');
    runBuiltDay(prim, { date: D, slug: 'quartz-orchard', title: 'Quartz Orchard', role: 'primary', session: 'session-primary', until: 'spec' });
    prim.at(D, '05:15');
    prim.phaseStart('build', 'session-primary', D);
    prim.write(`work/${D}/build/site/index.html`, '<!doctype html><title>half</title>');
    prim.sync('build started, then the container died');

    const B = w.box('wdB');
    B.at(D, '06:47');
    const take = B.begin('wdB', 'session-wdB', D);
    assert.equal(take.action, 'takeover');
    assert.equal(take.targetTier, 3);
    assert.equal(take.resumePhase, 'package', 'ideate is done, so the Ideas Day path starts at package');
    B.sync(`sed(${D}): wdB takeover`);
    B.at(D, '06:55');
    B.phaseStart('package', 'session-wdB', D);
    const day = B.must('fallback', ['ideas-day', '--date', D]);
    assert.equal(day.tier, 3);
    assert.equal(B.json(`docs/d/${D}-ideas-day/ideas.json`).chosenId, 'i04', 'the final ideas document (with the pick) is preferred over the shortlist');
    B.must('fallback', ['notice', '--date', D, '--reason', 'primary died in build']);
    B.must('build-site', []);
    assert.equal(B.must('validate', ['repo']).ok, true);
    assert.equal(B.snippet('A2', { D, TIER: '3' }).json.action, 'cleared', 'the intended winner i04 is not durable, so nothing is saved');
    B.phaseDone('package', { session: 'session-wdB', role: 'wdB', date: D, note: 'ideas day' });
    B.sync('package');
    B.phaseStart('publish', 'session-wdB', D);
    assert.equal(B.finish(3, 'ideas-day', { by: 'wdB', date: D }).json.action, 'published');
    B.sync('published');
    assert.equal(w.remoteJson(`state/runs/${D}.json`).tier, 3);
    assert.ok(w.remoteJson(`state/runs/${D}.json`).events.some((e) => e.kind === 'takeover' || /takeover/i.test(e.msg) || e.kind === 'degrade'));
  });

  test('(c4) wdB tells a slow live primary to ship now (no --tier): the primary sees it at its next beat and drops to the Ideas Day', () => {
    const w = new World();
    const D = D1;
    const S = 'session-primary';
    const prim = w.box('primary');
    prim.at(D, '03:55');
    prim.begin('primary', S, D);
    prim.sync('begin');
    runBuiltDay(prim, { date: D, slug: 'cinder-fable', title: 'Cinder Fable', role: 'primary', session: S, until: 'select' });
    prim.at(D, '06:40');
    prim.phaseStart('spec', S, D);
    prim.sync('spec started');

    const B = w.box('wdB');
    B.at(D, '06:47');
    const b = B.begin('wdB', 'session-wdB', D);
    assert.equal(b.action, 'exit-alive');
    const dir = B.mustState(['directive', '--kind', 'ship-now', '--by', 'wdB', '--date', D]);
    assert.equal(dir.tier, 3, 'ideate is done, so the script picks the Ideas Day');
    assert.equal(dir.targetTier, 3);
    B.sync(`sed(${D}): wdB ship-now directive`);

    prim.at(D, '06:50');
    prim.sync('pull the directive');
    const beat = prim.mustState(['beat', '--role', 'primary', '--session', S, '--phase', 'spec', '--date', D]);
    assert.equal(beat.targetTier, 3);
    assert.ok(beat.directives.some((d) => d.kind === 'ship-now' && d.tier === 3));
    prim.mustState(['ack-directive', '--kind', 'ship-now', '--date', D]);
    const done = prim.phaseDone('spec', { session: S, role: 'primary', date: D, note: 'stopped: ship-now' });
    assert.equal(done.next, 'package', 'a tier 3 target skips build, qa and revise');
    prim.phaseStart('package', S, D);
    assert.equal(prim.must('fallback', ['ideas-day', '--date', D]).tier, 3);
    prim.must('build-site', []);
    assert.equal(prim.must('validate', ['repo']).ok, true);
    prim.phaseDone('package', { session: S, role: 'primary', date: D, note: 'ideas day' });
    prim.phaseStart('publish', S, D);
    assert.equal(prim.finish(3, 'ideas-day', { by: 'primary', date: D }).json.action, 'published');
    prim.sync('published');
    assert.equal(w.remoteJson(`state/runs/${D}.json`).tier, 3);
  });

  test('(b4) a phase attempted twice reports overLimit, and a takeover after two failures degrades the tier', () => {
    const w = new World();
    const D = D1;
    const prim = w.box('primary');
    prim.at(D, '03:55');
    prim.begin('primary', 's1', D);
    prim.checkpoint('preflight', { session: 's1', role: 'primary', date: D });
    prim.at(D, '04:10');
    const first = prim.phaseStart('ideate', 's1', D);
    assert.deepEqual([first.attempt, first.maxAttempts, first.overLimit], [1, 2, false]);
    prim.at(D, '04:50');
    const second = prim.phaseStart('ideate', 's1', D);
    assert.deepEqual([second.attempt, second.overLimit], [2, false]);
    prim.at(D, '05:00');
    const third = prim.phaseStart('ideate', 's1', D);
    assert.deepEqual([third.attempt, third.overLimit], [3, true], 'two failures are enough');
    prim.sync('ideate attempted three times');

    const A = w.box('wdA');
    A.at(D, '05:45');
    const take = A.begin('wdA', 's-wdA', D);
    assert.equal(take.action, 'takeover');
    assert.ok(take.targetTier >= 3 || take.run.events.some((e) => e.kind === 'degrade'), `a phase that failed twice degrades: tier ${take.targetTier}, ${take.reason}`);
    assert.ok(take.run.events.some((e) => e.kind === 'degrade'), JSON.stringify(take.run.events));
  });

  test('(p) the work branch is missing on the remote: the first sync recreates it; heartbeat reports instead of throwing', () => {
    const w = new World();
    git(w.remote, 'update-ref', '-d', `refs/heads/${BRANCH}`);
    assert.equal(gitTry(w.remote, 'rev-parse', '--verify', '-q', `refs/heads/${BRANCH}`).ok, false);
    const dir = path.join(w.base, 'on-main');
    execFileSync('git', ['clone', '-q', '--branch', 'main', w.remote, dir], { stdio: 'ignore' });
    const box = new Box(w, 'on-main', dir);
    box.at(D1, '03:55');
    const hb = box.cli('heartbeat', ['--role', 'primary', '--session', 's', '--phase', 'preflight', '--wait', '0', '--date', D1], { env: { SED_HB_DIR: path.join(w.base, 'hb') } });
    assert.equal(hb.code, 1, 'no branch to beat on: ok:false, exit 1, no exception');
    assert.equal(hb.json.ok, false);
    assert.match(hb.json.reason, /does not exist/);
    box.begin('primary', 's', D1);
    const out = box.sync('first sync creates the branch');
    assert.equal(out.pushed, true, JSON.stringify(out));
    assert.equal(gitTry(w.remote, 'rev-parse', '--verify', '-q', `refs/heads/${BRANCH}`).ok, true);
    assert.equal(box.git('rev-parse', '--abbrev-ref', 'HEAD'), BRANCH);
    assert.equal(w.remoteJson(`state/runs/${D1}.json`).lease.session, 's');
    // main itself was not touched
    assert.equal(w.remoteLog().includes('first sync creates the branch'), true);
    assert.equal(git(w.remote, 'log', '-1', '--format=%s', 'refs/heads/main'), 'seed: repo copy for e2e');
  });

  test('(q) spend cap, throttle steps and clean days: overCap at the level cap, down on a signal, up after five clean days', () => {
    const w = new World();
    const box = w.box('ops');
    const D = D1;
    box.at(D, '03:55');
    box.begin('primary', 's', D);
    const cap = CONFIG.budget.levels.balanced.outputTokens - CONFIG.budget.reserveForPublishTokens;
    assert.equal(box.mustState(['spend', '--tokens', String(cap - 1), '--calls', '40', '--phase', 'build', '--session', 's', '--date', D]).overCap, false);
    const over = box.mustState(['spend', '--tokens', '2', '--calls', '1', '--phase', 'qa', '--session', 's', '--date', D]);
    assert.equal(over.overCap, true);
    assert.equal(box.mustState(['beat', '--role', 'primary', '--session', 's', '--date', D]).spend.overCap, true);
    assert.equal(box.run(D).spend.byPhase.build.agentCalls, 40);

    // a rate-limit signal steps down one notch and is mirrored on the run with an event of the right kind
    const down = box.mustState(['throttle', 'down', '--reason', 'rate-limit: 429 from the API']);
    assert.deepEqual([down.from, down.to, down.changed], ['balanced', 'lean', true]);
    assert.equal(box.run(D).throttle, 'lean');
    assert.ok(box.run(D).events.some((e) => e.kind === 'rate-limit'));
    assert.equal(box.mustState(['throttle', 'get']).levelConfig.reviseLoops, 0);
    // one notch per run date: a second signal the same day is held unless the operator forces it
    const held = box.mustState(['throttle', 'down', '--reason', 'rate-limit: 429 again']);
    assert.deepEqual([held.to, held.changed], ['lean', false]);
    const budgetDown = box.mustState(['throttle', 'down', '--force', '--reason', 'budget-exhausted: stop']);
    assert.equal(budgetDown.to, 'minimal');
    assert.ok(box.run(D).events.some((e) => e.kind === 'budget'));
    assert.equal(box.mustState(['throttle', 'down', '--force', '--reason', 'usage-limit again']).changed, false);

    // five clean days raise one notch, never above the ceiling
    box.mustState(['throttle', 'set', '--level', 'lean', '--reason', 'owner']);
    const levels = [];
    for (let i = 0; i < 6; i++) {
      const r = box.mustState(['throttle', 'day-clean', '--date', addDays(D, i)]);
      levels.push(r.level);
    }
    assert.deepEqual(levels, ['lean', 'lean', 'lean', 'lean', 'balanced', 'balanced']);
    // the same day twice counts once
    const cd = box.mustState(['throttle', 'get']).cleanDays;
    box.mustState(['throttle', 'day-clean', '--date', addDays(D, 5)]);
    assert.equal(box.mustState(['throttle', 'get']).cleanDays, cd);
    assert.ok(JSON.parse(box.read('state/throttle.json')).log.length >= 6, 'every change is logged');
  });

  test('(s) when nothing worked the closer fails the run; a later manual run takes over, and a failed run can still be finished', () => {
    const w = new World();
    const D = D1;
    const C = w.box('closer');
    C.at(D, '07:27');
    C.begin('closer', 'session-closer', D);
    const f = C.mustState(['fail', '--reason', 'generators and deadman all failed', '--by', 'closer', '--date', D]);
    assert.equal(f.ok, true);
    assert.equal(C.run(D).status, 'failed');
    C.sync('fail');
    const M = w.box('manual');
    M.at(D, '09:00');
    const take = M.begin('manual', 'owner', D, ['--target-tier', '4']);
    assert.equal(take.action, 'takeover', take.reason);
    assert.equal(take.run.status, 'in_progress');
    const dm = M.must('deadman', ['--force', '--date', D, '--no-sleep']);
    assert.equal(dm.action, 'published');
    assert.equal(M.run(D).status, 'published');
    // failing a published day is refused
    assert.equal(M.state(['fail', '--reason', 'late', '--by', 'x', '--date', D]).code, 1);
    assert.equal(M.run(D).status, 'published');
  });

  test('(q2) browser-check as the playbook calls it: thumbnail meets the cap and validates, and its output never reaches git', async (t) => {
    const w = new World();
    const box = w.box('qa');
    const D = D1;
    box.at(D, '06:30');
    const { projectJson } = buildSiteDir(box, D, 'ember-engine', { title: 'Ember Engine', tier: 1 });
    box.write(`work/${D}/package/project.json`, projectJson);
    const stage = `work/${D}/tmp/pkg/${D}-ember-engine`;
    fs.mkdirSync(box.p(stage), { recursive: true });
    fs.cpSync(box.p('work', D, 'build', 'site'), box.p(stage), { recursive: true });
    fs.copyFileSync(box.p('work', D, 'package', 'project.json'), box.p(stage, 'project.json'));
    const r = await box.cliAsync('qa/browser-check', [stage, '--out', `work/${D}/tmp/qa-pkg`, '--thumb', '--seconds', '6']);
    if (r.json?.error === 'no-browser') return t.skip('no browser here');
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.json.ok, true, r.stdout);
    assert.deepEqual(r.json.errors, []);
    assert.ok(box.exists(`${stage}/thumb.png`));
    const thumb = fs.readFileSync(box.p(stage, 'thumb.png'));
    assert.deepEqual(pngSize(thumb), { width: 1200, height: 630 });
    assert.ok(thumb.length <= CONFIG.limits.thumbMaxBytes);
    assert.equal(box.must('validate', ['project', stage, '--tier', '1']).ok, true);
    assert.ok(box.exists(`work/${D}/tmp/qa-pkg/report.json`));
    assert.ok(r.json.shots.length >= 4, 'desktop and mobile, light and dark');

    // the generated fallback pages pass the same QA gate
    box.write(`state/ideas/${D}.json`, makeIdeasDoc(D));
    box.must('fallback', ['ideas-day', '--date', D]);
    box.must('fallback', ['postcard', '--date', addDays(D, 1)]);
    for (const dir of [`docs/d/${D}-ideas-day`, `docs/d/${addDays(D, 1)}-postcard`]) {
      const q = await box.cliAsync('qa/browser-check', [dir, '--out', `work/${D}/tmp/qa-${path.basename(dir)}`, '--seconds', '5', '--no-monkey']);
      assert.equal(q.json.ok, true, `${dir}: ${q.stdout.slice(0, 1500)}`);
    }

    // screenshots, reports and the staging copy are ignored by git; the package inputs are not
    box.sync('qa outputs');
    assert.deepEqual(w.remoteTree(`work/${D}/tmp`), []);
    assert.ok(w.remoteHasFile(`work/${D}/package/project.json`));
    assert.ok(w.remoteHasFile(`docs/d/${D}-ideas-day/index.html`));
    assert.equal(box.git('status', '--porcelain', '--ignored', '--', `work/${D}/tmp`).startsWith('!!'), true, 'the tmp dir is ignored, not untracked');
  });


  test('(b5) the primary pushed its package and died before finish: the closer records the published tier instead of replacing it', () => {
    const w = new World();
    const D = D1;
    const S = 'session-primary';
    const prim = w.box('primary');
    prim.at(D, '03:55');
    prim.begin('primary', S, D);
    prim.sync('begin');
    runBuiltDay(prim, { date: D, slug: 'ember-engine', title: 'Ember Engine', role: 'primary', session: S, until: 'package', times: { package: '07:05' } });
    assert.equal(w.remoteJson('state/history.json').entries[0].tier, 1, 'the package reached the remote');
    assert.equal(w.remoteJson(`state/runs/${D}.json`).status, 'in_progress');

    const C = w.box('closer');
    C.at(D, '07:27');
    const begin = C.begin('closer', 'session-closer', D);
    assert.equal(begin.action, 'force-degrade');
    const dm = C.must('deadman', ['--force', '--date', D, '--no-sleep']);
    assert.equal(dm.action, 'none', 'a better tier is already in history: never replaced');
    assert.equal(dm.tier, 1);
    // ...and the run now says so too, so status, exit-published and day reports agree with the site
    const run = C.run(D);
    assert.equal(run.status, 'published', 'the run file must not stay in_progress next to a live page');
    assert.equal(run.tier, 1);
    assert.equal(run.publishedUrl, `${SITE_URL}d/${D}-ember-engine/`);
    assert.deepEqual(dm.recordedRun, { ok: true, action: 'published' });
    assert.equal(C.begin('closer', 'session-closer-2', D).action, 'exit-published');
    assert.equal(C.exists(`docs/d/${D}-postcard`), false);
    assert.equal(C.exists(`docs/d/${D}-ideas-day`), false);
    assert.equal(C.history().entries.length, 1);
    assert.equal(C.dirty() === '' || C.dirty().includes('state/runs'), true);
  });


  test('(m4) the playbook\'s planner (A4) and ideas-check (A1) behave as documented, including on bad input', () => {
    const w = new World();
    const box = w.box('tools');
    const D = D1;
    const planner = (MTD, TIER, PHASE, extra = {}) => {
      const r = box.snippet('A4', { MTD: String(MTD), TIER: String(TIER), PHASE, ...extra });
      assert.equal(r.code, 0, r.stdout + r.stderr);
      return r.json;
    };
    // the clock thresholds agree with the schedule: a full day fits at 03:55, no longer at 04:45; compact stops fitting by ~05:35
    assert.equal(planner(245, 1, 'preflight').feasible, true);
    assert.equal(planner(195, 1, 'preflight').feasible, false);
    assert.equal(planner(195, 1, 'preflight').suggestTier, 2);
    assert.equal(planner(135, 2, 'preflight').feasible, false);
    assert.equal(planner(135, 2, 'preflight').suggestTier, 3);
    assert.equal(planner(160, 2, 'ideate').feasible, true);
    // a fallback publish is never refused, however late
    for (const [tier, phase] of [[3, 'package'], [4, 'package'], [4, 'publish']]) {
      const r = planner(5, tier, phase);
      assert.deepEqual([r.feasible, r.suggestTier], [true, tier]);
    }
    // revise is optional: it only asks whether a loop fits
    assert.equal(planner(150, 1, 'revise', { REVISE: '1' }).feasible, true);
    assert.equal(planner(60, 1, 'revise', { REVISE: '1' }).feasible, false);
    assert.equal(box.snippet('A4', { MTD: 'x', TIER: '1', PHASE: 'build' }).code, 2);
    assert.equal(box.snippet('A4', { MTD: '100', TIER: '1', PHASE: 'nope' }).code, 2);

    // ideas-check: a good shortlist passes, each kind of damage is named
    const good = makeIdeasDoc(D, { final: false });
    const check = (doc, mode = 'shortlist', extra = {}) => {
      box.write(`work/${D}/ideas/doc.json`, doc);
      return box.snippet('A1', { FILE: `work/${D}/ideas/doc.json`, D, MODE: mode, ...extra });
    };
    const ok = check(good);
    assert.equal(ok.code, 0, ok.stdout);
    assert.deepEqual([ok.json.ok, ok.json.count, ok.json.noveltyClean, ok.json.withVerifiedSource], [true, 10, 10, 10]);
    const damage = {
      '9 ideas': (d) => d.ideas.pop(),
      'unknown category': (d) => { d.ideas[2].fingerprint.category = 'not-a-category'; },
      'unknown mechanic': (d) => { d.ideas[2].fingerprint.mechanic = 'telepathy'; },
      'bad tone': (d) => { d.ideas[2].fingerprint.tone = ['grumpy']; },
      'duplicate id': (d) => { d.ideas[3].id = d.ideas[2].id; },
      'score out of range': (d) => { d.ideas[4].scores.delight = 11; },
      'durable is not a boolean': (d) => { d.ideas[4].durable = 'yes'; },
      'no sources': (d) => { d.ideas[5].research.sources = []; },
    };
    for (const [label, mutate] of Object.entries(damage)) {
      const doc = JSON.parse(JSON.stringify(good));
      mutate(doc);
      const r = check(doc);
      assert.equal(r.code, 1, `${label}: ${r.stdout}`);
      assert.ok(r.json.problems.length >= 1, label);
    }
    const missing = box.snippet('A1', { FILE: `work/${D}/ideas/nope.json`, D, MODE: 'shortlist' });
    assert.equal(missing.code, 1);
    assert.match(missing.json.problems[0], /cannot read/);

    // final mode: the chosen idea must exist, must not conflict with history, the carry-over must be durable, the slug must be new
    const final = makeIdeasDoc(D);
    assert.equal(check(final, 'final').code, 0);
    assert.match(check({ ...final, chosenId: 'i99' }, 'final').json.problems.join(), /chosenId/);
    assert.match(check({ ...final, carryoverOutId: 'i02' }, 'final').json.problems.join(), /non-durable/);
    assert.match(check({ ...final, carryoverOutId: final.chosenId }, 'final').json.problems.join(), /equals chosenId/);
    assert.match(check({ ...final, rationale: ' ' }, 'final').json.problems.join(), /rationale/);
    // history: today's chosen category repeated the next day trips the novelty gate, and a used slug is refused
    box.install(makeProject(tmpDir('sed-e2e-pj-'), { date: D, slug: 'taken-slug', category: final.ideas[3].fingerprint.category, mechanic: final.ideas[3].fingerprint.mechanic, tags: final.ideas[3].fingerprint.tags }));
    box.must('history', ['add', '--project', `docs/d/${D}-taken-slug`]);
    const D2 = addDays(D, 1);
    const next = makeIdeasDoc(D2, { shift: 3 * dayNumber(D, D1) });
    box.write(`work/${D2}/ideas/doc.json`, next);
    const clash = box.snippet('A1', { FILE: `work/${D2}/ideas/doc.json`, D: D2, MODE: 'final', SLUG: 'taken-slug' });
    assert.equal(clash.code, 1);
    assert.match(clash.json.problems.join(), /conflicts with history/);
    assert.match(clash.json.problems.join(), /already used/);
  });


  test('(m5) the remaining documented commands run: novelty check, throttle up, the standalone server', async () => {
    const w = new World();
    const box = w.box('tools');
    const D = D1;
    box.at(D, '04:00');
    // novelty.mjs check --candidates <file> (what the ideate workflow's clerks run)
    const doc = makeIdeasDoc(D, { final: false });
    box.write(`work/${D}/ideate/candidates.json`, doc.ideas.map(({ id, title, fingerprint }) => ({ id, title, fingerprint })));
    const check = box.must('novelty', ['check', '--candidates', `work/${D}/ideate/candidates.json`, '--date', D]);
    assert.equal(check.results.length, 10);
    assert.ok(check.results.every((r) => r.ok === true && Array.isArray(r.conflicts)));
    assert.equal(box.state(['today']).code, 0);
    const bad = box.cli('novelty', ['check', '--candidates', `work/${D}/ideate/missing.json`, '--date', D]);
    assert.notEqual(bad.code, 0);
    assert.equal(bad.json.ok, false);

    // throttle up: one notch, never above the ceiling
    box.mustState(['throttle', 'set', '--level', 'lean', '--reason', 'owner']);
    assert.equal(box.mustState(['throttle', 'up', '--reason', 'owner says go']).to, 'balanced');
    assert.equal(box.mustState(['throttle', 'up', '--reason', 'again']).changed, false);

    // serve.mjs <dir> --port N prints one JSON line and serves the directory (what the critic's scripts use)
    fs.mkdirSync(box.p('work', D, 'tmp', 'site'), { recursive: true });
    box.write(`work/${D}/tmp/site/index.html`, '<!doctype html><title>served</title>');
    const child = spawn(process.execPath, ['scripts/qa/serve.mjs', box.p('work', D, 'tmp', 'site')], { cwd: box.root, env: box.env() });
    try {
      const line = await new Promise((resolve, reject) => {
        let buf = '';
        child.stdout.on('data', (d) => {
          buf += d;
          if (/\}\s*$/.test(buf)) resolve(buf);
        });
        child.on('error', reject);
        setTimeout(() => reject(new Error(`serve.mjs printed nothing: ${buf}`)), 10_000);
      });
      const info = JSON.parse(line);
      assert.equal(info.ok, true);
      const res = await fetch(`${info.url}index.html`);
      assert.equal(res.status, 200);
      assert.match(await res.text(), /served/);
      assert.equal((await fetch(`${info.url}../../etc/passwd`)).status === 200, false);
    } finally {
      child.kill('SIGTERM');
    }
  });

});
