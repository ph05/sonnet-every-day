# Engineer notes, 2026-10-12 (Between Periods)

Files (all under `build/site/`): `js/main.js`, `js/sim.js`, `js/bot.js`, `js/game.js`, `js/share.js`, `test/selftest.mjs`.
Proof: `node test/selftest.mjs` prints `{"ok":true,...}` in about 10 s (T1 determinism, T2 365 daily rinks, T3 depth proof, T4 hash fuzz).
Also checked in headless Chromium against the artisan's real `render.js`/`ui.js`: clean console, `#a=` autoplay reaches the result dialog in about 9 s, no overflow at 360 px, a 25 s random monkey (521 actions, resizes, hash edits) with no console or page errors and no external request.

## Numbers: where I moved off the spec's starting values (all inside the stated bounds)
| value | spec start | shipped | why |
|---|---|---|---|
| `speed` | 18 ft/s | **21** | the clock was binding: a full route is about 2,500 ft. Best bot (spiral) below 95 percent gleam on how many of the 365 daily rinks: spec start values (18 ft/s, water 1/7, leak 0.9) **128**, worst 84.6; 18 ft/s with the two water changes below 60; 20 ft/s 3; **21 ft/s 0, worst 96.2**. Turn radius does not depend on speed, so handling geometry is unchanged. |
| `waterPerFt` | 1/7 | **1/8** | a full tank lasts 800 ft (spec band 450 to 900): fewer, cheaper pit stops |
| `dripPerSec` | 0.9 | **0.6** | the leak otherwise forced extra pit stops on every leaking rink |
| `clockTicks` 9000 (150 s), swath 8, radius 10, body 4.5, bands, penalties, door 16 x 14 | | unchanged | R/W is 1.25 |

Measured (selftest output):
* T1: 27 scripted runs (3 seeds x 3 routes x chunking 1, 7, 60), 0 digest or result mismatches; golden digest `7bd6e55d` (seed `qa1`, route `weave`, 1800 ticks) and golden rink hash `e8ea61b8`. Both change if `TUNING` or the generator change: update `GOLDEN` in `test/selftest.mjs`. Trig error under 1.6e-8; a tick costs about 0.0004 ms warm (budget 0.05).
* T1 also fuzz-drives 6 rinks for 72,000 random-steer ticks: the pose and tank never go non-finite, the machine never gets closer than 4.5 ft to the boards, the incremental counters equal a recount of the raw grid, and a renderer that replays `view.fresh` (with the `n = -1` resync) ends with exactly the sim's grid.
* T2: 365 UTC dates from 2026-10-12: every scar cell is reachable, `scarTotal` in [2000, 7000], scar share 5.6 to 7.4 percent, door and start legal. The par planner (**spiral**, closed laps) gleams **96.2 percent at worst, 99.5 median**, 0 bumps over all 365 laps, at least 3 refills each.
* T3 (100 seeds `qa1` to `qa100`, medians): mow 94.4 percent / 900 pts / 90 percent reached at tick 7070; spiral 99.5 / 956 / 6250; race 99.5 / 940 / 6840. Best (spiral) beats the mow by 56 points and 11.6 percent of time. A plus or minus 3 degree jitter never costs a grade band (drops: 99 seeds none, 1 seed gains one). Two tuning rounds were enough; nothing shipped failing.
* T4: 2000 hostile hashes (1137 outside the charset or length): never throws, always inside the grammar, `buildHash` round-trips.
* Timing of my part: cold start of rink plus 2100-tick demo run-in is about 45 ms (the reach mask measures one quadrant of the rink and mirrors it; the selftest checks the mask equals the plain per-cell test); first frame ready at 160 to 245 ms in headless Chromium including nine file fetches. One roughly 110 to 145 ms long task at boot (QA only warns above 1 s).

