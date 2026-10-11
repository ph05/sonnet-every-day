# Orbital Knitwear: SPEC (tier 2, compact day: two builders, engineer + artisan)

Slug `orbital-knitwear` · title "Orbital Knitwear" · date 2026-10-11 (Day 2) · idea i04 · site dir `work/2026-10-11/build/site/`.
Read with `DESIGN.md` (look, copy, motion). Start from `ops/templates/page-shell.html`: CSP meta, viewport, `lang`, back-link `<a class="sed-back" href="../../">`, skip link, single `<main id="main">`, `details.sed-about`, `<noscript>` all stay. Day label: `Day 2 &middot; 2026-10-11`. Rules for all code: no external requests, no analytics, no third-party code, no `eval`/`new Function`/`document.write`, no `innerHTML` with hash-derived strings, no unicode or hex escape sequences in source (write the literal character, or build it with `String.fromCodePoint`), no Worker (see Declined).

## 1. Vision and the wow moment
A satellite is a knitting needle and the Earth is the fabric. The visitor tunes up to three satellites (height, tilt, orbit shape, start longitude, swath width) and watches each ground track unspool across a wool-textured world map, every pass laying a ribbon of stitches as wide as the swath. Real orbital mechanics (two-body motion plus the J2 bulge) lets famous behaviours emerge from sliders: a tilt near 98 degrees makes the orbit turn with the sun (one local time of day), a height near 700 km makes tracks tile exactly like Landsat's 233 orbits in 16 days, 51.6 degrees fences the station's track. Eight pattern cards turn it into a puzzle with a par. Wow moment, with no click: the page loads already half-knitted (3 days pre-rolled), two yarn colours keep laying ribbons at one day per second, and a line such as "The flat map looks 74% covered; the planet is 61%" keeps score honestly. Scoring uses true surface area, so the projection cannot flatter you.

## 2. Core loop and visitor journey
Loop: set needles -> run the clock (fast-forward days) -> read coverage, gaps, local time -> retune (the run restarts and re-knits in about a second) -> bind off at the card's horizon, get a badge against par.
* **10 seconds:** knitting starts by itself; ghost-track dashes preview the selected needle; headline readout shows planet share versus map share.
* **First minute:** drag Height; tall ticks on the slider mark "stitch-perfect" repeat heights; press Tune sun-sync; pick the card First Swatch; bind off, see a badge.
* **Tenth minute:** Sixteen-Day Weave, Dawn Patrol, Two-Needle Cable; chasing par; add a second needle; compare flat and polar views; copy a link to a setup.
* **Coming back:** best badge per card remembered (localStorage), shareable setups in the URL hash, "Surprise me" for random needles.

## 3. File map
| Path | Owner | Responsibility | ~Lines | Public API |
|---|---|---|---|---|
| `index.html` | artisan | Shell, DOM skeleton (4.5), About panel (section 8), icon sprite, boot watchdog | 180 | ids in 4.5 |
| `style.css` | artisan | All styling, light/dark tokens, 3 breakpoints, reduced motion | 340 | custom properties 4.6 |
| `js/ui.js` | artisan | Binds DOM, renders panels from events, input model, owns the renderer | 380 | `createUI` |
| `js/render.js` | artisan | Wool renderer (yarn layer + overlay), projections, terminator, picking | 340 | `createRenderer` |
| `js/geodata.js` | artisan | Hand-simplified land outlines and city dots (data) | 110 | `LAND`, `CITIES` |
| `js/main.js` | engineer | Entry: boot, state, hash, run loop, event wiring, hooks | 240 | none (entry) |
| `js/orbit.js` | engineer | Constants, orbital mechanics, sun, repeats, info (pure, no DOM) | 270 | see 4.3 |
| `js/coverage.js` | engineer | Grid, painting, metrics, simulation clock (pure) | 230 | `createSim` |
| `js/cards.js` | engineer | 8 pattern cards, scoring, baked pars, locks | 220 | see 4.3 |
| `js/state.js` | engineer | Defaults, hash parse/serialize, localStorage store | 140 | see 4.3 |
| `js/selftest.js` | engineer | In-page physics checks against sourced figures | 90 | `runSelfTest` |

## 4. INTERFACE CONTRACT
### 4.0 Module system and conventions
**ES modules only.** `index.html` has one `<script type="module" src="js/main.js">`; every import is relative with the `.js` extension. Engineer files import only engineer files, except `main.js` imports `./ui.js`. Artisan files import only artisan files. No classic scripts, no globals except `window.__sedThumbReady` and `window.__sed` (12).
Conventions (the usual divergence traps): angles in **degrees** at every public boundary (radians only inside functions); latitude + north, longitude + east, longitude wrapped to [-180, 180); one Earth radius **6378.137 km** everywhere (orbit, swath, area); time is **days as float** since run start; altitude means **perigee altitude** above that radius; shares and metrics are **fractions 0..1**, card scores are **0..100**; typed-array pairs are `[lon, lat]`; grid index `row*360+col`, row 0 = northmost (centre lat `90-(row+0.5)`), col 0 = westmost (centre lon `-180+(col+0.5)`); numbers formatted in the UI with `en-US` and tabular figures.

### 4.1 Ranges (single source; `orbit.js` exports them as `RANGES`, `index.html` slider attributes copy them)
| Param | Unit | min | max | step | default (sat 0 / sat 1) | Slider id |
|---|---|---|---|---|---|---|
| `alt` perigee altitude | km | 200 | 2000 | 1 | 700 / 420 | `ctl-alt` |
| `inc` inclination | deg | 0 | 180 | 0.05 | 98.19 / 51.6 | `ctl-inc` |
| `ecc` eccentricity | - | 0 | 0.8 | 0.005 | 0 / 0 | `ctl-ecc` |
| `node` start longitude of the ascending node | deg | -180 | 180 | 0.5 | -22.5 / 60 | `ctl-node` |
| `argp` argument of perigee (only matters if `ecc` > 0) | deg | 0 | 360 | 1 | 0 / 0 | `ctl-argp` |
| `swath` | km | 110 | 1500 | 5 | 185 / 400 | `ctl-swath` |
| `season` sun date, days after 20 Mar | d | 0 | 364 | 1 | 0 | `ctl-season` |
Stored values are not rounded to slider steps (Snap and Tune write decimals); the UI must not echo a slider's rounding back into state unless the user moved it. Apogee altitude is capped at 60000 km by lowering `ecc` (`normalizeSat`).

