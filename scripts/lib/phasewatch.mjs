// Phase watchdog (`state.mjs watch ...`, CONTRACT 6.1): a stalled Workflow can never stall a day.
//
// A Workflow runs in the background and the operator's turn ends; when one of its agents dies or is interrupted the
// Workflow can hang for ever and nothing wakes the orchestrator. So before every launch the operator arms a watch:
// `arm` records run.watch and prints the fields of a one-shot `send_later` that delivers a PHASEWATCH line back into the
// same session once the phase budget plus a margin has run out; `bind` stores the trigger id (and the Workflow task id);
// `check` is what that line tells the operator to run: it answers whether the phase really overran (stop the Workflow,
// then retry compact or degrade) or whether the timer no longer matters (the verdict `stale`); `disarm` retires the watch.
//
// Layout: the decisions are pure functions of plain data (computeDue, classifyWatch, planOverdue, ...) so they can be
// tested without a repo; the five commands at the bottom read and write run.watch through runstate's locked run-file API.
// Nothing here pushes: the watch is part of the local run file and the next `sync` carries it (the launch sequence of PLAYBOOK 7.1a
// syncs once after the arm, so other containers see it). A watch that is overdue by WATCH_STALE_AFTER_MINUTES makes `begin` treat its
// holder's lease as stale (runstate.leaseInfo).
//
// A timer measures elapsed time, and a healthy Workflow on two agent slots is slow: so a phase that is past its due time but whose files
// are still changing is not stopped; the watch moves out (`extend`, twice at most). The timer that wakes the session has fired, so it is
// never deleted again (deleting a routine that has fired may delete the session it fired into): only a pending timer is cancelled.
//
// Whatever run.watch holds, nothing here throws for it: a damaged block is "no watch" (verdict stale, code corrupt-watch).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rp, repoRoot, localParts, loadConfig } from './common.mjs';
import {
  PHASES,
  ROLES,
  KAIZEN_CUTOFF_MINUTES,
  WATCH_STALE_AFTER_MINUTES,
  WATCH_MARGIN_MINUTES,
  StateError,
  UsageError,
  assertDate,
  assertPhase,
  doneNames,
  guardHolder,
  hasDoneMarker,
  isoMs,
  kaizenPending,
  phaseIsOver,
  pushEvent,
  qaBlock,
  readRunFile,
  scheduleMinutes,
  stagingDirs,
  toDate,
  updateRun,
  watchMarginMinutes,
  watchOverdueMinutes,
} from './runstate.mjs';

export { WATCH_STALE_AFTER_MINUTES, WATCH_MARGIN_MINUTES, watchMarginMinutes };

// watchMarginMinutes (runstate.mjs): the watch fires this long after the phase budget the Workflow was given (the Workflow honors the
// budget itself): WATCH_MARGIN_MINUTES, plus one member's turn for the kaizen round. The lease rule of runstate.leaseInfo uses the same
// numbers, so the two cannot drift.
/** The watch never falls due later than this before the day's hard stop (the kaizen cutoff for the kaizen phase). */
export const HARD_STOP_BUFFER_MINUTES = 5;
/** A retry is not offered with less than this left before that bound: nothing can be redone in less, and the retry's wipe would destroy
 * files the closer could still salvage at the hard stop. The two-failures table (degrade) applies instead. */
export const MIN_RETRY_MINUTES = 30;
/** ... and never sooner than this after it was armed. */
export const MIN_WATCH_MINUTES = 5;
/** A watch that cannot fire within six hours protects nothing. */
export const MAX_WATCH_MINUTES = 6 * 60;
/** `send_later` fires on whole minutes, so a timer up to this much early still counts as due. */
export const EARLY_TOLERANCE_MINUTES = 2;
/** A timer delivered later than this after its due time is too old to act on (an abandoned run, a container that slept): the verdict is stale. */
export const MAX_LATE_MINUTES = 120;
/** A file under work/<D> that changed this recently when the watch falls due says the Workflow is still working (the default window). */
export const PROGRESS_FRESH_MINUTES = 20;
/**
 * The window per phase: one agent call writes nothing until it writes its file in one go, and in these phases one call can be silent for
 * longer than 20 minutes on a healthy day: a builder's 1000-line module (2026-10-11: ui.js 1097 lines, render.js 1056), the architect's
 * SPEC.md, a scout's or a verifier's batch after its searches, a fix agent's copy, QA's review. A too short window stops and wipes a
 * healthy phase (retry); a too long one only grants a hung one its two extensions (30 minutes).
 */
export const PROGRESS_FRESH_BY_PHASE = Object.freeze({ ideate: 30, spec: 30, build: 35, qa: 25, revise: 30 });
/** The freshness window of `phase` in minutes. */
export const progressFreshMinutes = (phase) => PROGRESS_FRESH_BY_PHASE[phase] ?? PROGRESS_FRESH_MINUTES;
/** A working Workflow gets the watch moved out by this much, at most MAX_EXTENSIONS times (kaizen never: its tree must stay clean). */
export const EXTEND_MINUTES = 15;
export const MAX_EXTENSIONS = 2;
/** A DONE.json older than this when the timer fires means the Workflow's notification is lost: it would have woken the session first. */
export const NOTIFICATION_GRACE_MINUTES = 5;
/** A fresh DONE.json: the notification is probably queued behind the PHASEWATCH turn; a follow-up check this much later catches a lost one. */
export const FOLLOW_UP_MINUTES = 10;
/** A work tree with more entries than this is not walked to the end (the newest change found so far stands). */
const MAX_WALK_ENTRIES = 20_000;
/** A file change this far in the future of the clock the command runs by is not progress (clock skew, a pinned --now). */
const FUTURE_SLACK_MS = 5 * 60_000;
/** How many Workflow task ids a block remembers as stopped (to recognise the echo of a TaskStop). */
const MAX_STOPPED_TASKS = 6;
/** The Bash tool's longest background timeout (2 hours) bounds the heartbeat loop of a launch (PLAYBOOK 7.1a step 5). */
const LOOP_TIMEOUT_MS = 7_200_000;
/** One beat of the heartbeat-branch loop waits this long; 26 beats (117 minutes) fit in the timeout. */
const BEAT_SECONDS = 270;
const MAX_LOOP_BEATS = 26;
/** heartbeat.mjs pushes a beat that only moves the timestamp at most every 10 minutes: with a beat every 4.5 minutes every third one
 * reaches the branch, so the last pushed beat can be 14 minutes older than the end of the loop. */
const HB_PUSH_GAP_MINUTES = 14;
/** The PHASEWATCH turn (delivered up to 2 minutes after the due time) runs `watch check` and its `sync`, which pushes a fresh lease. */
const LOOP_SLACK_MINUTES = 10;

/** The budget of a phase that config.phaseBudgetMinutes has no usable entry for: the "hard cap" column of PLAYBOOK section 2. */
export const DEFAULT_PHASE_MINUTES = Object.freeze({
  preflight: 15,
  ideate: 75,
  select: 30,
  spec: 35,
  build: 80,
  qa: 30,
  revise: 40,
  package: 25,
  publish: 15,
  kaizen: 75,
});

/** Required outputs per phase (PLAYBOOK 7.3), shown with an overdue verdict so the operator sees what a stalled phase left behind. */
const REQUIRED_OUTPUTS = {
  ideate: ['work/<D>/ideas/shortlist.json', 'work/<D>/ideate/DONE.json'],
  select: ['state/ideas/<D>.json', 'work/<D>/select/DONE.json'],
  // PROJECT.json too: build reads it (the heading, the tagline, the draft of package/project.json)
  spec: ['work/<D>/spec/SPEC.md', 'work/<D>/spec/DESIGN.md', 'work/<D>/spec/OWNERSHIP.json', 'work/<D>/spec/PROJECT.json', 'work/<D>/spec/DONE.json'],
  build: ['work/<D>/build/site/index.html', 'work/<D>/build/DONE.json'],
  qa: ['work/<D>/qa/report.json', 'work/<D>/qa/DONE.json'],
  revise: ['work/<D>/qa/report.json', 'work/<D>/revise/log.json', 'work/<D>/revise/DONE.json'],
};

const MIN_MS = 60_000;
// Ids ride inside the PHASEWATCH line and inside commands the operator will run: plain tokens only.
const TOKEN = /^[A-Za-z0-9_][A-Za-z0-9_.:@-]{0,119}$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const hhmmOf = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const tokenOrNull = (v) => (typeof v === 'string' && TOKEN.test(v) ? v : null);
const noMillis = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export function assertToken(value, label) {
  if (typeof value !== 'string' || !TOKEN.test(value)) {
    throw new UsageError(`--${label} must be a plain id (letters, digits and ._:@- only, at most 120 characters; got ${JSON.stringify(value)})`);
  }
  return value;
}

function positiveMinutes(value, label) {
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (value === undefined || value === null || String(value).trim() === '' || !Number.isFinite(n) || n <= 0) {
    throw new UsageError(`${label} must be a positive number of minutes (got ${JSON.stringify(value)})`);
  }
  return n;
}

function positiveInt(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`${label} must be a positive integer (got ${JSON.stringify(value)})`);
  return n;
}

