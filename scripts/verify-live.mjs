#!/usr/bin/env node
// Polls the published archive.json until it lists a date. Best effort: an unreachable site is not a failure.
//   verify-live.mjs [--date YYYY-MM-DD] [--url <site url or archive.json url>] [--timeout-s N] [--now ISO]
// Exit codes: 0 ok (live, or unreachable), 1 checked and not live, 2 usage error.
// When archive.json is missing or answers with a page instead of JSON, one look at the site root and at
// <site>docs/archive.json names the cause (diagnoseSite): `site-root-is-readme` (Pages publishes the repository
// root, i.e. the README or the root redirect, not the docs/ folder) or `site-not-found` (nothing at the root:
// Pages is off or has not deployed yet). Both come with a `hint` that names the fix.
import { pathToFileURL } from 'node:url';
import { loadConfig, localParts, parseArgs, resolveNow, print, die } from './lib/common.mjs';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_TIMEOUT_S = 180;
const DEFAULT_INTERVAL_S = 10;
const REQUEST_TIMEOUT_S = 10;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The setting that fixes both Pages misconfigurations (README.md and ops/OPERATING.md say the same). */
export const PAGES_FIX = 'Settings > Pages > Build and deployment > Deploy from a branch, branch main, folder /docs, Save';
export const HINTS = {
  'site-root-is-readme': `GitHub Pages publishes the repository root (the README, or the root redirect to docs/), not the docs/ folder, so every page URL under the site answers 404. Fix: ${PAGES_FIX}.`,
  'site-not-found': `The site root answers 404 as well: GitHub Pages is not enabled, or its first deploy has not finished. Fix: ${PAGES_FIX}.`,
};
// Markers of the gallery's own index.html (site-src/index.template.html): its inline archive and its stylesheet.
const GALLERY_MARKERS = [/<script\b[^>]*\bid=["']?archive\b/i, /assets\/gallery\.css/i];
const looksLikeHtml = (type, text) => /\bhtml\b/i.test(String(type ?? '')) || /^\s*(?:<!doctype\s+html|<html|<head|<body|<meta|<title|<!--)/i.test(String(text ?? ''));

/** One GET bounded by the request timeout: { status, type, text } or null when nothing answered. Never throws. */
async function probeOnce(url, { fetchImpl, requestTimeoutS }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, requestTimeoutS * 1000));
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { 'cache-control': 'no-cache' }, redirect: 'follow' });
    const text = res.ok ? await res.text() : '';
    if (!res.ok) await res.body?.cancel().catch(() => {});
    return { status: res.status, type: res.headers?.get?.('content-type') ?? '', text };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Why is `<site>archive.json` missing or not JSON? Looks once at the site root and at `<site>docs/archive.json`.
 * Returns { reason: 'site-root-is-readme', docsListed } when GitHub Pages publishes the repository root instead of
 * the docs/ folder (docs/archive.json answers there, or the root page is not the gallery), { reason: 'site-not-found' }
 * when the root answers 404 as well, or null when neither applies (the caller keeps its own reason).
 */
export async function diagnoseSite({ target, date, fetchImpl = globalThis.fetch, requestTimeoutS = REQUEST_TIMEOUT_S }) {
  const root = new URL('./', target);
  const nested = new URL('docs/archive.json', root);
  nested.searchParams.set('cb', String(Date.now()));
  const [home, docs] = await Promise.all([probeOnce(root, { fetchImpl, requestTimeoutS }), probeOnce(nested, { fetchImpl, requestTimeoutS })]);
  if (docs?.status === 200) {
    try {
      const archive = JSON.parse(docs.text);
      if (Array.isArray(archive?.days)) return { reason: 'site-root-is-readme', docsListed: archive.days.some((d) => d?.date === date) };
    } catch {
      /* not the archive: decide from the root page */
    }
  }
  if (home?.status === 200 && looksLikeHtml(home.type, home.text) && !GALLERY_MARKERS.some((re) => re.test(home.text))) {
    return { reason: 'site-root-is-readme', docsListed: null };
  }
  if (home?.status === 404) return { reason: 'site-not-found' };
  return null;
}

/** `https://x/site/` => `https://x/site/archive.json`; a URL already ending in .json is used as given. */
export function archiveUrl(raw) {
  const u = new URL(String(raw));
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`unsupported protocol in ${raw}`);
  if (!u.pathname.endsWith('.json')) {
    if (!u.pathname.endsWith('/')) u.pathname += '/';
    u.pathname += 'archive.json';
  }
  u.hash = '';
  return u;
}

