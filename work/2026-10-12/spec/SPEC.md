# Between Periods: SPEC (tier 2, compact day, two builders)

Slug `between-periods`, title "Between Periods", date 2026-10-12, "Day 3". **engineer** owns the logic (6 files), **artisan** owns look and feel (6 files). You cannot see each other's code: sections 4 to 6 are binding. Where this document is silent, take the most natural reading, code defensively, and record the assumption in `work/2026-10-12/build/notes/<owner>.md`. Visible copy lives in artisan files; DESIGN.md has the voice and the microcopy list.

## 1. Vision and the wow moment

Intermission, and the rink is a wreck: skate grooves, divots, snow ridges and one seeded mishap (a shower of hats, a leaking tank). You drive an invented ice-resurfacing machine (nickname "Old Glossy") that always rolls forward at a steady pace and cannot turn tighter than a fixed radius. Every pass lays one stripe of water; ice under a wet stripe turns glossy and its scars vanish. The wow moment is the wet-ice sheen: a bright stripe trails the machine and dries to mirror gloss behind it while a half-wrecked sheet becomes a skating surface. A limited tank empties with distance, a refill door sits in the boards, the buzzer is the clock. You finish with a "gleam" grade (S, A, B, C, D), a spoiler-safe postcard of your lap pattern, a copy-text emoji strip and a challenge link. The rink is seeded from the UTC date, so everyone shares today's sheet, and the same seed with the same inputs always scores the same.

## 2. Core loop and visitor journey

Loop: read the rink (scars, refill door, mishap) -> plan lanes under the turning limit -> drive (steering only; speed is automatic, plus an optional slow) -> refill when low -> buzzer, or every reachable scar gleams -> grade -> retry, practice or share.
* **10 seconds**: the page opens on a half-gleaming rink with a demo lap leaving a sheen trail (reduced motion: the same frame, static). Enter or Start rolls the machine out of the door; the first steer lays a glossy stripe and scars disappear under it.
* **First minute**: you learn that it cannot turn on a dime (a predicted arc helps), that water drains with distance and refills in the door zone, and that dull passes (empty tank) do not count. First grade lands around C or B. The result card shows the postcard, stats and share buttons.
* **Tenth minute**: you compare strategies (skip-lane mow, spiral, racetrack) with "Watch a lap", rehearse in no-clock practice, chase S on today's rink, and try a friend's challenge link.
* **Coming back**: tomorrow's rink arrives at 00:00 UTC; best result per seed kept locally; challenge links; typed seeds.

## 3. File map (all paths relative to `work/2026-10-12/build/site/`)

| path | owner | responsibility | ~lines | public API |
|---|---|---|---|---|
| `index.html` | artisan | page shell, DOM skeleton (4.6), About panel, inline favicon, one module script | 220 | DOM ids |
| `css/style.css` | artisan | tokens, layout at 360/768/1280, components, motion, reduced motion | 450 | `--rk-*`, classes |
| `js/render.js` | artisan | canvas renderer: rink, scars, gleam layer, sheen, machine, arcs, fx, portrait rotation | 520 | `createRenderer` |
| `js/ui.js` | artisan | HUD, buttons, dialog, toasts, live region, coach line, copy table | 380 | `createUI` |
| `js/audio.js` | artisan | WebAudio synth, muted by default (optional module) | 150 | `createAudio` |
| `js/postcard.js` | artisan | postcard canvas from `Result.route` (optional module) | 200 | `drawPostcard` |
| `js/main.js` | engineer | boot and wiring (4.10) | 80 | none |
| `js/sim.js` | engineer | PRNG, rink generator, kinematics, grid, scoring (pure) | 480 | `createRink`, `createSim` |
| `js/bot.js` | engineer | three planners, headless runner (attract, watch, autoplay, tests) | 260 | `makePlanner`, `runBot` |
| `js/game.js` | engineer | fixed-step loop, input, phases, prefs, hash sync, events | 420 | `createGame` |
| `js/share.js` | engineer | hash grammar, challenge compare, share text | 130 | `parseHash` etc. |
| `test/selftest.mjs` | engineer | Node proof: determinism, 365-seed attainability, depth, hash fuzz | 220 | `node test/selftest.mjs` |

Line counts are targets; the floors are in section 9.

## 4. INTERFACE CONTRACT

### 4.1 Module system
ES modules only. `index.html` has exactly one script, `<script type="module" src="js/main.js">`, last child of `<main>`. Relative imports with the `.js` extension; no classic scripts, no bundler, no globals except `window.__sedThumbReady` and `window.__sedState`. Static imports: `main -> game, render, ui`; `game -> sim, bot, share`; `bot -> sim`. `render.js` and `ui.js` have no static project imports. Optional modules `audio.js` (loaded by `main.js`) and `postcard.js` (loaded by `ui.js`) are loaded with dynamic `import()` inside try/catch: a failure disables sound or the postcard canvas, never the page. `sim.js`, `bot.js` and `share.js` touch no DOM, no `window`, no `Math.random`, no clock (`share.todaySeed` takes `nowMs`).

