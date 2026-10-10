// Usage guard: turns the rate-limit info a Claude session can read about itself into one action for the operator.
//
//   state.mjs usage observe [--info '<json>' | --file F | stdin] [--session S] [--phase P] [--date D] [--now ISO]
//   state.mjs usage clear --reason "<why this stop is wrong>" [--date D] [--session S]        (the owner's way out of a limit stop)
//
// Input is the `rate_limit_info` object ({ isUsingOverage, rateLimitType, status, resetsAt }), the `external_metadata`
// object that holds it, or the whole `get_session` result (all three are accepted; the real result nests it as
// ccr.external_metadata.rate_limit_info, so the whole input is searched, bounded), or nothing at all (null / absent).
// Reading and classifying are pure functions. This file's only own file I/O is the append-only observation log
// (state/usage.json, the last MAX_OBSERVATIONS only; machine-local, git-ignored); `observe` applies the effects through the owners of that state:
// runstate.mjs for the run (latchUsageStop, liftUsageStop, eventRun, skipPhase, syncThrottleToRun) and throttle.mjs. Actions:
//   stop    overage in use, or the plan rejected/blocked us. ALWAYS, also during the owner override. Latches `usageStop`
//           on today's run; the decision table (runstate.decide row 2b) then degrades the day to a tier that needs no
//           model tokens, and nothing may start agent work.
//   down    a SHORT window (five_hour, or one of unknown length) is nearly full (allowed_warning), or any window is at 90% or more:
//           throttle down one notch (reason rate-limit).
//   warn    allowed_warning on a long window (seven_day, ...) below 90%, which is normal after heavy use and can last for days, or the
//           same signal during the owner override: logged, nothing changes. (Stepping down on it every morning would ratchet the level
//           to the floor and keep it there: a day with a rate-limit event is never clean.)
//   ok      allowed. Also lifts a latched stop whose reset time has passed (or was never known).
//   unknown nothing usable: the observation is fail-open, and it never lifts a stop. `blind:true` says the guard saw nothing at all.
import path from 'node:path';
import { rp, readJson, writeJsonAtomic, loadConfig, localParts } from './common.mjs';
import {
  withLock, readRunFile, eventRun, usageStopActive, kaizenPending, skipPhase, syncThrottleToRun, latchUsageStop, liftUsageStop, clearUsageStop, toDate, assertDate, inertToken,
} from './runstate.mjs';
import * as th from './throttle.mjs';

export const ACTIONS = ['ok', 'warn', 'down', 'stop', 'unknown'];
/** Statuses (normalised: lower case, spaces and hyphens as underscores) that mean the plan will not serve us. */
export const STOP_STATUSES = new Set(['rejected', 'blocked', 'exceeded', 'limit_reached']);
export const MAX_OBSERVATIONS = 50;
/** A limit stop that resets within this many minutes may be waited out (PLAYBOOK 6.5 step 2) instead of degrading the day for good. */
export const WAIT_MINUTES = 15;
/** An allowed_warning on a window at or above this share is a step down whatever the window's length. */
export const HIGH_UTILIZATION = 0.9;
const MIN_RESET_MS = Date.UTC(2000, 0, 1);
const MAX_RESET_MS = Date.UTC(2100, 0, 1);
// The search for the info inside a larger result is bounded: an answer is a few hundred nodes at most, never a document to crawl.
const MAX_DEPTH = 6;
const MAX_NODES = 600;
const MAX_CANDIDATES = 8;
const MAX_ARRAY_ITEMS = 24;
const MAX_NESTED_TEXT = 1_000_000;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.hasOwn(o, k);
const token = (s) => inertToken(s); // echoed into run events: keep it inert text
const noMillis = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// ---------------------------------------------------------------------------------------
// pure: reading the input
// ---------------------------------------------------------------------------------------

/**
 * resetsAt as an ISO instant: epoch seconds, epoch milliseconds (a number or numeric text) or an ISO-8601 string. Text
 * without an offset counts as UTC (never the machine's zone); anything else, and anything outside 2000..2100, is unusable
 * (Date.parse alone reads "-5" as a date in 2001). { iso, problem }: iso is null when absent or unusable.
 */
