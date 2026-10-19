/*
 * render.js: the hero code's renderer for "Scratch a QR Code" (cameo 3, VISUAL agent; SPEC 5.6, IC-5, IC-6).
 *
 *   draw(canvas, sym, view, opts) paints the code card at the device pixel ratio: the white card with its full
 *   4-module quiet zone, the print, Scratch strokes (ink worn off a sticker: torn, grooved edges over a faint grey
 *   residue that still shows the ghost of the removed squares), Marker strokes (matte felt-tip ink that colours in
 *   whole squares), the Show bytes view, the broken / fixed / beyond-repair marks, the repair flash and the brush ring.
 *
 * THE CAMERA RULE (SPEC 5.4, binding): in the central 60% x 60% of every module, every rendered pixel has relative
 * luminance <= 0.25 for a dark module and >= 0.75 for a light one, with any overlay, flash, texture, cursor or
 * animation frame; texture and torn edges use only each module's outer 20% band, never the quiet zone.
 * How draw() keeps it, whatever the strokes look like:
 *   1. view.modules (strokes.js, LEAD) is the only truth. render.js never decides a module's state.
 *   2. Strokes are painted freely, clipped to the symbol (never the quiet zone). Every module a Scratch covers gets a
 *      disc of residue over its whole central square; Marker paints whole squares.
 *   3. VERIFY: the pixels are read back and every pixel of every central square near a stroke is tested against the
 *      rule (with a safety margin: <= 0.22 / >= 0.78). A failing module is repainted as a whole, flat cell in its
 *      state's colour (a square of print the scratch did not take, or a square it did).
 *   3b. ORACLE's stricter rule (23:15, binding for robustness against local binarizers): every pixel of a light
 *      module inside [0.1, 0.9] of its cell has luma >= 232 (within 24 of the paper: a scraped square is near-paper,
 *      never grey), every pixel of a dark module inside [0.1, 0.9] has luma <= 100, and whole-cell means stay on the
 *      right side (light >= 210, dark <= 90). Torn dark remnants live only in the outer band of a cell. The verify
 *      pass tests exactly this and repaints a failing cell whole.
 *   4. Overlays drawn afterwards keep the rule by construction: outlines run on module edges (<= 15% of a module
 *      wide), washes and hatches over light cells stay at luminance >= 0.78, dark cells stay dark, and the brush ring
 *      changes its ink inside central squares to the module's own class.
 *   checkCameraRule() tests the finished canvas pixel by pixel; the harness asserts zero violations in every state.
 *
 * Plain ES module: no globals, no DOM access beyond the canvas it is given; deterministic (each stroke's texture comes
 * from a seed hashed from its first point).
 */

// ------------------------------------------------------------------------------------------------
// Colours. The card is white in both themes (SPEC 5.2); nothing here changes with the page theme.
// ------------------------------------------------------------------------------------------------
export const PAINT = Object.freeze({
  paper: '#ffffff',
  ink: '#111111', // printed modules (SPEC 5.2), relative luminance 0.006
  residue: '#f6f5f2', // scraped paper (L 0.91)
  ghost: '#ebeae6', // the ghost of a scraped-off square (L 0.82)
  grainLight: '#fdfdfb',
  grainMid: '#eeede9', // luma 237: the darkest groove (every scraped pixel stays within 24 luma of the paper)
  fibre: '#fbfaf8',
  marker: '#33281f', // matte felt-tip, a warm brown-black, visibly not print (L 0.022)
  markerEdge: '#20180f', // ink pooled at the edge of a coloured-in patch
  markerStreak: '#55473b', // felt-tip streaks (L 0.064)
  // marks (SPEC 5.2, Okabe-Ito): broken vermillion dashed, fixed green solid, beyond repair vermillion + hatch
  broken: '#d55e00',
  fixed: '#009e73',
  failed: '#d55e00',
  warn: '#b45a00',
});

// Show bytes: block colour (outline and meter), a pale tint for its light modules (luma >= 236, so a binarizer still
// sees paper), a pattern in the outer 10% band of each light module (a second, colour-free cue), plus solid outlines
// for message bytes and dashed for check bytes (SPEC 4.4).
// Block 3 is sky blue rather than the SPEC's green: green already means "fixed" (see DESIGN.md).
export const BLOCK_STYLE = Object.freeze([
  { name: 'Block 1', line: '#0072b2', tint: '#e6f0fa', pattern: 'stripes', ui: { light: '#0072b2', dark: '#56a7e0' } },
  { name: 'Block 2', line: '#c77c00', tint: '#fcedd8', pattern: 'dots', ui: { light: '#b86e00', dark: '#e6a532' } },
  { name: 'Block 3', line: '#3a9bd5', tint: '#e4f3fb', pattern: 'cross', ui: { light: '#2f87bd', dark: '#7cc6f0' } },
  { name: 'Block 4', line: '#b4568e', tint: '#f9ebf3', pattern: 'lines', ui: { light: '#a3497e', dark: '#d991bb' } },
]);

export const CAMERA_RULE = Object.freeze({
  centre: 0.6, darkMax: 0.25, lightMin: 0.75, margin: 0.03, band: 0.2, // SPEC 5.4 (relative luminance)
  inner: 0.1, innerLightLuma: 232, innerDarkLuma: 100, cellLightMean: 210, cellDarkMean: 90, // ORACLE 23:15 (luma)
});

export const MARK = Object.freeze({ none: 0, broken: 1, fixed: 2, failed: 3, erased: 4, damaged: 1, erasedFixed: 4 });

// sRGB -> linear, and relative luminance (WCAG)
const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
export function relLum(r, g, b) {
  return 0.2126 * LIN[r] + 0.7152 * LIN[g] + 0.0722 * LIN[b];
}

// A cell's central square in device px, snapped OUTWARD to whole pixels so nothing anti-aliased drawn around it can
// leak into the 60% the camera rule protects. Returns [x, y, w, h].
function central(px, py, m) {
  const a = Math.floor(0.2 * m);
  const b = Math.ceil(0.8 * m);
  return [px + a, py + a, b - a, b - a];
}
// The inner 80% of a cell (outer 10% band excluded), snapped outward to whole pixels.
function inner(px, py, m) {
  const a = Math.floor(0.1 * m);
  const b = Math.ceil(0.9 * m);
  return [px + a, py + a, b - a, b - a];
}
// The cover of a scraped module: [0.07, 0.93] of the cell, snapped outward (it holds the whole inner 80%).
function cover(px, py, m) {
  const a = Math.floor(0.07 * m);
  const b = Math.ceil(0.93 * m);
  return [px + a, py + a, b - a, b - a];
}

// ------------------------------------------------------------------------------------------------
// Deterministic randomness
// ------------------------------------------------------------------------------------------------
function hash32(a, b = 0, c = 0) {
  let h = (a | 0) ^ Math.imul(b | 0, 0x9e3779b1) ^ Math.imul(c | 0, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}
const rand01 = (a, b, c) => hash32(a, b, c) / 4294967296;
const randPM = (a, b, c) => rand01(a, b, c) * 2 - 1;
function valueNoise(seed, x) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return randPM(seed, i, 7) * (1 - u) + randPM(seed, i + 1, 7) * u;
}

// ------------------------------------------------------------------------------------------------
// Geometry
// ------------------------------------------------------------------------------------------------
/**
 * Where everything sits, in DEVICE pixels: m = device px per module (a whole number: module edges on whole device
 * pixels), the card is m * (size + 2 * quiet) square, the symbol's top-left module starts at (originX, originY).
 * opts: {modulePx: CSS px per module (SPEC: an integer 8 to 12), dpr, quiet = 4}.
 */
