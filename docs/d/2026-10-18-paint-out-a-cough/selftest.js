// Known-answer checks, run by "Check against known answers" and by QA through window.__sedSelfTest.
// Each case computes its output with the page's own code (engine.js and sample.js on this thread; cases 17,
// 19, 30 and 33 also read a fresh copy of the page's own worker.js) and compares it with an expected value
// copied from the named source, computed independently here, or recorded at build time, and labelled so
// (SPEC.md, section 7). Values the page sets by design (the slice length, the brush, the picture's rows) are
// labelled as the design; the SPEC section is named in the comments. Expected values are never edited to make
// a case pass; a recorded value is re-recorded only after an intended change to the engine, with the date.
import * as E from './engine.js';
import { makeSample, demoStroke, mulberry32, SAMPLE_RATE } from './sample.js';

// Measured with this page's code when it was built (2026-10-18, engine.js and worker.js of 22:44 UTC).
// Regression values: when an intended change to the engine moves one, the failing case prints the new value;
// copy it here with the date (and update the explainer if it quotes the number).
const RECORDED = {
  sampleRms: -21.512, // the demo clip's level, dBFS RMS (case 17)
  demoError: -20.75, // demo stroke: difference from the cough-free clip, dB re the music (case 19; explainer: 20.7 dB)
  demoReadout: 20.82, // demo stroke: median drop of the painted spots that changed by 3 dB or more (case 30)
  demoCoughDrop: 19.0, // demo stroke: how much quieter the cough's own spots became, the demo line's number (case 30)
  pictureTop: -20, // demo clip: top of the picture's colour scale, dB (case 33)
};
const TOL_DB = 0.5;

const pass = (ok, detail) => ({ ok: !!ok, detail });
// numbers in the details: 4 significant figures (tiny ones in exponent form), whole numbers grouped
function g4(v) {
  if (v === 0) return '0';
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a < 1e-3) return v.toExponential(3);
  if (a >= 1e5) return Math.round(v).toLocaleString('en-US');
  return v.toPrecision(4);
}
const n = (v) => v.toLocaleString('en-US');
const signed = (v) => (v > 0 ? '+' : '') + g4(v);
const yn = (b) => (b ? 'yes' : 'no');
const noise = (len, seed) => { const r = mulberry32(seed); const x = new Float64Array(len); for (let i = 0; i < len; i++) x[i] = r() * 2 - 1; return x; };
// roughly Gaussian noise of unit variance (sum of four uniforms), as Float32 like a real recording
const hiss = (len, seed, amp) => { const r = mulberry32(seed); const x = new Float32Array(len); for (let i = 0; i < len; i++) x[i] = amp * (r() + r() + r() + r() - 2) * Math.sqrt(3); return x; };
const tone = (len, hz, amp, rate) => Float32Array.from({ length: len }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate));
// the mel scale as the page's picture uses it (SPEC section 5), written out here so a case can check the engine's copy
const mel = (f) => 2595 * Math.log10(1 + f / 700);

// a stroke as the worker stores it (worker.js addStroke): the brush path plus its rasterised columns
function strokeOf(s, grid, fr) {
  const r = E.rasterise(s, grid, fr.first, fr.last);
  return { ...s, cols: r.cols, f0: r.f0, f1: r.f1 };
}
const upright = (id, mode, t, rT, grid) => ({ id, mode, points: [[t, grid.melHi], [t, grid.melLo]], rT, rM: 40, top: true, bottom: true });
// one rebuild applied the way the worker posts it and the player writes it: Float32 samples over [start, end)
function patch(out, channels, grid, stroke, active) {
  const b = E.rebuild({ channels, grid, stroke, active });
  out.set(Float32Array.from(b.region.yl[0].subarray(b.start - b.region.origin, b.end - b.region.origin)), b.start);
  return b;
}
const differing = (a, b) => { let c = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) c++; return c; };

// ---- 1 to 7: the Fourier transform and the slicing --------------------------------------------------

function impulse() {
  const len = 1024, F = E.makeComplexFFT(len), re = new Float64Array(len), im = new Float64Array(len);
  re[0] = 1;
  F.forward(re, im);
  let e = 0;
  for (let k = 0; k < len; k++) e = Math.max(e, Math.abs(re[k] - 1), Math.abs(im[k]));
  return pass(e < 1e-12, `largest deviation from 1 + 0i over 1,024 bins: ${g4(e)} (limit 1e-12)`);
}

function cosine() {
  const len = 64, F = E.makeComplexFFT(len), re = new Float64Array(len), im = new Float64Array(len);
  for (let i = 0; i < len; i++) re[i] = Math.cos((2 * Math.PI * 5 * i) / len);
  F.forward(re, im);
  const mag = (k) => Math.hypot(re[k], im[k]);
  let other = 0;
  for (let k = 0; k < len; k++) if (k !== 5 && k !== 59) other = Math.max(other, mag(k));
  const d = Math.max(Math.abs(mag(5) - 32), Math.abs(mag(59) - 32));
  return pass(d < 1e-9 && other < 1e-9, `|X5| = ${g4(mag(5))} and |X59| = ${g4(mag(59))}, at most ${g4(d)} from 32 (limit 1e-9); largest other bin ${g4(other)} (limit 1e-9)`);
}

// The DFT straight from its definition, X[k] = sum of x[n] e^(-2 pi i k n / N), one term at a time: a reference
// that shares no code with the page's FFT. Then the sign convention: sin(2 pi 7 n / N) has X[7] = -iN/2.
function directDft() {
  const N = 2048, x = noise(N, 2026);
  const R = E.makeRealFFT(N), re = new Float64Array(N / 2 + 1), im = new Float64Array(N / 2 + 1);
  R.forward(x, re, im);
  const c = new Float64Array(N), s = new Float64Array(N);
  for (let m = 0; m < N; m++) { c[m] = Math.cos((2 * Math.PI * m) / N); s[m] = Math.sin((2 * Math.PI * m) / N); }
  let e = 0, big = 0;
  for (let k = 0; k <= N / 2; k++) {
    let sr = 0, si = 0;
    for (let i = 0, m = 0; i < N; i++, m = (m + k) & (N - 1)) { sr += x[i] * c[m]; si -= x[i] * s[m]; }
    e = Math.max(e, Math.abs(re[k] - sr), Math.abs(im[k] - si));
    big = Math.max(big, Math.hypot(sr, si));
  }
  const y = Float64Array.from({ length: N }, (_, i) => Math.sin((2 * Math.PI * 7 * i) / N));
  R.forward(y, re, im);
  let other = 0;
  for (let k = 0; k <= N / 2; k++) if (k !== 7) other = Math.max(other, Math.hypot(re[k], im[k]));
  const dp = Math.max(Math.abs(re[7]), Math.abs(im[7] + N / 2));
  const ok = e < 1e-9 && dp < 1e-9 && other < 1e-9;
  return pass(ok, `largest difference from the direct sum over 1,025 bins: ${g4(e)} (limit 1e-9; bins up to ${g4(big)}); sine at bin 7: X[7] = ${g4(re[7])} ${im[7] < 0 ? '-' : '+'} ${g4(Math.abs(im[7]))}i, ${g4(dp)} from -1,024i (limit 1e-9), other bins up to ${g4(other)}`);
}

function parseval() {
  const N = 2048, x = noise(N, 12345), R = E.makeRealFFT(N);
  const re = new Float64Array(N / 2 + 1), im = new Float64Array(N / 2 + 1);
  R.forward(x, re, im);
  let ex = 0;
  for (const v of x) ex += v * v;
  let eX = re[0] ** 2 + im[0] ** 2 + re[N / 2] ** 2 + im[N / 2] ** 2;
  for (let k = 1; k < N / 2; k++) eX += 2 * (re[k] ** 2 + im[k] ** 2);
  const rel = Math.abs(ex - eX / N) / ex;
  return pass(rel < 1e-12, `sum of x squared ${g4(ex)}, (1/N) sum of |X| squared ${g4(eX / N)}, relative difference ${g4(rel)} (limit 1e-12)`);
}

