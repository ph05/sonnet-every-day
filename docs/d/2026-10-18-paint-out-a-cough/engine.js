// The sound engine of Paint Out a Cough. Pure functions, no DOM: worker.js uses it to draw and rebuild,
// selftest.js uses it to check known answers. Everything runs in double precision.

export const PICTURE_ROWS = 360; // rows of the picture, spaced on the mel scale
export const ERASE_DB = 60; // Erase turns painted cells down by this many decibels
export const BORDER_FRAMES = 4; // Fill in reads up to this many untouched frames on each side
export const HYBRID_RATIO = 2; // keep the measured phase where |X| <= 2 x the rebuilt level
export const NOISE_FLICKER = 0.3; // rows that flicker more than this (nepers per frame) count as noise
export const MAX_ROUNDS = 12; // masked Griffin-Lim rounds for short strokes
export const MIN_ROUNDS = 2; // and never fewer than this
export const BRUSH_CORE = 0.8; // full strength inside 80% of the brush radius
export const PAD_FRAMES = 6; // frames analysed beyond a region on each side
export const MERGE_FRAMES = 10; // strokes closer than this (in frames) are rebuilt together
export const STEP_RATIO = 2; // borders whose levels differ by more than this (6 dB) may be joined by a step
export const STEP_FIT = 0.5; // ...when a step explains the painted levels at least twice as well as a blend

// ------------------------------------------------------------------------------------------------
// Fourier transform: radix-2 complex FFT (bit-reversal swap list, first two stages merged, one twiddle
// table per stage) and a real FFT of length N through one complex FFT of length N/2.
// ------------------------------------------------------------------------------------------------

export function makeComplexFFT(n) {
  if (!(n >= 2) || (n & (n - 1)) !== 0) throw new Error('FFT size must be a power of two');
  const levels = Math.log2(n);
  const swaps = [];
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0, v = i; b < levels; b++, v >>= 1) r = (r << 1) | (v & 1);
    if (r > i) swaps.push(i, r);
  }
  const sw = Uint32Array.from(swaps);
  const offs = [];
  let total = 0;
  for (let half = 4; half < n; half <<= 1) { offs.push(total); total += half; }
  const tr = new Float64Array(total);
  const ti = new Float64Array(total);
  for (let half = 4, o = 0; half < n; half <<= 1) {
    for (let k = 0; k < half; k++, o++) { tr[o] = Math.cos((-Math.PI * k) / half); ti[o] = Math.sin((-Math.PI * k) / half); }
  }
  // forward transform in place (no scaling)
  function forward(re, im) {
    for (let s = 0; s < sw.length; s += 2) {
      const i = sw[s], j = sw[s + 1];
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
    if (n === 2) {
      const r0 = re[0], i0 = im[0];
      re[0] = r0 + re[1]; im[0] = i0 + im[1]; re[1] = r0 - re[1]; im[1] = i0 - im[1];
      return;
    }
    for (let a = 0; a < n; a += 4) {
      const r0 = re[a], i0 = im[a], r1 = re[a + 1], i1 = im[a + 1], r2 = re[a + 2], i2 = im[a + 2], r3 = re[a + 3], i3 = im[a + 3];
      const s0r = r0 + r1, s0i = i0 + i1, d0r = r0 - r1, d0i = i0 - i1;
      const s1r = r2 + r3, s1i = i2 + i3, d1r = r2 - r3, d1i = i2 - i3;
      re[a] = s0r + s1r; im[a] = s0i + s1i;
      re[a + 2] = s0r - s1r; im[a + 2] = s0i - s1i;
      re[a + 1] = d0r + d1i; im[a + 1] = d0i - d1r;
      re[a + 3] = d0r - d1i; im[a + 3] = d0i + d1r;
    }
    for (let half = 4, st = 0; half < n; half <<= 1, st++) {
      const size = half << 1;
      const o = offs[st];
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = tr[o + k], wi = ti[o + k];
          const a = start + k, b = a + half;
          const br = re[b], bi = im[b];
          const xr = br * wr - bi * wi, xi = br * wi + bi * wr;
          const ar = re[a], ai = im[a];
          re[b] = ar - xr; im[b] = ai - xi; re[a] = ar + xr; im[a] = ai + xi;
        }
      }
    }
  }
  // inverse without the 1/n scale: swapping re and im turns the forward transform into the inverse
  return { n, forward, inverse: (re, im) => forward(im, re) };
}

export function makeRealFFT(N) {
  const M = N / 2;
  const c = makeComplexFFT(M);
  const zr = new Float64Array(M);
  const zi = new Float64Array(M);
  const wr = new Float64Array(M + 1);
  const wi = new Float64Array(M + 1);
  for (let k = 0; k <= M; k++) { wr[k] = Math.cos((2 * Math.PI * k) / N); wi[k] = -Math.sin((2 * Math.PI * k) / N); }
  // x: N real samples; outRe, outIm: bins 0..N/2
  function forward(x, outRe, outIm) {
    for (let i = 0, j = 0; i < M; i++, j += 2) { zr[i] = x[j]; zi[i] = x[j + 1]; }
    c.forward(zr, zi);
    outRe[0] = zr[0] + zi[0]; outIm[0] = 0;
    outRe[M] = zr[0] - zi[0]; outIm[M] = 0;
    for (let k = 1; k < M; k++) {
      const ar = zr[k], ai = zi[k], br = zr[M - k], bi = -zi[M - k];
      const er = 0.5 * (ar + br), ei = 0.5 * (ai + bi), dr = 0.5 * (ar - br), di = 0.5 * (ai - bi);
      outRe[k] = er + wr[k] * di + wi[k] * dr;
      outIm[k] = ei - wr[k] * dr + wi[k] * di;
    }
  }
  // inRe, inIm: bins 0..N/2; out: N real samples, scaled by 1/N
  function inverse(inRe, inIm, out) {
    for (let k = 0; k < M; k++) {
      const ar = inRe[k], ai = inIm[k], br = inRe[M - k], bi = -inIm[M - k];
      const er = 0.5 * (ar + br), ei = 0.5 * (ai + bi), dr = 0.5 * (ar - br), di = 0.5 * (ai - bi);
      const or = dr * wr[k] + di * wi[k], oi = di * wr[k] - dr * wi[k];
      zr[k] = er - oi; zi[k] = ei + or;
    }
    c.inverse(zr, zi);
    const s = 1 / M;
    for (let i = 0, j = 0; i < M; i++, j += 2) { out[j] = zr[i] * s; out[j + 1] = zi[i] * s; }
  }
  return { N, bins: M + 1, forward, inverse };
}