export function geometry(sym, opts = {}) {
  const dpr = opts.dpr ?? (globalThis.devicePixelRatio || 1);
  const quiet = opts.quiet ?? 4;
  const css = opts.modulePx ?? 10;
  const m = Math.max(1, Math.round(css * dpr));
  const span = sym.size + 2 * quiet;
  return { m, dpr, quiet, span, size: sym.size, W: m * span, cssModule: m / dpr, cssW: (m * span) / dpr, originX: quiet * m, originY: quiet * m, modulePx: m };
}

/** Module (x, y) as a rectangle in CSS px from the canvas's top-left (hit tests, ORACLE's sampler). */
export function moduleRect(sym, x, y, opts = {}) {
  const g = geometry(sym, opts);
  return { x: (g.quiet + x) * g.cssModule, y: (g.quiet + y) * g.cssModule, w: g.cssModule, h: g.cssModule };
}

/** A pointer position (client px) as normalized symbol coordinates {u, v} (0..1 across the symbol's modules). */
export function clientToNorm(canvas, sym, clientX, clientY, opts = {}) {
  const g = geometry(sym, opts);
  const r = canvas.getBoundingClientRect();
  const cx = ((clientX - r.left) * g.cssW) / (r.width || g.cssW);
  const cy = ((clientY - r.top) * g.cssW) / (r.height || g.cssW);
  return { u: (cx / g.cssModule - g.quiet) / sym.size, v: (cy / g.cssModule - g.quiet) / sym.size };
}

// ------------------------------------------------------------------------------------------------
// Per-symbol data (cached): codeword cells, outline edges, block and data/check of each codeword
// ------------------------------------------------------------------------------------------------
const SYM_CACHE = new WeakMap();
function prep(sym, opts) {
  let P = SYM_CACHE.get(sym);
  if (P) return P;
  const n = sym.size;
  const ncw = sym.stream.length;
  const cells = Array.from({ length: ncw }, () => []);
  for (let i = 0; i < n * n; i++) if (sym.cw[i] >= 0) cells[sym.cw[i]].push(i);
  const block = new Int8Array(ncw);
  const isCheck = new Uint8Array(ncw);
  sym.blocks.forEach((b, bi) => {
    const at = b.at;
    for (let j = 0; j < at.length; j++) {
      block[at[j]] = bi;
      isCheck[at[j]] = j >= b.dataCount ? 1 : 0;
    }
  });
  if (opts && opts.blockOf) block.set(opts.blockOf);
  const edges = cells.map((list) => boundaryEdges(list, n));
  P = { cells, edges, block, isCheck, prints: new Map() };
  SYM_CACHE.set(sym, P);
  return P;
}

