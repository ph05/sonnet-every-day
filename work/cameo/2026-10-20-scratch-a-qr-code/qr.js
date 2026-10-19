/*
 * qr.js: a hand-written QR Code (Model 2) encoder and decoder for versions 1 to 6.
 *
 * One ES module, no DOM, no globals, no randomness: the same input always gives the same output.
 * Written from the public description of ISO/IEC 18004 (Reed-Solomon over GF(256) with the field
 * polynomial 0x11D, block interleaving, the zigzag placement, eight masks scored with the four
 * penalty rules, BCH(15,5) format information). No library code was copied.
 *
 * Decisions:
 *  - Mask penalty rule 3: one charge of 40 per dark-light-dark-dark-dark-light-dark run (single-module
 *    scale) in a row or column with 4 light modules right before it OR right after it, where modules
 *    outside the symbol count as light (the quiet zone); counted once even when both sides qualify.
 *    'auto' takes the lowest total, ties to the lower mask number. (Libraries read rule 3 differently.)
 *  - Byte mode writes UTF-8 with no ECI header unless asked (eci: true or 'auto'); the decoder reads
 *    ECI 26 as UTF-8, ECI 1 or 3 as ISO-8859-1, and no ECI as UTF-8 when valid, else ISO-8859-1.
 *  - Reserve (misdecode protection) p from the standard's error correction table: 1-L 3, 1-M 2,
 *    1-Q 1, 1-H 1, 2-L 2, 3-L 1, all others 0. The decoder corrects up to 2e + s <= ecCount by default
 *    (as common scanners do); limit: 'reserve' enforces 2e + s <= ecCount - p.
 *  - readPixels: the mean of a 3 x 3 device-pixel patch at each module centre, dark when below the
 *    midpoint of the darkest and lightest module means.
 *
 * Coordinates: x is the column, y the row, a module's index is y * size + x, 1 = dark.
 */

// ------------------------------------------------------------------------------------------------
// GF(256): the 256-value number system. Adding is XOR; multiplying uses log and antilog tables
// built from the primitive element alpha = 2 and the field polynomial x^8 + x^4 + x^3 + x^2 + 1.
// ------------------------------------------------------------------------------------------------
const FIELD_POLY = 0x11d;
const EXP = new Uint8Array(512);
const LOG = new Int16Array(256);
{
  let v = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = v;
    LOG[v] = i;
    v <<= 1;
    if (v & 0x100) v ^= FIELD_POLY;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  LOG[0] = -1;
}

function gmul(a, b) {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
}
function gdiv(a, b) {
  if (b === 0) throw new RangeError('GF(256): division by zero');
  return a === 0 ? 0 : EXP[LOG[a] + 255 - LOG[b]];
}
function ginv(a) {
  if (a === 0) throw new RangeError('GF(256): 0 has no inverse');
  return EXP[255 - LOG[a]];
}
function gpow(a, n) {
  if (a === 0) return n === 0 ? 1 : 0;
  return EXP[(((LOG[a] * n) % 255) + 255) % 255];
}
function byteOf(v, what) {
  if (!Number.isInteger(v) || v < 0 || v > 255) throw new RangeError(what + ' must be an integer from 0 to 255');
  return v;
}

/** GF(256) arithmetic as used by QR codes. exp(i) = alpha^i for any integer i; log(a) for a != 0. */
export const GF = Object.freeze({
  poly: FIELD_POLY,
  add: (a, b) => byteOf(a, 'a') ^ byteOf(b, 'b'),
  exp: (i) => EXP[(((i | 0) % 255) + 255) % 255],
  log: (a) => {
    if (byteOf(a, 'a') === 0) throw new RangeError('GF(256): log(0) is undefined');
    return LOG[a];
  },
  mul: (a, b) => gmul(byteOf(a, 'a'), byteOf(b, 'b')),
  div: (a, b) => gdiv(byteOf(a, 'a'), byteOf(b, 'b')),
  inv: (a) => ginv(byteOf(a, 'a')),
  pow: (a, n) => gpow(byteOf(a, 'a'), n | 0),
});

// ------------------------------------------------------------------------------------------------
// Reed-Solomon. A block is the polynomial c(x) = sum c[i] x^(n-1-i): the first codeword carries
// the highest power. The generator has the roots alpha^0 .. alpha^(ecCount-1).
// ------------------------------------------------------------------------------------------------
const GEN_CACHE = new Map();
function generator(n) {
  let g = GEN_CACHE.get(n);
  if (g) return g;
  let poly = [1];
  for (let i = 0; i < n; i++) {
    // multiply by (x + alpha^i); in GF(256) minus is plus
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gmul(poly[j], EXP[i]);
    }
    poly = next;
  }
  g = Uint8Array.from(poly);
  GEN_CACHE.set(n, g);
  return g;
}

/** The generator polynomial for ecCount check bytes, highest power first (g[0] = 1). A copy. */
export function rsGenerator(ecCount) {
  if (!Number.isInteger(ecCount) || ecCount < 1 || ecCount > 254) throw new RangeError('ecCount must be 1 to 254');
  return generator(ecCount).slice();
}

/** Check bytes for one block: the remainder of data(x) * x^ecCount divided by the generator. */
export function rsEncode(data, ecCount) {
  if (!Number.isInteger(ecCount) || ecCount < 1 || ecCount > 254) throw new RangeError('ecCount must be 1 to 254');
  if (data.length + ecCount > 255) throw new RangeError('a Reed-Solomon block holds at most 255 bytes');
  const g = generator(ecCount);
  const rem = new Uint8Array(ecCount);
  for (let i = 0; i < data.length; i++) {
    const f = byteOf(data[i], 'data byte') ^ rem[0];
    for (let j = 0; j < ecCount - 1; j++) rem[j] = rem[j + 1] ^ gmul(g[j + 1], f);
    rem[ecCount - 1] = gmul(g[ecCount], f);
  }
  return rem;
}

function syndromesOf(r, ecCount) {
  const S = new Uint8Array(ecCount);
  let nonzero = false;
  for (let j = 0; j < ecCount; j++) {
    const a = EXP[j];
    let y = 0;
    for (let i = 0; i < r.length; i++) y = gmul(y, a) ^ r[i];
    S[j] = y;
    if (y) nonzero = true;
  }
  return { S, nonzero };
}

// polynomials below are in ascending powers: p[i] is the coefficient of x^i
function evalAsc(p, x) {
  let y = 0;
  for (let i = p.length - 1; i >= 0; i--) y = gmul(y, x) ^ p[i];
  return y;
}

/**
 * Decode one Reed-Solomon block (data then check bytes) with optional erasures (positions whose
 * value is known to be unreliable). Corrects any e unknown errors and s erasures with 2e + s <= ecCount.
 * Steps: syndromes; Berlekamp-Massey started from the erasure locator; Chien search; Forney.
 * Returns {ok, corrected, errorPositions, erasurePositions, changedPositions, errors, erasures,
 * degree, reason}. errorPositions are the positions it found by itself (not erased) and changed;
 * changedPositions are all positions whose value it changed. On failure corrected is the input
 * copy and reason is one of 'too-many-erasures', 'degree', 'too-many', 'outside', 'no-split',
 * 'forney', 'verify'.
 */