function ola(hop, squared) {
  const N = 2048, w = E.periodicHann(N), s = new Float64Array(4 * N);
  for (let st = 0; st + N <= s.length; st += hop) for (let i = 0; i < N; i++) s[st + i] += squared ? w[i] * w[i] : w[i];
  let lo = Infinity, hi = -Infinity;
  for (let i = N; i < 2 * N; i++) { lo = Math.min(lo, s[i]); hi = Math.max(hi, s[i]); }
  return [lo, hi];
}
function colaHalf() { const [lo, hi] = ola(1024, false); const d = Math.max(Math.abs(lo - 1), Math.abs(hi - 1)); return pass(d < 1e-12, `the sum stays within ${g4(d)} of 1 (limit 1e-12)`); }
function colaQuarter() { const [lo, hi] = ola(512, true); const d = Math.max(Math.abs(lo - 1.5), Math.abs(hi - 1.5)); return pass(d < 1e-12, `the sum stays within ${g4(d)} of 1.5 (limit 1e-12)`); }

function roundTrip() {
  const x = noise(3 * 44100, 777);
  const out = [];
  let worst = 0;
  for (const N of [2048, 1024]) {
    const y = E.roundTrip(x, N);
    let e = 0;
    for (let i = 0; i < x.length; i++) e = Math.max(e, Math.abs(y[i] - x[i]));
    out.push(`N ${n(N)}: ${g4(e)}`);
    worst = Math.max(worst, e);
  }
  return pass(worst < 1e-9, `largest error over 3 s at 44,100 Hz: ${out.join(', ')} (limit 1e-9)`);
}

// ---- 8 to 12: the WAV format ------------------------------------------------------------------------

