// The first screen: a lit wall, a lamp, Pebble and Fog. Lamp switch with an auto-cycle, Wiggle, Make my own pair, More.
import * as E from './engine.js';
import { DATA } from './data.js';
import * as V from './views.js';

const $ = (id) => document.getElementById(id);
export const PEBBLE = Float64Array.from(DATA.pair.Pebble);
// The data keep 6 decimals; one projection puts Fog back exactly on Pebble's shop-light color (moves no handle by 1e-6).
export const FOG = E.toPlane(Float64Array.from(DATA.pair.Fog), PEBBLE, E.seenBasis('FL11'));
const CYCLE = ['FL11', 'A', 'D65'];
const PERIOD = 3500;
const FADE = 600;
const WIGGLE_S = 6;
const GOAL = "Goal: fool the shop light but not your living room. Drag your paint's curve until the warm bulb shows a difference above 10, while the shop light still sees a match.";
// While a paint wiggles unseen under one lamp, this lamp shows what the wiggle does.
const OTHER = { FL11: 'A', A: 'D65', D65: 'A', 'LED-B2': 'D65', sodium: 'D65', P3999: 'A' };

const st = {
  mode: 'pair',
  lamp: 'FL11',
  mine: null,
  locks: new Set(['FL11']),
  showLight: false,
  cycling: false,
  paused: false,
  touched: false,
  timer: 0,
  shown: null,
  painted: null,
  anim: 0,
  wiggle: null,
  wiggleH: null,
  found: [],
  foundMsg: '',
  pulsed: false,
  celebrated: false,
  seed: 1,
  visible: true,
  endTimer: 0,
};
let el = {};
let editor = null;
let thumbResolve = null;
export const thumbReady = new Promise((r) => { thumbResolve = r; });

const bHandles = () => (st.mode === 'editor' ? st.mine : FOG);
const bName = () => (st.mode === 'editor' ? 'Your paint' : 'Fog');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const list = (a) => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);

