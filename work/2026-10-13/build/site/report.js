// Every string that depends on a result (SPEC 4.6, 7): headline, readings, steps, copy text, grid labels
// and the place table. Pure and synchronous. The DOM only ever receives these strings, as text.

import {
  MONTH_NAMES, WEEKDAY_NAMES, interpret, monthGrid, customPlace, dayNumberTerms,
  weekdayOf, toDayNumber, fromDayNumber, offsetDays,
} from './engine.js';
import { PLACES } from './data/places.js';

const OLD = 'the old calendar';
const NEW = "today's calendar";
const FOOTER = 'Not genealogical or legal proof. Historical Date Converter, Sonnet Every Day.';
const SAMPLE_CAPTION = 'Sample, built on 13 October 2026: one of the ten days Rome never had in 1582.';
const COUNT_FROM_REAL = 'Count from a real day: fix the first date.';
const DAY_MESSAGE = 'Type the day as a whole number from 1 to 31, using only the digits 0 to 9. '
  + 'A date such as 13/10/1582 goes in three boxes: day, month, year.';
const MESSAGES = {
  'day-format': DAY_MESSAGE,
  'day-range': DAY_MESSAGE,
  'month-format': 'Pick a month from the list.',
  'month-range': 'Pick a month from the list.',
  'year-format': 'Type the year as digits, for example 1582.',
  'year-range': 'This page covers the years 1500 to 2099.',
  'place-format': 'Pick a place from the list.',
  'custom-format': 'Last day on the old calendar: type a real date with digits only, for example 2 September 1752.',
  'between-format': 'Second date: type a day, a month and a year using digits, or clear the three boxes.',
  internal: 'Something went wrong with that date. Try another one.',
};

const MISMATCH_WHY = {
  julian: 'it was still on the old calendar',
  gregorian: 'it had already switched',
  gap: 'it skipped this date',
};

const cap = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const calendarWord = (cal) => (cal === 'julian' ? 'Julian' : 'Gregorian');

export function placeById(id) {
  return PLACES.find((place) => place.id === id) || null;
}

export function formatYMD(ymd, opts) {
  if (!ymd || !MONTH_NAMES[ymd.month - 1]) return '';
  const weekday = opts && WEEKDAY_NAMES[opts.weekday] ? `${WEEKDAY_NAMES[opts.weekday]} ` : '';
  const year = opts && opts.dual ? opts.dual : ymd.year;
  return `${weekday}${ymd.day} ${MONTH_NAMES[ymd.month - 1]} ${year}`;
}

// A date, optionally with its weekday (a number 0..6, 0 = Sunday).
const fmt = (ymd, weekday) => formatYMD(ymd, weekday === undefined ? undefined : { weekday });

function ordinal(n) {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
}

// Groups ascending day numbers into [first, last] runs.
function runsOf(days) {
  const runs = [];
  for (const day of days) {
    const last = runs[runs.length - 1];
    if (last && day === last[1] + 1) last[1] = day;
    else runs.push([day, day]);
  }
  return runs;
}

function runText([from, to]) {
  if (from === to) return String(from);
  return to === from + 1 ? `${from} and ${to}` : `${from} to ${to}`;
}

function rangeText(from, to, withYear) {
  if (from.year === to.year && from.month === to.month) {
    return `${from.day} to ${to.day} ${MONTH_NAMES[from.month - 1]}${withYear ? ` ${from.year}` : ''}`;
  }
  if (from.year === to.year && !withYear) {
    return `${from.day} ${MONTH_NAMES[from.month - 1]} to ${to.day} ${MONTH_NAMES[to.month - 1]}`;
  }
  return `${fmt(from)} to ${fmt(to)}`;
}

function noSuchDayText(params) {
  const calendar = params.calendar ? ` on the ${calendarWord(params.calendar)} calendar` : '';
  const leap = params.leapNote ? ` ${params.year} was a leap year on the Julian calendar only.` : '';
  return `${MONTH_NAMES[params.month - 1]} ${params.year} has only ${params.maxDays} days${calendar}.${leap}`;
}

function errorText(code, params) {
  if (code === 'no-such-day') return noSuchDayText(params);
  return MESSAGES[code] || MESSAGES.internal;
}

