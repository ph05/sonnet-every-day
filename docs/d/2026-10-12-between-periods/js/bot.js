// Between Periods: the robot driver. Three planners drive the sim the way a person does, one steer value
// and one slow flag per tick. They power the attract demo, "Watch a lap", the #a= autoplay hook and the
// self-tests that prove every daily rink is winnable.
//   mow     skip-lane lanes end to end: simple, and it leaves pockets at the lane ends
//   spiral  three closed laps hugging the boards, stepping inward, then a scar-aware sweep and clean-up
//   race    the same with two laps, so the sweep has more to do
// A route is a polyline of Dubins connectors and straight lanes (planned a little wider than the machine
// can turn, so the steering keeps headroom), followed by pure pursuit. The refill door is visited when the
// tank runs low, at the cheapest point of the route. Everything is planned in a frame where the door is on
// the y = 0 board. Pure: no browser globals, no unseeded randomness, no clock; trig comes from sim.js.

import {
  TUNING, createRink, createSim, mulberry32, sinq, cosq, atan2q, wrapPi, boardDepth, outlinePoint, outlineLength,
} from './sim.js';

export const PLANNERS = ['mow', 'spiral', 'race'];

const PI = 3.141592653589793;
const TWO_PI = 6.283185307179586;
const HALF_PI = 1.5707963267948966;
const RHO = 11;          // planning radius: a little wider than the machine's 10 ft so the steering keeps headroom
const PITCH = 7.5;       // lane and loop spacing: the 8 ft stripe overlaps its neighbour by half a foot
const CLEAR = 5;         // planned centre line stays this far from the boards (the push-out starts at 4.5)
const STEP = 1;          // path sample spacing, feet
const LOOKAHEAD = 6.5;   // pure-pursuit distance, feet
const LANES = 11;
const SKIP_ORDER = [0, 3, 6, 9, 5, 2, 7, 10, 4, 1, 8];   // every hop skips at least two lanes: 3 * PITCH >= 2 * RHO
const BLOCK = 6;         // clean-up block size, feet
const BLOCK_COLS = 34;
const BLOCK_ROWS = 15;

const mod2pi = (t) => t - TWO_PI * Math.floor(t / TWO_PI);
const acosq = (c) => atan2q(Math.sqrt(Math.max(0, 1 - c * c)), c);
const laneY = (k) => CLEAR + PITCH * k;
const loopRadius = (d) => Math.max(28 - d, RHO);

// ---- Dubins: the shortest forward-only path between two poses at a minimum turning radius ----------

const WORD_KINDS = [[1, 0, 1], [-1, 0, -1], [1, 0, -1], [-1, 0, 1], [-1, 1, -1], [1, -1, 1]];   // LSL RSR LSR RSL RLR LRL
const words = { len: new Float64Array(6), t: new Float64Array(6), p: new Float64Array(6), q: new Float64Array(6) };

function setWord(i, t, p, q) {
  words.t[i] = t; words.p[i] = p; words.q[i] = q;
  words.len[i] = t + p + q;
}

// Fills `words` with the six Dubins words for a start pose and a goal pose (Infinity where none exists).
function dubinsWords(x0, y0, a0, x1, y1, a1) {
  const dx = x1 - x0, dy = y1 - y0;
  const dist = Math.sqrt(dx * dx + dy * dy), d = dist / RHO;
  const th = dist > 1e-9 ? atan2q(dy, dx) : 0;
  const alpha = mod2pi(a0 - th), beta = mod2pi(a1 - th);
  const sa = sinq(alpha), sb = sinq(beta), ca = cosq(alpha), cb = cosq(beta), cab = cosq(alpha - beta);
  for (let i = 0; i < 6; i++) words.len[i] = Infinity;
  let psq = 2 + d * d - 2 * cab + 2 * d * (sa - sb);
  if (psq >= 0) {
    const tmp = atan2q(cb - ca, d + sa - sb);
    setWord(0, mod2pi(tmp - alpha), Math.sqrt(psq), mod2pi(beta - tmp));
  }
  psq = 2 + d * d - 2 * cab + 2 * d * (sb - sa);
  if (psq >= 0) {
    const tmp = atan2q(ca - cb, d - sa + sb);
    setWord(1, mod2pi(alpha - tmp), Math.sqrt(psq), mod2pi(tmp - beta));
  }
  psq = -2 + d * d + 2 * cab + 2 * d * (sa + sb);
  if (psq >= 0) {
    const p = Math.sqrt(psq);
    const tmp = atan2q(-ca - cb, d + sa + sb) - atan2q(-2, p);
    setWord(2, mod2pi(tmp - alpha), p, mod2pi(tmp - mod2pi(beta)));
  }
  psq = -2 + d * d + 2 * cab - 2 * d * (sa + sb);
  if (psq >= 0) {
    const p = Math.sqrt(psq);
    const tmp = atan2q(ca + cb, d - sa - sb) - atan2q(2, p);
    setWord(3, mod2pi(alpha - tmp), p, mod2pi(beta - tmp));
  }
  let c = (6 - d * d + 2 * cab + 2 * d * (sa - sb)) / 8;
  if (c >= -1 && c <= 1) {
    const phi = atan2q(ca - cb, d - sa + sb);
    const p = mod2pi(TWO_PI - acosq(c));
    const t = mod2pi(alpha - phi + mod2pi(p / 2));
    setWord(4, t, p, mod2pi(alpha - beta - t + mod2pi(p)));
  }
  c = (6 - d * d + 2 * cab + 2 * d * (sb - sa)) / 8;
  if (c >= -1 && c <= 1) {
    const phi = atan2q(ca - cb, d + sa - sb);
    const p = mod2pi(TWO_PI - acosq(c));
    const t = mod2pi(-alpha - phi + p / 2);
    setWord(5, t, p, mod2pi(beta - alpha - t + p));
  }
}