function frameFor(lamp, hb = bHandles()) {
  const Ra = E.curve(PEBBLE), Rb = E.curve(hb);
  const da = E.displayRGB(Ra, lamp), db = E.displayRGB(Rb, lamp);
  const wall = E.flatRGB(E.WALL, lamp);
  return {
    lamp, Ra, Rb,
    chipA: da.rgb, chipB: db.rgb, clipped: da.clipped || db.clipped,
    wallHi: wall, wallLo: wall.map((v) => v * 0.74),
    card: E.flatRGB(E.CARD, lamp), glow: E.glowRGB(lamp),
    d: E.diff(Ra, Rb, lamp),
    conesA: E.cones(Ra, lamp), conesB: E.cones(Rb, lamp),
  };
}
/** A frame part-way between two (a lamp crossfade in linear light). A new fade can start from it, so nothing snaps. */
function mixFrames(f0, f1, e) {
  const m = { lamp: e < 0.5 ? f0.lamp : f1.lamp, d: f0.d + (f1.d - f0.d) * e };
  for (const k of ['wallHi', 'wallLo', 'card', 'glow', 'chipA', 'chipB']) m[k] = E.mixLinear(f0[k], f1[k], e);
  return m;
}
function setColors(m) {
  const s = el.scene.style;
  s.setProperty('--wall-hi', E.hex(m.wallHi));
  s.setProperty('--wall-lo', E.hex(m.wallLo));
  s.setProperty('--card', E.hex(m.card));
  s.setProperty('--chip-a', E.hex(m.chipA));
  if (!st.wiggle) s.setProperty('--chip-b', E.hex(m.chipB));
  const g = E.encode(m.glow).join(' ');
  s.setProperty('--glow-a', `rgb(${g} / 62%)`);
  s.setProperty('--glow-c', `rgb(${g} / 46%)`);
  s.setProperty('--glow-b', `rgb(${g} / 0%)`);
  s.setProperty('--bulb', `rgb(${g})`);
}
/** Where the two curves cross close to the lamp's strongest lines, shown only while the pair matches. */
function marksFor(f) {
  const lines = V.LAMP_LINES[f.lamp];
  if (!lines || f.d >= 1 || st.showLight) return [];
  return V.crossings(f.Ra, f.Rb).filter((l) => lines.some((x) => Math.abs(x - l) <= 8));
}
function chipCurve(canvas, R, lampFrom, lampTo, t, { ghost = null, marks = [] } = {}) {
  const { ctx, w, h } = V.fitCanvas(canvas);
  const box = { x: 1, y: 3, w: w - 2, h: h - 10 };
  if (lampFrom && lampFrom !== lampTo && t < 1) V.drawLamp(ctx, box, E.lampSpectrum(lampFrom), V.lampInk(lampFrom, true), 1 - t, true);
  V.drawLamp(ctx, box, E.lampSpectrum(lampTo), V.lampInk(lampTo, true), lampFrom && lampFrom !== lampTo ? t : 1, true);
  if (ghost) V.drawCurve(ctx, box, ghost, { fill: 0, color: 'rgb(42 36 32 / 55%)', width: 1.5, dash: [4, 3] });
  if (st.showLight) {
    const L = E.LAMPS[lampTo];
    if (L.kind === 'table') {
      const spec = E.lampSpectrum(lampTo).values;
      V.drawCurve(ctx, box, R.map((r, i) => r * spec[i]), { fill: 0.55, color: '#2a2420', width: 1.8 });
    } else {
      const x = V.xOf(L.nm, box), v = E.at(R, L.nm);
      ctx.fillStyle = '#2a2420';
      ctx.fillRect(x - 1.5, V.yOf(v, box), 3, v * box.h);
    }
  } else V.drawCurve(ctx, box, R, { fill: 0.4, color: '#2a2420', width: 2 });
  for (const l of marks) {
    ctx.beginPath();
    ctx.arc(V.xOf(l, box), V.yOf(E.at(R, l), box), 3.4, 0, Math.PI * 2);
    ctx.fillStyle = '#fffaf2';
    ctx.fill();
    ctx.lineWidth = 1.8;
    ctx.strokeStyle = '#2a2420';
    ctx.stroke();
  }
  V.drawBand(ctx, box, 5);
}
/** Color names for the two chips. Under a one-wavelength lamp only lightness is left, so the names say lighter or darker. */
function namesFor(f) {
  const la = E.labOfDisplay(f.chipA), lb = E.labOfDisplay(f.chipB);
  if (E.LAMPS[f.lamp].kind !== 'line') return [E.colorName(la), E.colorName(lb)];
  if (Math.abs(la[0] - lb[0]) < 1) return ['orange', 'orange'];
  return la[0] > lb[0] ? ['lighter orange', 'darker orange'] : ['darker orange', 'lighter orange'];
}
function describe(f) {
  const [na, nb] = namesFor(f);
  return `${cap(E.LAMPS[f.lamp].under)}: ${E.verdict(f.d).toLowerCase()}, color difference ${f.d.toFixed(1)}. ${na === nb ? `Both look ${na}.` : `Pebble looks ${na} and ${bName()} looks ${nb}.`}`;
}
function setCaption(f) {
  const L = E.LAMPS[f.lamp];
  el.lampName.textContent = L.name;
  el.lampDetail.textContent = L.detail;
  el.lampBrief.textContent = L.brief;
  el.curveA.setAttribute('aria-label', curveLabel('Pebble', PEBBLE));
  el.curveB.setAttribute('aria-label', curveLabel(bName(), bHandles()));
}
function setVerdict(d) {
  const v = E.verdict(d);
  if (el.verdict.textContent !== v) el.verdict.textContent = v;
}
/** The readout's second line: the difference, or one live line during and after a wiggle (always one line). */
function setSub(d) {
  if (el.sub.dataset.mode !== 'diff') {
    el.sub.dataset.mode = 'diff';
    el.sub.classList.remove('live');
    el.sub.innerHTML = '<abbr title="CIEDE2000, computed against a white sheet under the same lamp">Color difference</abbr> <b></b><span class="sub-tail"> · about 1 is just noticeable</span>';
  }
  el.sub.querySelector('b').textContent = d.toFixed(1);
}
function setHex(f) {
  const ha = E.hex(f.chipA).toUpperCase(), hb = E.hex(f.chipB).toUpperCase();
  const [na, nb] = namesFor(f);
  el.hex.classList.remove('live');
  el.hex.textContent = ha === hb ? `On your screen both chips are ${ha}, ${na}` : `On your screen: Pebble ${ha}, ${na} · ${bName()} ${hb}, ${nb}`;
  if (f.clipped) {
    const s = document.createElement('span');
    s.className = 'clipnote';
    s.textContent = ' Your screen cannot show this color fully; it is shown less vivid or less bright.';
    el.hex.append(s);
  }
}
/** Two live one-liners; an optional tail of the second line is dropped on very narrow screens. */
function setLive(a, b, tail = '') {
  el.sub.dataset.mode = 'live';
  el.sub.classList.add('live');
  el.sub.textContent = a;
  el.hex.classList.add('live');
  el.hex.textContent = b;
  if (tail) {
    const t = document.createElement('span');
    t.className = 'sub-tail';
    t.textContent = tail;
    el.hex.append(t);
  }
}
export function curveLabel(name, h) {
  const pts = [0, 3, 6, 9, 12].map((k) => `${Math.round(h[k] * 100)}% at ${E.HW[k]} nm`);
  return `${name}'s reflectance curve: it sends back ${pts.join(', ')}.`;
}
function numbersTable(f) {
  const tb = el.numTable.querySelector('tbody');
  const rows = [['Pebble', f.conesA, E.lab(f.Ra, f.lamp), f.chipA], [bName(), f.conesB, E.lab(f.Rb, f.lamp), f.chipB]];
  tb.replaceChildren(...rows.map(([n, c, l, rgb]) => {
    const tr = document.createElement('tr');
    for (const v of [n, c[0].toFixed(3), c[1].toFixed(3), c[2].toFixed(3), l[0].toFixed(1), l[1].toFixed(1), l[2].toFixed(1), E.hex(rgb).toUpperCase()]) {
      const td = document.createElement('td');
      td.textContent = v;
      tr.append(td);
    }
    return tr;
  }));
}
function pulse(node) {
  if (!node || V.reduceMotion()) return;
  node.classList.remove('pulse');
  void node.offsetWidth;
  node.classList.add('pulse');
}

/** Show the current state. With `fade`, colors cross over in linear light (a dimmer, not a paint swap); a fade that
 *  starts while another runs begins from the colors on screen. The verdict word always follows the number shown. */
