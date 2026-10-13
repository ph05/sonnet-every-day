// State shape, URL-hash grammar and raw field parsing (SPEC 4.2, 4.5 and 4.11). Pure and synchronous.
// Everything that comes from a text box or from the address bar is validated here, once.

import { PLACES } from './data/places.js';

const FIELD_LIMITS = {
  day: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  year: { min: 1500, max: 2099 },
};
const HASH_KEYS = ['p', 'd', 'm', 'y', 'w', 'cd', 'cm', 'cy', 'bd', 'bm', 'by'];
const WRITTEN_VALUES = ['auto', 'julian', 'gregorian'];
const HASH_MAX_LENGTH = 160;
const HASH_VALUE = /^[a-z0-9-]{1,16}$/;
const DIGITS = { 2: /^\d{1,2}$/, 4: /^\d{1,4}$/ };

export const SAMPLE = Object.freeze({
  placeId: 'rome',
  year: 1582,
  month: 10,
  day: 13,
  writtenIn: 'auto',
  custom: Object.freeze({ year: 1752, month: 9, day: 2 }),
  between: null,
});

const copyYMD = (ymd) => ({ year: ymd.year, month: ymd.month, day: ymd.day });
const isPlaceId = (id) => PLACES.some((place) => place.id === id);

// ASCII digits only (a JavaScript \d never matches Arabic-Indic or full-width digits).
function digitsToInt(text, maxLength) {
  return DIGITS[maxLength].test(text) ? Number.parseInt(text, 10) : null;
}

function withinLimits(value, kind) {
  const { min, max } = FIELD_LIMITS[kind];
  return value !== null && value >= min && value <= max;
}

function clamp(value, kind) {
  const { min, max } = FIELD_LIMITS[kind];
  return Math.min(max, Math.max(min, value));
}

function sameYMD(a, b) {
  if (a == null || b == null) return a == null && b == null;
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

export function sameState(a, b) {
  if (!a || !b) return a === b;
  if (a.placeId !== b.placeId || a.year !== b.year || a.month !== b.month || a.day !== b.day) return false;
  if (a.writtenIn !== b.writtenIn) return false;
  if (a.placeId === 'custom' && !sameYMD(a.custom, b.custom)) return false;
  return sameYMD(a.between, b.between);
}

export function formatHash(state) {
  const parts = [`p=${state.placeId}`, `d=${state.day}`, `m=${state.month}`, `y=${state.year}`];
  if (state.writtenIn && state.writtenIn !== 'auto') parts.push(`w=${state.writtenIn}`);
  if (state.placeId === 'custom' && state.custom) {
    parts.push(`cd=${state.custom.day}`, `cm=${state.custom.month}`, `cy=${state.custom.year}`);
  }
  if (state.between) parts.push(`bd=${state.between.day}`, `bm=${state.between.month}`, `by=${state.between.year}`);
  return `#${parts.join('&')}`;
}

// Reads three optional hash keys that belong together. Returns undefined when none is present,
// null when only some are (a violation) and the clamped date when all three are.
function readHashDate(values, keys) {
  const present = keys.filter((key) => values.has(key));
  if (present.length === 0) return undefined;
  if (present.length !== keys.length) return null;
  const [day, month, year] = keys.map((key) => values.get(key));
  if (![day, month, year].every((text) => DIGITS[4].test(text))) return null;
  return {
    year: clamp(Number.parseInt(year, 10), 'year'),
    month: clamp(Number.parseInt(month, 10), 'month'),
    day: clamp(Number.parseInt(day, 10), 'day'),
  };
}

export function parseHash(hash) {
  if (typeof hash !== 'string' || hash.length > HASH_MAX_LENGTH) return null;
  const body = hash.charAt(0) === '#' ? hash.slice(1) : hash;
  if (body === '') return null;

  const values = new Map();
  for (const part of body.split('&')) {
    const cut = part.indexOf('=');
    if (cut < 1) return null;
    const key = part.slice(0, cut);
    const value = part.slice(cut + 1);
    if (!HASH_KEYS.includes(key) || values.has(key) || !HASH_VALUE.test(value)) return null;
    values.set(key, value);
  }

  const placeId = values.get('p');
  if (placeId === undefined || !isPlaceId(placeId)) return null;
  const main = readHashDate(values, ['d', 'm', 'y']);
  if (!main) return null;
  const writtenIn = values.has('w') ? values.get('w') : 'auto';
  if (!WRITTEN_VALUES.includes(writtenIn)) return null;

  const custom = readHashDate(values, ['cd', 'cm', 'cy']);
  if (custom === null || (custom === undefined && placeId === 'custom')) return null;
  const between = readHashDate(values, ['bd', 'bm', 'by']);
  if (between === null) return null;

  return {
    placeId,
    year: main.year,
    month: main.month,
    day: main.day,
    writtenIn,
    custom: custom || copyYMD(SAMPLE.custom),
    between: between || null,
  };
}

function readDate(day, month, year) {
  const date = { day: digitsToInt(day, 2), month: digitsToInt(month, 2), year: digitsToInt(year, 4) };
  const valid = withinLimits(date.day, 'day') && withinLimits(date.month, 'month') && withinLimits(date.year, 'year');
  return valid ? { year: date.year, month: date.month, day: date.day } : null;
}

export function readFields(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const text = (name) => (source[name] === null || source[name] === undefined ? '' : String(source[name]).trim());

  const bFilled = [text('bday'), text('bmonth'), text('byear')];
  let between = null;
  let betweenError = null;
  if (bFilled.some((part) => part !== '')) {
    between = readDate(bFilled[0], bFilled[1], bFilled[2]);
    if (between === null) betweenError = 'between-format';
  }
  const failure = (code, field) => ({ state: null, error: { code, field }, betweenError });

  const day = digitsToInt(text('day'), 2);
  if (!withinLimits(day, 'day')) return failure('day-format', 'day');
  const month = digitsToInt(text('month'), 2);
  if (!withinLimits(month, 'month')) return failure('month-format', 'month');
  const year = digitsToInt(text('year'), 4);
  if (year === null) return failure('year-format', 'year');
  if (!withinLimits(year, 'year')) return failure('year-range', 'year');
  const placeId = text('placeId');
  if (!isPlaceId(placeId)) return failure('place-format', 'place');

  const custom = readDate(text('cday'), text('cmonth'), text('cyear'));
  if (placeId === 'custom' && custom === null) return failure('custom-format', 'custom');

  const writtenIn = WRITTEN_VALUES.includes(text('writtenIn')) ? text('writtenIn') : 'auto';
  return {
    state: { placeId, year, month, day, writtenIn, custom: custom || copyYMD(SAMPLE.custom), between },
    error: null,
    betweenError,
  };
}
