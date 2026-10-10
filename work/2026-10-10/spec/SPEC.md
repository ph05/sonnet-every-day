# Jokers In Phase: SPEC

Slug `jokers-in-phase` · 2026-10-10 (Day 1) · **TIER 2, compact build**: two builders (engineer, artisan), no co-planning, no revise loop, so the first build must be right. Lint floor 350 own lines (HTML, CSS, JS outside `data/`); plan 1,100 to 1,500; an owner heading below 60% of their section 3 budget tells the architect which feature went missing. Static, offline, no network, shell CSP unchanged, nothing third-party. The architect owns no file and integrates after the build.

## 1. Vision and the wow moment

A fan-made concept sandbox for joker-deck roguelikes where jokers have a beat. Five joker slots resolve left to right over four face-up, seeded poker hands (score = points x mult). Timing matters as well as order: a Pendulum swings between adding and multiplying, Fireflies flash on their own beats and pull rail-neighbours toward step (a simplified, integer-only rule in the spirit of Kuramoto coupling), and a Handshake multiplies only when both neighbours are in matching phase. Wow moment: the three Fireflies land in phase on one hand, the dark phase scope glows once and slowly, a gold concept card appears, and the share link replays the exact line in any browser.

## 2. Core loop and visitor journey

One beat: read the face-up deal and the "If you play now" preview, make at most ONE swap (rail-rail or rail-bench), play the hand, read the cascade. Four hands per round; hand 1 is auto-played with the opening rail, so swaps come before hands 2, 3, 4 (26 choices each, 17,576 lines, solved exactly). The rail is rearranged between hands, never set once.
- **10 s:** challenge 1 opens with hand 1 already played (a straight), the premise, the fan line, a glowing "Play hand 2".
- **First minute:** the coach explains points x mult left to right; the visitor swaps Twofold and Steady (Hint is always on in challenge 1), sees the preview jump, plays, reaches par by hand 4, gets a par card.
- **Tenth minute:** challenges 2 and 3 add coupling, then the Handshake. The lesson: the best-scoring rail is not the best-syncing rail, so the hunt is for silver and gold locks that need planning two hands ahead (greedy preview-chasing rarely finds them). Each finished round reveals the exact best score of its deal.
- **Coming back:** best scores and cards persist; Sandbox deals new seeds; `l=` links replay a friend's line.

## 3. File map

| path | owner | responsibility | approx lines | public API |
|---|---|---|---|---|
| index.html | artisan | shell intact (CSP first, back link, skip link, About, noscript), DOM skeleton, inline guard script, css link, one module script | 170 | ids in 4.5 |
| css/style.css | artisan | tokens, 360/768/1280 layouts, components, motion, reduced motion, dark | 380 | CSS vars (DESIGN.md) |
| js/ui.js | artisan | renders `app:state`; drag, tap-select, keyboard; cascade; announcements; coach; tabs; optional sound | 380 | `mountUI()` |
| js/ring.js | artisan | canvas phase ring | 110 | `createRing(canvas)` |
| js/art.js | artisan | SVG joker glyphs, card faces, concept card | 150 | `jokerGlyph`, `cardFace`, `conceptCard` |
| js/main.js | engineer | boot order, hashchange, test hook | 40 | none |
| js/game.js | engineer | controller: actions, view-model, hash, storage, events | 230 | `createGame()` |
| js/engine.js | engineer | pure rules: rng, deal, evaluator, advance, score, swap, play | 260 | 4.2 |
| js/solver.js | engineer | exhaustive search, hint | 90 | 4.2 |
| data/tables.js | engineer | constants and tables (data) | 40 | consts |
| data/challenges.js | engineer | three shipped challenges (data) | 10 | `CHALLENGES` |
| test/engine.test.mjs | engineer | headless tests, `node --test` | 150 | none |

## 4. INTERFACE CONTRACT

### 4.1 Module system
ES modules only: one `<script type="module" src="js/main.js">`, relative imports with `.js` extensions, no bundler, no dynamic import, no `fetch`. The only classic script is the small inline guard in index.html. `engine.js`, `solver.js`, `data/*` never touch the DOM (Node imports them). `ui.js`, `ring.js`, `art.js` never import engine files. The halves talk only through the two events below. No `console.error` anywhere (QA treats it as S1); use `console.warn`.