// ---------------------------------------------------------------------------------------
// time: when does the watch fall due
// ---------------------------------------------------------------------------------------

/** Epoch ms of the local wall time `date` `hhmm` in `tz` (DST aware; NaN for nonsense). */
export function zonedInstant(date, hhmm, tz) {
  const [y, mo, d] = String(date).split('-').map(Number);
  const [h, mi] = String(hhmm).split(':').map(Number);
  const want = Date.UTC(y, mo - 1, d, h, mi);
  if (!Number.isFinite(want)) return NaN;
  let guess = want;
  for (let i = 0; i < 4; i++) {
    const lp = localParts(new Date(guess), tz);
    const got = Date.parse(`${lp.date}T00:00:00Z`) + lp.minutes * MIN_MS;
    if (got === want) break;
    guess += want - got;
  }
  return guess;
}

/** The phase's budget in minutes: the flag, else config.phaseBudgetMinutes[phase] when it is a positive number, else the default table. */
export function phaseBudget(config, phase, override) {
  if (override !== undefined) return { minutes: override, source: 'flag' };
  const v = config?.phaseBudgetMinutes?.[phase];
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return { minutes: v, source: 'config' };
  return { minutes: DEFAULT_PHASE_MINUTES[phase] ?? 60, source: 'default' };
}

/**
 * Pure. Minutes from `nowMs` to the latest instant a watch of `phase` may fall due: the day's hard stop minus 5 minutes (the kaizen
 * cutoff minus 5 for `kaizen`, which runs after the publish); negative once that is past. null when nothing binds: a manual run, a rerun
 * of a day that is already over, a schedule without a usable hard stop.
 */
export function boundRoomMinutes({ config, date, phase, nowMs, manual = false }) {
  if (manual || localParts(new Date(nowMs), config.timezone).date > date) return null;
  const boundMinutes = phase === 'kaizen' ? KAIZEN_CUTOFF_MINUTES : scheduleMinutes(config).hardStop;
  if (!Number.isFinite(boundMinutes)) return null;
  const latest = zonedInstant(date, hhmmOf(boundMinutes), config.timezone) - HARD_STOP_BUFFER_MINUTES * MIN_MS;
  const room = (latest - nowMs) / MIN_MS;
  return Number.isFinite(room) ? room : null;
}

/**
 * Pure. When does a watch armed at `nowMs` fall due: budget + margin minutes later (watchMarginMinutes: 10, 25 for the kaizen round;
 * `marginMinutes` overrides it), scaled DOWN so that it is not later than the day's hard stop minus 5 minutes (the kaizen cutoff for
 * `kaizen`, which runs after the publish), and never sooner than 5 minutes. A manual run, or a rerun of a day that is already over, has
 * no deadline pressure: no hard-stop clamp then.
 * Returns { dueMs, delayMinutes, clamped } with clamped null | 'hard-stop' | 'kaizen-cutoff' | 'min' | 'max'.
 */
export function computeDue({ config, date, phase, nowMs, budgetMinutes, manual = false, marginMinutes = watchMarginMinutes(phase) }) {
  let delay = budgetMinutes + marginMinutes;
  let clamped = null;
  if (delay > MAX_WATCH_MINUTES) {
    delay = MAX_WATCH_MINUTES;
    clamped = 'max';
  }
  const room = boundRoomMinutes({ config, date, phase, nowMs, manual });
  if (room !== null && room < delay) {
    delay = room;
    clamped = phase === 'kaizen' ? 'kaizen-cutoff' : 'hard-stop';
  }
  if (delay < MIN_WATCH_MINUTES) {
    delay = MIN_WATCH_MINUTES;
    clamped = 'min';
  }
  return { dueMs: Math.round(nowMs + delay * MIN_MS), delayMinutes: round2(delay), clamped };
}

/** A path as one shell word: plain paths as they are, anything else single-quoted. */
const shellWord = (text) => (/^[A-Za-z0-9_./:@+-]+$/.test(text) ? text : `'${String(text).replace(/'/g, `'\\''`)}'`);

/**
 * The line that `send_later` delivers back into the session when the watch falls due. Every field is a validated token. It is
 * self-contained: it names the attempt (a timer of an earlier attempt must not act on the current one), says it is the session's own
 * timer, and, when the repo root is given, the directory to run the command in.
 */
export function watchMessage({ date, phase, attempt, session, dueAt, root }) {
  const cd = root ? `cd ${shellWord(root)} && ` : '';
  return `PHASEWATCH ${date} ${phase} attempt ${attempt} session ${session} due ${dueAt}. Your own timer (phase watch, PLAYBOOK 7.1a). Run: ${cd}node scripts/state.mjs watch check --date ${date} --phase ${phase} --session ${session} --attempt ${attempt} and obey its verdict.`;
}

/**
 * The arguments of the `send_later` call for a watch; `at` is the due time rounded UP to the minute (send_later truncates seconds).
 * The name carries the attempt, so the routines list never shows two timers of one name (one spent, one pending).
 */
export function sendLaterFor({ date, phase, attempt, session, dueAt, root }) {
  return {
    at: noMillis(Math.ceil(Date.parse(dueAt) / MIN_MS) * MIN_MS),
    name: `sed-watch-${date}-${phase}-a${attempt}`,
    message: watchMessage({ date, phase, attempt, session, dueAt, root }),
  };
}

// ---------------------------------------------------------------------------------------
// the run.watch block
// ---------------------------------------------------------------------------------------

/**
 * Pure. Reads whatever run.watch holds: { ok:true, watch } with sanitized ids, or { ok:false, reason } where reason is
 * 'no-watch' (absent) or 'corrupt-watch' (not a usable block: phase, session and an ISO dueAt are the minimum).
 */
export function readWatch(raw) {
  if (raw === undefined || raw === null) return { ok: false, reason: 'no-watch' };
  if (!isObj(raw)) return { ok: false, reason: 'corrupt-watch' };
  const dueMs = isoMs(raw.dueAt);
  if (!PHASES.includes(raw.phase) || raw.phase === 'done' || typeof raw.session !== 'string' || !raw.session || !Number.isFinite(dueMs)) {
    return { ok: false, reason: 'corrupt-watch' };
  }
  return {
    ok: true,
    watch: {
      ...raw,
      attempt: Number.isInteger(raw.attempt) && raw.attempt >= 1 ? raw.attempt : 1,
      dueMs,
      triggerId: tokenOrNull(raw.triggerId),
      workflowTask: tokenOrNull(raw.workflowTask),
      stoppedTasks: Array.isArray(raw.stoppedTasks) ? raw.stoppedTasks.map(tokenOrNull).filter(Boolean).slice(-MAX_STOPPED_TASKS) : [],
    },
  };
}

/** Arms per phase recorded in a block ({ ideate: 1, ... }); a valid block from before the counter existed counts as its own attempt. */
function armsOf(raw) {
  const arms = {};
  if (isObj(raw?.arms)) {
    for (const [phase, n] of Object.entries(raw.arms)) if (PHASES.includes(phase) && Number.isInteger(n) && n >= 1) arms[phase] = n;
  }
  if (PHASES.includes(raw?.phase) && !arms[raw.phase] && Number.isInteger(raw.attempt) && raw.attempt >= 1) arms[raw.phase] = raw.attempt;
  return arms;
}

function touchLease(run, session, nowIso) {
  if (run.lease && run.lease.session === session) run.lease.heartbeatAt = nowIso;
}

// ---------------------------------------------------------------------------------------
// check: the verdict (pure part)
// ---------------------------------------------------------------------------------------

/**
 * Pure. Decides what a PHASEWATCH line means for `run` at `nowMs`. Returns
 *   { verdict:'stale', code, reason, foreign?, watch? }   the timer no longer matters. `foreign` = the request is not about the
 *                                                           run's current watch, so that watch's trigger is not ours to delete
 *   { verdict:'early', watch, remainingMinutes }          the timer fired more than 2 minutes before the watch falls due
 *   { verdict:'overdue', watch, overdueMinutes }           the phase is still the current one, not done, and past its due time
 *                                                           (stale 'expired' instead when that was more than MAX_LATE_MINUTES ago)
 * `attempt` (optional) is the attempt the PHASEWATCH line named; `displacedBy` the remote lease that took this session's lease.
 */
export function classifyWatch({ run, phase, session, attempt, nowMs, displacedBy = null }) {
  const stale = (code, reason, extra = {}) => ({ verdict: 'stale', code, reason, ...extra });
  const res = readWatch(run?.watch);
  if (!res.ok) {
    return stale(res.reason, res.reason === 'no-watch' ? 'the run has no phase watch' : 'run.watch is not a usable watch block (phase, session and an ISO dueAt are required)', { foreign: true });
  }
  const w = res.watch;
  // The request must be about this very watch; otherwise it is another timer's business and its trigger is not ours to delete.
  if (w.phase !== phase) return stale('other-phase', `the run's watch is for ${w.phase}, not ${phase}`, { foreign: true, watch: w });
  if (w.session !== session) return stale('other-session', `the run's watch belongs to session ${w.session}, not ${session}`, { foreign: true, watch: w });
  if (attempt !== undefined && attempt !== w.attempt) {
    return stale('superseded', `this timer was for attempt ${attempt}; the run's watch is attempt ${w.attempt}`, { foreign: true, watch: w });
  }
  if (w.disarmedAt) return stale('disarmed', `the watch was disarmed at ${w.disarmedAt}`, { watch: w });
  if (displacedBy) {
    return stale('displaced', `${displacedBy.holder}/${displacedBy.session} took the lease on the shared branch: this session no longer owns the day (PLAYBOOK 6.6)`, { watch: w });
  }
  if (run.status === 'failed') return stale('run-failed', 'the run is marked failed; the next `begin` takes it over', { watch: w });
  if (run.lease && run.lease.session !== session) {
    return stale('lease-held-by-other', `the lease is held by ${run.lease.holder}/${run.lease.session}, not by ${session} (PLAYBOOK 6.6)`, { watch: w });
  }
  if (run.status === 'published' && !(w.phase === 'kaizen' && kaizenPending(run))) {
    return stale('published', `the day is published (tier ${run.tier ?? '?'}); nothing is left to watch in ${w.phase}`, { watch: w });
  }
  if (phaseIsOver(run, w.phase)) return stale('phase-done', `${w.phase} is already in phasesDone`, { watch: w });
  if (run.phase !== w.phase) return stale('phase-moved', `the run moved on: it is in ${run.phase} now, not in ${w.phase}`, { watch: w });
  const used = Number(run.attempts?.[w.phase]) || 0;
  if (w.firedAt && Number.isInteger(w.attemptsAtFire) && used > w.attemptsAtFire) {
    return stale('restarted', `${w.phase} was started again (attempt ${used}) after this watch fired; the watch of the running attempt must be armed with \`watch arm\``, { watch: w });
  }
  const remaining = (w.dueMs - nowMs) / MIN_MS;
  if (remaining > EARLY_TOLERANCE_MINUTES) return { verdict: 'early', watch: w, remainingMinutes: round1(remaining) };
  // A timer delivered hours or days late (an abandoned run, a container that slept) describes a situation others have long since dealt with
  // or will deal with through `begin`: acting on it would wipe and retry a phase nobody is running.
  if (-remaining > MAX_LATE_MINUTES) {
    return stale('expired', `this timer fell due ${Math.round(-remaining)} min ago (more than ${MAX_LATE_MINUTES}): too old to act on; \`begin\` decides what happens to the run`, { watch: w });
  }
  return { verdict: 'overdue', watch: w, overdueMinutes: round1(Math.max(0, -remaining)) };
}

