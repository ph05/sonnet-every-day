// app.js: Scratch a QR Code. The page's controller: the scratchable hero code, its live decoder readout, the
// first frame's sample scratch, the More panel, the step-2 demo, the ladder widgets and the exercises.
// The engine (qr.js) encodes and decodes; render.js draws and is the single definition of which squares a stroke
// changes; strokes.js keeps strokes normalized so they survive a change of version.
import * as QR from './qr.js';
import * as R from './render.js';
import { mountLine, mountCurve, mountClock } from './ladder.js';
import { initExercises } from './exercises.js';
import { BRUSH, newStroke, addPoint, applyStrokes, ghostAt, ghostStroke } from './strokes.js';
import { runChecks, installSelfTest } from './selfcheck.js';

installSelfTest();

const SAMPLE = 'SCRATCHED BUT STILL READABLE';
const $ = (id) => document.getElementById(id);
const mqReduce = window.matchMedia('(prefers-reduced-motion: reduce)');
const reduced = () => mqReduce.matches;
const coarse = window.matchMedia('(pointer: coarse)').matches;

const el = {
  app: $('app'), canvas: $('qr-canvas'), card: $('qr-card'), hold: $('qr-hold'), legend: $('qr-legend'),
  readout: $('qr-readout'), label: $('qr-label'), message: $('qr-message'), summary: $('qr-summary'),
  meters: $('qr-meters'), note: $('qr-note'), live: $('qr-live'), tool: $('qr-tool'), undo: $('qr-undo'),
  clean: $('qr-clean'), bytes: $('qr-bytes'), text: $('qr-text'), help: $('qr-msg-help'), moreBtn: $('qr-more-btn'),
  more: $('qr-more'), erase: $('qr-erase'), compare: $('qr-compare'), check: $('qr-check'), checkList: $('qr-check-list'),
};

const S = {
  text: SAMPLE, level: 'H', sym: null,
  strokes: [], active: null, tool: 'scratch', brush: coarse ? 'wide' : 'medium',
  erasure: false, showBytes: false, live: false,
  applied: null, read: null, view: null, drawOpts: { modulePx: 12, dpr: 1 },
  marks: null, flash: null, flashStart: null, prevFixed: null,
  cursor: null, keyPen: false, ghost: { running: false }, geo: null, dpr: 1,
  noteOnce: null, touched: false,
};

// ------------------------------------------------------------------------------------------------------------------
// Symbol, sizing, analysis
// ------------------------------------------------------------------------------------------------------------------
function makeSym(text, level) {
  try {
    return QR.encode(text, { level });
  } catch (e) {
    if (e && e.code === 'TOO_LONG') return null;
    throw e;
  }
}

// Whole device pixels per module, as large as the card allows, at most 12 CSS px (SPEC 3.1).
function sizeCanvas() {
  S.dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const box = el.card.clientWidth || 444;
  const m = Math.max(1, Math.min(Math.floor((box * S.dpr) / (S.sym.size + 8)), Math.floor(12 * S.dpr)));
  S.drawOpts = { modulePx: m / S.dpr, dpr: S.dpr };
  S.geo = R.geometry(S.sym, S.drawOpts);
}

// Keep the hero canvas on whole CSS pixels (VISUAL's rule): a fractional page offset makes the browser resample the
// bitmap. The canvas is centred in its card by margins rounded so that its page position is an integer.
function snapCanvas() {
  const c = el.canvas;
  c.style.marginLeft = '0px';
  c.style.marginTop = '0px';
  const card = el.card.getBoundingClientRect();
  const cw = c.getBoundingClientRect().width;
  const fx = Math.max(0, (card.width - cw) / 2);
  const fy = Math.max(0, (card.height - cw) / 2);
  const x = card.left + window.scrollX + fx;
  const y = card.top + window.scrollY + fy;
  c.style.marginLeft = (fx + Math.round(x) - x).toFixed(3) + 'px';
  c.style.marginTop = (fy + Math.round(y) - y).toFixed(3) + 'px';
}

function analyse() {
  const sym = S.sym;
  S.applied = applyStrokes(sym, S.strokes);
  S.read = QR.decodeModules(S.applied.modules, sym.size, {
    erasedModules: S.erasure ? S.applied.scratched : null,
    reference: sym,
    fallbackFormat: { level: sym.level, mask: sym.mask },
  });
  S.view = viewOf(sym, S.applied, S.read);
}

function viewOf(sym, applied, read) {
  const g = read.graded;
  const ncw = sym.stream.length;
  const changed = new Uint8Array(ncw);
  for (const c of g.changed) changed[c] = 1;
  const under = new Uint8Array(ncw);
  for (let i = 0; i < applied.scratched.length; i++) if (applied.scratched[i] && sym.cw[i] >= 0) under[sym.cw[i]] = 1;
  let nUnder = 0;
  for (let c = 0; c < ncw; c++) nUnder += under[c];
  const blocks = sym.blocks.map((b, i) => {
    let s = 0;
    let e = 0;
    for (const c of b.at) {
      if (S.erasure && under[c]) s++;
      else if (changed[c]) e++;
    }
    const cost = S.erasure ? s + 2 * e : g.trueBroken[i];
    const cap = S.erasure ? b.ecCount : b.maxTry;
    const promised = S.erasure ? b.erasureBudget : b.budget;
    return {
      i, cost, cap, promised, broken: g.trueBroken[i], erased: s, over: cost > cap, edge: cost === cap && cost > 0,
      past: cost > promised && cost <= cap, maxTry: b.maxTry,
      // Erasure mode only: a camera does not know where the scratches are, so it pays 2 check bytes per broken byte.
      cameraOver: S.erasure && g.trueBroken[i] > b.maxTry,
    };
  });
  let kind;
  if (read.ok && g.wrongText !== null) kind = 'wrong';
  else if (read.ok) kind = applied.flipped === 0 && (!S.erasure || nUnder === 0) ? 'clean' : 'fixed';
  else if (read.reason === 'format') kind = 'format';
  else kind = 'failed';
  const st = g.structure;
  const finders = st.finder.map((n) => n > 0);
  const fA = st.formatA;
  const fB = st.formatB;
  const wrongCopy = read.format.copies.some((c) => c.distance <= 3 && (c.level !== sym.level || c.mask !== sym.mask));
  return {
    kind, blocks, changed, under, nChanged: g.changed.length, nUnder, read, g,
    finders, finder: finders.some(Boolean), fA, fB,
    formatStrong: (fA >= 4 && fB >= 4) || wrongCopy, formatAny: fA > 0 || fB > 0, formatOne: (fA > 0) !== (fB > 0),
    timing: st.timing > 0,
  };
}

