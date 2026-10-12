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

export const PHASES = ['preflight', 'ideate', 'select', 'spec', 'build', 'qa', 'revise', 'package', 'publish', 'kaizen', 'done'];
export const ROLES = ['primary', 'wdA', 'wdB', 'closer', 'manual'];
export const STATUSES = ['in_progress', 'published', 'failed'];
// Machine-readable tags ride on these kinds as `code`: corrupt-run (error), grace (note).
export const EVENT_KINDS = ['note', 'error', 'takeover', 'degrade', 'rate-limit', 'budget'];
// The only tag an operator may put on its own event (`state.mjs event --code`); every other code is written by the scripts. planned-compact
// marks the degrade event of PLAYBOOK 8.4 (spec went compact on a machine with few agent slots): expected, so Appendix A5 does not count it.
export const OPERATOR_EVENT_CODES = ['planned-compact'];
export const DIRECTIVE_KINDS = ['scope-cut', 'ship-now'];
export const MAX_EVENTS = 200;

// Phases a run walks through per target tier. Tier 3 (Ideas Day) needs the ideas but
// nothing built; tier 4 (Postcard) needs nothing at all. `kaizen` (CONTRACT 12) runs after the day is
// published, on every tier, so it can never endanger the page.
const TIER_PHASES = {
  1: PHASES,
  2: PHASES,
  3: ['preflight', 'ideate', 'package', 'publish', 'kaizen', 'done'],
  4: ['package', 'publish', 'kaizen', 'done'],
};
// Phases in which a healthy run keeps its grace period past the 08:00 guideline (CONTRACT 13).
const LATE_PHASES = ['qa', 'revise', 'package', 'publish'];
// No kaizen is resumed after this local time: a retrospective that wakes up at lunch time is a zombie.
export const KAIZEN_CUTOFF_MINUTES = 12 * 60;
// An armed phase watch (scripts/lib/phasewatch.mjs) that is overdue by more than this makes its holder's lease count as stale.
export const WATCH_STALE_AFTER_MINUTES = 15;
// The watch falls due this long after the phase budget the Workflow was given (phasewatch.mjs arms it; the lease rule below uses the
// same number to estimate how long a phase may take when no watch is visible).
export const WATCH_MARGIN_MINUTES = 10;
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
// A validated package of a finished build takes about 12 minutes (planner TYPICAL); keep slack before the hard stop.
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

export function pushEvent(run, kind, msg, by, at, code) {
  run.events.push({ at, by, kind, ...(code ? { code } : {}), msg });
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

/**
 * The marks of the day that the decision table compares the clock with, in minutes after local midnight
 * (CONTRACT 13). Configs written before the grace period existed fall back to the 08:00 guideline for both.
 */
export function scheduleMinutes(config) {
  const s = config.schedule ?? {};
  const deadline = hm(s.deadline);
  const graceUntil = s.graceUntil ? hm(s.graceUntil) : deadline;
  const hardStop = s.hardStop ? hm(s.hardStop) : graceUntil;
  return { deadline, graceUntil, hardStop };
}

/** qa, revise, package, publish: a healthy run here is not degraded before graceUntil. */
export const isLatePhase = (phase) => LATE_PHASES.includes(phase);

/** kaizen is off only when the owner says so; a config without the block gets the contract's default. */
export const kaizenEnabled = (config) => config.kaizen?.enabled !== false;

/** The page is live but the day's kaizen (CONTRACT 12) has not run or been skipped yet. */
export function kaizenPending(run) {
  return run?.status === 'published' && run.phase === 'kaizen' && !doneNames(run).includes('kaizen');
}

// A JS Date holds at most +-8.64e15 ms; a number beyond it cannot be turned back into an ISO string (RangeError), so it is no instant at all.
const MAX_DATE_MS = 8.64e15;
const instantMs = (v) => {
  const t = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) && Math.abs(t) <= MAX_DATE_MS ? t : null;
};

/** A short label that came out of a file or a platform answer and goes back into an answer or a message: letters, digits and _.:- only. */
export const inertToken = (v, max = 40) => String(v).replace(/[^A-Za-z0-9_.:\- ]/g, '?').slice(0, max);
/** Free text from a run file as one inert line: control characters and line breaks become spaces, capped. */
export const inertText = (v, max = 300) => String(v).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim().slice(0, max);

/**
 * The usage stop in force on `run` at `nowMs`, { at, reason, resetsAt, rateLimitType, kind }, or null. `usage observe`
 * (scripts/lib/usage.mjs) latches a stop on the run when the plan has no room left (a rejected limit, overage in use):
 * no agent work may start while it stands, and the decision table degrades the day to a tier that needs no model tokens.
 * It ends when its reset time passes, or when a later `usage observe` reads an allowed status while the reset time is
 * unknown (`usageClearedAt` records the clear; it is also what lets two writers of one run file merge correctly), or when the
 * owner clears a wrongly latched limit stop by hand (`usage clear`). `kind` is overage (money) or limit (a refusal); a stop from
 * before the field existed is read from its words. Every text in the answer is made inert: the file may have been edited by hand.
 */
export function usageStopActive(run, nowMs = Date.now()) {
  const s = run?.usageStop;
  if (!isObj(s)) return null;
  const at = instantMs(s.at);
  const cleared = instantMs(run.usageClearedAt);
  if (cleared !== null && (at === null || cleared >= at)) return null;
  const resets = instantMs(s.resetsAt);
  if (resets !== null && resets <= nowMs) return null;
  const kind = s.kind === 'overage' || s.kind === 'limit' ? s.kind : /overage/i.test(`${s.reason} ${s.rateLimitType}`) ? 'overage' : 'limit';
  return {
    at: s.at === undefined || s.at === null ? null : inertText(s.at, 40),
    reason: typeof s.reason === 'string' && s.reason.trim() ? inertText(s.reason) : 'usage limit',
    resetsAt: resets === null ? null : new Date(resets).toISOString(),
    rateLimitType: s.rateLimitType === undefined || s.rateLimitType === null ? null : inertToken(s.rateLimitType),
    kind,
  };
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
/** Epoch ms of an ISO-8601 instant string; NaN for anything else (Date.parse alone accepts numbers and fragments such as "5"). */
export const isoMs = (v) => (typeof v === 'string' && ISO_INSTANT.test(v) ? Date.parse(v) : NaN);

/**
 * Is `phase` in phasesDone and not running again? `phase-start` on a skipped phase (PLAYBOOK 4.1, the compact QA of a rescue) runs it
 * once more without taking it out of phasesDone, so a phase that was started after its entry was written is still under way.
 */
export function phaseIsOver(run, phase) {
  const entry = (run?.phasesDone ?? []).find((e) => e?.phase === phase);
  if (!entry) return false;
  const restarted = isoMs(run.phaseStartedAt?.[phase]);
  const finished = isoMs(entry.at);
  return !(run.phase === phase && Number.isFinite(restarted) && Number.isFinite(finished) && restarted > finished);
}

/**
 * Minutes the run's armed phase watch (scripts/lib/phasewatch.mjs) is past its dueAt (negative: still to come), or null when the run
 * has no live watch: never armed, disarmed, armed by a session that no longer holds the lease, for another phase than the run's, for a
 * phase that is done, one that fired and whose phase was started again afterwards (the retry has to arm a watch of its own: the fired
 * one belongs to the attempt that was stopped), or on a day that is over. Whatever run.watch holds this never throws: a damaged block
 * simply is no watch.
 */
export function watchOverdueMinutes(run, nowMs) {
  const w = run?.watch;
  if (!isObj(w) || w.disarmedAt) return null;
  const due = isoMs(w.dueAt);
  if (!Number.isFinite(due) || typeof w.phase !== 'string') return null;
  if (!run.lease || w.session !== run.lease.session) return null; // a previous holder's timer is not the new holder's problem
  if (run.phase !== w.phase || phaseIsOver(run, w.phase)) return null;
  if (run.status !== 'in_progress' && !kaizenPending(run)) return null;
  if (w.firedAt && Number.isInteger(w.attemptsAtFire) && (Number(run.attempts?.[w.phase]) || 0) > w.attemptsAtFire) return null; // restarted
  return (nowMs - due) / 60000;
}

/** What `begin` and `status` print about run.watch: null without a block; a damaged block still shows, with nulls. */
export function watchSummary(run, nowMs) {
  const w = run?.watch;
  if (!isObj(w)) return null;
  const str = (v) => (typeof v === 'string' && v ? v : null);
  const due = isoMs(w.dueAt);
  const late = watchOverdueMinutes(run, nowMs);
  return {
    phase: str(w.phase),
    attempt: Number.isInteger(w.attempt) ? w.attempt : null,
    session: str(w.session),
    armedAt: str(w.armedAt),
    dueAt: Number.isFinite(due) ? w.dueAt : null,
    disarmedAt: str(w.disarmedAt),
    firedAt: str(w.firedAt),
    triggerId: str(w.triggerId),
    workflowTask: str(w.workflowTask),
    live: late !== null,
    overdueMinutes: late === null ? null : round1(late),
    staleLease: late !== null && late > WATCH_STALE_AFTER_MINUTES,
  };
}

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
 * live heartbeat is still dead); a live phase watch of the holder (phasewatch.mjs) widens that limit to its own due
 * time plus WATCH_STALE_AFTER_MINUTES, where the watch itself makes the lease stale. The watch lives in the holder's local run file
 * until a push carries it, so another container often cannot see it: without a visible watch the limit is widened to the phase budget
 * the owner configured (config.phaseBudgetMinutes) plus the same margin and grace, which is exactly where a watch armed with that
 * budget would have put it.
 * `hbUnknown` = the heartbeat channel could not be read at all (fetch failed after retries, branch missing). The
 * lease's own heartbeatAt only moves at checkpoint syncs and routinely ages past leaseStaleMinutes inside a healthy
 * build phase, so silence alone proves nothing then: such a lease keeps the benefit of the doubt (`hbUnreadable`)
 * until it is silent for phaseStuckMinutes, or, under the holder's own live phase watch, until that watch is
 * WATCH_STALE_AFTER_MINUTES overdue (`watchDoubt`; not when `hbMissing`: the branch does not exist), and `stuck` stays the backstop.
 */
