// Orbital Knitwear entry point: boot, state, URL hash, run loop and event wiring.
// All rules live in the pure engine modules; this file owns the clock, the state and the app:* events.
import { createUI } from './ui.js';
import { RANGES, normalizeSat, satInfo, findRepeats, ssoInclination, sampleTrack } from './orbit.js';
import { createSim } from './coverage.js';
import { CARDS, getCard, cardInfo, applyLocks, evaluate, badgeName } from './cards.js';
import { parseHash, serializeHash, loadStore, saveStore, mulberry32 } from './state.js';

let resolveThumb;
window.__sedThumbReady = new Promise((resolve) => {
  resolveThumb = resolve;
});

const SPEEDS = [0.25, 1, 4, 16];
const MAX_SATS = 3;
const FREE_DAYS = 365;
const CATCH_UP_DAY = 2;
const PREROLL_DAY = 3;
const FRAME_BUDGET_MS = 8;
const PREROLL_SLICE_MS = 40;
const RESTART_DEBOUNCE_MS = 120;
const HASH_THROTTLE_MS = 500;
const TICK_MS = 100;
const PREVIEW_MS = 1500;
const MAX_DT = 0.1;
const DAY_EPS = 1e-9;
const LOCK_LABELS = { swath: 'Swath width', season: 'Sun date' };
const SAT_KEYS = ['alt', 'inc', 'ecc', 'node', 'argp', 'swath'];

let state = null;
let store = null;
let sim = null;
let ui = null;
let horizon = FREE_DAYS;
let finished = false;
let catchUpTo = 0;
let stepTarget = null;
let restartTimer = 0;
let hashTimer = 0;
let lastHash = '';
let testMode = false;
let rafId = 0;
let lastTs = 0;
let lastTickAt = 0;
let previewUntil = 0;
let previewKey = '';
let previewTrack = null;
let previewShown = false;
let dirty = true;
let failed = false;
let ready = false;
let reducedMotion = false;
let pressCount = 0;
let storageWarned = false;
let selfTestStarted = false;
let resolveReady;

const readyPromise = new Promise((resolve) => {
  resolveReady = resolve;
});
const frame = {
  day: 0,
  view: 'flat',
  season: 0,
  terminator: true,
  sun: { lat: 0, lon: 0 },
  grid: null,
  sats: [],
  preview: null,
  focus: null,
};

const emit = (name, detail) => document.dispatchEvent(new CustomEvent(`app:${name}`, { detail }));
const toast = (key, params) => emit('toast', params ? { key, params } : { key });
const activeCard = () => getCard(state.card);
const bestOf = (id) => (store.best[id] ? store.best[id] : null);
const isRunning = () => state.playing && !finished && !failed;
const nowMs = () => performance.now();
const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;
const snapTo = (v, step) => Number((Math.round(v / step) * step).toFixed(3));
const copyState = () => ({ ...state, sats: state.sats.map((s) => ({ ...s })) });

function fail(err) {
  if (failed) return;
  failed = true;
  const message = err && err.message ? String(err.message) : String(err);
  console.error('Orbital Knitwear stopped:', err);
  clearTimeout(restartTimer);
  clearTimeout(hashTimer);
  restartTimer = 0;
  hashTimer = 0;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  emit('status', { kind: 'error', message });
  resolveReady(false);
}

// Every listener and timer callback goes through here so one fault becomes the "yarn snapped" panel, not a dead page.
const guarded = (fn) => (...args) => {
  try {
    return fn(...args);
  } catch (err) {
    fail(err);
    return undefined;
  }
};

const frameCallback = guarded((ts) => onFrame(ts));

function cardsPayload() {
  return { cards: CARDS.map((card) => cardInfo(card, bestOf(card.id))), active: state.card };
}

function infoPayload() {
  return { sats: state.sats.map(satInfo), sel: state.sel, ticks: findRepeats(state.sats[state.sel]) };
}

function emitState(reason) {
  emit('state', { state: copyState(), reason });
  emit('info', infoPayload());
}