export function periodicHann(N) {
  const w = new Float64Array(N);
  for (let n = 0; n < N; n++) w[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N);
  return w;
}

// Slice length for a sample rate and the window choice of the More panel.
export function stftSize(rate, choice = 'balanced') {
  const base = rate >= 32000 ? 2048 : 1024;
  return choice === 'short' ? base / 2 : choice === 'long' ? base * 2 : base;
}

// Frame f is centred on sample f*H and covers [f*H - N/2, f*H + N/2). With frames from -1 (hop N/4) every
// sample of [0, L) lies under exactly four frames, where the squared windows add to 1.5.
export function frameRange(L, N, H) {
  return { first: -Math.floor(N / (2 * H)) + 1, last: Math.floor((L - 1 + N / 2) / H) };
}

export function makeSTFT(N) {
  const H = N / 4;
  const fft = makeRealFFT(N);
  const w = periodicHann(N);
  const bins = N / 2 + 1;
  const buf = new Float64Array(N);
  // the overlap-added sum of w^2 at one sample position: 0 + 0.25 + 1 + 0.25 = 1.5 for Hann at hop N/4,
  // the same at every position (self-test 6)
  let wsq = 0;
  for (let n = 0; n < N; n += H) wsq += w[n] * w[n];
  // analyse frame f of a whole signal x
  function analyse(x, f, re, im) {
    const start = f * H - N / 2;
    const L = x.length;
    if (start >= 0 && start + N <= L) {
      for (let n = 0; n < N; n++) buf[n] = x[start + n] * w[n];
    } else {
      for (let n = 0; n < N; n++) { const i = start + n; buf[n] = i >= 0 && i < L ? x[i] * w[n] : 0; }
    }
    fft.forward(buf, re, im);
  }
  // analyse frame f from a local buffer whose sample 0 is absolute sample `origin`
  function analyseLocal(y, origin, f, re, im) {
    const start = f * H - N / 2 - origin;
    if (start >= 0 && start + N <= y.length) {
      for (let n = 0; n < N; n++) buf[n] = y[start + n] * w[n];
    } else {
      for (let n = 0; n < N; n++) { const i = start + n; buf[n] = i >= 0 && i < y.length ? y[i] * w[n] : 0; }
    }
    fft.forward(buf, re, im);
  }
  // add scale * w * inverse(re, im) for frame f into a local buffer (origin as above)
  function synthAdd(re, im, out, origin, f, scale) {
    fft.inverse(re, im, buf);
    const start = f * H - N / 2 - origin;
    for (let n = 0; n < N; n++) {
      const i = start + n;
      if (i >= 0 && i < out.length) out[i] += scale * w[n] * buf[n];
    }
  }
  return { N, H, bins, w, wsq, fft, analyse, analyseLocal, synthAdd };
}

// The full analysis and resynthesis of a whole signal with no edits (used by the self-test).
export function roundTrip(x, N) {
  const S = makeSTFT(N);
  const { first, last } = frameRange(x.length, N, S.H);
  const re = new Float64Array(S.bins);
  const im = new Float64Array(S.bins);
  const y = new Float64Array(x.length);
  for (let f = first; f <= last; f++) { S.analyse(x, f, re, im); S.synthAdd(re, im, y, 0, f, 1 / S.wsq); }
  return y;
}

// ------------------------------------------------------------------------------------------------
// The picture: 360 rows on the mel scale from 40 Hz to 12 kHz (or 0.95 x Nyquist), one column per frame.
// ------------------------------------------------------------------------------------------------

export const melOf = (f) => 2595 * Math.log10(1 + f / 700);
export const hzOf = (m) => 700 * (Math.pow(10, m / 2595) - 1);

export function makeGrid(rate, N) {
  const H = N / 4;
  const bins = N / 2 + 1;
  const binHz = rate / N;
  const melLo = melOf(40);
  const melHi = melOf(Math.min(12000, 0.95 * (rate / 2)));
  const rows = PICTURE_ROWS;
  const step = (melHi - melLo) / rows;
  const k0 = new Int32Array(rows);
  const k1 = new Int32Array(rows);
  const frac = new Float64Array(rows);
  const useMax = new Uint8Array(rows);
  for (let r = 0; r < rows; r++) {
    const m = melHi - (r + 0.5) * step;
    const lo = hzOf(m - step / 2) / binHz;
    const hi = hzOf(m + step / 2) / binHz;
    if (hi - lo <= 1) {
      const b = hzOf(m) / binHz;
      k0[r] = Math.max(0, Math.min(bins - 2, Math.floor(b)));
      frac[r] = Math.min(1, Math.max(0, b - k0[r]));
    } else {
      useMax[r] = 1;
      k0[r] = Math.max(0, Math.round(lo));
      k1[r] = Math.min(bins - 1, Math.max(k0[r], Math.round(hi)));
    }
  }
  const melOfBin = new Float64Array(bins);
  for (let k = 0; k < bins; k++) melOfBin[k] = melOf(k * binHz);
  return { rate, N, H, bins, binHz, melLo, melHi, rows, step, k0, k1, frac, useMax, melOfBin };
}

