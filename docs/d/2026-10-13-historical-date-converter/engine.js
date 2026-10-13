// Calendar arithmetic for the Historical Date Converter (SPEC sections 4.3 and 5).
// Whole-number day counting only. The browser's own date and locale tools are left out on purpose:
// they extend today's calendar backwards and cannot hold a real Julian day such as 29 February 1700.

export const YEAR_MIN = 1500;
export const YEAR_MAX = 2099;
export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const fail = (code, params) => ({ ok: false, code, params: params || {} });

// Dual-year form of a date written in the old year count: 1731/32, and 1699/1700 across a century.
function dualYear(typedYear, modernYear) {
  const sameCentury = Math.floor(typedYear / 100) === Math.floor(modernYear / 100);
  const second = sameCentury ? String(modernYear % 100).padStart(2, '0') : String(modernYear);
  return `${typedYear}/${second}`;
}

// `centuryRule: false` turns the Gregorian leap rule into "every fourth year". Only the self-test
// mutation guard uses it, to prove the known-answer checks notice a wrong leap rule.
export function createEngine(opts) {
  const centuryRule = !(opts && opts.centuryRule === false);

  function isLeap(year, cal) {
    if (year % 4 !== 0) return false;
    if (cal === 'julian' || !centuryRule) return true;
    return year % 100 !== 0 || year % 400 === 0;
  }

  function daysInMonth(year, month, cal) {
    if (!(month >= 1 && month <= 12)) return 0;
    return month === 2 && isLeap(year, cal) ? 29 : MONTH_LENGTHS[month - 1];
  }

  function isValidDate(ymd, cal) {
    if (!ymd || !Number.isInteger(ymd.year) || !Number.isInteger(ymd.month) || !Number.isInteger(ymd.day)) {
      return false;
    }
    return ymd.day >= 1 && ymd.day <= daysInMonth(ymd.year, ymd.month, cal);
  }

  // The pieces of the day-number formula, so the steps panel can print the sum it really did.
  function dayNumberTerms(ymd, cal) {
    const julian = cal === 'julian';
    const a = Math.floor((14 - ymd.month) / 12);
    const y = ymd.year + 4800 - a;
    const m = ymd.month + 12 * a - 3;
    const t153 = Math.floor((153 * m + 2) / 5);
    const t365 = 365 * y;
    const t4 = Math.floor(y / 4);
    const t100 = julian ? 0 : Math.floor(y / 100);
    const t400 = julian ? 0 : Math.floor(y / 400);
    const k = julian ? 32083 : 32045;
    return { a, y, m, t153, t365, t4, t100, t400, k, jdn: ymd.day + t153 + t365 + t4 - t100 + t400 - k };
  }

  function toDayNumber(ymd, cal) {
    return dayNumberTerms(ymd, cal).jdn;
  }

  function fromDayNumber(jdn, cal) {
    let f = jdn + 1401;
    if (cal !== 'julian') f += Math.floor(Math.floor((4 * jdn + 274277) / 146097) * 3 / 4) - 38;
    const e = 4 * f + 3;
    const g = Math.floor((e % 1461) / 4);
    const h = 5 * g + 2;
    const day = Math.floor((h % 153) / 5) + 1;
    const month = ((Math.floor(h / 153) + 2) % 12) + 1;
    const year = Math.floor(e / 1461) - 4716 + Math.floor((12 + 2 - month) / 12);
    return { year, month, day };
  }

  // 0 = Sunday. The seven-day cycle ran on unbroken through every calendar switch.
  function weekdayOf(jdn) {
    return (((jdn + 1) % 7) + 7) % 7;
  }

  function compareYMD(a, b) {
    if (a.year !== b.year) return a.year < b.year ? -1 : 1;
    if (a.month !== b.month) return a.month < b.month ? -1 : 1;
    if (a.day !== b.day) return a.day < b.day ? -1 : 1;
    return 0;
  }

  // How far the Gregorian name of a day is ahead of its Julian name.
  function offsetDays(jdn) {
    return toDayNumber(fromDayNumber(jdn, 'gregorian'), 'julian') - jdn;
  }

  function customPlace(lastJulian) {
    if (!isValidDate(lastJulian, 'julian') || lastJulian.year < YEAR_MIN || lastJulian.year > YEAR_MAX) {
      return null;
    }
    return {
      id: 'custom',
      name: 'A place that is not listed',
      short: 'your place',
      lastJulian: { year: lastJulian.year, month: lastJulian.month, day: lastJulian.day },
      firstGregorian: fromDayNumber(toDayNumber(lastJulian, 'julian') + 1, 'gregorian'),
      yearStart: null,
      yearRule: 'The year is counted from 1 January.',
      basisKind: null,
      basis: '',
    };
  }

  // Month length is the same on both calendars except for century years, so `calendar` is only
  // named in the message when it matters.
  function noSuchDay(typed, cal) {
    const { year, month, day } = typed;
    const julianLength = daysInMonth(year, month, 'julian');
    const gregorianLength = daysInMonth(year, month, 'gregorian');
    if (cal === null) {
      return fail('no-such-day', {
        month, year, maxDays: Math.max(julianLength, gregorianLength), calendar: null, leapNote: false,
      });
    }
    return fail('no-such-day', {
      month,
      year,
      maxDays: cal === 'julian' ? julianLength : gregorianLength,
      calendar: julianLength !== gregorianLength ? cal : null,
      leapNote: day === 29 && month === 2 && cal === 'gregorian' && isLeap(year, 'julian'),
    });
  }

  function skippedResult(typed, place) {
    const beforeJdn = toDayNumber(place.lastJulian, 'julian');
    const afterJdn = toDayNumber(place.firstGregorian, 'gregorian');
    const skippedCount = offsetDays(afterJdn);
    const result = {
      ok: true,
      kind: 'skipped',
      typed,
      place,
      before: { ymd: place.lastJulian, jdn: beforeJdn, weekday: weekdayOf(beforeJdn) },
      after: { ymd: place.firstGregorian, jdn: afterJdn, weekday: weekdayOf(afterJdn) },
      skippedCount,
      skippedFrom: fromDayNumber(beforeJdn + 1, 'julian'),
      skippedTo: fromDayNumber(beforeJdn + skippedCount, 'julian'),
      asGregorian: null,
      asJulian: null,
    };
    if (isValidDate(typed, 'gregorian')) {
      const jdn = toDayNumber(typed, 'gregorian');
      result.asGregorian = { jdn, weekday: weekdayOf(jdn), julian: fromDayNumber(jdn, 'julian') };
    }
    if (isValidDate(typed, 'julian')) {
      const jdn = toDayNumber(typed, 'julian');
      result.asJulian = { jdn, weekday: weekdayOf(jdn), gregorian: fromDayNumber(jdn, 'gregorian') };
    }
    return result;
  }

  function makeReading(id, typed, modern, cal, dual) {
    const jdn = toDayNumber(modern, cal);
    return {
      id,
      calendar: cal,
      typed: { year: typed.year, month: typed.month, day: typed.day },
      modern: { year: modern.year, month: modern.month, day: modern.day },
      julian: cal === 'julian' ? { year: modern.year, month: modern.month, day: modern.day } : fromDayNumber(jdn, 'julian'),
      gregorian: cal === 'gregorian'
        ? { year: modern.year, month: modern.month, day: modern.day }
        : fromDayNumber(jdn, 'gregorian'),
      jdn,
      weekday: weekdayOf(jdn),
      offset: offsetDays(jdn),
      dual,
    };
  }

  // A date from 1 January to 24 March, before the place moved its new year to 1 January, was
  // written with the previous year number.
  function hasOldYearReading(place, typed) {
    const rule = place && place.yearStart;
    if (!rule || rule.rule !== 'march25') return false;
    const inWindow = typed.month < 3 || (typed.month === 3 && typed.day <= 24);
    return inWindow && typed.year + 1 <= rule.lastModernYear;
  }

  function interpret(input) {
    const { ymd, place, writtenIn } = input || {};
    const src = ymd || {};
    if (!Number.isInteger(src.month) || src.month < 1 || src.month > 12) return fail('month-range');
    if (!Number.isInteger(src.day) || src.day < 1 || src.day > 31) return fail('day-range');
    if (!Number.isInteger(src.year) || src.year < YEAR_MIN || src.year > YEAR_MAX) return fail('year-range');
    const typed = { year: src.year, month: src.month, day: src.day };

    const hasSwitch = Boolean(place && place.lastJulian && place.firstGregorian);
    const forced = writtenIn === 'julian' || writtenIn === 'gregorian';
    let regime = null;
    if (hasSwitch) {
      if (compareYMD(typed, place.lastJulian) <= 0) regime = 'julian';
      else if (compareYMD(typed, place.firstGregorian) >= 0) regime = 'gregorian';
      else regime = 'gap';
    }
    // Compared as labels before any leap-day check, so 29 February 1700 is a dropped date in
    // Denmark-Norway even though it is no Gregorian date.
    if (regime === 'gap' && !forced) {
      const real = isValidDate(typed, 'julian') || isValidDate(typed, 'gregorian');
      return real ? skippedResult(typed, place) : noSuchDay(typed, null);
    }

    const cal = forced ? writtenIn : regime === 'gregorian' ? 'gregorian' : 'julian';
    const readings = [];
    if (cal === 'julian' && hasOldYearReading(place, typed)) {
      const modern = { year: typed.year + 1, month: typed.month, day: typed.day };
      if (isValidDate(modern, cal)) {
        readings.push(makeReading('written', typed, modern, cal, dualYear(typed.year, modern.year)));
      }
    }
    if (isValidDate(typed, cal)) readings.push(makeReading('plain', typed, typed, cal, null));
    if (!readings.length) return noSuchDay(typed, cal);

    return {
      ok: true,
      kind: 'day',
      typed,
      place: place || null,
      calendar: cal,
      regime,
      forcedMismatch: forced && regime !== null && regime !== cal,
      noPlace: !hasSwitch,
      readings,
    };
  }

  function gridEntry(year, month, day, cal) {
    return { day, weekday: weekdayOf(toDayNumber({ year, month, day }, cal)), calendar: cal };
  }

  function monthGrid(input) {
    const { year, month, place } = input;
    const plain = input.calendar === 'julian' || input.calendar === 'gregorian' ? input.calendar : null;
    const hasSwitch = !plain && Boolean(place && place.lastJulian && place.firstGregorian);
    const days = [];
    const gapDays = [];
    let gapAt = null;

    if (!hasSwitch) {
      const cal = plain || 'julian';
      const length = daysInMonth(year, month, cal);
      for (let day = 1; day <= length; day += 1) days.push(gridEntry(year, month, day, cal));
    } else {
      const longest = Math.max(daysInMonth(year, month, 'julian'), daysInMonth(year, month, 'gregorian'));
      for (let day = 1; day <= longest; day += 1) {
        const label = { year, month, day };
        if (compareYMD(label, place.lastJulian) <= 0 && isValidDate(label, 'julian')) {
          days.push(gridEntry(year, month, day, 'julian'));
        } else if (compareYMD(label, place.firstGregorian) >= 0 && isValidDate(label, 'gregorian')) {
          days.push(gridEntry(year, month, day, 'gregorian'));
        } else if (
          (isValidDate(label, 'julian') || isValidDate(label, 'gregorian'))
          && compareYMD(label, place.lastJulian) > 0
          && compareYMD(label, place.firstGregorian) < 0
        ) {
          if (gapAt === null) gapAt = days.length;
          gapDays.push(day);
        }
      }
    }
    return { year, month, lead: days.length ? days[0].weekday : 0, days, gapAt, gapDays };
  }

  return {
    isLeap, daysInMonth, isValidDate, toDayNumber, fromDayNumber, weekdayOf, compareYMD,
    offsetDays, dayNumberTerms, customPlace, interpret, monthGrid,
  };
}

const defaultEngine = createEngine();

export const {
  isLeap, daysInMonth, isValidDate, toDayNumber, fromDayNumber, weekdayOf, compareYMD,
  offsetDays, dayNumberTerms, customPlace, interpret, monthGrid,
} = defaultEngine;
