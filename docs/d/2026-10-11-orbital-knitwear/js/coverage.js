// Coverage simulation: a 1-degree grid of stitches, painted every 4 s of simulated time. Pure, no DOM.
import { KM_PER_DEG, makePoint, elements, propagateInto, sunPoint, ltDriftHours } from './orbit.js';

export const GRID_W = 360;
export const GRID_H = 180;
export const DT_S = 4;
export const PASS_GAP_DAYS = 1 / 72;

const CELLS = GRID_W * GRID_H;
const SAMPLES_PER_DAY = 86400 / DT_S;
const MIN_RHO_KM = 55.66;
const MAX_SATS = 3;
const MAX_TRAIL_POINTS = 600;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const EMPTY = new Float32Array(0);
const nowMs = typeof performance === 'object' && performance && typeof performance.now === 'function'
  ? () => performance.now()
  : () => Date.now();

const AREA = new Float64Array(GRID_H);
const ROW_SIN = new Float64Array(GRID_H);
const ROW_COS = new Float64Array(GRID_H);
for (let r = 0; r < GRID_H; r++) {
  AREA[r] = (Math.sin((90 - r) * D2R) - Math.sin((89 - r) * D2R)) / (2 * GRID_W);
  ROW_SIN[r] = Math.sin((89.5 - r) * D2R);
  ROW_COS[r] = Math.cos((89.5 - r) * D2R);
}

// Share of the whole sphere held by one cell of the given row (row 0 is the northmost).
export function cellAreaFraction(row) {
  return Number.isInteger(row) && row >= 0 && row < GRID_H ? AREA[row] : 0;
}

// Versions only ever grow, even across simulations, so a renderer can cache by version alone.
let versionCounter = 0;
const nextVersion = () => ++versionCounter;