function wavHeader() {
  const b = E.writeWav([new Float32Array(44100)], 44100);
  const v = new DataView(b.buffer);
  const tag = (o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  const names = ['file size', 'RIFF', 'RIFF size', 'WAVE', 'fmt ', 'fmt size', 'format', 'channels', 'rate', 'ByteRate', 'BlockAlign', 'bits', 'data', 'data size'];
  const got = [b.byteLength, tag(0), v.getUint32(4, true), tag(8), tag(12), v.getUint32(16, true), v.getUint16(20, true), v.getUint16(22, true), v.getUint32(24, true), v.getUint32(28, true), v.getUint16(32, true), v.getUint16(34, true), tag(36), v.getUint32(40, true)];
  const want = [88244, 'RIFF', 88236, 'WAVE', 'fmt ', 16, 1, 1, 44100, 88200, 2, 16, 'data', 88200];
  const bad = names.filter((_, i) => got[i] !== want[i]).map((nm) => `${nm}: got ${got[names.indexOf(nm)]}, expected ${want[names.indexOf(nm)]}`);
  return pass(!bad.length, bad.length ? bad.join('; ') : '88,244 bytes; RIFF size 88,236; format 1 (PCM), 1 channel, 44,100 Hz, ByteRate 88,200, BlockAlign 2, 16 bits; data 88,200 bytes (all 14 fields as expected)');
}

function wavStereo() {
  const b = E.writeWav([new Float32Array(10), new Float32Array(10)], 48000);
  const v = new DataView(b.buffer);
  return pass(v.getUint32(28, true) === 192000 && v.getUint16(32, true) === 4, `ByteRate ${n(v.getUint32(28, true))}, BlockAlign ${v.getUint16(32, true)} (expected 192,000 and 4)`);
}

function pcmScaling() {
  const b = E.writeWav([Float32Array.from([1, -1, 0, 2, -2, 0.5])], 8000);
  const v = new DataView(b.buffer);
  const vals = [0, 1, 2, 3, 4, 5].map((i) => v.getInt16(44 + 2 * i, true));
  const bytes = [...b.slice(44, 50)].map((x) => x.toString(16).padStart(2, '0')).join(' ');
  return pass(vals.join(',') === '32767,-32768,0,32767,-32768,16384' && bytes === 'ff 7f 00 80 00 00', `values ${vals.join(', ')} (expected 32767, -32768, 0, 32767, -32768, 16384); first bytes ${bytes} (expected ff 7f 00 80 00 00)`);
}

function wavReadBack() {
  const a = Float32Array.from({ length: 64 }, (_, i) => Math.sin(i / 3) * 0.9);
  const c = Float32Array.from({ length: 64 }, (_, i) => Math.cos(i / 5) * 0.5);
  const p = E.parseWav(E.writeWav([a, c], 22050));
  let e = 0;
  for (let i = 0; i < 64; i++) e = Math.max(e, Math.abs(p.channels[0][i] - a[i]), Math.abs(p.channels[1][i] - c[i]));
  const limit = 0.5 / 32767 + 1e-7;
  return pass(p.sampleRate === 22050 && p.channels.length === 2 && e <= limit, `rate ${n(p.sampleRate)}, ${p.channels.length} channels, largest error ${g4(e)} (limit ${g4(limit)}: half a 16-bit step, ${g4(0.5 / 32767)}, plus 1e-7 for float32 rounding)`);
}

function wav24() {
  const bytes = new Uint8Array(50);
  const v = new DataView(bytes.buffer);
  const tag = (o, s) => { for (let i = 0; i < 4; i++) bytes[o + i] = s.charCodeAt(i); };
  tag(0, 'RIFF'); v.setUint32(4, 42, true); tag(8, 'WAVE'); tag(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 22050, true); v.setUint32(28, 22050 * 3, true);
  v.setUint16(32, 3, true); v.setUint16(34, 24, true); tag(36, 'data'); v.setUint32(40, 6, true);
  bytes.set([0xff, 0xff, 0x7f, 0x00, 0x00, 0x80], 44);
  const q = E.parseWav(bytes);
  return pass(q.channels[0][0] === 1 && q.channels[0][1] === -1 && q.sampleRate === 22050, `read ${q.channels[0][0]} and ${q.channels[0][1]} at ${n(q.sampleRate)} Hz (expected 1 and -1 at 22,050 Hz)`);
}

// ---- 13 to 16: Erase, Fill in, Undo -----------------------------------------------------------------

// a 1 kHz (or 440 Hz) tone of 2 s at 44.1 kHz, its grid, and a rectangle of cells
function toneSetup(hz) {
  const rate = 44100, L = 2 * rate, x = new Float32Array(L);
  for (let i = 0; i < L; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / rate);
  const grid = E.makeGrid(rate, E.stftSize(rate));
  return { rate, L, x, grid };
}
function rect(grid, fa, fb, ka, kb, value) {
  const m = new Map();
  for (let f = fa; f <= fb; f++) { const col = new Float32Array(grid.bins); for (let k = ka; k <= kb; k++) col[k] = value; m.set(f, col); }
  return m;
}
const local = (region, s) => s - region.origin;

function eraseDepth() {
  const { rate, x, grid } = toneSetup(1000);
  const fa = Math.round((0.5 * rate) / grid.H), fb = Math.round((1.5 * rate) / grid.H);
  const erase = rect(grid, fa, fb, Math.round(700 / grid.binHz), Math.round(1300 / grid.binHz), E.ERASE_DB);
  const region = E.renderRegion({ channels: [x], grid, fa, fb, erase, fill: null });
  let ex = 0, ey = 0;
  for (let s = Math.round(0.75 * rate); s < Math.round(1.25 * rate); s++) { ex += region.xl[0][local(region, s)] ** 2; ey += region.yl[0][local(region, s)] ** 2; }
  const depth = 10 * Math.log10(ex / ey);
  return pass(Math.abs(depth - 60) <= 1, `${g4(depth)} dB quieter from 0.75 to 1.25 s (limit 60 ± 1)`);
}

function eraseUntouched() {
  const { rate, x, grid } = toneSetup(1000);
  const fa = Math.round((0.5 * rate) / grid.H), fb = Math.round((1.5 * rate) / grid.H);
  const region = E.renderRegion({ channels: [x], grid, fa, fb, erase: rect(grid, fa, fb, 30, 60, 60), fill: null });
  const reach = fa * grid.H - grid.N / 2, reachEnd = fb * grid.H + grid.N / 2;
  let d = 0, cnt = 0;
  for (let s = region.origin; s < region.origin + region.len; s++) {
    if (s >= reach && s < reachEnd) continue;
    d = Math.max(d, Math.abs(region.yl[0][local(region, s)] - region.xl[0][local(region, s)]));
    cnt++;
  }
  return pass(d === 0 && cnt > 0, `largest change over ${n(cnt)} samples outside the stroke's reach: ${g4(d)} (expected exactly 0)`);
}

function fillTone() {
  const { rate, x, grid } = toneSetup(440);
  const clean = Float32Array.from(x);
  const r = mulberry32(99);
  const g0 = Math.round(0.9 * rate), g1 = Math.round(1.1 * rate);
  for (let i = g0; i < g1; i++) x[i] += 0.5 * (r() * 2 - 1);
  const fa = Math.floor((0.9 * rate - grid.N / 2) / grid.H), fb = Math.ceil((1.1 * rate + grid.N / 2) / grid.H);
  const region = E.renderRegion({ channels: [x], grid, fa, fb, erase: null, fill: rect(grid, fa, fb, 0, grid.bins - 1, 1), rounds: 12 });
  let ec = 0, ey = 0;
  for (let s = g0; s < g1; s++) { ec += clean[s] ** 2; ey += region.yl[0][local(region, s)] ** 2; }
  const level = 10 * Math.log10(ey / ec);
  return pass(Math.abs(level) <= 1, `level in the painted 200 ms: ${signed(level)} dB against the clean tone (limit ±1 dB)`);
}

// The worker's own path (worker.js addStroke, undo, redo): every edit is E.rebuild over the active strokes,
// posted as Float32 samples over [start, end). A Fill stroke and an Erase stroke 3 slices apart, close enough
// that their sound overlaps, so they must be rebuilt together (shared with case 28).
let pairMemo = null;
function pair() {
  if (!pairMemo) {
    const rate = 44100, L = 2 * rate, x = hiss(L, 4, 0.03);
    for (let i = 0; i < L; i++) x[i] += 0.3 * Math.sin((2 * Math.PI * 300 * i) / rate);
    const grid = E.makeGrid(rate, E.stftSize(rate)), fr = E.frameRange(L, grid.N, grid.H);
    const strokes = [strokeOf(upright(1, 'fill', 0.8, 0.04, grid), grid, fr), strokeOf(upright(2, 'erase', 0.9, 0.04, grid), grid, fr)];
    pairMemo = { L, x, grid, strokes, both: null };
  }
  return pairMemo;
}

function undoRedo() {
  const P = pair(), { x, grid, strokes } = P;
  const out = Float32Array.from(x);
  let cursor = 0, outside = 0;
  const sent = (b) => { const { region } = b; for (let i = 0; i < region.len; i++) { const s = region.origin + i; if (region.yl[0][i] !== region.xl[0][i] && (s < b.start || s >= b.end)) outside++; } };
  const add = () => { cursor += 1; sent(patch(out, [x], grid, strokes[cursor - 1], strokes.slice(0, cursor))); };
  const undo = () => { cursor -= 1; sent(patch(out, [x], grid, strokes[cursor], strokes.slice(0, cursor))); };
  add(); const one = out.slice();
  add(); P.both = out.slice();
  undo(); const backToOne = differing(out, one);
  undo(); const backToStart = differing(out, x);
  add(); const redone = differing(out, one);
  let changed = 0;
  for (let i = 0; i < P.L; i++) changed = Math.max(changed, Math.abs(P.both[i] - x[i]));
  const ok = changed > 1e-3 && backToOne === 0 && backToStart === 0 && redone === 0 && outside === 0;
  return pass(ok, `two strokes changed samples by up to ${g4(changed)}; samples differing after Undo from the first stroke's result: ${backToOne}, after Undo, Undo from the original: ${backToStart}, after Redo from the first stroke's result: ${redone}; changed samples outside the span the worker sends: ${outside} (all expected 0)`);
}

// ---- 17 to 19: the demo clip ------------------------------------------------------------------------

// Two runs: this thread's sample and the one the worker made in its own thread (or a second run here).
function sampleDeterministic(wr) {
  const a = demo().s.channels[0], b = wr && wr.loaded && !wr.error ? wr.loaded.channels[0] : makeSample().channels[0];
  let same = a.length === b.length;
  for (let i = 0; same && i < a.length; i++) if (a[i] !== b[i]) same = false;
  let e = 0;
  for (const v of a) e += v * v;
  const rms = 10 * Math.log10(e / a.length);
  return pass(same && Math.abs(rms - RECORDED.sampleRms) <= 0.05, `two runs ${same ? 'identical' : 'differ'}; level ${g4(rms)} dBFS RMS (recorded at build time: ${RECORDED.sampleRms} ± 0.05)`);
}

async function graphSubtraction() {
  const OAC = typeof window !== 'undefined' && (window.OfflineAudioContext || window.webkitOfflineAudioContext);
  if (!OAC) return pass(false, 'this browser has no OfflineAudioContext');
  const L = 44100, ctx = new OAC(1, L, 44100);
  const A = new Float32Array(L), B = new Float32Array(L), r = mulberry32(8);
  for (let i = 0; i < L; i++) { A[i] = 0.4 * Math.sin(i * 0.05) + 0.1 * (r() - 0.5); B[i] = A[i] * 0.7 + 0.01 * (r() - 0.5); }
  const make = (data) => { const buf = ctx.createBuffer(1, L, 44100); buf.copyToChannel(data, 0); const s = ctx.createBufferSource(); s.buffer = buf; return s; };
  const a = make(A), b = make(B), ga = ctx.createGain(), gb = ctx.createGain();
  ga.gain.value = 1; gb.gain.value = -1; // the gains the player uses for "Hear only what you removed"
  a.connect(ga).connect(ctx.destination); b.connect(gb).connect(ctx.destination);
  a.start(0); b.start(0);
  const out = (await ctx.startRendering()).getChannelData(0);
  let e = 0;
  for (let i = 0; i < L; i++) e = Math.max(e, Math.abs(out[i] - (A[i] - B[i])));
  return pass(e < 1e-6, `largest difference between the graph and before minus after: ${g4(e)} (limit 1e-6)`);
}

// the demo clip on this thread (computed once per run), and its stroke rebuilt the way the worker does it
let demoMemo = null;
function demo(mode) {
  if (!demoMemo) {
    const s = makeSample();
    const grid = E.makeGrid(SAMPLE_RATE, E.stftSize(SAMPLE_RATE));
    demoMemo = { s, grid, fr: E.frameRange(s.channels[0].length, grid.N, grid.H) };
  }
  if (mode && !demoMemo[mode]) {
    const { s, grid, fr } = demoMemo;
    const stroke = strokeOf({ ...demoStroke(grid.melLo, grid.melHi), mode }, grid, fr);
    demoMemo[mode] = { stroke, b: E.rebuild({ channels: s.channels, grid, stroke, active: [stroke] }) };
  }
  return mode ? { ...demoMemo, ...demoMemo[mode] } : demoMemo;
}

// The page's own worker (worker.js), started fresh once per run: it makes the demo clip, draws its picture and
// paints out the cough with the demo stroke, exactly as on load; then Undo, through its messages.
function runWorker() {
  return new Promise((resolve) => {
    const res = { error: null, loaded: null, add: null, undo: null };
    if (typeof Worker !== 'function') { res.error = 'this browser cannot start the worker'; resolve(res); return; }
    let w = null, timer = 0;
    const done = (err) => { if (err && !res.error) res.error = err; clearTimeout(timer); if (w) w.terminate(); resolve(res); };
    try { w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }); } catch (err) { done(`the worker did not start: ${err && err.message}`); return; }
    timer = setTimeout(() => done('the worker did not finish within 10 s'), 10000);
    w.onerror = (e) => { if (e && e.preventDefault) e.preventDefault(); done(`the worker failed: ${(e && e.message) || 'error'}`); };
    w.onmessage = (e) => {
      const m = e.data || {};
      if (m.op === 'error') { done(`the worker reported: ${m.message}`); return; }
      if (m.op === 'loaded') { res.loaded = m; return; }
      if (m.op !== 'patch' || !res.loaded || m.strokeId !== 1) return;
      if (m.action === 'add' && !res.add) { res.add = m; w.postMessage({ op: 'undo', token: res.loaded.token }); }
      else if (m.action === 'undo' && !res.undo) { res.undo = m; done(); }
    };
    w.postMessage({ op: 'sample', choice: 'balanced' });
  });
}
const workerFailed = (wr) => pass(false, wr.error || 'the worker sent no result');