// ------------------------------------------------------------------------------------------------------------------
// Marks, flashes, painting
// ------------------------------------------------------------------------------------------------------------------
function computeMarks(v, live) {
  const n = S.sym.stream.length;
  const marks = new Uint8Array(n);
  const st = v.read.status;
  for (let c = 0; c < n; c++) {
    const ch = v.changed[c];
    if (live || v.kind === 'wrong' || v.kind === 'format') {
      if (ch) marks[c] = R.MARK.broken;
      continue;
    }
    if (st[c] === 2) {
      if (ch) marks[c] = R.MARK.failed;
    } else if (ch) marks[c] = st[c] === 1 || st[c] === 3 ? R.MARK.fixed : R.MARK.broken;
    else if (st[c] === 3) marks[c] = R.MARK.erased;
  }
  return marks;
}

// After a stroke (or the sample scratch) ends: the decoder's repairs flash green one by one, block 1 first.
function settle(withFlash = true) {
  const v = S.view;
  const marks = computeMarks(v, false);
  const n = marks.length;
  const now = performance.now();
  const fresh = [];
  for (let c = 0; c < n; c++) if (marks[c] === R.MARK.fixed && !(S.prevFixed && S.prevFixed[c])) fresh.push(c);
  fresh.sort((a, b) => S.sym.cwBlock[a] - S.sym.cwBlock[b] || a - b);
  if (withFlash && !reduced()) fresh.forEach((c, k) => { S.flashStart[c] = now + 260 + k * 60; });
  S.marks = marks;
  S.prevFixed = Uint8Array.from(marks, (m) => (m === R.MARK.fixed ? 1 : 0));
  return fresh.length;
}

function effectiveMarks(now) {
  const m = S.marks.slice();
  for (let c = 0; c < m.length; c++) if (S.flashStart[c] > now && m[c] === R.MARK.fixed) m[c] = R.MARK.broken;
  return m;
}

function paint(now = performance.now()) {
  const v = S.view;
  const c = S.cursor;
  const out = R.draw(el.canvas, S.sym, {
    modules: S.applied.modules, under: S.applied.scratched, strokes: S.strokes, showBytes: S.showBytes,
    marks: effectiveMarks(now), flash: S.flash, cursor: c && c.visible ? { u: c.u, v: c.v, r: c.r } : null,
    camera: v.finder ? { finders: v.finders } : null,
  }, S.drawOpts);
  S.geo = out.geo;
}

let raf = 0;
function startAnim() {
  if (!raf) raf = requestAnimationFrame(tick);
}
function tick(now) {
  raf = 0;
  let more = false;
  if (S.ghost.running) more = stepGhost(now);
  if (S.dirty) {
    S.dirty = false;
    analyse();
    S.marks = computeMarks(S.view, true);
    renderReadout('live');
  }
  let flashing = false;
  for (let c = 0; c < S.flash.length; c++) {
    const st = S.flashStart[c];
    if (!st) {
      S.flash[c] = 0;
      continue;
    }
    const t = now - st;
    if (t < 0) {
      S.flash[c] = 0;
      flashing = true;
    } else if (t < 650) {
      S.flash[c] = R.flashAt(t);
      flashing = true;
    } else {
      S.flash[c] = 0;
      S.flashStart[c] = 0;
    }
  }
  paint(now);
  if (more || flashing) startAnim();
}

// ------------------------------------------------------------------------------------------------------------------
// The readout
// ------------------------------------------------------------------------------------------------------------------
const plural = (n, one, many) => (n === 1 ? one : many);
function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}
function blockList(list) {
  const names = list.map((b) => b.i + 1);
  if (names.length === 1) return 'block ' + names[0];
  if (names.length === 2) return 'block ' + names[0] + ' or block ' + names[1];
  return 'block ' + names.slice(0, -1).join(', ') + ' or ' + names[names.length - 1];
}
function instruction() {
  if (coarse) return S.touched ? 'Scratch it. Then scan it with a second phone, or a friend’s.' : 'Drag sideways to scratch, or hold, then drag.';
  return 'Scratch it. Then scan it with your phone.';
}

function labelOf(v) {
  if (v.kind === 'clean') return 'Reads';
  if (v.kind === 'fixed') return v.finder || v.formatStrong || v.blocks.some((b) => b.cameraOver) ? 'Still reads on this page' : 'Still reads';
  if (v.kind === 'wrong') return 'Reads the WRONG message';
  return 'Can’t read it';
}