### 4.2 Exports (sync unless marked)
```
sim.js    TICK_HZ=60; TUNING (frozen object, values in section 5); MISHAPS=['hats','drip','slush','gate','puddle']; GRADES=['D','C','B','A','S']
          hashSeed(s:string):uint32            // FNV-1a over UTF-16 code units
          mulberry32(a:uint32):()=>number      // [0,1)
          sinq(x) cosq(x) atan2q(y,x)          // polynomial; only + - * / sqrt (no Math trig, pow, exp, log in sim.js)
          createRink(seed:string):Rink         // pure
          createSim(rink:Rink, opts?:{timed?:boolean}):Sim
  Sim     { rink, grid:{cols,rows,cell,scar,reach,done}, m:{x,y,a,speed,steer,tank,door,dry,contact}, tick, ended:null|'complete'|'buzzer'|'finish',
            step(steer:int -32..32, slow:0|1):number   // exactly one tick; bit flags 1 bump,2 refillStart,4 refillEnd,8 tankLow,16 tankEmpty,32 ended
            stats():Stats  finish():void  result(mode:'timed'|'practice'|'auto', seed:string):Result
            fresh:{idx:Int32Array(4096), n:number}  clearFresh():void
            predict(steer:number, out:Float32Array):number    // 24 points [x,y] every 5 ticks of travel; returns count
            digest():string }                                 // FNV-1a hex over tick, pose, tank, done grid, counters
bot.js    PLANNERS=['mow','spiral','race']
          makePlanner(name, rink, opts?:{jitterDeg?:number, seed?:uint32}):{name, control(sim):{steer:int, slow:0|1}}   // returns a reused object
          runBot(seed:string, name:string, opts?:{jitterDeg?, maxTicks?, timed?}):{result:Result, ticks:number}
share.js  SEED_RE=/^[A-Za-z0-9_-]{1,24}$/;  isValidSeed(x:any):boolean;  todaySeed(nowMs:number):string     // UTC 'YYYY-MM-DD'; callers pass Date.now()
          parseHash(hash:string, nowMs:number):{seed, challenge:{grade,feet}|null, auto:'mow'|'spiral'|'race'|null, note:''|'bad-hash'|'bad-seed'}   // never throws; one leading '#' is stripped first
          buildHash({seed, challenge?}):string              // no leading '#'
          gradeRank(g):number (D0 C1 B2 A3 S4, else -1);  beats(r:{grade,feet}, c:{grade,feet}):boolean   // higher rank, or equal rank and fewer feet
          shareText(result:Result, url:string):string       // format in 4.8
game.js   createGame({canvas, toLogical:(clientX,clientY)=>({x,y})|null}):Game
  Game    { boot():Promise<void>                  // resolves after the first frame has been drawn (autoplay: after the run ends)
            onFrame(cb:(view:View, nowMs:number)=>void):()=>void     // unsubscribe
            getView():View;  actions:Actions;  destroy():void }
render.js createRenderer(canvas:HTMLCanvasElement):Renderer          // throws Error('canvas2d-unavailable') without a 2D context
  Renderer{ draw(view:View, nowMs:number):void     // re-measures canvas box and devicePixelRatio (cap 2) on every call; rebuilds layers when view.rink or view.gridVersion changed or view.fresh.n<0
            toLogical(clientX,clientY):{x,y}|null  // client px -> rink feet, undoing portrait rotation; null only if the canvas has zero size
            isPortrait():boolean                   // true when canvas.clientHeight > canvas.clientWidth
            dispose():void }
ui.js     createUI(root:HTMLElement, actions:Actions):{update(view:View):void}   // update diffs and touches the DOM only on change; clock text at most 10x/s
audio.js  createAudio():{unlock():void, setMuted(m:boolean):void, play(code:string, n?:number):void, update(view:View):void}   // every call is a safe no-op before unlock, when muted, or without WebAudio
postcard.js drawPostcard(canvas:HTMLCanvasElement, result:Result):void   // sets 1200x630 and draws; always the dark-ice palette
```

