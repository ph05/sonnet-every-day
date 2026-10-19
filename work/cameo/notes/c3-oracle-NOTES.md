# ORACLE notes for the LEAD, ENGINE and VISUAL (verdict first; updated 2026-10-18 23:45 UTC)

The harness blocks subagents from writing REPORT.md, so the full report is ORACLE's final reply; this file is the
verdict and everything the team must act on. Scripts, outputs and screenshots: W/oracle/ (lab.py, t*.py, e*.py,
page_*.mjs, shoot.mjs, harness/, analyze_*.py, shots/, out/). How to re-run: INTEGRATE.md.
Real decoders: zxing-cpp 3.1.1 (`zx`, plus its GlobalHistogram binarizer `zx_gh`), OpenCV 5.0 `QRCodeDetector`
(`cv`) and `QRCodeDetectorAruco` (`cva`). "Phone views": the screenshot downscaled to 3 to 5 camera px per module,
blurred, tilted, rotated, noisy, lower contrast, one with glare.

## VERDICT (SITE with render.js sha256 00a5e22b..., qr.js 23:02, app.js 23:32)
THE PROMISE HOLDS: on the page itself, a real decoder reads the code exactly while the page says it still reads, and
gives up exactly when the page says it can't, for byte damage, at every level and versions 1 to 6.
* Decisive matrix (page_matrix.mjs, out/matrix_analysis.txt): 128 states made inside the real page (light and dark,
  DPR 1 and 2, 1280x800 and 390x844, Show bytes off and on; random Scratch and Marker strokes, no corner square,
  format or timing module touched):
  - AT the limit (a block at exactly 11 of 11; 64 states): the page said "Still reads" 64 / 64; raw screenshots read
    by zxing 63, zxing-GH 64, OpenCV 62, Aruco 62; phone views zxing 312 / 320 (flat control 320 / 320): 160 / 160
    without Show bytes, 152 / 160 with it. The one raw zxing miss reads in 5 / 5 phone views (open item 3).
  - ONE PAST the limit (a block at 12 of 11; 64 states): the page said "Can't read it" 64 / 64; raw reads 0 / 64 for
    all four decoders; phone views 0 / 320 (zxing) and 0 / 320 (Aruco). No wrong message anywhere.
  - Camera rule (SPEC 5.4) per pixel in all 128 shots: 0 violations; sampled module centres = page state: 0 mismatches.
* Scripted taps (Fine brush, one byte per tap, shots/core2): 11 of 11 reads (zxing corrected exactly 11), the 12th
  fails, Undo restores, 11 + 11 = 22 of 70 bytes reads, Marker 11 reads / 12 fails.
* Reserve region (page_reserve.mjs): 1-M 4 reads, 5 reads with "Past the promise ... the standard only promises 4"
  (all four decoders read), 6 "Can't read it" (all fail); 1-L 2 / 3 / 4 the same. Exactly right.
* Every clean code the page makes (v1-H to v5-H, v6-Q, v2-L/M/Q, byte and alphanumeric) reads in all four decoders;
  first frame (ghost, 4 + 5) reads everywhere, zxing corrects exactly 5 in the worst block; thumb.png reads too.
* Engine: exact (6,344 symbols = an independent encoder; Reed-Solomon = an independent decoder on 15,600 cases;
  grading flags every wrong result); self-checks pass and their expected values equal my independent numbers.

## OPEN (owner, severity)
1. LEAD, blocker for honesty: ERASURE MODE invites a scan that cannot work. With "Tell the decoder where the
   scratches are" on, the readout says "STILL READS / 35 known gaps filled ... / Scratch it. Then scan it with your
   phone." while graded.trueBroken is [15, 17] (a phone stops at 11): zxing, OpenCV and Aruco all fail (shots/
   erasure2, 23:33). Fix: in erasure mode, once any block's trueBroken > maxTry, replace the instruction with e.g.
   "Only this page can read it now: a phone is not told where you scratched, and block 2 has 13 broken bytes, 2 more
   than a phone can fix on its own."
2. LEAD, copy: Show bytes costs 5% of phone views exactly at the limit on the SITE (152 vs 160; 10% in the harness).
   SPEC 4.4: not proved -> keep/print "Turn Show bytes off before scanning" (or switch it off while at the edge).