### 4.2 Exports (all synchronous)
```
ui.js      mountUI(): void            // finds elements by id, attaches listeners, listens for app:state on document
ring.js    createRing(canvas): { draw(vm, {reduced:boolean, t:number}): void, resize(): void }
art.js     jokerGlyph(id): SVGElement; cardFace({r,s}): SVGElement; conceptCard(card): SVGElement   // textContent only
game.js    createGame(): { start(hash:string): void, dispatch(action): void, vm(): ViewModel|null }
main.js    mountUI(); g=createGame(); g.start(location.hash); addEventListener('hashchange',()=>g.start(location.hash)); window.__jip={version:1, vm:()=>g.vm()}
engine.js  P=64, N_HANDS=4; mulberry32(seed):()=>float; makeDeal(seed); evalHand(cards5):0..8; openRound(seed,k):Round;
           swap(round,a,b):{round,ok,reason:null|'same'|'limit'}; undo(round):Round; play(round):{round,trace}; preview(round):Trace|null;
           ACTIONS (26); actionFor(baseRound,curRound):0..25; syncPct(ids,ph):0..100
solver.js  solve(round):{best,bestLine,maxLock,goldBest,goldLine}; enumerate(round,visit({line,total,lock,rail})):void; hintFor(round):{noop,a,b}
data/tables.js  SIN, HAND, JOKERS, OMEGA, PULL, W, F, TAU, LOCK        data/challenges.js  CHALLENGES
```
`Round` is the engineer's plain object (at least `seed,k,hand,rail,bench,line,total,lock`). Joker ids: `JOKERS = ['steady','twofold','tally','pendulum','handshake','lantern','ember','spark']` (the engine uses the index, the view-model the string).

### 4.3 Events on `document` (the only coupling)
- **`app:state`** (engine to UI): `detail = { vm: ViewModel, trace: Trace|null, animate: boolean }`, emitted synchronously after every dispatched action (rejected ones too) and after `start`. `trace` is the hand just scored (hand 1 after start/retry/challenge, the last replayed hand after a hash replay, null for swap/undo/hint/rejections). `animate` is true only for a user `play`; on any new `app:state` the UI first completes a running cascade instantly.
- **`app:action`** (UI to engine): `detail = Action`. The engine validates every field; unknown types are ignored; nothing throws.

| Action | params | valid when | effect |
|---|---|---|---|
| `{type:'play'}` | none | round not finished | commits the pending swap, scores the next hand |
| `{type:'swap', a, b}` | ints 0..7 (0-4 rail, 5-7 bench) | not finished | exchanges positions. Bench-bench or a===b: ignored silently. Rejected with notice `swap-limit` unless the result is the base arrangement plus at most ONE transposition (rail-rail, or one rail slot with one bench joker) |
| `{type:'undo'}` | none | `changed.length>0` | back to the arrangement after the last played hand |
| `{type:'retry'}` | none | always | restarts the deal, hand 1 auto-played, `attempt+1` |
| `{type:'challenge', id}` | 1, 2, 3 | always | starts that challenge |
| `{type:'sandbox', seed?, k?}` | seed 1..99999 (clamped, notice `seed-clamped`; omitted = `nextSeed(current)`), k 0..3 (omitted = current k when already in sandbox, else 2) | always | free deal, no cards |
| `{type:'hint'}` | none | not finished and `hintReady` | sets `vm.hint`; otherwise notice `no-hint` |