### 4.3 Data schemas (produced by engineer, read-only for artisan)
```
Rink  { seed, id:uint32, w:200, h:85, cornerR:28, cell:0.5, cols:400, rows:170,          // feet, game scale; x right, y down; idx = row*cols+col, col=floor(x/cell)
        marks:{ redX:100, blueX:[75,125], goalX:[11,189], dots:[[x,y]x9], circleR:15, centerR:15,
                creases:[{x,y,r,dir}x2], nets:[{x,y,w,d,dir}x2] },                         // the renderer draws exactly these
        // dots: centre (100,42.5), neutral zone (80|120, 20.5|64.5), end zones (31|169, 20.5|64.5); circles of circleR on the four end-zone dots and centre;
        // creases: r 6 half discs on the goal lines at y 42.5, dir +1 on the left, -1 on the right; nets: 6 wide, 3.3 deep behind the goal line centre
        door:{x,y,w,h,nx,ny},                    // refill rect centred on (x,y), inside the rink against a straight board, h >= 12 so the machine centre fits; (nx,ny) unit normal pointing into the rink
        start:{x,y,a},                           // machine start pose, inside the door rect, facing into the rink
        mishap:{ id:one of MISHAPS, zone:{x,y,w,h}|null, items:[{x,y,a,k}] },             // hats: items with style k 0..3; slush/puddle: zone; gate: door moved
        scar:Uint8Array, reach:Uint8Array,       // scar: 0 clean 1 groove 2 divot 3 snow ridge 4 hat; reach: 1 where a stripe can reach
        scarTotal:number,                        // count of cells with scar>0 and reach=1
        tune:{swath,radius,body,tankMax,clockTicks,tickHz} }
Stats { gleamPct:0..100 (0.1 steps), left:int, feet:int, tidyPct:0..100 (int), refills:int, bumps:int, cleanLaps:int, points:0..1000, grade:'S'|'A'|'B'|'C'|'D' }
Result extends Stats { seed, mode:'timed'|'practice'|'auto', reason:'complete'|'buzzer'|'finish', ticks:int, seconds:number (0.1), route:Int16Array, beat:boolean|null }
        // route = x*10,y*10 pairs, one point per 12 ticks, at most 3000 points; beat = set by game.js: true when the result beats the loaded challenge (share.beats), null without one
View  { v:1, phase:'boot'|'ready'|'playing'|'paused'|'done', mode:'attract'|'auto'|'timed'|'practice', seed, seedIsToday:boolean,
        rink:Rink, gridVersion:int, grid:{cols,rows,cell,scar,reach,done},      // done: Uint8Array, 0 untouched 1 dull (shaved dry) 2 gleam
        fresh:{idx:Int32Array,n:number},                                        // cells whose done changed this frame; n=-1 means resync from grid
        tick:int, clockTicks:int (0 = untimed),
        m:{x,y,a,speed,steer,tank,tankMax,door,dry,contact},                    // interpolated render pose; a radians, 0=+x, positive steer=right turn (a grows), steer -1..1
        stats:Stats, arcs:{now,left,right:Float32Array(48), n:int},             // predicted paths (4.2 predict); left/right are full-lock arcs
        aim:{x,y}|null, challenge:{grade,feet}|null, best:{points,grade,feet}|null,
        prefs:{sound:boolean, assist:boolean, shake:boolean}, result:Result|null }
```
`view` is one object mutated in place each frame; `grid.scar/reach` are the rink's arrays (never written), `grid.done` is the active sim's. `gridVersion` increments whenever the rink or the sim is replaced.

### 4.4 Events (`document.dispatchEvent(new CustomEvent('app:<name>', {detail}))`, dispatched by game.js; `app:error` also by main.js)
| event | detail |
|---|---|
| `app:phase` | `{phase, mode, seed, reason}`; reason is boot, start, pause, resume, hidden, finish, restart, load or cancel |
| `app:note` | `{code, n?}`; codes: `tank-low` (n=percent), `tank-empty`, `refill-start`, `refill-done`, `bump` (n=bumps so far), `milestone` (n=25, 50 or 75, once each per run), `bad-hash`, `bad-seed`, `storage-off`, `autoplay` (n=speed multiplier), `challenge` (a challenge link was loaded) |
| `app:finish` | `{result:Result}` (also in `view.result`) |
| `app:error` | `{where, message, fatal:boolean}` |

Events carry codes and numbers, never prose: ui.js owns every user-facing string. `game.js` also sets `html[data-phase]` and `html[data-mode]` on every `app:phase`.

### 4.5 Actions (`game.actions`, given to `createUI`)
`start(mode:'timed'|'practice')` (from ready or done; while playing or paused it restarts) / `pause()` / `resume()` / `togglePause()` / `restart()` (same rink and mode) / `finish()` (grade now) / `loadSeed(text):{ok,seed,code:''|'bad-seed'}` / `loadToday()` / `watch(name)` (bot lap at 2x) / `setPref(name:'sound'|'assist'|'shake', on:boolean)` / `setSlow(on:boolean)` / `shareText():string` / `shareLink():string`. All safe in any phase (ignored when meaningless), all synchronous. Clipboard writes happen in ui.js (`navigator.clipboard.writeText` in try/catch; fallback: show the text in `#share-text`, selected).