3. Residual, no fix needed (state E copy says "should"): at full close-up resolution (24-27 px per module) local
   binarizers (zxing's and OpenCV's) sometimes misjudge the inside of LARGE dark areas made by Marker ink plus print
   (39- and 128-module dark regions): 1 of 64 at-limit raw shots failed zxing by one byte (reads in 5 / 5 phone
   views), and in the harness OpenCV read 2 of 42 past-limit states from flat 27 px renders. Phone-distance views
   never showed it.
4. LEAD, copy: state F "A phone should give up here too" (both format copies lost) is not guaranteed: zxing-cpp
   falls back to an UNMASKED format read; wiping both copies light on a mask-0 code reads level M mask 0, and zxing
   then reads the RIGHT text at M (all versions), 1-Q, 1-H, 2-Q, 2-H, 4-Q and a WRONG text at 6-H
   ('SCRATCHED BUT STILL%R3WF2C0Y'). Suggest "Most scanners give up here; a few guess and may read it, or read
   nonsense." The explainer's "if both copies are badly damaged a scanner cannot tell" -> "usually cannot".
5. LEAD, copy: note 2.4 #5 "scanners can still use the spare copy": OpenCV reads only 23-73% once one copy has 4+
   wrong bits (zxing 100%) -> "most scanners can still use the spare copy".
6. LEAD: state G must handle an EMPTY wrong message: in 6 of 37 wrong reads (fuzz) the miscorrected data parses to
   '' (graded.wrongText === ''); test `wrongText !== null`, show "an empty message".
7. LEAD/FACTS, flag only: the sources list cites ZXing's Reed-Solomon decoder and ZBar's qrdec.c; DIRECTION says
   the real decoders are never cited as sources (zxing-cpp is ZXing's C++ port). Your call.
8. Residual: zxing-cpp's QRCode format includes Micro QR; past the limit it found an 11 x 11 "Micro QR" beside a
   corner square and returned its digits in 11 of 40,000 heavily damaged v4-v6 codes. No copy change proposed.

## Ground truth (what scanners do), short
* Limit per block = floor(check bytes / 2) for all four decoders at every version 1-6 and level, INCLUDING 1-L (3,
  standard promises 2), 1-M (5 vs 4), 2-L (5 vs 4): the reserve is not honoured. Spread across blocks: every block
  at its limit reads (6-H: 56 of 172 bytes), one block +1 fails. 43,008 random decodes, 0 wrong.
* A wrong message needs constructed damage: patterns of floor(ec/2)+1 bytes that land within reach of another
  codeword make all four decoders read a different message at every version/level (t4). Random damage: at most
  6e-10 per beyond-limit read (1-L), 4e-28 for a 3-H block.
* Corner squares: one changed module (1 dark module scratched: zxing 62-87%; 1 light module inked: zxing 0%); a
  whole square, its centre or one row: 0% for all. Separator inked: Aruco 2 / 16 with one module.
* Format: one copy intact + the other 0-3 wrong bits: 100%; both damaged: 2+2 zxing 90%, 3+3 36%, 4+4 6%; one copy
  4+ wrong bits: OpenCV 23-73%. Timing row: one module stops OpenCV, never zxing. Alignment: harmless on clean renders.

## Impostor ready (SPEC 7 step 6, P2): out/impostor.json (details in INTEGRATE.md)
'TABLE 18' at 1-L mask 7 + 7 MARKER squares (2,10) (8,10) (4,11) (8,11) (9,14) (9,17) (10,18): all four decoders read
'TABLE 27' (4-12 px per module; zxing 6 / 6 filmed); qr.js reads 'TABLE 27' with wrongText; limit 'reserve' refuses.

## History (fixed): the scratch texture made dead codes scan (23:15) -> fixed by VISUAL's render.js (23:24)
Before: one past the limit, zxing read 14 / 42 raw render.js states and 34 / 420 phone views (scratched modules drawn
grey, median module luma 192: a local binarizer took them for ink); at the limit Show bytes lost 21% of views. After:
0 / 42 and 0 / 420 in the harness, 0 / 64 and 0 / 320 on the SITE (above).