function render({ fade = false, announce = false } = {}) {
  const f1 = frameFor(st.lamp);
  const f0 = st.painted || st.shown;
  cancelAnimationFrame(st.anim);
  st.painted = null;
  const willFade = fade && f0 && !V.reduceMotion();
  setCaption(f1);
  V.setBars(el.barsA, f1.conesA);
  if (!st.wiggle) V.setBars(el.barsB, f1.conesB);
  numbersTable(f1);
  if (announce) el.desc.textContent = describe(f1);
  if (st.mode === 'editor') { drawEditor(); goalStatus(); }
  renderHeld(f1);
  const marks = marksFor(f1);
  const finish = () => {
    st.shown = f1;
    st.painted = null;
    setColors(f1);
    if (!st.wiggle) { setVerdict(f1.d); setSub(f1.d); setHex(f1); }
    chipCurve(el.curveA, f1.Ra, null, f1.lamp, 1, { marks });
    if (!st.wiggle) chipCurve(el.curveB, f1.Rb, null, f1.lamp, 1, { marks });
  };
  if (!willFade) { finish(); return; }
  const t0 = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - t0) / FADE);
    const e = ease(t);
    const m = mixFrames(f0, f1, e);
    st.painted = m;
    setColors(m);
    chipCurve(el.curveA, f1.Ra, f0.lamp, f1.lamp, e);
    if (!st.wiggle) {
      chipCurve(el.curveB, f1.Rb, f0.lamp, f1.lamp, e);
      setSub(m.d);
      setVerdict(m.d);
    }
    if (t < 1) st.anim = requestAnimationFrame(step);
    else { finish(); if (st.cycling && f1.lamp === 'A') setTimeout(() => thumbResolve(), 150); }
  };
  st.anim = requestAnimationFrame(step);
}

// ---- lamp switch and the auto-cycle ----------------------------------------------------------------------------------------
function syncLampInputs() {
  for (const r of el.radios) r.checked = r.value === st.lamp;
  el.other.value = CYCLE.includes(st.lamp) || !E.LAMP_IDS.includes(st.lamp) ? '' : st.lamp;
  if (st.lamp === 'FL11' || st.lamp === 'A') setDimmer(st.lamp === 'A' ? 100 : 0);
}
function setDimmer(v) {
  el.dimmer.value = String(v);
  el.dimmerOut.textContent = v === 0 ? 'all shop light' : v === 100 ? 'all warm bulb' : `${100 - v}% shop light, ${v}% warm bulb`;
  el.dimmer.setAttribute('aria-valuetext', el.dimmerOut.textContent);
}
export function setLamp(lamp, { user = false, instant = false } = {}) {
  if (!E.LAMPS[lamp]) return;
  if (user) touch();
  if (st.wiggle) endWiggle(true);
  const changed = lamp !== st.lamp;
  st.lamp = lamp;
  syncLampInputs();
  if (changed) render({ fade: !instant, announce: user && !instant });
  if (user && st.mode === 'pair' && E.LAMP_IDS.includes(lamp)) noteFind(lamp);
  updateHint();
}
/** The visitor found a lamp that gives the pair away: say so once per lamp, and pulse the verdict the first time. */
function noteFind(lamp) {
  const d = E.diff(E.curve(PEBBLE), E.curve(FOG), lamp);
  if (d < 2 || st.found.includes(lamp)) return;
  st.found.push(lamp);
  const n = d.toFixed(1);
  st.foundMsg = st.found.length === 1
    ? `Found it: ${E.LAMPS[lamp].under} they are ${n} apart. Now press Wiggle, or make your own pair.`
    : `${E.LAMPS[lamp].subject} gives them away too: ${n} apart. Now press Wiggle, or make your own pair.`;
  if (!st.pulsed) { st.pulsed = true; pulse(el.verdict); }
}
function restartProgress() {
  el.seg.classList.remove('cycling');
  void el.seg.offsetWidth;
  if (st.cycling && !st.paused && st.visible) el.seg.classList.add('cycling');
}
function scheduleNext() {
  clearTimeout(st.timer);
  restartProgress();
  if (!st.cycling || st.paused || !st.visible) return;
  st.timer = setTimeout(() => {
    if (!st.cycling || st.paused) return;
    setLamp(CYCLE[(CYCLE.indexOf(st.lamp) + 1) % CYCLE.length]);
    scheduleNext();
  }, PERIOD);
}
function stopCycle() {
  if (!st.cycling) return;
  st.cycling = false;
  clearTimeout(st.timer);
  el.seg.classList.remove('cycling');
  el.pause.hidden = true;
  thumbResolve();
}
/** The visitor used a hero control on purpose: the auto-cycle stops for good (scrolling never counts). */
function touch() {
  if (st.touched) return;
  st.touched = true;
  stopCycle();
  updateHint();
}
function updateHint() {
  let t;
  if (st.mode === 'editor') t = 'Your paint starts as a copy of Pebble. Drag its curve below the chips and watch them split; the small pair shows the shop light, where the match is held.';
  else if (st.cycling) t = st.paused ? 'Paused. Pick a lamp yourself, or press play.' : 'The lamp changes by itself until you pick one.';
  else if (st.foundMsg) t = st.foundMsg;
  else t = 'This pair matches in the shop. Find the lamp that gives it away.';
  if (el.hint.textContent !== t) el.hint.textContent = t;
}

