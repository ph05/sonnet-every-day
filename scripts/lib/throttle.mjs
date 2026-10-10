// Budget throttle (CONTRACT 6.1 `throttle`): state/throttle.json holds the current level.
// Levels ordered all-in > balanced > lean > minimal. `down` goes one notch (never below
// config floor), `up` one notch (never above config ceiling), `set` is an explicit operator
// override, `day-clean` counts clean publishes and auto-ups after upAfterCleanDays.
//
// Owner override (config.budget.ownerOverride = { until, level, note }): while now < until the owner's level is the
// EFFECTIVE level of every command (levelConfig, begin, status, today). It is derived from config and the clock on
// each call and never written into state/throttle.json, so nothing can stay stuck at it: when `until` passes the stored
// level simply applies again. While it is active a signal of the token budget it lifted (`down` for a rate limit or an exhausted
// budget), `up` and `day-clean` are recorded no-ops on the stored level (`down --force` and `set` still edit it, for the day the
// override ends). A usage limit and an overage warning are the plan and the money, not that budget: never absorbed.
import path from 'node:path';
import { rp, readJson, writeJsonAtomic, loadConfig, localParts } from './common.mjs';
import { withLock, levelConfigFor, UsageError, toDate, assertDate } from './runstate.mjs';

/** Lowest to highest. */
export const LEVELS_ASC = ['minimal', 'lean', 'balanced', 'all-in'];
const MAX_LOG = 200;

const throttlePath = () => rp('state', 'throttle.json');
const lockPath = () => path.join(rp('state'), '.throttle.lock');
const rank = (level) => LEVELS_ASC.indexOf(level);

function bounds(config) {
  const auto = config.budget.autoThrottle ?? {};
  const floor = LEVELS_ASC.includes(auto.floor) ? auto.floor : 'minimal';
  const ceiling = LEVELS_ASC.includes(auto.ceiling) ? auto.ceiling : 'balanced';
  return { floor, ceiling, upAfterCleanDays: Number.isInteger(auto.upAfterCleanDays) && auto.upAfterCleanDays > 0 ? auto.upAfterCleanDays : 5 };
}

const DEFAULT_DOWN_ON = ['rate-limit', 'usage-limit', 'budget-exhausted', 'overage-warning'];
const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|z|[+-]\d{2}:\d{2})$/;

/**
 * A strict ISO-8601 instant WITH an explicit offset ("2026-10-11T19:00:00-04:00", "...Z"): { ms, iso } or { error }.
 * Date.parse alone is not enough: it rolls 2026-02-31 over to March 3, accepts 24:00, and reads a time without
 * an offset in the local zone of whatever machine runs the script.
 */
export function parseInstant(text) {
  const raw = typeof text === 'string' ? text.trim() : '';
  const m = INSTANT_RE.exec(raw);
  if (!m) return { error: 'is not an ISO-8601 instant with an explicit offset (for example 2026-10-11T19:00:00-04:00 or 2026-10-11T23:00:00Z)' };
  const [year, month, day, hour, minute] = m.slice(1, 6).map(Number);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return { error: 'is not a real calendar date' };
  if (hour > 23 || minute > 59 || second > 59) return { error: 'is not a real time of day' };
  const offset = m[8].toUpperCase();
  if (offset !== 'Z' && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59)) return { error: 'has an impossible UTC offset' };
  const ms = Date.parse(raw.replace(/^(\d{4}-\d{2}-\d{2})[Tt ]/, '$1T').replace(/z$/, 'Z'));
  return Number.isFinite(ms) ? { ms, iso: new Date(ms).toISOString() } : { error: 'could not be parsed' };
}

/**
 * The owner's budget override (config.budget.ownerOverride) as of `nowInput`, or null when the config has none
 * (then nothing about any output changes). A malformed override is IGNORED with warnings, never a crash:
 * { configured:true, valid, active, until, untilUtc, level, note, minutesLeft, warnings }. `active` = valid and now < until.
 */
export function ownerOverrideOf(config, nowInput) {
  const raw = config?.budget?.ownerOverride;
  if (raw === undefined || raw === null) return null;
  const now = nowInput === undefined || nowInput === null ? new Date() : toDate(nowInput);
  const out = { configured: true, valid: false, active: false, until: null, untilUtc: null, level: null, note: null, minutesLeft: null, warnings: [] };
  const problems = ownerOverrideProblems(config, { note: false }); // a malformed note costs nothing at run time; the validator reports it
  if (problems.length) {
    out.warnings = problems.map((p) => `${p}; the override is ignored`);
    return out;
  }
  const until = parseInstant(raw.until);
  const left = until.ms - now.getTime();
  return {
    ...out,
    valid: true,
    active: left > 0,
    until: raw.until,
    untilUtc: until.iso,
    level: raw.level,
    note: typeof raw.note === 'string' && raw.note.trim() ? raw.note.trim() : null,
    minutesLeft: left > 0 ? Math.ceil(left / 60000) : 0,
  };
}

