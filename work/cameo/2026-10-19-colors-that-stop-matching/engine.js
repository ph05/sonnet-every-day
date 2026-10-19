// The color engine of "Colors That Stop Matching". Pure functions, no DOM.
//
// Spectra live on a grid from 380 to 780 nm every 5 nm (81 samples). A paint is 13 handle values at 400, 425, ..., 700 nm;
// a Catmull-Rom curve through them (zero slope at the ends, held level below 400 and above 700 nm) gives its reflectance
// curve on the grid. Every step from handles to the three cone signals is linear, which is what makes the "invisible
// wiggle" exact: a change the eye cannot see under a lamp is a change in the null space of a 3 x 13 matrix.
import { DATA } from './data.js';

export const N = DATA.count;
export const WL = Array.from({ length: N }, (_, i) => DATA.start + i * DATA.step);
export const HW = Array.from({ length: 13 }, (_, i) => 400 + 25 * i);
export const K = HW.length;

// ---- paint curves -------------------------------------------------------------------------------------------------------
/** B (N x K): reflectance on the grid = B times the handle values. Rows sum to 1, so a level curve stays level. */
export const B = (() => {
  const rows = [];
  for (const lam of WL) {
    const row = new Float64Array(K);
    if (lam <= 400) row[0] = 1;
    else if (lam >= 700) row[K - 1] = 1;
    else {
      const s = (lam - 400) / 25;
      let j = Math.floor(s);
      let t = s - j;
      if (j >= K - 1) { j = K - 2; t = 1; }
      const idx = [j - 1, j, j + 1, j + 2].map((q) => (q === -1 ? 1 : q === K ? K - 2 : q));
      const c = [0.5 * (-t + 2 * t * t - t ** 3), 0.5 * (2 - 5 * t * t + 3 * t ** 3), 0.5 * (t + 4 * t * t - 3 * t ** 3), 0.5 * (-t * t + t ** 3)];
      for (let q = 0; q < 4; q++) row[idx[q]] += c[q];
    }
    rows.push(row);
  }
  return rows;
})();
export function curve(h) {
  const r = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let s = 0;
    const row = B[i];
    for (let k = 0; k < K; k++) s += row[k] * h[k];
    r[i] = s;
  }
  return r;
}
/** Reflectance at any wavelength, read from the grid by linear interpolation (as the drawn curve shows it). */
export function at(R, lam) {
  const x = (lam - DATA.start) / DATA.step;
  const i = Math.max(0, Math.min(N - 2, Math.floor(x)));
  const t = x - i;
  return R[i] * (1 - t) + R[i + 1] * t;
}

