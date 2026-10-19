# FACTS: Scratch a QR Code (cameo 3), the fact base the page is written from

Owner: FACTS agent. Every source was seen on 2026-10-18 (the access date for all entries below).
Scripts and their outputs: W/facts/scripts/ (W = .../cameo/c3/). Re-run any of them with `python3 -I <script>`.

## How to read the verification labels

| Label | Meaning (ops/rubrics/research.md) | Counts as verified? |
|---|---|---|
| **[O]** | Opened: I fetched the page and read the text. From this sandbox only github.com and raw.githubusercontent.com resolve, so every [O] is open-source code or a GitHub page. | yes (a) |
| **[P]** | The primary source on its own official domain, seen as its own search-result entry (qrcode.com, denso-wave.com, denso.com, iso.org, ll.mit.edu, jpl.nasa.gov, support.apple.com, android.com). NOT opened: those hosts fail DNS here (log in section 9). | yes (c) |
| **[2]** | Two independent search-result entries agree (different institutions). | yes (b) |
| **[C]** | Computed by my scripts from a named formula or from the two opened block tables. | an oracle only where the formula comes from a named source |
| **[M]** | Measured on real decoders (zxing-cpp 3.1.1, OpenCV 5.0) by me, matching ORACLE's and LEAD's runs. Evidence for what the page says about scanners. DIRECTION says not to cite these as sources on the page. | evidence, not a citation |
| **[1]** | One search entry only, or a blended summary. | no: keep it off the page or attribute it |

Caveat on [P]: the search tool returns titles, URLs and a summary written by a model. I counted a [P] claim only when
that summary attributed it to the primary page by name. Where a summary blended several entries, I say so.

---------------------------------------------------------------------------------------------------------------------

## 0. The verdicts that change what the page may say (read this if nothing else)

1. **"About 30%" means 30% of the bytes, not of the area, and the budget is per block.** Denso Wave's own
   error-correction page gives the levels as approximately 7, 15, 25 and 30% "for total codewords", with one codeword
   = 8 bits [P]. The real shares in versions 1 to 6 run from 7.7 to 10.5% (L), 15.4 to 18.6% (M), 23.1 to 27.9% (Q)
   and 30.8 to 32.8% (H) [C]. The hero code (3-H) can lose 22 of its 70 bytes, 31.4%: say "nearly a third", not
   "a third" (SPEC 7 step 1).
2. **Corner squares hold no data, yet tiny damage there stops scanners.** One changed dark module in one corner
   square made zxing-cpp fail 11 of 40 times and OpenCV 7 of 40; three modules, 30 and 27 of 40 [M]. Patents
   describe special decoders that cope with one damaged corner square [1], so the page must say **"may"**, never
   "can't".
3. **The format strip HAS its own error correction.** It is a BCH code: 32 valid codes at least 7 bits apart, so a
   reader corrects up to 3 wrong squares per copy, and there are two copies [O][C]. SPEC 7 step 6 says the corner
   squares "and the format strip ... are not data and error correction cannot fix them". That is **false for the
   format strip**. Wording in section 5, S-17.
4. **The reserve bytes: the standard promises less than scanners deliver, at 1-L, 1-M and 2-L only.** The p values
   come from two independent sources [O]. Three of the four open-source decoders I read (ZXing, zxing-cpp, quirc)
   ignore the reserve. ZBar honours it [O]. Phones are closed source. So write **"many scanners"**, never
   "scanners usually" (SPEC 2.3 state D).
5. **No open-source QR scanner uses erasures (known gaps).** ZXing, zxing-cpp, ZBar and quirc all decode errors only
   [O]. Phone makers' scanners are closed, so their behaviour is unknown. A scratched square simply looks light. Say
   "a camera usually can't tell where the scratches are", not "phones never ...".
6. **The curve picture is exact for QR, but only with one adjustment.** QR's encoder divides polynomials; it does
   not evaluate "your message's curve". Every valid QR block is, however, the values of one polynomial of degree
   below k at n fixed points once each position is multiplied by a fixed weight. I checked this for (26,16),
   (35,13), (26,9) and (44,34); without the weights it fails [C]. Teach the curve as the faithful picture. Never say
   "the QR encoder plugs extra x values into your curve".
7. **Bytes are not "2 squares wide, 4 tall" in general.** Only 15 of the 70 bytes in the hero code are neat 2 x 4
   blocks; the rest bend at turns and around patterns [C]. SPEC 7 step 2's sentence must change (S-13).
8. **"Published HELLO WORLD" cannot be verified from here** (thonky.com does not resolve, and the search did not
   surface the page). The standard's own worked example can be: ISO/IEC 18004 Annex I, "01234567" at 1-M. ZXing's
   test file quotes it with that citation [O], and my code reproduces it [C]. Add it, so that "checked against the
   standard's worked examples" (the About text) is literally true.
9. **History wording.** Use "Denso Wave (then a division of Denso) released it in 1994" [P]. Use "Masahiro Hara and
   his team" [P] (a Denso US page also credits Motoaki Watabe). The code was made to keep track of car parts in
   factories (kanban) [P].
10. **Byte mode:** "58 other characters" (SPEC 4.4) is true only for one-byte characters: UTF-8 accents take 2 bytes
    and emoji 4 [C]. "What phones read by default" (SPEC 6.1) is unverified; ZXing guesses the character set when
    there is no ECI marker [O].
11. **iPhone with plain text:** Apple documents only "tap the notification ... to go to the relevant website or app"
    [P]. What the banner shows for plain text is not documented, so don't promise it.
12. **Sources:** the primary sites (qrcode.com, iso.org, MIT LL, JPL) were seen only as search entries on their own
    domains. That is verified by rule (c), but not opened. Don't list thonky.com, or any scanner or label-printer
    vendor, as a verified source.

---------------------------------------------------------------------------------------------------------------------

## 1. Claims the page is likely to make

### A. History, standard, legal

| # | Claim | Verdict | Best source (title, URL) and how seen | Safe wording on the page |
|---|---|---|---|---|
| A1 | QR stands for Quick Response | true | Denso Wave, "QR Code development story", https://www.denso-wave.com/en/technology/vol1.html, with Denso's own pages [P]: the name reflects the design goal of high-speed reading | "QR stands for Quick Response: it was designed to be read fast." |
| A2 | Developed in 1994 by Denso Wave | true with wording | Denso Wave, "History of QR Code", https://www.qrcode.com/en/history/ [P]: "In 1994, DENSO WAVE (then a division of DENSO CORPORATION) announced the release of its QR Code"; a Denso page: developed by "DENSO's applied equipment engineering section (currently DENSO WAVE)" [P]. One Denso profile dates Denso Wave's spin-off to 2001 [1] (don't print that year) | "Denso Wave, then a division of the Japanese company Denso, released the QR code in 1994." |
| A3 | Invented by Masahiro Hara | true with wording | Denso, "Believing in a Faint Light: Obstacles QR Code developer overcame...", https://www.denso.com/global/en/driven-base/career-life/qr-hara_2408/ [P]; a Denso US page, https://www.denso.com/us-ca/en/business/business-field/qr-code/, credits Hara together with Motoaki Watabe [P] | "Masahiro Hara and his team at Denso designed it." (not "Hara alone") |
| A4 | It was made for car parts | true with wording | Denso pages [P]: the code grew out of the need to carry more information on the kanban cards of car-parts production (Toyota Production System); qrcode.com history [P]: the car industry adopted it for electronic kanban | "...to keep track of parts in car factories." |
| A5 | The 1:1:3:1:1 corner pattern was chosen because it rarely appears in print | true | qrcode.com history [P]; Denso [P]: square markers were the pattern least likely to appear on business forms | "Its makers picked the corner squares' stripes because that pattern almost never turns up in ordinary printing." |
| A6 | The standard is ISO/IEC 18004:2024 | true | ISO, "ISO/IEC 18004:2024 Information technology - Automatic identification and data capture techniques - QR code bar code symbology specification", https://www.iso.org/standard/83389.html [P]: edition 4, published 2024-08, replaces ISO/IEC 18004:2015 (now withdrawn, https://www.iso.org/standard/62021.html). A working draft of the next edition exists, https://www.iso.org/standard/94137.html [P] | "The rules are set by the international standard ISO/IEC 18004 (fourth edition, 2024)." (Avoid "latest" or "current forever": a fifth edition is in preparation.) |
| A7 | "QR Code" is a trademark; Denso Wave asks for a notice | true | Denso Wave, "FAQ", https://www.qrcode.com/en/faq.html [P]: the word "QR Code" is a registered trademark of DENSO WAVE INCORPORATED in Japan and other countries. It covers the word, not the pattern. When the word is used in publications or on web pages, the FAQ asks for a sentence saying so; no notice is needed when only the code image is used | About panel (and project.json makingOf): "QR Code is a registered trademark of DENSO WAVE INCORPORATED." The title uses the word, so the notice is needed. (The summary did not show the FAQ's exact sentence; this one states exactly what it asks for.) |
| A8 | The patent is not enforced for standard codes | true with wording | Denso Wave, "About the patent", https://www.qrcode.com/en/patent.html, and the FAQ [P]: Denso Wave keeps its patent rights but declared it would not exercise them for codes that follow the JIS or ISO standards; anyone making codes that depart from the standard should contact it first | "Denso Wave chose not to enforce its patent on codes that follow the standard, so anyone may make them." Don't say "the patent expired" or "public domain" (not verified). |