// what the demo clip sounds like after a patch: the original with the patch's samples written in
function afterPatch(loaded, p) { const out = Float32Array.from(loaded.channels[0]); out.set(p.channels[0], p.start); return out; }

function demoRegression(wr) {
  if (wr.error || !wr.add) return workerFailed(wr);
  const { s } = demo(), out = afterPatch(wr.loaded, wr.add), ev = s.events.cough;
  let e = 0, c = 0;
  for (let i = Math.round((ev.t0 - 0.05) * SAMPLE_RATE); i < Math.round((ev.t1 + 0.05) * SAMPLE_RATE); i++) {
    const ref = s.channels[0][i] - s.cough[i];
    e += (out[i] - ref) ** 2;
    c += ref * ref;
  }
  const err = 10 * Math.log10(e / c);
  const ok = err <= -15 && Math.abs(err - RECORDED.demoError) <= TOL_DB && wr.add.rounds === 12;
  return pass(ok, `difference from the demo clip without the cough: ${g4(-err)} dB below the music (recorded at build time: ${g4(-RECORDED.demoError)} ± ${TOL_DB}; design limit: at least 15 dB below); ${wr.add.rounds} rounds of Griffin-Lim (expected 12)`);
}

// ---- 20 to 22: the picture's figures ----------------------------------------------------------------

function sliceFigures() {
  const N = E.stftSize(44100), S = E.makeSTFT(N), G = E.makeGrid(44100, N);
  const { first, last } = E.frameRange(441000, N, G.H);
  const frames = last - first + 1;
  const ok = N === 2048 && S.H === 512 && G.H === 512 && S.bins === 1025 && G.bins === 1025 && Math.abs(G.binHz - 21.533) < 5e-4 && Math.abs(S.wsq - 1.5) < 1e-12 && frames === 865 && G.rows === 360;
  return pass(ok, `slices of ${n(N)} samples (${g4((1000 * N) / 44100)} ms), a new one every ${n(S.H)} (picture: ${n(G.H)}), ${n(S.bins)} bands (picture: ${n(G.bins)}) ${g4(G.binHz)} Hz apart, squared windows adding to ${g4(S.wsq)}, ${n(frames)} slices for the 10 s clip, ${G.rows} rows (expected 2,048, 512, 1,025, 21.53 = 44,100 / 2,048, 1.500, 865, 360)`);
}

function sliceRates() {
  const want = [[48000, 'balanced', 2048], [32000, 'balanced', 2048], [22050, 'balanced', 1024], [16000, 'balanced', 1024], [44100, 'short', 1024], [44100, 'long', 4096]];
  const got = want.map(([r, ch]) => E.stftSize(r, ch));
  const g22 = E.makeGrid(22050, E.stftSize(22050));
  const ok = want.every((w, i) => got[i] === w[2]) && g22.bins === 513 && Math.abs(g22.binHz - 21.533) < 5e-4;
  const label = want.map(([r, ch], i) => `${r / 1000} kHz${ch === 'balanced' ? '' : ` ${ch}`}: ${n(got[i])}`).join(', ');
  return pass(ok, `${label}; at 22.05 kHz ${g22.bins} bands ${g4(g22.binHz)} Hz apart (expected 2,048, 2,048, 1,024, 1,024, 1,024, 4,096; 513 bands 21.53 Hz apart)`);
}

// A full-scale sine at the centre of band k: |X[k]| = N/4 through the periodic Hann window (0 dB by the page's
// definition) and half that in bands k - 1 and k + 1 (the Hann window's transform), and the picture lights the
// row that the frequency-to-row function (the one the axis labels use) gives for it, which is also the row the
// SPEC's mapping gives: 360 rows evenly spaced in mel from 12 kHz at the top edge to 40 Hz at the bottom.
function fullScaleSine() {
  const rate = 44100, N = 2048, G = E.makeGrid(rate, N), S = E.makeSTFT(N);
  const top = mel(12000), step = (top - mel(40)) / 360;
  const re = new Float64Array(S.bins), im = new Float64Array(S.bins), power = new Float64Array(S.bins), rowDb = new Float64Array(G.rows);
  const half = 20 * Math.log10(0.5);
  let ok = true, worst = 0;
  const parts = [];
  for (const [label, k] of [['100 Hz', 6], ['1 kHz', 47], ['10 kHz', 464]]) {
    const f = (k * rate) / N;
    const x = Float64Array.from({ length: 4 * N }, (_, i) => Math.sin((2 * Math.PI * k * i) / N + 0.3));
    S.analyse(x, 8, re, im);
    for (let j = 0; j < S.bins; j++) power[j] = re[j] * re[j] + im[j] * im[j];
    const db0 = E.powerDb(power[k], N);
    const side = Math.max(Math.abs(E.powerDb(power[k - 1], N) - half), Math.abs(E.powerDb(power[k + 1], N) - half));
    worst = Math.max(worst, Math.abs(db0), side);
    E.rowsFromPower(power, G, rowDb);
    let best = 0;
    for (let r = 1; r < G.rows; r++) if (rowDb[r] > rowDb[best]) best = r;
    const byFn = Math.round(E.rowOfHz(G, f)), bySpec = Math.round((top - mel(f)) / step - 0.5);
    ok = ok && Math.abs(db0) <= 0.01 && side <= 0.01 && best === byFn && byFn === bySpec;
    parts.push(`${g4(f)} Hz (by the ${label} label): ${signed(db0)} dB, brightest row ${best}, frequency-to-row ${byFn}, mel formula ${bySpec}`);
  }
  return pass(ok, `${parts.join('; ')} (expected 0 dB and -6.021 dB beside it, each within 0.01 dB, largest miss ${g4(worst)}; the three rows equal)`);
}

// ---- 23 to 29: the brush, the masks, Fill in --------------------------------------------------------

// SPEC 6.3: full strength for d <= 0.8 of the radius, 0.5 + 0.5 cos(pi (d - 0.8) / 0.2) to the edge, nothing beyond
function brushShape() {
  const rate = 44100, G = E.makeGrid(rate, 2048);
  const fc = 100, t = (fc * G.H) / rate, m0 = mel(2000), rT = 0.05, rM = 200;
  const want = (d) => { const v = d <= 0.8 ? 1 : d < 1 ? 0.5 + 0.5 * Math.cos((Math.PI * (d - 0.8)) / 0.2) : 0; return v <= 0.001 ? 0 : v; };
  const r = E.rasterise({ points: [[t, m0]], rT, rM }, G, -1, 2000);
  let e = 0, cells = 0;
  for (let f = fc - 6; f <= fc + 6; f++) {
    const col = r.cols.get(f), u = ((f - fc) * G.H) / rate / rT;
    for (let k = 0; k < G.bins; k++) {
      const v = (mel((k * rate) / 2048) - m0) / rM;
      const w = want(Math.hypot(u, v)), got = col ? col[k] : 0;
      if (w > 0) cells++;
      e = Math.max(e, Math.abs(got - w));
    }
  }
  const atTop = E.rasterise({ points: [[t, G.melHi]], rT, rM, top: true }, G, -1, 2000).cols.get(fc);
  const nyq = atTop ? atTop[G.bins - 1] : 0;
  return pass(e < 1e-6 && cells > 0 && nyq === 1, `largest difference from the designed brush over ${n(cells)} painted cells: ${g4(e)} (limit 1e-6); a stroke along the top edge paints the highest band (${n(rate / 2)} Hz) at ${g4(nyq)} (expected 1)`);
}