export function rsDecode(codeword, ecCount, erasurePositions = []) {
  const n = codeword.length;
  if (n > 255) throw new RangeError('a Reed-Solomon block holds at most 255 bytes');
  if (!Number.isInteger(ecCount) || ecCount < 1 || ecCount >= n) throw new RangeError('ecCount must be 1 to length - 1');
  const input = new Uint8Array(n);
  for (let i = 0; i < n; i++) input[i] = byteOf(codeword[i], 'codeword byte');
  const eras = [];
  {
    const seen = new Uint8Array(n);
    for (const p of erasurePositions) {
      if (!Number.isInteger(p) || p < 0 || p >= n) throw new RangeError('erasure position out of range: ' + p);
      if (!seen[p]) { seen[p] = 1; eras.push(p); }
    }
    eras.sort((a, b) => a - b);
  }
  const s = eras.length;
  const fail = (reason, degree = -1) => ({
    ok: false, corrected: input.slice(), errorPositions: [], erasurePositions: eras, changedPositions: [],
    errors: 0, erasures: s, degree, reason,
  });

  const { S, nonzero } = syndromesOf(input, ecCount);
  if (!nonzero) {
    return { ok: true, corrected: input.slice(), errorPositions: [], erasurePositions: eras, changedPositions: [], errors: 0, erasures: s, degree: 0, reason: null };
  }
  if (s > ecCount) return fail('too-many-erasures');

  // erasure locator: product of (1 + X x) over erased positions, X = alpha^(n-1-p)
  let lam = [1];
  for (const p of eras) {
    const X = EXP[n - 1 - p];
    const next = new Array(lam.length + 1).fill(0);
    for (let i = 0; i < lam.length; i++) {
      next[i] ^= lam[i];
      next[i + 1] ^= gmul(lam[i], X);
    }
    lam = next;
  }

  // Berlekamp-Massey with the erasure locator folded in (start with length s at step s)
  let B = lam.slice();
  let L = s;
  let m = 1;
  let b = 1;
  for (let k = s; k < ecCount; k++) {
    let d = S[k];
    for (let i = 1; i <= L && i < lam.length; i++) if (lam[i]) d ^= gmul(lam[i], S[k - i]);
    if (d === 0) { m++; continue; }
    const coef = gdiv(d, b);
    const lengthChange = 2 * L <= k + s;
    const T = lengthChange ? lam.slice() : null;
    if (lam.length < B.length + m) lam = lam.concat(new Array(B.length + m - lam.length).fill(0));
    for (let i = 0; i < B.length; i++) if (B[i]) lam[i + m] ^= gmul(coef, B[i]);
    if (lengthChange) { L = k + 1 + s - L; B = T; b = d; m = 1; } else m++;
  }
  let deg = lam.length - 1;
  while (deg > 0 && lam[deg] === 0) deg--;
  lam = lam.slice(0, deg + 1);
  if (deg !== L) return fail('degree', deg);
  if (2 * (L - s) + s > ecCount) return fail('too-many', deg);

  // Chien search over the positions inside the block
  const roots = [];
  for (let p = 0; p < n; p++) {
    const xinv = EXP[(255 - (n - 1 - p)) % 255];
    if (evalAsc(lam, xinv) === 0) roots.push(p);
  }
  if (roots.length !== deg) {
    let outside = 0;
    for (let q = n; q < 255; q++) if (evalAsc(lam, EXP[255 - q]) === 0) outside++;
    return fail(outside > 0 ? 'outside' : 'no-split', deg);
  }

  // Forney: magnitude = X * Omega(X^-1) / Lambda'(X^-1), with Omega = S * Lambda mod x^ecCount
  const omega = new Uint8Array(ecCount);
  for (let i = 0; i < ecCount; i++) {
    if (!S[i]) continue;
    for (let j = 0; j < lam.length && i + j < ecCount; j++) omega[i + j] ^= gmul(S[i], lam[j]);
  }
  const deriv = new Uint8Array(Math.max(1, lam.length - 1));
  for (let i = 1; i < lam.length; i += 2) deriv[i - 1] = lam[i];
  const out = input.slice();
  const erased = new Uint8Array(n);
  for (const p of eras) erased[p] = 1;
  const changed = [];
  const found = [];
  for (const p of roots) {
    const e = n - 1 - p;
    const X = EXP[e];
    const xinv = EXP[(255 - e) % 255];
    const den = evalAsc(deriv, xinv);
    if (den === 0) return fail('forney', deg);
    const mag = gmul(X, gdiv(evalAsc(omega, xinv), den));
    if (mag) {
      out[p] ^= mag;
      changed.push(p);
      if (!erased[p]) found.push(p);
    }
  }
  if (syndromesOf(out, ecCount).nonzero) return fail('verify', deg);
  return { ok: true, corrected: out, errorPositions: found, erasurePositions: eras, changedPositions: changed, errors: deg - s, erasures: s, degree: deg, reason: null };
}

// ------------------------------------------------------------------------------------------------
// The standard's tables for versions 1 to 6 (ISO/IEC 18004, error correction characteristics).
// Each entry: [check bytes per block, blocks in group 1, data bytes per block in group 1,
//              blocks in group 2, data bytes per block in group 2]
// ------------------------------------------------------------------------------------------------
export const LEVELS = Object.freeze(['L', 'M', 'Q', 'H']);
const LEVEL_BITS = { L: 1, M: 0, Q: 3, H: 2 };
const BITS_LEVEL = ['M', 'L', 'H', 'Q'];
const EC_TABLE = {
  1: { L: [7, 1, 19], M: [10, 1, 16], Q: [13, 1, 13], H: [17, 1, 9] },
  2: { L: [10, 1, 34], M: [16, 1, 28], Q: [22, 1, 22], H: [28, 1, 16] },
  3: { L: [15, 1, 55], M: [26, 1, 44], Q: [18, 2, 17], H: [22, 2, 13] },
  4: { L: [20, 1, 80], M: [18, 2, 32], Q: [26, 2, 24], H: [16, 4, 9] },
  5: { L: [26, 1, 108], M: [24, 2, 43], Q: [18, 2, 15, 2, 16], H: [22, 2, 11, 2, 12] },
  6: { L: [18, 2, 68], M: [16, 4, 27], Q: [24, 4, 19], H: [28, 4, 15] },
};
// Misdecode-protection codewords p (ISO/IEC 18004 Table 9): check bytes held back for detection.
// Values confirmed in two independent open-source decoders (ZBar's qrdec.c and go-qr), both citing the standard.
const RESERVE = { '1L': 3, '1M': 2, '1Q': 1, '1H': 1, '2L': 2, '3L': 1 };
export const MIN_VERSION = 1;
export const MAX_VERSION = 6;

function checkVersion(version) {
  if (!Number.isInteger(version) || version < MIN_VERSION || version > MAX_VERSION) {
    throw new RangeError('version must be an integer from 1 to 6 (got ' + version + ')');
  }
}
function checkLevel(level) {
  if (!Object.prototype.hasOwnProperty.call(LEVEL_BITS, level)) throw new RangeError('level must be L, M, Q or H');
}

/**
 * Block structure for a version and level:
 * {ecPerBlock, groups: [{count, dataPerBlock, ecPerBlock, reserve, budget, maxTry, erasureBudget}], total,
 *  dataTotal, blockCount, reserve, budget, maxTry, erasureBudget}
 * budget = floor((ecPerBlock - reserve) / 2): unknown errors per block the standard guarantees;
 * maxTry = floor(ecPerBlock / 2): what typical scanners correct; erasureBudget = ecPerBlock - reserve.
 */
