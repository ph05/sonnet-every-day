# SPEC: Scratch a QR Code (cameo 3, LESSON, Day 11, 2026-10-20)

Owner of this file: LEAD. It outranks DIRECTION.md. Helpers: read "Interface changes" first, every time you check in.
Workspace W = /tmp/claude-0/-home-user/f017b37b-956c-5936-ade0-801c06b2aa0a/scratchpad/cameo/c3/
SITE = W/2026-10-20-scratch-a-qr-code/ (published as is; LEAD only). LEAD's scripts and outputs: W/proto/.
Status: SPEC APPROVED by the main session at 22:49 UTC; PHASE 2 (the build) has started. First complete build
target: about 02:00 UTC, 2026-10-19.

## Main session decisions (22:49, binding)
1. window.__sedSelfTest ships (10 cases) with a visible "Check the decoder" control in More.
2. The About clause about "two independent open-source QR decoders" stays, decoders unnamed.
3. The impostor is built LAST, only when every acceptance line is green, with an innocuous text pair (no URLs) and
   only what ORACLE proves with both decoder families. First cut if time is tight.
4. E3 uses 15 message and 28 check bytes (a real 6-H block). Agreed.
5. No phone on the team: ORACLE's camera-like proofs (screenshots plus downscale, blur, perspective, glare) are the
   publish gate. The copy keeps its hedges ("a phone may give up a little before this page does").
6. Title, tagline and instruction signed off. Intro change: "who has met a scuffed code" becomes "who has scanned a
   scuffed code" (still 59 words; project.json intro is exactly the text in 2.1).
7. Meters follow what scanners fix (half the check bytes); the standard's lower promise is the dotted tick.
8. E6 and the corner-square note must not claim more than we measured: some phone scanners may locate a code from
   two corner squares. E6's answer reads "Probably not: every scanner we tested gave up ..."; camera notes keep "may".
   FACTS confirms the wording.

---------------------------------------------------------------------------------------------------------------------

## Interface changes (read first; newest at the bottom; each one is binding from the moment it appears here)

IC-1 (ENGINE) Mask choice, penalty rule 3. Count each occurrence of the core 1011101 (dark-light-dark-dark-dark-
light-dark) in every row and every column that has 4 light modules immediately before it OR immediately after it,
where modules OUTSIDE the symbol count as light (clamp to the edge); 40 points per core occurrence, counted once
even when both sides qualify. Rules 1, 2 and 4 as the standard: runs of 5 or more score 3 + (run - 5); every 2x2
same-colour square scores 3 (overlaps count); rule 4 scores 10 x floor(|dark% - 50| / 5). Penalties are scored on
the full symbol with the format bits for that mask in place. Lowest total wins; ties go to the lower mask number.
Why: with exactly this rule my independent reference encoder picks the SAME mask as zxingcpp's encoder in 260 of 260
symbols (65 texts x 4 levels, versions 1 to 6), and the modules are identical in 260 of 260 (W/proto/xcheck_zxing.py).
The "strict" variant (outside does not count as light) agrees in only 108 of 260. Consequence the page relies on:
the default message at 3-H picks mask 7 (total 1301; mask 3 is a close 1304). ENGINE's encode must reproduce
the per-mask totals [1493, 1350, 1448, 1304, 1340, 1386, 1407, 1301] for it (section 6.2).

IC-2 (ENGINE) Sym.blocks[i] also carries `budget` = floor((ecCount - reserve) / 2) (what the standard guarantees),
`maxTry` = floor(ecCount / 2) (what scanners actually try; see 6.3) and `erasureBudget` = ecCount - reserve.
blockLayout(version, level) returns the same three numbers per group.

IC-3 (ENGINE) decodeModules(modules, size, opts) options:
  erasedModules: Uint8Array | null   (a codeword is an erasure when ANY of its modules is 1 here)
  reference:     Sym | null          (grading only: it never influences the decode)
  limit:         'half' (default) | 'reserve'   'half' accepts any 2e + s <= ecCount (as zxingcpp and OpenCV do);
                                                'reserve' accepts only 2e + s <= ecCount - reserve.
  fallbackFormat: {level, mask} | null  used ONLY when neither format copy is within 3 bits of a valid code; the
                                       Read then has ok:false, reason:'format', and dataOk tells whether the bytes
                                       alone would still decode (the page says so honestly; 2.5 state F).
Read gains: `dataOk` (bytes and parse fine under the format used), `format.used` ('A' | 'B' | 'fallback' | null),
`format.copies[i] = {distance, level, mask}` (nearest valid code per copy), and per block: `errors` (count found),
`erasures` (count), `cost` = 2 x errors + erasures, `safe` = (cost <= ecCount - reserve), `ok`.
Status codes per stream codeword stay: 0 ok, 1 found and fixed, 2 beyond repair, 3 erased and filled.

IC-4 (ENGINE) Read.graded (only when reference is given) also carries:
  trueBroken: [per block: number of codewords whose value differs from the clean code]
  structure:  {finder: [topLeft, topRight, bottomLeft], formatA, formatB, timing, alignment, dark}
              = number of CHANGED modules (vs the reference) inside each structure; finder counts the 8x8
              finder-plus-separator area of each corner (role 1).
  formatWrong: true when the format the decoder used differs from the reference's.
  miscorrected: true when any block decoded "ok" to a codeword that differs from the clean one.
  wrongText: the text a scanner would read when miscorrected, else null.