export function createSim(sats, season, recycle) {
  const list = (Array.isArray(sats) ? sats : []).slice(0, MAX_SATS);
  const seasonDays = Number.isFinite(season) ? season : 0;
  const reuse = recycle && typeof recycle.takeBuffers === 'function' ? recycle.takeBuffers() : null;
  const hits = reuse ? reuse.hits.fill(0) : new Uint8Array(CELLS);
  const last = reuse ? reuse.last.fill(-1) : new Float32Array(CELLS).fill(-1);
  const owner = reuse ? reuse.owner.fill(0) : new Uint8Array(CELLS);
  const first = reuse ? reuse.first.fill(-1) : new Float32Array(CELLS).fill(-1);
  const rowCovered = reuse ? reuse.rowCovered.fill(0) : new Int32Array(GRID_H);
  const grid = { w: GRID_W, h: GRID_H, version: nextVersion(), hits, last, owner };

  const needles = list.map((sat, index) => {
    const el = elements(sat);
    const rhoKm = Math.max(el.sat.swath / 2, MIN_RHO_KM);
    return {
      index,
      el,
      rhoDeg: rhoKm / KM_PER_DEG,
      cosRho: Math.cos(rhoKm / KM_PER_DEG * D2R),
      periodDays: (2 * Math.PI / (el.dM + el.dw)) / 86400,
      pos: { lat: 0, lon: 0, altKm: 0 },
      trailBuf: new Float32Array(2 * MAX_TRAIL_POINTS),
      trailDay: -1,
      trailLen: 0,
    };
  });
  const point = makePoint();
  const trailPoint = makePoint();
  let j = 0;
  let clock = 0;
  let covered = 0;
  let samples = 0;
  let north = 0;
  let twilight = 0;
  let retired = false;

  // Paints every cell whose centre lies within the needle's swath radius of the sub-satellite point.
  function paint(nd, lat, lon, day) {
    const sinP = point.z;
    const cosP = Math.sqrt(Math.max(0, 1 - sinP * sinP));
    const r0 = Math.max(0, Math.ceil(89.5 - lat - nd.rhoDeg));
    const r1 = Math.min(GRID_H - 1, Math.floor(89.5 - lat + nd.rhoDeg));
    const id = nd.index + 1;
    for (let r = r0; r <= r1; r++) {
      const den = cosP * ROW_COS[r];
      const num = nd.cosRho - sinP * ROW_SIN[r];
      let c0 = 0;
      let count = GRID_W;
      if (den < 1e-12) {
        if (num > 0) continue;
      } else {
        const q = num / den;
        if (q > 1) continue;
        if (q > -1) {
          const dl = Math.acos(q) * R2D;
          const lo = Math.ceil(lon - dl + 179.5);
          count = Math.floor(lon + dl + 179.5) - lo + 1;
          if (count <= 0) continue;
          if (count >= GRID_W) count = GRID_W;
          else c0 = ((lo % GRID_W) + GRID_W) % GRID_W;
        }
      }
      const rowStart = r * GRID_W;
      let i = rowStart + c0;
      for (let n = 0; n < count; n++) {
        const seen = last[i];
        if (seen < 0) {
          hits[i] = 1;
          first[i] = day;
          rowCovered[r]++;
          covered++;
        } else if (day - seen > PASS_GAP_DAYS && hits[i] < 255) {
          hits[i]++;
        }
        last[i] = day;
        owner[i] = id;
        if (++i === rowStart + GRID_W) i = rowStart;
      }
    }
  }

  function sample(index) {
    const day = index / SAMPLES_PER_DAY;
    for (let n = 0; n < needles.length; n++) {
      const nd = needles[n];
      propagateInto(nd.el, day, seasonDays, point);
      samples++;
      if (point.lat >= 60) north++;
      if (point.elevDeg <= 6 && point.elevDeg >= -6) twilight++;
      nd.pos.lat = point.lat;
      nd.pos.lon = point.lon;
      nd.pos.altKm = point.altKm;
      paint(nd, point.lat, point.lon, day);
    }
  }

  sample(0);

  const sim = {
    day: 0,
    grid,
    season: seasonDays,
    count: needles.length,
    sats: needles.map((nd) => nd.el.sat),

    // Whole samples only. Time that the budget did not allow is dropped, never skipped over.
    advance(days, budgetMs) {
      const want = Math.min(Number(days), 400);
      if (retired || !(want > 0)) return 0;
      clock += want;
      const target = Math.floor(clock * SAMPLES_PER_DAY + 1e-6);
      const before = j;
      const timed = Number.isFinite(budgetMs) && budgetMs > 0;
      const t0 = timed ? nowMs() : 0;
      let spent = 0;
      while (j < target) {
        sample(++j);
        if (timed && (++spent & 31) === 0 && nowMs() - t0 >= budgetMs) break;
      }
      if (j < target) clock = j / SAMPLES_PER_DAY;
      if (j === before) return 0;
      sim.day = j / SAMPLES_PER_DAY;
      grid.version = nextVersion();
      return (j - before) / SAMPLES_PER_DAY;
    },

    metrics(selIndex) {
      let weighted = 0;
      let over = 0;
      let revisitSum = 0;
      let revisitArea = 0;
      let planet = 0;
      for (let r = 0; r < GRID_H; r++) {
        const a = AREA[r];
        planet += a * rowCovered[r];
        if (rowCovered[r] === 0) continue;
        const end = (r + 1) * GRID_W;
        for (let i = r * GRID_W; i < end; i++) {
          const h = hits[i];
          if (h === 0) continue;
          weighted += a * h;
          if (h > 1) {
            over += a * (h - 1);
            revisitSum += a * (last[i] - first[i]) / (h - 1);
            revisitArea += a;
          }
        }
      }
      const nd = needles[selIndex] || needles[0];
      return {
        day: sim.day,
        planet,
        map: covered / CELLS,
        overlap: weighted > 0 ? over / weighted : 0,
        revisitH: revisitArea > 0 ? 24 * revisitSum / revisitArea : null,
        ltDriftH: nd ? ltDriftHours(nd.el.sat, sim.day) : 0,
        northShare: samples > 0 ? north / samples : 0,
        twilightShare: samples > 0 ? twilight / samples : 0,
        samples,
      };
    },

    // Area-weighted share of covered cells whose centre latitude falls in any [min, max] (inclusive).
    coverageIn(ranges) {
      if (!Array.isArray(ranges)) return 0;
      let num = 0;
      let den = 0;
      for (let r = 0; r < GRID_H; r++) {
        const lat = 89.5 - r;
        let inside = false;
        for (let k = 0; k < ranges.length && !inside; k++) {
          const rg = ranges[k];
          inside = Array.isArray(rg) && lat >= rg[0] && lat <= rg[1];
        }
        if (!inside) continue;
        den += AREA[r] * GRID_W;
        num += AREA[r] * rowCovered[r];
      }
      return den > 0 ? num / den : 0;
    },

    positions() {
      return needles.map((nd) => nd.pos);
    },

    // Last min(1.5 periods, 1 day) of the track as [lon, lat] pairs; the buffer belongs to the sim.
    trail(i) {
      const nd = needles[i];
      if (!nd) return EMPTY;
      if (nd.trailDay === sim.day) return nd.trailBuf.subarray(0, nd.trailLen);
      const d1 = sim.day;
      const d0 = Math.max(0, d1 - Math.min(1.5 * nd.periodDays, 1));
      const n = d1 > d0 ? Math.min(MAX_TRAIL_POINTS, Math.floor((d1 - d0) * 8640) + 2) : 1;
      for (let k = 0; k < n; k++) {
        propagateInto(nd.el, n === 1 ? d1 : d0 + (d1 - d0) * k / (n - 1), seasonDays, trailPoint);
        nd.trailBuf[2 * k] = trailPoint.lon;
        nd.trailBuf[2 * k + 1] = trailPoint.lat;
      }
      nd.trailDay = d1;
      nd.trailLen = 2 * n;
      return nd.trailBuf.subarray(0, nd.trailLen);
    },

    sunPoint() {
      return sunPoint(sim.day, seasonDays);
    },

    // Hands the big arrays to the next simulation; this one stops working afterwards.
    takeBuffers() {
      if (retired) return null;
      retired = true;
      return { hits, last, owner, first, rowCovered };
    },
  };
  return sim;
}

// Runs `days` of simulated time in slices so a page or a self-test never blocks for long.
export async function advanceSliced(sim, days, sliceMs = 30) {
  const target = sim.day + days;
  while (sim.day < target - 1e-9) {
    if (sim.advance(target - sim.day, sliceMs) <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