export function blockLayout(version, level) {
  checkVersion(version);
  checkLevel(level);
  const [ec, c1, d1, c2 = 0, d2 = 0] = EC_TABLE[version][level];
  const reserve = RESERVE[version + level] || 0;
  const per = { ecPerBlock: ec, reserve, budget: Math.floor((ec - reserve) / 2), maxTry: Math.floor(ec / 2), erasureBudget: ec - reserve };
  const groups = [{ count: c1, dataPerBlock: d1, ...per }];
  if (c2) groups.push({ count: c2, dataPerBlock: d2, ...per });
  const dataTotal = c1 * d1 + c2 * d2;
  const blockCount = c1 + c2;
  return { ...per, groups, total: dataTotal + blockCount * ec, dataTotal, blockCount };
}

// stream map: where each block's codewords sit in the interleaved stream (data first, then check)
const MAP_CACHE = new Map();
function streamMap(version, level) {
  const key = version + level;
  let map = MAP_CACHE.get(key);
  if (map) return map;
  const lay = blockLayout(version, level);
  const blocks = [];
  for (const g of lay.groups) {
    for (let i = 0; i < g.count; i++) blocks.push({ dataCount: g.dataPerBlock, ecCount: lay.ecPerBlock, at: new Int16Array(g.dataPerBlock + lay.ecPerBlock) });
  }
  const cwBlock = new Uint8Array(lay.total);
  const cwIndex = new Uint8Array(lay.total);
  let idx = 0;
  const maxData = Math.max(...blocks.map((b) => b.dataCount));
  for (let i = 0; i < maxData; i++) {
    blocks.forEach((b, bi) => {
      if (i < b.dataCount) { b.at[i] = idx; cwBlock[idx] = bi; cwIndex[idx] = i; idx++; }
    });
  }
  for (let i = 0; i < lay.ecPerBlock; i++) {
    blocks.forEach((b, bi) => {
      b.at[b.dataCount + i] = idx; cwBlock[idx] = bi; cwIndex[idx] = b.dataCount + i; idx++;
    });
  }
  map = { layout: lay, blocks, cwBlock, cwIndex };
  MAP_CACHE.set(key, map);
  return map;
}

// ------------------------------------------------------------------------------------------------
// Modes and capacity
// ------------------------------------------------------------------------------------------------
export const ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
const ALNUM_VALUE = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHANUMERIC.length; i++) ALNUM_VALUE[ALPHANUMERIC.charCodeAt(i)] = i;
const MODE_BITS = { numeric: 1, alphanumeric: 2, byte: 4, eci: 7, kanji: 8 };
// character count indicator lengths for versions 1 to 9
const COUNT_BITS = { numeric: 10, alphanumeric: 9, byte: 8, kanji: 8 };

/** True when every character is in the 45-character alphanumeric set (digits, A-Z, space, $%*+-./:). */
export function isAlphanumeric(text) {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 128 || ALNUM_VALUE[c] < 0) return false;
  }
  return true;
}
function isNumeric(text) {
  return /^[0-9]*$/.test(text);
}

/** UTF-8 bytes of a string, written by hand (lone surrogates become U+FFFD, as TextEncoder does). */
export function utf8Encode(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const d = str.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; } else c = 0xfffd;
    } else if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

/** Strict UTF-8 decoding: the string, or null when the bytes are not valid UTF-8. */
export function utf8Decode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    let cp;
    let need;
    if (b < 0x80) { cp = b; need = 0; } else if (b >= 0xc2 && b <= 0xdf) { cp = b & 31; need = 1; } else if (b >= 0xe0 && b <= 0xef) { cp = b & 15; need = 2; } else if (b >= 0xf0 && b <= 0xf4) { cp = b & 7; need = 3; } else return null;
    for (let k = 1; k <= need; k++) {
      const c = bytes[i + k];
      if (c === undefined || (c & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (c & 63);
    }
    if (need === 2 && (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff))) return null;
    if (need === 3 && (cp < 0x10000 || cp > 0x10ffff)) return null;
    s += String.fromCodePoint(cp);
    i += need + 1;
  }
  return s;
}
function latin1Decode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/**
 * How many characters fit (byte mode: how many BYTES, which is the character count only for ASCII).
 * mode 'alphanumeric', 'byte' or 'numeric'.
 */
export function capacity(version, level, mode) {
  const bits = blockLayout(version, level).dataTotal * 8 - 4 - COUNT_BITS[modeName(mode)];
  if (mode === 'alphanumeric') return Math.floor(bits / 11) * 2 + (bits % 11 >= 6 ? 1 : 0);
  if (mode === 'byte') return Math.floor(bits / 8);
  if (mode === 'numeric') return Math.floor(bits / 10) * 3 + (bits % 10 >= 7 ? 2 : bits % 10 >= 4 ? 1 : 0);
  throw new RangeError('mode must be alphanumeric, byte or numeric');
}
function modeName(mode) {
  if (mode !== 'alphanumeric' && mode !== 'byte' && mode !== 'numeric') throw new RangeError('mode must be alphanumeric, byte or numeric');
  return mode;
}

class Bits {
  constructor() { this.a = []; }
  put(value, len) { for (let i = len - 1; i >= 0; i--) this.a.push((value >>> i) & 1); }
  get length() { return this.a.length; }
}

function pickMode(text, mode) {
  if (mode === 'auto') return isAlphanumeric(text) ? 'alphanumeric' : 'byte';
  if (mode === 'alphanumeric') {
    if (!isAlphanumeric(text)) throw new RangeError('text has characters outside the alphanumeric set');
    return mode;
  }
  if (mode === 'numeric') {
    if (!isNumeric(text)) throw new RangeError('numeric mode takes digits only');
    return mode;
  }
  if (mode === 'byte') return mode;
  throw new RangeError("mode must be 'auto', 'alphanumeric', 'byte' or 'numeric'");
}

// the segment's bits after the mode indicator and count (the same for versions 1 to 9)
function segmentBits(text, mode) {
  const bits = new Bits();
  let count;
  if (mode === 'alphanumeric') {
    count = text.length;
    for (let i = 0; i + 1 < text.length; i += 2) bits.put(ALNUM_VALUE[text.charCodeAt(i)] * 45 + ALNUM_VALUE[text.charCodeAt(i + 1)], 11);
    if (text.length % 2) bits.put(ALNUM_VALUE[text.charCodeAt(text.length - 1)], 6);
    return { bits, count, bytes: null };
  }
  if (mode === 'numeric') {
    count = text.length;
    for (let i = 0; i < text.length; i += 3) {
      const chunk = text.slice(i, i + 3);
      bits.put(parseInt(chunk, 10), chunk.length * 3 + 1);
    }
    return { bits, count, bytes: null };
  }
  const bytes = utf8Encode(text);
  for (const v of bytes) bits.put(v, 8);
  return { bits, count: bytes.length, bytes };
}

function hasNonAscii(bytes) {
  for (const v of bytes) if (v >= 0x80) return true;
  return false;
}

// ------------------------------------------------------------------------------------------------
// Function patterns and the zigzag placement order, per version (cached)
// ------------------------------------------------------------------------------------------------
export const ROLE = Object.freeze({ data: 0, finder: 1, timing: 2, alignment: 3, formatA: 4, formatB: 5, dark: 6, remainder: 7 });
const PLACE_CACHE = new Map();