// The row whose centre is nearest to a frequency (0 = top row), for labels and tests.
export function rowOfHz(grid, hz) {
  return (grid.melHi - melOf(hz)) / grid.step - 0.5;
}

// dB of one bin's power, where 0 dB is a full-scale sine
export function powerDb(p, N) {
  const ref = (N / 4) * (N / 4);
  return 10 * Math.log10(p / ref + 1e-20);
}

// power per bin (averaged over channels) -> dB per picture row, written into out (Float64Array rows)
export function rowsFromPower(power, grid, out) {
  const { rows, k0, k1, frac, useMax, N } = grid;
  for (let r = 0; r < rows; r++) {
    if (useMax[r]) {
      let p = 0;
      for (let k = k0[r]; k <= k1[r]; k++) if (power[k] > p) p = power[k];
      out[r] = powerDb(p, N);
    } else {
      const a = powerDb(power[k0[r]], N), b = powerDb(power[k0[r] + 1], N);
      out[r] = a + (b - a) * frac[r];
    }
  }
  return out;
}

export function codeOf(db, lo, hi) {
  const v = Math.round(((db - lo) / (hi - lo)) * 255);
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

// The colour map: 256 colours along a path in the Oklab colour space, lightness rising evenly
// (designed for this page; proto/cmap2.py in the build notes).
const CMAP_HEX =
  '03051103051203061403061603071704071904071b04081c05081e050920050921060a23060a25070b26070b28080b2a' +
  '090c2b090c2d0a0d2f0b0d300c0e320d0e340e0f350f0f3710103911103a12113c13113e14113f151241161243171344' +
  '1813461914481a14491b154b1d154c1e164e1f164f20165122175223175424185526185727195828195a2a1a5b2b1a5d' +
  '2d1b5e2e1b5f2f1c61311c62321d64341d65351e66371e67391e693a1f6a3c1f6b3d206c3f206e41206f422170442171' +
  '4622724722734922744b23754c23764e247750247852247953257a55257b57257c59267c5a267d5c277e5e277e60277f' +
  '6228806328806529816729816929826b2a826d2a836e2b83702b84722c84742c84762d85772d85792e857b2e857d2f85' +
  '7f2f858030868231868431868632868733868933868b34868d35858e3585903685923785933785953885973984993a84' +
  '9a3a849c3b849e3c839f3c83a13d82a33e82a43e82a63f81a84081a94180ab4180ac427fae437fb0447eb1457eb3457d' +
  'b4467db6477cb7487bb9497bba4a7abc4a7abd4b79bf4c78c04d78c24e77c34f76c45076c65175c75274c95374ca5473' +
  'cb5572cd5671ce5771cf5870d0596fd25a6fd35b6ed45d6dd55e6dd75f6cd8606bd9616bda626adb6469dd6569de6668' +
  'df6768e06967e16a66e26b66e36d65e46e65e56f64e67164e87263e97363e97562ea7662eb7761ec7961ed7a60ee7c60' +
  'ef7d5ff07f5ff1805ff2825ef2835ef3855ef4865ef5885df6895df68b5df78c5df88e5df88f5cf9915cfa925cfa945c' +
  'fb965cfc975cfc995dfd9a5dfd9c5dfe9e5dfe9f5dffa15effa25fffa460ffa661fea762ffa963ffaa64ffac65ffad67' +
  'feaf68ffb069ffb26bffb46bffb56dffb76effb870ffba71ffbc72ffbd74ffbf76ffc077ffc279ffc47bffc57cffc77e' +
  'ffc980ffca82ffcc84ffcd85ffcf87ffd189ffd28affd48cffd58effd68fffd892ffd993ffdb95ffdc97ffde99ffdf9b' +
  'ffe09dffe29fffe3a0ffe4a3ffe6a5ffe7a7ffe8a9ffeaacffebafffedb2ffeeb4ffefb7fff1bafff2bdfff3c0fff5c3';

// 256 colours packed as 0xAABBGGRR (little-endian RGBA for a Uint32Array view of ImageData)
export const COLORMAP = (() => {
  const out = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const r = parseInt(CMAP_HEX.slice(i * 6, i * 6 + 2), 16);
    const g = parseInt(CMAP_HEX.slice(i * 6 + 2, i * 6 + 4), 16);
    const b = parseInt(CMAP_HEX.slice(i * 6 + 4, i * 6 + 6), 16);
    out[i] = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
  }
  return out;
})();
export const colormapHex = (i) => `#${CMAP_HEX.slice(i * 6, i * 6 + 6)}`;

// ------------------------------------------------------------------------------------------------
// Strokes: a brush path in (seconds, mel) with radii rT (seconds) and rM (mel). Full strength within 80% of
// the radius, a cosine feather to the edge. Touching the top (bottom) of the picture reaches Nyquist (0 Hz).
// Returns Map frame -> Float32Array(bins) and the frame span.
// ------------------------------------------------------------------------------------------------