### 4.6 DOM skeleton (artisan creates everything; E marks what engineer code touches)
* `html[data-boot]` loading (in markup) / ready / error (main.js) E. `html[data-phase]` (markup value `boot`) and `html[data-mode]` written by game.js E.
* `#boot-note` p (visible while loading); `#boot-error` div[role=alert][hidden] with `#boot-error-text` span (main.js fills and unhides) E.
* `#app` div (root passed to `createUI`, holds all play UI) E. `#rink` canvas[tabindex=0][role=img][aria-label] E; `touch-action:none` on `#rink` only.
* HUD: `#hud`, `#hud-clock` (mm:ss; practice shows elapsed), `#hud-tank` (role=meter, aria-valuemin/max/now; child `#hud-tank-fill`; classes `is-low`, `is-dry` set by ui.js), `#hud-gleam` (percent), `#hud-laps` (clean laps), `#hud-feet`, `#hud-grade` (provisional `stats.grade`).
* Text: `#coach` p, `#rink-info` p (seed, UTC note, mishap line), `#banner` div (challenge and hash notes), `#toasts` div, `#live` div[aria-live=polite] visually hidden.
* Buttons (`<button type="button">`): `#btn-start`, `#btn-practice`, `#btn-watch` with `#watch-select` (select: mow, spiral, race), `#btn-pause`, `#btn-slow` (aria-pressed), `#btn-sound`, `#btn-assist`, `#btn-shake` (aria-pressed), `#btn-finish` ("Call it"), `#btn-restart` ("Again"), `#btn-result` (reopen result).
* Seed group `div[role=group]` (never a `<form>`: the CSP is `form-action 'none'`): `#seed-input` (text, maxlength 24, autocomplete off), `#btn-seed-load`, `#btn-seed-today`, `#seed-note`.
* Result `<dialog id="result">`: `#res-grade`, `#res-title`, `#res-line`, `#res-stats` (dl), `#res-challenge`, `#postcard` (canvas), `#share-text` (readonly textarea), `#btn-copy-text`, `#btn-copy-link`, `#btn-save-card`, `#btn-result-close`, `#btn-result-again`.
* About: the shell's `details.sed-about`, `.sed-making-of`, `ul.sed-sources`.
* Visibility is CSS on `html[data-phase]` (start controls in ready, play controls in playing and paused, result button in done). ui.js moves focus to `#rink` (`preventScroll`) when a run starts, and to the dialog heading when it opens.

### 4.7 CSS contract
Shell tokens keep their names and meanings: `--bg --surface --fg --muted --border --accent --accent-fg --ring --shadow --radius --gutter --font --font-mono`. `css/style.css` is linked after the shell's inline `<style>` and overrides the token values (DESIGN.md). Rink colours are `--rk-ice --rk-dull --rk-gleam --rk-scar --rk-red --rk-blue --rk-machine --rk-ink --rk-water --rk-apron`, read by render.js with `getComputedStyle` (re-read on colour-scheme change). The engineer relies on none of them.

### 4.8 URL hash, share text, storage
Hash grammar: `#k=v&k=v`, keys `s` (seed `^[A-Za-z0-9_-]{1,24}$`), `c` (challenge `^[SABCD]-[0-9]{1,5}$`, grade and feet), `a` (autoplay: mow, spiral or race). Whole hash must match `^[A-Za-z0-9_=&.-]{0,512}$` (no percent-decoding; `+` and `%` are rejected), else defaults plus note `bad-hash`. Unknown keys ignored, duplicate keys: first wins, a known key with a bad value falls back to its default (`bad-seed` for `s`, `bad-hash` otherwise). Defaults: seed `todaySeed(now)`, no challenge, no autoplay. After each load, seed change or finish, game.js writes the canonical hash with `history.replaceState` (try/catch); a `hashchange` listener reloads. `buildHash` emits `s` always and `c` only after a timed run.
Share text (4 lines, `\n` separated): `Between Periods · rink <seed>` / `[Practice · ]Gleam <grade> (<points> pts) · <feet with thousands commas> ft · <cleanLaps> clean laps` / ten glyphs, `Math.round(gleamPct/10)` of `🟦` then `⬜` / `<url>`. `url` = `location.origin + location.pathname + '#' + buildHash(...)` (challenge only for timed runs). No names, no free text.
localStorage key `sed.between-periods.v1`, JSON `{v:1, sound:false, assist:true, shake:true, best:{"<seed>":[points,"<grade>",feet]}}`, at most 40 seeds (drop oldest), every access in try/catch, validated on read, any failure means defaults plus one `storage-off` note. Written on pref change and on a finished timed run only. `shake` defaults to false under reduced motion.