function placement(version) {
  let P = PLACE_CACHE.get(version);
  if (P) return P;
  const size = 17 + 4 * version;
  const role = new Uint8Array(size * size);
  const base = new Uint8Array(size * size);
  const put = (x, y, dark, r) => { base[y * size + x] = dark ? 1 : 0; role[y * size + x] = r; };
  // finder patterns with their separators (role 1)
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        put(x, y, d !== 2 && d !== 4, ROLE.finder);
      }
    }
  }
  // timing patterns (role 2)
  for (let i = 8; i <= size - 9; i++) {
    put(i, 6, i % 2 === 0, ROLE.timing);
    put(6, i, i % 2 === 0, ROLE.timing);
  }
  // the one alignment pattern of versions 2 to 6, centred at (size - 7, size - 7) (role 3)
  if (version >= 2) {
    const c = size - 7;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) put(c + dx, c + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1, ROLE.alignment);
    }
  }
  // format information: bit i (0 = least significant) of the 15-bit word, two copies
  const formatA = new Int16Array(15);
  const formatB = new Int16Array(15);
  for (let i = 0; i < 15; i++) {
    let x;
    let y;
    if (i <= 5) { x = 8; y = i; } else if (i === 6) { x = 8; y = 7; } else if (i === 7) { x = 8; y = 8; } else if (i === 8) { x = 7; y = 8; } else { x = 14 - i; y = 8; }
    formatA[i] = y * size + x;
    role[y * size + x] = ROLE.formatA;
    if (i <= 7) { x = size - 1 - i; y = 8; } else { x = 8; y = size - 15 + i; }
    formatB[i] = y * size + x;
    role[y * size + x] = ROLE.formatB;
  }
  // the dark module (role 6)
  put(8, size - 8, true, ROLE.dark);

  // zigzag: column pairs from the right edge, alternately upward and downward, skipping column 6
  const order = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const y = upward ? size - 1 - step : step;
      for (let k = 0; k < 2; k++) {
        const x = right - k;
        if (role[y * size + x] === ROLE.data) order.push(y * size + x);
      }
    }
    upward = !upward;
  }
  const total = blockLayout(version, 'L').total;
  const remainder = order.length - total * 8;
  if (remainder < 0 || remainder > 7) throw new Error('internal: data region does not match the codeword count');
  for (let k = total * 8; k < order.length; k++) role[order[k]] = ROLE.remainder;
  P = { version, size, role, base, order: Int16Array.from(order), formatA, formatB, total, remainder };
  PLACE_CACHE.set(version, P);
  return P;
}

/** The mask condition: true where mask m flips the module in row y, column x. */
export function maskBit(mask, x, y) {
  switch (mask) {
    case 0: return (y + x) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (y + x) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return ((y * x) % 2) + ((y * x) % 3) === 0;
    case 6: return (((y * x) % 2) + ((y * x) % 3)) % 2 === 0;
    case 7: return (((y + x) % 2) + ((y * x) % 3)) % 2 === 0;
    default: throw new RangeError('mask must be 0 to 7');
  }
}
// per (version, mask) a Uint8Array of 0/1 over the whole grid, 1 where the mask flips a data module
const MASK_CACHE = new Map();
function maskGrid(version, mask) {
  const key = version * 8 + mask;
  let g = MASK_CACHE.get(key);
  if (g) return g;
  const P = placement(version);
  const size = P.size;
  g = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = P.role[y * size + x];
      if ((r === ROLE.data || r === ROLE.remainder) && maskBit(mask, x, y)) g[y * size + x] = 1;
    }
  }
  MASK_CACHE.set(key, g);
  return g;
}

// ------------------------------------------------------------------------------------------------
// Format information: 2 level bits + 3 mask bits, 10 BCH(15,5) check bits (generator 0x537), XOR 0x5412
// ------------------------------------------------------------------------------------------------
/** The 15-bit masked format word for a level and mask. */
export function formatBits(level, mask) {
  checkLevel(level);
  if (!Number.isInteger(mask) || mask < 0 || mask > 7) throw new RangeError('mask must be 0 to 7');
  const data = (LEVEL_BITS[level] << 3) | mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) if (rem & (1 << i)) rem ^= 0x537 << (i - 10);
  return ((data << 10) | rem) ^ 0x5412;
}
/** All 32 valid format words: [{level, mask, bits}]. */
export const FORMAT_TABLE = Object.freeze(
  LEVELS.flatMap((level) => [0, 1, 2, 3, 4, 5, 6, 7].map((mask) => Object.freeze({ level, mask, bits: formatBits(level, mask) }))),
);
function popcount15(v) {
  let c = 0;
  while (v) { c += v & 1; v >>>= 1; }
  return c;
}
function nearestFormat(bits) {
  let best = null;
  let bestD = 99;
  let tie = false;
  for (const f of FORMAT_TABLE) {
    const d = popcount15(bits ^ f.bits);
    if (d < bestD) { bestD = d; best = f; tie = false; } else if (d === bestD) tie = true;
  }
  return { bits, distance: bestD, level: best.level, mask: best.mask, unique: !tie };
}

// ------------------------------------------------------------------------------------------------
// Mask penalty (N1 = 3, N2 = 3, N3 = 40, N4 = 10). Rule 3 (see the header): one charge
// per dark-light-dark-dark-dark-light-dark run of single modules in a row or column that has four
// light modules right before it or right after it, where modules outside the symbol (the quiet
// zone) count as light.
// ------------------------------------------------------------------------------------------------
function penaltyOf(mods, size) {
  let p1 = 0;
  let p2 = 0;
  let p3 = 0;
  let dark = 0;
  const at = (x, y) => mods[y * size + x];
  for (let line = 0; line < 2; line++) {
    const get = line === 0 ? (a, b) => at(b, a) : (a, b) => at(a, b); // line 0: rows, line 1: columns
    for (let a = 0; a < size; a++) {
      let run = 1;
      for (let b = 1; b < size; b++) {
        if (get(a, b) === get(a, b - 1)) run++;
        else { if (run >= 5) p1 += 3 + run - 5; run = 1; }
      }
      if (run >= 5) p1 += 3 + run - 5;
      for (let b = 0; b + 6 < size; b++) {
        if (get(a, b) === 1 && get(a, b + 1) === 0 && get(a, b + 2) === 1 && get(a, b + 3) === 1 && get(a, b + 4) === 1 && get(a, b + 5) === 0 && get(a, b + 6) === 1) {
          let before = true;
          for (let c = Math.max(0, b - 4); c < b; c++) if (get(a, c)) { before = false; break; }
          let after = true;
          if (!before) for (let c = b + 7; c < Math.min(size, b + 11); c++) if (get(a, c)) { after = false; break; }
          if (before || after) p3 += 40;
        }
      }
    }
  }
  for (let y = 0; y + 1 < size; y++) {
    for (let x = 0; x + 1 < size; x++) {
      const c = at(x, y);
      if (c === at(x + 1, y) && c === at(x, y + 1) && c === at(x + 1, y + 1)) p2 += 3;
    }
  }
  for (let i = 0; i < mods.length; i++) dark += mods[i];
  const total = size * size;
  const k = Math.floor(Math.abs(dark * 20 - total * 10) / total);
  const p4 = 10 * k;
  return [p1, p2, p3, p4];
}

