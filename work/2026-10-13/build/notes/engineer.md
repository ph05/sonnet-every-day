# Engineer notes, 2026-10-13, Historical Date Converter

Files written: `engine.js`, `data/places.js`, `state.js`, `report.js`, `app.js`, `selftest.js` (all in `work/2026-10-13/build/site/`).
Nothing was fetched from the web; no research text was used as an instruction. No injection attempt seen.

## For the integrator (read first)

1. **PlaceRow.place is a plain string, view.js reads `item.place.name`.** SPEC 4.6 says the PlaceRow members are
   "strings: name; 'Thursday 4 October 1582'; ...", so `placeTableRows()` returns `place: 'Rome and most of Italy'`.
   The artisan's `renderPlaceTable` (as read at 10:00) does `str(item.place && item.place.name)`, which is empty for a
   string: the Place column of the About table renders blank (seen in headless Chromium). One-line fix in view.js:
   `name.textContent = str(typeof item.place === 'string' ? item.place : item.place && item.place.name);`
   I did not change the provider because the contract text is literal.
2. **Golden "last step" for England 11 February 1731.** SPEC 4.6 says the last step is "Day number: a = 1, y = 6531, m = 11; ...
   = 2353712.", but its own list of real-day steps puts the switch-continuity sentence (step 8, any place with a switch) after
   it. I followed the list (England has a switch, so step 8 is last) and pin the formula step by content in the self-test
   (`steps.includes(...)`) instead of by position. If the architect wants the formula step last, drop step 8 or move it earlier
   in `dayParts` (report.js); nothing else depends on the order.
3. **Self-test has 33 cases, not 29.** Cases 1 to 29 are the SPEC rows and extras. I added 30 (input validation: empty, huge,
   negative, Arabic-Indic and full-width digits, pasted dates), 31 (wording of every message and mode, year-window
   boundaries 1 January / 24 March / 25 March, 1750 vs 1751, "1700/01"), 32 (month grids at the other switches) and 33 (place table
   rows). `renderSelfTest` prints the real total ("All 33 checks passed."), so the "29" in DESIGN.md microcopy is only an example.

## Assumptions (contract was ambiguous)

* `readFields` order of checks: second-date boxes are read first (so `betweenError` accompanies any main error), then
  day, month, year, place, custom. A month or day outside its range gives the `*-format` code (SPEC 4.5: "else day-format").
* The year-format message stays the exact SPEC 7 text for a date pasted into Year ("1582-10-13"); only the Day message
  mentions "three boxes", so a pasted date in Year says "Type the year as digits, for example 1582." (the edge-case table
  in section 14 describes both messages as saying "three boxes"; section 7 is exact and wins).
* Real-day step 1 with no place (the `none` place) is "You typed D." and, when "Read my date as" is forced, adds
  " 'Read my date as' was set to Julian." For a real place with a forced calendar the step is the normal "for <place name>"
  sentence and step 2 says "You chose to read it as a Julian date." The `custom` place is called "your place" in steps
  (its `name` is a select label, "A place that is not listed").
* A `written` reading that is the only valid one (29 February 1699 typed for England is real only as 29 February 1699/1700)
  drops the sentence "The second reading counts the year from 1 January instead." from step 3 and shows no year box.
* Grid texts for a month where the dropped stretch is cut by the month edge (custom places only) count only the dropped
  days inside that month ("6 days skipped here: 26 to 31 October"); one-day and two-day runs read "5" and "5 and 6".
* `copyText` follows the SPEC list literally: it does not include the days-between line or the year-box title.
* Grid `label` for a plain month is "<title>. Days 1 to 29." (no gap sentence).
* ArrowUp/ArrowDown on an empty or non-numeric box sets the SAMPLE value for that box and does not step. The two
  second-date boxes have no SAMPLE value, so they start from the first date's own day and year.
* `sample` is true only when the state equals SAMPLE and no control was touched since load or since the last
  state-carrying `hashchange` (a typed 13 that leaves the sample state again is no longer the sample).
* `report.js` does not import `state.js` (the import graph of 4.1), so it trusts `input.sample` for the caption.