/**
 * @param {{date: string, url: string, timeoutS?: number, intervalS?: number, requestTimeoutS?: number, fetchImpl?: typeof fetch}} opts
 * @returns {Promise<{ok: boolean, live: boolean|null, status: number|null, checked: number, date: string, url: string, reason?: string}>}
 */
export async function verifyLive({ date, url, timeoutS = DEFAULT_TIMEOUT_S, intervalS = DEFAULT_INTERVAL_S, requestTimeoutS = REQUEST_TIMEOUT_S, fetchImpl = globalThis.fetch }) {
  const target = archiveUrl(url);
  const deadline = Date.now() + timeoutS * 1000;
  let checked = 0;
  let status = null;
  let reason = 'timeout';
  let gotResponse = false;

  for (;;) {
    checked++;
    const probe = new URL(target);
    probe.searchParams.set('cb', String(Date.now())); // the Pages CDN caches by full URL; this dodges a stale copy
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, requestTimeoutS * 1000));
    try {
      const res = await fetchImpl(probe, { signal: controller.signal, headers: { 'cache-control': 'no-cache' }, redirect: 'follow' });
      gotResponse = true;
      status = res.status;
      if (res.ok) {
        const text = await res.text();
        let archive = null;
        try {
          archive = JSON.parse(text);
        } catch {
          reason = looksLikeHtml(res.headers?.get?.('content-type'), text) ? 'html-not-json' : 'bad-json';
        }
        if (archive) {
          if (Array.isArray(archive.days) && archive.days.some((d) => d?.date === date)) {
            return { ok: true, live: true, status, checked, date, url: target.toString() };
          }
          reason = 'not-listed';
        }
      } else {
        reason = `http-${res.status}`;
        await res.body?.cancel().catch(() => {});
      }
    } catch (e) {
      if (!gotResponse) reason = 'unreachable';
      process.stderr.write(`verify-live: attempt ${checked} failed: ${e?.name === 'AbortError' ? 'request timed out' : (e?.cause?.code ?? e?.message ?? e)}\n`);
    } finally {
      clearTimeout(timer);
    }
    const left = deadline - Date.now();
    if (left <= 0) break;
    await sleep(Math.min(intervalS * 1000, left));
  }

  const base = { status, checked, date, url: target.toString() };
  if (!gotResponse) return { ok: true, live: null, ...base, reason: 'unreachable' };
  if (reason === 'http-404' || reason === 'html-not-json') {
    const found = await diagnoseSite({ target, date, fetchImpl, requestTimeoutS });
    if (found) {
      process.stderr.write(`verify-live: ${found.reason} (archive.json answered ${reason}): ${HINTS[found.reason]}\n`);
      return { ok: false, live: false, ...base, reason: found.reason, was: reason, hint: HINTS[found.reason], ...(found.docsListed !== undefined ? { docsListed: found.docsListed } : {}) };
    }
  }
  return { ok: false, live: false, ...base, reason };
}

async function main() {
  const flags = parseArgs();
  let date;
  let url;
  let timeoutS = DEFAULT_TIMEOUT_S;
  let intervalS = DEFAULT_INTERVAL_S;
  try {
    const config = loadConfig();
    date = flags.date ?? localParts(resolveNow(flags), config.timezone).date;
    url = flags.url ?? config.siteUrl;
    if (flags['timeout-s'] !== undefined) timeoutS = Number(flags['timeout-s']);
    if (flags['interval-s'] !== undefined) intervalS = Number(flags['interval-s']);
  } catch (e) {
    die(e.message, 2);
  }
  if (typeof date !== 'string' || !DATE_RE.test(date)) die(`bad --date: ${date}`, 2);
  if (!Number.isFinite(timeoutS) || timeoutS < 0) die(`bad --timeout-s: ${flags['timeout-s']}`, 2);
  if (!Number.isFinite(intervalS) || intervalS <= 0) die(`bad --interval-s: ${flags['interval-s']}`, 2);
  try {
    archiveUrl(url);
  } catch (e) {
    die(`bad --url: ${e.message}`, 2);
  }
  const result = await verifyLive({ date, url, timeoutS, intervalS });
  print(result);
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e?.message ?? String(e), 1));
}
