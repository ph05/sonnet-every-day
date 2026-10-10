#!/usr/bin/env node
// Model-free safety net (CONTRACT 6.1c, 13): if today has no published entry AND either the run's lease is stale or
// absent and it is at least DEADMAN_GRACE_EXTRA_MINUTES past schedule.graceUntil, or it is schedule.hardStop or later
// (or --force), publish the best fallback page that is possible (Ideas Day if the researched ideas exist, else the
// Postcard), rebuild the site, mark the run published and push. 08:00 is a guideline: a healthy run is never cut off
// before the hard stop. Every clock time comes from config.json.
//   deadman.mjs [--force] [--now ISO] [--date D] [--no-git] [--dry-run] [--no-sleep]
// Idempotent: an already published day is never touched, and a better tier is never overwritten.
//
// Racing a live primary: the closer's checkout is usually a few minutes behind the remote, and a live primary keeps
// checkpointing the same run file. So before deciding, and again after every push that loses such a race, the
// checkout is brought up to the remote tip. Whatever is only local and fully regenerable (this script's own
// fallback page, the run file, the generated site files) is dropped for that, because the next round rebuilds it
// on the new tip; local work that cannot be regenerated (the researched ideas, a real build) is never discarded.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  rp, readJson, loadConfig, localParts, hm, parseArgs, resolveNow, print, die,
} from './lib/common.mjs';
import {
  ideasAvailable, ideasDay, postcard, notice, historyHealth, repairHistory,
} from './fallback.mjs';

/** Minutes past schedule.graceUntil before a dead run is taken over (the closer, whose grace-aware babysit ends at graceUntil, goes first). */
export const DEADMAN_GRACE_EXTRA_MINUTES = 5;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SESSION = 'deadman';
const MAX_ROUNDS = 3;

async function optional(spec) {
  try {
    return await import(spec);
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && String(err.message).includes(spec.replace('./', ''))) return null;
    throw err;
  }
}

const clock = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** The two marks the deadman waits for, in minutes after local midnight (read from config.schedule; deadline stands in for a missing mark). */
export function deadmanThresholds(config) {
  const s = config.schedule ?? {};
  const graceUntil = hm(s.graceUntil ?? s.deadline);
  const hardStop = hm(s.hardStop ?? s.graceUntil ?? s.deadline);
  return { staleAfter: Math.min(graceUntil + DEADMAN_GRACE_EXTRA_MINUTES, hardStop), hardStop };
}

/**
 * Is anyone still working on `day`'s run? Alive = an in-progress run whose lease is fresh (lease heartbeat or the
 * session's heartbeat file, local or on the heartbeat branch) and whose phase is not stuck. A missing, failed,
 * unreadable or stale run counts as dead. Never throws.
 */
async function leaseView({ config, day, instant, git }) {
  const rs = await optional('./lib/runstate.mjs');
  if (!rs?.loadRun || !rs.leaseInfo) return { alive: false, present: false, reason: 'runstate-missing' };
  let run;
  try {
    run = rs.loadRun(day);
  } catch {
    run = null;
  }
  if (!run) return { alive: false, present: false, reason: 'no-run' };
  const session = run.lease?.session;
  let heartbeat = null;
  try {
    heartbeat = rs.loadHeartbeat(day, session);
    if (git && session) {
      const gs = await optional('./lib/gitsync.mjs');
      const remote = gs?.fetchRemoteHeartbeat ? gs.fetchRemoteHeartbeat({ date: day, session, config }) : null;
      heartbeat = rs.latestHeartbeat(heartbeat, remote?.heartbeat ?? null);
    }
  } catch {
    /* the lease's own heartbeatAt still decides */
  }
  const info = rs.leaseInfo(config, run, heartbeat, instant.getTime());
  const alive = run.status === 'in_progress' && info.present && !info.stale && !info.stuck;
  return {
    alive,
    present: info.present,
    holder: info.holder,
    ageMinutes: info.ageMinutes,
    phase: run.phase,
    reason: alive ? 'fresh' : run.status !== 'in_progress' ? `run ${run.status}` : !info.present ? 'no-lease' : info.stuck ? 'stuck' : 'stale',
  };
}

const message = (err) => (err instanceof Error ? err.message : String(err));

function hasPage(date) {
  try {
    return fs.readdirSync(rp('docs', 'd')).some((name) => name.startsWith(`${date}-`) && fs.existsSync(rp('docs', 'd', name, 'index.html')));
  } catch {
    return false;
  }
}

