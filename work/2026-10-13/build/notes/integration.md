# Integration log, 2026-10-13, Historical Date Converter

Integrator: architect. Every cross-owner edit is logged here as file + reason. Site: `work/2026-10-13/build/site/` (9 files, own code about 2,900 lines).

## Edits (file, owner, reason)

1. `view.js` (artisan), `renderPlaceTable`: the Place column read `item.place.name`, but SPEC 4.6 defines `PlaceRow.place` as the plain
   name string and `report.js` returns it that way (self-test case 33 pins it), so the column rendered blank. The consumer now takes a
   string (and still an object with `name`). The provider was left alone because the contract text is literal.
2. `index.html` (artisan), explainer paragraph on the 1752 myth and the About source 8 sentence: "a 1755 painting about an election"
   became "a painting from 1755". With "Congress" (edit 3) the word "election" made `validate.mjs project` raise the error
   `politics-undeclared` (two political terms while `fingerprint.political` is false). The page is not political and the detail is
   not needed for a calendar tool, so the wording moved instead of the fingerprint.
3. `index.html` (artisan), `data/places.js` (engineer), `selftest.js` (engineer): the third search-seen name for the Soviet Russia row,
   "Library of Congress Law blog", was dropped from the About list, from the row's `basis` string and from the label of self-test case
   row 8. The row keeps its two other named sources and the "as of 2026-10-13, per search results" label. No expected value was touched.
   With edits 2 and 3 `validate.mjs project --contract` is clean (no errors, no warnings).
4. `index.html` (artisan), label of `#f-famous`: no longer visually hidden. `app.js` (by SPEC 4.8) shows the matching famous date in the
   select, so on the first frame it read "13 October 1582 in Rome (a da..." with no label, which looked like a second Place box.
5. `style.css` (artisan), month names: "September", "November" and "December" were clipped to "Septem..." in the 300 px form column
   (measured: 83, 78.5 and 78.5 px of text in 74 px). Changes: form column 300 -> 320 px at 1100 px and up; month selects give back
   padding (`0 24px 0 8px`); the custom-switch and days-between boxes use a 48 / fluid / 68 px day-month-year row (44 / fluid / 62 px with
   6 px input padding under 360 px, where the year box had been cut). Re-measured at 1280, 1100, 1024, 768, 390, 360 and 320 px with
   all three month boxes visible: no month name and no number is clipped.
5b. `style.css` (artisan), `.hdc-more` and `.hdc-quiet`: vertical padding 0 -> 6 px so the two-line label "Check this tool against known
   answers" no longer touches its border (min-height 44 px is unchanged).
6. `index.html` (artisan) and `package/project.json`: the making-of paragraph said the converter "never uses the browser's date tools",
   while `selftest.js` calls `Date.UTC` once as an independent reference for the Gregorian side. The paragraph now says the converter
   does not use them and that the self-test uses them once as a cross-check. The About panel and `project.json` carry the same text.

## Conformance sweep (provider and consumer agree)

* Module system: ES modules only; `selftest.js`, `app.js`, then the inline watchdog module, all at the end of `<main>`. Import graph
  has no cycle: engine, view and data/places import nothing; state imports places; report imports engine and places; selftest imports
  engine, state, report and places; app imports engine, state, report, places and view (as a namespace, so a missing export shows the
  watchdog text instead of a blank page). Every named import resolves (checked with a script and by loading the page).
* Exports and signatures: engine (`YEAR_MIN YEAR_MAX MONTH_NAMES WEEKDAY_NAMES createEngine` + the 12 default-instance members),
  places (`PLACES FAMOUS`), state (`SAMPLE parseHash formatHash readFields sameState`), report (`placeById formatYMD buildViewModel
  placeTableRows`), view (`mountView renderViewModel renderPlaceTable renderSelfTest flashCopied`): all as in SPEC 4.3 to 4.7.
* DOM ids: all 49 required ids exist once in `index.html` (51 ids in all, none duplicated); every id that `view.js` and `app.js` look up
  exists; `selftest.js` REQUIRED_IDS equals the SPEC list. `data-famous` ids in the explainer (rome-1582, england-1752, washington) are
  FAMOUS ids. Every class that JS adds (`hdc-row`, `hdc-cal`, `hdc-chip`, `is-tear-after`, `is-tear-before`, `is-animate`, `is-flip`,
  `is-flash`, `cal-j`, `cal-g`, `d`) has CSS, except `blank` (a plain empty cell, intended).
* CSS hooks: `#result[data-tone]`, `#result[data-sample]`, `[hidden] { display: none !important }`, the new tokens `--julian --julian-bg
  --gap --gap-bg --greg-bg --font-serif` (plus `--julian-fg --gap-fg --field-border`) are all defined light and dark in `style.css`.
* ViewModel and GridVM: every field `view.js` reads is produced by `report.js`; unknown fields are ignored on both sides.
* Hash grammar: `state.js` output order p d m y w cd cm cy bd bm by; strict parse (160 chars, known keys once, `[a-z0-9-]{1,16}`,
  numbers clamped). 24 hostile and odd hashes (bad place, repeated key, half a second date, 8 repeats, upper case, `%20`, markup) all
  show the sample or the clamped date, with no console output. A state hash applied by `hashchange`; `#explainer` and `#limits` do not
  reset the visitor's input (app.js ignores a hash without "=").
