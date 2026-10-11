// Orbit engine: two-body motion plus the secular J2 terms, the mean sun and the repeat-track finder.
// Pure maths, no DOM. Angles are degrees at every exported boundary, radians only inside functions.

export const EARTH_KM = 6378.137;
export const MU = 398600.4418;
export const J2 = 1.08263e-3;
export const SIDEREAL_DEG_DAY = 360.9856;
export const SUN_DEG_DAY = 360 / 365.2422;
export const OBLIQUITY_DEG = 23.4393;
export const KM_PER_DEG = EARTH_KM * Math.PI / 180;
export const EQUATOR_KM = 2 * Math.PI * EARTH_KM;
export const MAX_APOGEE_KM = 60000;

export const RANGES = Object.freeze({
  alt: Object.freeze({ min: 200, max: 2000, step: 1 }),
  inc: Object.freeze({ min: 0, max: 180, step: 0.05 }),
  ecc: Object.freeze({ min: 0, max: 0.8, step: 0.005 }),
  node: Object.freeze({ min: -180, max: 180, step: 0.5 }),
  argp: Object.freeze({ min: 0, max: 360, step: 1 }),
  swath: Object.freeze({ min: 110, max: 1500, step: 5 }),
  season: Object.freeze({ min: 0, max: 364, step: 1 }),
});

// Needle A and needle B of the free-knit scene; any other needle falls back to needle B's values.
export const DEFAULT_SATS = Object.freeze([
  Object.freeze({ alt: 700, inc: 98.19, ecc: 0, node: -22.5, argp: 0, swath: 185 }),
  Object.freeze({ alt: 420, inc: 51.6, ecc: 0, node: 60, argp: 0, swath: 400 }),
]);

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const TWO_PI = 2 * Math.PI;
const DAY_S = 86400;
const SIDEREAL_RAD_S = SIDEREAL_DEG_DAY * D2R / DAY_S;
const SUN_RAD_S = SUN_DEG_DAY * D2R / DAY_S;
const SIN_OBL = Math.sin(OBLIQUITY_DEG * D2R);
const COS_OBL = Math.cos(OBLIQUITY_DEG * D2R);
const SAT_KEYS = ['alt', 'inc', 'ecc', 'node', 'argp', 'swath'];
const MAX_TICKS = 400;
const REPEAT_WINDOW_KM = 0.6;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const wrapLon = (deg) => deg - 360 * Math.floor((deg + 180) / 360);
// Circular quantities that left their slider range are wrapped; values inside stay put, so a slider
// dragged to its end does not jump to the other end.
const wrapInto = (v, min, max) => (v >= min && v <= max ? v : v - 360 * Math.floor((v - min) / 360));

function asNumber(raw) {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string' && raw.trim() !== '') return Number(raw);
  return Number.NaN;
}

export function normalizeSat(sat, locks) {
  const src = sat !== null && typeof sat === 'object' ? sat : {};
  const notes = [];
  const out = {};
  for (const key of SAT_KEYS) {
    const range = RANGES[key];
    let v = asNumber(src[key]);
    if (!Number.isFinite(v)) v = DEFAULT_SATS[0][key];
    if (key === 'node' || key === 'argp') {
      v = wrapInto(v, range.min, range.max);
    } else {
      const c = clamp(v, range.min, range.max);
      if (key === 'alt' && c !== v) notes.push('perigee-clamped');
      v = c;
    }
    out[key] = v;
  }
  const apogeeKm = (EARTH_KM + out.alt) * (1 + out.ecc) / (1 - out.ecc) - EARTH_KM;
  if (apogeeKm > MAX_APOGEE_KM) {
    const q = (MAX_APOGEE_KM + EARTH_KM) / (EARTH_KM + out.alt);
    out.ecc = Math.floor((q - 1) / (q + 1) * 1e3) / 1e3;
    notes.push('apogee-clamped');
  }
  if (locks && Number.isFinite(locks.swath) && out.swath !== locks.swath) {
    out.swath = locks.swath;
    notes.push('locked:swath');
  }
  return { sat: out, notes };
}

// Secular rates (rad/s) for a perigee altitude, cos(inclination) and eccentricity, written into `o`.
function secular(alt, cosI, e, o) {
  const a = (EARTH_KM + alt) / (1 - e);
  const p = a * (1 - e * e);
  const n = Math.sqrt(MU / (a * a * a));
  const q = EARTH_KM / p;
  const k = J2 * q * q;
  const c2 = cosI * cosI;
  o.a = a;
  o.n = n;
  o.k = k;
  o.dOmega = -1.5 * n * k * cosI;
  o.dw = 0.75 * n * k * (5 * c2 - 1);
  o.dM = n * (1 + 0.75 * k * Math.sqrt(1 - e * e) * (3 * c2 - 1));
  return o;
}