// ---- lamps ----------------------------------------------------------------------------------------------------------------
function planck(T) {
  const c2 = 1.4388e-2;
  const v = WL.map((l) => { const m = l * 1e-9; return 1 / (m ** 5 * (Math.exp(c2 / (m * T)) - 1)); });
  const ref = v[(560 - DATA.start) / DATA.step];
  return v.map((x) => (100 * x) / ref);
}
export const LAMPS = {
  FL11: { kind: 'table', spd: DATA.lamps.FL11, name: 'Shop light', under: 'under the shop light', lower: 'shop light', subject: 'The shop light',  short: 'Shop', brief: 'Fluorescent tube · CIE FL11',  detail: 'Three-band fluorescent tube · CIE table FL11', source: 'CIE illuminant' },
  A: { kind: 'table', spd: DATA.lamps.A, name: 'Warm bulb', under: 'under the warm bulb', lower: 'warm bulb', subject: 'The warm bulb',  short: 'Warm bulb', brief: 'Filament bulb · CIE A',  detail: 'Filament bulb · CIE table A', source: 'CIE standard illuminant' },
  D65: { kind: 'table', spd: DATA.lamps.D65, name: 'Daylight', under: 'in daylight', lower: 'daylight', subject: 'Daylight',  short: 'Day', brief: 'Daylight · CIE D65',  detail: 'Average daylight · CIE table D65', source: 'CIE standard illuminant' },
  'LED-B2': { kind: 'table', spd: DATA.lamps['LED-B2'], name: 'Warm LED', under: 'under the warm LED', lower: 'warm LED', subject: 'The warm LED',  short: 'Warm LED', brief: 'LED bulb · CIE LED-B2',  detail: 'Warm white LED bulb · CIE table LED-B2', source: 'CIE illuminant' },
  sodium: { kind: 'line', nm: 589, cmf: DATA.cmf589, name: 'Sodium street lamp', under: 'under the sodium street lamp', lower: 'sodium lamp', subject: 'The sodium street lamp',  short: 'Sodium', brief: 'Modeled · 589 nm line',  detail: 'Modeled by this page · one line at 589 nm', source: 'modeled' },
  P3999: { kind: 'table', spd: planck(3999), name: 'Smooth glow, shop-light color', under: 'under the smooth glow', lower: 'smooth glow', subject: 'The smooth glow',  short: 'Smooth glow', brief: 'Modeled · smooth glow',  detail: "Modeled by this page · a smooth glow of the shop light's color", source: 'modeled' },
};
export const LAMP_IDS = Object.keys(LAMPS);
/** A dimmer between the shop light and the warm bulb: both lamps on, crossfaded at equal brightness, t from 0 to 1 in
 *  steps of 1%. Returns a lamp id (FL11 and A at the ends); the mixes are not in LAMP_IDS. */
export function mixLamp(t) {
  const p = Math.round(Math.min(1, Math.max(0, t)) * 100);
  if (p === 0) return 'FL11';
  if (p === 100) return 'A';
  const id = `MIX${p}`;
  if (!LAMPS[id]) {
    const Y = (spd) => spd.reduce((s, v, i) => s + v * DATA.cmf.y[i], 0);
    const yF = Y(LAMPS.FL11.spd), yA = Y(LAMPS.A.spd);
    const spd = LAMPS.FL11.spd.map((v, i) => ((100 - p) / 100) * (v / yF) + (p / 100) * (LAMPS.A.spd[i] / yA));
    const m = Math.max(...spd);
    LAMPS[id] = { kind: 'table', spd: spd.map((v) => (100 * v) / m), name: 'Shop light + warm bulb', under: 'under the mixed light', lower: 'mixed light', subject: 'The mixed light', short: 'Mix', brief: `${100 - p}% shop · ${p}% warm bulb`, detail: `Both on: ${100 - p}% shop light, ${p}% warm bulb, same brightness`, source: 'modeled' };
  }
  return id;
}