### 4.2 Data types (JSON-like)
```
Sat        {alt, inc, ecc, node, argp, swath}                    numbers, ranges above
State      {v:1, sats:Sat[1..3], sel:0..2, card:string /* card id or 'free' */, view:'flat'|'polar',
            speed:0.25|1|4|16 /* sim days per second */, season:0..364, terminator:boolean,
            seed:int 0..999999, playing:boolean, peeked:boolean}
SatInfo    {periodMin, perigeeKm, apogeeKm, nodeDriftDegDay, apsideDriftDegDay, revsPerDay /* per nodal day */,
            maxLatDeg, shiftDegOrbit /* westward track shift per orbit */, ltanH /* 0..24 at day 0 */,
            isSunSync /* |nodeDrift - 0.9856| <= 0.02 */, ssoIncDeg:number|null,
            repeat:{k,m,spacingKm}|null /* nearest repeat within 0.6 km of height */}
RepeatTick {alt, k, m, spacingKm, tight:boolean}                 tight = spacingKm <= sat.swath
Metrics    {day, planet, map, overlap, revisitH:number|null, ltDriftH, northShare, twilightShare, samples}
CardStatus {id, score, pass, badge:'none'|'swatch'|'sweater'|'heirloom', finished, progress:0..1, par, best:number|null, peeked}
CardInfo   {id, title, blurb, goal, hint, passText, days, maxSats, locks:{swath?:number, season?:number},
            regions:[[latMin,latMax],...]|null, par:number, best:{score,badge}|null}
Frame      {day, view, season, terminator, sun:{lat,lon},
            grid:{w:360, h:180, version:int, hits:Uint8Array, last:Float32Array, owner:Uint8Array},
            sats:[{index, lat, lon, altKm, color:0|1|2, selected, trail:Float32Array /* [lon,lat] pairs */}],
            preview:Float32Array|null, focus:[[latMin,latMax],...]|null}
```
`hits[i]` = pass count (saturates at 255); `last[i]` = day of the latest hit, -1 if never; `owner[i]` = latest hitter index+1, 0 if none. Frame arrays are live and read-only for the consumer; `ui.draw` must not keep them after returning (cache by `grid.version`). `trail` = last min(1.5 periods, 1 day), at most 600 points. `preview` = the selected needle's track from day 0 over min(1 day, card horizon), at most 720 points, non-null only for 1500 ms after a state change or while paused at day < 0.01; the renderer splits any polyline where consecutive longitudes differ by more than 180. `main.js` fills `Frame.sats[i].color = i`, `Frame.sun` from `sim.sunPoint()`, `Frame.focus` from the active card's `regions` (else `null`). `CardStatus.progress = min(1, day/days)`; before `finished`, `pass` reflects the current metrics and `badge` is `none`.

### 4.3 Exports (all synchronous unless marked async; none throws on bad input: they clamp and return)
**`js/orbit.js`** (engineer): constants `EARTH_KM=6378.137, MU=398600.4418, J2=1.08263e-3, SIDEREAL_DEG_DAY=360.9856, SUN_DEG_DAY=360/365.2422, OBLIQUITY_DEG=23.4393, KM_PER_DEG, EQUATOR_KM, MAX_APOGEE_KM=60000, RANGES`.
`normalizeSat(sat, locks?) -> {sat, notes:string[]}` (clamp to ranges, fix NaN to defaults, cap apogee, apply `locks` such as `{swath:400}`; notes in `perigee-clamped|apogee-clamped|locked:<param>`).
`elements(sat) -> Elements` (opaque, cached rates) · `propagate(el, day, season) -> {lat, lon, altKm, elevDeg}` (sub-satellite point; `elevDeg` = sun elevation there) · `sunPoint(day, season) -> {lat, lon}` · `ssoInclination(altKm, ecc) -> number|null` · `satInfo(sat) -> SatInfo` · `findRepeats(sat, {mMax=16, altMin=200, altMax=2000}?) -> RepeatTick[]` (sorted by `alt`, at most 400; inclination, ecc and argp held fixed) · `sampleTrack(sat, season, day0, day1, maxPoints) -> Float32Array` · `ltanHours(sat) -> number` · `ltDriftHours(sat, days) -> number`.
**`js/coverage.js`** (engineer): `GRID_W=360, GRID_H=180, DT_S=4, PASS_GAP_DAYS=1/72`, `cellAreaFraction(row) -> number` (share of the sphere; all cells sum to 1), `createSim(sats, season) -> Sim` where `Sim = {day, grid, advance(days, budgetMs?) -> daysAdvanced, metrics(selIndex) -> Metrics, coverageIn(ranges) -> number, positions() -> [{lat,lon,altKm}], trail(i) -> Float32Array, sunPoint() -> {lat,lon}}`. `advance` processes whole 4 s samples, stops early when `budgetMs` is spent (default unlimited), never skips samples; `Sim.day` is the time of the last processed sample.
**`js/cards.js`** (engineer): `CARDS` (8, section 5.4), `getCard(id) -> Card|null`, `cardInfo(card, best) -> CardInfo`, `applyLocks(card, sats) -> Sat[]`, `evaluate(card, metrics, sim, finished, peeked, best) -> CardStatus`, `async verifyPar(card, sliceMs=30) -> {ok, score, par}` (re-runs the baked par setup in time slices).
**`js/state.js`** (engineer): `STORE_KEY`, `defaultState() -> State`, `parseHash(hash) -> {state, repaired}`, `serializeHash(state) -> string` (with leading `#`), `loadStore() -> {best:{[cardId]:{score,badge}}, prefs:{speed,view,terminator}, ok}`, `saveStore(store) -> boolean`, `mulberry32(seed) -> () => number`.
**`js/selftest.js`** (engineer): `async runSelfTest() -> {passed, total, items:[{name, ok, got, want}]}`.
**`js/ui.js`** (artisan): `createUI({seed:number, reducedMotion:boolean}) -> {draw(frame:Frame):void, destroy():void}`. Synchronous; throws `Error('ui: missing #<id>')` if a required id from 4.5 is absent (ids of features on the cut-list may be absent; `ui.js` feature-tests them). `draw` costs at most 6 ms (budget in 9), may be called every animation frame, and does nothing heavy if nothing changed. All other UI input and output goes through events (4.4).
**`js/render.js`** (artisan, internal to artisan): `createRenderer(stageEl, {seed, reducedMotion}) -> {resize(), setView(v), setTheme(), draw(frame), pick(clientX, clientY) -> {lat, lon, row, col}|null, destroy()}`. **`js/geodata.js`**: `LAND: [{name, rings:[[ [lon,lat], ... ]]}]` (at least 10 polygons: the continents, Greenland, Madagascar, Great Britain, Japan, Indonesia, New Zealand; Antarctica as a southern band), `CITIES: [{name, lat, lon}]` (about 12 public cities). No national borders.