function summaryOf(v, phase) {
  if (v.kind === 'clean') return S.strokes.length ? 'No broken bytes: nothing you touched changed colour.' : 'No damage yet: every byte is intact.';
  if (v.kind === 'fixed') {
    if (S.erasure) return v.nUnder + ' known ' + plural(v.nUnder, 'gap', 'gaps') + ' filled: the decoder was told where you scratched';
    const n = v.nChanged;
    if (n === 0) return 'No broken bytes: the squares you changed are not part of any byte.';
    return n + ' broken ' + plural(n, 'byte', 'bytes') + (phase === 'live' ? ' so far' : ' found and fixed');
  }
  if (v.kind === 'wrong') return 'The damage looked like a smaller, different scratch, so the decoder fixed the wrong bytes. A scanner would most likely read this wrong message too.';
  if (v.kind === 'format') return 'Both copies of the format strip are damaged, so a reader usually can’t tell how the code was made.';
  const bad = v.blocks.filter((b) => b.over);
  if (!bad.length) return 'The bytes were repaired, but they no longer spell a message.';
  if (S.erasure) {
    if (bad.length === 1) return 'Block ' + (bad[0].i + 1) + ' has ' + bad[0].erased + ' scratched bytes; told where they are, it can fill ' + bad[0].cap + '.';
    return 'Blocks ' + bad.map((b) => b.i + 1).join(' and ') + ' have ' + bad.map((b) => b.erased).join(' and ') + ' scratched bytes; each can fill ' + bad[0].cap + '.';
  }
  if (bad.length === 1) return 'Block ' + (bad[0].i + 1) + ' has ' + bad[0].broken + ' broken bytes; it can fix ' + bad[0].cap + '.';
  return 'Blocks ' + bad.map((b) => b.i + 1).join(' and ') + ' have ' + bad.map((b) => b.broken).join(' and ') + ' broken bytes; each can fix ' + bad[0].cap + '.';
}

function noteOf(v, phase) {
  if (v.kind === 'failed') {
    // Erasure mode counts every scratched byte as a gap; a camera sees only the bytes that changed colour.
    if (S.erasure && !v.finder && !v.formatStrong && v.blocks.some((b) => b.over) && v.blocks.every((b) => b.broken <= b.maxTry)) {
      return { kind: 'warn', text: 'Told where you scratched, this page counts every scratched byte as a gap, and that is too many. A phone doesn’t know where you scratched and sees only the bytes that changed colour, so it may still read this: try it.' };
    }
    return { kind: 'bad', text: 'A phone should give up here too: try it. Undo takes back the last scratch.' };
  }
  if (v.kind === 'format') {
    if (v.read.dataOk) return { kind: 'bad', text: 'The bytes themselves would still be fixable (' + v.blocks.map((b) => 'block ' + (b.i + 1) + ': ' + b.cost + ' of ' + b.cap).join(', ') + '). Most scanners never get that far.' };
    return { kind: 'bad', text: 'Most scanners give up here too. Undo takes back the last scratch.' };
  }
  if (v.kind === 'wrong') return { kind: 'bad', text: 'Small codes keep reserve bytes to make this rarer: see step 6 below.' };
  if (v.blocks.some((b) => b.cameraOver)) return { kind: 'warn', text: 'This page can read it only because it knows where you scratched. A phone doesn’t know, so it should give up here: try it.' };
  if (v.finder) return { kind: 'warn', text: 'A phone may not find this code now: cameras spot a code by its three corner squares, and you scratched one. This page knows the grid, so it still reads.' };
  if (v.formatStrong) return { kind: 'warn', text: 'The format strip is damaged in both copies: a phone may not read this code any more, or may even misread it.' };
  if (v.timing) return { kind: 'warn', text: 'You scratched a timing line (the dotted row or column between the corner squares). Some scanners count squares with it, so a phone may struggle.' };
  const past = S.erasure ? [] : v.blocks.filter((b) => b.past);
  if (past.length) {
    const b = past[0];
    return { kind: 'edge', text: 'Past the promise: block ' + (b.i + 1) + ' has ' + b.cost + ' broken bytes, and at this size the standard only promises ' + b.promised + '. Many scanners still fix ' + b.cap + ' (a few stop at ' + b.promised + '), but one more breaks it.' };
  }
  const edge = v.blocks.filter((b) => b.edge);
  if (edge.length) return { kind: 'edge', text: 'One more ' + (S.erasure ? 'scratched' : 'broken') + ' byte in ' + blockList(edge) + ' breaks it.' };
  if (v.formatAny) return { kind: 'info', text: v.formatOne ? 'One copy of the format strip is damaged; most scanners can still use the spare copy.' : 'The format strip is damaged in both copies; some scanners may struggle.' };
  if (S.noteOnce) return { kind: 'info', text: S.noteOnce };
  return { kind: 'info', text: instruction() };
}

