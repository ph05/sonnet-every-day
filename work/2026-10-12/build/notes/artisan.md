# Artisan notes, 2026-10-12 (Between Periods)

Files: index.html, css/style.css, js/render.js, js/ui.js, js/audio.js, js/postcard.js (all under build/site/).
Checked against a scratch mock of game.js/main.js (not shipped) in headless Chromium: `build/notes/viewport.json` holds the rects.

## Assumptions (contract reading)
* `rink.door` is an axis-aligned rect w x h centred on (x,y); the board gate bar is drawn on the edge opposite `(nx,ny)`.
* `rink.marks.nets[i].x` is the goal-line x; the net extends `d` behind it (toward the end board, `-dir`). Off by at most 3.3 ft if the engineer meant the net centre.
* `view.m.dry` is true when the tank is empty (renderer and UI also treat `tank <= 0` as dry).
* `view.fresh.n` is non-negative except for one frame after a rink or sim swap; a standing `-1` would resync the gleam layer every frame (about 6 to 12 ms).
* `view.arcs.n` counts points (max 24) in the interleaved `[x,y]` arrays.
* The result dialog opens from `view.result` changing while `phase==='done'` (not from the `app:finish` event, which only feeds the live region). `Again` in the dialog or bar calls `start(mode)` when done (mode practice stays practice, anything else timed) and `restart()` when paused.
* `watch()` and `#a=` runs show `html[data-mode=auto]`: pause, slow and call-it are hidden and `#btn-start` stays visible as "take the wheel".
* A `load` phase right after the user pressed Load rink or Today's rink clears the old bad-link banner; otherwise it persists until the next start.

## Added ids and strings (beyond 4.6 and the DESIGN copy list)
Ids: `hud-tank-val`, `hud-clock-l`, `demo-chip`, `veil`, `banner-text`, `banner-action`, `best`, `hint`, `res-meta`.
Strings: "Elapsed", "Resumed." (live only), "Copied.", the copy-blocked and save-failed lines, "Best on this rink:", watch options (Skip-lane mow, Spiral, Racetrack), result reasons (Every scar gleams, Buzzer, Called it), "Tap the rink or press Space" (pause veil), "Demo lap. Tap Start to take the wheel." on coarse pointers (the touch twin of the Enter line).

## Degradation
* No WebAudio: `#btn-sound` disabled with title "Sound unavailable in this browser"; audio.js is a no-op. A failed `postcard.js` import hides `#postcard` and `#btn-save-card`.
* No `dialog.showModal`: the `open` attribute is set. No clipboard: the text is selected in `#share-text` with a toast.
* The renderer catches its own frame errors and dispatches `app:error {where:'render', fatal:false}` once; ui.js does the same for `where:'ui'`. Both show the Restart banner or a toast, never throw.
* If main.js never marks `html[data-boot]` ready, CSS reveals `#app` after 6 s so the page is not blank.

## Design choices worth knowing
* Layers: base+scars and gleam are offscreen canvases at 4 px per foot, switching to 8 px per foot only when the screen shows at least 9.5 device px per foot (large DPR 2 displays); back below 7.
* Scars: grooves solid, divots stippled, snow ridges hatched, hats as glyphs (4 styles, wobble only without reduced motion). Dull (empty tank) cells are translucent so the scar stays visible; gleam cells cover scars.
* Sheen film: ring buffer of the last 48 segments, 2.2 s fade; on the first frame of a sim already in motion it is back-filled along the current steering arc so the thumbnail shows a wet trail. Reduced motion: no film, shake, sparkle, buff or confetti, static pulse rings and static hat glyphs.
* Layout: viewport contract holds at 1366x768, 1200x630, 768x1024, 390x844, 360x640 and 320x568 in ready and playing (see viewport.json); `touch-action:none` only on `#rink`; no wheel listener.

## For the integrator
* makingOf is verbatim from PROJECT.json, including the sentence about self-tests: delete it from index.html and PROJECT.json together if the tests did not run and pass.
* `scripts/validate.mjs project` on the scratch copy reported only dir-name and missing thumbnail (expected pre-package).
* Not built (cut-list or out of scope): ghost replay, navigator.share, reload button in `#boot-error`.