/** The four penalty scores [rule1, rule2, rule3, rule4] of any module grid. */
export function penaltyScores(modules, size) {
  return penaltyOf(modules, size);
}

// ------------------------------------------------------------------------------------------------
// Encoder
// ------------------------------------------------------------------------------------------------
/**
 * Choose the smallest version (1 to 6) that holds the text, or null when it does not fit.
 * opts: {level, mode, eci}
 */
export function chooseVersion(text, opts = {}) {
  const level = opts.level ?? 'H';
  checkLevel(level);
  const mode = pickMode(String(text), opts.mode ?? 'auto');
  const seg = segmentBits(String(text), mode);
  const eci = mode === 'byte' && wantsEci(seg.bytes, opts.eci);
  const need = (eci ? 12 : 0) + 4 + COUNT_BITS[mode] + seg.bits.length;
  for (let v = 1; v <= MAX_VERSION; v++) {
    if (seg.count < 1 << COUNT_BITS[mode] && need <= blockLayout(v, level).dataTotal * 8) return v;
  }
  return null;
}
function wantsEci(bytes, eciOpt) {
  if (eciOpt === true) return true;
  if (eciOpt === false || eciOpt === undefined || eciOpt === 'never') return false;
  if (eciOpt === 'auto') return hasNonAscii(bytes);
  throw new RangeError("eci must be false, true or 'auto'");
}

/**
 * Encode text as a QR code symbol.
 * opts: {level = 'H', version = 'auto' | 1..6, mask = 'auto' | 0..7, mode = 'auto' | 'alphanumeric' |
 *        'byte' | 'numeric', eci = false | true | 'auto'}
 * 'auto' mode picks alphanumeric when every character is in its 45-character set, else byte (UTF-8).
 * eci: false (the default) writes no ECI header; true always writes ECI 26 (UTF-8) before a byte
 * segment; 'auto' writes it only when the text has non-ASCII characters.
 * Throws a RangeError with code 'TOO_LONG' when the text does not fit the chosen or any version.
 */
export function encode(text, opts = {}) {
  text = String(text);
  const level = opts.level ?? 'H';
  checkLevel(level);
  const mode = pickMode(text, opts.mode ?? 'auto');
  const seg = segmentBits(text, mode);
  const eci = mode === 'byte' && wantsEci(seg.bytes, opts.eci);
  let version = opts.version ?? 'auto';
  if (version === 'auto') {
    version = chooseVersion(text, { level, mode, eci });
    if (version === null) {
      const err = new RangeError('text too long for a version 6 code at level ' + level);
      err.code = 'TOO_LONG';
      throw err;
    }
  } else checkVersion(version);

  const lay = blockLayout(version, level);
  const capBits = lay.dataTotal * 8;
  const bits = new Bits();
  if (eci) { bits.put(MODE_BITS.eci, 4); bits.put(26, 8); }
  bits.put(MODE_BITS[mode], 4);
  if (seg.count >= 1 << COUNT_BITS[mode]) {
    const err = new RangeError('text too long'); err.code = 'TOO_LONG'; throw err;
  }
  bits.put(seg.count, COUNT_BITS[mode]);
  for (const b of seg.bits.a) bits.a.push(b);
  const dataBits = bits.length;
  if (dataBits > capBits) {
    const err = new RangeError('text too long for version ' + version + '-' + level);
    err.code = 'TOO_LONG';
    throw err;
  }
  bits.put(0, Math.min(4, capBits - bits.length)); // terminator, shortened when the symbol is full
  if (bits.length % 8) bits.put(0, 8 - (bits.length % 8)); // pad to a whole byte
  const data = new Uint8Array(lay.dataTotal);
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let k = 0; k < 8; k++) v = (v << 1) | bits.a[i + k];
    data[i >> 3] = v;
  }
  for (let i = bits.length >> 3, pad = 0; i < lay.dataTotal; i++, pad++) data[i] = pad % 2 ? 0x11 : 0xec;

  // split into blocks, compute check bytes, interleave
  const map = streamMap(version, level);
  const stream = new Uint8Array(lay.total);
  const blocks = [];
  let offset = 0;
  for (const mb of map.blocks) {
    const bd = data.slice(offset, offset + mb.dataCount);
    offset += mb.dataCount;
    const ec = rsEncode(bd, mb.ecCount);
    for (let i = 0; i < mb.dataCount; i++) stream[mb.at[i]] = bd[i];
    for (let i = 0; i < mb.ecCount; i++) stream[mb.at[mb.dataCount + i]] = ec[i];
    blocks.push({
      dataCount: mb.dataCount, ecCount: mb.ecCount, reserve: lay.reserve,
      budget: lay.budget, maxTry: lay.maxTry, erasureBudget: lay.erasureBudget,
      data: bd, ec, at: mb.at.slice(),
    });
  }

  // place the bits (unmasked), then try the masks
  const P = placement(version);
  const size = P.size;
  const unmasked = P.base.slice();
  const cw = new Int16Array(size * size).fill(-1);
  const bit = new Int8Array(size * size).fill(-1);
  for (let k = 0; k < P.order.length; k++) {
    const idx = P.order[k];
    if (k < lay.total * 8) {
      const c = k >> 3;
      const b = 7 - (k & 7);
      unmasked[idx] = (stream[c] >> b) & 1;
      cw[idx] = c;
      bit[idx] = b;
    } else unmasked[idx] = 0; // remainder bits
  }
  const build = (m) => {
    const g = maskGrid(version, m);
    const mods = new Uint8Array(size * size);
    for (let i = 0; i < mods.length; i++) mods[i] = unmasked[i] ^ g[i];
    const f = formatBits(level, m);
    for (let i = 0; i < 15; i++) {
      const v = (f >> i) & 1;
      mods[P.formatA[i]] = v;
      mods[P.formatB[i]] = v;
    }
    return mods;
  };
  const penalties = [];
  const penaltyDetail = [];
  for (let m = 0; m < 8; m++) {
    const d = penaltyOf(build(m), size);
    penaltyDetail.push(d);
    penalties.push(d[0] + d[1] + d[2] + d[3]);
  }
  let mask = opts.mask ?? 'auto';
  if (mask === 'auto') {
    mask = 0;
    for (let m = 1; m < 8; m++) if (penalties[m] < penalties[mask]) mask = m;
  } else if (!Number.isInteger(mask) || mask < 0 || mask > 7) throw new RangeError('mask must be auto or 0 to 7');
  const modules = build(mask);
  const cwBlock = map.cwBlock.slice();
  const cwIndex = map.cwIndex.slice();
  return {
    version, level, mask, mode, size, text, eci: eci ? 26 : null,
    modules, role: P.role.slice(), cw, bit, stream, blocks, data,
    cwBlock, cwIndex,
    formatBits: formatBits(level, mask), penalties, penaltyDetail,
    dataBits, capacityBits: capBits, remainderBits: P.remainder,
  };
}

// ------------------------------------------------------------------------------------------------
// Decoder
// ------------------------------------------------------------------------------------------------
class BitReader {
  constructor(bytes) { this.bytes = bytes; this.pos = 0; this.len = bytes.length * 8; }
  left() { return this.len - this.pos; }
  read(n) {
    if (n > this.left()) return -1;
    let v = 0;
    for (let i = 0; i < n; i++, this.pos++) v = (v << 1) | ((this.bytes[this.pos >> 3] >> (7 - (this.pos & 7))) & 1);
    return v;
  }
}