// ---- the wiggle --------------------------------------------------------------------------------------------------------------
function wiggleLabel() {
  return st.mode === 'editor' ? 'Wiggle my paint without changing its color' : 'Wiggle Fog without changing its color';
}
function startWiggle() {
  touch();
  if (st.wiggle?.manual) return;
  if (st.wiggle) { if (V.reduceMotion()) nextShape(); else endWiggle(false); return; }
  clearTimeout(st.endTimer);
  const h0 = Float64Array.from(bHandles());
  // In Make my own pair the wiggle also keeps every lamp you hold.
  const lamps = [...new Set([st.lamp, ...(st.mode === 'editor' ? st.locks : [])])];
  const other = [OTHER[st.lamp], 'A', 'D65', 'LED-B2', 'P3999', 'sodium', 'FL11'].filter(Boolean).find((id) => !lamps.includes(id));
  // Six slow random bumps, made invisible under the lamp(s); a draw that would barely move the curve is replaced.
  const w = E.wiggleBumps(() => 1000 + st.seed++, h0, E.seenBasis(lamps));
  Object.assign(w, { lamp: st.lamp, lamps, R0: E.curve(h0), other, t0: performance.now(), stopAt: null, k: 0 });
  st.wiggle = w;
  el.wiggle.classList.add('running');
  el.frozen.hidden = false;
  el.wigCanvas.hidden = false;
  el.wo.hidden = false;
  el.curveB.style.visibility = 'hidden';
  el.lgB.textContent = E.LAMPS[other].lower;
  el.woWas.style.background = E.hex(E.displayRGB(w.R0, other).rgb);
  if (V.reduceMotion()) {
    el.wiggle.textContent = 'Show another shape';
    el.backFog.textContent = st.mode === 'editor' ? 'Back to my paint' : 'Back to Fog';
    el.backFog.hidden = false;
    nextShape();
    return;
  }
  el.wiggle.textContent = 'Stop wiggling';
  revealChips();
  requestAnimationFrame(tickWiggle);
}
/** Reduced motion: one new invisible shape per press, no animation. */
function nextShape() {
  const w = st.wiggle;
  if (!w) return;
  w.k++;
  showWiggled(w, E.wiggleAt(w, 0.4 + 1.37 * w.k, 1));
  el.desc.textContent = `${bName()} has a new curve. ${cap(E.LAMPS[w.lamp].under)} its color is unchanged; ${E.LAMPS[w.other].under} it is ${E.diff(w.R0, E.curve(st.wiggleH), w.other).toFixed(1)} from the original.`;
}
function showWiggled(w, h) {
  st.wiggleH = h;
  const R = E.curve(h);
  // The still block is a measurement: its color is recomputed from the moving curve on every frame.
  el.scene.style.setProperty('--chip-b', E.hex(E.displayRGB(R, w.lamp).rgb));
  V.setBars(el.barsB, E.cones(R, w.lamp));
  drawWiggleOverlay(w, R);
  el.woNow.style.background = E.hex(E.displayRGB(R, w.other).rgb);
  const same = E.diff(w.R0, R, w.lamp), other = E.diff(w.R0, R, w.other);
  setLive(`${bName()} ${E.LAMPS[w.lamp].under}: unchanged (${same.toFixed(1)})`, `${cap(E.LAMPS[w.other].under)}: ${other.toFixed(1)}`, ' from the original');
  if (st.mode === 'editor') { drawEditor(h); renderHeld(st.shown || frameFor(st.lamp)); }
}
function overlayBox(cw, ch) {
  const top = Math.min(34, ch * 0.2);
  return { x: 12, y: top, w: cw - 24, h: ch - top - 12 };
}
function drawWiggleOverlay(w, R) {
  const { ctx, w: cw, h: ch } = V.fitCanvas(el.wigCanvas);
  const box = overlayBox(cw, ch);
  V.drawCurve(ctx, box, w.R0, { fill: 0, color: 'rgb(255 255 255 / 75%)', width: 1.6, dash: [5, 4] });
  ctx.save();
  ctx.shadowColor = 'rgb(24 16 10 / 55%)';
  ctx.shadowBlur = 7;
  ctx.shadowOffsetY = 1;
  V.drawCurve(ctx, box, R, { fill: 0, color: '#ffffff', width: 3.2 });
  ctx.restore();
}
function tickWiggle(now) {
  const w = st.wiggle;
  if (!w) return;
  const t = (now - w.t0) / 1000;
  let env = Math.min(1, t / 0.6, (WIGGLE_S - t) / 0.6);
  if (w.stopAt !== null) env = Math.min(env, w.stopEnv * (1 - (t - w.stopAt) / 0.6));
  env = Math.max(0, env);
  showWiggled(w, E.wiggleAt(w, t, ease(Math.min(1, env))));
  if (t >= WIGGLE_S || (w.stopAt !== null && t - w.stopAt >= 0.6)) { finishWiggle(); return; }
  requestAnimationFrame(tickWiggle);
}
function endWiggle(now) {
  const w = st.wiggle;
  if (!w) return;
  if (w.manual) { if (now) finishWiggle(true); else handEnd(); return; }
  if (now || V.reduceMotion()) { finishWiggle(true); return; }
  if (w.stopAt === null) {
    const t = (performance.now() - w.t0) / 1000;
    w.stopAt = t;
    w.stopEnv = Math.max(0, Math.min(1, t / 0.6, (WIGGLE_S - t) / 0.6));
  }
}
function finishWiggle(quiet = false) {
  const w = st.wiggle;
  st.wiggle = null;
  st.wiggleH = null;
  el.wiggle.textContent = wiggleLabel();
  el.wiggle.classList.remove('running');
  el.frozen.hidden = true;
  el.wigCanvas.hidden = true;
  el.wo.hidden = true;
  el.backFog.hidden = true;
  el.curveB.style.visibility = '';
  el.lgB.textContent = 'light it sends back';
  if (w) el.desc.textContent = `${bName()} is back to its original curve. Every shape it passed through gave the same three numbers ${E.LAMPS[w.lamp].under}.`;
  render();
  if (w && !quiet && !V.reduceMotion()) {
    const next = st.mode === 'pair' && !w.manual && !st.handTried ? 'Now drag across Fog to try it by hand.' : 'Step 4 below explains why.';
    setLive('Every shape gave the same three numbers.', next);
    clearTimeout(st.endTimer);
    st.endTimer = setTimeout(() => { if (!st.wiggle && st.shown) { setSub(st.shown.d); setHex(st.shown); } }, 4200);
  }
}
/** Drag across Fog's block: a brush reshapes Fog's curve in place while its color under this lamp is held exactly.
 *  On release the curve glides back (every in-between shape keeps the color, since it is a shorter step the same way). */