* Events: `app:rendered` (CustomEvent on `document`, detail `{tone, hash}`): dispatcher `app.js render()` after every render including
  the first; listeners: none in the build (QA hook), so no registration order matters, and it can be re-requested with
  `__sedApp.setState({})`. DOM events (`input change keydown focusout submit click` on `document`, `hashchange` on `window`) are attached
  at the end of `boot()` after the first render; nothing fires them earlier. `view.js` attaches its own listeners in `mountView` (More,
  Steps, Escape, grid click) before the first render. Window hooks: `__sedSelfTest` (selftest.js, set at module load), `__sedReady`,
  `__sedThumbReady`, `__sedApp` (app.js, set during boot).
* No `Date`, `Intl`, `toLocale*`, storage, cookie, `fetch`, `eval`, `innerHTML` or `console.*` outside selftest.js (which uses `Date.UTC`
  once, on purpose, as an independent check). CSP meta is byte for byte the shell's. `network` is `[]`.

## Rounds

* Round 1 (`qa/first`): ok, no errors, no warnings. 8 first-screen controls, first frame marked (result top 248 px desktop, 659 px phone),
  self-test 33 of 33 in about 90 ms, intro bottom 232 px desktop and 380 px phone, no overflow, contrast min 5.18 light and 7.56 dark.
* Edits 2 to 6 followed (visual review, the scratch-package validation and the layout probes below).
* Round 2: ok, no errors, no warnings (phone result top 680 px, still above 844). Extra full run with the monkey (scratch dir): ok.
* Final round (after the last edit, the making-of wording): ok, errors [], warnings []; 8 first-screen controls; first frame marked
  (desktop 248 px, phone 680 px); self-test 33 of 33 in 84 ms; intro bottom 232 px of 420 and 380 px of 560; no overflow, console
  error, page error, failed or non-local request, CSP violation or long task; contrast min 5.18 (light) and 7.56 (dark).
  Three browser-check runs in all (rounds 1, 2 and final), plus the scratch monkey run; the report is at `qa/first/report.json`.
* `package/project.json` (draft for the packaging step): title equals `<title>` and `<h1>`; tagline 91 characters; intro (61 words, first
  sentence 24) and makingOf taken from the page by script; palette = the page's real tokens, background first (`#f4eee1 #0c6b66 #8f4f0f
  #b3261e #211c15 #fffcf5 #15120d`); tier 2; `fingerprint.tech` = dom-ui, svg, es-modules, url-hash, clipboard-api (the spec's
  "pointer-events" was dropped: the grid pick is a plain click, no Pointer Events API); sources = the 8 About links, all `verified:true`
  in the dossier; network []; stats zeros. Its makingOf differs from spec/PROJECT.json on purpose (edit 6).

## Checks beyond browser-check (all in scratch copies, nothing written to the site)

* Premortem (1280x650 first frame): at 1280x650, 1366x768, 1280x800, 1100x700 the Day, Month, Year, Place, Famous and More controls and
  the Copy result and Show the steps buttons are all on screen and none overlaps another; result card top 248 px, first headline line
  ends at 361 px. At 390x844 the buttons sit at 734 to 778 px and the first headline line ends at 816 px. At 360x740 and 320x640 the
  buttons are below the fold (small phones), still no overlap. No horizontal overflow from 320 to 1024 px in 8 states x light and dark
  with Steps, More and About open.
* Interaction script (real Chromium): typing, ArrowUp, ArrowDown, Shift+ArrowUp, famous select, explainer "Try it" buttons (scroll to
  the app), More and Escape, forced calendar, days between, custom place (including a bad box), grid day pick, pasted date, year-range,
  Steps, Copy result (clipboard text checked), Copy link, self-test button (33 of 33), jump and limits links, place table: all pass.
* Fuzz in the live page: 4,000 random states plus 2,108 states built around every real switch and 1,500 custom places (dropped
  stretches cut by month edges): no exception, no "undefined", "NaN" or "null" in the text, grid cells, ghost chips, tear classes, focus
  cell, steps and lead blanks all match the ViewModel.
* Independent arithmetic check (Meeus formulas and Python `datetime`, not the page's code) of SPEC rows 1 to 3, 5 to 13, 17 to 20: every
  expected value in `selftest.js` is true (day numbers 2299160, 2299161, 2451545, 2353712; all weekdays; offsets 10 to 14; 3 and 355 days).
* Performance: render about one frame (16.7 ms median incl. vsync), self-test 77 ms, 125 KB transferred, no long task.
* Scratch package (site + `package/project.json` + a thumbnail made by `browser-check --thumb`): `validate.mjs project --tier 2
  --contract` ok with no errors and no warnings; the thumbnail (1200x630, 163 KB, scrolled 156 px so the result fills the frame) shows
  the sample result and the leaf with its torn gap, with the last lines of the intro above it.

## For QA and the revise step (not fixed here, all S3 or lower)

* Famous select: when a famous date is active the closed select shows its label clipped ("13 October 1582 in Rome (a da..."); the label
  above it now says what the control is, the list shows full texts.
* "Soviet Russia was still using the old calendar then" is shown for 25 October 1917 (famous date "in Russia"); the row's `short` is
  "Soviet Russia" by SPEC 4.4. A `short` of "Russia" would read better for 1917 and still be true for 1918; the About table keeps
  "Soviet Russia (RSFSR)" and says other governments switched on other days. Left as specified.
* SPEC 4.6 says the last real-day step for England 1731 is the "Day number" formula, its own list puts the switch-continuity sentence
  after it. The build follows the list; the self-test pins the formula step by content, so either order passes.
* `build/notes/engineer.md` and `artisan.md` sit in `build/notes/`, outside the site directory, so nothing from them ships; the
  OWNERSHIP conflict note about engineer.md does not touch the page. They were kept as handoff notes (the page does not need them).
* The About list "Also seen in search results" and the table rows marked search results are honest about the unverified rows. One name
  fewer for the Soviet row (edit 3).