// The edges of a codeword's modules that border a module of another codeword or a function module (SPEC 5.3), as
// [x0, y0, x1, y1, ...] in module units, merged into maximal straight runs.
function boundaryEdges(list, n) {
  const set = new Set(list);
  const h = new Map(); // y -> x of unit horizontal edges
  const v = new Map(); // x -> y of unit vertical edges
  const push = (map, k, a) => {
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(a);
  };
  for (const i of list) {
    const x = i % n;
    const y = (i / n) | 0;
    if (y === 0 || !set.has(i - n)) push(h, y, x);
    if (y === n - 1 || !set.has(i + n)) push(h, y + 1, x);
    if (x === 0 || !set.has(i - 1)) push(v, x, y);
    if (x === n - 1 || !set.has(i + 1)) push(v, x + 1, y);
  }
  const out = [];
  for (const [y, xs] of h) {
    xs.sort((a, b) => a - b);
    let s = xs[0];
    for (let k = 1; k <= xs.length; k++) {
      if (k === xs.length || xs[k] !== xs[k - 1] + 1) {
        out.push(s, y, xs[k - 1] + 1, y);
        s = xs[k];
      }
    }
  }
  for (const [x, ys] of v) {
    ys.sort((a, b) => a - b);
    let s = ys[0];
    for (let k = 1; k <= ys.length; k++) {
      if (k === ys.length || ys[k] !== ys[k - 1] + 1) {
        out.push(x, s, x, ys[k - 1] + 1);
        s = ys[k];
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// The print layer (cached per symbol, device module size and Show bytes)
// ------------------------------------------------------------------------------------------------
function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function lightCellColor(sym, P, i, showBytes) {
  if (!showBytes || sym.cw[i] < 0) return PAINT.paper;
  return BLOCK_STYLE[P.block[sym.cw[i]] % 4].tint;
}

function printLayer(sym, P, g, showBytes) {
  const key = g.m + ':' + (showBytes ? 1 : 0);
  let c = P.prints.get(key);
  if (c) return c;
  const m = g.m;
  const n = sym.size;
  c = makeCanvas(g.W, g.W);
  const x = c.getContext('2d');
  x.fillStyle = PAINT.paper;
  x.fillRect(0, 0, g.W, g.W);
  for (let yy = 0; yy < n; yy++) {
    for (let xx = 0; xx < n; xx++) {
      const i = yy * n + xx;
      const px = g.originX + xx * m;
      const py = g.originY + yy * m;
      if (sym.modules[i] === 1) {
        x.fillStyle = PAINT.ink;
        x.fillRect(px, py, m, m);
      } else if (showBytes && sym.cw[i] >= 0) {
        const B = BLOCK_STYLE[P.block[sym.cw[i]] % 4];
        x.fillStyle = B.tint;
        x.fillRect(px, py, m, m);
        cellPattern(x, B, px, py, m);
      }
    }
  }
  P.prints.set(key, c);
  return c;
}

// A block's pattern on one light cell, drawn only in the cell's outer 10% band (the inner 80% keeps its pale tint):
// stripes, dots, cross-hatch or lines. A colour-free second cue for the block (SPEC 5.2).
function cellPattern(x, B, px, py, m) {
  x.save();
  const band = new Path2D();
  band.rect(px, py, m, m);
  band.rect(...inner(px, py, m));
  x.clip(band, 'evenodd');
  x.strokeStyle = B.line;
  x.fillStyle = B.line;
  x.globalAlpha = 0.55;
  const w = Math.max(1, m * 0.07);
  x.lineWidth = w;
  x.beginPath();
  if (B.pattern === 'stripes' || B.pattern === 'cross') {
    for (let k = -2; k <= 2; k++) {
      x.moveTo(px + (k * m) / 2, py + m);
      x.lineTo(px + (k * m) / 2 + m, py);
      if (B.pattern === 'cross') {
        x.moveTo(px + (k * m) / 2, py);
        x.lineTo(px + (k * m) / 2 + m, py + m);
      }
    }
    x.stroke();
  } else if (B.pattern === 'lines') {
    for (const f of [0.05, 0.95]) {
      x.moveTo(px, py + f * m);
      x.lineTo(px + m, py + f * m);
    }
    x.stroke();
  } else if (B.pattern === 'dots') {
    const rr = m * 0.075;
    for (const [u, v] of [[0.05, 0.05], [0.95, 0.05], [0.05, 0.95], [0.95, 0.95], [0.5, 0.05], [0.5, 0.95], [0.05, 0.5], [0.95, 0.5]]) {
      x.moveTo(px + u * m + rr, py + v * m);
      x.arc(px + u * m, py + v * m, rr, 0, Math.PI * 2);
    }
    x.globalAlpha = 0.8;
    x.fill();
  }
  x.restore();
}

// ------------------------------------------------------------------------------------------------
// Strokes: normalized (strokes.js) -> module units, the look's geometry, and each stroke's own footprint
// ------------------------------------------------------------------------------------------------
const CONV = new WeakMap();
function conv(stroke, n) {
  const len = stroke.pts.length;
  let c = CONV.get(stroke);
  if (c && c.len === len && c.n === n && c.r0 === stroke.r) return c;
  const pts = new Float64Array(len);
  for (let i = 0; i < len; i++) pts[i] = stroke.pts[i] * n;
  const seed = stroke.seed ?? hash32(Math.round((stroke.pts[0] || 0) * 1e6), Math.round((stroke.pts[1] || 0) * 1e6), stroke.tool === 'marker' ? 2 : 1);
  c = { len, n, r0: stroke.r, s: { tool: stroke.tool, r: stroke.r * n, pts, seed } };
  CONV.set(stroke, c);
  return c;
}

function dist2ToPolyline(p, px, py) {
  const k = p.length >> 1;
  if (k === 0) return Infinity;
  if (k === 1) return (px - p[0]) ** 2 + (py - p[1]) ** 2;
  let best = Infinity;
  for (let i = 0; i < k - 1; i++) {
    const ax = p[2 * i];
    const ay = p[2 * i + 1];
    const vx = p[2 * i + 2] - ax;
    const vy = p[2 * i + 3] - ay;
    const wx = px - ax;
    const wy = py - ay;
    const vv = vx * vx + vy * vy;
    let t = vv > 0 ? (wx * vx + wy * vy) / vv : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = wx - t * vx;
    const dy = wy - t * vy;
    const d = dx * dx + dy * dy;
    if (d < best) best = d;
  }
  return best;
}

function boxOf(s, pad) {
  const p = s.pts;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    x0 = Math.min(x0, p[i]);
    x1 = Math.max(x1, p[i]);
    y0 = Math.min(y0, p[i + 1]);
    y1 = Math.max(y1, p[i + 1]);
  }
  return { x0: x0 - s.r - pad, y0: y0 - s.r - pad, x1: x1 + s.r + pad, y1: y1 + s.r + pad };
}

// the module centres this stroke covers (the rule of strokes.js; used for the look only, never for state)
function footprint(c, n) {
  if (c.fp && c.fpLen === c.len) return c.fp;
  const s = c.s;
  const out = [];
  if (s.pts.length) {
    const b = boxOf(s, 0);
    const r2 = s.r * s.r;
    for (let y = Math.max(0, Math.floor(b.y0 - 0.5)); y <= Math.min(n - 1, Math.ceil(b.y1 - 0.5)); y++) {
      for (let x = Math.max(0, Math.floor(b.x0 - 0.5)); x <= Math.min(n - 1, Math.ceil(b.x1 - 0.5)); x++) {
        if (dist2ToPolyline(s.pts, x + 0.5, y + 0.5) <= r2) out.push(y * n + x);
      }
    }
  }
  c.fp = out;
  c.fpLen = c.len;
  return out;
}

// resampled path with smoothed normals, extended past both ends for the frayed tails
function look(c) {
  if (c.look && c.lookLen === c.len) return c.look;
  const s = c.s;
  const p = s.pts;
  const k = p.length >> 1;
  const path = [];
  let arc = 0;
  for (let i = 0; i < k; i++) {
    const x = p[2 * i];
    const y = p[2 * i + 1];
    if (i === 0) {
      path.push([x, y, 0, 0, 0]);
      continue;
    }
    const px = p[2 * i - 2];
    const py = p[2 * i - 1];
    const len = Math.hypot(x - px, y - py);
    if (len < 1e-9) continue;
    const steps = Math.max(1, Math.ceil(len / 0.12));
    for (let j = 1; j <= steps; j++) {
      arc += len / steps;
      path.push([px + ((x - px) * j) / steps, py + ((y - py) * j) / steps, arc, 0, 0]);
    }
  }
  for (let i = 0; i < path.length; i++) {
    const a = path[Math.max(0, i - 3)];
    const b = path[Math.min(path.length - 1, i + 3)];
    let tx = b[0] - a[0];
    let ty = b[1] - a[1];
    const l = Math.hypot(tx, ty);
    if (l < 1e-9) {
      tx = 1;
      ty = 0;
    } else {
      tx /= l;
      ty /= l;
    }
    path[i][3] = -ty;
    path[i][4] = tx;
  }
  const E = s.r * 1.2;
  const ext = path.slice();
  if (path.length > 1) {
    const f = path[0];
    const l = path[path.length - 1];
    const steps = Math.ceil(E / 0.12);
    for (let j = 1; j <= steps; j++) {
      const d = (E * j) / steps;
      ext.unshift([f[0] - f[4] * d, f[1] + f[3] * d, -d, f[3], f[4]]);
      ext.push([l[0] + l[4] * d, l[1] - l[3] * d, arc + d, l[3], l[4]]);
    }
  }
  c.look = { path, ext, arc };
  c.lookLen = c.len;
  return c.look;
}

function strip(P2, L, off, w, a0, a1, seed, T) {
  const left = [];
  const right = [];
  for (const pt of L.ext) {
    if (pt[2] < a0 || pt[2] > a1) continue;
    const c = off + 0.045 * valueNoise(seed, pt[2] / 0.9);
    const lo = c - w / 2 + 0.025 * valueNoise(seed + 1, pt[2] / 0.22);
    const hi = c + w / 2 + 0.025 * valueNoise(seed + 2, pt[2] / 0.22);
    left.push(T.x(pt[0] + pt[3] * lo), T.y(pt[1] + pt[4] * lo));
    right.push(T.x(pt[0] + pt[3] * hi), T.y(pt[1] + pt[4] * hi));
  }
  if (left.length < 4) return;
  P2.moveTo(left[0], left[1]);
  for (let i = 2; i < left.length; i += 2) P2.lineTo(left[i], left[i + 1]);
  for (let i = right.length - 2; i >= 0; i -= 2) P2.lineTo(right[i], right[i + 1]);
  P2.closePath();
}

function along(ctx, L, off, a0, a1, T, seed) {
  let started = false;
  for (const pt of L.ext) {
    if (pt[2] < a0 || pt[2] > a1) continue;
    const o = off + 0.035 * valueNoise(seed, pt[2] / 0.8);
    const x = T.x(pt[0] + pt[3] * o);
    const y = T.y(pt[1] + pt[4] * o);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else ctx.lineTo(x, y);
  }
}

// ------------------------------------------------------------------------------------------------
// Painting a Scratch: torn strips + a near-paper square over every covered module + ghosts + light grooves + fibres
// ------------------------------------------------------------------------------------------------
function paintScratch(ctx, sym, c, g, T) {
  const s = c.s;
  const L = look(c);
  if (!L.path.length) return;
  const n = sym.size;
  const m = g.m;
  const r = s.r;
  const seed = s.seed;
  const A = L.arc;
  const body = new Path2D();
  if (A < 0.05) {
    const N = 20;
    const p0 = L.path[0];
    for (let j = 0; j < N; j++) {
      const a = (j / N) * Math.PI * 2;
      const rr = r * (0.96 + 0.07 * randPM(seed, 5, j));
      if (j === 0) body.moveTo(T.x(p0[0] + Math.cos(a) * rr), T.y(p0[1] + Math.sin(a) * rr));
      else body.lineTo(T.x(p0[0] + Math.cos(a) * rr), T.y(p0[1] + Math.sin(a) * rr));
    }
    body.closePath();
  } else {
    const nCore = Math.max(4, Math.ceil((1.7 * r) / 0.17));
    for (let j = 0; j < nCore; j++) {
      const off = -0.85 * r + (1.7 * r * j) / (nCore - 1) + 0.03 * randPM(seed, 100 + j, 1);
      const w = 0.26 + 0.1 * rand01(seed, 100 + j, 2);
      const cap = r * Math.sqrt(Math.max(0, 1 - (off / r) ** 2));
      strip(body, L, off, w, -cap * (0.86 + 0.24 * rand01(seed, 100 + j, 3)), A + cap * (0.86 + 0.24 * rand01(seed, 100 + j, 4)), seed + j * 17, T);
    }
    for (let side = -1; side <= 1; side += 2) {
      const nf = 2 + Math.round(A * 0.35);
      for (let j = 0; j < nf; j++) {
        const off = side * r * (0.9 + 0.13 * rand01(seed, 400 + j, side + 3));
        const w = 0.07 + 0.11 * rand01(seed, 400 + j, side + 4);
        const cc = A * rand01(seed, 400 + j, side + 5);
        const half = 0.3 + 1.6 * rand01(seed, 400 + j, side + 6);
        strip(body, L, off, w, Math.max(-0.3, cc - half), Math.min(A + 0.3, cc + half), seed + 999 + j * 7 + side, T);
      }
    }
  }
  // every module this stroke covers: a near-paper square over [0.07, 0.93] of its cell (ORACLE: a scraped module is
  // within 24 luma of the paper everywhere but its outer band, where a torn sliver of ink may stay)
  for (const i of footprint(c, n)) body.rect(...cover(T.x(i % n), T.y((i / n) | 0), m));
  ctx.fillStyle = PAINT.residue;
  ctx.fill(body, 'nonzero');
  ctx.save();
  ctx.clip(body, 'nonzero');
  const b = boxOf(s, 0.6);
  ctx.fillStyle = PAINT.ghost;
  for (let y = Math.max(0, Math.floor(b.y0)); y <= Math.min(n - 1, Math.ceil(b.y1)); y++) {
    for (let x = Math.max(0, Math.floor(b.x0)); x <= Math.min(n - 1, Math.ceil(b.x1)); x++) {
      if (sym.modules[y * n + x] === 1) ctx.fillRect(T.x(x), T.y(y), m, m);
    }
  }
  if (A >= 0.05) {
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';
    const G = Math.max(8, Math.round(r * 20));
    for (let j = 0; j < G; j++) {
      const off = r * 1.02 * randPM(seed, 300 + j, 1);
      const tone = rand01(seed, 300 + j, 2);
      ctx.strokeStyle = tone < 0.3 ? '#ffffff' : tone < 0.5 ? PAINT.grainLight : PAINT.grainMid;
      ctx.globalAlpha = 0.95;
      ctx.lineWidth = Math.max(0.6, m * (0.025 + 0.09 * Math.pow(rand01(seed, 300 + j, 3), 2.2)));
      const pieces = 1 + Math.floor(rand01(seed, 300 + j, 4) * 2.4);
      for (let q = 0; q < pieces; q++) {
        const a0 = -r + ((A + 2 * r) * (q + 0.35 * rand01(seed, 300 + j, 10 + q))) / pieces;
        const a1 = -r + ((A + 2 * r) * (q + 1 - 0.35 * rand01(seed, 300 + j, 20 + q))) / pieces;
        if (a1 - a0 < 0.15) continue;
        ctx.beginPath();
        along(ctx, L, off, a0, a1, T, seed + j * 31);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();
  if (A < 0.05) return;
  // torn paper fibres at the edge, pointing out into the ink
  const path = L.path;
  const perSide = Math.max(1, Math.round(A * 0.9));
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = PAINT.fibre;
  for (let side = -1; side <= 1; side += 2) {
    for (let j = 0; j < perSide; j++) {
      const pt = path[Math.min(path.length - 1, Math.floor(rand01(seed, 2000 + j, side + 5) * path.length))];
      const er = r * (0.97 + 0.05 * randPM(seed, 2000 + j, 9));
      const nx = pt[3] * side;
      const ny = pt[4] * side;
      const da = 0.9 * randPM(seed, 2000 + j, 10);
      const dx = nx * Math.cos(da) - ny * Math.sin(da);
      const dy = nx * Math.sin(da) + ny * Math.cos(da);
      const len = 0.1 + 0.2 * Math.pow(rand01(seed, 2000 + j, 11), 1.5);
      const sx = pt[0] + nx * er;
      const sy = pt[1] + ny * er;
      const bend = 0.07 * randPM(seed, 2000 + j, 13);
      ctx.lineWidth = Math.max(0.6, m * (0.03 + 0.025 * rand01(seed, 2000 + j, 12)));
      ctx.beginPath();
      ctx.moveTo(T.x(sx - dx * 0.06), T.y(sy - dy * 0.06));
      ctx.quadraticCurveTo(T.x(sx + dx * len * 0.5 + pt[4] * bend), T.y(sy + dy * len * 0.5 - pt[3] * bend), T.x(sx + dx * len), T.y(sy + dy * len));
      ctx.stroke();
    }
  }
  ctx.restore();
}

// ------------------------------------------------------------------------------------------------
// Painting a Marker stroke: it colours in whole squares (SPEC 4.4), with a felt-tip edge and streaks
// ------------------------------------------------------------------------------------------------
function paintMarker(ctx, sym, c, g, T) {
  const s = c.s;
  const n = sym.size;
  const m = g.m;
  const fp = footprint(c, n);
  if (!fp.length) return;
  const cells = new Path2D();
  for (const i of fp) cells.rect(T.x(i % n), T.y((i / n) | 0), m, m);
  // the edge: the union's outline thickened a little (round caps) so the patch reads as ink, not pixels; the bleed
  // stays inside the neighbours' outer band (0.07 of a module)
  const outline = new Path2D();
  const set = new Set(fp);
  for (const i of fp) {
    const x = i % n;
    const y = (i / n) | 0;
    if (y === 0 || !set.has(i - n)) {
      outline.moveTo(T.x(x), T.y(y));
      outline.lineTo(T.x(x + 1), T.y(y));
    }
    if (y === n - 1 || !set.has(i + n)) {
      outline.moveTo(T.x(x), T.y(y + 1));
      outline.lineTo(T.x(x + 1), T.y(y + 1));
    }
    if (x === 0 || !set.has(i - 1)) {
      outline.moveTo(T.x(x), T.y(y));
      outline.lineTo(T.x(x), T.y(y + 1));
    }
    if (x === n - 1 || !set.has(i + 1)) {
      outline.moveTo(T.x(x + 1), T.y(y));
      outline.lineTo(T.x(x + 1), T.y(y + 1));
    }
  }
  ctx.save();
  ctx.fillStyle = PAINT.marker;
  ctx.fill(cells);
  ctx.strokeStyle = PAINT.markerEdge;
  ctx.lineWidth = Math.max(1, m * 0.14);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(outline);
  // felt-tip streaks along the gesture, inside the coloured squares only
  ctx.clip(cells);
  const L = look(c);
  if (L.arc > 0.2) {
    const G = Math.max(4, Math.round(s.r * 9));
    for (let j = 0; j < G; j++) {
      ctx.beginPath();
      along(ctx, L, s.r * 1.1 * randPM(s.seed, 60 + j, 1), -s.r, L.arc + s.r, T, s.seed + j);
      ctx.strokeStyle = PAINT.markerStreak;
      ctx.globalAlpha = 0.35 + 0.4 * rand01(s.seed, 60 + j, 2);
      ctx.lineWidth = Math.max(0.6, m * (0.04 + 0.08 * rand01(s.seed, 60 + j, 3)));
      ctx.stroke();
    }
  }
  ctx.restore();
}

// ------------------------------------------------------------------------------------------------
// VERIFY: every pixel of every central square near a stroke against the camera rule; repaint failing cells whole
// ------------------------------------------------------------------------------------------------
function verify(ctx, sym, P, view, convs, g, box, showBytes) {
  const n = sym.size;
  const m = g.m;
  const xa = Math.max(0, box.x0);
  const xb = Math.min(n - 1, box.x1);
  const ya = Math.max(0, box.y0);
  const yb = Math.min(n - 1, box.y1);
  if (xa > xb || ya > yb) return 0;
  const w = (xb - xa + 1) * m;
  const h = (yb - ya + 1) * m;
  const img = ctx.getImageData(g.originX + xa * m, g.originY + ya * m, w, h).data;
  const R = CAMERA_RULE;
  // pixel ranges inside a cell: the central 60% (SPEC 5.4, relative luminance) and the inner 80% (ORACLE, luma)
  const c0 = Math.max(0, Math.ceil(0.18 * m - 0.5));
  const c1 = Math.min(m - 1, Math.floor(0.82 * m - 0.5));
  const i0 = Math.max(0, Math.ceil(R.inner * m - 0.5));
  const i1 = Math.min(m - 1, Math.floor((1 - R.inner) * m - 0.5));
  const darkMax = R.darkMax - R.margin;
  const lightMin = R.lightMin + R.margin;
  // which tool last covered each module (for the repaint colour), from the look's footprints
  const lastTool = new Int8Array(n * n); // 0 none, 1 scratch, 2 marker
  convs.forEach((c) => {
    const t = c.s.tool === 'marker' ? 2 : 1;
    for (const i of footprint(c, n)) lastTool[i] = t;
  });
  let fixed = 0;
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      const i = y * n + x;
      const dark = view.modules[i] === 1;
      let bad = false;
      let sum = 0;
      for (let py = 0; py < m && !bad; py++) {
        let j = (((y - ya) * m + py) * w + (x - xa) * m) * 4;
        const rowInner = py >= i0 && py <= i1;
        const rowCentral = py >= c0 && py <= c1;
        for (let px = 0; px < m; px++, j += 4) {
          const r = img[j];
          const gg = img[j + 1];
          const b = img[j + 2];
          const luma = 0.299 * r + 0.587 * gg + 0.114 * b;
          sum += luma;
          if (rowInner && px >= i0 && px <= i1) {
            if (dark ? luma > R.innerDarkLuma : luma < R.innerLightLuma) {
              bad = true;
              break;
            }
            if (rowCentral && px >= c0 && px <= c1) {
              const l = 0.2126 * LIN[r] + 0.7152 * LIN[gg] + 0.0722 * LIN[b];
              if (dark ? l > darkMax : l < lightMin) {
                bad = true;
                break;
              }
            }
          }
        }
      }
      if (!bad) {
        const mean = sum / (m * m);
        bad = dark ? mean > R.cellDarkMean : mean < R.cellLightMean;
      }
      if (!bad) continue;
      fixed++;
      let col;
      if (dark) col = lastTool[i] === 2 ? PAINT.marker : PAINT.ink;
      else if (lastTool[i] === 1) col = sym.modules[i] === 1 ? PAINT.ghost : PAINT.residue;
      else col = lightCellColor(sym, P, i, showBytes);
      ctx.fillStyle = col;
      ctx.fillRect(g.originX + x * m, g.originY + y * m, m, m);
    }
  }
  return fixed;
}

/**
 * The camera rule on a finished canvas: every pixel of every module's central 60% x 60% (pixel centres inside
 * [0.2, 0.8] of the cell) against relative luminance <= 0.25 (dark) / >= 0.75 (light); and the quiet zone pure white.
 * Returns {ok, bad: [{x, y, dark, worst}], quietBad: pixel count}.
 */
export function checkCameraRule(canvas, sym, modules, opts = {}) {
  const g = geometry(sym, opts);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, g.W, g.W).data;
  const n = sym.size;
  const m = g.m;
  const lo = Math.max(0, Math.ceil(0.2 * m - 0.5));
  const hi = Math.min(m - 1, Math.floor(0.8 * m - 0.5));
  const bad = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dark = modules[y * n + x] === 1;
      let worst = dark ? 0 : 1;
      for (let py = lo; py <= hi; py++) {
        let j = ((g.originY + y * m + py) * g.W + g.originX + x * m + lo) * 4;
        for (let px = lo; px <= hi; px++, j += 4) {
          const l = 0.2126 * LIN[img[j]] + 0.7152 * LIN[img[j + 1]] + 0.0722 * LIN[img[j + 2]];
          if (dark) worst = Math.max(worst, l);
          else worst = Math.min(worst, l);
        }
      }
      if (dark ? worst > CAMERA_RULE.darkMax : worst < CAMERA_RULE.lightMin) bad.push({ x, y, dark, worst: Math.round(worst * 1000) / 1000 });
    }
  }
  let quietBad = 0;
  for (let y = 0; y < g.W; y++) {
    for (let x = 0; x < g.W; x++) {
      if (x >= g.originX && x < g.originX + n * m && y >= g.originY && y < g.originY + n * m) continue;
      const j = (y * g.W + x) * 4;
      if (img[j] < 250 || img[j + 1] < 250 || img[j + 2] < 250) quietBad++;
    }
  }
  return { ok: bad.length === 0 && quietBad === 0, bad, quietBad };
}

// ------------------------------------------------------------------------------------------------
// Overlays
// ------------------------------------------------------------------------------------------------
function edgesPath(P2, edges, T) {
  for (let k = 0; k < edges.length; k += 4) {
    P2.moveTo(T.x(edges[k]), T.y(edges[k + 1]));
    P2.lineTo(T.x(edges[k + 2]), T.y(edges[k + 3]));
  }
}

// a codeword's light cells that no stroke has touched (washes go only there: paper or a Show bytes tint)
function cleanLightCellsPath(P, sym, c, modules, near, T, m) {
  const n = sym.size;
  const p = new Path2D();
  for (const i of P.cells[c]) if (modules[i] !== 1 && !near[i]) p.rect(T.x(i % n), T.y((i / n) | 0), m, m);
  return p;
}

// the outer band of each of a codeword's cells (a frame per square, inside the outer 10%: the inner 80% is left alone)
function bandsPath(P, sym, c, T, m) {
  const n = sym.size;
  const p = new Path2D();
  const a = Math.floor(0.1 * m);
  const b = Math.ceil(0.9 * m);
  for (const i of P.cells[c]) {
    const x = T.x(i % n);
    const y = T.y((i / n) | 0);
    p.rect(x, y, m, m);
    p.rect(x + a, y + a, b - a, b - a);
  }
  return p;
}

// Washes over clean light cells keep luminance >= 0.78 over the palest base they can meet (white or a tint).
const WASH_CAP = new Map();
function washCap(hex, base = '#ffffff') {
  const key = hex + base;
  if (WASH_CAP.has(key)) return WASH_CAP.get(key);
  const h = (s) => [1, 3, 5].map((k) => parseInt(s.slice(k, k + 2), 16));
  const [r, gg, b] = h(hex);
  const [R0, G0, B0] = h(base);
  let a = 0;
  for (let t = 0.005; t <= 1; t += 0.005) {
    const mix = (v, w) => Math.round(w * (1 - t) + v * t);
    const lr = mix(r, R0);
    const lg = mix(gg, G0);
    const lb = mix(b, B0);
    if (relLum(lr, lg, lb) < CAMERA_RULE.lightMin + CAMERA_RULE.margin || 0.299 * lr + 0.587 * lg + 0.114 * lb < CAMERA_RULE.innerLightLuma + 4) break;
    a = t;
  }
  WASH_CAP.set(key, a);
  return a;
}

function marksFromView(view, ncw) {
  if (view.marks) return view.marks;
  const out = new Uint8Array(ncw);
  const st = view.cwStatus;
  const br = view.broken;
  for (let c = 0; c < ncw; c++) {
    const s = st ? st[c] : 0;
    if (s === 2) out[c] = !br || br[c] ? MARK.failed : 0; // a failed block: mark the bytes that really broke
    else if (st && s === 1) out[c] = MARK.fixed;
    else if (st && s === 3) out[c] = MARK.erased;
    else if (br && br[c]) out[c] = MARK.broken;
  }
  return out;
}

function drawOverlays(ctx, sym, P, view, g, T, near) {
  const m = g.m;
  const n = sym.size;
  const ncw = sym.stream.length;
  const W15 = Math.max(1, Math.min(0.14 * m, 2 * Math.floor(0.1 * m) - 1)); // <= 15% of a module, inside the outer 10% bands
  ctx.save();
  ctx.beginPath();
  ctx.rect(g.originX, g.originY, n * m, n * m); // overlays never reach the quiet zone
  ctx.clip();
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  if (view.showBytes) {
    for (let c = 0; c < ncw; c++) {
      const B = BLOCK_STYLE[P.block[c] % 4];
      const p = new Path2D();
      edgesPath(p, P.edges[c], T);
      ctx.strokeStyle = B.line;
      ctx.lineWidth = Math.max(1, Math.min(0.09 * m, 2 * Math.floor(0.1 * m) - 1));
      ctx.setLineDash(P.isCheck[c] ? [0.32 * m, 0.2 * m] : []);
      ctx.stroke(p);
    }
    ctx.setLineDash([]);
  }
  const marks = marksFromView(view, ncw);
  const flash = view.flash;
  const tintBase = view.showBytes ? '#e6f0fa' : '#ffffff'; // the darkest base a wash can meet (washes vanish over tints)
  for (let c = 0; c < ncw; c++) {
    const mk = marks[c];
    const f = flash ? Math.max(0, Math.min(1, flash[c] || 0)) : 0;
    if (!mk && !f) continue;
    const ep = new Path2D();
    edgesPath(ep, P.edges[c], T);
    if (f > 0) {
      // the repair flash: every square of the byte lights up in its outer band, clean paper cells get a green wash,
      // and the byte's outline thickens (all of it outside the central squares)
      ctx.save();
      ctx.clip(bandsPath(P, sym, c, T, m), 'evenodd');
      ctx.globalAlpha = 0.75 * f;
      ctx.fillStyle = PAINT.fixed;
      ctx.fillRect(g.originX, g.originY, n * m, n * m);
      ctx.restore();
      ctx.globalAlpha = washCap(PAINT.fixed, tintBase) * f;
      ctx.fillStyle = PAINT.fixed;
      ctx.fill(cleanLightCellsPath(P, sym, c, view.modules, near, T, m));
      ctx.globalAlpha = 1;
      ctx.strokeStyle = PAINT.fixed;
      ctx.lineWidth = W15 + (Math.max(W15, 2 * Math.floor(0.1 * m) - 1) - W15) * f; // stays inside the outer 10% bands
      ctx.stroke(ep);
      continue;
    }
    if (mk === MARK.failed) {
      // beyond repair: a vermillion hatch in the bands of the byte's squares
      ctx.save();
      ctx.clip(bandsPath(P, sym, c, T, m), 'evenodd');
      ctx.globalAlpha = 0.75;
      ctx.strokeStyle = PAINT.failed;
      ctx.lineWidth = Math.max(1, 0.1 * m);
      const hp = new Path2D();
      for (const i of P.cells[c]) {
        const x = i % n;
        const y = (i / n) | 0;
        for (const t of [0, 0.5, 1]) {
          hp.moveTo(T.x(x + t - 0.5), T.y(y + 1));
          hp.lineTo(T.x(x + t + 0.5), T.y(y));
        }
      }
      ctx.stroke(hp);
      ctx.restore();
    } else if (mk === MARK.broken) {
      ctx.globalAlpha = washCap(PAINT.broken, tintBase);
      ctx.fillStyle = PAINT.broken;
      ctx.fill(cleanLightCellsPath(P, sym, c, view.modules, near, T, m));
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = mk === MARK.fixed || mk === MARK.erased ? PAINT.fixed : PAINT.broken;
    ctx.lineWidth = W15;
    ctx.setLineDash(mk === MARK.broken ? [0.34 * m, 0.22 * m] : mk === MARK.erased ? [0.1 * m, 0.16 * m] : []);
    ctx.stroke(ep);
    ctx.setLineDash([]);
  }
  if (view.camera) drawCameraWarn(ctx, sym, view.camera, g, T);
  ctx.restore();
  if (view.cursor) drawCursor(ctx, sym, view, g, T);
}

// dashed amber frames around damaged corner squares (on module edges, inside the symbol)
function drawCameraWarn(ctx, sym, cam, g, T) {
  const n = sym.size;
  const m = g.m;
  ctx.save();
  ctx.strokeStyle = PAINT.warn;
  ctx.lineWidth = Math.max(1, 0.12 * m);
  ctx.setLineDash([0.4 * m, 0.25 * m]);
  if (cam.finders) {
    const at = [[0, 0], [n - 8, 0], [0, n - 8]];
    cam.finders.forEach((on, j) => {
      if (on) ctx.strokeRect(T.x(at[j][0]), T.y(at[j][1]), 8 * m, 8 * m);
    });
  }
  ctx.restore();
}

// The brush ring. Inside each module's central square its ink takes the module's own class (a pale ring over light
// modules, a mid-grey ring over dark ones); in the outer bands it is a firm dark grey. So it never changes a reading.
function drawCursor(ctx, sym, view, g, T) {
  const cur = view.cursor;
  const n = sym.size;
  const m = g.m;
  const cx = T.x(cur.u * n);
  const cy = T.y(cur.v * n);
  const rr = cur.r * n * m;
  const ring = new Path2D();
  ring.arc(cx, cy, rr, 0, Math.PI * 2);
  const light = new Path2D();
  const dark = new Path2D();
  const outside = new Path2D();
  outside.rect(g.originX, g.originY, n * m, n * m);
  const x0 = Math.max(0, Math.floor(cur.u * n - cur.r * n - 1));
  const x1 = Math.min(n - 1, Math.ceil(cur.u * n + cur.r * n + 1));
  const y0 = Math.max(0, Math.floor(cur.v * n - cur.r * n - 1));
  const y1 = Math.min(n - 1, Math.ceil(cur.v * n + cur.r * n + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const target = view.modules[y * n + x] === 1 ? dark : light;
      const [a, b, w, h] = inner(T.x(x), T.y(y), m);
      target.rect(a - 1, b - 1, w + 2, h + 2);
      outside.rect(a - 1, b - 1, w + 2, h + 2);
    }
  }
  const lw = Math.max(1.5, 0.11 * m);
  ctx.save();
  ctx.beginPath();
  ctx.rect(g.originX, g.originY, n * m, n * m);
  ctx.clip();
  ctx.lineWidth = lw;
  ctx.save();
  ctx.clip(outside, 'evenodd'); // the outer bands only
  ctx.strokeStyle = 'rgba(40, 40, 40, 0.9)'; // the outer bands only
  ctx.stroke(ring);
  ctx.restore();
  ctx.save();
  ctx.clip(light);
  ctx.strokeStyle = '#ececec'; // luma 236: visible on white, still paper to a camera
  ctx.stroke(ring);
  ctx.restore();
  ctx.save();
  ctx.clip(dark);
  ctx.strokeStyle = '#555555'; // luma 85: visible on black, still ink to a camera
  ctx.stroke(ring);
  ctx.restore();
  ctx.restore();
}

// ------------------------------------------------------------------------------------------------
// The committed-strokes layer: print + strokes[0 .. len - 2] painted once (raw paint, never repaired: the verify pass
// runs on the composed canvas every frame, against the current view.modules)
// ------------------------------------------------------------------------------------------------
const LAYERS = new WeakMap();
function paintStroke(ctx, sym, c, g, T) {
  if (c.s.tool === 'marker') paintMarker(ctx, sym, c, g, T);
  else paintScratch(ctx, sym, c, g, T);
}
function strokeLayer(canvas, sym, P, g, showBytes, strokes, T) {
  const want = Math.max(0, strokes.length - 1);
  let L = LAYERS.get(canvas);
  let ok = L && L.sym === sym && L.m === g.m && L.W === g.W && L.showBytes === showBytes && L.refs.length <= want;
  for (let k = 0; ok && k < L.refs.length; k++) if (L.refs[k] !== strokes[k] || L.lens[k] !== strokes[k].pts.length || L.radii[k] !== strokes[k].r) ok = false;
  if (!ok) {
    const c = L && L.W === g.W ? L.canvas : makeCanvas(g.W, g.W);
    L = { sym, m: g.m, W: g.W, showBytes, refs: [], lens: [], radii: [], canvas: c, count: 0 };
    const x = c.getContext('2d');
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.globalAlpha = 1;
    x.globalCompositeOperation = 'copy';
    x.drawImage(printLayer(sym, P, g, showBytes), 0, 0);
    x.globalCompositeOperation = 'source-over';
    LAYERS.set(canvas, L);
  }
  if (L.refs.length < want) {
    const x = L.canvas.getContext('2d');
    const n = sym.size;
    x.save();
    x.beginPath();
    x.rect(g.originX, g.originY, n * g.m, n * g.m);
    x.clip();
    for (let k = L.refs.length; k < want; k++) {
      paintStroke(x, sym, conv(strokes[k], n), g, T);
      L.refs.push(strokes[k]);
      L.lens.push(strokes[k].pts.length);
      L.radii.push(strokes[k].r);
    }
    x.restore();
  }
  L.count = L.refs.length;
  return L;
}

// light cells a scratch may have textured (no washes there): centres within r + 0.75 of the path (cached per stroke)
function nearList(c, n) {
  if (c.near && c.nearLen === c.len) return c.near;
  const out = [];
  const b = boxOf(c.s, 1);
  const lim = (c.s.r + 0.75) ** 2;
  for (let y = Math.max(0, Math.floor(b.y0)); y <= Math.min(n - 1, Math.ceil(b.y1)); y++) {
    for (let x = Math.max(0, Math.floor(b.x0)); x <= Math.min(n - 1, Math.ceil(b.x1)); x++) {
      if (dist2ToPolyline(c.s.pts, x + 0.5, y + 0.5) <= lim) out.push(y * n + x);
    }
  }
  c.near = out;
  c.nearLen = c.len;
  return out;
}

// ------------------------------------------------------------------------------------------------
// draw()
// ------------------------------------------------------------------------------------------------
const CTX = new WeakMap();
function context(canvas) {
  let c = CTX.get(canvas);
  if (!c) {
    c = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
    CTX.set(canvas, c);
  }
  return c;
}

/**
 * Paint the code card (SPEC 5.6).
 *  canvas: the hero canvas. draw() sizes its backing store to geometry(sym, opts).W square (device px) and, unless
 *          opts.setSize === false, its CSS size to W / dpr.
 *  sym:    the clean symbol (qr.js encode()).
 *  view:   {modules: Uint8Array (the state to draw, from strokes.js), under (not needed for the look), strokes:
 *           [Stroke] with normalized pts and r, cwStatus: Read.status per codeword or null, broken: Uint8Array per
 *           codeword or null, showBytes, flash: Float32Array per codeword (0..1) or null, cursor: {u, v, r} or null,
 *           marks: optional Uint8Array per codeword (MARK.*) that overrides the rule below,
 *           camera: optional {finders: [3 bools]} for dashed warning frames}
 *          Marks without view.marks: cwStatus 2 -> beyond repair; cwStatus 1 -> fixed; 3 -> filled gap; otherwise
 *          broken[c] -> broken (vermillion, dashed). While a stroke is in progress pass cwStatus = null to show
 *          every broken byte as broken; after the stroke pass the decoder's status to turn them fixed.
 *  opts:   {modulePx (CSS px per module), dpr, quiet = 4, setSize = true, verify = true, blockOf}
 * Returns {geo, repaired, ms}: geo = geometry() in device px (originX, originY, modulePx = m, size: what
 * qr.js readPixels needs), repaired = cells the verify pass repainted, ms = time taken.
 */
export function draw(canvas, sym, view = {}, opts = {}) {
  // the earlier call shape (module-unit strokes, {strokes, state} + marks/flash/cursor in opts) still works
  if (view && view.state && view.state.modules && !view.modules) return drawLegacy(canvas, sym, view, opts);
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  const g = geometry(sym, opts);
  if (canvas.width !== g.W || canvas.height !== g.W) {
    canvas.width = g.W;
    canvas.height = g.W;
  }
  if (opts.setSize !== false && canvas.style) {
    const css = g.cssW + 'px';
    if (canvas.style.width !== css) {
      canvas.style.width = css;
      canvas.style.height = css;
    }
  }
  const P = prep(sym, opts);
  const ctx = context(canvas);
  const n = sym.size;
  const m = g.m;
  const T = { x: (u) => g.originX + u * m, y: (v) => g.originY + v * m };
  const modules = view.modules || sym.modules;
  const v = { ...view, modules };
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  const strokes = (view.strokes || []).filter((st) => st && st.pts && st.pts.length >= 2);
  // the print plus every stroke but the last (it may still be growing) comes from a cached layer
  const layer = strokeLayer(canvas, sym, P, g, !!view.showBytes, strokes, T);
  ctx.drawImage(layer.canvas, 0, 0);
  const convs = strokes.map((st) => conv(st, n));
  let box = null;
  for (const c of convs) {
    const b = boxOf(c.s, 0.8);
    const bb = { x0: Math.floor(b.x0), y0: Math.floor(b.y0), x1: Math.ceil(b.x1), y1: Math.ceil(b.y1) };
    box = box ? { x0: Math.min(box.x0, bb.x0), y0: Math.min(box.y0, bb.y0), x1: Math.max(box.x1, bb.x1), y1: Math.max(box.y1, bb.y1) } : bb;
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(g.originX, g.originY, n * m, n * m); // never the quiet zone
  ctx.clip();
  for (let k = layer.count; k < convs.length; k++) paintStroke(ctx, sym, convs[k], g, T);
  ctx.restore();
  // a module whose state differs from the print but that no stroke reaches is checked (and repainted) too
  let stray = false;
  for (let i = 0; i < n * n && !stray; i++) if (modules[i] !== sym.modules[i]) stray = !box;
  if (stray) box = { x0: 0, y0: 0, x1: n - 1, y1: n - 1 };
  let repaired = 0;
  if (box && opts.verify !== false) repaired = verify(ctx, sym, P, v, convs, g, box, !!view.showBytes);
  const near = new Uint8Array(n * n);
  for (const c of convs) if (c.s.tool !== 'marker') for (const i of nearList(c, n)) near[i] = 1;
  drawOverlays(ctx, sym, P, v, g, T, near);
  ctx.restore();
  const ms = typeof performance !== 'undefined' ? performance.now() - t0 : 0;
  return { geo: g, repaired, ms };
}

// ------------------------------------------------------------------------------------------------
// The earlier API (module units), kept so callers written against it keep working (ORACLE's harness, mini canvases):
// fit, geometryOf, newStroke, extendStroke, applyStrokes, changedCodewords, bezierPts, clientToModule, ghostAt, and
// draw(canvas, sym, {strokes, state}, {dpr, showBytes, marks, flash, cursor: {x, y, r, tool, visible}, camera, verify})
// returning {geo, state, fixedCores}. Strokes here are {tool, r, seed, pts} in MODULE units.
// ------------------------------------------------------------------------------------------------
const TWINS = new WeakMap();
function twin(s, n) {
  let t = TWINS.get(s);
  if (!t || t.n !== n || t.len !== s.pts.length || t.r0 !== s.r) {
    const norm = { tool: s.tool, r: s.r / n, seed: s.seed, pts: Array.from(s.pts, (v) => v / n) };
    if (t && t.n === n && t.r0 === s.r) {
      t.obj.pts = norm.pts; // keep the twin's identity: the layer cache keys on it
      t.len = s.pts.length;
    } else {
      t = { n, len: s.pts.length, r0: s.r, obj: norm };
      TWINS.set(s, t);
    }
  }
  return t.obj;
}

function drawLegacy(canvas, sym, view, opts) {
  const n = sym.size;
  const quiet = opts.quiet ?? 4;
  const dpr = opts.dpr ?? (globalThis.devicePixelRatio || 1);
  const span = n + 2 * quiet;
  const m = Math.max(1, Math.floor(Math.min(canvas.width, canvas.height) / span));
  const cur = opts.cursor && opts.cursor.visible ? { u: opts.cursor.x / n, v: opts.cursor.y / n, r: opts.cursor.r / n } : null;
  const v = {
    modules: view.state.modules,
    strokes: (view.strokes || []).filter((s) => s && s.pts && s.pts.length >= 2).map((s) => twin(s, n)),
    showBytes: !!opts.showBytes,
    marks: opts.marks || null,
    flash: opts.flash || null,
    cursor: cur,
    camera: opts.camera || null,
  };
  const out = draw(canvas, sym, v, { modulePx: m / dpr, dpr, quiet, setSize: false, verify: opts.verify, blockOf: opts.blockOf });
  return { geo: out.geo, state: view.state, fixedCores: out.repaired, repaired: out.repaired, ms: out.ms };
}

/** Size the canvas: the largest whole number of device px per module that fits maxCssWidth (earlier API). */
export function fit(canvas, sym, { maxCssWidth, dpr = globalThis.devicePixelRatio || 1, quiet = 4, minCssModule = 0, maxCssModule = 14 } = {}) {
  const span = sym.size + 2 * quiet;
  let m = Math.floor((maxCssWidth * dpr) / span);
  m = Math.min(m, Math.floor(maxCssModule * dpr));
  if (minCssModule > 0) m = Math.max(m, Math.ceil(minCssModule * dpr));
  m = Math.max(1, m);
  const W = m * span;
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== W) canvas.height = W;
  if (canvas.style) {
    canvas.style.width = W / dpr + 'px';
    canvas.style.height = W / dpr + 'px';
  }
  return geometry(sym, { modulePx: m / dpr, dpr, quiet });
}

/** The geometry of a canvas already sized (earlier API). */
export function geometryOf(canvas, sym, quiet = 4, dpr = globalThis.devicePixelRatio || 1) {
  const span = sym.size + 2 * quiet;
  const m = Math.max(1, Math.floor(Math.min(canvas.width, canvas.height) / span));
  return geometry(sym, { modulePx: m / dpr, dpr, quiet });
}

/** A new module-unit stroke (earlier API). */
export function newStroke(tool, r, seed = 1) {
  if (tool !== 'scratch' && tool !== 'marker') throw new RangeError("tool must be 'scratch' or 'marker'");
  if (!(r > 0)) throw new RangeError('r must be positive');
  return { tool, r, seed: seed >>> 0, pts: [] };
}

/** Append a module-unit point; ignores moves under 0.05 module. */
export function extendStroke(stroke, x, y) {
  const p = stroke.pts;
  const k = p.length;
  if (k >= 2 && (x - p[k - 2]) ** 2 + (y - p[k - 1]) ** 2 < 0.0025) return false;
  p.push(x, y);
  return true;
}

/** Squared distance from a point to a module-unit stroke's polyline. */
export function dist2ToStroke(stroke, px, py) {
  return dist2ToPolyline(stroke.pts, px, py);
}

/**
 * Module state after module-unit strokes (the rule of strokes.js: a module takes the stroke's colour when its centre
 * is within r of the polyline; later strokes win). Returns {modules, cover, scratched, flipped, byStroke}.
 */
export function applyStrokes(sym, strokes, upto = strokes.length) {
  const n = sym.size;
  const modules = Uint8Array.from(sym.modules);
  const cover = new Int16Array(n * n).fill(-1);
  const scratched = new Uint8Array(n * n);
  const byStroke = [];
  for (let k = 0; k < upto; k++) {
    const s = strokes[k];
    const mine = [];
    byStroke.push(mine);
    if (!s.pts.length) continue;
    const b = boxOf(s, 0);
    const r2 = s.r * s.r;
    const val = s.tool === 'marker' ? 1 : 0;
    for (let y = Math.max(0, Math.floor(b.y0 - 0.5)); y <= Math.min(n - 1, Math.ceil(b.y1 - 0.5)); y++) {
      for (let x = Math.max(0, Math.floor(b.x0 - 0.5)); x <= Math.min(n - 1, Math.ceil(b.x1 - 0.5)); x++) {
        if (dist2ToPolyline(s.pts, x + 0.5, y + 0.5) <= r2) {
          const i = y * n + x;
          modules[i] = val;
          cover[i] = k;
          scratched[i] = 1;
          mine.push(i);
        }
      }
    }
  }
  let flipped = 0;
  for (let i = 0; i < modules.length; i++) if (modules[i] !== sym.modules[i]) flipped++;
  return { modules, cover, scratched, flipped, byStroke };
}

/** 1 per stream codeword whose modules differ from the clean code. */
export function changedCodewords(sym, modules) {
  const out = new Uint8Array(sym.stream.length);
  for (let i = 0; i < modules.length; i++) if (sym.cw[i] >= 0 && modules[i] !== sym.modules[i]) out[sym.cw[i]] = 1;
  return out;
}

/** A quadratic Bezier sampled into n + 1 points [[x, y], ...]. */
export function bezierPts(p0, p1, p2, n = 24) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = (1 - t) * (1 - t);
    const b = 2 * (1 - t) * t;
    const c = t * t;
    out.push([a * p0[0] + b * p1[0] + c * p2[0], a * p0[1] + b * p1[1] + c * p2[1]]);
  }
  return out;
}

