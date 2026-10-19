// ladder.js: the three ladder widgets of "Scratch a QR Code" (SPEC section 7, steps 3 to 5).
//   mountLine(el, opts)   two numbers make a line: 4 points are sent, the decoder names the liar
//   mountCurve(el, opts)  bendier curves: 7 points on a parabola; 2 liars fixed; a known gap costs half a liar
//   mountClock(el, opts)  arithmetic on a clock: the line game mod 13, and partners on a 13- or 12-hour clock
// Each returns {destroy, reset, preset(name), presets, state()}. ES module, no dependencies, no globals, no DOM work
// until a mount function runs, so node can import the exact maths (export `math`) for tests.
// Every decode is exact: fractions of whole numbers for the line and the curve, whole numbers mod 13 on the clock.
// The decoder is brute force: fit every k-point subset and keep the one polynomial that enough points agree with.

/* ------------------------------------------------------------------------------------------------------------ */
/* exact arithmetic                                                                                             */
/* ------------------------------------------------------------------------------------------------------------ */

const gcd = (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) { const t = a % b; a = b; b = t; } return a; };

/** Fractions of whole numbers, always reduced, denominator > 0. Values here stay tiny, so plain numbers are exact. */
export const Q = {
  name: 'fractions',
  make(n, d = 1) {
    if (d === 0) throw new Error('division by zero');
    if (d < 0) { n = -n; d = -d; }
    const g = gcd(n, d) || 1;
    return { n: n / g, d: d / g };
  },
  of: (v) => Q.make(v, 1),
  add: (a, b) => Q.make(a.n * b.d + b.n * a.d, a.d * b.d),
  sub: (a, b) => Q.make(a.n * b.d - b.n * a.d, a.d * b.d),
  mul: (a, b) => Q.make(a.n * b.n, a.d * b.d),
  div: (a, b) => Q.make(a.n * b.d, a.d * b.n),
  eq: (a, b) => a.n === b.n && a.d === b.d,
  isZero: (a) => a.n === 0,
  num: (a) => a.n / a.d,
  str: (a) => (a.d === 1 ? String(a.n) : a.d === 2 ? String(a.n / 2) : `${a.n}/${a.d}`),
  isWhole: (a) => a.d === 1,
};

/** Whole numbers on a p-hour clock (p prime): add, subtract, multiply, and divide by multiplying by the partner. */
export function modField(p) {
  const norm = (v) => ((v % p) + p) % p;
  const inv = (a) => {
    a = norm(a);
    if (a === 0) throw new Error('0 has no partner');
    let [r0, r1, t0, t1] = [p, a, 0, 1];
    while (r1) { const q = Math.floor(r0 / r1); [r0, r1] = [r1, r0 - q * r1]; [t0, t1] = [t1, t0 - q * t1]; }
    if (r0 !== 1) throw new Error(`${a} has no partner on a ${p}-hour clock`);
    return norm(t0);
  };
  return {
    name: `mod ${p}`, p, inv,
    of: norm,
    add: (a, b) => norm(a + b),
    sub: (a, b) => norm(a - b),
    mul: (a, b) => norm(a * b),
    div: (a, b) => norm(a * inv(b)),
    eq: (a, b) => a === b,
    isZero: (a) => a === 0,
    num: (a) => a,
    str: (a) => String(a),
    isWhole: () => true,
  };
}

/** k-element subsets of arr, in order. */
export function* subsets(arr, k, start = 0, acc = []) {
  if (acc.length === k) { yield acc.slice(); return; }
  for (let i = start; i <= arr.length - (k - acc.length); i++) { acc.push(arr[i]); yield* subsets(arr, k, i + 1, acc); acc.pop(); }
}

/** Coefficients c0..c(k-1) of the one polynomial of degree < k through k points [[x, y]] (Gauss-Jordan in F). */
export function fitPoly(F, pts) {
  const k = pts.length;
  const M = pts.map(([x, y]) => {
    const row = []; let pw = F.of(1);
    for (let j = 0; j < k; j++) { row.push(pw); pw = F.mul(pw, F.of(x)); }
    row.push(F.of(y));
    return row;
  });
  for (let c = 0; c < k; c++) {
    let r = c;
    while (r < k && F.isZero(M[r][c])) r++;
    if (r === k) return null;
    [M[c], M[r]] = [M[r], M[c]];
    const piv = M[c][c];
    for (let j = c; j <= k; j++) M[c][j] = F.div(M[c][j], piv);
    for (let i = 0; i < k; i++) {
      if (i === c || F.isZero(M[i][c])) continue;
      const f = M[i][c];
      for (let j = c; j <= k; j++) M[i][j] = F.sub(M[i][j], F.mul(f, M[c][j]));
    }
  }
  return M.map((row) => row[k]);
}

export const evalPoly = (F, coef, x) => coef.reduceRight((acc, c) => F.add(F.mul(acc, F.of(x)), c), F.of(0));

/**
 * The decoder. xs: the x of each sent point; ys: what arrived (null = a known gap); k: numbers in the message.
 * With nk known points it can fix eMax = floor((nk - k) / 2) unknown liars (so 2 x errors + gaps <= n - k), and it
 * accepts a polynomial only when at least need = nk - eMax known points sit on it (then it is the only one).
 * Otherwise it reports 'unsure' and lists the polynomials that fit the most points (the competing lines).
 */
export function decodePoints(F, xs, ys, k) {
  const known = [];
  ys.forEach((y, i) => { if (y !== null && y !== undefined) known.push(i); });
  const nk = known.length;
  const out = { kind: 'underdetermined', known, need: 0, eMax: 0, winner: null, best: [], maxAgree: 0, liars: [] };
  if (nk < k) return out;
  out.eMax = Math.floor((nk - k) / 2);
  out.need = nk - out.eMax;
  const seen = new Map();
  for (const S of subsets(known, k)) {
    const coef = fitPoly(F, S.map((i) => [xs[i], ys[i]]));
    if (!coef) continue;
    const vals = xs.map((x) => evalPoly(F, coef, x));
    const key = vals.map(F.str).join(',');
    if (seen.has(key)) continue;
    seen.set(key, { coef, vals, agree: known.filter((i) => F.eq(vals[i], F.of(ys[i]))) });
  }
  const all = [...seen.values()];
  out.maxAgree = Math.max(0, ...all.map((c) => c.agree.length));
  out.winner = all.find((c) => c.agree.length >= out.need) || null;
  out.best = all.filter((c) => c.agree.length === out.maxAgree);
  if (out.winner) {
    out.liars = known.filter((i) => !out.winner.agree.includes(i));
    out.kind = out.liars.length ? 'fixed' : 'clean';
  } else out.kind = 'unsure';
  return out;
}

/** What actually happened, judged against what was sent (the widget knows it; the decoder does not). */
export function judge(F, dec, sent) {
  if (dec.kind === 'unsure' || dec.kind === 'underdetermined') return 'unsure';
  const right = dec.winner.vals.every((v, i) => F.eq(v, F.of(sent[i])));
  if (dec.kind === 'clean') return right ? 'clean' : 'undetected';
  return right ? 'fixed' : 'fooled';
}

/** QR's own 256-value number system (GF(256) with the standard's rule 0x11D): carry-less multiply, then reduce. */
export function gfMul(a, b) {
  let r = 0;
  while (b) { if (b & 1) r ^= a; a <<= 1; if (a & 0x100) a ^= 0x11d; b >>= 1; }
  return r;
}
export function gfPartner(a) { for (let b = 1; b < 256; b++) if (gfMul(a, b) === 1) return b; return null; }
/** Partner (the number it multiplies with to make 1) of a on a p-hour clock, or null when there is none. */
export function clockPartner(a, p) { for (let b = 0; b < p; b++) if ((a * b) % p === 1 % p) return b; return null; }

export const math = { Q, modField, fitPoly, evalPoly, decodePoints, judge, gfMul, gfPartner, clockPartner, subsets, gcd };

/* ------------------------------------------------------------------------------------------------------------ */
/* defaults and presets (SPEC IC-11; found by tools/presets.mjs, re-checked by tools/presets4.mjs and answers.mjs) */
/* ------------------------------------------------------------------------------------------------------------ */

const LINE = {
  message: [3, 5], max: 12,                 // IC-11: y = 2x + 1, sends 3, 5, 7, 9
  presets: {
    clean: [3, 5, 7, 9],
    'one-liar': [3, 5, 11, 9],              // point 3 is the liar: it should be 7
    'two-liars': [3, 8, 4, 9],              // no line through three points: six competing lines
    fooled: [3, 6, 9, 9],                   // points 1, 2, 3 line up on y = 3x: the decoder "fixes" point 4 to 12, reads 3, 6
    undetected: [4, 6, 8, 10],              // every point moved onto another line
  },
};
const CURVE = {
  message: [1, 5, 8], max: 12,              // IC-11: sends 1, 5, 8, 10, 11, 11, 10 (y = -x²/2 + 11x/2 - 4)
  presets: {
    clean: { recv: [1, 5, 8, 10, 11, 11, 10] },
    'one-liar': { recv: [1, 5, 8, 6, 11, 11, 10] },
    'two-liars': { recv: [1, 2, 8, 10, 11, 7, 10] },
    'three-liars': { recv: [1, 2, 8, 6, 11, 7, 10] },                   // no curve through five points
    'liars-as-gaps': { recv: [1, 2, 8, 6, 11, 7, 10], gaps: [2, 4, 6] },  // the same three, marked as known gaps: read
    fooled: { recv: [1, 6, 9, 10, 9, 11, 10] },                          // points 1 to 5 sit on the hill 1 6 9 10 9 6 1
    undetected: { recv: [2, 6, 9, 11, 12, 12, 11] },                     // every point one higher: another honest curve
    'four-gaps': { recv: [1, 5, 8, 10, 11, 11, 10], gaps: [2, 3, 5, 6] },
    'gaps-one-liar': { recv: [1, 5, 8, 6, 11, 11, 10], gaps: [2, 6] },
    'gaps-two-liars': { recv: [1, 2, 8, 6, 11, 11, 10], gaps: [3, 6] },
  },
};
const CLOCK = {
  message: [5, 8],                          // IC-11: y = 3x + 2 on a 13-hour clock: sends 5, 8, 11, 1 (11 + 3 = 14 is 1)
  presets: {
    clean: [5, 8, 11, 1],
    'one-liar': [5, 8, 4, 1],               // point 3 is the liar: it should be 11
    'two-liars': [5, 2, 4, 1],
    fooled: [4, 8, 12, 1],                  // points 1, 2, 3 sit on y = 4x: the decoder "fixes" point 4 to 3 (12 + 4 = 16 is 3)
  },
};