### 4.9 Phases and lifecycle
`boot -> ready` (attract demo running) `-> playing <-> paused -> done -> playing or ready`. `start` in ready or done begins a fresh run; `loadSeed`, `loadToday` and `hashchange` go to ready with a new rink; the tab becoming hidden pauses a playing run (reason `hidden`); a visible tab never auto-resumes. The run ends on the buzzer (timed, tick >= clockTicks), on `complete` (gleamPct >= 99.5) or on `finish`. Autoplay (`#a=`) runs at 16x real time (at most 16 ticks per frame) to `done`; `watch()` runs at 2x; any key or pointerdown on the canvas cancels either (reason `cancel`, back to ready).

### 4.10 Boot order (main.js, one try/catch)
1. Find `#rink` and `#app`, else fatal. 2. `createRenderer(canvas)`. 3. `createGame({canvas, toLogical:(x,y)=>renderer.toLogical(x,y)})`. 4. `createUI(app, game.actions)`. 5. `await import('./audio.js')` and `createAudio()` in their own try/catch (a failure only leaves `audio` null). 6. `game.onFrame((v,t)=>{renderer.draw(v,t); ui.update(v); audio&&(audio.setMuted(!v.prefs.sound), audio.update(v));})`. 7. Map events to `audio.play(code)`: `app:note` code as is; `app:phase` reason `start` -> `start`; `app:finish` -> `buzzer` when reason is buzzer, else `chime`. 8. One-time capturing `pointerdown` and `keydown` listeners call `audio.unlock()`. 9. `window.__sedState = ()=>({phase,mode,seed,tick,gleamPct,grade,points,tank,x,y,a,gridVersion})`; `window.__sedThumbReady = game.boot()`. 10. On resolve set `html[data-boot=ready]`. On any error: `data-boot=error`, text into `#boot-error-text`, dispatch `app:error` fatal.

### 4.11 Error contract
Nothing throws on bad runtime input (hash, storage, pointer coordinates, wrong phase). The only throw is `canvas2d-unavailable`, caught in main.js. Each frame runs in try/catch: on an exception game.js pauses, dispatches `app:error {where:'frame', fatal:false}` once and `console.error`s once; ui.js shows a banner with "Restart". Normal operation never logs to the console. Missing DOM ids in ui.js are skipped silently (guard every lookup).