## Planners (what "Watch a lap" shows)
`mow` = 11 full lanes in skip order with semicircle hops (baseline, leaves pockets at lane ends); `spiral` = three closed laps hugging the boards, each stepping one lane inward near the door, then a scar-aware sweep of the centre and a clean-up; `race` = the same with two laps. A continuous spiral was tried first and loses badly: after the first quarter-lap it can never again cover the strip beside the boards, where over half the scars are. The About copy can say "closed laps beat lanes: laps hug the wear".

## Assumptions where the contract was silent or ambiguous
* **Zones are top-left anchored**: `mishap.zone = {x, y, w, h}` is the rectangle from the corner `(x, y)`; the puddle is the circle inscribed in it. The artisan's renderer draws them that way (checked on screenshots), so I matched it. The door stays centred as the contract says.
* Nets span `x - dir*d .. x` behind the goal line, creases are half discs opening toward the rink centre (`dir`); same reading as the artisan's notes.
* Start pose is in the door facing inward. The machine is not refilled until it has first left the door rect (otherwise the drip start of 85 would be topped up at once, and a refill flag would fire at the start). The door slows the machine to 0.4 inside it.
* `rink.reachTotal` is an extra field; `sim.stats(out)` takes an optional object to fill (no allocation per frame); extra exports `boardDepth`, `outlinePoint`, `outlineLength`, `wrapPi` are used by the bot.
* A clean lap needs an all-wet straight run (a dry tick voids it), because the spec says dull passes do not count.
* `result.beat` is a boolean for timed and bot (`auto`) results when a challenge is loaded, `null` for practice or without one.
* Hash: a bad `s` drops the challenge too (a bar for an unknown rink would be unfair). After a load the canonical hash keeps `c` of the loaded challenge; after a timed finish it carries your own result; practice finishes keep the last timed result on that rink. `a` never survives the first write, so a reload does not autoplay again.
* `loadSeed` returns `{ok, seed, code}` and emits **no** note (the UI already shows the seed message from the code; a `bad-seed` note would trigger the "link looked odd" toast). Hash problems emit `bad-hash` or `bad-seed` once, after the UI exists.
* Notes (`tank-low`, `bump`, `milestone`, ...) fire for the player's own runs only; the demo and bot laps emit just `autoplay`. `app:phase` is dispatched before `app:finish` and the view is synced before every `app:phase`.
* Share text says "1 clean lap" (singular) for one lap; otherwise exactly the 4.8 format.
* `main.js` loads game, render and ui with dynamic `import()` inside the one try/catch so a broken module shows `#boot-error` instead of a blank loading page, and defines `__sedThumbReady` and `__sedState` on its first line. `html[data-boot]` becomes `ready` as soon as the first frame is drawn (also for an autoplay lap); the thumbnail promise settles when `boot()` does (after the lap for `#a=`, or on cancel).
* Keys: auto-repeat is ignored for Space, Enter, P, R, M and Escape; keys do nothing inside an open dialog, input, select or textarea; any key (not a bare modifier or Tab) cancels an autoplay or watch lap and does nothing else.

## For the integrator
* **makingOf sentence about tests is only partly true.** Check "three bot planners ... can reach par on the next 365 daily rinks": the 365-rinks assertion is for the spiral planner (96.2 percent at worst); the mow reaches 90 percent on 99 of 100 test rinks but not 95 on all. Suggested replacement, to apply in `PROJECT.json` and the About panel together: "Self-tests replay scripted routes and check that a bot driving closed laps gleams at least 95 percent of the scars on each of the next 365 daily rinks, and that three bot planners (skip-lane mow, spiral, racetrack) compare as expected."
* Tuned numbers (speed 21, water 1/8, leak 0.6) are not printed anywhere in copy; the 150 s clock is unchanged.
* `view.fresh` is the sim's own `{idx, n}`; I clear it after each frame's callbacks, so `n` is -1 only if more than 4096 cells change in one frame (not seen, even at 16x).
* `__sedState().tank` etc. read the interpolated view pose.
* Nothing from the cut-list was cut (ghost replay was already out). Facts policy: my files hold no user-facing prose or real-world fact; events carry codes only. No INJECTION ATTEMPT seen in the idea file, spec or notes.
