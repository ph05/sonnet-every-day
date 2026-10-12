#!/usr/bin/env node
// Regenerates the static site (everything in docs/ except docs/d/**) from state/history.json and each
// docs/d/<date>-<slug>/project.json, plus the swarm's diary (docs/kaizen/) from ops/kaizen/INDEX.json.
// Projects that fail validation are left out of the site, never fatal.
//   build-site.mjs [--now ISO]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { rp, readJson, loadConfig, localParts, addDays, hm, parseArgs, resolveNow, print, die } from './lib/common.mjs';
import {
  buildArchive, normalizeSiteUrl, renderTemplate, renderFeed, renderSitemap, renderRobots,
  normalizeKaizen, kaizenTeaser, renderKaizenPage, renderKaizenJson, summarizeKaizen, KAIZEN_PATH,
} from './lib/archive.mjs';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_REPORTED_WARNINGS = 50;
const DEFAULT_CONCURRENCY = 8;

class FatalError extends Error {}

const errMsg = (e) => (e instanceof Error ? e.message : String(e));

/** Imports the gate's validator; null (plus a warning) if it cannot be loaded so the build still runs. */
async function loadValidator(warnings) {
  try {
    const mod = await import(new URL('./validate.mjs', import.meta.url).href);
    if (typeof mod.validateProject === 'function') return mod.validateProject;
    warnings.push('scripts/validate.mjs does not export validateProject; using structural checks only');
  } catch (e) {
    warnings.push(`scripts/validate.mjs could not be loaded (${errMsg(e).split('\n')[0]}); using structural checks only`);
  }
  return null;
}