// SPEC 6.3 and 6.4: Erase removes 60 dB times the brush strength, and overlapping Erase strokes add their
// decibels (their gains multiply); overlapping Fill in strokes keep the stronger value.
function maskRules() {
  const one = (vals) => new Map([[10, Float32Array.from(vals)]]);
  const strokes = [
    { mode: 'erase', f0: 10, f1: 10, cols: one([1, 0.5, 0.25, 0, 0, 0]) },
    { mode: 'erase', f0: 10, f1: 10, cols: one([1, 0, 0, 0, 0, 0]) },
    { mode: 'fill', f0: 10, f1: 10, cols: one([0, 0, 0, 0.6, 0.3, 0]) },
    { mode: 'fill', f0: 10, f1: 10, cols: one([0, 0, 0, 0.3, 0.9, 0]) },
  ];
  const { erase, fill } = E.masksFor(10, 10, strokes, 6);
  const e = erase.get(10), m = fill.get(10);
  const we = [120, 30, 15, 0, 0, 0], wm = [0, 0, 0, 0.6, 0.9, 0];
  let d = 0;
  for (let k = 0; k < 6; k++) d = Math.max(d, Math.abs(e[k] - we[k]) / 60, Math.abs(m[k] - wm[k]));
  return pass(d < 1e-6, `Erase: ${[...e.slice(0, 3)].map(g4).join(', ')} dB where the strokes are at 1 + 1, 0.5 and 0.25 strength (expected 120, 30, 15); Fill in: ${g4(m[3])} and ${g4(m[4])} where they overlap (expected 0.6 and 0.9)`);
}

// SPEC 6.5 step 1: the level a painted band is rebuilt to comes from the mean power of up to 4 untouched slices
// on each side. The engine reports the louder side per band (region.rowBorder); the same mean is computed here.
function borderSlices() {
  const rate = 44100, N = 2048, G = E.makeGrid(rate, N), S = E.makeSTFT(N);
  const x = hiss(rate, 31, 0.1);
  const fa = 40, fb = 49, ka = 20, kb = 300;
  const region = E.renderRegion({ channels: [x], grid: G, fa, fb, erase: null, fill: rect(G, fa, fb, ka, kb, 1), rounds: 0 });
  const re = new Float64Array(S.bins), im = new Float64Array(S.bins), pl = new Float64Array(S.bins), pr = new Float64Array(S.bins);
  for (let j = 1; j <= 4; j++) {
    S.analyse(x, fa - j, re, im);
    for (let k = ka; k <= kb; k++) pl[k] += (re[k] * re[k] + im[k] * im[k]) / 4;
    S.analyse(x, fb + j, re, im);
    for (let k = ka; k <= kb; k++) pr[k] += (re[k] * re[k] + im[k] * im[k]) / 4;
  }
  let e = 0;
  for (let k = ka; k <= kb; k++) { const w = Math.max(pl[k], pr[k]); e = Math.max(e, Math.abs(region.rowBorder[k] - w) / w); }
  return pass(e < 1e-9, `in each of ${kb - ka + 1} painted bands the level read equals the mean power of the 4 untouched slices on each side (4 hops, ${g4((4 * G.H * 1000) / rate)} ms): largest relative difference ${g4(e)} (limit 1e-9)`);
}

// SPEC 6.5 step 4 (texture): over steady hiss a fill should sound like hiss, not a frozen tone, and should
// not count as taking anything out. Measured in the stroke's centre against the hiss that was there.
function hissFill() {
  const rate = 44100, L = 2 * rate, x = hiss(L, 5, 0.05);
  const grid = E.makeGrid(rate, E.stftSize(rate)), fr = E.frameRange(L, grid.N, grid.H), S = E.makeSTFT(grid.N);
  const st = strokeOf(upright(1, 'fill', 1.0, 0.1, grid), grid, fr);
  const b = E.rebuild({ channels: [x], grid, stroke: st, active: [st] });
  const ro = E.readout(b.region, st.cols, grid);
  const net = ro.changed - (ro.rose || 0), removed = E.clearlyRemoved(ro);
  const fc = Math.round((1.0 * rate) / grid.H), ka = 20, kb = 700, lag = 4;
  const re = new Float64Array(S.bins), im = new Float64Array(S.bins);
  const logMag = (y, f) => { S.analyseLocal(y, b.region.origin, f, re, im); const o = new Float64Array(S.bins); for (let k = ka; k <= kb; k++) o[k] = 0.5 * Math.log(re[k] * re[k] + im[k] * im[k] + 1e-30); return o; };
  const measure = (y) => {
    const lm = [];
    for (let f = fc - 6; f <= fc + 6; f++) lm.push(logMag(y, f));
    let d2 = 0, cnt = 0, p = 0, np = 0;
    for (let i = 0; i < lm.length; i++) for (let k = ka; k <= kb; k++) { p += Math.exp(2 * lm[i][k]); np++; if (i + lag < lm.length) { d2 += (lm[i + lag][k] - lm[i][k]) ** 2; cnt++; } }
    return { flicker: Math.sqrt(d2 / cnt / 2), power: p / np };
  };
  const after = measure(b.region.yl[0]), before = measure(b.region.xl[0]);
  const level = 10 * Math.log10(after.power / before.power), ratio = after.flicker / before.flicker;
  const ok = Math.abs(level) <= 2 && ratio >= 0.5 && net < 0.1 && removed === false;
  return pass(ok, `level ${signed(level)} dB against the hiss that was there (limit ±2 dB); flicker ${g4(after.flicker)} nepers against ${g4(before.flicker)}, ratio ${g4(ratio)} (limit: at least 0.5); spots 3 dB quieter less those 3 dB louder: ${g4(100 * net)}% (limit under 10%); clearly taken out: ${yn(removed)} (expected no, so the readout says nothing stood out)`);
}

// File edges: slices whose window reaches past either end hold silence, not sound, so they are never a border.
function fileEdges() {
  const rate = 44100;
  const run = (L, pts, rT, rM, a0, a1) => {
    const x = tone(L, 1000, 0.5, rate);
    const grid = E.makeGrid(rate, E.stftSize(rate)), fr = E.frameRange(L, grid.N, grid.H);
    const p = typeof pts === 'function' ? pts(grid) : pts;
    const st = strokeOf({ id: 1, mode: 'fill', points: p, rT, rM, top: true, bottom: true }, grid, fr);
    const b = E.rebuild({ channels: [x], grid, stroke: st, active: [st] });
    let ex = 0, ey = 0;
    for (let i = Math.round(a0 * rate); i < Math.min(L, Math.round(a1 * rate)); i++) { ex += x[i] ** 2; ey += b.region.yl[0][local(b.region, i)] ** 2; }
    return { level: 10 * Math.log10(ey / ex), noBorders: b.region.noBorders, sides: b.region.sides || {} };
  };
  const col = (t) => (g) => [[t, g.melHi], [t, g.melLo]];
  const start = run(3 * 44100, col(0.02), 0.06, 30, 0, 0.06);
  const end = run(3 * 44100, col(2.98), 0.06, 30, 2.94, 3);
  const whole = run(Math.round(0.25 * rate), (g) => [[0, (g.melHi + g.melLo) / 2], [0.25, (g.melHi + g.melLo) / 2]], 0.1, 300, 0, 0.25);
  // the readout says "from the sound after it" when most painted bands had only a later side, and so on
  const one = (sd, a, b, c) => (sd[a] || 0) > (sd[b] || 0) + (sd[c] || 0);
  const after = one(start.sides, 'after', 'both', 'before'), before = one(end.sides, 'before', 'both', 'after');
  const ok = Math.abs(start.level) <= 1 && Math.abs(end.level) <= 1 && !start.noBorders && !end.noBorders && after && before && whole.noBorders === true;
  return pass(ok, `1 kHz tone at -6 dBFS: a stroke over its first 60 ms leaves it ${signed(start.level)} dB, filled from the sound after it: ${yn(after)}; over its last 60 ms ${signed(end.level)} dB, from the sound before it: ${yn(before)} (limit ±1 dB; expected yes, yes); a stroke over a whole 0.25 s file has nothing untouched to fill from: ${yn(whole.noBorders)} (expected yes)`);
}