function emitTick(force) {
  const t = nowMs();
  if (!sim || (!force && t - lastTickAt < TICK_MS)) return;
  lastTickAt = t;
  const metrics = sim.metrics(state.sel);
  const card = activeCard();
  const status = card ? evaluate(card, metrics, sim, finished, state.peeked, bestOf(card.id)) : null;
  emit('tick', { day: sim.day, running: isRunning(), metrics, card: status });
}

function persist() {
  if (!saveStore(store) && !storageWarned) {
    storageWarned = true;
    toast('storageOff');
  }
}

function writeHash() {
  hashTimer = 0;
  lastHash = serializeHash(state) + (testMode ? '&test=1' : '');
  if (location.hash === lastHash) return;
  try {
    history.replaceState(null, '', lastHash);
  } catch {
    // Sandboxed frames and some file URLs refuse; the page still works, the link just stays at its old value.
  }
}

function scheduleHash() {
  if (!hashTimer) hashTimer = setTimeout(guarded(writeHash), HASH_THROTTLE_MS);
}

function invalidate() {
  dirty = true;
  kick();
}

function kick() {
  if (rafId || failed || !sim || document.hidden) return;
  rafId = requestAnimationFrame(frameCallback);
}

function previewVisible(t) {
  return t < previewUntil || (!isRunning() && sim.day < 0.01);
}

function currentPreview() {
  const sat = state.sats[state.sel];
  const days = Math.min(1, horizon);
  const key = `${SAT_KEYS.map((k) => sat[k]).join()}|${state.season}|${days}`;
  if (key !== previewKey) {
    previewKey = key;
    previewTrack = sampleTrack(sat, state.season, 0, days, 720);
  }
  return previewTrack;
}

function fillFrame(t) {
  const card = activeCard();
  const sun = sim.sunPoint();
  frame.day = sim.day;
  frame.view = state.view;
  frame.season = state.season;
  frame.terminator = state.terminator;
  frame.sun.lat = sun.lat;
  frame.sun.lon = sun.lon;
  frame.grid = sim.grid;
  const pos = sim.positions();
  frame.sats.length = pos.length;
  for (let i = 0; i < pos.length; i++) {
    const entry = frame.sats[i] || (frame.sats[i] = { index: i, lat: 0, lon: 0, altKm: 0, color: i, selected: false, trail: null });
    entry.index = i;
    entry.lat = pos[i].lat;
    entry.lon = pos[i].lon;
    entry.altKm = pos[i].altKm;
    entry.color = i;
    entry.selected = i === state.sel;
    entry.trail = sim.trail(i);
  }
  previewShown = previewVisible(t);
  frame.preview = previewShown ? currentPreview() : null;
  frame.focus = card ? card.regions : null;
}

function drawFrame(t) {
  fillFrame(t);
  ui.draw(frame);
  dirty = false;
}

function daysThisFrame(dt) {
  const left = horizon - sim.day;
  if (left <= DAY_EPS) return 0;
  if (catchUpTo - sim.day > DAY_EPS) return Math.min(left, catchUpTo - sim.day);
  if (stepTarget !== null) return Math.min(left, Math.max(0, stepTarget - sim.day));
  return state.playing ? Math.min(left, state.speed * dt) : 0;
}

function setPlaying(on) {
  if (state.playing === on) return;
  state.playing = on;
  emitState('user');
  emitTick(true);
  invalidate();
}

function afterAdvance() {
  if (sim.day >= horizon - DAY_EPS) finishRun();
  else if (stepTarget !== null && sim.day >= stepTarget - DAY_EPS) {
    stepTarget = null;
    emitTick(true);
  }
}

