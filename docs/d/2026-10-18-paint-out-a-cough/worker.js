// The background worker: holds the original recording and the list of strokes, draws the picture and
// rebuilds only the painted stretch after each stroke, Undo or Redo. It never stores a full STFT.
import {
  makeGrid, makeSTFT, frameRange, stftSize, rowsFromPower, codeOf, rasterise, rebuild, readout, carriesOn, clearlyRemoved, parseWav, melOf,
} from './engine.js';
import { makeSample, demoStroke } from './sample.js';

const MAX_SECONDS = 120;

let st = null; // the loaded recording
let token = 0;

function post(msg, transfer) { self.postMessage(msg, transfer || []); }
function fail(where, err) { post({ op: 'error', token, where, message: String((err && err.message) || err).slice(0, 200) }); }

// ---- loading -------------------------------------------------------------------------------------

function load({ name, rate, channels, isSample, events, parts, notice, choice, deep }) {
  token += 1;
  st = { name, rate, channels, length: channels[0].length, isSample: !!isSample, events: events || null, strokes: [], cursor: 0, choice: choice || 'balanced', deep: !!deep };
  buildPicture();
  if (st.isSample && parts) prepareEvents(parts);
  const copies = st.channels.map((c) => c.slice());
  const before = st.before.slice();
  post({ op: 'loaded', token, name, rate, length: st.length, isSample: st.isSample, deep: st.deep, events: st.events, eventState: eventStates(), notice: notice || null, channels: copies, ...pictureMessage(before) },
    [...copies.map((c) => c.buffer), before.buffer]);
}

function buildPicture() {
  const N = stftSize(st.rate, st.choice);
  st.grid = makeGrid(st.rate, N);
  const { first, last } = frameRange(st.length, N, N / 4);
  st.first = first; st.last = last;
  const frames = last - first + 1, rows = st.grid.rows;
  const S = makeSTFT(N);
  const re = new Float64Array(S.bins), im = new Float64Array(S.bins), power = new Float64Array(S.bins);
  const rowDb = new Float64Array(rows);
  const db = new Int16Array(frames * rows);
  const hist = new Uint32Array(241); // -220 .. +20 dB
  let lastPost = performance.now();
  for (let f = first; f <= last; f++) {
    power.fill(0);
    for (const x of st.channels) {
      S.analyse(x, f, re, im);
      for (let k = 0; k < S.bins; k++) power[k] += (re[k] * re[k] + im[k] * im[k]) / st.channels.length;
    }
    rowsFromPower(power, st.grid, rowDb);
    const o = (f - first) * rows;
    for (let r = 0; r < rows; r++) {
      const v = Math.max(-220, Math.min(20, rowDb[r]));
      db[o + r] = Math.round(v * 64);
      hist[Math.round(v) + 220]++;
    }
    if (frames > 2000 && performance.now() - lastPost > 120) { lastPost = performance.now(); post({ op: 'progress', token, done: f - first, total: frames }); }
  }
  // the brightest 0.3% of the picture sets the top of the colour scale; the scale spans 72 dB
  const total = frames * rows;
  let acc = 0, p997 = -60;
  for (let i = hist.length - 1; i >= 0; i--) { acc += hist[i]; if (acc >= total * 0.003) { p997 = i - 220; break; } }
  st.hi = Math.max(-60, p997 + 4);
  st.lo = st.hi - 72;
  const before = new Uint8Array(total);
  for (let i = 0; i < total; i++) before[i] = codeOf(db[i] / 64, st.lo, st.hi);
  st.before = before;
}

function pictureMessage(before) {
  const g = st.grid;
  return { N: g.N, H: g.H, first: st.first, frames: st.last - st.first + 1, rows: g.rows, melLo: g.melLo, melHi: g.melHi, lo: st.lo, hi: st.hi, choice: st.choice, before };
}

// ---- the demo clip's noises: is each one really gone? ---------------------------------------------------
// For the cough, the ping and the click the worker knows each noise on its own (the clip is synthesized).
// It keeps the time-frequency cells where that noise was at least 6 dB louder than everything else, and the
// level those cells would have without the noise. After every rebuild it measures what is left in them: a
// noise counts as removed when its cells are back within 6 dB of the noise-free level (for the demo cough that
// is a drop of about 19 dB, for a fully painted ping about 44 dB). Otherwise the page says part of it is left.
const REMOVED_EXCESS_DB = 6;

