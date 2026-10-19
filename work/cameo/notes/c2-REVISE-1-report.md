# Revise round 1 report: Colors That Stop Matching (cameo 2)

All five MUST items and all seven SHOULD items are done, and most of the POLISH is done too. The final files are in
`.../cameo/c2/2026-10-19-colors-that-stop-matching/`, last changed at 23:03:29Z.

**Evidence.** The regression runner's scoreboard is
`/tmp/claude-0/-home-user/f017b37b-956c-5936-ade0-801c06b2aa0a/scratchpad/cameo/c2/fanout/regress/STATUS.md`. Its final
pass, run 2026-10-18T23-12-35-850-live on the live SITE (unchanged since 23:03:29Z), reports:
* 17 of 17 required checks pass and 16 of 16 additional checks pass.
* Nothing regressed.
* The 9 checks that failed on the 22:53 snapshot pass since the 23:04 run. They failed only because the copy deck and the contrast fix had not yet landed.

## Final checks (on the live SITE)

| Check | Result |
|---|---|
| `validate.mjs project <SITE> --contract` | ok, 0 errors, 0 warnings. The CVRL http warning is gone. |
| `browser-check.mjs <SITE> --contract --thumb --seconds 10` | ok, 0 errors, 0 warnings, 0 console or page errors.<br>Self-test 21 of 21. 7 first-screen controls.<br>Result top: 213 px on desktop, 508 px on a phone.<br>Thumbnail: 253 KB raw, no palette reduction. I looked at it: the warm-bulb split of the new pair. |
| `window.__sedSelfTest` | 21 of 21 in Chromium and in node. Round 1 had 16 cases. New cases: the 1964 observer match (with the first design failing it at 10.7), the LED-B2 white point, FL11 against a 3999 K glow, and exercises 4 and 5. |
| Exercises helper's verifier `engine_exercises.mjs` | 40 of 40 numbers agree with the independent colour-science script; 21 of 21 self-tests. |
| Pair helper's oracle (`fanout/pairverify/deliver/NUMBERS.md`) | Every pair number reproduces. I took its three corrections: four-lock maximum 3.38, deutan daylight 13.2, exact crossing points. |
| Reviewers' failing scripts, re-run on port 42110 (`proto/qa-regress/run-all.sh`) | **touchscroll:** the cycle survives a flick; the lamp reaches D65 within 8 s.<br>**wigglecls** (desktop and phone) and **shift** (1280, 1366, 390 and 320 px): no layout shift.<br>**Mid-fade switch:** no snap back; 0 verdict/number mismatches.<br>**touch_fig2:** a vertical drag edits the curve and the page does not scroll.<br>**Share links:** the shop lock is on by default.<br>**reduced:** "Show another shape", no slideshow.<br>**Hand drag:** the color holds.<br>**Wiggle presses:** every press moves the curve at least 0.32.<br>**Editor walks** (desktop, phone and the content reviewer's): the success text is live and true; the inset proves the held match. |

## The REVISE-1 items

