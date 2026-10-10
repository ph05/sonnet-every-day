# Engineer notes: Jokers In Phase (2026-10-10, tier 2)

Files (all under `work/2026-10-10/build/site/`): `js/main.js`, `js/game.js`, `js/engine.js`, `js/solver.js`, `data/tables.js`, `data/challenges.js`, `test/engine.test.mjs`.
Run `node --test test/engine.test.mjs` from the site folder: 44 tests, about 7 s, all green.

## What was verified
- All nine reference lines (per-hand scores, totals, lock), the three reference deals (cats, phase0, pOff, rail, bench, first hand) and the phases after hand 1 reproduce exactly.
- The exact solver returns the shipped `best`, `bestLine`, `goldBest`/`goldLine` for all three challenges (C1 1864 `hra`; C2 2706 `hqa`, gold 2003 `hnz`; C3 2785 `uxm`, gold 1638 `qlw`).
- Every depth criterion in SPEC section 9 holds on the shipped seeds (best/median 2.27, 1.92, 3.27; gold share 4.14% and 4.11%; gold best 0.74 and 0.59 of best; one-swap-to-par lines exist in C1; best rails differ).
- Exhaustive evalHand counts over all 2,598,960 hands match, 4 royal.
- The optimised step equals a naive restatement of the rules on 6,000 random configurations; lock and `syncPct` agree with a floating-point oracle.
- `start` including the solve: about 16 ms cold and 4 ms warm in Node (about 60 ms with the JIT switched off); swap plus preview about 0.03 ms.
- The real gate (`scripts/validate.mjs project --tier 2`, run on a scratch copy) reports no error or warning about my files; its only complaint was the not-yet-made thumbnail.
- Mutation check: 20 deliberate engine and controller bugs (tolerance, truncation, clamp, lock threshold, flash edge, bench order, pendulum side, weights, bench Fireflies counted, wheel straight, pair lock on bench Fireflies, glow repeat, hint with pending swap, misses, link saves, anchor reset, notice, par ratio, solver tie, card order) were each caught by at least one test.
- In real Chromium (scratch copy, local server only): `scripts/qa/browser-check.mjs` returned ok with 0 console errors, 0 page errors, 0 non-local requests, a clean 146-action desktop and 68-action mobile monkey run; all nine reference lines replay through `hashchange` with the same scores and the on-screen total; keyboard and tap play-through, drag swap, skip link, bad hash, throwing storage and reload-from-hash all behave.

