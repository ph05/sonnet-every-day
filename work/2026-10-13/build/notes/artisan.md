# Artisan notes, 2026-10-13

Worked examples re-run with node (spec 5.1 formulas): Julian 4 Oct 1582 = 2299160 (Thursday), Gregorian 15 Oct 1582 = 2299161 (Friday),
Julian 4 Oct 1582 = Gregorian 14 Oct 1582, Julian 29 Feb 1700 = Thursday 11 March 1700, 11 Feb 1731/32 = Friday 22 Feb 1732 and
11 Feb 1731 = Thursday 22 Feb 1731, offsets 10/11/12/13 on the dates of the explainer table. All explainer numbers are correct; nothing corrected.
The intro equals PROJECT.json intro (the build script threw on any difference); explainer pasted from SPEC.md 13 by script, word for word.

Assumptions
- GridVM days carry no calendar tag, so view.js colours days before `gapAt` as old calendar and the rest as today's; with no gap the
  subtitle containing "Julian" means the whole month is old calendar, otherwise today's.
- The Year label reads "Year" with " (as written)" visually hidden (accessible name is "Year (as written)"): the column is 80px wide.
- The Famous select's label is visually hidden (its first option already reads "Try a famous date...").
- Labels of c-*/b-* boxes: visible "Day/Month/Year", with the spec's longer text as visually hidden prefix.
- #copy-status is a fixed bottom toast (no layout shift, visible whichever button was pressed).
- #steps-panel and #limits-note sit inside #result. Steps formulas get <code> via a regex over the VM string (textContent only).
- index.html inlines the shell's <style> block unchanged and loads style.css after it; style.css overrides the tokens.
- view.js uses `click` on #grid-body for the day pick (covers mouse and touch, ignores scroll drags).

Degradation / needs from others: none beyond the contract. view.js reads only ViewModel fields of 4.6 and PlaceRow of 4.6; unknown or missing
fields are skipped. app.js must add the select options (months, places, famous, b-month "Month" + months); until then the selects are empty.
Static `value` on #f-day (13) and #f-year (1582) is only a pre-boot placeholder; app.js overwrites it.

Checks done with a scratch mock app (not in the repo): both golden-like ViewModels, error VM, September 1752 and February 1918 grids at
320/360/390/768/1280 light and dark, no horizontal scroll at 320, 8 visible controls at 1280x800, first line of result inside 390x844,
result top 248px at 1280, Escape in More returns focus, day pick, toggles survive error renders. validate.mjs shows only integration items
(missing project.json, app.js, selftest.js, thumb, and sources links pending project.json).