IC-5 (LEAD, VISUAL) The stroke model (section 4.5) lives in SITE/strokes.js, written by LEAD. Strokes are stored in
NORMALIZED symbol coordinates (0..1 across the symbol's module area, quiet zone excluded), radius in the same unit.
render.js never decides module state: it is given the current modules and the brush footprint.

IC-6 (VISUAL) render.js signature (section 5.6): draw(canvas, sym, view, opts). The camera rule of section 5.4 is
binding and is what ORACLE tests.

IC-7 (WIDGETS) Ladder defaults and decoder rules are fixed in section 7 (line message 2, 5; parabola message
1, 4, 6; clock message 3, 7 on 13 hours). Exercises are fixed in section 8 (six of them; E3 and E4 differ from
the dossier's wording).

IC-8 (LEAD, ENGINE, VISUAL; from ORACLE's NOTES section 1, which agrees with W/proto/damage.out) The meters count
against maxTry = floor(ecCount / 2), what every tested scanner really fixes, and "one more breaks it" fires when a
block's errors equal maxTry (erasure mode: when its cost equals ecCount). Where the standard's guaranteed budget is
lower (1-L 2 of 3, 1-M 4 of 5, 2-L 4 of 5), the cells above the budget are drawn dotted with a tick labelled
"promised: 4", and state D explains it. At the hero 3-H both numbers are 11.

IC-9 (LEAD, ENGINE; from ORACLE's NOTES sections 2b and 4) The format-strip notes use changed-module counts per copy
(graded.structure.formatA / formatB) and each copy's nearest valid code (Read.format.copies): see 2.4 items 2 and 5.
ENGINE: copies[i] must report {distance, level, mask} of the nearest of the 32 valid codes even when distance > 3.

IC-11 (LEAD, build, 23:10) render.js's own stroke model is adopted: render.js applyStrokes() is the single
definition of module state (module units, later strokes win). The page keeps strokes NORMALIZED in strokes.js and
converts them for the current symbol before every applyStrokes/draw (IC-5 amended). WIDGETS' widget defaults are
adopted instead of 7's: line message 3, 5 (sends 3, 5, 7, 9), curve 1, 5, 8 (sends 1, 5, 8, 10, 11, 11, 10; on
ordinary numbers y = -x^2/2 + 11x/2 - 4), clock 5, 8 on 13 hours (y = 3x + 2, sends 5, 8, 11, 1). Exercises: WIDGETS'
E1 to E6 (= section 8) plus extras X1 (fooled line), X2 (which clocks divide), X3 (XOR). ENGINE final: G only when
graded.wrongText !== null; failed blocks use graded.trueBroken; "one more breaks it" = room < 2 (errors) / < 1.
FACTS (23:00) copy changes folded in: format strip has its own error correction (S-17), byte shapes (S-13), "spot
two" (S-14), "many scanners (a few stop at the promise)" (S-5), Annex I self-check + HELLO WORLD as a tutorial
example (S-2), "nearly a third" (S-12), "58 bytes of other text" (S-9), history and patent wording (S-23), the
curve picture with the division sentence (D3), levels "roughly ... rounded" (C1/C3), erasures "a camera usually
can't tell" (F1), Voyager and RAID 6 (G3, G5), FACTS' sources list (no thonky.com).

IC-12 (LEAD, 23:25) render.js moved to the SPEC 5.6 API (VISUAL 23:15+): draw(canvas, sym, view, opts) with
view.modules from strokes.js applyStrokes() (normalized strokes; the module truth now lives in strokes.js, not
render.js), geometry()/clientToNorm(), MARK.broken/fixed/failed/erased, checkCameraRule(). app.js and selfcheck.js
are ported; the old-API copies are kept in W/proto/*.oldapi.js. ORACLE's 23:15 BLOCKER (grey scratch residue read as
dark by local binarizers, so dead codes scanned) is fixed in VISUAL's 23:22 file, which the SITE runs: 0 reads past
the limit (ORACLE 42 states + 420 views; LEAD 96 attempts), camera rule 0 violations per pixel at DPR 1/2/3.
Exercise X2 dropped (repeats E5); the SITE has E1 to E6 plus X1 (fooled line) and X3 (XOR). 13 self-checks.

IC-13 (LEAD, 23:50, ORACLE's final report via the coordinator) Honesty fixes, all in the SITE:
* Erasure mode: a block whose TRUE broken bytes exceed maxTry is `cameraOver` (viewOf). The page still reads it,
  so the label is "Still reads on this page", the note is "This page can read it only because it knows where you
  scratched. A phone doesn't know, so it should give up here: try it." and that block's meter shows a red line
  "A phone sees N broken bytes here and can fix only M." (.qr-meter-cam). The same scratch with erasures off is
  refused (W/proto/erasure.mjs: 19 + 18 scratched of 22, 17 + 17 true broken of 11). Reverse case (erasure mode
  refuses, every block's true broken <= maxTry): note "Told where you scratched, this page counts every scratched
  byte as a gap ... A phone ... may still read this: try it." (not met in 4,000 random strokes; kept as a guard).
* State F: note "Most scanners give up here too." / "Most scanners never get that far."; summary "...a reader
  usually can't tell..."; explainer step 6 "a scanner usually cannot tell". Note 5 already says "most scanners".
  State G tests wrongText !== null (it did).
* Wording: claims about scanner behaviour say "the open-source scanners we checked" (step 5 erasures, step 6
  impostor, E6 answer "every open-source scanner we checked gave up"); products are named only in Sources.
* Show bytes: the readout note on switching it on ends "Turn Show bytes off before scanning." (the legend has it too).
* Phones: a long label or summary (label > 14 or summary > 56 characters) gets its own row (data-stack).
* Impostor: kept 'FLOOR 26' -> 'FLOOR 17' (ORACLE's own candidate list, same 7 squares as 'TABLE 18', and the page's
  AUTOMATIC mask is 7, so no forced mask is needed). ORACLE's t7 proof re-run on it (W/proto/impostor_proof.py,
  output W/proto/impostor/floor26.json): zx, zx_gh, cv, cva read FLOOR 17 at 4, 6, 8, 10, 12 px/module; filmed
  zx 6/6, cva 2/6 (TABLE 18: the same); clean reads FLOOR 26 in all four; lab grid decoder FLOOR 17, refused under
  the reserve; the SITE's qr.js reads FLOOR 17 with wrongText and refuses under limit 'reserve'. Step 6's
  paragraph now ends on the reserve-bytes lesson.

IC-10 (VISUAL, ORACLE) W/proto/ghost.json was rewritten at 22:49: it now holds the FINAL ghost (P0 (0.28, 0.52),
P1 (0.50, 0.20), P2 (0.80, 0.60), radius 1.2 modules = 0.04138, 25 points, 9 broken bytes 4 + 5). The 22:30 version
of that file (P0 (0.20, 0.55), radius 0.6) is obsolete; re-render anything made from it.

---------------------------------------------------------------------------------------------------------------------

## 0. The numbers this spec rests on (all computed here; commands and outputs)

Everything below was computed with python3 -I and the pylib path from DIRECTION.md. My own reference encoder,
W/proto/qrref.py (written from the standard's rules, not shipped), is cross-checked against zxingcpp's encoder.

```
$ python3 -I W/proto/xcheck_zxing.py
cases per variant (text x level that fit v1-6): 260
mask choice agrees with zxingcpp: {'clamp': 260, 'strict': 108}
identical modules at zxingcpp's mask: 260 of 260
mismatches (first 10): []
```

```
$ python3 -I W/proto/tables.py        (full output in W/proto/tables.out)
ver lv size total  blocks                      ec  p  budget maxTry erasures  fixable%  alnum byte
1   L  21x21   26  1x(26,19,7)                  7  3      2      3        4      7.7      25   17
1   M  21x21   26  1x(26,16,10)                10  2      4      5        8     15.4      20   14
1   Q  21x21   26  1x(26,13,13)                13  1      6      6       12     23.1      16   11
1   H  21x21   26  1x(26,9,17)                 17  1      8      8       16     30.8      10    7
2   L  25x25   44  1x(44,34,10)                10  2      4      5        8      9.1      47   32
2   M  25x25   44  1x(44,28,16)                16  0      8      8       16     18.2      38   26
2   Q  25x25   44  1x(44,22,22)                22  0     11     11       22     25.0      29   20
2   H  25x25   44  1x(44,16,28)                28  0     14     14       28     31.8      20   14
3   L  29x29   70  1x(70,55,15)                15  1      7      7       14     10.0      77   53
3   M  29x29   70  1x(70,44,26)                26  0     13     13       26     18.6      61   42
3   Q  29x29   70  2x(35,17,18)                18  0      9      9       18     25.7      47   32
3   H  29x29   70  2x(35,13,22)                22  0     11     11       22     31.4      35   24
4   L  33x33  100  1x(100,80,20)               20  0     10     10       20     10.0     114   78
4   M  33x33  100  2x(50,32,18)                18  0      9      9       18     18.0      90   62
4   Q  33x33  100  2x(50,24,26)                26  0     13     13       26     26.0      67   46
4   H  33x33  100  4x(25,9,16)                 16  0      8      8       16     32.0      50   34
5   L  37x37  134  1x(134,108,26)              26  0     13     13       26      9.7     154  106
5   M  37x37  134  2x(67,43,24)                24  0     12     12       24     17.9     122   84
5   Q  37x37  134  2x(33,15,18) + 2x(34,16,18)  18  0      9      9       18     26.9      87   60
5   H  37x37  134  2x(33,11,22) + 2x(34,12,22)  22  0     11     11       22     32.8      64   44
6   L  41x41  172  2x(86,68,18)                18  0      9      9       18     10.5     195  134
6   M  41x41  172  4x(43,27,16)                16  0      8      8       16     18.6     154  106
6   Q  41x41  172  4x(43,19,24)                24  0     12     12       24     27.9     108   74
6   H  41x41  172  4x(43,15,28)                28  0     14     14       28     32.6      84   58
(p = misdecode-protection reserve from the standard's Table 9: 1-L 3, 1-M 2, 1-Q 1, 1-H 1, 2-L 2, 3-L 1, else 0.
 FACTS confirms the table; the capacities match the standard's published capacity table.)

== Format strings with mask 0 (15 bits, after the 0x5412 mask)
L 111011111000100 0x77c4      M 101010000010010 0x5412      Q 011010101011111 0x355f      H 001011010001001 0x1689

== HELLO WORLD at 1-M (alphanumeric)
data codewords: [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17]
check codewords: [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]

== Default message: 'SCRATCHED BUT STILL READABLE' 28 characters
level L -> version 2 (25x25) mask 4;  M -> version 2 mask 1;  Q -> version 2 mask 4;  H -> version 3 (29x29) mask 7
3-H dataBits 167 of 208; data codewords (26): [32, 228, 248, 153, 52, 149, 133, 166, 212, 27, 79, 104, 75, 63, 122,
  179, 52, 231, 156, 215, 126, 0, 236, 17, 236, 17]
 block 1 data (13): [32, 228, 248, 153, 52, 149, 133, 166, 212, 27, 79, 104, 75]
 block 1 check (22): [42, 146, 243, 210, 155, 223, 68, 122, 113, 203, 148, 169, 111, 122, 107, 114, 214, 64, 242, 9, 120, 249]
 block 2 data (13): [63, 122, 179, 52, 231, 156, 215, 126, 0, 236, 17, 236, 17]
 block 2 check (22): [127, 102, 110, 32, 29, 227, 194, 244, 170, 74, 209, 167, 81, 140, 37, 253, 218, 134, 123, 44, 42, 61]
 block 1 = even stream positions 0, 2, ..., 68; block 2 = odd positions 1, 3, ..., 69 (data 0..25, check 26..69)
per-mask totals: [1493, 1350, 1448, 1304, 1340, 1386, 1407, 1301] -> mask 7; format bits 3-H mask 7: 000100000111011
module roles 3-H [data, finder+sep, timing, align, fmtA, fmtB, dark, remainder]: [560, 192, 26, 25, 15, 15, 1, 7]
codewords whose 8 modules are not a 2x4 rectangle: 54 of 70  (bounding-box test; the exact shape test in
 W/proto/misc.out says 55 of 70: only 15 bytes are neat 2x4 rectangles)
```
HELLO WORLD 1-M reproduces the published data and check codewords exactly; the four mask-0 format strings match
the standard's table (the dossier quotes L and M from a library table citing Annex C; Q and H recomputed).

What real decoders do (rendered black on white, 10 px per module, 4-module quiet zone; 30 random trials per row):
```
$ python3 -I W/proto/damage.py        (W/proto/damage.out)
3-H default message, broken bytes per block (random positions, random wrong values):
 block1 10, block2  0:  zxing 30 read / 0 wrong / 0 no read   cv 30/0/0   cvAruco 30/0/0
 block1 11, block2  0:  zxing 30/0/0                         cv 30/0/0   cvAruco 30/0/0
 block1 12, block2  0:  zxing 0 read / 0 wrong / 30 no read  cv 0/0/30   cvAruco 0/0/30
 block1 13, block2  0:  zxing 0/0/30                         cv 0/0/30   cvAruco 0/0/30
 block1  0, block2 11:  all three 30/0/0;      block1 0, block2 12: all three 0/0/30
 block1 11, block2 11:  all three 30/0/0 (22 broken bytes, a third of the code, still reads)
 block1 12, block2 11:  all three 0/0/30;      block1 4, block2 5 (the first frame's split): all three 30/0/0
3-H scratch style (every module of the chosen bytes turned light): 11 -> 30/30 read, 12 -> 0/30, 11+11 -> 30/30
Reserve bytes (one block):
 1-M (budget 4, half 5): 4 -> 30/30 read, 5 -> 30/30 read, 6 -> 0/30     (all three decoders)
 1-L (budget 2, half 3): 2 -> read, 3 -> read, 4 -> no read;  2-L (budget 4, half 5): 5 -> read, 6 -> no read
 1-Q, 1-H, 3-L: read at half, fail at half + 1
```
So: (a) the breaking point of the default code is exactly 11 versus 12 broken bytes in one block, for all three
decoders, and no trial ever read a wrong message; (b) the tested decoders ignore the reserve bytes and use half the
check bytes. ORACLE's wider run (W/oracle/out/t1_breaking.txt) agrees for zxingcpp at every version and level, and
finds the plain cv2.QRCodeDetector sometimes gives up EARLIER (2-L, 2-Q, 3-H) on its scratch shapes: phones may give
up a little before the page does (the copy says so, 2.5 and 9.6).
```
$ python3 -I W/proto/damage2.py ; python3 -I W/proto/damage3.py     (W/proto/damage2.out, damage3.out)
Corner squares: wiped, centre 3x3 wiped, one thin scratch line through it, half wiped, blacked out with marker,
  at each of the three corners: zxing, cv and cvAruco ALL fail, 15 of 15 cases.
Format: copy A wiped light (B intact): all read; copy A marker dark: all read; copy B wiped or dark (A intact): all
  read; 1 to 3 random flips in one copy: all read 20/20; 4 to 6 random flips in one copy: zxing 20/20, OpenCV 7-15/20;
  both copies 2 flips each: zxing 16/20; 3 each: zxing 5/20; both copies 4 or more flips: 0/20; both wiped: none.
Alignment square wiped: all read. Timing row wiped: zxing reads, both OpenCV paths fail. Timing column wiped: zxing
  and cv read, cvAruco fails.
```
The first frame's ghost scratch (section 3.3):
```
$ python3 -I W/proto/ghost_final.py   (W/proto/ghost_final.out, W/proto/ghost.json)
ghost: quadratic Bezier P0=(0.28, 0.52) P1=(0.5, 0.2) P2=(0.8, 0.6), radius 1.20 modules = 0.04138 of the symbol width
modules under the brush 46, changed 26, roles changed {'data': 26}
broken stream bytes [11, 15, 20, 26, 35, 49, 54, 55, 60]
 block 1: broken 4 of budget 11 (stream [20, 26, 54, 60]); under brush 7
 block 2: broken 5 of budget 11 (stream [11, 15, 35, 49, 55]); under brush 6
bytes under the brush (erasure mode): 13
 decoders at 8, 9, 10 and 12 px/module: zxing True, cv True, cvAruco True
 same stroke at level L (version 2): 10 broken of budget 4, also clips a timing module -> zxing and cv FAIL
 same stroke at level M (version 2): 8 of 8 -> reads (at the edge);  level Q (version 2): 10 of 11 -> reads
```
Step 2 (bytes, not squares):
```
$ python3 -I W/proto/step2.py   (W/proto/step2.out)
one square (14,14) scratched light: 1 byte broken (block 2); the same square with marker: 0 (it was already dark)
horizontal scratch along row 14, 20 squares (r 0.5): 12 squares changed, 8 bytes broken (5 + 3), reads
horizontal scratch 3 squares wide (61 squares under the brush, 35 changed): 11 bytes (6 + 5), reads
vertical scratch along column 15, 20 squares: 10 changed, 5 bytes (2 + 3); 3 wide: 12 bytes (7 + 5), reads
data modules 560 = 70 bytes x 8 = 66.6% of the 29x29 area; the most 3-H can lose (22 bytes) = 31.4% of the byte area
```
Exercises and ladder numbers: `python3 -I W/proto/exercises.py` (W/proto/exercises.out), quoted in sections 7 and 8.

---------------------------------------------------------------------------------------------------------------------

## 1. Promise and audience

Promise, in one plain sentence: a lesson on why a QR code still scans after a big chunk of it is scratched off.
The visitor scratches a live code, the page shows which bytes broke and that it repaired them, and their own phone
confirms it; then they push until it breaks.

Concept (the one idea): the code carries extra check bytes that are not copies. The message becomes points on a
curve; the code sends extra points on the same curve; a decoder finds the one curve that fits almost all the points
and repairs the bytes that do not fit (Reed-Solomon error correction). Two extra points pay for one unknown error,
one extra point pays for one known gap.

Audience: a curious adult who has scanned a scuffed code on a menu, a ticket or a parcel. No maths needed before the
first success. The ladder reaches lines, parabolas and clock arithmetic for those who want minute ten.

Misconception to bust (documented, FACTS sources it): "a QR code survives damage because any 30% of its picture can
be covered". Truth on this page, measured: the budget is counted in BYTES PER BLOCK, not area; one scratched square
spoils a whole byte; a long scratch shares its damage between interleaved blocks; and the three corner squares are
not data at all: one thin scratch across one of them stops all three decoders we tested (0.2 above).

Title: "Scratch a QR Code" (kept: it is the first action and names the object; 4 words; the judges' clarity notes
praise it). Slug scratch-a-qr-code. Purpose lesson, tier 1. Day label `Day 11 &middot; 2026-10-20` plus
`<span class="cameo-badge">Opus cameo</span>`.

## 2. Exact copy

### 2.1 Head
* `<title>` and `<h1>`: Scratch a QR Code
* meta description: A hands-on lesson on why a scratched QR code still scans: scratch a live code, scan it with
  your phone, and see the check bytes repair what you broke.
* Tagline (93 characters): Scratch a working QR code and it keeps scanning. Find the one scratch that finally breaks it.
* Intro (59 words; first sentence 18 words; counted by W/proto/copycheck.py), exactly:
  A lesson on why a QR code still scans after a big chunk of it is scratched off. The code carries extra check
  bytes (numbers worked out from the message) that rebuild what is missing. For anyone who has scanned a scuffed
  code on a menu or a parcel: scratch the one below, then scan it with a phone.
  (One glossed term, "check bytes". project.json intro is this text exactly.)

### 2.2 The app's labels (first screen)
* Code canvas aria-label: "QR code you can scratch. Drag across it to scratch. With the keyboard: arrow keys move
  the brush, Space starts and ends a scratch, Ctrl+Z undoes." (role img is NOT used: it is an interactive canvas
  with tabindex 0; its live summary is the readout, which is aria-live polite.)
* Tool switch (one role=switch button): text "Scratch" with a small knob; when on: "Marker". aria-label
  "Marker: paint dark squares instead of scratching" with aria-checked. Tooltip (title): "Scratch removes ink.
  Marker adds ink."
* Buttons: "Undo" (aria-keyshortcuts Control+Z), "Clean code", "Show bytes" (aria-pressed), "More" (aria-expanded).
* Message field: visible label "Your message", placeholder none, value "SCRATCHED BUT STILL READABLE", maxlength 84.
  Helper line under it (only while focused or invalid): "28 characters, fits a 29 x 29 code at level H" (computed).
* Instruction (in the note line when nothing else needs it): desktop "Scratch it. Then scan it with your phone."
  Coarse pointer (phones, tablets): "Scratch it. Then scan it with a second phone, or a friend's."
  Plus, on coarse pointers only, a quiet line under the toolbar: "A phone can't photograph its own screen: show this
  page on a computer or another phone and scan that." (never hidden, never in a closed panel).

### 2.3 Readout (the big type; every state). Structure, top to bottom, all lines reserved so nothing shifts:
  label line (small caps, 0.85rem) / message (1.5 to 2rem, bold, up to 2 lines reserved) / summary (1.1rem) /
  meters (one row per block) / note (2 lines reserved desktop, 3 on phones).

| State | Label | Message line | Summary | Note (one line of the priority list 2.4) |
|---|---|---|---|---|
| A clean | Reads | the message | No damage yet: every byte is intact. | the instruction |
| B fixed | Still reads | the message | 9 broken bytes found and fixed | 2.4 list, else the instruction |
| B1 (1 byte) | Still reads | the message | 1 broken byte found and fixed | as B |
| C at the edge (some block's errors = maxTry; erasure mode: cost = ecCount) | Still reads | the message | as B | "One more broken byte in block 2 breaks it." (several: "in block 1 or block 2"; four: "in block 1, 3 or 4") |
| D past the promise (1-L, 1-M, 2-L only: budget < errors <= maxTry) | Still reads | the message | as B | "Past the promise: block 1 has 5 broken bytes, and at this size the standard only promises 4. Scanners usually still fix 5, but one more breaks it." (FACTS checks "usually"; fallback "A scanner may still manage 5.") |
| E failed (a block beyond maxTry, or erasure cost beyond ecCount) | Can't read it | the message, struck through, muted | "Block 2 has 12 broken bytes; it can fix 11." (true count from grading; several: "Blocks 1 and 2 have 12 and 13 broken bytes; each can fix 11.") | "A phone should give up here too: try it. Undo takes back the last scratch." |
| F format lost (no format copy within 3 bits) | Can't read it | struck through | "Both copies of the format strip are damaged, so a reader can't tell how the code was made." | if dataOk: "The bytes themselves would still be fixable (block 1: 3 of 11, block 2: 2 of 11)." else as E |
| G miscorrected (graded.miscorrected or formatWrong with ok) | Reads the WRONG message | "the wrong text", in quotes, with a warning glyph and red rule (never a link) | "The damage looked like a smaller, different scratch, so the decoder fixed the wrong bytes. A scanner would read this wrong message too." | "Small codes keep reserve bytes to make this rarer: see step 6." (links to #step-6) |
| H erasure mode on | Still reads | the message | "13 known gaps filled: the decoder was told where you scratched" | at the edge: "One more scratched byte in block 1 breaks it."; failed summary: "Block 1 has 23 scratched bytes; told where they are, it can fill 22." |
| During a stroke | as the live decode | the message | "{n} broken bytes so far" (red tint) | unchanged |

Meters: one per block, label "Block 1", a bar of maxTry cells (11 at 3-H; in erasure mode ecCount cells, each one
check byte), and the count "4 of 11". Cells fill in the block colour; at the edge the count turns bold; past the
limit extra cells appear hatched red outside the bar ("12 of 11"); where the guaranteed budget is lower (IC-8) the
cells above it are dotted and a small tick says "promised: 4". Versions with 4 blocks show 4 compact meters (2 per row on phones).
Text equivalents for screen readers: "Block 1: 4 of 11 broken bytes fixable".

### 2.4 Note priority (show the first that applies; one at a time)
1. Corner square changed (graded.structure.finder any > 0): "A phone may not find this code now: cameras spot a
   code by its three corner squares, and you scratched one. This page knows the grid, so it still reads." The label
   becomes "Still reads on this page".
2. Format strip, strong (formatA >= 4 and formatB >= 4 changed modules, or either copy's nearest valid code is a
   WRONG format within 3 bits): "The format strip is damaged in both copies: a phone may not read this code any
   more, or may even misread it." Label "Still reads on this page". (ORACLE: both copies 4+ bad bits, about 0%
   read; a copy that looks like a wrong format misleads OpenCV, which trusts copy A first; both copies wiped on a
   mask-0 6-H code made zxing-cpp read nonsense with zero errors.)
3. Timing line changed (timing > 0): "You scratched a timing line (the dotted row or column between the corner
   squares). Some scanners count squares with it, so a phone may struggle."
4. State C (at the edge), state D (past the promise).
5. Format strip, mild: one copy changed and the other intact or at most 1 changed module, neither copy pointing
   at a wrong format: "One copy of the format strip is damaged; scanners can still use the spare copy." Any other
   damage to both copies: "The format strip is damaged in both copies; some scanners may struggle."
6. The instruction.
(Wording is safe against 0.2: corner damage stopped every decoder tested; timing damage stopped OpenCV but not
zxing; one wiped format copy stopped none. "may" everywhere; no claim about any phone brand.)

### 2.5 Phone and honesty lines
* In More and in step 6: "Real cameras also fight glare, blur and tilt, so a phone may give up a little before this
  page does. Turn the screen brightness up and hold the phone 20 to 40 cm away."
* About panel and project.json makingOf (identical text, ~110 words; LEAD may tighten in PHASE 2):
  "This page is an Opus cameo: it was built by a team of Claude Opus agents instead of the usual Sonnet team.
  Everything runs in your browser and nothing you type leaves your device. The code is drawn by the page's own
  hand-written encoder (versions 1 to 6, levels L, M, Q and H) and read back after every scratch by its own decoder,
  which repairs bytes with Reed-Solomon error correction over the 256-value number system QR codes use. Before
  publishing, the page's codes were checked against the standard's worked examples and against two independent
  open-source QR decoders reading screenshots of this page. QR Code is a registered trademark of DENSO WAVE
  INCORPORATED."
* Credits line: "Built by Opus, a cameo on Sonnet Every Day".
* No URL state for the message: a shared link must never make this page show someone else's code (anti-phishing).

## 3. First frame

### 3.1 Desktop 1280 x 800 (light and dark)
* y 0 to 64: header (back link pill, day label + badge).
* y ~72 to 125: h1; ~130 to 160 lede (tagline + "Jump to the explanation"); ~176 to 265 intro (3 lines at 68ch).
  Intro bottom about 265 (limit 420).
* y ~290: `section.qr-app[data-sed-result]` (top about 290, limit 560): a two-column grid at >= 900 px.
  - Left: the code card, white in both themes, exactly the symbol plus its 4-module quiet zone (37 modules wide at
    3-H), no extra padding, radius 12 px, soft shadow, sitting on the paper texture. modulePx =
    clamp(8, min(floor(availW / (size + 8)), floor((innerHeight - 48) / (size + 8))), 12): the card always fits
    the viewport once the app is scrolled to its top (the thumbnail is shot in a 1200x630 viewport scrolled to
    data-sed-result, so it must not depend on where the app sits on the page). Integer CSS px, computed before the
    first paint and on resize (debounced, never during a stroke). At 1280x800, 3-H: 12 px, card 444 x 444, bottom
    about 734, all on screen. At 1366x768 also all on screen (bottom about 734). At 1280x650 the card's lower part
    sits below the fold (its top, the readout and the toolbar are on screen; no overlap).
    The canvas keeps the same CSS box when the version changes (module px recomputed, the card size steps; the
    readout column does not move).
  - Right (min 360 px): the readout (2.3) at the top, then the toolbar (6 controls), then the More panel (closed).
* Under the app, on desktop: nothing else in the first screen (the explainer starts below the fold).
* Thumbnail (1200x630, desktop-light, scrolled to data-sed-result): the scratched code at the left with green
  "fixed" outlines, the big "Still reads: SCRATCHED BUT STILL READABLE", "9 broken bytes found and fixed" and the
  two meters. window.__sedThumbReady resolves when the ghost animation has ended (or at once under reduced motion).

### 3.2 Phone 390 x 844
* Header in one row (back link pill 36 px tall, day label 0.75rem, badge); h1 1.7rem one line; tagline 2 lines;
  intro 7 to 8 lines (1rem/1.5); the "Jump to the explanation" link moves under the app on phones.
  Targets: intro bottom <= 400 (limit 560), app top <= 410.
* Stacked: the code card full width minus 16 px gutters: 390 - 32 = 358 -> 9 px per module -> 333 px card (3-H);
  the readout right under it, compact: label + message on one line when it fits ("Still reads:" then the message),
  summary, meters side by side (2 per row). Code card bottom about 745, meters bottom about 830: the whole code and
  its readout are inside 844. The toolbar follows (just below the fold is acceptable: the first action is the code
  itself; Undo is one short scroll away and the code stays in view while using it).
* 320 px wide: floor((320 - 32) / 37) = 7 px per module -> card 37 x 7 = 259 px; no horizontal scroll.
  8 px minimum holds from 360 px wide up. Versions 5 and 6 on phones may drop to 7 px (a stated limit: phones are
  not the scanning screen).

### 3.3 The running demo (the ghost scratch)
* On load (after first paint, when the card is at least 50% in view, IntersectionObserver), wait 400 ms, then the
  ghost stroke draws itself: quadratic Bezier P0 (0.28, 0.52), P1 (0.50, 0.20), P2 (0.80, 0.60) in normalized symbol
  coordinates, radius 0.04138 (1.2 modules at 3-H), sampled as 25 points (W/proto/ghost.json), drawn over 1100 ms
  with ease-in-out. Modules flip as the brush passes; each byte outlines red the moment it breaks.
* 300 ms after the stroke ends, the red outlines flash green one by one (60 ms stagger, block 1 first) as the
  readout counts "1 ... 9 broken bytes found and fixed"; the outlines settle as thin green "fixed" outlines.
  Total about 2.6 s. Exact result: 46 modules under the brush, 26 changed, 9 broken bytes: block 1 4 of 11 (stream
  20, 26, 54, 60), block 2 5 of 11 (stream 11, 15, 35, 49, 55); no structure touched; all three real decoders read
  the rendered result at 8, 9, 10 and 12 px per module.
* The ghost is stroke 0 in the undo stack: Undo removes it, Clean code removes it. Any pointerdown or key on the
  code before it ends completes it instantly (no fight with the visitor).
* Reduced motion: the final state is drawn at once (no draw-on, no flashes; the green outlines appear static).
* No layout shift: every readout line has its height reserved from the first paint (static text in index.html
  already shows the final numbers, so the no-JS and pre-JS frame match the end state).

### 3.4 First-screen controls (desktop): 7
1 the code canvas (tabindex 0), 2 Scratch/Marker (one role=switch), 3 Undo, 4 Clean code, 5 Show bytes
(aria-pressed), 6 Your message (text input), 7 More (button, aria-expanded, aria-controls qr-more). Plain links (back,
jump) do not count. Correction level, "Tell the decoder where the scratches are", brush size, "Same scratch, every
level", "Check the decoder" and the scanning tips live in the More panel.

## 4. Interaction design

### 4.1 Pointer (mouse, pen)
pointerdown on the canvas starts a stroke at the pointer (setPointerCapture); pointermove appends points (skip moves
under 0.25 module); pointerup or pointercancel ends it. The brush ring (radius r) follows the pointer on hover.

### 4.2 Touch (the phone rule; cameo 1's panel caught the failure)
The canvas has `touch-action: pan-y` and non-passive touchstart/touchmove listeners:
* the first move larger than 6 px decides: mostly sideways (|dx| > |dy|) -> scratch at once (preventDefault on
  every following move); mostly vertical -> do nothing, the page scrolls;
* press and hold 300 ms with under 8 px of movement -> armed: a ring fills around the finger during the hold
  (reduced motion: a static ring), then the stroke follows the finger in any direction (preventDefault);
* a quick tap (under 200 ms, no move) scratches a single dot (the brush disc).
* Two fingers: never scratch (pinch zoom stays the browser's).
Phone hint on coarse pointers, in the note line until the first stroke: "Drag sideways to scratch, or hold, then drag."
Playwright check (touch emulation, 390x844): a vertical swipe over the code changes scrollY and no module; a
sideways drag changes modules and not scrollY; hold-then-vertical changes modules.

### 4.3 Keyboard
Canvas focused: a brush cursor (ring) appears at the code centre. Arrow keys move it one module (Shift: 4 modules);
Space or Enter starts a stroke, moving extends it, Space/Enter again or Escape ends it; Ctrl/Cmd+Z = Undo anywhere
on the page outside text fields; Tab order: canvas, tool switch, Undo, Clean code, Show bytes, Your message, More,
then the More panel's controls when open. Focus is always visible (shell ring; on the canvas a 3 px ring outside the
card so the quiet zone stays clean).

### 4.4 Controls and states
* Scratch/Marker: switch the tool for the next stroke. Marker paints dark squares (covers the code with ink).
* Undo: removes the last stroke (the ghost included); disabled when the stack is empty.
* Clean code: removes every stroke (the code is as printed); the readout returns to state A; disabled when clean.
* Show bytes: outlines every byte in its block's colour (5.3), shows a one-line legend under the card. Turning it on
  also explains in the note line once: "Each outline is one byte: 8 squares. Blue stripes = block 1, orange dots =
  block 2; solid = message bytes, dashed = check bytes." Scanning with it on still works (ORACLE proves it or the
  legend says "Turn Show bytes off before scanning").
* Your message: re-encodes 300 ms after typing stops (or on Enter) with mode auto (alphanumeric when every character
  is in 0-9 A-Z space $ % * + - . / :, else byte mode in UTF-8), version auto (smallest of 1 to 6 that fits at the
  current level), mask auto. Strokes are KEPT (normalized), so the same scratch lands on the new code. Too long:
  the code keeps the last valid message; helper text: "Too long for this lesson's biggest code (41 x 41): at level H
  it holds 84 capital letters and digits, or 58 other characters. Shorten it, or pick level L in More." Empty:
  "Type something to encode." (the code keeps the last valid message). Never rendered as HTML; never put in the URL.
* More: opens the panel inline below the toolbar (content below moves: acceptable on a user action), focus moves to
  its first control; Escape closes it and returns focus to More.

### 4.5 The stroke model (SITE/strokes.js, LEAD)
```
Stroke = {tool: 'scratch' | 'marker', r: number /* normalized */, pts: Float32Array /* u0,v0,u1,v1,... in 0..1 */}
footprint(size, stroke) -> Uint8Array(size*size)    // 1 where the module centre ((x+0.5)/size, (y+0.5)/size) is
                                                    // within r of the polyline (a single point = a disc)
applyStrokes(sym, strokes) -> {modules: Uint8Array, under: Uint8Array}   // in order: scratch -> 0, marker -> 1;
                                                    // under = union of all footprints (the erasure map)
appendSegment(state, stroke, u, v)                  // incremental: updates modules/under for the new segment only
GHOST = {tool:'scratch', r: 0.04138, pts: [25 points from W/proto/ghost.json]}
```
Brush radius presets (normalized to the 3-H width, so the same physical size on every version): Fine 0.6/29,
Medium 1.2/29 (default; equals the ghost), Wide 2.0/29; on coarse pointers the default is Wide. The quiet zone
cannot be damaged (only symbol modules exist in the model and the renderer clips marks to the symbol).
Every stroke frame: appendSegment, then one decode per animation frame (coalesced), then draw.

### 4.6 The More panel (closed by default)
* "Correction level" radio group L, M, Q, H with a one-line gloss each: "L: about 7% of bytes can be repaired",
  "M: about 15%", "Q: about 25%", "H: about 30% (this page starts here)". (Percentages are the standard's nominal
  levels, FACTS sources them; the meters always show the exact budget of the current code.) Changing the level
  re-encodes; strokes kept.
* "Tell the decoder where the scratches are" (role=switch) + gloss: "A camera has to find the damage itself. If the
  decoder is told where you scratched, each scratched byte costs 1 check byte instead of 2, so it can fill twice as
  many. Every byte under the brush counts, even if it did not change." Turns on state H.
* "Brush" radio: Fine, Medium, Wide.
* "Same scratch, every level" (P2): a 4-row mini table recomputed on every stroke end: "L (25 x 25): breaks, 10 of 4
  in its only block / M: reads, 8 of 8 / Q: reads, 10 of 11 / H: reads, 4 + 5 of 11" (the numbers in 0 for the ghost).
* "Check the decoder" button: runs the self-checks (section 10) and lists each with a tick or a cross.
* Scanning tips (2.5) and the phone line.

## 5. Visual design (VISUAL owns the details in W/visual/DESIGN.md; these are the LEAD's constraints)

### 5.1 Look
A scuffed sticker on paper, never a lottery scratch card: no gold or silver foil, no coins, no prizes, no "win",
no sparkle. The page background carries a gentle paper texture (generated, low contrast, CSS or canvas noise under
0.04 alpha); the code card is a crisp white sticker with a soft shadow in both themes. Scratches look like ink worn
off a sticker: the white paper shows through with faint grey fibres and slightly torn edges. Marker looks like matte
felt-tip ink, slightly warmer black than the printed modules.

### 5.2 Themes, type
Shell tokens for page, text and panels; the card is always #ffffff with modules #111111 (dark mode: the card keeps a
1 px #ffffff22 halo and a deeper shadow). System font stack; the message line in the readout semibold with
font-variant-numeric: tabular-nums for counts. Block colours (Okabe-Ito, colour-blind safe, always paired with a
pattern and a label): block 1 blue #0072B2 + diagonal stripes, block 2 orange #E69F00 + dots, block 3 green #009E73
+ cross-hatch, block 4 purple #CC79A7 + horizontal lines. Broken: vermillion #D55E00 dashed outline; fixed: green
#009E73 solid outline; beyond repair: vermillion outline + hatch. Contrast of every text on its background AA.

### 5.3 Overlays (Show bytes, broken, fixed)
Byte outlines follow the true module shape of each codeword (55 of the 70 bytes at 3-H are not 2x4 rectangles; only 15 are, W/proto/misc.out):
draw the edges of each codeword's modules that border a module of another codeword or a function module. Outline
width at most 15% of a module, centred on the module edge. Show bytes may tint LIGHT modules of a byte with its
block colour at a luminance of at least 0.75; dark modules stay dark.

### 5.4 The camera rule (binding; ORACLE tests it)
In the central 60% x 60% of every module, every rendered pixel has relative luminance <= 0.25 for a dark module and
>= 0.75 for a light one, in both themes, with any overlay, flash, texture, cursor or animation frame. Texture and
torn edges may use only each module's outer 20% band, and never the quiet zone. So what a camera samples at each
module centre equals the module state the decoder is given.

### 5.5 Motion
Meaning only: the brush draws; a byte outlines red when it breaks; when the stroke ends, the decoder's repairs flash
green (one 300 ms pulse each, staggered); a failed block's meter shakes once (2 px, 200 ms) and stays red; the
readout's counts tick. Reduced motion: no draw-on, no flash, no shake; states change instantly.

### 5.6 render.js interface (VISUAL)
```
draw(canvas, sym, view, opts)
  view = {modules: Uint8Array, under: Uint8Array, strokes: Stroke[],   // current state (from strokes.js)
          cwStatus: Uint8Array | null,   // Read.status per stream codeword (0 ok, 1 fixed, 2 beyond, 3 erased)
          broken: Uint8Array | null,     // 1 per codeword changed vs clean (graded), for red outlines while drawing
          showBytes: bool, flash: Float32Array | null /* 0..1 per codeword */, cursor: {u, v, r} | null}
  opts = {modulePx, quiet: 4, dpr, theme: 'light' | 'dark', blockOf: Int8Array(stream.length), dataCountOf}
moduleRect(sym, x, y, opts) -> {x, y, w, h} in CSS px   // for hit tests and for ORACLE's sampler
```
The canvas backing store is CSS size x devicePixelRatio, module edges on whole device pixels.

## 6. The engine (ENGINE builds W/engine/qr.js to DIRECTION's interface plus IC-1 to IC-4)

### 6.1 Encoder
Versions 1 to 6 (no version information needed below 7), modes alphanumeric and byte (auto), levels L, M, Q, H with
the block table of section 0, Reed-Solomon over GF(256) with 0x11D and generator roots alpha^0 ... alpha^(n-1),
interleaving (data codewords by index across blocks, shorter blocks first-exhausted, then check codewords), the
standard placement and remainder bits (7 for versions 2 to 6), masks 0 to 7 with IC-1, BCH(15,5) format bits with
generator 0x537 and mask 0x5412, the dark module at (8, size - 8). Byte mode is UTF-8 without an ECI header
(what the tested decoders and phones read by default; ENGINE documents it).

### 6.2 Known answers ENGINE's tests must hit (all in section 0)
HELLO WORLD 1-M data and check codewords; L/M/Q/H mask-0 format strings 0x77C4, 0x5412, 0x355F, 0x1689; the
default message at L, M, Q, H -> versions 2, 2, 2, 3 and masks 4, 1, 4, 7; the 3-H data and check codewords and
per-mask totals; capacities of section 0 for all 24 version-levels and both modes; and module-for-module equality
with W/proto/qrref.py for the 260 cases of xcheck_zxing.py (ENGINE may call qrref through a fixture file: LEAD can
dump them as JSON on request in NOTES).

### 6.3 Budget, reserve, erasures, miscorrection (decisions)
* Decode limit 'half' by default: 2e + s <= ecCount, exactly what zxingcpp and both OpenCV paths do (section 0 and
  ORACLE's 24-pair run). So the page's "one more breaks it" matches the scanners at every level (IC-8).
* Guaranteed budget = floor((ecCount - reserve) / 2) is shown as the "promised" tick; it differs from maxTry only at
  1-L (2 vs 3), 1-M (4 vs 5) and 2-L (4 vs 5); at 1-Q, 1-H and 3-L the floor makes them equal.
* Erasures: only with the toggle; every codeword touched by any stroke footprint is an erasure. The meter's cells
  are erasureBudget = ecCount - reserve; the decoder (limit 'half') accepts up to ecCount erasures, and erasures
  beyond erasureBudget show as state D ("past the promise").
* Miscorrection: detected only by grading against the clean code (a real scanner cannot know); shown as state G.
  At 3-H a random miscorrection is about 1 in 10^18 (sphere volume V(11)/256^22), so the hero shows G only from
  crafted damage; the line widget shows it often (section 7, step 3) and step 6's "impostor" shows it on a real
  code (P2, ORACLE builds it).
* Camera notes come from graded.structure (2.4).
* Performance: decode < 5 ms for version 6 in Chromium (target < 1 ms at 3-H); one decode per animation frame.

### 6.4 Second decode path
readPixels(rgba, width, height, {originX, originY, modulePx, size}) samples a 3 x 3 device-pixel patch at each
module centre, thresholds at the midpoint of the darkest and lightest patch means, and returns modules. The page
uses it in the load-time self-check (10) on an offscreen canvas painted by render.js: the picture, not only the
state, must decode.

## 7. The ladder (inside the explainer; each step an h3 with id step-1 ... step-6, a live demo in a figure)

Step 1 "Scratch it" (the hero; no new widget). The text sends the visitor back up with a link "Back to the code" and
three challenges: break block 1 without touching block 2 (Show bytes helps); cover a third of the bytes and still
read (22 bytes, 11 per block, reads: section 0); make it unreadable with the smallest scratch (12 bytes in one block).
Sentence it proves: "A QR code survives damage because it stores more than the message: check bytes that let a reader
work out what is missing."

Step 2 "Bytes, not squares". Demo: a small second canvas (render.js, 6 px modules) of the same code with Show bytes
on, and two buttons "Scratch across" and "Scratch down" that draw a straight 1-module scratch (row 14 or column 15)
and print the result. Numbers (step2.out): across, 20 squares: 12 change, 8 bytes break (5 + 3); down, 20 squares:
10 change, 5 bytes (2 + 3); one square: one byte. Sentence: "The budget is counted in bytes: one scratched square
spoils its whole byte, bytes are tall and thin (2 squares wide, 4 tall), and interleaving deals a long scratch out
between the blocks."

Step 3 "Two numbers make a line" (WIDGETS mountLine). Four points at x = 1, 2, 3, 4; y snaps to whole numbers 0 to
14; message 2, 5 -> line y = 3x - 1 -> sends (1, 2), (2, 5), (3, 8), (4, 11). The first two are the message (solid),
the last two the check points (ring). Drag any point up or down. Decoder: look for a line through at least 3 of the
4 points.
* 0 off: "All four points agree: the message is 2, 5."
* 1 off: "Point 3 is the liar: the only line through three of the points says it should be 8." The fix animates
  (reduced motion: jumps).
* 2 off, no three on a line: "Something is wrong, but I can't tell what: each of these 6 lines fits two points."
  (draw all 6 candidate lines thin).
* 2 off with three on a wrong line (possible on the whole-number grid): "Fooled: three points agree on a different
  line, so I would 'fix' the wrong point and read {a}, {b}." with a link to step 6 (reserve bytes).
Sentence: "Check numbers are not copies: they are extra points on the same line, so one wrong point stands out, and the
decoder can say which one and what it should be. Two extra points can fix one error, and spot (not fix) two."

Step 4 "Bendier curves" (WIDGETS mountCurve). Seven points x = 1 to 7, y whole numbers 0 to 12; message 1, 4, 6 ->
parabola through (1, 1), (2, 4), (3, 6) -> sends 1, 4, 6, 7, 7, 6, 4 (exercises.out). A tap on a point's "?" toggle
marks it as a known gap (erasure). Decoder: among the known points, find the parabola that fits all but at most
floor((known - 3) / 2) of them; the budget line under the plot: "Extra points: 4. Spent: 2 per unknown error + 1 per
known gap = 3 of 4." Any 2 dragged off: recovered. 4 known gaps: recovered. 1 error + 2 gaps: recovered. 3 errors:
"can't be sure" or fooled. Side note in the prose: the same parabola on ordinary numbers is y = -x^2/2 + 9x/2 - 3:
fractions appear even for whole-number messages, which is the reason for step 5.
Sentence: "Every extra point pays for half an unknown error or one known gap: 2 x errors + gaps <= extra points. A code
with 22 check bytes per block can fix 11 unknown errors, or fill 22 known gaps." The hero's erasure toggle proves it.

Step 5 "Arithmetic on a clock" (WIDGETS mountClock). Two parts.
(a) The line game on a 13-hour clock: values 0 to 12, all arithmetic wraps at 13; message 3, 7 -> y = 12 + 4x
(mod 13) -> sends (1, 3), (2, 7), (3, 11), (4, 2). The "line" now wraps (dashed where it wraps), yet the liar
search works exactly as in step 3.
(b) Partners: a 13-hour clock face; tap a number to see its partner (the number that multiplies with it to 1):
1-1, 2-7, 3-9, 4-10, 5-8, 6-11, 12-12 (exercises.out). A switch "12 hours" shows the failure: 2, 3, 4, 6, 8, 9, 10
have no partner; and two different lines (y = 2 + 2x and y = 8 + 8x) pass through the same points (1, 4) and (3, 8),
so the check points cannot pin down the message. On 13 hours only one line does.
Prose: a 256-hour clock fails the same way: 2 x 128 = 256 lands on 0, and 127 of the 255 non-zero numbers have no
partner. QR instead builds a 256-value number system for bytes: adding is XOR (bits flip, no carrying: 0x57 + 0x83
= 0xD4), multiplying follows a fixed rule from the standard, and every byte except 0 has a partner (in it 2 x 128 =
29 and 2 x 142 = 1). It is NOT "mod 256". (P2: a two-byte calculator showing a + b, a x b and the partner of a.)
Sentence: "On a clock with a prime number of hours every number except 0 has a partner, so division always works and
the same lines and curves exist with whole numbers only; QR does the same with a 256-value system built for bytes."

Step 6 "The real budget". A static table generated from section 0 (rendered by app.js from blockLayout, so it can
never disagree with the engine): version, size, level, blocks, check bytes per block, fixable per block, capacity.
Prose: levels L to H (about 7, 15, 25, 30%: the share of bytes, not of area); bigger codes split into blocks so no
block gets too long; the smallest codes keep reserve bytes (1-M: 10 check bytes, the standard promises 4 fixes, not
5) so a scanner can refuse rather than guess wrong, yet many scanners still try 5 (state D; FACTS words it);
the corner squares and the format strip (stored twice) are not data and error correction cannot fix them; why logos
in the middle work (they spend the budget). Buttons "Try this scratch at level L / M / Q / H" set the hero's level
and scroll back to it. Final challenge: "Type your own message, pick H, and find the biggest scratch it survives."
(P2) "The impostor": a prepared 1-L code with a few marker squares, built and proved by ORACLE, that every decoder
we tested reads as a different message; the page shows state G. Only an innocuous text pair, and only if ORACLE
proves it with both decoder families (W/oracle/out/t4_miscorrect.txt already shows crafted 1-L damage read WRONG by
all of them).

## 8. Exercises (static `div.sed-check[data-sed-check]` blocks in index.html, each after its step; answers hidden in
a closed `details`; an input or select plus a "Check" button gives instant feedback; every answer recomputed by
W/proto/exercises.py and by WIDGETS' own script, and the page's check function uses the same arithmetic)

E1 (after step 5) On a 7-hour clock: what is 5 + 4? What is 3 x 4? Which number times 4 gives 1?
   Answers: 2; 5; 2. (exercises.out: "5+4 = 2 | 3x4 = 5 | partner of 4: [2]")
E2 (after step 3) These four points should lie on one straight line, but one was damaged: (1, 5), (2, 7), (3, 10),
   (4, 11). Which point is wrong, and what should it be? Answer: the third; it should be (3, 9). The only three
   points on one line are 1, 2 and 4 (y = 2x + 3); unique (exercises.out).
E3 (after step 4) A block of a bigger code has 15 message bytes and 28 check bytes. (a) How many bytes can be
   damaged anywhere, unknown to the decoder, and still be fixed? (b) If the decoder is told where 6 damaged bytes
   are, how many more unknown ones can it fix on top? Answers: (a) 14; (b) 11, because 2 x 11 + 6 = 28. (Rule
   2e + s <= n - k; this replaces the dossier's "9 and 17" case, whose "17 by the plain rule" collides with the
   1-H reserve byte.)
E4 (after step 2) This page's code alternates its two blocks byte by byte. A long scratch breaks 14 bytes that sit
   one after another in the code's byte order. Does the code still read? What if all 14 broken bytes were in one
   block? Answers: yes, 7 land in each block and each can fix 11; no, 14 is more than 11. (exercises.out: runs from
   20 and 47 both split 7 + 7.)
E5 (after step 5) Why can't bytes use ordinary clock arithmetic with 256 hours? (a) 256 is too big; (b) 2 x 128
   lands on 0, so you could never divide by 2; (c) bytes cannot be added. Answer: (b).
E6 (after step 6) A sticker covers one corner square completely but no byte. Will a phone most likely read the
   code? (a) Yes, error correction repairs it; (b) Probably not: cameras find the code by its corner squares, and
   those are not bytes, so error correction has nothing to repair; (c) Only at level H. Answer: (b), worded
   "Probably not: every scanner we tested gave up when one corner square was covered. Cameras look for the three
   corner squares to find the code, and they are not bytes, so error correction cannot rebuild them. (Some phone
   scanners may still manage from two corners.)" (Measured: 0 of 15 corner cases read; FACTS confirms wording.)

## 9. Explainer outline (section.sed-explainer#explainer; 1,300 to 1,700 words in p/li/figcaption; 9 headings)

h2 "How a scratched code still reads". Opening (80 words): what the visitor just did and the one idea: extra check
bytes, not copies.

h3 "1. What the squares are" (step 1; defines module, the three corner squares (finder patterns), the timing lines,
the small alignment square, the format strip stored twice, the quiet zone, and the data area read 8 squares at a
time: a byte, which the standard calls a codeword). Key sentence: "About two thirds of this code's squares hold
bytes; the rest tell a camera where the code is, how big it is and how to read it." (560 of 841 = 66.6%.)

h3 "2. Bytes, not squares" (step 2; defines block and interleaving). Worked example: the step-2 numbers.
E4 follows.

h3 "3. Check bytes are not copies" (step 3). Copying the message twice shows THAT something is wrong but not which
copy; a line through two points, sent as four points, names the liar. Reed and Solomon described codes built this
way in 1960 (FACTS: J. SIAM 8(2), 300-304). Worked example (IC-11, the widget's one-liar preset): message 3, 5 -> 3, 5, 7, 9; point 3 arrives
as 11; only points 1, 2, 4 lie on a line, so point 3 should be 7. E2 follows.

h3 "4. Bendier curves, more extra points" (step 4; defines erasure: a known gap). The rule 2 x errors + gaps <= extra
points, with the hero's numbers: 22 check bytes per block -> 11 unknown or 22 known. E3 follows.

h3 "5. Arithmetic on a clock" (step 5; defines the 256-value number system). Fractions on ordinary numbers
(y = -x^2/2 + 9x/2 - 3); a 13-hour clock; partners; why 12 and 256 fail; XOR; "not mod 256". E1 and E5 follow.

h3 "6. The real budget" (step 6): the table, levels as share of bytes, reserve bytes, what scanners do (FACTS
wording), corner squares and format strip, logos. E6 follows.

h3 "Why your phone might give up sooner": glare, blur, tilt, small modules, screen moire; scanning tips. One line on
erasures: a camera does not know where the scratches are, so it pays the full price for every one.

h3 "Where QR codes come from": Denso Wave, 1994, for tracking car parts (FACTS: qrcode.com history); ISO/IEC 18004,
fourth edition 2024 (iso.org); patents waived for the standard (qrcode.com); the trademark notice; Reed-Solomon
codes also protect CDs and other media (FACTS picks a non-vendor source or the line goes).

Sources (About panel, verified only, no scanner or label-printer vendors): iso.org ISO/IEC 18004:2024 page;
qrcode.com pages (history, error correction levels, FAQ for the trademark, standardization for the patents);
Reed and Solomon 1960 (J. SIAM; a library or MIT Lincoln Laboratory page); a non-commercial technical reference for
the block table and the worked HELLO WORLD example (thonky.com's QR tutorial or an encyclopedia); the
misdecode-reserve source FACTS verifies. FACTS/FACTS.md is the authority on wording; LEAD folds it in as it lands.

## 10. Load-time self-checks (SITE/selfcheck.js; window.__sedSelfTest returns {cases}; "Check the decoder" in More
shows them; run once after the first frame is painted, in idle time, never blocking the ghost)
 1 HELLO WORLD 1-M data and check codewords equal the published values (section 0).
 2 Format strings for L, M, Q, H with mask 0 equal 0x77C4, 0x5412, 0x355F, 0x1689.
 3 The default message at 3-H: mask 7, per-mask totals equal [1493, 1350, 1448, 1304, 1340, 1386, 1407, 1301],
   stream equals the 70 codewords of section 0 (stored in selfcheck.js, labelled "computed by the lead's independent
   reference encoder, which matches zxingcpp module for module").
 4 Block layout of all 24 version-levels equals the section-0 table (counts, data per block, check bytes, reserve).
 5 Round trip: decodeModules(encode(T).modules) reads T with no errors, at every level.
 6 Picture, clean: render.js paints the clean code to an offscreen canvas (10 px per module, dpr 1); readPixels
   returns modules identical to sym.modules; it decodes to T.
 7 Picture, first frame: the ghost-scratched state painted and read back equals the state modules and reads T with
   9 fixed, 4 in block 1 and 5 in block 2.
 8 Reed-Solomon limit: 11 errors in a 3-H block (fixed seed) are fixed; 12 are refused; never a wrong codeword.
 9 Erasures: 22 erasures in a 3-H block are filled; 23 are refused.
10 Reserve: at 1-M, 5 errors decode with limit 'half' and are refused with limit 'reserve'.
A failing case shows a cross in More and keeps the page working; no console.error (QA counts them).

## 11. File map and module interfaces

SITE (published; LEAD assembles):
* index.html (LEAD, from the shell): head, header, h1, tagline, intro, section.qr-app (static readout skeleton with
  the first frame's final numbers), the explainer with the ladder figures (static mount points `div.qw-mount`), the
  six exercises, the About panel, scripts at the end of main (type=module).
* style.css (LEAD; VISUAL's tokens and component styles folded in), ladder.css (WIDGETS, .qw- prefix).
* app.js (LEAD): state {text, level, strokes[], tool, brush, erasure, showBytes}, input handling (4.1 to 4.3), the
  decode loop, the readout and notes (2.3, 2.4), the ghost animation (3.3), More, step-2 demo, step-6 table, the
  level buttons in step 6, the message field.
* qr.js (ENGINE's W/engine/qr.js, copied verbatim; header comment kept).
* strokes.js (LEAD, 4.5). render.js (VISUAL's W/visual/render.js). ladder.js (WIDGETS). exercises.js (LEAD wiring of
  the check buttons, using WIDGETS' answer arithmetic). selfcheck.js (LEAD, 10).
* project.json, thumb.png (made by browser-check --thumb).
No other files; no fonts; no images except thumb.png. Total well under 300 KB.

Helper deliverables (each with INTEGRATE.md): ENGINE W/engine/qr.js + tests; WIDGETS W/widgets/ladder.js,
ladder.css, exercises.html, the answer script; VISUAL W/visual/DESIGN.md, mock + screenshots, render.js; FACTS
W/facts/FACTS.md (claim, source, verified, safe wording per line of sections 2, 7, 9); ORACLE W/oracle/ proofs
(section 14) and the impostor code (P2).

## 12. Accessibility and mobile
* Keyboard path for every action (4.3); visible focus; the canvas has an aria-label and aria-describedby the
  readout; the readout is aria-live="polite" and announces only at the end of a stroke ("Still reads. 9 broken
  bytes found and fixed. Block 1: 4 of 11. Block 2: 5 of 11.").
* Colour never alone: block colour + pattern + label; broken/fixed outlines dashed vs solid; state words in text.
* Ladder widgets: points are focusable buttons (role slider with aria-valuenow, arrows move by 1, Home/End), the
  decoder's verdict in a live region; touch and mouse drag; reduced motion.
* Reduced motion everywhere (3.3, 5.5).
* 320 px: no horizontal scroll, card 259 px; 390 x 844: code and readout inside the first screen; 1280 x 650: no
  overlap, code top, readout and toolbar on screen. Touch targets >= 44 px.
* Dark mode: the code card stays white (scannable) with the halo; all text uses the shell tokens.

## 13. Risks and the cut order

Risks (with the mitigation built into this spec):
1 The hero's magic hidden in small print (the other cameos' top finding): the readout is big type beside or under
  the code, the meters are graphic, the ghost runs where the eye is.
2 Phones lose the demo: 4.2's touch rule; code and readout inside 390 x 844; tested with touch emulation.
3 An encoder slip kills the phone wow: the reference encoder equals zxingcpp's in 260 of 260; ENGINE's tests hit
  section 6.2; self-checks 1 to 9 on load; ORACLE scans the page's own screenshots; a real iOS and Android scan
  is the publish gate (main session).
4 The renderer's scuff texture or overlays change what a camera sees: the camera rule (5.4) + ORACLE's centre
  sampling and decoding of screenshots in every overlay state.
5 Phones read less than the page (glare, OpenCV-style decoders giving up earlier): honest "may" copy and tips.
6 The 2024 video covers the idea: the interaction carries the page (the breaking-point game, same scratch on four
  levels, the impostor).
7 Explainer too thin or too dense: 1,300 to 1,700 words, every term defined in place, worked examples from scripts.
8 Time (3 to 4 hours for six agents): the cut order below; helpers deliver early stand-ins.
9 Layout shift in the readout: every line reserved; static first-frame numbers.
10 Safety: no lottery imagery; no message in the URL; the wrong text in state G is shown as text, never a link;
  trademark notice; no vendor sources.

Cut order (first cut first): (1) the impostor (step 6 P2); (2) "Same scratch, every level" mini table; (3) the
GF(256) calculator; (4) the 12-hour switch in the clock widget (keep the prose); (5) brush presets (keep Medium,
coarse pointers Wide); (6) the step-2 mini canvas (point to the hero's Show bytes instead); (7) versions 5 and 6
(max version 4: messages up to 50 alphanumeric characters at H); (8) erasure toggle on the hero (keep it in the
curve widget). Never cut: the ghost first frame, the big readout, the meters, "one more breaks it", the camera
notes, Undo/Clean, Show bytes, the touch rule, the three ladder widgets, six exercises, self-checks 1 to 9.

## 14. Acceptance checklist (PHASE 2 is done when every line is true)
Contract and QA
* [ ] `node scripts/validate.mjs project SITE --contract`: ok true, no errors; every warning read and answered.
* [ ] `node scripts/qa/browser-check.mjs SITE --out W/qa-build --contract --thumb --seconds 10`: ok true, no errors;
      warnings none or justified; all eight screenshots (desktop/mobile x light/dark) and thumb.png looked at.
* [ ] First-screen controls = 7 at 1280x800; data-sed-result top <= 300 at 1280x800 and <= 420 at 390x844; the
      whole code and readout inside 390x844 and inside 1280x800; intro bottom <= 420 desktop, <= 560 mobile.
* [ ] Explainer 1,300+ words, 9 headings; six exercises answerable; no term used before it is defined.
* [ ] No console errors or unhandled rejections in desktop/mobile/light/dark and the monkey run; no layout shift
      during the ghost (PerformanceObserver layout-shift total 0).
Engine and picture (ORACLE proves, W/oracle/INTEGRATE.md lists each with its command and output)
* [ ] HELLO WORLD 1-M data and check codewords; L/M/Q/H mask-0 format strings; 24-row block table; capacities.
* [ ] For the same text, version, level and mask, the page's modules equal zxingcpp's encoder (all 260 xcheck cases
      plus 50 random byte-mode texts), and auto mask equals zxingcpp's choice.
* [ ] zxingcpp and OpenCV (both detectors) read the page's own Chromium screenshots of the clean code at every level
      and at versions 1 to 6, in light and dark, desktop and phone sizes.
* [ ] They read the first frame (ghost) screenshot; they read page-made scratches inside the budget (incl. 11 + 11 at
      3-H) and fail past half the check bytes (12 in one 3-H block) as the page predicts, with no wrong reads.
* [ ] The camera rule holds: sampling every module centre on the screenshots equals the page's module state, in
      every overlay state (Show bytes, red, green flash frames, marker, cursor).
* [ ] The camera notes match reality: a corner-square scratch made on the page stops the decoders.
* [ ] Decode < 5 ms at version 6 (median of 200 in Chromium), first paint fast (no long task > 50 ms on load).
Interaction
* [ ] Touch emulation at 390x844: vertical swipe scrolls and changes nothing; sideways drag scratches; hold-then-
      vertical scratches; two fingers never scratch.
* [ ] Keyboard-only: scratch, undo, clean, show bytes, type a message, open More, change level, toggle erasures.
* [ ] Undo after any sequence returns exactly the earlier state; Clean code equals a fresh load minus the ghost.
* [ ] Reduced motion: final first frame at once, no flashes.
Publish gate (main session): a real iOS and a real Android phone read the first frame from a laptop screen, and
both give up after "one more breaks it".

## 15. Decisions for the main session
D1 Ship the self-checks as window.__sedSelfTest on a lesson (10 cases, all must pass)? Recommended yes.
D2 The making-of says the page was checked against "two independent open-source QR decoders reading screenshots of
   this page" (unnamed). DIRECTION says the real decoders are never cited as sources; this is a making-of fact, not
   a source. Keep, or drop the clause?
D3 Step 6's "impostor" (a code every tested decoder reads as a different message): P2 and first to cut. Build it if
   time allows, or skip outright as too clever?
D4 Exercise E3 replaces the dossier's (9 + 17) case with (15 + 28) to avoid the reserve-byte trap. Agree?
D5 Real-phone scan as the publish gate: who does it (the owner or the main session) before 2026-10-20 goes live?
D6 Copy sign-off: title "Scratch a QR Code", tagline and intro of 2.1 (59 words), the six-word instruction kept as
   "Scratch it. Then scan it with your phone." (phones get "...with a second phone, or a friend's.").
D7 (decided, tell me if you disagree) The meters and "one more breaks it" follow what scanners really do (half the
   check bytes, IC-8); the standard's lower promise in 1-L, 1-M and 2-L is shown as a dotted "promised" tick.