// The sum behind a day number, as the steps panel prints it. The a, y, m prefix is printed once.
function formula(ymd, cal, withPrefix) {
  const t = dayNumberTerms(ymd, cal);
  const sum = cal === 'julian'
    ? `${ymd.day} + ${t.t153} + ${t.t365} + ${t.t4} - ${t.k}`
    : `${ymd.day} + ${t.t153} + ${t.t365} + ${t.t4} - ${t.t100} + ${t.t400} - ${t.k}`;
  return withPrefix ? `a = ${t.a}, y = ${t.y}, m = ${t.m}; ${sum}` : sum;
}

// Facts about a place's switch that several strings need: the day numbers on either side, the number
// of names that were dropped and the first and last of them (as Julian labels).
function switchFacts(place) {
  const beforeJdn = toDayNumber(place.lastJulian, 'julian');
  const afterJdn = toDayNumber(place.firstGregorian, 'gregorian');
  const count = offsetDays(afterJdn);
  return {
    beforeJdn,
    afterJdn,
    count,
    beforeWeekday: weekdayOf(beforeJdn),
    afterWeekday: weekdayOf(afterJdn),
    from: fromDayNumber(beforeJdn + 1, 'julian'),
    to: fromDayNumber(beforeJdn + count, 'julian'),
  };
}

function resolvePlace(state) {
  return state.placeId === 'custom' ? customPlace(state.custom) : placeById(state.placeId);
}

function errorVM(message, extra) {
  return {
    tone: 'error',
    badge: 'Check the date',
    sample: false,
    headline: message,
    detail: [],
    rows: [],
    yearBox: null,
    grid: null,
    steps: [],
    caption: '',
    copyText: '',
    announce: message,
    yearRule: '',
    showCustom: false,
    customLine: '',
    betweenLine: '',
    betweenTone: 'none',
    openMore: false,
    ...extra,
  };
}

// The sentence under the "Count the days" boxes, and its tone.
function betweenOutcome(state, betweenError, main, place) {
  if (betweenError) return { betweenLine: MESSAGES['between-format'], betweenTone: 'error' };
  if (!state.between) return { betweenLine: '', betweenTone: 'none' };
  if (main.kind !== 'day') return { betweenLine: COUNT_FROM_REAL, betweenTone: 'error' };

  const second = interpret({ ymd: state.between, place, writtenIn: state.writtenIn });
  if (!second.ok) return { betweenLine: `Second date: ${errorText(second.code, second.params)}`, betweenTone: 'error' };
  if (second.kind === 'skipped') {
    const line = `Second date: ${fmt(second.typed)} never happened in ${second.place.short}. Pick a day that did.`;
    return { betweenLine: line, betweenTone: 'error' };
  }
  const days = second.readings[0].jdn - main.readings[0].jdn;
  if (days === 0) return { betweenLine: 'Both dates are the same day.', betweenTone: 'ok' };
  const amount = Math.abs(days) === 1 ? '1 day' : `${Math.abs(days)} days`;
  const line = `${fmt(second.typed)} is ${amount} ${days > 0 ? 'later' : 'earlier'}, `
    + 'counting real days only; skipped dates do not count.';
  return { betweenLine: line, betweenTone: 'ok' };
}

function daysSentence(days) {
  return `Days ${runsOf(days).map(runText).join(', then ')}.`;
}

// `data` is the engine's monthGrid; `droppedDay` is the typed day when it is one of the dropped names.
function gridVM(data, shortName, dual, focusDay, droppedDay) {
  const monthName = MONTH_NAMES[data.month - 1];
  const title = `${monthName} ${dual || data.year}`;
  const julianDays = data.days.filter((entry) => entry.calendar === 'julian');
  const gregorianDays = data.days.filter((entry) => entry.calendar === 'gregorian');
  let subtitle = julianDays.length ? 'Old calendar (Julian)' : "Today's calendar (Gregorian)";
  if (julianDays.length && gregorianDays.length) {
    subtitle = `Old calendar up to the ${ordinal(julianDays[julianDays.length - 1].day)}, `
      + `today's calendar from the ${ordinal(gregorianDays[0].day)}`;
  }

  let gap = null;
  let label = `${title}. ${daysSentence(data.days.map((entry) => entry.day))}`;
  if (data.gapDays.length) {
    const count = data.gapDays.length;
    const names = `${runsOf(data.gapDays).map(runText).join(', ')} ${monthName}`;
    gap = {
      days: data.gapDays.slice(),
      text: `${count} ${count === 1 ? 'day' : 'days'} skipped here: ${names}`,
      focus: droppedDay !== null && data.gapDays.includes(droppedDay) ? droppedDay : null,
    };
    label += ` The ${count === 1 ? 'day' : 'days'} ${names} never happened in ${shortName}.`;
  }
  return {
    title,
    subtitle,
    label,
    weekdays: ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'],
    weekdayNames: WEEKDAY_NAMES.slice(),
    lead: data.lead,
    days: data.days.map((entry) => ({ day: entry.day, weekday: entry.weekday })),
    focus: focusDay !== null && data.days.some((entry) => entry.day === focusDay) ? focusDay : null,
    gapAt: data.gapAt,
    gap,
  };
}