### 4.4 Events
Custom events on `document`, `new CustomEvent('app:<name>', {detail})`, dispatched synchronously, payloads exactly as below, unknown fields ignored, handlers must not throw.
**Main -> UI (engineer emits, artisan listens):**
| Event | detail | When |
|---|---|---|
| `app:status` | `{kind:'loading'\|'ready'\|'error', message?:string}` | boot, ready, fatal |
| `app:cards` | `{cards:CardInfo[], active:string}` | boot; a best changed |
| `app:state` | `{state:State, reason:'boot'\|'user'\|'hash'\|'card'\|'reset'\|'random'}` | every state change |
| `app:info` | `{sats:SatInfo[], sel:number, ticks:RepeatTick[]}` (ticks for the selected needle) | with every `app:state` |
| `app:tick` | `{day:number, running:boolean, metrics:Metrics, card:CardStatus\|null}` | at most 10 per second while running; once on pause, finish, reset |
| `app:toast` | `{key:string, params?:object}` | closed key list in DESIGN.md |
| `app:selftest` | `{passed, total, items}` | after `app:about-open` (once) or `#test=1` |
**UI -> main (artisan emits, engineer listens):**
`app:set-sat {index, patch:Partial<Sat>}` · `app:add-sat {}` (copy of the selected needle, node + 90) · `app:remove-sat {index}` · `app:select-sat {index}` · `app:set-view {view}` · `app:set-speed {speed}` · `app:set-season {season}` · `app:set-terminator {on}` · `app:toggle-play {}` · `app:step {days:1}` (advance exactly that many days, then pause) · `app:reset {}` · `app:pick-card {id}` (`'free'` or card id) · `app:peek-par {}` · `app:tune-sso {index}` · `app:snap-repeat {index, dir:0\|-1\|1}` (0 nearest, -1 next lower, 1 next higher; prefers `tight` ticks) · `app:randomize {}` · `app:share {}` · `app:about-open {}`.
Behaviour owned by main: every change except play, pause, step, speed, view, terminator and needle selection restarts the run at day 0 (debounced 120 ms), then **catches up** at full speed (8 ms per frame) to day 2 (or the card horizon if shorter) before slowing to the chosen speed. Card locks override patches (toast `locked`, also for `app:set-season`). `app:pick-card` loads the card's `start` setup (`free` keeps the current needles), applies locks, clears `peeked`. `app:peek-par` loads `par.sats` and sets `peeked` (it stays set until the next `app:pick-card`). `app:add-sat` at the card's `maxSats` (3 in free mode) is refused with toast `maxSats`; `app:remove-sat` on the last needle with `minSats`; a new needle becomes the selected one. `app:randomize` keeps the number of needles and draws each from `mulberry32(seed + pressCount)`: `alt` 300 to 1400, `inc` 20 to 120, `ecc` 0 (7 in 10) or 0 to 0.3, `node` and `argp` anywhere, `swath` 110 to 500 unless locked, then toast `randomized`. At the card's horizon (or day 365 in free mode) the run stops, `finished:true`.

### 4.5 DOM skeleton (artisan creates all; ids are stable test hooks; `ui.js` is the only writer)
Containers: `#app[data-state=loading|ready|error]`, `#stage[data-view=flat|polar]` holding `canvas#map` (role=img, label refreshed at most every 2 s), `canvas#overlay`, `output#map-readout`. Playback: `#clock` (text `Day {floor(day)+1} · {hh:mm} UTC`, where hh:mm = 12:00 plus the fraction of the day, modulo 24 h), `button#btn-play[data-playing]`, `#btn-step`, `#btn-reset`, `select#speed` (0.25, 1, 4, 16), `#btn-view-flat` and `#btn-view-polar` (`aria-pressed`), `#btn-terminator`. Needles: `#sats` (dynamic `button.sat-chip[data-index][aria-selected]`), `#btn-add-sat`, `#btn-remove-sat`. Controls: `input[type=range]` `#ctl-alt #ctl-inc #ctl-ecc #ctl-node #ctl-argp #ctl-swath #ctl-season`, each with `data-param`, a `<label>`, `output#out-<param>` (`out-season` shows the date from `new Date(Date.UTC(2001, 2, 20 + season))` in UTC as "Mar 20"), and `[data-locked]` when a card fixes it; `#alt-ticks` (dynamic marks from `app:info.ticks`, positioned at `(alt-200)/1800` of the slider track: `tight` ticks tall and in `--accent` with `title` "{k} orbits in {m} days, tracks {spacing} km apart", other ticks with `m` <= 3 short, the rest not drawn), `#btn-snap`, `#btn-sso`, `#btn-random`, `#btn-share`, `#share-url` (readonly input, hidden until `shareManual`). Readouts (`dd`): `#ro-period #ro-apogee #ro-regress #ro-ltan #ro-revs #ro-shift #ro-repeat #ro-maxlat #ro-sunsync`. Score: `#sc-planet #sc-map #sc-overlap #sc-revisit #sc-drift #sc-lie`. Cards: `#card-list` (dynamic `button.card-item[data-card-id][data-badge]`), `#card-goal`, `progress#card-progress`, `#card-result`, `#btn-peek`, `#btn-free`. System: `#toast` (role=status), `#sr-announcer` (aria-live=polite), `#fatal` (role=alert, hidden), `#selftest-result`, `svg#icons` (symbols `i-play i-pause i-step i-reset i-flat i-polar i-share i-shuffle i-plus i-trash i-lock i-sun i-info i-eye i-wand`). About: `details.sed-about`, `.sed-making-of`, `ul.sed-sources` (placeholders removed).