export function parseResetsAt(value) {
  if (value === undefined || value === null || value === '') return { iso: null, problem: null };
  let ms = NaN;
  if (typeof value === 'number' || (typeof value === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(value))) {
    const n = Number(value);
    ms = n < 1e11 ? n * 1000 : n; // 1e11 seconds is the year 5138, 1e11 milliseconds is 1973: nothing real is ambiguous
  } else if (typeof value === 'string') {
    const text = value.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) ms = th.parseInstant(`${text}T00:00:00Z`).ms;
    else ms = th.parseInstant(/(?:Z|[+-]\d{2}:\d{2})$/i.test(text) ? text : `${text}Z`).ms;
  }
  if (!Number.isFinite(ms) || ms < MIN_RESET_MS || ms > MAX_RESET_MS) return { iso: null, problem: `resetsAt ${JSON.stringify(value)} is not a usable time` };
  return { iso: new Date(ms).toISOString(), problem: null };
}

const FALSE_WORDS = new Set(['false', 'no', 'off', '0', 'n', 'f']);
const TRUE_WORDS = new Set(['true', 'yes', 'on', '1', 'y', 't']);
const ABSENT_WORDS = new Set(['', 'null', 'none', 'n/a', 'unknown']);

/**
 * isUsingOverage as the platform may spell it. Overage is the one thing that costs money, so the reading is fail-CLOSED: only an absent
 * value (null, undefined, blank) and a clear "no" (false, 0, "false", "no", "off") are not overage; a clear "yes" and every other value
 * (1, "1", "yes", "on", an object, a word nobody expected) count as overage, the latter with a problem saying so.
 * { value: true | false | null, problem?: string }
 */
function overageFlag(value) {
  if (value === undefined || value === null) return { value: null };
  if (typeof value === 'boolean') return { value };
  if (typeof value === 'number' && Number.isFinite(value)) return { value: value !== 0 };
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase();
    if (ABSENT_WORDS.has(t)) return { value: null };
    if (FALSE_WORDS.has(t)) return { value: false };
    if (TRUE_WORDS.has(t)) return { value: true };
  }
  const shown = typeof value === 'string' ? JSON.stringify(token(value)) : typeof value;
  return { value: true, problem: `isUsingOverage has a value nobody expected (${shown}): read as true, because overage is the one thing that costs money` };
}

function normalizeInfo(raw) {
  const pick = (...keys) => keys.map((k) => raw[k]).find((v) => v !== undefined);
  const status = pick('status');
  const type = pick('rateLimitType', 'rate_limit_type');
  const over = overageFlag(pick('isUsingOverage', 'is_using_overage', 'usingOverage'));
  const util = pick('utilization');
  const resets = parseResetsAt(pick('resetsAt', 'resets_at', 'resetAt'));
  const problems = [resets.problem, over.problem].filter(Boolean);
  return {
    info: {
      status: typeof status === 'string' && status.trim() ? status.trim().toLowerCase().replace(/[\s-]+/g, '_') : null,
      // a label that is echoed into run files and commands: letters, digits and _.:- only, whatever the platform sent
      rateLimitType: typeof type === 'string' && type.trim() ? token(type.trim()) : null,
      isUsingOverage: over.value,
      resetsAt: resets.iso,
      utilization: typeof util === 'number' && Number.isFinite(util) ? util : null,
      ...(over.problem ? { overageUnreadable: true } : {}),
    },
    problems,
  };
}

const INFO_KEYS = ['status', 'rateLimitType', 'rate_limit_type', 'isUsingOverage', 'is_using_overage', 'resetsAt', 'resets_at'];
// Deeper inside a result a bare `status` is some other object's status ("running", "idle"): such an object needs one of the limit's own keys too.
const DISTINCT_INFO_KEYS = INFO_KEYS.filter((k) => k !== 'status');
const INFO_HOLDERS = ['rate_limit_info', 'rateLimitInfo'];