// Toasts and bests after a card run; a peeked run earns neither (the result panel says so).
function announce(card, status) {
  if (state.peeked) return;
  if (!status.pass) {
    toast('cardMissed', { short: status.short });
    return;
  }
  const params = { badge: badgeName(status.badge), badgeId: status.badge, score: round1(status.score), par: round1(status.par) };
  const previous = bestOf(card.id);
  const score = round2(status.score);
  if (previous && score <= previous.score) {
    toast('cardPassed', params);
    return;
  }
  store.best[card.id] = { score, badge: status.badge };
  persist();
  emit('cards', cardsPayload());
  toast(previous ? 'newBest' : 'cardPassed', params);
}

function finishRun() {
  if (finished) return;
  finished = true;
  stepTarget = null;
  state.playing = false;
  emitState('user');
  emitTick(true);
  const card = activeCard();
  if (card) {
    const status = evaluate(card, sim.metrics(state.sel), sim, true, state.peeked, bestOf(card.id));
    if (status) announce(card, status);
  }
  invalidate();
}

function onFrame(ts) {
  rafId = 0;
  if (failed || !sim) return;
  if (document.hidden) {
    lastTs = 0;
    return;
  }
  const dt = lastTs ? Math.min(MAX_DT, Math.max(0, (ts - lastTs) / 1000)) : 1 / 60;
  lastTs = ts;
  let moved = false;
  if (!restartTimer && !finished) {
    const days = daysThisFrame(dt);
    if (days > 0) moved = sim.advance(days, FRAME_BUDGET_MS) > 0;
  }
  if (moved) {
    dirty = true;
    afterAdvance();
  }
  const t = nowMs();
  if (dirty || (previewShown && !previewVisible(t))) drawFrame(t);
  if (moved) emitTick(false);
  const busy = isRunning() || stepTarget !== null || catchUpTo - sim.day > DAY_EPS || dirty || t < previewUntil;
  if (busy && !failed) kick();
  else lastTs = 0;
}

function restartRun() {
  clearTimeout(restartTimer);
  restartTimer = 0;
  const card = activeCard();
  const wasFinished = finished;
  sim = createSim(state.sats, state.season, sim);
  horizon = card ? card.days : FREE_DAYS;
  finished = false;
  stepTarget = null;
  catchUpTo = Math.min(CATCH_UP_DAY, horizon);
  if (wasFinished && !reducedMotion && !state.playing) {
    state.playing = true;
    emitState('user');
  }
  emitTick(true);
  invalidate();
}

function scheduleRestart() {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(guarded(restartRun), RESTART_DEBOUNCE_MS);
}

// Announces a state change to the UI, queues the URL write and restarts the run (debounced for slider drags).
function commit(reason, { immediate = false, restart = true } = {}) {
  previewUntil = nowMs() + PREVIEW_MS;
  emitState(reason);
  scheduleHash();
  if (restart) {
    if (immediate) restartRun();
    else scheduleRestart();
  }
  invalidate();
}

function indexOrSel(index) {
  return Number.isInteger(index) && index >= 0 && index < state.sats.length ? index : state.sel;
}

function patchSat(index, patch, quiet) {
  const i = indexOrSel(index);
  const card = activeCard();
  const next = { ...state.sats[i] };
  if (patch && typeof patch === 'object') {
    for (const key of SAT_KEYS) {
      if (key in patch) next[key] = patch[key];
    }
  }
  const { sat, notes } = normalizeSat(next, card ? card.locks : null);
  if (!quiet) {
    if (notes.includes('locked:swath')) toast('locked', { param: LOCK_LABELS.swath, key: 'swath' });
    if (notes.includes('perigee-clamped') && Number(patch && patch.alt) < RANGES.alt.min) toast('tooLow');
    if (notes.includes('apogee-clamped')) toast('tooHigh');
  }
  const same = SAT_KEYS.every((key) => sat[key] === state.sats[i][key]);
  state.sats[i] = sat;
  commit('user', { restart: !same });
}

// View, speed and night shading are remembered per viewer and never restart the run.
function setPref(key, value) {
  state[key] = value;
  store.prefs[key] = value;
  persist();
  commit('user', { restart: false });
}