/* ------------------------------------------------------------------------------------------------------------ */
/* small DOM helpers                                                                                            */
/* ------------------------------------------------------------------------------------------------------------ */

const SVGNS = 'http://www.w3.org/2000/svg';
let uidCounter = 0;
const uid = (p) => `${p}-${++uidCounter}`;
const reduceMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'text') e.textContent = v;
    else if (k === 'class') e.className = v;
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined) e.append(c);
  return e;
}
function s(tag, attrs = {}, parent = null) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'text') e.textContent = v; else e.setAttribute(k, String(v));
  }
  if (parent) parent.append(e);
  return e;
}
const clear = (e) => { while (e.firstChild) e.firstChild.remove(); };
const andList = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
const numWord = (n) => ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'][n] ?? String(n);

/** A box always as tall as the tallest of its sample contents, so changing the text never moves the page. */
function stack(samples, cls, boxCls = '') {
  const box = h('div', { class: `qw-stack ${boxCls}`.trim() });
  const sizer = h('div', { class: 'qw-stack-sizer', 'aria-hidden': 'true' });
  for (const t of samples) sizer.append(h('p', { class: cls, text: t }));
  const el = h('p', { class: cls });
  box.append(sizer, el);
  return { box, el };
}

/** Writes a verdict {status, hint, link} into the status and hint paragraphs. */
function writeSay(statusEl, hintEl, w) {
  statusEl.textContent = w.status;
  hintEl.textContent = w.hint || '';
  if (w.link && w.link.href) hintEl.append(w.hint ? ' ' : '', h('a', { href: w.link.href, text: w.link.text }));
}

/* ------------------------------------------------------------------------------------------------------------ */
/* the point game: shared by the line, the curve and the clock line                                              */
/* ------------------------------------------------------------------------------------------------------------ */