/** One value found under a rate_limit_info key: an object, a JSON string holding one, or null. { empty } | { problem } | { info, problems }. */
function readCandidate(raw, key) {
  if (raw === null || raw === undefined) return { empty: true };
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return { problem: `${key} is a string that is not JSON` };
    }
    if (value === null) return { empty: true };
  }
  if (!isObj(value)) return { problem: `${key} is not an object` };
  return normalizeInfo(value);
}

/** How bad one reading is, to pick the worst when a result holds several: overage and a refusal outrank a warning, which outranks allowed. */
function severity(info) {
  if (info.isUsingOverage === true) return 5;
  if (info.rateLimitType && info.rateLimitType.toLowerCase() === 'overage' && info.status !== 'allowed') return 5;
  if (info.status && STOP_STATUSES.has(info.status)) return 4;
  if (info.status === 'allowed_warning') return 3;
  if (info.status === 'allowed') return 2;
  return 1;
}

/**
 * Looks for rate-limit info anywhere inside `root` (breadth first, so the shallowest comes first): under a `rate_limit_info` key (an
 * object or a JSON string), as an object that carries the four fields itself, and inside MCP text parts (`content: [{ type: 'text', text:
 * '<json>' }]`). Bounded in depth, nodes and candidates. { candidates: [{ info, problems, path }], sawEmpty, problems }
 */