export function leaseInfo(config, run, heartbeat, nowMs, { hbUnknown = false, hbMissing = false } = {}) {
  const lease = run?.lease ?? null;
  if (!lease) {
    return { present: false, holder: null, session: null, stale: true, beatStale: true, watchStale: false, watchOverdueMinutes: null, hbUnreadable: false, watchDoubt: false, stuck: false, stuckLimitMinutes: config.phaseStuckMinutes, ageMinutes: null, phaseMinutes: null, lastBeatAt: null, source: null };
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
  const silent = !(ageMinutes <= config.leaseStaleMinutes);
  // An armed phase watch that nobody answered for WATCH_STALE_AFTER_MINUTES past its due time (scripts/lib/phasewatch.mjs: the
  // operator's own timer, set to the phase budget plus a margin) is as good as a dead holder, a live heartbeat or an unreadable
  // heartbeat channel notwithstanding. The heartbeat staleness above is otherwise untouched.
  const watchLate = watchOverdueMinutes(run, nowMs);
  const watchStale = watchLate !== null && watchLate > WATCH_STALE_AFTER_MINUTES;
  // A live phase watch of the holder (armed at its launch and pushed with it, not yet WATCH_STALE_AFTER_MINUTES overdue) is its own
  // statement that it waits for its Workflow until then, and its turn has ended, so its lease cannot move before the phase is done.
  // With the heartbeat channel unreadable the doubt therefore lasts as long as that watch (watchStale ends it), not only
  // phaseStuckMinutes: a healthy slow ideate on two agent slots runs about 110 minutes without a checkpoint. Only for a channel
  // that could not be READ (`hbMissing`: the branch does not exist, so nobody's pulse is landing: the 90-minute rule stands).
  const watchDoubt = silent && hbUnknown && !hbMissing && !watchStale && watchLate !== null && ageMinutes > config.phaseStuckMinutes;
  const hbUnreadable = silent && hbUnknown && !watchStale && (ageMinutes <= config.phaseStuckMinutes || watchDoubt);
  const beatStale = silent && !hbUnreadable;
  const stale = beatStale || watchStale;
  const start = phaseStartMs(run);
  const phaseMinutes = start === null ? null : Math.max(0, (nowMs - start) / 60000);
  // A human-supervised manual run has no deadline pressure and legitimately spends long in one phase.
  const baseLimit = config.phaseStuckMinutes * (lease.holder === 'manual' ? MANUAL_STUCK_FACTOR : 1);
  // A live phase watch is the holder's own, checkable statement of how long this phase may take (the phase budget plus a margin; the
  // owner's phaseBudgetMinutes for build, qa, revise and kaizen are longer than phaseStuckMinutes). Until that watch is itself
  // WATCH_STALE_AFTER_MINUTES late (watchStale above: the lease is stale then, whatever else holds) a phase is not "stuck" merely
  // for outlasting phaseStuckMinutes. When no live watch is visible (not pushed yet, disarmed, another phase's) the configured
  // phase budget stands in for it. Without either the limit is exactly what it always was.
  const watchDue = watchLate === null ? NaN : isoMs(run.watch.dueAt);
  const watchLimit = Number.isFinite(watchDue) && start !== null ? round1((watchDue - start) / 60000 + WATCH_STALE_AFTER_MINUTES) : null;
  const budget = config.phaseBudgetMinutes?.[run.phase];
  const budgetLimit = typeof budget === 'number' && Number.isFinite(budget) && budget > 0 ? round1(budget + WATCH_MARGIN_MINUTES + WATCH_STALE_AFTER_MINUTES) : null;
  const allowance = watchLimit ?? budgetLimit;
  const stuckLimit = allowance !== null && allowance > baseLimit ? allowance : baseLimit;
  const stuck = (run.status === 'in_progress' || kaizenPending(run)) && run.phase !== 'done' && phaseMinutes !== null && phaseMinutes > stuckLimit;
  return {
    present: true,
    holder: lease.holder,
    session: lease.session,
    stale,
    beatStale,
    watchStale,
    watchOverdueMinutes: watchLate === null ? null : round1(watchLate),
    hbUnreadable,
    watchDoubt, // the holder's own live watch, not phaseStuckMinutes, is what keeps the doubt now
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
 * Why the QA report forbids shipping the build of `date`, or null (no report yet, or it allows shipping). A report that
 * blocks (S1 defects, verdict "block"), that nobody reviewed (`unreviewed`: never to be read as "ship") or that cannot
 * be read at all counts. Rescue, salvage and the late-phase shortcuts of the playbook all consult it.
 */
export function qaBlock(date) {
  const file = rp('work', date, 'qa', 'report.json');
  if (!fs.existsSync(file)) return null;
  let report;
  try {
    report = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { reason: `work/${date}/qa/report.json is unreadable (${err.message})`, verdict: null, S1: null, unreviewed: false };
  }
  const S1 = Number(report?.counts?.S1) || 0;
  const verdict = typeof report?.verdict === 'string' ? report.verdict : null;
  const unreviewed = report?.unreviewed === true;
  const why = [S1 > 0 && `${S1} S1 defect(s)`, verdict === 'block' && 'verdict block', unreviewed && 'unreviewed by the critic'].filter(Boolean);
  return why.length ? { reason: `QA does not allow shipping this build: ${why.join(', ')}`, verdict, S1, unreviewed } : null;
}

/**
 * A finished build (`build` done) can still be packaged as a Tier-2 page, skipping QA and revise, while there is
 * time left before the hard stop and the package step has not already failed. Throwing a built site away because
 * QA flaked or the clock passed 08:00 would waste the day's real work; the Ideas Day is the fallback for a
 * failed package.
 */
export function rescuePackageAvailable(config, run, minutes) {
  if (!run || run.targetTier > 2) return false;
  if (!doneNames(run).includes('build')) return false;
  if (run.date && qaBlock(run.date)) return false; // QA already judged this build not shippable: salvaging it would ship exactly that
  if ((run.attempts?.package ?? 0) >= config.maxAttemptsPerPhase) return false;
  return minutes <= scheduleMinutes(config).hardStop - RESCUE_PACKAGE_MARGIN_MINUTES;
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
function settle(config, run, baseIn, { minutes, rescue = true }) {
  const done = doneNames(run);
  // A package that is already done carries the tier it was made at; only publish/finish remain, and the clock must
  // not re-tier it (a QA'd Tier 1 page would be re-staged and recorded as a Tier 2 salvage).
  const packaged = rescue && done.includes('package');
  const baseTier = packaged ? run.targetTier : baseIn;
  const hasIdeate = done.includes('ideate');
  // A run that is not published yet is never "waiting for kaizen": `finish` is part of publish.
  const pendingFor = (t) => {
    const p = firstPending(t, done);
    return p === 'kaizen' ? 'publish' : p;
  };
  let tier = baseTier;
  let resume;
  let degrade = null;
  const notes = [];
  const info = [];
  if (packaged) {
    resume = pendingFor(tier);
    info.push(`package is already done: keeping tier ${tier} and resuming at ${resume} (confirm the staged page on the remote, then finish at tier ${tier})`);
  } else if (rescue && tier >= 3 && rescuePackageAvailable(config, run, minutes)) {
    notes.push(`build is done and ${scheduleMinutes(config).hardStop - minutes} min remain before the hard stop: packaging it as tier 2 (QA/revise skipped) instead of tier ${tier}`);
    tier = 2;
    resume = 'package';
  } else {
    resume = pendingFor(tier);
  }
  const attempts = run.attempts?.[resume] ?? 0;
  // A packaged page is only waiting to be published: retrying that beats replacing it by a fallback.
  if (resume !== 'done' && !packaged && attempts >= config.maxAttemptsPerPhase) {
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
      if (tier >= 3) resume = pendingFor(tier);
      else if (resume === 'qa' || resume === 'revise') resume = 'package';
      degrade = `${stuckPhase} already attempted ${attempts}x (max ${config.maxAttemptsPerPhase}): degrading tier ${from} -> ${tier}, continuing at ${resume}`;
    }
  }
  const skipPhases = resume === 'package' && tier <= 2 ? skippedBefore('package', tier, done) : [];
  return { tier, resume, degrade, notes, info, skipPhases };
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
  kaizenPending: false,
  grace: false,
  hbUnreadable: false,
  closeKaizen: null,
  events: [],
  directives: [],
  changed: false,
  ...p,
});

/** How long a silent holder keeps the benefit of the doubt while the heartbeat channel is unreadable (leaseInfo `hbUnreadable`). */
const doubtUntil = (config, info) =>
  info.watchDoubt ? `its phase watch is ${WATCH_STALE_AFTER_MINUTES} min overdue` : `${config.phaseStuckMinutes} min of silence`;

/** Why a lease no longer counts as alive: the lease half of a takeover reason. */
function leaseProblem(config, run, info) {
  if (!info.present) return 'no lease';
  if (info.watchStale && !info.beatStale) {
    return `phase watch for ${run.phase} is ${info.watchOverdueMinutes} min overdue (> ${WATCH_STALE_AFTER_MINUTES}) although the heartbeat is fresh`;
  }
  if (info.stuck && !info.stale) {
    return `phase ${run.phase} has run ${info.phaseMinutes} min (> ${info.stuckLimitMinutes}) although the heartbeat is fresh`;
  }
  return `lease of ${info.holder}/${info.session} is stale (${info.ageMinutes === null ? 'never beat' : `${info.ageMinutes} min`} > ${config.leaseStaleMinutes})`;
}

/**
 * Row 1 of the table. A published page is never redone; the only thing a published run can still owe is its
 * kaizen (CONTRACT 12), which any operator role except the closer resumes when its owner is gone, until 12:00.
 */
function decidePublished({ config, run, role, session, heartbeat, hbUnknown, hbMissing, nowMs, minutes, base }) {
  const head = `already published (tier ${run.tier ?? '?'}) at ${run.publishedAt ?? '?'}; only \`finish\` may upgrade it`;
  const exit = (suffix = '', extra = {}) =>
    plan({ ...base, action: 'exit-published', targetTier: run.targetTier, resumePhase: null, reason: `${head}${suffix}`, ...extra });
  if (!base.kaizenPending) return exit();
  if (role === 'closer') return exit('; its kaizen is pending but the closer never runs it');
  if (minutes >= KAIZEN_CUTOFF_MINUTES) return exit('; its kaizen is pending but the 12:00 window for resuming it has closed');
  const stop = usageStopActive(run, nowMs);
  if (stop) return exit(`; its kaizen is pending but a usage stop is in force (${stop.reason}, ${stop.resetsAt ? `until ${stop.resetsAt}` : 'reset time unknown'}): not resumed`);

  const info = leaseInfo(config, run, heartbeat, nowMs, { hbUnknown, hbMissing });
  const self = isSelf(run.lease, role, session);
  if (!self && info.present && !info.stale && !info.stuck) {
    return exit(`; its kaizen is running (${info.holder}/${info.session}, last sign ${info.ageMinutes} min ago)`);
  }
  const attempts = run.attempts?.kaizen ?? 0;
  if (attempts >= config.maxAttemptsPerPhase) {
    const note = `skipped: attempted ${attempts}x (max ${config.maxAttemptsPerPhase})`;
    return exit(`; its kaizen is closed (${note})`, { changed: true, kaizenPending: false, closeKaizen: note, events: [{ kind: 'note', msg: `kaizen ${note}` }] });
  }
  const problem = leaseProblem(config, run, info);
  return plan({
    ...base,
    action: 'resume-kaizen',
    takeLease: true,
    setPhase: true,
    ackDirectives: true,
    changed: true,
    targetTier: run.targetTier,
    resumePhase: 'kaizen',
    reason: `${head}; kaizen is pending and ${self ? 'this is its own session' : problem}: ${self ? 'resuming' : 'taking it over'} at kaizen`,
    events: [
      self
        ? { kind: 'note', msg: `${role} (${session}) resumed its own kaizen` }
        : { kind: 'takeover', msg: `${role} (${session}) took over the kaizen from ${run.lease ? `${run.lease.holder}/${run.lease.session}` : 'nobody'}: ${problem}` },
    ],
  });
}

/**
 * Pure. Decides what an unattended session in `role` should do right now.
 * input: { role, session, now, date, config?, run?, heartbeat?, hbUnknown?, hbMissing?, throttleLevel?, flags?: { targetTier, force } }
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
  const hbUnknown = input.hbUnknown === true;
  const hbMissing = input.hbMissing === true; // the heartbeat branch does not exist (leaseInfo)
  const nowMs = now.getTime();
  const clock = localParts(now, config.timezone).time;
  const minutes = effectiveMinutes(config, now, date);
  const byTime = tierByMinutes(config, minutes);
  const level = input.throttleLevel ?? run?.throttle ?? config.budget.level;
  const forcedByLevel = config.budget.levels?.[level]?.forceTier ?? 1;
  const manual = role === 'manual';
  const startTier = Math.max(manual ? clampTier(flags.targetTier ?? 1, '--target-tier') : byTime, forcedByLevel);
  const sched = scheduleMinutes(config);
  const base = { role, date, minutes, builtSiteAvailable: doneNames(run).includes('build'), kaizenPending: kaizenPending(run) };

  // 1. published: never redo the page (a kaizen still owed is the one thing that may resume).
  if (run?.status === 'published') return decidePublished({ config, run, role, session, heartbeat, hbUnknown, hbMissing, nowMs, minutes, base });

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

  const info = leaseInfo(config, run, heartbeat, nowMs, { hbUnknown, hbMissing });
  const self = isSelf(run.lease, role, session);
  const leaseGone = run.status === 'failed' || !info.present || info.stale;
  const leaseDead = leaseGone || (!self && info.stuck);

  // 2b. a usage stop is in force (scripts/lib/usage.mjs latched it on the run): the plan has no room left, so no agent
  // work may start, whatever the role, the lease or the clock say. Degrade to the cheapest tier that needs no model
  // tokens: the Ideas Day when ideate is done, else the Postcard. Idempotent: once the run's target is that cheap the
  // ordinary rows below apply (a holder already on the scripts-only path is left alone).
  const stop = usageStopActive(run, nowMs);
  const stopTier = stop ? Math.max(doneNames(run).includes('ideate') ? 3 : 4, run.targetTier) : null;
  if (stop && stopTier > run.targetTier) {
    const resets = stop.resetsAt ? `resets ${stop.resetsAt}` : 'reset time unknown';
    const lifts = stop.resetsAt ? `the stop ends at ${stop.resetsAt}` : 'its reset time is unknown, so only a `usage observe` that reads allowed lifts it';
    return plan({
      ...base,
      action: 'force-degrade',
      takeLease: true,
      setPhase: true,
      clearFailed: true,
      changed: true,
      targetTier: stopTier,
      resumePhase: firstPending(stopTier, doneNames(run)),
      reason: `usage-stop: ${stop.reason} (${stop.rateLimitType ?? 'limit'}, ${resets}); no agent work may start, forcing tier ${stopTier} (${stopTier === 3 ? 'Ideas Day from the researched ideas' : 'Postcard, no ideas exist'}), scripts only; ${lifts}, and the tier does not go back up within the run`,
      events: [
        {
          kind: 'degrade',
          code: 'usage-stop',
          msg: `${role} (${session}) forced tier ${stopTier} at ${clock}: usage stop (${stop.reason}, ${resets}); ${self ? 'kept the lease' : `took the lease from ${run.lease ? `${run.lease.holder}/${run.lease.session}` : 'nobody'}`}`,
        },
      ],
      directives: self ? [] : newDirectives(run, [{ kind: 'ship-now', tier: stopTier }]),
    });
  }

  // 3. closer at/after the tier-3 cutoff (CONTRACT 13). A healthy run (fresh lease, phase advancing) in
  // qa/revise/package/publish keeps its grace period until graceUntil: the closer waits instead of discarding
  // good work. Everything else with a live lease is forced to the best fallback that is still possible (a hung
  // phase with a live heartbeat included); hardStop overrides health. A lease that is gone before the hard stop
  // is an ordinary takeover (row 4).
  if (role === 'closer' && minutes >= hm(config.tierCutoffs.t3Until)) {
    const hardStop = minutes >= sched.hardStop;
    if (!hardStop && !leaseGone && !self && !info.stuck && isLatePhase(run.phase) && minutes < sched.graceUntil) {
      const first = !run.events.some((e) => e.code === 'grace' && e.by === role);
      return plan({
        ...base,
        action: 'exit-alive',
        grace: true,
        targetTier: run.targetTier,
        resumePhase: null,
        reason: `grace: ${info.holder}/${info.session} is alive in ${run.phase} (last sign ${info.ageMinutes} min ago, ${info.phaseMinutes ?? '?'} min in the phase); ${config.schedule.deadline} is a guideline, so the closer waits until ${config.schedule.graceUntil} (babysit: wait up to 9 min, re-run begin, repeat)`,
        events: first ? [{ kind: 'note', code: 'grace', msg: `grace granted to ${info.holder}/${info.session} in ${run.phase} until ${config.schedule.graceUntil}` }] : [],
      });
    }
    if (hardStop || !leaseGone) {
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
      const why = hardStop
        ? `past the hard stop ${config.schedule.hardStop}`
        : minutes >= sched.graceUntil
          ? `past ${config.schedule.graceUntil}, the end of the grace period`
          : !isLatePhase(run.phase)
            ? `${info.holder}'s phase ${run.phase} is too early for grace (only ${LATE_PHASES.join('/')} qualify)`
            : `${info.holder}'s phase ${run.phase} has run ${info.phaseMinutes} min (> ${info.stuckLimitMinutes}): not advancing, so no grace`;
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
        reason: `closer at ${clock}, ${why}: forcing tier ${forced} (${forcedWhat})`,
        events: [
          {
            kind: 'degrade',
            msg: `closer forced tier ${forced} at ${clock} (${why}); took the lease from ${run.lease ? `${run.lease.holder}/${run.lease.session}` : 'nobody'}`,
          },
        ],
        directives: newDirectives(run, [{ kind: 'ship-now', tier: forced }]),
      });
    }
  }

  // 4. failed run, or nobody alive behind the lease: take over (or resume if it is me).
  if (leaseDead) {
    // Once the ideas exist an Ideas Day needs no time, so the clock alone never pushes such a run down to the Postcard.
    const timeTier = byTime === 4 && doneNames(run).includes('ideate') ? 3 : byTime;
    // manual ignores the clock and uses its explicit target; everyone else never improves on the previous target
    const baseTier = manual ? startTier : Math.max(run.targetTier, timeTier, forcedByLevel);
    const { tier, resume, degrade, notes, info: infoNotes, skipPhases } = settle(config, run, baseTier, { minutes, rescue: !manual });
    const why = run.status === 'failed' ? 'run was marked failed' : leaseProblem(config, run, info);
    // The phase the dead holder was in is what has half-written staging, even when the new tier skips past it.
    const interrupted = doneNames(run).includes(run.phase) ? resume : run.phase;
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
    for (const n of infoNotes) events.push({ kind: 'note', msg: n });
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
      cleanPhase: self ? null : interrupted,
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
        cleanPhase: doneNames(run).includes(run.phase) ? resume : run.phase,
        reason: `forced over a fresh lease held by ${info.holder}/${info.session}`,
        events,
      });
    }
    // wdB (06:47) cuts the scope of any run that has not reached build yet; wdA (05:32) only of one still in ideate.
    const wanted = [];
    if (role === 'wdB' && WD_B_SCOPE_PHASES.includes(run.phase)) wanted.push({ kind: 'scope-cut', tier: 2 });
    if (role === 'wdA' && WD_A_BEHIND_PHASES.includes(run.phase) && minutes >= hm(WD_A_BEHIND_FROM)) wanted.push({ kind: 'scope-cut', tier: 2 });
    const directives = newDirectives(run, wanted);
    const note = directives.length ? '; scope-cut directive left for it' : wanted.length ? '; scope-cut directive already pending' : '';
    if (info.hbUnreadable) {
      // Silent by the lease's own clock but the heartbeat channel is unreadable: not evidence of death. Say so once per role.
      const first = !run.events.some((e) => e.code === 'hb-unreadable' && e.by === role);
      const until = doubtUntil(config, info);
      return plan({
        ...base,
        action: 'exit-alive',
        hbUnreadable: true,
        targetTier: run.targetTier,
        resumePhase: null,
        reason: `hb-unreadable: ${info.holder}/${info.session} last checkpointed ${info.ageMinutes} min ago (phase ${run.phase}${info.phaseMinutes === null ? '' : `, ${info.phaseMinutes} min in it`}) and the heartbeat branch could not be read, so it is not declared dead before ${until}${note}`,
        directives,
        events: first ? [{ kind: 'note', code: 'hb-unreadable', msg: `heartbeat branch unreadable: ${info.holder}/${info.session} is silent ${info.ageMinutes} min on the lease but is not taken over before ${until}` }] : [],
      });
    }
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
    if (!r.phasesDone.some((e) => e.phase === phase)) r.phasesDone.push({ phase, at: nowIso, by: role, note: 'skipped: finished build is packaged without it', skipped: true });
  }
  if (throttleLevel && p.changed) r.throttle = throttleLevel;
  for (const e of p.events) pushEvent(r, e.kind, e.msg, role, nowIso, e.code);
  if (p.closeKaizen) closeKaizen(r, { by: role, at: nowIso, note: p.closeKaizen, skipped: true });
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
  // The phase watch (scripts/lib/phasewatch.mjs) belongs to the lease holder: one holder on both sides keeps the block it touched
  // last (armed, bound, fired or disarmed), whichever side that was; with two holders the winner's block stands (cloned above).
  if (sameHolder) {
    const watches = [remote.watch, local.watch].filter(isObj);
    const touched = (w) => Math.max(ms(w.armedAt), ms(w.boundAt), ms(w.firedAt), ms(w.disarmedAt), ms(w.extendedAt), ms(w.timerFiredAt));
    const newest = watches.length === 2 ? (touched(remote.watch) > touched(local.watch) ? remote.watch : local.watch) : watches[0];
    if (newest) out.watch = structuredClone(newest);
  }

  // A usage stop (usage.mjs) belongs to the account, not to the lease holder: keep the newest stop either side saw,
  // unless a clear (usageClearedAt) that is not older than it was recorded on either side.
  const stops = [remote.usageStop, local.usageStop].filter(isObj).sort((a, b) => ms(b.at) - ms(a.at));
  const clearedAt = [remote.usageClearedAt, local.usageClearedAt].filter((t) => typeof t === 'string').sort((a, b) => ms(b) - ms(a))[0];
  delete out.usageStop;
  delete out.usageClearedAt;
  if (clearedAt) out.usageClearedAt = clearedAt;
  if (stops[0] && !(clearedAt && ms(clearedAt) >= ms(stops[0].at))) out.usageStop = stops[0];

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
    // The kaizen runs after the publish: once either side finished or skipped it, the day is done and stays done.
    for (const side of [remote, local]) {
      if (side.status !== 'published') continue;
      for (const e of side.phasesDone) {
        if ((e.phase === 'kaizen' || e.phase === 'done') && !out.phasesDone.some((x) => x.phase === e.phase)) out.phasesDone.push(e);
      }
    }
    if (doneNames(out).includes('done')) out.phase = 'done';
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

export function hasDoneMarker(date, phase) {
  if (!STAGING_DIRS[phase]) return false;
  const marker = readJson(doneMarker(date, phase), null);
  return isObj(marker) && marker.ok !== false;
}

function removeDoneMarker(date, phase) {
  if (!STAGING_DIRS[phase]) return;
  fs.rmSync(doneMarker(date, phase), { force: true });
}

/** Deletes work/<date>/<dir> for the phase being restarted (except `keep`); returns the dirs that existed. */
function cleanStaging(date, phase, { keep = [] } = {}) {
  const removed = [];
  const root = stagingRoot(date);
  for (const dir of stagingDirs(phase)) {
    if (keep.includes(dir)) continue;
    const target = path.join(root, dir);
    if (path.dirname(target) !== root) continue; // never leave work/<date>/
    if (!fs.existsSync(target)) continue;
    fs.rmSync(target, { recursive: true, force: true });
    removed.push(path.relative(rp(), target));
  }
  return removed;
}

function withPhaseDone(run, phase, { by, note = '', at, skipped = false }) {
  const r = structuredClone(run);
  if (!r.phasesDone.some((e) => e.phase === phase)) r.phasesDone.push({ phase, at, by, note, ...(skipped ? { skipped: true } : {}) });
  r.attempts[phase] = Math.max(1, r.attempts[phase] ?? 0);
  return r;
}

/** The kaizen phase is over, done or skipped (mutates `run`): with it the whole day is done. */
function closeKaizen(run, { by, at, note, skipped = false }) {
  if (!doneNames(run).includes('kaizen')) run.phasesDone.push({ phase: 'kaizen', at, by, note, ...(skipped ? { skipped: true } : {}) });
  run.phase = 'done';
  run.phaseStartedAt.done = at;
  if (!doneNames(run).includes('done')) run.phasesDone.push({ phase: 'done', at, by, note: 'kaizen closed the day' });
}

// ---------------------------------------------------------------------------------------
// is a "published" day really on the site?
// ---------------------------------------------------------------------------------------

const hasIndex = (dir) => fs.existsSync(path.join(dir, 'index.html'));

/** The dead builder's site, finished or not (repo-relative dir), for the closer's salvage; null when there is none. */
export function unfinishedSite(date) {
  const root = stagingRoot(date);
  const dir = [path.join(root, 'build', 'site'), path.join(root, 'build')].find(hasIndex);
  return dir ? path.relative(rp(), dir) : null;
}

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
    reserveForKaizenTokens: lv.reserveForKaizenTokens ?? config.budget.reserveForKaizenTokens ?? 0,
    kaizenMinTokensToStart: config.kaizen?.minTokensToStart ?? 0,
    capTokens: Math.max(0, (lv.outputTokens ?? 0) - reserve),
  };
}