function startHandWiggle(ev) {
  if (st.mode !== 'pair' || st.wiggle || (ev.button !== undefined && ev.button !== 0)) return;
  touch();
  clearTimeout(st.endTimer);
  st.handTried = true;
  const lamps = [st.lamp];
  const other = [OTHER[st.lamp], 'A', 'D65', 'LED-B2', 'P3999', 'sodium', 'FL11'].filter(Boolean).find((id) => !lamps.includes(id));
  const w = { manual: true, lamp: st.lamp, lamps, h0: Float64Array.from(FOG), R0: E.curve(FOG), Q: E.seenBasis(lamps), other, h: Float64Array.from(FOG), pid: ev.pointerId };
  st.wiggle = w;
  el.frozen.hidden = false;
  el.wigCanvas.hidden = false;
  el.wo.hidden = false;
  el.curveB.style.visibility = 'hidden';
  el.lgB.textContent = E.LAMPS[other].lower;
  el.woWas.style.background = E.hex(E.displayRGB(w.R0, other).rgb);
  el.colorB.setPointerCapture?.(ev.pointerId);
  handMove(ev);
}
function handMove(ev) {
  const w = st.wiggle;
  if (!w || !w.manual || w.leaving || ev.pointerId !== w.pid) return;
  const r = el.colorB.getBoundingClientRect();
  const box = overlayBox(r.width, r.height);
  const lam = V.lamOf(ev.clientX - r.left, box), y = Math.min(E.HHI, Math.max(E.HLO, V.valOf(ev.clientY - r.top, box)));
  for (let i = 0; i < 2; i++) w.h = E.brush(w.h, lam, y, w.Q);
  showWiggled(w, w.h);
}
function handEnd(ev) {
  const w = st.wiggle;
  if (!w || !w.manual || w.leaving || (ev && ev.pointerId !== w.pid)) return;
  w.leaving = true;
  const from = Float64Array.from(w.h), t0 = performance.now(), dur = V.reduceMotion() ? 0 : 900;
  const step = (now) => {
    if (st.wiggle !== w) return;
    const t = dur ? Math.min(1, (now - t0) / dur) : 1, s = 1 - ease(t);
    showWiggled(w, Float64Array.from(w.h0, (v, k) => v + s * (from[k] - v)));
    if (t < 1) requestAnimationFrame(step);
    else finishWiggle();
  };
  requestAnimationFrame(step);
}
/** Keep the proof on screen while it changes: from the live line above the chips down to the Wiggle button when that fits
 *  (phones), else at least the chips. */
function revealChips() {
  const behavior = V.reduceMotion() ? 'auto' : 'smooth';
  const top = el.sub.getBoundingClientRect().top, bottom = Math.max(el.chips.getBoundingClientRect().bottom, el.wiggle.getBoundingClientRect().bottom);
  if (top >= 8 && bottom <= innerHeight - 8) return;
  if (bottom - top + 16 <= innerHeight) { scrollTo({ top: scrollY + (top < 8 ? top - 8 : bottom - innerHeight + 8), behavior }); return; }
  const r = el.chips.getBoundingClientRect();
  if (r.top < 0 || r.bottom > innerHeight) el.chips.scrollIntoView({ block: 'nearest', behavior });
}