function renderMeters(v) {
  const sig = v.blocks.map((b) => b.cap + '/' + b.promised).join(',');
  if (el.meters.dataset.sig !== sig) {
    el.meters.textContent = '';
    v.blocks.forEach((b) => {
      const m = document.createElement('div');
      m.className = 'qr-meter';
      m.dataset.block = String(b.i);
      m.style.setProperty('--cap', String(b.cap));
      const name = document.createElement('span');
      name.className = 'qr-meter-name';
      name.textContent = 'Block ' + (b.i + 1);
      const cells = document.createElement('span');
      cells.className = 'qr-cells';
      cells.setAttribute('aria-hidden', 'true');
      for (let k = 0; k < b.cap; k++) cells.append(document.createElement('i'));
      const count = document.createElement('span');
      count.className = 'qr-meter-count';
      const cam = document.createElement('span');
      cam.className = 'qr-meter-cam';
      cam.hidden = true;
      m.append(name, cells, count, cam);
      el.meters.append(m);
    });
    el.meters.dataset.sig = sig;
    el.meters.dataset.n = String(v.blocks.length);
  }
  v.blocks.forEach((b, i) => {
    const m = el.meters.children[i];
    const cells = m.children[1];
    while (cells.children.length > b.cap) cells.lastChild.remove();
    const extra = Math.min(4, Math.max(0, b.cost - b.cap));
    for (let k = 0; k < extra; k++) cells.append(document.createElement('i'));
    for (let k = 0; k < cells.children.length; k++) {
      const cls = k >= b.cap ? 'over' : (k < b.cost ? 'on' : '') + (k >= b.promised ? ' promised-gap' : '');
      if (cells.children[k].className !== cls.trim()) cells.children[k].className = cls.trim();
    }
    m.classList.toggle('is-edge', b.edge);
    m.classList.toggle('is-over', b.over);
    m.classList.toggle('is-camera-over', !!b.cameraOver);
    m.children[3].hidden = !b.cameraOver;
    if (b.cameraOver) setText(m.children[3], 'A phone sees ' + b.broken + ' broken bytes here and can fix only ' + b.maxTry + '.');
    const unit = S.erasure ? 'scratched bytes' : 'broken bytes';
    const promise = b.promised < b.cap ? ', promised ' + b.promised : '';
    setText(m.children[2], b.cost + ' of ' + b.cap);
    m.title = 'Block ' + (b.i + 1) + ': ' + b.cost + ' ' + unit + ', it can fix ' + b.cap + promise + (b.cameraOver ? '; a phone sees ' + b.broken + ' broken bytes and can fix ' + b.maxTry : '');
  });
}

function renderReadout(phase) {
  const v = S.view;
  el.readout.dataset.state = v.kind;
  const label = labelOf(v);
  const summary = summaryOf(v, phase);
  setText(el.label, label);
  const wrong = v.kind === 'wrong' ? (v.g.wrongText === '' ? '(an empty message)' : '“' + v.g.wrongText + '”') : null;
  setText(el.message, wrong !== null ? wrong : v.read.ok ? v.read.text : S.sym.text);
  setText(el.summary, summary);
  // Phones put a short summary beside the label; a long label or summary gets its own row (style.css).
  const stack = label.length > 14 || summary.length > 56 ? '1' : '';
  if (el.readout.dataset.stack !== stack) el.readout.dataset.stack = stack;
  renderMeters(v);
  const note = noteOf(v, phase);
  setText(el.note, note.text);
  el.note.dataset.kind = note.kind;
  el.summary.classList.toggle('is-live', phase === 'live' && v.kind === 'fixed');
}

function announce() {
  const v = S.view;
  const meters = v.blocks.map((b) => 'Block ' + (b.i + 1) + ': ' + b.cost + ' of ' + b.cap).join('. ');
  el.live.textContent = labelOf(v) + '. ' + summaryOf(v, 'idle') + '. ' + meters + '.';
}

function updateButtons() {
  el.undo.disabled = S.strokes.length === 0;
  el.clean.disabled = S.strokes.length === 0;
}

// Recompute everything after an edit that is not a live stroke (undo, clean, level, message, erasure toggle).
function afterEdit(flash = false) {
  analyse();
  if (!flash) {
    S.flashStart.fill(0);
    S.flash.fill(0);
    S.prevFixed = null;
  }
  settle(flash);
  renderReadout('idle');
  updateButtons();
  startAnim();
  scheduleCompare();
}

// ------------------------------------------------------------------------------------------------------------------
// Strokes: begin, extend, end
// ------------------------------------------------------------------------------------------------------------------
function toNorm(clientX, clientY) {
  return R.clientToNorm(el.canvas, S.sym, clientX, clientY, S.drawOpts);
}
function beginStroke(p) {
  finishGhost();
  S.noteOnce = null;
  S.active = newStroke(S.tool, BRUSH[S.brush]);
  addPoint(S.active, p.u, p.v, S.sym.size);
  S.strokes.push(S.active);
  S.live = true;
  S.dirty = true;
  updateButtons();
  startAnim();
}
function extendStroke(p) {
  if (!S.active) return;
  if (addPoint(S.active, p.u, p.v, S.sym.size)) {
    S.dirty = true;
    startAnim();
  }
}
function endStroke() {
  if (!S.active) return;
  S.active = null;
  S.live = false;
  S.dirty = false;
  analyse();
  settle(true);
  renderReadout('idle');
  announce();
  updateButtons();
  startAnim();
  scheduleCompare();
}

// ------------------------------------------------------------------------------------------------------------------
// The first frame's sample scratch
// ------------------------------------------------------------------------------------------------------------------
let resolveThumb;
window.__sedThumbReady = new Promise((res) => {
  resolveThumb = res;
  setTimeout(res, 6000);
});