function createPointGame(el, cfg) {
  const { F, n, k, min, max, noun } = cfg;
  const xs = Array.from({ length: n }, (_, i) => i + 1);
  const sent = cfg.sent;
  const st = { recv: cfg.recv.slice(), gaps: new Set(cfg.gaps || []) };
  const isGap = (i) => st.gaps.has(i);
  const listeners = [];
  const on = (t, ev, fn, o) => { t.addEventListener(ev, fn, o); listeners.push(() => t.removeEventListener(ev, fn, o)); };

  const root = h('div', { class: `qw qw-game qw-${cfg.kind}` });
  if (cfg.kicker) root.append(h('p', { class: 'qw-kicker', text: cfg.kicker }));
  const fig = h('div', { class: 'qw-figure' });
  const svg = s('svg', { class: 'qw-svg', role: 'group', 'aria-label': cfg.svgLabel });
  fig.append(svg);
  root.append(fig);

  // the budget line under the plot (curve): the rule, the slots, and what the damage costs
  let meter = null;
  if (cfg.meter) {
    const budget = n - k;
    const textSamples = [];
    for (let g = 0; g <= n; g++) for (let e = 0; e + g <= n; e++) textSamples.push(meterText(budget, g, e));
    const textStack = stack(textSamples, 'qw-meter-text', 'qw-meter-stack');
    meter = { wrap: h('div', { class: 'qw-meter' }), text: textStack.el, slots: [] };
    const slotsBar = h('span', { class: 'qw-meter-bar', 'aria-hidden': 'true' });
    for (let i = 0; i < budget; i++) { const sl = h('span', { class: 'qw-slot' }); meter.slots.push(sl); slotsBar.append(sl); }
    meter.wrap.append(h('span', { class: 'qw-meter-label', text: 'Spent' }), slotsBar, textStack.box);
    meter.box = h('div', { class: 'qw-budget' },
      h('p', { class: 'qw-rule', text: `Extra points: ${budget}. An unknown error (a liar) costs 2 of them, a known gap costs 1.` }),
      meter.wrap);
    root.append(meter.box);
  }

  // the verdict: every possible message is stacked in one grid cell, so the box never changes height
  const say = h('div', { class: 'qw-say' });
  const status = h('p', { class: 'qw-status' });
  const hint = h('p', { class: 'qw-hint' });
  const sizer = h('div', { class: 'qw-say-sizer', 'aria-hidden': 'true' });
  say.append(sizer, h('div', { class: 'qw-say-live' }, status, hint));
  root.append(say);

  // byte rows: message, sent, received, decoded
  const table = h('table', { class: 'qw-bytes' });
  table.append(h('caption', { class: 'qw-sr', text: `The ${noun} game as numbers: the message, what was sent, what arrived and what the decoder made of it.` }));
  const thead = h('thead');
  const trHead = h('tr', {}, h('td', { class: 'qw-bytes-corner' }));
  trHead.append(h('th', { scope: 'colgroup', colspan: k, class: 'qw-bytes-group', text: 'message' }));
  trHead.append(h('th', { scope: 'colgroup', colspan: n - k, class: 'qw-bytes-group is-check', text: 'extra points' }));
  thead.append(trHead);
  table.append(thead);
  const tbody = h('tbody');
  const mkRow = (label, count, cls) => {
    const tr = h('tr', { class: `qw-row ${cls}` }, h('th', { scope: 'row', text: label }));
    const cells = [];
    for (let i = 0; i < n; i++) {
      const td = h('td', { class: i < k ? 'is-msg' : 'is-check' });
      if (i >= count) td.classList.add('is-blank');
      cells.push(td); tr.append(td);
    }
    tbody.append(tr);
    return cells;
  };
  const cMsg = mkRow('Message', k, 'qw-row-msg');
  const cSent = mkRow('Sent', n, 'qw-row-sent');
  const cRecv = mkRow('Received', n, 'qw-row-recv');
  const cDec = mkRow('Decoded', n, 'qw-row-dec');
  table.append(tbody);
  root.append(h('div', { class: 'qw-bytes-wrap' }, table));

  const actions = h('div', { class: 'qw-actions' });
  const resetBtn = h('button', { type: 'button', class: 'qw-btn', text: 'Reset' });
  actions.append(resetBtn);
  root.append(actions);
  const live = h('p', { class: 'qw-live qw-sr', 'aria-live': 'polite' });
  root.append(live);
  clear(el);
  el.append(root);

  /* ----- the view: geometry, static layer, dynamic layer ----- */
  const clipId = uid('qw-clip');
  const defs = s('defs', {}, svg);
  const clip = s('clipPath', { id: clipId }, defs);
  const clipRect = s('rect', {}, clip);
  const gStatic = s('g', { class: 'qw-static' }, svg);
  const gDyn = s('g', { class: 'qw-dyn', 'clip-path': `url(#${clipId})` }, svg);
  const gMarks = s('g', { class: 'qw-marks' }, svg);
  const gHandles = s('g', { class: 'qw-handles' }, svg);
  const gToggles = cfg.gapToggles ? s('g', { class: 'qw-toggles' }, svg) : null;
  const geo = {};

  function layout() {
    const W = Math.max(260, Math.round(fig.clientWidth || 320));
    if (cfg.lattice) {
      const side = Math.min(W, 470);
      const left = 28, right = 8, top = 12, bottom = 28;
      const cell = (side - left - right) / 13;
      Object.assign(geo, { W: side, H: Math.round(top + bottom + cell * 13), left, top, cell, colW: cell,
        px: (x) => left + (x + 0.5) * cell, py: (v) => top + (12.5 - v) * cell, vy: (y) => 12.5 - (y - top) / cell });
      geo.plot = { x: left, y: top, w: cell * 13, h: cell * 13 };
    } else {
      const H0 = Math.round(Math.min(330, Math.max(226, W * 0.58)));
      const left = 32, right = 14, top = 14, bottom = cfg.gapToggles ? 98 : 46;
      const H = H0 + (bottom - 46);
      const pw = W - left - right, ph = H - top - bottom;
      const x0 = 0.45, x1 = n + 0.55, y0 = min - 0.7, y1 = max + 0.7;
      Object.assign(geo, { W, H, left, top, x0, x1, y0, y1,
        px: (x) => left + ((x - x0) / (x1 - x0)) * pw, py: (v) => top + ((y1 - v) / (y1 - y0)) * ph,
        vy: (y) => y1 - ((y - top) / ph) * (y1 - y0) });
      geo.plot = { x: left, y: top, w: pw, h: ph };
      geo.colW = pw / (x1 - x0);
    }
    svg.setAttribute('viewBox', `0 0 ${geo.W} ${geo.H}`);
    svg.setAttribute('width', geo.W);
    svg.setAttribute('height', geo.H);
    Object.entries({ x: geo.plot.x, y: geo.plot.y, width: geo.plot.w, height: geo.plot.h }).forEach(([a, v]) => clipRect.setAttribute(a, v));
    drawStatic();
    render(false);
  }

  function drawStatic() {
    clear(gStatic);
    const P = geo.plot;
    s('rect', { class: 'qw-plot-bg', x: P.x, y: P.y, width: P.w, height: P.h, rx: 6 }, gStatic);
    if (cfg.lattice) {
      s('rect', { class: 'qw-band', x: geo.px(1) - geo.cell / 2, y: P.y, width: geo.cell * 4, height: P.h }, gStatic);
      for (let v = 0; v <= 12; v++) {
        s('text', { class: 'qw-axis', x: geo.left - 6, y: geo.py(v) + 4, 'text-anchor': 'end', text: v }, gStatic);
        // x labels: every column when there is room; on narrow screens the sent columns 1 to 4 and the even ones
        if (geo.cell >= 21 || (v >= 1 && v <= 4) || v % 2 === 0) s('text', { class: `qw-axis${v >= 1 && v <= 4 ? ' qw-axis-x' : ''}`, x: geo.px(v), y: P.y + P.h + 17, 'text-anchor': 'middle', text: v }, gStatic);
        for (let x = 0; x <= 12; x++) s('circle', { class: 'qw-lattice', cx: geo.px(x), cy: geo.py(v), r: 1.6 }, gStatic);
      }
      return;
    }
    const step = P.h / (max - min + 1.4) >= 17 ? 1 : 2;
    for (let v = min; v <= max; v++) {
      const y = geo.py(v);
      s('line', { class: v % 2 === 0 ? 'qw-grid is-major' : 'qw-grid', x1: P.x, x2: P.x + P.w, y1: y, y2: y }, gStatic);
      if (v % step === 0) s('text', { class: 'qw-axis', x: P.x - 7, y: y + 4, 'text-anchor': 'end', text: v }, gStatic);
    }
    for (const x of xs) {
      const X = geo.px(x);
      s('line', { class: 'qw-grid is-col', x1: X, x2: X, y1: P.y, y2: P.y + P.h }, gStatic);
      s('text', { class: 'qw-axis qw-axis-x', x: X, y: P.y + P.h + 17, 'text-anchor': 'middle', text: x }, gStatic);
    }
    // the message / extra points bracket under the x labels (and under the gap toggles on the curve)
    const yb = P.y + P.h + (cfg.gapToggles ? 76 : 27);
    const bracket = (a, b, label, cls) => {
      const xa = geo.px(a) - geo.colW * 0.32, xb = geo.px(b) + geo.colW * 0.32;
      s('path', { class: `qw-bracket ${cls}`, d: `M${xa} ${yb - 3}V${yb}H${xb}V${yb - 3}` }, gStatic);
      s('text', { class: `qw-axis qw-bracket-label ${cls}`, x: (xa + xb) / 2, y: yb + 13, 'text-anchor': 'middle', text: label }, gStatic);
    };
    bracket(1, k, 'message', 'is-msg');
    bracket(k + 1, n, 'extra points', 'is-check');
  }

  /* ----- handles (the points) and the gap toggles ----- */
  const handles = xs.map((x, i) => {
    const g = s('g', { class: `qw-handle ${i < k ? 'is-msg' : 'is-check'}`, tabindex: 0, role: 'slider', 'aria-orientation': 'vertical',
      'aria-valuemin': min, 'aria-valuemax': max, 'aria-label': `Point ${x}, ${i < k ? 'a message number' : 'an extra point'}` }, gHandles);
    const hit = s('rect', { class: 'qw-hit', rx: 12 }, g);
    const ring = s('circle', { class: 'qw-ring', r: 15.5 }, g);
    const dot = s('circle', { class: 'qw-dot', r: i < k ? 8.5 : 7.5 }, g);
    const q = s('text', { class: 'qw-dot-q', 'text-anchor': 'middle', y: 4.5, text: '?' }, g);
    return { g, hit, ring, dot, q, i };
  });
  const toggles = !gToggles ? [] : xs.map((x, i) => {
    const g = s('g', { class: 'qw-gaptoggle', tabindex: 0, role: 'button', 'aria-pressed': 'false', 'aria-label': `Point ${x} is a known gap` }, gToggles);
    s('circle', { class: 'qw-hit', r: 22 }, g);
    s('circle', { class: 'qw-ring', r: 17.5 }, g);
    s('circle', { class: 'qw-gaptoggle-dot', r: 13 }, g);
    s('text', { class: 'qw-gaptoggle-q', 'text-anchor': 'middle', y: 5, text: '?' }, g);
    return { g, i };
  });

  function placeHandles() {
    const hw = Math.max(44, geo.colW), hh = Math.max(44, cfg.lattice ? geo.cell * 1.8 : 48);
    handles.forEach((hd) => {
      const X = geo.px(xs[hd.i]);
      const Y = geo.py(isGap(hd.i) ? (min + max) / 2 : st.recv[hd.i]);
      hd.g.setAttribute('transform', `translate(${X} ${Y})`);
      hd.hit.setAttribute('x', -hw / 2); hd.hit.setAttribute('y', -hh / 2);
      hd.hit.setAttribute('width', hw); hd.hit.setAttribute('height', hh);
    });
    toggles.forEach((tg) => tg.g.setAttribute('transform', `translate(${geo.px(xs[tg.i])} ${geo.plot.y + geo.plot.h + 44})`));
  }

  /* ----- drawing the decoder's answer ----- */
  const pathOf = (coefNums) => {
    const f = (x) => coefNums.reduceRight((a, c) => a * x + c, 0);
    let d = '';
    const steps = k === 2 ? 1 : 64;
    for (let j = 0; j <= steps; j++) {
      const x = geo.x0 + ((geo.x1 - geo.x0) * j) / steps;
      d += `${j ? 'L' : 'M'}${geo.px(x).toFixed(1)} ${geo.py(f(x)).toFixed(1)}`;
    }
    return d;
  };
  // a line y = a x + b on the 13-hour clock: its dots, solid steps, and dashed steps where it wraps past 12
  const clockLine = (vals, cls, parent, x0 = 0, x1 = 12, dots = true) => {
    const a = F.sub(vals[1], vals[0]);
    const b = F.sub(vals[0], a);
    const aa = a <= 6 ? a : a - 13;
    const g = s('g', { class: cls }, parent);
    let solid = '', wrapd = '';
    for (let x = x0; x < x1; x++) {
      const y = F.add(F.mul(a, x), b), y2 = y + aa;
      const seg = (sh) => `M${geo.px(x).toFixed(1)} ${geo.py(y + sh).toFixed(1)}L${geo.px(x + 1).toFixed(1)} ${geo.py(y2 + sh).toFixed(1)}`;
      if (y2 >= 0 && y2 <= 12) solid += seg(0);
      else wrapd += seg(0) + seg(y2 > 12 ? -13 : 13);
    }
    if (solid) s('path', { class: 'qw-clockline', d: solid }, g);
    if (wrapd) s('path', { class: 'qw-clockline is-wrap', d: wrapd }, g);
    if (dots) for (let x = 0; x <= 12; x++) s('circle', { class: 'qw-clockdot', cx: geo.px(x), cy: geo.py(F.add(F.mul(a, x), b)), r: 3.6 }, g);
    return g;
  };

  let flashTimer = 0;
  let last = null;

  function render(commit, why = '') {
    const ys = st.recv.map((v, i) => (isGap(i) ? null : v));
    const dec = decodePoints(F, xs, ys, k);
    const verdict = judge(F, dec, sent);
    const key = dec.winner ? `${dec.liars.join(',')}|${dec.winner.vals.map(F.str).join(',')}|${[...st.gaps].join(',')}` : `none|${[...st.gaps].join(',')}`;
    const fresh = !!last && last.key !== key && commit !== null && !reduceMotion();
    const moved = xs.map((_, i) => i).filter((i) => !isGap(i) && st.recv[i] !== sent[i]);
    const gaps = xs.map((_, i) => i).filter(isGap);
    clear(gDyn); clear(gMarks);

    // 1. the line that was sent, faint, only when the decoder's answer is wrong
    if (verdict === 'fooled' || verdict === 'undetected') {
      if (cfg.lattice) clockLine(sent.slice(0, 2), 'qw-ghost', gDyn);
      else s('path', { class: 'qw-ghost', d: pathOf(fitPoly(F, xs.slice(0, k).map((x, i) => [x, sent[i]])).map(F.num)) }, gDyn);
    }
    // 2. competing lines when the decoder cannot be sure (every pair of points makes a line)
    if (verdict === 'unsure' && k === 2) {
      dec.best.forEach((c, j) => {
        if (cfg.lattice) clockLine(c.vals.slice(0, 2), 'qw-compete', gDyn, 1, 4, false).style.setProperty('--qw-i', j);
        else s('path', { class: 'qw-compete', d: pathOf(c.coef.map(F.num)), style: `--qw-i:${j}` }, gDyn);
      });
    }
    // 3. the decoded line or curve
    if (dec.winner) {
      const cls = verdict === 'fooled' || verdict === 'undetected' ? 'qw-fit is-wrong' : 'qw-fit';
      if (cfg.lattice) clockLine(dec.winner.vals.slice(0, 2), cls, gDyn);
      else s('path', { class: cls, d: pathOf(dec.winner.coef.map(F.num)) }, gDyn);
    }
    // gap columns
    for (const i of gaps) {
      const X = geo.px(xs[i]);
      const w = Math.min(36, geo.colW * 0.72);
      s('rect', { class: 'qw-gapcol', x: X - w / 2, y: geo.plot.y + 2, width: w, height: geo.plot.h - 4, rx: 6 }, gDyn);
    }
    // 4. where each moved point came from (what the visitor did; the decoder never sees this)
    for (const i of moved) {
      if (dec.winner && dec.liars.includes(i) && F.eq(dec.winner.vals[i], F.of(sent[i]))) continue;
      const X = geo.px(xs[i]);
      s('line', { class: 'qw-trail', x1: X, x2: X, y1: geo.py(sent[i]), y2: geo.py(st.recv[i]) }, gMarks);
      s('circle', { class: 'qw-origin', cx: X, cy: geo.py(sent[i]), r: 4.5 }, gMarks);
    }
    // 5. the decoder's repairs: an error bar from the liar to where it should be, and the fix sliding home
    if (dec.winner) {
      dec.liars.forEach((i, j) => {
        const X = geo.px(xs[i]);
        const ok = F.eq(dec.winner.vals[i], F.of(sent[i]));
        const yw = clampY(F.num(dec.winner.vals[i]));
        const yr = geo.py(st.recv[i]);
        s('line', { class: 'qw-errbar', x1: X, x2: X, y1: yr, y2: yw }, gMarks);
        if (fresh) {
          const tr = s('circle', { class: `qw-travel${ok ? '' : ' is-wrong'}`, cx: X, cy: yw, r: 5.5 }, gMarks);
          tr.style.setProperty('--qw-dy', `${(yr - yw).toFixed(1)}px`);
          tr.style.animationDelay = `${j * 120}ms`;
        }
        s('circle', { class: `qw-want${ok ? '' : ' is-wrong'}${fresh ? ' is-new' : ''}`, cx: X, cy: yw, r: 10.5, style: fresh ? `animation-delay:${j * 120 + 380}ms` : null }, gMarks);
        label(X, yw, ok ? F.str(dec.winner.vals[i]) : `“${F.str(dec.winner.vals[i])}”`, ok ? 'qw-want-label' : 'qw-want-label is-wrong', st.recv[i] > F.num(dec.winner.vals[i]));
      });
      for (const i of gaps) {
        const X = geo.px(xs[i]);
        const yw = clampY(F.num(dec.winner.vals[i]));
        s('circle', { class: 'qw-gapfill', cx: X, cy: yw, r: 9 }, gMarks);
        label(X, yw, F.str(dec.winner.vals[i]), 'qw-want-label is-gap', false);
      }
    }

    // handles and toggles: state and aria
    handles.forEach((hd) => {
      const i = hd.i, gap = isGap(i);
      hd.g.classList.toggle('is-liar', !!dec.winner && dec.liars.includes(i));
      hd.g.classList.toggle('is-gap', gap);
      hd.g.classList.toggle('is-moved', moved.includes(i));
      if (gap) {
        hd.g.setAttribute('tabindex', '-1');
        hd.g.setAttribute('aria-disabled', 'true');
        hd.g.setAttribute('aria-valuetext', 'a known gap');
      } else {
        hd.g.setAttribute('tabindex', '0');
        hd.g.removeAttribute('aria-disabled');
        hd.g.setAttribute('aria-valuenow', st.recv[i]);
        hd.g.setAttribute('aria-valuetext', `${st.recv[i]}${st.recv[i] !== sent[i] ? `, moved from ${sent[i]}` : ''}`);
      }
    });
    toggles.forEach((tg) => { tg.g.setAttribute('aria-pressed', String(isGap(tg.i))); tg.g.classList.toggle('is-on', isGap(tg.i)); });
    placeHandles();

    // byte rows
    cMsg.forEach((td, i) => { td.textContent = i < k ? String(sent[i]) : ''; });
    cSent.forEach((td, i) => { td.textContent = String(sent[i]); });
    cRecv.forEach((td, i) => {
      td.textContent = isGap(i) ? '?' : String(st.recv[i]);
      td.classList.toggle('is-damaged', !isGap(i) && st.recv[i] !== sent[i]);
      td.classList.toggle('is-gap', isGap(i));
    });
    cDec.forEach((td, i) => {
      td.classList.remove('is-fixed', 'is-wrong', 'is-unknown', 'is-filled', 'is-frac');
      if (!dec.winner) { td.textContent = '?'; td.classList.add('is-unknown'); return; }
      const v = dec.winner.vals[i];
      td.textContent = F.str(v);
      if (!F.isWhole(v)) td.classList.add('is-frac');
      const changed = isGap(i) || !F.eq(v, F.of(st.recv[i]));
      const right = F.eq(v, F.of(sent[i]));
      if (!right) td.classList.add('is-wrong');
      else if (changed) td.classList.add(isGap(i) ? 'is-filled' : 'is-fixed');
    });
    // newly repaired cells flash green once (only true repairs; none under reduced motion)
    if (fresh && dec.winner && dec.liars.length) {
      clearTimeout(flashTimer);
      cDec.forEach((td) => td.classList.remove('is-flash'));
      void table.offsetWidth;
      dec.liars.forEach((i) => { if (F.eq(dec.winner.vals[i], F.of(sent[i]))) cDec[i].classList.add('is-flash'); });
      flashTimer = setTimeout(() => cDec.forEach((td) => td.classList.remove('is-flash')), 1000);
    }

    // words
    const sum = summarize(dec, verdict, moved, gaps);
    const w = cfg.words(sum);
    writeSay(status, hint, w);
    if (meter) updateMeter(gaps.length, moved.length);
    root.dataset.verdict = verdict;
    last = { key, verdict };
    if (commit) announce(`${why}${w.status}`);
    if (cfg.onChange) cfg.onChange(snapshot(dec, verdict));
  }

  const clampY = (v) => geo.py(Math.max(min - 0.55, Math.min(max + 0.55, v)));
  function label(X, Y, text, cls, below) {
    const t = s('text', { class: cls, x: X + 14, y: Y + (below ? 15 : -9), text }, gMarks);
    if (X + 14 + 26 > geo.W) { t.setAttribute('x', X - 14); t.setAttribute('text-anchor', 'end'); }
    return t;
  }

  function summarize(dec, verdict, moved, gaps) {
    const vals = dec.winner ? dec.winner.vals : null;
    return {
      verdict, moved, gaps, n, k,
      msgText: sent.slice(0, k).join(', '),
      decText: vals ? vals.slice(0, k).map(F.str).join(', ') : '',
      liars: dec.liars.map((i) => ({ p: xs[i], v: vals ? F.str(vals[i]) : '?', honest: st.recv[i] === sent[i] })),
      agree: vals ? dec.winner.agree.map((i) => String(xs[i])) : [],
      gapVals: vals ? gaps.map((i) => F.str(vals[i])) : [],
      gapPoints: gaps.map((i) => String(xs[i])),
      slope: vals && cfg.lattice ? F.sub(vals[1], vals[0]) : null,
      wrapSay: vals && cfg.lattice ? wrapSay(vals) : '',
      need: dec.need, known: dec.known.length, budget: n - k,
      cost: 2 * moved.length + gaps.length,
      link: cfg.reserveHref ? { href: cfg.reserveHref, text: 'Why small codes keep spare check bytes' } : null,
    };
  }
  // the first step that goes round the clock, in words: "11 + 4 = 15 lands on 2"
  function wrapSay(vals) {
    const a = F.sub(vals[1], vals[0]);
    for (let i = 0; i + 1 < vals.length; i++) if (vals[i] + a > 12) return `${vals[i]} + ${a} = ${vals[i] + a} lands on ${F.add(vals[i], a)}`;
    return '';
  }

  function updateMeter(gapsN, liarsN) {
    const budget = n - k;
    const fills = [];
    for (let g = 0; g < gapsN; g++) fills.push('is-gap');
    for (let l = 0; l < liarsN; l++) fills.push('is-liar', 'is-liar');
    meter.slots.forEach((sl, i) => { sl.className = `qw-slot ${fills[i] || ''}`; });
    const over = Math.max(0, fills.length - budget);
    meter.text.textContent = meterText(budget, gapsN, liarsN);
    meter.wrap.classList.toggle('is-over', over > 0);
    meter.wrap.classList.toggle('is-full', fills.length === budget);
  }

  // the sizer: the longest message each verdict can produce, stacked invisibly so the box keeps its height
  function buildSizer() {
    clear(sizer);
    for (const sample of cfg.samples()) {
      const w = cfg.words(sample);
      const ps = h('p', { class: 'qw-status' }), ph = h('p', { class: 'qw-hint' });
      writeSay(ps, ph, w);
      sizer.append(h('div', {}, ps, ph));
    }
  }

  let liveTimer = 0;
  function announce(text) {
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => { live.textContent = text; }, 120);
  }

  function snapshot(dec, verdict) {
    return { verdict, received: st.recv.slice(), gaps: [...st.gaps].map((i) => xs[i]).sort((a, b) => a - b),
      liars: dec.liars.map((i) => xs[i]), decoded: dec.winner ? dec.winner.vals.map(F.str) : null, sent: sent.slice() };
  }

  /* ----- input: drag (mouse, pen, touch), keyboard ----- */
  let drag = null;
  const svgPoint = (e) => { const r = svg.getBoundingClientRect(); const sc = geo.W / (r.width || geo.W); return { x: (e.clientX - r.left) * sc, y: (e.clientY - r.top) * sc }; };
  handles.forEach((hd) => {
    on(hd.g, 'pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      // hit areas are at least 44 px and may overlap on narrow screens: take the nearest point that is not a gap
      const p = svgPoint(e);
      let best = -1, bd = Infinity;
      handles.forEach((o) => { if (isGap(o.i)) return; const d = Math.abs(geo.px(xs[o.i]) - p.x); if (d < bd) { bd = d; best = o.i; } });
      if (best < 0) return;
      const target = handles[best];
      e.preventDefault();
      target.g.focus({ preventScroll: true });
      try { hd.g.setPointerCapture(e.pointerId); } catch { /* old browsers */ }
      drag = { id: e.pointerId, i: best, cap: hd.g, off: p.y - geo.py(st.recv[best]), from: st.recv[best] };
      target.g.classList.add('is-dragging');
      root.classList.add('is-dragging');
    });
    on(hd.g, 'pointermove', (e) => {
      if (!drag || drag.id !== e.pointerId || drag.cap !== hd.g) return;
      e.preventDefault();
      const p = svgPoint(e);
      const v = Math.max(min, Math.min(max, Math.round(geo.vy(p.y - drag.off))));
      if (v !== st.recv[drag.i]) { st.recv[drag.i] = v; render(false); }
    });
    const end = (e) => {
      if (!drag || drag.id !== e.pointerId || drag.cap !== hd.g) return;
      const d = drag; drag = null;
      handles[d.i].g.classList.remove('is-dragging');
      root.classList.remove('is-dragging');
      if (st.recv[d.i] !== d.from) render(true, `Point ${xs[d.i]} moved to ${st.recv[d.i]}. `);
    };
    on(hd.g, 'pointerup', end);
    on(hd.g, 'pointercancel', end);
    on(hd.g, 'lostpointercapture', end);
    // Chromium ignores touch-action on SVG child elements, so a finger on a point would scroll the page and cancel
    // the drag. Cancelling the touch here keeps the page still for that finger only; a swipe that starts anywhere
    // else on the plot still scrolls, as a phone visitor expects.
    on(hd.g, 'touchstart', (e) => { if (!isGap(hd.i)) e.preventDefault(); }, { passive: false });
    on(hd.g, 'touchmove', (e) => { if (drag) e.preventDefault(); }, { passive: false });
    on(hd.g, 'keydown', (e) => {
      if (isGap(hd.i)) return;
      const v0 = st.recv[hd.i];
      const span = max - min + 1;
      const step = (d) => (cfg.wrap ? min + ((((v0 - min + d) % span) + span) % span) : Math.max(min, Math.min(max, v0 + d)));
      let v = v0;
      switch (e.key) {
        case 'ArrowUp': case 'ArrowRight': v = step(1); break;
        case 'ArrowDown': case 'ArrowLeft': v = step(-1); break;
        case 'PageUp': v = step(3); break;
        case 'PageDown': v = step(-3); break;
        case 'Home': v = min; break;
        case 'End': v = max; break;
        default: return;
      }
      e.preventDefault();
      if (v !== v0) { st.recv[hd.i] = v; render(true, `Point ${xs[hd.i]} now ${v}. `); }
    });
  });
  toggles.forEach((tg) => {
    const flip = () => {
      if (isGap(tg.i)) st.gaps.delete(tg.i); else st.gaps.add(tg.i);
      render(true, isGap(tg.i) ? `Point ${xs[tg.i]} is now a known gap. ` : `Point ${xs[tg.i]} is no longer a gap. `);
    };
    on(tg.g, 'click', flip);
    on(tg.g, 'keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
  });
  on(resetBtn, 'click', () => {
    st.recv = sent.slice();
    st.gaps.clear();
    render(true, 'Reset: every point is back where it was sent. ');
  });

  let ro = null, raf = 0, lastW = 0;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { const w = Math.round(fig.clientWidth); if (w && w !== lastW) { lastW = w; layout(); } });
    });
    ro.observe(fig);
  }

  buildSizer();
  lastW = Math.round(fig.clientWidth);
  layout();
  render(null);

  return {
    root,
    destroy() { listeners.forEach((f) => f()); if (ro) ro.disconnect(); clearTimeout(flashTimer); clearTimeout(liveTimer); cancelAnimationFrame(raf); clear(el); },
    reset() { st.recv = sent.slice(); st.gaps.clear(); render(false); },
    set(values, gapPoints = []) {
      st.recv = values.map((v) => Math.max(min, Math.min(max, Math.round(v))));
      st.gaps = new Set(cfg.gapToggles ? gapPoints.map((p) => p - 1) : []);
      render(false);
    },
    state() { const ys = st.recv.map((v, i) => (isGap(i) ? null : v)); const dec = decodePoints(F, xs, ys, k); return snapshot(dec, judge(F, dec, sent)); },
  };
}