const MAT = new Map();
/** 3 x N matrix M with XYZ = M R, scaled so a perfect white reflector has Y = 1 under this lamp. */
export function lampMatrix(id) {
  if (MAT.has(id)) return MAT.get(id);
  const L = LAMPS[id];
  const M = [new Float64Array(N), new Float64Array(N), new Float64Array(N)];
  if (L.kind === 'line') {
    const x = (L.nm - DATA.start) / DATA.step;
    const i = Math.floor(x);
    const t = x - i;
    for (let c = 0; c < 3; c++) { M[c][i] = (1 - t) * L.cmf[c]; M[c][i + 1] = t * L.cmf[c]; }
  } else {
    const { x, y, z } = DATA.cmf;
    for (let i = 0; i < N; i++) { M[0][i] = x[i] * L.spd[i]; M[1][i] = y[i] * L.spd[i]; M[2][i] = z[i] * L.spd[i]; }
  }
  let k = 0;
  for (let i = 0; i < N; i++) k += M[1][i];
  for (let c = 0; c < 3; c++) for (let i = 0; i < N; i++) M[c][i] /= k;
  MAT.set(id, M);
  return M;
}
export function XYZ(R, id) {
  const M = lampMatrix(id);
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    let s = 0;
    for (let i = 0; i < N; i++) s += M[c][i] * R[i];
    out[c] = s;
  }
  return out;
}
const ONES = new Float64Array(N).fill(1);
const WHITES = new Map();
export function white(id) {
  if (!WHITES.has(id)) WHITES.set(id, XYZ(ONES, id));
  return WHITES.get(id);
}
export const chroma = (v) => { const s = v[0] + v[1] + v[2]; return [v[0] / s, v[1] / s]; };
/** A lamp's spectrum for drawing: values scaled to the peak inside 400-700 nm, or a single line. */
export function lampSpectrum(id) {
  const L = LAMPS[id];
  if (L.kind === 'line') return { kind: 'line', nm: L.nm };
  let peak = 0;
  for (let i = 0; i < N; i++) if (WL[i] >= 400 && WL[i] <= 700) peak = Math.max(peak, L.spd[i]);
  return { kind: 'table', values: L.spd.map((v) => v / peak) };
}
/** Share of a lamp's 400-700 nm power that lies in [lo, hi] nm. */
export function powerShare(id, lo, hi) {
  const L = LAMPS[id];
  if (L.kind === 'line') return L.nm >= lo && L.nm <= hi ? 1 : 0;
  let a = 0, b = 0;
  for (let i = 0; i < N; i++) {
    if (WL[i] < 400 || WL[i] > 700) continue;
    b += L.spd[i];
    if (WL[i] >= lo && WL[i] <= hi) a += L.spd[i];
  }
  return a / b;
}

// ---- CIELAB (against the lamp's own white) and CIEDE2000 ---------------------------------------------------------------------
export function labOf(v, w) {
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(v[0] / w[0]), fy = f(v[1] / w[1]), fz = f(v[2] / w[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
export const lab = (R, id) => labOf(XYZ(R, id), white(id));
const DEG = Math.PI / 180;
/** CIEDE2000 (kL = kC = kH = 1) after Sharma, Wu and Dalal (2005). A hue difference of exactly 180 degrees takes the
 *  "<= 180" branch (1e-9 tolerance), which gives their pair 14 its published 4.8045 on every platform. */
export function dE00(l1, l2) {
  const [L1, a1, b1] = l1;
  const [L2, a2, b2] = l2;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const hp = (b, ap) => (b === 0 && ap === 0 ? 0 : (Math.atan2(b, ap) / DEG + 360) % 360);
  const h1p = hp(b1, a1p), h2p = hp(b2, a2p);
  const dLp = L2 - L1, dCp = C2p - C1p;
  const EPS = 1e-9;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    const d = h2p - h1p;
    dhp = Math.abs(d) <= 180 + EPS ? d : d > 180 ? d - 360 : d + 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * DEG);
  const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180 + EPS) hbp = (h1p + h2p) / 2;
    else hbp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  }
  const T = 1 - 0.17 * Math.cos((hbp - 30) * DEG) + 0.24 * Math.cos(2 * hbp * DEG) + 0.32 * Math.cos((3 * hbp + 6) * DEG) - 0.2 * Math.cos((4 * hbp - 63) * DEG);
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const RC = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const SL = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const SC = 1 + 0.045 * Cbp, SH = 1 + 0.015 * Cbp * T;
  const RT = -Math.sin(2 * dTheta * DEG) * RC;
  return Math.sqrt((dLp / SL) ** 2 + (dCp / SC) ** 2 + (dHp / SH) ** 2 + RT * (dCp / SC) * (dHp / SH));
}
/** CIEDE2000 between two reflectance curves under one lamp. */
export const diff = (R1, R2, id) => dE00(lab(R1, id), lab(R2, id));
/** The same difference for the CIE 1964 10-degree observer (large fields of view), under a lamp given by a table. The page
 *  uses the 1931 observer everywhere else; this one only checks that Pebble and Fog also match for a second standard eye. */
