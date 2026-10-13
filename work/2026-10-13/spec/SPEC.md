# SPEC: Historical Date Converter (tier 2, purpose: tool)

Slug `historical-date-converter`, date 2026-10-13 (Day 4). Builders: engineer (logic) and artisan (look, layout, static text); the architect integrates. Section 4 is binding; where another section seems to disagree, section 4 wins. Look and palette: DESIGN.md. Metadata draft: PROJECT.json (the page's `<title>`, h1, tagline, intro and meta description equal its `title`, `tagline`, `intro` and `description`).

## 1. Vision and the wow moment

A private, offline converter between the Julian calendar (the old one) and the Gregorian calendar (today's) that knows when each place switched, says plainly when a date never existed there, and shows every step of its working. The wow moment is the first frame: the page opens on 13 October 1582 in Rome with the answer already on screen. That date never happened. The calendar jumped from Thursday 4 October to Friday 15 October, and the month grid beside the answer draws the ten missing days as a torn gap while the weekday columns run straight through. Change the 13 to a 15 and the card turns into a real day. All arithmetic is hand-written whole-number day counting, and the page re-proves itself against known answers on demand.

## 2. Core loop and the visitor journey

Core loop: set a date and a place, read the result in both calendars, open the working, try another date.

* 10 seconds: title, tagline, intro, then the sample result (a skipped date) and the October 1582 grid with its gap. Nothing to read first.
* First minute: change the day to 15 (a real day), pick a famous date (England 1731 shows two possible years), open "Show the steps", press "Copy result".
* Tenth minute: choose "A place that is not listed" and enter a switch day, count the days between two dates across a switch (under More), run the known-answer checks, read the explanation and the limits.
* Coming back: the address bar holds the state (`#p=england&d=11&m=2&y=1731`), so a bookmark or a pasted link restores it. The page stores nothing else.

## 3. File map

Site files live in `work/2026-10-13/build/site/`. OWNERSHIP.json is the same map.

| path | owner | responsibility | approx lines | public API |
|---|---|---|---|---|
| index.html | artisan | page shell, intro, app skeleton with every id of 4.9, explainer, About panel, scripts | 300 | the ids and attributes of 4.9 |
| style.css | artisan | tokens, light and dark, layouts at 360 / 768 / 1280, calendar leaf, motion | 430 | tokens and state hooks of 4.10 |
| view.js | artisan | renders a ViewModel into the DOM; More and Steps toggles; grid pointer pick; copy flash; self-test and place-table output | 280 | mountView, renderViewModel, renderPlaceTable, renderSelfTest, flashCopied |
| engine.js | engineer | pure calendar arithmetic and the interpretation rules | 260 | createEngine and the default instance (4.3) |
| data/places.js | engineer | place table, famous dates, year rules, evidence labels | 90 | PLACES, FAMOUS |
| state.js | engineer | State shape, hash parse and format, raw field parsing | 130 | SAMPLE, parseHash, formatHash, readFields, sameState |
| report.js | engineer | every result-dependent string, steps, copy text, place-table rows | 330 | buildViewModel, formatYMD, placeById, placeTableRows |
| app.js | engineer | boot, field IO, events, hash sync, clipboard, test hooks | 230 | none (entry module) |
| selftest.js | engineer | known-answer cases, mutation guard, hash and DOM checks | 220 | sets window.__sedSelfTest |

## 4. INTERFACE CONTRACT

### 4.1 Module system and load order

ES modules only: every script is `<script type="module">`, imports are relative and include `./` and `.js` (`import { interpret } from './engine.js'`). No classic scripts, no bundler, no `eval`. At the end of `<main>` in index.html, in this order: (1) `<script type="module" src="selftest.js"></script>`, (2) `<script type="module" src="app.js"></script>`, (3) a short inline `<script type="module">` boot watchdog (4.13). Import graph, no cycles: `engine.js`, `view.js` and `data/places.js` import nothing; `state.js` imports places; `report.js` imports engine and places; `selftest.js` imports engine, state, report and places; `app.js` imports engine, state, report, places and view. Only `app.js` and `view.js` touch the DOM (selftest.js reads it in one case).

### 4.2 Shared types

```
Cal   = 'julian' | 'gregorian'
WIn   = 'auto' | 'julian' | 'gregorian'      // "read my date as"
YMD   = { year, month, day }                 // integers, month 1..12: a calendar label
Place = { id, name, short, lastJulian: YMD|null, firstGregorian: YMD|null,
          yearStart: null | { rule: 'march25', lastModernYear: number },
          yearRule, basisKind, basis }        // 4.4; lastJulian null = no known switch
State = { placeId, year, month, day, writtenIn: WIn,
          custom: YMD,                        // last Julian day of a custom place
          between: YMD|null }                 // second date of "days between"
```

### 4.3 engine.js (engineer): pure, synchronous; no DOM, no `Date`, no `Intl`, no `toLocale*`

```
export const YEAR_MIN = 1500, YEAR_MAX = 2099
export const MONTH_NAMES      // ['January', ..., 'December'], index 0 = January
export const WEEKDAY_NAMES    // ['Sunday', ..., 'Saturday'], index 0 = Sunday
export function createEngine(opts?: { centuryRule?: boolean }): Engine
```
`centuryRule:false` makes the Gregorian leap rule "every fourth year" (used only by the self-test mutation guard). The default instance's members are also exported by name: `isLeap, daysInMonth, isValidDate, toDayNumber, fromDayNumber, weekdayOf, compareYMD, offsetDays, dayNumberTerms, customPlace, interpret, monthGrid`.

```
isLeap(year, cal): boolean
daysInMonth(year, month, cal): 28..31
isValidDate(ymd, cal): boolean            // integers, month 1..12, 1 <= day <= daysInMonth
toDayNumber(ymd, cal): number             // Julian day number, no validation
fromDayNumber(jdn, cal): YMD
weekdayOf(jdn): 0..6                      // 0 = Sunday
compareYMD(a, b): -1 | 0 | 1              // tuple order year, month, day
offsetDays(jdn): number                   // toDayNumber(fromDayNumber(jdn,'gregorian'),'julian') - jdn
dayNumberTerms(ymd, cal): { a, y, m, t153, t365, t4, t100, t400, k, jdn }   // pieces of 5.1; t100 = t400 = 0 for Julian
customPlace(lastJulian: YMD): Place | null   // null unless a valid Julian date within YEAR_MIN..YEAR_MAX
interpret({ ymd, place, writtenIn }): InterpretResult    // place may be null
monthGrid({ year, month, place, calendar }): GridData    // place may be null; calendar null or a Cal
```
```
InterpretResult =
  { ok:false, code:'year-range'|'month-range'|'day-range'|'no-such-day', params:{ month?, year?, maxDays?, calendar?, leapNote? } }
| { ok:true, kind:'skipped', typed:YMD, place:Place,
    before:{ ymd, jdn, weekday }, after:{ ymd, jdn, weekday },    // last old-calendar day, first new-calendar day
    skippedCount:number, skippedFrom:YMD, skippedTo:YMD,          // Julian labels of the dropped stretch
    asGregorian: null | { jdn, weekday, julian:YMD },             // typed label read as Gregorian (null if not a valid Gregorian date)
    asJulian:    null | { jdn, weekday, gregorian:YMD } }         // typed label read as Julian (null if not a valid Julian date)
| { ok:true, kind:'day', typed:YMD, place:Place|null, calendar:Cal,
    regime:'julian'|'gregorian'|'gap'|null,   // what the place used on that label; null = no known switch
    forcedMismatch:boolean, noPlace:boolean,
    readings:Reading[] }                      // 1 or 2; readings[0] is the headline
Reading = { id:'written'|'plain', calendar:Cal, typed:YMD, modern:YMD, julian:YMD, gregorian:YMD,
            jdn:number, weekday:number, offset:number, dual:string|null }
GridData = { year, month, lead:number, days:[{ day, weekday, calendar:Cal }], gapAt:number|null, gapDays:number[] }
```
`modern` is the label in the reading's calendar with the year counted from 1 January (it differs from `typed` only for id `written`, where `modern.year = typed.year + 1`). `dual` is set only for `written` ("1731/32", "1699/1700"). `GridData.days` lists only days that exist; `gapAt` is the index in `days` before which the dropped days sat (0 = before the first day, `days.length` = after the last) and `gapDays` their day numbers in this month; both are null or empty when the month has no dropped labels. Rules: section 5.

### 4.4 data/places.js (engineer)

`export const PLACES` in this order: rome, spain, portugal, france, england, scotland, denmark-norway, soviet-russia, none, custom. `export const FAMOUS`. Exact data:

| id | name | short | lastJulian | firstGregorian | yearStart |
|---|---|---|---|---|---|
| rome | Rome and most of Italy | Rome | 1582-10-04 | 1582-10-15 | null |
| spain | Spain | Spain | 1582-10-04 | 1582-10-15 | null |
| portugal | Portugal | Portugal | 1582-10-04 | 1582-10-15 | null |
| france | France | France | 1582-12-09 | 1582-12-20 | null |
| england | England, Wales, Ireland and the colonies | England | 1752-09-02 | 1752-09-14 | march25, lastModernYear 1751 |
| scotland | Scotland | Scotland | 1752-09-02 | 1752-09-14 | march25, lastModernYear 1599 |
| denmark-norway | Denmark-Norway | Denmark-Norway | 1700-02-18 | 1700-03-01 | null |
| soviet-russia | Soviet Russia (RSFSR) | Soviet Russia | 1918-01-31 | 1918-02-14 | null |
| none | No place: just compare the calendars | (empty string) | null | null | null |
| custom | A place that is not listed | your place | null in PLACES; report.js builds it from State.custom with customPlace | derived | null |

`yearRule` (shown beside the year field): england "In England, Wales, Ireland and the colonies the year began on 25 March until 1751, and on 1 January from 1752."; scotland "In Scotland the year began on 25 March until 1599, and on 1 January from 1600 (as of 2026-10-13, per search results)."; every other place, including none and custom: "The year is counted from 1 January." `basisKind` is `confirmed` (rome, england), `mixed` (scotland), `search` (spain, portugal, france, denmark-norway, soviet-russia), null (none, custom). `basis` (the About table, exact; empty for none and custom): rome "Family Tree Magazine and the Julian day article (see Sources)."; england "The Calendar (New Style) Act 1750 and History Today (see Sources)."; scotland "Switch day: the same Act as England (see Sources). Year start in 1600: as of 2026-10-13, per search results: National Records of Scotland; Wikipedia, Dual dating."; spain and portugal "As of 2026-10-13, per search results: Wikipedia, 1582; Catholic Answers, The day the Church altered time."; france "As of 2026-10-13, per search results: Wikipedia, 1582 in France; icalendars.net, Gregorian reform: one day or another."; denmark-norway "As of 2026-10-13, per search results: Wikipedia, Adoption of the Gregorian calendar; Debian tzdata calendars file. Many Protestant German states made the same switch, but not all of them."; soviet-russia "As of 2026-10-13, per search results: Soviet History archive (Michigan State); prlib.ru; Library of Congress Law blog. Other governments of the former Russian empire switched on other days."

`FAMOUS` entries `{ id, label, state: { placeId, year, month, day, writtenIn:'auto' } }`:

| id | label | place | date |
|---|---|---|---|
| rome-1582 | 13 October 1582 in Rome (a date that never was) | rome | 1582-10-13 |
| england-1752 | 3 September 1752 in England (a date that never was) | england | 1752-09-03 |
| washington | 11 February 1731 in England (which year?) | england | 1731-02-11 |
| newton | 25 December 1642 in England (the old calendar) | england | 1642-12-25 |
| russia-1917 | 25 October 1917 in Russia (the old calendar) | soviet-russia | 1917-10-25 |

### 4.5 state.js (engineer): pure, synchronous

```
export const SAMPLE   // { placeId:'rome', year:1582, month:10, day:13, writtenIn:'auto', custom:{year:1752,month:9,day:2}, between:null }
export function parseHash(hash: string): State | null     // null = unusable (4.11)
export function formatHash(state: State): string           // '#p=rome&d=13&m=10&y=1582'
export function readFields(raw: RawFields): { state: State|null, error: null|{ code, field }, betweenError: null|string }
export function sameState(a, b): boolean                  // equality of every field (custom compared only when placeId is custom)
RawFields = { day, month, year, placeId, writtenIn, cday, cmonth, cyear, bday, bmonth, byear }   // strings read from the controls
```
`readFields` trims every string. Day `/^\d{1,2}$/` and 1..31 (else `day-format`); month `/^\d{1,2}$/` and 1..12 (else `month-format`); year `/^\d{1,4}$/` (else `year-format`) and 1500..2099 (else `year-range`); `\d` is ASCII only. `placeId` must be in PLACES (else `place-format`); a `writtenIn` outside the three values counts as `auto`. With `placeId` `custom` the `c*` fields follow the same rules and fail as `custom-format` (field `custom`). The `b*` fields all empty give `between:null`; if any is filled all three must be valid, else `between:null` and `betweenError:'between-format'` (the main result still shows). Any main error gives `state:null`.

### 4.6 report.js (engineer): pure, synchronous; builds every string that depends on a result

```
export function placeById(id): Place | null
export function formatYMD(ymd, opts?: { weekday?: number, dual?: string|null }): string   // 'Thursday 4 October 1582'; with dual: '11 February 1731/32'
export function buildViewModel(input: { state: State|null, error: null|{code,field}, betweenError: null|string, sample: boolean, placeId: string }): ViewModel
export function placeTableRows(): PlaceRow[]
PlaceRow = { place, lastOld, firstNew, skipped, basis, basisKind }   // strings: name; 'Thursday 4 October 1582'; 'Friday 15 October 1582'; '10 days (5 to 14 October 1582)' (full dates when the stretch crosses a month); basis; basisKind. The 8 real places only.
```
`placeId` is the raw place control value (so an error ViewModel still knows `showCustom`). With `placeId` `custom` report.js builds the place with `customPlace(state.custom)`; null gives the `custom-no-such-day` error. `buildViewModel` never throws (an internal failure returns the `internal` error ViewModel).

```
ViewModel = {
  tone: 'ok'|'skip'|'error',   badge: string,   sample: boolean,
  headline: string,            detail: string[],              // 0..2 sentences
  rows: [{ label, value, cal: 'julian'|'gregorian'|null }],   // 0..2
  yearBox: null | { title: string, rows: [{ label, value }] },
  grid: null | GridVM,         steps: string[],               // [] when tone is error
  caption: string,             copyText: string,              // '' when tone is error
  announce: string,            yearRule: string,              // '' (error) = leave the text unchanged
  showCustom: boolean,         customLine: string,
  betweenLine: string,         betweenTone: 'ok'|'error'|'none',
  openMore: boolean                                           // true when writtenIn is not auto or between is set: the view opens More (never closes it)
}
GridVM = {
  title, subtitle, label: string,
  weekdays: ['Su','Mo','Tu','We','Th','Fr','Sa'], weekdayNames: [full names],    // Sunday first
  lead: number,                                // empty cells before days[0]
  days: [{ day, weekday }],                    // existing days only
  focus: number|null,                          // the typed day when it exists
  gapAt: number|null,                          // the gap sits between days[gapAt-1] and days[gapAt]
  gap: null | { days: number[], text: string, focus: number|null }    // focus = the typed day when it is a dropped one
}
```
Text templates, exact (`D(x)` = `formatYMD(x)`; `Wd` = weekday name; "old" = "the old calendar" for Julian, "new" = "today's calendar" for Gregorian):

| case | field | text |
|---|---|---|
| skipped | badge | Never existed there |
| skipped | headline | `D(typed)` never happened in `short`. |
| skipped | detail[0] | The calendar jumped from `D(before, Wd)` to `D(after, Wd)`, skipping `skippedCount` days. |
| skipped | rows[0] (only if asGregorian; cal gregorian) | label "If you meant today's calendar"; value "Counting back, that day would have been a `Wd`, called `D(asGregorian.julian)` on the old calendar." |
| skipped | rows[1] (only if asJulian; cal julian) | label "If you meant the old calendar"; value "It did exist, as a `Wd`, called `D(asJulian.gregorian)` on today's calendar." |
| day | badge | A real day |
| day | headline | `formatYMD(r.modern, {dual})` on `calPhrase` is the same day as `formatYMD(other, {weekday})` on `otherPhrase`. (`r` = readings[0]; `other` = r.gregorian for a Julian reading, r.julian for a Gregorian one) |
| day | detail[0] | place with a switch: regime julian "`short` was still using the old calendar then; it switched after `D(lastJulian, Wd)`."; regime gregorian "`short` was using today's calendar then; it had switched on `D(firstGregorian, Wd)`."; forcedMismatch "`short` was not using that calendar then (`why`); the date is shown as you asked." with `why` = "it was still on the old calendar", "it had already switched" or "it skipped this date". No switch and writtenIn auto: "No place is chosen, so the date is read as an old-calendar date. Change 'Read my date as' under More to read it as a today's-calendar date." No switch and forced: none |
| day | detail[next] | On this day the two calendars' names differed by `offset` days. |
| day | rows | label "Old calendar (Julian)", value `formatYMD(r.julian, {weekday, dual})`, cal julian; label "Today's calendar (Gregorian)", value `formatYMD(r.gregorian, {weekday})`, cal gregorian |
| day, 2 readings | yearBox.title | Which year? `short` began the year on 25 March until `lastModernYear`, so a date from 1 January to 24 March can be read two ways. |
| day, 2 readings | yearBox.rows | label "As written then (the year began on 25 March)", value "`formatYMD(written.modern,{dual})` is `formatYMD(written.gregorian,{weekday})` on today's calendar."; label "If your source counted years from 1 January", value "`D(plain.modern)` is `formatYMD(plain.gregorian,{weekday})` on today's calendar." |
| error | badge, headline, announce | Check the date; the message of section 7 |
| sample | caption | Sample, built on 13 October 2026: one of the ten days Rome never had in 1582. (else empty) |
| custom | customLine | After `D(lastJulian, Wd)` the next day was `D(firstGregorian, Wd)`. `n` days were skipped. (only when `showCustom` and valid) |
| between | betweenLine | ok: "`D(second)` is `n` days later, counting real days only; skipped dates do not count." ("earlier" when negative; "1 day" when n is 1; "Both dates are the same day." when 0). errors: "Second date: " plus the no-such-day text; "Second date: `D(typed)` never happened in `short`. Pick a day that did."; "Count from a real day: fix the first date."; the `between-format` text |

Other fields: `announce` = headline, a space, detail[0]; `copyText` = headline, detail lines, "label: value" for every row and yearBox row, then "Not genealogical or legal proof. Historical Date Converter, Sonnet Every Day.", joined by newlines. GridVM `title` is "October 1582" (dual form for a `written` reading: "February 1731/32"); `subtitle` is "Old calendar (Julian)", "Today's calendar (Gregorian)" or, when both occur in the month, "Old calendar up to the 4th, today's calendar from the 15th"; `gap.text` "10 days skipped here: 5 to 14 October" ("1 day skipped here: 5 October"); `label` spells the grid out, for example "October 1582. Days 1 to 4, then 15 to 31. The days 5 to 14 October never happened in Rome."

Steps (strings; `formula` = "`day` + `t153` + `t365` + `t4` - `k`" for Julian, "`day` + `t153` + `t365` + `t4` - `t100` + `t400` - `k`" for Gregorian, from `dayNumberTerms`; the prefix "a = `a`, y = `y`, m = `m`; " goes on the first formula line only). Skipped: (1) "You typed `D(typed)` for `short`." (2) "`short` used the old calendar up to `D(before, Wd)` and today's calendar from `D(after, Wd)`." (3) "Day numbers (a plain count of days): `D(before)` is day `jdn` and `D(after)` is day `jdn`. The count has no gap, so no real day was lost; the `n` names from `range` were skipped." (4) "Your date falls inside that stretch, so no day in `short` carried the name `D(typed)`." (5, if asGregorian) "Counting back on today's calendar: `D(typed)` is day `jdn` (`formula`), and (`jdn` + 1) mod 7 = `r`, a `Wd`. The old calendar called that day `D(julian)`." (6, if asJulian) "Read as an old-calendar date: `D(typed)` is day `jdn` (`formula`), and (`jdn` + 1) mod 7 = `r`, a `Wd`. Today's calendar calls that day `D(gregorian)`." Real day: (1) "You typed `D(typed)` for `place name`." (just "You typed `D(typed)`." with no place; add " 'Read my date as' was set to Julian." when forced); (2) why that calendar: "`short` was still on the old calendar then (it switched after `D(lastJulian, Wd)`), so the date is read as a Julian date." or the Gregorian twin, "You chose to read it as a `Julian|Gregorian` date.", "No place is chosen, so it is read as a Julian date."; (3, `written` reading only) "Year: `short` began the year on 25 March, so `Month` `typed.year` belongs to the year `modern.year` by today's count (written `dual`). The second reading counts the year from 1 January instead."; (4) "Day number: `formula` = `jdn`." with the prefix; (5) "The same day on `otherPhrase`: day number `jdn` is `D(other)`."; (6) "Weekday: (`jdn` + 1) mod 7 = `r`, a `Wd` (0 is Sunday)."; (7) "On this day the two calendars' names differed by `offset` days."; (8, place with a switch) "`short`'s switch kept the count continuous: day number `jdnLast` (`D(lastJulian)`) is followed by day number `jdnFirst` (`D(firstGregorian)`), and `n` names were skipped."

Golden ViewModel for `SAMPLE` with `sample:true` (pinned by the self-test; `days` has 21 entries, 1 to 4 then 15 to 31, weekdays 1 2 3 4 5 6 0 1 2 3 4 5 6 0 ...):

```
tone "skip"; badge "Never existed there"; sample true; openMore false
headline "13 October 1582 never happened in Rome."
detail ["The calendar jumped from Thursday 4 October 1582 to Friday 15 October 1582, skipping 10 days."]
rows [ {label "If you meant today's calendar", value "Counting back, that day would have been a Wednesday, called 3 October 1582 on the old calendar.", cal "gregorian"},
       {label "If you meant the old calendar", value "It did exist, as a Saturday, called 23 October 1582 on today's calendar.", cal "julian"} ]
yearBox null; yearRule "The year is counted from 1 January."; showCustom false; customLine ""; betweenLine ""; betweenTone "none"
caption "Sample, built on 13 October 2026: one of the ten days Rome never had in 1582."
grid { title "October 1582", subtitle "Old calendar up to the 4th, today's calendar from the 15th", lead 1, focus null, gapAt 4,
       gap { days [5,6,7,8,9,10,11,12,13,14], text "10 days skipped here: 5 to 14 October", focus 13 } }
steps ["You typed 13 October 1582 for Rome.",
  "Rome used the old calendar up to Thursday 4 October 1582 and today's calendar from Friday 15 October 1582.",
  "Day numbers (a plain count of days): 4 October 1582 is day 2299160 and 15 October 1582 is day 2299161. The count has no gap, so no real day was lost; the 10 names from 5 to 14 October were skipped.",
  "Your date falls inside that stretch, so no day in Rome carried the name 13 October 1582.",
  "Counting back on today's calendar: 13 October 1582 is day 2299159 (a = 0, y = 6382, m = 7; 13 + 214 + 2329430 + 1595 - 63 + 15 - 32045), and (2299159 + 1) mod 7 = 3, a Wednesday. The old calendar called that day 3 October 1582.",
  "Read as an old-calendar date: 13 October 1582 is day 2299169 (13 + 214 + 2329430 + 1595 - 32083), and (2299169 + 1) mod 7 = 6, a Saturday. Today's calendar calls that day 23 October 1582."]
```
Golden for `england 1731-02-11 auto`: headline "11 February 1731/32 on the old calendar is the same day as Friday 22 February 1732 on today's calendar."; rows "Old calendar (Julian)": "Friday 11 February 1731/32" and "Today's calendar (Gregorian)": "Friday 22 February 1732"; yearBox title "Which year? England began the year on 25 March until 1751, so a date from 1 January to 24 March can be read two ways.", its row values "11 February 1731/32 is Friday 22 February 1732 on today's calendar." and "11 February 1731 is Thursday 22 February 1731 on today's calendar."; grid title "February 1731/32", subtitle "Old calendar (Julian)", focus 11, 29 days; last step "Day number: a = 1, y = 6531, m = 11; 11 + 337 + 2383815 + 1632 - 32083 = 2353712."

### 4.7 view.js (artisan): the only writer of output regions; imports nothing

```
export function mountView(hooks: { onPickDay: (day: number) => void }): void    // once: wires More, Steps, grid pointer pick, Escape
export function renderViewModel(vm: ViewModel, opts?: { animate?: boolean }): void
export function renderPlaceTable(rows: PlaceRow[]): void       // fills #place-table tbody; basisKind search or mixed rows get class is-search
export function renderSelfTest(res: { ok, total, passed, cases:[{ name, ok, detail }] } | null): void
export function flashCopied(ok: boolean, what: 'result'|'link'): void
```
All synchronous; none throws (a missing node or field is skipped). VM strings are written with `textContent` only, never `innerHTML`. `renderViewModel` sets `#result[data-tone]` and `[data-sample]`, toggles `hidden` on `#result-sample`, `#year-box`, `#custom-box`, disables `#btn-copy` when `copyText` is empty and `#btn-steps` when `steps` is empty, writes `#live` with `announce`, writes `#year-rule` unless `yearRule` is empty, opens More when `openMore`, and keeps the Steps and More open states across renders. The grid is a `table` inside `#grid-body` whose accessible name is `grid.label`; `weekdayNames` feed the `abbr` titles of the header cells; `grid-gap` shows `gap.text` plus one ghost chip per `gap.days` entry (the `gap.focus` chip marked). `opts.animate` is false on the first render and on hash changes; the view also honours `prefers-reduced-motion`. `renderSelfTest` prints "All N checks passed." or "P of N checks passed." plus one line per failing case (name and detail), or "The checks could not run." for null. `flashCopied` shows "Copied." (result), "Link copied." (link) or "Could not copy. Select the text and copy it yourself." in `#copy-status` for 2.5 s.

### 4.8 app.js (engineer): entry module, no exports

Owns the `.value` of every form control, the hash, the clipboard and the debounce. Calls view.js; never writes into output regions. Listeners: `input` on text fields (350 ms debounce), `change` on selects (immediate), Enter or blur flushes, `submit` on `#form` (preventDefault), ArrowUp/ArrowDown on numeric text fields, click on `#btn-copy` (copies `copyText`), `#btn-link` (copies `location.href`), `#btn-selftest` (runs `window.__sedSelfTest()` and passes the result to `renderSelfTest`), click on any `[data-famous]` element (delegated on `document`) and a `change` on `#f-famous` (its empty option does nothing): set the state from FAMOUS, write the fields, render with animate true; from the explainer also `#app.scrollIntoView()` (no smooth scrolling under reduced motion). `onPickDay(day)` writes the day into `#f-day` and applies at once. The hash is rewritten with `history.replaceState` after each change; `hashchange` re-parses it. `#f-famous` shows the matching FAMOUS id when the state equals one, else "". The `sample` flag is true iff the state equals SAMPLE and the visitor has edited no control since the page loaded or the hash last changed. After every render: `document.dispatchEvent(new CustomEvent('app:rendered', { detail: { tone, hash } }))`; nothing in the build listens (QA hook). Window hooks: `window.__sedReady = true` after the first render; `window.__sedThumbReady` (a Promise resolved two animation frames after the first render); `window.__sedApp = { getState(), setState(partial), getViewModel() }` (`setState` merges the given fields into the state, writes the controls and renders).

### 4.9 DOM skeleton (the ids are the contract; classes and layout are artisan-private)

Static elements are created by artisan in index.html. "App" = `.value` written by app.js; "View" = content written by view.js. The result card holds a top toolbar (badge, Sample tag, Copy result, Show the steps) so both buttons stay on screen.

| id | element | created by | written by | notes |
|---|---|---|---|---|
| app | section.hdc-app | artisan | none | wraps form and output; aria-label "Date converter" |
| form | form, novalidate, autocomplete off | artisan | none | |
| f-day | input text, inputmode numeric, label "Day" | artisan | App | no maxlength (pasted text must arrive whole) |
| f-month | select, label "Month" | artisan | App | options 1..12 added by app.js |
| f-year | input text, inputmode numeric, label "Year (as written)" | artisan | App | |
| year-rule | p | artisan | View | `vm.yearRule`, always visible beside the year field |
| f-place | select, label "Place" | artisan | App | options added by app.js (value = place id) |
| custom-box | div, hidden | artisan | View toggles hidden | holds c-day, c-month, c-year, c-line |
| c-day, c-year | input text numeric | artisan | App | labels "Last day on the old calendar: day" and "year" |
| c-month | select | artisan | App | options added by app.js |
| c-line | p | artisan | View | `vm.customLine` |
| f-famous | select, label "Try a famous date" | artisan | App | first option value "" text "Try a famous date..."; app.js adds the five FAMOUS options |
| btn-more | button, aria-expanded, aria-controls more-panel | artisan | View | "More options" / "Fewer options" |
| more-panel | div, hidden | artisan | View | holds f-written, b-day, b-month, b-year, b-line, btn-link, btn-selftest, selftest-out |
| f-written | select, label "Read my date as" | artisan | App | static options auto "Work it out from the place", julian "Julian (old calendar)", gregorian "Gregorian (today's calendar)" |
| b-day, b-year | input text numeric | artisan | App | labels "Count the days to another date: day" and "year" |
| b-month | select | artisan | App | app.js adds option value "" text "Month", then 1..12 |
| b-line | p | artisan | View | `vm.betweenLine`; attribute `data-tone` from `vm.betweenTone` |
| btn-link | button | artisan | App (click) | "Copy link to this date" |
| btn-selftest | button | artisan | App (click) | "Check this tool against known answers" |
| selftest-out | div, aria-live polite | artisan | View | initial text "Not run yet." |
| result | div[data-sed-result] | artisan | View | attributes `data-tone`, `data-sample`; aria-live off; reserve a min-height |
| result-badge | span | artisan | View | |
| result-sample | span, static text "Sample" | artisan | View toggles hidden | |
| btn-copy | button | artisan | App (click) | "Copy result" |
| btn-steps | button, aria-expanded, aria-controls steps-panel | artisan | View | "Show the steps" / "Hide the steps" |
| copy-status | span, aria-live polite | artisan | View | |
| result-headline | p | artisan | View | initial static text "Loading the converter..." |
| result-detail | div | artisan | View | one `p` per `vm.detail` entry |
| result-rows | dl | artisan | View | `dt`/`dd` pairs; each `dd` carries `data-cal` |
| year-box | div, hidden | artisan | View | children year-box-title (p) and year-box-rows (dl) |
| grid | figure inside #result | artisan | View | children grid-title (figcaption), grid-sub (p), grid-body (div holding a table), grid-gap (div: text and ghost chips) |
| result-caption | p | artisan | View | `vm.caption` |
| limits-note | p | artisan | none | static: "One switch day per place. Not genealogical or legal proof. Read the limits." with a link to #limits |
| steps-panel | div, hidden | artisan | View | child steps-list (ol, one li per step) |
| live | div.sed-visually-hidden, role status | artisan | View | `vm.announce` |
| place-table | table in the About panel | artisan | View | static thead; View fills tbody |

Required ids, for the self-test DOM check (49): `app form f-day f-month f-year year-rule f-place custom-box c-day c-month c-year c-line f-famous btn-more more-panel f-written b-day b-month b-year b-line btn-link btn-selftest selftest-out result result-badge result-sample btn-copy btn-steps copy-status result-headline result-detail result-rows year-box year-box-title year-box-rows grid grid-title grid-sub grid-body grid-gap result-caption limits-note steps-panel steps-list live place-table explainer explainer-title limits`. In the grid every existing day is an element with `data-day="N"` (the typed day also `data-focus="true"`); skipped days are not elements. Explainer buttons carry `data-famous="<id>"`.

### 4.10 CSS contract (artisan, style.css)

Shell tokens keep their names (`--bg --surface --fg --muted --border --accent --accent-fg --ring --shadow --radius --gutter --font --font-mono`); new tokens `--julian --julian-bg --gap --gap-bg --greg-bg --font-serif`; values in DESIGN.md, light on `:root`, dark under `@media (prefers-color-scheme: dark)`. State hooks: `#result[data-tone="ok"|"skip"|"error"]`, `#result[data-sample="true"|"false"]`, and `[hidden] { display: none !important; }` must be in style.css. Nobody but artisan depends on a class name.

### 4.11 URL hash grammar (state.js parses and formats; app.js applies)

`#p=<place id>&d=<1..31>&m=<1..12>&y=<1500..2099>`, optional `&w=<auto|julian|gregorian>` (omitted when auto), `&cd=&cm=&cy=` (custom last Julian day; required when `p=custom`), `&bd=&bm=&by=` (second date; all three or none). Output order: p d m y w cd cm cy bd bm by. Parse strictly: at most 160 characters; known keys only, each at most once; every value matches `/^[a-z0-9-]{1,16}$/`; `p` is a PLACES id; numbers match `/^\d{1,4}$/` and are clamped into their range; `w` is one of the three. Any violation, missing required key or unknown key gives `null` and the page shows the sample. An empty hash shows the sample and leaves the address untouched until the visitor changes something. Values reach the DOM only as `.value` or `textContent`.

### 4.12 Storage and network

None. No `localStorage`, `sessionStorage`, cookie or IndexedDB; no `fetch`, `XMLHttpRequest` or other request; project.json `network` is `[]`; the CSP of the page shell stays byte for byte unchanged.

### 4.13 Boot order and lifecycle

1. HTML parses; the static intro, explainer and skeleton already show. 2. `selftest.js` runs: defines `window.__sedSelfTest`, touches no DOM. 3. `app.js` runs: fills the selects (months, places, famous, `b-month`), `mountView({ onPickDay })`, `renderPlaceTable(placeTableRows())`, reads `parseHash(location.hash) ?? SAMPLE`, writes the fields, renders (animate false), sets `__sedReady` and `__sedThumbReady`, then attaches the listeners. 4. The inline module watchdog: after 5000 ms, if `window.__sedReady` is not `true`, it writes "The converter could not start. Reload the page, or try a current browser." into `#result-headline`. No pause or reset exists; every change is one pure pass: fields, `readFields`, `buildViewModel`, `renderViewModel`, hash update, `app:rendered`.

### 4.14 Error contract

Nothing throws on user input: `interpret` returns `{ ok:false, code }`, `readFields` returns an error object, `buildViewModel` always returns a ViewModel, view.js skips what is missing, app.js wraps every listener in try/catch. No `console.*` output. Codes become the exact messages of section 7. A network request, any storage, or `Date` outside selftest.js is a contract violation.

## 5. Algorithms and numbers (engineer)

5.1 Day number. `a = floor((14 - month) / 12); y = year + 4800 - a; m = month + 12a - 3`. Julian: `JDN = day + floor((153m + 2) / 5) + 365y + floor(y / 4) - 32083`. Gregorian: `JDN = day + floor((153m + 2) / 5) + 365y + floor(y / 4) - floor(y / 100) + floor(y / 400) - 32045`. Inverse: `f = J + 1401` (Gregorian: `f = J + 1401 + floor(floor((4J + 274277) / 146097) * 3 / 4) - 38`); `e = 4f + 3; g = floor((e mod 1461) / 4); h = 5g + 2; day = floor((h mod 153) / 5) + 1; month = ((floor(h / 153) + 2) mod 12) + 1; year = floor(e / 1461) - 4716 + floor((12 + 2 - month) / 12)`. Every operand is positive for years 1400 to 2200, so `Math.floor` and `%` are exact. Anchors: Julian 4 October 1582 = 2299160, Gregorian 15 October 1582 = 2299161, Gregorian 1 January 2000 = 2451545. (These formulas were checked by node -e against an independent day-by-day walk and against the Gregorian arithmetic of `Date`, with no mismatch from 1400 to 2200.)

5.2 Weekday: `(JDN + 1) mod 7`, 0 = Sunday (2299160 gives 4, Thursday).

5.3 Leap years. Julian: `year mod 4 = 0`. Gregorian: `(year mod 4 = 0 and year mod 100 != 0) or year mod 400 = 0`; 400 Gregorian years hold 97 leap years and 146097 days (average 365.2425); `daysInMonth` follows.

5.4 Offset: `offsetDays(J)` is how far the Gregorian name is ahead of the Julian one. It is 10 from Gregorian 1 March 1500 to 28 February 1700 (9 before 1 March 1500), 11 from 1 March 1700, 12 from 1 March 1800, 13 from 1 March 1900, 14 from 1 March 2100.

5.5 A place's switch pair is valid iff `toDayNumber(firstGregorian,'gregorian') = toDayNumber(lastJulian,'julian') + 1`. `skippedCount = offsetDays(toDayNumber(firstGregorian,'gregorian'))` (10, 10, 10, 10, 11, 11, 11, 13 for the eight rows); `skippedFrom = fromDayNumber(jdnLast + 1,'julian')`, `skippedTo = fromDayNumber(jdnLast + skippedCount,'julian')`. A custom place: `firstGregorian = fromDayNumber(toDayNumber(lastJulian,'julian') + 1,'gregorian')`.

5.6 `interpret`, in this order. (1) Range: month 1..12 else `month-range`; day 1..31 else `day-range`; year within YEAR_MIN..YEAR_MAX else `year-range`. (2) Reading calendar `cal`: if `writtenIn` is julian or gregorian use it (forced). Otherwise, for a place with a switch, compare the typed label as a tuple, before any leap-day check: `<= lastJulian` gives julian; `>= firstGregorian` gives gregorian; anything between them is dropped: return the `skipped` result if the label is a valid date on the Julian or on the Gregorian calendar (this includes 29 February 1700 in Denmark-Norway), else `no-such-day` (30 February, 31 April; `params.maxDays` the larger of the two month lengths, `calendar` null). With no switch (`place` null or `lastJulian` null) use julian and set `noPlace`. (3) `regime` = what the place used on that label (julian, gregorian or `gap`); `forcedMismatch` = forced and `regime` differs from `cal`. (4) Readings: `plain` has `modern = typed`; a `written` reading goes first when `cal` is julian, the place has `yearStart`, the typed date lies from 1 January to 24 March and `typed.year + 1 <= lastModernYear`: `modern.year = typed.year + 1` and `dual` as in 5.9. Keep only readings where `isValidDate(modern, cal)`. If none is valid return `no-such-day` with `params`: `month, year` (of the plain reading), `maxDays = daysInMonth(year, month, cal)`, `calendar = cal` when the two calendars give that month different lengths (else null), `leapNote` true for 29 February when cal is gregorian and the Julian calendar has the day that year. (5) For each reading: `jdn = toDayNumber(modern, cal)`, the label on the other calendar via `fromDayNumber`, `weekday`, `offset`.

5.7 `skipped` result: `before = lastJulian` and `after = firstGregorian` with their day numbers and weekdays; `asGregorian` when the typed label is a valid Gregorian date (`jdn = toDayNumber(typed,'gregorian')`, `julian = fromDayNumber(jdn,'julian')`); `asJulian` when it is a valid Julian date.

5.8 `monthGrid`: with `calendar` given, a plain month in that calendar and no gap. Otherwise, with a switch: for `day = 1 .. max(daysInMonth julian, gregorian)` the label exists as julian if it is `<= lastJulian` and a valid Julian date, as gregorian if it is `>= firstGregorian` and a valid Gregorian date; a label that does not exist but is valid on either calendar and lies strictly between the two switch days is dropped (`gapDays`; `gapAt` is the length of `days` at the first one); any other label (31 April, 29 February 1900 in a Gregorian place) is simply absent. `lead` = weekday of `days[0]`. Without a switch use Julian. Expected: October 1582 in Rome lead 1, days 1 to 4 and 15 to 31, `gapAt` 4; September 1752 in England lead 2, days 1, 2, 14 to 30, `gapAt` 2 (the layout of the old Unix `cal` output); February 1918 in Soviet Russia `gapAt` 0; February 1700 in Denmark-Norway `gapAt` 18, the number of days.

5.9 Dual year: `typed.year`, a slash, then the last two digits of `modern.year`; when the hundreds differ the full second year ("1699/1700"). Days between: `jdn(second) - jdn(first)` from each date's `readings[0]` with the same place and `writtenIn`; the second date must be a real day (England 1 September 1752 to 15 September 1752 is 3). Grid for a result: the typed month with the reading's `modern.year`, `focus = typed.day`; an automatic reading uses the place's regime, a forced reading a plain month in that calendar, no place Julian.

## 6. Input model

Keyboard: Tab order is source order: Day, Month, Year, Place, [custom boxes when shown], Famous, More options, [More panel controls when open], Copy result, Show the steps. Enter in a text field applies at once. ArrowUp/ArrowDown in a numeric text field change the value by 1 (Shift: 10 on a year), clamped to 1..31 and 1500..2099, and apply at once (a box that is empty or not a number first becomes the SAMPLE value for that box). Escape inside the More panel closes it and returns focus to `#btn-more`. Space and Enter work on every button. No other shortcuts. Pointer and touch: click or tap a day in the grid to set the Day field, month and year unchanged (pointer only, no focus stop; the Day field is the keyboard path); selects use the native picker; nothing depends on hover; no gestures. Tap targets are at least 44 px.

## 7. States

* Loading: `#result-headline` reads "Loading the converter..." until the first render (under 100 ms).
* Empty: the output is never empty. The self-test panel reads "Not run yet."; the days-between line is hidden while its boxes are empty.
* Error: shown in the result card (tone error, no grid, no rows, Copy and Steps disabled). Messages, exact:

| code | message |
|---|---|
| day-format, day-range | Type the day as a whole number from 1 to 31, using only the digits 0 to 9. A date such as 13/10/1582 goes in three boxes: day, month, year. |
| month-format, month-range | Pick a month from the list. |
| year-format | Type the year as digits, for example 1582. |
| year-range | This page covers the years 1500 to 2099. |
| place-format | Pick a place from the list. |
| no-such-day | `Month` `year` has only `n` days`[ on the Julian or Gregorian calendar]`.`[ 1900 was a leap year on the Julian calendar only.]` (the bracketed parts only when `params.calendar` or `params.leapNote` are set; the year is `params.year`) |
| custom-format | Last day on the old calendar: type a real date with digits only, for example 2 September 1752. |
| custom-no-such-day | "Last day on the old calendar: " plus the no-such-day text for the Julian calendar |
| between-format | Second date: type a day, a month and a year using digits, or clear the three boxes. (days-between line only) |
| internal | Something went wrong with that date. Try another one. |

* Success: tone ok (a real day) or tone skip (a dropped date); both have a card, a grid and steps.
* Failure: boot failure shows the watchdog text; a failed clipboard write shows "Could not copy. Select the text and copy it yourself."; a failed self-test run shows "The checks could not run."

## 8. The About & making-of panel and the FACTS POLICY

Policy: a number, date, rule or name appears as plain fact only when its `research.facts` source is `verified:true`; anything else appears as "as of 2026-10-13, per <source title>" or not at all. Nothing on the page is simulated, estimated or fictional: the sample is a real historical date, weekdays and day numbers are computed. The panel is the shell's `<details class="sed-about">`; artisan writes this static text, exactly:

1. Making of (`p.sed-making-of`): the `makingOf` paragraph of PROJECT.json, word for word.
2. "Sources" (`ul.sed-sources`): the eight entries of PROJECT.json `sources`, in that order (title as link text), each followed by its sentence and "Seen in search results, as of 2026-10-13.": (1) day number 2299161 is 15 October 1582 Gregorian, with no gap in the count; (2) Wednesday 2 September 1752 was followed by Thursday 14 September, and New Year's Day moved from 25 March to 1 January; (3) the Act's own text; (4) Catholic countries went from 4 to 15 October 1582; (5) the Gregorian leap rule; (6) a second source for the leap rule; (7) the story of 1752 calendar riots is largely a later myth; (8) the slogan is tied to a banner in a 1755 painting about an election.
3. "Also seen in search results" (a plain list, no links), introduced by "Named by the review step of this build as seen in search results on 2026-10-13; the team did not open these pages and keeps no links.": Spain and Portugal, 1582: Wikipedia "1582"; Catholic Answers "The day the Church altered time". France, 1582: Wikipedia "1582 in France"; icalendars.net "Gregorian reform: one day or another". Denmark-Norway, 1700: Wikipedia "Adoption of the Gregorian calendar"; Debian tzdata "calendars" file. Soviet Russia, 1918: Soviet History archive (Michigan State); prlib.ru; Library of Congress Law blog. Scotland's new year in 1600: National Records of Scotland; Wikipedia "Dual dating". The 1582 date pair: Britannica entry on Gregory XIII. Offsets of 10 to 13 days: Wikipedia "Conversion between Julian and Gregorian calendars". Famous dates: 11 February 1731 as then written, the birth date of George Washington (National Park Service article; Philadelphia Inquirer); 25 December 1642, the birth date of Isaac Newton (Newton Project, Oxford; Wikipedia "Early life of Isaac Newton"); 25 October 1917, the date of the Russian October Revolution (Wikipedia "October Revolution"; Cambridge University Library exhibition). The page computes the conversions of these dates itself; only the stories attached to them rest on search results.
4. "Switch days used" (`#place-table`, caption "Switch days used by this page, as of 2026-10-13"): columns Place, Last day on the old calendar, First day on today's calendar, Skipped, Basis; rows from `placeTableRows()`, never typed by hand.
5. "What is estimated or simulated": "Nothing is simulated. Day numbers and weekdays are computed. Rows marked search results have not been checked against an opened page."
6. "Wikipedia text is licensed CC BY-SA; this page links to articles and copies none of their wording."

## 9. Acceptance criteria and budgets

Tier minimum: 350 lines of own HTML, CSS and JS in total (hard; `data/places.js` does not count; the validator skips blank lines, comments and lines over 400 characters, so wrap prose at about 100 characters). Target about 1,100 honest lines, no padding. Budgets: first render under 100 ms after parse; input to repaint under 50 ms (debounce aside); all files together under 250 KB; no long task over 50 ms; no layout shift after boot; the self-test under 2 s.

Engineer (at least 400 lines among engine, report, state, app and selftest):
- [ ] engine.js passes the round trip for every day 1500-01-01 to 2099-12-31 in both calendars, uses no `Date`, `Intl` or `toLocale*`, and is the only place calendar arithmetic lives.
- [ ] `buildViewModel` reproduces the golden ViewModels of 4.6 string for string; `readFields`, `parseHash` and `formatHash` follow 4.5 and 4.11.
- [ ] app.js: one render path, debounce, hash sync, clipboard with fallback, `__sedReady`, `__sedThumbReady`, `__sedApp`; no console output; no storage.
- [ ] selftest.js: all 29 cases of section 14, passing, under 2 s; the mutation guard fails at least 3 vectors; no expected value is ever edited to make a case pass.
- [ ] Every string reaching the DOM comes from report.js; no HTML is built from user input.

Artisan (at least 350 lines among index.html, style.css and view.js):
- [ ] index.html starts from `ops/templates/page-shell.html`: CSP, lang, viewport, skip link, back link, About panel and noscript intact; `<title>`, h1, tagline, meta description and day label ("Day 4 · 2026-10-13") as in PROJECT.json; the intro equals PROJECT.json `intro` exactly; the explainer is pasted from section 13 as static markup; every id of 4.9 exists; scripts in the order of 4.1 with the watchdog; the shell's instruction comment and every `data-sed-placeholder` element are gone.
- [ ] view.js renders both golden ViewModels, ignores unknown or missing fields, never uses `innerHTML` with VM text.
- [ ] Control budget: exactly eight visible controls in the first 1280x800 viewport (section 13).
- [ ] Layout: at 1280x650, 1366x768 and 390x844 the Day, Month, Year and Place boxes, the toolbar buttons and the first two lines of the result are on screen without scrolling; intro bottom at most 420 px (desktop) and 560 px (phone); the result card starts above 560 px (desktop) and 844 px (phone); no overlap, no inner scroller, no horizontal scroll at 320 px. Test with a Playwright resize script, not only the two sizes browser-check shoots.
- [ ] Light and dark, visible focus on every control, AA contrast, reduced motion honoured, 44 px targets, the grid readable from 320 px.

## 10. Cut-list (drop in this order if behind)

1. Leaf-flip and tear animation (keep a static tear). 2. Pointer pick on grid days. 3. Days between (`b-*`, `betweenLine`). 4. Copy link (`btn-link`). 5. Famous dates beyond rome-1582, england-1752 and washington. 6. The `none` place. 7. Formula text in the steps (keep the plain sentences). 8. The custom place (last resort; then also remove `custom-box` and the `custom` option; the limits text still tells the visitor to look the place up elsewhere).

Must survive: engine.js and selftest.js; the sample first frame with the grid; the result card with steps; the year rule and the year box; the intro, the explainer and the limits; the About panel with its sources; the hash; Copy result.

## 11. Answers to winnerNotes.mustFixInSpec

1. Region rows: accepted. Exactly the rows of 4.4 (Rome, Spain, Portugal, France, England with Wales, Ireland and the colonies, Scotland, Denmark-Norway, Soviet Russia), worded as asked ("Rome and most of Italy", no decree dates, "not all of them", other Russian governments on other days). The sources behind France, Denmark-Norway, Russia, Spain and Portugal are search results, not dossier facts, so those rows carry "as of 2026-10-13, per search results" in the About table.
2. Left out: accepted. The excluded places are named in the limits (section 13).
3. Custom switch: accepted with changes; see Declined.
4. Year convention: accepted. The rule is printed beside the year field; both readings are shown, as written first; Scotland has its own rule; Washington is a self-test vector (row 9).
5. Engine rules: accepted as written. One refinement: a label between the two switch days is dropped only if it is a valid date on one of the two calendars; 30 February stays an error.
6. First frame: accepted: hard-coded sample, no clock, dated caption, the wording of 4.6 (see Declined for one phrase), the 1280x650, 1366x768 and 390x844 checks of section 9.
7. One picture: accepted: Sunday-first grid; both expected grids are self-test rows 21 and 22.
8. Self-test: accepted: 16 oracle rows, 8 labelled computed rows, a mutation guard, hash and DOM checks.
9. Control budget: accepted: eight controls, the rest under More (section 13).
10. Jargon: accepted: the intro glosses only Julian and Gregorian; day number and proleptic are defined in the explainer and appear on the first screen only inside the steps.
11. Allowed facts: accepted; the offsets are labelled computed, Scotland's 1600 carries the "as of" label.
12. Copy guardrails: accepted: no paywall, price, parity or product wording; neutral about churches; the October 1917 pair has no commentary; results are not proof.
13. Limits panel: accepted: the last explainer section (`#limits`), linked from `#limits-note`, dated "as of 2026-10-13".
14. Sources and licence: accepted. The eight verified sources with URLs are listed; the vendor reference manual (dossier source 1) is not cited because the page may not name a vendor product; the two unverified Wikipedia pages and the Warwick page are omitted.
15. Input and hash safety: accepted and stricter: no storage at all.
16. Build order and cuts: accepted (sections 9 and 10).
17. No-place mode: accepted as the `none` place (cheap in the engine).
Premortem (1280x650 first frame): addressed in section 9. Judge warning on single-table rows: addressed by items 1 and 2.

### Declined

* Item 3, two input fields (last old-calendar day and first new-calendar day): the second is derived (`customLine`) because the two days are always consecutive and a typed pair could contradict itself; this removes an error state and three controls. The custom boxes also appear in place when "A place that is not listed" is chosen in the Place select, not behind More: a visitor who picks that option must see the boxes at once.
* Item 6, the phrase "which England, still on the old calendar, called 3 October": replaced by "called 3 October 1582 on the old calendar", which is true for any place and needs no claim about England. The critic's parenthesis about England's own 13 October is kept as the second reading row, worded without naming England.
* Item 14, "cite astronomy references" for the day-number anchors: no title or URL was recorded for them, so none is cited; the anchors cite Wikipedia, Julian day.
* Item 8, naming timeanddate as a second source for the offsets: it is a date-calculator site, and item 12 forbids product and competitor names anywhere on the page, so the page cites Wikipedia only for the offsets (which the page also labels as computed).

## 12. Test hooks

* Stable ids: all of 4.9. `window.__sedSelfTest()` (sync, under 2 s), `window.__sedReady`, `window.__sedThumbReady`, `window.__sedApp`, event `app:rendered`.
* Seed: nothing is random, so the hash is the seed. Reproducible states: sample (no hash); `#p=england&d=11&m=2&y=1731` (two readings); `#p=england&d=3&m=9&y=1752` (dropped date, grid with gapAt 2); `#p=denmark-norway&d=29&m=2&y=1700` (dropped leap day); `#p=france&d=29&m=2&y=1900` (error no-such-day); `#p=none&d=29&m=2&y=1700&w=julian` (Julian leap day, Thursday 11 March 1700); `#p=custom&cd=2&cm=9&cy=1752&d=3&m=9&y=1752` (custom place); `#p=zzz` (bad hash, shows the sample); `#p=england&d=1&m=9&y=1752&bd=15&bm=9&by=1752` (3 days between).
* Thumbnail: the first frame is final at load (no intro animation); `__sedThumbReady` resolves two frames after the first render.

## 13. Intro and explainer

### Intro

A converter that turns a Julian date (from the old calendar) into a Gregorian date (today's calendar), and back, for the place you pick. It flags dates that never existed there, like 13 October 1582 in Rome. Made for family historians and anyone reading old letters: a sample is loaded, so change the day or place, or try a famous date.

### Explainer

#### h2: Why one date can name two different days

A calendar is a set of rules for naming days with a day of the month, a month and a year. Two calendars can give one real day two different names, and this page works with two of them: the Julian calendar and the Gregorian calendar.

The Julian calendar puts a leap year (a year with an extra day, 29 February) in every fourth year, so its year averages 365.25 days. The Gregorian calendar, the one in use today, leaves out the leap year in century years that are not divisible by 400, so 97 of every 400 years are leap years and its year averages 365.2425 days.

That small difference adds up. Measured against the Gregorian average, the Julian calendar gains about 3 days every 400 years, so the two names for the same day drift apart. In 1582 the Gregorian name was 10 days ahead of the Julian one. From 1 March 1700 on today's calendar the gap was 11 days, from 1 March 1800 it was 12, and from 1 March 1900 it was 13.

| Dates on today's calendar | The Gregorian name is ahead of the Julian name by |
|---|---|
| 15 October 1582 to 28 February 1700 | 10 days |
| 1 March 1700 to 28 February 1800 | 11 days |
| 1 March 1800 to 28 February 1900 | 12 days |
| 1 March 1900 to 28 February 2100 | 13 days |

A place that moved from the Julian calendar to the Gregorian one had to choose which names to drop so that the two lined up. This page calls that moment the place's switch day, and the names that were dropped skipped dates.

Rome switched in 1582: the day after Thursday 4 October was Friday 15 October, so the names 5 to 14 October never existed there. No real day was lost and the weekdays carried on without a break. Only ten names were skipped.

[[try:rome-1582]]

Britain and its colonies switched 170 years later, under the Calendar (New Style) Act 1750. Wednesday 2 September 1752 was followed by Thursday 14 September 1752, so 3 to 13 September never existed there. That is eleven skipped names, one more than in Rome, because 1700 was a leap year on the Julian calendar but not on the Gregorian one.

[[try:england-1752]]

A popular story says angry crowds demanded their eleven days back. Historians find little evidence for it, and the slogan is tied to a banner in a 1755 painting about an election.

#### h2: Old Style, New Style and the year that began in March

Old Style (O.S.) means a date on the Julian calendar, and New Style (N.S.) means a date on the Gregorian calendar. Mixing them up moves a date by 10 to 13 days after 1582, as the table above shows.

The year could also start on a different day. In England, Wales, Ireland and the colonies the year began on 25 March until 1751, and on 1 January from 1752. So a date from 1 January to 24 March still belonged to the old year: a letter dated 11 February 1731 was written in 1731 by the calendar of the day, which today's count calls 1732. A dual date writes both years together, like 11 February 1731/32, for a day between 1 January and 24 March.

When you enter a date from 1 January to 24 March for a place with a 25 March year, the converter shows two readings. The first is the year as then written. The second counts the year from 1 January, because your source may already have used the modern count. For 11 February 1731 in England the first reading is Friday 22 February 1732 on today's calendar and the second is Thursday 22 February 1731. The first adds one to the year and 11 days to the date, the second only the 11 days.

[[try:washington]]

Scotland moved its new year to 1 January earlier, in 1600 (as of 2026-10-13, per search results from the National Records of Scotland and the Wikipedia article "Dual dating"), and the converter follows that. For every other place the converter counts the year from 1 January, even if your place started its year on another day, so check that yourself.

#### h2: How the converter works

The converter never works with month names directly. It turns your date into a day number, a plain count of days with no months and no leap years, and then turns that number back into a date on the other calendar. Day number 2299160 is 4 October 1582 on the Julian calendar, and day number 2299161 is 15 October 1582 on the Gregorian calendar. The count runs on without a gap; only the names jump. This count is known as the Julian day number. It counts days rather than names, so it can connect the two calendars.

The weekday comes from the same number. Add 1, divide by 7 and keep the remainder, written "mod 7": 0 means Sunday, 1 Monday and so on. For day number 2299160 the sum is (2299160 + 1) mod 7 = 4, which is Thursday. The seven-day cycle carried on unbroken through the switches in 1582 and 1752, so one rule gives the right weekday on both sides.

Before a place switched, nobody there used the Gregorian calendar, but the converter can still say what a day would be called on it. Extending a calendar backwards in this way is called proleptic use. That is how it can say that 4 October 1582 on the Julian calendar is 14 October 1582 on the Gregorian one, a name nobody in Rome used at the time.

The date type that web pages normally use (JavaScript's Date) extends today's calendar backwards, so it reads 29 February 1700, a real day on the Julian calendar, as 1 March 1700. The converter does its own arithmetic and finds that Julian 29 February 1700 is Thursday 11 March 1700 on today's calendar.

#### h3: What the converter cannot tell you {#limits}

Each place has one switch day. These places are not included because this page has no confirmed switch day for them: Greece, Sweden, Germany, the Netherlands, Switzerland, Austria, Poland-Lithuania, the colonies of other powers and every other place not in the list. If you know when your place switched, choose "A place that is not listed" and enter the last day it used the Julian calendar; the converter works out the next day for you.

The 25 March year is applied only to England, Wales, Ireland, the colonies and Scotland. Dates on today's calendar from before a place switched are counted backwards, so nobody there used them at the time. The page handles the years 1500 to 2099 and does not cover other calendar systems, such as the Hebrew, Islamic or Chinese calendars.

Some rows rest on search results rather than on pages the team opened (as of 2026-10-13): Spain, Portugal, France, Denmark-Norway and Soviet Russia, and Scotland's new-year change in 1600. A result is a calculation, not genealogical or legal proof: check it against the original record.

### Glossary

| term | plain definition | where on the page it is defined |
|---|---|---|
| Julian calendar | The old calendar: a leap year every fourth year, so its year averages 365.25 days. | Intro; explainer, Why one date can name two different days |
| Gregorian calendar | Today's calendar: it drops the leap year in century years not divisible by 400, so its year averages 365.2425 days. | Intro; same section |
| Leap year | A year with an extra day, 29 February. | Same section |
| Switch day | The day a place stopped using the Julian calendar and started using the Gregorian one. | Same section; the result card |
| Skipped date | A name, such as 13 October 1582 in Rome, that no day carried in that place because it was dropped at the switch. | Same section; the result card |
| Old Style and New Style | Labels for a Julian date and a Gregorian date. | Explainer, Old Style, New Style and the year that began in March |
| Dual date | A date written with two years together, like 11 February 1731/32, for a day from 1 January to 24 March when the year began on 25 March. | Same section; the year box |
| Day number | A plain count of days with no months or leap years, known as the Julian day number; it moves a date between calendars. | Explainer, How the converter works; Show the steps |
| Mod 7 | The remainder after dividing by 7; it turns a day number into a weekday. | Explainer, How the converter works |
| Proleptic | Extending a calendar backwards to dates before it was in use. | Explainer, How the converter works |

### First 30 seconds

The first frame, inside the element marked `data-sed-result` (its top above y = 560 at 1280x800, its first line inside the 390x844 screen), shows the sample: the badge "Never existed there" and the tag "Sample", the headline "13 October 1582 never happened in Rome.", the sentence about the jump from Thursday 4 to Friday 15 October, the two "If you meant" readings, the October 1582 grid with its torn gap, and the dated caption. The visitor needs no input to see a result. First action: change the Day from 13 to 15, press ArrowUp in the Day box, or pick a famous date. First success: the card turns into a real day ("15 October 1582 on today's calendar is the same day as Friday 5 October 1582 on the old calendar", with the 15th highlighted in the grid). New concepts before that success: two (a calendar switch, a skipped date); both are explained in the card itself.

### Control budget

Visible in the first viewport at 1280x800 (eight): Day, Month, Year, Place, Try a famous date, Copy result, Show the steps, More options. Behind More options: Read my date as, the three Count the days boxes (day, month, year), Copy link to this date, Check this tool against known answers. Shown only when the Place is "A place that is not listed": the three custom boxes. Not counted: the back link and the Jump link (plain links) and the About summary (below the explainer).

### Markup notes (for the builder, not page text)

"#### h2:" and "#### h3:" lines become `<h2>` and `<h3>` inside `section.sed-explainer#explainer[data-sed-explainer]`; the first h2 keeps `id="explainer-title"`; a trailing `{#limits}` sets the element id. Paragraph lines become `<p>`, the pipe table becomes a `<table>` with a `<thead>`, and `[[try:ID]]` becomes `<p><button type="button" class="sed-btn is-quiet" data-famous="ID">LABEL</button></p>` with the labels: rome-1582 "Try it: 13 October 1582 in Rome", england-1752 "Try it: 3 September 1752 in England", washington "Try it: 11 February 1731 in England". Paste the words exactly; the validator reads this markup statically.

## 14. Tool design

**Job.** Convert a historical date between the Julian and Gregorian calendars using the switch day of the chosen place; say when a date never existed there or has two possible years; show the working. **Audience.** Family historians, history students, writers and anyone reading old documents. **Inputs.** Day (1 to 31, digits), month (a list), year (1500 to 2099, digits), place (eight places, none, custom), optional Read my date as, optional second date. **Outputs.** The result in both calendars with the weekday (Sunday to Saturday), the difference in whole days, a dropped-date flag with the neighbouring days, one or two year readings, a month grid, the steps (day numbers are integers), and optionally the whole days between two dates. Units: days; dates as day, month name, four-digit year.

**Correctness oracle.** Expected values are copied from the named source where it prints them; rows whose source cell says "computed per" were computed with node -e from the formulas of section 5 (8 of 24 rows, at most half). "Search-seen" means the review step saw the claim in at least two independent search results on 2026-10-13 and no page was opened.

| # | input | expected output | source |
|---|---|---|---|
| 1 | toDayNumber(Julian 4 October 1582) | 2299160 | Wikipedia, Julian day (dossier source 2); also printed by a software reference manual example (dossier source 1, not cited on the page) |
| 2 | toDayNumber(Gregorian 15 October 1582) | 2299161 | Wikipedia, Julian day (dossier source 2); same manual example |
| 3 | toDayNumber(Gregorian 1 January 2000) | 2451545 | J2000.0 epoch, astronomy references seen in search results by the review step |
| 4 | interpret Rome 4, 5, 10 and 15 October 1582 | 4 Oct: day, Julian, Thursday; 15 Oct: day, Gregorian, Friday, day number one more than 4 Oct; 10 Oct: skipped, skippedCount 10, skippedFrom 5 October, skippedTo 14 October | Family Tree Magazine (dossier source 9, verified): Catholic countries went from 4 to 15 October 1582; the weekdays from the dossier fact |
| 5 | interpret England 2, 3, 13 and 14 September 1752 | 2 Sep: Julian, Wednesday; 14 Sep: Gregorian, Thursday, one day number after 2 Sep; 3 and 13 Sep: skipped, skippedCount 11 | Calendar (New Style) Act 1750, Irish Statute Book, and History Today (dossier sources 10 and 3, verified) |
| 6 | interpret France 9, 15 and 20 December 1582 | 9 Dec: Julian, Sunday; 20 Dec: Gregorian, Monday, one day number after 9 Dec; 15 Dec: skipped, 10 days | search-seen: Wikipedia, 1582 in France; icalendars.net, Gregorian reform: one day or another |
| 7 | interpret Denmark-Norway 18 and 28 February, 29 February and 1 March 1700 | 18 Feb: Julian, Sunday; 1 Mar: Gregorian, Monday, one day number after 18 Feb; 28 and 29 Feb: skipped, skippedCount 11, skippedTo 29 February; for 29 Feb asGregorian is null (1700 was not a Gregorian leap year) | search-seen: Wikipedia, Adoption of the Gregorian calendar; Debian tzdata calendars file |
| 8 | interpret Soviet Russia 31 January, 7 and 14 February 1918 | 31 Jan: Julian, Wednesday; 14 Feb: Gregorian, Thursday, one day number after 31 Jan; 7 Feb: skipped, 13 days | search-seen: Soviet History archive (Michigan State); prlib.ru; Library of Congress Law blog |
| 9 | interpret England 11 February 1731, auto | two readings: written, dual 1731/32, Gregorian Friday 22 February 1732, day number 2353712; plain, Gregorian Thursday 22 February 1731 | search-seen: National Park Service article; Philadelphia Inquirer (the written reading); the plain reading is computed per section 5 |
| 10 | interpret England 25 December 1642, auto | one reading, Gregorian Sunday 4 January 1643 | search-seen: Newton Project (Oxford); Wikipedia, Early life of Isaac Newton (the date pair); weekday computed |
| 11 | interpret Soviet Russia 25 October 1917, auto | Gregorian Wednesday 7 November 1917 | search-seen: Wikipedia, October Revolution; Cambridge University Library exhibition (the date pair); weekday computed |
| 12 | offsetDays at Julian 1 January 1650, 1750, 1850, 1950 | 10, 11, 12, 13 | search-seen: Wikipedia, Conversion between Julian and Gregorian calendars, and a second result named by the review step (not cited on the page, see Declined) |
| 13 | offsetDays on Gregorian 28 February and 1 March of 1700, 1800, 1900, 2100 | 10 then 11; 11 then 12; 12 then 13; 13 then 14 | search-seen: same sources as row 12 |
| 14 | isLeap Gregorian 1600, 2000, 1700, 1800, 1900; Julian 1700, 1900, 1582 | true, true, false, false, false; true, true, false | US Naval Observatory FAQ, Leap years (dossier source 11, primary); Tondering (source 6) |
| 15 | leap years and days in the 400 Gregorian years 1601 to 2000 | 97 leap years, 146097 days, average 365.2425 | US Naval Observatory FAQ and Tondering (dossier fact 3); 146097 computed per 97 x 366 + 303 x 365 |
| 16 | the same 400 years on the Julian calendar | 100 leap years, 146100 days, 3 more than the Gregorian count | dossier fact 3 (Julian average 365.25, about 3 days per 400 years); counts computed per section 5.3 |
| 17 | interpret none, Julian 29 February 1700 (writtenIn julian) | Gregorian Thursday 11 March 1700 | computed per section 5.1 (node -e) |
| 18 | interpret none, Julian 29 February 1900 (writtenIn julian) | Gregorian Tuesday 13 March 1900 | computed per section 5.1 (node -e) |
| 19 | day numbers from England 1 September 1752 to 15 September 1752 | 3 days | computed per section 5.9 (node -e) |
| 20 | day numbers from England 1 January 1752 to 1 January 1753 | 355 days (366 minus 11) | computed per section 5.9 (node -e) |
| 21 | monthGrid England September 1752 | lead 2; days 1, 2, 14 to 30 (19 days); 1 is Tuesday, 14 is Thursday; gapAt 2, gapDays 3 to 13 | computed per section 5.8; matches the layout of the old Unix cal output for September 1752 (dossier inspiration, not opened) |
| 22 | monthGrid Rome October 1582 | lead 1; days 1 to 4 and 15 to 31 (21 days); 1 is Monday, 4 Thursday, 15 Friday, 31 Sunday; gapAt 4 | computed per section 5.8 (node -e) |
| 23 | interpret France 29 February 1900, auto | error no-such-day, maxDays 28, calendar gregorian, leapNote true | computed per section 5.3 (Gregorian rule) |
| 24 | every day number from 1 January 1500 to 31 December 2099 | day number to label to day number returns the same number in both calendars; Gregorian labels agree with the browser's own Gregorian arithmetic (selftest.js checks this with Date.UTC as an independent reference) | computed per section 5.1 |

Extra cases (no oracle, one self-test case each): (25) mutation guard: running the engine-level checks of rows 7, 14, 15 and 23 against `createEngine({ centuryRule:false })` makes at least three of them fail; (26) the golden sample ViewModel of 4.6 matches string for string; (27) hash safety: `parseHash` gives null for `#p=zzz&d=13&m=10&y=1582`, for `#p=rome&d=1x&m=10&y=1582` and for a repeated key, and clamps `y=3000&m=13&d=0` to 2099, 12 and 1; (28) every built-in place has consecutive day numbers and `skippedCount` 10, 10, 10, 10, 11, 11, 11, 13; (29) DOM contract: every required id of 4.9 exists. Case names carry the row number and the source, for example "row 5 England 1752 (Irish Statute Book, History Today)". `window.__sedSelfTest` is set by selftest.js, is synchronous, finishes in under 2 s and returns `{ ok, total, passed, cases: [{ name, ok, detail }] }` with one case per row and per extra case (29 in all); index.html loads it with the relative tag of 4.1.

**Unverified sources** (named by the review step as seen in search results on 2026-10-13; the team never opened them and keeps no link): Wikipedia, 1582; Catholic Answers, The day the Church altered time; Wikipedia, 1582 in France; icalendars.net, Gregorian reform: one day or another; Wikipedia, Adoption of the Gregorian calendar; Debian tzdata calendars file; Soviet History archive (Michigan State); prlib.ru; Library of Congress Law blog; National Records of Scotland; Wikipedia, Dual dating; National Park Service article and Philadelphia Inquirer; Newton Project (Oxford); Wikipedia, Early life of Isaac Newton; Wikipedia, October Revolution; Cambridge University Library exhibition; Wikipedia, Conversion between Julian and Gregorian calendars; Britannica, Gregory XIII; astronomy references for J2000.0; one date-calculator site named for the offsets (not cited on the page, see Declined). The page's limits and About panel say which rows rest on them: Spain, Portugal, France, Denmark-Norway, Soviet Russia, Scotland's year start, and the stories attached to the famous dates. The dossier's own sources were also seen only in search results (no page was opened); the ones marked verified there are primary pages or were seen in two independent results.

**Edge cases and what the page shows.**

| input | what the page shows |
|---|---|
| empty day, month or year box | the matching error message of section 7 in the result card; Copy and Steps disabled |
| huge number such as year 99999 or day 999 | the day-format, year-format or year-range message; a hash with such a number is clamped |
| negative number such as -5 | the day-format or year-format message (digits only) |
| unicode digits (Arabic-Indic, full-width) or letters | the same format message (only ASCII 0 to 9 count) |
| locale-style text such as 13/10/1582, 13.10.1582 or 1582-10-13 pasted into one box | the day-format or year-format message that says a date goes in three boxes; the page never guesses the order |
| 31 April, 30 February | the no-such-day message, "April 1582 has only 30 days." |
| 29 February in a non-leap year of the reading calendar | the no-such-day message with the leap note when the other calendar has the day |
| a date between a place's two switch days | the dropped-date result, never an error |
| 1 January to 24 March in England or Scotland before the change | two readings and the year box |
| a calendar forced against the place | the result plus the note sentence; not an error |
| no place chosen | read as a Julian date, with the note sentence |
| year outside 1500 to 2099 | the year-range message |

**Limits the page prints** (explainer, `#limits`, and linked from the result card): one switch day per place; the places not included are named; the 25 March year applies to England, Wales, Ireland, the colonies and Scotland only; Gregorian dates before a place switched are counted backwards; years 1500 to 2099; other calendar systems are not covered; not genealogical or legal proof; and the rows resting on search results (Unverified sources above), dated "as of 2026-10-13".

**Privacy.** Everything runs in the browser. Nothing is sent, stored or tracked: no network request, no cookie, no browser storage. The address-bar hash holds the date and place so a link can be shared; it leaves the device only if the visitor shares it.

**Copy and export.** "Copy result" puts `vm.copyText` on the clipboard (Clipboard API, falling back to a hidden textarea and `execCommand` inside try/catch). "Copy link to this date" copies `location.href` with the current hash. No file export.
