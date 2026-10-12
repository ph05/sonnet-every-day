// Between Periods: the simulation core. Pure: no browser globals, no unseeded randomness, no clock.
// Trig is polynomial and everything else is + - * / sqrt (exactly rounded in IEEE-754), so one
// seed and one input stream give bit-identical results in every JavaScript engine.

export const TICK_HZ = 60;
export const MISHAPS = ['hats', 'drip', 'slush', 'gate', 'puddle'];
export const GRADES = ['D', 'C', 'B', 'A', 'S'];

// Game-scale numbers. Everything here is invented; none of it is a real machine's figure.
export const TUNING = Object.freeze({
  tickHz: TICK_HZ,
  swath: 8, radius: 10, body: 4.5, speed: 21,
  slowMul: 0.5, doorMul: 0.4, slushMul: 0.6, bumpMul: 0.6,
  tankMax: 100, waterPerFt: 1 / 8, refillPerSec: 45, dripPerSec: 0.6, dripStart: 85, lowTank: 25,
  clockTicks: 9000, cell: 0.5, reachDepth: 1, freeOverlap: 0.1,
  bands: Object.freeze({ S: 900, A: 780, B: 620, C: 450 }),
  bumpPenalty: 6, bumpCap: 60,
  doorW: 16, doorH: 14,
});

const DT = 1 / TICK_HZ;
const PI = 3.141592653589793;
const TWO_PI = 6.283185307179586;
const HALF_PI = 1.5707963267948966;
const QUARTER_PI = 0.7853981633974483;
const CX = 100, CY = 42.5, HX = 100, HY = 42.5, CORNER = 28;
const FRESH_CAP = 4096;

// ---- hashing and randomness -------------------------------------------------------------