export function diff10(R1, R2, id) {
  const spd = LAMPS[id].spd, { x, y, z } = DATA.cmf10;
  let k = 0;
  for (let i = 0; i < N; i++) k += y[i] * spd[i];
  const xyz = (R) => {
    const o = [0, 0, 0];
    for (let i = 0; i < N; i++) { const e = spd[i] * R[i] / k; o[0] += x[i] * e; o[1] += y[i] * e; o[2] += z[i] * e; }
    return o;
  };
  const w = xyz(ONES);
  return dE00(labOf(xyz(R1), w), labOf(xyz(R2), w));
}
/** The page's words for a difference: below 1 and 1 to 2 follow the usual gloss; 5 is the page's own band. */
export function verdict(d) {
  // judged on the number as the page prints it (one decimal), so the word and the number never disagree
  const r = +d.toFixed(1);
  if (r < 1) return 'Identical to the eye';
  if (r < 2) return 'Nearly identical';
  if (r < 5) return 'Noticeably different';
  return 'Clearly different';
}

// ---- the three cone signals: Hunt-Pointer-Estevez (a linear map of XYZ), relative to a white sheet under the same lamp ------
const HPE = [[0.38971, 0.68898, -0.07868], [-0.22981, 1.1834, 0.04641], [0, 0, 1]];
const mul3 = (M, v) => M.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
export function cones(R, id) {
  const c = mul3(HPE, XYZ(R, id));
  const w = mul3(HPE, white(id));
  return [c[0] / w[0], c[1] / w[1], c[2] / w[2]];
}
export const conesOfXYZ = (v, id) => { const c = mul3(HPE, v), w = mul3(HPE, white(id)); return [c[0] / w[0], c[1] / w[1], c[2] / w[2]]; };
/** The cone sensitivity curves of this model (HPE applied to the CIE 1931 functions), each scaled to a peak of 1. */
export const coneCurves = (() => {
  const { x, y, z } = DATA.cmf;
  const out = [new Float64Array(N), new Float64Array(N), new Float64Array(N)];
  for (let i = 0; i < N; i++) {
    const v = mul3(HPE, [x[i], y[i], z[i]]);
    for (let c = 0; c < 3; c++) out[c][i] = Math.max(0, v[c]);
  }
  return out.map((a) => { const m = Math.max(...a); return a.map((v) => v / m); });
})();

// ---- display: partial Bradford adaptation toward D65, auto exposure, sRGB (IEC 61966-2-1) ---------------------------------------
/** Degree of adaptation: the page keeps 40 percent of each lamp's tint (your eye would remove more of it). */
export const ADAPT = 0.6;
const BRAD = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]];
const TO_RGB = [[3.2406, -1.5372, -0.4986], [-0.9689, 1.8758, 0.0415], [0.0557, -0.204, 1.057]];
function inv3(m) {
  const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2];
  const A = e * i - f * h, Bq = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * Bq + c * C;
  return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det], [Bq / det, (a * i - c * g) / det, -(a * f - c * d) / det], [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
}
const BRADI = inv3(BRAD);
const TO_XYZ = inv3(TO_RGB);
export const D65W = [0.95047, 1, 1.08883];
/** von Kries in the Bradford space with degree D (D = 1: full adaptation to D65). */
export function adapt(v, srcWhite, D = ADAPT) {
  const s = mul3(BRAD, srcWhite), d = mul3(BRAD, D65W), x = mul3(BRAD, v);
  return mul3(BRADI, x.map((q, k) => q * (D * (d[k] / s[k]) + 1 - D)));
}
/** The chips' white card has reflectance 0.80; the wall 0.70. The card is the exposure reference. */
export const CARD = 0.8, WALL = 0.7;
const EXPO = new Map();
/** The "eye adjusts to brightness" step: the card's brightest linear channel lands at 0.95 under every lamp. */
export function exposure(id) {
  if (!EXPO.has(id)) {
    const w = white(id);
    const rgb = mul3(TO_RGB, adapt(w.map((q) => q * CARD), w));
    EXPO.set(id, 0.95 / Math.max(...rgb));
  }
  return EXPO.get(id);
}
const linOfXYZ = (v, id) => { const e = exposure(id); return mul3(TO_RGB, adapt(v, white(id))).map((q) => q * e); };
/** Linear sRGB of a reflectance curve under a lamp, before any gamut fitting (may leave 0..1). */
export const linearRGB = (R, id) => linOfXYZ(XYZ(R, id), id);
/** Linear sRGB of a flat reflectance (the wall, the card) under a lamp. */
export const flatRGB = (level, id) => linOfXYZ(white(id).map((q) => q * level), id);
export const clipped = (rgb) => rgb.some((q) => q < -1e-4 || q > 1 + 1e-4);
const lum = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
/** Bring a color inside sRGB by moving it toward the lamp's (tinted) gray of the same luminance; never changes an
 *  in-gamut color. Returns {rgb, clipped}. */