/** Minimal checks used when validate.mjs is unavailable: project.json fields, entry page, PNG thumbnail. */
function structuralCheck(dir, project) {
  const errors = [];
  const isFile = (rel) => {
    try {
      return fs.statSync(path.join(dir, rel)).isFile();
    } catch {
      return false;
    }
  };
  const safeRel = (v, fallback) => (typeof v === 'string' && /^[\w.-]+$/.test(v) && !v.startsWith('.') ? v : fallback);
  if (typeof project.title !== 'string' || !project.title.trim()) errors.push('project.json: missing title');
  if (![1, 2, 3, 4].includes(project.tier)) errors.push(`project.json: tier must be 1..4, got ${JSON.stringify(project.tier)}`);
  const entry = safeRel(project.entry, 'index.html');
  const thumb = safeRel(project.thumb, 'thumb.png');
  if (!isFile(entry)) errors.push(`entry page ${entry} is missing`);
  if (!isFile(thumb)) {
    errors.push(`thumbnail ${thumb} is missing`);
  } else {
    const head = Buffer.alloc(8);
    const fd = fs.openSync(path.join(dir, thumb), 'r');
    try {
      fs.readSync(fd, head, 0, 8, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (!head.equals(PNG_MAGIC)) errors.push(`thumbnail ${thumb} is not a PNG`);
  }
  return errors;
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

function readRequired(rel, what) {
  const file = rp(rel);
  try {
    return fs.readFileSync(file);
  } catch (e) {
    throw new FatalError(`${rel} is missing or unreadable (${e.code ?? errMsg(e)}). ${what} Nothing in docs/ was changed.`);
  }
}

function loadHistoryEntries() {
  const file = rp('state', 'history.json');
  if (!fs.existsSync(file)) return [];
  const history = readJson(file);
  if (!history || !Array.isArray(history.entries)) throw new FatalError('state/history.json is corrupt (no "entries" array); refusing to rebuild the site from it. Nothing in docs/ was changed.');
  return history.entries;
}

/** The canonical purpose order: ops/taxonomy.json `purposes` keys; the archive's built-in order when the taxonomy has none. */
function purposeOrder() {
  try {
    const keys = Object.keys(readJson(rp('ops', 'taxonomy.json'))?.purposes ?? {});
    return keys.length ? keys : undefined;
  } catch {
    return undefined;
  }
}

/** Last date that counts as "should have a project": today once it is past the deadline or published, else yesterday. */
function missingThrough({ now, config, publishedDates }) {
  const { date: today, minutes } = localParts(now, config.timezone);
  const deadline = hm(config.schedule?.deadline ?? '08:00');
  return !publishedDates.has(today) && minutes < deadline ? addDays(today, -1) : today;
}

/**
 * The diary's inputs: the ledger plus its three optional site-src files. Nothing here is ever fatal: without the
 * files or with a ledger that cannot be read, the diary is simply not (re)written and the page already in docs/kaizen/
 * stays as it was.
 */
function loadDiary(config, warnings) {
  const read = (rel) => {
    try {
      return fs.readFileSync(rp(rel));
    } catch {
      return null;
    }
  };
  const template = read('site-src/kaizen.template.html');
  const css = read('site-src/kaizen.css');
  const js = read('site-src/kaizen.js');
  const missing = [['kaizen.template.html', template], ['kaizen.css', css], ['kaizen.js', js]].filter(([, v]) => v === null).map(([n]) => `site-src/${n}`);
  const ledgerFile = rp('ops', 'kaizen', 'INDEX.json');
  let raw;
  let readError = null;
  if (fs.existsSync(ledgerFile)) {
    try {
      raw = readJson(ledgerFile);
    } catch (e) {
      readError = errMsg(e).split('\n')[0];
    }
  }
  const model = readError ? { ok: false, error: readError, entries: [], warnings: [] } : normalizeKaizen(raw, { repo: config.repo, workBranch: config.workBranch, members: config.kaizen?.members });
  warnings.push(...model.warnings);
  const present = fs.existsSync(rp('docs', 'kaizen', 'index.html'));
  if (!model.ok) warnings.push(`the swarm's diary was not rebuilt: ${model.error}${present ? '; keeping the published page' : ''}`);
  else if (missing.length) warnings.push(`the swarm's diary was not built: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing${present ? '; keeping the published page' : ''}`);
  const render = model.ok && missing.length === 0;
  return { render, present: render || present, entries: model.entries, template: template?.toString('utf8'), css, js };
}

async function validateOne({ entry, validate, now }) {
  const rel = `d/${entry.date}-${entry.slug}/`;
  const dir = rp('docs', 'd', `${entry.date}-${entry.slug}`);
  const fail = (...errors) => ({ omitted: { path: rel, errors } });
  if (!DATE_RE.test(String(entry.date)) || !SLUG_RE.test(String(entry.slug))) {
    return { omitted: { path: String(entry.path ?? `${entry.date}-${entry.slug}`), errors: [`history entry has an unusable date/slug (${JSON.stringify(entry.date)}, ${JSON.stringify(entry.slug)})`] } };
  }
  let project;
  try {
    project = readJson(path.join(dir, 'project.json'));
  } catch (e) {
    return fail(`project.json is unreadable: ${errMsg(e)}`);
  }
  if (!project || typeof project !== 'object' || Array.isArray(project)) return fail('project.json is not an object');
  if (project.date !== entry.date || project.slug !== entry.slug) {
    return fail(`project.json (${project.date}-${project.slug}) does not match its history entry (${entry.date}-${entry.slug})`);
  }
  let result;
  try {
    result = validate ? await validate(dir, { now }) : { ok: true, errors: structuralCheck(dir, project), warnings: [] };
    if (!validate) result.ok = result.errors.length === 0;
  } catch (e) {
    return fail(`validator crashed: ${errMsg(e)}`);
  }
  if (!result?.ok) return fail(...(Array.isArray(result?.errors) && result.errors.length ? result.errors.map(String) : ['validation failed']));
  const warnings = (result.warnings ?? []).map((w) => `${rel}: ${w}`);
  if (entry.path && entry.path !== rel) warnings.push(`${rel}: history entry path ${JSON.stringify(entry.path)} differs from the directory; using the directory`);
  return { project, entry, warnings };
}

function writeAtomic(file, content) {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  try {
    if (fs.readFileSync(file).equals(data)) return false;
  } catch {
    // not there yet
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return true;
}

/**
 * @param {{now?: Date|string, validate?: Function, concurrency?: number}} [opts] `validate` overrides the
 *   imported validateProject (tests).
 * @returns {Promise<{ok: boolean, projects: number, omitted: {path: string, errors: string[]}[], unlisted: string[], warnings: string[], error?: string}>}
 *   `unlisted`: docs/d directories without a state/history.json entry (not on the site); their warnings come first.
 */
export async function buildSite({ now, validate, concurrency = DEFAULT_CONCURRENCY } = {}) {
  const warnings = [];
  const omitted = [];
  const unlisted = [];
  try {
    const instant = now instanceof Date ? now : resolveNow({ now });
    if (Number.isNaN(instant.getTime())) throw new FatalError(`bad now value: ${now}`);
    const config = loadConfig();
    const siteUrl = normalizeSiteUrl(config.siteUrl);

    // Read and render everything first; only then touch docs/, so a missing input never leaves a half-built site.
    const indexTemplate = readRequired('site-src/index.template.html', 'The gallery engineer owns site-src/.').toString('utf8');
    const notFoundTemplate = readRequired('site-src/404.template.html', 'The gallery engineer owns site-src/.').toString('utf8');
    const css = readRequired('site-src/gallery.css', 'The gallery engineer owns site-src/.');
    const js = readRequired('site-src/gallery.js', 'The gallery engineer owns site-src/.');

    const entries = loadHistoryEntries();
    const byDate = new Map();
    for (const e of entries) {
      if (e && typeof e === 'object') {
        if (byDate.has(e.date)) warnings.push(`state/history.json has more than one entry for ${e.date}; using the last`);
        byDate.set(e.date, e);
      }
    }
    const ordered = [...byDate.values()].sort((a, b) => (String(a.date) < String(b.date) ? -1 : 1));

    const validator = validate ?? (await loadValidator(warnings));
    const results = await mapPool(ordered, concurrency, (entry) => validateOne({ entry, validate: validator, now: instant }));
    const projects = [];
    for (const r of results) {
      if (r.omitted) {
        omitted.push(r.omitted);
        warnings.push(`omitted ${r.omitted.path}: ${r.omitted.errors.join('; ')}`);
      } else {
        projects.push({ entry: r.entry, project: r.project });
        warnings.push(...r.warnings);
      }
    }

    const known = new Set(ordered.map((e) => `${e.date}-${e.slug}`));
    try {
      for (const d of fs.readdirSync(rp('docs', 'd'), { withFileTypes: true })) {
        if (d.isDirectory() && !known.has(d.name)) unlisted.push(`docs/d/${d.name}`);
      }
    } catch {
      // docs/d does not exist yet
    }
    // first in the list, so the output's 50-warning cut never drops them: a new page missing from the gallery is the usual cause
    warnings.unshift(...unlisted.map((d) => `${d} is not in state/history.json, so the site does not list it (to publish it: node scripts/history.mjs add --project ${d})`));

    const diary = loadDiary(config, warnings);
    const publishedDates = new Set(projects.map((p) => p.project.date));
    const archive = buildArchive({
      projects, config, siteUrl, now: instant, through: missingThrough({ now: instant, config, publishedDates }),
      kaizen: diary.render ? kaizenTeaser(diary.entries) : null, purposes: purposeOrder(),
    });

    const index = renderTemplate(indexTemplate, archive);
    const notFound = renderTemplate(notFoundTemplate, archive);
    if (index.missing.includes('ARCHIVE_JSON')) warnings.push('site-src/index.template.html has no {{ARCHIVE_JSON}} placeholder; the gallery gets no inline data');
    for (const [name, r] of [['index.template.html', index], ['404.template.html', notFound]]) {
      if (r.unknown.length) warnings.push(`site-src/${name} has unknown placeholders left untouched: ${r.unknown.join(', ')}`);
    }

    const diaryOutputs = [];
    if (diary.render) {
      const page = renderKaizenPage(diary.template, { archive, entries: diary.entries });
      if (page.unknown.length) warnings.push(`site-src/kaizen.template.html has unknown placeholders left untouched: ${page.unknown.join(', ')}`);
      diaryOutputs.push(
        ['assets/kaizen.css', diary.css],
        ['assets/kaizen.js', diary.js],
        ['kaizen/kaizen.json', renderKaizenJson({ archive, entries: diary.entries, repo: config.repo, workBranch: config.workBranch })],
        ['kaizen/index.html', page.html],
      );
    }

    const publishedAtByDate = Object.fromEntries(projects.map((p) => [p.entry.date, p.entry.publishedAt]));
    const diaryPage = diary.present ? [{ path: KAIZEN_PATH, lastmod: summarizeKaizen(diary.entries).lastDate }] : [];
    const outputs = [
      ['assets/gallery.css', css],
      ['assets/gallery.js', js],
      ['archive.json', `${JSON.stringify(archive, null, 2)}\n`],
      ['feed.xml', renderFeed({ archive, publishedAtByDate, diary: diary.present })],
      ['sitemap.xml', renderSitemap(archive, diaryPage)],
      ['robots.txt', renderRobots(siteUrl)],
      ['404.html', notFound.html],
      ['.nojekyll', ''],
      ...diaryOutputs,
      // The entry point goes last: it is what visitors load, so it only changes once everything it references is in place.
      ['index.html', index.html],
    ];
    const changed = [];
    for (const [rel, content] of outputs) {
      if (writeAtomic(rp('docs', rel), content)) changed.push(rel);
    }

    return { ok: true, projects: projects.length, omitted, unlisted, warnings, generatedAt: archive.generatedAt, changed, diary: { entries: diary.entries.length, rendered: diary.render } };
  } catch (e) {
    return { ok: false, projects: 0, omitted, unlisted, warnings, error: errMsg(e) };
  }
}

async function main() {
  const flags = parseArgs();
  let now;
  try {
    now = resolveNow(flags);
  } catch (e) {
    die(errMsg(e), 2);
  }
  const result = await buildSite({ now });
  for (const w of result.warnings) process.stderr.write(`warning: ${w}\n`);
  if (!result.ok) process.stderr.write(`build-site failed: ${result.error}\n`);
  if (result.warnings.length > MAX_REPORTED_WARNINGS) {
    const extra = result.warnings.length - MAX_REPORTED_WARNINGS;
    result.warnings = [...result.warnings.slice(0, MAX_REPORTED_WARNINGS), `... and ${extra} more warnings`];
  }
  print(result);
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(errMsg(e), 1));
}
