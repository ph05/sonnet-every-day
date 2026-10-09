#!/usr/bin/env node
// state/history.json: one entry per published date. Read by novelty/lenses/build-site, written here only.
//   history.mjs digest [--limit N] [--text]
//   history.mjs add --project <docs/d/dir> [--counts-for-novelty true|false]
//   history.mjs remove --date YYYY-MM-DD [--rm-dir]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  rp, readJson, writeJsonAtomic, loadConfig, dayNumber, parseArgs, resolveNow, print, die,
} from './lib/common.mjs';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAGLINE_MAX = 120;

export function historyFile() {
  return rp('state', 'history.json');
}

function configStartDate() {
  try {
    return loadConfig().startDate ?? null;
  } catch {
    return null;
  }
}

/** Missing file => empty history. A file that exists but is unreadable is an error: never silently reset history. */
export function loadHistory() {
  const file = historyFile();
  if (!fs.existsSync(file)) return { schema: 1, startDate: configStartDate(), entries: [] };
  const h = readJson(file);
  if (!h || typeof h !== 'object' || !Array.isArray(h.entries)) {
    throw new Error(`${file}: expected an object with an "entries" array`);
  }
  if (!h.startDate) h.startDate = configStartDate();
  return h;
}

function saveHistory(h) {
  h.entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  writeJsonAtomic(historyFile(), h);
}

function resolveProjectDir(projectDir) {
  const abs = path.resolve(String(projectDir));
  if (fs.existsSync(abs)) return abs;
  const fromRoot = rp(String(projectDir));
  if (fs.existsSync(fromRoot)) return fromRoot;
  throw new Error(`project directory not found: ${projectDir}`);
}

function clip(text, max) {
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Append or replace the entry for the project's date from its project.json.
 * Idempotent: re-adding the same project keeps `n` and `publishedAt`.
 * @returns {{entry: object, replaced: boolean}}
 */
export function addProject(projectDir, { countsForNovelty, publishedAt, now } = {}) {
  const dir = resolveProjectDir(projectDir);
  const pj = readJson(path.join(dir, 'project.json'));
  const { date, slug, title, tier } = pj;
  if (!DATE_RE.test(String(date))) throw new Error(`project.json: bad date ${JSON.stringify(date)}`);
  if (!SLUG_RE.test(String(slug))) throw new Error(`project.json: bad slug ${JSON.stringify(slug)}`);
  if (!title || typeof title !== 'string') throw new Error('project.json: missing title');
  if (![1, 2, 3, 4].includes(tier)) throw new Error(`project.json: tier must be 1..4, got ${JSON.stringify(tier)}`);
  if (!pj.fingerprint || typeof pj.fingerprint !== 'object') throw new Error('project.json: missing fingerprint');
  if (path.basename(dir) !== `${date}-${slug}`) {
    throw new Error(`directory name ${path.basename(dir)} does not match project.json (${date}-${slug})`);
  }

  const h = loadHistory();
  const existing = h.entries.find((e) => e.date === date);
  const clash = h.entries.find((e) => e.slug === slug && e.date !== date);
  if (clash && tier <= 2 && clash.tier <= 2) {
    throw new Error(`slug "${slug}" is already used by the ${clash.date} project; pick a unique slug`);
  }

  const startDate = h.startDate || date;
  const n = existing?.n ?? dayNumber(date, startDate);
  if (!(n >= 1)) throw new Error(`date ${date} is before the start date ${startDate}`);

  const entry = {
    n,
    date,
    slug,
    title: clip(title, 200),
    tagline: clip(pj.tagline ?? '', TAGLINE_MAX),
    tier,
    fingerprint: pj.fingerprint,
    path: `d/${date}-${slug}/`,
    publishedAt: publishedAt
      ?? (existing && existing.slug === slug ? existing.publishedAt : null)
      ?? (now instanceof Date ? now : resolveNow({})).toISOString(),
    countsForNovelty: typeof countsForNovelty === 'boolean' ? countsForNovelty : tier <= 2,
  };

  h.entries = h.entries.filter((e) => e.date !== date);
  h.entries.push(entry);
  saveHistory(h);
  return { entry, replaced: Boolean(existing) };
}

/** Drops the history entry for `date` (and optionally its docs/d directory). Missing date is not an error. */
export function removeDate(date, { deleteDir = false } = {}) {
  if (!DATE_RE.test(String(date))) throw new Error(`bad date: ${date}`);
  const h = loadHistory();
  const entry = h.entries.find((e) => e.date === date);
  if (!entry) return { removed: false, entry: null, dirDeleted: false };
  h.entries = h.entries.filter((e) => e.date !== date);
  saveHistory(h);
  let dirDeleted = false;
  if (deleteDir && typeof entry.path === 'string') {
    const base = path.resolve(rp('docs', 'd'));
    const target = path.resolve(rp('docs', entry.path));
    if (target.startsWith(base + path.sep) && fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      dirDeleted = true;
    }
  }
  return { removed: true, entry, dirDeleted };
}

function cell(v) {
  return String(v ?? '').replace(/[\r\n|\s]+/g, ' ').trim();
}

/** One line per past project: "YYYY-MM-DD | title | category | mechanic | tags". Most recent `limit` entries. */
export function digest({ limit } = {}) {
  const entries = [...loadHistory().entries].sort((a, b) => (a.date < b.date ? -1 : 1));
  const n = Number(limit);
  const shown = Number.isFinite(n) && n > 0 ? entries.slice(-Math.floor(n)) : entries;
  if (!shown.length) return '(no past projects yet)';
  return shown
    .map((e) => {
      const fp = e.fingerprint ?? {};
      const title = e.countsForNovelty === false ? `${cell(e.title)} (fallback day)` : cell(e.title);
      return [e.date, title, cell(fp.category), cell(fp.mechanic), (fp.tags ?? []).map(cell).join(',')].join(' | ');
    })
    .join('\n');
}

function main() {
  const flags = parseArgs();
  const cmd = flags._[0];
  try {
    if (cmd === 'digest') {
      const text = digest({ limit: flags.limit });
      const count = text === '(no past projects yet)' ? 0 : text.split('\n').length;
      if (flags.text) {
        process.stdout.write(`${text}\n`);
        return;
      }
      print({ ok: true, count, digest: text });
    } else if (cmd === 'add') {
      if (!flags.project || flags.project === true) die('usage: history.mjs add --project <docs/d/dir>', 2);
      const opts = {};
      const c = flags['counts-for-novelty'];
      if (c !== undefined) opts.countsForNovelty = String(c) !== 'false';
      if (flags.now || process.env.SED_NOW) opts.now = resolveNow(flags);
      const { entry, replaced } = addProject(flags.project, opts);
      print({ ok: true, replaced, entry });
    } else if (cmd === 'remove') {
      if (!flags.date || flags.date === true) die('usage: history.mjs remove --date YYYY-MM-DD [--rm-dir]', 2);
      print({ ok: true, ...removeDate(flags.date, { deleteDir: Boolean(flags['rm-dir']) }) });
    } else {
      die('usage: history.mjs digest|add|remove (see ops/CONTRACT.md 6.5)', 2);
    }
  } catch (err) {
    die(err.message, 1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