function decodeBytes(bytes, eci) {
  if (eci === 26) return { text: utf8Decode(bytes) ?? lenientUtf8(bytes), charset: 'UTF-8' };
  if (eci === 1 || eci === 3) return { text: latin1Decode(bytes), charset: 'ISO-8859-1' };
  const u = utf8Decode(bytes);
  if (u !== null) return { text: u, charset: 'UTF-8 (guessed)' };
  return { text: latin1Decode(bytes), charset: 'ISO-8859-1 (default)' };
}
function lenientUtf8(bytes) {
  // decode valid runs, replace each bad byte with U+FFFD
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    let ok = false;
    for (let len = 1; len <= 4 && i + len <= bytes.length; len++) {
      const s = utf8Decode(bytes.subarray(i, i + len));
      if (s !== null && s.length > 0) { out += s; i += len; ok = true; break; }
    }
    if (!ok) { out += '�'; i++; }
  }
  return out;
}

// Parse the data codewords into segments. Returns {ok, text, segments, detail}.
function parseSegments(data, version) {
  const r = new BitReader(data);
  const segments = [];
  let text = '';
  let eci = null;
  let pending = [];
  const flush = () => {
    if (pending.length) {
      const d = decodeBytes(Uint8Array.from(pending), eci);
      text += d.text;
      segments[segments.length - 1].charset = d.charset;
      pending = [];
    }
  };
  const failed = (detail) => ({ ok: false, text: null, segments, detail });
  while (r.left() >= 4) {
    const mode = r.read(4);
    if (mode === 0) break; // terminator
    if (mode === MODE_BITS.numeric) {
      flush();
      const count = r.read(COUNT_BITS.numeric);
      if (count < 0) return failed('numeric count cut short');
      let s = '';
      for (let i = 0; i < count; i += 3) {
        const digits = Math.min(3, count - i);
        const v = r.read(digits * 3 + 1);
        if (v < 0) return failed('numeric data cut short');
        if (v >= 10 ** digits) return failed('numeric group out of range');
        s += String(v).padStart(digits, '0');
      }
      text += s;
      segments.push({ mode: 'numeric', count, text: s });
    } else if (mode === MODE_BITS.alphanumeric) {
      flush();
      const count = r.read(COUNT_BITS.alphanumeric);
      if (count < 0) return failed('alphanumeric count cut short');
      let s = '';
      for (let i = 0; i + 1 < count; i += 2) {
        const v = r.read(11);
        if (v < 0) return failed('alphanumeric data cut short');
        if (v >= 45 * 45) return failed('alphanumeric pair out of range');
        s += ALPHANUMERIC[Math.floor(v / 45)] + ALPHANUMERIC[v % 45];
      }
      if (count % 2) {
        const v = r.read(6);
        if (v < 0) return failed('alphanumeric data cut short');
        if (v >= 45) return failed('alphanumeric character out of range');
        s += ALPHANUMERIC[v];
      }
      text += s;
      segments.push({ mode: 'alphanumeric', count, text: s });
    } else if (mode === MODE_BITS.byte) {
      const count = r.read(COUNT_BITS.byte);
      if (count < 0) return failed('byte count cut short');
      const bytes = [];
      for (let i = 0; i < count; i++) {
        const v = r.read(8);
        if (v < 0) return failed('byte data cut short');
        bytes.push(v);
      }
      if (!pending.length) segments.push({ mode: 'byte', count, bytes: Uint8Array.from(bytes), eci });
      else {
        const last = segments[segments.length - 1];
        last.count += count;
        last.bytes = Uint8Array.from([...last.bytes, ...bytes]);
      }
      pending.push(...bytes);
    } else if (mode === MODE_BITS.eci) {
      flush();
      let v = r.read(8);
      if (v < 0) return failed('ECI cut short');
      if ((v & 0x80) === 0) { /* 7-bit value */ } else if ((v & 0xc0) === 0x80) {
        const w = r.read(8); if (w < 0) return failed('ECI cut short');
        v = ((v & 0x3f) << 8) | w;
      } else if ((v & 0xe0) === 0xc0) {
        const w = r.read(16); if (w < 0) return failed('ECI cut short');
        v = ((v & 0x1f) << 16) | w;
      } else return failed('bad ECI designator');
      eci = v;
      segments.push({ mode: 'eci', value: v });
    } else if (mode === 3) { // structured append header: skip it
      flush();
      if (r.read(16) < 0) return failed('structured append cut short');
      segments.push({ mode: 'structured-append' });
    } else if (mode === 5) { // FNC1 in first position
      flush();
      segments.push({ mode: 'fnc1' });
    } else if (mode === 9) {
      flush();
      if (r.read(8) < 0) return failed('FNC1 cut short');
      segments.push({ mode: 'fnc1' });
    } else if (mode === MODE_BITS.kanji) {
      return failed('kanji mode is not supported by this decoder');
    } else return failed('unknown mode indicator ' + mode);
  }
  flush();
  return { ok: true, text, segments, detail: null };
}

function readFormatWord(modules, positions) {
  let v = 0;
  for (let i = 0; i < 15; i++) if (modules[positions[i]]) v |= 1 << i;
  return v;
}

/**
 * Decode a module grid (1 = dark, index y * size + x). The version comes from the size.
 * opts (SPEC IC-3):
 *  - erasedModules: Uint8Array(size * size) | null: 1 where the page knows the scratch went; a codeword is an
 *    erasure when ANY of its modules is 1 here.
 *  - reference: the clean Sym | null: used ONLY to grade the result (Read.graded), never to decode.
 *  - limit: 'half' (default) accepts any block with 2e + s <= ecCount (what zxing-cpp and OpenCV do);
 *    'reserve' accepts only 2e + s <= ecCount - reserve (the standard's misdecode protection).
 *    (strict: true is an alias of limit: 'reserve'.)
 *  - fallbackFormat: {level, mask} | null: used ONLY when neither format copy is within 3 bits of a valid code.
 *    The Read then has ok false, reason 'format', format.used 'fallback', and dataOk tells whether the bytes
 *    alone would still decode (dataText holds what they say).
 *  - retryWithoutErasures: when true, a block that fails with erasures is retried as unknown errors only.
 * Returns a Read: {ok, text, reason, detail, dataOk, dataText, version, size, format, blocks, status, stream,
 *   corrected, erasedCodewords, segments, graded}; blocks[i] = {index, dataCount, ecCount, reserve, budget,
 *   maxTry, erasureBudget, ok, reason, errors, erasures, cost, room, safe, found, erased, retried}.
 */