/**
 * The day's spend against its cap. `level` (optional) is the level in force right now, the throttle's effective one: a run that is
 * still going follows it, so a cap changes at the very instant the owner override ends and not at the next `begin`; a finished run
 * keeps the level it ran at. `workflowCapTokens` and `kaizenCapTokens` are what to pass as `args.capTokens` of a Workflow launched
 * NOW: budget.spent() restarts at 0 in every turn, so what the day has spent so far must already be out of the cap (ideate to
 * revise also leave the kaizen reserve; kaizen does not). They are the PLAYBOOK 6.5 table with BASE worked out for you.
 */
export function spendSummary(config, run, { level } = {}) {
  const live = run.status === 'in_progress' || kaizenPending(run);
  const lc = levelConfigFor(config, live && level ? level : (run.throttle ?? config.budget.level));
  const spent = run.spend.outputTokens;
  return {
    outputTokens: spent,
    agentCalls: run.spend.agentCalls,
    byPhase: run.spend.byPhase,
    level: lc.level,
    capTokens: lc.capTokens,
    remainingTokens: Math.max(0, lc.capTokens - spent),
    workflowCapTokens: Math.max(0, lc.capTokens - lc.reserveForKaizenTokens - spent),
    kaizenCapTokens: Math.max(0, lc.capTokens - spent),
    overCap: spent > lc.capTokens,
  };
}