function dubinsLength(x0, y0, a0, x1, y1, a1) {
  dubinsWords(x0, y0, a0, x1, y1, a1);
  let best = Infinity;
  for (let i = 0; i < 6; i++) if (words.len[i] < best) best = words.len[i];
  return best * RHO;
}

// ---- a growing polyline with an end pose ------------------------------------------------------------

class PathBuf {
  constructor(cap) {
    this.p = new Float64Array(2 * cap);
    this.n = 0;
    this.x = 0; this.y = 0; this.a = 0;
    this.hazard = null;   // a circle where steering is halved: no turn may be planned inside it
    this.hit = false;
  }

  reset(x, y, a) {
    this.n = 0;
    this.push(x, y);
    this.x = x; this.y = y; this.a = a;
  }

  // The end pose follows the last two points; call after pushing raw points.
  syncEnd() {
    const q = this.n - 1;
    this.x = this.p[2 * q]; this.y = this.p[2 * q + 1];
    if (q > 0) this.a = atan2q(this.y - this.p[2 * q - 1], this.x - this.p[2 * q - 2]);
  }

  push(x, y) {
    if (2 * this.n + 2 > this.p.length) {
      const q = new Float64Array(this.p.length * 2);
      q.set(this.p);
      this.p = q;
    }
    this.p[2 * this.n] = x;
    this.p[2 * this.n + 1] = y;
    this.n++;
  }

