// Known-answer checks, run by "Check this tool against known answers" and by QA through
// window.__sedSelfTest. Every case computes its output with the page's own functions and compares it with
// an expected value copied from the table in SPEC.md section 14 (the source is in the case name).
// Expected values are never edited to make a case pass. Cases 1 to 24 are the table rows, 25 to 29 the
// extra cases of the spec, and 30 to 33 pin input validation, the wording of the messages, the other
// switches' month grids and the place table.

import * as live from './engine.js';
import { createEngine } from './engine.js';
import { SAMPLE, parseHash, formatHash, readFields } from './state.js';
import { buildViewModel, placeById, placeTableRows } from './report.js';
import { PLACES } from './data/places.js';

const ymd = (year, month, day) => ({ year, month, day });
const ymdText = (value) => (value ? `${value.year}-${value.month}-${value.day}` : 'none');
const CALENDARS = ['julian', 'gregorian'];

const REQUIRED_IDS = [
  'app', 'form', 'f-day', 'f-month', 'f-year', 'year-rule', 'f-place', 'custom-box', 'c-day', 'c-month',
  'c-year', 'c-line', 'f-famous', 'btn-more', 'more-panel', 'f-written', 'b-day', 'b-month', 'b-year',
  'b-line', 'btn-link', 'btn-selftest', 'selftest-out', 'result', 'result-badge', 'result-sample',
  'btn-copy', 'btn-steps', 'copy-status', 'result-headline', 'result-detail', 'result-rows', 'year-box',
  'year-box-title', 'year-box-rows', 'grid', 'grid-title', 'grid-sub', 'grid-body', 'grid-gap',
  'result-caption', 'limits-note', 'steps-panel', 'steps-list', 'live', 'place-table', 'explainer',
  'explainer-title', 'limits',
];

function show(value) {
  const text = value === undefined ? 'undefined' : JSON.stringify(value);
  return text.length > 90 ? `${text.slice(0, 87)}...` : text;
}

// The first place where two plain values differ, or null when they are equal.
function firstDifference(got, want, path) {
  if (Object.is(got, want)) return null;
  const isObject = (value) => value !== null && typeof value === 'object';
  if (!isObject(got) || !isObject(want) || Array.isArray(got) !== Array.isArray(want)) {
    return `${path || 'value'}: got ${show(got)}, want ${show(want)}`;
  }
  for (const key of new Set([...Object.keys(got), ...Object.keys(want)])) {
    const inner = firstDifference(got[key], want[key], path ? `${path}.${key}` : key);
    if (inner) return inner;
  }
  return null;
}

// pairs: [label, got, want]. The case passes when every pair agrees.
function compare(pairs) {
  const misses = [];
  for (const [label, got, want] of pairs) {
    const difference = firstDifference(got, want, '');
    if (difference) misses.push(`${label} ${difference}`);
  }
  return misses.length
    ? { ok: false, detail: misses.join('; ') }
    : { ok: true, detail: `${pairs.length} comparisons agree` };
}

const reading = (result, index) => (result.readings ? result.readings[index || 0] : undefined);
const weekdayOfReading = (result) => (reading(result) ? reading(result).weekday : undefined);

function interpretAt(E, placeId, year, month, day, writtenIn) {
  return E.interpret({ ymd: ymd(year, month, day), place: placeById(placeId), writtenIn: writtenIn || 'auto' });
}

// Engine-level checks take the engine to test, so the mutation guard can run them on a broken one.
function row7(E) {
  const at = (month, day) => interpretAt(E, 'denmark-norway', 1700, month, day);
  const feb18 = at(2, 18);
  const feb28 = at(2, 28);
  const feb29 = at(2, 29);
  const mar1 = at(3, 1);
  return compare([
    ['18 Feb calendar', feb18.calendar, 'julian'],
    ['18 Feb weekday (Sunday)', weekdayOfReading(feb18), 0],
    ['1 Mar calendar', mar1.calendar, 'gregorian'],
    ['1 Mar weekday (Monday)', weekdayOfReading(mar1), 1],
    ['1 Mar day number minus 18 Feb', (reading(mar1) || {}).jdn - (reading(feb18) || {}).jdn, 1],
    ['28 Feb kind', feb28.kind, 'skipped'],
    ['28 Feb skippedCount', feb28.skippedCount, 11],
    ['28 Feb skippedTo', ymdText(feb28.skippedTo), '1700-2-29'],
    ['29 Feb kind', feb29.kind, 'skipped'],
    ['29 Feb as a Gregorian date (1700 was not a leap year)', feb29.asGregorian, null],
    ['29 Feb as a Julian date, on today\'s calendar', ymdText((feb29.asJulian || {}).gregorian), '1700-3-11'],
  ]);
}

function row14(E) {
  return compare([
    ['Gregorian 1600, 2000, 1700, 1800, 1900', [1600, 2000, 1700, 1800, 1900].map((y) => E.isLeap(y, 'gregorian')),
      [true, true, false, false, false]],
    ['Julian 1700, 1900, 1582', [1700, 1900, 1582].map((y) => E.isLeap(y, 'julian')), [true, true, false]],
  ]);
}

