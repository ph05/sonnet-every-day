// Run-state engine (CONTRACT 5.8, 6.1, 7): the run file, the lease, the resilience
// decision table and every mutation of state/runs/<date>.json.
//
// Design rules:
//  * decide() and applyDecision() are pure. All I/O (locking, reading, writing, cleaning
//    staging dirs) lives in the *Run() commands below, always inside the per-date lock.
//  * Every write goes through writeJsonAtomic (temp file + rename): a half-written run
//    file can never exist, even if the process is killed mid-write.
//  * A run file that cannot be parsed is quarantined as <date>.json.corrupt-<n> and the
//    day restarts from scratch with an explanatory event.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { rp, readJson, writeJsonAtomic, loadConfig, localParts, hm } from './common.mjs';

export const PHASES = ['preflight', 'ideate', 'select', 'spec', 'build', 'qa', 'revise', 'package', 'publish', 'done'];
export const ROLES = ['primary', 'wdA', 'wdB', 'closer', 'manual'];
export const STATUSES = ['in_progress', 'published', 'failed'];
export const EVENT_KINDS = ['note', 'error', 'takeover', 'degrade', 'rate-limit', 'budget'];
export const DIRECTIVE_KINDS = ['scope-cut', 'ship-now'];
export const MAX_EVENTS = 200;

// Phases a run walks through per target tier. Tier 3 (Ideas Day) needs the ideas but
// nothing built; tier 4 (Postcard) needs nothing at all.
const TIER_PHASES = {
  1: PHASES,
  2: PHASES,
  3: ['preflight', 'ideate', 'package', 'publish', 'done'],
  4: ['package', 'publish', 'done'],
};
// Phases whose work lands in work/<date>/<dir>/ and is wiped when a takeover restarts them.
const STAGING_DIRS = {
  ideate: ['ideate', 'ideas'],
  select: ['select'],
  spec: ['spec'],
  build: ['build'],
  qa: ['qa'],
  revise: ['revise'],
};
const WD_A_BEHIND_FROM = '05:30'; // CONTRACT 7 row 5: wdA flags a primary still in ideate from 05:30
const WD_A_BEHIND_PHASES = ['preflight', 'ideate'];
const WD_B_SCOPE_PHASES = ['preflight', 'ideate', 'select', 'spec'];
const HEARTBEAT_FUTURE_SLACK_MS = 10 * 60 * 1000; // ignore heartbeat stamps from a badly skewed clock
const UPGRADE_CUTOFF_MINUTES = 23 * 60 + 59;
const MANUAL_STUCK_FACTOR = 2;
// A validated package of a finished build takes about 12 minutes (planner TYPICAL); keep slack before the deadline.
const RESCUE_PACKAGE_MARGIN_MINUTES = 20;

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    this.exitCode = 2;
  }
}
export class StateError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'StateError';
    this.exitCode = 1;
    this.extra = extra;
  }
}

// ---------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const round1 = (n) => Math.round(n * 10) / 10;

export function assertDate(date) {
  const parsed = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00Z`) : null;
  // round-trip catches impossible dates such as 2026-02-31 that Date would silently roll over
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new UsageError(`bad date "${date}" (expected a real calendar date YYYY-MM-DD)`);
  }
  return date;
}

export function toDate(value) {
  if (value instanceof Date) return value;
  if (value === undefined || value === null) return new Date();
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new UsageError(`bad time value "${value}"`);
  return d;
}

export function clampTier(value, label = 'tier') {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 4) throw new UsageError(`${label} must be an integer 1..4 (got "${value}")`);
  return n;
}

export function assertIdentity(role, session) {
  if (!ROLES.includes(role)) throw new UsageError(`unknown role "${role}" (expected ${ROLES.join('|')})`);
  if (typeof session !== 'string' || !session.trim()) throw new UsageError('a non-empty --session id is required');
}

export function assertPhase(phase) {
  if (!PHASES.includes(phase)) throw new UsageError(`unknown phase "${phase}" (expected ${PHASES.join('|')})`);
  return phase;
}

/** Synchronous sleep (CLI code is synchronous; Atomics.wait is allowed on Node's main thread). */
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));
export function sleepSync(ms) {
  Atomics.wait(SLEEP_CELL, 0, 0, Math.max(0, ms));
}

// ---------------------------------------------------------------------------------------
// lockfile: O_EXCL create, stale-lock breaking, bounded wait
// ---------------------------------------------------------------------------------------

function lockOptions(o = {}) {
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    staleMs: num(o.staleMs ?? process.env.SED_LOCK_STALE_MS, 30_000),
    waitMs: num(o.waitMs ?? process.env.SED_LOCK_WAIT_MS, 45_000), // must exceed staleMs or a dead holder is never broken
    pollMs: num(o.pollMs, 25),
  };
}

function breakIfStale(lockPath, staleMs) {
  let st;
  try {
    st = fs.statSync(lockPath);
  } catch {
    return;
  }
  if (Date.now() - st.mtimeMs <= staleMs) return;
  const graveyard = `${lockPath}.stale.${process.pid}.${Date.now()}`;
  try {
    fs.renameSync(lockPath, graveyard); // exactly one breaker wins the rename
  } catch {
    return;
  }
  // Between our stat and the rename someone may have replaced the stale lock with a fresh one.
  // If what we moved is fresh, put it back.
  try {
    if (Date.now() - fs.statSync(graveyard).mtimeMs <= staleMs) fs.linkSync(graveyard, lockPath);
  } catch {
    /* nothing sensible left to do */
  }
  try {
    fs.unlinkSync(graveyard);
  } catch {
    /* already gone */
  }
}

export function acquireLock(lockPath, options) {
  const { staleMs, waitMs, pollMs } = lockOptions(options);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const token = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }));
      } finally {
        fs.closeSync(fd);
      }
      return { path: lockPath, token };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    breakIfStale(lockPath, staleMs);
    if (Date.now() >= deadline) {
      throw new StateError(`could not acquire lock ${lockPath} within ${waitMs} ms (another process holds it)`);
    }
    sleepSync(pollMs + Math.floor(Math.random() * pollMs));
  }
}

export function releaseLock(lock) {
  try {
    const current = JSON.parse(fs.readFileSync(lock.path, 'utf8'));
    if (current.token !== lock.token) return; // our lock was declared stale and replaced; leave the new owner's file alone
    fs.unlinkSync(lock.path);
  } catch {
    /* already released */
  }
}

export function withLock(lockPath, fn, options) {
  const lock = acquireLock(lockPath, options);
  try {
    return fn();
  } finally {
    releaseLock(lock);
  }
}

// ---------------------------------------------------------------------------------------
// paths and file access
// ---------------------------------------------------------------------------------------

export const runDir = () => rp('state', 'runs');
export const runPath = (date) => path.join(runDir(), `${assertDate(date)}.json`);
export const runLockPath = (date) => path.join(runDir(), `.${assertDate(date)}.lock`);

/**
 * One heartbeat file per (date, session): a zombie session's pulse and the new holder's pulse can never
 * overwrite each other. Session ids are reduced to a filesystem-safe name; a lossy reduction gets a hash
 * suffix so two different ids never share a file.
 */
export function heartbeatName(session) {
  const raw = String(session ?? '');
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.{2,}/g, '_').replace(/^\./, '_').slice(0, 80);
  if (safe === raw && safe) return safe;
  return `${safe || 'session'}-${crypto.createHash('sha1').update(raw).digest('hex').slice(0, 8)}`;
}
export const heartbeatRel = (date, session) => path.join('state', 'heartbeats', assertDate(date), `${heartbeatName(session)}.json`);
export const heartbeatPath = (date, session) => rp(heartbeatRel(date, session));

function normalizeRun(raw, date) {
  if (!isObj(raw)) throw new Error('not a JSON object');
  if (raw.schema !== 1) throw new Error(`unsupported schema ${JSON.stringify(raw.schema)}`);
  if (raw.date !== date) throw new Error(`date mismatch (file says ${JSON.stringify(raw.date)})`);
  if (!STATUSES.includes(raw.status)) throw new Error(`bad status ${JSON.stringify(raw.status)}`);
  if (!PHASES.includes(raw.phase)) throw new Error(`bad phase ${JSON.stringify(raw.phase)}`);
  if (!Number.isInteger(raw.targetTier) || raw.targetTier < 1 || raw.targetTier > 4) {
    throw new Error(`bad targetTier ${JSON.stringify(raw.targetTier)}`);
  }
  const run = { ...raw };
  run.tier = Number.isInteger(raw.tier) ? raw.tier : null;
  run.phasesDone = Array.isArray(raw.phasesDone) ? raw.phasesDone.filter((e) => isObj(e) && typeof e.phase === 'string') : [];
  run.attempts = isObj(raw.attempts) ? raw.attempts : {};
  run.phaseStartedAt = isObj(raw.phaseStartedAt) ? raw.phaseStartedAt : {};
  run.lease = isObj(raw.lease) && typeof raw.lease.session === 'string' ? raw.lease : null;
  run.directives = Array.isArray(raw.directives) ? raw.directives.filter(isObj) : [];
  run.chosen = isObj(raw.chosen) ? raw.chosen : null;
  run.throttle = typeof raw.throttle === 'string' ? raw.throttle : null;
  const spend = isObj(raw.spend) ? raw.spend : {};
  run.spend = {
    ...spend,
    outputTokens: Number(spend.outputTokens) || 0,
    agentCalls: Number(spend.agentCalls) || 0,
    byPhase: isObj(spend.byPhase) ? spend.byPhase : {},
  };
  run.publishedAt = raw.publishedAt ?? null;
  run.publishedUrl = raw.publishedUrl ?? null;
  run.events = Array.isArray(raw.events) ? raw.events.filter(isObj) : [];
  return run;
}

/** Parses and validates run-file text (a working-tree file or a blob read from git). Returns null when it is not a usable run for `date`. */
export function parseRunText(text, date) {
  try {
    return normalizeRun(JSON.parse(text), date);
  } catch {
    return null;
  }
}

/** Reads and validates a run file. Never throws for bad content; reports `corrupt` instead. */
export function readRunFile(date) {
  const file = runPath(date);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { status: 'missing', run: null };
    return { status: 'corrupt', run: null, error: `unreadable: ${err.message}` };
  }
  try {
    return { status: 'ok', run: normalizeRun(JSON.parse(text), date) };
  } catch (err) {
    return { status: 'corrupt', run: null, error: err.message };
  }
}

/** Read-only convenience for other components: the run, or null if missing or corrupt. */
export function loadRun(date) {
  return readRunFile(date).run;
}

/** The liveness record `session` last pushed for `date`, or null. */
export function loadHeartbeat(date, session) {
  if (typeof session !== 'string' || !session) return null;
  return validHeartbeat(readJson(heartbeatPath(date, session), null), session);
}

export function validHeartbeat(hb, session) {
  return isObj(hb) && hb.session === session && typeof hb.at === 'string' ? hb : null;
}

/** The fresher of two heartbeat records (either may be null). */
export function latestHeartbeat(a, b) {
  if (!a || !b) return a ?? b ?? null;
  return Date.parse(b.at) > Date.parse(a.at) ? b : a;
}

export function saveRun(run) {
  if (run.events.length > MAX_EVENTS) run.events = run.events.slice(-MAX_EVENTS);
  writeJsonAtomic(runPath(run.date), run);
}

/** Moves an unreadable run file aside as <date>.json.corrupt-<n> (never overwriting an earlier one). */
function quarantine(date) {
  const file = runPath(date);
  for (let n = 1; ; n++) {
    const dest = `${file}.corrupt-${n}`;
    try {
      fs.linkSync(file, dest); // fails with EEXIST rather than clobbering
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    fs.unlinkSync(file);
    return dest;
  }
}

/**
 * Locks the date, loads its run, lets `mutate(run)` change it, saves.
 * `mutate` returns { run?, result }: omit `run` to leave the file untouched.
 */
export function updateRun(date, mutate) {
  return withLock(runLockPath(date), () => {
    const read = readRunFile(date);
    if (read.status === 'missing') throw new StateError(`no run file for ${date}; run \`state.mjs begin\` first`);
    if (read.status === 'corrupt') {
      throw new StateError(`run file for ${date} is corrupt (${read.error}); run \`state.mjs begin\` to quarantine and recreate it`);
    }
    const out = mutate(read.run);
    if (out.run) saveRun(out.run);
    return out.result;
  });
}