| Item | Status | What and why |
|---|---|---|
| MUST 1 (correctness C1) | **done** | **New pair.** It matches exactly under FL11 for the CIE 1931 2-degree, 1964 10-degree and 2015 2-degree observers, by 9 equality constraints in `proto/design_robust.py`. The 2015 10-degree observer gives 0.11.<br>**Kept constraints:** lightness change (Pebble 5.0 L* lighter under A); color-blind splits of 7.0 deutan (A) and 13.2 deutan (D65); sRGB under all six lamps; smooth handles.<br>**New splits:** A 19.4, D65 30.0, LED-B2 18.8, glow 24.6, sodium 3.5.<br>**Cost:** rougher curves with 7 crossings instead of 3.<br>**Data:** data.js embeds the 1964 table (`cmf10`) and the old pair (`draft`). engine.js has `diff10()`, and a self-test checks both.<br>**Copy:** the honest observer-metamerism lines are in step 3 (deck H15) and in "What this page simplifies" (N17/H47). They name the 1931 and 1964 standard observers and the 2015 cone-based observer. They also say the wiggle holds only for the 1931 observer. The CIE 1964 and CIE 170-2 data tables are now sources.<br>**Checks:** confirmed independently by the pair helper's oracle and by STATUS C1. |
| MUST 2 (correctness C2) | **done** | Exercise 3 is now a smooth 25-point bump on the 81-sample grid (sigma 8 nm). Results: shop 0.9, daylight 3.1, warm bulb 5.7, glow 4.5. The answer and feedback were reworded. The self-test checks the oracle values (exercises helper; STATUS C2). |
| MUST 3 (correctness C3) | **done** | Exercise 2 asks for an exact match, "the same three numbers". It answers "Right: none can." The numbers are 4.0 to 4.7, and at least 3.2 over 2,000 random lamps. It adds the nuance that half a point above, R looks identical but never matches exactly (exercises helper; STATUS C3). |
| MUST 4 (content C1, correctness C4) | **done** | **Screens bullet:** "when a photo looks right ... colors more vivid than the screen's three lights cannot be matched" (H46).<br>**Swatch paragraph:** "a well-set-up screen ... not a copy of its light; this page tints on purpose" (H27).<br>**Four locks:** "only one direction is left ... the sodium street lamp, by at most about 3.4" (H19). Wavelength is no longer called hue (H13). "Almost every eye" (N18). STATUS C1/C4 checks pass. |
| MUST 5 (content C2) | **done** | **Removed:** X-Rite, Konica Minolta, HunterLab, MetricGate, testextextile.com, RP Photonics, the unverifiable PMC entry, the Stanford page and the http CVRL link (copy deck H55).<br>**Computed on the page instead:** the FL11 lines and its 4000 K color. The About says so (H53), and self-tests check FL11 against a 3999 K glow and the LED-B2 white point.<br>**Cleanup:** no "seen in search results" note is left in front of readers; it is recorded below. STATUS C2 passes. |
| SHOULD 6 (FI-02, content C9, correctness C17a) | **done** | **During the wiggle:** Fog's curve thrashes large over its still block (bright line, soft shadow, dashed ghost of the original), under a "Color unchanged" badge. Fog's paper strip shows "was / now" swatches under the other lamp, which flicker apart.<br>**Readout:** two one-line labels, e.g. "Fog under the shop light: unchanged (0.0)" and "Under the warm bulb: 28.8 from the original".<br>**Block color:** `--chip-b` is recomputed from the moving curve on every frame.<br>**Phones:** the live line, Fog's block and the Wiggle button are kept on screen together.<br>**Also:** a drag across Fog's block reshapes the curve by hand (see FI-17). |
| SHOULD 7 (FI-01, correctness C5) | **done** | **Stops the cycle:** only a click, change or keyboard focus on a hero control. The pause button only pauses. Scroll, wheel, text selection and a vertical swipe on the chips never stop it.<br>**Off screen:** the IntersectionObserver sleeps the cycle below 40% visibility and resumes it after.<br>**Check:** touchscroll passes. |
| SHOULD 8 (FI-03) | **done** | **Lamp lines:** spectra on light paper (hero, editor, figures in light mode) are drawn in a darker, saturated hue of the lamp (`views.lampInk`); dark mode keeps the pale glow. STATUS measures 2.6:1 for the 546 nm line against the paper.<br>**Crossing marks:** while a pair matches, small rings mark where the curves cross within 8 nm of the lamp's lines (543 and 603 nm under the shop light). |
| SHOULD 9 (FI-06) | **done** | The first lamp a visitor picks that gives the pair away gets "Found it: under the warm bulb they are 19.4 apart. Now press Wiggle, or make your own pair." A second lamp gets "Daylight gives them away too: 30.0 apart". The verdict pulses once, with no pulse under reduced motion. The threshold is 2 (deck K01), so the 3.5 sodium split counts too. |
| SHOULD 10 (FI-04, FI-11, content C6, correctness C11) | **done** | **Scene and inset:** Make my own pair switches the scene to the warm bulb. An inset, "Under the shop light (held)", shows two squares and the live number under the held lamp.<br>**Phones and desktop:** the page scrolls so the chips, inset, editor and status share one screen. The inset and the split pulse once on success.<br>**Goal text:** it has no frozen number and is always true for the paint on screen. It reverts when the split is lost and changes when the warm bulb is held. It defines "metamer" (K05). |
| SHOULD 11 (FI-05, correctness C6) | **done** | Every readout line is a reserved one-liner (nowrap). The hint reserves two lines. The end-of-wiggle message fits the same lines. At 360 px and below, the tail of the difference line is dropped. shift.mjs and wigglecls.mjs show 0 px movement at every size. |
| SHOULD 12 | **done** | **FI-07:** solid ink; the cone letters are ink with colored underlines. Lowest contrast under any lamp is 6.0:1 (STATUS).<br>**FI-09:** the whole split block fits on a 390x844 screen (blocks 639 to 783 px).<br>**FI-10:** each paper strip carries a "light it sends back / your eye" legend; L/M/S letters are 0.72rem ink; shorter caption.<br>**Content C3, C4** (H19, H18); **C5 and correctness C7:** light-power shares in exercise 5 and figure 6.<br>**C7:** definitions of nm, illuminant, kelvin, Planck's law, phosphor, chromaticity and metamer (H13, H20, H26, F05, K05).<br>**C8:** new step-4 transfer (the two-line lamp, exercise 4) and new exercise 5. |
| POLISH | **mostly done** | See the tables below. Not done: the CIE licence line (C12.7), the "no longer made" sodium note, settling the cycle after two loops (FI-17), and compositor-only crossfade layers (C10). |