function countYears(E, cal, from, to) {
  let leapYears = 0;
  let days = 0;
  for (let year = from; year <= to; year += 1) {
    if (E.isLeap(year, cal)) leapYears += 1;
    for (let month = 1; month <= 12; month += 1) days += E.daysInMonth(year, month, cal);
  }
  return { leapYears, days };
}

function row15(E) {
  const { leapYears, days } = countYears(E, 'gregorian', 1601, 2000);
  const span = E.toDayNumber(ymd(2001, 1, 1), 'gregorian') - E.toDayNumber(ymd(1601, 1, 1), 'gregorian');
  return compare([
    ['leap years 1601 to 2000', leapYears, 97],
    ['days summed from the month lengths', days, 146097],
    ['days from the day numbers', span, 146097],
    ['average year', (days / 400).toFixed(4), '365.2425'],
  ]);
}

function row23(E) {
  const result = interpretAt(E, 'france', 1900, 2, 29);
  const params = result.params || {};
  return compare([
    ['ok', result.ok, false],
    ['code', result.code, 'no-such-day'],
    ['maxDays', params.maxDays, 28],
    ['calendar', params.calendar, 'gregorian'],
    ['leapNote', params.leapNote, true],
  ]);
}

function differentLabels(a, b) {
  return a.year !== b.year || a.month !== b.month || a.day !== b.day;
}

function roundTripEveryDay(E) {
  const first = E.toDayNumber(ymd(1500, 1, 1), 'gregorian');
  const last = E.toDayNumber(ymd(2099, 12, 31), 'gregorian');
  const walkers = {};
  for (const cal of CALENDARS) walkers[cal] = E.fromDayNumber(first, cal);
  let checked = 0;
  for (let jdn = first; jdn <= last; jdn += 1) {
    for (const cal of CALENDARS) {
      const label = E.fromDayNumber(jdn, cal);
      const walked = walkers[cal];
      if (E.toDayNumber(label, cal) !== jdn || !E.isValidDate(label, cal)) {
        return { ok: false, detail: `day ${jdn} does not round trip on the ${cal} calendar` };
      }
      if (differentLabels(label, walked)) {
        return {
          ok: false,
          detail: `day ${jdn} on the ${cal} calendar: formula gives ${ymdText(label)}, counting gives ${ymdText(walked)}`,
        };
      }
      // Counting forward one name at a time uses only month lengths, a path independent of the formulas.
      let { year, month, day } = walked;
      day += 1;
      if (day > E.daysInMonth(year, month, cal)) {
        day = 1;
        month += 1;
        if (month > 12) {
          month = 1;
          year += 1;
        }
      }
      walkers[cal] = { year, month, day };
    }
    const g = E.fromDayNumber(jdn, 'gregorian');
    const utcDays = Math.round(Date.UTC(g.year, g.month - 1, g.day) / 86400000) + 2440588;
    if (utcDays !== jdn) {
      return {
        ok: false,
        detail: `${ymdText(g)} is day ${jdn} here but day ${utcDays} by the browser's own arithmetic`,
      };
    }
    checked += 1;
  }
  return { ok: true, detail: `${checked} days, both calendars, labels agree with counting and with Date.UTC` };
}

function mutationGuard() {
  const mutant = createEngine({ centuryRule: false });
  const checks = [['row 7', row7], ['row 14', row14], ['row 15', row15], ['row 23', row23]];
  const healthy = checks.filter(([, check]) => check(live).ok).length;
  const caught = checks.filter(([, check]) => !attempt(() => check(mutant)).ok).map(([label]) => label);
  return {
    ok: healthy === checks.length && caught.length >= 3,
    detail: `${healthy} of ${checks.length} pass on the real engine; `
      + `the every-fourth-year leap rule fails ${caught.join(', ') || 'none'}`,
  };
}

function attempt(run) {
  try {
    return run();
  } catch (failure) {
    return { ok: false, detail: `threw ${failure && failure.message}` };
  }
}

const GOLDEN_SAMPLE = {
  tone: 'skip',
  badge: 'Never existed there',
  sample: true,
  openMore: false,
  headline: '13 October 1582 never happened in Rome.',
  detail: ['The calendar jumped from Thursday 4 October 1582 to Friday 15 October 1582, skipping 10 days.'],
  rows: [
    {
      label: "If you meant today's calendar",
      value: 'Counting back, that day would have been a Wednesday, called 3 October 1582 on the old calendar.',
      cal: 'gregorian',
    },
    {
      label: 'If you meant the old calendar',
      value: "It did exist, as a Saturday, called 23 October 1582 on today's calendar.",
      cal: 'julian',
    },
  ],
  yearBox: null,
  yearRule: 'The year is counted from 1 January.',
  showCustom: false,
  customLine: '',
  betweenLine: '',
  betweenTone: 'none',
  caption: 'Sample, built on 13 October 2026: one of the ten days Rome never had in 1582.',
  announce: '13 October 1582 never happened in Rome. '
    + 'The calendar jumped from Thursday 4 October 1582 to Friday 15 October 1582, skipping 10 days.',
  grid: {
    title: 'October 1582',
    subtitle: "Old calendar up to the 4th, today's calendar from the 15th",
    label: 'October 1582. Days 1 to 4, then 15 to 31. The days 5 to 14 October never happened in Rome.',
    weekdays: ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'],
    weekdayNames: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    lead: 1,
    days: [1, 2, 3, 4, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31].map((day, index) => ({
      day,
      weekday: [1, 2, 3, 4, 5, 6, 0, 1, 2, 3, 4, 5, 6, 0, 1, 2, 3, 4, 5, 6, 0][index],
    })),
    focus: null,
    gapAt: 4,
    gap: { days: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14], text: '10 days skipped here: 5 to 14 October', focus: 13 },
  },
  steps: [
    'You typed 13 October 1582 for Rome.',
    "Rome used the old calendar up to Thursday 4 October 1582 and today's calendar from Friday 15 October 1582.",
    'Day numbers (a plain count of days): 4 October 1582 is day 2299160 and 15 October 1582 is day 2299161. '
      + 'The count has no gap, so no real day was lost; the 10 names from 5 to 14 October were skipped.',
    'Your date falls inside that stretch, so no day in Rome carried the name 13 October 1582.',
    "Counting back on today's calendar: 13 October 1582 is day 2299159 "
      + '(a = 0, y = 6382, m = 7; 13 + 214 + 2329430 + 1595 - 63 + 15 - 32045), '
      + 'and (2299159 + 1) mod 7 = 3, a Wednesday. The old calendar called that day 3 October 1582.',
    'Read as an old-calendar date: 13 October 1582 is day 2299169 (13 + 214 + 2329430 + 1595 - 32083), '
      + "and (2299169 + 1) mod 7 = 6, a Saturday. Today's calendar calls that day 23 October 1582.",
  ],
};