function buildElements(sat) {
  const inc = sat.inc * D2R;
  const el = {
    sat,
    ecc: sat.ecc,
    cosI: Math.cos(inc),
    sinI: Math.sin(inc),
    node0: sat.node * D2R,
    // A circular orbit has no perigee, so a leftover argument must not shift where the needle starts.
    argp0: sat.ecc > 1e-9 ? sat.argp * D2R : 0,
  };
  return secular(sat.alt, el.cosI, sat.ecc, el);
}

export function elements(sat) {
  return buildElements(normalizeSat(sat).sat);
}

// Newton iteration on Kepler's equation, starting at E = M (or pi for the most eccentric orbits).
function solveKepler(meanAnomaly, e) {
  let m = meanAnomaly % TWO_PI;
  if (m > Math.PI) m -= TWO_PI;
  else if (m < -Math.PI) m += TWO_PI;
  let E = e >= 0.8 ? (m < 0 ? -Math.PI : Math.PI) : m;
  for (let i = 0; i < 12; i++) {
    const step = (E - e * Math.sin(E) - m) / (1 - e * Math.cos(E));
    E -= step;
    if (Math.abs(step) < 1e-12) break;
  }
  return E;
}

export function makePoint() {
  return { lat: 0, lon: 0, altKm: 0, elevDeg: 0, x: 0, y: 0, z: 0 };
}

// Allocation-free propagation for the simulation loop: fills `out` (see makePoint) and returns it.
// x, y, z is the inertial unit vector of the sub-satellite direction.
export function propagateInto(el, day, season, out) {
  const s = DAY_S * day;
  const e = el.ecc;
  const meanAnomaly = el.dM * s;
  let nu = meanAnomaly;
  let r = el.a;
  if (e > 1e-9) {
    const E = solveKepler(meanAnomaly, e);
    nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
    r = el.a * (1 - e * Math.cos(E));
  }
  const gmst0 = SUN_DEG_DAY * season * D2R;
  const u = el.argp0 + el.dw * s + nu;
  const raan = el.node0 + gmst0 + el.dOmega * s;
  const cu = Math.cos(u);
  const su = Math.sin(u);
  const co = Math.cos(raan);
  const so = Math.sin(raan);
  const x = co * cu - so * su * el.cosI;
  const y = so * cu + co * su * el.cosI;
  const z = su * el.sinI;
  const lam = SUN_DEG_DAY * D2R * (season + day);
  const sl = Math.sin(lam);
  const dot = x * Math.cos(lam) + y * sl * COS_OBL + z * sl * SIN_OBL;
  out.lat = Math.asin(clamp(z, -1, 1)) * R2D;
  out.lon = wrapLon((Math.atan2(y, x) - gmst0 - SIDEREAL_DEG_DAY * D2R * day) * R2D);
  out.altKm = r - EARTH_KM;
  out.elevDeg = Math.asin(clamp(dot, -1, 1)) * R2D;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function propagate(el, day, season) {
  const known = el !== null && typeof el === 'object' && Number.isFinite(el.dM);
  const p = propagateInto(known ? el : elements(el), Number(day) || 0, Number(season) || 0, makePoint());
  return { lat: p.lat, lon: p.lon, altKm: p.altKm, elevDeg: p.elevDeg };
}

export function sunPoint(day, season) {
  const d = Number(day) || 0;
  const se = Number(season) || 0;
  const lam = SUN_DEG_DAY * D2R * (se + d);
  const sl = Math.sin(lam);
  const sy = sl * COS_OBL;
  const sz = sl * SIN_OBL;
  const theta = (SUN_DEG_DAY * se + SIDEREAL_DEG_DAY * d) * D2R;
  return { lat: Math.asin(clamp(sz, -1, 1)) * R2D, lon: wrapLon((Math.atan2(sy, Math.cos(lam)) - theta) * R2D) };
}

// Inclination at which the node regresses by one turn per year; null when no real tilt does it.
export function ssoInclination(altKm, ecc) {
  const s = normalizeSat({ alt: altKm, ecc }).sat;
  const o = secular(s.alt, 0, s.ecc, {});
  const c = -SUN_RAD_S / (1.5 * o.n * o.k);
  return Math.abs(c) <= 1 ? Math.acos(c) * R2D : null;
}

export function ltanHours(sat) {
  const node = normalizeSat(sat).sat.node;
  return (((12 + node / 15) % 24) + 24) % 24;
}

// Signed drift of the local solar time at the node after `days` (hours; negative means earlier).
export function ltDriftHours(sat, days) {
  const el = elements(sat);
  const d = Number.isFinite(days) ? days : 0;
  return (el.dOmega * R2D * DAY_S - SUN_DEG_DAY) * d / 15;
}

const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
// Tick lists depend only on tilt, shape and swath, so dragging the height slider never recomputes them.
const repeatMemo = new Map();

// Orbits per nodal day: the argument of latitude turns this often while the Earth turns once under the plane.
function revsPerDay(alt, cosI, ecc, scratch) {
  const o = secular(alt, cosI, ecc, scratch);
  return (o.dM + o.dw) / (SIDEREAL_RAD_S - o.dOmega);
}

export function findRepeats(sat, opts) {
  const s = normalizeSat(sat).sat;
  const o = opts && typeof opts === 'object' ? opts : {};
  const mMax = clamp(Math.floor(Number.isFinite(o.mMax) ? o.mMax : 16), 1, 40);
  const altMin = clamp(Number.isFinite(o.altMin) ? o.altMin : RANGES.alt.min, 100, 5000);
  const altMax = clamp(Number.isFinite(o.altMax) ? o.altMax : RANGES.alt.max, altMin + 1, 20000);
  const key = `${s.inc}|${s.ecc}|${s.swath}|${mMax}|${altMin}|${altMax}`;
  const memo = repeatMemo.get(key);
  if (memo) {
    repeatMemo.delete(key);
    repeatMemo.set(key, memo);
    return memo.slice();
  }
  const cosI = Math.cos(s.inc * D2R);
  const scratch = {};
  const fHigh = revsPerDay(altMin, cosI, s.ecc, scratch);
  const fLow = revsPerDay(altMax, cosI, s.ecc, scratch);
  const ticks = [];
  for (let m = 1; m <= mMax; m++) {
    const k0 = Math.max(1, Math.ceil(m * fLow - 1e-9));
    const k1 = Math.floor(m * fHigh + 1e-9);
    for (let k = k0; k <= k1; k++) {
      if (gcd(k, m) !== 1) continue;
      const target = k / m;
      let lo = altMin;
      let hi = altMax;
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (revsPerDay(mid, cosI, s.ecc, scratch) > target) lo = mid;
        else hi = mid;
      }
      const spacingKm = EQUATOR_KM / k;
      ticks.push({ alt: (lo + hi) / 2, k, m, spacingKm, tight: spacingKm <= s.swath });
    }
  }
  if (ticks.length > MAX_TICKS) {
    ticks.sort((a, b) => a.m - b.m || a.alt - b.alt);
    ticks.length = MAX_TICKS;
  }
  ticks.sort((a, b) => a.alt - b.alt);
  repeatMemo.set(key, ticks);
  if (repeatMemo.size > 8) repeatMemo.delete(repeatMemo.keys().next().value);
  return ticks.slice();
}