export function fitGamut(rgb, id) {
  if (!clipped(rgb)) return { rgb: rgb.map((q) => Math.min(1, Math.max(0, q))), clipped: false };
  const card = flatRGB(CARD, id);
  const y = Math.min(0.999, Math.max(0, lum(rgb)));
  const g = card.map((q) => (q * y) / lum(card));
  let t = 0;
  for (let c = 0; c < 3; c++) {
    if (rgb[c] > 1 && g[c] < rgb[c]) t = Math.max(t, (rgb[c] - 1) / (rgb[c] - g[c]));
    if (rgb[c] < 0 && g[c] > rgb[c]) t = Math.max(t, -rgb[c] / (g[c] - rgb[c]));
  }
  t = Math.min(1, t);
  return { rgb: rgb.map((q, c) => Math.min(1, Math.max(0, q + t * (g[c] - q)))), clipped: true };
}
/** What the page paints for a reflectance curve under a lamp. */
export const displayRGB = (R, id) => fitGamut(linearRGB(R, id), id);
const enc = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
export const encode = (rgb) => rgb.map((c) => Math.round(enc(Math.min(1, Math.max(0, c))) * 255));
export const hex = (rgb) => '#' + encode(rgb).map((v) => v.toString(16).padStart(2, '0')).join('');
export const mixLinear = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
/** The lamp's own light as a vivid glow color (only 25 percent adapted), scaled to a brightest channel of 1. */
export function glowRGB(id) {
  const w = white(id);
  const rgb = mul3(TO_RGB, adapt(w, w, 0.25)).map((q) => Math.max(0, q));
  const m = Math.max(...rgb);
  return rgb.map((q) => q / m);
}
/** CIELAB (D65) of a displayed linear sRGB color: used only to name what the visitor sees. */
export function labOfDisplay(rgb) {
  return labOf(mul3(TO_XYZ, rgb), D65W);
}
/** A plain name for a displayed color, from its CIELAB lightness, chroma and hue. */
export function colorName(l) {
  const [L, a, b] = l;
  const C = Math.hypot(a, b);
  const h = ((Math.atan2(b, a) / DEG) + 360) % 360;
  if (C < 5) return L > 85 ? 'off-white' : L > 62 ? 'light gray' : L > 38 ? 'gray' : 'dark gray';
  const deep = L < 52 ? 'deep ' : '';
  if (h >= 345 || h < 30) return C < 25 ? 'dusty rose' : 'rose';
  if (h < 62) return C < 14 ? 'rosy taupe' : C < 22 ? 'dusty rose' : deep + 'terracotta';
  if (h < 100) return C < 17 ? 'taupe' : C < 24 ? 'tan' : C < 40 ? 'mustard' : 'mustard yellow';
  if (h < 170) return C < 15 ? 'sage' : 'olive green';
  if (h < 250) return C < 15 ? 'blue-gray' : 'teal';
  if (h < 300) return C < 15 ? 'blue-gray' : L > 70 ? 'light blue' : 'blue';
  return C < 15 ? 'lilac gray' : C < 25 ? 'mauve' : 'violet';
}