function selectSat(index) {
  const i = indexOrSel(index);
  if (i === state.sel) return;
  state.sel = i;
  commit('user', { restart: false });
  emitTick(true);
}

function addSat() {
  const card = activeCard();
  if (state.sats.length >= (card ? card.maxSats : MAX_SATS)) {
    toast('maxSats');
    return;
  }
  const base = state.sats[state.sel];
  state.sats.push(normalizeSat({ ...base, node: base.node + 90 }, card ? card.locks : null).sat);
  state.sel = state.sats.length - 1;
  commit('user');
}

function removeSat(index) {
  if (state.sats.length <= 1) {
    toast('minSats');
    return;
  }
  const i = indexOrSel(index);
  state.sats.splice(i, 1);
  if (state.sel > i) state.sel -= 1;
  state.sel = Math.min(state.sel, state.sats.length - 1);
  commit('user');
}

function setSeason(value) {
  const card = activeCard();
  const season = Math.round(Math.min(RANGES.season.max, Math.max(RANGES.season.min, Number(value))));
  if (!Number.isFinite(season)) return;
  if (card && card.locks.season !== undefined && season !== card.locks.season) {
    toast('locked', { param: LOCK_LABELS.season, key: 'season' });
    emitState('user');
    return;
  }
  const same = season === state.season;
  state.season = season;
  commit('user', { restart: !same });
}

function pickCard(id) {
  const card = id === 'free' ? null : getCard(id);
  if (id !== 'free' && !card) return;
  state.card = card ? card.id : 'free';
  state.peeked = false;
  if (card) {
    state.sats = applyLocks(card, card.start.sats).map((s) => normalizeSat(s).sat);
    state.sel = 0;
    if (card.locks.season !== undefined) state.season = card.locks.season;
    if (!reducedMotion) state.playing = true;
  }
  emit('cards', cardsPayload());
  commit('card', { immediate: true });
}

function peekPar() {
  const card = activeCard();
  if (!card) return;
  state.sats = applyLocks(card, card.par.sats).map((s) => normalizeSat(s).sat);
  state.sel = 0;
  state.peeked = true;
  if (!reducedMotion) state.playing = true;
  toast('peeked');
  commit('card', { immediate: true });
}

function resetRun() {
  if (failed) {
    recover();
    return;
  }
  toast('runReset');
  if (!reducedMotion) state.playing = true;
  commit('reset', { immediate: true, restart: true });
}

// "Frog it" on the fatal panel: start over from the default scene.
function recover() {
  failed = false;
  state = { ...parseHash('', store.prefs).state, playing: !reducedMotion };
  emit('status', { kind: 'loading' });
  emit('cards', cardsPayload());
  emitState('reset');
  restartRun();
  emit('status', { kind: 'ready' });
  resolveReady(true);
}

function tuneSso(index) {
  const i = indexOrSel(index);
  const inc = ssoInclination(state.sats[i].alt, state.sats[i].ecc);
  if (inc === null) {
    toast('ssoNone');
    return;
  }
  patchSat(i, { inc: round2(inc) }, true);
  toast('tuned', { inc: round2(inc) });
}

// Moves the height to a repeat height; tick lists favour "tight" repeats whose tracks sit closer than the swath.
function snapRepeat(index, dir) {
  const i = indexOrSel(index);
  const sat = state.sats[i];
  const ticks = findRepeats(sat);
  const pool = dir < 0 ? ticks.filter((t) => t.alt < sat.alt - 0.005) : dir > 0 ? ticks.filter((t) => t.alt > sat.alt + 0.005) : ticks;
  const tight = pool.filter((t) => t.tight);
  const from = tight.length > 0 ? tight : pool;
  if (from.length === 0) {
    toast('noRepeat');
    return;
  }
  let pick = from[0];
  if (dir < 0) pick = from[from.length - 1];
  else if (dir === 0) pick = from.reduce((best, t) => (Math.abs(t.alt - sat.alt) < Math.abs(best.alt - sat.alt) ? t : best));
  patchSat(i, { alt: round2(pick.alt) }, true);
  toast('snapped', { alt: round1(pick.alt), k: pick.k, m: pick.m, spacing: round1(pick.spacingKm) });
}