export function decodeModules(modules, size, opts = {}) {
  const version = (size - 17) / 4;
  checkVersion(version);
  if (!modules || modules.length !== size * size) throw new RangeError('modules must have size * size entries');
  const erasedModules = opts.erasedModules ?? null;
  if (erasedModules && erasedModules.length !== size * size) throw new RangeError('erasedModules must have size * size entries');
  const reference = opts.reference ?? null;
  const limit = opts.limit ?? (opts.strict ? 'reserve' : 'half');
  if (limit !== 'half' && limit !== 'reserve') throw new RangeError("limit must be 'half' or 'reserve'");
  const fallbackFormat = opts.fallbackFormat ?? null;
  if (fallbackFormat) {
    checkLevel(fallbackFormat.level);
    if (!Number.isInteger(fallbackFormat.mask) || fallbackFormat.mask < 0 || fallbackFormat.mask > 7) throw new RangeError('fallbackFormat.mask must be 0 to 7');
  }
  const retry = !!(opts.retryWithoutErasures ?? opts.fallback);
  const P = placement(version);

  const copyA = nearestFormat(readFormatWord(modules, P.formatA));
  const copyB = nearestFormat(readFormatWord(modules, P.formatB));
  const okA = copyA.distance <= 3 && copyA.unique;
  const okB = copyB.distance <= 3 && copyB.unique;
  let used = null;
  if (okA) used = 'A';
  if (okB && (used === null || copyB.distance < copyA.distance)) used = 'B';
  let level = null;
  let mask = null;
  if (used === 'A') ({ level, mask } = copyA);
  else if (used === 'B') ({ level, mask } = copyB);
  else if (fallbackFormat) { used = 'fallback'; ({ level, mask } = fallbackFormat); }
  const format = {
    ok: used === 'A' || used === 'B',
    level,
    mask,
    used,
    copies: [[copyA, okA], [copyB, okB]].map(([c, ok]) => ({ distance: c.distance, level: c.level, mask: c.mask, bits: c.bits, unique: c.unique, ok })),
  };
  const total = P.total;
  const read = {
    ok: false, text: null, reason: null, detail: null, dataOk: false, dataText: null, version, size, format,
    blocks: [], status: new Uint8Array(total), stream: new Uint8Array(total), corrected: null,
    erasedCodewords: [], segments: [], graded: null,
  };
  if (used === null) {
    read.reason = 'format';
    read.detail = 'neither copy of the format information is within 3 bits of a valid code';
    if (reference) read.graded = grade(read, modules, reference, P);
    return read;
  }
  const g = maskGrid(version, mask);
  const stream = read.stream;
  const erasedCw = new Uint8Array(total);
  for (let k = 0; k < total * 8; k++) {
    const idx = P.order[k];
    const v = (modules[idx] ? 1 : 0) ^ g[idx];
    if (v) stream[k >> 3] |= 1 << (7 - (k & 7));
    if (erasedModules && erasedModules[idx]) erasedCw[k >> 3] = 1;
  }
  for (let c = 0; c < total; c++) if (erasedCw[c]) read.erasedCodewords.push(c);

  const map = streamMap(version, level);
  const corrected = stream.slice();
  let allOk = true;
  const dataOut = [];
  const reserve = map.layout.reserve;
  map.blocks.forEach((mb, bi) => {
    const n = mb.at.length;
    const received = new Uint8Array(n);
    const eras = [];
    for (let i = 0; i < n; i++) {
      received[i] = stream[mb.at[i]];
      if (erasedCw[mb.at[i]]) eras.push(i);
    }
    let res = rsDecode(received, mb.ecCount, eras);
    let retried = false;
    if (!res.ok && eras.length && retry) {
      const again = rsDecode(received, mb.ecCount, []);
      if (again.ok) { res = again; retried = true; }
    }
    const usedEras = retried ? [] : eras;
    let ok = res.ok;
    let reason = res.reason;
    const errors = res.errorPositions.length;
    const cost = 2 * errors + usedEras.length;
    if (ok && limit === 'reserve' && cost > mb.ecCount - reserve) { ok = false; reason = 'reserve'; }
    read.blocks.push({
      index: bi,
      dataCount: mb.dataCount,
      ecCount: mb.ecCount,
      reserve,
      budget: Math.floor((mb.ecCount - reserve) / 2),
      maxTry: Math.floor(mb.ecCount / 2),
      erasureBudget: mb.ecCount - reserve,
      ok,
      reason: ok ? null : reason,
      errors: ok ? errors : null,
      erasures: usedEras.length,
      cost: ok ? cost : null,
      room: ok ? mb.ecCount - cost : null, // check bytes still unused: one more unknown error needs 2, one more erasure 1
      safe: ok && cost <= mb.ecCount - reserve,
      found: ok ? res.errorPositions.map((i) => mb.at[i]) : [],
      erased: eras.map((i) => mb.at[i]),
      retried,
    });
    if (ok) {
      for (let i = 0; i < n; i++) corrected[mb.at[i]] = res.corrected[i];
      for (const i of usedEras) read.status[mb.at[i]] = 3;
      for (const i of res.errorPositions) read.status[mb.at[i]] = 1;
      dataOut.push(...res.corrected.subarray(0, mb.dataCount));
    } else {
      allOk = false;
      for (let i = 0; i < n; i++) read.status[mb.at[i]] = 2;
    }
  });
  read.corrected = corrected;
  let parsed = null;
  if (allOk) {
    parsed = parseSegments(Uint8Array.from(dataOut), version);
    read.segments = parsed.segments;
    read.dataOk = parsed.ok;
    if (parsed.ok) read.dataText = parsed.text;
  }
  if (!format.ok) {
    read.reason = 'format';
    read.detail = 'neither copy of the format information is within 3 bits of a valid code; the bytes were read with the fallback format ' + level + ' mask ' + mask + (read.dataOk ? ' and would decode' : ' and would not decode');
  } else if (!allOk) {
    read.reason = 'block';
    const bad = read.blocks.filter((b) => !b.ok).map((b) => b.index + 1);
    read.detail = 'block' + (bad.length > 1 ? 's ' : ' ') + bad.join(', ') + ' could not be repaired';
  } else if (!parsed.ok) {
    read.reason = 'parse';
    read.detail = parsed.detail;
  } else {
    read.ok = true;
    read.text = parsed.text;
  }
  if (reference) read.graded = grade(read, modules, reference, P);
  return read;
}

// Grading against the clean symbol (SPEC IC-4). Module-based, so it is right whatever format the decoder used.
function grade(read, modules, ref, P) {
  const size = P.size;
  const total = P.total;
  const structure = { finder: [0, 0, 0], formatA: 0, formatB: 0, timing: 0, alignment: 0, dark: 0, data: 0, remainder: 0 };
  const cwChanged = new Uint8Array(total);
  for (let i = 0; i < size * size; i++) {
    if ((modules[i] ? 1 : 0) === ref.modules[i]) continue;
    const r = P.role[i];
    if (r === ROLE.finder) {
      const x = i % size;
      const y = (i - x) / size;
      structure.finder[x > size / 2 ? 1 : y > size / 2 ? 2 : 0]++;
    } else structure[['data', null, 'timing', 'alignment', 'formatA', 'formatB', 'dark', 'remainder'][r]]++;
    if (ref.cw[i] >= 0) cwChanged[ref.cw[i]] = 1;
  }
  const changed = [];
  for (let c = 0; c < total; c++) if (cwChanged[c]) changed.push(c);
  const trueBroken = ref.blocks.map((b) => {
    let k = 0;
    for (const c of b.at) if (cwChanged[c]) k++;
    return k;
  });
  const formatFlipped = read.format.copies.map((c) => popcount15(c.bits ^ ref.formatBits));
  const formatWrong = read.format.used !== null && (read.format.level !== ref.level || read.format.mask !== ref.mask);
  let blocks = [];
  let miscorrected = false;
  let located = null;
  if (read.corrected) {
    const map = streamMap(read.version, read.format.level);
    located = new Uint8Array(total);
    blocks = read.blocks.map((b) => {
      const at = map.blocks[b.index].at;
      let nChanged = 0;
      let wrongAfter = 0;
      for (let i = 0; i < at.length; i++) {
        if (cwChanged[at[i]]) nChanged++;
        if (read.corrected[at[i]] !== ref.stream[at[i]]) wrongAfter++;
      }
      if (b.ok) {
        for (const c of b.found) located[c] = 1;
        if (!b.retried) for (const c of b.erased) located[c] = 1;
      }
      const mis = b.ok && wrongAfter > 0;
      if (mis) miscorrected = true;
      return { index: b.index, changed: nChanged, ok: b.ok, miscorrected: mis };
    });
  }
  const textWrong = read.ok && read.text !== ref.text;
  if (textWrong) miscorrected = true;
  const allOk = read.blocks.length > 0 && read.blocks.every((b) => b.ok);
  const allFound = !formatWrong && allOk && !miscorrected && changed.every((c) => located[c]);
  const broken = read.corrected ? changed.filter((c) => read.status[c] === 2) : changed.slice();
  return {
    changed, broken, trueBroken, structure, formatFlipped, formatWrong, miscorrected,
    wrongText: textWrong ? read.text : null, allFound, blocks,
    roles: structure, // deprecated alias (the first drafts of qr.js used this name)
  };
}

