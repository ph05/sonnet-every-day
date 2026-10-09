#!/usr/bin/env node
// Polls the published archive.json until it lists a date. Best effort: an unreachable site is not a failure.
//   verify-live.mjs [--date YYYY-MM-DD] [--url <site url or archive.json url>] [--timeout-s N] [--now ISO]
// Exit codes: 0 ok (live, or unreachable), 1 checked and not live, 2 usage error.
import { pathToFileURL } from 'node:url';
import { loadConfig, localParts, parseArgs, resolveNow, print, die } from './lib/common.mjs';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_TIMEOUT_S = 180;
const DEFAULT_INTERVAL_S = 10;
const REQUEST_TIMEOUT_S = 10;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
          reason = 'bad-json';
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