// ---------------------------------------------------------------------------------------
// check: what to do about an overdue phase (pure part)
// ---------------------------------------------------------------------------------------

/** The two-failures table of PLAYBOOK 6.7: what happens to the day when `phase` has no attempts left. */
export function degradePlan({ phase, targetTier, hasIdeas, blocked }) {
  const tier = (extra = '') => {
    const toTier = Math.max(targetTier ?? 1, hasIdeas ? 3 : 4);
    const page = toTier === 3 ? 'publish the Ideas Day (PLAYBOOK 9.1)' : 'publish the Postcard (PLAYBOOK 9.2)';
    return { how: 'tier', toTier, skip: [], note: `${phase} has no attempts left: ${page}, and the carry-over settle saves the intended winner (PLAYBOOK 10.3)${extra}` };
  };
  switch (phase) {
    case 'qa':
      return { how: 'skip', toTier: null, skip: ['qa', 'revise'], note: 'qa has no attempts left: package with the validator and the smoke run only (PLAYBOOK 6.7 two failures) and say so in the report' };
    case 'revise':
      return blocked
        ? tier(' (QA still blocks the build, so it is not shipped)')
        : { how: 'skip', toTier: null, skip: ['revise'], note: 'revise has no attempts left and QA does not block shipping: package, listing the known issues in the report' };
    case 'kaizen':
      return { how: 'skip', toTier: null, skip: ['kaizen'], note: 'the page is live: closing the kaizen on purpose, then PLAYBOOK 10.7 (handoff)' };
    case 'preflight':
      return { how: 'skip', toTier: null, skip: [], note: 'preflight has no attempts left: skip the premortem (it never blocks the day) and go on with the rest of preflight' };
    case 'ideate':
      return tier('; before that see whether a partial shortlist of 7 or more can be accepted (PLAYBOOK 6.7 "Ideate came back short" step 4)');
    default:
      return tier();
  }
}

function retryWipe(phase, date) {
  if (phase === 'ideate') return `if [ -d work/${date}/ideas ]; then mv work/${date}/ideas work/${date}/ideas.attempt1; fi; rm -rf work/${date}/ideate`;
  const dirs = stagingDirs(phase);
  return dirs.length ? `rm -rf ${dirs.map((d) => `work/${date}/${d}`).join(' ')}` : null;
}

/**
 * The DONE.json a finished-by-hand phase gets. spec: compact and tier come from work/<D>/spec/PROGRESS.json, which the spec Workflow
 * writes before its architect starts (PLAYBOOK 8.4 reads them from DONE.json when the result is missing); without it the safe side,
 * compact, tier 2 (a compact build of a full spec only lowers the bar, a full build of a mini-spec fails it: FM-83).
 */
function handDone(phase, date) {
  const dir = `work/${date}/${phase}`;
  if (phase !== 'spec') return `mkdir -p ${dir} && echo '{"ok":true,"phase":"${phase}","by":"orchestrator"}' > ${dir}/DONE.json`;
  return `node -e 'const fs=require("fs");let p={};try{p=JSON.parse(fs.readFileSync("${dir}/PROGRESS.json","utf8"))}catch{}const c=p.compact!==false;fs.writeFileSync("${dir}/DONE.json",JSON.stringify({ok:true,phase:"spec",by:"orchestrator",compact:c,tier:c?2:1})+"\\n")'`;
}

/** What PLAYBOOK 7.3 checks before `phase` is done: what the operator runs on a phase that wrote everything but its DONE.json. */
function phaseCheck(phase, date) {
  return (
    {
      ideate: `Appendix A1 on work/${date}/ideas/shortlist.json with MODE=shortlist (PARTIAL=1 accepts 7 to 9 ideas, PLAYBOOK 6.7)`,
      select: `Appendix A1 on state/ideas/${date}.json with MODE=final and SLUG=<the slug> (PARTIAL=1 when ideate was accepted partial)`,
      spec: `work/${date}/spec/SPEC.md, DESIGN.md, OWNERSHIP.json and PROJECT.json exist and are non-empty, and OWNERSHIP.json and PROJECT.json parse (the DONE.json command below copies compact and tier from work/${date}/spec/PROGRESS.json: PLAYBOOK 8.4 applies to them)`,
      build: `work/${date}/build/site/index.html exists and the trial stage of PLAYBOOK 10.1 passes`,
      qa: `work/${date}/qa/report.json parses and has counts`,
      revise: `work/${date}/qa/report.json was rewritten with a higher revision than QA wrote`,
    }[phase] ?? null
  );
}

/** The attempts of a phase as `begin` counts them (run.attempts, bumped by `phase-start`) and by the watch's own arm counter. */
function attemptCounts(run, config, watch) {
  const maxAttempts = Number.isInteger(config.maxAttemptsPerPhase) && config.maxAttemptsPerPhase > 0 ? config.maxAttemptsPerPhase : 2;
  const attemptsUsed = Math.max(Number(run.attempts?.[watch.phase]) || 0, watch.attempt);
  return { maxAttempts, attemptsUsed, attemptsLeft: Math.max(0, maxAttempts - attemptsUsed) };
}

/**
 * Pure. The plan for an overdue phase. `facts` = { doneMarker, outputs, hasIdeas, blocked, progress } (see gatherFacts).
 * next: 'nothing' (the phase wrote its DONE.json: it finished), 'finish-by-hand' (it wrote every required output but its DONE.json: check
 * and finish it instead of redoing it; `fallback` is what happens when the check fails), 'retry' (attempts left: same phase, compact) or
 * 'degrade' (attempts exhausted: the existing two-failures table of PLAYBOOK 6.7). Attempts are counted as `begin` counts them
 * (run.attempts, bumped by `phase-start`) and also by the watch's own arm counter, so a missing `phase-start` cannot loop for ever.
 * `roomMinutes` (boundRoomMinutes: minutes left before the hard stop minus 5, or the kaizen cutoff minus 5; null when nothing binds):
 * with less than MIN_RETRY_MINUTES left no retry is offered, whatever the attempts say: the degrade table applies (`tooLate:true`).
 * The timer that woke the session has fired and is spent: no step ever deletes it.
 */