function startGhost() {
  if (S.strokes.length) return resolveThumb();
  if (reduced()) {
    S.strokes = [ghostStroke()];
    afterEdit(false);
    return resolveThumb();
  }
  S.ghost = { running: true, t0: performance.now() + 150, stroke: null };
  S.live = true;
  startAnim();
}
function stepGhost(now) {
  const g = S.ghost;
  const ms = now - g.t0;
  if (ms < 0) return true;
  const { stroke: norm, done } = ghostAt(ms);
  const at = g.stroke ? S.strokes.indexOf(g.stroke) : -1;
  if (at >= 0) S.strokes[at] = norm;
  else S.strokes.unshift(norm);
  g.stroke = norm;
  analyse();
  S.marks = computeMarks(S.view, true);
  renderReadout('live');
  if (at < 0) updateButtons();
  if (done) {
    g.running = false;
    S.live = false;
    const n = settle(true);
    renderReadout('idle');
    announce();
    updateButtons();
    setTimeout(resolveThumb, 260 + n * 60 + 700);
  }
  return true;
}
function finishGhost() {
  const g = S.ghost;
  if (!g.running) return;
  g.running = false;
  S.live = false;
  const full = ghostStroke();
  const at = g.stroke ? S.strokes.indexOf(g.stroke) : -1;
  if (at >= 0) S.strokes[at] = full;
  else S.strokes.unshift(full);
  analyse();
  settle(false);
  renderReadout('idle');
  updateButtons();
  resolveThumb();
}

// ------------------------------------------------------------------------------------------------------------------
// Input: mouse and pen, touch (sideways scratches at once, vertical scrolls, hold then drag), keyboard
// ------------------------------------------------------------------------------------------------------------------
function showCursor(p) {
  S.cursor = { u: p.u, v: p.v, r: BRUSH[S.brush], tool: S.tool, visible: true };
}
el.canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch' || e.button !== 0) return;
  e.preventDefault();
  el.canvas.focus({ preventScroll: true });
  try {
    el.canvas.setPointerCapture(e.pointerId);
  } catch (err) { /* capture is optional */ }
  const p = toNorm(e.clientX, e.clientY);
  showCursor(p);
  beginStroke(p);
});
el.canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') return;
  const list = S.active && e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of list.length ? list : [e]) {
    const p = toNorm(ev.clientX, ev.clientY);
    if (S.active) extendStroke(p);
    showCursor(p);
  }
  startAnim();
});
const endPointer = (e) => {
  if (e.pointerType === 'touch') return;
  if (S.active && !S.keyPen) endStroke();
};
el.canvas.addEventListener('pointerup', endPointer);
el.canvas.addEventListener('pointercancel', endPointer);
el.canvas.addEventListener('pointerleave', (e) => {
  if (e.pointerType === 'touch' || S.active || document.activeElement === el.canvas) return;
  if (S.cursor) S.cursor.visible = false;
  startAnim();
});

let T = null;
function holdRing(on, x, y) {
  const h = el.hold;
  if (!on) {
    h.classList.remove('is-on');
    h.style.removeProperty('--hold');
    return;
  }
  const r = el.card.getBoundingClientRect();
  h.style.left = x - r.left + 'px';
  h.style.top = y - r.top + 'px';
  h.classList.add('is-on');
  if (reduced()) {
    h.style.setProperty('--hold', '100%');
    return;
  }
  const t0 = performance.now();
  const grow = (now) => {
    if (!T || T.mode) return;
    const f = Math.min(1, (now - t0) / 300);
    h.style.setProperty('--hold', Math.round(f * 100) + '%');
    if (f < 1) requestAnimationFrame(grow);
  };
  requestAnimationFrame(grow);
}
el.canvas.addEventListener('touchstart', (e) => {
  if (e.touches.length > 1) {
    if (T && T.mode === 'scratch') endStroke();
    if (T) clearTimeout(T.timer);
    holdRing(false);
    T = null;
    return;
  }
  const t = e.changedTouches[0];
  T = { id: t.identifier, x0: t.clientX, y0: t.clientY, t0: performance.now(), mode: null };
  T.timer = setTimeout(() => {
    if (T && !T.mode) {
      T.mode = 'scratch';
      holdRing(false);
      S.touched = true;
      beginStroke(toNorm(T.x0, T.y0));
    }
  }, 300);
  holdRing(true, t.clientX, t.clientY);
}, { passive: true });
el.canvas.addEventListener('touchmove', (e) => {
  if (!T) return;
  if (e.touches.length > 1) return;
  const t = Array.from(e.changedTouches).find((x) => x.identifier === T.id);
  if (!t) return;
  if (!T.mode) {
    const dx = t.clientX - T.x0;
    const dy = t.clientY - T.y0;
    if (Math.hypot(dx, dy) < 6) return;
    clearTimeout(T.timer);
    holdRing(false);
    if (Math.abs(dx) > Math.abs(dy)) {
      T.mode = 'scratch';
      S.touched = true;
      beginStroke(toNorm(T.x0, T.y0));
    } else {
      T.mode = 'scroll';
      return;
    }
  }
  if (T.mode === 'scratch') {
    if (e.cancelable) e.preventDefault();
    extendStroke(toNorm(t.clientX, t.clientY));
  }
}, { passive: false });
const touchEnd = () => {
  if (!T) return;
  clearTimeout(T.timer);
  holdRing(false);
  if (T.mode === 'scratch') endStroke();
  else if (!T.mode && performance.now() - T.t0 < 300) {
    S.touched = true;
    beginStroke(toNorm(T.x0, T.y0));
    endStroke();
  }
  T = null;
};
el.canvas.addEventListener('touchend', touchEnd);
el.canvas.addEventListener('touchcancel', () => {
  if (!T) return;
  clearTimeout(T.timer);
  holdRing(false);
  if (T.mode === 'scratch') endStroke();
  T = null;
});