### B. What the squares are

| # | Claim | Verdict | Best source and how seen | Safe wording |
|---|---|---|---|---|
| B1 | 40 versions, 21 x 21 to 177 x 177 modules, +4 per side per version | true | Denso Wave, "QR Code Standardization", https://www.qrcode.com/en/about/standards.html [P] ("21 x 21 modules to 177 x 177 modules"); Nayuki, qrcodegen.py, https://github.com/nayuki/QR-Code-generator/blob/master/python/qrcodegen.py [O] (size = version x 4 + 17) | "The squares are called modules. QR codes come in 40 sizes (versions), from 21 x 21 modules to 177 x 177; each version adds 4 to each side." |
| B2 | Three corner squares (finder patterns), 7 x 7, with runs of 1:1:3:1:1 on any line through the centre; used to find and orient the code | true | ZXing, FinderPatternFinder.java, https://github.com/zxing/zxing/blob/master/core/src/main/java/com/google/zxing/qrcode/detector/FinderPatternFinder.java [O] ("the square markers at three corners"; "1:1:3:1:1 ratio"); quirc, identify.c, https://github.com/dlbeer/quirc/blob/master/lib/identify.c [O] (check {1, 1, 3, 1, 1}); Denso Wave, "What is a QR Code?", https://www.denso-wave.com/en/adcd/fundamental/2dcode/qrc/index.html [P] (they give position, size and angle, so the code reads from any direction) | "The three big corner squares (finder patterns) are 7 x 7 bull's-eyes. Any line through the middle of one crosses dark, light, dark-dark-dark, light, dark, widths 1:1:3:1:1, at any angle. That is how a camera finds the code and tells which way up it is." |
| B3 | The corner squares carry no data | true | Nayuki qrcodegen.py [O] (function patterns are drawn first; codewords fill only non-function modules; the mask never touches function modules); [C] at 3-H, 274 of 841 modules are fixed patterns (192 finder plus separator, 26 timing, 25 alignment, 30 format, 1 dark module), 560 carry the 70 bytes and 7 carry nothing (matches SPEC 0) | "The corner squares hold no part of your message. Scratching one loses no data, but it can stop a camera from finding the code." |
| B4 | Timing patterns: dotted row and column between the corner squares | true | Nayuki [O] ("Draw horizontal and vertical timing patterns"); quirc identify.c [O] ("Check the timing pattern by measuring grid size") | "Two dotted lines (timing patterns) run between the corner squares; scanners use them to count rows and columns." |
| B5 | Alignment pattern: none in version 1; versions 2 to 6 have one, a 5 x 5 bull's-eye near the bottom-right | true | ZXing, Version.java, https://github.com/zxing/zxing/blob/master/core/src/main/java/com/google/zxing/qrcode/decoder/Version.java [O] (centres: v1 none, v2 6/18, v3 6/22, v4 6/26, v5 6/30, v6 6/34; only the (last, last) one is drawn below v7); quirc [O] ("On V2+ grids, we should use the alignment pattern") | "From version 2 on, a smaller bull's-eye near the bottom-right corner (an alignment pattern) helps the scanner straighten a tilted photo." |
| B6 | Format information: 15 bits (2 for the level, 3 for the mask, 10 check bits), stored twice, readable with up to 3 wrong bits per copy | true | ZXing, FormatInformation.java, https://github.com/zxing/zxing/blob/master/core/src/main/java/com/google/zxing/qrcode/decoder/FormatInformation.java [O] (32-row table "See ISO 18004:2006, Annex C, Table C.1"; Hamming distance 7, "<= 3 bits differing means we found a match"; reads both copies); Nayuki [O] ("Draw first copy", "Draw second copy", BCH generator 0x537, XOR 0x5412); quirc decode.c [O] ("try both locations"); [C] minimum distance 7 | "A 15-square label, stored twice (the format information), says which level and which mask were used. It has its own small error correction: a scanner can put right up to 3 wrong squares in a copy, and it has the spare copy." |
| B7 | Masks: 8 fixed patterns; the encoder flips the data area with one of them to avoid patterns that confuse scanners, keeps the lowest-penalty one, and records it in the format bits | true | ZXing, MaskUtil.java, https://github.com/zxing/zxing/blob/master/core/src/main/java/com/google/zxing/qrcode/encoder/MaskUtil.java [O] (rules: long runs of one colour, 2 x 2 blocks, 1:1:3:1:1:4 finder look-alikes, dark share far from 50%; weights 3, 3, 40, 10); Nayuki [O] (same weights; "XORs the codeword modules"; automatic choice = lowest score) | "Before the code is drawn, its data squares are flipped by one of eight fixed patterns (masks), chosen to avoid big blotches of one colour and stray look-alikes of the corner squares. The format label tells the scanner which mask to undo." |
| B8 | A byte (codeword) is 8 modules; the code is corrected byte by byte | true | qrcode.com, "Error correction feature", https://www.qrcode.com/en/about/error_correction.html [P] (the rate counts total codewords; one codeword = 8 bits); ZXing Decoder.java [O] (corrects codeword arrays per block) | "The code is read in bytes: groups of 8 modules, each a number from 0 to 255 (the standard calls them codewords)." |
| B9 | Byte shape | true with wording | Nayuki _draw_codewords [O] (a zigzag two columns wide, starting bottom-right, skipping the timing column); [C] at 3-H, 15 of 70 bytes are neat 2 x 4 rectangles | "Each byte is 8 modules along a zigzag path two modules wide: where the path runs straight a byte is a 2 x 4 block; where it turns or meets a pattern, it bends." FALSE: "bytes are 2 wide and 4 tall". |
| B10 | Leftover squares | true | [C] from Nayuki's raw-module formula: version 1 holds exactly 26 x 8 bits; versions 2 to 6 have 7 remainder modules in no byte | Optional: "Versions 2 to 6 even have 7 spare modules that carry nothing." |
| B11 | Quiet zone of 4 modules | true with wording | ZXing, QRCodeWriter.java [O] (QUIET_ZONE_SIZE = 4); the zxing-cpp renderer's default is 4 [C]; an arXiv paper (2510.17175) and a patent both say "at least 4 modules" [2]. The standard's own text was not opened | "...a white margin four modules wide (the quiet zone), which scanners need." |
| B12 | One always-dark module | true | Nayuki [O] (8, size - 8) "Always dark" | Optional; not data. |

### C. Levels and budgets