const GOLDEN_WASHINGTON = {
  headline: "11 February 1731/32 on the old calendar is the same day as Friday 22 February 1732 on today's calendar.",
  rows: [
    { label: 'Old calendar (Julian)', value: 'Friday 11 February 1731/32', cal: 'julian' },
    { label: "Today's calendar (Gregorian)", value: 'Friday 22 February 1732', cal: 'gregorian' },
  ],
  yearBox: {
    title: 'Which year? England began the year on 25 March until 1751, '
      + 'so a date from 1 January to 24 March can be read two ways.',
    rows: [
      {
        label: 'As written then (the year began on 25 March)',
        value: "11 February 1731/32 is Friday 22 February 1732 on today's calendar.",
      },
      {
        label: 'If your source counted years from 1 January',
        value: "11 February 1731 is Thursday 22 February 1731 on today's calendar.",
      },
    ],
  },
  gridTitle: 'February 1731/32',
  gridSubtitle: 'Old calendar (Julian)',
  gridFocus: 11,
  gridDays: 29,
  dayNumberStep: 'Day number: a = 1, y = 6531, m = 11; 11 + 337 + 2383815 + 1632 - 32083 = 2353712.',
};

function goldenViewModels() {
  const sample = buildViewModel({ state: SAMPLE, error: null, betweenError: null, sample: true, placeId: 'rome' });
  const fields = readFields({
    day: '11', month: '2', year: '1731', placeId: 'england', writtenIn: 'auto',
    cday: '2', cmonth: '9', cyear: '1752', bday: '', bmonth: '', byear: '',
  });
  const washington = buildViewModel({ ...fields, sample: false, placeId: 'england' });
  const grid = washington.grid || {};
  return compare([
    ['sample', { ...sample, copyText: undefined }, { ...GOLDEN_SAMPLE, copyText: undefined }],
    ['sample copy text ends with the disclaimer', sample.copyText.split('\n').pop(),
      'Not genealogical or legal proof. Historical Date Converter, Sonnet Every Day.'],
    ['England 1731 headline', washington.headline, GOLDEN_WASHINGTON.headline],
    ['England 1731 rows', washington.rows, GOLDEN_WASHINGTON.rows],
    ['England 1731 year box', washington.yearBox, GOLDEN_WASHINGTON.yearBox],
    ['England 1731 grid title', grid.title, GOLDEN_WASHINGTON.gridTitle],
    ['England 1731 grid subtitle', grid.subtitle, GOLDEN_WASHINGTON.gridSubtitle],
    ['England 1731 grid focus', grid.focus, GOLDEN_WASHINGTON.gridFocus],
    ['England 1731 grid days', (grid.days || []).length, GOLDEN_WASHINGTON.gridDays],
    ['England 1731 day number step', washington.steps.includes(GOLDEN_WASHINGTON.dayNumberStep), true],
  ]);
}

function hashSafety() {
  const clamped = parseHash('#p=rome&y=3000&m=13&d=0');
  const long = `#p=rome&d=13&m=10&y=1582&w=${'a'.repeat(160)}`;
  const custom = { ...SAMPLE, placeId: 'custom', day: 3, month: 9, year: 1752 };
  return compare([
    ['unknown place', parseHash('#p=zzz&d=13&m=10&y=1582'), null],
    ['letters in a number', parseHash('#p=rome&d=1x&m=10&y=1582'), null],
    ['repeated key', parseHash('#p=rome&d=13&d=14&m=10&y=1582'), null],
    ['unknown key', parseHash('#p=rome&d=13&m=10&y=1582&q=1'), null],
    ['missing year', parseHash('#p=rome&d=13&m=10'), null],
    ['negative number', parseHash('#p=rome&d=-5&m=10&y=1582'), null],
    ['too long', parseHash(long), null],
    ['custom place without its last day', parseHash('#p=custom&d=3&m=9&y=1752'), null],
    ['half a second date', parseHash('#p=rome&d=13&m=10&y=1582&bd=5'), null],
    ['empty hash', parseHash(''), null],
    ['clamped year, month, day', clamped && [clamped.year, clamped.month, clamped.day], [2099, 12, 1]],
    ['sample round trip', parseHash(formatHash(SAMPLE)) && formatHash(parseHash(formatHash(SAMPLE))), '#p=rome&d=13&m=10&y=1582'],
    ['custom round trip', formatHash(parseHash(formatHash(custom))), '#p=custom&d=3&m=9&y=1752&cd=2&cm=9&cy=1752'],
    ['forced calendar and second date', formatHash(parseHash('#p=england&d=1&m=9&y=1752&w=julian&bd=15&bm=9&by=1752')),
      '#p=england&d=1&m=9&y=1752&w=julian&bd=15&bm=9&by=1752'],
  ]);
}