el.canvas.addEventListener('focus', () => {
  if (!S.cursor || !S.cursor.visible) {
    const c = S.cursor && S.cursor.kb ? S.cursor : { u: 0.5, v: 0.5 };
    S.cursor = { u: c.u, v: c.v, r: BRUSH[S.brush], tool: S.tool, visible: true, kb: true };
  }
  startAnim();
});
el.canvas.addEventListener('blur', () => {
  if (S.keyPen) {
    S.keyPen = false;
    endStroke();
  }
  if (S.cursor) S.cursor.visible = false;
  startAnim();
});
el.canvas.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 4 : 1;
  const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  const n = S.sym.size;
  if (!S.cursor) S.cursor = { u: 0.5, v: 0.5, r: BRUSH[S.brush], tool: S.tool, visible: true, kb: true };
  if (d) {
    e.preventDefault();
    finishGhost();
    const cx = Math.min(n - 1, Math.max(0, Math.floor(S.cursor.u * n) + d[0]));
    const cy = Math.min(n - 1, Math.max(0, Math.floor(S.cursor.v * n) + d[1]));
    S.cursor.u = (cx + 0.5) / n;
    S.cursor.v = (cy + 0.5) / n;
    S.cursor.visible = true;
    S.cursor.kb = true;
    if (S.keyPen) extendStroke({ u: S.cursor.u, v: S.cursor.v });
    startAnim();
    return;
  }
  if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    if (!S.keyPen) {
      S.keyPen = true;
      beginStroke({ u: S.cursor.u, v: S.cursor.v });
    } else {
      S.keyPen = false;
      endStroke();
    }
    return;
  }
  if (e.key === 'Escape' && S.keyPen) {
    e.preventDefault();
    S.keyPen = false;
    endStroke();
  }
});
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || (e.key !== 'z' && e.key !== 'Z')) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  e.preventDefault();
  undo();
});

// ------------------------------------------------------------------------------------------------------------------
// Controls
// ------------------------------------------------------------------------------------------------------------------
function undo() {
  finishGhost();
  if (S.keyPen) S.keyPen = false;
  if (S.active) {
    S.active = null;
    S.live = false;
  }
  if (!S.strokes.length) return;
  S.strokes.pop();
  afterEdit();
  announce();
}
el.undo.addEventListener('click', undo);
el.clean.addEventListener('click', () => {
  finishGhost();
  S.strokes = [];
  S.active = null;
  S.keyPen = false;
  afterEdit();
  announce();
});
el.tool.addEventListener('click', () => {
  S.tool = S.tool === 'scratch' ? 'marker' : 'scratch';
  el.tool.setAttribute('aria-checked', String(S.tool === 'marker'));
  if (S.cursor) S.cursor.tool = S.tool;
  S.noteOnce = S.tool === 'marker' ? 'Marker paints squares dark, like ink or a sticker. Dark squares it covers stay as they were.' : null;
  renderReadout('idle');
  startAnim();
});
el.bytes.addEventListener('click', () => {
  S.showBytes = !S.showBytes;
  el.bytes.setAttribute('aria-pressed', String(S.showBytes));
  el.legend.hidden = !S.showBytes;
  renderLegend();
  S.noteOnce = S.showBytes ? 'Each outline is one byte: 8 squares. A byte breaks when any of its squares changes colour; the colours show its block. Turn Show bytes off before scanning.' : null;
  renderReadout('idle');
  startAnim();
});
el.moreBtn.addEventListener('click', () => {
  const open = el.more.hidden;
  el.more.hidden = !open;
  el.moreBtn.setAttribute('aria-expanded', String(open));
  if (open) {
    const first = el.more.querySelector('input:checked, button');
    if (first) first.focus({ preventScroll: true });
    el.more.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' });
    scheduleCompare(0);
  }
});
el.more.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    el.more.hidden = true;
    el.moreBtn.setAttribute('aria-expanded', 'false');
    el.moreBtn.focus();
  }
});
el.erase.addEventListener('click', () => {
  finishGhost();
  S.erasure = !S.erasure;
  el.erase.setAttribute('aria-checked', String(S.erasure));
  afterEdit();
  announce();
});
for (const r of document.querySelectorAll('input[name="qr-level"]')) {
  r.addEventListener('change', () => {
    if (r.checked) setLevel(r.value);
  });
}
for (const r of document.querySelectorAll('input[name="qr-brush"]')) {
  if (r.value === S.brush) r.checked = true;
  r.addEventListener('change', () => {
    if (!r.checked) return;
    S.brush = r.value;
    if (S.cursor) S.cursor.r = BRUSH[S.brush];
    startAnim();
  });
}
for (const b of document.querySelectorAll('.qr-try-btn')) {
  b.addEventListener('click', () => {
    setLevel(b.dataset.level);
    el.app.scrollIntoView({ block: 'start', behavior: reduced() ? 'auto' : 'smooth' });
  });
}
// Step 6: a code that lies. 'FLOOR 26' at level L (version 1, automatic mask 7) with seven squares coloured in reads
// as 'FLOOR 17': five broken bytes sit within three of the other message's code. Proved with zxing-cpp and both OpenCV
// detectors on renders (W/proto) and on this page's screenshots (ORACLE); the reserve limit refuses it.
const IMPOSTOR = { text: 'FLOOR 26', level: 'L', squares: [[2, 10], [4, 11], [8, 10], [8, 11], [9, 14], [9, 17], [10, 18]] };
const impostorBtn = $('qr-impostor');
if (impostorBtn) {
  impostorBtn.addEventListener('click', () => {
    finishGhost();
    const back = impostorBtn.dataset.on === '1';
    const text = back ? SAMPLE : IMPOSTOR.text;
    const level = back ? 'H' : IMPOSTOR.level;
    const sym = makeSym(text, level);
    const n = sym.size;
    el.text.value = text;
    S.text = text;
    S.level = level;
    for (const r of document.querySelectorAll('input[name="qr-level"]')) r.checked = r.value === level;
    S.strokes = back ? [] : IMPOSTOR.squares.map(([x, y]) => ({ tool: 'marker', r: 0.3 / n, seed: 1, pts: [(x + 0.5) / n, (y + 0.5) / n] }));
    useSym(sym);
    announce();
    impostorBtn.dataset.on = back ? '' : '1';
    impostorBtn.textContent = back ? 'Load a code that lies' : 'Back to the sample code';
    el.app.scrollIntoView({ block: 'start', behavior: reduced() ? 'auto' : 'smooth' });
  });
}