// ------------------------------------------------------------------------------------------------
// The second decode path: sample module centres from RGBA pixels (SPEC 6.4)
// ------------------------------------------------------------------------------------------------
/**
 * Sample each module centre and threshold it.
 * opts: {originX, originY, modulePx, size, threshold = 'midpoint' | 'otsu' | number 0..255, spread = null}
 * originX/Y: the pixel position of the top-left corner of module (0, 0) (not of the quiet zone);
 * modulePx: device pixels per module (may be fractional).
 * Each module's value is the mean luminance of a 3 x 3 patch of device pixels centred on the pixel that holds
 * the module centre (or, with spread = f, of 9 pixels at the centre +/- f * modulePx). Luminance is
 * 0.299 R + 0.587 G + 0.114 B on the stored sRGB values, composited over white by alpha.
 * threshold 'midpoint' (default): halfway between the darkest and the lightest module mean (128 when the
 * two differ by less than 16, a one-tone picture); 'otsu': Otsu's split of the module means; or a fixed number.
 * Returns {modules, luma, threshold, margin, darkest, lightest}; margin is the smallest distance of any module
 * mean from the threshold (0 to 255; small means an ambiguous picture).
 */
export function samplePixels(rgba, width, height, opts) {
  const { originX, originY, modulePx, size } = opts;
  const spread = opts.spread ?? null;
  if (!(modulePx > 0)) throw new RangeError('modulePx must be positive');
  if (!Number.isInteger(size) || size < 1) throw new RangeError('size must be a positive integer');
  const luma = new Float32Array(size * size);
  const lumAt = (px, py) => {
    const x = Math.min(width - 1, Math.max(0, px));
    const y = Math.min(height - 1, Math.max(0, py));
    const i = (y * width + x) * 4;
    const a = rgba[i + 3] / 255;
    return a * (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) + (1 - a) * 255;
  };
  let darkest = 255;
  let lightest = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = originX + (x + 0.5) * modulePx;
      const cy = originY + (y + 0.5) * modulePx;
      let sum = 0;
      if (spread === null) {
        const px = Math.floor(cx);
        const py = Math.floor(cy);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += lumAt(px + dx, py + dy);
      } else {
        const o = spread * modulePx;
        for (const oy of [-o, 0, o]) for (const ox of [-o, 0, o]) sum += lumAt(Math.floor(cx + ox), Math.floor(cy + oy));
      }
      const m = sum / 9;
      luma[y * size + x] = m;
      if (m < darkest) darkest = m;
      if (m > lightest) lightest = m;
    }
  }
  let threshold = opts.threshold ?? 'midpoint';
  if (threshold === 'midpoint') threshold = lightest - darkest < 16 ? 128 : (darkest + lightest) / 2;
  else if (threshold === 'otsu') threshold = otsu(luma);
  else if (!(typeof threshold === 'number' && threshold >= 0 && threshold <= 255)) throw new RangeError("threshold must be 'midpoint', 'otsu' or 0 to 255");
  const modules = new Uint8Array(size * size);
  let margin = 255;
  for (let i = 0; i < luma.length; i++) {
    modules[i] = luma[i] < threshold ? 1 : 0;
    margin = Math.min(margin, Math.abs(luma[i] - threshold));
  }
  return { modules, luma, threshold, margin, darkest, lightest };
}
function otsu(values) {
  const hist = new Float64Array(256);
  for (const v of values) hist[Math.max(0, Math.min(255, Math.round(v)))]++;
  const n = values.length;
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t];
  let w0 = 0;
  let sum0 = 0;
  let best = -1;
  let first = -1;
  let last = -1;
  // threshold t splits into {v < t} and {v >= t}
  for (let t = 1; t < 256; t++) {
    w0 += hist[t - 1];
    sum0 += (t - 1) * hist[t - 1];
    const w1 = n - w0;
    if (w0 === 0 || w1 === 0) continue;
    const m0 = sum0 / w0;
    const m1 = (sumAll - sum0) / w1;
    const between = w0 * w1 * (m0 - m1) * (m0 - m1);
    if (between > best * (1 + 1e-12)) { best = between; first = t; last = t; } else if (Math.abs(between - best) <= best * 1e-12) last = t;
  }
  if (first < 0) return 128;
  return (first + last) / 2;
}

/** The second decode path's module grid: samplePixels(...).modules. */
export function readPixels(rgba, width, height, opts) {
  return samplePixels(rgba, width, height, opts).modules;
}

// ------------------------------------------------------------------------------------------------
// Helpers for the page
// ------------------------------------------------------------------------------------------------
/** For each codeword of the stream, its 8 module indices, most significant bit first. */
export function codewordModules(sym) {
  const out = Array.from({ length: sym.stream.length }, () => new Array(8));
  for (let i = 0; i < sym.cw.length; i++) {
    const c = sym.cw[i];
    if (c >= 0) out[c][7 - sym.bit[i]] = i;
  }
  return out;
}

/**
 * The codewords a set of scratched modules touches. scratched: a Uint8Array(size * size) mask
 * (nonzero = scratched) or an iterable of module indices.
 * Returns {all: [streamIdx ascending], byBlock: [[streamIdx], ...], nonData: count of touched
 * modules outside the data codewords (function patterns, format, remainder bits)}.
 */
export function codewordsTouched(sym, scratched) {
  const n = sym.size * sym.size;
  const hit = new Uint8Array(sym.stream.length);
  let nonData = 0;
  const visit = (i) => {
    if (i < 0 || i >= n) return;
    const c = sym.cw[i];
    if (c >= 0) hit[c] = 1; else nonData++;
  };
  if (scratched instanceof Uint8Array && scratched.length === n) {
    for (let i = 0; i < n; i++) if (scratched[i]) visit(i);
  } else for (const i of scratched) visit(i);
  const all = [];
  const byBlock = sym.blocks.map(() => []);
  for (let c = 0; c < hit.length; c++) {
    if (!hit[c]) continue;
    all.push(c);
    byBlock[sym.cwBlock[c]].push(c);
  }
  return { all, byBlock, nonData };
}

/** Decode a symbol's own modules (or a damaged copy) with the clean symbol as the grading reference. */
export function decodeSym(sym, modules = sym.modules, opts = {}) {
  return decodeModules(modules, sym.size, { ...opts, reference: sym });
}