## Deviations from the spec text (all small, all in app.js)

* `hashchange` is ignored unless the new hash contains "=" (a state hash always does). The jump link (`#explainer`) and the
  limits link (`#limits`) change the hash too and would otherwise have reset the visitor's input to the sample.
* "Copy link to this date" first rewrites the address with the current state's hash, then copies `location.href`, so the
  link is right after an in-page link replaced the hash and while the sample has no hash yet.
* A held ArrowUp/ArrowDown renders without the fade (`event.repeat`), so the card does not flicker.
* `selftest.js` also exports `runSelfTest` (the page uses `window.__sedSelfTest`; the export lets Node run the cases).
* `engine.customPlace` returns a complete Place with the same `name` and `short` strings as the `custom` row of
  `data/places.js` (engine.js imports nothing, so the two strings exist in both files).
* `app.js` imports `view.js` as a namespace (`import * as view`), so the module graph still links if an export is missing
  and the failure is a visible TypeError at boot (watchdog message) instead of a silent blank page.

## Data (places.js) and the facts policy

All eight rows, `yearRule` and `basis` strings are copied from SPEC 4.4. `basisKind` confirmed = rome, england; mixed = scotland;
search = spain, portugal, france, denmark-norway, soviet-russia. Nothing in my files states a fact beyond those rows; the
dates and weekdays shown elsewhere are computed. Possible wording issue (not mine to change): the 1917 famous date reads
"Soviet Russia was still using the old calendar then", because the row's `short` is "Soviet Russia"; a `short` of "Russia"
would read better there while the table keeps "Soviet Russia (RSFSR)".

## Vectors

No SPEC vector looks wrong. Every weekday of rows 4 to 11, 17 and 18 and of the grid rows was re-derived with Python's
`datetime` (an independent Gregorian calendar) and agrees. Row 24 compares both calendars against a day-by-day count and
Gregorian labels against `Date.UTC`. Expected values are copied from the table; none was edited. Two expected values
I wrote myself (extras 31 and 32) were checked with Python before being pinned; one early guess of mine ("Wednesday 15 January
1699/1700") was wrong, Python and the engine both say Monday, and I fixed my own literal.

## What I ran

* `node --input-type=module --check` on all six files; `node scripts/validate.mjs project` on the site dir (only packaging
  errors: dir name, project.json, thumb, undeclared source links before project.json exists).
* Real Chromium via Playwright: sample first frame, all reproducible hashes of SPEC 12, bad hash, hashchange, typing, ArrowUp
  with Shift, famous select and explainer buttons (scroll), custom place, grid pick, days between, Copy result, Copy link,
  clipboard fallback (no Clipboard API, and a rejecting one), self-test button, reduced motion, no horizontal overflow at 320,
  360 and 390 px, a seeded 1,500-action monkey (junk text, 5,000-character strings, odd hashes) on desktop and phone:
  no console or page errors.
* `scripts/qa/browser-check.mjs` (tool, contract armed): ok, no errors or warnings, 8 first-screen controls, self-test 33/33
  in about 90 ms, first frame marked and inside both screens.
* Node property checks: for each of the eight places, walk every real day from 1 January 1500 to 31 December 2099 label by
  label; `interpret` agrees on the calendar, day numbers rise by exactly one (also across the switch), weekdays advance by one,
  and `monthGrid` equals the walked days for all 7,200 months; dropped-label counts are 10, 10, 10, 10, 11, 11, 11, 13.
  200,000 random raw-field combinations through `readFields` and `buildViewModel`: never the "internal" error view model, no
  "undefined" or "NaN" in any string, every valid state survives `formatHash` then `parseHash`.
* Mutation check of the self-test: 17 deliberate defects in scratch copies (weekday off by one, dropped 400 rule, switch
  off by one, year window 25 March, last dual year, zero padding, swapped later/earlier, footer, hash repeat, clamp, and others);
  16 fail at least one case, the 17th is an equivalent mutant (a grid branch that cannot be reached), and a harmless control
  mutant passes, as it should.