/** What is wrong with config.budget.ownerOverride (empty: absent or fine). Shared with the repo validator. */
export function ownerOverrideProblems(config, { note = true } = {}) {
  const raw = config?.budget?.ownerOverride;
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== 'object' || Array.isArray(raw)) return ['budget.ownerOverride must be an object {until, level, note}'];
  const problems = [];
  if (typeof raw.until !== 'string' || !raw.until.trim()) problems.push('budget.ownerOverride.until is missing (an ISO instant with offset, for example 2026-10-11T19:00:00-04:00)');
  else {
    const parsed = parseInstant(raw.until);
    if (parsed.error) problems.push(`budget.ownerOverride.until ${JSON.stringify(raw.until)} ${parsed.error}`);
  }
  const levels = config.budget.levels;
  if (typeof raw.level !== 'string' || !levels || !Object.hasOwn(levels, raw.level)) {
    problems.push(`budget.ownerOverride.level ${JSON.stringify(raw.level)} is not a level in budget.levels (${Object.keys(levels ?? {}).join('|')})`);
  }
  if (note && raw.note !== undefined && typeof raw.note !== 'string') problems.push('budget.ownerOverride.note must be a string when present');
  return problems;
}

/** The override as the commands print it: { active, until, level, minutesLeft, ... } (undefined without an override). */
export function overrideView(ov) {
  if (!ov) return undefined;
  return {
    active: ov.active,
    until: ov.until,
    level: ov.level,
    minutesLeft: ov.minutesLeft,
    ...(ov.valid ? { untilUtc: ov.untilUtc } : { ignored: true, warnings: ov.warnings }),
    ...(ov.valid && !ov.active ? { expired: true } : {}),
    ...(ov.note ? { note: ov.note } : {}),
  };
}

const slug = (s) => String(s).toLowerCase().replace(/[\s_]+/g, '-');
/** Is `reason` one of the automatic signals (config.budget.autoThrottle.downOn) that `throttle down` exists for? */
export function isLimitSignal(reason, config) {
  const downOn = config?.budget?.autoThrottle?.downOn;
  const tokens = Array.isArray(downOn) && downOn.length ? downOn : DEFAULT_DOWN_ON;
  const r = slug(reason);
  return tokens.some((t) => typeof t === 'string' && t.trim() && r.includes(slug(t.trim())));
}
// The plan itself running out, and money: not the token budget the owner lifted. These stop agent work (PLAYBOOK 6.5a) whatever the override says.
const STOP_SIGNALS = ['usage-limit', 'overage'];
/** Does `reason` name the plan running out or an overage? Then `throttle down` also says stop (FM-46, FM-48). */
export const isStopSignal = (reason) => STOP_SIGNALS.some((t) => slug(reason).includes(t));
/**
 * Is `reason` a signal the owner override absorbs? Only the token budget they lifted: rate limits that heavy use causes and an exhausted
 * budget. A usage limit or an overage warning is the plan or the money, never absorbed (the stored level steps down as it always did).
 */
export const isAbsorbedSignal = (reason, config) => isLimitSignal(reason, config) && !isStopSignal(reason);
const STOP_NOTE = 'the plan itself is out of room or money is involved: start no agent work, run the usage stop procedure (PLAYBOOK 6.5a); the owner override does not lift this';

function normalize(raw, config) {
  const cfgLevel = LEVELS_ASC.includes(config.budget.level) ? config.budget.level : 'balanced';
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    schema: 1,
    level: LEVELS_ASC.includes(o.level) ? o.level : cfgLevel,
    cleanDays: Number.isInteger(o.cleanDays) && o.cleanDays >= 0 ? o.cleanDays : 0,
    lastChange: typeof o.lastChange === 'string' ? o.lastChange : null,
    lastCleanDate: typeof o.lastCleanDate === 'string' ? o.lastCleanDate : null,
    lastDownDate: typeof o.lastDownDate === 'string' ? o.lastDownDate : null,
    log: Array.isArray(o.log) ? o.log.filter((e) => e && typeof e === 'object') : [],
  };
}