function prepareEvents(parts) {
  st.output = Float32Array.from(st.channels[0]);
  st.eventCells = {};
  const g = st.grid, S = makeSTFT(g.N);
  const re = new Float64Array(g.bins), im = new Float64Array(g.bins), r2 = new Float64Array(g.bins), i2 = new Float64Array(g.bins);
  const kMax = Math.min(g.bins - 1, Math.floor(16000 / g.binHz));
  for (const name of ['cough', 'ping', 'click']) {
    const ev = st.events[name], part = parts[name];
    if (!ev || !part) continue;
    const rest = Float32Array.from(st.channels[0], (v, i) => v - part[i]);
    const f0 = Math.max(st.first, Math.floor(((ev.t0 - 0.05) * st.rate) / g.H)), f1 = Math.min(st.last, Math.ceil(((ev.t1 + 0.05) * st.rate) / g.H));
    const cells = [], restP = [];
    let before = 0, restSum = 0;
    for (let f = f0; f <= f1; f++) {
      S.analyse(part, f, re, im);
      S.analyse(rest, f, r2, i2);
      for (let k = 1; k <= kMax; k++) {
        const pe = re[k] * re[k] + im[k] * im[k], pr = r2[k] * r2[k] + i2[k] * i2[k];
        if (pe >= 4 * pr && pe > 0) {
          cells.push(f, k); restP.push(pr); restSum += pr;
          before += (re[k] + r2[k]) ** 2 + (im[k] + i2[k]) ** 2;
        }
      }
    }
    st.eventCells[name] = { cells: Int32Array.from(cells), rest: Float64Array.from(restP), restSum, before };
  }
}

// For each noise: removed or not, the drop in its cells, and (when some is left) where the rest of it is.
function eventStates() {
  if (!st.isSample || !st.eventCells) return null;
  const g = st.grid, S = makeSTFT(g.N);
  const re = new Float64Array(g.bins), im = new Float64Array(g.bins);
  const out = {};
  for (const [name, ev] of Object.entries(st.eventCells)) {
    let after = 0, f = null;
    const left = [];
    for (let i = 0, c = 0; i < ev.cells.length; i += 2, c++) {
      if (ev.cells[i] !== f) { f = ev.cells[i]; S.analyse(st.output, f, re, im); }
      const k = ev.cells[i + 1];
      const p = re[k] * re[k] + im[k] * im[k];
      after += p;
      if (p > 4 * ev.rest[c]) left.push([f, k, p - ev.rest[c]]);
    }
    const excess = 10 * Math.log10((after + 1e-30) / (ev.restSum + 1e-30));
    const removed = excess <= REMOVED_EXCESS_DB;
    let span = null;
    if (!removed && left.length) {
      // the stretch holding the middle 90% of what is left, in seconds and hertz
      const q = (arr, idx) => {
        const sorted = arr.slice().sort((a, b) => a[idx] - b[idx]);
        let tot = 0; for (const x of sorted) tot += x[2];
        let acc = 0, lo = sorted[0][idx], hi = sorted[sorted.length - 1][idx], gotLo = false;
        for (const x of sorted) { acc += x[2]; if (!gotLo && acc >= 0.05 * tot) { lo = x[idx]; gotLo = true; } if (acc >= 0.95 * tot) { hi = x[idx]; break; } }
        return [lo, hi];
      };
      const [fa, fb] = q(left, 0), [ka, kb] = q(left, 1);
      span = { t0: (fa * g.H) / st.rate, t1: (fb * g.H) / st.rate, hz0: ka * g.binHz, hz1: kb * g.binHz };
    }
    // touched: an active stroke's mask reaches at least one of the noise's own cells at half strength or more
    let touched = false;
    for (const sk of activeStrokes()) {
      if (!sk.cols || touched) continue;
      for (let i = 0; i < ev.cells.length; i += 2) { const col = sk.cols.get(ev.cells[i]); if (col && col[ev.cells[i + 1]] >= 0.5) { touched = true; break; } }
    }
    out[name] = { removed, touched, excess: Math.round(excess * 10) / 10, drop: Math.round(10 * Math.log10((ev.before + 1e-30) / (after + 1e-30)) * 10) / 10, left: span };
  }
  return out;
}