// The same two strokes painted in the other order (Erase first): rebuilt together, they must give the same
// samples as in case 16's order.
function nearbyStrokes() {
  const P = pair(), { x, grid, strokes: [a, z] } = P;
  if (!P.both) { const ab = Float32Array.from(x); patch(ab, [x], grid, a, [a]); patch(ab, [x], grid, z, [a, z]); P.both = ab; }
  const ba = Float32Array.from(x);
  patch(ba, [x], grid, z, [z]); patch(ba, [x], grid, a, [z, a]);
  const d = differing(P.both, ba);
  return pass(d === 0 && z.f0 - a.f1 === 3, `a Fill stroke over slices ${a.f0} to ${a.f1} and an Erase stroke over ${z.f0} to ${z.f1} (expected 3 slices apart): ${n(d)} samples differ between the two painting orders (expected 0)`);
}

// The readout's honesty check (as worker.js does it: nothing clearly removed, then carriesOn): a stroke across a
// held note rebuilds the note, and the page must say the note carries on past the stroke; a stroke over a short
// burst removed it.
function carriesOnCheck() {
  const rate = 44100, L = 2 * rate, x = tone(L, 440, 0.3, rate);
  const grid = E.makeGrid(rate, E.stftSize(rate)), fr = E.frameRange(L, grid.N, grid.H);
  const st = strokeOf(upright(1, 'fill', 1.0, 0.05, grid), grid, fr);
  const judge = (y) => {
    const b = E.rebuild({ channels: [y], grid, stroke: st, active: [st] });
    const ro = E.readout(b.region, st.cols, grid);
    const net = ro.changed - (ro.rose || 0);
    return { net, carries: !E.clearlyRemoved(ro) && E.carriesOn(b.region, grid, -40) };
  };
  const held = judge(x);
  const y = Float32Array.from(x), bur = hiss(Math.round(0.04 * rate), 3, 0.5), i0 = Math.round(0.98 * rate);
  for (let i = 0; i < bur.length; i++) y[i0 + i] += bur[i];
  const burst = judge(y);
  return pass(held.carries === true && burst.carries === false, `held 440 Hz note: painted spots made quieter minus those made louder ${g4(100 * held.net)}%, "carries on" ${yn(held.carries)} (expected yes); a 40 ms burst on it: ${g4(100 * burst.net)}%, "carries on" ${yn(burst.carries)} (expected no); bright means at most 40 dB below full scale`);
}

// ---- 30 to 33: the readouts, the WAV round trip, the page's own worker ---------------------------------

// The demo line's numbers, as the worker sends them: the cough's own spots (the number the demo line shows) and
// the median drop of the painted spots that changed (the number a visitor's stroke shows).
function demoReadout(wr) {
  if (wr.error || !wr.add) return workerFailed(wr);
  const ev = wr.add.events || {}, ro = wr.add.readout || {}, cough = ev.cough || {};
  const others = ['ping', 'click'].every((k) => ev[k] && !ev[k].removed);
  const ok = cough.removed === true && Math.abs(cough.drop - RECORDED.demoCoughDrop) <= TOL_DB && typeof ro.db === 'number' && Math.abs(ro.db - RECORDED.demoReadout) <= TOL_DB && others;
  return pass(ok, `cough removed: ${yn(cough.removed)} (expected yes); its spots ${g4(cough.drop)} dB quieter (recorded at build time: ${g4(RECORDED.demoCoughDrop)} ± ${TOL_DB}); painted spots that changed: ${typeof ro.db === 'number' ? g4(ro.db) : ro.db} dB quieter (recorded: ${g4(RECORDED.demoReadout)} ± ${TOL_DB}); ping and click untouched: ${yn(others)} (expected yes)`);
}

// Erase's readout says "turned down by 60 dB". At the stroke's centre (full-strength cells whose overlapping
// slices are all at full strength in that band) that is exactly what the rebuilt sound must measure.
function eraseCentre() {
  const { stroke, grid, b } = demo('erase');
  const centre = new Map();
  for (const [f, col] of stroke.cols) {
    let c = null;
    for (let k = 0; k < grid.bins; k++) {
      let full = true;
      for (let j = -3; j <= 3 && full; j++) { const cj = stroke.cols.get(f + j); if (!cj || !(cj[k] >= 1)) full = false; }
      if (full) { if (!c) c = new Float32Array(grid.bins); c[k] = 1; }
    }
    if (c) centre.set(f, c);
  }
  const ro = E.readout(b.region, centre, grid);
  const ok = ro.db !== null && Math.abs(ro.db - E.ERASE_DB) <= 1 && E.ERASE_DB === 60;
  return pass(ok, `${n(ro.cells)} centre spots over ${centre.size} slices: ${ro.db === null ? 'no change' : `${g4(ro.db)} dB quieter (median)`} (limit 60 ± 1; Erase is set to ${E.ERASE_DB} dB)`);
}

// Every one of the 65,536 16-bit values, in a stereo 48 kHz WAV built here byte by byte (the canonical header,
// CCRMA WaveFormat), opened with the page's reader and saved with its writer: the same bytes must come back.
function wavAllValues() {
  const count = 65536, rate = 48000, bytes = new Uint8Array(44 + 4 * count), v = new DataView(bytes.buffer);
  const tag = (o, s) => { for (let i = 0; i < 4; i++) bytes[o + i] = s.charCodeAt(i); };
  tag(0, 'RIFF'); v.setUint32(4, 36 + 4 * count, true); tag(8, 'WAVE'); tag(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 4, true);
  v.setUint16(32, 4, true); v.setUint16(34, 16, true); tag(36, 'data'); v.setUint32(40, 4 * count, true);
  for (let i = 0; i < count; i++) { v.setInt16(44 + 4 * i, i - 32768, true); v.setInt16(46 + 4 * i, 32767 - i, true); }
  const p = E.parseWav(bytes);
  const back = E.writeWav(p.channels, p.sampleRate);
  let d = back.length === bytes.length ? 0 : Math.abs(back.length - bytes.length);
  for (let i = 0; i < Math.min(back.length, bytes.length); i++) if (back[i] !== bytes[i]) d++;
  return pass(d === 0, `${n(d)} of ${n(bytes.length)} bytes differ after open and save (expected 0); read back at ${n(p.sampleRate)} Hz, ${p.channels.length} channels`);
}

// The worker's picture of the demo clip (SPEC 5 and 6.9), and its own Undo of the demo stroke (worker.js undo):
// Undo must send back the clip exactly as made, over at least the span the stroke changed, and the cough must
// count as removed only while the stroke is in. (Redo goes through the same rebuild; case 16 checks it.)
function workerDemo(wr) {
  if (wr.error || !wr.add || !wr.undo) return workerFailed(wr);
  const L0 = wr.loaded, a = wr.add, u = wr.undo;
  const orig = L0.channels[0];
  let undoDiff = 0;
  for (let i = 0; i < u.channels[0].length; i++) if (u.channels[0][i] !== orig[u.start + i]) undoDiff++;
  const covers = u.start <= a.start && u.start + u.channels[0].length >= a.start + a.channels[0].length;
  const st = (p) => yn(!!(p.events && p.events.cough && p.events.cough.removed));
  const states = `${yn(!!(L0.eventState && L0.eventState.cough && L0.eventState.cough.removed))}, ${st(a)}, ${st(u)}`;
  const ok = L0.N === 2048 && L0.H === 512 && L0.frames === 865 && L0.rows === 360 && L0.hi - L0.lo === 72 && Math.abs(L0.hi - RECORDED.pictureTop) <= 1
    && covers && undoDiff === 0 && states === 'no, yes, no';
  return pass(ok, `picture: ${L0.frames} slices of ${n(L0.N)} samples every ${L0.H}, ${L0.rows} rows, colour scale ${L0.lo} to ${L0.hi} dB (expected 865, 2,048, 512, 360, a 72 dB span, top ${RECORDED.pictureTop} ± 1); after Undo ${n(undoDiff)} of ${n(u.channels[0].length)} samples differ from the clip (expected 0), covering the stroke's span: ${yn(covers)}; cough removed before the stroke, after it, after Undo: ${states} (expected no, yes, no)`);
}