export function loadThrottle(config = loadConfig()) {
  return normalize(readJson(throttlePath(), null), config);
}

/** The effective budget for a level: config.budget.levels[level] plus the publish reserve and the spend cap. */
export function levelConfigOf(config, level) {
  if (!config.budget.levels?.[level]) {
    throw new UsageError(`unknown level "${level}" (expected ${Object.keys(config.budget.levels ?? {}).join('|')})`);
  }
  return levelConfigFor(config, level);
}

/**
 * The throttle as the commands print it. `level`/`levelConfig` are the EFFECTIVE ones: the owner override's while it is
 * active (then `storedLevel` is what applies once it ends), else the stored level. Without an override in the config the
 * shape is exactly what it always was.
 */
export function describeThrottle(state, config = loadConfig(), opts = {}) {
  const b = bounds(config);
  const ov = ownerOverrideOf(config, opts.now);
  const level = ov?.active ? ov.level : state.level;
  return {
    level,
    cleanDays: state.cleanDays,
    lastChange: state.lastChange,
    floor: b.floor,
    ceiling: b.ceiling,
    upAfterCleanDays: b.upAfterCleanDays,
    levelConfig: levelConfigOf(config, level),
    ...(ov ? { override: overrideView(ov), ...(ov.active ? { storedLevel: state.level } : {}), ...(ov.warnings.length ? { warnings: ov.warnings } : {}) } : {}),
  };
}

function mutate(config, fn, now) {
  return withLock(lockPath(), () => {
    const state = loadThrottle(config);
    const out = fn(state, bounds(config));
    state.log = state.log.slice(-MAX_LOG);
    writeJsonAtomic(throttlePath(), state);
    return { ...describeThrottle(state, config, { now }), ...out };
  });
}

function stamp(opts) {
  const now = toDate(opts.now);
  return { now, at: now.toISOString() };
}

/** `opts.now` (Date or ISO text, default the clock) decides whether the owner override is still active. */
export function getThrottle(config = loadConfig(), opts = {}) {
  return { ...describeThrottle(loadThrottle(config), config, opts), changed: false };
}

/**
 * One notch down, never below the floor. Always resets cleanDays and logs the signal, even when already at the
 * floor. At most ONE notch per run date: a retrying workflow reporting the same rate limit five times must not
 * drop the level five notches (and cost ten clean days to climb back); further signals that day are logged as
 * held unless `force` (an operator deliberately stepping down again).
 * While the owner override is active a signal of the token budget they lifted (rate-limit, budget-exhausted: isAbsorbedSignal) is a
 * recorded no-op { ok:true, changed:false, overrideActive:true }: the reason stays in the log, the stored level and the clean-day streak
 * are untouched. A usage limit or an overage warning is never absorbed, and says `stop:true` (PLAYBOOK 6.5a). `force` steps the stored
 * level down anyway (it matters once the override ends).
 */
export function throttleDown(opts = {}) {
  const config = opts.config ?? loadConfig();
  const { now, at } = stamp(opts);
  const date = assertDate(opts.date ?? localParts(now, config.timezone).date);
  const reason = opts.reason && opts.reason !== true ? String(opts.reason) : 'unspecified';
  const ov = ownerOverrideOf(config, now);
  const absorbed = Boolean(ov?.active) && !opts.force && isAbsorbedSignal(reason, config);
  const stop = isStopSignal(reason) ? { stop: true, note: STOP_NOTE } : {};
  return mutate(config, (st, b) => {
    const from = st.level;
    if (absorbed) {
      st.log.push({ at, action: 'down', from, to: from, reason, date, held: `owner override active until ${ov.until} (level ${ov.level}): a limit signal does not lower the stored level (use --force to)` });
      return { ok: true, action: 'down', from, to: from, changed: false, alreadyDownToday: false, date, reason, overrideActive: true };
    }
    st.cleanDays = 0;
    if (st.lastDownDate === date && !opts.force) {
      st.log.push({ at, action: 'down', from, to: from, reason, date, held: `already stepped down for ${date} (use --force to step again)` });
      return { action: 'down', from, to: from, changed: false, alreadyDownToday: true, date, reason, ...stop, ...(ov?.active ? { overrideActive: true } : {}) };
    }
    const target = rank(from) - 1;
    const to = target >= rank(b.floor) ? LEVELS_ASC[target] : from;
    st.level = to;
    if (to !== from) st.lastChange = at;
    st.lastDownDate = date;
    st.log.push({ at, action: 'down', from, to, reason, date, ...(to === from ? { held: `at floor (${b.floor})` } : {}) });
    return { action: 'down', from, to, changed: to !== from, alreadyDownToday: false, date, reason, ...stop, ...(ov?.active ? { overrideActive: true } : {}) };
  }, now);
}

