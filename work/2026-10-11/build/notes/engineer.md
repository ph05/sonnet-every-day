# Engineer notes: Orbital Knitwear (2026-10-11, tier 2 compact day)

Files (all in `work/2026-10-11/build/site/js/`, ES modules, no DOM outside `main.js`, no network, no eval, no escapes in source):
`orbit.js` 313 lines, `coverage.js` 263, `cards.js` 236, `state.js` 244, `selftest.js` 96, `main.js` 716 (1,680 code lines without blanks and comment-only lines; spec table target 1190, engineer floor 600). Raw size 65.6 KB (about 25 KB gzipped); the whole site was 213.8 KB when last measured, so the 200 KB budget is the artisan's size pass plus, if needed, selftest.js (5.5 KB, cut-list item 3).

## What was checked
* Node: every vector in SPEC 5.3 matches (see `selftest.js`, 34 of 34 pass in Node and in headless Chromium, about 3 s in the page).
* Node harness with a fake DOM and a stub `ui.js` that checks every `app:*` payload against SPEC 4.2 and 4.4: 34 scenario checks, 2,500-action monkeys with garbage payloads (null, NaN, strings, huge numbers), 20 boot hashes (garbage, 1 MB, percent-escapes, card links), blocked and corrupt storage, reduced motion, a fault injected into `ui.draw` (error status once, one `console.error`, events ignored, `app:reset` recovers).
* Property tests: 3,000 random states round-trip through `serializeHash`/`parseHash`; 60 random multi-needle runs give identical grids whether advanced in one call, in random chunks or under a millisecond budget; recycled sims equal fresh ones.
* Real Chromium with the artisan's files (read only): `scripts/qa/browser-check.mjs` passes (0 console errors, 0 page errors, 0 non-local requests, no CSP violations, 1,262 random actions in 100 s, one 55 to 68 ms long task at load that is script evaluation); all eight cards played from their start setup and from their par; share link reload; best badge persisted across reload; hidden tab pauses and resumes without a jump; blocked storage, denied or missing clipboard, throwing `history.replaceState` all degrade to the right toast.
* Cost: boot to ready 330 to 530 ms (1.1 s with the CPU throttled 4x); 3 needles at 16 days per second hold 56 fps (the 8 ms budget caps the sim at about 13 days per second there); heap steady at 6 to 8 MB; ticks arrive at 9.4 per second; the validator reports no finding in my files. Engine cost per needle-day is 6 to 12 ms (a 1500 km polar swath costs 65 ms). With the CPU throttled 4x in software-rendered headless Chromium the page drops to 16 fps and my share of a frame is about 12 ms (advance 5, draw call 4.5, metrics 2); the rest is the renderer, and the in-page checks then take tens of seconds because the render loop starves their slices (they still finish).

## Pars (baked in `cards.js`, replayed by `verifyPar` and the self-test, tolerance 0.1 points)
Found offline with this engine: random restarts plus elitist local moves on the slider grid (about 5 to 10 minutes of Node per card) and exhaustive scans for the two repeat-height cards. They are the best setups found, not proofs. No pass level had to be lowered (every par clears its pass level), so the goal strings in SPEC 5.4 are unchanged. The SPEC "par seeds" were far below what the search found, so the pars differ from the SPEC table.

| card | pass at | par setup | par | start setup scores |
|---|---|---|---|---|
| first-swatch | planet >= 76% | 441 km, 86.7 deg | 97.4 | 71.6 (4.4 short) |
| past-the-station | polar bands >= 85% | 759 km, 88.75 deg | 100 | 5.0 |
| sixteen-day-weave | band >= 99% | 699.57 km, 98.19 deg (233 orbits in 16 days) | 100 | 91.5 |
| same-time-tomorrow | drift <= 0.25 h and planet >= 95% | 236 km, 96.45 deg | 99.4 | 0 (drift) |
| dawn-patrol | twilight >= 65% | 705 km, 93.5 deg, node -88 | 100 | 6.7 |
| two-needle-cable | planet >= 97% | two at 222 km, 89.7 deg, nodes 0 and 180 | 100 | 95.3 (1.7 short) |
| linger-up-north | north share >= 30% | 200 km, 90 deg, ecc 0.8, argp 272 | 69.9 | 16.7 |
| map-lies | map minus planet >= 9 points | 1213 km, 85.05 deg, ecc 0.565, argp 72 | 13.7 | 0 |