export function satInfo(sat) {
  const s = normalizeSat(sat).sat;
  const el = buildElements(s);
  const rate = el.dM + el.dw;
  const periodS = TWO_PI / rate;
  const nodeDrift = el.dOmega * R2D * DAY_S;
  let repeat = null;
  let nearest = REPEAT_WINDOW_KM;
  for (const t of findRepeats(s)) {
    const gap = Math.abs(t.alt - s.alt);
    if (gap <= nearest) {
      nearest = gap;
      repeat = { k: t.k, m: t.m, spacingKm: t.spacingKm };
    }
  }
  return {
    periodMin: periodS / 60,
    perigeeKm: s.alt,
    apogeeKm: el.a * (1 + s.ecc) - EARTH_KM,
    nodeDriftDegDay: nodeDrift,
    apsideDriftDegDay: el.dw * R2D * DAY_S,
    revsPerDay: rate / (SIDEREAL_RAD_S - el.dOmega),
    maxLatDeg: s.inc <= 90 ? s.inc : 180 - s.inc,
    shiftDegOrbit: (SIDEREAL_DEG_DAY - nodeDrift) * periodS / DAY_S,
    ltanH: ltanHours(s),
    isSunSync: Math.abs(nodeDrift - SUN_DEG_DAY) <= 0.02,
    ssoIncDeg: ssoInclination(s.alt, s.ecc),
    repeat,
  };
}

// [lon, lat] pairs, evenly spaced in time over [day0, day1], never denser than one point per 4 s.
export function sampleTrack(sat, season, day0, day1, maxPoints) {
  const el = elements(sat);
  const se = Number.isFinite(season) ? season : 0;
  let d0 = Number.isFinite(day0) ? day0 : 0;
  let d1 = Number.isFinite(day1) ? day1 : d0;
  if (d1 < d0) [d0, d1] = [d1, d0];
  const cap = clamp(Math.floor(Number.isFinite(maxPoints) ? maxPoints : 2), 1, 8192);
  const n = Math.max(1, Math.min(cap, Math.floor((d1 - d0) * DAY_S / 4) + 1));
  const out = new Float32Array(2 * n);
  const p = makePoint();
  for (let i = 0; i < n; i++) {
    propagateInto(el, n === 1 ? d0 : d0 + (d1 - d0) * i / (n - 1), se, p);
    out[2 * i] = p.lon;
    out[2 * i + 1] = p.lat;
  }
  return out;
}