// ---- make my own pair ------------------------------------------------------------------------------------------------------------
const lockQ = () => (st.locks.size ? E.seenBasis([...st.locks]) : null);
function editorBox(w, h) { return { x: 42, y: 22, w: w - 54, h: h - 46 }; }
function drawEditor(hOverride = null) {
  if (!editor) return;
  const c = el.editorCanvas;
  const { ctx, w, h } = V.fitCanvas(c);
  const box = editorBox(w, h);
  V.drawAxis(ctx, box, '#2a2420');
  V.drawLamp(ctx, box, E.lampSpectrum(st.lamp), V.lampInk(st.lamp, true), 1, true);
  ctx.save();
  ctx.strokeStyle = 'rgb(42 36 32 / 45%)';
  ctx.setLineDash([2, 3]);
  for (const id of st.locks) for (const nm of V.LAMP_LINES[id] || []) {
    const x = V.xOf(nm, box);
    ctx.beginPath(); ctx.moveTo(x, box.y); ctx.lineTo(x, box.y + box.h); ctx.stroke();
  }
  ctx.restore();
  V.drawCurve(ctx, box, E.curve(PEBBLE), { fill: 0, color: 'rgb(42 36 32 / 60%)', width: 1.6, dash: [5, 4] });
  const hm = hOverride || st.mine;
  V.drawCurve(ctx, box, E.curve(hm), { fill: 0.42, color: '#2a2420', width: 2.4 });
  V.drawBand(ctx, box, 5);
  V.drawHandles(ctx, box, hm, editor.selected(), editor.focused(), '#2a2420');
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillStyle = 'rgb(42 36 32 / 85%)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(w < 560 ? 'dashed: Pebble · solid: your paint' : 'dashed: Pebble · solid: your paint · dotted lines: where the held lamp shines brightest', box.x, 5);
}
/** The inset that proves the held match: Pebble and your paint under the held lamp, while the scene shows another lamp. */
function renderHeld(f) {
  const id = st.locks.has('FL11') ? 'FL11' : (st.locks.size ? [...st.locks][0] : 'FL11');
  if (st.mode !== 'editor' || id === f.lamp) { el.held.hidden = true; return; }
  el.held.hidden = false;
  const Rm = st.wiggleH ? E.curve(st.wiggleH) : f.Rb;
  const Ra = E.curve(PEBBLE);
  el.heldLabel.textContent = `${cap(E.LAMPS[id].under)}${st.locks.has(id) ? ' (held)' : ''}`;
  el.held.style.setProperty('--held-wall', E.hex(E.flatRGB(E.WALL, id)));
  el.heldA.style.background = E.hex(E.displayRGB(Ra, id).rgb);
  el.heldB.style.background = E.hex(E.displayRGB(Rm, id).rgb);
  el.heldD.textContent = E.diff(Ra, Rm, id).toFixed(1);
}
function statusText() {
  const Rp = E.curve(PEBBLE), Rm = E.curve(st.mine);
  if (st.locks.size > 1 || (st.locks.size === 1 && !st.locks.has('FL11'))) {
    const held = [...st.locks].map((id) => E.LAMPS[id].lower);
    const free = E.LAMP_IDS.filter((id) => !st.locks.has(id));
    return `Held: ${list(held)}. Under the other lamps: ` + free.map((id) => `${E.LAMPS[id].lower} ${E.diff(Rp, Rm, id).toFixed(1)}`).join(' · ');
  }
  return `Shop light ${E.diff(Rp, Rm, 'FL11').toFixed(1)}${st.locks.has('FL11') ? ' (held)' : ''} · warm bulb ${E.diff(Rp, Rm, 'A').toFixed(1)} (goal: above 10)`;
}
/** The goal line is always true for the paint on screen: no frozen numbers, and it changes back if the split is lost. */
function goalStatus() {
  const Rp = E.curve(PEBBLE), Rm = E.curve(st.mine);
  const ok = E.diff(Rp, Rm, 'FL11') < 1 && E.diff(Rp, Rm, 'A') >= 10;
  el.status.textContent = statusText();
  el.status.className = `editor-status ${ok ? 'ok' : 'wait'}`;
  let goal = GOAL;
  if (st.locks.has('A')) goal = `Held: ${list([...st.locks].map((id) => E.LAMPS[id].lower))}. Which lamp still gives your pair away? The line under the chart shows every other lamp.`;
  else if (ok) goal = 'You made a metamer of Pebble: a different curve that gives the same three numbers under the shop light, yet splits from it under the warm bulb. Next: in More, hold the match under the warm bulb too, and find a lamp that still gives your pair away.';
  if (el.goal.textContent !== goal) el.goal.textContent = goal;
  if (ok && !st.celebrated) {
    st.celebrated = true;
    el.shareRow.hidden = false;
    el.desc.textContent = 'You made a metamer of Pebble: a different curve that matches it under the shop light and splits from it under the warm bulb.';
    pulse(el.chips);
    pulse(el.held);
  }
}
function enterEditor() {
  touch();
  if (st.wiggle) endWiggle(true);
  clearTimeout(st.endTimer);
  st.mode = 'editor';
  if (!st.mine) st.mine = Float64Array.from(PEBBLE);
  el.nameB.textContent = 'Your paint';
  el.colorB.removeAttribute('title');
  el.scene.classList.add('editing');
  for (const n of [el.editor, el.reset, el.back, el.lockWrap, el.lockHelp, el.locks]) n.hidden = false;
  el.make.hidden = true;
  el.wiggle.textContent = wiggleLabel();
  if (st.celebrated) el.shareRow.hidden = false;
  updateHint();
  // The scene shows the goal lamp, so every drag visibly splits the pair; the inset shows the held shop-light match.
  if (st.lamp !== 'A') { st.lamp = 'A'; syncLampInputs(); render({ fade: true }); } else render();
  el.editorCanvas.focus({ preventScroll: true });
  revealEditor();
}
/** On a phone, scroll so the chips and the editor are on screen together; elsewhere just bring the editor into view. */
function revealEditor() {
  const behavior = V.reduceMotion() ? 'auto' : 'smooth';
  const c = el.chips.getBoundingClientRect(), e = el.editor.getBoundingClientRect();
  if (e.bottom - c.top + 16 <= innerHeight) {
    if (c.top < 8 || e.bottom > innerHeight - 8) scrollTo({ top: scrollY + c.top - 8, behavior });
  } else el.editor.scrollIntoView({ block: 'nearest', behavior });
}
function leaveEditor() {
  if (st.wiggle) endWiggle(true);
  st.mode = 'pair';
  el.nameB.textContent = 'Fog';
  el.colorB.title = 'Drag across Fog to reshape its curve: its color stays';
  el.scene.classList.remove('editing');
  for (const n of [el.editor, el.reset, el.back, el.lockWrap, el.lockHelp, el.locks, el.shareRow]) n.hidden = true;
  el.make.hidden = false;
  el.wiggle.textContent = wiggleLabel();
  updateHint();
  render();
  el.make.focus({ preventScroll: true });
}
function setLocks(ids) {
  st.locks = new Set(ids);
  el.lock.checked = st.locks.has('FL11');
  for (const c of el.locks.querySelectorAll('input')) c.checked = st.locks.has(c.value);
  const Q = lockQ();
  if (Q && st.mine) {
    const before = Float64Array.from(st.mine);
    st.mine = E.keepColour(st.mine, PEBBLE, Q);
    const moved = before.some((v, k) => Math.abs(v - st.mine[k]) > 1e-6);
    if (moved) el.desc.textContent = 'Your paint was adjusted so it matches Pebble under every lamp you hold.';
  }
  render();
}