// ---------------------------------------------------------------------------------------
// commands (each is one atomic, locked read-modify-write)
// ---------------------------------------------------------------------------------------

export function guardHolder(run, session) {
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
 * Returns { action, date, role, targetTier, resumePhase, reason, wrote, grace, hbUnreadable, salvageSite, kept, kaizenPending, run, recovered, cleaned, corrupt }
 * where action is proceed | resume | takeover | force-degrade | exit-published | exit-alive | resume-kaizen.
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
    const input = { ...opts, config, now, date, heartbeat, run, hbUnknown: opts.hbUnknown === true, hbMissing: opts.hbMissing === true };
    let p = decide(input);

    // A phase that finished (DONE.json) just before its session died must not be redone or wiped.
    // The interrupted phase counts too: a takeover that degrades past it would otherwise wipe a finished build.
    const recovered = [];
    let working = run;
    while (working && p.setPhase && !p.create && p.action !== 'force-degrade' && recovered.length < PHASES.length) {
      const phase = [p.cleanPhase, p.resumePhase].find((ph) => ph && !doneNames(working).includes(ph) && hasDoneMarker(date, ph));
      if (!phase) break;
      working = withPhaseDone(working, phase, { by: 'recovery', note: 'DONE.json marker found; phase had completed before the session died', at: nowIso });
      recovered.push(phase);
      p = decide({ ...input, run: working });
    }

    // exit-published / exit-alive without a directive or an event must not touch the file at all (watchdogs commit nothing).
    const mustWrite = p.changed || p.directives.length > 0 || p.events.length > 0 || corrupt !== null || recovered.length > 0 || reopened;
    let result = working;
    let cleaned = [];
    let kept = null;
    let wrote = false;
    if (mustWrite) {
      if (p.cleanPhase) {
        // A dead build that left a site behind is the closer's salvage material: when the plan moves past `build`
        // (fallback tier or rescue) nothing restarts it, so wiping it would only destroy the day's best chance.
        const site = p.cleanPhase === 'build' && p.resumePhase !== 'build' ? unfinishedSite(date) : null;
        if (site) kept = path.join('work', date, 'build');
        cleaned = cleanStaging(date, p.cleanPhase, { keep: site ? ['build'] : [] });
      }
      const next = applyDecision(working, p, { role: opts.role, session: opts.session, nowIso, date, throttleLevel: opts.throttleLevel });
      if (corrupt) {
        const msg = `corrupt-run: ${corrupt.error}${corrupt.preservedAs ? `; bad file preserved as ${corrupt.preservedAs}` : ''}`;
        next.events.unshift({ at: nowIso, by: opts.role, kind: 'error', code: 'corrupt-run', msg });
      }
      for (const phase of recovered) {
        pushEvent(next, 'note', `phase ${phase} recovered from its DONE.json marker`, opts.role, nowIso);
      }
      if (kept) pushEvent(next, 'note', `kept ${kept}: the interrupted build left a site (${unfinishedSite(date)}) that the closer may salvage`, opts.role, nowIso);
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
      grace: p.grace,
      hbUnreadable: p.hbUnreadable,
      salvageSite: result.status === 'published' ? null : unfinishedSite(date),
      kept,
      kaizenPending: kaizenPending(result),
      ...(usageStopActive(result, now.getTime()) ? { usageStop: usageStopActive(result, now.getTime()) } : {}),
      ...(unbacked ? { publicationBacked: false, publicationProblem: unbacked } : {}),
      run: result,
      recovered,
      cleaned,
      corrupt,
      lease: leaseInfo(config, result, heartbeat, now.getTime(), { hbUnknown: opts.hbUnknown === true, hbMissing: opts.hbMissing === true }),
    };
  });
}