export function planOverdue({ run, config, watch, facts, role, date, session, overdueMinutes, roomMinutes = null }) {
  const phase = watch.phase;
  const { maxAttempts, attemptsUsed, attemptsLeft } = attemptCounts(run, config, watch);
  const tooLate = typeof roomMinutes === 'number' && Number.isFinite(roomMinutes) && roomMinutes < MIN_RETRY_MINUTES;
  const boundName = phase === 'kaizen' ? 'the 12:00 kaizen cutoff' : `the hard stop ${config.schedule?.hardStop ?? ''}`.trim();
  // R lands in commands the operator will run: only a real role name may get there, whatever the run file says
  const R = [role, run.lease?.holder, watch.role].find((r) => ROLES.includes(r)) ?? 'primary';
  const disarm = `node scripts/state.mjs watch disarm --phase ${phase} --session ${session} --date ${date}`;
  const kaizen = phase === 'kaizen';
  const stop = kaizen
    ? `TaskStop the kaizen Workflow task (its id is in "$HOME/.sed-wf-${date}-kaizen" when you saved it there, else the one the Workflow tool printed; the kaizen binds none: a bind would dirty the tree its gate checks)`
    : watch.workflowTask
      ? `TaskStop({ task_id: "${watch.workflowTask}" })   (the Workflow task bound at launch; stopping a finished task is harmless)`
      : `TaskStop the running ${phase} Workflow task (the id the Workflow tool printed at launch; none was bound with watch bind --workflow-task)`;
  const late = `${phase} attempt ${watch.attempt} fell due ${watch.dueAt} (${overdueMinutes} min ago) and is still the current phase`;
  const outputs = facts.outputs ?? { required: [], present: [], missing: [] };
  const doneFile = `work/${date}/${phase}/DONE.json`;
  const shown = outputs.required.length
    ? [`state of ${phase}: present ${outputs.present.length ? outputs.present.join(', ') : 'nothing'}; missing ${outputs.missing.length ? outputs.missing.join(', ') : 'nothing'}`]
    : [];

  if (facts.doneMarker) {
    // A Workflow that finished well before its timer would have woken the session with its notification first: that one is lost, and
    // waiting for it would stall the day (nothing else wakes the session). A fresh DONE.json: the notification is probably queued.
    const age = facts.doneAgeMinutes;
    const lost = typeof age === 'number' && Number.isFinite(age) && age > NOTIFICATION_GRACE_MINUTES;
    const finishFromFiles = `the PLAYBOOK 7.3 checks, spend (no result: charge the PLAYBOOK 6.5 estimate) and the checkpoint from the files, as if it had returned (PLAYBOOK 6.7: the files are the truth)`;
    return {
      next: 'nothing',
      hint: null,
      attemptsUsed,
      maxAttempts,
      attemptsLeft,
      degrade: null,
      awaitNotification: !lost,
      reason: lost
        ? `${late}, but ${doneFile} exists: the Workflow finished ${Math.round(age)} min ago and its notification never came`
        : `${late}, but ${doneFile} exists: the Workflow finished and only its report is missing`,
      steps: lost
        ? [
            `Do NOT stop or retry ${phase}: its DONE.json was written ${Math.round(age)} min ago (the last thing the Workflow does), so it finished, and its notification would have woken you before this timer: it is lost. Do not wait for it.`,
            `run: ${disarm}   (the timer that woke you has fired and is spent: delete nothing)`,
            `Then ${finishFromFiles}. A notification that still arrives finds the watch disarmed: one line, touch nothing.`,
          ]
        : [
            `Do NOT stop or retry ${phase}: its DONE.json is written (the last thing the Workflow does), so it finished.`,
            'If its task-notification arrives, handle it as usual: watch disarm (with --workflow-task), the PLAYBOOK 7.3 checks, spend, checkpoint.',
            `It is probably queued behind this turn. So that a lost one cannot stall the day: call send_later with followUp.at, followUp.name and followUp.message (one more check in ${FOLLOW_UP_MINUTES} minutes; bind nothing), then end the turn. If that check finds the watch still armed it says the notification is lost: then run: ${disarm} (the timer that woke you has fired and is spent: delete nothing) and do ${finishFromFiles}.`,
          ],
    };
  }

  let base;
  if (attemptsLeft > 0 && !tooLate) {
    const steps = [stop, ...shown];
    if (kaizen) {
      steps.push(`run: node scripts/state.mjs sync -m "sed(${date}): ${R} kaizen watch fired"   (commits the watch-fired event; never git checkout the run file)`);
      steps.push('run: git status --short   (it must print nothing; restore only paths outside state/, work/ and docs/ as PLAYBOOK 10.6 step 4 says)');
    } else {
      const wipe = retryWipe(phase, date);
      if (wipe) steps.push(`run: ${wipe}`);
    }
    steps.push(`run: node scripts/state.mjs phase-start --phase ${phase} --session ${session} --date ${date}   (expect attempt ${attemptsUsed + 1} and overLimit:false)`);
    if ((run.targetTier ?? 1) < 2 && !kaizen) {
      steps.push(`run: node scripts/state.mjs directive --kind scope-cut --tier 2 --by ${R} --date ${date}`);
      steps.push(`run: node scripts/state.mjs ack-directive --kind scope-cut --date ${date}`);
      steps.push(`run: node scripts/state.mjs event --kind degrade --msg "${phase} stalled (phase watch): retrying compact, tier 2" --by ${R} --date ${date}`);
    }
    if (phase === 'revise') {
      steps.push(`run: node scripts/state.mjs revise plan --date ${date} --session ${session} --role ${R} --apply   (decision run: relaunch with its workflow object; skip: it records phase-done revise itself, go on to package)`);
    }
    steps.push(`run: node scripts/state.mjs watch arm --phase ${phase} --session ${session} --role ${R} --date ${date}   (the retry needs a watch of its own: it must print attempt ${watch.attempt + 1}; add --minutes <the phaseBudgetMinutes you pass in args> when that is below the configured one)`);
    steps.push(
      kaizen
        ? `Then finish the launch as "Launching any Workflow" says: send_later with the sendLater it printed, watch bind --attempt ${watch.attempt + 1} --trigger-id <the trigger_id>, sync, git status --short must print nothing, then the kaizen Workflow (no task bind).`
        : `Then finish the launch as "Launching any Workflow" says: send_later with the sendLater it printed, watch bind --attempt ${watch.attempt + 1} --trigger-id <the trigger_id>, the heartbeat loop it printed, sync, then ${phase} with compact:true and tier:2 (planner for phaseBudgetMinutes) and watch bind --workflow-task.`,
    );
    base = {
      next: 'retry',
      hint: 'compact',
      attemptsUsed,
      maxAttempts,
      attemptsLeft,
      degrade: null,
      reason: `${late}; ${attemptsUsed} of ${maxAttempts} attempts spent, ${attemptsLeft} ${attemptsLeft === 1 ? 'is' : 'are'} left`,
      steps,
    };
  } else {
    const degrade = degradePlan({ phase, targetTier: run.targetTier, hasIdeas: doneNames(run).includes('ideate') || facts.hasIdeas, blocked: Boolean(facts.blocked) });
    const steps = [stop, ...shown];
    // why the phase is given up: its attempts are spent, or (tooLate) a retry cannot fit before the bound any more
    const why = tooLate && attemptsLeft > 0 ? `stalled ${Math.max(0, Math.floor(roomMinutes))} min before ${boundName}` : `stalled ${attemptsUsed} times`;
    if (degrade.how === 'tier') {
      steps.push(`run: node scripts/state.mjs directive --kind ship-now --tier ${degrade.toTier} --by ${R} --date ${date}`);
      steps.push(`run: node scripts/state.mjs ack-directive --kind ship-now --date ${date}`);
      steps.push(`run: node scripts/state.mjs event --kind degrade --msg "${phase} ${why} (phase watch): tier ${degrade.toTier}" --by ${R} --date ${date}`);
    } else {
      for (const p of degrade.skip) {
        steps.push(`run: node scripts/state.mjs skip-phase --phase ${p} --reason "phase watch: ${phase} ${why}" --session ${session} --role ${R} --date ${date}`);
      }
    }
    steps.push(`run: ${disarm}   (the timer that woke you has fired and is spent: delete nothing)`);
    steps.push(`Then: ${degrade.note}.`);
    base = {
      next: 'degrade',
      hint: null,
      attemptsUsed,
      maxAttempts,
      attemptsLeft,
      degrade,
      ...(tooLate && attemptsLeft > 0 ? { tooLate: true } : {}),
      reason:
        tooLate && attemptsLeft > 0
          ? `${late}; ${Math.max(0, Math.floor(roomMinutes))} min are left before ${boundName} (minus ${HARD_STOP_BUFFER_MINUTES}), a retry needs ${MIN_RETRY_MINUTES}: no retry, the two-failures table applies`
          : `${late}; all ${maxAttempts} attempts are spent`,
      steps,
    };
  }

  // A phase that wrote everything but its DONE.json (the last thing its Workflow does) is finished by hand, not redone: the files are the truth.
  const check = phaseCheck(phase, date);
  if (check && outputs.required.length > 1 && outputs.present.length > 0 && outputs.missing.every((m) => m === doneFile)) {
    return {
      ...base,
      next: 'finish-by-hand',
      hint: null,
      fallback: base.next,
      reason: `${late}; every required output except its DONE.json is there, so finishing by hand beats redoing it (if the check fails, ${base.next === 'retry' ? 'the retry' : 'the degrade table'} below applies)`,
      steps: [
        stop,
        `${phase} wrote every required output but its DONE.json (${outputs.present.join(', ')}): finish it by hand instead of redoing it (PLAYBOOK 6.7, 7.3).`,
        `Check it as PLAYBOOK 7.3 says for ${phase}: ${check}.`,
        `If the check passes: run: ${handDone(phase, date)}`,
        `If the check passes: run: ${disarm}   (the timer that woke you has fired and is spent: delete nothing)`,
        `If the check passes: spend (a stopped Workflow reports none: charge the PLAYBOOK 6.5 estimate), then the checkpoint with note "${phase} ok (finished by hand after the phase watch)" and go on to the next phase.`,
        `If the check fails, do exactly this instead (${base.next}):`,
        ...base.steps.slice(1),
      ],
    };
  }
  return base;
}