export function rasterise(stroke, grid, first, last) {
  const { rate, H, bins, melOfBin, melLo, melHi } = grid;
  const pts = stroke.points;
  const rT = Math.max(1e-4, stroke.rT), rM = Math.max(1e-3, stroke.rM);
  const segs = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[Math.min(i + 1, pts.length - 1)];
    const ax = a[0] / rT, ay = a[1] / rM, bx = b[0] / rT, by = b[1] / rM;
    segs.push({ ax, ay, dx: bx - ax, dy: by - ay, l2: (bx - ax) ** 2 + (by - ay) ** 2, x0: Math.min(ax, bx) - 1, x1: Math.max(ax, bx) + 1, y0: Math.min(ay, by) - 1, y1: Math.max(ay, by) + 1 });
    if (pts.length === 1) break;
  }
  let tmin = Infinity, tmax = -Infinity;
  for (const p of pts) { if (p[0] < tmin) tmin = p[0]; if (p[0] > tmax) tmax = p[0]; }
  const fLo = Math.max(first, Math.floor(((tmin - rT) * rate) / H) - 1);
  const fHi = Math.min(last, Math.ceil(((tmax + rT) * rate) / H) + 1);
  const cols = new Map();
  let f0 = Infinity, f1 = -Infinity;
  const core = BRUSH_CORE;
  for (let f = fLo; f <= fHi; f++) {
    const u = (f * H) / rate / rT;
    const near = segs.filter((s) => u >= s.x0 && u <= s.x1);
    if (!near.length) continue;
    let vmin = Infinity, vmax = -Infinity;
    for (const s of near) { if (s.y0 < vmin) vmin = s.y0; if (s.y1 > vmax) vmax = s.y1; }
    let col = null;
    for (let k = 0; k < bins; k++) {
      let m = melOfBin[k];
      if (stroke.top && m > melHi) m = melHi;
      if (stroke.bottom && m < melLo) m = melLo;
      const v = m / rM;
      if (v < vmin || v > vmax) continue;
      let d = Infinity;
      for (const s of near) {
        let t = s.l2 ? ((u - s.ax) * s.dx + (v - s.ay) * s.dy) / s.l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = u - (s.ax + t * s.dx), ey = v - (s.ay + t * s.dy);
        const dd = ex * ex + ey * ey;
        if (dd < d) d = dd;
      }
      d = Math.sqrt(d);
      if (d >= 1) continue;
      const val = d <= core ? 1 : 0.5 + 0.5 * Math.cos((Math.PI * (d - core)) / (1 - core));
      if (val <= 0.001) continue;
      if (!col) { col = new Float32Array(bins); cols.set(f, col); }
      col[k] = val;
    }
    if (col) { if (f < f0) f0 = f; if (f > f1) f1 = f; }
  }
  return { cols, f0: Number.isFinite(f0) ? f0 : null, f1: Number.isFinite(f1) ? f1 : null };
}

// ------------------------------------------------------------------------------------------------
// Rebuilding a region. Inputs: the original channels, frames [fa, fb] holding every painted cell of the
// region, erase (Map frame -> Float32Array of dB to remove) and fill (Map frame -> Float32Array mask).
// Output: for each channel the local original (xl) and the rebuilt local signal (yl), with origin.
// Every sample outside the painted frames' reach is copied, never recomputed (delta overlap-add).
// ------------------------------------------------------------------------------------------------

// a small integer hash -> [0, 1), so the same cell always gets the same "random" value
function hash01(f, k, ch, salt) {
  let h = (Math.imul(f | 0, 0x27d4eb2d) ^ Math.imul(k | 0, 0x165667b1) ^ Math.imul(ch + 1, 0x9e3779b1) ^ Math.imul(salt + 7, 0x85ebca77)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d); h ^= h >>> 15; h = Math.imul(h, 0x846ca68b); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function gaussian(f, k, ch) {
  const u = Math.max(1e-12, hash01(f, k, ch, 1));
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * hash01(f, k, ch, 2));
}

