// Drawing helpers shared by the hero and the figures: canvas sizing, spectrum panels, bars, and a curve editor that works
// with a pointer (drag the curve) and with the keyboard (Left/Right choose a handle, Up/Down move it).
import * as E from './engine.js';
import { DATA } from './data.js';

export const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export const isDark = () => matchMedia('(prefers-color-scheme: dark)').matches;

/** Size a canvas to its CSS box at the device pixel ratio (max 2) and return a context in CSS pixels. */
export function fitCanvas(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const r = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width));
  const h = Math.max(1, Math.round(r.height));
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}
export function cssVar(name, el = document.documentElement) {
  return getComputedStyle(el).getPropertyValue(name).trim();
}
export const rgba = (lin, a = 1) => { const [r, g, b] = E.encode(lin); return `rgb(${r} ${g} ${b} / ${a})`; };

export const xOf = (lam, box) => box.x + ((lam - 400) / 300) * box.w;
export const yOf = (v, box) => box.y + box.h - v * box.h;
export const lamOf = (x, box) => Math.min(700, Math.max(400, 400 + ((x - box.x) / box.w) * 300));
export const valOf = (y, box) => (box.y + box.h - y) / box.h;
const I0 = (400 - DATA.start) / DATA.step, I1 = (700 - DATA.start) / DATA.step;