/** One notch up, never above the ceiling. A recorded no-op while the owner override is active. */
export function throttleUp(opts = {}) {
  const config = opts.config ?? loadConfig();
  const { now, at } = stamp(opts);
  const reason = opts.reason && opts.reason !== true ? String(opts.reason) : 'manual';
  const ov = ownerOverrideOf(config, now);
  return mutate(config, (st, b) => {
    const from = st.level;
    if (ov?.active) {
      st.log.push({ at, action: 'up', from, to: from, reason, held: `owner override active until ${ov.until}: the stored level is not moved` });
      return { ok: true, action: 'up', from, to: from, changed: false, reason, overrideActive: true };
    }
    const target = rank(from) + 1;
    const to = target <= rank(b.ceiling) ? LEVELS_ASC[target] : from;
    st.level = to;
    if (to !== from) {
      st.lastChange = at;
      st.cleanDays = 0;
    }
    st.log.push({ at, action: 'up', from, to, reason, ...(to === from ? { held: `at ceiling (${b.ceiling})` } : {}) });
    return { action: 'up', from, to, changed: to !== from, reason };
  }, now);
}

/** Explicit operator override: any configured level, even outside floor/ceiling. */
export function throttleSet(opts = {}) {
  const config = opts.config ?? loadConfig();
  const { now, at } = stamp(opts);
  if (!LEVELS_ASC.includes(opts.level) || !config.budget.levels?.[opts.level]) {
    throw new UsageError(`--level must be one of ${LEVELS_ASC.join('|')} (got "${opts.level}")`);
  }
  const reason = opts.reason && opts.reason !== true ? String(opts.reason) : 'manual set';
  const ov = ownerOverrideOf(config, now);
  return mutate(config, (st) => {
    const from = st.level;
    st.level = opts.level;
    st.cleanDays = 0;
    st.lastDownDate = null; // an explicit override starts a fresh budget for stepping down
    if (from !== opts.level) st.lastChange = at;
    st.log.push({ at, action: 'set', from, to: opts.level, reason });
    return { action: 'set', from, to: opts.level, changed: from !== opts.level, reason, ...(ov?.active ? { overrideActive: true } : {}) };
  }, now);
}

/**
 * Counts one fully clean publish (idempotent per date); auto-ups once upAfterCleanDays are reached. While the owner
 * override is active nothing is counted: a day run at the override's level proves nothing about the stored one.
 */
export function throttleDayClean(opts = {}) {
  const config = opts.config ?? loadConfig();
  const { now, at } = stamp(opts);
  const date = assertDate(opts.date ?? localParts(now, config.timezone).date);
  const ov = ownerOverrideOf(config, now);
  return mutate(config, (st, b) => {
    if (ov?.active) {
      const held = `owner override active until ${ov.until}: a day run at level ${ov.level} says nothing about the stored level ${st.level}`;
      if (!st.log.some((e) => e.action === 'day-clean' && e.date === date && e.held)) st.log.push({ at, action: 'day-clean', from: st.level, to: st.level, reason: `day ${date} not counted`, date, held });
      return { ok: true, action: 'day-clean', from: st.level, to: st.level, changed: false, alreadyCounted: false, counted: false, date, overrideActive: true };
    }
    if (st.lastCleanDate === date) return { action: 'day-clean', from: st.level, to: st.level, changed: false, alreadyCounted: true, date };
    const from = st.level;
    st.cleanDays += 1;
    st.lastCleanDate = date;
    let reason = `clean day ${date}`;
    if (st.cleanDays >= b.upAfterCleanDays) {
      const target = rank(from) + 1;
      if (target <= rank(b.ceiling)) {
        st.level = LEVELS_ASC[target];
        st.cleanDays = 0;
        st.lastChange = at;
        reason = `${b.upAfterCleanDays} clean days in a row`;
      } else {
        st.cleanDays = b.upAfterCleanDays; // already at the ceiling: keep the counter from growing forever
      }
    }
    st.log.push({ at, action: 'day-clean', from, to: st.level, reason, cleanDays: st.cleanDays });
    return { action: 'day-clean', from, to: st.level, changed: st.level !== from, alreadyCounted: false, date, reason };
  }, now);
}