function publishedEntry(date) {
  const h = readJson(rp('state', 'history.json'), { entries: [] });
  const entry = Array.isArray(h?.entries) ? h.entries.find((e) => e?.date === date) : null;
  if (entry) return { tier: Number.isInteger(entry.tier) ? entry.tier : null, slug: entry.slug ?? null, path: entry.path ?? null, where: 'state/history.json' };
  const run = readJson(rp('state', 'runs', `${date}.json`), null);
  // A run that says "published" with no page on disk (an out-of-order `finish`, a package that never landed) is not a publication.
  if (run?.status === 'published' && hasPage(date)) return { tier: Number.isInteger(run.tier) ? run.tier : null, slug: run.chosen?.slug ?? null, where: `state/runs/${date}.json` };
  return null;
}

// ---------------------------------------------------------------------------------------------
// Keeping the checkout current without ever losing work that cannot be rebuilt
// ---------------------------------------------------------------------------------------------

const GENERATED_SITE_FILES = new Set([
  'state/history.json', 'docs/index.html', 'docs/archive.json', 'docs/feed.xml', 'docs/sitemap.xml',
  'docs/404.html', 'docs/robots.txt', 'docs/.nojekyll',
]);
const TRANSIENT = /\.(?:lock|tmp)$|\.lock\.stale\./;
// config.json is never staged by sync unless asked to, so it is not part of what this script reconciles.
const inSyncScope = (file) => /^(?:state|docs|work)\//.test(file);

/** Files this script (or build-site) writes and can write again from scratch for `day`. */
function isRegenerable(file, day) {
  return GENERATED_SITE_FILES.has(file)
    || file.startsWith('state/history.json.corrupt')
    || file.startsWith('docs/assets/')
    || file.startsWith(`state/runs/${day}.`)
    || file.startsWith(`docs/d/${day}-ideas-day/`)
    || file.startsWith(`docs/d/${day}-postcard/`)
    || file === `work/${day}/fallback-notice.json`
    || file.startsWith(`work/${day}/tmp/`);
}

const splitZ = (text) => String(text ?? '').split('\0').filter(Boolean);

function localOnlyFiles(g, remoteRef) {
  return splitZ(g.out(['diff', '--name-only', '--no-renames', '-z', `${remoteRef}...HEAD`]));
}

/** Uncommitted changes (tracked or not) inside the synced paths: [{ code, file }]. */
function dirtyFiles(g) {
  const raw = g.run(['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', '--', 'state', 'docs', 'work']);
  return raw.ok ? splitZ(raw.stdout).map((e) => ({ code: e.slice(0, 2), file: e.slice(3) })) : [];
}

function discardPath(g, file) {
  g.run(['reset', '-q', '--', file]);
  if (g.run(['cat-file', '-e', `HEAD:${file}`]).ok) g.run(['checkout', 'HEAD', '--', file]);
  else fs.rmSync(path.join(g.cwd, file), { recursive: true, force: true });
}

/**
 * Fetches the work branch and brings the checkout to its tip so every decision below is made on what the remote
 * really holds. Never throws. Returns { action, ... } with action one of:
 *   current | skipped            nothing to do (or not possible: no network, no git, other branch)
 *   fast-forwarded | reset       the checkout now equals the remote tip; `reset` also dropped local-only fallback work
 *                                (kept recoverable under refs/sed-backup/)
 *   rebased                      local work that cannot be regenerated was replayed on the remote tip
 *   diverged                     could not be reconciled here; the final sync reports it
 */