function placeTable() {
  const real = PLACES.filter((place) => place.lastJulian);
  const consecutive = real.map((place) => live.toDayNumber(place.firstGregorian, 'gregorian')
    - live.toDayNumber(place.lastJulian, 'julian'));
  const skipped = real.map((place) => {
    const firstDropped = live.fromDayNumber(live.toDayNumber(place.lastJulian, 'julian') + 1, 'julian');
    return interpretAt(live, place.id, firstDropped.year, firstDropped.month, firstDropped.day).skippedCount;
  });
  return compare([
    ['places in the table', real.map((place) => place.id),
      ['rome', 'spain', 'portugal', 'france', 'england', 'scotland', 'denmark-norway', 'soviet-russia']],
    ['day number step across each switch', consecutive, [1, 1, 1, 1, 1, 1, 1, 1]],
    ['skippedCount of each place', skipped, [10, 10, 10, 10, 11, 11, 11, 13]],
  ]);
}

function domContract() {
  if (typeof document === 'undefined') return { ok: false, detail: 'there is no document to look in' };
  const missing = REQUIRED_IDS.filter((id) => !document.getElementById(id));
  return missing.length
    ? { ok: false, detail: `missing ids: ${missing.join(', ')}` }
    : { ok: true, detail: `all ${REQUIRED_IDS.length} required ids exist` };
}

function rawFields(overrides) {
  return {
    day: '13', month: '10', year: '1582', placeId: 'rome', writtenIn: 'auto',
    cday: '2', cmonth: '9', cyear: '1752', bday: '', bmonth: '', byear: '',
    ...overrides,
  };
}

function viewModelFor(overrides) {
  const fields = readFields(rawFields(overrides));
  return buildViewModel({ ...fields, sample: false, placeId: (overrides && overrides.placeId) || 'rome' });
}

const DAY_MESSAGE = 'Type the day as a whole number from 1 to 31, using only the digits 0 to 9. '
  + 'A date such as 13/10/1582 goes in three boxes: day, month, year.';

function inputValidation() {
  const message = (overrides) => {
    const vm = viewModelFor(overrides);
    return [vm.tone, vm.headline, vm.copyText, vm.steps.length];
  };
  const bad = (headline) => ['error', headline, '', 0];
  return compare([
    ['empty day', message({ day: '' }), bad(DAY_MESSAGE)],
    ['whitespace-only day', message({ day: '   ' }), bad(DAY_MESSAGE)],
    ['huge day', message({ day: '999' }), bad(DAY_MESSAGE)],
    ['day 0', message({ day: '0' }), bad(DAY_MESSAGE)],
    ['negative day', message({ day: '-5' }), bad(DAY_MESSAGE)],
    ['Arabic-Indic digits', message({ day: '١٣' }), bad(DAY_MESSAGE)],
    ['full-width digits', message({ year: '１５８２' }), bad('Type the year as digits, for example 1582.')],
    ['a whole date pasted into Day', message({ day: '13/10/1582' }), bad(DAY_MESSAGE)],
    ['month not on the list', message({ month: '' }), bad('Pick a month from the list.')],
    ['month 13', message({ month: '13' }), bad('Pick a month from the list.')],
    ['empty year', message({ year: '' }), bad('Type the year as digits, for example 1582.')],
    ['huge year', message({ year: '99999' }), bad('Type the year as digits, for example 1582.')],
    ['a date pasted into Year', message({ year: '1582-10-13' }), bad('Type the year as digits, for example 1582.')],
    ['year before 1500', message({ year: '1499' }), bad('This page covers the years 1500 to 2099.')],
    ['year after 2099', message({ year: '2100' }), bad('This page covers the years 1500 to 2099.')],
    ['unknown place', message({ placeId: 'atlantis' }), bad('Pick a place from the list.')],
    ['custom place with a bad box', message({ placeId: 'custom', cday: 'x' }),
      bad('Last day on the old calendar: type a real date with digits only, for example 2 September 1752.')],
    ['second date half filled, main result still shows', viewModelFor({ bday: '5' }).betweenLine,
      'Second date: type a day, a month and a year using digits, or clear the three boxes.'],
    ['second date half filled keeps the tone', viewModelFor({ bday: '5' }).tone, 'skip'],
  ]);
}