/** A pointer position as module units (earlier API; geo from fit/geometryOf). */
export function clientToModule(canvas, geo, clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  const sx = canvas.width / (r.width || canvas.width);
  const sy = canvas.height / (r.height || canvas.height);
  return { x: ((clientX - r.left) * sx - geo.originX) / geo.modulePx, y: ((clientY - r.top) * sy - geo.originY) / geo.modulePx };
}

/** The ghost scratch ms after it starts (module units): {stroke, done}. def: {pts: [[x, y], ...], r, ms, seed}. */
export function ghostAt(def, ms) {
  const flat = def.pts.flat();
  const part = partialPolyline(flat, swipeEase(ms / def.ms));
  return { stroke: { tool: 'scratch', r: def.r, seed: def.seed ?? 7, pts: part }, done: ms >= def.ms };
}

// ------------------------------------------------------------------------------------------------
// Motion helpers (the page owns time; these are pure functions of it). SPEC 5.5: one 300 ms pulse per byte.
// ------------------------------------------------------------------------------------------------
/** Repair flash intensity (0..1) for one byte, ms after its pulse starts: up in 90 ms, down by 300 ms. */
export function flashAt(ms) {
  if (ms <= 0 || ms >= 300) return 0;
  if (ms < 90) return ms / 90;
  const t = (ms - 90) / 210;
  return 1 - t * t * (3 - 2 * t);
}

/** Ease-in-out cubic for the ghost's draw-on (SPEC 3.3: 1100 ms). */
export function swipeEase(t) {
  t = Math.min(1, Math.max(0, t));
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** The first `t` (0..1, by arc length) of a polyline [u0, v0, u1, v1, ...]: the ghost as it draws itself. */
export function partialPolyline(pts, t) {
  const k = pts.length >> 1;
  if (k < 2 || t >= 1) return Array.from(pts);
  const cum = [0];
  for (let i = 1; i < k; i++) cum.push(cum[i - 1] + Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]));
  const target = Math.max(0, t) * cum[k - 1];
  const out = [pts[0], pts[1]];
  for (let i = 1; i < k; i++) {
    if (cum[i] <= target) out.push(pts[2 * i], pts[2 * i + 1]);
    else {
      const a = (target - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
      out.push(pts[2 * i - 2] + (pts[2 * i] - pts[2 * i - 2]) * a, pts[2 * i - 1] + (pts[2 * i + 1] - pts[2 * i - 1]) * a);
      break;
    }
  }
  return out;
}