export function pushEvent(run, kind, msg, by, at) {
  run.events.push({ at, by, kind, msg });
  if (run.events.length > MAX_EVENTS) run.events = run.events.slice(-MAX_EVENTS);
}

// ---------------------------------------------------------------------------------------
// time and tiers
// ---------------------------------------------------------------------------------------

/**
 * Minutes after local midnight on `date`. For any date other than "today" the clock is
 * meaningless, so a past date counts as end of day (deadline long gone) and a future date as start of day.
 */
export function effectiveMinutes(config, now, date) {
  const lp = localParts(now, config.timezone);
  if (lp.date === date) return lp.minutes;
  return lp.date > date ? 24 * 60 : 0;
}

export function tierByMinutes(config, minutes) {
  const c = config.tierCutoffs;
  if (minutes < hm(c.t1Until)) return 1;
  if (minutes < hm(c.t2Until)) return 2;
  if (minutes < hm(c.t3Until)) return 3;
  return 4;
}

export const relevantPhases = (tier) => TIER_PHASES[tier] ?? PHASES;
export const doneNames = (run) => (run?.phasesDone ?? []).map((e) => e.phase);

/** First phase of the tier's path that is not done yet. */
export function firstPending(tier, done) {
  const set = new Set(done);
  const list = relevantPhases(tier);
  const laterWork = list.some((p) => p !== 'preflight' && set.has(p));
  for (const p of list) {
    if (set.has(p)) continue;
    if (p === 'preflight' && laterWork) continue; // later work only exists if preflight happened
    return p;
  }
  return 'done';
}

export function stagingDirs(phase) {
  return STAGING_DIRS[phase] ?? [];
}

// ---------------------------------------------------------------------------------------
// lease inspection
// ---------------------------------------------------------------------------------------

function phaseStartMs(run) {
  const direct = Date.parse(run.phaseStartedAt?.[run.phase]);
  if (Number.isFinite(direct)) return direct;
  const last = run.phasesDone[run.phasesDone.length - 1];
  const fromDone = Date.parse(last?.at);
  if (Number.isFinite(fromDone)) return fromDone;
  const acquired = Date.parse(run.lease?.acquiredAt);
  return Number.isFinite(acquired) ? acquired : null;
}

/**
 * Liveness of the lease. Last sign of life = latest of lease.heartbeatAt and the out-of-process
 * heartbeat file (when it belongs to the same session). `stale` = silent for leaseStaleMinutes;
 * `stuck` = the current phase has run longer than phaseStuckMinutes (a hung orchestrator with a
 * live heartbeat is still dead).
 */
export function leaseInfo(config, run, heartbeat, nowMs) {
  const lease = run?.lease ?? null;
  if (!lease) {
    return { present: false, holder: null, session: null, stale: true, stuck: false, stuckLimitMinutes: config.phaseStuckMinutes, ageMinutes: null, phaseMinutes: null, lastBeatAt: null, source: null };
  }
  const own = Date.parse(lease.heartbeatAt ?? lease.acquiredAt);
  let last = Number.isFinite(own) ? own : 0;
  let source = 'lease';
  if (heartbeat && heartbeat.session === lease.session) {
    const t = Date.parse(heartbeat.at);
    if (Number.isFinite(t) && t <= nowMs + HEARTBEAT_FUTURE_SLACK_MS && t > last) {
      last = t;
      source = 'heartbeat-file';
    }
  }
  const ageMinutes = last > 0 ? Math.max(0, (nowMs - last) / 60000) : Infinity;
  const stale = !(ageMinutes <= config.leaseStaleMinutes);
  const start = phaseStartMs(run);
  const phaseMinutes = start === null ? null : Math.max(0, (nowMs - start) / 60000);
  // A human-supervised manual run has no deadline pressure and legitimately spends long in one phase.
  const stuckLimit = config.phaseStuckMinutes * (lease.holder === 'manual' ? MANUAL_STUCK_FACTOR : 1);
  const stuck = run.status === 'in_progress' && run.phase !== 'done' && phaseMinutes !== null && phaseMinutes > stuckLimit;
  return {
    present: true,
    holder: lease.holder,
    session: lease.session,
    stale,
    stuck,
    stuckLimitMinutes: stuckLimit,
    ageMinutes: Number.isFinite(ageMinutes) ? round1(ageMinutes) : null,
    phaseMinutes: phaseMinutes === null ? null : round1(phaseMinutes),
    lastBeatAt: last > 0 ? new Date(last).toISOString() : null,
    source: last > 0 ? source : null,
  };
}