// ---- 34 and 35: the brush's soft edge, and a note that starts under the paint ---------------------------

// SPEC 6.5 step 6: at brush strength m a painted spot becomes exp((1 - m) ln|X| + m ln T), so a half-strength
// brush moves each spot halfway, in dB, from what was there to what Fill in rebuilds: the brush's soft edge.
// A loud burst inside quiet hiss, filled at full and at half strength.
function halfStrength() {
  const rate = 44100, N = 2048, G = E.makeGrid(rate, N), S = E.makeSTFT(N);
  const x = hiss(rate, 17, 0.003), burst = hiss(Math.round(0.08 * rate), 18, 0.3), i0 = Math.round(0.46 * rate);
  for (let i = 0; i < burst.length; i++) x[i0 + i] += burst[i];
  const fa = Math.round((0.4 * rate) / G.H), fb = Math.round((0.6 * rate) / G.H), ka = 20, kb = 700;
  const render = (v) => E.renderRegion({ channels: [x], grid: G, fa, fb, erase: null, fill: rect(G, fa, fb, ka, kb, v), rounds: 12 });
  const full = render(1), half = render(0.5);
  const re = new Float64Array(S.bins), im = new Float64Array(S.bins);
  const level = (r, y) => {
    let sum = 0, cnt = 0;
    for (let f = Math.round((0.47 * rate) / G.H); f <= Math.round((0.53 * rate) / G.H); f++) {
      S.analyseLocal(y, r.origin, f, re, im);
      for (let k = ka + 5; k <= kb - 5; k++) { sum += E.powerDb(re[k] * re[k] + im[k] * im[k], N); cnt++; }
    }
    return sum / cnt;
  };
  const lo = level(full, full.xl[0]), lf = level(full, full.yl[0]), lh = level(half, half.yl[0]);
  const frac = (lo - lh) / (lo - lf);
  return pass(lo - lf > 20 && Math.abs(frac - 0.5) <= 0.15, `the burst's spots read ${g4(lo)} dB, ${g4(lf)} dB after a full-strength fill and ${g4(lh)} dB after a half-strength one: ${g4(frac)} of the way (by design 0.5; limit 0.35 to 0.65)`);
}

// A note that starts under the paint: no border shows its start, so Fill in looks for the moment in the painted
// sound itself (a step from one side's level to the other's) and the note comes back at its own level after
// its start instead of fading in across the stroke (engine.js fillCells).
// ---- 36 and 37: added in revise round 2 (2026-10-18) ----------------------------------------------------

// A click where exact digital silence meets sound: one border has no energy at all, which must give silence on
// that side, not NaN (before round 2 this returned thousands of NaN samples).
function fillSilence() {
  const rate = 44100, L = rate, x = new Float32Array(L), r0 = mulberry32(36);
  for (let i = Math.round(0.53 * rate); i < L; i++) x[i] = 0.05 * (r0() + r0() + r0() + r0() - 2) * Math.sqrt(3);
  for (let i = 0; i < 8; i++) x[Math.round(0.5 * rate) + i] = i % 2 ? -0.6 : 0.6;
  const grid = E.makeGrid(rate, E.stftSize(rate)), fr = E.frameRange(L, grid.N, grid.H);
  const st = strokeOf(upright(1, 'fill', 0.5, 0.03, grid), grid, fr);
  const b = E.rebuild({ channels: [x], grid, stroke: st, active: [st] });
  const y = b.region.yl[0];
  let bad = 0, peak = 0;
  for (let i = 0; i < y.length; i++) { if (!Number.isFinite(y[i])) bad++; else peak = Math.max(peak, Math.abs(y[i])); }
  const ro = E.readout(b.region, st.cols, grid);
  const finite = [ro.drop, ro.net].every(Number.isFinite) && (ro.db === null || Number.isFinite(ro.db));
  return pass(bad === 0 && finite && peak < 0.6, `${n(y.length)} rebuilt samples: ${n(bad)} not finite (expected 0); loudest ${g4(peak)} (the click was 0.6); readout numbers finite: ${yn(finite)}`);
}

// The reviewer's case (C2-2): a narrow ping holds most of the energy in few spots, while the room tone around it
// is re-rolled by Fill in, so the median of the spots that changed undersells it. When nearly all that moved was
// taken out, the page reports the energy drop of the painted part as a whole.
function pingRoomTone() {
  const rate = 44100, L = 2 * rate, x = hiss(L, 36, 0.003), i0 = Math.round(0.8 * rate);
  for (let i = i0; i < Math.min(L, i0 + Math.round(0.45 * rate)); i++) { const t = (i - i0) / rate; x[i] += 0.25 * Math.exp(-t / 0.12) * Math.sin(2 * Math.PI * 3600 * t); }
  const grid = E.makeGrid(rate, E.stftSize(rate)), fr = E.frameRange(L, grid.N, grid.H);
  const m = E.melOf(3600);
  const st = strokeOf({ id: 1, mode: 'fill', points: [[0.79, m], [1.0, m], [1.24, m]], rT: 0.03, rM: 90, top: false, bottom: false }, grid, fr);
  const b = E.rebuild({ channels: [x], grid, stroke: st, active: [st] });
  const ro = E.readout(b.region, st.cols, grid);
  const shown = E.reportedDb(ro);
  const ok = ro.drop >= 20 && ro.net >= 0.9 && shown !== null && Math.abs(shown - ro.drop) <= 3;
  return pass(ok, `painted part ${g4(ro.drop)} dB quieter as a whole (energy; expected at least 20), net share taken out ${g4(ro.net)} (expected at least 0.9); the page shows ${shown === null ? 'nothing' : `${g4(shown)} dB`} (limit: within 3 dB of the energy drop); median of the spots that changed ${ro.db === null ? 'none' : `${g4(ro.db)} dB`}`);
}

function noteStart() {
  const rate = 44100, L = 2 * rate, N = 2048, G = E.makeGrid(rate, N), S = E.makeSTFT(N), fr = E.frameRange(L, N, G.H);
  const k = 47, hz = (k * rate) / N, i0 = rate, x = hiss(L, 21, 0.002);
  for (let i = i0; i < L; i++) x[i] += 0.3 * Math.min(1, (i - i0) / (0.002 * rate)) * Math.sin((2 * Math.PI * hz * (i - i0)) / rate);
  const st = strokeOf(upright(1, 'fill', 1.0, 0.1, G), G, fr);
  const b = E.rebuild({ channels: [x], grid: G, stroke: st, active: [st] });
  const re = new Float64Array(S.bins), im = new Float64Array(S.bins);
  const lvl = (y, f) => { S.analyseLocal(y, b.region.origin, f, re, im); return E.powerDb(re[k] * re[k] + im[k] * im[k], N); };
  const fo = Math.round(i0 / G.H);
  let d = 0;
  for (let f = fo + 3; f <= fo + 6; f++) d += (lvl(b.region.yl[0], f) - lvl(b.region.xl[0], f)) / 4;
  return pass(Math.abs(d) <= 1, `a ${g4(hz)} Hz note starting 1 s in, under a stroke from 0.9 to 1.1 s: after its start it comes back ${signed(d)} dB from its own level (limit ±1 dB)`);
}