## 5. Algorithms and numbers (engineer; starting values, tune within the bounds)
`TUNING`: swath W=8, radius R=10 (R/W in [1.0, 1.5]), body 4.5, speed 18 ft/s, slowMul .5, doorMul .4, slushMul .6, bumpMul .6, tankMax 100, waterPerFt 1/7 (a full tank lasts 450 to 900 ft), refillPerSec 45, dripPerSec .9, lowTank 25, clockTicks 9000 (7200 to 10800), cell .5, reachDepth 1.0, freeOverlap .10, bands S 900 / A 780 / B 620 / C 450, bumpPenalty 6 (cap 60). Final numbers go into `TUNING`; the measured results go into `build/notes/engineer.md`.
* **Tick** (dt=1/60, integer ticks; the clock is `tick`): `mul=min(1, slow?.5:1, door?.4:1, slush?.6:1, contact?.6:1)`, `v=speed*mul`, `kappa=(steer/32)/R`, `a+=kappa*v*dt` (wrap to (-pi,pi] by +-2pi), `x+=cosq(a)*v*dt`, `y+=sinq(a)*v*dt`. The radius is R at any speed. No reverse.
* **Boards**: signed distance to the rounded rectangle (centre (100,42.5), half extents (100,42.5), corner 28): `qx=|x-100|-72, qy=|y-42.5|-14.5, d=sqrt(max(qx,0)^2+max(qy,0)^2)+min(max(qx,qy),0)-28`, depth `=-d` (no `Math.hypot`). If depth < body, push the centre inward along the gradient (slide, never stop), `contact=true`; a bump counts when contact starts after 20 contact-free ticks. `reach[cell]=1` iff depth(cell centre) >= reachDepth.
* **Stripe**: each tick, for sub-poses at most 0.25 ft apart along the travelled segment, mark cells at lateral offsets `j*0.25` for `|j*0.25| <= W/2` (lateral unit vector `(-sinq a, cosq a)`), only inside the rink. Tank > 0: `done=2`; else `done=1` where `done==0`. Newly changed cells go to `fresh`. Afterwards `tank -= travelled*waterPerFt` (and `tank -= dripPerSec*dt` under the drip mishap), clamp at 0. The tank starts at `tankMax`. Door rect: `tank += refillPerSec*dt`; flag 2 on entering it with the tank below `tankMax-5`, flag 4 when the tank reaches `tankMax` or the machine leaves after adding >= 20 (that visit also counts `refills++`). Flag 8 when the tank first falls below `lowTank` (re-armed above 40), flag 16 at 0 (re-armed above 5).
* **Stats**: `fixed` = reachable scar cells with `done==2`, `gleamPct = 100*fixed/scarTotal`; `gleamArea` = cells with `done==2` times cell area; `tidyPct = 100*min(1, gleamArea/(feet*W*(1-freeOverlap)))` (100 while feet < 20); `cleanLaps` counts straight runs (|steer| <= 6/32) of >= 180 ticks where >= 85% of marked cells were previously untouched. `points = clamp(round(1000*cov*sqrt(cov)*(0.8+0.2*tidyPct/100)) + timeBonus - min(60, 6*bumps), 0, 1000)` with `cov=fixed/scarTotal`, `timeBonus = timed and cov>=.9 ? round(100*ticksLeft/clockTicks) : 0`. Grade from `bands`, else D. Run ends `complete` at gleamPct >= 99.5.
* **Generator** (`mulberry32(rink.id ^ 0x9e3779b9)`; only `sinq`, `cosq` and `sqrt` for geometry): wear clustered on creases, the nine faceoff spots, the centre circle and the boards; about 24 to 34 grooves (arcs and lines, 1 to 2 cells wide), 36 to 52 divots (r 1 to 2.5 ft), 5 to 9 snow ridges, then the mishap; scars only where `reach==1`. Door on a straight board at least 12 ft from any corner arc; start inside the door. `scarTotal` in [2000, 7000] and 5 to 12 percent of reachable cells on every seed.
* **Mishaps** (hats and drip first): `hats` 12 to 18 hats as scar 4 (r .9 ft); `drip` tank starts at 85 and loses `dripPerSec`; `slush` a 30x14 ft zone, speed x.6; `gate` the door sits at the far end; `puddle` an r 9 ft zone where steer is halved.
* **Prediction**: `predict` integrates the same tick law with constant steer; `arcs.left/right` use steer -32/+32.
* **Pointer aim** (game.js; the sim only sees integers): `d=wrap(atan2(ty-y,tx-x)-a)`; inside 8 degrees steer 0; beyond that `sign(d)*min(1,(|d|-8deg)/17deg)` (full lock from 25 degrees); aim closer than 1.5R is ignored. Keys give -1, 0 or +1 and override the aim. Input is quantised to `round(s*32)` once per tick.
* **Attract**: for `rink.id%3` choose a planner, run `2100` ticks headless before the first frame, then continue live (reduced motion: frozen, never continues); restart when it ends or passes 5400 ticks. Practice has no clock. The demo's numbers are shown under a "Demo lap" chip.

## 6. Input model
* **Keyboard** (document-level; ignored when focus is in `#seed-input`, with Ctrl, Meta or Alt, and Space or Enter when a button or link has focus): `ArrowLeft`/`A` steer left, `ArrowRight`/`D` steer right, `ArrowDown`/`S` hold to slow, `Space` start (ready) or pause/resume, `P` pause, `Enter` start timed (`Shift+Enter` practice), `Escape` pause or close the dialog, `R` restart (not while playing), `M` sound. Handled keys call `preventDefault` only while the target is body or `#rink`.
* **Pointer** on `#rink`: mouse steers toward the pointer while it hovers (no click); touch and pen steer toward the finger while down; first pointer id only; release or leave clears the aim. Tapping the canvas while paused resumes; in ready it does nothing (starting is always explicit). `pointerdown` uses `setPointerCapture` (try/catch). No wheel listener anywhere: a wheel over the rink scrolls the page. `#btn-slow` is a toggle for touch.
* Every action has a keyboard path and a 44 px touch target; visible focus ring on `#rink`.

## 7. States
* **Loading**: `data-boot=loading` shows `#boot-note`. **Empty**: ready phase with the demo and idle "best: none yet". **Error**: fatal text in `#boot-error`; a frame error shows a banner; bad hash and bad seed show notes and fall back to today's rink; storage off shows a note; no WebAudio disables `#btn-sound` with a title. **Success**: the result dialog (grade, postcard, challenge beaten line, effects for B or better). **Failure**: buzzer with a low grade reads kindly (DESIGN.md); a dry tank turns the gauge `is-dry` and the toast says passes only shave.