## Readings of ambiguous contract text (the integrator should know these)
1. `evalHand` takes five card numbers 0..51 (rank `c % 13 + 2`, suit `floor(c / 13)`); the view-model converts to `{r, s}`.
2. `vm.share.hash` includes the leading `#` (so it compares equal to `location.hash`). The UI strips and re-adds it, which is fine either way.
3. Lock pairs ("some pair has pct >= 92") count only Fireflies on the rail. The reference table confirms it: counting benched Fireflies would give lock 3 for `#c=2&l=aaa` and 2 for `#c=3&l=aaa`, where the table says 0.
4. `sync.n` is the number of Fireflies on the current (pending) rail; `sync.now` and `sync.next` are the percent of those same Fireflies at the post-hand phases and at the projected next-hand phases; both are null when `k == 0` or `n < 2`.
5. `phases.now` rows describe the hand just scored (`onRail`/`flash` per the arrangement that scored); `phases.next` rows describe the projection of the pending arrangement. `flash` is true only for a Firefly that wrapped past the top while on the rail. Benched Fireflies keep their `ring` moving but never flash.
6. `phases.bridge` is derived from the projected trace: the Handshake step is `match` (ok:true) or `apart` (ok:false); `edge` and `unphased` give null.
7. A hash whose recognised keys name no deal (`#l=hra`, `#k=1`) is rejected (`bad-hash`). A hash with only unknown keys (`#main`, the skip link) is "foreign": ignored while a game is running (otherwise the skip link would reset the round) and treated as empty at boot.
8. `retry`, `challenge` and `sandbox` all rewrite the URL hash (the spec lists play, challenge and sandbox; retry is added so a reload never replays the abandoned line).
9. `attempt` increases whenever the deal already on the table is started again (retry, the same sandbox seed and coupling, a same-deal link); a different deal resets it to 1. The UI uses `attempt` in its freshness key.
10. A pending swap is put back (undo) before `hint` computes, so `hint.a/b` always match the arrangement on screen. Positions follow the post-hand bench order (rail slot with bench joker `t` is `(r, 5 + t)`).
11. Every action clears `notice` and `lockEvent` first. `lockEvent` is nonzero only on the emission after a `play` that raised the round's lock (and on a start or replay whose last hand raised it), so the glow cannot repeat on later swaps.
12. Unknown action types and non-object actions emit nothing. Well-formed no-ops (play when finished, undo with nothing to undo, a bench-bench swap) still emit a state, as the contract says. A swap with non-integer positions is a silent no-op; numeric strings are accepted for `a`, `b`, `id`, `seed`, `k`.
13. `sandbox` seed: numeric strings accepted, truncated, clamped to 1..99999 with notice `seed-clamped`; a non-numeric seed falls back to `nextSeed(current)` with the same notice; `k` is clamped to 0..3 and defaults to the current coupling in the sandbox, else 2.
14. Progress is written only when a challenge round (not a sandbox, not a replayed link) finishes: `{"v":1,"best":{"1":n,"2":n,"3":n},"card":{...}}` with 0 and `"none"` meaning nothing saved. `bestSaved` is null when nothing is saved. Best and card never go backwards.
15. `misses` counts finished challenge rounds below par since page load, per challenge, never reset, never counted for replayed links.
16. `syncPct` follows the written formula exactly, so two Fireflies on the same phase can read 99% for phases whose table vector is a hair short of 1000 (for example phase 1). The 92 lock threshold is unaffected.

## Beyond the listed exports (harmless extras)
- `engine.js`: `LETTERS`, `FIRST_FIREFLY`, `nextSeed`, `project` (the preview with its phases, flashes and lock), `stepInto`, `makeScratch`, `applyInto`.
- `tables.js`: `COS`, `FX`. `game.js`: `parseHash`; `createGame(env)` takes an optional `{target, storage, writeHash}` so the controller can be tested headless (browsers pass nothing).
- `actionFor` returns -1 when the arrangements differ by more than one action (the contract says 0..25 for valid input).
- `enumerate` visits a reused object; `rail` is an `Int8Array(5)` of joker indices. Copy what you keep.

## Deviations from the spec
- None in rules, numbers or signatures.
- The engine and controller are larger than the planned 650 lines (788 non-data lines, 0 padding) and the test file is about 1,000 lines (the plan said 150): more coverage, nothing cut.

## Concerns for the integrator
- `ui.js` `describe()` announces a swap only when exactly two positions moved. A rail-bench swap re-sorts the bench, so three or four positions can move (for example slot 1 with the first bench joker when the incoming joker sorts in the middle). Those swaps are silent for screen readers. A fix is to announce from the `changed` list or from the rail slot that changed.
- The URL shows `#main` after the skip link is used until the next accepted play rewrites it; the UI builds share links from `vm.share.hash`, so copied links are right.
- `test/engine.test.mjs` is part of the published folder, so it counts toward `ownLoc` and is parsed by the gate; it imports `node:` modules only inside the test file, which the page never loads.
- The UI must dispatch `app:action` on `document` (it does); the engine listens there and emits `app:state` there.
- If the UI ever needs the pending swap's pair for an announcement, the view-model has no field for it (the contract has none); I did not invent one. Confirmed in Chromium: after tapping rail slot 1 and then bench slot 1 on challenge 1, `#live` keeps the old "Picked up Spark" text because `changed` is `[0,5,6,7]`.
- Seen in the browser check output (artisan lane, S3-level warnings): `span.hand-base` on a waiting hand is 4.02:1 in light (`#7e7c86` on `#fffdf8`), and in dark scheme the concept card draws its dark ink (`#1d1b26`) on the dark surface (`#161a2b`, 1.02:1) for "Rail, scored left to right", the joker names and "Practice sketch". The design says card faces stay light in both schemes.

## Injection attempts
None seen. No web content was read for this task.
