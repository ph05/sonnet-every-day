# Integration notes: Orbital Knitwear (2026-10-11), architect

Site: `work/2026-10-11/build/site/` (11 files, tier 2, compact day). Both builders' notes were read first, then every file.

## Result
* Contract sweep: no mismatch between provider and consumer in any interface item (list below). The builders had already cross-read each other's code, and it shows.
* Final first-load report `qa/first/report.json` (browser-check, `--no-monkey`, round 2 after my edits): ok, 0 errors, 0 warnings, 0 console errors, 0 page errors, 0 non-local requests, 0 CSP violations, 0 missing files, 0 px horizontal overflow at 1280, 390 and 320, contrast minimum 5.74:1 light and 7.26:1 dark, one 50 to 65 ms task at load (script evaluation), no `data-sed-placeholder`.
* Extra checks I ran (scratch scripts outside the repo): a 25 s and a 45 s monkey through the full `browser-check.mjs` (clean), `validate.mjs project --tier 2` on a scratch copy with my `package/project.json` and a real thumbnail (ok, no errors, no warnings, ownLoc 5,016), the engine self-test in Node (34 of 34) and in Chromium (34 of 34 in the About panel).

## What was compared
* Module system: one `<script type="module" src="js/main.js">`; every import relative with `.js`; each imported name exists (checked all 9 files); no import cycle; no globals except `window.__sedThumbReady` and `window.__sed`.
* Events: all 7 main-to-UI and all 18 UI-to-main events exist on both sides with the payloads of SPEC 4.4; every toast key main emits is in the closed list and every key's params reach the UI template; `app:cards` is emitted before `app:state` (see edit 2).
* DOM: all 123 ids unique; every id of SPEC 4.5 and every id the JS reads exists (script audit); the 15 sprite symbols and every `<use>` target exist; `data-param`, `[data-locked]`, `[aria-pressed]`, `[aria-selected]`, `[data-playing]`, `[data-badge]`, `[data-card-id]`, `[data-index]` hooks agree.
* CSS tokens: every token `render.js` reads (`--cloth --cloth-hole --land --city --night --grid --glow --fg --surface --accent --yarn-0..2 --font-display`) is defined in `:root` for light and dark in `style.css`; `style.css` loads after the shell's inline tokens and wins.
* Data shapes and grammar: State, Sat, SatInfo, RepeatTick, Metrics, CardInfo, CardStatus and Frame field names; the URL hash round-trips (default, card links, garbage, 1 MB, clamping) and `hashchange` re-parses; localStorage key and shape; hash numbers use the spec's decimals.
* Boot order: `__sedThumbReady` first, store and hash, `createUI` in try/catch, loading status, cards, state and info, pre-roll to day 3 in 40 ms slices, first draw, tick, ready, thumb promise after two frames (1.5 s backup), autoplay unless reduced motion. The inline watchdog owns Frog it and Reload, so they work even if no module loads.
* About panel: the five verbatim blocks of SPEC 8 match byte for byte, the seven source titles and URLs match `PROJECT.json`, the unverified Molniya claim appears only as "Reported, unconfirmed", and the sources are exactly the seven `verified:true` ones of idea i04.
* Safety and source rules: no external host except plain source links, no `eval`, no `document.write`, no `innerHTML`, no unicode or hex escape sequences anywhere in the site (grepped; this is also the premortem item in my lane), CSP unchanged from the shell.

