# Integration notes, 2026-10-12 (Between Periods)

Integrator: architect. Site: `work/2026-10-12/build/site/`. Verdict: the page is integrated and the last browser-check report (`qa/first/report.json`) has no errors and no warnings.

## Edits across file boundaries (file, owner, why)

| file | owner | edit and reason |
|---|---|---|
| `index.html` | artisan | `.sed-making-of`: the sentence "three bot planners ... can reach par on the next 365 daily rinks" was only true for the spiral planner (engineer's note; the mow misses 95 percent on some rinks). Replaced by what `test/selftest.mjs` asserts and passes today: scripted routes replayed with the ticks fed in chunks of 1, 7 and 60 give identical results; a bot driving closed laps gleams at least 95 percent on each of the next 365 daily rinks (worst 96.2); the best of three planners out-scores the plain mow (+56 points over 100 rinks). Same paragraph is in `package/project.json`. |
| `index.html` | artisan | "Real and made up": source attributions aligned with the research notes. Mental Floss established only the 1949 Model A date, so it is cited for that and no longer for the shave-and-vacuum description or the steering story; those cite HowStuffWorks and Wikipedia, and Wikipedia and the maker's PDF. |
| `js/ui.js` | artisan | New "first-screen fit" block (about 30 lines) plus two `scheduleFit()` calls (phase change, banner change). The CSS caps the rink at `100dvh - var(--rk-chrome)`, and the constants were tuned only at the three contract sizes. The block measures the real space the page needs above the rink and below it (down to the first visible primary button) and writes it to `--rk-chrome` on `#app`; the CSS values stay as fallback. Reason: on common viewports the Start button fell 4 to 66 px below the fold (390x750, 412x732, 430x740, 1280x650, 1366x650, any challenge-link banner at 375 to 430 px wide and at 1536x730). Grid of 264 sizes (320 to 1920 wide, 568 to 1080 tall, no banner): 79 failures before, 5 after (all 568 px tall on windows 1280 px or wider, where the 560 px rink floor cannot fit); with a challenge banner 22 remain, all at 600 px tall or less. 60 common real-world viewport and phase combinations: 12 failures before (21 with a banner), 0 after (2 with a banner at 1280x600). Contract sizes keep passing; the rink is up to 3 percent larger where the old constant was too cautious. |

No other file was edited. `spec/PROJECT.json` is untouched; `package/project.json` is the corrected draft.

## Conformance sweep (provider and consumer agree)

Read all 12 files and checked against SPEC section 4:
* Module system: one `<script type="module" src="js/main.js">`, last child of `<main>`; every import path has `.js`; `sim.js`, `bot.js`, `share.js` touch no DOM, no `Math.random`, no clock (`Date.now` only in `game.js`). `node --input-type=module --check` passes on every file.
* Exports and signatures (4.2) all present with the stated shapes; extras (`reachTotal`, `boardDepth`, `outlinePoint`, `outlineLength`, `wrapPi`, `planner.done`) are used only by engineer files.
* Data (4.3): `Rink`, `Sim`, `View`, `Result`, `Stats` match what `render.js`, `ui.js`, `postcard.js` read. Zones are top-left anchored and nets lie behind the goal line in both engineer and artisan code (checked on screenshots for slush, puddle, hats, drip, gate).
* Events (4.4): every code `game.js` emits (`tank-low`, `tank-empty`, `refill-start`, `refill-done`, `bump`, `milestone`, `bad-hash`, `bad-seed`, `storage-off`, `autoplay`, `challenge`) has a handler in `ui.js` with the DESIGN copy; `main.js` maps the audio codes. Synthetic note events checked one by one for toast and live-region text.
* DOM (4.6): all 49 ids of the contract exist once; every id `ui.js`, `main.js` and `game.js` look up exists (55 referenced). Added ids (`hud-tank-val`, `hud-clock-l`, `demo-chip`, `veil`, `banner-text`, `banner-action`, `best`, `hint`, `res-meta`) are all used by `ui.js` or the stylesheet. `data-show` plus `html[data-phase]` and `[data-mode]` drive the control bar for ready, playing, paused, done and auto.
* CSS (4.7): the ten `--rk-*` tokens exist in `:root` as plain hex and render.js reads them; dark overrides present; shell tokens kept.
* Hash grammar, share text, storage key (4.8): `share.js` and `game.js` agree; hostile hashes tested in the browser (percent escapes, 25-character seed, bad challenge, script text) all give the odd-link note and today's rink.
* Boot order (4.10): `main.js` loads `game`, `render`, `ui` with dynamic `import()` inside one try/catch instead of static imports (engineer's deviation, accepted: a broken module shows `#boot-error`, a blank loading page cannot happen). `__sedThumbReady` and `__sedState` exist from the first line. Missing `audio.js` or `postcard.js` degrade as specified; a missing `render.js` or a canvas without 2D shows the fatal text.
* Shell parts intact: CSP meta first after charset, back link `../../`, skip link, `main#main`, `details.sed-about`, credits, `noscript`; no `data-sed-placeholder` left; no forms, no inline handlers, inline SVG favicon (no `/favicon.ico` request).
* About panel: nine sources, same labels and URLs as `package/project.json`; no other external link; brand and team names only in source URLs and the dated NHL season line.

## Evidence

* `node test/selftest.mjs`: `ok:true` in about 10 s (T1 27 runs, 0 mismatches, golden digest `7bd6e55d`; T2 365 rinks, worst par lap 96.2 percent; T3 spiral beats mow by 56 points and 11.6 percent of time, jitter never costs a band; T4 2000 hostile hashes).
* `browser-check.mjs --no-monkey`: round 1 clean; round 2 clean after the edits above (0 console errors, 0 page errors, 0 non-local requests, no overflow at 390 or 320, contrast min 5.15 light and 7.24 dark, 14 tab stops, no missing focus indicator). The default 12 s monkey passes (desktop 317 actions, mobile 146) and two longer seeded runs (45 s, 525 and 248 actions, 511 and 196 actions) were clean.
* About 190 scripted browser checks (Playwright, Chromium) all pass: start by click, Enter, Shift+Enter; steering by keys, mouse hover and touch drag; pause by P, Escape, Space and the button; slow; call it; result dialog (stats, share text 4 lines, postcard drawn, copy result and link through the clipboard, save card downloads a PNG, Escape returns focus to Again); autoplay `#a=mow|spiral|race` ends in 8 to 10 s; challenge win and loss lines; practice mode; seed typing, Today, hashchange; preferences persisted; storage that throws; no WebAudio; corrupted stored data; hidden tab pauses and a visible tab does not auto-resume; low and dry tank (class, coach line, toast, live text); buzzer on a fake clock; reduced motion; forced render fault (banner and Restart recover). Gleam layer painted incrementally equals the full rebuild (same covered pixels, no drift).
* Frame cost while playing: JS 0.3 to 0.5 ms median, frame gap steady at 16.7 ms (1366x768 and 390x844 at 2x DPR).
* `scripts/validate.mjs project --tier 2` on a scratch copy named `2026-10-12-between-periods` with `package/project.json` and a generated thumbnail: `ok:true`, no errors, no warnings, ownLoc 4692, thumbnail 247 KB.
* Page payload 201 KB (225 KB with `test/selftest.mjs`), 276 DOM nodes.

## Viewport contract (SPEC 11.6, premortem risk 3), re-run on the integrated page

`build/notes/viewport-integrated.json` holds the rects. Method: Playwright Chromium, `#s=qa1`, for each viewport and scheme read `getBoundingClientRect` of `#rink`, `#hud-clock`, `#hud-tank` and the primary button (`#btn-start` in ready, `#btn-pause` in playing and paused) at `scrollY` 0, require every edge inside the viewport, `touch-action: none` on `#rink` and not on `body`, no horizontal overflow, then `mouse.wheel(0, 160)` over the rink centre and require `scrollY` to grow when the page is taller than the viewport.
* 1366x768, 390x844 and 360x640, light and dark, ready, playing and paused: every rect inside, scrollY 0, no overflow, wheel scrolls the page. Also inside at 1280x800, 1200x630, 1024x768, 768x1024, 412x915, 320x568.
* Not inside (outside the contract, listed so QA does not rediscover them): phone landscape 844x390 (the page scrolls; header, title and HUD alone take 200 px); viewports 568 px tall or less on wide screens, and 600 px tall or less with a challenge banner at 768 px or wider, where the 560 px rink floor cannot fit.

## Known limits and small things left alone

* A machine driven straight at a board stops against it (it slides only along it) until the player steers; steering still works while pinned. By design in SPEC 5 ("slide, never stop" is about the tangential part), the coach line does not mention it.
* Bot laps that end because the planner has nothing left read "Called it" in the result line.
* JavaScript disabled: the loading note and a dead interface show for 6 s, the no-script sentence sits under About. The page is a game; left as is.
* The thumbnail the packaging step will take at 1200x630 shows the rink about 980 px wide with the half-gleaming demo, the machine with its sheen trail, the refill door and the Start and Practice buttons; nothing cut off (preview checked on a scratch copy).
* `spec/PROJECT.json` still carries the old self-test sentence; use `package/project.json`.