// Draw order per needle is fixed (alt, tilt, shape roll, stretch, node, argp, swath) so a seed always repeats.
function randomize() {
  pressCount += 1;
  const rng = mulberry32(state.seed + pressCount);
  const card = activeCard();
  state.sats = state.sats.map(() => {
    const alt = 300 + rng() * 1100;
    const inc = 20 + rng() * 100;
    const roll = rng();
    const stretch = rng() * 0.3;
    const node = -180 + rng() * 360;
    const argp = rng() * 360;
    const swath = 110 + rng() * 390;
    const raw = { alt: snapTo(alt, 1), inc: snapTo(inc, 0.05), ecc: roll < 0.7 ? 0 : snapTo(stretch, 0.005), node: snapTo(node, 0.5), argp: snapTo(argp, 1), swath: snapTo(swath, 5) };
    return normalizeSat(raw, card ? card.locks : null).sat;
  });
  toast('randomized');
  commit('random', { immediate: true });
}

function share() {
  clearTimeout(hashTimer);
  writeHash();
  const url = location.href.split('#')[0] + serializeHash(state);
  const clip = navigator.clipboard;
  if (!clip || typeof clip.writeText !== 'function') {
    toast('shareManual', { url });
    return;
  }
  let pending;
  try {
    pending = clip.writeText(url);
  } catch {
    pending = Promise.reject(new Error('clipboard refused'));
  }
  pending.then(guarded(() => toast('shareCopied', { url })), guarded(() => toast('shareManual', { url })));
}

function togglePlay() {
  if (finished) {
    state.playing = true;
    commit('reset', { immediate: true });
    return;
  }
  stepTarget = null;
  setPlaying(!state.playing);
}

function stepDays(days) {
  const n = Number.isFinite(days) && days > 0 ? Math.min(days, 30) : 1;
  if (finished) return;
  stepTarget = Math.min(horizon, sim.day + n);
  catchUpTo = 0;
  state.playing = false;
  emitState('user');
  emitTick(true);
  invalidate();
}