### 4.6 CSS custom properties (artisan-owned; tokens listed so renderer and CSS agree)
Shell tokens `--bg --surface --fg --muted --border --accent --accent-fg --ring --radius --gutter --font --font-mono`, plus `--font-display --cloth --cloth-hole --land --city --night --grid --yarn-0 --yarn-1 --yarn-2 --glow`. Light and dark values are in DESIGN.md. `render.js` reads them through `getComputedStyle(document.documentElement)` on `setTheme()`; no colour literal lives in JS.

### 4.7 URL hash grammar
`#v=1&s=<sat>;<sat>;<sat>&i=<sel>&c=<card|free>&w=<flat|polar>&sp=<speed>&se=<season>&t=<0|1>&seed=<int>[&test=1]`, where `<sat>` = `alt,inc,ecc,node,argp,swath`. Written with `history.replaceState` at most every 500 ms after a change, in this key order, `alt` 2 decimals, `inc` 2, `ecc` 3, `node` 1, `argp` 1, `swath` 0. `parseHash` rules: unknown keys ignored; a missing or non-numeric field takes its default and sets `repaired`; numbers clamp to 4.1; more than 3 sats truncate; unknown `v`, card id, view or speed take the default; `i` clamps to the sat count; a card's locks override the hash; with no `s`, the card's `start` setup is used (the default scene for `free`). Default (empty hash): the free-knit scene with the two default needles of 4.1, `c=free`, `w=flat`, `sp=1`, `se=0`, `t=1`, `seed=1011`. `repaired` -> toast `badLink`. `playing` and `peeked` are runtime-only and never written to the hash (`parseHash` returns both `false`). A `hashchange` that differs from the last written value re-parses (`reason:'hash'`).

### 4.8 localStorage
Single key `sed.orbital-knitwear.v1`: `{"v":1,"best":{"<cardId>":{"score":number,"badge":string}},"prefs":{"speed":1,"view":"flat","terminator":true}}`. Every read and write is in try/catch; a failure or bad JSON means in-memory defaults and one toast `storageOff`; the page behaves identically without it.

### 4.9 Boot order and lifecycle (main.js)
1. First statement: `window.__sedThumbReady = new Promise(...)` (resolved at step 6). Inline artisan script: a 6 s watchdog that shows `#fatal` if `#app[data-state]` is still `loading`; `<noscript>` and `nomodule` messages.
2. `loadStore()`, `parseHash(location.hash)`; apply card locks.
3. `createUI({seed, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches})` (inside try/catch; failure -> `app:status error`).
4. Emit `app:status loading`, `app:cards`, `app:state (boot)`, `app:info`.
5. `createSim(...)`; pre-roll to day 3 (day `card.days/2` if smaller) in slices of at most 40 ms, yielding with `setTimeout(0)` between slices.
6. `ui.draw(frame)`, emit `app:tick`, `app:status ready`; resolve `__sedThumbReady` after two animation frames; if `test=1`, run the self-test.
7. Autoplay at `speed` unless reduced motion (then paused; Space or the play button starts it).
Lifecycle: `init` (steps 1-6), `start` (rAF loop: `advance(speed*dt, 8)` with `dt` capped at 0.1 s; draw only if `grid.version`, state or theme changed), `pause` (also on `visibilitychange` hidden; resumes when visible), `reset` (new sim, day 0, catch-up). Self-test runs once, lazily on `app:about-open`, in slices.

### 4.10 Error contract
Engine functions (`orbit`, `coverage`, `cards`, `state`) never throw on user data: NaN or out-of-range inputs become the clamped default, unknown ids return `null` or are ignored. `main.js` wraps the rAF loop and every event handler: on an exception it logs once with `console.error`, emits `app:status {kind:'error', message}`, stops the loop, and the UI shows `#fatal` ("The yarn snapped", reload advice, and a Frog it button that does a full reset). Clipboard failure -> toast `shareManual` and `#share-url` is shown. Storage failure -> `storageOff`. A failing self-test never blocks the page; it shows red lines in the About panel.