export function hashSeed(s) {
  s = String(s);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mulberry32(a) {
  a = a >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- polynomial trig (Taylor to x^13 on [-pi/2, pi/2]: error below 1e-9) -----------------

const S3 = -1 / 6, S5 = 1 / 120, S7 = -1 / 5040, S9 = 1 / 362880, S11 = -1 / 39916800, S13 = 1 / 6227020800;

export function sinq(x) {
  if (x > PI || x < -PI) x -= TWO_PI * Math.floor(x / TWO_PI + 0.5);
  if (x > HALF_PI) x = PI - x;
  else if (x < -HALF_PI) x = -PI - x;
  const x2 = x * x;
  return x * (1 + x2 * (S3 + x2 * (S5 + x2 * (S7 + x2 * (S9 + x2 * (S11 + x2 * S13))))));
}

export function cosq(x) {
  return sinq(x + HALF_PI);
}

const A3 = -1 / 3, A5 = 1 / 5, A7 = -1 / 7, A9 = 1 / 9, A11 = -1 / 11, A13 = 1 / 13, A15 = -1 / 15;
const TAN_EIGHTH_PI = 0.41421356237309503;

// atan on [0, 1]; above tan(pi/8) the identity atan(r) = pi/4 - atan((1-r)/(1+r)) keeps the series short.
function atanUnit(r) {
  let z = r, off = 0, sgn = 1;
  if (r > TAN_EIGHTH_PI) {
    z = (1 - r) / (1 + r);
    off = QUARTER_PI;
    sgn = -1;
  }
  const z2 = z * z;
  return off + sgn * z * (1 + z2 * (A3 + z2 * (A5 + z2 * (A7 + z2 * (A9 + z2 * (A11 + z2 * (A13 + z2 * A15)))))));
}

export function atan2q(y, x) {
  const ax = x < 0 ? -x : x;
  const ay = y < 0 ? -y : y;
  if (ax === 0 && ay === 0) return 0;
  let a = ay > ax ? HALF_PI - atanUnit(ax / ay) : atanUnit(ay / ax);
  if (x < 0) a = PI - a;
  return y < 0 ? -a : a;
}

export function wrapPi(x) {
  return x - TWO_PI * Math.floor((x + PI) / TWO_PI);
}

// ---- rink geometry -------------------------------------------------------------------------

// Signed distance inside the rounded-rectangle boards: positive inside, feet from the boards.
export function boardDepth(x, y) {
  const qx = (x < CX ? CX - x : x - CX) - (HX - CORNER);
  const qy = (y < CY ? CY - y : y - CY) - (HY - CORNER);
  const px = qx > 0 ? qx : 0;
  const py = qy > 0 ? qy : 0;
  const m = qx > qy ? qx : qy;
  return CORNER - (Math.sqrt(px * px + py * py) + (m < 0 ? m : 0));
}

export function outlineLength(hx, hy, rc) {
  return 4 * (hx - rc) + 4 * (hy - rc) + TWO_PI * rc;
}

// Point and heading at arc length s along a rounded rectangle (half extents hx, hy, corner rc > 0)
// centred on the rink, walked clockwise on screen from the left end of its top edge.
export function outlinePoint(hx, hy, rc, s, out) {
  const ax = 2 * (hx - rc), ay = 2 * (hy - rc), arc = HALF_PI * rc;
  const total = 2 * ax + 2 * ay + 4 * arc;
  s -= total * Math.floor(s / total);
  let x, y, a, f;
  if (s < ax) {
    x = CX - (hx - rc) + s; y = CY - hy; a = 0;
  } else if ((s -= ax) < arc) {
    f = s / rc; x = CX + hx - rc + rc * sinq(f); y = CY - hy + rc - rc * cosq(f); a = f;
  } else if ((s -= arc) < ay) {
    x = CX + hx; y = CY - (hy - rc) + s; a = HALF_PI;
  } else if ((s -= ay) < arc) {
    f = s / rc; x = CX + hx - rc + rc * cosq(f); y = CY + hy - rc + rc * sinq(f); a = HALF_PI + f;
  } else if ((s -= arc) < ax) {
    x = CX + (hx - rc) - s; y = CY + hy; a = PI;
  } else if ((s -= ax) < arc) {
    f = s / rc; x = CX - hx + rc - rc * sinq(f); y = CY + hy - rc + rc * cosq(f); a = PI + f;
  } else if ((s -= arc) < ay) {
    x = CX - hx; y = CY + (hy - rc) - s; a = PI + HALF_PI;
  } else {
    f = (s - ay) / rc; x = CX - hx + rc - rc * cosq(f); y = CY - hy + rc - rc * sinq(f); a = PI + HALF_PI + f;
  }
  out.x = x; out.y = y; out.a = a;
  return out;
}

function makeMarks() {
  return {
    redX: 100, blueX: [75, 125], goalX: [11, 189],
    dots: [[100, 42.5], [80, 20.5], [80, 64.5], [120, 20.5], [120, 64.5], [31, 20.5], [31, 64.5], [169, 20.5], [169, 64.5]],
    circleR: 15, centerR: 15,
    creases: [{ x: 11, y: 42.5, r: 6, dir: 1 }, { x: 189, y: 42.5, r: 6, dir: -1 }],
    // A net lies behind its goal line: it spans x - dir*d .. x.
    nets: [{ x: 11, y: 42.5, w: 6, d: 3.3, dir: 1 }, { x: 189, y: 42.5, w: 6, d: 3.3, dir: -1 }],
  };
}

// The rink for a seed: wear map, reach mask, refill door, start pose and one mishap. Pure.
export function createRink(seed) {
  seed = String(seed);
  const T = TUNING;
  const id = hashSeed(seed);
  const rng = mulberry32((id ^ 0x9e3779b9) >>> 0);
  const cols = 400, rows = 170, cells = cols * rows;
  const cell = T.cell;
  const reach = new Uint8Array(cells);
  const scar = new Uint8Array(cells);
  // The rink is symmetric about both axes, so one quadrant of cells is measured and mirrored.
  let reachTotal = 0;
  for (let r = 0; r < rows / 2; r++) {
    const y = (r + 0.5) * cell;
    for (let c = 0; c < cols / 2; c++) {
      if (boardDepth((c + 0.5) * cell, y) >= T.reachDepth) {
        reach[r * cols + c] = 1;
        reach[r * cols + cols - 1 - c] = 1;
        reach[(rows - 1 - r) * cols + c] = 1;
        reach[(rows - 1 - r) * cols + cols - 1 - c] = 1;
        reachTotal += 4;
      }
    }
  }
  const marks = makeMarks();

  // Door on a long board, at least 12 ft from either corner arc. A jammed gate pushes it to one end.
  const mishapId = MISHAPS[Math.floor(rng() * MISHAPS.length)];
  const top = rng() < 0.5;
  const dLo = 28 + 12 + T.doorW / 2, dHi = 172 - 12 - T.doorW / 2;
  let dx;
  if (mishapId === 'gate') dx = rng() < 0.5 ? dLo + rng() * 6 : dHi - rng() * 6;
  else dx = dLo + rng() * (dHi - dLo);
  dx = Math.round(dx * 2) / 2;
  const dy = top ? T.doorH / 2 : 85 - T.doorH / 2;
  const door = { x: dx, y: dy, w: T.doorW, h: T.doorH, nx: 0, ny: top ? 1 : -1 };
  const start = { x: dx, y: dy, a: top ? HALF_PI : -HALF_PI };

  // Wear. `count` is the number of scarred cells; wear stops at `cap` and is topped up to `floor`.
  const cap = Math.min(7000, Math.floor(0.115 * reachTotal));
  const floorCount = Math.max(2000, Math.ceil(0.055 * reachTotal));
  let count = 0;
  const put = (i, k) => {
    if (reach[i] === 1 && scar[i] === 0) {
      scar[i] = k;
      count++;
    }
  };
  const disc = (x, y, rad, k) => {
    if (count >= cap) return;
    const c0 = Math.max(0, Math.floor((x - rad) / cell)), c1 = Math.min(cols - 1, Math.floor((x + rad) / cell));
    const r0 = Math.max(0, Math.floor((y - rad) / cell)), r1 = Math.min(rows - 1, Math.floor((y + rad) / cell));
    const r2 = rad * rad;
    for (let r = r0; r <= r1; r++) {
      const ddy = (r + 0.5) * cell - y;
      for (let c = c0; c <= c1; c++) {
        const ddx = (c + 0.5) * cell - x;
        if (ddx * ddx + ddy * ddy <= r2) put(r * cols + c, k);
      }
    }
  };
  const ellipse = (x, y, ra, rb, ang, k) => {
    if (count >= cap) return;
    const ca = cosq(ang), sa = sinq(ang), rad = ra > rb ? ra : rb;
    const c0 = Math.max(0, Math.floor((x - rad) / cell)), c1 = Math.min(cols - 1, Math.floor((x + rad) / cell));
    const r0 = Math.max(0, Math.floor((y - rad) / cell)), r1 = Math.min(rows - 1, Math.floor((y + rad) / cell));
    for (let r = r0; r <= r1; r++) {
      const ddy = (r + 0.5) * cell - y;
      for (let c = c0; c <= c1; c++) {
        const ddx = (c + 0.5) * cell - x;
        const u = ddx * ca + ddy * sa, v = ddy * ca - ddx * sa;
        if ((u * u) / (ra * ra) + (v * v) / (rb * rb) <= 1) put(r * cols + c, k);
      }
    }
  };
  const groove = (x, y, h, curv, len, rad) => {
    const n = Math.ceil(len / 0.25);
    for (let i = 0; i < n; i++) {
      disc(x, y, rad, 1);
      x += cosq(h) * 0.25;
      y += sinq(h) * 0.25;
      h += curv * 0.25;
    }
  };
  const an = { x: 0, y: 0, a: 0 };
  // Wear clusters on the boards, the nine spots, the creases and the centre circle.
  const pick = () => {
    const r = rng();
    if (r < 0.3) {
      const ins = 1.5 + rng() * 3;
      const hx = HX - ins, hy = HY - ins, rc = CORNER - ins;
      outlinePoint(hx, hy, rc, rng() * outlineLength(hx, hy, rc), an);
    } else if (r < 0.55) {
      const d = marks.dots[Math.floor(rng() * 9)], rad = rng() * 7, t = rng() * TWO_PI;
      an.x = d[0] + rad * cosq(t); an.y = d[1] + rad * sinq(t); an.a = rng() * TWO_PI;
    } else if (r < 0.75) {
      const cr = marks.creases[rng() < 0.5 ? 0 : 1];
      an.x = cr.x + cr.dir * rng() * 9; an.y = CY + (rng() * 2 - 1) * 9; an.a = rng() * TWO_PI;
    } else if (r < 0.87) {
      const t = rng() * TWO_PI, rad = marks.centerR + (rng() * 2 - 1) * 2.5;
      an.x = CX + rad * cosq(t); an.y = CY + rad * sinq(t); an.a = t + HALF_PI;
    } else {
      an.x = 12 + rng() * 176; an.y = 7 + rng() * 71; an.a = rng() * TWO_PI;
    }
    return an;
  };

  const nGroove = 24 + Math.floor(rng() * 11);
  const nDivot = 36 + Math.floor(rng() * 17);
  const nRidge = 5 + Math.floor(rng() * 5);
  for (let i = 0; i < nGroove; i++) {
    const p = pick();
    const len = 10 + rng() * 28;
    const rad = rng() < 0.45 ? 0.55 : 0.3;
    const sign = rng() < 0.5 ? -1 : 1;
    const curv = rng() < 0.35 ? sign * (0.08 + rng() * 0.12) : (rng() * 2 - 1) * 0.04;
    groove(p.x, p.y, p.a, curv, len, rad);
  }
  for (let i = 0; i < nDivot; i++) {
    const p = pick();
    disc(p.x + (rng() * 2 - 1) * 1.5, p.y + (rng() * 2 - 1) * 1.5, 1 + rng() * 1.5, 2);
  }
  for (let i = 0; i < nRidge; i++) {
    const ins = 2.5 + rng() * 2.5;
    const hx = HX - ins, hy = HY - ins, rc = CORNER - ins;
    outlinePoint(hx, hy, rc, rng() * outlineLength(hx, hy, rc), an);
    ellipse(an.x, an.y, 3 + rng() * 3.5, 1 + rng() * 1.2, an.a, 3);
  }

  // The mishap. Hats are wear on top of wear; the others are zones or rules the sim reads.
  let zone = null;
  const items = [];
  if (mishapId === 'hats') {
    const n = 12 + Math.floor(rng() * 7);
    const ox = 35 + rng() * 130, oy = 18 + rng() * 49;
    for (let i = 0; i < n; i++) {
      const rad = 14 * Math.sqrt(rng()), t = rng() * TWO_PI;
      let hx = ox + rad * cosq(t), hy = oy + rad * sinq(t);
      for (let g = 0; g < 8 && boardDepth(hx, hy) < 3.5; g++) {
        hx += (CX - hx) * 0.25; hy += (CY - hy) * 0.25;
      }
      items.push({ x: Math.round(hx * 10) / 10, y: Math.round(hy * 10) / 10, a: Math.round(rng() * TWO_PI * 100) / 100, k: Math.floor(rng() * 4) });
    }
  } else if (mishapId === 'slush') {
    zone = { x: Math.round(50 + rng() * 100) - 15, y: Math.round(22 + rng() * 41) - 7, w: 30, h: 14 };
  } else if (mishapId === 'puddle') {
    zone = { x: Math.round(45 + rng() * 110) - 9, y: Math.round(24 + rng() * 37) - 9, w: 18, h: 18 };
  }

  // Top up the wear so every seed lands inside the 5 to 12 percent band, then drop the hats on top.
  for (let guard = 0; count < floorCount && guard < 800; guard++) {
    const p = pick();
    disc(p.x, p.y, 1.5 + rng() * 1.3, 2);
  }
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const rad = 0.9, c0 = Math.floor((it.x - rad) / cell), c1 = Math.floor((it.x + rad) / cell);
    const r0 = Math.floor((it.y - rad) / cell), r1 = Math.floor((it.y + rad) / cell);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const ddx = (c + 0.5) * cell - it.x, ddy = (r + 0.5) * cell - it.y;
        if (r >= 0 && r < rows && c >= 0 && c < cols && ddx * ddx + ddy * ddy <= rad * rad && reach[r * cols + c] === 1) scar[r * cols + c] = 4;
      }
    }
  }
  let scarTotal = 0;
  for (let i = 0; i < cells; i++) if (scar[i] !== 0) scarTotal++;

  return {
    seed, id, w: 200, h: 85, cornerR: CORNER, cell, cols, rows,
    marks, door, start,
    mishap: { id: mishapId, zone, items },
    scar, reach, scarTotal, reachTotal,
    tune: { swath: T.swath, radius: T.radius, body: T.body, tankMax: T.tankMax, clockTicks: T.clockTicks, tickHz: TICK_HZ },
  };
}