function copyTextOf(headline, detail, rows, yearBox) {
  const lines = [headline, ...detail, ...rows.map((row) => `${row.label}: ${row.value}`)];
  if (yearBox) lines.push(...yearBox.rows.map((row) => `${row.label}: ${row.value}`));
  lines.push(FOOTER);
  return lines.join('\n');
}

function skippedParts(res) {
  const { typed, place, before, after } = res;
  const shortName = place.short;
  const detail = [
    `The calendar jumped from ${fmt(before.ymd, before.weekday)} to ${fmt(after.ymd, after.weekday)}, `
    + `skipping ${res.skippedCount} days.`,
  ];
  const rows = [];
  if (res.asGregorian) {
    rows.push({
      label: "If you meant today's calendar",
      value: `Counting back, that day would have been a ${WEEKDAY_NAMES[res.asGregorian.weekday]}, `
        + `called ${fmt(res.asGregorian.julian)} on ${OLD}.`,
      cal: 'gregorian',
    });
  }
  if (res.asJulian) {
    rows.push({
      label: 'If you meant the old calendar',
      value: `It did exist, as a ${WEEKDAY_NAMES[res.asJulian.weekday]}, `
        + `called ${fmt(res.asJulian.gregorian)} on ${NEW}.`,
      cal: 'julian',
    });
  }

  let prefixed = false;
  const sum = (cal) => {
    const text = formula(typed, cal, !prefixed);
    prefixed = true;
    return text;
  };
  const steps = [
    `You typed ${fmt(typed)} for ${shortName}.`,
    `${cap(shortName)} used ${OLD} up to ${fmt(before.ymd, before.weekday)} and ${NEW} from `
      + `${fmt(after.ymd, after.weekday)}.`,
    `Day numbers (a plain count of days): ${fmt(before.ymd)} is day ${before.jdn} and ${fmt(after.ymd)} `
      + `is day ${after.jdn}. The count has no gap, so no real day was lost; the ${res.skippedCount} names `
      + `from ${rangeText(res.skippedFrom, res.skippedTo, false)} were skipped.`,
    `Your date falls inside that stretch, so no day in ${shortName} carried the name ${fmt(typed)}.`,
  ];
  if (res.asGregorian) {
    const g = res.asGregorian;
    steps.push(`Counting back on ${NEW}: ${fmt(typed)} is day ${g.jdn} (${sum('gregorian')}), `
      + `and (${g.jdn} + 1) mod 7 = ${g.weekday}, a ${WEEKDAY_NAMES[g.weekday]}. `
      + `The old calendar called that day ${fmt(g.julian)}.`);
  }
  if (res.asJulian) {
    const j = res.asJulian;
    steps.push(`Read as an old-calendar date: ${fmt(typed)} is day ${j.jdn} (${sum('julian')}), `
      + `and (${j.jdn} + 1) mod 7 = ${j.weekday}, a ${WEEKDAY_NAMES[j.weekday]}. `
      + `Today's calendar calls that day ${fmt(j.gregorian)}.`);
  }

  const data = monthGrid({ year: typed.year, month: typed.month, place, calendar: null });
  return {
    tone: 'skip',
    badge: 'Never existed there',
    headline: `${fmt(typed)} never happened in ${shortName}.`,
    detail,
    rows,
    yearBox: null,
    grid: gridVM(data, shortName, null, null, typed.day),
    steps,
  };
}