// ---- what the eye cannot see: the color-preserving plane ------------------------------------------------------------------------
/** Orthonormal rows (in handle space) spanning what the eye can see under the given lamps: rank 3 per lamp with a spread
 *  spectrum, 1 for a single line. Stacking lamps stacks their rows. */
export function seenBasis(ids) {
  const list = Array.isArray(ids) ? ids : [ids];
  const Q = [];
  for (const id of list) {
    const M = lampMatrix(id);
    for (const row of M) {
      const r = new Float64Array(K);
      for (let i = 0; i < N; i++) { if (row[i] === 0) continue; for (let k = 0; k < K; k++) r[k] += row[i] * B[i][k]; }
      const v = Float64Array.from(r);
      for (const q of Q) { let d = 0; for (let k = 0; k < K; k++) d += v[k] * q[k]; for (let k = 0; k < K; k++) v[k] -= d * q[k]; }
      const nv = Math.hypot(...v), nr = Math.hypot(...r);
      if (nr > 0 && nv > 1e-9 * nr) Q.push(v.map((x) => x / nv));
    }
  }
  return Q;
}
/** The nearest handles to h with exactly h0's color under the lamps of Q. */
export function toPlane(h, h0, Q) {
  const out = Float64Array.from(h);
  for (const q of Q) {
    let d = 0;
    for (let k = 0; k < K; k++) d += q[k] * (out[k] - h0[k]);
    for (let k = 0; k < K; k++) out[k] -= d * q[k];
  }
  return out;
}
export const HLO = 0.03, HHI = 0.97;
/** Keep every grid sample in [0, 1] by pulling the change toward h0 along a straight line (keeps the color exactly). */
function pullInside(h, h0) {
  const r = curve(h), r0 = curve(h0);
  let s = 1;
  for (let i = 0; i < N; i++) {
    const d = r[i] - r0[i];
    if (d > 1e-12) s = Math.min(s, (1 - r0[i]) / d);
    else if (d < -1e-12) s = Math.min(s, (0 - r0[i]) / d);
  }
  return s < 1 ? h.map((v, k) => h0[k] + Math.max(0, s) * (v - h0[k])) : h;
}
/** The closest handles to `target` that keep h0's color under Q's lamps and keep every handle in [HLO, HHI]: Dykstra's
 *  alternating projections between the color-preserving plane and the box, an exact final projection, then pullInside. */
export function keepColour(target, h0, Q, iters = 40) {
  let x = Float64Array.from(target);
  const p = new Float64Array(K), q = new Float64Array(K);
  for (let it = 0; it < iters; it++) {
    const y = toPlane(x.map((v, k) => v + p[k]), h0, Q);
    for (let k = 0; k < K; k++) p[k] = x[k] + p[k] - y[k];
    const z = y.map((v, k) => Math.min(HHI, Math.max(HLO, v + q[k])));
    for (let k = 0; k < K; k++) q[k] = y[k] + q[k] - z[k];
    x = z;
  }
  return pullInside(toPlane(x, h0, Q), h0);
}
function solveSmall(M, b) {
  const n = b.length;
  const A = M.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    if (Math.abs(A[c][c]) < 1e-300) continue;
    for (let r = 0; r < n; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k]; }
  }
  return A.map((r, i) => (Math.abs(r[i]) < 1e-300 ? 0 : r[n] / r[i]));
}
function weightedPlane(t, h0, Q, w) {
  const m = Q.length;
  const G = [], rhs = [];
  for (let a = 0; a < m; a++) {
    G.push(Array.from({ length: m }, (_, b) => { let s = 0; for (let k = 0; k < K; k++) s += (Q[a][k] * Q[b][k]) / w[k]; return s; }));
    let s = 0;
    for (let k = 0; k < K; k++) s += Q[a][k] * (t[k] - h0[k]);
    rhs.push(s);
  }
  const lam = solveSmall(G, rhs);
  return Float64Array.from(t, (v, k) => v - Q.reduce((s, q, a) => s + q[k] * lam[a], 0) / w[k]);
}
/** One step of the brush at wavelength `lam` toward reflectance y. With Q the color under Q's lamps is held exactly: the
 *  handles near the pointer resist (weight 1 + 60 g) and the far handles compensate. */