const CASES = [
  ['1 DFT of a unit impulse is 1 in every bin (Smith, Mathematics of the DFT)', impulse],
  ['2 Cosine at bin 5 of 64 gives 32 in bins 5 and 59 (Smith, Mathematics of the DFT)', cosine],
  ['3 The real FFT matches a slow, direct DFT sum, and a sine at bin 7 gives X[7] = -iN/2 (DFT definition, Smith, Mathematics of the DFT; sum computed here)', directDft],
  ['4 Parseval: the same energy in time and frequency (Smith, Rayleigh energy theorem)', parseval],
  ['5 Periodic Hann at hop N/2 adds to exactly 1 (Smith, Spectral Audio Signal Processing, overlap-add)', colaHalf],
  ['6 Squared periodic Hann at hop N/4 adds to 1.5 (Smith, Spectral Audio Signal Processing, overlap-add)', colaQuarter],
  ['7 An unedited round trip returns the input (follows from case 6, computed here)', roundTrip],
  ['8 One second of mono 16-bit 44.1 kHz WAV is 88,244 bytes with the canonical header (CCRMA WaveFormat; Microsoft WAVEFORMATEX)', wavHeader],
  ['9 Stereo 48 kHz 16-bit: ByteRate 192,000 and BlockAlign 4 (CCRMA WaveFormat; Microsoft WAVEFORMATEX)', wavStereo],
  ['10 PCM scaling: +1 to 32767, -1 to -32768, 0 to 0, clipping beyond (16-bit range: CCRMA WaveFormat; 0.5 to 16384 is this page\'s rounding, computed here)', pcmScaling],
  ['11 The WAV reader inverts the writer (computed here)', wavReadBack],
  ['12 24-bit PCM extremes read as +1 and -1 (CCRMA WaveFormat layout; reader convention computed here)', wav24],
  ['13 Erase: a 1 kHz tone inside a -60 dB stroke is 60 ± 1 dB quieter (linearity of the STFT, property test)', eraseDepth],
  ['14 Erase leaves every sample outside the stroke\'s reach bit-identical (delta overlap-add, computed here)', eraseUntouched],
  ['15 Fill in brings back a steady 440 Hz tone across a painted 200 ms gap within 1 dB (regression, computed here)', fillTone],
  ['16 Undo returns the original bit for bit and Redo repeats each stroke exactly, through the worker\'s own rebuild (computed here)', undoRedo],
  ['17 The demo clip is the same on every load, here and in the worker (determinism and recorded level, computed here)', sampleDeterministic, 'worker'],
  ['18 Hear only what you removed: the audio graph\'s before minus after equals the arithmetic difference (computed here)', graphSubtraction],
  ['19 The demo stroke leaves a difference 20.7 dB below the music, as the explainer says, with 12 Griffin-Lim rounds (recorded at build time)', demoRegression, 'worker'],
  ['20 Slices of 2,048 samples (46 ms), a new one every 512, with 1,025 bands 21.53 Hz apart at 44,100 Hz (the explainer\'s figures)', sliceFigures],
  ['21 Slice length at other rates and for the slice-length choice: 2,048 from 32 kHz up, 1,024 below, half or double on request (the page\'s design)', sliceRates],
  ['22 A full-scale sine reads 0 dB in its band, -6.02 dB beside it, and lights the row its axis label marks (Hann window: Smith, Spectral Audio Signal Processing)', fullScaleSine],
  ['23 The brush: full strength within 80% of its radius, a cosine edge, and a stroke along the top reaches the highest band (the brush\'s design)', brushShape],
  ['24 Overlapping strokes: Erase takes 60 dB times the brush strength and adds up; Fill in keeps the stronger stroke (the page\'s design)', maskRules],
  ['25 Fill in reads the 4 untouched slices, about 46 ms, on each side of the painted area, as the explainer says (computed here)', borderSlices],
  ['26 Fill in over plain hiss keeps its level and a matching flicker, and takes nothing out (property test, computed here)', hissFill],
  ['27 Fill in at the very start and end of a file keeps a steady tone within 1 dB; over a whole file it has nothing to fill from (computed here)', fileEdges],
  ['28 Two nearby strokes give the same samples in either painting order, because they are rebuilt together (computed here)', nearbyStrokes],
  ['29 A stroke across a held note says the note carries on past it; a stroke over a short burst does not (computed here)', carriesOnCheck],
  ['30 Readout: the demo line says the cough is removed, with the drops recorded at build time (regression, ± 0.5 dB)', demoReadout, 'worker'],
  ['31 Readout: at the centre of a real Erase stroke over the demo cough the sound is 60 ± 1 dB quieter, as the readout says (computed here)', eraseCentre],
  ['32 Every one of the 65,536 16-bit values comes back unchanged through open and save (stereo 48 kHz WAV, computed here)', wavAllValues],
  ['33 The page\'s own worker draws the demo clip with the figures above, and its Undo of the demo stroke gives back the clip bit for bit (computed here)', workerDemo, 'worker'],
  ['34 A half-strength brush moves each spot halfway, in dB, towards what Fill in rebuilds: the brush\'s soft edge (by design, computed here)', halfStrength],
  ['35 A note that starts under the paint comes back at its own level after its start, not faded in (computed here)', noteStart],
  ['36 Fill in over a click between exact digital silence and sound returns only finite samples, never NaN (computed here)', fillSilence],
  ['37 A ping over room tone, painted along: the readout gives how much quieter the painted part became as a whole, within 3 dB of its energy drop (regression, computed here)', pingRoomTone],
];

// let the page breathe between cases (no timer clamping), so the playhead and the hints keep moving
function breathe() {
  return new Promise((resolve) => {
    if (typeof MessageChannel !== 'function') { setTimeout(resolve, 0); return; }
    const ch = new MessageChannel();
    ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
    ch.port2.postMessage(0);
  });
}

async function runAll() {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  demoMemo = null; pairMemo = null;
  // the worker runs in its own thread: start it first; the cases that read it run after the others
  const fromWorker = runWorker();
  const results = new Array(CASES.length);
  const one = async (i, arg) => {
    const [name, run] = CASES[i];
    let outcome;
    try { outcome = await run(arg); } catch (err) { outcome = { ok: false, detail: `threw ${err && err.message}` }; }
    results[i] = { name, ok: !!outcome && outcome.ok === true, detail: String(outcome && outcome.detail) };
    await breathe();
  };
  for (let i = 0; i < CASES.length; i++) if (CASES[i][2] !== 'worker') await one(i);
  const wr = await fromWorker;
  for (let i = 0; i < CASES.length; i++) if (CASES[i][2] === 'worker') await one(i, wr);
  demoMemo = null; pairMemo = null;
  const passed = results.filter((c) => c.ok).length;
  const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
  return { ok: passed === results.length, total: results.length, passed, ms, cases: results };
}

// one run at a time: a second call while a run is going gets the same result
let running = null;
export function runSelfTest() {
  if (!running) running = runAll().finally(() => { running = null; });
  return running;
}

if (typeof window !== 'undefined') {
  window.__sedSelfTest = runSelfTest;
  const render = async (btn) => {
    const out = btn.parentElement.querySelector('.pos-selftest-out');
    btn.disabled = true;
    if (out) out.textContent = `Running ${CASES.length} checks…`;
    const res = await runSelfTest();
    btn.disabled = false;
    if (!out) return;
    out.textContent = '';
    const sum = document.createElement('p');
    sum.className = 'sum';
    sum.textContent = `${res.passed} of ${res.total} checks pass (${(res.ms / 1000).toFixed(1)} s).`;
    const key = document.createElement('p');
    key.className = 'key';
    const keyText = document.createElement('small');
    keyText.textContent = 'Each check names its source. "Computed here" means the expected value was worked out on this page by a separate method; "recorded at build time" means it was measured when the page was built, so any change shows up; "design" marks a value the page sets on purpose.';
    key.append(keyText);
    const ol = document.createElement('ol');
    for (const c of res.cases) {
      const li = document.createElement('li');
      li.className = c.ok ? 'ok' : 'bad';
      li.textContent = `${c.ok ? 'Pass' : 'Fail'}: ${c.name.replace(/^\d+ /, '')}`;
      const small = document.createElement('small');
      // a true minus sign in exponents (1e−12), so a phone never breaks a number after its hyphen
      small.textContent = c.detail.replace(/e-(\d)/g, 'e\u2212$1');
      li.append(small);
      ol.append(li);
    }
    out.append(sum, key, ol);
  };
  for (const btn of document.querySelectorAll('.pos-run-selftest')) btn.addEventListener('click', () => { render(btn).catch(() => { btn.disabled = false; }); });
}
