// Drawing the picture. Two stacked canvases at device resolution: the picture layer (the spectrogram, the
// time ruler and the pitch labels; redrawn only when something changes) and the overlay (outlines, the
// brush, labels, the playhead; redrawn on animation frames while anything moves).
import { COLORMAP, melOf, hzOf } from './engine.js';

export const RULER = 20; // css px of time ruler under the picture
const INK = '#f4f1ff';
const BRUSH = '#5ce1e6';
const PILL = 'rgba(5, 6, 15, 0.8)';
const FONT = '600 12.5px system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const FONT_HINT = '650 13px system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const FONT_HINT_NARROW = '650 12px system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const FONT_SMALL = '500 10.5px system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

export function createView({ stage, base, overlay }) {
  const bctx = base.getContext('2d');
  const octx = overlay.getContext('2d');
  const outlineCanvas = document.createElement('canvas');
  const outlineCtx = outlineCanvas.getContext('2d');
  const tmp = document.createElement('canvas');
  const tctx = tmp.getContext('2d');
  // a checkerboard used to cut the outline ring into dashes
  const dashTile = document.createElement('canvas');
  dashTile.width = dashTile.height = 10;
  const dctx = dashTile.getContext('2d');
  dctx.fillStyle = '#000';
  dctx.fillRect(0, 0, 5, 5); dctx.fillRect(5, 5, 5, 5);
  let dashPattern = null;
  let W = 0, Hc = 0, dpr = 1, picH = 0;
  let pic = null; // { first, frames, rows, before, after, removed, rate, H, melLo, melHi, duration }
  let show = 'after';
  let t0 = 0, t1 = 1;
  let image = null, image32 = null;
  const reveals = []; // { c0, c1, prev: Uint8Array, start, dur }
  let override = null; // { c0, c1 }: columns shown from the original while showing After (the first frame's split)
  let ghostCache = null; // the removed sound of some columns, drawn once for the first frame's lift
  let outlinesDirty = true;
  let strokes = [];

  function resize() {
    const r = stage.getBoundingClientRect();
    dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    W = Math.max(1, Math.round(r.width));
    Hc = Math.max(1, Math.round(r.height));
    picH = Math.max(10, Hc - RULER);
    for (const c of [base, overlay, outlineCanvas, tmp]) { c.width = Math.round(W * dpr); c.height = Math.round(Hc * dpr); }
    image = bctx.createImageData(base.width, Math.round(picH * dpr));
    image32 = new Uint32Array(image.data.buffer);
    outlinesDirty = true;
    renderBase();
  }

  // ---- coordinates ----
  const tToX = (t) => ((t - t0) / (t1 - t0)) * W;
  const xToT = (x) => t0 + (x / W) * (t1 - t0);
  const melToY = (m) => pic ? ((pic.melHi - m) / (pic.melHi - pic.melLo)) * picH : 0;
  const yToMel = (y) => pic ? pic.melHi - (y / picH) * (pic.melHi - pic.melLo) : 0;
  const hzToY = (hz) => melToY(melOf(Math.max(1, hz)));
  const secPerPx = () => (t1 - t0) / W;
  const melPerPx = () => (pic ? (pic.melHi - pic.melLo) / picH : 1);

  function setPicture(p) {
    pic = p;
    reveals.length = 0;
    ghostCache = null;
    t0 = 0; t1 = p.duration;
    outlinesDirty = true;
    renderBase();
  }

  function setView(a, b) {
    if (!pic) return;
    const d = pic.duration;
    const minSpan = Math.max(0.25, (W * pic.H) / pic.rate / 4);
    let span = Math.max(minSpan, Math.min(d, b - a));
    let s = Math.max(0, Math.min(d - span, a));
    t0 = s; t1 = s + span;
    outlinesDirty = true;
    renderBase();
  }

  function setShow(mode) { show = mode; renderBase(); }
  function setOverride(o) { override = o; renderBase(); }

  // column (frame index into the picture) values of the image being shown, with reveal blending
  function columnSource() {
    if (show === 'before') return pic.before;
    if (show === 'removed') return pic.removed;
    return pic.after;
  }

  // renders the picture into the canvas, optionally only device columns [xa, xb)
  function renderBase(xa = 0, xb = null) {
    if (!image) return;
    const Wd = base.width, Hd = image.height;
    xb = xb === null ? Wd : Math.min(Wd, xb);
    xa = Math.max(0, xa);
    if (!pic) {
      bctx.fillStyle = '#05060f';
      bctx.fillRect(0, 0, base.width, base.height);
      return;
    }
    const src = columnSource();
    const ov = override && show === 'after' ? override : null;
    const pick = ov ? (c) => (c >= ov.c0 && c <= ov.c1 ? pic.before : src) : () => src;
    const now = performance.now();
    const active = show === 'after' ? reveals.filter((r) => now - r.start < r.dur) : [];
    paintColumns(image32, Wd, Hd, pick, xa, xb, active, now);
    bctx.putImageData(image, 0, 0, xa, 0, xb - xa, Hd);
    if (xa === 0 && xb === Wd) drawRulerAndAxis();
  }

  // writes device columns [xa, xb) of the picture into a 32-bit image, pick(column) giving each column's codes
  function paintColumns(out32, Wd, Hd, pick, xa, xb, active, now) {
    const rows = pic.rows;
    const colv = new Float32Array(rows);
    const yr0 = new Int32Array(Hd), yfr = new Float32Array(Hd);
    for (let y = 0; y < Hd; y++) {
      const rf = ((y + 0.5) / Hd) * rows - 0.5;
      const r0 = Math.max(0, Math.min(rows - 2, Math.floor(rf)));
      yr0[y] = r0; yfr[y] = Math.max(0, Math.min(1, rf - r0));
    }
    const fpp = ((t1 - t0) * pic.rate) / pic.H / Wd; // frames per device pixel
    for (let x = xa; x < xb; x++) {
      const ta = t0 + (x / Wd) * (t1 - t0);
      const ua = (ta * pic.rate) / pic.H - pic.first; // fractional column index
      if (fpp <= 1) {
        const uc = ua + fpp / 2;
        const c0 = Math.max(0, Math.min(pic.frames - 2, Math.floor(uc)));
        const fr = Math.max(0, Math.min(1, uc - c0));
        const src = pick(c0);
        const o0 = c0 * rows, o1 = o0 + rows;
        for (let r = 0; r < rows; r++) colv[r] = src[o0 + r] + (src[o1 + r] - src[o0 + r]) * fr;
        if (active.length) blendReveal(active, c0, fr, colv, now);
      } else {
        const ca = Math.max(0, Math.floor(ua)), cb = Math.min(pic.frames - 1, Math.floor(ua + fpp));
        colv.fill(0);
        for (let c = ca; c <= cb; c++) { const src = pick(c); const o = c * rows; for (let r = 0; r < rows; r++) if (src[o + r] > colv[r]) colv[r] = src[o + r]; }
        if (active.length) blendReveal(active, ca, 0, colv, now);
      }
      for (let y = 0; y < Hd; y++) {
        const r0 = yr0[y];
        const v = colv[r0] + (colv[r0 + 1] - colv[r0]) * yfr[y];
        out32[y * Wd + x] = COLORMAP[v < 0 ? 0 : v > 255 ? 255 : v | 0];
      }
    }
  }

  // the removed sound of columns [c0, c1] as its own image (for the first frame's lifting ghost)
  function ghostImage(c0, c1) {
    const key = `${c0},${c1},${t0},${t1},${base.width},${image.height}`;
    if (ghostCache && ghostCache.key === key) return ghostCache;
    const [xa, xb] = columnsToX(c0, c1);
    const a = Math.max(0, xa), b = Math.min(base.width, xb);
    if (b <= a) return null;
    const cv = document.createElement('canvas');
    cv.width = base.width; cv.height = image.height;
    const cx = cv.getContext('2d');
    const img = cx.createImageData(base.width, image.height);
    const o32 = new Uint32Array(img.data.buffer);
    paintColumns(o32, base.width, image.height, () => pic.removed, a, b, [], 0);
    for (let y = 0; y < image.height; y++) {
      for (let x = a; x < b; x++) {
        const i = y * base.width + x, p = o32[i];
        const m = Math.max(p & 255, (p >>> 8) & 255, (p >>> 16) & 255);
        const al = m < 48 ? 0 : Math.min(255, (m - 48) * 1.7);
        o32[i] = (p & 0x00ffffff) | ((al & 255) << 24);
      }
    }
    cx.putImageData(img, 0, 0, a, 0, b - a, image.height);
    ghostCache = { key, canvas: cv };
    return ghostCache;
  }

  // the first frame's knit: columns [c0, c1] grow from `prev` (a dark gap) to what is shown, edges first
  function knit(c0, c1, prev, dur) {
    if (!pic) return;
    reveals.push({ c0, c1, prev, start: performance.now(), dur });
    renderColumns(c0, c1);
  }

  // during a reveal the new columns grow in from both edges of the edited stretch toward its middle
  function blendReveal(active, c, fr, colv, now) {
    for (const rv of active) {
      if (c < rv.c0 || c > rv.c1) continue;
      const half = Math.max(1, (rv.c1 - rv.c0) / 2);
      const d = Math.min(c - rv.c0, rv.c1 - c) / half; // 0 at the edges, 1 in the middle
      const p = Math.max(0, Math.min(1, ((now - rv.start) / rv.dur - 0.55 * d) / 0.45));
      if (p >= 1) continue;
      const o = (c - rv.c0) * pic.rows;
      for (let r = 0; r < pic.rows; r++) colv[r] = rv.prev[o + r] + (colv[r] - rv.prev[o + r]) * p;
    }
  }

  function drawRulerAndAxis() {
    const c = bctx;
    c.save();
    c.scale(dpr, dpr);
    c.fillStyle = '#080a16';
    c.fillRect(0, picH, W, RULER);
    c.strokeStyle = 'rgba(244, 241, 255, 0.18)';
    c.beginPath(); c.moveTo(0, picH + 0.5); c.lineTo(W, picH + 0.5); c.stroke();
    // time ticks: choose a step so labels are at least 56 px apart
    const span = t1 - t0;
    const steps = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60];
    let step = steps[steps.length - 1];
    for (const s of steps) if ((s / span) * W >= 56) { step = s; break; }
    c.font = FONT_SMALL;
    c.fillStyle = 'rgba(244, 241, 255, 0.72)';
    c.textBaseline = 'middle';
    c.textAlign = 'center';
    for (let t = Math.ceil(t0 / step) * step; t <= t1 + 1e-9; t += step) {
      const x = Math.round(tToX(t)) + 0.5;
      c.strokeStyle = 'rgba(244, 241, 255, 0.35)';
      c.beginPath(); c.moveTo(x, picH); c.lineTo(x, picH + 4); c.stroke();
      if (x > 14 && x < W - 14) c.fillText(`${+t.toFixed(2)} s`, x, picH + RULER / 2 + 1);
    }
    // pitch labels
    c.textAlign = 'left';
    for (const [hz, label] of [[100, '100 Hz'], [1000, '1 kHz'], [10000, '10 kHz']]) {
      if (melOf(hz) > pic.melHi || melOf(hz) < pic.melLo) continue;
      const y = Math.round(hzToY(hz)) + 0.5;
      c.strokeStyle = 'rgba(244, 241, 255, 0.45)';
      c.beginPath(); c.moveTo(0, y); c.lineTo(5, y); c.stroke();
      c.fillStyle = 'rgba(5, 6, 15, 0.55)';
      const w = c.measureText(label).width;
      c.fillRect(7, y - 7, w + 6, 14);
      c.fillStyle = 'rgba(244, 241, 255, 0.78)';
      c.fillText(label, 10, y + 0.5);
    }
    c.restore();
  }

  function patchColumns(colFrom, count, after, removed, animate) {
    if (!pic) return;
    const rows = pic.rows;
    if (animate) {
      const prev = pic.after.slice(colFrom * rows, (colFrom + count) * rows);
      reveals.push({ c0: colFrom, c1: colFrom + count - 1, prev, start: performance.now(), dur: animate });
    }
    pic.after.set(after, colFrom * rows);
    pic.removed.set(removed, colFrom * rows);
    renderColumns(colFrom, colFrom + count - 1);
  }

  function columnsToX(c0, c1) {
    const ta = ((c0 + pic.first) * pic.H) / pic.rate, tb = ((c1 + pic.first + 1) * pic.H) / pic.rate;
    return [Math.floor(tToX(ta) * dpr) - 2, Math.ceil(tToX(tb) * dpr) + 2];
  }

  function renderColumns(c0, c1) {
    const [xa, xb] = columnsToX(c0, c1);
    if (xb <= 0 || xa >= base.width) return;
    renderBase(Math.max(0, xa), Math.min(base.width, xb));
  }

  // advance reveal animations; returns true while any is running
  function stepReveals() {
    if (!reveals.length || !pic) return false;
    const now = performance.now();
    for (const rv of reveals) renderColumns(rv.c0, rv.c1);
    for (let i = reveals.length - 1; i >= 0; i--) if (now - reveals[i].start >= reveals[i].dur) reveals.splice(i, 1);
    return reveals.length > 0;
  }

  // ---- outlines of committed strokes, cached ----
  function setStrokes(list) { strokes = list; outlinesDirty = true; }

  function strokePath(ctx2, s, grow) {
    const rx = s.rT / secPerPx(), ry = s.rM / melPerPx();
    const k = ry / Math.max(0.5, rx);
    ctx2.save();
    ctx2.scale(1, k);
    ctx2.lineCap = 'round'; ctx2.lineJoin = 'round';
    ctx2.lineWidth = Math.max(1, 2 * rx + grow);
    ctx2.beginPath();
    s.points.forEach((p, i) => { const x = tToX(p[0]), y = melToY(p[1]) / k; if (i === 0) ctx2.moveTo(x, y); else ctx2.lineTo(x, y); });
    if (s.points.length === 1) { const x = tToX(s.points[0][0]), y = melToY(s.points[0][1]) / k; ctx2.lineTo(x + 0.01, y); }
    ctx2.stroke();
    ctx2.restore();
  }

  function renderOutlines() {
    outlinesDirty = false;
    outlineCtx.setTransform(1, 0, 0, 1, 0, 0);
    outlineCtx.clearRect(0, 0, outlineCanvas.width, outlineCanvas.height);
    if (!pic) return;
    for (const s of strokes) {
      if (s.hidden) continue;
      tctx.setTransform(1, 0, 0, 1, 0, 0);
      tctx.clearRect(0, 0, tmp.width, tmp.height);
      tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      tctx.save();
      tctx.beginPath(); tctx.rect(0, 0, W, picH); tctx.clip();
      const pending = s.status === 'pending';
      if (!pending) { tctx.strokeStyle = 'rgba(5, 6, 15, 0.7)'; strokePath(tctx, s, 6); }
      tctx.strokeStyle = pending ? 'rgba(92, 225, 230, 0.34)' : 'rgba(92, 225, 230, 0.95)';
      strokePath(tctx, s, pending ? 0 : 3);
      if (!pending) {
        tctx.globalCompositeOperation = 'destination-out';
        tctx.strokeStyle = '#000';
        strokePath(tctx, s, 0);
        if (!dashPattern) dashPattern = tctx.createPattern(dashTile, 'repeat');
        tctx.fillStyle = dashPattern;
        tctx.fillRect(0, 0, W, picH);
        tctx.globalCompositeOperation = 'source-over';
        if (s.mode === 'erase') { tctx.strokeStyle = 'rgba(5, 6, 15, 0.18)'; strokePath(tctx, s, 0); }
      }
      tctx.restore();
      outlineCtx.drawImage(tmp, 0, 0);
    }
  }

  // where a label pill goes (kept inside the picture)
  function pillBox(ctx2, text, x, y, align = 'center', font = FONT) {
    ctx2.font = font;
    const w = ctx2.measureText(text).width + 16, h = font === FONT ? 23 : 19;
    let left = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    left = Math.max(4, Math.min(W - w - 4, left));
    const top = Math.max(4, Math.min(picH - h - 4, y - h / 2));
    return { left, top, w, h };
  }

  function pill(ctx2, text, x, y, align = 'center', font = FONT) {
    const { left, top, w, h } = pillBox(ctx2, text, x, y, align, font);
    ctx2.fillStyle = PILL;
    ctx2.beginPath();
    if (ctx2.roundRect) ctx2.roundRect(left, top, w, h, 7); else ctx2.rect(left, top, w, h);
    ctx2.fill();
    ctx2.fillStyle = INK;
    ctx2.textAlign = 'left'; ctx2.textBaseline = 'middle';
    ctx2.fillText(text, left + 8, top + h / 2 + 0.5);
    return { left, top, w, h };
  }

  // words wrapped to maxW, each given paragraph on its own line(s)
  function wrap(ctx2, paras, maxW) {
    const lines = [];
    for (const para of paras) {
      if (!para) continue;
      let line = '';
      for (const word of para.split(' ')) {
        const next = line ? `${line} ${word}` : word;
        if (line && ctx2.measureText(next).width > maxW) { lines.push(line); line = word; } else line = next;
      }
      if (line) lines.push(line);
    }
    return lines;
  }

  // the step hint: a bright pill beside the target outline, or at the top left of the picture
  function hintPill(ctx2, h) {
    const narrow = W < 560;
    ctx2.font = narrow ? FONT_HINT_NARROW : FONT_HINT;
    const maxW = narrow ? W - 32 : Math.min(W - 24, 440);
    const lines = wrap(ctx2, [h.text, h.more], maxW);
    if (!lines.length) return;
    const lh = narrow ? 16 : 17, w = Math.max(...lines.map((l) => ctx2.measureText(l).width)) + 20, hh = lines.length * lh + 12;
    // on a phone the hint sits at the bottom of the picture (above the 100 Hz mark), away from the ping it points to
    let left = 8, top = narrow ? Math.min(picH - 6, hzToY(100) - 9) - hh : 8;
    if (h.at === 'target' && h.box && !narrow) {
      const bx0 = tToX(h.box.t0), bx1 = tToX(h.box.t1);
      const cy = h.box.hz0 ? (hzToY(h.box.hz0) + hzToY(h.box.hz1)) / 2 : picH / 2;
      top = cy - hh / 2;
      if (bx0 - 12 - w >= 4) left = bx0 - 12 - w;
      else if (bx1 + 12 + w <= W - 4) left = bx1 + 12;
      else { left = Math.max(4, Math.min(W - w - 4, bx0 - w / 2)); top = (h.box.hz0 ? hzToY(h.box.hz0) : picH / 2) + 22; }
    }
    left = Math.max(4, Math.min(W - w - 4, left));
    top = Math.max(4, Math.min(picH - hh - 4, top));
    ctx2.fillStyle = 'rgba(5, 6, 15, 0.88)';
    ctx2.strokeStyle = 'rgba(92, 225, 230, 0.75)';
    ctx2.lineWidth = 1;
    ctx2.beginPath();
    if (ctx2.roundRect) ctx2.roundRect(left + 0.5, top + 0.5, w, hh, 9); else ctx2.rect(left + 0.5, top + 0.5, w, hh);
    ctx2.fill(); ctx2.stroke();
    ctx2.fillStyle = INK;
    ctx2.textAlign = 'left'; ctx2.textBaseline = 'middle';
    lines.forEach((l, i) => ctx2.fillText(l, left + 10, top + 6 + lh / 2 + i * lh + 0.5));
    return { left, top, w, h: hh };
  }

  // a rounded box around a stretch of time (and pitch, or the full height when hz0 is null)
  function capsulePath(ctx2, b, grow) {
    const x0 = tToX(b.t0) - 4 - grow, x1 = tToX(b.t1) + 4 + grow;
    const y0 = b.hz0 ? hzToY(b.hz1) - 6 - grow : 3 - grow, y1 = b.hz0 ? hzToY(b.hz0) + 6 + grow : picH - 3 + grow;
    const r = Math.max(2, Math.min((x1 - x0) / 2, (y1 - y0) / 2, 16 + grow));
    ctx2.beginPath();
    if (ctx2.roundRect) ctx2.roundRect(x0, y0, x1 - x0, y1 - y0, r); else ctx2.rect(x0, y0, x1 - x0, y1 - y0);
  }

  // the target outline's box (with a little room), for keeping labels off it
  function targetBox(b) {
    const x0 = tToX(b.t0) - 7, x1 = tToX(b.t1) + 7;
    const y0 = b.hz0 ? hzToY(b.hz1) - 9 : 0, y1 = b.hz0 ? hzToY(b.hz0) + 9 : picH;
    return { left: x0, top: y0, w: x1 - x0, h: y1 - y0 };
  }

  // ---- the overlay ----
  // s: { labels, target, hint, trail, gap, ghost, lift, split, brush, playhead, hover, message, reduced }
  function drawOverlay(s) {
    const c = octx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, overlay.width, overlay.height);
    if (!pic) {
      if (s.message) { c.setTransform(dpr, 0, 0, dpr, 0, 0); c.font = FONT; c.fillStyle = 'rgba(244,241,255,0.8)'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(s.message, W / 2, picH / 2); }
      return;
    }
    if (s.lift) {
      const g = ghostImage(s.lift.c0, s.lift.c1);
      if (g) {
        c.save();
        c.globalAlpha = s.lift.alpha;
        c.beginPath(); c.rect(0, 0, overlay.width, picH * dpr); c.clip();
        c.drawImage(g.canvas, 0, -s.lift.dy * dpr);
        c.restore();
      }
    }
    if (outlinesDirty) renderOutlines();
    c.drawImage(outlineCanvas, 0, 0);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.save();
    c.beginPath(); c.rect(0, 0, W, picH); c.clip();
    if (s.gap) {
      // the dark gap the story's brush opens as it passes
      const x0 = tToX(s.gap.t - s.gap.rT), x1 = tToX(s.gap.t + s.gap.rT), y1 = melToY(s.gap.toMel);
      const grad = c.createLinearGradient(x0, 0, x1, 0);
      grad.addColorStop(0, 'rgba(5, 6, 15, 0)'); grad.addColorStop(0.12, 'rgba(5, 6, 15, 0.94)');
      grad.addColorStop(0.88, 'rgba(5, 6, 15, 0.94)'); grad.addColorStop(1, 'rgba(5, 6, 15, 0)');
      c.fillStyle = grad;
      c.fillRect(x0, melToY(s.gap.fromMel), x1 - x0, y1 - melToY(s.gap.fromMel));
    }
    if (s.trail && s.trail.points.length) {
      c.strokeStyle = 'rgba(92, 225, 230, 0.38)';
      strokePath(c, s.trail, 0);
    }
    if (s.ghost) {
      const x = tToX(s.ghost.t), y = melToY(s.ghost.mel);
      const r = Math.max(9, s.ghost.rT / secPerPx());
      c.shadowColor = BRUSH; c.shadowBlur = 14;
      c.strokeStyle = BRUSH; c.lineWidth = 2;
      c.beginPath(); c.arc(x, y, r, 0, 2 * Math.PI); c.stroke();
      c.shadowBlur = 0;
    }
    if (s.split && s.split.t !== null) {
      const x = Math.round(tToX(s.split.t)) + 0.5;
      c.strokeStyle = 'rgba(5, 6, 15, 0.8)'; c.lineWidth = 4;
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, picH); c.stroke();
      c.strokeStyle = '#ffffff'; c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, picH); c.stroke();
    }
    // the hint and the target's box first, so the labels can step out of their way. One pass: a label that
    // names the target and runs into it (or into the hint) is left out, since the outline and the hint name it;
    // another label moves below (or above) what it hit, and is left out if it still overlaps anything.
    let hb = null;
    if (s.hint) {
      c.save(); c.globalAlpha = 0; hb = hintPill(c, s.hint); c.restore();
    }
    const tb = s.target ? targetBox(s.target) : null;
    const hits = (a, b) => !!b && a.left < b.left + b.w && a.left + a.w > b.left && a.top < b.top + b.h && a.top + a.h > b.top;
    const placed = [];
    for (const l of s.labels || []) {
      const x = tToX(l.t);
      if (x < -60 || x > W + 60) continue;
      const align = l.align || 'center';
      let r = pillBox(c, l.text, x, hzToY(l.hz) + (l.dy || 0), align);
      if (tb && l.n && l.n === s.target.n && (hits(r, tb) || hits(r, hb))) continue;
      if (hits(r, tb)) {
        r = pillBox(c, l.text, x, tb.top + tb.h + 4 + r.h / 2, align);
        if (hits(r, tb)) r = pillBox(c, l.text, x, tb.top - 4 - r.h / 2, align);
      }
      if (hits(r, hb)) r = pillBox(c, l.text, x, hb.top > picH / 2 ? hb.top - 4 - r.h / 2 : hb.top + hb.h + 4 + r.h / 2, align);
      if (hits(r, tb) || hits(r, hb) || placed.some((q) => hits(r, q))) continue;
      placed.push(r);
      pill(c, l.text, x, r.top + r.h / 2, align);
    }
    if (s.hint) hintPill(c, s.hint);
    // the target outline last, so nothing covers what the visitor is asked to paint
    if (s.target) {
      const b = s.target;
      const ph = s.reduced ? 0.25 : b.phase;
      c.lineWidth = 2;
      c.strokeStyle = 'rgba(5, 6, 15, 0.7)';
      capsulePath(c, b, 1); c.lineWidth = 4; c.stroke();
      c.lineWidth = 2;
      c.strokeStyle = `rgba(92, 225, 230, ${0.75 + 0.25 * Math.cos(2 * Math.PI * ph)})`;
      capsulePath(c, b, 0); c.stroke();
      if (!s.reduced) {
        c.strokeStyle = `rgba(92, 225, 230, ${(1 - ph) * 0.55})`;
        capsulePath(c, b, 2 + 9 * ph); c.stroke();
      }
    }
    c.restore();
    if (s.playhead !== null && s.playhead !== undefined) {
      const x = Math.round(tToX(s.playhead)) + 0.5;
      if (x >= 0 && x <= W) {
        c.shadowColor = BRUSH; c.shadowBlur = 6;
        c.strokeStyle = '#ffffff'; c.lineWidth = 2;
        c.beginPath(); c.moveTo(x, 0); c.lineTo(x, picH); c.stroke();
        c.shadowBlur = 0;
        c.fillStyle = '#ffffff';
        c.beginPath(); c.moveTo(x - 5, picH); c.lineTo(x + 5, picH); c.lineTo(x, picH + 6); c.fill();
      }
    }
    if (s.brush) {
      // the brush: as wide in time as it will paint (an ellipse once its width is capped)
      const { x, y } = s.brush;
      const rx = Math.max(2, s.brush.rx), ry = s.brush.ry;
      c.lineWidth = 1;
      c.strokeStyle = 'rgba(5, 6, 15, 0.85)';
      c.beginPath(); c.ellipse(x, y, rx + 1.5, ry + 1.5, 0, 0, 2 * Math.PI); c.stroke();
      const col = s.brush.erase ? '#ffd27a' : BRUSH;
      c.strokeStyle = col;
      if (s.brush.hold !== undefined) {
        // a finger held still: the ring fills up, then painting starts
        c.globalAlpha = 0.45; c.lineWidth = 1.5;
        c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, 2 * Math.PI); c.stroke();
        c.globalAlpha = 1; c.lineWidth = 3.5;
        c.beginPath(); c.ellipse(x, y, rx, ry, 0, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * s.brush.hold); c.stroke();
      } else {
        c.lineWidth = 1.5;
        c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, 2 * Math.PI); c.stroke();
      }
    }
    if (s.hover && W >= 560) {
      c.font = FONT_SMALL;
      const text = s.hover;
      const w = c.measureText(text).width + 12;
      c.fillStyle = PILL;
      c.fillRect(W - w - 6, 6, w, 18);
      c.fillStyle = 'rgba(244, 241, 255, 0.85)';
      c.textAlign = 'left'; c.textBaseline = 'middle';
      c.fillText(text, W - w, 15.5);
    }
    if (s.message) pill(c, s.message, W / 2, picH / 2, 'center');
  }

  return {
    resize, setPicture, setView, setShow, setOverride, knit, patchColumns, stepReveals, setStrokes, drawOverlay, renderBase,
    tToX, xToT, melToY, yToMel, hzToY, secPerPx, melPerPx,
    size: () => ({ W, H: Hc, picH, dpr }),
    view: () => ({ t0, t1 }),
    hasPicture: () => !!pic,
    picture: () => pic,
    invalidateOutlines: () => { outlinesDirty = true; },
    revealing: () => reveals.length > 0,
    hzOfY: (y) => hzOf(yToMel(y)),
  };
}