export function brush(h, lam, y, Q = null, sigma = 18) {
  const g = HW.map((l) => Math.exp(-0.5 * ((l - lam) / sigma) ** 2));
  const cur = at(curve(h), lam);
  const t = Float64Array.from(h, (v, k) => v + g[k] * (y - cur));
  if (!Q || !Q.length) return t.map((v) => Math.min(HHI, Math.max(HLO, v)));
  const w = g.map((v) => 1 + 60 * v);
  let x = t;
  for (let it = 0; it < 30; it++) x = weightedPlane(x, h, Q, w).map((v) => Math.min(HHI, Math.max(HLO, v)));
  return pullInside(weightedPlane(x, h, Q, w), h);
}
/** Set handle k directly (keyboard editing) with the same color holding as the brush. */
export function nudge(h, k, delta, Q = null) {
  return brush(h, HW[k], Math.min(HHI, Math.max(HLO, h[k] + delta)), Q, 9);
}

// ---- seeded randomness, random paints, the lamp-lab experiment ----------------------------------------------------------------
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
/** A random smooth disturbance in handle space: a few bumps of random sign, position and width. */
export function randomBumps(r, count = 4, amp = 0.25) {
  const d = new Float64Array(K);
  for (let b = 0; b < count; b++) {
    const a = gauss(r) * amp, c = r() * (K - 1), w = 1 + r() * 1.5;
    for (let k = 0; k < K; k++) d[k] += a * Math.exp(-0.5 * ((k - c) / w) ** 2);
  }
  return d;
}
/** A wiggle: six slow random bumps added to h0 and made invisible under Q's lamps by keepColour. */
export function wiggleAt(w, t, env) {
  const target = Float64Array.from(w.h0, (v, k) => v + env * w.bumps.reduce((s, b, j) => s + Math.sin(w.om[j] * t * 2 + w.ph[j]) * b[k], 0));
  return keepColour(target, w.h0, w.Q);
}
/** Bumps for a wiggle of h0 under Q. A draw that would barely move the curve (less than `minMove` anywhere on the grid at
 *  five test moments) is replaced by the next seed, up to 12 draws; the largest mover wins. `nextSeed()` gives seeds. */
export function wiggleBumps(nextSeed, h0, Q, minMove = 0.28) {
  const R0 = curve(h0);
  let best = null;
  for (let tries = 0; tries < 12; tries++) {
    const r = rng(nextSeed());
    const c = {
      h0, Q,
      bumps: Array.from({ length: 6 }, () => randomBumps(r, 1, 0.4)),
      om: Array.from({ length: 6 }, () => 0.6 + r()), ph: Array.from({ length: 6 }, () => r() * 6.283),
    };
    let move = 0;
    for (const t of [0.9, 1.8, 2.7, 3.6, 4.5]) {
      const R = curve(wiggleAt(c, t, 1));
      for (let i = 0; i < N; i++) move = Math.max(move, Math.abs(R[i] - R0[i]));
    }
    c.move = move;
    if (!best || move > best.move) best = c;
    if (move >= minMove) break;
  }
  return best;
}
export function randomPaint(r) {
  const h = new Float64Array(K);
  let acc = 0;
  for (let k = 0; k < K; k++) { acc += gauss(r) * 0.08; h[k] = Math.min(0.9, Math.max(0.08, 0.45 + acc * 0.6)); }
  return h;
}
/** The lamp lab: random paints, each with a partner that matches it exactly under `match`; both judged under lamps a and b.
 *  Returns a stepper so the page can run it in small chunks: step(n) adds n pairs and returns the running summary. */