  // Straight to (x, y) in STEP-sized pieces; the end heading follows the direction travelled.
  lineTo(x, y) {
    const dx = x - this.x, dy = y - this.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-9) return;
    const k = Math.ceil(len / STEP);
    for (let i = 1; i <= k; i++) this.push(this.x + (dx * i) / k, this.y + (dy * i) / k);
    this.x = x; this.y = y; this.a = atan2q(dy, dx);
  }

  arc(sign, angle) {
    const k = Math.max(1, Math.ceil((angle * RHO) / STEP));
    const x0 = this.x, y0 = this.y, a0 = this.a;
    let a = a0;
    for (let i = 1; i <= k; i++) {
      a = a0 + (sign * angle * i) / k;
      if (sign > 0) this.push(x0 + RHO * (sinq(a) - sinq(a0)), y0 - RHO * (cosq(a) - cosq(a0)));
      else this.push(x0 - RHO * (sinq(a) - sinq(a0)), y0 + RHO * (cosq(a) - cosq(a0)));
      const h = this.hazard;
      if (h !== null) {
        const dx = this.p[2 * this.n - 2] - h.x, dy = this.p[2 * this.n - 1] - h.y;
        if (dx * dx + dy * dy < h.r * h.r) this.hit = true;
      }
    }
    this.x = this.p[2 * this.n - 2]; this.y = this.p[2 * this.n - 1]; this.a = a;
  }

  word(i, t, p, q) {
    const kinds = WORD_KINDS[i];
    this.arc(kinds[0], t);
    if (kinds[1] === 0) {
      const h = this.a, len = p * RHO;
      this.lineTo(this.x + cosq(h) * len, this.y + sinq(h) * len);
      this.a = h;
    } else {
      this.arc(kinds[1], p);
    }
    this.arc(kinds[2], q);
  }

  // Shallowest board depth over the points appended since index `from` (skipping the first few).
  minDepthFrom(from) {
    let m = Infinity;
    for (let i = from + 3; i < this.n; i++) {
      const d = boardDepth(this.p[2 * i], this.p[2 * i + 1]);
      if (d < m) m = d;
    }
    return m;
  }

  // Dubins connector to a goal pose: the shortest word whose points stay `thr` feet inside the boards.
  // With `strict` nothing is appended and false comes back when every word touches them; otherwise the
  // word that stays deepest is used as a best effort.
  connectTo(x1, y1, a1, strict, thr) {
    const floor = thr === undefined ? CLEAR - 0.15 : thr;
    const x0 = this.x, y0 = this.y, a0 = this.a, from = this.n - 1;
    if ((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0) < 0.0025 && Math.abs(wrapPi(a1 - a0)) < 0.02) {
      this.a = a1;
      return true;
    }
    dubinsWords(x0, y0, a0, x1, y1, a1);
    const len = Array.from(words.len), t = Array.from(words.t), p = Array.from(words.p), q = Array.from(words.q);
    let bestI = -1, bestDepth = -Infinity;
    for (let tries = 0; tries < 6; tries++) {
      let wi = -1, wl = Infinity;
      for (let i = 0; i < 6; i++) if (len[i] < wl) { wl = len[i]; wi = i; }
      if (wi < 0) break;
      len[wi] = Infinity;
      this.hit = false;
      this.word(wi, t[wi], p[wi], q[wi]);
      const depth = this.minDepthFrom(from);
      if (depth >= floor && !this.hit) {
        this.x = x1; this.y = y1; this.a = a1;
        return true;
      }
      if (depth - (this.hit ? 1.5 : 0) > bestDepth) { bestDepth = depth - (this.hit ? 1.5 : 0); bestI = wi; }
      this.n = from + 1; this.x = x0; this.y = y0; this.a = a0;
    }
    if (strict) return false;
    if (bestI < 0) this.lineTo(x1, y1);
    else this.word(bestI, t[bestI], p[bestI], q[bestI]);
    this.x = x1; this.y = y1; this.a = a1;
    return false;
  }

  // Length in feet of the shortest clean connector from the end pose to a goal pose, or Infinity.
  cleanLength(x1, y1, a1) {
    scratch.reset(this.x, this.y, this.a);
    scratch.hazard = this.hazard;
    return scratch.connectTo(x1, y1, a1, true) ? scratch.n - 1 : Infinity;
  }
}

const scratch = new PathBuf(512);

// ---- the lane grid every planner shares (canonical frame: the refill door is on the y = 0 board) ------

// Leftmost x at which a lane centre line keeps CLEAR feet from the boards.
function laneLeft(y) {
  let x = 100;
  while (x > 0 && boardDepth(x - 0.5, y) >= CLEAR) x -= 0.5;
  return x;
}

const turnCache = new Map();
const hopCache = new Map();

// How far from the west board a lane must end for the hop to the lane at yB (opposite heading) to stay
// clear of the boards. The east end is the mirror image.
function turnX(yA, yB) {
  const key = yA + '|' + yB;
  let v = turnCache.get(key);
  if (v !== undefined) return v;
  const tmp = new PathBuf(256);
  v = 100;
  for (let x = Math.max(laneLeft(yA), laneLeft(yB)); x < 100; x += 0.5) {
    tmp.reset(x, yA, PI);
    if (tmp.connectTo(x, yB, 0, true)) { v = x; break; }
  }
  turnCache.set(key, v);
  return v;
}

function hopCost(gap) {
  const key = Math.round(gap * 2);
  let v = hopCache.get(key);
  if (v === undefined) {
    v = dubinsLength(0, 0, 0, 0, gap, PI);
    hopCache.set(key, v);
  }
  return v;
}

// A pose is escapable when a full-lock turn to at least one side stays clear of the boards.
function escapable(x, y, a) {
  const lx = x - RHO * sinq(a), ly = y + RHO * cosq(a), rx = x + RHO * sinq(a), ry = y - RHO * cosq(a);
  return boardDepth(lx, ly) >= RHO + CLEAR - 0.15 || boardDepth(rx, ry) >= RHO + CLEAR - 0.15;
}

let mowCache = null;

// The whole skip-lane route for a mower that starts on lane 0 heading +x. Independent of the rink.
function mowLanes() {
  if (mowCache) return mowCache;
  const b = new PathBuf(4096);
  b.reset(laneLeft(laneY(0)), laneY(0), 0);
  for (let idx = 0; idx < LANES; idx++) {
    const east = idx % 2 === 0, yA = laneY(SKIP_ORDER[idx]);
    if (idx === LANES - 1) {
      const e = laneLeft(yA);
      b.lineTo(east ? 200 - e : e, yA);
      break;
    }
    const yB = laneY(SKIP_ORDER[idx + 1]), tx = turnX(yA, yB), xe = east ? 200 - tx : tx;
    b.lineTo(xe, yA);
    b.connectTo(xe, yB, east ? PI : 0, false);
  }
  mowCache = b;
  return b;
}

