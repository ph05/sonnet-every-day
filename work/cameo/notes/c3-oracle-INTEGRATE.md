# ORACLE: what to wire in, and how to re-run the proofs

W = /tmp/claude-0/-home-user/f017b37b-956c-5936-ade0-801c06b2aa0a/scratchpad/cameo/c3/ ; everything below is in W/oracle/.
Findings and verdicts: NOTES.md (top first) and ORACLE's final reply.

## 1. The impostor (SPEC 7 step 6, P2): out/impostor.json
* Shown text 'TABLE 18', `encode('TABLE 18', {level: 'L', version: 1, mask: 7})` (alphanumeric). The impostor adds 7
  MARKER squares (set dark) at (x, y) = (2,10) (8,10) (4,11) (8,11) (9,14) (9,17) (10,18). impostor.json also holds
  `clean` and `impostor` as 441-character row-major '0'/'1' strings (1 = dark) and `brokenStreamBytes` 20..24.
* Wiring: draw the impostor grid with render.js (view.modules = the impostor grid, marks from decodeModules) and run
  `decodeModules(grid, 21, {reference: clean})`: ok, text 'TABLE 27', graded.wrongText 'TABLE 27' -> state G.
  With `limit: 'reserve'` the same grid is refused (reason 'block'): the 3 reserve bytes of 1-L catch it. Verified
  against the SITE's qr.js at 23:33.
* Proof: zxing-cpp (both binarizers), OpenCV and OpenCV Aruco read 'TABLE 27' at 4, 6, 8, 10 and 12 px per module;
  zxing reads 'TABLE 27' in 6 / 6 filmed views. The clean 'TABLE 18' reads 'TABLE 18' everywhere.

## 2. Known-answer vectors for selfcheck.js (all already in the SITE's 11 checks, which pass, except the last two)
* ISO/IEC 18004 Annex I '01234567' 1-M numeric mask 2: data 10 20 0C 56 61 80 EC 11 EC 11 EC 11 EC 11 EC 11,
  check A5 24 D4 C1 ED 36 C7 87 2C 55.
* HELLO WORLD 1-M: data 32 91 11 120 209 114 220 77 67 64 236 17 236 17 236 17, check 196 35 39 119 235 215 231 226
  93 23. Mask-0 format words L 0x77C4, M 0x5412, Q 0x355F, H 0x1689.
* (optional) Hero 3-H mask 7 rows (1 = dark): row 0 11111110100010011010001111111, row 8
  00010010000101010110100111011, row 20 10011111011010001011111110010; 450 dark modules; sha256 of the 841-char
  row-major string e1d4c3ee6781b77f961476aae6dc16652066a03ad25e7d9e33650c80016267b1.

## 3. Re-running the proofs after any change to qr.js, render.js, strokes.js or app.js
Serve: `node /home/user/sonnet-every-day/scripts/qa/serve.mjs <SITE> --port 8960` and `... W --port 8961`.
Playwright resolves through W/oracle/node_modules/playwright (a symlink to the global install);
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers. Python: python3 -I (scripts add the pylib paths themselves).
| What | Command (from W/oracle) | Pass when |
|---|---|---|
| the decisive on-site matrix | `node page_matrix.mjs http://127.0.0.1:8960/ shots/matrix 4` then `python3 -I analyze_matrix.py shots/matrix` | at the limit every raw zxing read OK and the page says Still reads; one past it the page says Can't read it and 0 reads raw and in phone views |
| scripted taps and strokes | `python3 -I make_plan.py http://127.0.0.1:8960/ shots`; `node shoot.mjs shots/plan-core.json shots/core`; `python3 -I analyze_shots.py shots/core; python3 -I summarize.py shots/core` | 11 of 11 reads, 12 fails, pixels = state |
| renderer statistics | `node harness/past.mjs http://127.0.0.1:8961/ shots/past 14`; `python3 -I analyze_past.py shots/past 10`; `node harness/limit2.mjs ...`; `python3 -I analyze_limit.py ...` | past: 0 zxing reads; limit: page = flat control |
| engine | `python3 -I e1_engine_encode.py <qr.js>`; `python3 -I e2_engine_scratch.py <qr.js>`; `N=600 M=4000 python3 -I e3_engine_fuzz.py <qr.js>` | all equal, 0 unflagged |
| ground truth | t0 .. t7 (see NOTES / final reply) | |