/** The curve's spending line: "2 × 1 error + 1 gap = 3 of 4". */
function meterText(budget, gapsN, errorsN) {
  const used = gapsN + 2 * errorsN;
  if (used === 0) return `nothing yet: 0 of ${budget}`;
  const parts = [];
  if (errorsN) parts.push(`2 × ${errorsN} ${errorsN === 1 ? 'error' : 'errors'}`);
  if (gapsN) parts.push(`${gapsN} ${gapsN === 1 ? 'gap' : 'gaps'}`);
  return `${parts.join(' + ')} = ${used} of ${budget}${used > budget ? ': too many' : used === budget ? ': the limit' : ''}`;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* the words (SPEC 7's copy for the line; the same voice for the curve and the clock)                           */
/* ------------------------------------------------------------------------------------------------------------ */

function lineWords(clock) {
  const kind = clock ? 'clock line' : 'line';
  return (sm) => {
    const { verdict, liars } = sm;
    switch (verdict) {
      case 'clean':
        return clock
          ? { status: `All four points agree on one clock line: each step adds ${sm.slope} and goes round after 12${sm.wrapSay ? ` (${sm.wrapSay})` : ''}. The message is ${sm.msgText}.`,
            hint: 'Drag a point off the line, as before (or Tab to it and use the arrow keys).' }
          : { status: `All four points agree: the message is ${sm.msgText}.`,
            hint: 'Drag any point up or down (or Tab to it and use the arrow keys).' };
      case 'fixed':
        return { status: `Point ${liars[0].p} is the liar: the only ${kind} through three of the points says it should be ${liars[0].v}.${clock ? ' The same search as before, with whole numbers only.' : ''}`,
          hint: 'Now drag a second point.' };
      case 'unsure':
        return { status: `Something is wrong, but I can't tell what: each of these 6 ${kind}s fits two points.`,
          hint: 'Two extra points can fix one liar, and only spot two. Press Reset to start again.' };
      case 'fooled':
        return { status: `Fooled: three points agree on a different ${kind}, so I would “fix” the wrong point and read ${sm.decText}.`,
          hint: `The message was ${sm.msgText}.`, link: sm.link };
      case 'undetected':
        return { status: `All four points agree, so I see nothing wrong, but this is not the ${kind} that was sent: I would read ${sm.decText}.`,
          hint: `The message was ${sm.msgText}. With every point moved, nothing honest is left to compare with.` };
      default:
        return { status: '', hint: '' };
    }
  };
}

function curveWords(sm) {
  const { verdict, liars, gaps } = sm;
  const g = gaps.length;
  const gapLead = g ? `${g === 1 ? `Point ${sm.gapPoints[0]} is a known gap` : `Points ${andList(sm.gapPoints)} are known gaps`}. ` : '';
  switch (verdict) {
    case 'clean':
      return g
        ? { status: `${gapLead}The other ${numWord(sm.known)} agree on one curve, which fills ${g === 1 ? 'it' : 'them'} in: ${andList(sm.gapVals)}. The message is ${sm.msgText}.`,
          hint: g >= 4 ? 'Four known gaps use all 4 extra points.' : 'A known gap costs 1 extra point. Drag a point, or mark another gap.' }
        : { status: `All seven points agree: the message is ${sm.msgText}.`,
          hint: 'Drag two points off the curve, or tap a ? to mark a point as a known gap.' };
    case 'fixed': {
      const who = liars.length === 1 ? `Point ${liars[0].p} is a liar` : `Points ${andList(liars.map((l) => String(l.p)))} are liars`;
      const what = liars.length === 1 ? `it should be ${liars[0].v}` : `they should be ${andList(liars.map((l) => l.v))}`;
      return { status: `${gapLead}${who}: the only curve through ${numWord(sm.known - liars.length)} of the ${g ? 'known ' : ''}points says ${what}.`,
        hint: sm.cost >= sm.budget ? 'That uses all 4 extra points. One more liar is too many, unless you mark it as a known gap.' : 'Now drag a second point.' };
    }
    case 'unsure': {
      const m = sm.moved.length;
      const fits = sm.need === sm.known ? `all ${numWord(sm.known)} known points` : `${numWord(sm.need)} of the ${g ? `${numWord(sm.known)} known ` : 'seven '}points`;
      return { status: `Something is wrong, but I can't tell what: no curve fits ${fits}.`,
        hint: m > 0 ? `This damage costs ${sm.cost} of the 4 extra points. Tap ? under ${m === 1 ? 'the liar' : 'the liars'} to tell me where ${m === 1 ? 'it is' : 'they are'}.` : 'Reset to start again.' };
    }
    case 'fooled': {
      const wrongFix = liars.filter((l) => l.honest).map((l) => String(l.p));
      return { status: `Fooled: ${numWord(sm.agree.length)} points agree on a different curve, so I would “fix” ${wrongFix.length === 1 ? `point ${wrongFix[0]}` : `points ${andList(wrongFix)}`} and read ${sm.decText}.`,
        hint: `The message was ${sm.msgText}.`, link: sm.link };
    }
    case 'undetected':
      return { status: `Every point I can see agrees, so I see nothing wrong, but this is not the curve that was sent: I would read ${sm.decText}.`,
        hint: sm.known === sm.k
          ? `The message was ${sm.msgText}. Three points always fit some curve, so with only three left there is nothing to check them against.`
          : `The message was ${sm.msgText}. With this many points moved, nothing honest is left to compare with.` };
    default:
      return { status: '', hint: '' };
  }
}

const fake = (o) => ({ verdict: 'clean', liars: [], gaps: [], moved: [], agree: [], gapVals: [], gapPoints: [], msgText: '12, 12, 12', decText: '22/9, 25/9, 40/9',
  slope: 12, wrapSay: '12 + 12 = 24 lands on 11', need: 5, known: 7, budget: 4, cost: 14, link: { href: '#', text: 'Why small codes keep spare check bytes' }, ...o });
const L1 = [{ p: 4, v: '22/3', honest: true }];
const L2 = [{ p: 3, v: '22/3', honest: true }, { p: 6, v: '22/3', honest: true }];
const lineSamples = () => ['clean', 'fixed', 'unsure', 'fooled', 'undetected'].map((v) => fake({ verdict: v, liars: L1, msgText: '12, 12', decText: '22/3, 12' }));
const curveSamples = () => [
  fake({}), fake({ verdict: 'fixed', liars: L1, cost: 2 }), fake({ verdict: 'fixed', liars: L2, cost: 4 }),
  fake({ verdict: 'fixed', liars: L1, gaps: [2, 5], gapPoints: ['3', '6'], known: 5, cost: 4 }),
  fake({ verdict: 'clean', gaps: [1, 2, 4, 5], gapPoints: ['2', '3', '5', '6'], gapVals: ['12', '12', '12', '12'], known: 3, cost: 4 }),
  fake({ verdict: 'clean', gaps: [1, 2, 4], gapPoints: ['2', '3', '5'], gapVals: ['12', '12', '12'], known: 4, cost: 3 }),
  fake({ verdict: 'unsure', moved: [1, 2, 3, 4, 5, 6, 7] }),
  fake({ verdict: 'unsure', moved: [1, 2, 3], gaps: [4, 5, 6], gapPoints: ['5', '6', '7'], need: 4, known: 4, cost: 13 }),
  fake({ verdict: 'fooled', liars: L2, agree: ['1', '2', '3', '4', '5'] }),
  fake({ verdict: 'undetected' }),
  fake({ verdict: 'undetected', known: 3, k: 3, gaps: [1, 2, 4, 5], gapPoints: ['2', '3', '5', '6'] }),
  fake({ verdict: 'unsure', moved: [1], gaps: [1, 2, 4], gapPoints: ['2', '3', '5'], need: 4, known: 4, cost: 5 }),
];

/* ------------------------------------------------------------------------------------------------------------ */
/* the three mounts                                                                                             */
/* ------------------------------------------------------------------------------------------------------------ */

const asPreset = (p) => (Array.isArray(p) ? { recv: p, gaps: [] } : { recv: p.recv, gaps: p.gaps || [] });
function pickPreset(presets, name, fallback) {
  if (!name) return { recv: fallback, gaps: [] };
  if (!presets[name]) { console.warn(`ladder: unknown preset "${name}"`); return { recv: fallback, gaps: [] }; }
  return asPreset(presets[name]);
}

/** Values at x = 1..n of the polynomial through the message (the message is its values at x = 1..k). */
function sentFrom(F, message, n) {
  const coef = fitPoly(F, message.map((y, i) => [i + 1, y]));
  return Array.from({ length: n }, (_, i) => evalPoly(F, coef, i + 1));
}

function withPresets(game, presets) {
  return {
    destroy: game.destroy, reset: game.reset, state: game.state,
    preset(name) { const p = presets[name]; if (!p) return false; const q = asPreset(p); game.set(q.recv, q.gaps); return true; },
    presets: Object.keys(presets).filter((key) => presets[key]),
  };
}

/** For a non-default message: one example of each outcome by a small ordered search (cheap for 4 points). */
function searchPresets(F, sent, k, min, max) {
  const n = sent.length;
  const xs = Array.from({ length: n }, (_, i) => i + 1);
  const out = { clean: sent.slice() };
  const offs = [3, -3, 4, -4, 2, -2, 5, -5, 1, -1];
  const tryMoves = (idx, want, name) => {
    const rec = (j, cur) => {
      if (out[name]) return;
      if (j === idx.length) { if (judge(F, decodePoints(F, xs, cur, k), sent) === want) out[name] = cur.slice(); return; }
      for (const o of offs) {
        const v = sent[idx[j]] + o;
        if (v < min || v > max) continue;
        const c = cur.slice(); c[idx[j]] = v;
        rec(j + 1, c);
        if (out[name]) return;
      }
    };
    rec(0, sent.slice());
  };
  const pairs = [...subsets(xs.map((_, i) => i), 2)].reverse();
  tryMoves([n - 2], 'fixed', 'one-liar');
  if (k === 2) { for (const pr of pairs) tryMoves(pr, 'unsure', 'two-liars'); for (const pr of pairs) tryMoves(pr, 'fooled', 'fooled'); }
  else for (const pr of pairs) tryMoves(pr, 'fixed', 'two-liars');
  return out;
}

const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Step 3, two numbers make a line. opts: {message: [a, b] (default [3, 5]), max: 12, preset: 'clean'|'one-liar'|
 * 'two-liars'|'fooled'|'undetected', received: [4 numbers], reserveHref: '#step-6' (the fooled state's link; null
 * for none), onChange(state)}.
 */
export function mountLine(el, opts = {}) {
  const max = opts.max ?? LINE.max;
  let message = opts.message || LINE.message;
  let sent = sentFrom(Q, message, 4);
  if (!sent.every((v) => Q.isWhole(v) && v.n >= 0 && v.n <= max)) { console.warn('ladder: line message leaves 0..max'); message = LINE.message; sent = sentFrom(Q, message, 4); }
  const sentNums = sent.map(Q.num);
  const presets = sameList(message, LINE.message) && max === LINE.max ? LINE.presets : searchPresets(Q, sentNums, 2, 0, max);
  const p = opts.received ? { recv: opts.received, gaps: [] } : pickPreset(presets, opts.preset, sentNums);
  const game = createPointGame(el, {
    kind: 'line', F: Q, n: 4, k: 2, min: 0, max, noun: 'line', sent: sentNums, recv: p.recv,
    reserveHref: opts.reserveHref === undefined ? '#step-6' : opts.reserveHref,
    svgLabel: 'Four points on a straight line. Points 1 and 2 are the message, points 3 and 4 are extra points. Drag a point, or Tab to it and use the arrow keys.',
    words: lineWords(false), samples: lineSamples, onChange: opts.onChange,
  });
  return withPresets(game, presets);
}

/**
 * Step 4, bendier curves. opts: {message: [a, b, c] (default [1, 5, 8]), preset: 'clean'|'one-liar'|'two-liars'|
 * 'three-liars'|'liars-as-gaps'|'fooled'|'undetected'|'four-gaps'|'gaps-one-liar'|'gaps-two-liars', received: [7 numbers],
 * gaps: [point numbers marked as known gaps], reserveHref: '#step-6', max: 12, onChange(state)}.
 */
export function mountCurve(el, opts = {}) {
  const max = opts.max ?? CURVE.max;
  let message = opts.message || CURVE.message;
  let sent = sentFrom(Q, message, 7);
  if (!sent.every((v) => Q.isWhole(v) && v.n >= 0 && v.n <= max)) { console.warn('ladder: curve message leaves 0..max'); message = CURVE.message; sent = sentFrom(Q, message, 7); }
  const sentNums = sent.map(Q.num);
  const presets = sameList(message, CURVE.message) && max === CURVE.max ? CURVE.presets : searchPresets(Q, sentNums, 3, 0, max);
  const p = opts.received ? { recv: opts.received, gaps: opts.gaps || [] } : pickPreset(presets, opts.preset, sentNums);
  const game = createPointGame(el, {
    kind: 'curve', F: Q, n: 7, k: 3, min: 0, max, noun: 'curve', sent: sentNums, recv: p.recv,
    gaps: (p.gaps.length ? p.gaps : opts.gaps || []).map((x) => x - 1), gapToggles: true, meter: true,
    reserveHref: opts.reserveHref === undefined ? '#step-6' : opts.reserveHref,
    svgLabel: 'Seven points on a curve. Points 1 to 3 are the message, points 4 to 7 are extra points. Drag a point, or Tab to it and use the arrow keys. The question-mark buttons under the points mark a point as a known gap.',
    words: curveWords, samples: curveSamples, onChange: opts.onChange,
  });
  return withPresets(game, presets);
}

/**
 * Step 5, arithmetic on a clock. opts: {parts: ['line', 'partners'] (default; add 'trap' for the optional 256-hour
 * dial), message: [a, b] (default [5, 8]), preset: 'clean'|'one-liar'|'two-liars'|'fooled', received,
 * pick: 3 (the number shown first on the partners dial), hours: 13 | 12 (the dial's starting clock),
 * trap: 128, reserveHref, onChange(state)}.
 */
export function mountClock(el, opts = {}) {
  const F = modField(13);
  const parts = opts.parts || ['line', 'partners'];
  clear(el);
  const wrap = h('div', { class: 'qw qw-clock' });
  el.append(wrap);
  const kids = [];
  if (parts.includes('line')) {
    const slot = h('div', { class: 'qw-part qw-part-line' });
    wrap.append(slot);
    const message = opts.message || CLOCK.message;
    const sent = sentFrom(F, message, 4);
    const presets = sameList(message, CLOCK.message) ? CLOCK.presets : searchPresets(F, sent, 2, 0, 12);
    const p = opts.received ? { recv: opts.received, gaps: [] } : pickPreset(presets, opts.preset, sent);
    const game = createPointGame(slot, {
      kind: 'clockgame', F, n: 4, k: 2, min: 0, max: 12, wrap: true, lattice: true, noun: 'clock line',
      sent, recv: p.recv, kicker: 'The line game on a 13-hour clock',
      reserveHref: opts.reserveHref === undefined ? '#step-6' : opts.reserveHref,
      svgLabel: 'A 13 by 13 grid of whole numbers, 0 to 12. Four points sit on a clock line that wraps from 12 back to 0. Drag a point, or Tab to it and use the arrow keys.',
      words: lineWords(true), samples: lineSamples, onChange: opts.onChange,
    });
    kids.push(withPresets(game, presets));
  }
  if (parts.includes('partners')) kids.push(mountPartners(wrap, opts.pick ?? 3, opts.hours === 12 ? 12 : 13));
  if (parts.includes('trap')) kids.push(mountTrap(wrap, opts.trap ?? 128));
  const line = kids.find((c) => c.preset);
  return {
    destroy() { kids.forEach((c) => c.destroy()); clear(el); },
    reset() { kids.forEach((c) => c.reset && c.reset()); },
    preset(name) { return line ? line.preset(name) : false; },
    state() { return kids.map((c) => (c.state ? c.state() : null)); },
    presets: line ? line.presets : [],
  };
}

/* ----- partners: pick a number, walk round the clock in steps of it, see whether a step lands on 1 ----- */
function partnersWords(v, P) {
  if (v === 0) return '0 × anything is 0, so it never lands on 1: 0 has no partner, just as you cannot divide by 0 with ordinary numbers.';
  const w = clockPartner(v, P);
  if (w === null) {
    const g = gcd(v, P);
    const lands = []; for (let j = 0; j < P; j += g) lands.push(j);
    const z = P / g;
    return `Steps of ${v} land only on ${andList(lands.map(String))}, never on 1, so ${v} has no partner on a ${P}-hour clock and you cannot divide by ${v}. (${v} × ${z} = ${v * z} lands on 0.)`;
  }
  if (v === 1) return '1 × 1 = 1, so 1 is its own partner. Steps of 1 walk round the clock through every number.';
  const prod = v * w, turns = Math.floor(prod / P);
  const round = `${turns === 1 ? 'once' : turns === 2 ? 'twice' : `${turns} times`} round the clock (${turns * P} hours) and 1 more`;
  const own = v === w ? `${v} is its own partner` : `${w} is ${v}'s partner: multiplying by ${w} undoes multiplying by ${v}, which is how you divide on a clock`;
  return `${v} × ${w} = ${prod}: ${round}, so it lands on 1. ${own}.${P === 13 ? ` Steps of ${v} visit every number before coming back to 0.` : ''}`;
}

function mountPartners(parent, pick, hours0) {
  const listeners = [];
  const on = (t, ev, fn) => { t.addEventListener(ev, fn); listeners.push(() => t.removeEventListener(ev, fn)); };
  const part = h('div', { class: 'qw-part qw-part-partners' });
  part.append(h('p', { class: 'qw-kicker', text: 'Partners: numbers that multiply to 1' }));
  const sw = h('div', { class: 'qw-switch', role: 'group', 'aria-label': 'Hours on the clock' });
  const b13 = h('button', { type: 'button', class: 'qw-switch-btn', 'aria-pressed': 'true', text: '13 hours' });
  const b12 = h('button', { type: 'button', class: 'qw-switch-btn', 'aria-pressed': 'false', text: '12 hours' });
  sw.append(b13, b12);
  part.append(sw);
  const row = h('div', { class: 'qw-dial-row' });
  const svg = s('svg', { class: 'qw-dial', viewBox: '0 0 300 300', role: 'radiogroup', 'aria-label': 'Pick a number on the clock to see its partner' });
  const side = h('div', { class: 'qw-dial-side' });
  const big = h('p', { class: 'qw-big', 'aria-hidden': 'true' });
  const samples = [];
  for (const hrs of [12, 13]) for (let v = 0; v < hrs; v++) samples.push(partnersWords(v, hrs));
  const sayStack = stack(samples, 'qw-status', 'qw-say qw-say-plain');
  const pairsText = (hrs) => {
    const have = [], none = [];
    for (let v = 1; v < hrs; v++) { const w = clockPartner(v, hrs); if (w === null) none.push(String(v)); else if (v <= w) have.push(`${v}\u00a0×\u00a0${w}`); }
    return `Partners on this clock: ${have.join(', ')}.${none.length ? ` No partner: ${andList(none)}.` : ' Every number but 0 has one.'}`;
  };
  const pairsStack = stack([pairsText(12), pairsText(13)], 'qw-pairs');
  const pairs = pairsStack.el;
  side.append(big, sayStack.box, pairsStack.box);
  row.append(svg, side);
  part.append(row);

  // two lines through the same two points: one on 13 hours, two on 12 (SPEC 7, step 5b)
  const linesBox = h('div', { class: 'qw-twolines' });
  const lineTable = h('table', { class: 'qw-bytes qw-bytes-small' });
  const capText = {
    13: 'On a 13-hour clock only one line passes through the points (1,\u00a04) and (3,\u00a08): y\u00a0=\u00a02\u00a0+\u00a02x. Switch to 12 hours to see what goes wrong.',
    12: 'On a 12-hour clock two different lines pass through the same points (1,\u00a04) and (3,\u00a08): y\u00a0=\u00a02\u00a0+\u00a02x and y\u00a0=\u00a08\u00a0+\u00a08x. The check points can no longer pin down the message.',
  };
  const linesCap = stack([capText[13], capText[12]], 'qw-note-text');
  linesBox.append(h('div', { class: 'qw-bytes-wrap' }, lineTable), linesCap.box);
  part.append(linesBox);
  const live = h('p', { class: 'qw-live qw-sr', 'aria-live': 'polite' });
  part.append(live);
  parent.append(part);

  const cx = 150, cy = 150, R = 118;
  let P = hours0, cur = -1, btns = [], walk = null, hit1 = null, centre = null;
  const at = (v, r = R) => { const a = (-90 + (v * 360) / P) * (Math.PI / 180); return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; };

  function buildDial() {
    clear(svg);
    s('circle', { class: 'qw-dial-face', cx, cy, r: R + 24 }, svg);
    s('circle', { class: 'qw-dial-track', cx, cy, r: R }, svg);
    walk = s('path', { class: 'qw-walk' }, svg);
    hit1 = s('circle', { class: 'qw-land', r: 21.5 }, svg);
    centre = s('text', { class: 'qw-dial-centre', x: cx, y: cy + 8, 'text-anchor': 'middle' }, svg);
    btns = [];
    for (let v = 0; v < P; v++) {
      const [x, y] = at(v);
      const g = s('g', { class: 'qw-num', role: 'radio', tabindex: -1, 'aria-checked': 'false', 'aria-label': String(v), transform: `translate(${x} ${y})` }, svg);
      s('circle', { class: 'qw-hit', r: 23 }, g);
      s('circle', { class: 'qw-num-ring', r: 21.5 }, g);
      s('circle', { class: 'qw-num-dot', r: 16.5 }, g);
      s('text', { class: 'qw-num-text', y: 5.5, 'text-anchor': 'middle', text: v }, g);
      btns.push(g);
      g.addEventListener('click', () => { select(v, true); g.focus({ preventScroll: true }); });
      g.addEventListener('keydown', (e) => {
        const map = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
        let nv = null;
        if (e.key in map) nv = cur + map[e.key];
        else if (e.key === 'Home') nv = 0; else if (e.key === 'End') nv = P - 1;
        else if (e.key === ' ' || e.key === 'Enter') nv = v;
        if (nv === null) return;
        e.preventDefault();
        select(nv, true);
        btns[cur].focus({ preventScroll: true });
      });
    }
    pairs.textContent = pairsText(P);
    // the two-lines table
    clear(lineTable);
    const xsT = [0, 1, 2, 3, 4, 5];
    const mk = (label, vals, cls = '') => h('tr', { class: cls }, h('th', { scope: 'row', text: label }), ...vals.map((v, i) => h('td', { class: i === 1 || i === 3 ? 'is-shared' : '', text: String(v) })));
    lineTable.append(h('caption', { class: 'qw-sr', text: 'Values of the lines at x = 0 to 5' }));
    lineTable.append(mk('x', xsT, 'qw-row-x'));
    lineTable.append(mk('2 + 2x', xsT.map((x) => (2 + 2 * x) % P)));
    if (P === 12) lineTable.append(mk('8 + 8x', xsT.map((x) => (8 + 8 * x) % P)));
    else lineTable.append(mk('', xsT.map(() => ''), 'qw-row-ghost'));
    linesCap.el.textContent = capText[P];
    part.classList.toggle('is-12', P === 12);
  }

  function select(v, announceIt) {
    cur = ((v % P) + P) % P;
    const w = cur === 0 ? null : clockPartner(cur, P);
    btns.forEach((g, i) => {
      g.setAttribute('aria-checked', String(i === cur));
      g.setAttribute('tabindex', i === cur ? '0' : '-1');
      g.classList.toggle('is-on', i === cur);
      g.classList.toggle('is-partner', w !== null && i === w);
    });
    big.textContent = w === null ? `${cur} × ? = 1: none` : `${cur} × ${w} = 1`;
    centre.textContent = w === null ? 'none' : `× ${w}`;
    sayStack.el.textContent = partnersWords(cur, P);
    // the walk 0, v, 2v, ... back to 0: a star on a prime clock, a smaller polygon when steps miss numbers
    if (cur === 0) walk.setAttribute('d', '');
    else {
      let d = '', j = 0;
      do { const [x, y] = at((j * cur) % P, R - 26); d += `${j ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`; j++; } while ((j * cur) % P !== 0 && j <= P);
      const [x0, y0] = at(0, R - 26); d += `L${x0.toFixed(1)} ${y0.toFixed(1)}`;
      walk.setAttribute('d', d);
      const len = walk.getTotalLength ? walk.getTotalLength() : 0;
      walk.style.transition = 'none';
      if (len && !reduceMotion()) {
        walk.style.strokeDasharray = `${len}`;
        walk.style.strokeDashoffset = `${len}`;
        walk.getBoundingClientRect();
        walk.style.transition = 'stroke-dashoffset 1.1s ease-out';
        walk.style.strokeDashoffset = '0';
      } else { walk.style.strokeDasharray = ''; walk.style.strokeDashoffset = ''; }
    }
    const [x1, y1] = at(1);
    hit1.setAttribute('cx', x1); hit1.setAttribute('cy', y1);
    hit1.classList.toggle('is-missed', w === null);
    if (announceIt) live.textContent = sayStack.el.textContent;
  }

  function setHours(np, announceIt) {
    P = np;
    b13.setAttribute('aria-pressed', String(P === 13));
    b12.setAttribute('aria-pressed', String(P === 12));
    buildDial();
    select(P === hours0 ? pick : P === 13 ? 3 : 2, false);
    if (announceIt) live.textContent = `${P}-hour clock. ${sayStack.el.textContent}`;
  }
  on(b13, 'click', () => setHours(13, true));
  on(b12, 'click', () => setHours(12, true));
  setHours(hours0, false);
  return { destroy() { listeners.forEach((f) => f()); part.remove(); }, reset() { setHours(hours0, false); }, state: () => ({ hours: P, pick: cur }) };
}

/* ----- optional: the 256-hour trap (2 × anything is even, so it never lands on 1) ----- */
function mountTrap(parent, first) {
  const N = 256;
  const listeners = [];
  const on = (t, ev, fn) => { t.addEventListener(ev, fn); listeners.push(() => t.removeEventListener(ev, fn)); };
  const part = h('div', { class: 'qw-part qw-part-trap' });
  part.append(h('p', { class: 'qw-kicker', text: 'The trap: a 256-hour clock' }));
  const row = h('div', { class: 'qw-dial-row' });
  const svg = s('svg', { class: 'qw-dial qw-dial-256', viewBox: '0 0 300 300', role: 'img', 'aria-label': 'A 256-hour clock showing where 2 times the chosen number lands' });
  const side = h('div', { class: 'qw-dial-side' });
  const ctrl = h('div', { class: 'qw-trap-ctrl' });
  const id = uid('qw-m');
  const minus = h('button', { type: 'button', class: 'qw-btn qw-step', 'aria-label': 'One less', text: '−' });
  const input = h('input', { id, class: 'qw-num-input', type: 'number', inputmode: 'numeric', min: 0, max: 255, step: 1, value: first });
  const plus = h('button', { type: 'button', class: 'qw-btn qw-step', 'aria-label': 'One more', text: '+' });
  ctrl.append(h('label', { class: 'qw-trap-label', for: id, text: '2 ×' }), minus, input, plus);
  const all = h('button', { type: 'button', class: 'qw-btn', text: 'Try all 256' });
  const big = h('p', { class: 'qw-big', 'aria-hidden': 'true' });
  const wordsFor = (m) => {
    const prod = 2 * m, r = prod % N, turns = Math.floor(prod / N);
    if (m === 0) return '2 × 0 = 0. Pick another number: can you make 2 × it land on 1?';
    if (r === 0) return `2 × ${m} = ${prod}: exactly one full turn, so it lands on 0. Two numbers that are not 0 multiply to 0, so 2 can have no partner: on a 256-hour clock you cannot divide by 2.`;
    return `2 × ${m} = ${prod}${turns ? `, one full turn (256) and ${r} more` : ''}: it lands on ${r}, an even number again. However you choose, 2 × anything lands on an even hour, never on 1.`;
  };
  const allWords = 'All 256 tried: 2 × anything landed on one of the 128 even hours, never on 1. So 2 has no partner on this clock, and neither has any even number.';
  const sayStack = stack([wordsFor(128), wordsFor(255), allWords], 'qw-status', 'qw-say qw-say-plain');
  side.append(ctrl, big, sayStack.box, h('div', { class: 'qw-actions' }, all));
  row.append(svg, side);
  part.append(row);
  part.append(h('p', { class: 'qw-note', text: 'So QR does not count on a 256-hour clock. It builds its own number system with 256 values out of the 8 bits of a byte: adding is XOR (add each column of bits with no carrying, so 5 + 3 = 6 and any value plus itself is 0), multiplying follows a fixed rule from the standard, and every value except 0 has a partner (there, 2 × 142 = 1). It is not "mod 256".' }));
  const live = h('p', { class: 'qw-live qw-sr', 'aria-live': 'polite' });
  part.append(live);
  parent.append(part);

  const cx = 150, cy = 150, R = 122;
  const ang = (v) => (-90 + (v * 360) / N) * (Math.PI / 180);
  s('circle', { class: 'qw-dial-face', cx, cy, r: R + 20 }, svg);
  const ticks = [];
  for (let v = 0; v < N; v++) {
    const a = ang(v), r0 = v % 64 === 0 ? R - 14 : v % 2 === 0 ? R - 8 : R - 5;
    ticks.push(s('line', { class: `qw-tick${v % 2 ? ' is-odd' : ''}`, x1: cx + r0 * Math.cos(a), y1: cy + r0 * Math.sin(a), x2: cx + R * Math.cos(a), y2: cy + R * Math.sin(a) }, svg));
  }
  for (const v of [0, 64, 128, 192]) {
    const a = ang(v), r = R - 30;
    s('text', { class: 'qw-dial-label', x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) + 5, 'text-anchor': 'middle', text: v }, svg);
  }
  const one = ang(1);
  s('circle', { class: 'qw-one', cx: cx + (R + 9) * Math.cos(one), cy: cy + (R + 9) * Math.sin(one), r: 5 }, svg);
  s('text', { class: 'qw-one-label', x: cx + (R + 9) * Math.cos(one) + 9, y: cy + (R + 9) * Math.sin(one) + 4, text: '1' }, svg);
  const hand = s('line', { class: 'qw-hand', x1: cx, y1: cy, x2: cx, y2: cy - R + 18 }, svg);
  s('circle', { class: 'qw-hub', cx, cy, r: 5 }, svg);
  const landing = s('circle', { class: 'qw-landing', r: 7 }, svg);

  let m = first, angle = 0, anim = 0;
  function show(v, announceIt) {
    m = Math.max(0, Math.min(255, Math.round(Number.isFinite(v) ? v : 0)));
    input.value = String(m);
    const prod = 2 * m, r = prod % N;
    big.textContent = `2 × ${m} = ${prod} → ${r}`;
    sayStack.el.textContent = wordsFor(m);
    part.classList.remove('is-all');
    ticks.forEach((t) => t.classList.remove('is-hit'));
    ticks[r].classList.add('is-hit');
    const a = ang(r), rr = R + 1;
    landing.setAttribute('cx', cx + rr * Math.cos(a)); landing.setAttribute('cy', cy + rr * Math.sin(a));
    landing.classList.toggle('is-zero', r === 0);
    spin((prod * 360) / N);
    if (announceIt) live.textContent = sayStack.el.textContent;
  }
  function spin(target) {
    cancelAnimationFrame(anim);
    if (reduceMotion()) { angle = target; hand.setAttribute('transform', `rotate(${angle % 360} ${cx} ${cy})`); return; }
    const from = angle % 360, to = target, t0 = performance.now(), dur = 700 + Math.min(900, Math.abs(to - from));
    const stepf = (t) => {
      const u = Math.min(1, (t - t0) / dur), e = 1 - (1 - u) ** 3;
      angle = from + (to - from) * e;
      hand.setAttribute('transform', `rotate(${angle % 360} ${cx} ${cy})`);
      if (u < 1) anim = requestAnimationFrame(stepf);
    };
    anim = requestAnimationFrame(stepf);
  }
  on(minus, 'click', () => show(m - 1, true));
  on(plus, 'click', () => show(m + 1, true));
  on(input, 'change', () => show(parseInt(input.value, 10), true));
  on(input, 'keydown', (e) => { if (e.key === 'Enter') show(parseInt(input.value, 10), true); });
  on(all, 'click', () => {
    cancelAnimationFrame(anim);
    part.classList.add('is-all');
    ticks.forEach((t, v) => t.classList.toggle('is-hit', v % 2 === 0));
    big.textContent = '2 × (0 to 255) → only even hours';
    sayStack.el.textContent = allWords;
    live.textContent = allWords;
  });
  show(first, false);
  return { destroy() { cancelAnimationFrame(anim); listeners.forEach((f) => f()); part.remove(); }, reset() { show(first, false); }, state: () => ({ m }) };
}