function loadWav(name, buffer, choice) {
  let parsed;
  try { parsed = parseWav(new Uint8Array(buffer), MAX_SECONDS); } catch (err) { post({ op: 'wav-fallback', token, name, reason: String(err.message || err) }); return; }
  const cut = parsed.totalFrames > parsed.channels[0].length;
  loadPcm(name, parsed.sampleRate, parsed.channels, choice, cut, null, parsed.format === 3 || parsed.bits > 16);
}

// deep: the source holds more than 16 bits per sample (Save WAV then adds a faint dither before rounding)
function loadPcm(name, rate, channels, choice, alreadyCut, notice, deep = true) {
  const notices = notice ? [notice] : [];
  let ch = channels;
  if (ch.length > 2) { notices.push(`${name} has ${ch.length} channels; the first two were kept.`); ch = ch.slice(0, 2); }
  const max = Math.floor(MAX_SECONDS * rate);
  if (ch[0].length > max || alreadyCut) { notices.push(`Only the first 2 minutes of ${name} were loaded. This page works on up to 2 minutes at a time.`); ch = ch.map((c) => (c.length > max ? c.slice(0, max) : c)); }
  if (ch[0].length < rate * 0.1) { post({ op: 'reject', token, name, message: `${name} is shorter than a tenth of a second.` }); return; }
  let peak = 0;
  for (const c of ch) for (let i = 0; i < c.length; i++) { const a = Math.abs(c[i]); if (a > peak) peak = a; }
  if (!(peak > 1e-6)) { post({ op: 'reject', token, name, message: `${name} has no sound in it.` }); return; }
  load({ name, rate, channels: ch.map((c) => (c instanceof Float32Array ? c : Float32Array.from(c))), isSample: false, notice: notices.join(' ') || null, choice, deep });
}

// ---- strokes -------------------------------------------------------------------------------------

function activeStrokes() { return st.strokes.slice(0, st.cursor); }

// The demo clip only (the page made the ping, so it knows where it is): a Fill stroke with at least 40% of its
// path inside the ping's capsule (8.50 to 9.45 s, both lines plus the brush) takes the whole ping, from 30 ms
// before its start to where it fades. Visitors' own files keep the "part is still there" coaching.
function growOnPing(stroke) {
  const ev = st.isSample && st.events && st.events.ping;
  if (!ev || stroke.mode !== 'fill' || !stroke.points.length) return false;
  const m1 = melOf(ev.f1), m2 = melOf(ev.f2), pad = 2 * st.grid.step;
  const t0 = ev.t0 - 0.05, t1 = ev.t1;
  const inside = stroke.points.filter((p) => p[0] >= t0 && p[0] <= t1 && p[1] + stroke.rM >= m1 - pad && p[1] - stroke.rM <= m2 + pad).length;
  if (inside < 0.4 * stroke.points.length) return false;
  const cap = { points: [[ev.t0 - 0.03, (m1 + m2) / 2], [ev.t1, (m1 + m2) / 2]], rT: 0.03, rM: (m2 - m1) / 2 + pad + 40, top: false, bottom: false };
  const r = rasterise(cap, st.grid, st.first, st.last);
  for (const [f, col] of r.cols) {
    const mine = stroke.cols.get(f);
    if (!mine) { stroke.cols.set(f, col); continue; }
    for (let k = 0; k < col.length; k++) if (col[k] > mine[k]) mine[k] = col[k];
  }
  stroke.f0 = stroke.f0 === null ? r.f0 : Math.min(stroke.f0, r.f0);
  stroke.f1 = stroke.f1 === null ? r.f1 : Math.max(stroke.f1, r.f1);
  stroke.grew = 'ping';
  return true;
}

function addStroke(s) {
  const r = rasterise(s, st.grid, st.first, st.last);
  const stroke = { ...s, cols: r.cols, f0: r.f0, f1: r.f1 };
  if (r.f0 !== null) growOnPing(stroke);
  st.strokes.length = st.cursor;
  st.strokes.push(stroke);
  st.cursor += 1;
  if (stroke.f0 === null) { post({ op: 'patch', token, action: 'add', strokeId: s.id, empty: true, canUndo: st.cursor > 0, canRedo: false }); return; }
  apply(stroke, 'add');
}

function undo() {
  if (st.cursor <= 0) return;
  st.cursor -= 1;
  const stroke = st.strokes[st.cursor];
  if (stroke.f0 === null) { post({ op: 'patch', token, action: 'undo', strokeId: stroke.id, empty: true, canUndo: st.cursor > 0, canRedo: true }); return; }
  apply(stroke, 'undo');
}

