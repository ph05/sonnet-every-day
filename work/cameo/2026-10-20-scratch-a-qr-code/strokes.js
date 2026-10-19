// strokes.js: the page's stroke store. Strokes are kept NORMALIZED (0..1 across the symbol's module area, quiet
// zone excluded; the radius in the same unit), so a scratch stays where it is when the message or the level changes
// the code's size. render.js works in module units: toModule() converts for the current symbol, and render.js's
// applyStrokes() is the single definition of which modules a stroke changes (a module takes the stroke's colour when
// its centre lies within the radius of the stroke's polyline; later strokes win).

// Brush radii, normalized to the 29 x 29 sample code (1.2 modules there = the first frame's sample scratch).
export const BRUSH = Object.freeze({ fine: 0.6 / 29, medium: 1.2 / 29, wide: 2.0 / 29 });

// The first frame's sample scratch: a quadratic Bezier in normalized coordinates (W/proto/ghost_final.py). On the
// sample code (version 3-H, 29 x 29) it changes 26 modules and breaks 9 bytes, 4 in block 1 and 5 in block 2,
// and touches no corner square, timing line, alignment square or format strip.
export const GHOST = Object.freeze({ p0: [0.28, 0.52], p1: [0.5, 0.2], p2: [0.8, 0.6], r: 1.2 / 29, ms: 1000, seed: 7, steps: 24 });

let seedCounter = 11;

/** A new, empty normalized stroke. */
export function newStroke(tool, r) {
  seedCounter = (seedCounter * 1103515245 + 12345) >>> 0;
  return { tool, r, seed: seedCounter >>> 8, pts: [] };
}

/** Append a normalized point; moves shorter than a twentieth of a module of a size-n code are skipped. */
export function addPoint(stroke, u, v, size) {
  const p = stroke.pts;
  const n = p.length;
  if (n >= 2) {
    const du = (u - p[n - 2]) * size;
    const dv = (v - p[n - 1]) * size;
    if (du * du + dv * dv < 0.0025) return false;
  }
  p.push(u, v);
  return true;
}

/** One stroke in module units for a code of the given size (the shape render.js expects). */
export function toModule(s, size) {
  const pts = new Array(s.pts.length);
  for (let i = 0; i < s.pts.length; i++) pts[i] = s.pts[i] * size;
  return { tool: s.tool, r: s.r * size, seed: s.seed, pts };
}

/** A module-unit stroke back to normalized. */
export function fromModule(s, size) {
  return { tool: s.tool, r: s.r / size, seed: s.seed, pts: s.pts.map((v) => v / size) };
}

/** The ghost's path for a code of the given size, as render.js's ghostAt() wants it (module units). */
export function ghostDef(size) {
  const pts = [];
  const { p0, p1, p2, steps } = GHOST;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = (1 - t) * (1 - t);
    const b = 2 * (1 - t) * t;
    const c = t * t;
    pts.push([(a * p0[0] + b * p1[0] + c * p2[0]) * size, (a * p0[1] + b * p1[1] + c * p2[1]) * size]);
  }
  return { pts, r: GHOST.r * size, ms: GHOST.ms, seed: GHOST.seed };
}

/** The whole ghost as one normalized stroke (for reduced motion and the self-check). */
export function ghostStroke() {
  const def = ghostDef(1);
  return { tool: 'scratch', r: GHOST.r, seed: GHOST.seed, pts: def.pts.flat() };
}

/** Squared distance (module units) from (px, py) to a module-unit polyline given as a flat array (one vertex = a point). */
function dist2(pts, px, py) {
  const k = pts.length >> 1;
  if (k === 0) return Infinity;
  if (k === 1) return (px - pts[0]) ** 2 + (py - pts[1]) ** 2;
  let best = Infinity;
  for (let i = 0; i + 1 < k; i++) {
    const ax = pts[2 * i];
    const ay = pts[2 * i + 1];
    const dx = pts[2 * i + 2] - ax;
    const dy = pts[2 * i + 3] - ay;
    const L = dx * dx + dy * dy;
    let t = L > 0 ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = px - (ax + t * dx);
    const ey = py - (ay + t * dy);
    const d = ex * ex + ey * ey;
    if (d < best) best = d;
  }
  return best;
}

/**
 * THE definition of what the strokes do to the code (the decoder is given exactly this, and render.js draws it):
 * a module takes the stroke's colour (Scratch: light, Marker: dark) when its centre ((x + 0.5, y + 0.5) in module
 * units) lies within the stroke's radius of its polyline; later strokes win. Strokes are normalized.
 * Returns {modules, scratched (1 under any stroke: the erasure map), cover (index of the last stroke covering the
 * centre, -1 if none), flipped (modules that differ from the clean code)}.
 */
export function applyStrokes(sym, strokes) {
  const n = sym.size;
  const modules = Uint8Array.from(sym.modules);
  const scratched = new Uint8Array(n * n);
  const cover = new Int16Array(n * n).fill(-1);
  strokes.forEach((s, k) => {
    if (!s.pts.length) return;
    const pts = s.pts.map((v) => v * n);
    const r = s.r * n;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      x0 = Math.min(x0, pts[i]);
      x1 = Math.max(x1, pts[i]);
      y0 = Math.min(y0, pts[i + 1]);
      y1 = Math.max(y1, pts[i + 1]);
    }
    const xa = Math.max(0, Math.floor(x0 - r - 0.5));
    const xb = Math.min(n - 1, Math.ceil(x1 + r - 0.5));
    const ya = Math.max(0, Math.floor(y0 - r - 0.5));
    const yb = Math.min(n - 1, Math.ceil(y1 + r - 0.5));
    const r2 = r * r;
    const v = s.tool === 'marker' ? 1 : 0;
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) {
        if (dist2(pts, x + 0.5, y + 0.5) <= r2) {
          const i = y * n + x;
          modules[i] = v;
          scratched[i] = 1;
          cover[i] = k;
        }
      }
    }
  });
  let flipped = 0;
  for (let i = 0; i < modules.length; i++) if (modules[i] !== sym.modules[i]) flipped++;
  return { modules, scratched, cover, flipped };
}

/** easeInOutCubic: a quick, confident swipe. */
export function swipeEase(t) {
  t = Math.min(1, Math.max(0, t));
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** The sample scratch ms after it starts: the normalized stroke grown along its path, and whether it is done. */
export function ghostAt(ms) {
  const full = ghostStroke();
  const t = swipeEase(ms / GHOST.ms);
  const p = full.pts;
  const k = p.length >> 1;
  const cum = [0];
  for (let i = 1; i < k; i++) cum.push(cum[i - 1] + Math.hypot(p[2 * i] - p[2 * i - 2], p[2 * i + 1] - p[2 * i - 1]));
  const target = t * cum[k - 1];
  const out = [p[0], p[1]];
  for (let i = 1; i < k; i++) {
    if (cum[i] <= target) out.push(p[2 * i], p[2 * i + 1]);
    else {
      const a = (target - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
      out.push(p[2 * i - 2] + (p[2 * i] - p[2 * i - 2]) * a, p[2 * i - 1] + (p[2 * i + 1] - p[2 * i - 1]) * a);
      break;
    }
  }
  return { stroke: { tool: 'scratch', r: GHOST.r, seed: GHOST.seed, pts: out }, done: t >= 1 };
}