const isSelf = (lease, role, session) => Boolean(lease) && lease.session === session && lease.holder === role;

// ---------------------------------------------------------------------------------------
// the decision table (CONTRACT 7)
// ---------------------------------------------------------------------------------------

function nextTierDown(phase, tier, hasIdeate) {
  let t = Math.min(4, tier + 1);
  // If the package/publish step itself keeps failing the build is the problem: go straight to a fallback page.
  if (phase === 'package' || phase === 'publish') t = Math.max(t, hasIdeate ? 3 : 4);
  if (t === 3 && !hasIdeate) t = 4; // an Ideas Day cannot be made from ideas that were never produced
  return t;
}

/**
 * A finished build (`build` done) can still be packaged as a Tier-2 page, skipping QA and revise, while there is
 * time left and the package step has not already failed. Throwing a built site away because QA flaked or the
 * clock passed 06:45 would waste the day's real work; the Ideas Day is the fallback for a failed package.
 */
export function rescuePackageAvailable(config, run, minutes) {
  if (!run || run.targetTier > 2) return false;
  if (!doneNames(run).includes('build')) return false;
  if ((run.attempts?.package ?? 0) >= config.maxAttemptsPerPhase) return false;
  return minutes <= hm(config.schedule.deadline) - RESCUE_PACKAGE_MARGIN_MINUTES;
}

/** QA / revise phases that a package-now resume leaves undone: they are recorded as skipped so `next` never walks back to them. */
function skippedBefore(resume, tier, done) {
  const list = relevantPhases(tier);
  const at = list.indexOf(resume);
  return ['qa', 'revise'].filter((p) => list.indexOf(p) !== -1 && list.indexOf(p) < at && !done.includes(p));
}

/**
 * Picks the tier and phase a takeover/resume continues at, degrading when a phase keeps failing.
 * `rescue` (not for manual runs, which choose their own tier) lets a finished build be packaged at Tier 2 even
 * when the clock alone would say Tier 3 or 4.
 */
function settle(config, run, baseTier, { minutes, rescue = true }) {
  const done = doneNames(run);
  const hasIdeate = done.includes('ideate');
  let tier = baseTier;
  let resume;
  let degrade = null;
  const notes = [];
  if (rescue && tier >= 3 && rescuePackageAvailable(config, run, minutes)) {
    notes.push(`build is done and ${hm(config.schedule.deadline) - minutes} min remain: packaging it as tier 2 (QA/revise skipped) instead of tier ${tier}`);
    tier = 2;
    resume = 'package';
  } else {
    resume = firstPending(tier, done);
  }
  const attempts = run.attempts?.[resume] ?? 0;
  if (resume !== 'done' && attempts >= config.maxAttemptsPerPhase) {
    const stuckPhase = resume;
    if ((resume === 'qa' || resume === 'revise') && done.includes('build')) {
      // ship what exists rather than loop on QA: a real build is packaged as (at best) a compact Tier-2 page, never discarded
      const from = tier;
      tier = Math.min(2, tier + 1);
      resume = 'package';
      degrade = `${stuckPhase} already attempted ${attempts}x (max ${config.maxAttemptsPerPhase}): skipping QA/revise, packaging the built site (tier ${from} -> ${tier})`;
    } else if (resume === 'package' && tier >= 3 && hasIdeate && run.targetTier <= 2 && done.includes('build')) {
      // the failed attempts were the real build's package; the Ideas Day is a different (model-free) package, so it still gets its try
      degrade = `package of the built site failed ${attempts}x: falling back to the Ideas Day`;
    } else {
      const from = tier;
      tier = nextTierDown(resume, tier, hasIdeate);
      if (tier >= 3) resume = firstPending(tier, done);
      else if (resume === 'qa' || resume === 'revise') resume = 'package';
      degrade = `${stuckPhase} already attempted ${attempts}x (max ${config.maxAttemptsPerPhase}): degrading tier ${from} -> ${tier}, continuing at ${resume}`;
    }
  }
  const skipPhases = resume === 'package' && tier <= 2 ? skippedBefore('package', tier, done) : [];
  return { tier, resume, degrade, notes, skipPhases };
}

const sameDirective = (a, kind, tier) => a.kind === kind && a.tier === tier;
const newDirectives = (run, wanted) => wanted.filter((w) => !run.directives.some((d) => sameDirective(d, w.kind, w.tier)));

const plan = (p) => ({
  create: false,
  takeLease: false,
  setPhase: false,
  clearFailed: false,
  ackDirectives: false,
  cleanPhase: null,
  skipPhases: [],
  builtSiteAvailable: false,
  events: [],
  directives: [],
  changed: false,
  ...p,
});

/**
 * Pure. Decides what an unattended session in `role` should do right now.
 * input: { role, session, now, date, config?, run?, heartbeat?, throttleLevel?, flags?: { targetTier, force } }
 * When config / run / heartbeat are omitted they are read from disk (CONTRACT 6 signature), pass
 * `run: null` to mean "no run file". Returns the action plus the mutations begin must apply.
 */
