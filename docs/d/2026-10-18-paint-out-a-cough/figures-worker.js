// The explainer's figures, computed off the main thread with the page's own engine from the demo clip:
// the clip's picture (drawn exactly as worker.js draws it, with the same colour scale), and the demo stroke
// rebuilt twice, once as Fill in (the result the picture at the top shows) and once as Erase, plus the short
// stretches of sound the figures' Play buttons ask for. figures.js starts this worker only when a figure comes
// near the screen, and ends it after its one answer.
import { makeGrid, makeSTFT, frameRange, stftSize, rowsFromPower, codeOf, rasterise, rebuild } from './engine.js';
import { makeSample, demoStroke } from './sample.js';

const FADE_S = 0.012; // a stretch fades in and out over 12 ms, so it starts and ends without a click

// requests: [{ key, show: 'original' | 'erase' | 'fill', t0, t1 }], the stretches to cut for the Play buttons
export function computeFigures(requests = []) {
  const s = makeSample();
  const rate = s.rate, x = s.channels[0], L = x.length;
  const N = stftSize(rate), grid = makeGrid(rate, N), H = grid.H, rows = grid.rows;
  const { first, last } = frameRange(L, N, H);
  const frames = last - first + 1;
  const S = makeSTFT(N);
  const re = new Float64Array(S.bins), im = new Float64Array(S.bins), power = new Float64Array(S.bins);
  const rowDb = new Float64Array(rows);

  // the picture: dB per row in 1/64 dB steps and a histogram, so the colour scale is the hero's
  const db = new Int16Array(frames * rows);
  const hist = new Uint32Array(241); // -220 .. +20 dB
  for (let f = first; f <= last; f++) {
    S.analyse(x, f, re, im);
    for (let k = 0; k < S.bins; k++) power[k] = re[k] * re[k] + im[k] * im[k];
    rowsFromPower(power, grid, rowDb);
    const o = (f - first) * rows;
    for (let r = 0; r < rows; r++) {
      const v = Math.max(-220, Math.min(20, rowDb[r]));
      db[o + r] = Math.round(v * 64);
      hist[Math.round(v) + 220]++;
    }
  }
  const total = frames * rows;
  let acc = 0, p997 = -60;
  for (let i = hist.length - 1; i >= 0; i--) { acc += hist[i]; if (acc >= total * 0.003) { p997 = i - 220; break; } }
  const hi = Math.max(-60, p997 + 4), lo = hi - 72;
  const before = new Uint8Array(total);
  for (let i = 0; i < total; i++) before[i] = codeOf(db[i] / 64, lo, hi);

  // the demo stroke, rebuilt as Fill in and as Erase; the picture's columns come from the rebuilt region
  const d = demoStroke(grid.melLo, grid.melHi);
  const r = rasterise(d, grid, first, last);
  const variant = (mode) => {
    const stroke = { ...d, mode, cols: r.cols, f0: r.f0, f1: r.f1 };
    const { region, fa, fb, start, end } = rebuild({ channels: [x], grid, stroke, active: [stroke] });
    const out = Float32Array.from(x);
    out.set(region.yl[0].subarray(start - region.origin, end - region.origin), start);
    const c0 = Math.max(first, fa - 3), c1 = Math.min(last, fb + 3);
    const after = before.slice();
    for (let f = c0; f <= c1; f++) {
      S.analyseLocal(region.yl[0], region.origin, f, re, im);
      for (let k = 0; k < S.bins; k++) power[k] = re[k] * re[k] + im[k] * im[k];
      rowsFromPower(power, grid, rowDb);
      const o = (f - first) * rows;
      for (let q = 0; q < rows; q++) after[o + q] = codeOf(rowDb[q], lo, hi);
    }
    return { after, out, c0: c0 - first, c1: c1 - first };
  };
  const fill = variant('fill');
  const erase = variant('erase');

  const signal = { original: x, erase: erase.out, fill: fill.out };
  const fadeN = Math.round(FADE_S * rate);
  const clips = {};
  for (const q of requests) {
    if (!q || clips[q.key] || !signal[q.show]) continue;
    const i0 = Math.max(0, Math.round(q.t0 * rate)), i1 = Math.min(L, Math.round(q.t1 * rate));
    if (!(i1 - i0 > 2 * fadeN)) continue;
    const c = signal[q.show].slice(i0, i1);
    for (let i = 0; i < fadeN; i++) { const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeN); c[i] *= g; c[c.length - 1 - i] *= g; }
    clips[q.key] = { t0: i0 / rate, samples: c };
  }
  return {
    op: 'figures', rate, N, H, first, frames, rows, melLo: grid.melLo, melHi: grid.melHi, duration: L / rate, lo, hi,
    before, fill: fill.after, erase: erase.after, c0: Math.min(fill.c0, erase.c0), c1: Math.max(fill.c1, erase.c1),
    stroke: { points: d.points, rT: d.rT, rM: d.rM, top: d.top, bottom: d.bottom }, clips,
  };
}

if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.onmessage = (ev) => {
    if (!ev.data || ev.data.op !== 'figures') return;
    try {
      const m = computeFigures(ev.data.clips);
      self.postMessage(m, [m.before.buffer, m.fill.buffer, m.erase.buffer, ...Object.values(m.clips).map((c) => c.samples.buffer)]);
    } catch (err) {
      self.postMessage({ op: 'error', message: String((err && err.message) || err).slice(0, 200) });
    }
  };
}