## 5. Algorithms and numbers
### 5.1 Orbit (engineer)
`a=(RE+alt)/(1-e)`, `p=a(1-e^2)`, `n=sqrt(MU/a^3)` rad/s, `k=J2(RE/p)^2`. Secular rates (rad/s): `dOmega=-1.5 n k cos i`; `dw=0.75 n k (5cos^2 i - 1)`; `dM=n(1+0.75 k sqrt(1-e^2)(3cos^2 i - 1))`. Argument-of-latitude rate `dM+dw`; nodal period `2pi/(dM+dw)`.
Position at day `d`, `s=86400 d`: `M=dM*s` (M0=0, so a needle starts at perigee; circular orbits with `argp=0` start at the ascending node); solve `E-e sin E=M` by Newton (start `E=M`, or `pi` if `e>=0.8`; tolerance 1e-12; at most 12 iterations); `nu=2 atan2(sqrt(1+e) sin(E/2), sqrt(1-e) cos(E/2))`; `r=a(1-e cos E)`; `u=argp0+dw*s+nu`; `Omega=Omega0+dOmega*s` with `Omega0=node+GMST0`, `GMST0=SUN_DEG_DAY*season`. Unit vector `(x,y,z)=(cosO cos u - sinO sin u cos i, sinO cos u + cosO sin u cos i, sin u sin i)`; `lat=asin z`; `lon=atan2(y,x)-(GMST0+SIDEREAL_DEG_DAY*d)`; `altKm=r-RE`.
Sun: `lam=SUN_DEG_DAY*(season+d)`; `s=(cos lam, sin lam cos eps, sin lam sin eps)`; sub-solar `lat=asin sz`, `lon=atan2(sy,sx)-(GMST0+SIDEREAL_DEG_DAY*d)`; sun elevation at the needle `elevDeg=asin(x sx + y sy + z sz)`. Day 0 is 12:00 UTC at the chosen season. Local time is mean solar time: `ltanH=(12+node/15) mod 24`; `ltDriftHours(sat,days)=(dOmegaDegDay - SUN_DEG_DAY)*days/15` (signed).
Sun-synchronous: `cos i = -(SUN_DEG_DAY in rad/s)/(1.5 n k)`, `null` if its magnitude exceeds 1. `isSunSync` per 4.2. Critical inclination where `dw=0`: `acos(sqrt(0.2))=63.435` degrees.
Repeats: `revsPerDay(alt)=(dM+dw)/(SIDEREAL_RAD_S - dOmega)`, strictly decreasing in altitude. For `m` in 1..mMax and `k` in `ceil(m*f(altMax))..floor(m*f(altMin))` with **k and m coprime**, bisect (60 iterations) for `f(alt)=k/m`; `spacingKm=EQUATOR_KM/k` with `EQUATOR_KM=2pi*RE=40075.017`. `shiftDegOrbit=(SIDEREAL_DEG_DAY - dOmegaDegDay)*periodDays`.
### 5.2 Coverage (engineer)
One sample every `DT_S=4` s, from `j=0` (painted at reset). For each needle and sample: `rhoKm=max(swath/2, 55.66)`; paint every cell whose **centre** is within `rhoKm/KM_PER_DEG` degrees (great circle) of the sub-satellite point. Per painted cell: if `last<0` or `day-last>PASS_GAP_DAYS`: `hits=min(255,hits+1)`, and `first=day` when `last<0`; always `last=day`, `owner=index+1`; `grid.version` is assigned from a module-level counter that only increases and never repeats, even across `createSim` calls, once per `advance` that painted (and at creation), so renderers can cache by it safely. Cell area share `areaFrac(r)=(1/360)(sin(phiTop)-sin(phiBot))/2`.
Metrics: `planet=sum areaFrac[hits>0]`; `map=count(hits>0)/64800`; `overlap=sum areaFrac(hits-1)+ / sum areaFrac*hits` (0 if none); `revisitH=24*sum areaFrac(last-first)/(hits-1)` over cells with 2+ passes, divided by their `areaFrac` sum, `null` if none; `coverageIn(ranges)` = area-weighted share of hit cells among cells whose centre latitude lies in any `[a,b]` (inclusive); `northShare`, `twilightShare` = share of all samples (all needles, day 0 included) with `lat>=60` and with `abs(elevDeg)<=6`; `ltDriftH` for the selected needle.
### 5.3 Test vectors (computed by the architect's throwaway prototype with exactly these formulas; `selftest.js` and the engineer's Node checks must match)
| Check | Expected | Tolerance |
|---|---|---|
| `ssoInclination(600,0)` / `(700,0)` / `(705,0)` | 97.788 / 98.188 / 98.208 deg | 0.02 |
| `satInfo({alt:420,inc:51.6,ecc:0,...})` period / shift per orbit / node drift / max lat | 92.90 min / 23.61 deg / -4.951 deg per day / 51.6 | 0.05 / 0.05 / 0.01 / exact |
| same for `alt` 370, 460: shift | 23.36, 23.81 deg | 0.05 |
| `satInfo({alt:705,inc:98.2,ecc:0})` period | 99.00 min | 0.05 |
| `findRepeats` for `{inc:98.186,ecc:0,argp:0,swath:185}` contains `k=233,m=16` | alt 699.6 km, spacing 172.0 km, `tight` | 0.5 km |
| critical inclination | 63.435 deg | 0.001 |
| `sum cellAreaFraction` over all cells; polar-cap share beyond 60 deg | 1; `1-sin 60 deg = 0.13397` | 1e-9; 1e-4 |
| `ltDriftHours` 30 d, alt 705, inc 51.6 / 97.8 | -10.55 / -0.10 h | 0.05 |
| 16 d, `{alt:699.59,inc:98.186,ecc:0,node:0,argp:0,swath:185}` | `coverageIn([[-60,60]])>=0.999`, `planet=0.9925` | 0.005 |
| 3 d, swath 400: `{alt:420,inc:51.6,node:0}` / `{alt:500,inc:98,node:0}` planet | 0.716 / 0.806 | 0.01 |
| 10 d `{alt:705,inc:98.208,node:-90,swath:185}` / node 90: `twilightShare` | 0.81 / 0.41 | 0.02 |
| 4 d `{alt:500,ecc:0.74,inc:63.4,argp:270,swath:185}`: `northShare`, `apogeeKm` | 0.337, 39652 km | 0.015, 5 |
Sourced figures these support: 97.8 and 98.2 degrees (NASA primer, Skill-Lync), 51.6 degrees (NASA, ESA), 98.9 min and 233 orbits in 16 days at 705 km (NASA, about 0.1% and 0.8% from the model). The NASA tutorial's "near 22.9 degrees" per pass is a few percent below the model's 23.4 to 23.8 for 370 to 460 km (22.9 matches a 91.4 minute orbit); the page says so. Cost reference: 16 days, one needle is about 0.2 s in Node.
### 5.4 Pattern cards (engineer writes `cards.js`; every string below is verbatim copy)
Each card runs `days` simulated days. `sats` is the maximum number of needles (the start setup uses exactly that many). `score` 0..100 is maximised; `pass` is the condition. Badge: not pass -> `none`; score >= `par - 0.5` -> `heirloom`; >= `0.9*par` -> `sweater`; else `swatch`. `par` and `par.sats` are found offline by brute force with this very engine (throwaway Node script in the scratchpad, seeds below), baked into `cards.js`, and re-checked by `verifyPar`. If a baked par scores below the pass level, lower the pass level to `floor(0.95*par)` and write it in the file header comment.
| id | Title | days | sats | locks | score / pass | start setup | par seed |
|---|---|---|---|---|---|---|---|
| `first-swatch` | First Swatch | 3 | 1 | swath 400 | `100*planet` / `planet>=0.76` | 420 km, 51.6 deg | 500 km, 98 deg: 80.6 |
| `past-the-station` | Past the Station | 3 | 1 | swath 300 | `100*coverageIn([[-90,-51.6],[51.6,90]])` / `>=0.85` | 420 km, 51.6 deg | 600 km, 85 deg: 92.6 |
| `sixteen-day-weave` | Sixteen-Day Weave | 16 | 1 | swath 185 | `100*coverageIn([[-60,60]])` / `>=0.99` | 650 km, sun-sync tilt | 233/16 at 699.6 km: 100 |
| `same-time-tomorrow` | Same Time Tomorrow | 30 | 1 | swath 185 | `100*planet*max(0,1-abs(ltDriftH))` / `abs(ltDriftH)<=0.25 && planet>=0.95` | 705 km, 90 deg | sun-sync at 705: about 98 |
| `dawn-patrol` | Dawn Patrol | 10 | 1 | swath 185, season 0 | `100*twilightShare` / `>=0.65` | 705 km, sun-sync tilt, node 0 | node -90: 81 |
| `two-needle-cable` | Two-Needle Cable | 8 | 2 | swath 150 | `100*planet` / `>=0.97` | two 700 km, 98 deg, nodes 0 and 90 | 600 km, 98 deg, nodes 0 and 180: 99 |
| `linger-up-north` | Linger Up North | 4 | 1 | swath 185 | `100*northShare` / `>=0.30` | 700 km, 90 deg, ecc 0 | ecc 0.74 to 0.8, 63.4 deg, argp 270: 34 to 39 |
| `map-lies` | The Map Lies | 1 | 1 | swath 1500 | `100*max(0,map-planet)` / `map-planet>=0.09` | 420 km, 51.6 deg | 3000 km, 90 deg, ecc 0.5: 12 |
`goal` strings: First Swatch "Cover 76% of the planet's surface in 3 days with one needle (swath fixed at 400 km)." Past the Station "Cover 85% of the area beyond 51.6 degrees latitude in 3 days (swath fixed at 300 km)." Sixteen-Day Weave "Cover 99% of the band from 60 degrees south to 60 north in 16 days (swath fixed at 185 km)." Same Time Tomorrow "Cover 95% of the planet in 30 days while your local time at the node drifts less than 0.25 hours (swath fixed at 185 km)." Dawn Patrol "Spend 65% of 10 days within 6 degrees of sunrise (sun elevation between -6 and +6 degrees)." Two-Needle Cable "Cover 97% of the planet in 8 days with two needles (swath fixed at 150 km)." Linger Up North "Spend 30% of 4 days north of 60 degrees." The Map Lies "Make the flat map look 9 points more covered than the planet really is, after 1 day (swath fixed at 1,500 km)."
`blurb`: "Your first square of fabric." / "Knit where the space station can't." / "Landsat's trick: tracks that tile exactly." / "Keep the sun at the same angle." / "Ride the line between night and day." / "Two needles, one pattern." / "A stretched orbit that hangs over the pole." / "Make a flat map brag."
`hint` (shown on a miss): "Tilt the orbit toward the poles: the station's 51.6 degrees never sees the caps." / "The station tops out at 51.6 degrees. Go steeper." / "Look for the tall ticks on the height slider: those heights repeat with tracks closer than your swath." / "The tilt that makes the orbit turn with the sun is about 98 degrees. Try Tune sun-sync." / "You need a sun-synchronous orbit that crosses the equator at 6 in the morning: a start longitude near -90 degrees." / "Same height and tilt, start longitudes 180 degrees apart, then fine-tune the height." / "Stretch the orbit (eccentricity above 0.7), tilt it to 63.4 degrees, and point the perigee south (argument 270)." / "Polar orbits pile up stitches near the poles, which are huge on the map and tiny on the planet."
`passText` is "Pass: <condition in words>" (engineer's wording from the table). Peeking (`app:peek-par`) loads `par.sats`, sets `peeked`, and no best is saved this round.

### 5.5 Projections (artisan; `render.js` and the drag/hover maths in `ui.js` use the same formulas)
**Flat:** equirectangular, 2:1, `x=(lon+180)/360*W`, `y=(90-lat)/180*H`; caption "Flat map: the poles are inflated". **Polar:** Lambert azimuthal equal-area centred on the north pole, whole globe in one disc (centre = north pole, rim = south pole), square 1:1; with colatitude `theta=90-lat` the radius is `rho=2 sin(theta/2)` (0 to 2, scaled to the disc); Greenwich points down and east runs counterclockwise; inverse `colat=2 asin(rho/2)`, `lon=atan2` of the offset; caption "Equal-area view: a stitch is the same size on screen as on the planet". Both views sample the same 360 x 180 grid through a pixel-to-cell lookup table rebuilt only on resize or view change. The night shade uses `sin(elev)=sin(lat) sin(sunLat)+cos(lat) cos(sunLat) cos(lon-sunLon) < 0` per pixel (or per cell), drawn with `--night`.

## 6. Input model
Keyboard (one global `keydown` handler in `ui.js`; Ctrl, Meta and Alt combinations are never intercepted; inside a `select` or range slider the keys Space, Arrows, Home, End, PageUp and PageDown keep their native meaning; on a focused `button`, Space and Enter activate it, other shortcuts still work; `?` and `Escape` always work):

| Key | Intent event | Key | Intent event |
|---|---|---|---|
| `Space` | `app:toggle-play` | `S` / `,` / `.` | `app:snap-repeat` dir 0 (nearest) / -1 (next lower) / 1 (next higher) |
| `R` (Frog it) | `app:reset` | `U` | `app:tune-sso` for the selected needle |
| `D` | `app:step` 1 day | `[` / `]` | `app:pick-card` previous / next card (free mode sits before the first card) |
| `V` | `app:set-view` toggle | `P` | `app:peek-par` |
| `T` | `app:set-terminator` toggle | `L` | `app:share` |
| `1` `2` `3` | `app:select-sat` | `M` | `app:randomize` |
| `N` | `app:add-sat` | `?` | opens the About panel (`app:about-open`) |
| `X` or `Delete` | `app:remove-sat` (selected) | `Escape` | closes About, dismisses the toast |

Range sliders keep native Arrow, Home, End, PageUp/PageDown. Tab order follows reading order: back link, playback, needles, sliders, action buttons, cards, About.
Pointer and touch: horizontal drag on `#overlay` sets the selected needle's start longitude (flat: pixels to degrees; polar: angle about the pole) via `app:set-sat`; `touch-action: pan-y` so vertical scrolling still works; hover or long-press shows lat/lon, pass count and the stitch's true area (`R^2 * (pi/180) * (sin(phiTop)-sin(phiBot))` km^2) in `#map-readout`. Targets are at least 44 px; sliders have large thumbs. Every pointer action has a keyboard or button twin.

## 7. States
* **Loading:** `#app[data-state=loading]` shows "Casting on..." with the needle motif until the first frame (under 1.5 s).
* **Empty:** day 0 before anything is painted: bare linen with dashed preview and the hint "Press play, or nudge a slider, to start knitting." Free mode without a card is a normal state.
* **Error:** `#fatal` for engine or boot faults; toasts for recoverable ones (bad link, clipboard, storage).
* **Success:** card finished and `pass`: "Bound off!" banner, badge, score against par, Share and Next card buttons; a new best toast.
* **Failure:** finished and not `pass`: how many points short, the card `hint`, Try again (reset) and Peek at par.

## 8. About and making-of panel; FACTS POLICY
Policy: a number, date, rule or name is plain fact only when its `research.facts` source has `verified:true`. A claim from a `verified:false` source appears only as "as of 2026-10-11, per <source title>, reported, unconfirmed" or not at all. Anything invented is labelled simulated, computed here, or fictional. Only the seven `verified:true` sources are listed as sources (they were found through search and cross-checked between results; the team did not open every page, and the panel says so). The model constants (J2, Earth radius, gravitational parameter) are standard textbook values and are described as model constants, not as sourced facts.
Verbatim panel text (artisan; `.sed-making-of`, then sections):
* How it works: "Up to three satellites fly a two-body orbit with the J2 correction: Earth's bulge slowly turns each orbit's plane and perigee. Each pass is painted into a one-degree grid of stitches as wide as the satellite's swath. Scores weigh every stitch by its true area, so polar holes that look huge on a flat map count for little. This is a toy model, not a tracker: tracks drift from real satellites over weeks, and drag, the Moon and the Sun's pull are not modelled."
* What the sources say (as of 2026-10-11): "A sun-synchronous orbit needs its node to drift about 0.9856 degrees per day, which Earth's J2 bulge supplies; that takes about 98.2 degrees of tilt at 700 km (NASA primer) and about 97.8 degrees near 600 km (Skill-Lync). The International Space Station flies at 51.6 degrees inclination, so it never gets farther north or south than 51.6 degrees latitude, at roughly 370 to 460 km in orbits of 90 to 93 minutes; each pass lands about 22.9 degrees of longitude west of the last (NASA tutorial). Landsat 4 to 9 fly a circular sun-synchronous orbit near 705 km on a 16-day repeat of 233 orbits, about 98.9 minutes per orbit, tracks about 24.7 degrees (2752 km) apart at the equator, with a design swath of 185 km (NASA, USGS)."
* Computed here: "The model gives 97.79 degrees at 600 km and 98.19 degrees at 700 km, matching both sources. 233 evenly spaced tracks put neighbours about 172 km apart (40,075 km / 233), so a 185 km swath overlaps its neighbour by about 13 km (7 percent); the model's 233-in-16 repeat lands at about 699.6 km, 0.8 percent below Landsat's 705 km. The band beyond 60 degrees latitude is a third of a flat map but about 13 percent of the planet. The model shifts the station's track 23.4 to 23.8 degrees per orbit (370 to 460 km), a few percent more than the NASA tutorial's figure, which matches a slightly shorter orbit. The 63.4 degree tilt where the perigee stops turning comes from the same formula."
* Reported, unconfirmed: "As of 2026-10-11, per arXiv 2007.04341 (one search result): Molniya-type orbits use about 63.4 degrees of tilt, a 12-hour period and two apogees a day."
* Made up or hand-made: "Coastlines are hand-simplified outlines and city dots are approximate; there are no borders. Pars were found by brute-force search with this model. Card names, thresholds and yarn colours are the team's. The sun moves uniformly along the ecliptic (no equation of time)."
* Physics checks: `#selftest-result` fills with "N of N checks pass" and a list.
* Sources: seven `<li>`: title as in PROJECT.json, link, and one line on what it established. Plain anchors only.

## 9. Acceptance criteria
**Engineer** (min 600 own lines; hard floor for the whole tier 350): [ ] all test vectors in 5.3 pass in Node (`node` import of `orbit.js`/`coverage.js` works with no DOM) [ ] 8 cards baked with verified pars (`verifyPar` ok) [ ] hash round-trips and survives garbage [ ] events and payloads exactly as 4.4 [ ] toast keys only from the DESIGN list [ ] `advance` 8 ms budget respected; 16-day single-needle card finishes in under 5 s at 4 days per second on a mid laptop; boot to first frame under 1.5 s [ ] zero console errors, no throws on the monkey [ ] self-test runs lazily [ ] no network, no eval.
**Artisan** (min 750 own lines incl. CSS and HTML): [ ] every id in 4.5 exists; `createUI` works with only `app:*` events [ ] flat view plus polar view with inverse projection and LUT; terminator; wool look per DESIGN [ ] yarn layer redraw under 14 ms at 960x480 and at most 15 per second, overlay under 6 ms, internal size capped (about 1.4 M pixels desktop, 0.4 M under 600 px width) [ ] no horizontal overflow at 320, 360, 390 px; layouts at 360/768/1280; focus visible; labels and `aria-valuetext` on every slider; `prefers-reduced-motion` and `prefers-color-scheme` honoured [ ] About panel text verbatim, 7 sources, no placeholders (`data-sed-placeholder` removed) [ ] keyboard and touch twins for all actions [ ] favicon as an inline `data:` link (no 404).
**Budgets:** total JS+CSS+HTML under 200 KB; no long task over 120 ms after boot; memory steady (typed arrays reused).

## 10. Cut-list (drop in this order; the survivors still exceed the 350-line floor)
1. Polar view (hide `#btn-view-polar`; ignore `app:set-view` polar). 2. Card `linger-up-north`. 3. `selftest.js` and `#test=1` (About keeps a static "checks run in the team's build" line). 4. Hover/long-press readout and drag-to-set-longitude. 5. Season control and terminator shading (cards keep working). 6. Cards `dawn-patrol` and `two-needle-cable`. 7. Randomize, Peek.
**Must survive:** orbit engine with J2; coverage and true-area scoring with the planet-versus-map line; cards `first-swatch`, `past-the-station`, `sixteen-day-weave`, `same-time-tomorrow`, `map-lies` with pars; height slider with repeat ticks and Snap; Tune sun-sync; wool renderer in flat view; hash state; About panel with the facts policy; keyboard and touch; light/dark; reduced motion.

## 11. Answers to `mustFixInSpec`
`winnerNotes.mustFixInSpec` was empty and `risks` empty. The two `judgeWarnings` and the idea's own `design.risks` are answered as follows.
| Item | Answer in this spec |
|---|---|
| Coarse stylised land set, about a dozen polygons from memory | 4.3 `geodata.js`: at least 10 polygons, hand-simplified, labelled so in section 8; cosmetic only, no card depends on land |
| Keep OffscreenCanvas optional | Not used at all (Declined) |
| Unit-test the J2 and ISS figures | 5.3 test vectors, `selftest.js`, acceptance list |
| Cut polar view and Molniya first | Section 10, items 1 and 2 |
| No borders, plain-text citations, Molniya "as of ... per arXiv 2007.04341", tracks drift from real satellites | Section 8 verbatim text; no logos or imagery |
| Pars must be solvable | 5.4 prototype-calibrated thresholds, offline brute force, `verifyPar`, fallback rule |
| Coastlines may look crude | Embroidered-outline styling (DESIGN) |
| Two-body plus J2 is not a precision propagator; tests within about 1 percent | 5.3 tolerances (0.02 degrees on tilts, 0.8 percent on the Landsat altitude); section 8 and the About text say tracks drift over weeks |
| Wool texture at one degree risks dropped frames on phones | Yarn layer cached on a second canvas, redrawn at most 15 times per second, pixel budget scaled by width (section 9); scoring grid stays fixed (Declined) |
### Declined
* **Worker for the coverage grid** (idea hook): declined. A one-needle day is about 20 ms of work, the main thread time-slices at 8 ms per frame, and with two builders and no co-planning a Worker adds an untestable seam.
* **OffscreenCanvas** (idea tech tag, judge: keep optional): declined; the yarn layer is cached on an ordinary second canvas. `offscreen-canvas` and `worker` are removed from PROJECT.json `tech`.
* **Coarser scoring grid on small screens** (idea risk mitigation): declined, because scores and pars must be identical on every device and in every shared link. Only the renderer's internal pixel size scales down.
* **In-page brute-force par search** (idea hook): declined at runtime (seconds of blocking work on phones). Pars are found offline, baked, and re-verified in the self-test; the live repeat finder (4.3) stays in the page.

## 12. Test hooks
* Stable ids: `#app #map #overlay #clock #btn-play #btn-reset #btn-share #sc-planet #sc-map #sc-lie #card-list #card-goal #card-result #toast #fatal #selftest-result` and every id in 4.5. `#app[data-state]` is `ready` when the first frame is drawn.
* `window.__sedThumbReady`: a Promise set by the first statement of `main.js`, resolved two animation frames after the pre-rolled first frame is drawn (three days of wool, default free-knit scene).
* Reproducible runs: `#seed=<int>` (default 1011) seeds the yarn texture jitter and Surprise me (`mulberry32(seed + pressCount)`); a full setup is reproducible from the hash alone, and the simulation itself is deterministic (scores are stable to 0.1 points across browsers).
* `#test=1` runs the self-test at boot and opens nothing else. `window.__sed = {version:1, state(), metrics(), advance(days) -> Promise, ready:Promise}` is read-only apart from `advance`.
* Monkey safety: random clicks, keys, drags and resizes must never throw; Share must survive a denied clipboard.