// ---- the planner ------------------------------------------------------------------------------------

export function makePlanner(name, rink, opts) {
  const o = opts || {};
  const T = TUNING;
  const kind = PLANNERS.indexOf(name) >= 0 ? name : PLANNERS[0];
  const flip = rink.door.ny < 0;
  const FY = (y) => (flip ? 85 - y : y);
  const doorX = rink.door.x, doorY = rink.door.h / 2, doorHalf = rink.door.w / 2 - 1;
  const clockTicks = rink.tune.clockTicks;
  const zone = rink.mishap.zone;
  const puddle = rink.mishap.id === 'puddle';
  const perFt = T.waterPerFt + (rink.mishap.id === 'drip' ? T.dripPerSec / T.speed : 0);
  const rng = mulberry32(o.seed !== undefined ? o.seed >>> 0 : rink.id);
  const jitter = ((+o.jitterDeg || 0) * PI) / 180;
  // Route skipped by a pit shortcut is a saving for the planners that sweep up later, a loss for the mow.
  const skipCredit = kind === 'mow' ? -0.5 : 0.35;
  const { cols, scar } = rink;
  const out = { steer: 0, slow: 0 };
  const planner = { name: kind, done: false, control };

  const scarIdx = [];
  for (let i = 0; i < scar.length; i++) if (scar[i] !== 0) scarIdx.push(i);

  const path = new PathBuf(4096), probe = new PathBuf(512);
  const hazard = puddle && zone !== null ? { x: zone.x + zone.w / 2, y: FY(zone.y + zone.h / 2), r: zone.w / 2 + 1.5 } : null;
  path.hazard = hazard; probe.hazard = hazard;
  const tmpPt = { x: 0, y: 0, a: 0 };
  const bCount = new Int32Array(BLOCK_COLS * BLOCK_ROWS), bTried = new Uint8Array(BLOCK_COLS * BLOCK_ROWS);
  const bSumX = new Float64Array(BLOCK_COLS * BLOCK_ROWS), bSumY = new Float64Array(BLOCK_COLS * BLOCK_ROWS);
  let ci = 0, stage = 0, built = false, tailAt = -1, pit = null, pitWait = 0, jit = 0, stuckPasses = 0;
  let contactTicks = 0, stalled = false, anchorX = 0, anchorY = 0, anchorTick = 0;

  const cellX = (i) => ((i % cols) + 0.5) * rink.cell;
  const cellY = (i) => FY((Math.floor(i / cols) + 0.5) * rink.cell);
  const headingAt = (p, i, n) => (i + 1 < n ? atan2q(p[2 * i + 3] - p[2 * i + 1], p[2 * i + 2] - p[2 * i]) : 0);

  // First laps, built in a frame mirrored left-right when needed so they always run clockwise from the door.
  function buildInitial(x, y, a) {
    const mirror = kind !== 'mow' && doorX > 100;
    const mx = mirror ? 200 - x : x, ma = mirror ? PI - a : a;
    if (mirror && hazard !== null) { path.hazard = { x: 200 - hazard.x, y: hazard.y, r: hazard.r }; probe.hazard = path.hazard; }
    path.reset(mx, y, ma);
    if (kind === 'mow') {
      const lanes = mowLanes();
      const lx = lanes.p[0], ly = lanes.p[1];
      const flipX = dubinsLength(mx, y, ma, 200 - lx, ly, PI) < dubinsLength(mx, y, ma, lx, ly, 0);
      path.connectTo(flipX ? 200 - lx : lx, ly, flipX ? PI : 0, false);
      for (let i = 1; i < lanes.n; i++) path.push(flipX ? 200 - lanes.p[2 * i] : lanes.p[2 * i], lanes.p[2 * i + 1]);
      stage = 3;
    } else {
      // Closed laps hugging the boards, each stepping one lane inward near the door. The first lap starts
      // a little past the door so the S-curve out of it has room; a step slides along the lap when its
      // turns would land in the puddle.
      const xs = (mirror ? 200 - doorX : doorX) + 36, laps = kind === 'spiral' ? 3 : 2;
      let xk = xs;
      for (let k = 0; k < laps; k++) {
        const d = CLEAR + PITCH * k, rc = loopRadius(d), hx = 100 - d, hy = 42.5 - d, L = outlineLength(hx, hy, rc);
        const nominal = k === 0 ? xs : xk + 17;
        xk = nominal;
        for (const extra of [0, 10, 20, -10, 30]) {
          const cand = nominal + extra;
          if (cand < d + rc + 6 || cand > 200 - d - rc - 8) continue;
          outlinePoint(hx, hy, rc, cand - (d + rc), tmpPt);
          probe.reset(path.x, path.y, path.a);
          if (probe.connectTo(tmpPt.x, tmpPt.y, tmpPt.a, true)) { xk = cand; break; }
        }
        const s0 = xk - (d + rc), n = Math.ceil(L / STEP);
        outlinePoint(hx, hy, rc, s0, tmpPt);
        path.connectTo(tmpPt.x, tmpPt.y, tmpPt.a, false);
        for (let i = 1; i <= n; i++) {
          outlinePoint(hx, hy, rc, s0 + (L * i) / n, tmpPt);
          path.push(tmpPt.x, tmpPt.y);
        }
        path.x = tmpPt.x; path.y = tmpPt.y; path.a = tmpPt.a;
      }
      stage = 1;
    }
    if (mirror) for (let i = 0; i < path.n; i++) path.p[2 * i] = 200 - path.p[2 * i];
    path.hazard = hazard; probe.hazard = hazard;
    path.syncEnd();
  }

  // Append a connector from the path's end pose to `old` at index `j`, then the rest of `old`.
  function rejoin(old, j, strict) {
    const n = old.length / 2;
    const ok = path.connectTo(old[2 * j], old[2 * j + 1], headingAt(old, j, n), strict);
    if (!ok && strict) return false;
    for (let i = j + 1; i < n; i++) path.push(old[2 * i], old[2 * i + 1]);
    path.syncEnd();
    return ok;
  }

  // Start a replacement path at the machine. Pressed against the boards, first drive a short way inward,
  // since nothing that starts at the wall can pass the usual clearance test.
  function restart(x, y, a) {
    path.reset(x, y, a);
    const depth = boardDepth(x, y);
    if (depth >= CLEAR - 0.3) return;
    const gx = boardDepth(x + 0.5, y) - boardDepth(x - 0.5, y), gy = boardDepth(x, y + 0.5) - boardDepth(x, y - 0.5);
    const g = Math.sqrt(gx * gx + gy * gy) || 1;
    path.connectTo(x + (gx / g) * 9, y + (gy / g) * 9, atan2q(gy, gx), false, depth - 0.1);
  }

  // Rejoin the route ahead of the machine, preferring a clean connector over a short one.
  function reroute(x, y, a, from) {
    const old = path.p.slice(0, 2 * path.n), last = path.n - 1, jumps = [10, 20, 40, 80, 160, 320];
    for (let k = 0; k < jumps.length; k++) {
      const j = Math.min(last, from + jumps[k]);
      restart(x, y, a);
      if (rejoin(old, j, true)) { ci = 0; return; }
      if (j === last) break;
    }
    restart(x, y, a);
    rejoin(old, Math.min(last, from + 10), false);
    ci = 0;
  }

  // Unfixed scar cells binned into blocks; returns how many there are.
  function gather(done) {
    bCount.fill(0); bSumX.fill(0); bSumY.fill(0);
    let total = 0;
    for (let k = 0; k < scarIdx.length; k++) {
      const i = scarIdx[k];
      if (done[i] === 2) continue;
      const x = cellX(i), y = cellY(i);
      const b = Math.min(BLOCK_ROWS - 1, Math.floor(y / BLOCK)) * BLOCK_COLS + Math.min(BLOCK_COLS - 1, Math.floor(x / BLOCK));
      bCount[b]++; bSumX[b] += x; bSumY[b] += y;
      total++;
    }
    return total;
  }

  // A scar-aware sweep: the lanes of the shared grid that still hold scars, trimmed to where the scars
  // are, visited nearest-first. Lane ends keep room for the hop to the next lane.
  function planSweep(done) {
    const cnt = new Int32Array(LANES), lo = new Float64Array(LANES).fill(999), hi = new Float64Array(LANES).fill(-1);
    for (let k = 0; k < scarIdx.length; k++) {
      const i = scarIdx[k];
      if (done[i] === 2) continue;
      const x = cellX(i), y = cellY(i), lane = Math.max(0, Math.min(LANES - 1, Math.round((y - CLEAR) / PITCH)));
      cnt[lane]++;
      if (x < lo[lane]) lo[lane] = x;
      if (x > hi[lane]) hi[lane] = x;
    }
    const lanesLeft = [];
    for (let l = 0; l < LANES; l++) {
      if (cnt[l] < 3) continue;
      const left = laneLeft(laneY(l));
      let a = Math.max(left, lo[l] - 3), b = Math.min(200 - left, hi[l] + 3);
      if (b - a < 12) { const mid = (a + b) / 2; a = Math.max(left, mid - 6); b = Math.min(200 - left, mid + 6); }
      lanesLeft.push({ y: laneY(l), a, b });
    }
    if (lanesLeft.length === 0) return false;

    // first lane: the cheapest clean connector from where the path ends
    let first = null, firstCost = Infinity;
    for (let i = 0; i < lanesLeft.length; i++) {
      const t = lanesLeft[i];
      const fwd = path.cleanLength(t.a, t.y, 0), bwd = path.cleanLength(t.b, t.y, PI);
      if (fwd < firstCost) { firstCost = fwd; first = { t, dir: 1 }; }
      if (bwd < firstCost) { firstCost = bwd; first = { t, dir: -1 }; }
    }
    if (first === null) first = { t: lanesLeft[0], dir: 1 };
    let cur = first, entry = first.dir > 0 ? first.t.a : first.t.b;
    lanesLeft.splice(lanesLeft.indexOf(cur.t), 1);
    path.connectTo(entry, cur.t.y, cur.dir > 0 ? 0 : PI, false);

    // Each hop to the next lane happens at an x that keeps room for the turn and leaves the lane going
    // forward; a lane that cannot be hopped to from here waits for the clean-up.
    while (lanesLeft.length > 0) {
      const order = lanesLeft.slice().sort((u, v) => hopCost(Math.abs(u.y - cur.t.y)) - hopCost(Math.abs(v.y - cur.t.y)));
      let hop = null;
      for (let k = 0; k < order.length && hop === null; k++) {
        const nxt = order[k], tx = turnX(cur.t.y, nxt.y);
        const xc = cur.dir > 0
          ? Math.min(200 - tx, Math.max(cur.t.b, nxt.b, entry + 4))
          : Math.max(tx, Math.min(cur.t.a, nxt.a, entry - 4));
        if (cur.dir > 0 ? xc >= entry + 4 : xc <= entry - 4) hop = { nxt, xc };
      }
      if (hop === null) break;
      path.lineTo(hop.xc, cur.t.y);
      path.connectTo(hop.xc, hop.nxt.y, cur.dir > 0 ? PI : 0, false);
      lanesLeft.splice(lanesLeft.indexOf(hop.nxt), 1);
      cur = { t: hop.nxt, dir: -cur.dir };
      entry = hop.xc;
    }
    let exit = cur.dir > 0 ? Math.max(cur.t.b, entry + 4) : Math.min(cur.t.a, entry - 4);
    while (Math.abs(exit - entry) > 4 && !escapable(exit, cur.t.y, cur.dir > 0 ? 0 : PI)) exit -= cur.dir;
    path.lineTo(exit, cur.t.y);
    return true;
  }

  // Greedy clean-up: the best cluster of unfixed scars nearby, one straight pass along its long axis.
  function planPass(done) {
    const total = gather(done);
    if (total === 0) return false;
    for (let attempt = 0; attempt < 4; attempt++) {
      let bi = -1, bs = 0;
      for (let b = 0; b < bCount.length; b++) {
        const c = bCount[b];
        if (c === 0 || bTried[b] >= 2 || (c < 3 && total > 30)) continue;
        const dx = bSumX[b] / c - path.x, dy = bSumY[b] / c - path.y;
        const s = c / (Math.sqrt(dx * dx + dy * dy) + 20);
        if (s > bs) { bs = s; bi = b; }
      }
      if (bi < 0) return false;
      bTried[bi]++;
      const mx = bSumX[bi] / bCount[bi], my = bSumY[bi] / bCount[bi];
      let sxx = 0, sxy = 0, syy = 0, m = 0;
      for (let k = 0; k < scarIdx.length; k++) {
        const i = scarIdx[k];
        if (done[i] === 2) continue;
        const x = cellX(i) - mx, y = cellY(i) - my;
        if (x * x + y * y > 64) continue;
        sxx += x * x; sxy += x * y; syy += y * y; m++;
      }
      const ang = m > 2 ? 0.5 * atan2q(2 * sxy, sxx - syy) : 0;
      const lam = m > 2 ? (sxx + syy) / (2 * m) + Math.sqrt(((sxx - syy) / (2 * m)) * ((sxx - syy) / (2 * m)) + (sxy / m) * (sxy / m)) : 4;
      const half = Math.min(14, Math.max(4.5, 1.8 * Math.sqrt(lam) + 3));
      let cx = mx, cy = my;
      const depth = boardDepth(cx, cy);
      if (depth < CLEAR) {
        const gx = boardDepth(cx + 0.5, cy) - boardDepth(cx - 0.5, cy), gy = boardDepth(cx, cy + 0.5) - boardDepth(cx, cy - 0.5);
        const g = Math.sqrt(gx * gx + gy * gy) || 1;
        cx += (gx / g) * (CLEAR - depth); cy += (gy / g) * (CLEAR - depth);
      }
      const ux = cosq(ang), uy = sinq(ang);
      const fx = cx - ux * half, fy = cy - uy * half, rx = cx + ux * half, ry = cy + uy * half;
      const forward = path.cleanLength(fx, fy, ang), backward = path.cleanLength(rx, ry, ang + PI);
      if (forward === Infinity && backward === Infinity) continue;
      // Leave by the far end, trimmed so the pass does not finish pointing at a wall.
      const fwd = forward <= backward, ex = fwd ? rx : fx, ey = fwd ? ry : fy, ea = fwd ? ang : ang + PI;
      let len = 2 * half;
      while (len > 6 && !escapable(ex - cosq(ea) * (2 * half - len), ey - sinq(ea) * (2 * half - len), ea)) len -= 1;
      path.connectTo(fwd ? fx : rx, fwd ? fy : ry, ea, true);
      path.lineTo(path.x + cosq(ea) * len, path.y + sinq(ea) * len);
      return true;
    }
    return false;
  }

  function extend(done) {
    if (stage === 1) {
      stage = 2;
      if (planSweep(done)) return;
    }
    if (stage === 2) {
      if (planPass(done)) { stuckPasses = 0; return; }
      // Nothing clean from this pose (a dead end near a board): head for the middle and look again.
      if (stuckPasses < 3 && gather(done) > 0) {
        stuckPasses++;
        bTried.fill(0);
        path.connectTo(100, 42.5, path.a, false);
        return;
      }
    }
    if (tailAt < 0) {
      tailAt = path.n;
      path.lineTo(path.x + cosq(path.a) * 24, path.y + sinq(path.a) * 24);
    }
  }

  // Pit stop: leave the route where a visit to the refill door costs least, pass through it, rejoin.
  function planPit(tank) {
    const range = Math.max(0, (tank - 4) / perFt), p = path.p;
    const last = Math.min(path.n - 14, ci + Math.max(6, Math.floor(range) - 12));
    const cands = [];
    for (let i = ci + 4; i <= last; i += 4) {
      const px = p[2 * i], py = p[2 * i + 1], pa = headingAt(p, i, path.n);
      for (let dir = -1; dir <= 1; dir += 2) {
        const ea = dir > 0 ? 0 : PI, go = dubinsLength(px, py, pa, doorX - dir * doorHalf, doorY, ea);
        for (const j of [0, 12, 24, 40, 60]) {
          const jj = i + j;
          if (jj > path.n - 3) break;
          const back = dubinsLength(doorX + dir * doorHalf, doorY, ea, p[2 * jj], p[2 * jj + 1], headingAt(p, jj, path.n));
          cands.push({ i, j: jj, dir, cost: go + 2 * doorHalf + back - skipCredit * j });
        }
      }
    }
    // The cheap estimate ignores the boards, so settle the best few with clean connectors.
    cands.sort((u, v) => u.cost - v.cost);
    let best = null, bc = Infinity;
    for (let k = 0; k < Math.min(8, cands.length); k++) {
      const c = cands[k], ea = c.dir > 0 ? 0 : PI;
      probe.reset(p[2 * c.i], p[2 * c.i + 1], headingAt(p, c.i, path.n));
      const go = probe.cleanLength(doorX - c.dir * doorHalf, doorY, ea);
      probe.reset(doorX + c.dir * doorHalf, doorY, ea);
      const back = probe.cleanLength(p[2 * c.j], p[2 * c.j + 1], headingAt(p, c.j, path.n));
      const cost = go + 2 * doorHalf + back - skipCredit * (c.j - c.i);
      if (cost < bc) { bc = cost; best = c; }
    }
    pit = best;
    if (pit === null) pitWait = 90;
  }

  function doPit(x, y, a) {
    let dir = pit.dir;
    probe.reset(x, y, a);
    if (!probe.connectTo(doorX - dir * doorHalf, doorY, dir > 0 ? 0 : PI, true)) {
      dir = -dir;
      probe.reset(x, y, a);
      if (!probe.connectTo(doorX - dir * doorHalf, doorY, dir > 0 ? 0 : PI, true)) {
        pit = null; pitWait = 240;
        return;
      }
    }
    const old = path.p.slice(2 * pit.j, 2 * path.n), n = old.length / 2, ea = dir > 0 ? 0 : PI;
    path.reset(x, y, a);
    path.connectTo(doorX - dir * doorHalf, doorY, ea, true);
    path.lineTo(doorX + dir * doorHalf, doorY);
    let jj = 0;
    for (const off of [0, 8, 16, 32, 64]) {
      if (off >= n) break;
      probe.reset(path.x, path.y, path.a);
      if (probe.connectTo(old[2 * off], old[2 * off + 1], headingAt(old, off, n), true)) { jj = off; break; }
    }
    path.connectTo(old[2 * jj], old[2 * jj + 1], headingAt(old, jj, n), false);
    for (let i = jj + 1; i < n; i++) path.push(old[2 * i], old[2 * i + 1]);
    path.syncEnd();
    if (tailAt >= 0) tailAt = path.n - 25;
    ci = 0; pit = null; pitWait = 600;
  }

  function control(sim) {
    const m = sim.m, tick = sim.tick;
    const x = m.x, y = FY(m.y), a = flip ? -m.a : m.a;
    if (!built) {
      built = true;
      buildInitial(x, y, a);
      ci = 0;
      anchorX = x; anchorY = y;
    }
    if (planner.done) { out.steer = 0; out.slow = 0; return out; }

    // advance along the route
    let p = path.p;
    let d0 = (p[2 * ci] - x) * (p[2 * ci] - x) + (p[2 * ci + 1] - y) * (p[2 * ci + 1] - y);
    while (ci < path.n - 1) {
      const d1 = (p[2 * ci + 2] - x) * (p[2 * ci + 2] - x) + (p[2 * ci + 3] - y) * (p[2 * ci + 3] - y);
      if (d1 > d0) break;
      ci++; d0 = d1;
    }
    if (tailAt >= 0 && ci >= tailAt - 1) { planner.done = true; out.steer = 0; return out; }
    if (tailAt < 0 && path.n - ci < 14) extend(sim.grid.done);

    // water: plan a pit stop when the tank runs low, take it when the machine reaches its departure point
    if (pitWait > 0) pitWait--;
    if (pit === null && pitWait === 0 && m.tank < 42 && clockTicks - tick > 600) planPit(m.tank);
    if (pit !== null && ci >= pit.i - 1) doPit(x, y, a);

    // trouble: pinned on the boards, far off the route, or not getting anywhere
    contactTicks = m.contact ? contactTicks + 1 : 0;
    if (tick - anchorTick >= 150) {
      const moved = (x - anchorX) * (x - anchorX) + (y - anchorY) * (y - anchorY);
      anchorX = x; anchorY = y; anchorTick = tick;
      if (moved < 64 && !m.door) stalled = true;
    }
    if (contactTicks > 40 || d0 > 100 || stalled) {
      reroute(x, y, a, ci);
      pit = null; contactTicks = 0; stalled = false; anchorTick = tick;
    }

    // pure pursuit
    p = path.p;
    let px = p[2 * ci], py = p[2 * ci + 1], acc = 0, k = ci;
    while (k < path.n - 1 && acc < LOOKAHEAD) {
      const nx = p[2 * k + 2], ny = p[2 * k + 3];
      acc += Math.sqrt((nx - px) * (nx - px) + (ny - py) * (ny - py));
      px = nx; py = ny; k++;
    }
    const dx = px - x, dy = py - y, len = Math.sqrt(dx * dx + dy * dy);
    let s = 0;
    if (len > 0.3) {
      if (jitter > 0 && tick % 15 === 0) jit = (rng() * 2 - 1) * jitter;
      const al = wrapPi(atan2q(dy, dx) - a + jit);
      s = al > HALF_PI ? 1 : al < -HALF_PI ? -1 : (2 * sinq(al) * T.radius) / len;
      if (puddle && zone !== null && (m.x - zone.x - zone.w / 2) * (m.x - zone.x - zone.w / 2) + (m.y - zone.y - zone.h / 2) * (m.y - zone.y - zone.h / 2) <= (zone.w / 2) * (zone.w / 2)) s *= 2;
      s = s > 1 ? 1 : s < -1 ? -1 : s;
    }
    out.steer = Math.round(32 * s * (flip ? -1 : 1));
    out.slow = 0;
    return out;
  }

  return planner;
}

// Drives a whole lap headlessly. `opts.rink` reuses a built rink; the lap ends at the buzzer, when the
// planner has nothing left, or at maxTicks.
export function runBot(seed, name, opts) {
  const o = opts || {};
  const rink = o.rink || createRink(seed);
  const timed = o.timed !== false;
  const sim = createSim(rink, { timed });
  const planner = makePlanner(name, rink, o);
  const maxTicks = o.maxTicks > 0 ? Math.floor(o.maxTicks) : timed ? rink.tune.clockTicks + 60 : 30000;
  while (sim.ended === null && sim.tick < maxTicks) {
    const c = planner.control(sim);
    sim.step(c.steer, c.slow);
    if (planner.done) break;
  }
  if (sim.ended === null) sim.finish();
  return { result: sim.result('auto', rink.seed), ticks: sim.tick };
}