// ---- share a pair through the address -------------------------------------------------------------------------------------
function readHash() {
  try {
    const p = new URLSearchParams(location.hash.slice(1));
    const mine = p.get('mine');
    if (!mine) return;
    const v = mine.split('-').map((s) => Number(s));
    if (v.length !== E.K || v.some((x) => !Number.isInteger(x) || x < 3 || x > 97)) return;
    const locks = (p.get('lock') || '').split(',').filter((id) => ['FL11', 'A', 'D65', 'LED-B2'].includes(id));
    const lamp = p.get('lamp');
    st.mine = Float64Array.from(v, (x) => x / 100);
    st.touched = true;
    enterEditor();
    setLocks(locks.length ? locks : ['FL11']);
    if (lamp && E.LAMPS[lamp]) setLamp(lamp, { user: true });
  } catch { /* an unreadable address is ignored */ }
}
async function share() {
  const v = Array.from(st.mine, (x) => String(Math.round(x * 100)).padStart(2, '0')).join('-');
  const hash = `#mine=${v}&lock=${[...st.locks].join(',')}&lamp=${st.lamp}`;
  try { history.replaceState(null, '', hash); } catch { /* ignore */ }
  const url = location.href.split('#')[0] + hash;
  try { await navigator.clipboard.writeText(url); el.shareStatus.textContent = 'Link copied.'; } catch { el.shareStatus.textContent = 'The link is in the address bar.'; }
}

