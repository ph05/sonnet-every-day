// State defaults, the URL-hash grammar and the per-viewer store. Pure apart from localStorage (always in try/catch).
import { RANGES, DEFAULT_SATS, normalizeSat } from './orbit.js';
import { getCard, applyLocks } from './cards.js';

export const STORE_KEY = 'sed.orbital-knitwear.v1';

const SAT_KEYS = ['alt', 'inc', 'ecc', 'node', 'argp', 'swath'];
const DECIMALS = { alt: 2, inc: 2, ecc: 3, node: 1, argp: 1, swath: 0 };
const SPEEDS = [0.25, 1, 4, 16];
const VIEWS = ['flat', 'polar'];
const BADGES = ['swatch', 'sweater', 'heirloom'];
const MAX_SATS = 3;
const MAX_HASH_CHARS = 2048;
const DEFAULT_SEED = 1011;
const NUMBER = /^\s*[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?\s*$/;

// Small seeded generator: the same seed always yields the same sequence.
export function mulberry32(seed) {
  let a = (Number.isFinite(seed) ? Math.floor(seed) : 0) >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const defaultSat = (index) => ({ ...DEFAULT_SATS[Math.min(index, DEFAULT_SATS.length - 1)] });

export function defaultState() {
  return {
    v: 1,
    sats: DEFAULT_SATS.map((_, i) => defaultSat(i)),
    sel: 0,
    card: 'free',
    view: 'flat',
    speed: 1,
    season: 0,
    terminator: true,
    seed: DEFAULT_SEED,
    playing: true,
    peeked: false,
  };
}

const parseNumber = (text) => (typeof text === 'string' && NUMBER.test(text) ? Number(text) : Number.NaN);

function splitHash(hash) {
  const fields = new Map();
  let malformed = false;
  for (const part of hash.replace(/^#/, '').split('&')) {
    const cut = part.indexOf('=');
    if (cut <= 0) continue;
    try {
      fields.set(part.slice(0, cut), decodeURIComponent(part.slice(cut + 1)));
    } catch {
      malformed = true;
    }
  }
  return { fields, malformed };
}

// Never throws. `repaired` is true when any part of the link had to be replaced, clamped or dropped.
// `prefs` (from loadStore) fill in speed, view and night shading when the link does not carry them.
export function parseHash(hash, prefs) {
  const state = defaultState();
  state.playing = false;
  if (prefs && typeof prefs === 'object') {
    if (SPEEDS.includes(prefs.speed)) state.speed = prefs.speed;
    if (VIEWS.includes(prefs.view)) state.view = prefs.view;
    if (typeof prefs.terminator === 'boolean') state.terminator = prefs.terminator;
  }
  const tooLong = typeof hash === 'string' && hash.length > MAX_HASH_CHARS;
  const split = typeof hash === 'string' && !tooLong ? splitHash(hash) : { fields: new Map(), malformed: false };
  const fields = split.fields;
  let repaired = tooLong || split.malformed;

  if (fields.has('v') && fields.get('v') !== '1') repaired = true;
  let sats = [];
  const rawSats = fields.get('s');
  if (rawSats) {
    const parts = rawSats.split(';').filter((p) => p !== '');
    if (parts.length > MAX_SATS) {
      repaired = true;
      parts.length = MAX_SATS;
    }
    parts.forEach((part, index) => {
      const cells = part.split(',');
      const base = defaultSat(index);
      const raw = {};
      SAT_KEYS.forEach((key, at) => {
        const v = parseNumber(cells[at]);
        if (Number.isFinite(v)) raw[key] = v;
        else {
          raw[key] = base[key];
          repaired = true;
        }
      });
      if (cells.length > SAT_KEYS.length) repaired = true;
      const { sat } = normalizeSat(raw);
      if (SAT_KEYS.some((key) => sat[key] !== raw[key])) repaired = true;
      sats.push(sat);
    });
  }

  let card = null;
  if (fields.has('c') && fields.get('c') !== 'free') {
    card = getCard(fields.get('c'));
    if (!card) repaired = true;
  }
  state.card = card ? card.id : 'free';

  const view = fields.get('w');
  if (view !== undefined) {
    if (VIEWS.includes(view)) state.view = view;
    else repaired = true;
  }
  const speed = fields.get('sp');
  if (speed !== undefined) {
    const v = parseNumber(speed);
    if (SPEEDS.includes(v)) state.speed = v;
    else repaired = true;
  }
  const season = fields.get('se');
  if (season !== undefined) {
    const v = parseNumber(season);
    if (Number.isFinite(v)) {
      state.season = Math.round(Math.min(RANGES.season.max, Math.max(RANGES.season.min, v)));
      if (state.season !== v) repaired = true;
    } else repaired = true;
  }
  const night = fields.get('t');
  if (night !== undefined) {
    if (night === '0' || night === '1') state.terminator = night === '1';
    else repaired = true;
  }
  const seed = fields.get('seed');
  if (seed !== undefined) {
    const v = parseNumber(seed);
    if (Number.isFinite(v)) {
      state.seed = Math.floor(Math.min(999999, Math.max(0, v)));
      if (state.seed !== v) repaired = true;
    } else repaired = true;
  }

  if (card) {
    if (sats.length === 0) sats = card.start.sats.map((s) => ({ ...s }));
    if (sats.length > card.maxSats) {
      sats.length = card.maxSats;
      repaired = true;
    }
    sats = applyLocks(card, sats);
    if (card.locks.season !== undefined) state.season = card.locks.season;
  } else if (sats.length === 0) {
    sats = state.sats;
  }
  state.sats = sats;

  const sel = fields.get('i');
  if (sel !== undefined) {
    const v = parseNumber(sel);
    if (Number.isFinite(v)) {
      state.sel = Math.min(sats.length - 1, Math.max(0, Math.floor(v)));
      if (state.sel !== v) repaired = true;
    } else repaired = true;
  }
  return { state, repaired, test: fields.get('test') === '1' };
}

function fixed(value, decimals) {
  const rounded = Number(Number(value).toFixed(decimals));
  return (rounded === 0 ? 0 : rounded).toFixed(decimals);
}

export function serializeHash(state) {
  const src = state && typeof state === 'object' ? state : defaultState();
  const sats = (Array.isArray(src.sats) && src.sats.length > 0 ? src.sats : defaultState().sats).slice(0, MAX_SATS);
  const encoded = sats.map((raw) => {
    const sat = normalizeSat(raw).sat;
    return SAT_KEYS.map((key) => fixed(sat[key], DECIMALS[key])).join(',');
  });
  const sel = Math.min(encoded.length - 1, Math.max(0, Math.floor(Number(src.sel) || 0)));
  const card = getCard(src.card) ? src.card : 'free';
  const view = VIEWS.includes(src.view) ? src.view : 'flat';
  const speed = SPEEDS.includes(src.speed) ? src.speed : 1;
  const season = Math.round(Math.min(RANGES.season.max, Math.max(RANGES.season.min, Number(src.season) || 0)));
  const seed = Math.floor(Math.min(999999, Math.max(0, Number.isFinite(src.seed) ? src.seed : DEFAULT_SEED)));
  return `#v=1&s=${encoded.join(';')}&i=${sel}&c=${card}&w=${view}&sp=${speed}&se=${season}&t=${src.terminator === false ? 0 : 1}&seed=${seed}`;
}

function emptyStore() {
  return { best: {}, prefs: { speed: 1, view: 'flat', terminator: true }, ok: true };
}

// Reads the saved badges and preferences; any failure or bad JSON yields defaults with ok:false.
export function loadStore() {
  const store = emptyStore();
  let raw;
  try {
    raw = globalThis.localStorage.getItem(STORE_KEY);
  } catch {
    store.ok = false;
    return store;
  }
  if (raw === null || raw === undefined) return store;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    store.ok = false;
    return store;
  }
  if (!data || typeof data !== 'object' || data.v !== 1) {
    store.ok = false;
    return store;
  }
  if (data.best && typeof data.best === 'object') {
    for (const id of Object.keys(data.best)) {
      const entry = data.best[id];
      if (getCard(id) && entry && Number.isFinite(entry.score) && BADGES.includes(entry.badge)) {
        store.best[id] = { score: Math.min(100, Math.max(0, entry.score)), badge: entry.badge };
      }
    }
  }
  const prefs = data.prefs;
  if (prefs && typeof prefs === 'object') {
    if (SPEEDS.includes(prefs.speed)) store.prefs.speed = prefs.speed;
    if (VIEWS.includes(prefs.view)) store.prefs.view = prefs.view;
    if (typeof prefs.terminator === 'boolean') store.prefs.terminator = prefs.terminator;
  }
  return store;
}

export function saveStore(store) {
  try {
    const best = store && store.best && typeof store.best === 'object' ? store.best : {};
    const prefs = store && store.prefs && typeof store.prefs === 'object' ? store.prefs : emptyStore().prefs;
    globalThis.localStorage.setItem(STORE_KEY, JSON.stringify({ v: 1, best, prefs }));
    return true;
  } catch {
    return false;
  }
}