function wordingAndModes() {
  const line = (overrides) => viewModelFor(overrides);
  const april = line({ day: '31', month: '4' });
  const leapless = line({ day: '29', month: '2', year: '1900', placeId: 'france' });
  const february30 = line({ day: '30', month: '2', year: '1900', placeId: 'france' });
  const forced = line({ day: '3', month: '9', year: '1752', placeId: 'england', writtenIn: 'julian' });
  const noPlace = line({ day: '29', month: '2', year: '1700', placeId: 'none', writtenIn: 'julian' });
  const unplaced = line({ day: '4', month: '10', year: '1582', placeId: 'none' });
  const custom = line({ day: '3', month: '9', year: '1752', placeId: 'custom' });
  const customBad = line({ day: '3', month: '9', year: '1752', placeId: 'custom', cday: '31', cmonth: '4', cyear: '1752' });
  const between = line({ day: '1', month: '9', year: '1752', placeId: 'england', bday: '15', bmonth: '9', byear: '1752' });
  const earlier = line({ day: '15', month: '9', year: '1752', placeId: 'england', bday: '1', bmonth: '9', byear: '1752' });
  const same = line({ day: '15', month: '9', year: '1752', placeId: 'england', bday: '15', bmonth: '9', byear: '1752' });
  const secondGap = line({ day: '1', month: '9', year: '1752', placeId: 'england', bday: '5', bmonth: '9', byear: '1752' });
  const firstGap = line({ day: '5', month: '9', year: '1752', placeId: 'england', bday: '15', bmonth: '9', byear: '1752' });
  const secondBad = line({ day: '1', month: '9', year: '1752', placeId: 'england', bday: '31', bmonth: '4', byear: '1752' });
  const dual = line({ day: '15', month: '1', year: '1699', placeId: 'england' });
  const scotland = line({ day: '11', month: '2', year: '1598', placeId: 'scotland' });
  const england = (day, month, year) => line({
    day: String(day), month: String(month), year: String(year), placeId: 'england',
  });
  const firstOfYear = england(1, 1, 1731);
  const lastBefore = england(24, 3, 1731);
  const newYear = england(25, 3, 1731);
  const lastWritten = england(11, 2, 1750);
  const firstModern = england(11, 2, 1751);
  const turnOfCentury = england(15, 1, 1700);
  return compare([
    ['31 April', april.headline, 'April 1582 has only 30 days.'],
    ['29 February 1900 in France', leapless.headline,
      'February 1900 has only 28 days on the Gregorian calendar. 1900 was a leap year on the Julian calendar only.'],
    ['30 February 1900 in France', february30.headline, 'February 1900 has only 28 days on the Gregorian calendar.'],
    ['a calendar forced against the place', forced.detail[0],
      'England was not using that calendar then (it skipped this date); the date is shown as you asked.'],
    ['forced calendar keeps a real day', [forced.tone, forced.grid.gap], ['ok', null]],
    ['no place, forced Julian', [noPlace.detail.length, noPlace.rows[1].value], [1, 'Thursday 11 March 1700']],
    ['no place, automatic', unplaced.detail[0],
      "No place is chosen, so the date is read as an old-calendar date. "
      + "Change 'Read my date as' under More to read it as a today's-calendar date."],
    ['custom place', [custom.tone, custom.headline], ['skip', '3 September 1752 never happened in your place.']],
    ['custom place line', custom.customLine,
      'After Wednesday 2 September 1752 the next day was Thursday 14 September 1752. 11 days were skipped.'],
    ['custom place with an impossible last day', customBad.headline,
      'Last day on the old calendar: April 1752 has only 30 days.'],
    ['days between', between.betweenLine,
      '15 September 1752 is 3 days later, counting real days only; skipped dates do not count.'],
    ['days between, earlier', earlier.betweenLine,
      '1 September 1752 is 3 days earlier, counting real days only; skipped dates do not count.'],
    ['days between, same day', same.betweenLine, 'Both dates are the same day.'],
    ['second date was skipped', secondGap.betweenLine,
      'Second date: 5 September 1752 never happened in England. Pick a day that did.'],
    ['first date was skipped', firstGap.betweenLine, 'Count from a real day: fix the first date.'],
    ['second date impossible', secondBad.betweenLine, 'Second date: April 1752 has only 30 days.'],
    ['dual year across a century', dual.rows[0].value, 'Monday 15 January 1699/1700'],
    ['Scotland year rule', scotland.yearBox && scotland.yearBox.title,
      'Which year? Scotland began the year on 25 March until 1599, '
      + 'so a date from 1 January to 24 March can be read two ways.'],
    ['More opens for a second date', [between.openMore, forced.openMore, april.openMore], [true, true, false]],
    ['two readings from 1 January to 24 March', [firstOfYear.yearBox !== null, lastBefore.yearBox !== null], [true, true]],
    ['24 March reads two ways', lastBefore.yearBox && lastBefore.yearBox.rows.map((row) => row.value),
      ["24 March 1731/32 is Friday 4 April 1732 on today's calendar.",
        "24 March 1731 is Wednesday 4 April 1731 on today's calendar."]],
    ['25 March starts the new year, one reading', newYear.yearBox, null],
    ['1750 is the last written year with two readings, 1751 has one',
      [lastWritten.yearBox !== null, firstModern.yearBox], [true, null]],
    ['dual year keeps its leading zero', turnOfCentury.rows[0].value, 'Wednesday 15 January 1700/01'],
  ]);
}