export function renderRegion({ channels, grid, fa, fb, erase, fill, rounds = MAX_ROUNDS }) {
  const L = channels[0].length;
  const { N, H, bins } = grid;
  const S = makeSTFT(N);
  const F0 = fa - PAD_FRAMES, F1 = fb + PAD_FRAMES;
  const nF = F1 - F0 + 1;
  const origin = F0 * H - N / 2;
  const len = (F1 - F0) * H + N;
  const M = new Array(nF); // fill mask per local frame (or null)
  const E = new Array(nF); // erase dB per local frame (or null)
  const changed = [];
  for (let j = 0; j < nF; j++) {
    M[j] = (fill && fill.get(F0 + j)) || null;
    E[j] = (erase && erase.get(F0 + j)) || null;
    if (M[j] || E[j]) changed.push(j);
  }
  const lists = M.map((m) => {
    if (!m) return null;
    const l = [];
    for (let k = 0; k < bins; k++) if (m[k] > 0) l.push(k);
    return Uint16Array.from(l);
  });
  const result = { origin, len, L, xl: [], yl: [], noBorders: false, sides: { both: 0, before: 0, after: 0 }, rounds: 0, frames: changed.length };
  const scale = 1 / S.wsq;
  const tr = new Float64Array(bins), ti = new Float64Array(bins);
  const ar = new Float64Array(bins), ai = new Float64Array(bins);
  const glRounds = lists.some((l) => l && l.length) ? rounds : 0;
  result.rounds = glRounds;
  channels.forEach((x, ch) => {
    const xl = new Float64Array(len);
    for (let i = 0; i < len; i++) { const s = origin + i; xl[i] = s >= 0 && s < x.length ? x[s] : 0; }
    // spectra of the original (X) and the target (Y)
    const Xr = new Array(nF), Xi = new Array(nF), Yr = new Array(nF), Yi = new Array(nF);
    for (let j = 0; j < nF; j++) {
      Xr[j] = new Float64Array(bins); Xi[j] = new Float64Array(bins);
      S.analyseLocal(xl, origin, F0 + j, Xr[j], Xi[j]);
    }
    // Erase first: the erased spectrum is what Fill in reads as known sound
    const Er = new Array(nF), Ei = new Array(nF);
    for (let j = 0; j < nF; j++) {
      if (!E[j]) { Er[j] = Xr[j]; Ei[j] = Xi[j]; continue; }
      Er[j] = Float64Array.from(Xr[j]); Ei[j] = Float64Array.from(Xi[j]);
      for (let k = 0; k < bins; k++) {
        const db = E[j][k];
        if (db > 0) { const g = Math.pow(10, -db / 20); Er[j][k] *= g; Ei[j][k] *= g; }
      }
    }
    for (let j = 0; j < nF; j++) {
      Yr[j] = M[j] || E[j] ? Float64Array.from(Er[j]) : Er[j];
      Yi[j] = M[j] || E[j] ? Float64Array.from(Ei[j]) : Ei[j];
    }
    const T = new Array(nF); // target magnitudes of filled cells
    if (M.some(Boolean)) {
      if (!result.rowIn) { result.rowIn = new Float64Array(bins); result.rowBorder = new Float64Array(bins); result.rowSkew = new Float64Array(bins); }
      const nb = fillCells({ Er, Ei, M, Yr, Yi, T, nF, bins, H, N, F0, ch, L, rowIn: result.rowIn, rowBorder: result.rowBorder, rowSkew: result.rowSkew, sides: ch === 0 ? result.sides : null });
      if (nb) result.noBorders = true;
    }
    const yl = new Float64Array(len);
    const synth = () => {
      yl.set(xl);
      for (const j of changed) {
        tr.fill(0); ti.fill(0);
        const yr = Yr[j], yi = Yi[j], xr = Xr[j], xi = Xi[j];
        const m = M[j], e = E[j];
        for (let k = 0; k < bins; k++) {
          if ((m && m[k] > 0) || (e && e[k] > 0)) { tr[k] = yr[k] - xr[k]; ti[k] = yi[k] - xi[k]; }
        }
        S.synthAdd(tr, ti, yl, origin, F0 + j, scale);
      }
    };
    synth();
    for (let it = 0; it < glRounds; it++) {
      for (const j of changed) {
        const lst = lists[j];
        if (!lst || !lst.length) continue;
        S.analyseLocal(yl, origin, F0 + j, ar, ai);
        const t = T[j], yr = Yr[j], yi = Yi[j];
        for (let q = 0; q < lst.length; q++) {
          const k = lst[q];
          const mag = Math.sqrt(ar[k] * ar[k] + ai[k] * ai[k]);
          if (mag > 1e-20) { const s = t[k] / mag; yr[k] = ar[k] * s; yi[k] = ai[k] * s; }
        }
      }
      synth();
    }
    // a sample that is not a number would be a click at full scale in the saved file: make it silence instead
    for (let i = 0; i < len; i++) if (!Number.isFinite(yl[i])) yl[i] = 0;
    result.xl.push(xl);
    result.yl.push(yl);
  });
  return result;
}