export function judge(seed = 1, match = 'A', a = 'FL11', b = 'P3999') {
  const r = rng(seed);
  const Q = seenBasis(match);
  const pairs = [];
  const summary = () => {
    const n = pairs.length;
    const med = (i) => { const s = pairs.map((p) => p[i]).sort((x, y) => x - y); return n ? s[Math.floor(n / 2)] : 0; };
    return { n, pairs, more: n ? pairs.filter((p) => p[0] > p[1]).length / n : 0, medA: med(0), medB: med(1), worstMatch: n ? Math.max(...pairs.map((p) => p[2])) : 0 };
  };
  return {
    step(count) {
      let made = 0;
      while (made < count) {
        const base = randomPaint(r);
        const d = randomBumps(r, 4, 0.25);
        const other = keepColour(base.map((v, k) => v + d[k]), base, Q);
        const R0 = curve(base), R1 = curve(other);
        let mv = 0;
        for (let i = 0; i < N; i++) mv = Math.max(mv, Math.abs(R1[i] - R0[i]));
        if (mv < 0.05) continue;
        pairs.push([diff(R0, R1, a), diff(R0, R1, b), diff(R0, R1, match)]);
        made++;
      }
      return summary();
    },
    summary,
  };
}

// ---- a modelled screen: three narrow bands ----------------------------------------------------------------------------------------
export const BANDS = [
  { name: 'red', nm: 618, fwhm: 28 },
  { name: 'green', nm: 532, fwhm: 32 },
  { name: 'blue', nm: 460, fwhm: 22 },
].map((b) => {
  const s = b.fwhm / 2.3548;
  const spd = WL.map((l) => Math.exp(-0.5 * ((l - b.nm) / s) ** 2));
  const { x, y, z } = DATA.cmf;
  const xyz = [0, 0, 0];
  for (let i = 0; i < N; i++) { xyz[0] += x[i] * spd[i]; xyz[1] += y[i] * spd[i]; xyz[2] += z[i] * spd[i]; }
  return { ...b, spd, xyz };
});
/** Band strengths that give exactly the target XYZ (any scale), and the shares of the total. */
export function bandWeights(target) {
  const M = [0, 1, 2].map((c) => BANDS.map((b) => b.xyz[c]));
  const w = solveSmall(M, target);
  const s = w.reduce((a, v) => a + v, 0);
  // power: each band's strength times its area (the light it actually gives out), as shares of the total
  const pw = w.map((v, j) => v * BANDS[j].spd.reduce((a2, x) => a2 + x, 0));
  const ps = pw.reduce((a2, v) => a2 + v, 0);
  return { w, shares: w.map((v) => v / s), power: pw.map((v) => v / ps), ok: w.every((v) => v >= 0) };
}
/** The light that leaves a mix of the bands, on the grid. */
export function bandLight(w) {
  return WL.map((_, i) => BANDS.reduce((s, b, j) => s + w[j] * b.spd[i], 0));
}
/** XYZ of a light on the grid (raw CMF sums, the scale of the band weights). */
export function xyzOfLight(spd) {
  const { x, y, z } = DATA.cmf;
  const out = [0, 0, 0];
  for (let i = 0; i < N; i++) { out[0] += x[i] * spd[i]; out[1] += y[i] * spd[i]; out[2] += z[i] * spd[i]; }
  return out;
}
/** The light leaving a paint under a lamp, on the grid, scaled like xyzOfLight so it compares with band light. */
export function paintLight(R, id) {
  const L = LAMPS[id];
  if (L.kind === 'line') return null;
  return L.spd.map((e, i) => e * R[i]);
}