function redo() {
  if (st.cursor >= st.strokes.length) return;
  const stroke = st.strokes[st.cursor];
  st.cursor += 1;
  if (stroke.f0 === null) { post({ op: 'patch', token, action: 'redo', strokeId: stroke.id, empty: true, canUndo: true, canRedo: st.cursor < st.strokes.length }); return; }
  apply(stroke, 'redo');
}

// picture columns of a rendered region: the cleaned recording and what was removed
function columnsOf(region, c0, c1) {
  const g = st.grid, rows = g.rows, count = c1 - c0 + 1, nch = region.yl.length;
  const after = new Uint8Array(count * rows), removed = new Uint8Array(count * rows);
  const S = makeSTFT(g.N);
  const re = new Float64Array(g.bins), im = new Float64Array(g.bins);
  const pa = new Float64Array(g.bins), pr = new Float64Array(g.bins), rowDb = new Float64Array(rows);
  const diff = region.xl.map((x, ch) => { const d = new Float64Array(x.length); const y = region.yl[ch]; for (let i = 0; i < x.length; i++) d[i] = x[i] - y[i]; return d; });
  for (let f = c0; f <= c1; f++) {
    pa.fill(0); pr.fill(0);
    for (let ch = 0; ch < nch; ch++) {
      S.analyseLocal(region.yl[ch], region.origin, f, re, im);
      for (let k = 0; k < g.bins; k++) pa[k] += (re[k] * re[k] + im[k] * im[k]) / nch;
      S.analyseLocal(diff[ch], region.origin, f, re, im);
      for (let k = 0; k < g.bins; k++) pr[k] += (re[k] * re[k] + im[k] * im[k]) / nch;
    }
    const o = (f - c0) * rows;
    rowsFromPower(pa, g, rowDb);
    for (let r = 0; r < rows; r++) after[o + r] = codeOf(rowDb[r], st.lo, st.hi);
    rowsFromPower(pr, g, rowDb);
    for (let r = 0; r < rows; r++) removed[o + r] = codeOf(rowDb[r], st.lo, st.hi);
  }
  return { after, removed, count };
}

// the strokes that shape the sound: active ones, except those Fill in "kept" (see apply)
function liveStrokes() { return activeStrokes().filter((s) => !s.kept); }

const WIDEN = [2, 3, 4.5, 6];
const WIDEN_MAX = 0.4; // seconds either side
const WIDEN_VERTICAL = [0.075, 0.12, 0.18, 0.25, 0.33, 0.4]; // a mostly vertical stroke starts 0.15 s wide

// The noise rows of a trial: pitch bands whose loudest painted cell stood at least 6 dB above its louder
// untouched border. Returns how many there are (share of the painted bands) and how many of them the trial
// brought back to within 6 dB of that border.
function noiseRows(region, cols, g) {
  if (!region.rowIn) return { share: 0, cleared: 0 };
  const kMax = Math.min(g.bins - 1, Math.floor(16000 / g.binHz));
  const rows = [];
  let painted = 0;
  for (let k = 1; k <= kMax; k++) {
    if (!(region.rowIn[k] > 0)) continue;
    painted++;
    if (region.rowIn[k] >= 4 * region.rowBorder[k]) rows.push(k);
  }
  if (!rows.length || !painted) return { share: 0, cleared: 0 };
  const S = makeSTFT(g.N), re = new Float64Array(g.bins), im = new Float64Array(g.bins);
  const after = new Float64Array(g.bins);
  for (const [f, col] of cols) {
    for (let ch = 0; ch < region.yl.length; ch++) {
      S.analyseLocal(region.yl[ch], region.origin, f, re, im);
      for (const k of rows) if (col[k] >= 0.5) after[k] = Math.max(after[k], re[k] * re[k] + im[k] * im[k]);
    }
  }
  let cleared = 0;
  for (const k of rows) if (after[k] <= 4 * region.rowBorder[k]) cleared++;
  // how well the two sides of the painted area agree, over all painted bands (median power ratio)
  const sk = [];
  for (let k = 1; k <= kMax; k++) if (region.rowIn[k] > 0) sk.push(region.rowSkew ? region.rowSkew[k] : 1e6);
  sk.sort((a, b) => a - b);
  return { share: rows.length / painted, cleared: cleared / rows.length, skew: sk.length ? sk[Math.floor(sk.length / 2)] : 1e6 };
}