function adoptHash() {
  const hash = location.hash;
  if (hash === lastHash || !/^#?[a-z]+=/i.test(hash)) return;
  const parsed = parseHash(hash, store.prefs);
  state = { ...parsed.state, playing: state.playing };
  testMode = parsed.test;
  lastHash = hash;
  emit('cards', cardsPayload());
  commit('hash', { immediate: true });
  if (parsed.repaired) toast('badLink');
}

function runSelfTestOnce() {
  if (selfTestStarted) return;
  selfTestStarted = true;
  import('./selftest.js').then(
    guarded(async (mod) => {
      try {
        emit('selftest', await mod.runSelfTest());
      } catch (err) {
        emit('selftest', { passed: 0, total: 1, items: [{ name: `The checks could not run: ${err && err.message ? err.message : 'unknown error'}`, ok: false, got: null, want: null, tol: null }] });
      }
    }),
    () => {
      // The checks are optional (cut-list item 3): without the module the About panel keeps its static line.
    },
  );
}

async function externalAdvance(days) {
  const want = Number(days);
  if (!sim || failed || !(want > 0)) return sim ? sim.metrics(state.sel) : null;
  const target = Math.min(horizon, sim.day + Math.min(want, 400));
  try {
    while (sim && !failed && sim.day < target - DAY_EPS) {
      if (sim.advance(target - sim.day, 12) <= 0) break;
      dirty = true;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (failed) return null;
    afterAdvance();
    emitTick(true);
    invalidate();
    return sim.metrics(state.sel);
  } catch (err) {
    fail(err);
    return null;
  }
}

window.__sed = Object.freeze({
  version: 1,
  state: () => (state ? copyState() : null),
  metrics: () => (sim ? sim.metrics(state.sel) : null),
  advance: externalAdvance,
  ready: readyPromise,
});

const HANDLERS = {
  'set-sat': (d) => patchSat(d.index, d.patch, false),
  'add-sat': addSat,
  'remove-sat': (d) => removeSat(d.index),
  'select-sat': (d) => selectSat(d.index),
  'set-view': (d) => (d.view === 'flat' || d.view === 'polar') && setPref('view', d.view),
  'set-speed': (d) => SPEEDS.includes(Number(d.speed)) && setPref('speed', Number(d.speed)),
  'set-season': (d) => setSeason(d.season),
  'set-terminator': (d) => setPref('terminator', !!d.on),
  'toggle-play': togglePlay,
  step: (d) => stepDays(Number(d.days)),
  reset: resetRun,
  'pick-card': (d) => pickCard(d.id),
  'peek-par': peekPar,
  'tune-sso': (d) => tuneSso(d.index),
  'snap-repeat': (d) => snapRepeat(d.index, d.dir < 0 ? -1 : d.dir > 0 ? 1 : 0),
  randomize,
  share,
  'about-open': runSelfTestOnce,
};

function wire() {
  for (const name of Object.keys(HANDLERS)) {
    document.addEventListener(
      `app:${name}`,
      guarded((event) => {
        // Only "Frog it" and the About panel work before the first frame or after a fault.
        if (failed ? name !== 'reset' : !ready && name !== 'about-open') return;
        HANDLERS[name](event.detail && typeof event.detail === 'object' ? event.detail : {});
      }),
    );
  }
  window.addEventListener('hashchange', guarded(() => ready && !failed && adoptHash()));
  window.addEventListener('pagehide', guarded(() => hashTimer && (clearTimeout(hashTimer), writeHash())));
  document.addEventListener('visibilitychange', guarded(() => {
    lastTs = 0;
    if (!document.hidden && ready) invalidate();
  }));
  if (typeof matchMedia === 'function') {
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const scheme = matchMedia('(prefers-color-scheme: dark)');
    if (typeof motion.addEventListener === 'function') {
      motion.addEventListener('change', guarded((e) => {
        reducedMotion = e.matches;
        if (reducedMotion && ready) setPlaying(false);
      }));
      scheme.addEventListener('change', guarded(() => ready && invalidate()));
    }
  }
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

async function preroll(target) {
  while (sim.day < target - DAY_EPS) {
    if (sim.advance(target - sim.day, PREROLL_SLICE_MS) <= 0) break;
    await pause();
  }
}

function afterTwoFrames(fn) {
  let left = 2;
  const step = () => (--left > 0 ? requestAnimationFrame(step) : fn());
  requestAnimationFrame(step);
  setTimeout(fn, 1500);
}

async function init() {
  store = loadStore();
  const parsed = parseHash(location.hash, store.prefs);
  state = parsed.state;
  testMode = parsed.test;
  lastHash = location.hash;
  reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  state.playing = !reducedMotion;
  wire();
  try {
    ui = createUI({ seed: state.seed, reducedMotion });
  } catch (err) {
    fail(err);
    return;
  }
  emit('status', { kind: 'loading' });
  emit('cards', cardsPayload());
  emitState('boot');
  const card = activeCard();
  horizon = card ? card.days : FREE_DAYS;
  sim = createSim(state.sats, state.season);
  previewUntil = nowMs() + PREVIEW_MS;
  await pause();
  await preroll(Math.min(PREROLL_DAY, card ? card.days / 2 : PREROLL_DAY));
  if (failed) return;
  drawFrame(nowMs());
  ready = true;
  emitTick(true);
  emit('status', { kind: 'ready' });
  resolveReady(true);
  afterTwoFrames(() => resolveThumb(true));
  if (!store.ok) {
    storageWarned = true;
    toast('storageOff');
  }
  if (parsed.repaired) {
    toast('badLink');
    scheduleHash();
  }
  if (testMode) runSelfTestOnce();
  kick();
}

init().catch(fail);