// Fill in, row by row across time (decision D2), with border statistics, texture and hybrid phase.
// rowIn[k] collects the loudest painted cell of band k and rowBorder[k] the louder of its two untouched
// borders, so the readout can tell when a stroke cut through a sound that carries on past it.
function fillCells({ Er, Ei, M, Yr, Yi, T, nF, bins, H, N, F0, ch, L, rowIn, rowBorder, rowSkew, sides }) {
  // a frame whose window reaches past either end of the file holds silence, not sound: never a border
  const inside = (j) => (F0 + j) * H - N / 2 >= 0 && (F0 + j) * H + N / 2 <= L;
  const known = (j, k) => (!M[j] || !(M[j][k] > 0)) && inside(j);
  const twoPi = 2 * Math.PI;
  const princ = (a) => a - twoPi * Math.round(a / twoPi);
  let noBorders = false;
  for (let j = 0; j < nF; j++) if (M[j]) T[j] = new Float64Array(bins);
  const ls = new Float64Array(BORDER_FRAMES);
  const side = (k, from, step) => {
    let p = 0, n = 0;
    for (let j = from, c = 0; c < BORDER_FRAMES && j >= 0 && j < nF && known(j, k); j += step, c++) {
      const m2 = Er[j][k] * Er[j][k] + Ei[j][k] * Ei[j][k];
      p += m2; ls[n] = 0.5 * Math.log(Math.max(m2, 1e-24)); n++;
    }
    if (!n) return null;
    let d2 = 0;
    for (let i = 1; i < n; i++) d2 += (ls[i] - ls[i - 1]) ** 2;
    // floored, so a border of exact digital silence gives a very low level, never -Infinity (and NaN after it)
    return { lvl: 0.5 * Math.log(Math.max(p / n, 1e-24)), flick: n > 1 ? Math.sqrt(d2 / (n - 1) / 2) : 0 };
  };
  for (let k = 0; k < bins; k++) {
    const expected = (twoPi * H * k) / N;
    let j = 0;
    while (j < nF) {
      if (known(j, k)) { j++; continue; }
      let e = j;
      while (e < nF && !known(e, k)) e++;
      const left = j - 1, right = e;
      const sl = left >= 0 ? side(k, left, -1) : null;
      const sr = right < nF ? side(k, right, 1) : null;
      let pl = null, dl = expected, pr = null, dr = expected;
      if (sl) {
        pl = Math.atan2(Ei[left][k], Er[left][k]);
        if (left >= 1 && known(left - 1, k)) dl = expected + princ(pl - Math.atan2(Ei[left - 1][k], Er[left - 1][k]) - expected);
      }
      if (sr) {
        pr = Math.atan2(Ei[right][k], Er[right][k]);
        if (right + 1 < nF && known(right + 1, k)) dr = expected + princ(Math.atan2(Ei[right + 1][k], Er[right + 1][k]) - pr - expected);
      }
      if (!sl && !sr) noBorders = true;
      if (sides) { if (sl && sr) sides.both++; else if (sl) sides.before++; else if (sr) sides.after++; }
      // A note that starts or stops inside the painted area: when the two sides differ by more than 6 dB and
      // the painted levels look clearly more like a step from one side's level to the other's than like a
      // straight blend, rebuild the step (at the best-fitting frame). Each frame's misfit is capped at
      // 12 dB, so the loud frames of the noise itself barely move the choice.
      let split = -1;
      if (sl && sr && Math.abs(sl.lvl - sr.lvl) > Math.log(STEP_RATIO)) {
        const clip = Math.log(4);
        const lo = new Float64Array(e - j);
        for (let q = j; q < e; q++) lo[q - j] = 0.5 * Math.log(Math.max(Er[q][k] * Er[q][k] + Ei[q][k] * Ei[q][k], 1e-24));
        let best = Infinity, lin = 0;
        for (let q = j; q < e; q++) {
          const a = (q - left) / (right - left);
          lin += Math.min(clip, Math.abs(lo[q - j] - ((1 - a) * sl.lvl + a * sr.lvl)));
        }
        for (let sp = j; sp <= e; sp++) {
          let c = 0;
          for (let q = j; q < e; q++) c += Math.min(clip, Math.abs(lo[q - j] - (q < sp ? sl.lvl : sr.lvl)));
          if (c < best - 1e-9) { best = c; split = sp; }
        }
        if (!(best < STEP_FIT * lin)) split = -1;
      }
      if (rowIn) {
        let pin = 0, n = 0;
        for (let q = j; q < e; q++) if (M[q] && M[q][k] >= 0.5) { pin = Math.max(pin, Er[q][k] * Er[q][k] + Ei[q][k] * Ei[q][k]); n++; }
        if (n) {
          rowIn[k] = Math.max(rowIn[k], pin);
          const pb = Math.max(sl ? Math.exp(2 * sl.lvl) : 0, sr ? Math.exp(2 * sr.lvl) : 0);
          rowBorder[k] = Math.max(rowBorder[k], pb);
          // how far the two sides disagree (power ratio; one-sided or no side counts as far apart)
          if (rowSkew) rowSkew[k] = Math.max(rowSkew[k], sl && sr ? Math.exp(2 * Math.abs(sl.lvl - sr.lvl)) : 1e6);
        }
      }
      for (let q = j; q < e; q++) {
        // frames past either end of the file are unknown but were not painted: they stay as they are
        if (!M[q] || !(M[q][k] > 0)) continue;
        const f = F0 + q;
        const m = M[q][k];
        const om = Math.sqrt(Er[q][k] * Er[q][k] + Ei[q][k] * Ei[q][k]);
        let target, ph;
        if (!sl && !sr) {
          // nothing untouched on either side: erase instead
          target = om * Math.pow(10, -ERASE_DB / 20);
          ph = Math.atan2(Ei[q][k], Er[q][k]);
        } else {
          const a = split >= 0 ? (q < split ? 0 : 1) : sl && sr ? (q - left) / (right - left) : 0;
          const lvl = sl && sr ? (1 - a) * sl.lvl + a * sr.lvl : (sl || sr).lvl;
          const fl = sl && sr ? (1 - a) * sl.flick + a * sr.flick : (sl || sr).flick;
          const noisy = fl > NOISE_FLICKER;
          target = Math.exp(lvl + (noisy ? fl * gaussian(f, k, ch) - fl * fl : 0));
          if (om <= HYBRID_RATIO * Math.exp(lvl)) ph = Math.atan2(Ei[q][k], Er[q][k]);
          else if (noisy) ph = twoPi * hash01(f, k, ch, 3);
          else if (sl && sr) {
            const p1 = pl + dl * (q - left), p2 = pr - dr * (right - q);
            ph = Math.atan2((1 - a) * Math.sin(p1) + a * Math.sin(p2), (1 - a) * Math.cos(p1) + a * Math.cos(p2));
          } else ph = sl ? pl + dl * (q - left) : pr - dr * (right - q);
        }
        const mag = m >= 1 ? target : Math.exp((1 - m) * Math.log(Math.max(om, 1e-12)) + m * Math.log(Math.max(target, 1e-12)));
        T[q][k] = mag;
        Yr[q][k] = mag * Math.cos(ph);
        Yi[q][k] = mag * Math.sin(ph);
      }
      j = e;
    }
  }
  return noBorders;
}