el.check.addEventListener('click', () => {
  el.checkList.textContent = '';
  const res = runChecks();
  for (const c of res.cases) {
    const li = document.createElement('li');
    li.className = c.ok ? 'ok' : 'fail';
    li.textContent = c.name + (c.detail ? ' (' + c.detail + ')' : '');
    el.checkList.append(li);
  }
  const passed = res.cases.filter((c) => c.ok).length;
  const li = document.createElement('li');
  li.className = passed === res.cases.length ? 'ok' : 'fail';
  li.textContent = passed + ' of ' + res.cases.length + ' checks pass.';
  el.checkList.prepend(li);
});

function setLevel(level) {
  const sym = makeSym(S.text, level);
  for (const r of document.querySelectorAll('input[name="qr-level"]')) r.checked = r.value === level;
  if (!sym) {
    S.level = level;
    helpTooLong();
    return;
  }
  finishGhost();
  S.level = level;
  useSym(sym);
}

function useSym(sym) {
  S.sym = sym;
  S.flash = new Float32Array(sym.stream.length);
  S.flashStart = new Float64Array(sym.stream.length);
  S.prevFixed = null;
  renderLegend();
  sizeCanvas();
  afterEdit();
  paint();
  snapCanvas();
  helpOk();
}

// The Show bytes legend: one key per block of the current code, in render.js's block colours and patterns.
function renderLegend() {
  const keys = document.getElementById('qr-keys');
  if (!keys) return;
  const n = S.sym.blocks.length;
  if (keys.children.length === n) return;
  keys.textContent = '';
  for (let i = 0; i < n; i++) {
    const item = document.createElement('span');
    item.className = 'qr-key-item';
    const k = document.createElement('span');
    k.className = 'qr-key';
    k.dataset.b = String(i);
    item.append(k, ' Block ' + (i + 1));
    keys.append(item, ' ');
  }
}

function helpOk() {
  const n = Array.from(S.text).length;
  el.help.dataset.kind = '';
  el.text.removeAttribute('aria-invalid');
  setText(el.help, n + ' ' + plural(n, 'character', 'characters') + ', fits a ' + S.sym.size + ' × ' + S.sym.size + ' code at level ' + S.sym.level + '.');
}
function helpTooLong() {
  const a = QR.capacity(6, S.level, 'alphanumeric');
  const b = QR.capacity(6, S.level, 'byte');
  el.help.dataset.kind = 'bad';
  el.text.setAttribute('aria-invalid', 'true');
  setText(el.help, 'Too long for this lesson’s biggest code (41 × 41): at level ' + S.level + ' it holds ' + a + ' capital letters and digits, or ' + b + ' bytes of other text (an accented letter takes 2, an emoji 4). Shorten it' + (S.level === 'L' ? '.' : ', or pick level L in More.'));
}
let textTimer = 0;
function applyText() {
  clearTimeout(textTimer);
  const text = el.text.value;
  if (!text.length) {
    el.help.dataset.kind = 'bad';
    setText(el.help, 'Type something to encode.');
    return;
  }
  if (text === S.text && S.sym && S.sym.level === S.level) return helpOk();
  const sym = makeSym(text, S.level);
  if (!sym) {
    S.text = text;
    helpTooLong();
    return;
  }
  finishGhost();
  S.text = text;
  useSym(sym);
}
el.text.addEventListener('input', () => {
  clearTimeout(textTimer);
  textTimer = setTimeout(applyText, 300);
});
el.text.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    applyText();
  }
});

// "Same scratch, every level" (More)
let compareTimer = 0;
function scheduleCompare(ms = 250) {
  if (el.more.hidden) return;
  clearTimeout(compareTimer);
  compareTimer = setTimeout(renderCompare, ms);
}
function renderCompare() {
  const rows = [];
  for (const lv of ['L', 'M', 'Q', 'H']) {
    const sym = makeSym(S.text, lv);
    if (!sym) {
      rows.push([lv, '', 'bad', 'message too long', '']);
      continue;
    }
    const applied = applyStrokes(sym, S.strokes);
    const read = QR.decodeModules(applied.modules, sym.size, { reference: sym });
    const worst = Math.max(0, ...read.graded.trueBroken);
    const wi = read.graded.trueBroken.indexOf(worst);
    const cap = sym.blocks[Math.max(0, wi)].maxTry;
    const ok = read.ok && read.graded.wrongText === null;
    rows.push([lv, sym.size + ' × ' + sym.size, ok ? 'ok' : 'bad', ok ? 'reads' : 'breaks', 'worst block: ' + worst + ' of ' + cap]);
  }
  const tb = document.createElement('tbody');
  for (const [lv, size, cls, verdict, worst] of rows) {
    const tr = document.createElement('tr');
    for (const [text, c] of [[lv, ''], [size, ''], [verdict, cls], [worst, '']]) {
      const td = document.createElement('td');
      td.textContent = text;
      if (c) td.className = c;
      tr.append(td);
    }
    if (lv === S.level) tr.style.fontWeight = '700';
    tb.append(tr);
  }
  el.compare.replaceChildren(tb);
}