### 4.4 View-model and trace (all fields always present; the UI renders only from this)
```
ViewModel {
 v:1, fatal:boolean,
 notice: null | {code:'swap-limit'|'bad-hash'|'seed-clamped'|'line-clipped'|'no-hint'},
 mode:'challenge'|'sandbox',
 challenge:{id:0|1|2|3 /*0 = sandbox*/, seed, k:0..3, par:int, best:int, maxLock:0|2|3, bestSaved:int|null, cardSaved:Card, hasNext:boolean},
 round:{hand:1..4 /*hands played*/, hands:4, finished:boolean, attempt:int, misses:int, canPlay:boolean, canUndo:boolean, hintReady:boolean},
 deal:[{cards:[{r:2..14, s:0..3}x5], cat:0..8, base:{pts,mult}, status:'played'|'next'|'waiting', score:int|null} x4],
 pos:[8 joker ids]   /* 0-4 rail, 5-7 bench in ascending catalog order */,  changed:int[]  /* positions differing from the post-hand arrangement */,
 phases:{P:64, now:Row[4], next:Row[4]|null,
         bridge:null|{a:id,b:id,ok:boolean}},   /* Handshake in rail slot 1..3 with both neighbours phased: next-hand rings, ok = circ<=8 */
 sync:{n:int, now:int|null, next:int|null, lock:92},   /* percent; null when k==0 or fewer than 2 fireflies on the rail */
 total:int, lock:0|2|3, lockEvent:0|2|3,   /* lockEvent nonzero only on the state right after a hand that raised lock; lock and lockEvent stay 0 in sandbox and when k==0 */
 next: Trace|null   /* the projected hand for the current arrangement; null when finished */,
 hint: null | {noop:boolean, a:int, b:int},
 result: null | {total, par, parMet:boolean, lock:0|2|3, card:Card, best},
 share:{hash:string, card:{rail:[5 ids], seed, k, total, cid:0..3, line:string, tier:Card}}
}
Card = 'none'|'par'|'silver'|'gold'        Row = {id:'pendulum'|'lantern'|'ember'|'spark', ring:0..63, onRail:boolean, flash:boolean, side:0|1|null}
Trace = {hand:0..3, cat:0..8, pts0:int, mult0:int, steps:Step[5] /*slot order*/, pts:int, mult:int, score:int, flashN:int}
Step = {slot:0..4, id, kind:'add'|'mul'|'pts'|'idle', value:int, why:null|'out'|'back'|'flash'|'match'|'dim'|'edge'|'unphased'|'apart', n:int|null, pts:int, mult:int}
// value = amount added or factor applied (0 when idle); n = fireflies flashing together (why 'flash'), else null; pts, mult = running totals after the step
// hint a,b = positions to swap, both -1 when noop; share.card.tier = result.card once finished, else 'none'
```
A Row's `ring` is `ring/64` of a turn clockwise from 12 o'clock; the Pendulum is 0 (out) or 32 (back). The UI draws `phases.next` as the main dots (what scores if you play now) and `now` as faint ghosts. All human text belongs to the artisan (copy in DESIGN.md); the engine sends codes, ids and numbers only.

### 4.5 DOM skeleton (all created by the artisan; the engineer creates no DOM)
Shell parts kept: `a.sed-back`, `p.sed-day` ("Day 1 · 2026-10-10"), `h1.sed-title`, `p.sed-tagline`, `details.sed-about`, footer credit. Ids: `p#fan-note`; `nav#challenge-nav` with `button#btn-c1`, `#btn-c2`, `#btn-c3`, `#btn-sandbox` (`data-challenge`, `aria-current`); `p#coach`; `ol#deal` (children `li.hand[data-hand][data-status]`); `div#rail[role=group]` holding `button.slot[data-pos=0..4][data-joker]`; `div#bench[role=group]` holding `button.slot[data-pos=5..7][data-joker]` (classes `.is-changed .is-hint .is-grabbed`, `aria-pressed` while grabbed); `button#btn-play #btn-undo #btn-retry #btn-hint #btn-copy` and `#btn-sound[aria-pressed]`; `span#score-hand`, `span#score-total[data-value]`, `span#score-par`, `div#score-bar[role=progressbar]`; `section#scope` holding `canvas#ring[role=img]`, `div#sync-meter[role=meter]`, `table#phase-table`; `div#steps-panel` holding `button#tab-last[role=tab]`, `button#tab-next[role=tab]`, `ol#steps`; `section#result[hidden]`; `section#card-panel` holding `div#card-host` and `input#share-url[readonly]`; `section#sandbox[hidden]` holding `input#sandbox-seed[type=number][min=1][max=99999]`, four `input[name=k][type=radio]` (values 0..3), `button#btn-deal`, `button#btn-newseed`; `p#notice[role=status]`; `div#live[aria-live=polite]` (visually hidden); `div#fatal[hidden][role=alert]` with `button#btn-reload`. ui.js sets `html[data-ready="1"]` after the first render. Re-rendering must keep keyboard focus (restore by `data-pos`).