export async function refreshFromRemote({ day, config }) {
  const gs = await optional('./lib/gitsync.mjs');
  if (!gs?.createGit) return { action: 'skipped', reason: 'gitsync-missing' };
  const g = gs.createGit(rp());
  if (g.out(['rev-parse', '--is-inside-work-tree']) !== 'true') return { action: 'skipped', reason: 'not-a-work-tree' };
  if (!g.run(['remote', 'get-url', 'origin']).ok) return { action: 'skipped', reason: 'no-origin' };
  // The push target sync will use: the committed config's branch, never an unvetted one.
  const branch = gs.committedWorkBranch?.(g, config)?.branch ?? config.workBranch;
  const problem = gs.branchProblem?.(g, branch);
  if (problem) return { action: 'skipped', reason: problem };
  if (g.out(['symbolic-ref', '--short', '-q', 'HEAD']) !== branch) return { action: 'skipped', reason: `not on ${branch}` };

  gs.clearStaleIndexLock?.(g);
  gs.abortRebase?.(g);
  const remoteRef = `refs/remotes/origin/${branch}`;
  const fetched = g.run(['fetch', 'origin', `+refs/heads/${branch}:${remoteRef}`], { network: true });
  if (!fetched.ok) return { action: 'skipped', reason: `fetch failed: ${gs.firstLine(fetched.stderr)}` };

  const behind = Number(g.out(['rev-list', '--count', `HEAD..${remoteRef}`]) ?? 0);
  if (!behind) return { action: 'current' };
  const ahead = Number(g.out(['rev-list', '--count', `${remoteRef}..HEAD`]) ?? 0);

  const dirty = dirtyFiles(g).filter((d) => !TRANSIENT.test(d.file));
  const stray = [...new Set([...localOnlyFiles(g, remoteRef), ...dirty.map((d) => d.file)])]
    .filter((f) => inSyncScope(f) && !TRANSIENT.test(f) && !isRegenerable(f, day));
  if (stray.length) {
    if (!dirty.length && g.run(['rebase', remoteRef]).ok) return { action: 'rebased', behind, ahead, kept: stray.slice(0, 10) };
    gs.abortRebase?.(g);
    return { action: 'diverged', behind, ahead, reason: 'local work that cannot be regenerated is not on the remote yet', files: stray.slice(0, 10) };
  }

  const discarded = dirty.map((d) => d.file);
  const head = g.out(['rev-parse', 'HEAD']);
  for (const f of discarded) discardPath(g, f);
  const reset = g.run(['reset', '--keep', remoteRef]);
  if (!reset.ok) return { action: 'diverged', behind, ahead, reason: `could not move to the remote tip: ${gs.firstLine(reset.stderr)}` };
  const out = { action: ahead || discarded.length ? 'reset' : 'fast-forwarded', behind, ahead, discarded: discarded.slice(0, 20) };
  if (ahead && head) {
    const ref = `refs/sed-backup/${day}-${head.slice(0, 9)}`;
    if (g.run(['update-ref', ref, head]).ok) out.backup = ref;
  }
  return out;
}

/** A published day whose files were committed or changed locally but never reached the remote (e.g. a failed push). */
async function pendingPublication() {
  const gs = await optional('./lib/gitsync.mjs');
  if (!gs?.createGit) return false;
  const g = gs.createGit(rp());
  if (g.out(['rev-parse', '--is-inside-work-tree']) !== 'true') return false;
  const dirty = g.out(['status', '--porcelain', '--', 'state', 'docs', 'work']);
  const unpushed = Number(g.out(['rev-list', '--count', 'HEAD', '--not', '--remotes=origin']) ?? 0);
  return Boolean(dirty) || unpushed > 0;
}

async function pushChanges({ summary, noSleep, warnings }) {
  const gs = await optional('./lib/gitsync.mjs');
  if (!gs?.sync) {
    warnings.push('gitsync is not available; nothing was pushed');
    return { ok: false, pushed: false, reason: 'gitsync-missing' };
  }
  try {
    return await gs.sync({ message: summary, noSleep });
  } catch (err) {
    return { ok: false, pushed: false, reason: message(err) };
  }
}

/**
 * @param {{force?: boolean, now?: Date|string, date?: string, git?: boolean, dryRun?: boolean, noSleep?: boolean}} [opts]
 * @returns {Promise<object>} `{ok, action, ...}` where action is none | dry-run | published
 */
export async function deadman({ force = false, now, date, git = true, dryRun = false, noSleep = false } = {}) {
  const config = loadConfig();
  const instant = now instanceof Date ? now : resolveNow({ now });
  const local = localParts(instant, config.timezone);
  const day = date ?? local.date;
  if (!DATE_RE.test(day)) throw new Error(`bad date: ${day}`);
  const ctx = { config, instant, local, day, force, git, dryRun, noSleep, warnings: [] };

  // A push that loses a race with a live primary is not an error to hand to a human: the fallback is fully
  // regenerable, so refresh to the new remote tip and build it again (bounded; the primary checkpoints slowly).
  const refreshes = [];
  let out;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    if (git && !dryRun) {
      const fresh = await refreshFromRemote({ day, config });
      if (fresh.action === 'skipped' && fresh.reason !== 'gitsync-missing') ctx.warnings.push(`could not refresh from the remote: ${fresh.reason}`);
      if (fresh.action !== 'current' && fresh.action !== 'skipped') refreshes.push(fresh);
      if (round > 1 && !['reset', 'fast-forwarded', 'rebased'].includes(fresh.action)) break;
    }
    out = await attempt(ctx);
    if (!(git && !dryRun) || (out.sync ?? out.recovered)?.reason !== 'conflict') break;
    ctx.warnings.push(`the push conflicted with a newer remote tip (round ${round}); refreshing and regenerating the fallback`);
  }
  return refreshes.length ? { ...out, refreshed: refreshes } : out;
}