Things the search taught: any tight repeat height with a sun-sync tilt gives 100 on the weave (Snap then Tune is enough); dawn-patrol reaches 100 on a wide ridge of tilt and start longitude (a retrograde tilt near 93.5 deg at node -88) and the sun-sync answer scores 81; linger-up-north peaks near 70 with a polar, fully stretched orbit, well above the 63.4 deg figure in the hint (which still passes with about 34). Near-par setups are broad plateaus (scores move less than 0.04 under 1e-5 relative nudges), so cross-browser float noise cannot fail the replay.

## Assumptions where the contract was ambiguous (all additive, nothing renamed)
* `parseHash(hash, prefs?)` takes an optional second argument (saved prefs fill `speed`, `view`, `terminator` when the link omits them) and returns an extra `test` flag next to `{state, repaired}`. `repaired` is set for any replaced, clamped, truncated or undecodable part; a card lock overriding the link's swath or season is silent.
* `createSim(sats, season, recycle?)`: pass the previous sim to reuse its typed arrays; the old sim then returns 0 from `advance`. Extra exports: orbit.js `makePoint`, `propagateInto`, `DEFAULT_SATS`; coverage.js `advanceSliced`; cards.js `badgeName`, `PAR_TOLERANCE`.
* `normalizeSat` wraps `node` and `argp` into their ranges instead of clamping (a needle added at node + 90 must wrap) but keeps in-range ends (a slider dragged to 180 stays at 180). The ecc cap is floored to 3 decimals so a capped state survives the 3-decimal hash. A circular orbit ignores `argp` (it starts at the node), so a leftover value cannot shift a par replay.
* `CardStatus` carries one extra field, `short`: points still missing from the weakest pass condition (0 on a pass; for same-time-tomorrow the drift condition is counted in score points). `app:cards` is also emitted when the active card changes or a hash is adopted.
* Toast params: `locked {param (label), key}`, `tuned {inc}`, `snapped {alt, k, m, spacing}`, `cardPassed|newBest {badge (display name), badgeId, score, par}`, `cardMissed {short}`, `shareCopied|shareManual {url}`. A peeked run earns no toast and no best. First pass shows `cardPassed`; beating a stored best shows `newBest`.
* Snap and Tune write alt and inc rounded to 2 decimals, the precision of the URL hash, so a link replays exactly what the visitor saw. Snap prefers tight ticks and takes the nearest (dir 0), the next lower or the next higher one.
* After a run ends, changing a needle or pressing Play restarts it and plays (unless reduced motion). Paused runs still catch up to day 2 after a change, so a tweak always shows a result.
* `__sed.advance(days)` resolves with the metrics object; `__sed.ready` resolves true at ready and false on a fatal error.
* `selftest.js` is loaded by dynamic `import()` on `app:about-open` (or `#test=1`), so cutting it (cut-list item 3) cannot break the page.

## Deviations from the spec
* Pars and pass-level-adjacent numbers come from the real search (table above), not the seeds in SPEC 5.4.
* `main.js` is 716 lines against a 240 target: defensive event handling, fatal recovery, the preview/preroll/catch-up lifecycle and the test hooks took the room. No dead code.

## Concerns for the integrator
* Packaging: the validator only complains about `project.json`, `thumb.png` and the About links not being in `project.json` yet (they are in PROJECT.json). The thumbnail screenshot should wait for `__sedThumbReady`; it resolves two frames after the pre-rolled first frame (3 days, default scene) and a 1.5 s timer backs it up for hidden tabs.
* The default scene at day 3 reads "The flat map looks 82% covered; the planet is 89%": the map understates here because the unvisited polar caps are many cells but little area. Honest numbers, opposite of the pitch line's example; the cards (The Map Lies, Past the Station) show the other direction.
* The About panel's own 8 s fallback line in `ui.js` can appear before slow phones finish the checks (they take about 3 s here); the results replace it when they arrive.
* Card hints are verbatim from SPEC 5.4 and still lead to a pass, but they do not describe the par: the dawn-patrol hint asks for a sun-synchronous tilt (that scores 81) while the best answer is a tilt near 93.5 deg, and the linger-up-north hint names 63.4 deg while a polar orbit scores twice as high. That is a nice discovery for the visitor; the artisan may want the About text to say pars come from a search (it already says brute force).
* The spec's cut-list items that touch me are all still in; nothing to cut.
* Premortem item in my lane (shipped program must not contain backslash-u or backslash-x escapes): grepped all six files, none; no non-ASCII characters either.
* No injection attempts were seen in the files I read.