export function decide(input) {
  const config = input.config ?? loadConfig();
  const { role, session } = input;
  assertIdentity(role, session);
  const now = toDate(input.now);
  const date = assertDate(input.date ?? localParts(now, config.timezone).date);
  const run = input.run === undefined ? loadRun(date) : input.run;
  const heartbeat = input.heartbeat === undefined ? loadHeartbeat(date, run?.lease?.session) : input.heartbeat;
  const flags = input.flags ?? {};
  const nowMs = now.getTime();
  const clock = localParts(now, config.timezone).time;
  const minutes = effectiveMinutes(config, now, date);
  const byTime = tierByMinutes(config, minutes);
  const level = input.throttleLevel ?? run?.throttle ?? config.budget.level;
  const forcedByLevel = config.budget.levels?.[level]?.forceTier ?? 1;
  const manual = role === 'manual';
  const startTier = Math.max(manual ? clampTier(flags.targetTier ?? 1, '--target-tier') : byTime, forcedByLevel);
  const base = { role, date, minutes, builtSiteAvailable: doneNames(run).includes('build') };

  // 1. published: never redo.
  if (run?.status === 'published') {
    return plan({
      ...base,
      action: 'exit-published',
      targetTier: run.targetTier,
      resumePhase: null,
      reason: `already published (tier ${run.tier ?? '?'}) at ${run.publishedAt ?? '?'}; only \`finish\` may upgrade it`,
    });
  }

  // 2. no run file: start one.
  if (!run) {
    return plan({
      ...base,
      action: 'proceed',
      create: true,
      takeLease: true,
      setPhase: true,
      changed: true,
      targetTier: startTier,
      resumePhase: firstPending(startTier, []),
      reason: manual
        ? `no run for ${date}; manual run at tier ${startTier}`
        : `no run for ${date}; starting at ${clock} => tier ${startTier} by time`,
      events: [{ kind: 'note', msg: `run created by ${role} (${session}) targeting tier ${startTier}` }],
    });
  }

  const info = leaseInfo(config, run, heartbeat, nowMs);
  const self = isSelf(run.lease, role, session);

  // 3. closer at/after the tier-3 cutoff: force the best fallback that is still possible.
  if (role === 'closer' && minutes >= hm(config.tierCutoffs.t3Until)) {
    // A finished build is packaged (Tier 2, QA skipped) while there is time; only otherwise fall back to Tier 3/4.
    const rescue = rescuePackageAvailable(config, run, minutes);
    const forced = rescue ? 2 : Math.max(doneNames(run).includes('ideate') ? 3 : 4, run.targetTier);
    if (self && run.status === 'in_progress' && run.targetTier >= forced) {
      return plan({
        ...base,
        action: 'resume',
        takeLease: true,
        changed: true,
        targetTier: run.targetTier,
        resumePhase: run.phase,
        reason: 'closer resuming its own forced degrade',
      });
    }
    const resumePhase = rescue ? 'package' : firstPending(forced, doneNames(run));
    const forcedWhat = rescue
      ? 'package the finished build as a compact page, QA skipped'
      : forced === 3
        ? 'Ideas Day from the researched ideas'
        : 'Postcard, no ideas exist';
    return plan({
      ...base,
      action: 'force-degrade',
      takeLease: true,
      setPhase: true,
      clearFailed: true,
      changed: true,
      targetTier: forced,
      resumePhase,
      skipPhases: rescue ? skippedBefore('package', 2, doneNames(run)) : [],
      reason: `closer at ${clock} (past ${config.tierCutoffs.t3Until}): forcing tier ${forced} (${forcedWhat})`,
      events: [
        {
          kind: 'degrade',
          msg: `closer forced tier ${forced} at ${clock}; took the lease from ${run.lease ? `${run.lease.holder}/${run.lease.session}` : 'nobody'}`,
        },
      ],
      directives: newDirectives(run, [{ kind: 'ship-now', tier: forced }]),
    });
  }

  // 4. failed run, or nobody alive behind the lease: take over (or resume if it is me).
  const otherStuck = info.present && !self && info.stuck;
  if (run.status === 'failed' || !info.present || info.stale || otherStuck) {
    // manual ignores the clock and uses its explicit target; everyone else never improves on the previous target
    const baseTier = manual ? startTier : Math.max(run.targetTier, byTime, forcedByLevel);
    const { tier, resume, degrade, notes, skipPhases } = settle(config, run, baseTier, { minutes, rescue: !manual });
    const why =
      run.status === 'failed'
        ? 'run was marked failed'
        : !info.present
          ? 'no lease'
          : otherStuck && !info.stale
            ? `phase ${run.phase} has run ${info.phaseMinutes} min (> ${info.stuckLimitMinutes}) although the heartbeat is fresh`
            : `lease of ${info.holder}/${info.session} is stale (${info.ageMinutes === null ? 'never beat' : `${info.ageMinutes} min`} > ${config.leaseStaleMinutes})`;
    const events = [];
    events.push(
      self
        ? { kind: 'note', msg: `${role} (${session}) resumed its own ${run.status === 'failed' ? 'failed run' : 'stale lease'} at ${resume}, tier ${tier}` }
        : {
            kind: 'takeover',
            msg: `${role} (${session}) took over from ${run.lease ? `${run.lease.holder}/${run.lease.session}` : 'nobody'}: ${why}; continuing at ${resume}, tier ${tier}`,
          },
    );
    for (const n of notes) events.push({ kind: 'degrade', msg: n });
    if (degrade) events.push({ kind: 'degrade', msg: degrade });
    return plan({
      ...base,
      action: self ? 'resume' : 'takeover',
      takeLease: true,
      setPhase: true,
      clearFailed: true,
      ackDirectives: true,
      changed: true,
      targetTier: tier,
      resumePhase: resume,
      skipPhases,
      cleanPhase: self ? null : resume,
      reason: `${why}; ${self ? 'resuming' : 'taking over'} at ${resume} with tier ${tier}`,
      events,
    });
  }

  // 5. someone else holds a fresh lease.
  if (!self) {
    if (manual && flags.force) {
      const { tier, resume, degrade, skipPhases } = settle(config, run, startTier, { minutes, rescue: false });
      const events = [
        {
          kind: 'takeover',
          msg: `manual run (${session}) FORCED a takeover from fresh holder ${info.holder}/${info.session}; continuing at ${resume}, tier ${tier}`,
        },
      ];
      if (degrade) events.push({ kind: 'degrade', msg: degrade });
      return plan({
        ...base,
        action: 'takeover',
        takeLease: true,
        setPhase: true,
        ackDirectives: true,
        changed: true,
        targetTier: tier,
        resumePhase: resume,
        skipPhases,
        cleanPhase: resume,
        reason: `forced over a fresh lease held by ${info.holder}/${info.session}`,
        events,
      });
    }
    const wanted = [];
    if (role === 'wdB' && WD_B_SCOPE_PHASES.includes(run.phase) && minutes >= hm(config.tierCutoffs.t2Until)) {
      wanted.push({ kind: 'scope-cut', tier: 2 });
    }
    if (role === 'wdA' && WD_A_BEHIND_PHASES.includes(run.phase) && minutes >= hm(WD_A_BEHIND_FROM)) {
      wanted.push({ kind: 'scope-cut', tier: 2 });
    }
    const directives = newDirectives(run, wanted);
    const note = directives.length ? '; scope-cut directive left for it' : wanted.length ? '; scope-cut directive already pending' : '';
    return plan({
      ...base,
      action: 'exit-alive',
      changed: false,
      targetTier: run.targetTier,
      resumePhase: null,
      reason: `${info.holder}/${info.session} holds a fresh lease (last sign of life ${info.ageMinutes} min ago, phase ${run.phase}${info.phaseMinutes === null ? '' : `, ${info.phaseMinutes} min in it`})${note}`,
      directives,
    });
  }

  // 6. fresh lease, mine: just continue.
  return plan({
    ...base,
    action: 'resume',
    takeLease: true,
    changed: true,
    targetTier: run.targetTier,
    resumePhase: run.phase,
    reason: `resuming own lease at ${run.phase}`,
  });
}

function addDirective(run, { kind, tier }, by, at) {
  if (run.directives.some((d) => sameDirective(d, kind, tier))) return false;
  run.directives.push({ kind, tier, by, at, ack: false });
  if (tier > run.targetTier) run.targetTier = tier;
  return true;
}

/** Pure. Applies a decide() plan to a run (or creates one) and returns the new run object. */
export function applyDecision(run, p, ctx) {
  const { role, session, nowIso, date, throttleLevel } = ctx;
  let r;
  if (p.create) {
    r = {
      schema: 1,
      date,
      status: 'in_progress',
      targetTier: p.targetTier,
      tier: null,
      phase: p.resumePhase,
      phasesDone: [],
      attempts: {},
      phaseStartedAt: {},
      lease: null,
      directives: [],
      chosen: null,
      throttle: throttleLevel,
      spend: { outputTokens: 0, agentCalls: 0, byPhase: {} },
      publishedAt: null,
      publishedUrl: null,
      createdAt: nowIso,
      events: [],
    };
  } else {
    r = structuredClone(run);
  }
  if (p.takeLease) {
    const keepAcquired = isSelf(r.lease, role, session);
    r.lease = {
      holder: role,
      session,
      acquiredAt: keepAcquired ? r.lease.acquiredAt : nowIso,
      heartbeatAt: nowIso,
    };
  }
  if (p.clearFailed && r.status === 'failed') r.status = 'in_progress';
  if (p.ackDirectives) for (const d of r.directives) d.ack = true;
  if (p.setPhase) {
    r.targetTier = p.targetTier;
    r.phase = p.resumePhase;
    r.phaseStartedAt[p.resumePhase] = nowIso;
  }
  for (const phase of p.skipPhases) {
    if (!r.phasesDone.some((e) => e.phase === phase)) r.phasesDone.push({ phase, at: nowIso, by: role, note: 'skipped: finished build is packaged without it' });
  }
  if (throttleLevel && p.changed) r.throttle = throttleLevel;
  for (const e of p.events) pushEvent(r, e.kind, e.msg, role, nowIso);
  for (const d of p.directives) {
    if (addDirective(r, d, role, nowIso)) {
      pushEvent(r, 'note', `${d.kind} directive (tier ${d.tier}) issued by ${role}`, role, nowIso);
    }
  }
  return r;
}

// ---------------------------------------------------------------------------------------
// merging two writers of one run file (git is the only arbiter between containers)
// ---------------------------------------------------------------------------------------

const ms = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};

function unionBy(items, keyOf, combine) {
  const map = new Map();
  for (const item of items) {
    const key = keyOf(item);
    map.set(key, map.has(key) ? combine(map.get(key), item) : item);
  }
  return [...map.values()];
}

/** 3-way sum for a counter: what the base had plus what each side added. */
const mergeCounter = (base, remote, local) => Math.max(0, (base ?? 0) + ((remote ?? 0) - (base ?? 0)) + ((local ?? 0) - (base ?? 0)));