### 4.6 CSS custom properties
The engineer relies on none. The artisan owns the token set in DESIGN.md; shell tokens `--bg --surface --fg --muted --border --accent --accent-fg --ring` stay valid.

### 4.7 URL-hash grammar (written with `history.replaceState`, never by assigning `location.hash`)
`#c=<1|2|3>` or `#s=<seed>&k=<0..3>`, plus optional `&l=<letters>`. Parse: strip `#`, length at most 64, split on `&`, whitelist keys `c s k l` (unknown keys ignored, first duplicate wins); `c` matches `^[123]$`; `s` matches `^[0-9]{1,5}$` and is 1..99999; `k` matches `^[0-3]$` (default 2); `l` matches `^[a-z]{1,8}$`, clipped to 3 letters (notice `line-clipped`). A recognised key with an invalid value rejects the whole hash: fresh Challenge 1 plus notice `bad-hash`. Empty hash: Challenge 1, no notice. `c` beats `s` and `k`. `l` is replayed hand by hand with `animate=false`; each letter is an action index `0..25` as `a..z`, taken before hands 2, 3, 4 (`a` = no swap). Write the hash after each accepted `play`, challenge change or sandbox deal (not on swaps; at boot only if the incoming hash was invalid or clipped). `start` ignores a hash equal to the current `share.hash`. Rendered text comes only from enumerated ids, clamped integers and `textContent`; the hash never supplies free text.