function widen(stroke) {
  const g = st.grid;
  // a stroke that covers most of the picture's height is a vertical stroke through a noise burst
  let mlo = Infinity, mhi = -Infinity;
  for (const p of stroke.points) { mlo = Math.min(mlo, p[1] - stroke.rM); mhi = Math.max(mhi, p[1] + stroke.rM); }
  const vertical = (stroke.top && stroke.bottom) || (mhi - mlo) > 0.6 * (g.melHi - g.melLo);
  // the usual widths (2 to 6 times) may be accepted by either rule; the extra widths of a vertical stroke only
  // by the broad-noise rule, which needs steady sound on both sides (never speech)
  const usual = WIDEN.map((k) => Math.min(WIDEN_MAX, stroke.rT * k));
  const widths = [...new Set([...usual, ...(vertical ? WIDEN_VERTICAL : [])])].sort((a, b) => a - b);
  for (const rT of widths) {
    if (rT <= stroke.rT) continue;
    const anyRule = usual.includes(rT);
    const r = rasterise({ ...stroke, rT }, g, st.first, st.last);
    if (r.f0 === null) continue;
    const trial = { ...stroke, rT, cols: r.cols, f0: r.f0, f1: r.f1 };
    const active = liveStrokes().map((s) => (s === stroke ? trial : s));
    const res = rebuild({ channels: st.channels, grid: g, stroke: trial, active });
    const ro = readout(res.region, trial.cols, g);
    ro.clear = clearlyRemoved(ro);
    ro.carries = !ro.clear && carriesOn(res.region, g, st.hi - 40);
    // Accept when the wider stroke clearly takes something out, judged two ways, both strict so it never blurs
    // away speech: (1) at least half the painted spots got quieter (net of those that got louder), nearly all
    // the energy that moved went down, and the painted sound dropped 6 dB or more in all; or (2) a broad noise:
    // at least a third of the painted pitch bands stood 6 dB or more above their borders, and the wider stroke
    // brought 80% of them back to their borders, even when a steady chord holds most of the energy.
    const nr = ro.clear && !ro.carries ? noiseRows(res.region, trial.cols, g) : { share: 0, cleared: 0, skew: 1e6 };
    // (2) also needs the two sides to agree (median within 3 dB: steady music, not changing speech) and nearly
    // all the moved energy to have gone down
    if ((anyRule && ro.changed - ro.rose >= 0.5 && ro.net >= 0.8 && ro.drop >= 6 && !ro.carries) || (ro.clear && !ro.carries && nr.share >= 0.33 && nr.cleared >= 0.8 && nr.skew <= 2 && ro.net >= 0.8)) {
      Object.assign(stroke, { rT, cols: r.cols, f0: r.f0, f1: r.f1, widened: true });
      ro.widened = rT;
      return { res, ro };
    }
  }
  return null;
}
void WIDEN_MAX;

function apply(stroke, action) {
  const t0 = performance.now();
  const g = st.grid;
  if (action !== 'undo') stroke.kept = false;
  let res = rebuild({ channels: st.channels, grid: g, stroke, active: liveStrokes() });
  let ro = null;
  if (action !== 'undo') {
    ro = readout(res.region, stroke.cols, g);
    // a bright sound (within 40 dB of the top of the picture's colour scale) that carries on past the stroke
    ro.clear = clearlyRemoved(ro);
    ro.carries = stroke.mode !== 'erase' && !ro.clear && !stroke.grew && carriesOn(res.region, g, st.hi - 40);
    if (stroke.grew) ro.grew = stroke.grew;
    stroke.readout = ro;
    if (ro.carries) {
      // The stroke sits inside a longer loud sound. Try it wider in time (up to 0.4 s either side): if a wider
      // stroke clearly takes out something that stood out (see widen), keep the wider stroke and say so.
      // Otherwise Fill in keeps the sound as it was, so the page's words are literally true and nothing gets worse.
      const wide = widen(stroke);
      if (wide) { res = wide.res; ro = wide.ro; stroke.readout = ro; }
      else { stroke.kept = true; res = rebuild({ channels: st.channels, grid: g, stroke, active: liveStrokes() }); }
    }
  }
  const { region, fa, fb, start, end, rounds } = res;
  const out = region.yl.map((y) => Float32Array.from(y.subarray(start - region.origin, end - region.origin)));
  if (st.output) st.output.set(out[0], start);
  const c0 = Math.max(st.first, fa - 3), c1 = Math.min(st.last, fb + 3);
  const { after, removed, count } = columnsOf(region, c0, c1);
  // which of the demo clip's noises this stroke's mask reaches (so a stroke that touches one never goes unremarked)
  const hit = [];
  if (st.eventCells && action !== 'undo') {
    for (const [name, ev] of Object.entries(st.eventCells)) {
      // the noise's box: the frames and bands its own cells span
      let fa = Infinity, fb = -Infinity, ka = Infinity, kb = -Infinity;
      for (let i = 0; i < ev.cells.length; i += 2) { fa = Math.min(fa, ev.cells[i]); fb = Math.max(fb, ev.cells[i]); ka = Math.min(ka, ev.cells[i + 1]); kb = Math.max(kb, ev.cells[i + 1]); }
      let inBox = false;
      for (const [f, col] of stroke.cols) {
        if (f < fa || f > fb) continue;
        for (let k = ka; k <= kb; k++) if (col[k] >= 0.5) { inBox = true; break; }
        if (inBox) break;
      }
      if (inBox) hit.push(name);
    }
  }
  post({
    op: 'patch', token, action, strokeId: stroke.id, start, channels: out, colFrom: c0 - st.first, colCount: count, after, removed,
    readout: ro, mode: stroke.mode, noBorders: region.noBorders, sides: region.sides, rounds, frames: region.frames, events: eventStates(), hit, kept: !!stroke.kept,
    ms: Math.round(performance.now() - t0), canUndo: st.cursor > 0, canRedo: st.cursor < st.strokes.length,
  }, [...out.map((c) => c.buffer), after.buffer, removed.buffer]);
}