function mergeSpend(base, remote, local) {
  const phases = new Set([...Object.keys(remote.byPhase), ...Object.keys(local.byPhase)]);
  const byPhase = {};
  for (const phase of phases) {
    const b = base?.byPhase?.[phase];
    const r = remote.byPhase[phase];
    const l = local.byPhase[phase];
    byPhase[phase] = {
      outputTokens: mergeCounter(b?.outputTokens, r?.outputTokens, l?.outputTokens),
      agentCalls: mergeCounter(b?.agentCalls, r?.agentCalls, l?.agentCalls),
    };
  }
  return {
    ...remote,
    ...local,
    outputTokens: mergeCounter(base?.outputTokens, remote.outputTokens, local.outputTokens),
    agentCalls: mergeCounter(base?.agentCalls, remote.agentCalls, local.agentCalls),
    byPhase,
  };
}

const isBetterPublication = (a, b) => a.status === 'published' && (b.status !== 'published' || (a.tier ?? 4) < (b.tier ?? 4));

/**
 * Pure 3-way merge of two versions of one run (`remote` = what the shared branch holds, `local` = what this
 * checkout holds, `base` = their common ancestor or null). Two containers can write the same day: the lease
 * decides who is authoritative for the phase machinery, while append-only data (events, directives,
 * phasesDone) is unioned and counters (spend) are summed against the base.
 *
 * Returns { displaced: true, remoteLease } when the REMOTE lease belongs to a different session and wins
 * (acquired later, or the remote got there first when both created the day): the local writer lost and must stop.
 * A local writer that holds a better published tier is never displaced (the late-finisher upgrade, CONTRACT 7).
 * Otherwise { displaced: false, run }.
 */
export function mergeRuns(base, remote, local) {
  const rl = remote.lease;
  const ll = local.lease;
  let holder;
  if (!rl || !ll) holder = rl ? 'remote' : 'local';
  else if (rl.session === ll.session) holder = ms(rl.heartbeatAt) > ms(ll.heartbeatAt) ? 'remote' : 'local';
  else if (!base) holder = 'remote'; // both created the day: the one that reached the branch first owns it
  else holder = ms(ll.acquiredAt) > ms(rl.acquiredAt) ? 'local' : 'remote';

  const differentSessions = Boolean(rl && ll && rl.session !== ll.session);
  if (differentSessions && holder === 'remote' && !isBetterPublication(local, remote)) {
    return { displaced: true, remoteLease: rl };
  }

  const win = holder === 'local' ? local : remote;
  const other = holder === 'local' ? remote : local;
  const out = structuredClone(win);
  const sameHolder = !differentSessions;

  out.directives = unionBy(
    [...remote.directives, ...local.directives],
    (d) => `${d.kind}:${d.tier}`,
    (a, b) => ({ ...a, ack: Boolean(a.ack || b.ack) }),
  );
  // a directive only the other side knows about still raises the target, exactly as issuing it would have
  for (const d of other.directives) {
    if (!win.directives.some((w) => w.kind === d.kind && w.tier === d.tier) && !d.ack && d.tier > out.targetTier) out.targetTier = d.tier;
  }
  out.events = unionBy([...remote.events, ...local.events], (e) => JSON.stringify(e), (a) => a)
    .sort((a, b) => ms(a.at) - ms(b.at))
    .slice(-MAX_EVENTS);
  if (sameHolder) {
    out.phasesDone = unionBy([...remote.phasesDone, ...local.phasesDone], (e) => e.phase, (a) => a).sort((a, b) => ms(a.at) - ms(b.at));
  }
  for (const [phase, n] of Object.entries(other.attempts)) out.attempts[phase] = Math.max(out.attempts[phase] ?? 0, Number(n) || 0);
  for (const [phase, at] of Object.entries(other.phaseStartedAt)) out.phaseStartedAt[phase] ??= at;
  out.spend = mergeSpend(base?.spend, remote.spend, local.spend);
  out.chosen = win.chosen ?? other.chosen;
  if (rl && ll && sameHolder) out.lease = { ...out.lease, heartbeatAt: ms(rl.heartbeatAt) > ms(ll.heartbeatAt) ? rl.heartbeatAt : ll.heartbeatAt };
  if (remote.replaced || local.replaced) {
    out.replaced = unionBy([...(remote.replaced ?? []), ...(local.replaced ?? [])], (r) => JSON.stringify(r), (a) => a);
  }

  // a published day stays published, at the better tier, whichever side said so
  if (remote.status === 'published' || local.status === 'published') {
    const pub = isBetterPublication(local, remote) || remote.status !== 'published' ? local : remote;
    Object.assign(out, {
      status: 'published',
      tier: pub.tier,
      publishedAt: pub.publishedAt,
      publishedUrl: pub.publishedUrl,
      phase: pub.phase,
    });
    if (!out.phasesDone.some((e) => e.phase === 'done')) out.phasesDone.push(...pub.phasesDone.filter((e) => e.phase === 'done'));
  }
  return { displaced: false, run: out };
}

// ---------------------------------------------------------------------------------------
// staging cleanup and DONE.json recovery
// ---------------------------------------------------------------------------------------

function stagingRoot(date) {
  return path.join(rp('work'), assertDate(date));
}

function doneMarker(date, phase) {
  return path.join(stagingRoot(date), phase, 'DONE.json');
}

function hasDoneMarker(date, phase) {
  if (!STAGING_DIRS[phase]) return false;
  const marker = readJson(doneMarker(date, phase), null);
  return isObj(marker) && marker.ok !== false;
}

function removeDoneMarker(date, phase) {
  if (!STAGING_DIRS[phase]) return;
  fs.rmSync(doneMarker(date, phase), { force: true });
}

/** Deletes work/<date>/<dir> for the phase being restarted; returns the dirs that existed. */
function cleanStaging(date, phase) {
  const removed = [];
  const root = stagingRoot(date);
  for (const dir of stagingDirs(phase)) {
    const target = path.join(root, dir);
    if (path.dirname(target) !== root) continue; // never leave work/<date>/
    if (!fs.existsSync(target)) continue;
    fs.rmSync(target, { recursive: true, force: true });
    removed.push(path.relative(rp(), target));
  }
  return removed;
}

function withPhaseDone(run, phase, { by, note = '', at }) {
  const r = structuredClone(run);
  if (!r.phasesDone.some((e) => e.phase === phase)) r.phasesDone.push({ phase, at, by, note });
  r.attempts[phase] = Math.max(1, r.attempts[phase] ?? 0);
  return r;
}

// ---------------------------------------------------------------------------------------
// is a "published" day really on the site?
// ---------------------------------------------------------------------------------------

const hasIndex = (dir) => fs.existsSync(path.join(dir, 'index.html'));

function historyEntryFor(date) {
  const history = readJson(rp('state', 'history.json'), null);
  const entry = Array.isArray(history?.entries) ? history.entries.find((e) => isObj(e) && e.date === date) : null;
  return entry ?? null;
}