## 8. About & making-of panel and FACTS POLICY
The panel (artisan, in `index.html`) holds: `.sed-making-of` = PROJECT.json `makingOf` verbatim (the integrator deletes any sentence about tests that did not run and pass, and updates both files together); "How it plays" (controls, tank, grade); "Real and made up"; "Sources" = `ul.sed-sources` with exactly the nine PROJECT.json sources, same labels and URLs, the last three under "Craft notes". Links are plain `<a href>`; no other external link exists anywhere (validate.mjs makes any undeclared host an error at tier 2).
A number, date, rule or name is plain fact only when its fact is verified:true; every real-world fact below carries "as of 2026-10-12, per <labels>":
* F1 the 2026-27 NHL season opened on 29 September 2026 (sources 1, 2); said once, in the About panel only, with no scores, banner, team or player names.
* F2 a resurfacing pass shaves a thin layer, carries the shavings by augers to a snow tank, sprays water, and picks up dirty water with a vacuum and squeegee (3, 4).
* F3 the Model A of 1949 had four-wheel steering that was cut back to front-wheel steering after it jammed against the boards (4, 5, 6); never "the first machine".
* F4 daily browser puzzles commonly seed the day's puzzle from the date, many reset at 00:00 UTC (7, 8, 9), labelled "craft notes".
* F5 earlier ice-resurfacing games exist: "a browser doodle from 2013 and at least one commercial game, per our own web searches, as of 2026-10-12" (search-only, so no link, no names).
* F6 simplification: one pass here has three zones (shave, wash, squeegee) along the machine and spends tank water; a real machine does shave, wash, vacuum and flood in one pass. The refill door is a game rule.
Everything else is labelled game scale, invented, simulated or stylized: the machine and its nickname, livery, mishaps and hats, scars and wear, the 150 s clock, tank units, speeds, distances, grades and the 0.5 ft grid. The rink is "stylized, drawn to rough rink proportions"; no dimension is printed. The daily seed is the UTC date and the panel says so. Excluded: hockeyschedules.net, the 1947 prototype, real intermission length, real machine speed or tank size, team and player names, the emergency-goalie story, "first", "new" or "never before" claims.

## 9. Acceptance criteria (tier minimum 350 own lines; this spec expects 1,400 or more honest lines)
**Engineer (>= 700 lines)**
- [ ] `node test/selftest.mjs` prints `{ok:true,...}` in under 90 s: T1 same seed and inputs give equal `digest()` and result across 3 scripted routes, chunking of 1, 7 and 60 ticks per call, and a golden digest; T2 for the next 365 UTC dates from 2026-10-12 every scar cell has `reach==1`, `scarTotal` and scar share are in range, and the best planner reaches >= 95 percent inside clock and tank; T3 on 100 seeds at least two planners have median gleam >= 90 percent in time, the best beats the simplest (mow) by >= 40 median points or >= 8 percent median time, and a +-3 degree jitter costs the best planner at most one grade band; T4 hash fuzz (2,000 seeded random and hostile strings never throw, outputs satisfy the grammar).
- [ ] Time box: two tuning rounds; if T3 still fails, ship the best numbers and record them. T1 and T2 never ship failing.
- [ ] No `getImageData`, no `Math.random`, no wall clock in the sim path; the loop clamps frame time to 50 ms, runs at most 4 ticks per frame (16 in autoplay, 4 in watch), and pauses on `visibilitychange`.
- [ ] Keyboard-complete play, pointer and touch steering, hash/storage/error contracts, events and `view` exactly as 4.3 to 4.5.
- [ ] Budgets: a tick under 0.05 ms, first frame ready under 250 ms on desktop, no per-frame allocation in the tick loop.
**Artisan (>= 700 lines)**
- [ ] Every id in 4.6 exists; no `<form>`, no inline handlers, inline SVG favicon (no `/favicon.ico` request), one module script, shell parts intact.
- [ ] Viewport contract (section 11, item 6) holds in ready and playing; no horizontal overflow at 320; contrast AA; focus ring on every control; reduced-motion twins for every effect.
- [ ] Renderer: draw cost under 8 ms at 1366x768 DPR 1 (2.5 MP backing store cap), layers at 4 px per foot, sheen limited to the last 48 path segments, scars readable by shape and luminance.
- [ ] About panel follows section 8 exactly; all strings from the DESIGN.md copy list; `textContent` only for dynamic text.
- [ ] First frame (thumbnail composition in DESIGN.md) is strong at 1200x630 light.
**Both**: payload under 250 KB, DOM under 450 nodes, no external request, CSP unchanged, `node --input-type=module --check` passes on every `.js`, notes written to `build/notes/<owner>.md`.

## 10. Cut-list (drop in this order; the first items go first)
1. `#btn-watch` and `watch()` (keep the `#a=` hook). 2. Mishaps beyond `hats` and `drip`. 3. `postcard.js` and `#btn-save-card` (keep the text strip and links). 4. `audio.js` chime, then all sound (hide the toggle if the module is absent). 5. Sparkle, final-buff and confetti effects, then the left/right turn arcs (keep the current-steer arc). 6. Attract motion (keep the precomputed half-gleaming frame). 7. The racetrack and spiral planners (keep mow plus one). The ghost replay is already cut.
**Must survive**: deterministic scoring and T1/T2, tank and refill, practice mode, the viewport contract, keyboard-complete play, hash validation, the About panel with section 8, `__sedThumbReady`.