### 4.8 localStorage (engineer `jip.v1.progress`, artisan `jip.v1.ui`; every access in try/catch; the page is correct without it)
`jip.v1.progress` = `{"v":1,"best":{"1":int,"2":int,"3":int},"card":{"1":Card,"2":Card,"3":Card}}`, validated on read (ints 0..99999999, enumerated cards, else ignored), written when a round finishes; a round that began from an `l=` link never writes (a friend's line is not your best). `jip.v1.ui` = `{"v":1,"muted":true}`.

### 4.9 Boot, lifecycle, errors
Boot: the inline classic script runs first and sets `window.__sedThumbReady = new Promise(r => window.__sedThumbResolve = r)` plus window `error` and `unhandledrejection` handlers that reveal `#fatal` and resolve the promise. Then main.js runs `mountUI()` (renders a "Dealing the cards" state), `createGame()`, `start(location.hash)`. Two animation frames after the first `app:state` render (or after 1,500 ms at the latest), ui.js calls `__sedThumbResolve()` and sets `html[data-ready=1]`. Pause: on `visibilitychange` hidden the UI stops animation frames and running animations; the engine has no timers. Reset: `retry`, `challenge`, `sandbox` or a new hash. Errors: engine and solver functions never throw for typed input; `dispatch` and `start` catch anything else, `console.warn`, and emit `vm.fatal=true`, after which the UI shows `#fatal` (Reload) and still resolves the thumbnail promise; storage failures are silent; a rejected action only sets `notice`.

## 5. Algorithms and numbers (frozen: do not tune, tell the architect)

```
P=64  N_HANDS=4  seed 1..99999  k 0..3 = Off, Soft, Medium, Firm      suits 0 spade, 1 heart, 2 diamond, 3 club
HAND[cat]=[pts,mult]: 0 High card [3,1]  1 Pair [6,2]  2 Two pair [9,2]  3 Three of a kind [12,3]  4 Straight [16,3]
                      5 Flush [18,4]  6 Full house [22,4]  7 Four of a kind [30,6]  8 Straight flush [40,8]
steady: mult+=4   twofold: mult*=2   tally: pts+=12   pendulum: side=(h+pOff)&1 -> 0 'out' mult+=8, 1 'back' mult*=2
handshake: mult*=3 if match   firefly: if flash, mult += F[k]*n          OMEGA lantern 7, ember 10, spark 13
PULL[k]=[0,3,5,8]  W[d]=[-,1000,500,250,125] (d = slot distance 1..4)  F[k]=[6,5,4,3]  TAU=8  LOCK=92
SIN[k]=round(1000*sin(2*pi*k/64)), k=0..63: generate once, commit as a literal. k=0..16: 0,98,195,290,383,471,556,634,707,773,831,882,924,957,981,995,1000;
  SIN[32-k]=SIN[k]; SIN[32+k]=-SIN[k]; sum of |SIN| = 40708; COS[k]=SIN[(k+16)&63]
```
- **PRNG:** `function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}`. Shuffle: `for(i=n-1;i>0;i--){j=Math.floor(rng()*(i+1)); swap(a[i],a[j])}`.
- **Deal(seed), fixed draw order:** rng=mulberry32(seed); shuffle deck [0..51]; hands = deck[0..4], [5..9], [10..14], [15..19]; card c has rank c%13+2 (11 J, 12 Q, 13 K, 14 A) and suit floor(c/13). Then phase0 of lantern, ember, spark = floor(rng()*64) in that order; pOff = rng()<0.5 ? 0 : 1; order=[0..7] shuffled; rail = order[0..4], bench = order[5..7] ascending. Hand index 0 is scored at once with the opening rail.
- **evalHand (9 exclusive categories):** straight flush (4 royal inside it), four, full house, flush, straight, three, two pair, pair, high card. A straight is five distinct ranks with max-min=4, or A-2-3-4-5; no wrap-around. The dossier's "eight hand types" was a miscount; none is dropped.
- **advance(rail, ph, k)** for firefly f in 5,6,7, reading only the OLD ph: `step=OMEGA[f]`; if k>0 and f is on the rail, `c = sum over other rail fireflies g of trunc(PULL[k]*W[|slot f - slot g|]*SIN[(ph[g]-ph[f])&63]/1000000)` and `step=clamp(OMEGA[f]+c,0,63)`. Then `raw=ph[f]+step; flash[f]=raw>=64; ph2[f]=raw&63`. Bench fireflies keep time (step=OMEGA) without coupling.
- **score(h)** after advance: `ring(id)` = pendulum ? (side==0?0:32) : ph2[id]; `circ(a,b)=min((a-b)&63, 64-((a-b)&63))`. Start `[pts,mult]=HAND[cat]`; n = rail fireflies with flash. For slot 0..4 apply the joker from the table. Handshake: only slots 1..3 with both neighbours phased (pendulum or firefly) and `circ(ring(L),ring(R))<=TAU` is a match (`why` 'match'); else idle with why 'apart', 'unphased' (a neighbour has no phase) or 'edge' (slot 0 or 4). A non-flashing rail Firefly is idle 'dim'. Hand score = pts*mult. All integer math; state, score and solver paths never call Math.sin, cos, exp, pow, log, sqrt, random or Date.
- **Lock** (k>0 only, after every hand incl. hand 1): `pct(set)` = largest integer p in 0..100 with `(sx^2+sy^2)*10000 >= p^2*(1000*|set|)^2`, sx=sum COS[ph2], sy=sum SIN[ph2]. Level 3: all three fireflies on the rail and pct>=92; else 2: some pair has pct>=92; else 0. Round lock = max over hands. `sync.now/next` = pct of all rail fireflies.
- **swap/play:** `swap` obeys 4.3 and keeps `base` (the arrangement after the last hand); the bench is re-sorted ascending after a rail-bench swap. `play` commits cur to base, appends the letter of the single action that turns the old base into cur (`actionFor`, 'a' if none), then advances and scores hand `round.hand`; `preview` runs the same advance and score for that hand on a copy. ACTIONS: 0 none; 1..10 rail pairs (0,1),(0,2),(0,3),(0,4),(1,2),(1,3),(1,4),(2,3),(2,4),(3,4); 11..25 = (rail r, bench t) at 11+3r+t. Letter = `String.fromCharCode(97+index)`.
- **Solver:** DFS over the 26 actions for each remaining window, ascending; `best` = max total, `bestLine` = the FIRST line in that order reaching it (same rule for `goldLine`); `maxLock` = highest lock on any line (0 when k==0); `hintFor` = first action of the best line from the base arrangement (`noop` when 'a'). A full solve takes about 13 ms in Node. **Par:** challenges use the stored `par`; sandbox par = floor(0.70*best). `hintReady`: challenge 1 and sandbox always, challenges 2 and 3 after 3 finished rounds below par (`misses`, per challenge since page load). **Card** (challenges only; lock counts only when k>0): gold if lock 3, else silver if lock 2, else par if total>=par, else none; sandbox is always 'none'.
- **Shipped data:** `CHALLENGES = [{id:1,seed:789,k:0,par:1025,best:1864},{id:2,seed:3338,k:1,par:1894,best:2706},{id:3,seed:9187,k:2,par:1531,best:2785}]`. `nextSeed(s) = ((Math.imul(s,1664525)+1013904223)>>>0) % 99999 + 1`.
- **Reference vectors** (from the architect's prototype; the test must reproduce them exactly). Deals: seed 789: cats 4010, phase0 L/E/S 59/51/28, pOff 1, rail spark,twofold,ember,tally,steady, bench pendulum,handshake,lantern, first hand 43 31 32 7 47. Seed 3338: cats 1040, phase0 51/36/38, pOff 1, rail steady,twofold,pendulum,tally,spark, bench handshake,lantern,ember, first hand 2 38 1 9 12. Seed 9187: cats 1004, phase0 41/29/36, pOff 1, rail steady,handshake,ember,twofold,pendulum, bench tally,lantern,spark, first hand 19 14 27 30 20. Phases (lantern, ember, spark) after hand 1 on `l=aaa`: C1 (2,61,41), C2 (58,46,51), C3 (48,39,49).

| hash | per-hand scores | total | lock |
|---|---|---|---|
| `#c=1&l=aaa` | 280, 180, 360, 90 | 910 | 0 |
| `#c=1&l=haa` | 280, 330, 432, 150 | 1192 | 0 |
| `#c=1&l=hra` (best) | 280, 330, 864, 390 | 1864 | 0 |
| `#c=2&l=aaa` | 432, 345, 784, 270 | 1831 | 0 |
| `#c=2&l=hqa` (best) | 432, 540, 1344, 390 | 2706 | 0 |
| `#c=2&l=hnz` (best gold) | 432, 540, 896, 135 | 2003 | 3 |
| `#c=3&l=aaa` | 144, 54, 60, 480 | 738 | 0 |
| `#c=3&l=uxm` (best) | 144, 195, 150, 2296 | 2785 | 2 |
| `#c=3&l=qlw` (best gold) | 144, 54, 1020, 420 | 1638 | 3 |

## 6. Input model
- **Pointer and touch:** tap a slot to select it (aria-pressed), tap another to swap (tap the same slot to deselect); or drag a slot onto another with pointer events (6 px threshold, ghost follows the pointer, release elsewhere cancels); `touch-action:none` on `.slot` only; buttons at least 44 px high.
- **Keyboard:** roving tabindex over the 8 slots; ArrowLeft/Right (and Up/Down) move focus, Home/End jump; Space or Enter grabs the focused slot, then Space or Enter on another slot drops (swap); Escape cancels. Global keys (no modifier, not inside an input): P play, U undo, R retry, H hint, M sound, 1 2 3 challenges, S sandbox. Every grab, swap, play and notice is announced in `#live`. There are no arrow buttons: tap-select and the keyboard cover them.

## 7. States
Loading: before the first state `#coach` reads "Dealing the cards" and Play is disabled. Empty: `#result` hidden and `#card-panel` shows a practice sketch until the round ends. Error: `vm.fatal` shows `#fatal`; `notice` codes render as one polite line in `#notice`. Success: par card, silver (two fireflies locked), gold (all three, one slow glow). Failure: below par shows the gap and Retry, and Hint after three misses. After the last hand swaps and Play are disabled until Retry, the next challenge or Sandbox.

## 8. About and making-of panel, FACTS POLICY
Plain facts on the page are only this page's own rules and numbers (labelled "invented for this concept"), values it computes (labelled "computed by this page") and the dated statements below; anything else is omitted. The panel (inside the shell's `details.sed-about`) says, in the artisan's wording of exactly this content and order:
1. **Fan line:** unofficial fan concept in the style of joker-deck roguelikes such as Balatro; not affiliated with or endorsed by its developer or publisher; no game art, fonts, logos or audio; numbers and art invented. The game's name appears only here, in `#fan-note`, in project.json and in tags.
2. **How it works:** score = points x mult; jokers act from the left slot to the right slot. Computed by this page: a pair is 6 points x 2 mult; Steady (+4 mult) then Twofold (x2) gives 6 x 12 = 72, Twofold then Steady gives 6 x 8 = 48. Points are only a score: nothing here costs or pays anything. Phases are whole numbers on a 64-step cycle with a fixed sine table, deals use a seeded shuffle, and the solver tries all 17,576 swap lines, so a shared link reproduces the same scores in any browser.
3. **Research, "as of 2026-10-10, per search results only (the pages were not opened)":** two community guides, Destructoid and Prima Games, state that joker effects resolve left to right, so additive mult belongs before multiplying mult; this page uses that rule as the guides describe it, not as a developer statement. The Kuramoto model is described as a model of phase-coupled oscillators, each with its own natural frequency plus a coupling term (Complexity Explorables, "ride my kuramotocycle"). A 2025 APS March Meeting abstract, "Relating the Kuramoto model to data from immobile firefly swarms", relates a Kuramoto variant to flash data from one firefly swarm. The Firefly rule here is a simplified invented cousin chosen for play, not a model of real fireflies. A Lua mod loader and API layer for the game exists (Steamodded repository); this page is a standalone web toy and ships no mod files. No claim is made that timing-based jokers are new to the genre.
4. **Sources** (exactly these five links, `target=_blank rel="noopener noreferrer"`, same list as PROJECT.json): Destructoid joker order guide; Prima Games "Four Things I Wish I Knew When Starting Balatro"; APS March Meeting 2025 abstract; Complexity Explorables "ride my kuramotocycle"; Steamodded (smods) repository. The footer credit "Built by the Sonnet Every Day team" stays visible.

## 9. Acceptance criteria and budgets
**Engineer** (about 650 non-data lines plus tests; floor 450):
- [ ] `node --test test/engine.test.mjs` passes within 30 s and asserts: exact category counts over all 2,598,960 hands (high 1,302,540; pair 1,098,240; two pair 123,552; three 54,912; straight 10,200; flush 5,108; full house 3,744; four 624; straight flush 40, of which 4 royal); SIN checksum and symmetry; the nine reference lines to the letter; shipped `best`, `bestLine`, `goldLine`, `par`; the depth criteria below; swap-limit rules; hash fuzz (random strings never throw, invalid means default plus `bad-hash`); `l` round trip; a source grep finding no `Math.random|Date|Math.sin|Math.cos|Math.exp|Math.pow|Math.log|Math.sqrt` in engine.js, solver.js or the state paths of game.js.
- [ ] Depth criteria per shipped challenge: line `aaa` is below par with lock 0; best >= 1.5 x median; at least 2 distinct final rails within 5% of best; best final rails differ across the three; C1 has a line with exactly one non-`a` letter reaching par; C2 and C3 have a gold share of lines between 1% and 10%, a best-score line that is not gold, and a best gold total between 0.5 and 0.9 of best and at or above par.
- [ ] `start` including the solve at most 100 ms; swap+preview and `play` at most 5 ms; no exception escapes `dispatch`; every field of 4.4 is present in every emission.

**Artisan** (about 1,150 lines; floor 700: html 130, css 300, ui 300, ring 90, art 130):
- [ ] Shell intact, every id of 4.5, no `data-sed-placeholder` left, `<title>` and `<h1>` exactly "Jokers In Phase", the fan line visible without scrolling at 360x640 and 1280x800, About per section 8.
- [ ] Renders every view-model field; reorder by drag, tap-select and keyboard; `aria-live` announcements; focus preserved; the ring has `role=img` with an aria-label updated each state, plus a real phase table; phase is never encoded by colour alone; suits and glyphs are SVG paths (no emoji, no Unicode card characters).
- [ ] No horizontal scroll at 320/360/390; five slots on one row at 360 (about 56 px); AA contrast in both schemes; the scope panel is dark in both schemes; reduced motion removes pulse, drift, blinks, tweens and cascade timing; hidden tab pauses; sound starts muted and a failed AudioContext is silent; challenge 1 is completable with the keyboard alone.
- [ ] Zero console errors; no request outside the page; first render within 300 ms of DOMContentLoaded; ring frame under 4 ms; DOM under 1,200 nodes; JS under 150 KB.

## 10. Cut-list (drop in this order; PNG export was already cut at spec time)
1. Sound (WebAudio ticks). 2. Ring idle shimmer and slot FLIP animation. 3. Challenge 3. 4. Sandbox mode and its controls. 5. Concept-card artwork (text-only card). **Must survive:** tested engine and solver, the rail with all three input paths, ring plus phase table, cascade log with preview, challenges 1 and 2 solvable, hash state, About panel, the fan line, the dark scope panel, abstract geometric glyphs drawn in code (no character art). If sound is cut, the packaging step removes `procedural-audio` from PROJECT.json.

## 11. Answers to winnerNotes.mustFixInSpec
1. Section 8. 2. Section 8: only the page's own computed example; every number is invented. 3. Section 8: five links, no novelty claim. 4. `#fan-note` in the first viewport; the game's name only in it, the About panel, project.json and tags; own identity (DESIGN.md: no CRT, pixel art, green felt, blue/red pairing, card-back pattern, mascot; system fonts); avoided words: Blind, Ante, Voucher, Tarot, Planet, Spectral, Stake. 5. "Points", never "chips"; line "Points are only a score: nothing here costs or pays anything"; banned in all copy: bet, wager, ante, payout, pay out, jackpot, cash, coin, buy, shop, reroll, "real money", currency symbols. 6. Section 5 and 9: nine categories, A-2-3-4-5, exact counts. 7. Section 5: 64-step integer phases, literal SIN, mulberry32, no trig in state paths, reference lines in the test and for the browser check. 8. Section 5: pure `play` and `preview` return the traces the UI renders; exact solver; shipped seeds came from a build-time search (the architect's prototype) and the test re-verifies them; other deals show `challenge.maxLock` ("best rail locks n of 3") and a New seed button; Hint. 9. Sections 2, 5, 9: rail rearranged each beat (one swap); minute ten is the silver and gold hunt; 8 jokers for 5 slots; distance-decaying W; Handshake rules at edges, unphased neighbours and the matching tolerance (8 ticks, the Pendulum sits at ring 0 or 32); the rail is always full, so no empty slots; the finished state; depth tests. 10. Section 5: coupling fixed per challenge (Off, Soft, Medium), priced by detent in the sandbox (flash bonus 6, 5, 4, 3), sandbox gives no card or glow. 11. Section 4.4 and 4.9: the preview shows the next scoring phases, animation only tweens between discrete states, hand 1 is auto-played, `__sedThumbReady`, dark scope panel. 12. Section 2 and the DESIGN.md coach copy; ladder par, silver, gold; copy link always. 13. Section 4.7. 14. Sections 6 and 9. 15. DESIGN.md motion: one 900 ms glow, under 10% luminance change, never repeated within 4 s; fewer than 2 firefly blinks per second in total; sound muted by default. 16. Header, section 3 budgets, section 10.

### Declined and adapted
- **Item 16 "state tier 1, aim 900 to 1,300 lines, floor 700": declined.** The orchestrator fixed tier 2 and floor 350; the SPEC states tier 2, plans 1,100 to 1,500 and keeps the critic's cut order and must-survive list.
- Item 5 "keep chips": adapted to "points" (stronger). Item 8 "hint reveals one working rail": adapted to one working swap. Item 12 "Fireflies arrive in challenge 2, Handshake in 3": adapted; all eight jokers exist everywhere, challenge 1 has coupling off, and the coach introduces coupling in 2 and the Handshake in 3. Item 7 "0 to 1023 ticks": adapted to 64, same determinism.
- Item 14 "arrow buttons": declined; tap-select and the keyboard already cover them.
- Item 1(a) "one uncontrolled forum report" and 1(d) "Mirollo and Strogatz, SIAM 1990": omitted, no recorded source for either. Blueprint, Brainstorm, Community College Pack, Mistigris, Nexus and Georgia Tech entries are not used. Operator note, outside the page: do not post the link in the game's official community spaces.

## 12. Test hooks
- Hash states reproduce runs: `#c=1..3` with `&l=` lines, or `#s=<seed>&k=<k>&l=<letters>`; the nine lines in section 5 give exact totals. `#s=3338&k=1&l=hqa` equals challenge 2's numbers but earns no card.
- `window.__sedThumbReady` (a Promise that never rejects) resolves after the first render or on a fatal error; `window.__jip.vm()` returns the latest view-model; `html[data-ready="1"]`.
- Stable DOM: `#score-total[data-value]`, `.slot[data-pos][data-joker]`, `.hand[data-hand][data-status]`, `#btn-play`, `#sync-meter[aria-valuenow]`.
- QA greps: `balatro` appears only in index.html (fan line, About); no banned wager words; no hosts beyond the five source links; the monkey run stays clean.