## Every finding id

### First impression (qa1-first-impression.json)

| Id | Status | Note |
|---|---|---|
| FI-01 | done | SHOULD 7. |
| FI-02 | done | SHOULD 6. The chip block's aspect is 1/0.8 on desktop, so the curves sit inside a 650 px window. |
| FI-03 | done | SHOULD 8. |
| FI-04 | done | SHOULD 10. |
| FI-05 | done | SHOULD 11. |
| FI-06 | done | SHOULD 9. |
| FI-07 | done | SHOULD 12; it also needed the cone-letter fix that the runner flagged. |
| FI-08 | done | The SVG noise is gone. The thumbnail is 253 KB raw, under 300 KB, with no palette reduction. The hero grid is minmax(18rem, 27rem) 1fr and the scene max-width is 48rem. The chips are 520 px wide. |
| FI-09 | done | **Phones:** the jump link is hidden, the margins are tighter, the lamp is smaller and the intro is 51 words (deck H03).<br>**Measured:** result top 508 px, blocks end at 783 px of 844. |
| FI-10 | done | SHOULD 12. |
| FI-11 | done | SHOULD 10. |
| FI-12 | done | The verdict word follows the number shown on every frame; engine `verdict()` judges the one-decimal number that is printed. The hex line is set when the fade ends. The bulb's CSS transition is gone. |
| FI-13 | done | **Narrow scenes:** a container query shows the short caption at 560 px and below.<br>**Wide screens:** header, main and footer are centered at max 1360 px.<br>**Jump link:** on desktop it lines up with the picture's left edge. |
| FI-14 | done | Quiet buttons have a hover state. "Numbers" and every "Show the answer" have chevrons. Figure chips, checkboxes and summaries are 44 px. |
| FI-15 | done | "Identical to the eye" (deck J02). Exercise 1 says "the same shade of orange". Figure 6 says "First panel / Second panel". Figure 3's label is shorter on phones. The hint uses text-wrap: balance. |
| FI-16 | done | **Reduced motion:** one new shape per press ("Show another shape") and a "Back to Fog" button.<br>**Keyboard:** focus on a hero control stops the cycle. |
| FI-17 | changed | **Done:**<br>- Clicking the lamp changes the lamp. It is a pointer shortcut, kept out of the first-screen control count; the lamp switch is the keyboard way.<br>- A drag across Fog's block runs a locked brush in place, and the curve glides back on release. After a first wiggle the page says "Now drag across Fog to try it by hand."<br>- More has a dimmer from the shop light to the warm bulb, at equal brightness. The block tears in two near 6% warm bulb (1.1).<br>**Not done:** settling the cycle after two loops, because the cycle already sleeps off screen and has a pause button. |

### Correctness (qa1-correctness.json)

| Id | Status | Note |
|---|---|---|
| C1 | done | MUST 1. |
| C2 | done | MUST 2. |
| C3 | done | MUST 3. |
| C4 | done | MUST 4. |
| C5 | done | SHOULD 7. |
| C6 | done | SHOULD 11. |
| C7 | done | `bandWeights().power`: each band's strength times its area. Figure 6's label and exercise 5 print power shares: daylight 33/40/27, shop light 46/35/19. |
| C8 | done | A new fade starts from the colors last painted (`mixFrames`), and the word follows the number. My midfade test: largest frame-to-frame jump 2/255, 0 mismatches. |
| C9 | done | `E.wiggleBumps()` redraws a seed that would move the curve less than 0.28, up to 12 draws. The hero and figure 4 both use it. Smallest press over 8 presses x 6 lamps: 0.32. |
| C10 | changed | **Done:** the blur filter on the light cone and the drop-shadow filter on the chips are gone (a box-shadow instead). Editor drags redraw at most once per frame.<br>**Not done:** compositor-only crossfade layers.<br>**Measured (shared machine, noisy):** crossfade p95 33 to 50 ms at 6x throttle; round 1 was 50 ms. |
| C11 | done | SHOULD 10. |
| C12 | done | Step 3 numbers rewritten for the new pair (N08/N09, deck H16): 700 nm 62% and 11%; the lines at most 6 points apart; seven crossings, one at 543 nm. |
| C13 | done | Under the sodium line the hero names colors by lightness only: "orange", "lighter orange", "darker orange". |
| C14 | done | A share link with a missing or invalid lock opens with the shop lock on. |
| C15 | done | "Your screen cannot show this color fully; it is shown less vivid or less bright." |
| C16 | done | Figure 2's drag takes touch only over the middle row (a touch-action:none overlay). Elsewhere a swipe scrolls the page. |
| C17 | done | **(a)** the block is recomputed every frame. **(b)** the editor status is no longer a live region; a summary goes to the scene's status on pointerup and keyup. **(c)** "Tip: press W to wiggle Fog." in More. **(d)** "Sodium lamp (modeled)". **(e)** no http sources. |