function otherGrids() {
  const grid = (placeId, year, month, calendar) => live.monthGrid({
    year, month, place: placeById(placeId), calendar: calendar || null,
  });
  // [lead, number of days, first day, gapAt, [first and last dropped day]]
  const shape = (g) => [g.lead, g.days.length, g.days.length ? g.days[0].day : null, g.gapAt,
    g.gapDays.length ? [g.gapDays[0], g.gapDays[g.gapDays.length - 1]] : []];
  return compare([
    ['Denmark-Norway February 1700', shape(grid('denmark-norway', 1700, 2)), [4, 18, 1, 18, [19, 29]]],
    ['Soviet Russia February 1918', shape(grid('soviet-russia', 1918, 2)), [4, 15, 14, 0, [1, 13]]],
    ['France December 1582', shape(grid('france', 1582, 12)), [6, 21, 1, 9, [10, 19]]],
    ['Rome September 1582 has no gap', shape(grid('rome', 1582, 9)), [6, 30, 1, null, []]],
    ['England February 1700 keeps its Julian leap day', shape(grid('england', 1700, 2)), [4, 29, 1, null, []]],
    ['Rome February 1900 has no 29th', shape(grid('rome', 1900, 2)), [4, 28, 1, null, []]],
    ['Rome October 1582 on a plain Julian calendar', shape(grid('rome', 1582, 10, 'julian')), [1, 31, 1, null, []]],
    ['no place means a Julian month', shape(live.monthGrid({ year: 1700, month: 2, place: null, calendar: null })),
      [4, 29, 1, null, []]],
  ]);
}

function placeTableText() {
  const rows = placeTableRows();
  const stretch = (name, last, first, skipped, kind) => [name, last, first, skipped, kind];
  return compare([
    ['rows', rows.map((row) => stretch(row.place, row.lastOld, row.firstNew, row.skipped, row.basisKind)), [
      stretch('Rome and most of Italy', 'Thursday 4 October 1582', 'Friday 15 October 1582',
        '10 days (5 to 14 October 1582)', 'confirmed'),
      stretch('Spain', 'Thursday 4 October 1582', 'Friday 15 October 1582', '10 days (5 to 14 October 1582)', 'search'),
      stretch('Portugal', 'Thursday 4 October 1582', 'Friday 15 October 1582',
        '10 days (5 to 14 October 1582)', 'search'),
      stretch('France', 'Sunday 9 December 1582', 'Monday 20 December 1582',
        '10 days (10 to 19 December 1582)', 'search'),
      stretch('England, Wales, Ireland and the colonies', 'Wednesday 2 September 1752',
        'Thursday 14 September 1752', '11 days (3 to 13 September 1752)', 'confirmed'),
      stretch('Scotland', 'Wednesday 2 September 1752', 'Thursday 14 September 1752',
        '11 days (3 to 13 September 1752)', 'mixed'),
      stretch('Denmark-Norway', 'Sunday 18 February 1700', 'Monday 1 March 1700',
        '11 days (19 to 29 February 1700)', 'search'),
      stretch('Soviet Russia (RSFSR)', 'Wednesday 31 January 1918', 'Thursday 14 February 1918',
        '13 days (1 to 13 February 1918)', 'search'),
    ]],
    ['every row names its basis', rows.every((row) => typeof row.basis === 'string' && row.basis.length > 0), true],
  ]);
}