// Why this calendar was used for the date: the place, the visitor's choice, or the default.
function calendarReason(state, res) {
  if (state.writtenIn === 'julian' || state.writtenIn === 'gregorian') {
    return `You chose to read it as a ${calendarWord(res.calendar)} date.`;
  }
  if (res.noPlace) return 'No place is chosen, so it is read as a Julian date.';
  const { place } = res;
  const facts = switchFacts(place);
  if (res.regime === 'julian') {
    return `${cap(place.short)} was still on ${OLD} then (it switched after `
      + `${fmt(place.lastJulian, facts.beforeWeekday)}), so the date is read as a Julian date.`;
  }
  return `${cap(place.short)} was already on ${NEW} then (it switched on `
    + `${fmt(place.firstGregorian, facts.afterWeekday)}), so the date is read as a Gregorian date.`;
}

function regimeSentence(state, res) {
  const { place } = res;
  if (res.noPlace) {
    return state.writtenIn === 'auto'
      ? "No place is chosen, so the date is read as an old-calendar date. "
        + "Change 'Read my date as' under More to read it as a today's-calendar date."
      : null;
  }
  const facts = switchFacts(place);
  if (res.forcedMismatch) {
    return `${cap(place.short)} was not using that calendar then (${MISMATCH_WHY[res.regime]}); `
      + 'the date is shown as you asked.';
  }
  if (res.regime === 'julian') {
    return `${cap(place.short)} was still using ${OLD} then; it switched after `
      + `${fmt(place.lastJulian, facts.beforeWeekday)}.`;
  }
  return `${cap(place.short)} was using ${NEW} then; it had switched on ${fmt(place.firstGregorian, facts.afterWeekday)}.`;
}

// Without a place the only reason to mention the calendar is that the visitor chose one.
function forcedNote(state, res) {
  return state.writtenIn === 'auto' ? '' : ` 'Read my date as' was set to ${calendarWord(res.calendar)}.`;
}

function dayParts(state, res) {
  const [r, alternate] = res.readings;
  const julian = r.calendar === 'julian';
  const other = julian ? r.gregorian : r.julian;
  const otherPhrase = julian ? NEW : OLD;
  const { place } = res;

  const headline = `${formatYMD(r.modern, { dual: r.dual })} on ${julian ? OLD : NEW} is the same day as `
    + `${formatYMD(other, { weekday: r.weekday })} on ${otherPhrase}.`;
  const detail = [regimeSentence(state, res), `On this day the two calendars' names differed by ${r.offset} days.`]
    .filter(Boolean);
  const rows = [
    { label: 'Old calendar (Julian)', value: formatYMD(r.julian, { weekday: r.weekday, dual: r.dual }), cal: 'julian' },
    { label: "Today's calendar (Gregorian)", value: formatYMD(r.gregorian, { weekday: r.weekday }), cal: 'gregorian' },
  ];

  let yearBox = null;
  if (alternate) {
    const [written, plain] = res.readings;
    yearBox = {
      title: `Which year? ${place.short} began the year on 25 March until ${place.yearStart.lastModernYear}, `
        + 'so a date from 1 January to 24 March can be read two ways.',
      rows: [
        {
          label: 'As written then (the year began on 25 March)',
          value: `${formatYMD(written.modern, { dual: written.dual })} is `
            + `${formatYMD(written.gregorian, { weekday: written.weekday })} on ${NEW}.`,
        },
        {
          label: 'If your source counted years from 1 January',
          value: `${fmt(plain.modern)} is ${formatYMD(plain.gregorian, { weekday: plain.weekday })} on ${NEW}.`,
        },
      ],
    };
  }

  const steps = [
    res.noPlace
      ? `You typed ${fmt(res.typed)}.${forcedNote(state, res)}`
      : `You typed ${fmt(res.typed)} for ${place.id === 'custom' ? place.short : place.name}.`,
    calendarReason(state, res),
  ];
  if (r.id === 'written') {
    steps.push(`Year: ${place.short} began the year on 25 March, so ${MONTH_NAMES[r.typed.month - 1]} `
      + `${r.typed.year} belongs to the year ${r.modern.year} by today's count (written ${r.dual}).`
      + `${alternate ? ' The second reading counts the year from 1 January instead.' : ''}`);
  }
  steps.push(
    `Day number: ${formula(r.modern, r.calendar, true)} = ${r.jdn}.`,
    `The same day on ${otherPhrase}: day number ${r.jdn} is ${fmt(other)}.`,
    `Weekday: (${r.jdn} + 1) mod 7 = ${r.weekday}, a ${WEEKDAY_NAMES[r.weekday]} (0 is Sunday).`,
    `On this day the two calendars' names differed by ${r.offset} days.`,
  );
  if (!res.noPlace) {
    const facts = switchFacts(place);
    steps.push(`${cap(place.short)}'s switch kept the count continuous: day number ${facts.beforeJdn} `
      + `(${fmt(place.lastJulian)}) is followed by day number ${facts.afterJdn} (${fmt(place.firstGregorian)}), `
      + `and ${facts.count} names were skipped.`);
  }

  const forcedCalendar = state.writtenIn === 'auto' ? null : r.calendar;
  const data = monthGrid({ year: r.modern.year, month: r.modern.month, place, calendar: forcedCalendar });
  return {
    tone: 'ok',
    badge: 'A real day',
    headline,
    detail,
    rows,
    yearBox,
    grid: gridVM(data, place ? place.short : '', r.dual, r.typed.day, null),
    steps,
  };
}