/**
 * Pure. May an overdue watch be moved out instead of acted on? A timer measures elapsed time, and a healthy Workflow on two agent slots
 * is slow (day 1: build 85 minutes, qa 38 and kaizen 82 against budgets of 80, 30 and 75): stopping and wiping it would throw away good
 * work. The Workflow is judged by its files. Yes (at most MAX_EXTENSIONS times, never for the kaizen, whose tree must stay clean) when a file
 * under work/<D> changed within the phase's window (progressFreshMinutes: one agent call that writes a big file in one go is silent for
 * a long time) and the timer itself was on time; never past the bound of computeDue: an extension that the hard stop (or the kaizen
 * cutoff) would squeeze below MIN_WATCH_MINUTES is refused, so nothing runs past it on an extension. Returns null or
 * { n, dueMs, dueAt, minutes, clamped, windowMinutes }.
 */
export function planExtension({ config, date, watch, facts, overdueMinutes, nowMs, manual = false }) {
  const phase = watch.phase;
  if (phase === 'kaizen' || watch.firedAt || facts.doneMarker) return null;
  const used = Number.isInteger(watch.extensions) && watch.extensions > 0 ? watch.extensions : 0;
  if (used >= MAX_EXTENSIONS) return null;
  const windowMinutes = progressFreshMinutes(phase);
  const ago = facts.progress?.minutesAgo;
  if (typeof ago !== 'number' || !Number.isFinite(ago) || ago > windowMinutes) return null;
  if (overdueMinutes >= Math.max(15, 0.5 * (Number(watch.budgetMinutes) || 0))) return null;
  const due = computeDue({ config, date, phase, nowMs, budgetMinutes: EXTEND_MINUTES, marginMinutes: 0, manual });
  if (due.clamped === 'min') return null; // the bound leaves no room: the phase is resolved now, not in 5 minutes past the bound
  return { n: used + 1, dueMs: due.dueMs, dueAt: new Date(due.dueMs).toISOString(), minutes: due.delayMinutes, clamped: due.clamped, windowMinutes };
}

// ---------------------------------------------------------------------------------------
// file facts for an overdue verdict
// ---------------------------------------------------------------------------------------

const nonEmpty = (file) => {
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
};

/**
 * The newest modification time (epoch ms) of anything under `dir`, directories included (they change when files come and go); null when
 * there is nothing. Bounded. A time more than FUTURE_SLACK_MS beyond `ceilingMs` (the clock the command runs by) is a skewed clock or a
 * pinned `--now`, not progress, and is ignored.
 */
function newestWrite(dir, ceilingMs) {
  let newest = null;
  let seen = 0;
  const stack = [dir];
  while (stack.length && seen < MAX_WALK_ENTRIES) {
    const here = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(here, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++seen > MAX_WALK_ENTRIES) break;
      if (entry.isSymbolicLink()) continue;
      const file = path.join(here, entry.name);
      try {
        const { mtimeMs } = fs.statSync(file);
        if (mtimeMs <= ceilingMs + FUTURE_SLACK_MS && (newest === null || mtimeMs > newest)) newest = mtimeMs;
      } catch {
        continue;
      }
      if (entry.isDirectory()) stack.push(file);
    }
  }
  return newest;
}

/** What the stalled phase left on disk. Read-only and cheap; any failure reads as "nothing there". `progress` = the newest change under work/<D>. */
export function gatherFacts(date, phase, nowMs = Date.now()) {
  const required = (REQUIRED_OUTPUTS[phase] ?? []).map((p) => p.replace('<D>', date));
  const present = required.filter((p) => nonEmpty(rp(p)));
  let blocked = null;
  try {
    blocked = qaBlock(date);
  } catch {
    blocked = null;
  }
  let doneMarker = false;
  try {
    doneMarker = hasDoneMarker(date, phase);
  } catch {
    doneMarker = false;
  }
  let newest = null;
  try {
    newest = newestWrite(rp('work', date), nowMs);
  } catch {
    newest = null;
  }
  // how long ago the Workflow wrote its DONE.json (null: none, unreadable, or stamped by a clock ahead of this one)
  let doneAgeMinutes = null;
  if (doneMarker) {
    try {
      const { mtimeMs } = fs.statSync(rp('work', date, phase, 'DONE.json'));
      if (mtimeMs <= nowMs + FUTURE_SLACK_MS) doneAgeMinutes = round1(Math.max(0, (nowMs - mtimeMs) / MIN_MS));
    } catch {
      doneAgeMinutes = null;
    }
  }
  return {
    doneMarker,
    doneAgeMinutes,
    outputs: { required, present, missing: required.filter((p) => !present.includes(p)) },
    hasIdeas: nonEmpty(rp('work', date, 'ideas', 'shortlist.json')),
    blocked,
    progress: { newestAt: newest === null ? null : new Date(newest).toISOString(), minutesAgo: newest === null ? null : round1(Math.max(0, (nowMs - newest) / MIN_MS)) },
  };
}

// ---------------------------------------------------------------------------------------
// the heartbeat loop of a launch
// ---------------------------------------------------------------------------------------

/**
 * The OS-level heartbeat loop that keeps the lease alive while the turn is over (PLAYBOOK 7.1a step 5): with fewer than 6 agent slots a
 * Workflow that gets osHeartbeat:true drops its own pulse (on 2 slots that pulse would take one of the two), so this loop is then the
 * only signal and must be started BEFORE the Workflow and never stopped at launch. It is bounded by the Bash background timeout (2 hours,
 * 26 beats of 4.5 minutes). It need not beat until the due time itself: the lease looks stale only `leaseStaleMinutes` after the last
 * beat that reached the branch, and the PHASEWATCH turn at the due time pushes a fresh lease (`watch check`, then its `sync`). So
 * `coversWatch` says whether the lease stays fresh until LOOP_SLACK_MINUTES past the due time (`freshUntilMinutes`); if not,
 * osHeartbeat must be left out so the Workflow keeps its own pulse. Without a usable `leaseStaleMinutes` the loop itself must reach the
 * due time. When the heartbeat branch cannot be pushed ($HOME/.sed-hb-broken-<D>, FM-111) the work-branch loop of PLAYBOOK 4 is printed
 * instead (every beat of it is pushed).
 */
export function heartbeatLoopFor({ phase, session, role, date, delayMinutes, leaseStaleMinutes = null }) {
  let workBranch = false;
  try {
    workBranch = fs.existsSync(path.join(os.homedir(), `.sed-hb-broken-${date}`));
  } catch {
    workBranch = false;
  }
  const iterations = workBranch ? Math.min(5, Math.ceil(delayMinutes / 20) + 1) : Math.min(MAX_LOOP_BEATS, Math.ceil((delayMinutes * 60) / BEAT_SECONDS) + 2);
  const coversMinutes = workBranch ? iterations * 20 : Math.round((iterations * BEAT_SECONDS) / 60);
  const reach = Math.min(coversMinutes, LOOP_TIMEOUT_MS / MIN_MS);
  const stale = typeof leaseStaleMinutes === 'number' && Number.isFinite(leaseStaleMinutes) && leaseStaleMinutes > 0 ? leaseStaleMinutes : null;
  const freshUntilMinutes = stale === null ? reach : round1(reach - (workBranch ? 0 : HB_PUSH_GAP_MINUTES) + stale);
  const command = workBranch
    ? `for i in $(seq 1 ${iterations}); do node -e "setTimeout(()=>{},1200000)"; node scripts/state.mjs beat --role ${role} --session ${session} --phase ${phase} --date ${date}; node scripts/state.mjs sync -m "sed(${date}): liveness" --paths state/runs/${date}.json; done`
    : `for i in $(seq 1 ${iterations}); do node scripts/heartbeat.mjs --role ${role} --session ${session} --phase ${phase} --date ${date} --wait ${BEAT_SECONDS} >/dev/null 2>&1; done`;
  return {
    variant: workBranch ? 'work-branch' : 'heartbeat-branch',
    command,
    background: true,
    timeoutMs: LOOP_TIMEOUT_MS,
    iterations,
    coversMinutes,
    freshUntilMinutes,
    coversWatch: stale === null ? reach >= delayMinutes : freshUntilMinutes >= delayMinutes + LOOP_SLACK_MINUTES,
  };
}

// ---------------------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------------------

function dayOf(date, at, config) {
  return assertDate(date ?? localParts(at, config.timezone).date);
}