function searchInfo(root) {
  const candidates = [];
  const problems = [];
  let sawEmpty = false;
  const queue = [{ value: root, path: '', depth: 0 }];
  let visited = 0;
  while (queue.length && visited < MAX_NODES && candidates.length < MAX_CANDIDATES) {
    const { value, path: at, depth } = queue.shift();
    visited++;
    if (Array.isArray(value)) {
      if (depth < MAX_DEPTH) value.slice(0, MAX_ARRAY_ITEMS).forEach((item, i) => queue.push({ value: item, path: `${at}[${i}]`, depth: depth + 1 }));
      continue;
    }
    if (!isObj(value)) continue;
    const holder = INFO_HOLDERS.find((k) => has(value, k));
    if (holder) {
      const c = readCandidate(value[holder], holder);
      const where = at ? `${at}.${holder}` : holder;
      if (c.empty) sawEmpty = true;
      else if (c.problem) problems.push(`${where}: ${c.problem}`);
      else candidates.push({ info: c.info, problems: c.problems, path: where });
    } else if (depth > 0 && DISTINCT_INFO_KEYS.some((k) => has(value, k))) {
      const n = normalizeInfo(value);
      candidates.push({ info: n.info, problems: n.problems, path: at });
      continue; // the object IS the info: nothing inside it to search
    }
    if (depth >= MAX_DEPTH) continue;
    for (const [key, child] of Object.entries(value)) {
      if (INFO_HOLDERS.includes(key)) continue;
      if (child !== null && typeof child === 'object') queue.push({ value: child, path: at ? `${at}.${key}` : key, depth: depth + 1 });
      else if (key === 'text' && typeof child === 'string' && child.length <= MAX_NESTED_TEXT && /^\s*[{[]/.test(child)) {
        try {
          queue.push({ value: JSON.parse(child), path: `${at ? `${at}.` : ''}text`, depth: depth + 1 });
        } catch {
          /* a text part that is not JSON says nothing about the plan */
        }
      }
    }
  }
  return { candidates, sawEmpty, problems };
}

/**
 * Finds the rate-limit info in whatever the caller passed: { shape, info, problems, foundAt? }. shape is rate_limit_info (the object
 * itself), external_metadata (it holds `rate_limit_info`), session (a whole get_session result: the info sits under external_metadata
 * or deeper, `foundAt` names the path), empty (null, absent, blank, {}) or invalid (not JSON, not an object, no info inside). info is
 * null unless found. When a result holds several readings the worst one wins (a stray "allowed" cannot hide a refusal).
 */
export function extractRateLimitInfo(input, depth = 0) {
  const none = (shape, problems = []) => ({ shape, info: null, problems });
  if (input === undefined || input === null) return none('empty');
  if (typeof input === 'string') {
    const text = input.trim();
    if (!text) return none('empty');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return none('invalid', [`not valid JSON (${err.message})`]);
    }
    return depth > 3 ? none('invalid', ['nested too deeply']) : extractRateLimitInfo(parsed, depth + 1);
  }
  if (!isObj(input)) return none('invalid', [`expected a JSON object, got ${Array.isArray(input) ? 'an array' : typeof input}`]);
  if (depth > 3) return none('invalid', ['nested too deeply']);
  if (has(input, 'external_metadata')) return { ...extractRateLimitInfo(input.external_metadata, depth + 1), shape: 'session' };
  for (const key of INFO_HOLDERS) {
    if (!has(input, key)) continue;
    const c = readCandidate(input[key], key);
    if (c.empty) return none('external_metadata');
    if (c.problem) return none('external_metadata', [c.problem]);
    return { shape: 'external_metadata', ...c };
  }
  if (INFO_KEYS.some((k) => has(input, k))) return { shape: 'rate_limit_info', ...normalizeInfo(input) };
  // a wrapper of some kind ({ ccr: { external_metadata: { rate_limit_info } } }, { result: ... }, an MCP content list): search inside
  const found = searchInfo(input);
  if (found.candidates.length) {
    const worst = found.candidates.reduce((a, b) => (severity(b.info) > severity(a.info) ? b : a));
    const extra = found.candidates.length > 1 ? [`${found.candidates.length} readings found (${found.candidates.map((c) => c.path).join(', ')}): the worst one is used`] : [];
    return { shape: 'session', info: worst.info, problems: [...worst.problems, ...found.problems, ...extra], foundAt: worst.path };
  }
  if (found.sawEmpty) return none('session', found.problems);
  return Object.keys(input).length ? none('invalid', ['no rate_limit_info found in the object', ...found.problems]) : none('empty');
}

const LONG_WINDOW = /day|week|month/i;
const utilizationShare = (u) => (typeof u === 'number' && Number.isFinite(u) ? (u > 1 ? u / 100 : u) : null);

/**
 * The action for one reading. Order matters: anything that costs money or is refused stops first, a nearly full window
 * only warns (or steps the level down once when it is a short window or at 90%), and a reading that says nothing usable is `unknown`
 * (fail-open; observe never lifts a stop on it). { action, reason, kind? } where kind (stop only) is overage|limit.
 */
export function classify(info, { overrideActive = false } = {}) {
  if (!info) return { action: 'unknown', reason: 'no rate-limit info (null or absent): nothing to judge, carrying on' };
  const status = info.status ? token(info.status) : null;
  const type = info.rateLimitType ? token(info.rateLimitType) : null;
  const label = type ?? 'unknown limit';
  if (info.isUsingOverage === true) {
    return {
      action: 'stop',
      kind: 'overage',
      reason: info.overageUnreadable
        ? `isUsingOverage could not be read (${label}): treated as true, because the next request could be billed as extra usage`
        : `isUsingOverage is true (${label}): the next request would be billed as extra usage`,
    };
  }
  if (info.rateLimitType && info.rateLimitType.toLowerCase() === 'overage' && info.status !== 'allowed') {
    return { action: 'stop', kind: 'overage', reason: `the overage window is not allowed (status ${status ?? 'missing'}): extra usage must not be used` };
  }
  if (info.status && STOP_STATUSES.has(info.status)) {
    return { action: 'stop', kind: 'limit', reason: `status ${status} (${label}): the plan will not serve more requests until the limit resets` };
  }
  if (info.status === 'allowed_warning') {
    if (overrideActive) return { action: 'warn', reason: `status allowed_warning (${label}): the plan window is filling up; the owner override is active, so only logged` };
    const share = utilizationShare(info.utilization);
    const longWindow = Boolean(info.rateLimitType) && LONG_WINDOW.test(info.rateLimitType);
    if (longWindow && !(share !== null && share >= HIGH_UTILIZATION)) {
      return { action: 'warn', reason: `status allowed_warning (${label}): a long window filling up is normal after heavy use and can last for days, so it is only logged; a rejected window still stops the run` };
    }
    return { action: 'down', reason: `status allowed_warning (${label}): the plan window is nearly full` };
  }
  if (info.status === 'allowed') return { action: 'ok', reason: `status allowed (${label})` };
  return { action: 'unknown', reason: info.status ? `unrecognised status "${status}" (${label}): not treated as a limit` : `no status in the info (${label}): nothing to judge` };
}

// ---------------------------------------------------------------------------------------
// the observation log: state/usage.json, last MAX_OBSERVATIONS entries
// ---------------------------------------------------------------------------------------

const usagePath = () => rp('state', 'usage.json');
const usageLock = () => path.join(rp('state'), '.usage.lock');

export function readUsageLog() {
  const raw = readJson(usagePath(), null);
  const list = isObj(raw) && Array.isArray(raw.observations) ? raw.observations.filter(isObj) : [];
  return { schema: 1, observations: list.slice(-MAX_OBSERVATIONS) };
}

/** Appends one observation (atomically, under a lock) and returns how many the log holds now. */
function appendObservation(entry) {
  return withLock(usageLock(), () => {
    const log = readUsageLog();
    log.observations.push(entry);
    log.observations = log.observations.slice(-MAX_OBSERVATIONS);
    writeJsonAtomic(usagePath(), log);
    return log.observations.length;
  });
}

// ---------------------------------------------------------------------------------------
// effects on the run
// ---------------------------------------------------------------------------------------

/** A stop seen while the day's kaizen is still owed: the round is skipped (nothing else to degrade, the page is live). */
function skipKaizen({ date, now, session, config, reason }) {
  const read = readRunFile(date);
  if (read.status !== 'ok' || !kaizenPending(read.run)) return null;
  try {
    skipPhase({ phase: 'kaizen', reason: `usage stop: ${reason}`, session, date, now, config });
    return { skipped: true };
  } catch (err) {
    return { skipped: false, why: err.message };
  }
}

// ---------------------------------------------------------------------------------------
// observe
// ---------------------------------------------------------------------------------------

/**
 * One observation. opts: { input, session?, phase?, date?, now?, config? }. `input` is anything extractRateLimitInfo takes
 * (undefined or blank: nothing was given at all).
 * Returns { ok:true, action, reason, date, at, shape, info, ... }; throws UsageError only for a bad date or time.
 * `blind:true` = no rate-limit info was found in what was given (nothing given, unreadable, or an explicit null): the guard saw nothing.
 * A limit stop that resets within WAIT_MINUTES also carries `wait` (the send_later that re-observes after the reset).
 */
export function observe(opts = {}) {
  const config = opts.config ?? loadConfig();
  const now = toDate(opts.now);
  const nowIso = now.toISOString();
  const date = assertDate(opts.date ?? localParts(now, config.timezone).date);
  const session = typeof opts.session === 'string' && opts.session.trim() ? opts.session.trim().replace(/[^A-Za-z0-9_.:@/ -]/g, '?').slice(0, 120) : undefined; // echoed into events: inert text
  const phase = typeof opts.phase === 'string' && opts.phase.trim() ? token(opts.phase.trim()) : undefined;

  const parsed = extractRateLimitInfo(opts.input);
  const ov = th.ownerOverrideOf(config, now);
  const cls = classify(parsed.info, { overrideActive: Boolean(ov?.active) });
  const previous = readUsageLog().observations.at(-1) ?? null;
  const out = { ok: true, action: cls.action, reason: cls.reason, date, at: nowIso, shape: parsed.shape, info: parsed.info };
  let run = { found: false };

  // A guard that saw nothing must not look like one that saw a calm plan: say how it came to see nothing.
  const blind = parsed.info === null;
  if (blind) {
    out.blind = true;
    const given = !(opts.input === undefined || (typeof opts.input === 'string' && !opts.input.trim()));
    if (!given) out.reason = 'no input given (no --info, --file or piped JSON): the guard saw nothing, carrying on; pass the rate_limit_info object, or --info null when get_session had none';
    else if (parsed.shape === 'invalid') out.reason = `the input could not be read (${parsed.problems.join('; ')}): the guard saw nothing, carrying on; pass only the rate_limit_info object (isUsingOverage, rateLimitType, status, resetsAt)`;
  }

  if (cls.action === 'stop') {
    const stop = { reason: cls.reason, resetsAt: parsed.info.resetsAt, rateLimitType: parsed.info.rateLimitType, kind: cls.kind };
    const kaizen = skipKaizen({ date, now, session, config, reason: cls.reason });
    // a stop that closes the day's kaizen needs no latch (the day is over); otherwise latch it for the decision table
    run = kaizen?.skipped
      ? { found: true, recorded: false, kaizen }
      : { ...latchUsageStop({ date, now, stop, kind: cls.kind === 'overage' ? 'budget' : 'rate-limit', session, phase }), ...(kaizen ? { kaizen } : {}) };
    out.stop = { ...stop, at: nowIso };
    // A refusal whose reset time has already passed describes a limit that is over: most likely a reading older than the limit.
    // It is still a stop (nothing here may second-guess the platform), but the latch it leaves is expired on arrival, so `begin`
    // does not degrade the day for it, and the operator is told to look twice (PLAYBOOK usage guard). Money (overage) is never "stale".
    if (cls.kind === 'limit' && stop.resetsAt && Date.parse(stop.resetsAt) <= now.getTime()) {
      out.stale = true;
      out.reason = `${cls.reason}; its reset time ${stop.resetsAt} has already passed, so this may be a reading older than the limit`;
    }
    // A limit that reopens within minutes can be waited out (PLAYBOOK 6.5 step 2) instead of degrading the day for good: a tier never goes back up.
    // The operator decides (the planner must still say the phase fits); overage (money) is never waited out.
    if (cls.kind === 'limit' && stop.resetsAt && !out.stale) {
      const ms = Date.parse(stop.resetsAt) - now.getTime();
      if (ms > 0 && ms <= WAIT_MINUTES * 60_000) {
        const minutes = Math.ceil(ms / 60_000);
        const resumeMs = Math.ceil((Date.parse(stop.resetsAt) + 60_000) / 60_000) * 60_000;
        out.wait = {
          until: stop.resetsAt,
          minutes,
          sendLater: {
            at: noMillis(resumeMs),
            name: `sed-usage-wait-${date}`,
            message: `USAGE-WAIT ${date}${phase ? ` ${phase}` : ''}${session ? ` session ${session}` : ''}: the usage limit resets at ${stop.resetsAt}. Run get_session and usage observe again; on allowed continue the phase, on another stop run the stop procedure (PLAYBOOK 6.5a).`,
          },
        };
        out.reason = `${out.reason}; it resets in ${minutes} min, see wait: if the planner still says the phase fits you may wait for it instead of running begin`;
      }
    }
    if (ov?.active) out.reason = `${out.reason}; the owner override does not lift this`;
  } else if (cls.action === 'down') {
    const stored = th.loadThrottle(config);
    if (stored.lastDownDate === date) {
      out.throttle = { changed: false, alreadyDownToday: true, level: stored.level, skipped: true };
    } else {
      const t = th.throttleDown({ reason: 'rate-limit', now, config, date });
      const mirrored = t.changed && !t.overrideActive
        ? syncThrottleToRun({ date, now, level: t.to, reason: `rate-limit: ${cls.reason}`, kind: 'rate-limit', config })
        : { updated: false };
      out.throttle = { from: t.from, to: t.to, changed: t.changed, alreadyDownToday: t.alreadyDownToday, level: t.level, run: mirrored };
    }
    out.reason = `${cls.reason}; ${out.throttle.changed ? `throttle ${out.throttle.from} -> ${out.throttle.to}` : out.throttle.skipped ? 'the throttle already stepped down for this run date' : `throttle held at ${out.throttle.to}`}: re-read \`throttle get\` before the next workflow`;
  } else if (cls.action === 'warn') {
    // a note on the transition only: a busy hour must not fill the run's 200 events with identical warnings
    // (the log spans days: a warning that began yesterday still gives today's run its own note)
    const read = readRunFile(date);
    run = { found: read.status === 'ok', noted: false };
    if (run.found && !(previous?.action === 'warn' && previous.date === date)) {
      try {
        eventRun({ kind: 'note', msg: `usage warning${ov?.active ? ' during the owner override' : ''}: ${cls.reason}`, by: 'usage', date, now, config, code: 'usage-warn' });
        run.noted = true;
      } catch (err) {
        run.error = err.message;
      }
    }
  } else if (cls.action === 'ok') {
    run = liftUsageStop({ date, now, session });
    if (run.cleared) out.reason = `${cls.reason}; cleared the usage stop recorded ${run.clearedStop.at ?? '?'} (${run.why})`;
    else if (run.standingStop) {
      out.standingStop = run.standingStop;
      out.reason = `${cls.reason}; the usage stop recorded ${run.standingStop.at ?? '?'} still stands until ${run.standingStop.resetsAt} (a reading can be stale, the reset time decides): \`begin\` keeps the day on the scripts-only path`;
    }
  } else {
    // unknown: fail-open for the observation itself, and it never lifts anything
    const read = readRunFile(date);
    run = { found: read.status === 'ok' };
    const standing = read.status === 'ok' ? usageStopActive(read.run, now.getTime()) : null;
    if (standing) out.standingStop = standing;
  }

  if (ov) {
    out.override = th.overrideView(ov);
    if (ov.warnings.length) out.warnings = ov.warnings;
  }
  if (parsed.problems.length) out.problems = parsed.problems;
  if (parsed.foundAt) out.foundAt = parsed.foundAt;
  out.run = run;
  const entry = {
    at: nowIso,
    date,
    session: session ?? null,
    phase: phase ?? null,
    action: out.action,
    reason: out.reason,
    shape: parsed.shape,
    status: parsed.info?.status ?? null,
    rateLimitType: parsed.info?.rateLimitType ?? null,
    isUsingOverage: parsed.info?.isUsingOverage ?? null,
    resetsAt: parsed.info?.resetsAt ?? null,
    override: Boolean(ov?.active),
    ...(out.throttle ? { throttle: { from: out.throttle.from ?? null, to: out.throttle.to ?? null, changed: out.throttle.changed } } : {}),
    ...(run.recorded ? { latched: true } : {}),
    ...(run.cleared ? { cleared: true } : {}),
    ...(blind ? { blind: true } : {}),
  };
  try {
    out.observations = appendObservation(entry);
  } catch (err) {
    out.logError = err.message; // the log is diagnostics: a failure to append must not hide the answer (the effects above are done)
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// clear: the owner's way out of a limit stop
// ---------------------------------------------------------------------------------------

/**
 * `usage clear`: lifts a LIMIT stop that its reset time keeps in force although the plan is open again (a refusal read from a window
 * that does not apply to us, a clock error). It needs a reason in words, records it in an event, refuses an overage stop (money),
 * and does not raise the tier the stop forced. opts: { reason, date?, session?, now?, config? }.
 * Returns { ok, date, found, cleared, ... } (ok:false when there is no usable run or the stop is an overage one).
 */
export function clear(opts = {}) {
  const config = opts.config ?? loadConfig();
  const now = toDate(opts.now);
  const date = assertDate(opts.date ?? localParts(now, config.timezone).date);
  const read = readRunFile(date);
  if (read.status !== 'ok') return { ok: false, date, found: false, cleared: false, error: read.status === 'missing' ? `no run file for ${date}` : `the run file for ${date} is corrupt: run \`state.mjs begin\` first` };
  const r = clearUsageStop({ date, now, reason: opts.reason, session: opts.session });
  return { ok: !r.refused, date, ...r };
}