const GRAD = new WeakMap();
/** A left-to-right rainbow for 400-700 nm across a box (approximate spectral colors). */
export function rainbow(ctx, box, alpha = 1) {
  const g = ctx.createLinearGradient(box.x, 0, box.x + box.w, 0);
  const n = DATA.rainbow.length;
  DATA.rainbow.forEach((hex, i) => {
    const v = parseInt(hex.slice(1), 16);
    g.addColorStop(i / (n - 1), `rgb(${(v >> 16) & 255} ${(v >> 8) & 255} ${v & 255} / ${alpha})`);
  });
  return g;
}
function pathOf(ctx, values, box, scale = 1) {
  ctx.beginPath();
  for (let i = I0; i <= I1; i++) {
    const x = xOf(E.WL[i], box), y = yOf(Math.max(0, Math.min(1.02, values[i] * scale)), box);
    if (i === I0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
}
/** Draw a lamp's light inside a box: a filled glow for a spectrum, a bar for a single line. `strong` is for light paper:
 *  a denser fill and a firmer outline, so a narrow-band lamp's lines read at a glance. */
export function drawLamp(ctx, box, spec, color, alpha = 1, strong = false) {
  if (!spec) return;
  if (spec.kind === 'line') {
    const x = xOf(spec.nm, box);
    const g = ctx.createLinearGradient(x - 6, 0, x + 6, 0);
    g.addColorStop(0, `rgb(${color} / 0)`);
    g.addColorStop(0.5, `rgb(${color} / ${(strong ? 1 : 0.9) * alpha})`);
    g.addColorStop(1, `rgb(${color} / 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x - 6, box.y, 12, box.h);
    return;
  }
  pathOf(ctx, spec.values, box, 0.96);
  ctx.lineTo(box.x + box.w, box.y + box.h);
  ctx.lineTo(box.x, box.y + box.h);
  ctx.closePath();
  ctx.fillStyle = `rgb(${color} / ${(strong ? 0.3 : 0.22) * alpha})`;
  ctx.fill();
  pathOf(ctx, spec.values, box, 0.96);
  ctx.strokeStyle = `rgb(${color} / ${(strong ? 0.85 : 0.75) * alpha})`;
  ctx.lineWidth = strong ? 1.5 : 1.2;
  ctx.stroke();
}
/** Fill under a curve with the rainbow and draw its line. */
export function drawCurve(ctx, box, R, { fill = 0.35, color = '#2a2420', width = 2, dash = null, scale = 1 } = {}) {
  if (fill) {
    pathOf(ctx, R, box, scale);
    ctx.lineTo(box.x + box.w, box.y + box.h);
    ctx.lineTo(box.x, box.y + box.h);
    ctx.closePath();
    ctx.fillStyle = rainbow(ctx, box, fill);
    ctx.fill();
  }
  pathOf(ctx, R, box, scale);
  ctx.setLineDash(dash || []);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.setLineDash([]);
}
export function drawBand(ctx, box, h = 5) {
  ctx.fillStyle = rainbow(ctx, box, 1);
  ctx.fillRect(box.x, box.y + box.h, box.w, h);
}
export function drawAxis(ctx, box, ink, { pct = true, nm = true } = {}) {
  ctx.save();
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillStyle = ink;
  ctx.strokeStyle = ink;
  ctx.globalAlpha = 0.18;
  ctx.lineWidth = 1;
  for (const v of [0.25, 0.5, 0.75, 1]) {
    ctx.beginPath();
    ctx.moveTo(box.x, Math.round(yOf(v, box)) + 0.5);
    ctx.lineTo(box.x + box.w, Math.round(yOf(v, box)) + 0.5);
    ctx.stroke();
  }
  ctx.globalAlpha = 0.75;
  if (nm) {
    ctx.textBaseline = 'top';
    for (const l of [400, 500, 600, 700]) {
      ctx.textAlign = l === 400 ? 'left' : l === 700 ? 'right' : 'center';
      ctx.fillText(l + (l === 700 ? ' nm' : ''), xOf(l, box), box.y + box.h + 8);
    }
  }
  if (pct) {
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('100%', box.x - 6, yOf(1, box));
    ctx.fillText('0', box.x - 6, yOf(0, box));
  }
  ctx.restore();
}
/** A lamp's light color as "r g b" for canvas strings. */
export function lampColor(id) {
  return E.encode(E.glowRGB(id)).join(' ');
}
/** The lamp's color for drawing its spectrum: the pale glow on dark backgrounds; on light paper a darker, saturated
 *  version of the same hue (a near-white lamp such as daylight becomes a neutral gray), so the lines stay visible. */
export function lampInk(id, onLight) {
  const [r, g, b] = E.encode(E.glowRGB(id)).map((v) => v / 255);
  if (!onLight) return lampColor(id);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, c = mx - mn;
  const s0 = c === 0 ? 0 : c / (1 - Math.abs(2 * l - 1));
  let hue = 0;
  if (c) hue = mx === r ? ((g - b) / c) % 6 : mx === g ? (b - r) / c + 2 : (r - g) / c + 4;
  const S = s0 < 0.12 ? 0 : Math.max(s0, 0.78), L = 0.42;
  const C = (1 - Math.abs(2 * L - 1)) * S, X = C * (1 - Math.abs((hue % 2 + 2) % 2 - 1)), m = L - C / 2;
  const seg = Math.floor(((hue % 6) + 6) % 6);
  const [R, G, B] = [[C, X, 0], [X, C, 0], [0, C, X], [0, X, C], [X, 0, C], [C, 0, X]][seg];
  return [R, G, B].map((v) => Math.round((v + m) * 255)).join(' ');
}
/** Wavelengths (0.5 nm walk, 400-700 nm) where two curves cross. */
export function crossings(Ra, Rb) {
  const out = [];
  let prev = null;
  for (let l = 400; l <= 700; l += 0.5) {
    const d = E.at(Rb, l) - E.at(Ra, l);
    if (prev !== null && d !== 0 && Math.sign(d) !== Math.sign(prev)) out.push(l - 0.25);
    if (d !== 0) prev = d;
  }
  return out;
}
/** Vertical tick marks where a lamp has its strongest lines (where it is "watching"). */
export const LAMP_LINES = { FL11: [435, 545, 610], 'LED-B2': [450], sodium: [589] };

/**
 * A curve editor on a canvas. opts: getH() -> handles, setH(h), getQ() -> seenBasis or null, box(w, h) -> plot box,
 * draw(), onDone() (after a drag or key press), label(k, h) -> aria-valuetext, hit (optional): the element that takes
 * pointer drags (an overlay over the draggable part), so touches elsewhere on the canvas still scroll the page.
 */
export function curveEditor(canvas, opts) {
  let sel = 6;
  let dragging = false;
  const hit = opts.hit || canvas;
  const point = (ev) => {
    const r = canvas.getBoundingClientRect();
    const box = opts.box(r.width, r.height);
    return { lam: lamOf(ev.clientX - r.left, box), y: Math.min(E.HHI, Math.max(E.HLO, valOf(ev.clientY - r.top, box))) };
  };
  const apply = (ev) => {
    const p = point(ev);
    let h = opts.getH();
    if (!h) return;
    for (let i = 0; i < 2; i++) h = E.brush(h, p.lam, p.y, opts.getQ());
    sel = Math.round((p.lam - 400) / 25);
    opts.setH(h);
    opts.draw();
  };
  hit.addEventListener('pointerdown', (ev) => {
    if (ev.button !== undefined && ev.button !== 0) return;
    dragging = true;
    canvas.classList.add('dragging');
    hit.setPointerCapture?.(ev.pointerId);
    apply(ev);
    ev.preventDefault();
    if (hit !== canvas) canvas.focus({ preventScroll: true });
  });
  hit.addEventListener('pointermove', (ev) => { if (dragging) apply(ev); });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    canvas.classList.remove('dragging');
    opts.onDone?.();
    sync();
  };
  hit.addEventListener('pointerup', end);
  hit.addEventListener('pointercancel', end);
  hit.addEventListener('lostpointercapture', end);
  const sync = () => {
    const h = opts.getH();
    if (!h) return;
    canvas.setAttribute('aria-valuenow', String(Math.round(h[sel] * 100)));
    canvas.setAttribute('aria-valuetext', opts.label ? opts.label(sel, h) : `${E.HW[sel]} nanometers, sends back ${Math.round(h[sel] * 100)} percent`);
  };
  canvas.addEventListener('keydown', (ev) => {
    const k = ev.key;
    let h = opts.getH();
    if (!h) return;
    if (k === 'ArrowLeft' || k === 'ArrowRight') sel = Math.max(0, Math.min(E.K - 1, sel + (k === 'ArrowLeft' ? -1 : 1)));
    else if (k === 'Home') sel = 0;
    else if (k === 'End') sel = E.K - 1;
    else if (k === 'ArrowUp' || k === 'ArrowDown' || k === 'PageUp' || k === 'PageDown') {
      const step = (k === 'PageUp' || k === 'PageDown' || ev.shiftKey ? 0.1 : 0.02) * (k === 'ArrowUp' || k === 'PageUp' ? 1 : -1);
      h = E.nudge(h, sel, step, opts.getQ());
      opts.setH(h);
      opts.onDone?.();
    } else if (k === 'Escape') { canvas.blur(); return; }
    else return;
    ev.preventDefault();
    opts.draw();
    sync();
  });
  canvas.addEventListener('focus', () => { opts.draw(); sync(); });
  canvas.addEventListener('blur', () => opts.draw());
  sync();
  return { selected: () => sel, focused: () => document.activeElement === canvas, sync };
}

/** Draw handles as small rings; the selected one larger when the canvas has focus. */
export function drawHandles(ctx, box, h, sel, focused, ink) {
  for (let k = 0; k < E.K; k++) {
    const x = xOf(E.HW[k], box), y = yOf(h[k], box);
    const big = focused && k === sel;
    ctx.beginPath();
    ctx.arc(x, y, big ? 7 : 4.5, 0, Math.PI * 2);
    ctx.fillStyle = big ? ink : '#fffaf2';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = ink;
    ctx.stroke();
  }
}
/** Set the heights of three bars (L, M, S) inside a container of .bar > i elements. */
export function setBars(el, v) {
  const bars = el.querySelectorAll('i');
  v.forEach((x, i) => { if (bars[i]) bars[i].style.transform = `scaleY(${Math.max(0.02, Math.min(1, x)).toFixed(4)})`; });
}