/**
 * arm: record run.watch for the phase the run is in and print the send_later call that wakes the session when it falls due.
 * opts: { date, phase, session, role?, minutes?, now, config }. `minutes` is the phase budget the Workflow gets as
 * phaseBudgetMinutes (default config.phaseBudgetMinutes[phase]); the watch falls due watchMarginMinutes(phase) after it. Arming the same launch
 * twice (same phase and session, the earlier watch neither fired nor disarmed, no `phase-start` since) is one attempt, not two: it
 * refreshes the watch and says `reused:true`.
 */
export function armWatch({ date, phase, session, role, minutes, now, config = loadConfig() }) {
  assertPhase(phase);
  if (phase === 'done') throw new UsageError('nothing runs in phase done: there is nothing to watch');
  assertToken(session, 'session');
  if (role !== undefined && !ROLES.includes(role)) throw new UsageError(`unknown role "${role}" (expected ${ROLES.join('|')})`);
  const override = minutes === undefined ? undefined : positiveMinutes(minutes, '--minutes');
  const at = toDate(now);
  const nowIso = at.toISOString();
  const day = dayOf(date, at, config);
  return updateRun(day, (run) => {
    if (run.status !== 'in_progress' && !(phase === 'kaizen' && kaizenPending(run))) {
      throw new StateError(`run for ${day} is ${run.status}: there is no running phase to watch`);
    }
    guardHolder(run, session);
    if (run.phase !== phase) {
      throw new StateError(`phase ${phase} is not the run's current phase (${run.phase}): run phase-start --phase ${phase} first, then arm`, { runPhase: run.phase });
    }
    const holder = [role, run.lease?.holder].find((r) => ROLES.includes(r));
    const budget = phaseBudget(config, phase, override);
    const due = computeDue({ config, date: day, phase, nowMs: at.getTime(), budgetMinutes: budget.minutes, manual: holder === 'manual' });
    const previous = readWatch(run.watch);
    const arms = armsOf(run.watch);
    const attemptsNow = Number(run.attempts?.[phase]) || 0;
    const prev = previous.ok ? previous.watch : null;
    const reused = Boolean(prev && prev.phase === phase && prev.session === session && !prev.firedAt && !prev.disarmedAt && Number.isInteger(prev.attemptsAtArm) && prev.attemptsAtArm === attemptsNow);
    if (!reused) arms[phase] = (arms[phase] ?? 0) + 1;
    const attempt = reused ? prev.attempt : arms[phase];
    arms[phase] = attempt;
    const dueAt = new Date(due.dueMs).toISOString();
    // A pending timer of the watch this one replaces must be deleted by the operator (a fired one-shot is spent already: never delete it;
    // past its due time it has fired or is firing, as disarm judges).
    const replaced =
      prev && !prev.disarmedAt && !prev.firedAt && !prev.timerFiredAt && at.getTime() < prev.dueMs && (prev.triggerId || prev.workflowTask)
        ? { phase: prev.phase, attempt: prev.attempt, triggerId: prev.triggerId, workflowTask: prev.workflowTask }
        : null;
    const stoppedTasks = prev ? prev.stoppedTasks : [];
    run.watch = {
      phase,
      attempt,
      armedAt: nowIso,
      dueAt,
      session,
      triggerId: null,
      workflowTask: null,
      role: holder ?? null,
      budgetMinutes: budget.minutes,
      delayMinutes: due.delayMinutes,
      clamped: due.clamped,
      arms,
      attemptsAtArm: attemptsNow,
      ...(stoppedTasks.length ? { stoppedTasks } : {}),
    };
    touchLease(run, session, nowIso);
    const margin = watchMarginMinutes(phase);
    pushEvent(
      run,
      'note',
      `phase watch ${reused ? 're-armed (same launch)' : 'armed'}: ${phase} attempt ${attempt}, due ${dueAt} (${due.delayMinutes} min: budget ${budget.minutes} + ${margin} margin${due.clamped ? `, clamped by ${due.clamped}` : ''})`,
      holder ?? 'watch',
      nowIso,
      'watch-armed',
    );
    const R = holder ?? 'primary';
    const loop = heartbeatLoopFor({ phase, session, role: R, date: day, delayMinutes: due.delayMinutes, leaseStaleMinutes: config.leaseStaleMinutes });
    const kaizen = phase === 'kaizen';
    // the replaced timer is still pending; the permission classifier may refuse its delete (2026-10-11): disable it instead, else leave it
    const replacedTimer = replaced?.triggerId
      ? `first delete_trigger({ trigger_id: "${replaced.triggerId}" }): it is the pending timer of the ${replaced.phase} watch this arm replaced. Denied: update_trigger({ trigger_id: "${replaced.triggerId}", enabled: false }) instead (never retry a denied call as written); denied too: leave it, it fires into a stale \`watch check\` (FM-120)`
      : null;
    return {
      run,
      result: {
        ok: true,
        date: day,
        phase,
        attempt,
        reused,
        session,
        role: holder ?? null,
        armedAt: nowIso,
        dueAt,
        delayMinutes: due.delayMinutes,
        budgetMinutes: budget.minutes,
        budgetSource: budget.source,
        marginMinutes: margin,
        clamped: due.clamped,
        replaced,
        sendLater: sendLaterFor({ date: day, phase, attempt, session, dueAt, root: repoRoot() }),
        heartbeatLoop: loop,
        osHeartbeat: loop.coversWatch,
        then: [
          ...(replacedTimer ? [replacedTimer] : []),
          ...(replaced?.workflowTask ? [`the replaced watch had Workflow task "${replaced.workflowTask}" bound: if it still runs, TaskStop it before another launch`] : []),
          'call send_later with sendLater.at, sendLater.name and sendLater.message exactly as printed (it returns a trigger_id)',
          `run: node scripts/state.mjs watch bind --phase ${phase} --session ${session} --date ${day} --attempt ${attempt} --trigger-id <the trigger_id>`,
          loop.coversWatch
            ? `start the heartbeat loop in the background now (Bash run_in_background, timeout ${loop.timeoutMs}): ${loop.command}   then pass osHeartbeat:true to the Workflow; never stop the loop at launch`
            : `the heartbeat loop would end before the watch (${loop.coversMinutes} of ${due.delayMinutes} min; the lease would look stale from minute ${loop.freshUntilMinutes}): you may still start it (${loop.command}) but leave osHeartbeat out, so the Workflow keeps its own pulse`,
          `run: node scripts/state.mjs sync -m "sed(${day}): ${R} ${phase} launch (watch armed)"   (other containers see only what is pushed; this one push also carries the checkpoint of the phase that just finished)`,
          kaizen
            ? 'launch the kaizen Workflow in the background and bind no task (write nothing under the repo while it runs; keep its id in "$HOME/.sed-wf-' + day + '-kaizen")'
            : `launch the Workflow in the background, then run: node scripts/state.mjs watch bind --phase ${phase} --session ${session} --date ${day} --attempt ${attempt} --workflow-task <its task id>`,
          'end the turn (do not poll or sleep)',
        ],
      },
    };
  });
}

/**
 * bind: store the send_later trigger id and/or the Workflow task id on the armed watch (idempotent). With `attempt` the bind is for that
 * attempt only: a command of an earlier attempt must not overwrite the live attempt's ids.
 */
export function bindWatch({ date, phase, session, triggerId, workflowTask, attempt, now, config = loadConfig() }) {
  if (triggerId === undefined && workflowTask === undefined) throw new UsageError('watch bind needs --trigger-id and/or --workflow-task');
  if (triggerId !== undefined) assertToken(triggerId, 'trigger-id');
  if (workflowTask !== undefined) assertToken(workflowTask, 'workflow-task');
  if (phase !== undefined) assertPhase(phase);
  if (session !== undefined) assertToken(session, 'session');
  const wantAttempt = attempt === undefined ? undefined : positiveInt(attempt, '--attempt');
  const at = toDate(now);
  const nowIso = at.toISOString();
  const day = dayOf(date, at, config);
  return updateRun(day, (run) => {
    const res = readWatch(run.watch);
    if (!res.ok) throw new StateError(`run ${day} has no usable phase watch (${res.reason}): run watch arm first`, { reason: res.reason });
    const w = res.watch;
    if (w.disarmedAt) throw new StateError(`the ${w.phase} watch was disarmed at ${w.disarmedAt}: arm it again before binding`, { reason: 'disarmed' });
    if (phase !== undefined && w.phase !== phase) throw new StateError(`the run's watch is for ${w.phase}, not ${phase}`, { reason: 'other-phase', runWatchPhase: w.phase });
    if (session !== undefined && w.session !== session) throw new StateError(`the run's watch belongs to session ${w.session}, not ${session}`, { reason: 'other-session' });
    if (wantAttempt !== undefined && w.attempt !== wantAttempt) {
      throw new StateError(`the run's watch is attempt ${w.attempt}, not ${wantAttempt}: that bind belongs to an earlier attempt and would overwrite the live one's ids`, { reason: 'other-attempt', runWatchAttempt: w.attempt });
    }
    const raw = run.watch;
    let changed = false;
    if (triggerId !== undefined && raw.triggerId !== triggerId) {
      raw.triggerId = triggerId;
      delete raw.timerFiredAt; // a new timer is pending
      changed = true;
    }
    if (workflowTask !== undefined && raw.workflowTask !== workflowTask) {
      raw.workflowTask = workflowTask;
      changed = true;
    }
    if (changed) {
      raw.boundAt = nowIso;
      touchLease(run, w.session, nowIso);
    }
    return {
      run: changed ? run : undefined,
      result: { ok: true, date: day, phase: w.phase, attempt: w.attempt, triggerId: raw.triggerId ?? null, workflowTask: raw.workflowTask ?? null, changed },
    };
  });
}