// The readout: over the painted cells (at least half strength, up to 16 kHz), the drop in level from the
// original to the result. The number shown is the median drop of the cells that changed by 3 dB or more;
// `changed` is the share of painted cells that did. Cells of the music that Fill in rebuilt unchanged do
// not water the number down, and a stroke over nothing that stood out reports no number at all.
export function readout(region, cols, grid) {
  const { N, bins, binHz } = grid;
  const S = makeSTFT(N);
  const r1 = new Float64Array(bins), i1 = new Float64Array(bins), r2 = new Float64Array(bins), i2 = new Float64Array(bins);
  const pb = new Float64Array(bins), pa = new Float64Array(bins);
  const drops = [];
  let cells = 0, rose = 0, eDrop = 0, eRise = 0, sumB = 0, sumA = 0;
  const kMax = Math.min(bins - 1, Math.floor(16000 / binHz));
  const L = region.L || Infinity;
  for (const [f, col] of cols) {
    if (f * grid.H - N / 2 < 0 || f * grid.H + N / 2 > L) continue;
    pb.fill(0); pa.fill(0);
    for (let ch = 0; ch < region.xl.length; ch++) {
      S.analyseLocal(region.xl[ch], region.origin, f, r1, i1);
      S.analyseLocal(region.yl[ch], region.origin, f, r2, i2);
      for (let k = 1; k <= kMax; k++) { pb[k] += r1[k] * r1[k] + i1[k] * i1[k]; pa[k] += r2[k] * r2[k] + i2[k] * i2[k]; }
    }
    for (let k = 1; k <= kMax; k++) {
      if (!(col[k] >= 0.5)) continue;
      cells++;
      sumB += pb[k]; sumA += pa[k];
      const d = 10 * Math.log10((pb[k] + 1e-24) / (pa[k] + 1e-24));
      if (d >= 3) { drops.push(d); eDrop += pb[k] - pa[k]; }
      else if (d <= -3) { rose++; eRise += pa[k] - pb[k]; }
    }
  }
  drops.sort((a, b) => a - b);
  // `rose` is the share that got 3 dB louder: where a fill only swapped one stretch of noise for a similar
  // one, about as many spots rise as drop, and nothing was really taken out
  // `net`: of the energy that moved by 3 dB or more, the share taken out less the share added (1: only taken out)
  const net = eDrop + eRise > 0 ? (eDrop - eRise) / (eDrop + eRise) : 0;
  // `drop`: how much quieter the painted cells became all together (energy), in dB
  const drop = sumA > 0 ? 10 * Math.log10(sumB / sumA) : 0;
  return { db: drops.length ? drops[Math.floor(drops.length / 2)] : null, changed: cells ? drops.length / cells : 0, rose: cells ? rose / cells : 0, net, drop, cells };
}

// The number the page shows for a Fill stroke: when nearly all the energy that moved was taken out (net >= 0.9), how
// much quieter the painted cells became together (energy-weighted, so a narrow ping that holds most of the energy
// in few cells is not undersold by the many room-tone cells around it); otherwise the median drop of the cells that
// changed by 3 dB or more.
export function reportedDb(ro) {
  if (!ro || ro.db === null || ro.db === undefined) return null;
  return ro.net >= 0.9 && Number.isFinite(ro.drop) && ro.drop > 0 ? ro.drop : ro.db;
}

// Was anything clearly taken out? Not when, net of the painted cells that rose by 3 dB, under a tenth of them
// dropped by 3 dB, and the energy that dropped is less than three times the energy that rose (`net` < 0.5):
// then Fill in only swapped one stretch of sound for a similar one.
export function clearlyRemoved(ro) {
  return !!ro && ro.db !== null && !(ro.changed - ro.rose < 0.1 && ro.net < 0.5);
}

// Did the stroke cut through a longer sound? When nothing was clearly taken out, yet some pitch band in the
// stroke is bright in the picture (at or above floorDb) and its untouched border is no more than 6 dB quieter,
// a clear sound runs through the stroke and on past it, and Fill in, which rebuilds from either side, kept it.
export function carriesOn(region, grid, floorDb) {
  if (!region.rowIn) return false;
  const kMax = Math.min(grid.bins - 1, Math.floor(16000 / grid.binHz));
  for (let k = 1; k <= kMax; k++) {
    const p = region.rowIn[k];
    if (p > 0 && powerDb(p, grid.N) >= floorDb && region.rowBorder[k] * 4 >= p) return true;
  }
  return false;
}

// Rounds of masked Griffin-Lim for a rebuild: from the number of filled frames alone (so Undo and Redo
// recompute exactly the same result), about 160 ms of work, never fewer than 2 or more than 12.
export function roundsFor(fillFrames, channels) {
  if (!fillFrames) return 0;
  return Math.max(MIN_ROUNDS, Math.min(MAX_ROUNDS, Math.floor(1600 / (fillFrames * channels))));
}

// The region to rebuild for a stroke: its own frames, grown to take in every active stroke within reach.
export function regionFor(stroke, active) {
  let fa = stroke.f0, fb = stroke.f1;
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of active) {
      if (s.f0 === null) continue;
      if (s.f1 + MERGE_FRAMES >= fa && s.f0 - MERGE_FRAMES <= fb && (s.f0 < fa || s.f1 > fb)) {
        fa = Math.min(fa, s.f0); fb = Math.max(fb, s.f1); grew = true;
      }
    }
  }
  return { fa, fb };
}

// The combined masks of the active strokes inside frames [fa, fb]: Erase adds decibels, Fill in takes the maximum.
export function masksFor(fa, fb, active, bins) {
  const erase = new Map(), fill = new Map();
  for (const s of active) {
    if (s.f0 === null || s.f1 < fa || s.f0 > fb) continue;
    for (const [f, col] of s.cols) {
      if (f < fa || f > fb) continue;
      if (s.mode === 'erase') {
        let e = erase.get(f);
        if (!e) { e = new Float32Array(bins); erase.set(f, e); }
        for (let k = 0; k < bins; k++) if (col[k] > 0) e[k] = Math.min(2 * ERASE_DB, e[k] + ERASE_DB * col[k]);
      } else {
        let m = fill.get(f);
        if (!m) { m = new Float32Array(bins); fill.set(f, m); }
        for (let k = 0; k < bins; k++) if (col[k] > m[k]) m[k] = col[k];
      }
    }
  }
  return { erase, fill };
}