function build(input) {
  const { state, error, betweenError, sample, placeId } = input;
  const edge = betweenError ? { betweenLine: MESSAGES['between-format'], betweenTone: 'error' } : {};
  if (!state) {
    return errorVM(errorText(error ? error.code : 'internal'), { showCustom: placeId === 'custom', ...edge });
  }

  const showCustom = state.placeId === 'custom';
  const openMore = state.writtenIn !== 'auto' || state.between !== null;
  const place = resolvePlace(state);
  const stuck = (message) => errorVM(message, {
    showCustom,
    openMore,
    ...(state.between ? { betweenLine: COUNT_FROM_REAL, betweenTone: 'error' } : edge),
  });
  if (!place && showCustom) {
    const probe = interpret({ ymd: state.custom, place: null, writtenIn: 'julian' });
    const reason = probe.ok ? MESSAGES.internal : errorText(probe.code, probe.params);
    return stuck(`Last day on the old calendar: ${reason}`);
  }
  if (!place) return stuck(MESSAGES['place-format']);

  const res = interpret({
    ymd: { year: state.year, month: state.month, day: state.day },
    place,
    writtenIn: state.writtenIn,
  });
  if (!res.ok) return stuck(errorText(res.code, res.params));

  const parts = res.kind === 'skipped' ? skippedParts(res) : dayParts(state, res);
  let customLine = '';
  if (showCustom) {
    const facts = switchFacts(place);
    customLine = `After ${fmt(place.lastJulian, facts.beforeWeekday)} the next day was `
      + `${fmt(place.firstGregorian, facts.afterWeekday)}. ${facts.count} days were skipped.`;
  }
  return {
    tone: parts.tone,
    badge: parts.badge,
    sample: Boolean(sample),
    headline: parts.headline,
    detail: parts.detail,
    rows: parts.rows,
    yearBox: parts.yearBox,
    grid: parts.grid,
    steps: parts.steps,
    caption: sample ? SAMPLE_CAPTION : '',
    copyText: copyTextOf(parts.headline, parts.detail, parts.rows, parts.yearBox),
    announce: [parts.headline, parts.detail[0]].filter(Boolean).join(' '),
    yearRule: place.yearRule,
    showCustom,
    customLine,
    ...betweenOutcome(state, betweenError, res, place),
    openMore,
  };
}

export function buildViewModel(input) {
  try {
    return build(input || {});
  } catch {
    // The contract says a view model is always returned; the self-test pins every normal path.
    return errorVM(MESSAGES.internal, { showCustom: Boolean(input && input.placeId === 'custom') });
  }
}

export function placeTableRows() {
  return PLACES.filter((place) => place.lastJulian).map((place) => {
    const facts = switchFacts(place);
    return {
      place: place.name,
      lastOld: fmt(place.lastJulian, facts.beforeWeekday),
      firstNew: fmt(place.firstGregorian, facts.afterWeekday),
      skipped: `${facts.count} days (${rangeText(facts.from, facts.to, true)})`,
      basis: place.basis,
      basisKind: place.basisKind,
    };
  });
}