/**
 * disarm: retire the watch (idempotent, tolerant of a missing or unreadable run). Prints the trigger id so the operator can
 * delete_trigger it, but only a timer that is still pending: one that has fired is spent and is never to be deleted (`timerFired:true`).
 * A watch of another phase or session is left alone and its trigger is not printed. With `workflowTask` (the id the notification names)
 * the disarm is refused for a task that is not the watch's own (`reason:'other-task'`) or that this watch stopped (`reason:'echo'`): a late
 * or echoed notification must not unwatch the live attempt. A different id while the watched phase's DONE.json is on disk is the phase's
 * own completion whatever id was bound at launch (DONE.json is the last thing its Workflow writes; `taskMismatch` says so): refusing it
 * would leave the result unhandled until the timer. A printed `deleteTrigger` comes with `ifDeleteDenied`, the PLAYBOOK 7.1a fallback.
 */
export function disarmWatch({ date, phase, session, workflowTask, now, config = loadConfig() }) {
  if (phase !== undefined) assertPhase(phase);
  if (session !== undefined) assertToken(session, 'session');
  if (workflowTask !== undefined) assertToken(workflowTask, 'workflow-task');
  const at = toDate(now);
  const nowIso = at.toISOString();
  const day = dayOf(date, at, config);
  const none = (reason, extra = {}) => ({ ok: true, date: day, disarmed: false, reason, phase: null, attempt: null, triggerId: null, workflowTask: null, deleteTrigger: null, ...extra });
  const read = readRunFile(day);
  if (read.status === 'missing') return none('no-run');
  if (read.status === 'corrupt') return none('run-corrupt');
  return updateRun(day, (run) => {
    const res = readWatch(run.watch);
    if (!res.ok) return { result: none(res.reason) };
    const w = res.watch;
    // Another phase's or session's watch is not ours: say whose it is, but never print its trigger id (the operator would delete it).
    const current = { phase: w.phase, attempt: w.attempt, session: w.session };
    if (phase !== undefined && w.phase !== phase) return { result: none('other-phase', { current }) };
    if (session !== undefined && w.session !== session) return { result: none('other-session', { current }) };
    let taskMismatch = null;
    if (workflowTask !== undefined) {
      if (w.stoppedTasks.includes(workflowTask)) {
        return { result: none('echo', { current: { ...current, workflowTask: w.workflowTask }, note: `task ${workflowTask} is a Workflow this watch stopped: its notification is the echo of your TaskStop. Touch nothing; the live attempt keeps its watch.` }) };
      }
      if (w.workflowTask && w.workflowTask !== workflowTask) {
        let finished = false;
        try {
          finished = hasDoneMarker(day, w.phase);
        } catch {
          finished = false;
        }
        if (!finished) {
          const rebind = `node scripts/state.mjs watch bind --phase ${w.phase} --session ${w.session} --date ${day} --attempt ${w.attempt} --workflow-task ${workflowTask}`;
          return {
            result: none('other-task', {
              current: { ...current, workflowTask: w.workflowTask },
              note: `the watch belongs to task ${w.workflowTask}, not ${workflowTask}: a notification of another task (an earlier attempt, the end of the heartbeat loop). Touch nothing; the watch stays armed. Only if this notification is the ${w.phase} Workflow's own result (it reports phase "${w.phase}") was the id bound at launch wrong: then run ${rebind} and this disarm again.`,
            }),
          };
        }
        taskMismatch = { bound: w.workflowTask, notified: workflowTask };
      }
    }
    // Spent once `watch check` recorded it, or once its due time has passed: send_later fires on the first whole minute at or after
    // dueAt, so its PHASEWATCH turn may already be queued behind this notification turn. A leftover finds the watch disarmed (stale).
    const timerFired = Boolean(w.firedAt || w.timerFiredAt) || at.getTime() >= w.dueMs;
    const deleteTrigger = w.triggerId && !timerFired ? { trigger_id: w.triggerId } : null;
    const out = {
      ok: true,
      date: day,
      ...current,
      triggerId: w.triggerId,
      workflowTask: w.workflowTask,
      timerFired,
      deleteTrigger,
      ...(deleteTrigger
        ? { ifDeleteDenied: `update_trigger({ trigger_id: "${deleteTrigger.trigger_id}", enabled: false }); denied too: leave it, it fires into a stale \`watch check\` (PLAYBOOK 7.1a step 4, FM-120)` }
        : {}),
      ...(taskMismatch
        ? {
            taskMismatch,
            note: `the notification names task ${workflowTask} but ${w.workflowTask} was bound; work/${day}/${w.phase}/DONE.json is on disk, so the ${w.phase} Workflow finished and this is its result: handled as its own notification`,
          }
        : {}),
    };
    if (w.disarmedAt) return { result: { ...out, disarmed: false, alreadyDisarmed: true, disarmedAt: w.disarmedAt } };
    run.watch.disarmedAt = nowIso;
    touchLease(run, w.session, nowIso);
    return { run, result: { ...out, disarmed: true, disarmedAt: nowIso } };
  });
}

/** status: the watch block as stored, with its state; read-only and tolerant of anything. */
export function statusWatch({ date, now, config = loadConfig() }) {
  const at = toDate(now);
  const nowMs = at.getTime();
  const day = dayOf(date, at, config);
  const read = readRunFile(day);
  const base = { ok: true, date: day, now: at.toISOString(), runFile: read.status };
  if (read.status !== 'ok') return { ...base, state: 'none', watch: null, live: false, overdueMinutes: null, dueInMinutes: null, staleLease: false };
  const run = read.run;
  const res = readWatch(run.watch);
  const raw = run.watch ?? null;
  const state = raw === null ? 'none' : !res.ok ? 'corrupt' : res.watch.disarmedAt ? 'disarmed' : res.watch.firedAt ? 'fired' : 'armed';
  const late = watchOverdueMinutes(run, nowMs);
  return {
    ...base,
    runStatus: run.status,
    runPhase: run.phase,
    state,
    watch: raw,
    live: late !== null,
    overdueMinutes: late === null ? null : round1(late),
    dueInMinutes: res.ok ? round1((res.watch.dueMs - nowMs) / MIN_MS) : null,
    staleLease: late !== null && late > WATCH_STALE_AFTER_MINUTES,
    ...(res.ok && !res.watch.disarmedAt ? { sendLater: sendLaterFor({ date: day, phase: res.watch.phase, attempt: res.watch.attempt, session: res.watch.session, dueAt: res.watch.dueAt, root: repoRoot() }) } : {}),
  };
}

// The timer that woke the session has fired: deleting it is useless, and deleting a routine that has fired may delete the session it fired into.
const SPENT_TIMER = 'The timer that woke you has fired and is spent: do NOT delete it (deleting a routine that has fired may delete the session it fired into).';
const STALE_INSTRUCTIONS = `Nothing else to do. ${SPENT_TIMER} End the turn.`;

/**
 * check: what a PHASEWATCH line means right now. Always ok:true with a verdict (stale | early | overdue) and an `action` code
 * (stale: nothing, or stop-zombie for a replaced session and arm for a restarted phase, as `instructions` say; early: re-arm;
 * overdue: extend | retry | finish-by-hand | degrade | nothing, which `next` repeats); never throws for
 * a missing or damaged run or watch. An overdue verdict writes (once per watch, under the per-date lock, after the run was read a second
 * time, so a `phase-done` that raced the first read turns the verdict into stale): the `watch-fired` event for a retry, a degrade or a
 * finish by hand, or the moved-out due time (`extend`) when the Workflow's files are still changing. The timer that called is spent
 * (`timerFired`) and no verdict ever tells the operator to delete it.
 * opts: { date, phase, session, attempt?, role?, now, config, displacedBy?, beforeLock? } (`beforeLock` is a test seam: it runs
 * between the first read and the locked one, which is where a racing `phase-done` would land)
 */