### Content (qa1-content.json)

| Id | Status | Note |
|---|---|---|
| C1 | done | MUST 4 (H27, H46). |
| C2 | done | MUST 5. |
| C3 | done | Four-lock claim (H19, "by at most about 3.4"; NUMBERS gives 3.38, or 3.45 with the brush). |
| C4 | done | "Directions the handles move in together" (H18, plus the More lock note). Figure 4 pins and labels the 589 nm point under the sodium lamp. |
| C5 | done | Power shares, as correctness C7. |
| C6 | done | SHOULD 10. |
| C7 | done | Definitions (H13 nm and wavelength, H20 illuminant, kelvin and Planck's law, H26 phosphor, F05/H22b chromaticity, K05 metamer). Kelvin is gone from the hero captions (H04/J01). |
| C8 | done | Exercise 4 is a step-4 transfer: a lamp with lines at 450 and 600 nm pins exactly those heights, while four lines let them trade. Exercise 5 is a new case: under the shop light the screen makes both halves from the same three bands. The old judge question is dropped; figure 5 still runs that test. |
| C9 | done | SHOULD 6. |
| C10 | done | (a) through (j) via the deck. In (b) the crossings are new. (j) The self-check line says "white points of its four CIE lamps", and LED-B2 has a self-test. |
| C11 | changed | **Done:** sodium wording is model versus real lamp ("very hard to tell apart"), and high-pressure lamps "leave some color".<br>**Not done:** "no longer made", because no non-commercial source was found. |
| C12 | changed | **Done:** single author; PMC entry dropped; the e-ILV label and term 17-23-008; real titles in project.json; CVRL http dropped.<br>**Not done:** quoting the CIE licence line (item 7). The dataset metadata cannot be opened from this machine (proxy 403) and the search budget is spent. |
| C13 | done | (a) to (h): "modeled"; one name per lamp; "Identical to the eye"; "split"; editor status names; one decimal; plain self-check labels; description. |
| C14 | done | The step 3 slivers sentence (H16), the step 2 example (H14), and "Because every lamp judges differently ..." (H26). |

## Notes for round 2

* **Four-lock bound.** With four lamps held, the sodium split reaches 3.38 inside the handle box, and 3.45 with the brush. The text says "at most about 3.4".
* **Wiggle and other observers.** The wiggle holds only for the 1931 observer, and the page now says so.
* **The pair's look.** Pebble and Fog swapped roles: Pebble is tan, then sage; Fog is dusty rose, then mauve.
* **Source provenance, for the records only (not shown on the page):**
  * The CIE pages, the authors' page, the journal's page and the ASTM page are each the primary source's own page.
  * Seen in search results with agreeing results: the strollswithmydog rule of thumb, the Wikipedia pages paired with HyperPhysics, the Nagoya museum, the ICC registry and russellcottrell.
  * Seen in search results: the CIE x046 paper (on the CIE's own site), the U.S. Department of Energy LED pages, the IOP article page, and the Berkeley lecture with the flowvis gallery.
  * The 1964 and 2015 observer tables are the CIE's data pages; the lead located them by web search. I could not open any URL from here (the proxy returns 403), and I had no searches left.
* **The pair's own source.** The pair is in `proto/pair_default.json` (= `pair_rob6.json`); `pair_v1_1931.json` is the first design. Designer: `proto/design_robust.py`. Every number the page states: `proto/page_numbers.mjs` and `fanout/pairverify/deliver/NUMBERS.md`.