// ---- boot ---------------------------------------------------------------------------------------------------------------------
export function initHero({ runChecks }) {
  el = {
    hero: $('hero'), scene: $('scene'), seg: $('lamp-switch'), radios: [...document.querySelectorAll('input[name="lamp"]')], pause: $('pause'), hint: $('hint'),
    lampBtn: $('lamp-btn'), lampName: $('lamp-name'), lampDetail: $('lamp-detail'), lampBrief: $('lamp-brief'), verdict: $('verdict'), sub: $('verdict-sub'), hex: $('verdict-hex'),
    chips: $('chips'), colorB: $('color-b'), curveA: $('curve-a'), curveB: $('curve-b'), barsA: $('bars-a'), barsB: $('bars-b'), nameB: $('name-b'), frozen: $('frozen'),
    wigCanvas: $('wig-canvas'), wo: $('wig-other'), woWas: $('wo-was'), woNow: $('wo-now'), lgB: $('lg-b'),
    held: $('held'), heldLabel: $('held-label'), heldA: $('held-a'), heldB: $('held-b'), heldD: $('held-d'),
    editor: $('editor'), editorCanvas: $('editor-canvas'), status: $('editor-status'), goal: $('goal'), desc: $('scene-desc'),
    wiggle: $('wiggle'), backFog: $('back-fog'), make: $('make'), reset: $('reset-paint'), back: $('back'), moreToggle: $('more-toggle'), more: $('more'),
    lockWrap: $('lock-wrap'), lock: $('lock'), lockHelp: $('lock-help'), locks: $('locks'), shareRow: $('share-row'), share: $('share'),
    shareStatus: $('share-status'), other: $('other-lamp'), showLight: $('show-light'), numTable: $('num-table'),
    dimmer: $('dimmer'), dimmerOut: $('dimmer-out'),
  };
  for (const r of el.radios) r.addEventListener('change', () => { if (r.checked) setLamp(r.value, { user: true }); });
  el.other.addEventListener('change', () => { if (el.other.value) setLamp(el.other.value, { user: true }); else setLamp('FL11', { user: true }); });
  el.lampBtn.addEventListener('click', () => setLamp(CYCLE[(CYCLE.indexOf(st.lamp) + 1) % CYCLE.length], { user: true }));
  // The dimmer: slide from the shop light to the warm bulb and find the moment the block tears in two.
  el.dimmer.addEventListener('input', () => {
    const v = +el.dimmer.value;
    setLamp(E.mixLamp(v / 100), { user: true, instant: true });
    setDimmer(v);
  });
  el.dimmer.addEventListener('change', () => { el.desc.textContent = describe(frameFor(st.lamp)); });
  el.pause.addEventListener('click', () => {
    st.paused = !st.paused;
    el.pause.setAttribute('aria-pressed', String(st.paused));
    el.pause.setAttribute('aria-label', st.paused ? 'Play the lamp cycle' : 'Pause the lamp cycle');
    if (st.paused) { clearTimeout(st.timer); restartProgress(); } else scheduleNext();
    updateHint();
  });
  el.wiggle.addEventListener('click', startWiggle);
  // A mouse or pen drag starts at once; a finger must move sideways first, so a vertical swipe still scrolls the page.
  let pending = null;
  el.colorB.addEventListener('pointerdown', (ev) => {
    if (ev.pointerType === 'touch') { pending = { id: ev.pointerId, x: ev.clientX, y: ev.clientY }; return; }
    startHandWiggle(ev);
  });
  el.colorB.addEventListener('pointermove', (ev) => {
    if (pending && ev.pointerId === pending.id) {
      const dx = ev.clientX - pending.x, dy = ev.clientY - pending.y;
      if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) { pending = null; startHandWiggle(ev); }
      return;
    }
    handMove(ev);
  });
  for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) el.colorB.addEventListener(t, (ev) => { if (pending && ev.pointerId === pending.id) pending = null; handEnd(ev); });
  el.backFog.addEventListener('click', () => endWiggle(true));
  el.make.addEventListener('click', enterEditor);
  el.back.addEventListener('click', leaveEditor);
  el.reset.addEventListener('click', () => { if (st.wiggle) endWiggle(true); st.mine = Float64Array.from(PEBBLE); st.celebrated = false; el.shareRow.hidden = true; render(); });
  el.lock.addEventListener('change', () => { const s = new Set(st.locks); if (el.lock.checked) s.add('FL11'); else s.delete('FL11'); setLocks([...s]); });
  for (const c of el.locks.querySelectorAll('input')) c.addEventListener('change', () => { const s = new Set(st.locks); if (c.checked) s.add(c.value); else s.delete(c.value); setLocks([...s]); });
  el.share.addEventListener('click', share);
  el.showLight.addEventListener('change', () => { st.showLight = el.showLight.checked; render(); });
  el.moreToggle.addEventListener('click', () => {
    const open = el.more.hidden;
    el.more.hidden = !open;
    el.moreToggle.setAttribute('aria-expanded', String(open));
  });
  el.more.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { el.more.hidden = true; el.moreToggle.setAttribute('aria-expanded', 'false'); el.moreToggle.focus(); } });
  for (const b of [$('check-numbers'), $('check-numbers-2')]) b?.addEventListener('click', () => runChecks(b.id === 'check-numbers' ? $('check-out') : $('check-out-2')));
  // Only deliberate use of a hero control stops the cycle: a click, a change, or keyboard focus on a control. Scrolling,
  // wheel and text selection never do, and the pause button only pauses.
  const CONTROL = 'button, input, select, summary, canvas[tabindex]';
  const onControl = (ev) => { const c = ev.target.closest?.(CONTROL); if (c && !el.pause.contains(c)) touch(); };
  el.hero.addEventListener('click', onControl);
  el.hero.addEventListener('change', onControl);
  el.hero.addEventListener('focusin', onControl);
  // W wiggles while focus is in the hero (not while a list or text field has it)
  document.addEventListener('keydown', (ev) => {
    const a = document.activeElement;
    const typing = a.tagName === 'SELECT' || (a.tagName === 'INPUT' && !['radio', 'checkbox', 'range'].includes(a.type));
    if ((ev.key === 'w' || ev.key === 'W') && !ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.repeat && el.hero.contains(a) && !typing) startWiggle();
  });
  editor = V.curveEditor(el.editorCanvas, {
    getH: () => st.mine, setH: (h) => { st.mine = h; }, getQ: lockQ, box: editorBox,
    // drags redraw at most once per frame
    draw: () => { if (!st.drawQueued) { st.drawQueued = true; requestAnimationFrame(() => { st.drawQueued = false; render(); }); } },
    onDone: () => { el.desc.textContent = statusText(); },
    label: (k, h) => `${E.HW[k]} nanometers, your paint sends back ${Math.round(h[k] * 100)} percent`,
  });
  // The cycle sleeps while less than 40% of the picture is on screen and wakes when it comes back.
  new IntersectionObserver((entries) => {
    const e = entries[entries.length - 1];
    const vis = e.isIntersecting && e.intersectionRatio >= 0.4;
    if (vis === st.visible) return;
    st.visible = vis;
    if (st.cycling && !st.paused) { if (vis) scheduleNext(); else { clearTimeout(st.timer); restartProgress(); } }
  }, { threshold: [0, 0.4, 0.7] }).observe(el.scene);
  let rt = 0;
  addEventListener('resize', () => { cancelAnimationFrame(rt); rt = requestAnimationFrame(() => { if (!st.anim || !st.painted) render(); }); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => render());

  render();
  updateHint();
  if (location.hash.includes('mine=')) readHash();
  if (V.reduceMotion() || st.touched) { el.pause.hidden = true; thumbResolve(); }
  else { st.cycling = true; scheduleNext(); }
  updateHint();
}