// One rebuild, shared by the worker and the self-test: the stroke's region with every active stroke in it.
// Returns the rendered region and the span of samples that can have changed.
export function rebuild({ channels, grid, stroke, active }) {
  const { fa, fb } = regionFor(stroke, active);
  const { erase, fill } = masksFor(fa, fb, active, grid.bins);
  const rounds = roundsFor(fill.size, channels.length);
  const region = renderRegion({ channels, grid, fa, fb, erase, fill, rounds });
  const L = channels[0].length;
  return { region, fa, fb, start: Math.max(0, fa * grid.H - grid.N / 2), end: Math.min(L, fb * grid.H + grid.N / 2), rounds };
}

// ------------------------------------------------------------------------------------------------
// WAV: the canonical 44-byte PCM header (RIFF, "fmt " of 16 bytes, "data"), 16-bit little-endian output.
// The reader is the writer's exact inverse: positive samples over 32767, negative over 32768.
// ------------------------------------------------------------------------------------------------

export function toInt16(s) {
  if (!(s === s)) return 0;
  const v = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
  return v > 32767 ? 32767 : v < -32768 ? -32768 : v;
}

// opts.dither: add triangular dither of +/-1 step before rounding (for sources finer than 16 bits); seeded,
// so the same recording always saves to the same bytes
export function writeWav(channels, sampleRate, opts = {}) {
  const nch = channels.length;
  const len = channels[0].length;
  const blockAlign = nch * 2;
  const dataBytes = len * blockAlign;
  const bytes = new Uint8Array(44 + dataBytes);
  const v = new DataView(bytes.buffer);
  const tag = (o, s) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  tag(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); tag(8, 'WAVE');
  tag(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nch, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * blockAlign, true);
  v.setUint16(32, blockAlign, true); v.setUint16(34, 16, true);
  tag(36, 'data'); v.setUint32(40, dataBytes, true);
  let o = 44;
  if (opts.dither) {
    let st = 0x2f6b9d1 >>> 0;
    const rnd = () => { st = (st + 0x6d2b79f5) >>> 0; let t = st; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    for (let i = 0; i < len; i++) for (let c = 0; c < nch; c++) { v.setInt16(o, toInt16(channels[c][i] + (rnd() - rnd()) / 32768), true); o += 2; }
    return bytes;
  }
  for (let i = 0; i < len; i++) for (let c = 0; c < nch; c++) { v.setInt16(o, toInt16(channels[c][i]), true); o += 2; }
  return bytes;
}

export function isWav(bytes) {
  if (bytes.byteLength < 12) return false;
  const s = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  return (s(0) === 'RIFF' || s(0) === 'RF64') && s(8) === 'WAVE';
}

export function parseWav(bytes, maxSeconds = Infinity) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (!isWav(bytes) || tag(0) !== 'RIFF') throw new Error('not a RIFF WAVE file');
  let o = 12, fmt = null, data = null;
  while (o + 8 <= bytes.byteLength) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    const body = o + 8;
    if (id === 'fmt ' && body + 16 <= bytes.byteLength) {
      let format = v.getUint16(body, true);
      if (format === 0xfffe && size >= 26 && body + 26 <= bytes.byteLength) format = v.getUint16(body + 24, true);
      fmt = { format, channels: v.getUint16(body + 2, true), sampleRate: v.getUint32(body + 4, true), blockAlign: v.getUint16(body + 12, true), bits: v.getUint16(body + 14, true) };
    } else if (id === 'data') {
      data = { offset: body, size: Math.min(size, bytes.byteLength - body) };
      if (fmt) break;
    }
    o = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('missing fmt or data chunk');
  const { format, channels, sampleRate, blockAlign, bits } = fmt;
  const bps = bits / 8;
  if (!channels || !sampleRate || !blockAlign || blockAlign < channels * bps) throw new Error('unsupported WAV layout');
  const okPcm = format === 1 && [8, 16, 24, 32].includes(bits);
  const okFloat = format === 3 && (bits === 32 || bits === 64);
  if (!okPcm && !okFloat) throw new Error(`unsupported WAV encoding (format ${format}, ${bits} bits)`);
  const frames = Math.min(Math.floor(data.size / blockAlign), Math.floor(maxSeconds * sampleRate));
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  const totalFrames = Math.floor(data.size / blockAlign);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const p = data.offset + i * blockAlign + c * bps;
      let s;
      if (okFloat) s = bits === 32 ? v.getFloat32(p, true) : v.getFloat64(p, true);
      else if (bits === 16) { const u = v.getInt16(p, true); s = u >= 0 ? u / 32767 : u / 32768; }
      else if (bits === 24) { const u = v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getInt8(p + 2) << 16); s = u >= 0 ? u / 8388607 : u / 8388608; }
      else if (bits === 8) { const u = v.getUint8(p) - 128; s = u >= 0 ? u / 127 : u / 128; }
      else { const u = v.getInt32(p, true); s = u >= 0 ? u / 2147483647 : u / 2147483648; }
      out[c][i] = Number.isFinite(s) ? s : 0;
    }
  }
  return { sampleRate, channels: out, bits, format, totalFrames };
}
