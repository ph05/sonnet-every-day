// Budget throttle (CONTRACT 6.1 `throttle`): state/throttle.json holds the current level.
// Levels ordered all-in > balanced > lean > minimal. `down` goes one notch (never below
// config floor), `up` one notch (never above config ceiling), `set` is an explicit operator
// override, `day-clean` counts clean publishes and auto-ups after upAfterCleanDays.
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

export function describeThrottle(state, config = loadConfig()) {
  const b = bounds(config);
  return {
    level: state.level,
    cleanDays: state.cleanDays,
    lastChange: state.lastChange,
    floor: b.floor,
    ceiling: b.ceiling,
    upAfterCleanDays: b.upAfterCleanDays,
    levelConfig: levelConfigOf(config, state.level),
  };
}

function mutate(config, fn) {
  return withLock(lockPath(), () => {
    const state = loadThrottle(config);
    const out = fn(state, bounds(config));
    state.log = state.log.slice(-MAX_LOG);
    writeJsonAtomic(throttlePath(), state);
    return { ...describeThrottle(state, config), ...out };
  });
}

function stamp(opts) {
  const now = toDate(opts.now);
  return { now, at: now.toISOString() };
}

export function getThrottle(config = loadConfig()) {
  return { ...describeThrottle(loadThrottle(config), config), changed: false };
}

/**
 * One notch down, never below the floor. Always resets cleanDays and logs the signal, even when already at the
 * floor. At most ONE notch per run date: a retrying workflow reporting the same rate limit five times must not
 * drop the level five notches (and cost ten clean days to climb back); further signals that day are logged as
 * held unless `force` (an operator deliberately stepping down again).
 */
export function throttleDown(opts = {}) {
  const config = opts.config ?? loadConfig();
  const { now, at } = stamp(opts);
  const date = assertDate(opts.date ?? localParts(now, config.timezone).date);
  const reason = opts.reason && opts.reason !== true ? String(opts.reason) : 'unspecified';
  return mutate(config, (st, b) => {
    const from = st.level;
    st.cleanDays = 0;
    if (st.lastDownDate === date && !opts.force) {
      st.log.push({ at, action: 'down', from, to: from, reason, date, held: `already stepped down for ${date} (use --force to step again)` });
      return { action: 'down', from, to: from, changed: false, alreadyDownToday: true, date, reason };
    }
    const target = rank(from) - 1;
    const to = target >= rank(b.floor) ? LEVELS_ASC[target] : from;
    st.level = to;
    if (to !== from) st.lastChange = at;
    st.lastDownDate = date;
    st.log.push({ at, action: 'down', from, to, reason, date, ...(to === from ? { held: `at floor (${b.floor})` } : {}) });
    return { action: 'down', from, to, changed: to !== from, alreadyDownToday: false, date, reason };
  });
}

/** One notch up, never above the ceiling. */
export function throttleUp(opts = {}) {
  const config = opts.config ?? loadConfig();
  const { at } = stamp(opts);
  const reason = opts.reason && opts.reason !== true ? String(opts.reason) : 'manual';
  return mutate(config, (st, b) => {
    const from = st.level;
    const target = rank(from) + 1;
    const to = target <= rank(b.ceiling) ? LEVELS_ASC[target] : from;
    st.level = to;
    if (to !== from) {
      st.lastChange = at;
      st.cleanDays = 0;
    }
    st.log.push({ at, action: 'up', from, to, reason, ...(to === from ? { held: `at ceiling (${b.ceiling})` } : {}) });
    return { action: 'up', from, to, changed: to !== from, reason };
  });
}

/** Explicit operator override: any configured level, even outside floor/ceiling. */
export function throttleSet(opts = {}) {
  const config = opts.config ?? loadConfig();
  const { at } = stamp(opts);
  if (!LEVELS_ASC.includes(opts.level) || !config.budget.levels?.[opts.level]) {
    throw new UsageError(`--level must be one of ${LEVELS_ASC.join('|')} (got "${opts.level}")`);
  }
  const reason = opts.reason && opts.reason !== true ? String(opts.reason) : 'manual set';
  return mutate(config, (st) => {
    const from = st.level;
    st.level = opts.level;
    st.cleanDays = 0;
    st.lastDownDate = null; // an explicit override starts a fresh budget for stepping down
    if (from !== opts.level) st.lastChange = at;
    st.log.push({ at, action: 'set', from, to: opts.level, reason });
    return { action: 'set', from, to: opts.level, changed: from !== opts.level, reason };
  });
}

/** Counts one fully clean publish (idempotent per date); auto-ups once upAfterCleanDays are reached. */
export function throttleDayClean(opts = {}) {
  const config = opts.config ?? loadConfig();
  const { now, at } = stamp(opts);
  const date = assertDate(opts.date ?? localParts(now, config.timezone).date);
  return mutate(config, (st, b) => {
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
  });
}