// ---- slice length: redraw and rebuild every stroke ----------------------------------------------------

function setWindow(choice) {
  if (!st || st.choice === choice) return;
  st.choice = choice;
  buildPicture();
  if (st.isSample && st.eventCells) prepareEvents(st.partsForWindow);
  const g = st.grid;
  const output = st.channels.map((c) => Float32Array.from(c));
  const after = st.before.slice(), removed = new Uint8Array(st.before.length);
  for (const s of st.strokes) { const r = rasterise(s, g, st.first, st.last); s.cols = r.cols; s.f0 = r.f0; s.f1 = r.f1; }
  const active = liveStrokes().filter((s) => s.f0 !== null);
  const done = new Set();
  for (const s of active) {
    if (done.has(s)) continue;
    const { region, fa, fb, start, end } = rebuild({ channels: st.channels, grid: g, stroke: s, active });
    for (const t of active) if (t.f0 >= fa && t.f1 <= fb) done.add(t);
    region.yl.forEach((y, ch) => output[ch].set(y.subarray(start - region.origin, end - region.origin), start));
    const c0 = Math.max(st.first, fa - 3), c1 = Math.min(st.last, fb + 3);
    const cols = columnsOf(region, c0, c1);
    after.set(cols.after, (c0 - st.first) * g.rows);
    removed.set(cols.removed, (c0 - st.first) * g.rows);
  }
  if (st.output) st.output.set(output[0]);
  const before = st.before.slice();
  post({ op: 'repicture', token, choice, channels: output, after, removed, events: eventStates(), ...pictureMessage(before) },
    [...output.map((c) => c.buffer), after.buffer, removed.buffer, before.buffer]);
}

// ---- messages ------------------------------------------------------------------------------------

self.onmessage = (ev) => {
  const msg = ev.data || {};
  try {
    if (msg.op === 'sample') {
      const s = makeSample();
      load({ name: 'the demo clip', rate: s.rate, channels: s.channels, isSample: true, events: s.events, parts: s.parts, choice: msg.choice });
      st.partsForWindow = s.parts;
      // the first frame's ghost stroke, rebuilt at once so it is ready when the brush finishes
      addStroke(demoStroke(st.grid.melLo, st.grid.melHi));
    } else if (msg.op === 'wav') loadWav(msg.name, msg.buffer, msg.choice);
    else if (msg.op === 'pcm') loadPcm(msg.name, msg.rate, msg.channels, msg.choice, !!msg.cut, msg.notice || null);
    else if (!st) return;
    else if (msg.op === 'stroke' && msg.token === token) addStroke(msg.stroke);
    else if (msg.op === 'undo' && msg.token === token) undo();
    else if (msg.op === 'redo' && msg.token === token) redo();
    else if (msg.op === 'window' && msg.token === token) setWindow(msg.choice);
  } catch (err) {
    fail(msg.op, err);
  }
};