// ---- the simulation ------------------------------------------------------------------------

function fnvMix(h, v) {
  v |= 0;
  h = Math.imul(h ^ (v & 255), 16777619);
  h = Math.imul(h ^ ((v >>> 8) & 255), 16777619);
  h = Math.imul(h ^ ((v >>> 16) & 255), 16777619);
  return Math.imul(h ^ ((v >>> 24) & 255), 16777619);
}

export function createSim(rink, opts) {
  const T = TUNING;
  const timed = !!(opts && opts.timed);
  const { cols, rows, scar, door } = rink;
  const cells = cols * rows;
  const mishapId = rink.mishap.id;
  const zone = rink.mishap.zone;
  const done = new Uint8Array(cells);
  const touch = new Int32Array(cells);
  const fresh = { idx: new Int32Array(FRESH_CAP), n: 0 };
  const m = {
    x: rink.start.x, y: rink.start.y, a: rink.start.a, speed: 0, steer: 0,
    tank: mishapId === 'drip' ? T.dripStart : T.tankMax, door: true, dry: false, contact: false,
  };
  const halfW = door.w / 2, halfH = door.h / 2;
  const clockTicks = rink.tune.clockTicks;
  const lowTank = T.lowTank, half = T.swath / 2;
  const scarTotal = rink.scarTotal;
  // A zone is a rectangle from its top-left corner (x, y); the puddle is the circle inscribed in it.
  const inZone = (x, y) => zone !== null && x >= zone.x && x <= zone.x + zone.w && y >= zone.y && y <= zone.y + zone.h;
  const inPud = (x, y) => {
    if (zone === null) return false;
    const dx = x - (zone.x + zone.w / 2), dy = y - (zone.y + zone.h / 2);
    return dx * dx + dy * dy <= (zone.w / 2) * (zone.w / 2);
  };

  let tick = 0, ended = null;
  let fixed = 0, gleamCells = 0, bumps = 0, refills = 0, cleanLaps = 0, feetAcc = 0, calm = 20;
  let inDoor = true, armed = false, inVisit = false, visitActive = false, visitDone = false, visitAdded = 0;
  let inSlush = mishapId === 'slush' && inZone(m.x, m.y);
  let inPuddle = mishapId === 'puddle' && inPud(m.x, m.y);
  let lowArmed = true, emptyArmed = true;
  let lx = -sinq(m.a), ly = cosq(m.a);
  let runTicks = 0, runMarked = 0, runFresh = 0, runWet = true, runId = 1;

  // The route, one point per `routeStep` ticks; when full it thins itself by half so a long practice
  // lap still fits in 3000 points.
  const route = new Int16Array(6000);
  let routeN = 0, routeStep = 12;

  const sim = { rink, grid: { cols, rows, cell: rink.cell, scar, reach: rink.reach, done }, m, tick: 0, ended: null, fresh };

  function recordRoute(force) {
    if (!force && tick % routeStep !== 0) return;
    if (routeN >= 3000) {
      let w = 0;
      for (let i = 0; i < routeN; i += 2) {
        route[2 * w] = route[2 * i];
        route[2 * w + 1] = route[2 * i + 1];
        w++;
      }
      routeN = w;
      routeStep *= 2;
      if (!force && tick % routeStep !== 0) return;
    }
    route[2 * routeN] = Math.round(m.x * 10);
    route[2 * routeN + 1] = Math.round(m.y * 10);
    routeN++;
  }
  recordRoute(true);

  function endRun() {
    if (runTicks >= 180 && runWet && runMarked > 0 && runFresh * 100 >= 85 * runMarked) cleanLaps++;
    runTicks = 0; runMarked = 0; runFresh = 0; runWet = true; runId++;
  }

  function stop(reason) {
    ended = reason;
    sim.ended = reason;
    endRun();
    recordRoute(true);
  }

  sim.step = function step(steerIn, slowIn) {
    if (ended !== null) return 0;
    let flags = 0;
    let st = steerIn;
    if (st !== st) st = 0;
    st = st > 32 ? 32 : st < -32 ? -32 : Math.round(st);

    let mul = slowIn ? T.slowMul : 1;
    if (inDoor && T.doorMul < mul) mul = T.doorMul;
    if (inSlush && T.slushMul < mul) mul = T.slushMul;
    if (m.contact && T.bumpMul < mul) mul = T.bumpMul;
    const v = T.speed * mul;
    const ds = v * DT;
    const x0 = m.x, y0 = m.y;

    let a = m.a + ((st / 32) * (inPuddle ? 0.5 : 1) * ds) / T.radius;
    if (a > PI) a -= TWO_PI;
    else if (a <= -PI) a += TWO_PI;
    let x = x0 + cosq(a) * ds;
    let y = y0 + sinq(a) * ds;

    // Boards: slide along them, never stop. A bump is a contact that starts after 20 calm ticks.
    const depth = boardDepth(x, y);
    const touching = depth < T.body;
    if (touching) {
      const qx = (x < CX ? CX - x : x - CX) - (HX - CORNER);
      const qy = (y < CY ? CY - y : y - CY) - (HY - CORNER);
      const px = qx > 0 ? qx : 0, py = qy > 0 ? qy : 0;
      let gx, gy;
      if (px > 0 || py > 0) {
        const l = Math.sqrt(px * px + py * py);
        gx = (x < CX ? -px : px) / l;
        gy = (y < CY ? -py : py) / l;
      } else if (qx > qy) {
        gx = x < CX ? -1 : 1; gy = 0;
      } else {
        gx = 0; gy = y < CY ? -1 : 1;
      }
      const push = T.body - depth;
      x -= gx * push;
      y -= gy * push;
      if (!m.contact && calm >= 20) {
        bumps++;
        flags |= 1;
      }
      calm = 0;
    } else if (calm < 1000) {
      calm++;
    }
    m.contact = touching;
    m.x = x; m.y = y; m.a = a; m.speed = v; m.steer = st;

    // Stripe: sub-poses at most 0.25 ft apart, 33 cells across. Wet ice glosses, a dry pass only shaves.
    const dx = x - x0, dy = y - y0;
    const len = Math.sqrt(dx * dx + dy * dy);
    let n = Math.ceil(len / 0.25);
    if (n < 1) n = 1;
    const nlx = -sinq(a), nly = cosq(a);
    const wet = m.tank > 0;
    const straight = st <= 6 && st >= -6;
    if (!wet) runWet = false;
    // Hot loop: work on locals, not closure slots, and write the counters back once.
    const D = done, TC = touch, SC = scar, W = cols, H = rows, fidx = fresh.idx, rid = runId;
    let gc = gleamCells, fx = fixed, rm = runMarked, rf = runFresh, fn = fresh.n;
    for (let i = 1; i <= n; i++) {
      const f = i / n;
      const ux = lx + (nlx - lx) * f, uy = ly + (nly - ly) * f;
      const sx = ux * 0.25, sy = uy * 0.25;
      let cx = x0 + dx * f - ux * half, cy = y0 + dy * f - uy * half;
      for (let j = 0; j < 33; j++, cx += sx, cy += sy) {
        if (cx < 0 || cy < 0) continue;
        const col = (cx * 2) | 0, row = (cy * 2) | 0;
        if (col >= W || row >= H) continue;
        const c = row * W + col;
        const d = D[c];
        if (straight && TC[c] !== rid) {
          TC[c] = rid;
          rm++;
          if (d === 0) rf++;
        }
        if (wet) {
          if (d !== 2) {
            D[c] = 2;
            gc++;
            if (SC[c] !== 0) fx++;
            if (fn >= 0) {
              if (fn < FRESH_CAP) fidx[fn++] = c;
              else fn = -1;
            }
          }
        } else if (d === 0) {
          D[c] = 1;
          if (fn >= 0) {
            if (fn < FRESH_CAP) fidx[fn++] = c;
            else fn = -1;
          }
        }
      }
    }
    gleamCells = gc; fixed = fx; runMarked = rm; runFresh = rf; fresh.n = fn;
    lx = nlx; ly = nly;
    feetAcc += len;
    if (straight) runTicks++;
    else endRun();

    // Water: spent by distance (and a leak), refilled in the door once the machine has rolled out of it.
    let tank = m.tank - len * T.waterPerFt;
    if (mishapId === 'drip') tank -= T.dripPerSec * DT;
    if (tank < 0) tank = 0;
    const nowDoor = Math.abs(x - door.x) <= halfW && Math.abs(y - door.y) <= halfH;
    if (!nowDoor) armed = true;
    if (nowDoor && armed) {
      if (!inVisit) {
        inVisit = true; visitAdded = 0; visitDone = false;
        visitActive = tank < T.tankMax - 5;
        if (visitActive) flags |= 2;
      }
      const room = T.tankMax - tank, add = T.refillPerSec * DT;
      if (room <= add) { tank = T.tankMax; visitAdded += room; } else { tank += add; visitAdded += add; }
      if (visitActive && !visitDone && tank >= T.tankMax) {
        visitDone = true;
        refills++;
        flags |= 4;
      }
    } else if (inVisit) {
      inVisit = false;
      if (visitActive && !visitDone && visitAdded >= 20) {
        refills++;
        flags |= 4;
      }
    }
    m.tank = tank;
    m.dry = tank <= 0;
    m.door = nowDoor;
    inDoor = nowDoor;
    if (mishapId === 'slush') inSlush = inZone(x, y);
    else if (mishapId === 'puddle') inPuddle = inPud(x, y);

    if (tank < lowTank) {
      if (lowArmed) { lowArmed = false; flags |= 8; }
    } else if (tank > 40) lowArmed = true;
    if (tank <= 0) {
      if (emptyArmed) { emptyArmed = false; flags |= 16; }
    } else if (tank > 5) emptyArmed = true;

    tick++;
    sim.tick = tick;
    recordRoute(false);
    if (scarTotal > 0 && Math.round((1000 * fixed) / scarTotal) >= 995) stop('complete');
    else if (timed && tick >= clockTicks) stop('buzzer');
    if (ended !== null) flags |= 32;
    return flags;
  };

  function stats(out) {
    const o = out || {};
    const cov = scarTotal > 0 ? fixed / scarTotal : 1;
    const gleamArea = gleamCells * T.cell * T.cell;
    const feet = Math.round(feetAcc);
    const tidyPct = feetAcc < 20 ? 100 : Math.round(100 * Math.min(1, gleamArea / (feetAcc * T.swath * (1 - T.freeOverlap))));
    const timeBonus = timed && cov >= 0.9 ? Math.round((100 * Math.max(0, clockTicks - tick)) / clockTicks) : 0;
    let points = Math.round(1000 * cov * Math.sqrt(cov) * (0.8 + (0.2 * tidyPct) / 100)) + timeBonus - Math.min(T.bumpCap, T.bumpPenalty * bumps);
    points = points < 0 ? 0 : points > 1000 ? 1000 : points;
    o.gleamPct = Math.round(1000 * cov) / 10;
    o.left = scarTotal - fixed;
    o.feet = feet;
    o.tidyPct = tidyPct;
    o.refills = refills;
    o.bumps = bumps;
    o.cleanLaps = cleanLaps;
    o.points = points;
    o.grade = points >= T.bands.S ? 'S' : points >= T.bands.A ? 'A' : points >= T.bands.B ? 'B' : points >= T.bands.C ? 'C' : 'D';
    return o;
  }
  sim.stats = stats;

  sim.finish = function finish() {
    if (ended === null) stop('finish');
  };

  sim.result = function result(mode, seed) {
    const s = stats();
    s.seed = seed === undefined ? rink.seed : String(seed);
    s.mode = mode === 'practice' || mode === 'auto' ? mode : 'timed';
    s.reason = ended === null ? 'finish' : ended;
    s.ticks = tick;
    s.seconds = Math.round(tick / 6) / 10;
    s.route = route.slice(0, 2 * routeN);
    s.beat = null;
    return s;
  };

  sim.clearFresh = function clearFresh() {
    fresh.n = 0;
  };

  // 24 points, one per 5 ticks of travel, with the steer held constant at its current speed.
  sim.predict = function predict(steer, out) {
    const v = m.speed > 0 ? m.speed : T.speed, ds = v * DT;
    const da = ((steer / 32) * ds) / T.radius;
    let x = m.x, y = m.y, a = m.a;
    for (let i = 0; i < 24; i++) {
      for (let j = 0; j < 5; j++) {
        a += da;
        if (a > PI) a -= TWO_PI;
        else if (a <= -PI) a += TWO_PI;
        x += cosq(a) * ds;
        y += sinq(a) * ds;
      }
      out[2 * i] = x;
      out[2 * i + 1] = y;
    }
    return 24;
  };

  sim.digest = function digest() {
    let h = 0x811c9dc5;
    h = fnvMix(h, tick);
    h = fnvMix(h, Math.round(m.x * 1e5));
    h = fnvMix(h, Math.round(m.y * 1e5));
    h = fnvMix(h, Math.round(m.a * 1e6));
    h = fnvMix(h, Math.round(m.tank * 1e5));
    h = fnvMix(h, bumps);
    h = fnvMix(h, refills);
    h = fnvMix(h, fixed);
    h = fnvMix(h, gleamCells);
    h = fnvMix(h, cleanLaps);
    h = fnvMix(h, Math.round(feetAcc * 1000));
    h = fnvMix(h, ended === null ? 0 : 1);
    for (let i = 0; i < cells; i++) h = Math.imul(h ^ done[i], 16777619);
    return (h >>> 0).toString(16).padStart(8, '0');
  };

  return sim;
}
