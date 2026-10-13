// Switch days of the places this page knows. Each row is a pair of consecutive days: the last day on
// the Julian calendar and the first day on the Gregorian one (SPEC 4.4). `basisKind` says how well the
// row is sourced: confirmed (a page was opened or the primary text was seen), mixed, or search (seen in
// search results only, never opened). The About panel and the limits note repeat that distinction.

function freeze(value) {
  for (const inner of Object.values(value)) {
    if (inner && typeof inner === 'object') freeze(inner);
  }
  return Object.freeze(value);
}

const ymd = (year, month, day) => ({ year, month, day });
const FROM_JANUARY = 'The year is counted from 1 January.';
const AS_OF = 'As of 2026-10-13, per search results: ';

export const PLACES = freeze([
  {
    id: 'rome',
    name: 'Rome and most of Italy',
    short: 'Rome',
    lastJulian: ymd(1582, 10, 4),
    firstGregorian: ymd(1582, 10, 15),
    yearStart: null,
    yearRule: FROM_JANUARY,
    basisKind: 'confirmed',
    basis: 'Family Tree Magazine and the Julian day article (see Sources).',
  },
  {
    id: 'spain',
    name: 'Spain',
    short: 'Spain',
    lastJulian: ymd(1582, 10, 4),
    firstGregorian: ymd(1582, 10, 15),
    yearStart: null,
    yearRule: FROM_JANUARY,
    basisKind: 'search',
    basis: AS_OF + 'Wikipedia, 1582; Catholic Answers, The day the Church altered time.',
  },
  {
    id: 'portugal',
    name: 'Portugal',
    short: 'Portugal',
    lastJulian: ymd(1582, 10, 4),
    firstGregorian: ymd(1582, 10, 15),
    yearStart: null,
    yearRule: FROM_JANUARY,
    basisKind: 'search',
    basis: AS_OF + 'Wikipedia, 1582; Catholic Answers, The day the Church altered time.',
  },
  {
    id: 'france',
    name: 'France',
    short: 'France',
    lastJulian: ymd(1582, 12, 9),
    firstGregorian: ymd(1582, 12, 20),
    yearStart: null,
    yearRule: FROM_JANUARY,
    basisKind: 'search',
    basis: AS_OF + 'Wikipedia, 1582 in France; icalendars.net, Gregorian reform: one day or another.',
  },
  {
    id: 'england',
    name: 'England, Wales, Ireland and the colonies',
    short: 'England',
    lastJulian: ymd(1752, 9, 2),
    firstGregorian: ymd(1752, 9, 14),
    yearStart: { rule: 'march25', lastModernYear: 1751 },
    yearRule: 'In England, Wales, Ireland and the colonies the year began on 25 March until 1751, ' +
      'and on 1 January from 1752.',
    basisKind: 'confirmed',
    basis: 'The Calendar (New Style) Act 1750 and History Today (see Sources).',
  },
  {
    id: 'scotland',
    name: 'Scotland',
    short: 'Scotland',
    lastJulian: ymd(1752, 9, 2),
    firstGregorian: ymd(1752, 9, 14),
    yearStart: { rule: 'march25', lastModernYear: 1599 },
    yearRule: 'In Scotland the year began on 25 March until 1599, and on 1 January from 1600 ' +
      '(as of 2026-10-13, per search results).',
    basisKind: 'mixed',
    basis: 'Switch day: the same Act as England (see Sources). Year start in 1600: as of 2026-10-13, ' +
      'per search results: National Records of Scotland; Wikipedia, Dual dating.',
  },
  {
    id: 'denmark-norway',
    name: 'Denmark-Norway',
    short: 'Denmark-Norway',
    lastJulian: ymd(1700, 2, 18),
    firstGregorian: ymd(1700, 3, 1),
    yearStart: null,
    yearRule: FROM_JANUARY,
    basisKind: 'search',
    basis: AS_OF + 'Wikipedia, Adoption of the Gregorian calendar; Debian tzdata calendars file. ' +
      'Many Protestant German states made the same switch, but not all of them.',
  },
  {
    id: 'soviet-russia',
    name: 'Soviet Russia (RSFSR)',
    short: 'Soviet Russia',
    lastJulian: ymd(1918, 1, 31),
    firstGregorian: ymd(1918, 2, 14),
    yearStart: null,
    yearRule: FROM_JANUARY,
    basisKind: 'search',
    basis: AS_OF + 'Soviet History archive (Michigan State); prlib.ru. ' +
      'Other governments of the former Russian empire switched on other days.',
  },
  {
    id: 'none',
    name: 'No place: just compare the calendars',
    short: '',
    lastJulian: null,
    firstGregorian: null,
    yearStart: null,
    yearRule: FROM_JANUARY,
    basisKind: null,
    basis: '',
  },
  {
    id: 'custom',
    name: 'A place that is not listed',
    short: 'your place',
    lastJulian: null,
    firstGregorian: null,
    yearStart: null,
    yearRule: FROM_JANUARY,
    basisKind: null,
    basis: '',
  },
]);

const famous = (id, label, placeId, year, month, day) => ({
  id,
  label,
  state: { placeId, year, month, day, writtenIn: 'auto' },
});

export const FAMOUS = freeze([
  famous('rome-1582', '13 October 1582 in Rome (a date that never was)', 'rome', 1582, 10, 13),
  famous('england-1752', '3 September 1752 in England (a date that never was)', 'england', 1752, 9, 3),
  famous('washington', '11 February 1731 in England (which year?)', 'england', 1731, 2, 11),
  famous('newton', '25 December 1642 in England (the old calendar)', 'england', 1642, 12, 25),
  famous('russia-1917', '25 October 1917 in Russia (the old calendar)', 'soviet-russia', 1917, 10, 25),
]);