// ------------------------------------------------------------------------------------------------------------------
// Step 2: the bytes demo
// ------------------------------------------------------------------------------------------------------------------
function setupMini() {
  const mini = $('qr-mini');
  const out = $('qr-mini-out');
  if (!mini) return;
  const sym = makeSym(SAMPLE, 'H');
  let strokes = [];
  let label = '';
  const draw = () => {
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const box = mini.parentElement.clientWidth || 222;
    const m = Math.max(1, Math.min(Math.floor((box * dpr) / (sym.size + 8)), Math.floor(6 * dpr)));
    const applied = applyStrokes(sym, strokes);
    const read = QR.decodeModules(applied.modules, sym.size, { reference: sym });
    const marks = new Uint8Array(sym.stream.length);
    for (const c of read.graded.changed) marks[c] = R.MARK.broken;
    R.draw(mini, sym, { modules: applied.modules, strokes, showBytes: true, marks }, { modulePx: m / dpr, dpr });
    if (!strokes.length) {
      out.textContent = 'Pick a scratch.';
      return;
    }
    const tb = read.graded.trueBroken;
    out.textContent = label + ': ' + applied.flipped + ' squares changed, ' + read.graded.changed.length + ' bytes broken (' + tb[0] + ' in block 1, ' + tb[1] + ' in block 2). ' + (read.ok ? 'It still reads.' : 'It no longer reads.');
  };
  $('qr-mini-across').addEventListener('click', () => {
    strokes = [{ tool: 'scratch', r: 0.5 / 29, seed: 3, pts: [9.5 / 29, 14.5 / 29, 28.5 / 29, 14.5 / 29] }];
    label = 'Across';
    draw();
  });
  $('qr-mini-down').addEventListener('click', () => {
    strokes = [{ tool: 'scratch', r: 0.5 / 29, seed: 5, pts: [15.5 / 29, 9.5 / 29, 15.5 / 29, 28.5 / 29] }];
    label = 'Down';
    draw();
  });
  $('qr-mini-clear').addEventListener('click', () => {
    strokes = [];
    draw();
  });
  draw();
  return draw;
}

// ------------------------------------------------------------------------------------------------------------------
// Start
// ------------------------------------------------------------------------------------------------------------------
function start() {
  S.sym = makeSym(SAMPLE, 'H');
  S.flash = new Float32Array(S.sym.stream.length);
  S.flashStart = new Float64Array(S.sym.stream.length);
  renderLegend();
  sizeCanvas();
  analyse();
  S.marks = computeMarks(S.view, false);
  paint();
  snapCanvas();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(snapCanvas);
  updateButtons();
  helpOk();
  const redrawMini = setupMini();
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      sizeCanvas();
      paint();
      snapCanvas();
      startAnim();
      if (redrawMini) redrawMini();
    }, 120);
  });
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((x) => x.isIntersecting && x.intersectionRatio >= 0.5)) {
        io.disconnect();
        startGhost();
      }
    }, { threshold: [0, 0.5, 1] });
    io.observe(el.card);
  } else startGhost();
  // The ladder and the exercises sit below the fold: build them in idle time, one per slice, after the first frame.
  const later = window.requestIdleCallback ? (fn) => window.requestIdleCallback(fn, { timeout: 1200 }) : (fn) => setTimeout(fn, 60);
  const jobs = [
    () => mountLine($('w-line')),
    () => mountCurve($('w-curve')),
    () => mountClock($('w-clock')),
    () => initExercises($('explainer')),
  ];
  const next = () => {
    const job = jobs.shift();
    if (!job) return;
    try {
      job();
    } catch (e) { /* the explainer's text still stands without its demos; the answers stay in their details */ }
    later(next);
  };
  later(next);
}

start();

// ORACLE's read-only state hook for the screenshot proofs: the module state the decoder is given, the brush footprint,
// the decode, and where module (0, 0) sits on the hero canvas (device px).
window.__qrState = () => {
  const sym = S.sym;
  const read = S.read;
  return {
    text: S.text, level: sym.level, version: sym.version, mask: sym.mask, size: sym.size,
    modules: Array.from(S.applied.modules).join(''),
    under: Array.from(S.applied.scratched).join(''),
    read: { ok: read.ok, text: read.text, reason: read.reason, blocks: read.blocks.map((b) => ({ found: b.ok ? b.found.length : null, budget: b.budget, maxTry: b.maxTry, ok: b.ok })) },
    structure: read.graded ? read.graded.structure : null,
    geo: { originX: S.geo.originX, originY: S.geo.originY, modulePx: S.geo.modulePx, dpr: S.geo.dpr },
    showBytes: S.showBytes, erasure: S.erasure, strokes: S.strokes.length, ghostRunning: S.ghost.running,
  };
};

// A read-only hook for the page's own tests (and the QA panel): the current symbol, strokes and decode.
window.__qr = {
  get sym() { return S.sym; },
  get read() { return S.read; },
  get view() { return S.view; },
  get applied() { return S.applied; },
  get strokes() { return S.strokes.map((s) => ({ tool: s.tool, r: s.r, pts: s.pts.slice() })); },
  get geo() { return S.geo; },
  get ghostRunning() { return S.ghost.running; },
  setStrokes(list) {
    finishGhost();
    S.strokes = list.map((s) => ({ tool: s.tool, r: s.r, seed: s.seed || 1, pts: s.pts.slice() }));
    afterEdit();
  },
};