const CASES = [
  ['row 1 Julian 4 October 1582 is day 2299160 (Wikipedia, Julian day)',
    () => compare([['day number', live.toDayNumber(ymd(1582, 10, 4), 'julian'), 2299160]])],
  ['row 2 Gregorian 15 October 1582 is day 2299161 (Wikipedia, Julian day)',
    () => compare([['day number', live.toDayNumber(ymd(1582, 10, 15), 'gregorian'), 2299161]])],
  ['row 3 Gregorian 1 January 2000 is day 2451545 (J2000.0 epoch, astronomy references seen in search results)',
    () => compare([['day number', live.toDayNumber(ymd(2000, 1, 1), 'gregorian'), 2451545]])],
  ['row 4 Rome 4 to 15 October 1582 (Family Tree Magazine)', () => {
    const at = (day) => interpretAt(live, 'rome', 1582, 10, day);
    const [d4, d5, d10, d15] = [4, 5, 10, 15].map(at);
    return compare([
      ['4 Oct kind and calendar', [d4.kind, d4.calendar], ['day', 'julian']],
      ['4 Oct weekday (Thursday)', weekdayOfReading(d4), 4],
      ['15 Oct kind and calendar', [d15.kind, d15.calendar], ['day', 'gregorian']],
      ['15 Oct weekday (Friday)', weekdayOfReading(d15), 5],
      ['15 Oct day number minus 4 Oct', (reading(d15) || {}).jdn - (reading(d4) || {}).jdn, 1],
      ['5 Oct kind', d5.kind, 'skipped'],
      ['10 Oct kind and count', [d10.kind, d10.skippedCount], ['skipped', 10]],
      ['10 Oct skippedFrom and skippedTo', [ymdText(d10.skippedFrom), ymdText(d10.skippedTo)], ['1582-10-5', '1582-10-14']],
    ]);
  }],
  ['row 5 England 2 to 14 September 1752 (Irish Statute Book, History Today)', () => {
    const at = (day) => interpretAt(live, 'england', 1752, 9, day);
    const [d2, d3, d13, d14] = [2, 3, 13, 14].map(at);
    return compare([
      ['2 Sep calendar and weekday (Wednesday)', [d2.calendar, weekdayOfReading(d2)], ['julian', 3]],
      ['14 Sep calendar and weekday (Thursday)', [d14.calendar, weekdayOfReading(d14)], ['gregorian', 4]],
      ['14 Sep day number minus 2 Sep', (reading(d14) || {}).jdn - (reading(d2) || {}).jdn, 1],
      ['3 Sep kind and count', [d3.kind, d3.skippedCount], ['skipped', 11]],
      ['13 Sep kind and count', [d13.kind, d13.skippedCount], ['skipped', 11]],
    ]);
  }],
  ['row 6 France 9 to 20 December 1582 (search-seen: Wikipedia, 1582 in France; icalendars.net)', () => {
    const at = (day) => interpretAt(live, 'france', 1582, 12, day);
    const [d9, d15, d20] = [9, 15, 20].map(at);
    return compare([
      ['9 Dec calendar and weekday (Sunday)', [d9.calendar, weekdayOfReading(d9)], ['julian', 0]],
      ['20 Dec calendar and weekday (Monday)', [d20.calendar, weekdayOfReading(d20)], ['gregorian', 1]],
      ['20 Dec day number minus 9 Dec', (reading(d20) || {}).jdn - (reading(d9) || {}).jdn, 1],
      ['15 Dec kind and count', [d15.kind, d15.skippedCount], ['skipped', 10]],
    ]);
  }],
  ['row 7 Denmark-Norway February 1700 (search-seen: Wikipedia, Adoption of the Gregorian calendar; Debian tzdata)',
    () => row7(live)],
  ['row 8 Soviet Russia January to February 1918 (search-seen: Soviet History archive; prlib.ru)',
    () => {
      const at = (month, day) => interpretAt(live, 'soviet-russia', 1918, month, day);
      const [jan31, feb7, feb14] = [at(1, 31), at(2, 7), at(2, 14)];
      return compare([
        ['31 Jan calendar and weekday (Wednesday)', [jan31.calendar, weekdayOfReading(jan31)], ['julian', 3]],
        ['14 Feb calendar and weekday (Thursday)', [feb14.calendar, weekdayOfReading(feb14)], ['gregorian', 4]],
        ['14 Feb day number minus 31 Jan', (reading(feb14) || {}).jdn - (reading(jan31) || {}).jdn, 1],
        ['7 Feb kind and count', [feb7.kind, feb7.skippedCount], ['skipped', 13]],
      ]);
    }],
  ['row 9 England 11 February 1731 reads two ways (search-seen: National Park Service; Philadelphia Inquirer)', () => {
    const result = interpretAt(live, 'england', 1731, 2, 11);
    const [written, plain] = result.readings || [];
    return compare([
      ['two readings', (result.readings || []).length, 2],
      ['first reading is the year as written', written && [written.id, written.dual], ['written', '1731/32']],
      ['written: Gregorian label and weekday (Friday)', written && [ymdText(written.gregorian), written.weekday], ['1732-2-22', 5]],
      ['written: day number', written && written.jdn, 2353712],
      ['plain: Gregorian label and weekday (Thursday)', plain && [ymdText(plain.gregorian), plain.weekday], ['1731-2-22', 4]],
    ]);
  }],
  ['row 10 England 25 December 1642 (search-seen: Newton Project; Wikipedia, Early life of Isaac Newton)', () => {
    const result = interpretAt(live, 'england', 1642, 12, 25);
    const only = reading(result);
    return compare([
      ['one reading', (result.readings || []).length, 1],
      ['Gregorian label and weekday (Sunday)', only && [ymdText(only.gregorian), only.weekday], ['1643-1-4', 0]],
    ]);
  }],
  ['row 11 Soviet Russia 25 October 1917 (search-seen: Wikipedia, October Revolution; Cambridge University Library)', () => {
    const only = reading(interpretAt(live, 'soviet-russia', 1917, 10, 25));
    return compare([
      ['Gregorian label and weekday (Wednesday)', only && [ymdText(only.gregorian), only.weekday], ['1917-11-7', 3]],
    ]);
  }],
  ['row 12 offsets 10, 11, 12, 13 (search-seen: Wikipedia, Conversion between Julian and Gregorian calendars)',
    () => compare([['offsets at Julian 1 January 1650, 1750, 1850, 1950',
      [1650, 1750, 1850, 1950].map((year) => live.offsetDays(live.toDayNumber(ymd(year, 1, 1), 'julian'))),
      [10, 11, 12, 13]]])],
  ['row 13 offsets across 1 March 1700, 1800, 1900 and 2100 (search-seen: same sources as row 12)',
    () => compare([['offsets on Gregorian 28 February and 1 March',
      [1700, 1800, 1900, 2100].map((year) => [
        live.offsetDays(live.toDayNumber(ymd(year, 2, 28), 'gregorian')),
        live.offsetDays(live.toDayNumber(ymd(year, 3, 1), 'gregorian')),
      ]),
      [[10, 11], [11, 12], [12, 13], [13, 14]]]])],
  ['row 14 leap years (US Naval Observatory FAQ; Tondering)', () => row14(live)],
  ['row 15 the 400 Gregorian years 1601 to 2000 (US Naval Observatory FAQ; Tondering)', () => row15(live)],
  ['row 16 the same 400 years on the Julian calendar (computed per section 5.3)', () => {
    const julian = countYears(live, 'julian', 1601, 2000);
    const gregorian = countYears(live, 'gregorian', 1601, 2000);
    return compare([
      ['leap years', julian.leapYears, 100],
      ['days', julian.days, 146100],
      ['more days than the Gregorian count', julian.days - gregorian.days, 3],
    ]);
  }],
  ['row 17 Julian 29 February 1700 on a plain calendar (computed per section 5.1)', () => {
    const only = reading(interpretAt(live, 'none', 1700, 2, 29, 'julian'));
    return compare([['Gregorian label and weekday (Thursday)', only && [ymdText(only.gregorian), only.weekday], ['1700-3-11', 4]]]);
  }],
  ['row 18 Julian 29 February 1900 on a plain calendar (computed per section 5.1)', () => {
    const only = reading(interpretAt(live, 'none', 1900, 2, 29, 'julian'));
    return compare([['Gregorian label and weekday (Tuesday)', only && [ymdText(only.gregorian), only.weekday], ['1900-3-13', 2]]]);
  }],
  ['row 19 England 1 to 15 September 1752 is 3 days (computed per section 5.9)', () => {
    const first = reading(interpretAt(live, 'england', 1752, 9, 1));
    const second = reading(interpretAt(live, 'england', 1752, 9, 15));
    return compare([['days between', second.jdn - first.jdn, 3]]);
  }],
  ['row 20 England 1 January 1752 to 1 January 1753 is 355 days (computed per section 5.9)', () => {
    const first = reading(interpretAt(live, 'england', 1752, 1, 1));
    const second = reading(interpretAt(live, 'england', 1753, 1, 1));
    return compare([['days between', second.jdn - first.jdn, 355]]);
  }],
  ['row 21 September 1752 in England, month grid (computed per section 5.8)', () => {
    const grid = live.monthGrid({ year: 1752, month: 9, place: placeById('england'), calendar: null });
    const weekdayOfDay = (day) => (grid.days.find((entry) => entry.day === day) || {}).weekday;
    return compare([
      ['lead', grid.lead, 2],
      ['days', grid.days.map((entry) => entry.day), [1, 2, ...Array.from({ length: 17 }, (_, index) => 14 + index)]],
      ['1 is Tuesday, 14 is Thursday', [weekdayOfDay(1), weekdayOfDay(14)], [2, 4]],
      ['gapAt and gapDays', [grid.gapAt, grid.gapDays], [2, Array.from({ length: 11 }, (_, index) => 3 + index)]],
    ]);
  }],
  ['row 22 October 1582 in Rome, month grid (computed per section 5.8)', () => {
    const grid = live.monthGrid({ year: 1582, month: 10, place: placeById('rome'), calendar: null });
    const weekdayOfDay = (day) => (grid.days.find((entry) => entry.day === day) || {}).weekday;
    return compare([
      ['lead', grid.lead, 1],
      ['days', grid.days.map((entry) => entry.day), [1, 2, 3, 4, ...Array.from({ length: 17 }, (_, index) => 15 + index)]],
      ['1 Monday, 4 Thursday, 15 Friday, 31 Sunday', [1, 4, 15, 31].map(weekdayOfDay), [1, 4, 5, 0]],
      ['gapAt', grid.gapAt, 4],
    ]);
  }],
  ['row 23 France 29 February 1900 is no date (computed per section 5.3)', () => row23(live)],
  ['row 24 every day from 1 January 1500 to 31 December 2099 round trips (computed per section 5.1; Date.UTC as reference)',
    () => roundTripEveryDay(live)],
  ['extra 25 mutation guard: an every-fourth-year leap rule is caught', mutationGuard],
  ['extra 26 golden view models of section 4.6 (the sample and England 11 February 1731)', goldenViewModels],
  ['extra 27 hash safety (parseHash and formatHash)', hashSafety],
  ['extra 28 each place has consecutive day numbers and its skipped count', placeTable],
  ['extra 29 DOM contract: every required id exists', domContract],
  ['extra 30 input validation: empty, huge, negative, unicode, pasted dates', inputValidation],
  ['extra 31 message wording: impossible dates, forced calendars, custom place, days between', wordingAndModes],
  ['extra 32 month grids at the other switches and without a gap (computed per section 5.8)', otherGrids],
  ['extra 33 place table rows: weekdays, skipped stretches and evidence labels (computed per section 5.5)',
    placeTableText],
].map(([name, run]) => ({ name, run }));

export function runSelfTest() {
  const cases = CASES.map(({ name, run }) => {
    const outcome = attempt(run);
    return { name, ok: outcome.ok === true, detail: String(outcome.detail) };
  });
  const passed = cases.filter((entry) => entry.ok).length;
  return { ok: passed === cases.length, total: cases.length, passed, cases };
}

if (typeof window !== 'undefined') window.__sedSelfTest = runSelfTest;