// Directories docs/d/<date>-<slug> that hold an index.html.
function pageDirsFor(date) {
  try {
    return fs
      .readdirSync(rp('docs', 'd'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith(`${date}-`) && hasIndex(rp('docs', 'd', d.name)))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * Does the repo hold the page a published run claims? Returns null when it does, else the reason it does not.
 * `tier` (optional) additionally demands that history records exactly that tier for the date (finish uses this
 * so a run can only be marked published after package added the page and its history entry).
 */
export function publicationProblem(date, tier) {
  const entry = historyEntryFor(date);
  if (entry) {
    if (tier !== undefined && entry.tier !== tier) return `state/history.json records tier ${entry.tier ?? '?'} for ${date}, not tier ${tier}`;
    const rel = typeof entry.path === 'string' ? path.normalize(entry.path) : null;
    const dir = rel ? path.resolve(rp('docs'), rel) : null;
    if (dir && dir.startsWith(path.resolve(rp('docs', 'd')) + path.sep) && hasIndex(dir)) return null;
    return `docs/${entry.path ?? `d/${date}-*`} has no index.html`;
  }
  if (tier === undefined && pageDirsFor(date).length) return null;
  return `state/history.json has no entry for ${date} (run package and \`history.mjs add\` before finishing)`;
}

// ---------------------------------------------------------------------------------------
// spend cap
// ---------------------------------------------------------------------------------------

export function levelConfigFor(config, level) {
  const lv = config.budget.levels?.[level] ?? config.budget.levels?.[config.budget.level] ?? {};
  const reserve = config.budget.reserveForPublishTokens ?? 0;
  return {
    level: config.budget.levels?.[level] ? level : config.budget.level,
    ...lv,
    reserveForPublishTokens: reserve,
    capTokens: Math.max(0, (lv.outputTokens ?? 0) - reserve),
  };
}

export function spendSummary(config, run) {
  const lc = levelConfigFor(config, run.throttle ?? config.budget.level);
  return {
    outputTokens: run.spend.outputTokens,
    agentCalls: run.spend.agentCalls,
    byPhase: run.spend.byPhase,
    level: lc.level,
    capTokens: lc.capTokens,
    remainingTokens: Math.max(0, lc.capTokens - run.spend.outputTokens),
    overCap: run.spend.outputTokens > lc.capTokens,
  };
}

// ---------------------------------------------------------------------------------------
// commands (each is one atomic, locked read-modify-write)
// ---------------------------------------------------------------------------------------

function guardHolder(run, session) {
  if (session && run.lease && run.lease.session !== session) {
    throw new StateError(
      `lease is held by ${run.lease.holder}/${run.lease.session}, not ${session}; stop writing (leaseHeld:false)`,
      { leaseHeld: false, holder: run.lease.holder, holderSession: run.lease.session },
    );
  }
}

function touchLease(run, session, nowIso) {
  if (session && run.lease && run.lease.session === session) run.lease.heartbeatAt = nowIso;
}

/**
 * begin: apply the decision table. opts: { role, session, date, now, config, flags, throttleLevel }.
 * Returns { action, date, role, targetTier, resumePhase, reason, wrote, run, recovered, cleaned, corrupt }.
 */
export function beginRun(opts) {
  assertIdentity(opts.role, opts.session); // reject bad input before a corrupt file gets quarantined for nothing
  if (opts.flags?.targetTier !== undefined) clampTier(opts.flags.targetTier, '--target-tier');
  const config = opts.config ?? loadConfig();
  const now = toDate(opts.now);
  const nowIso = now.toISOString();
  const date = assertDate(opts.date ?? localParts(now, config.timezone).date);
  return withLock(runLockPath(date), () => {
    const read = readRunFile(date);
    let run = read.run;
    let corrupt = null;
    let reopened = false;
    if (read.status === 'corrupt') {
      const moved = quarantine(date);
      corrupt = { error: read.error, preservedAs: moved ? path.relative(rp(), moved) : null };
      run = null;
    }
    // A run that says "published" while the site holds no page for the day is a lie that would stop every safety net.
    // Repair paths (deadman) opt in to reopening it as failed; everyone else is only told (`publicationBacked`).
    let unbacked = null;
    if (run?.status === 'published') {
      unbacked = publicationProblem(date);
      if (unbacked && opts.flags?.reopenUnbacked) {
        run = structuredClone(run);
        run.status = 'failed';
        run.publishedAt = null;
        run.publishedUrl = null;
        run.tier = null;
        pushEvent(run, 'error', `published claim discarded, no page behind it: ${unbacked}`, opts.role, nowIso);
        unbacked = null;
        reopened = true;
      }
    }
    const heartbeat = latestHeartbeat(loadHeartbeat(date, run?.lease?.session), opts.heartbeat ?? null);
    const input = { ...opts, config, now, date, heartbeat, run };
    let p = decide(input);

    // A phase that finished (DONE.json) just before its session died must not be redone or wiped.
    const recovered = [];
    let working = run;
    while (working && p.setPhase && !p.create && p.action !== 'force-degrade' && recovered.length < PHASES.length) {
      const phase = p.resumePhase;
      if (!hasDoneMarker(date, phase)) break;
      working = withPhaseDone(working, phase, { by: 'recovery', note: 'DONE.json marker found; phase had completed before the session died', at: nowIso });
      recovered.push(phase);
      p = decide({ ...input, run: working });
    }

    // exit-published / exit-alive without a directive must not touch the file at all (watchdogs commit nothing).
    const mustWrite = p.changed || p.directives.length > 0 || corrupt !== null || recovered.length > 0 || reopened;
    let result = working;
    let cleaned = [];
    let wrote = false;
    if (mustWrite) {
      if (p.cleanPhase) cleaned = cleanStaging(date, p.cleanPhase);
      const next = applyDecision(working, p, { role: opts.role, session: opts.session, nowIso, date, throttleLevel: opts.throttleLevel });
      if (corrupt) {
        const msg = `corrupt-run: ${corrupt.error}${corrupt.preservedAs ? `; bad file preserved as ${corrupt.preservedAs}` : ''}`;
        next.events.unshift({ at: nowIso, by: opts.role, kind: 'error', code: 'corrupt-run', msg });
      }
      for (const phase of recovered) {
        pushEvent(next, 'note', `phase ${phase} recovered from its DONE.json marker`, opts.role, nowIso);
      }
      if (next.events.length > MAX_EVENTS) next.events = next.events.slice(-MAX_EVENTS);
      saveRun(next);
      result = next;
      wrote = true;
    }
    return {
      action: p.action,
      date,
      role: opts.role,
      targetTier: p.targetTier,
      resumePhase: p.resumePhase,
      reason: unbacked ? `${p.reason}; WARNING the site holds no page for it (${unbacked}): run \`deadman.mjs --force\` to repair` : p.reason,
      wrote,
      directiveAdded: p.directives.length > 0 && wrote,
      builtSiteAvailable: p.builtSiteAvailable,
      ...(unbacked ? { publicationBacked: false, publicationProblem: unbacked } : {}),
      run: result,
      recovered,
      cleaned,
      corrupt,
      lease: leaseInfo(config, result, heartbeat, now.getTime()),
    };
  });
}

/** beat: refresh the lease heartbeat when the lease is ours; otherwise report who holds it. */
export function beatRun({ role, session, phase, note, date, now, displacedBy, config = loadConfig() }) {
  assertIdentity(role, session);
  if (phase !== undefined) assertPhase(phase);
  const at = toDate(now);
  const day = assertDate(date ?? localParts(at, config.timezone).date);
  return updateRun(day, (run) => {
    const pending = run.directives.filter((d) => !d.ack);
    const common = { directives: pending, targetTier: run.targetTier, status: run.status, spend: spendSummary(config, run) };
    if (displacedBy) {
      // another container's newer lease reached the shared branch: this writer lost and must not refresh anything
      return {
        result: {
          ...common,
          directives: displacedBy.directives ?? [],
          leaseHeld: false,
          displaced: true,
          holder: displacedBy.holder,
          holderSession: displacedBy.session,
          reason: `displaced: ${displacedBy.holder}/${displacedBy.session} took the lease on the shared branch; stop writing and see PLAYBOOK 6.6`,
        },
      };
    }
    if (!isSelf(run.lease, role, session)) {
      const info = leaseInfo(config, run, loadHeartbeat(day, run.lease?.session), at.getTime());
      const reason = !info.present
        ? 'no lease on this run; call begin'
        : info.stale || info.stuck
          ? `lease is held by ${info.holder}/${info.session} but looks ${info.stale ? 'stale' : 'stuck'}; call begin to take over properly`
          : `lease is held by ${info.holder}/${info.session} (fresh); stop writing`;
      return { result: { ...common, leaseHeld: false, holder: info.holder, holderSession: info.session, reason } };
    }
    if (run.status !== 'in_progress') {
      return { result: { ...common, leaseHeld: true, holder: role, reason: `run is ${run.status}; heartbeat not recorded` } };
    }
    run.lease.heartbeatAt = at.toISOString();
    if (phase !== undefined) run.lease.phase = phase;
    if (note !== undefined) run.lease.note = String(note);
    return { run, result: { ...common, leaseHeld: true, holder: role } };
  });
}

export function phaseStart({ phase, session, date, now, config = loadConfig() }) {
  assertPhase(phase);
  const at = toDate(now);
  const day = assertDate(date ?? localParts(at, config.timezone).date);
  const nowIso = at.toISOString();
  return updateRun(day, (run) => {
    if (run.status !== 'in_progress') throw new StateError(`run for ${day} is ${run.status}; cannot start phase ${phase}`);
    guardHolder(run, session);
    run.phase = phase;
    run.phaseStartedAt[phase] = nowIso;
    run.attempts[phase] = (run.attempts[phase] ?? 0) + 1;
    removeDoneMarker(day, phase);
    touchLease(run, session, nowIso);
    return {
      run,
      result: {
        phase,
        attempt: run.attempts[phase],
        maxAttempts: config.maxAttemptsPerPhase,
        overLimit: run.attempts[phase] > config.maxAttemptsPerPhase,
        targetTier: run.targetTier,
        directives: run.directives.filter((d) => !d.ack),
      },
    };
  });
}

export function phaseDone({ phase, note, role, session, date, now, config = loadConfig() }) {
  assertPhase(phase);
  const at = toDate(now);
  const day = assertDate(date ?? localParts(at, config.timezone).date);
  const nowIso = at.toISOString();
  return updateRun(day, (run) => {
    if (run.status !== 'in_progress') throw new StateError(`run for ${day} is ${run.status}; cannot finish phase ${phase}`);
    guardHolder(run, session);
    const already = doneNames(run).includes(phase);
    const r = withPhaseDone(run, phase, { by: role ?? run.lease?.holder ?? 'unknown', note: note ?? '', at: nowIso });
    const next = firstPending(r.targetTier, doneNames(r));
    if (r.phase !== next) {
      r.phase = next;
      r.phaseStartedAt[next] = nowIso;
    }
    touchLease(r, session, nowIso);
    return {
      run: r,
      result: { phase, alreadyDone: already, next, attempts: r.attempts, phasesDone: doneNames(r), targetTier: r.targetTier },
    };
  });
}

export function directiveRun({ kind, tier, by, date, now, config = loadConfig() }) {
  if (!DIRECTIVE_KINDS.includes(kind)) throw new UsageError(`directive kind must be ${DIRECTIVE_KINDS.join('|')} (got "${kind}")`);
  if (!by) throw new UsageError('--by <role> is required');
  const at = toDate(now);
  const day = assertDate(date ?? localParts(at, config.timezone).date);
  return updateRun(day, (run) => {
    if (run.status === 'published') throw new StateError(`run for ${day} is already published; a directive would be meaningless`);
    const t =
      tier === undefined
        ? kind === 'scope-cut'
          ? 2
          : doneNames(run).includes('ideate')
            ? 3
            : 4
        : clampTier(tier, '--tier');
    const added = addDirective(run, { kind, tier: t }, by, at.toISOString());
    if (added) pushEvent(run, 'note', `${kind} directive (tier ${t}) issued by ${by}`, by, at.toISOString());
    return { run: added ? run : undefined, result: { added, kind, tier: t, targetTier: run.targetTier, directives: run.directives } };
  });
}

export function ackDirectives({ kind, tier, date, now, config = loadConfig() }) {
  const at = toDate(now);
  const day = assertDate(date ?? localParts(at, config.timezone).date);
  return updateRun(day, (run) => {
    let acked = 0;
    for (const d of run.directives) {
      if (d.ack) continue;
      if (kind !== undefined && d.kind !== kind) continue;
      if (tier !== undefined && d.tier !== Number(tier)) continue;
      d.ack = true;
      acked++;
    }
    return { run: acked ? run : undefined, result: { acked, pending: run.directives.filter((d) => !d.ack) } };
  });
}

export function eventRun({ kind, msg, by, date, now, config = loadConfig() }) {
  if (!EVENT_KINDS.includes(kind)) throw new UsageError(`event kind must be ${EVENT_KINDS.join('|')} (got "${kind}")`);
  if (typeof msg !== 'string' || !msg.trim()) throw new UsageError('--msg is required');
  if (!by) throw new UsageError('--by <role> is required');
  const at = toDate(now);
  const day = assertDate(date ?? localParts(at, config.timezone).date);
  return updateRun(day, (run) => {
    pushEvent(run, kind, msg, by, at.toISOString());
    return { run, result: { kind, events: run.events.length } };
  });
}

export function spendRun({ tokens = 0, calls = 0, phase, session, date, now, config = loadConfig() }) {
  const t = Number(tokens);
  const c = Number(calls);
  if (!Number.isFinite(t) || t < 0 || !Number.isFinite(c) || c < 0) throw new UsageError('--tokens and --calls must be non-negative numbers');
  if (phase !== undefined) assertPhase(phase);
  const at = toDate(now);
  const day = assertDate(date ?? localParts(at, config.timezone).date);
  return updateRun(day, (run) => {
    guardHolder(run, session);
    const bucket = phase ?? run.phase;
    const before = spendSummary(config, run);
    run.spend.outputTokens += t;
    run.spend.agentCalls += c;
    const cur = run.spend.byPhase[bucket] ?? { outputTokens: 0, agentCalls: 0 };
    run.spend.byPhase[bucket] = { outputTokens: (cur.outputTokens ?? 0) + t, agentCalls: (cur.agentCalls ?? 0) + c };
    const after = spendSummary(config, run);
    if (after.overCap && !before.overCap) {
      pushEvent(
        run,
        'budget',
        `output tokens ${after.outputTokens} exceed the ${after.level} cap ${after.capTokens}: stop starting agent work, go to package or a fallback`,
        run.lease?.holder ?? 'unknown',
        at.toISOString(),
      );
    }
    return { run, result: { spend: after, overCap: after.overCap } };
  });
}

export function chooseRun({ ideaId, slug, title, session, date, now, config = loadConfig() }) {
  if (!ideaId || !title) throw new UsageError('--idea-id, --slug and --title are required');
  const clean = String(slug ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  if (!clean) throw new UsageError(`--slug "${slug}" has no usable characters`);
  const at = toDate(now);
  const day = assertDate(date ?? localParts(at, config.timezone).date);
  return updateRun(day, (run) => {
    guardHolder(run, session);
    run.chosen = { ideaId: String(ideaId), slug: clean, title: String(title) };
    return { run, result: { chosen: run.chosen, slugNormalized: clean !== slug } };
  });
}

/** Deletes the page of a fallback tier that a better tier just replaced; returns the repo-relative dirs removed. */
export function removeFallbackDir(date, replacedTier, newTier, chosenSlug, root = rp()) {
  const suffix = replacedTier === 3 ? 'ideas-day' : replacedTier === 4 ? 'postcard' : null;
  if (!suffix) return [];
  if (newTier <= 2 && chosenSlug === suffix) return []; // a real project that happens to use that slug
  const dir = path.join(root, 'docs', 'd', `${date}-${suffix}`);
  if (!fs.existsSync(dir)) return [];
  fs.rmSync(dir, { recursive: true, force: true });
  return [path.relative(root, dir)];
}

/**
 * finish: mark published. Never downgrades; upgrades a worse published tier until 23:59 local on the
 * run date (the replaced fallback page directory is removed; the caller replaces the history entry).
 */
export function finishRun({ status = 'published', tier, url, by, date, now, config = loadConfig() }) {
  if (status !== 'published') throw new UsageError(`finish only supports --status published (got "${status}"); use \`fail\` for failures`);
  const newTier = clampTier(tier, '--tier');
  const at = toDate(now);
  const day = assertDate(date ?? localParts(at, config.timezone).date);
  const nowIso = at.toISOString();
  const lp = localParts(at, config.timezone);
  return updateRun(day, (run) => {
    const who = by ?? run.lease?.holder ?? 'unknown';
    let removedDirs = [];
    let action = 'published';
    if (run.status === 'published') {
      const old = run.tier ?? 4;
      if (newTier > old) {
        return {
          result: { ok: false, action: 'refused', error: `refusing to downgrade: tier ${old} is already published, tier ${newTier} is worse`, tier: old, publishedUrl: run.publishedUrl },
        };
      }
      if (newTier === old) {
        return { result: { ok: true, action: 'noop', tier: old, publishedAt: run.publishedAt, publishedUrl: run.publishedUrl } };
      }
      const windowClosed = lp.date > day || (lp.date === day && lp.minutes >= UPGRADE_CUTOFF_MINUTES);
      if (windowClosed) {
        return {
          result: { ok: false, action: 'refused', error: `upgrade window for ${day} closed at 23:59 local`, tier: old, publishedUrl: run.publishedUrl },
        };
      }
      const missing = publicationProblem(day, newTier);
      if (missing) return { result: { ok: false, action: 'refused', error: `cannot publish tier ${newTier} for ${day}: ${missing}`, tier: old, publishedUrl: run.publishedUrl } };
      action = 'upgraded';
      run.replaced = [...(run.replaced ?? []), { tier: old, publishedAt: run.publishedAt, publishedUrl: run.publishedUrl, replacedAt: nowIso }];
      removedDirs = removeFallbackDir(day, old, newTier, run.chosen?.slug);
      pushEvent(run, 'note', `upgraded published tier ${old} -> ${newTier}${removedDirs.length ? `; removed ${removedDirs.join(', ')}` : ''}`, who, nowIso);
    } else {
      const missing = publicationProblem(day, newTier);
      if (missing) {
        return { result: { ok: false, action: 'refused', error: `cannot mark ${day} published at tier ${newTier}: ${missing}`, tier: run.tier } };
      }
      pushEvent(run, 'note', `published at tier ${newTier}`, who, nowIso);
    }
    run.status = 'published';
    run.tier = newTier;
    run.publishedAt = nowIso;
    run.publishedUrl = url ?? config.siteUrl ?? null;
    run.phase = 'done';
    run.phaseStartedAt.done = nowIso;
    if (!doneNames(run).includes('done')) run.phasesDone.push({ phase: 'done', at: nowIso, by: who, note: `published tier ${newTier}` });
    return {
      run,
      result: { ok: true, action, tier: newTier, publishedAt: nowIso, publishedUrl: run.publishedUrl, removedDirs, replaced: run.replaced ?? [] },
    };
  });
}

export function failRun({ reason, by, session, date, now, config = loadConfig() }) {
  if (typeof reason !== 'string' || !reason.trim()) throw new UsageError('--reason is required');
  const at = toDate(now);
  const day = assertDate(date ?? localParts(at, config.timezone).date);
  return updateRun(day, (run) => {
    if (run.status === 'published') {
      return { result: { ok: false, action: 'refused', error: `run for ${day} is already published (tier ${run.tier}); refusing to mark it failed` } };
    }
    guardHolder(run, session);
    run.status = 'failed';
    pushEvent(run, 'error', `run failed: ${reason}`, by ?? run.lease?.holder ?? 'unknown', at.toISOString());
    return { run, result: { ok: true, status: 'failed', reason } };
  });
}

/** Mirrors a throttle change onto today's run (level, forced tier, scope-cut directive). No-op without a live run. */
export function syncThrottleToRun({ date, now, level, reason, kind = 'note', by = 'throttle', config = loadConfig() }) {
  const at = toDate(now);
  const day = assertDate(date ?? localParts(at, config.timezone).date);
  const nowIso = at.toISOString();
  return withLock(runLockPath(day), () => {
    const read = readRunFile(day);
    if (read.status !== 'ok' || read.run.status !== 'in_progress') return { updated: false };
    const run = read.run;
    run.throttle = level;
    pushEvent(run, kind, `throttle -> ${level}: ${reason}`, by, nowIso);
    const forced = config.budget.levels?.[level]?.forceTier ?? 1;
    let directive = null;
    if (forced > run.targetTier) {
      addDirective(run, { kind: 'scope-cut', tier: forced }, by, nowIso);
      directive = { kind: 'scope-cut', tier: forced };
    }
    saveRun(run);
    return { updated: true, targetTier: run.targetTier, directive };
  });
}

// ---------------------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------------------

function nextActionHint({ run, info, config, minutes, spend }) {
  const deadline = hm(config.schedule.deadline);
  // A manual run (genesis, rerun, repair) has no deadline pressure: clock-based advice would abandon a good run.
  const manual = info.present && info.holder === 'manual';
  const late = !manual && minutes >= deadline;
  if (!run) {
    return late
      ? `No run for this date and the ${config.schedule.deadline} deadline has passed: \`state.mjs begin --role manual --target-tier 4\` then publish a Postcard (deadman.mjs --force does this model-free).`
      : 'No run yet: the primary runs `state.mjs begin --role primary --session <id>`; any other role will start the day at the tier its clock allows.';
  }
  if (run.status === 'published') {
    return `Published at tier ${run.tier} (${run.publishedUrl ?? 'no url'}). Nothing to do${run.tier > 1 ? '; a better tier may still replace it via `finish` until 23:59 local' : ''}.`;
  }
  const parts = [];
  if (run.status === 'failed') {
    parts.push('Run is marked failed: any role can `begin` to take it over and continue at ' + firstPending(run.targetTier, doneNames(run)) + '.');
  } else if (!info.present) {
    parts.push('Run has no lease: `begin` takes it over.');
  } else if (info.stale) {
    parts.push(`Lease of ${info.holder} is STALE (${info.ageMinutes} min silent, limit ${config.leaseStaleMinutes}): \`begin\` takes over at ${firstPending(run.targetTier, doneNames(run))}.`);
  } else if (info.stuck) {
    parts.push(`${info.holder} is heartbeating but phase ${run.phase} has run ${info.phaseMinutes} min (limit ${info.stuckLimitMinutes}): treated as hung, \`begin\` takes over.`);
  } else {
    parts.push(`${info.holder} is alive (last sign ${info.ageMinutes} min ago) in ${run.phase}${info.phaseMinutes === null ? '' : ` for ${info.phaseMinutes} min`}: watchdogs exit quietly.`);
  }
  const pending = run.directives.filter((d) => !d.ack);
  if (pending.length) parts.push(`Pending directives for the holder: ${pending.map((d) => `${d.kind}(tier ${d.tier})`).join(', ')}.`);
  if (spend.overCap) parts.push(`Output tokens ${spend.outputTokens} are over the ${spend.capTokens} cap: no new agent work, go to package or a fallback.`);
  if (manual) parts.push('This is a manual run: clock-based advice (deadline, tier cutoffs) does not apply to it; ignore clock hints.');
  else if (late) parts.push(`The ${config.schedule.deadline} deadline has passed without a publish: ship the best fallback now.`);
  else if (minutes >= hm(config.tierCutoffs.t3Until)) parts.push('Past the tier-3 cutoff: the closer force-degrades to Ideas Day or Postcard.');
  return parts.join(' ');
}

export function statusSummary({ date, now, config = loadConfig(), history = [] }) {
  const at = toDate(now);
  const day = assertDate(date ?? localParts(at, config.timezone).date);
  const read = readRunFile(day);
  const minutes = effectiveMinutes(config, at, day);
  const run = read.run;
  const heartbeat = loadHeartbeat(day, run?.lease?.session);
  const info = leaseInfo(config, run, heartbeat, at.getTime());
  const base = {
    date: day,
    now: at.toISOString(),
    time: localParts(at, config.timezone).time,
    minutesToDeadline: hm(config.schedule.deadline) - minutes,
    targetTierIfStartedNow: tierByMinutes(config, minutes),
    exists: read.status === 'ok',
    runFile: read.status,
    ...(read.status === 'corrupt' ? { corruptError: read.error } : {}),
  };
  if (!run) {
    const emptySpend = { outputTokens: 0, overCap: false, capTokens: levelConfigFor(config, config.budget.level).capTokens };
    return {
      ...base,
      nextAction:
        read.status === 'corrupt'
          ? `Run file is corrupt (${read.error}): \`begin\` quarantines it and restarts the day. ` + nextActionHint({ run: null, info, config, minutes, spend: emptySpend })
          : nextActionHint({ run: null, info, config, minutes, spend: emptySpend }),
      history,
    };
  }
  const spend = spendSummary(config, run);
  return {
    ...base,
    status: run.status,
    phase: run.phase,
    phaseStartedAt: run.phaseStartedAt[run.phase] ?? null,
    phaseMinutes: info.phaseMinutes,
    stuckLimitMinutes: info.stuckLimitMinutes,
    manualRun: info.holder === 'manual',
    clockApplies: info.holder !== 'manual',
    targetTier: run.targetTier,
    tier: run.tier,
    phasesDone: doneNames(run),
    attempts: run.attempts,
    lease: run.lease
      ? { ...run.lease, ageMinutes: info.ageMinutes, lastSignOfLifeAt: info.lastBeatAt, source: info.source, stale: info.stale, stuck: info.stuck, alive: !info.stale && !info.stuck }
      : null,
    directives: run.directives.filter((d) => !d.ack),
    directivesAcked: run.directives.filter((d) => d.ack).length,
    chosen: run.chosen,
    spend,
    runThrottle: run.throttle,
    publishedAt: run.publishedAt,
    publishedUrl: run.publishedUrl,
    ...(run.status === 'published' ? { publicationBacked: publicationProblem(day) === null } : {}),
    eventsTail: run.events.slice(-10),
    eventCount: run.events.length,
    nextAction: nextActionHint({ run, info, config, minutes, spend }),
    history,
  };
}