export function checkWatch({ date, phase, session, attempt, role, now, config = loadConfig(), displacedBy = null, beforeLock = null }) {
  assertPhase(phase);
  assertToken(session, 'session');
  if (role !== undefined && !ROLES.includes(role)) throw new UsageError(`unknown role "${role}" (expected ${ROLES.join('|')})`);
  const attemptNo = attempt === undefined ? undefined : positiveInt(attempt, '--attempt');
  const at = toDate(now);
  const nowMs = at.getTime();
  const nowIso = at.toISOString();
  const day = dayOf(date, at, config);
  const base = { ok: true, date: day, phase, session, now: nowIso };
  const root = repoRoot();

  // What a stale timer leaves to do is the PLAYBOOK 7.1a stale row: nothing, except for the codes that row names.
  const staleInstructions = (c) => {
    const task = c.watch?.workflowTask;
    const stopIt =
      phase === 'kaizen'
        ? `TaskStop your kaizen Workflow (its id is in "$HOME/.sed-wf-${day}-kaizen", else the one the Workflow tool printed at launch)`
        : `TaskStop your ${phase} Workflow (${task ? `TaskStop({ task_id: "${task}" })` : 'the task id the Workflow tool printed at launch'})`;
    switch (c.code) {
      case 'displaced':
      case 'lease-held-by-other':
        return `You were replaced (PLAYBOOK 6.6): ${stopIt}: it is a zombie now and writes into the new holder's files. Write nothing else. ${SPENT_TIMER} End the turn.`;
      case 'restarted':
        return `The ${phase} attempt that runs now has no watch of its own: arm one (PLAYBOOK 7.1a steps 3 to 6: watch arm, send_later, watch bind --attempt, sync). ${SPENT_TIMER} Then end the turn.`;
      case 'expired':
        return `Too old to act on: the next \`begin\` decides what happens to the run. ${STALE_INSTRUCTIONS}`;
      default:
        return STALE_INSTRUCTIONS;
    }
  };
  const staleOut = (c) => ({
    ...base,
    verdict: 'stale',
    code: c.code,
    reason: c.reason,
    triggerId: c.foreign ? null : (c.watch?.triggerId ?? null),
    deleteTrigger: null,
    timerFired: true,
    action: ['displaced', 'lease-held-by-other'].includes(c.code) ? 'stop-zombie' : c.code === 'restarted' ? 'arm' : 'nothing',
    instructions: staleInstructions(c),
  });
  const earlyOut = (c) => {
    const w = c.watch;
    return {
      ...base,
      verdict: 'early',
      attempt: w.attempt,
      dueAt: w.dueAt,
      remainingMinutes: c.remainingMinutes,
      timerFired: true,
      sendLater: sendLaterFor({ date: day, phase, attempt: w.attempt, session, dueAt: w.dueAt, root }),
      action: 're-arm',
      instructions: `The Workflow is still inside its budget: do NOT stop it. ${SPENT_TIMER} Create a fresh one-shot with send_later(sendLater) (this timer fired early), run: node scripts/state.mjs watch bind --phase ${phase} --session ${session} --date ${day} --attempt ${w.attempt} --trigger-id <the new trigger_id>, and end the turn.`,
    };
  };

  const read = readRunFile(day);
  if (read.status !== 'ok') {
    return staleOut({
      code: read.status === 'missing' ? 'no-run' : 'run-corrupt',
      reason: read.status === 'missing' ? `there is no run file for ${day}` : `the run file for ${day} is corrupt (${read.error}); \`begin\` quarantines and restarts it`,
      foreign: true,
    });
  }
  const first = classifyWatch({ run: read.run, phase, session, attempt: attemptNo, nowMs, displacedBy });
  if (first.verdict === 'stale') return staleOut(first);
  if (first.verdict === 'early') return earlyOut(first);

  // overdue: look again under the lock (a phase-done may have raced the read above) and write the decision once
  if (typeof beforeLock === 'function') beforeLock();
  return updateRun(day, (run) => {
    const c = classifyWatch({ run, phase, session, attempt: attemptNo, nowMs, displacedBy });
    if (c.verdict === 'stale') return { result: staleOut(c) };
    if (c.verdict === 'early') return { result: earlyOut(c) };
    const w = c.watch;
    const facts = gatherFacts(day, phase, nowMs);
    const counts = attemptCounts(run, config, w);
    const common = {
      ...base,
      verdict: 'overdue',
      attempt: w.attempt,
      overdueMinutes: c.overdueMinutes,
      attemptsUsed: counts.attemptsUsed,
      maxAttempts: counts.maxAttempts,
      attemptsLeft: counts.attemptsLeft,
      workflowTask: w.workflowTask,
      triggerId: w.triggerId,
      timerFired: true,
      outputs: facts.outputs,
      progress: facts.progress,
    };

    // Still working? Then the watch moves out instead of the Workflow being stopped.
    const manual = run.lease?.holder === 'manual';
    const ext = planExtension({ config, date: day, watch: w, facts, overdueMinutes: c.overdueMinutes, nowMs, manual });
    if (ext) {
      const was = w.dueAt;
      const by = [role, run.lease?.holder].find((r) => ROLES.includes(r)) ?? 'watch';
      run.watch.dueAt = ext.dueAt;
      run.watch.extensions = ext.n;
      run.watch.extendedAt = nowIso;
      run.watch.triggerId = null; // the timer that called is spent; the new one is bound after send_later
      delete run.watch.timerFiredAt;
      touchLease(run, session, nowIso);
      pushEvent(run, 'note', `phase watch extended: ${phase} attempt ${w.attempt} was ${c.overdueMinutes} min past ${was} but a file under work/${day} changed ${facts.progress.minutesAgo} min ago; due ${ext.dueAt} now (extension ${ext.n} of ${MAX_EXTENSIONS})`, by, nowIso, 'watch-extended');
      return {
        run,
        result: {
          ...common,
          dueAt: ext.dueAt,
          action: 'extend',
          next: 'extend',
          hint: null,
          reason: `${phase} attempt ${w.attempt} fell due ${was} (${c.overdueMinutes} min ago) but a file under work/${day} changed ${facts.progress.minutesAgo} min ago: the Workflow is still working, so the watch moves out to ${ext.dueAt} (extension ${ext.n} of ${MAX_EXTENSIONS})`,
          degrade: null,
          repeat: false,
          extension: { n: ext.n, max: MAX_EXTENSIONS, minutes: ext.minutes, dueAt: ext.dueAt, previousDueAt: was, clamped: ext.clamped, windowMinutes: ext.windowMinutes },
          sendLater: sendLaterFor({ date: day, phase, attempt: w.attempt, session, dueAt: ext.dueAt, root }),
          steps: [
            `Do NOT stop ${phase}: its files are still changing (newest change ${facts.progress.minutesAgo} min ago). ${SPENT_TIMER}`,
            'call send_later with sendLater.at, sendLater.name and sendLater.message exactly as printed (it returns a trigger_id)',
            `run: node scripts/state.mjs watch bind --phase ${phase} --session ${session} --date ${day} --attempt ${w.attempt} --trigger-id <the trigger_id>`,
            `run: node scripts/state.mjs sync -m "sed(${day}): ${by} ${phase} watch extended"   (other containers judge the pushed due time: without this push they act on the old one)`,
            'end the turn',
          ],
        },
      };
    }

    const roomMinutes = boundRoomMinutes({ config, date: day, phase, nowMs, manual });
    const plan = planOverdue({ run, config, watch: w, facts, role, date: day, session, overdueMinutes: c.overdueMinutes, roomMinutes });
    const out = {
      ...common,
      dueAt: w.dueAt,
      action: plan.next,
      next: plan.next,
      hint: plan.hint,
      reason: plan.reason,
      attemptsUsed: plan.attemptsUsed,
      maxAttempts: plan.maxAttempts,
      attemptsLeft: plan.attemptsLeft,
      degrade: plan.degrade,
      ...(plan.tooLate ? { tooLate: true } : {}),
      ...(plan.fallback ? { fallback: plan.fallback } : {}),
      ...(plan.next === 'nothing' ? { doneAgeMinutes: facts.doneAgeMinutes, notificationLost: !plan.awaitNotification } : {}),
      ...(plan.awaitNotification
        ? (() => {
            const t = sendLaterFor({ date: day, phase, attempt: w.attempt, session, dueAt: new Date(nowMs + FOLLOW_UP_MINUTES * MIN_MS).toISOString(), root });
            return { followUp: { ...t, name: `${t.name}-followup` } };
          })()
        : {}),
      repeat: Boolean(w.firedAt),
      steps: plan.steps,
    };
    if (w.firedAt) return { result: out };
    if (plan.next === 'nothing') {
      // the Workflow finished: nothing to stop; only remember that this timer is spent (a disarm in the notification turn must not offer it for deletion)
      if (w.timerFiredAt) return { result: out };
      run.watch.timerFiredAt = nowIso;
      touchLease(run, session, nowIso);
      return { run, result: out };
    }
    const by = [role, run.lease?.holder].find((r) => ROLES.includes(r)) ?? 'watch';
    run.watch.firedAt = nowIso;
    run.watch.timerFiredAt = nowIso;
    run.watch.attemptsAtFire = Number(run.attempts?.[phase]) || 0;
    run.watch.decision = plan.next;
    if (w.workflowTask) run.watch.stoppedTasks = [...w.stoppedTasks.filter((t) => t !== w.workflowTask), w.workflowTask].slice(-MAX_STOPPED_TASKS);
    touchLease(run, session, nowIso);
    pushEvent(run, 'error', `phase watch fired: ${phase} attempt ${w.attempt} was still running ${c.overdueMinutes} min after its due time ${w.dueAt}; the Workflow is stopped, next: ${plan.next}`, by, nowIso, 'watch-fired');
    return { run, result: out };
  });
}