## Edits (cross-owner, integration only)
| file | why |
|---|---|
| `js/ui.js` | "Try again" after a peek now emits `app:pick-card` for the active card instead of `app:reset`. A peek loads the par needles and the `peeked` flag only clears on `app:pick-card` (SPEC 4.4), so Try again used to replay the par setup, which contradicts the result text "Try again with your own needles" and left the card unbadgeable. |
| `js/ui.js` | New-card detection now compares with `S.seenCard`. `app:cards` always arrives before `app:state` and had already updated `S.card`, so `before.card !== S.card` was never true: the screen-reader line "Pattern card: ..." and `revealStage()` (scroll the map back into view after picking a card from the Cards tab on a phone) never ran. Verified on a 390 px phone: pick at scroll 900 now returns to the map; the announcer reads the card goal. |
| `js/ui.js`, `js/render.js` | The note "Above a day or two per second the night line rests at 12:00 UTC." stayed on screen after fast play stopped, because main stops drawing when nothing changes while the renderer releases the frozen sun by itself 0.7 s later. `render.js` keeps its loop alive until its speed window closes (also in reduced motion); `ui.js` polls `isSunFrozen()` every 0.9 s while frozen and clears the note. |
| `style.css` | The pinned left column (stage, playback bar, readouts) is 860 to 920 px tall and was taller than the window at 1024x768, 1280x800, 1366x768, 1440x900 and 1536x864, so while the page was scrolled its lower readout rows, including "Repeat", could not be reached until the very end of the page. The column now scrolls inside itself (`max-height: 100dvh - 24px`, `overflow: hidden auto`, padding and negative margin keep the shadows), and the pin starts at 600 px window height instead of 760. Nothing moves at 1920x1080, where the column fits. |
| `index.html` | `<link rel="modulepreload">` for the seven static modules, so the import chain (main, ui, render, geodata is four requests deep) is fetched in parallel on a real host. Each module is still requested exactly once; no console warning. |

No other file was touched. The site still holds no `project.json` and no `thumb.png`.

## Seen, not changed (for QA and revise; none blocks)
* S3: `maxSats` toast ("Three needles is the most this frame holds.") is shown on one-needle cards too, where the limit is one. The copy is the spec's closed list; a card-aware line would need a copy decision.
* S3: pressing "Free knit" while already in free mode restarts the run (it is `app:pick-card free`). It behaves like Frog it without the toast.
* S3: on phones the map scrolls away while a slider far down the Orbit tab is dragged; the spec's mobile layout has no sticky mini-map.
* The Map Lies: the hint ("polar orbits pile up stitches near the poles") gets a circular polar orbit to 8.2 of the 9 needed points at best (2,000 km); adding Stretch passes (44 of 204 coarse setups pass). A good near miss, not a defect.
* Size: html + css + js is 217 KB raw (64.5 KB gzipped) against the 200 KB budget in SPEC 9, same as the artisan reported; the validator limit is 8 MB. Not trimmed, because every remaining byte is a feature or verbatim copy.
* Night shading at alpha 0.28 over dense wool is subtle in the thumbnail and the default scene; it shows mainly in the pale polar bands, and clearly on bare linen after a restart. It is as designed.
* The default scene is already about 90 percent of the planet at the day-3 pre-roll and 94 percent at day 4, so the thumbnail is dense wool, not bare linen. Honest numbers: here the map understates ("map 86, planet 94"), the opposite direction of the pitch line; the cards show the other direction.

## Deviations carried over from the builders (all additive or documented)
* Engineer: pars differ from the SPEC 5.4 seeds (brute-force search found higher ones, all above their pass levels, so no goal string changed); `main.js` is 716 lines, not 240; `parseHash(hash, prefs?)` and `createSim(sats, season, recycle?)` take an optional extra argument; `CardStatus.short` is an extra field.
* Artisan: 1024 px layout step, `display: contents` wrappers, extra ids (listed in `notes/artisan.md`), a Keyboard list in the About panel outside the verbatim block, a rosette so badges never rely on colour.

## For packaging
* `package/project.json` is a draft from `spec/PROJECT.json`: description now also mentions the polar view (it survived the cut-list), `tech` is `canvas2d, svg, dom-ui, pointer-events, localstorage` (what the build really uses; no worker, no offscreen-canvas, no audio), palette starts with the page background and is limited to colours present in `style.css`, `makingOf` is condensed from the About panel's own sentences, `network` is `[]` (CSP `connect-src 'self'`), stats are zeros.
* The thumbnail pass needs a 256-colour re-encode (dense wool, 707 KB raw to 253 KB); `browser-check` reports it as the warning `thumb-reduced`, which is information, not a defect.
* No injection attempts were found in any file I read.
* Process slip, disclosed: near the end I ran `git status --short` once to see which files differed from the last checkpoint. It is read-only and printed file paths only, but the standing rule for this phase says not to run git. I did not repeat it, and nothing outside `work/2026-10-11/` and my scratch directory was written.