/** beat: refresh the lease heartbeat when the lease is ours; otherwise report who holds it. */
export function beatRun({ role, session, phase, note, date, now, displacedBy, level, config = loadConfig() }) {
  assertIdentity(role, session);
  if (phase !== undefined) assertPhase(phase);
  const at = toDate(now);
  const day = assertDate(date ?? localParts(at, config.timezone).date);
  return updateRun(day, (run) => {
    const pending = run.directives.filter((d) => !d.ack);
    const usageStop = usageStopActive(run, at.getTime()); // a stop another session latched shows up at the next boundary beat
    const common = { directives: pending, targetTier: run.targetTier, status: run.status, spend: spendSummary(config, run, { level }), kaizenPending: kaizenPending(run), ...(usageStop ? { usageStop } : {}) };
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
    if (run.status !== 'in_progress' && !kaizenPending(run)) {
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
    if (phase === 'kaizen') {
      // kaizen belongs to the already published day; before that it could only steal time from the page
      if (!kaizenPending(run)) throw new StateError(`phase kaizen starts only after the day is published (run is ${run.status}, phase ${run.phase})`);
    } else if (run.status !== 'in_progress') {
      throw new StateError(`run for ${day} is ${run.status}; cannot start phase ${phase}`);
    }
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

function completePhase({ phase, note, role, session, date, now, config = loadConfig(), skipped = false, heartbeat = null }) {
  assertPhase(phase);
  const at = toDate(now);
  const day = assertDate(date ?? localParts(at, config.timezone).date);
  const nowIso = at.toISOString();
  return updateRun(day, (run) => {
    if (phase === 'kaizen') {
      if (!kaizenEnabled(config)) throw new StateError('kaizen is disabled (config.kaizen.enabled is false)');
      if (!kaizenPending(run) && !doneNames(run).includes('kaizen')) {
        throw new StateError(`phase kaizen can only be closed after the day is published (run is ${run.status}, phase ${run.phase})`);
      }
    } else if (run.status !== 'in_progress') {
      throw new StateError(`run for ${day} is ${run.status}; cannot ${skipped ? 'skip' : 'finish'} phase ${phase}`);
    }
    // The closer never runs the kaizen round (CONTRACT 12.2) but closes it on purpose. A primary that died after it
    // published leaves a stale lease behind, and the holder guard would refuse that close for ever: a dead owner must not
    // keep the day open. A live owner (fresh lease or heartbeat, phase not stuck) is still protected.
    const orphan =
      phase === 'kaizen' && skipped && role === 'closer' && run.lease && run.lease.session !== session
        ? leaseInfo(config, run, latestHeartbeat(loadHeartbeat(day, run.lease.session), heartbeat), at.getTime())
        : null;
    const orphaned = orphan !== null && (orphan.stale || orphan.stuck);
    if (!orphaned) guardHolder(run, session);
    const by = role ?? run.lease?.holder ?? 'unknown';
    const already = doneNames(run).includes(phase);
    const r = withPhaseDone(run, phase, { by, note: note ?? '', at: nowIso, skipped });
    if (skipped && !already) pushEvent(r, 'note', `phase ${phase} ${note}`, by, nowIso);
    if (orphaned && !already) {
      pushEvent(r, 'note', `kaizen closed by the closer: its owner ${orphan.holder}/${orphan.session} is gone (${orphan.stale ? `silent ${orphan.ageMinutes} min` : `phase ${orphan.phaseMinutes} min old`})`, by, nowIso);
    }
    let next;
    if (phase === 'kaizen') {
      closeKaizen(r, { by, at: nowIso, note: note ?? '', skipped });
      next = 'done';
    } else {
      next = firstPending(r.targetTier, doneNames(r));
      // publish is only over when `finish` has marked the day published, so kaizen cannot follow it yet
      if (next === 'kaizen') next = kaizenEnabled(config) ? 'publish' : 'done';
      if (r.phase !== next) {
        r.phase = next;
        r.phaseStartedAt[next] = nowIso;
      }
    }
    touchLease(r, session, nowIso);
    return {
      run: r,
      result: { phase, alreadyDone: already, next, attempts: r.attempts, phasesDone: doneNames(r), targetTier: r.targetTier, kaizenPending: kaizenPending(r) },
    };
  });
}

export const phaseDone = completePhase;

/** Records a phase as skipped on purpose (it counts as done, so a takeover never walks back to it). */
export function skipPhase({ reason, ...rest }) {
  if (typeof reason !== 'string' || !reason.trim()) throw new UsageError('--reason is required');
  const why = reason.trim();
  return { ...completePhase({ ...rest, note: `skipped: ${why}`, skipped: true }), skipped: true, reason: why };
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

export function eventRun({ kind, msg, by, date, now, config = loadConfig(), code }) {
  if (!EVENT_KINDS.includes(kind)) throw new UsageError(`event kind must be ${EVENT_KINDS.join('|')} (got "${kind}")`);
  if (typeof msg !== 'string' || !msg.trim()) throw new UsageError('--msg is required');
  if (!by) throw new UsageError('--by <role> is required');
  const at = toDate(now);
  const day = assertDate(date ?? localParts(at, config.timezone).date);
  return updateRun(day, (run) => {
    pushEvent(run, kind, msg, by, at.toISOString(), code); // `code`: the machine-readable tag some callers add (usage-warn)
    return { run, result: { kind, events: run.events.length } };
  });
}

export function spendRun({ tokens = 0, calls = 0, phase, session, date, now, level, config = loadConfig() }) {
  const t = Number(tokens);
  const c = Number(calls);
  if (!Number.isFinite(t) || t < 0 || !Number.isFinite(c) || c < 0) throw new UsageError('--tokens and --calls must be non-negative numbers');
  if (phase !== undefined) assertPhase(phase);
  const at = toDate(now);
  const day = assertDate(date ?? localParts(at, config.timezone).date);
  return updateRun(day, (run) => {
    guardHolder(run, session);
    const bucket = phase ?? run.phase;
    const before = spendSummary(config, run, { level });
    run.spend.outputTokens += t;
    run.spend.agentCalls += c;
    const cur = run.spend.byPhase[bucket] ?? { outputTokens: 0, agentCalls: 0 };
    run.spend.byPhase[bucket] = { outputTokens: (cur.outputTokens ?? 0) + t, agentCalls: (cur.agentCalls ?? 0) + c };
    const after = spendSummary(config, run, { level });
    if (after.overCap && !before.overCap && run.status !== 'published') {
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
    const firstPublication = run.status !== 'published';
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
    // Publishing does not end the day: the kaizen (CONTRACT 12) is still owed, and an upgrade never reopens or closes it.
    if (firstPublication) {
      if (kaizenEnabled(config)) {
        run.phase = 'kaizen';
        run.phaseStartedAt.kaizen = nowIso;
      } else {
        run.phase = 'done';
        run.phaseStartedAt.done = nowIso;
        if (!doneNames(run).includes('done')) run.phasesDone.push({ phase: 'done', at: nowIso, by: who, note: `published tier ${newTier}` });
      }
    }
    return {
      run,
      result: {
        ok: true,
        action,
        tier: newTier,
        publishedAt: nowIso,
        publishedUrl: run.publishedUrl,
        removedDirs,
        replaced: run.replaced ?? [],
        kaizenPending: kaizenPending(run),
      },
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
// usage stop (written by scripts/lib/usage.mjs; read by usageStopActive, decide and mergeRuns above)
// ---------------------------------------------------------------------------------------

const sameUsageStop = (a, b) => a.rateLimitType === b.rateLimitType && a.resetsAt === b.resetsAt && a.reason === b.reason;

/**
 * Latches `stop` ({ reason, resetsAt, rateLimitType, kind }) on the run of `date`: run.usageStop = { at, reason, resetsAt, rateLimitType,
 * kind } (kind: overage = money, limit = a refusal), an event, and any earlier clear forgotten (a new stop outranks it). The account's
 * limit is nobody's lease, so no holder check.
 * Returns { found, recorded, ... } and never throws for a missing, unreadable or finished run. A stop identical to the one in
 * force is not recorded again (`repeat:true`): the first sighting keeps its time.
 */
export function latchUsageStop({ date, now, stop, kind = 'rate-limit', session, phase }) {
  const day = assertDate(date);
  const at = toDate(now);
  const nowIso = at.toISOString();
  const read = readRunFile(day);
  if (read.status !== 'ok') return { found: false, ...(read.status === 'corrupt' ? { corrupt: true } : {}) };
  if (read.run.status === 'published' && !kaizenPending(read.run)) return { found: true, recorded: false, finished: true }; // the day is over: nothing left to degrade
  try {
    return updateRun(day, (run) => {
      const active = usageStopActive(run, at.getTime());
      if (active && sameUsageStop(active, stop)) return { result: { found: true, recorded: false, repeat: true, usageStop: active } };
      run.usageStop = {
        at: nowIso,
        reason: inertText(stop.reason),
        resetsAt: stop.resetsAt ?? null,
        rateLimitType: stop.rateLimitType === undefined || stop.rateLimitType === null ? null : inertToken(stop.rateLimitType),
        kind: stop.kind === 'overage' ? 'overage' : 'limit',
      };
      delete run.usageClearedAt;
      const when = stop.resetsAt ? `resets ${stop.resetsAt}` : 'reset time unknown';
      pushEvent(run, kind === 'budget' ? 'budget' : 'rate-limit', `usage stop: ${stop.reason} (${when}); seen by ${session ?? 'an unnamed session'}${phase ? ` in ${phase}` : ''}`, 'usage', nowIso, 'usage-stop');
      return { run, result: { found: true, recorded: true, usageStop: run.usageStop } };
    });
  } catch (err) {
    return { found: false, error: err.message };
  }
}

/**
 * Lifts the usage stop of `date` once nothing but a reading can: its reset time has passed, or it never had one. A stop whose reset
 * time is still ahead stays (`standingStop`): an "allowed" reading may be stale, the reset time is the better witness. The lift
 * deletes run.usageStop and records run.usageClearedAt (so a merge with a writer that still has the stop cannot bring it back).
 * Returns { found, cleared, why?, clearedStop?, standingStop? }.
 */
export function liftUsageStop({ date, now, session }) {
  const day = assertDate(date);
  const at = toDate(now);
  const nowIso = at.toISOString();
  const read = readRunFile(day);
  if (read.status !== 'ok' || !read.run.usageStop) return { found: read.status === 'ok', cleared: false };
  try {
    return updateRun(day, (run) => {
      const prior = run.usageStop;
      if (!prior) return { result: { found: true, cleared: false } };
      const active = usageStopActive(run, at.getTime());
      if (active?.resetsAt) return { result: { found: true, cleared: false, standingStop: active } };
      const passed = Date.parse(prior.resetsAt) <= at.getTime();
      const why = active ? 'the stop had no known reset time and the plan now reads allowed' : passed ? `its reset time (${prior.resetsAt}) has passed` : 'another container had already cleared it';
      delete run.usageStop;
      run.usageClearedAt = nowIso;
      pushEvent(run, 'note', `usage stop recorded ${prior.at ?? '?'} cleared: ${why}; seen by ${session ?? 'an unnamed session'}`, 'usage', nowIso, 'usage-clear');
      return { run, result: { found: true, cleared: true, why, clearedStop: prior } };
    });
  } catch (err) {
    return { found: false, cleared: false, error: err.message };
  }
}

/**
 * The owner's way out of a LIMIT stop that its reset time keeps in force although the plan is open again (a refusal read from a window
 * that does not apply to us, a clock error): deletes run.usageStop, records run.usageClearedAt and an event that carries the owner's
 * reason, and nothing else (the tier the stop forced stays: a tier never goes back up). An overage stop (money) is never cleared this way.
 * Returns { found, cleared, ... }; `refused:'overage'` when it is one. Throws UsageError without a real reason.
 */
export function clearUsageStop({ date, now, reason, session }) {
  const why = typeof reason === 'string' ? inertText(reason, 200) : '';
  if (why.length < 12) throw new UsageError('--reason is required: one sentence saying why this stop is wrong (at least 12 characters)');
  const day = assertDate(date);
  const at = toDate(now);
  const nowIso = at.toISOString();
  return updateRun(day, (run) => {
    const active = usageStopActive(run, at.getTime());
    if (!active) return { result: { found: true, cleared: false, reason: run.usageStop ? 'the stop on file is no longer in force (reset time passed or already cleared)' : 'the run has no usage stop' } };
    if (active.kind === 'overage') {
      const ends = active.resetsAt ? `it ends at its reset time (${active.resetsAt})` : 'its reset time is unknown, so only a `usage observe` that reads allowed lifts it';
      return { result: { found: true, cleared: false, refused: 'overage', reason: `an overage stop (money) is never cleared by hand: ${ends}`, stop: active } };
    }
    const prior = run.usageStop;
    delete run.usageStop;
    run.usageClearedAt = nowIso;
    pushEvent(run, 'note', `usage stop recorded ${prior.at ?? '?'} cleared by hand: ${why}; seen by ${session ? inertToken(session, 120) : 'an unnamed session'}`, 'owner', nowIso, 'usage-clear');
    return { run, result: { found: true, cleared: true, why, clearedStop: active } };
  });
}

// ---------------------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------------------

function nextActionHint({ run, info, config, minutes, spend, usageStop = null }) {
  const sched = scheduleMinutes(config);
  // A manual run (genesis, rerun, repair) has no deadline pressure: clock-based advice would abandon a good run.
  const manual = info.present && info.holder === 'manual';
  if (!run) {
    return minutes >= hm(config.tierCutoffs.t3Until)
      ? `No run for this date and the tier-3 cutoff (${config.tierCutoffs.t3Until}) has passed: only a Postcard fits. \`state.mjs begin --role manual --target-tier 4\` then publish it (deadman.mjs --force does this model-free).`
      : 'No run yet: the primary runs `state.mjs begin --role primary --session <id>`; any other role will start the day at the tier its clock allows.';
  }
  if (run.status === 'published') {
    const upgrade = run.tier > 1 ? '; a better tier may still replace it via `finish` until 23:59 local' : '';
    const kaizen = kaizenPending(run)
      ? info.stale || info.stuck || !info.present
        ? ' Kaizen is pending and its owner is gone: `begin` (primary, wdA, wdB or manual) resumes it until 12:00 local, the closer never does.'
        : ` Kaizen is pending: ${info.holder} is running it.`
      : '';
    return `Published at tier ${run.tier} (${run.publishedUrl ?? 'no url'}). Nothing to do for the page${upgrade}.${kaizen}`;
  }
  const parts = [];
  if (run.status === 'failed') {
    parts.push('Run is marked failed: any role can `begin` to take it over and continue at ' + firstPending(run.targetTier, doneNames(run)) + '.');
  } else if (!info.present) {
    parts.push('Run has no lease: `begin` takes it over.');
  } else if (info.hbUnreadable) {
    parts.push(`${info.holder} last checkpointed ${info.ageMinutes} min ago but the heartbeat branch cannot be read (hb-unreadable): its silence is not proof of death, so \`begin\` leaves it alone until ${doubtUntil(config, info)} or a phase stuck past ${info.stuckLimitMinutes} min.`);
  } else if (info.watchStale && !info.beatStale) {
    parts.push(`The phase watch for ${run.phase} is ${info.watchOverdueMinutes} min overdue (limit ${WATCH_STALE_AFTER_MINUTES}) although ${info.holder} still beats: treated as hung, \`begin\` takes over at ${firstPending(run.targetTier, doneNames(run))}.`);
  } else if (info.stale) {
    parts.push(`Lease of ${info.holder} is STALE (${info.ageMinutes} min silent, limit ${config.leaseStaleMinutes}): \`begin\` takes over at ${firstPending(run.targetTier, doneNames(run))}.`);
  } else if (info.stuck) {
    parts.push(`${info.holder} is heartbeating but phase ${run.phase} has run ${info.phaseMinutes} min (limit ${info.stuckLimitMinutes}): treated as hung, \`begin\` takes over.`);
  } else {
    parts.push(`${info.holder} is alive (last sign ${info.ageMinutes} min ago) in ${run.phase}${info.phaseMinutes === null ? '' : ` for ${info.phaseMinutes} min`}: watchdogs exit quietly.`);
  }
  if (info.watchOverdueMinutes > 0 && !info.watchStale) {
    parts.push(`The phase watch for ${run.phase} fell due ${info.watchOverdueMinutes} min ago and nothing answered it: the holder obeys the PHASEWATCH verdict (\`state.mjs watch check\`), and \`begin\` takes over once it is ${WATCH_STALE_AFTER_MINUTES} min late.`);
  }
  const pending = run.directives.filter((d) => !d.ack);
  if (pending.length) parts.push(`Pending directives for the holder: ${pending.map((d) => `${d.kind}(tier ${d.tier})`).join(', ')}.`);
  if (spend.overCap) parts.push(`Output tokens ${spend.outputTokens} are over the ${spend.capTokens} cap: no new agent work, go to package or a fallback.`);
  if (usageStop) parts.push(`A usage stop is in force (${usageStop.reason}, ${usageStop.resetsAt ? `until ${usageStop.resetsAt}` : 'reset time unknown'}): no agent work may start; \`begin\` degrades the day to the Ideas Day or Postcard (scripts only). ${usageStop.resetsAt ? 'It ends at its reset time (a `usage observe` that reads allowed does not lift it earlier).' : 'Its reset time is unknown: a `usage observe` that reads allowed lifts it.'}`);
  if (manual) {
    parts.push('This is a manual run: clock-based advice (deadline, tier cutoffs) does not apply to it; ignore clock hints.');
  } else if (minutes >= sched.hardStop) {
    parts.push(`The hard stop (${config.schedule.hardStop}) has passed without a publish: force-resolve now (salvage a finished build as tier 2, else the Ideas Day, else the Postcard; deadman.mjs --force does it model-free).`);
  } else if (minutes >= sched.graceUntil) {
    parts.push(`The grace period ended at ${config.schedule.graceUntil} without a publish: the closer force-degrades; ship the best fallback now.`);
  } else if (minutes >= sched.deadline) {
    parts.push(
      isLatePhase(run.phase) && info.present && !info.stale && !info.stuck
        ? `The ${config.schedule.deadline} deadline is a guideline and the run is in ${run.phase} with a live lease: it keeps going until ${config.schedule.graceUntil} (quality beats punctuality).`
        : `The ${config.schedule.deadline} deadline (a guideline) has passed and phase ${run.phase} is not one of ${LATE_PHASES.join('/')}: the closer force-degrades a run that is not in a late phase, so ship the best fallback now.`,
    );
  }
  return parts.join(' ');
}

export function statusSummary({ date, now, config = loadConfig(), history = [], heartbeat = null, hbUnknown = false, hbMissing = false, level }) {
  const at = toDate(now);
  const day = assertDate(date ?? localParts(at, config.timezone).date);
  const read = readRunFile(day);
  const minutes = effectiveMinutes(config, at, day);
  const run = read.run;
  const info = leaseInfo(config, run, latestHeartbeat(loadHeartbeat(day, run?.lease?.session), validHeartbeat(heartbeat, run?.lease?.session)), at.getTime(), { hbUnknown, hbMissing });
  const sched = scheduleMinutes(config);
  const base = {
    date: day,
    now: at.toISOString(),
    time: localParts(at, config.timezone).time,
    minutesToDeadline: sched.deadline - minutes,
    minutesToGraceUntil: sched.graceUntil - minutes,
    minutesToHardStop: sched.hardStop - minutes,
    phaseIsLate: run ? isLatePhase(run.phase) : false,
    targetTierIfStartedNow: tierByMinutes(config, minutes),
    exists: read.status === 'ok',
    runFile: read.status,
    kaizenPending: kaizenPending(run),
    qaBlock: qaBlock(day),
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
  const spend = spendSummary(config, run, { level });
  const usageStop = usageStopActive(run, at.getTime());
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
      ? { ...run.lease, ageMinutes: info.ageMinutes, lastSignOfLifeAt: info.lastBeatAt, source: info.source, stale: info.stale, stuck: info.stuck, hbUnreadable: info.hbUnreadable, alive: !info.stale && !info.stuck, ...(info.watchStale ? { watchStale: true } : {}) }
      : null,
    ...(run.watch ? { watch: watchSummary(run, at.getTime()) } : {}),
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
    ...(usageStop ? { usageStop } : {}),
    nextAction: nextActionHint({ run, info, config, minutes, spend, usageStop }),
    history,
  };
}