## 11. Answers to winnerNotes.mustFixInSpec
1. **Determinism**: accepted (4.2, 5, 9). 60 Hz integer ticks in logical feet, grid scoring, no pixel reads, trig by polynomial so results match across browsers; T1.
2. **Attainable objective**: accepted. `reach` is depth >= 1 ft, so no scar sits where the body cannot go (R = 10 is well under the 28 ft corner radius); `gleamPct` is the share of reachable scar cells; mishaps are zones or small items that never block a lane; T2 asserts par on 365 seeds.
3. **Controls and geometry**: accepted. R/W start 1.25, no reverse, predicted arcs, 8 degree dead zone ramping to full lock at 25 degrees (refined: smooth, not bang-bang), 10 percent free overlap, keys at full rate.
4. **Depth proof**: accepted with a time box (two tuning rounds, then record the numbers); T3 as in section 9.
5. **Honest machine model**: F6 and the refill-door label in section 8.
6. **Viewport contract**: at 1366x768, 390x844 and 360x640, in ready and playing at scrollY 0, the rects of `#rink`, `#hud-clock`, `#hud-tank` and the primary button (`#btn-start` or `#btn-pause`) lie fully inside the viewport; portrait draws the rink rotated (long axis vertical); `touch-action:none` on `#rink` only; no wheel listener, so `mouse.wheel` over the rink moves `scrollY` whenever the page is taller than the viewport. The artisan runs a Playwright script (reuse the loader in `scripts/qa/browser-check.mjs`; browsers in `/opt/pw-browsers`) against a stub view, writes `build/notes/viewport.json`; the integrator re-runs it on the integrated page; QA attaches the same numbers.
7. **Facts policy**: section 8.
8. **Brand and people hygiene**: no maker's name, livery, mark or silhouette in copy, title, meta, alt text, file names or UI (source URLs are the only place it can appear); the machine is mustard and charcoal, nicknamed "Old Glossy"; league name only in F1 and the sources list; no teams, players or incidents; mishaps are labelled "invented".
9. **Rink drawing**: `marks` use the proportions listed (200 x 85, corner 28, goal lines 11 ft from the ends, blue lines 75 ft from the ends, 15 ft circles, all nine spots, creases, nets, red line); the page says "stylized" and prints no dimensions; wear clusters on creases, spots and boards.
10. **Prior art and vocabulary**: F5 only; no "first/new/never before"; visible words are gleam, clean laps, tidy, pass, stripe, tank (never "swath", "overlap waste", "true area").
11. **Pitch versus scope**: ghost cut now; tagline, description, About and share text promise a challenge link (seed, grade, feet); cut order in section 10.
12. **Link and storage safety**: 4.8, 4.11. Seeds only via `SEED_RE`; `textContent` only; no names.
13. **Audio, motion, accessibility**: audio muted by default with a visible toggle, context created on the first gesture, chime D5-A5-F#5 (not G-E-C), playable by keyboard alone, focus ring, `#live` announcements for tank and grade, reduced motion means static hats, no shake, instant sheen, flashes under 3 per second, scars distinguished by shape and luminance.
14. **First frame and performance**: attract demo or precomputed half-gleaming frame, `__sedThumbReady`, `#a=` hook, sheen on first movement, DPR cap 2, no readbacks.
### Declined
* **A separate refill key** (item 13): refill is automatic in the door zone (the machine slows there). Steering stays the only continuous control, so touch has parity, and the keyboard path stays complete.
* **Open-ended tuning to satisfy the depth proof** (item 4): replaced by the two-round time box in section 9, because a compact day has no revise slack.

Injection check: the idea file and the critic notes held no request to leave the repo, read secrets or use the network (no INJECTION ATTEMPT).

## 12. Test hooks
* Stable ids: all of 4.6. `html[data-phase]`, `[data-mode]`, `[data-boot]`.
* `#s=<seed>` fixes the rink (`#s=qa1`); `#a=mow|spiral|race` autoplays at 16x real time to the result dialog and postcard (typically 5 to 10 seconds); `#s=qa1&c=A-1400` loads a challenge.
* `window.__sedThumbReady`: a Promise from `game.boot()`, resolving after the first frame shows the half-gleaming attract state (with `#a=`, after the run ends).
* `window.__sedState()`: `{phase, mode, seed, tick, gleamPct, grade, points, tank, x, y, a, gridVersion}`.
* Node: `node test/selftest.mjs` (JSON on stdout, exit 1 on failure). Seeds for QA runs: `qa1` to `qa100` and any UTC date.