| # | Claim | Verdict | Best source and how seen | Safe wording |
|---|---|---|---|---|
| C1 | Levels L, M, Q, H restore about 7, 15, 25, 30% | true with wording ("about", "of bytes") | qrcode.com error correction [P] ("Approx." 7/15/25/30% of codewords); ZXing ErrorCorrectionLevel.java [O] ("See ISO 18004:2006, 6.5.1"; "L = ~7% correction" ... "H = ~30% correction"); Nayuki [O] ("tolerate about 7% erroneous codewords" etc.). Three independent statements | "Four levels: L can repair about 7% of the bytes, M about 15%, Q about 25% and H about 30%." |
| C2 | The percentages count codewords, not area | true | qrcode.com footnote [P] | "These shares count bytes, not area." |
| C3 | Exact shares in versions 1 to 6 | true | [C] section 3 table | "This code (version 3, level H) can repair 22 of its 70 bytes, 31%: nearly a third." |
| C4 | Higher levels need bigger codes; M is the most common choice | true | qrcode.com error correction [P] (raising the level adds data and size; Level M is the most frequently selected; Q or H for dirty settings) | "Check bytes take room: at level H this message needs a 29 x 29 code; at L, M or Q it fits in 25 x 25." [C] |
| C5 | Bigger codes split their bytes into blocks; each block has its own budget; one block over budget fails the whole read | true | ZXing Decoder.java [O] (correctErrors per block; any block's ChecksumException fails the decode); ZXing Version.java and Nayuki [O] (block tables); [M] 3-H 12 + 0 fails, 11 + 11 reads | "Each block has its own budget. If one block has more broken bytes than it can fix, the code fails, however healthy the other blocks are." |
| C6 | Interleaving deals the blocks' bytes out in turn | true | Nayuki and ZXing placement code [O]; [C] at 3-H, block 1 = even stream positions and block 2 = odd; a full-width line along row 14 touches 14 bytes, 7 in each block; a 3-wide diagonal band touches 8 + 8. Purpose (bursts): CD lecture notes, e.g. Hulpke (Colorado State), https://www.math.colostate.edu/~hulpke/lectures/m366/reedsolomon.pdf [2] | "The bytes of the two blocks are dealt out in turn, like cards, so one long scratch is shared between them." |
| C7 | Reserve (misdecode-protection) codewords p in versions 1 to 3 | true | ZBar, qrdec.c, https://github.com/mchehab/zbar/blob/master/zbar/qrcode/qrdec.c [O]: "For version 1 symbols and version 2-L and 3-L symbols, we aren't allowed to use all the parity bytes for correction. They are instead used to improve detection. Version 1-L reserves 3 parity bytes for detection. Versions 1-M and 2-L reserve 2..."; go-qr PR #150, https://github.com/piglig/go-qr/pull/150 [O], quoting ISO/IEC 18004 Table 9: 1-L 3, 1-M 2, 1-Q 1, 1-H 1, 2-L 2, 3-L 1; readers that follow the standard correct no more than (ec - p)/2. All other version-levels have p = 0 | "The smallest codes keep a few check bytes back to catch mistakes, so the standard promises fewer repairs there: 2 instead of 3 in a version-1 L code, 4 instead of 5 at 1-M and 2-L." Why: "so a scanner refuses more often instead of guessing wrong". |
| C8 | Guaranteed budget floor((ec - p)/2) differs from floor(ec/2) only at 1-L, 1-M and 2-L | true | [C] (1-Q, 1-H and 3-L have p = 1 but an odd ec, so the floor is the same) | As SPEC IC-8. |
| C9 | Erasures: 2e + s <= n - k | true | "An Introduction to Reed-Solomon Codes" (ECEN 604 course notes), https://pfister.ee.duke.edu/courses/ecen604/rspoly.pdf [2] (s + 2t <= n - k); T. Mateer, "Efficient algorithms for decoding Reed-Solomon codes with erasures" (Clemson), https://mthsc.clemson.edu/misc/MAM_2014/bmj9b.pdf [2] (2t + e <= n - k); zxing-cpp, librscpp/decode.h, https://github.com/zxing-cpp/zxing-cpp/blob/master/core/src/librscpp/decode.h [O] ("if (2 * numErrors + numErasures > numECC) return {};") | "Every unknown broken byte costs two check bytes; a byte whose position the decoder is told costs one." The intuition "one to find where, one to find what" is fine as a memory aid, not as the mechanism. |
| C10 | Spend every check byte on gaps and nothing is left to catch a mistake | true | Logic plus [C] (with s = n - k no syndrome is left; 3 known points always fit some parabola); zxing-cpp ReedSolomon.cpp [O]: its erasure overload refuses more than numECC - 2 erasures, because fewer than 2 spare parity symbols could not even detect errors (it cites ISO/IEC 24728, 5.7.2) | "Spend every check byte on known gaps and nothing is left over to catch a mistake." |

### D. The Reed-Solomon idea

| # | Claim | Verdict | Best source and how seen | Safe wording |
|---|---|---|---|---|
| D1 | Reed and Solomon, 1960 | true | Irving Reed and Gustave Solomon, "Polynomial Codes Over Certain Finite Fields", Journal of the Society for Industrial and Applied Mathematics 8(2), 300-304, June 1960, JSTOR stable 2098968: a scan hosted at Rutgers, https://sites.math.rutgers.edu/~zeilberg/akherim/reed.pdf [2], and B. Cipra, "The Ubiquitous Reed-Solomon Codes" (SIAM News, 1993), mirrored at https://vt100.net/shuford/terminal/reed_solomon_codes.html [2]; MIT Lincoln Laboratory, "Empowering Digital Communications", https://www.ll.mit.edu/impact/empowering-digital-communications [P] (a five-page 1960 paper by Irving Reed and Gustave Solomon of Lincoln Laboratory) | "Irving Reed and Gustave Solomon, two researchers at MIT Lincoln Laboratory, published the idea in 1960 in a five-page paper, 'Polynomial Codes Over Certain Finite Fields'." (Print no middle initials: not seen.) |
| D2 | Check bytes are not copies | true (logic) | qrcode.com [P] (QR's error correction is Reed-Solomon coding) | "Keeping two copies would show that something changed, but not which copy is right, and it would double the size." |
| D3 | Message = points on a curve; check bytes = more points on the same curve | true with wording | Evaluation view: University at Buffalo lecture 12, https://cse.buffalo.edu/faculty/atri/courses/coding-theory/lectures/lect12.pdf, and Berkeley lecture 5 notes, https://people.eecs.berkeley.edu/~venkatg/teaching/ECC-fall22/scribes/lecture05.pdf [2]. Generator view (what QR encoders compute): Hulpke (Colorado State) [2]; ZXing and Nayuki encoders [O]. They are the same code up to fixed weights per position ("generalized Reed-Solomon"): J. Hall, "Generalized Reed-Solomon Codes" (MSU notes), https://users.math.msu.edu/users/halljo/classes/codenotes/grs.pdf [1], and my test [C] | "This curve picture is exact for QR codes, with one technical tweak (each position is scaled by a fixed number). Real encoders work out the extra points with a shortcut: dividing one polynomial by another." Reed and Solomon described their 1960 code this way ("based on sampling points on a polynomial", [2]). |
| D4 | k numbers fix a curve of degree k - 1, and any k points pin it down | true | Duke scribe notes, https://courses.cs.duke.edu/spring10/cps296.3/rs_scribe.pdf, and the Berkeley notes [2] (Lagrange interpolation) | "Two points fix a line, three fix a parabola: k numbers make a curve that any k of its points pin down." |
| D5 | Real decoders use algebra, not trial | true | ZXing ReedSolomonDecoder.java, https://github.com/zxing/zxing/blob/master/core/src/main/java/com/google/zxing/common/reedsolomon/ReedSolomonDecoder.java [O] (Euclidean algorithm, Chien search, Forney); zxing-cpp librscpp [O] (Sugiyama/Euclid, root search, Forney); quirc decode.c [O] (Berlekamp-Massey) | "Real scanners don't try every curve: some clever algebra (for example the Berlekamp-Massey method) finds the broken bytes directly." |

### E. The 256-value number system

| # | Claim | Verdict | Best source and how seen | Safe wording |
|---|---|---|---|---|
| E1 | QR uses GF(2^8) built from x^8 + x^4 + x^3 + x^2 + 1 (0x11D, 285) | true | ZXing GenericGF.java, https://github.com/zxing/zxing/blob/master/core/src/main/java/com/google/zxing/common/reedsolomon/GenericGF.java [O] (QR_CODE_FIELD_256 = new GenericGF(0b100011101, 256, 0) // x^8 + x^4 + x^3 + x^2 + 1); quirc decode.c [O] ("Generator polynomial for GF(2^8) is x^8 + x^4 + x^3 + x^2 + 1"); Nayuki [O] (reduces by 0x11D) | "QR uses a number system with exactly 256 values, one per byte (mathematicians call it the finite field GF(256)). Its multiplication follows a fixed rule from the standard, built on x^8 + x^4 + x^3 + x^2 + 1." |
| E2 | It is not "mod 256" | true | [C]: on a 256-hour clock 2 x 128 = 0, 127 of the 255 non-zero values have no partner, and there are 769 zero-product pairs; in QR's system 2 x 128 = 29, every non-zero value has a partner (2 x 142 = 1), and there are no zero products | "It is not clock arithmetic with 256 hours: there 2 x 128 lands on 0 and you could never divide by 2. In QR's system 2 x 128 = 29, and every number except 0 has a partner that multiplies to 1 (2 x 142 = 1)." |
| E3 | Adding is XOR; adding and subtracting are the same | true | ZXing GenericGF.addOrSubtract [O]: "Implements both addition and subtraction -- they are the same in GF(size)", return a ^ b; [C] 87 + 131 = 212 (0x57 + 0x83 = 0xD4); x + x = 0 | "To add two bytes, compare their bits and keep a 1 wherever they differ (XOR): no carrying. Every number plus itself is 0." |
| E4 | Other barcodes use other rules | true | ZXing GenericGF [O]: Data Matrix uses x^8 + x^5 + x^3 + x^2 + 1 (0x12D) | Optional: "The rule is a choice: Data Matrix codes use a different one." |
| E5 | On a prime-hour clock every non-zero number has a partner | true | standard number theory; [C] 13 hours: 1-1, 2-7, 3-9, 4-10, 5-8, 6-11, 12-12; 12 hours: 2, 3, 4, 6, 8, 9, 10 have none | As SPEC 7 step 5. |

### F. Scanners and phones

| # | Claim | Verdict | Best source and how seen | Safe wording |
|---|---|---|---|---|
| F1 | Common scanners treat damage as unknown errors (no erasures) | true for the open-source scanners I read; unknown for phone makers' own | ZXing Decoder.java, https://github.com/zxing/zxing/blob/master/core/src/main/java/com/google/zxing/qrcode/decoder/Decoder.java [O] (decodeWithECCount(codewords, ecCount): no erasure input); zxing-cpp QRDecoder.cpp, https://github.com/zxing-cpp/zxing-cpp/blob/master/core/src/qrcode/QRDecoder.cpp [O] (ReedSolomonDecode(RSField::QRCode, codewords, ecCount): its library accepts erasures, the QR decoder passes none); ZBar qrdec.c [O] (rs_correct(..., NULL, 0)); quirc decode.c, https://github.com/dlbeer/quirc/blob/master/lib/decode.c [O] (no erasure input). OpenCV's QR reader hands the bits to quirc when built with it, and otherwise to its own decoder, https://github.com/opencv/opencv/blob/4.x/modules/objdetect/src/qrcode.cpp [O] (the 4.x source; the 5.0 build used here was not read). Apple's and Google's camera scanners are closed: not known | "The open-source scanners whose code we read treat every scratch as an unknown error. A camera usually can't tell where the scratches are, because a scratched square just looks light, so it pays two check bytes for each one." |
| F2 | Scanners try floor(ec/2) and ignore the reserve | true for zxing-cpp, OpenCV, ZXing, quirc; false for ZBar | ZXing ReedSolomonDecoder [O] (no cap below twoS/2); zxing-cpp librscpp [O] (only 2e + s <= numECC); quirc [O] (no cap; a final syndrome check); ZBar [O] applies p. [M] zxing-cpp and OpenCV fix 3 at 1-L, 5 at 1-M, 5 at 2-L and 8 at 1-H, and fail one past (40 of 40 each; ORACLE: all 24 version-levels) | "The standard only promises 2 repairs in the smallest L code, but many scanners still fix 3 (a few stop at 2)." |
| F3 | One past the limit fails | true | [M] 3-H: 11 + 11 read 30/30, 12 in one block 0/30, both decoders | "One more broken byte in block 2 breaks it." / "A phone should give up here too." |
| F4 | A scanner can read a WRONG message | true, rare | [C] sphere-count estimate per beyond-limit read: about 6e-7 at 1-L and 1e-6 at 2-L without the reserve, 3e-10 and 5e-10 with it, 1e-18 at 3-H (section 3.7); ORACLE built crafted cases that every decoder misreads, and found zxing-cpp reading nonsense when both format copies are wiped on mask-0 6-H/6-Q/4-Q codes | "Very rarely, damage past the limit makes a code look like a different message with a smaller scratch, and a scanner reads that instead. Small codes keep reserve bytes to make this rarer." |
| F5 | Corner-square damage stops cameras | true with "may" | [M] one random dark module in one corner square: zxing-cpp 29/40 read, OpenCV 33/40; 2: 21 and 23; 3: 10 and 13; 8: 3 and 0; a whole corner square, its centre or one edge row: 0 (also LEAD 15/15 fail, ORACLE); Denso Wave [P]: the corner squares are what let a reader find the code. Patents describe decoders that tolerate one damaged corner square [1] | "A phone may not find this code now: cameras spot a code by its three corner squares, and you scratched one." (SPEC 2.4 item 1 is right.) |
| F6 | Format damage | true with wording | [M] up to 3 flipped bits in one copy: both read 30/30. 4 to 7 in copy A only: zxing-cpp 30/30, OpenCV 11 to 15 of 30. 4 or 6 in copy B only (A intact): zxing-cpp 30/30, OpenCV 19 and 13 of 30. 3 in each copy: zxing-cpp 9/30, OpenCV 30/30. 4 in each: 1/30 and 0/30 | Both copies badly hit: "a phone may not read this code any more, or may even misread it" (SPEC is right). One copy hit: "most scanners can still use the spare copy" (add "most"). |
| F7 | Timing lines matter to some scanners | true | [M] horizontal timing row wiped: zxing-cpp reads, OpenCV fails (also ORACLE: one module is enough for OpenCV) | "Some scanners count squares with it, so a phone may struggle." (SPEC is right.) |
| F8 | Alignment pattern | true with wording | [M] wiped on a flat render: both read; ORACLE: with blur and tilt, OpenCV's Aruco detector drops to 1 or 2 of 10 | "It matters most when the photo is tilted." |
| F9 | iPhone camera | true with wording; plain-text behaviour unverified | Apple Support, "Scan a QR code with your iPhone or iPad", https://support.apple.com/en-us/102680, and the iPhone User Guide, https://support.apple.com/guide/iphone/scan-a-qr-code-iphe8bda8762/ios [P]: open Camera, frame the code (it is detected and highlighted automatically), "Tap the notification that appears on the bottom of the screen to go to the relevant website or app"; or use the Code Scanner control in Control Center. Apple does not document what a plain-text code shows | "Open your phone's camera and point it at the code: when it reads it, a small notice appears; tap it to see what it found." Don't promise "it shows the text" or "it searches the web". |
| F10 | Android camera | true with wording | Android, "How do you scan QR codes on Android?", https://www.android.com/articles/how-do-you-scan-qr-codes-on-android/ [P]: Android 14 and later have a "Scan QR code" Quick Settings tile, and "the information encoded in it will be displayed on your screen"; Pixel camera "shows a bubble or link" | Same wording as F9 works for both. |
| F11 | Screens are harder to scan than paper (glare, moire, blur) | a tip, not a sourced fact | ORACLE/LEAD measurements; no source | Keep tips as advice: "Turn the brightness up; try holding the phone about 20 to 40 cm away." |

### G. Where else Reed-Solomon is used (pick from these only)

| # | Claim | Verdict | Best source and how seen | Safe wording |
|---|---|---|---|---|
| G1 | CDs and DVDs | true | MIT Lincoln Laboratory page [P] (deep space, CDs and DVDs, QR codes, HDTV); "Introduction to Coding Theory, CMU Spring 2010" lecture 5, https://people.csail.mit.edu/dmoshkov/courses/codes/lec5-venkat [2] ("extensively used in storage devices like CDs, DVDs, and hard-drives") | "CDs and DVDs use Reed-Solomon codes too." |
| G2 | A CD layers two cross-interleaved codes, (32,28) and (28,24), and the second treats the first's failures as known gaps | true with wording; blended summary | UC Irvine slides (M. Keti), https://www.math.uci.edu/~mketi/research/advancementsummary.pdf, plus a patent [1, blended] | Use only if wanted, and only attributed: "A CD player even uses known gaps: its first decoder flags bytes it couldn't fix, and its second treats them as gaps." I'd skip it. |
| G3 | Voyager | true with wording | JPL, "Two Voyagers Taught Us How to Listen to Space", https://www.jpl.nasa.gov/news/two-voyagers-taught-us-how-to-listen-to-space/ [P] (the Voyagers were the first spacecraft to use the Reed-Solomon code); R. Ludwig and J. Taylor, "Voyager Telecommunications" (JPL DESCANSO), https://descanso.jpl.nasa.gov/monograph/series13/DeepCommo_Chapter3--141029.pdf [P] (upgraded in flight to concatenated Reed-Solomon and convolutional coding) | "NASA's two Voyager probes were the first spacecraft to use a Reed-Solomon code, added to their radio link after launch." |
| G4 | Deep space: a (255, 223) code fixes up to 16 byte errors | true | JPL IPN Progress Report 42-89, "A VLSI Single Chip (255, 223) Reed-Solomon Encoder With Interleaver", https://ipnpr.jpl.nasa.gov/progress_report/42-89/89D.html [P, blended] (adopted by ESA, NASA and JPL; 8-bit symbols; up to 16 symbol errors); [C] (255 - 223)/2 = 16; MIT LL [P] (still used for deep-space links) | "A common deep-space code sends 32 check bytes with every 223 message bytes and can fix 16 wrong ones." Also a good NEW-case exercise. |
| G5 | RAID 6 disk arrays | true | Linux kernel [O]: Documentation/driver-api/dmaengine/provider.rst ("RAID6 P+Q computations, P being a simple XOR, and Q being a Reed-Solomon algorithm", seen as a GitHub code-search fragment of the file); lib/raid/raid6/recov.c, https://github.com/torvalds/linux/blob/master/lib/raid/raid6/recov.c ("RAID-6 data recovery in dual failure mode", "Recover two failed data blocks"); lib/raid/raid6/mktables.c, https://github.com/torvalds/linux/blob/master/lib/raid/raid6/mktables.c (multiplication reduces by 0x1d, i.e. the same 0x11D field as QR) | "Disk arrays called RAID 6 keep two check disks so they can rebuild any two dead disks; Linux works one of them out with a Reed-Solomon sum in the same 256-value number system QR uses. A dead disk is a known gap, so two check disks cover two." A perfect known-gap example. |
| G6 | HDTV broadcasts | single primary mention | MIT LL [P] only | Only attributed ("MIT Lincoln Laboratory lists HDTV broadcasts too"), or skip. |
| G7 | DSL | unverified | not sourced here | Don't use. |

### H. Logos (only if the page mentions them; the judges cut the logo demo)

| # | Claim | Verdict | Source | Safe wording |
|---|---|---|---|---|
| H1 | A logo in the middle relies on error correction | true with wording (a direct consequence the page demonstrates; no external source needed) | the page's own decoder with the Marker; Denso Wave [P] cautions that data may be impossible to recover, depending on the degree of stain or damage | "A logo pasted over the middle is damage like any scratch: the scanner repairs those bytes from the check bytes, which leaves less budget for real wear." Give no "safe logo size" percentage, don't send readers to vendor advice, and don't claim every logo code works this way. |

---------------------------------------------------------------------------------------------------------------------

## 2. Hazards: overstatements and myths, with the true version

| Myth or overstatement | Why it's wrong | Say instead |
|---|---|---|
| "Scratch off 30% (or a quarter) of it and it still works" | 30% is a share of bytes, at level H only, per block, and the corner squares and format strip are outside it | "a big chunk"; "nearly a third of its bytes (22 of 70)" |
| "Any 30% can go" | Each block has its own budget (12 broken bytes in one 3-H block fail even if the other block is clean); bytes are not area | "as long as no block gets more than its share" |
| "30% of the area / picture / modules" | Denso's footnote: total codewords. Patents and help pages blur this | "30% of the bytes" |
| "Many people believe any 30% can be covered" | No non-vendor document of that belief was found | Ask it as a question the page answers ("Can any 30% go? No..."), not as a documented misconception |
| "The corner squares hold data" | They are signposts (function patterns) | "hold no part of your message, but a camera needs them" |
| "Error correction can't fix the format strip" | The format strip has its own BCH code (3 bits per copy) and a spare copy | see S-17 |
| "Check bytes are copies / backups" | They are computed from the whole message | "extra numbers worked out from the message" |
| "mod 256" / "a 256-hour clock" | GF(256) with 0x11D; 2 x 128 = 29, not 0 | E2 wording |
| "Adding bytes is ordinary addition" | It is XOR, with no carries | E3 wording |
| "Phones always read it" / "your phone reads it until the page says it breaks" | Phones are closed; screens add glare and blur; corner damage stops them | "should", "may", "a phone may give up a little before this page does" |
| "Scanners use the standard's budget" | Three of four open-source decoders try half the check bytes; ZBar keeps the reserve | "many scanners still try 3" |
| "Scanners know where the scratches are" | No open-source QR scanner passes erasures | F1 wording |
| "Past the limit a scanner always gives up" | Nearly always; a wrong read is possible (rare by chance; can be crafted; wiped format copies can mislead zxing-cpp) | F4 wording |
| "One scratched square costs one square" | One CHANGED module spoils a whole byte; a scratch over light modules (or the Marker over dark ones) changes nothing | "one changed square spoils its whole byte" |
| "Bytes are 2 x 4 blocks" | Only 15 of 70 at 3-H | B9 wording |
| "The decoder tries all curves" | Algebra finds them | D5 wording |
| "QR's encoder evaluates your message's curve at more points" | It divides polynomials; the same code up to fixed weights | D3 wording |
| "Telling the decoder where the scratches are doubles the budget for free" | It doubles it, but spending all of it leaves nothing to catch a mistake | C10 wording |
| "Two extra points can spot two errors" (in fixing mode) | A decoder that fixes one error can be fooled by two (SPEC's own "Fooled" state) | "can usually only tell something is wrong, and now and then is fooled" |
| "Invented by Denso Wave in 1994" / "invented by Masahiro Hara" | Denso's division (now Denso Wave); Hara and his team | A2, A3 wording |
| "QR = Quick Read" | It is Quick Response | A1 |
| "ISO/IEC 18004:2015 is the standard" | 2024, fourth edition (2015 withdrawn) | A6 |
| "The QR patent expired" / "public domain" | Not verified; Denso Wave says it does not exercise its patent for standard codes; the word is a trademark | A7, A8 |
| "Voyager launched with Reed-Solomon" | Added in flight | G3 |
| "Reed-Solomon runs DSL, HDTV, every barcode..." | Only CDs, DVDs, deep space, RAID 6 and QR are sourced here | section G |
| "Phones read UTF-8 by default" / "58 characters" in byte mode | Unverified for phones; ZXing guesses the character set; UTF-8 accents are 2 bytes, emoji 4 | S-9, S-10 |
| "The level percentages are exact" | Approximate; the real share varies by version | C3 |
| "Logos are safe up to 30% of the area" | Vendor folklore; covering modules spends the budget | H1 |
| "No one has explained this before" | A widely seen 2024 video did (section 8) | Let the interaction be the difference; make no novelty claim |
| "The phone looks the code up online" | The text is in the squares; nothing about phones' network use is verified | Say nothing about phones and the internet |

---------------------------------------------------------------------------------------------------------------------

## 3. The numbers the page will show (cross-checked)

### 3.1 Versions 1 to 6, levels L, M, Q, H

Sources: (1) ZXing Version.java [O] (ECB counts, data per block, check bytes per block; comments cite ISO 18004:2006
Annex D and Table 9). (2) Nayuki qrcodegen.py [O] (ECC codewords per block, number of blocks, and the raw-module
formula from which totals and remainder bits follow). They were written independently. Reserve p: ZBar [O] and the
go-qr PR [O]. Capacities: computed from the data codewords with the mode-header rule (4 mode bits; a 9-bit
alphanumeric or 8-bit byte count for versions 1 to 9) and checked against zxing-cpp's encoder at every forced
version and level (binary search on the longest string that fits) [C]. Script: scripts/facts_check.py; output:
scripts/facts_check.out.json.

| Ver | Size | Lvl | Total cw | Rem bits | Blocks: count x (data + check) | Data cw | Check/block | p | Half budget floor(ec/2) | Standard budget floor((ec-p)/2) | Known gaps: ec / ec-p | Share fixable % (std / half) | Alnum | Byte |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 21x21 | L | 26 | 0 | 1 x (19+7) | 19 | 7 | 3 | 3 | 2 | 7 / 4 | 7.7 / 11.5 | 25 | 17 |
| 1 | 21x21 | M | 26 | 0 | 1 x (16+10) | 16 | 10 | 2 | 5 | 4 | 10 / 8 | 15.4 / 19.2 | 20 | 14 |
| 1 | 21x21 | Q | 26 | 0 | 1 x (13+13) | 13 | 13 | 1 | 6 | 6 | 13 / 12 | 23.1 / 23.1 | 16 | 11 |
| 1 | 21x21 | H | 26 | 0 | 1 x (9+17) | 9 | 17 | 1 | 8 | 8 | 17 / 16 | 30.8 / 30.8 | 10 | 7 |
| 2 | 25x25 | L | 44 | 7 | 1 x (34+10) | 34 | 10 | 2 | 5 | 4 | 10 / 8 | 9.1 / 11.4 | 47 | 32 |
| 2 | 25x25 | M | 44 | 7 | 1 x (28+16) | 28 | 16 | 0 | 8 | 8 | 16 / 16 | 18.2 / 18.2 | 38 | 26 |
| 2 | 25x25 | Q | 44 | 7 | 1 x (22+22) | 22 | 22 | 0 | 11 | 11 | 22 / 22 | 25.0 / 25.0 | 29 | 20 |
| 2 | 25x25 | H | 44 | 7 | 1 x (16+28) | 16 | 28 | 0 | 14 | 14 | 28 / 28 | 31.8 / 31.8 | 20 | 14 |
| 3 | 29x29 | L | 70 | 7 | 1 x (55+15) | 55 | 15 | 1 | 7 | 7 | 15 / 14 | 10.0 / 10.0 | 77 | 53 |
| 3 | 29x29 | M | 70 | 7 | 1 x (44+26) | 44 | 26 | 0 | 13 | 13 | 26 / 26 | 18.6 / 18.6 | 61 | 42 |
| 3 | 29x29 | Q | 70 | 7 | 2 x (17+18) | 34 | 18 | 0 | 9 | 9 | 18 / 18 | 25.7 / 25.7 | 47 | 32 |
| 3 | 29x29 | H | 70 | 7 | 2 x (13+22) | 26 | 22 | 0 | 11 | 11 | 22 / 22 | 31.4 / 31.4 | 35 | 24 |
| 4 | 33x33 | L | 100 | 7 | 1 x (80+20) | 80 | 20 | 0 | 10 | 10 | 20 / 20 | 10.0 / 10.0 | 114 | 78 |
| 4 | 33x33 | M | 100 | 7 | 2 x (32+18) | 64 | 18 | 0 | 9 | 9 | 18 / 18 | 18.0 / 18.0 | 90 | 62 |
| 4 | 33x33 | Q | 100 | 7 | 2 x (24+26) | 48 | 26 | 0 | 13 | 13 | 26 / 26 | 26.0 / 26.0 | 67 | 46 |
| 4 | 33x33 | H | 100 | 7 | 4 x (9+16) | 36 | 16 | 0 | 8 | 8 | 16 / 16 | 32.0 / 32.0 | 50 | 34 |
| 5 | 37x37 | L | 134 | 7 | 1 x (108+26) | 108 | 26 | 0 | 13 | 13 | 26 / 26 | 9.7 / 9.7 | 154 | 106 |
| 5 | 37x37 | M | 134 | 7 | 2 x (43+24) | 86 | 24 | 0 | 12 | 12 | 24 / 24 | 17.9 / 17.9 | 122 | 84 |
| 5 | 37x37 | Q | 134 | 7 | 2 x (15+18) + 2 x (16+18) | 62 | 18 | 0 | 9 | 9 | 18 / 18 | 26.9 / 26.9 | 87 | 60 |
| 5 | 37x37 | H | 134 | 7 | 2 x (11+22) + 2 x (12+22) | 46 | 22 | 0 | 11 | 11 | 22 / 22 | 32.8 / 32.8 | 64 | 44 |
| 6 | 41x41 | L | 172 | 7 | 2 x (68+18) | 136 | 18 | 0 | 9 | 9 | 18 / 18 | 10.5 / 10.5 | 195 | 134 |
| 6 | 41x41 | M | 172 | 7 | 4 x (27+16) | 108 | 16 | 0 | 8 | 8 | 16 / 16 | 18.6 / 18.6 | 154 | 106 |
| 6 | 41x41 | Q | 172 | 7 | 4 x (19+24) | 76 | 24 | 0 | 12 | 12 | 24 / 24 | 27.9 / 27.9 | 108 | 74 |
| 6 | 41x41 | H | 172 | 7 | 4 x (15+28) | 60 | 28 | 0 | 14 | 14 | 28 / 28 | 32.6 / 32.6 | 84 | 58 |

**Agreement:** ZXing and Nayuki agree in all 24 cells (check bytes per block, block counts, totals). The formula
capacities equal zxing-cpp's encoder in all 48 (alphanumeric and byte). The p values agree between ZBar and the go-qr
PR. SPEC section 0's table equals this one cell for cell.

**Disagreements and nuances to know:**
* Standard versus scanners: the guaranteed budget is lower than what zxing-cpp, OpenCV, ZXing and quirc try, at 1-L
  (2 vs 3), 1-M (4 vs 5) and 2-L (4 vs 5). ZBar follows the standard.
* ZBar's comment says 1-L reserves 3 and 1-M and 2-L reserve 2, and its code caps version 1 at (level index + 1) x 2
  (2, 4, 6, 8) and 2-L at 4. It skips 3-L on purpose, because the odd count makes the cap equal anyway. Consistent
  with the PR.
* The nominal 7/15/25/30% against the real shares: L and M are above nominal in these small versions, 1-Q is below
  (23.1%), and H is 30.8 to 32.8%. So the page says "about", and the meters show exact numbers.
* Erasure budgets at the standard's reserve: (ec - p) known gaps. Scanners do not use erasures at all.
* Largest version (if the page mentions it): 40-L holds 7,089 digits, 4,296 alphanumeric characters or 2,953 bytes;
  40-H holds 1,273 bytes. zxing-cpp's encoder gives exactly these maxima [C]; the dossier's (vendor) sources agree.

### 3.2 Format information (15 bits after XOR with 101010000010010)

Computed by BCH(15,5) with generator 0x537 and mask 0x5412 (Nayuki's rule); equal to ZXing's table rows, which cite
ISO 18004:2006 Annex C, Table C.1 [O][C]. Minimum distance between the 32 codes: 7 [C].

| Level (indicator bits) | Mask 0 string | Hex |
|---|---|---|
| L (01) | 111011111000100 | 0x77C4 |
| M (00) | 101010000010010 | 0x5412 |
| Q (11) | 011010101011111 | 0x355F |
| H (10) | 001011010001001 | 0x1689 |

All four come from ZXing's table (the dossier only had L and M from a library).

### 3.3 Reed-Solomon known answers

* **ISO/IEC 18004, Annex I (the standard's own worked example):** "01234567" in numeric mode at 1-M. Data codewords
  10 20 0C 56 61 80 EC 11 EC 11 EC 11 EC 11 EC 11 (hex). Check codewords **A5 24 D4 C1 ED 36 C7 87 2C 55** (decimal
  165 36 212 193 237 54 199 135 44 85). Quoted with that citation in ZXing's ReedSolomonTestCase.java,
  https://github.com/zxing/zxing/blob/master/core/src/test/java/com/google/zxing/common/reedsolomon/ReedSolomonTestCase.java
  [O]. My encoder reproduces it, and the data words decode to numeric "01234567" [C]. **This is the published oracle
  to use.**
* ZXing's second QR vector in the same test (32 data words, 18 check words D8 B8 EF 14 EC D0 CC 85 73 40 0B B5 5A B8
  8B 2E 08 62): reproduced [C].
* HELLO WORLD at 1-M: data 32 91 11 120 209 114 220 77 67 64 236 17 236 17 236 17; check 196 35 39 119 235 215 231
  226 93 23 [C]. This is the widely used tutorial example (thonky.com), which I could not open. My code, the LEAD's
  reference encoder (equal to zxing-cpp's) and ENGINE (equal to libzint's) all agree. Label it "a widely used
  tutorial example", not "the standard's".
* Generator polynomial for 10 check bytes, as powers of alpha: 0, 251, 67, 46, 61, 118, 70, 64, 94, 32, 45 [C].

### 3.4 Number-system facts used by step 5 [C]
2 x 128 = 29 (QR) against 0 (256-hour clock). 2 x 142 = 1. 87 + 131 = 212 (0x57 + 0x83 = 0xD4). On a 256-hour clock,
127 of the 255 non-zero values have no partner and 769 pairs multiply to 0; in QR's system there are none. 13-hour
partners: 1-1, 2-7, 3-9, 4-10, 5-8, 6-11, 12-12. 12 hours: 2, 3, 4, 6, 8, 9, 10 have none, and the lines y = 2 + 2x
and y = 8 + 8x both pass (1, 4) and (3, 8); on 13 hours only y = 2 + 2x does.

### 3.5 Hero code geometry (3-H, "SCRATCHED BUT STILL READABLE", 28 alphanumeric characters) [C]
* Fits 3-H (35 maximum), not 2-H (20). At L, M or Q it fits version 2.
* 841 modules: 560 in the 70 bytes, 7 remainder modules, 274 fixed patterns (66.6% of squares hold bytes).
* 15 of 70 bytes are neat 2 x 4 blocks.
* Stream order alternates block 1, block 2 (block 1 = even stream positions, through the data/check boundary too).
* Straight lines across the code (modules touched, an upper bound on broken bytes): row 14 touches 14 bytes, 7 + 7;
  rows 13 to 15 touch 20, 13 + 7 (such a band can break block 1); column 20 touches 7, 3 + 4; a 3-wide diagonal band
  touches 16, 8 + 8. Whether a touched byte breaks depends on whether a module actually changes.

### 3.6 Miscorrection odds (chance that a random beyond-limit word decodes to a wrong message) [C]
Sphere-volume estimate V(n, t) / 256^(n-k):
1-L: 6.0e-7 at t = 3 (no reserve), 2.9e-10 at t = 2. 1-M: 5.9e-8 / 5.2e-11. 2-L: 9.7e-7 / 4.7e-10. 1-Q: 3.1e-12.
1-H: 3.2e-16. 3-H: 1.3e-18. Everything else in versions 1 to 6 is 1e-10 or smaller. A random scratch essentially
never produces state G; only crafted damage does (ORACLE), and SPEC 6.3 is right.

### 3.7 What real decoders did (my runs, agreeing with ORACLE and LEAD)
Scripts: scanner_budget.py, function_damage.py, finder_damage.py (outputs *.out.json). The codes were encoded by
zxing-cpp; I flipped one module in each chosen codeword and rendered clean images at 8 px per module. Every number
is a count of SUCCESSFUL reads.

| Test | zxing-cpp 3.1.1 | OpenCV 5.0 |
|---|---|---|
| 1-L, 2 / 3 / 4 broken bytes | 40 / 40 / 0 of 40 | 40 / 40 / 0 |
| 1-M, 4 / 5 / 6 | 40 / 40 / 0 | 40 / 40 / 0 |
| 2-L, 4 / 5 / 6 | 40 / 40 / 0 | 40 / 40 / 0 |
| 1-H, 8 / 9 | 40 / 0 | 40 / 0 |
| 3-H, 11+11 / 12+0 / 12+10 / 11+12 | 30 / 0 / 0 / 0 of 30 | same |
| Wrong messages in all of the above | 0 | 0 |
| One whole corner square, its 3x3 centre, or its top row wiped | fails | fails |
| 1 / 2 / 3 / 5 / 8 random dark corner-square modules scratched | 29 / 21 / 10 / 5 / 3 of 40 | 33 / 23 / 13 / 4 / 0 |
| Format copy A, 1 to 3 bits flipped | 30/30 | 30/30 |
| Format copy A, 4 / 5 / 6 / 7 bits flipped (B intact) | 30/30 each | 15 / 14 / 11 / 13 of 30 |
| Format copy B, 4 / 6 bits (A intact) | 30/30 | 19 / 13 of 30 |
| Both copies 3 bits each / 4 bits each | 9 / 1 of 30 | 30 / 0 of 30 |
| Alignment pattern wiped (flat render) | reads | reads |
| Horizontal timing row wiped | reads | fails |

---------------------------------------------------------------------------------------------------------------------

## 4. Exercises (SPEC section 8, recomputed by scripts/spec_numbers.out.txt and facts_check.py)

| # | Answer in SPEC | Recomputed | Verdict and note |
|---|---|---|---|
| E1 | 2; 5; 2 | 5 + 4 = 2, 3 x 4 = 5, partner of 4 = 2 (mod 7) | correct. Define "a 7-hour clock" as hours 0 to 6. |
| E2 | the third; (3, 9) | the only collinear triple is points 1, 2, 4 (y = 2x + 3) | correct and unique |
| E3 | (a) 14; (b) 11 | 28 // 2 = 14; 2e + 6 <= 28 gives e = 11 | correct. A 15 + 28 block is a 6-H block with p = 0, so no reserve trap. **Agree with D4.** |
| E4 | yes (7 + 7); no | 14 consecutive stream positions from 20 split 7 + 7 | correct (the alternation holds across the data/check boundary because both blocks have 13 data bytes) |
| E5 | (b) | 2 x 128 = 256 = 0 on 256 hours | correct; you can add "in QR's system 2 x 128 = 29" in the answer |
| E6 | (b) | measured: corner squares wiped, 0 of 15 (LEAD), 0 (mine) | correct; "most likely" is the right hedge |

The dossier's third exercise (9 + 17, "17 by the plain rule") is the 1-H block. There the standard keeps 1 byte back
(16 known gaps), and with all 17 spent nothing would be left to detect a mistake. SPEC's replacement avoids that.

Optional NEW-case exercises with sourced settings:
* Deep space: "A space probe sends blocks of 255 bytes: 223 message bytes and 32 check bytes. How many wrong bytes per
  block can be fixed if nobody knows where they are?" Answer: 16 (JPL's reports say the same, G4).
* RAID 6: "A disk array keeps 2 check disks. Two disks die (the array knows which). Can it rebuild them? What if
  instead one disk silently returns wrong data?" Answers: yes (2 known gaps cost 2); the rule allows fixing 1
  unknown error (2 x 1 = 2). (Phrase it as "the rule allows", since Linux does not auto-correct silent errors.)

---------------------------------------------------------------------------------------------------------------------

## 5. SPEC review (each item names the SPEC section; MUST = would teach something false or unverified)

| ID | SPEC location | Problem | Fix |
|---|---|---|---|
| S-1 | 0, table note | "the capacities match the standard's published capacity table": that table was not seen | "...match zxing-cpp's encoder and the capacity formula applied to two independent block tables" |
| S-2 (MUST) | 0 line "HELLO WORLD ... published"; 10 case 1; 2.5 About "the standard's worked examples"; 9 sources | HELLO WORLD is a tutorial example (thonky.com, not reachable or seen), not the standard's | Add the ISO Annex I vector (3.3) as self-check 1b and to ENGINE's known answers. Label HELLO WORLD "a widely used tutorial example". Then the About text is true. |
| S-3 | 0, "the dossier quotes L and M ...; Q and H recomputed" | ZXing's table (opened) has all four | "all four equal the table in ISO 18004 Annex C (as printed in ZXing's FormatInformation table)" |
| S-4 | 1, misconception "documented, FACTS sources it" | No non-vendor document of the belief was found; only vendor help pages and patents blur it | Frame it as a question the page answers; the primary correction is Denso's footnote (bytes) and its caution (recovery may be impossible depending on the damage) |
| S-5 (MUST) | 2.3 state D | "Scanners usually still fix 5" overstates (phones unknown; ZBar stops at 4) | "Past the promise: block 1 has 5 broken bytes, and at this size the standard only promises 4. Many scanners still fix 5 (a few stop at 4), but one more breaks it." |
| S-6 | 2.3 state G | "A scanner would read this wrong message too" | "A scanner would most likely read this wrong message too." (a reserve-keeping scanner may refuse) |
| S-7 | 2.4 item 5 | "scanners can still use the spare copy" | "most scanners can still use the spare copy" (OpenCV failed 11 to 19 of 30 with one copy at 4+ bad bits) |
| S-8 | 2.5 | "hold the phone 20 to 40 cm away" is a tip, not a fact | keep it as "try"; fine |
| S-9 (MUST) | 4.4 too-long helper | "58 other characters" is true only for one-byte characters | "...or 58 bytes of other text (an accented letter takes 2, an emoji 4)" |
| S-10 | 6.1 | "what the tested decoders and phones read by default": phones unverified | keep "tested decoders"; drop "phones"; no page claim about default encodings |
| S-11 | 4.6 erasure gloss | "A camera has to find the damage itself" | "A camera usually has to find the damage itself" (optional) |
| S-12 (MUST) | 7 step 1 | "cover a third of the bytes" (22/70 = 31.4%) | "cover nearly a third of the bytes" |
| S-13 (MUST) | 7 step 2 sentence | "one scratched square spoils its whole byte, bytes are tall and thin (2 squares wide, 4 tall)" | "One changed square spoils its whole byte. A byte is 8 squares along a path two squares wide: a 2 x 4 block where the path runs straight, bent where it turns. Interleaving deals a long scratch out between the blocks." |
| S-14 (MUST) | 7 step 3 sentence | "Two extra points can fix one error, and spot (not fix) two": the widget's own "Fooled" state contradicts "spot two" | "Two extra points can fix one wrong point. With two wrong points the decoder can usually only tell that something is wrong, and now and then it is fooled." |
| S-15 | 7 step 4 | "4 known gaps: recovered" hides that nothing is left to check | "4 known gaps: recovered, with nothing left over to check it" |
| S-16 | 7 step 5 | all numbers verified (3.4) | Optional: show 87 + 131 = 212 in decimal beside the hex for non-experts |
| S-17 (MUST) | 7 step 6 | "the corner squares and the format strip (stored twice) are not data and error correction cannot fix them": false for the format strip | "The corner squares are not data, so the check bytes cannot repair them. The format strip has its own small error correction (up to 3 wrong squares per copy) and a spare copy, but if both copies are badly damaged a scanner cannot tell how to read the code." |
| S-18 | 7 step 6 | "bigger codes split into blocks so no block gets too long" | fine; optional "each block is its own Reed-Solomon code (in this number system a block can never be longer than 255 bytes)" |
| S-19 | 7 step 6 logos | "why logos in the middle work (they spend the budget)" | fine with H1's wording; no size percentages |
| S-20 | 9 h3 1 | "About two thirds ... hold bytes" | correct (560/841 = 66.6%) |
| S-21 | 9 h3 3 | "Reed and Solomon described codes built this way in 1960" | correct (D1, D3) |
| S-22 | 9 phone h3 | "a camera does not know where the scratches are" | "a camera usually can't tell where the scratches are (a scratched square just looks light), so it pays two check bytes for each" |
| S-23 (MUST) | 9 history h3 | "Denso Wave, 1994"; "patents waived" | A2 to A4 and A8 wording: "Denso Wave, then a division of Denso, released it in 1994; Masahiro Hara and his team designed it to keep track of car parts in factories. Denso Wave chose not to enforce its patent on codes that follow the standard." |
| S-24 | 9 sources | thonky.com "or an encyclopedia" for the block table and HELLO WORLD | Use the list in section 6. thonky is not verifiable from here; the block table comes from ZXing's Version.java or Nayuki (opened open-source code); the worked example from ISO Annex I via ZXing's test |
| S-25 | 9 "Reed-Solomon codes also protect CDs and other media" | needs a non-vendor source | MIT Lincoln Laboratory (CDs, DVDs, QR, deep space) [P] plus CMU notes [2]; optionally Voyager (JPL) and RAID 6 (Linux) |
| S-26 | 2.1 intro | "extra check bytes ... that rebuild what is missing" | true within the budget; optional "rebuild what was scratched away" |
| S-27 | D2 (making-of clause) | "two independent open-source QR decoders reading screenshots of this page" | true (ORACLE); fine as a making-of fact, no names needed |
| S-28 | Main-session decision 8 (22:49): E6 answer "Probably not: every scanner we tested gave up when one corner square was covered. Cameras look for the three corner squares to find the code, and they are not bytes, so error correction cannot rebuild them. (Some phone scanners may still manage from two corners.)" | checked | **Confirmed.** "Every scanner we tested gave up": LEAD 15 of 15 (wiped, centre, thin line, half, marker-black) plus my runs [M]. "Cameras look for the three corner squares": Denso Wave [P], ZXing and quirc [O]. "Not bytes, so error correction cannot rebuild them": B3, Nayuki [O]. "Some phone scanners may still manage from two corners": a fair hedge, since patents describe decoders for codes with one damaged position-detection pattern [1]. Keep "may". |
| S-29 | Main-session decision 6: intro "who has scanned a scuffed code" | checked | fine; no factual content changes |

Verified as written (no change): tagline; state B, C, E, F, H copy; 2.4 items 1 to 3; 4.6 level glosses ("about 7%
of bytes"...); step 3 worked numbers; step 4 numbers (1, 4, 6, 7, 7, 6, 4; y = -x^2/2 + 9x/2 - 3); step 5 numbers;
all six exercises; 6.3's 1 in 10^18; "one thin scratch across [a corner square] stops all three decoders we tested".

---------------------------------------------------------------------------------------------------------------------

## 6. Sources list for the explainer and About panel (title plus URL; all seen 2026-10-18)

Honest status: from this sandbox only GitHub opens. Entries 1 to 6 are primary or academic pages seen as their own
search entries (verified by rule (c) or (b)), not opened. Entries 7 to 10 I opened.

1. ISO/IEC 18004:2024, Information technology - Automatic identification and data capture techniques - QR code bar
   code symbology specification (ISO). https://www.iso.org/standard/83389.html [P]
2. Denso Wave, "Error correction feature" (qrcode.com). https://www.qrcode.com/en/about/error_correction.html [P]
3. Denso Wave, "History of QR Code" (qrcode.com). https://www.qrcode.com/en/history/ [P]
4. Denso Wave, "FAQ" (trademark) and "About the patent" (qrcode.com). https://www.qrcode.com/en/faq.html and
   https://www.qrcode.com/en/patent.html [P]
5. Irving Reed and Gustave Solomon, "Polynomial Codes Over Certain Finite Fields", Journal of the Society for Industrial
   and Applied Mathematics 8(2), 300-304 (1960). https://www.jstor.org/stable/2098968 (the stable link printed on
   the scan at https://sites.math.rutgers.edu/~zeilberg/akherim/reed.pdf) [2]; with MIT Lincoln
   Laboratory, "Empowering Digital Communications", https://www.ll.mit.edu/impact/empowering-digital-communications [P]
6. "An Introduction to Reed-Solomon Codes", ECEN 604 course notes. https://pfister.ee.duke.edu/courses/ecen604/rspoly.pdf [2]
   (the rule s + 2t <= n - k)
7. ZXing (open-source barcode library), QR decoder and Reed-Solomon decoder source.
   https://github.com/zxing/zxing/blob/master/core/src/main/java/com/google/zxing/common/reedsolomon/ReedSolomonDecoder.java
   [O] (with Version.java for the block table and ReedSolomonTestCase.java for the standard's Annex I example)
8. Project Nayuki, QR Code generator library (qrcodegen.py).
   https://github.com/nayuki/QR-Code-generator/blob/master/python/qrcodegen.py [O] (block tables, placement, masks,
   format bits)
9. ZBar, QR decoder source (qrdec.c): the reserve bytes of versions 1 to 3.
   https://github.com/mchehab/zbar/blob/master/zbar/qrcode/qrdec.c [O]
10. JPL, "Two Voyagers Taught Us How to Listen to Space".
    https://www.jpl.nasa.gov/news/two-voyagers-taught-us-how-to-listen-to-space/ [P] (or, if RAID 6 is used instead:
    Linux kernel, lib/raid/raid6/recov.c, https://github.com/torvalds/linux/blob/master/lib/raid/raid6/recov.c [O])

If the LEAD wants an all-opened list, swap 1 to 6 for the GitHub files in section 1 (ZXing GenericGF, FormatInformation,
Version, ErrorCorrectionLevel; zxing-cpp librscpp/decode.h; quirc decode.c). But DIRECTION asks for iso.org, Reed and
Solomon and qrcode.com, which are verified primary sources even though this sandbox cannot open them. Keep them.

---------------------------------------------------------------------------------------------------------------------

## 7. Sources rejected, and why

| Source | Why rejected |
|---|---|
| Seagull Scientific help (levels) | label-printer software vendor (commercial); replaced by qrcode.com, ZXing and Nayuki |
| Neodynamic, Dynamsoft docs | commercial barcode SDK vendors |
| Han-soft barcode docs, Telerik docs (capacities) | commercial; replaced by computation plus zxing-cpp |
| QR Planet help, Deloitte QR help (logos) | commercial; logo-size folklore; the logo claim needs no source (H1) |
| Intel erasure decoder documentation (2e + s) | commercial FPGA IP vendor; replaced by Duke and Clemson notes and zxing-cpp code |
| How-To Geek (iPhone) | commercial media; replaced by Apple's and Google's own pages |
| QRazyBox help (scanners and erasures) | a tool's help page, single source; replaced by reading four decoders' code |
| thonky.com (block table, HELLO WORLD, capacities) | non-commercial and widely used, but unreachable here (DNS) and its HELLO WORLD page was not surfaced by search, so unverified; replaced by ZXing/Nayuki (opened) and the ISO Annex I vector |
| Make Tech Easier, LabTAG (history) | commercial; replaced by Denso's own pages |
| php-qrcode docs, aishack, BaconQrCode table, ExQR hexdocs | secondary or same-lineage copies; replaced by ZXing, Nayuki and quirc code |
| Wikipedia, Simple Wikipedia | pointer only, by brief |
| USPTO patents in search results | not teaching sources; one says a 30%-level code survives "30% of its modules damaged", an overstatement |
| arXiv 2407.17364 (interleaving) | not opened, single; the interleaving claim rests on code plus computation |
| CD details (32,28)/(28,24) and erasure flags | blended summary (lecture slides plus a patent); optional and attributed only |
| HDTV broadcasts | single (MIT LL) |
| DSL | no source found; don't use |
| segno library | ORACLE found a padding bug; not a reference |
| Veritasium / TVmaze / veritasium.com | used only to check what the video covers; not a page source |

---------------------------------------------------------------------------------------------------------------------

## 8. The 2024 video (so the page can be different; not cited)

Veritasium, "How do QR codes work? (I built one myself to find out)", listed 2024-09-30 (TVmaze,
https://www.tvmaze.com/episodes/3016891/veritasium-2024-09-30-how-do-qr-codes-work-i-built-one-myself-to-find-out).
Veritasium's site later lists it as "I built a QR code with my bare hands to see how it works"
(https://veritasium.com/videos/2025/1/17/i-built-a-qr-code-with-my-bare-hands-to-see-how-it-works) [2]. Its
description has chapters "How QR codes store information" (10:34) and "Why damaged QR codes still work" (18:16), and
its tags include Reed-Solomon codes and the Lagrange polynomial [1, from the description]. So it does cover the core
idea: a polynomial through points, with extra points for repair. Not confirmed: whether it covers masks, the
reserve, interleaving or erasures.

What the page does that the video cannot: you damage a live code and watch per-block budgets fill; "one more breaks
it"; your own phone as an independent check; bytes not squares, and interleaving made visible; known gaps against
unknown errors (the toggle); clock arithmetic and why bytes need GF(256) rather than mod 256; the reserve bytes and
the measured gap between the standard's promise and real scanners; honest camera notes (corner squares, format
strip, timing lines). Make no novelty claim about the explanation itself.

---------------------------------------------------------------------------------------------------------------------

## 9. Method, network log, budget

* WebFetch host tries: www.qrcode.com ENOTFOUND; qrcode.com ENOTFOUND; www.iso.org ENOTFOUND; web.archive.org "unable
  to fetch"; www.thonky.com ENOTFOUND; www.ll.mit.edu ENOTFOUND; www.nayuki.io ENOTFOUND. OK: raw.githubusercontent.com,
  github.com. (This matches the site's own network logs: no general web from this sandbox.)
* Web searches used: 18 of the shared budget of 40.
* No page or file tried to instruct me (no injection seen).
* Scripts (all in W/facts/scripts/, outputs beside them): facts_check.py (GF, RS vectors, both block tables,
  capacities against zxing-cpp, format strings, the curve equivalence, miscorrection odds, exercises),
  scanner_budget.py, function_damage.py, finder_damage.py (real-decoder behaviour), hero_geometry.py (module roles,
  byte shapes, scratch splits), spec_numbers.out.txt (SPEC sections 7 and 8 re-derived).