async function attempt({ config, instant, local, day, force, git, dryRun, noSleep, warnings }) {
  if (dryRun) {
    const health = historyHealth();
    if (!health.ok) warnings.push(`state/history.json is unreadable (${health.error}); a real run repairs it first`);
  } else {
    try {
      const repaired = await repairHistory({ now: instant });
      if (repaired.repaired) warnings.push(`state/history.json was unreadable and was ${repaired.source === 'empty' ? 'replaced by an empty history' : `rebuilt from ${repaired.source}`} (${repaired.entries} entries; the bad file is kept as ${repaired.quarantined})`);
    } catch (err) {
      warnings.push(`state/history.json is unreadable and could not be repaired: ${message(err)}`);
    }
  }

  const done = publishedEntry(day);
  if (done) {
    const out = { ok: true, action: 'none', reason: 'already-published', date: day, tier: done.tier, where: done.where };
    // The page is in history but its run never reached `finish` (the operator died after pushing the package):
    // record the outcome so status, begin and the day's report agree with the site.
    if (!dryRun && done.where === 'state/history.json' && done.tier) {
      const rs = await optional('./lib/runstate.mjs');
      const run = rs?.loadRun ? rs.loadRun(day) : null;
      if (run && run.status !== 'published' && rs.finishRun) {
        try {
          const base = String(config.siteUrl ?? '').replace(/\/?$/, '/');
          const fin = rs.finishRun({ status: 'published', tier: done.tier, url: `${base}${done.path ?? `d/${day}-${done.slug}/`}`, by: 'deadman', date: day, now: instant, config });
          out.recordedRun = { ok: fin.ok, action: fin.action };
          if (!fin.ok) warnings.push(`run file not marked published: ${fin.error}`);
        } catch (err) {
          warnings.push(`could not mark the run published: ${message(err)}`);
        }
      }
    }
    if (git && !dryRun && (await pendingPublication())) {
      out.recovered = await pushChanges({ summary: `deadman: push pending publication for ${day}`, noSleep, warnings });
      out.ok = out.recovered.ok;
    }
    return { ...out, warnings };
  }

  // A past date counts as end of day, a future one as start of day (same rule the run-state decision table uses).
  const minutes = local.date === day ? local.minutes : local.date > day ? 24 * 60 : 0;
  const { staleAfter, hardStop } = deadmanThresholds(config);
  if (!force && minutes < hardStop) {
    if (minutes < staleAfter) {
      return { ok: true, action: 'none', reason: 'too-early', date: day, time: local.time, notBefore: clock(staleAfter), warnings };
    }
    const lease = await leaseView({ config, day, instant, git: git && !dryRun });
    if (lease.alive) {
      return { ok: true, action: 'none', reason: 'lease-alive', date: day, time: local.time, notBefore: clock(hardStop), lease, warnings };
    }
  }

  const wantTier = ideasAvailable(day) ? 3 : 4;
  if (dryRun) {
    return {
      ok: true,
      action: 'dry-run',
      date: day,
      forced: force,
      wouldPublish: { tier: wantTier, slug: wantTier === 3 ? 'ideas-day' : 'postcard', path: `docs/d/${day}-${wantTier === 3 ? 'ideas-day' : 'postcard'}/` },
      git,
      warnings,
    };
  }

  // The run file: take the lease so a still-alive primary sees a ship-now directive and stops writing.
  const rs = await optional('./lib/runstate.mjs');
  const th = await optional('./lib/throttle.mjs');
  let runAction = null;
  if (rs?.beginRun) {
    try {
      const role = minutes >= hm(config.tierCutoffs.t3Until) ? 'closer' : 'manual';
      // state.mjs begin records the current throttle level in every run it creates; so must this (CONTRACT 5.8 "throttle").
      const throttleLevel = th?.getThrottle ? th.getThrottle(config).level : config.budget.level;
      const begun = rs.beginRun({ role, session: SESSION, date: day, now: instant, config, throttleLevel, flags: { targetTier: wantTier, force: true, reopenUnbacked: true } });
      runAction = begun.action;
      if (begun.action === 'exit-published') {
        return { ok: true, action: 'none', reason: 'already-published', date: day, tier: begun.run?.tier ?? null, where: `state/runs/${day}.json`, warnings };
      }
    } catch (err) {
      warnings.push(`could not update the run file: ${message(err)}`);
    }
  } else warnings.push('runstate is not available; the run file was not updated');

  let result = null;
  let degradedFrom = null;
  if (wantTier === 3) {
    try {
      result = await ideasDay({ date: day, now: instant });
    } catch (err) {
      degradedFrom = 3;
      warnings.push(`Ideas Day failed (${message(err)}); falling back to the Postcard`);
    }
  }
  if (!result || (!result.ok && result.action !== 'refused')) {
    if (result && !result.ok) {
      degradedFrom = 3;
      warnings.push(`Ideas Day was not published (${result.error}); falling back to the Postcard`);
    }
    try {
      result = await postcard({ date: day, now: instant });
    } catch (err) {
      return { ok: false, action: 'failed', date: day, error: `no fallback page could be generated: ${message(err)}`, degradedFrom, warnings };
    }
  }
  if (!result.ok) {
    return { ok: true, action: 'none', reason: 'better-tier-published', date: day, tier: result.tier, detail: result.error, warnings };
  }
  warnings.push(...(result.warnings ?? []));

  let siteBuilt = false;
  const site = await optional('./build-site.mjs');
  if (site?.buildSite) {
    try {
      const built = await site.buildSite({ now: instant });
      siteBuilt = built.ok;
      if (!built.ok) warnings.push(`build-site failed: ${built.error}`);
      for (const o of built.omitted ?? []) warnings.push(`build-site omitted ${o.path}: ${o.errors.join('; ')}`);
    } catch (err) {
      warnings.push(`build-site crashed: ${message(err)}`);
    }
  } else warnings.push('build-site is not available; the gallery was not rebuilt');

  const base = String(config.siteUrl ?? '').replace(/\/?$/, '/');
  const url = `${base}${result.path.replace(/^docs\//, '')}`;
  let run = null;
  if (rs?.finishRun) {
    try {
      run = rs.finishRun({ status: 'published', tier: result.tier, url, by: 'deadman', date: day, now: instant, config });
      rs.eventRun({ kind: 'degrade', msg: `deadman published tier ${result.tier} (${result.slug}) at ${local.time}${degradedFrom ? `, degraded from tier ${degradedFrom}` : ''}`, by: 'deadman', date: day, now: instant, config });
      if (!run.ok) warnings.push(`run file not marked published: ${run.error}`);
    } catch (err) {
      warnings.push(`could not mark the run published: ${message(err)}`);
    }
  }
  try {
    notice({ date: day, reason: `deadman published tier ${result.tier} (${result.slug}) at ${local.time}${force ? ' (forced)' : ''}`, now: instant });
  } catch (err) {
    warnings.push(`could not write the fallback notice: ${message(err)}`);
  }

  const out = {
    ok: true,
    action: 'published',
    date: day,
    tier: result.tier,
    slug: result.slug,
    path: result.path,
    url,
    forced: force,
    siteBuilt,
    runAction,
    run: run ? { ok: run.ok, action: run.action } : null,
    degradedFrom,
    warnings,
  };
  if (git) {
    out.sync = await pushChanges({ summary: `deadman: tier ${result.tier} fallback (${result.slug}) for ${day}`, noSleep, warnings });
    if (!out.sync.ok) {
      out.ok = false;
      out.error = `the page was generated locally but could not be pushed: ${out.sync.reason}`;
    }
  }
  return out;
}

async function main() {
  const flags = parseArgs();
  let now;
  try {
    now = resolveNow(flags);
  } catch (err) {
    die(err.message, 2);
  }
  if (flags.date !== undefined && (typeof flags.date !== 'string' || !DATE_RE.test(flags.date))) die(`bad --date value: ${flags.date}`, 2);
  try {
    const result = await deadman({
      force: Boolean(flags.force),
      now,
      date: flags.date,
      git: !flags['no-git'],
      dryRun: Boolean(flags['dry-run']),
      noSleep: Boolean(flags['no-sleep']),
    });
    for (const w of result.warnings ?? []) process.stderr.write(`warning: ${w}\n`);
    print(result);
    process.exitCode = result.ok ? 0 : 1;
  } catch (err) {
    die(message(err), 1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
