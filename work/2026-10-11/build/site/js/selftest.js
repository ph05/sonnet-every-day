// In-page physics checks: figures from the sourced pages, the spec's computed vectors and the eight baked pars.
// Each item is {name, ok, got, want, tol}; the slow ones run in slices so the page stays responsive.
import { ssoInclination, satInfo, findRepeats, ltDriftHours } from './orbit.js';
import { createSim, advanceSliced, cellAreaFraction, GRID_H, GRID_W } from './coverage.js';
import { CARDS, verifyPar, PAR_TOLERANCE } from './cards.js';

const SLICE_MS = 12;
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
const circular = (alt, inc, node = 0, swath = 185) => ({ alt, inc, ecc: 0, node, argp: 0, swath });

// Tilt at which the perigee stops turning, found by bisection on the model's own apsis rate.
function criticalTilt() {
  let lo = 40;
  let hi = 80;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (satInfo(circular(700, mid)).apsideDriftDegDay > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export async function runSelfTest() {
  const items = [];
  const add = (name, got, want, tol) => {
    const finite = Number.isFinite(got);
    items.push({ name, ok: finite && Math.abs(got - want) <= tol, got: finite ? Math.round(got * 10000) / 10000 : null, want, tol });
  };
  const attempt = async (label, work) => {
    try {
      await work();
    } catch (err) {
      items.push({ name: `${label} could not run: ${err && err.message ? err.message : 'unknown error'}`, ok: false, got: null, want: null, tol: null });
    }
  };

  await attempt('Orbit formulas', async () => {
    add('Sun-synchronous tilt at 600 km (degrees)', ssoInclination(600, 0), 97.788, 0.02);
    add('Sun-synchronous tilt at 700 km (degrees)', ssoInclination(700, 0), 98.188, 0.02);
    add('Sun-synchronous tilt at 705 km (degrees)', ssoInclination(705, 0), 98.208, 0.02);
    const station = satInfo(circular(420, 51.6, 0, 400));
    add('Station-like orbit at 420 km: orbit time (minutes)', station.periodMin, 92.9, 0.05);
    add('Station-like orbit at 420 km: track shift per orbit (degrees)', station.shiftDegOrbit, 23.61, 0.05);
    add('Station-like orbit at 420 km: node drift (degrees per day)', station.nodeDriftDegDay, -4.951, 0.01);
    add('Station-like orbit at 420 km: farthest latitude (degrees)', station.maxLatDeg, 51.6, 1e-9);
    add('Track shift per orbit at 370 km (degrees)', satInfo(circular(370, 51.6)).shiftDegOrbit, 23.36, 0.05);
    add('Track shift per orbit at 460 km (degrees)', satInfo(circular(460, 51.6)).shiftDegOrbit, 23.81, 0.05);
    add('Orbit time at 705 km and 98.2 degrees (minutes)', satInfo(circular(705, 98.2)).periodMin, 99.0, 0.05);
    const weave = findRepeats(circular(700, 98.186)).find((t) => t.k === 233 && t.m === 16);
    add('233 orbits in 16 days: height (km)', weave ? weave.alt : Number.NaN, 699.6, 0.5);
    add('233 orbits in 16 days: track spacing (km)', weave ? weave.spacingKm : Number.NaN, 172.0, 0.5);
    add('233 orbits in 16 days: tight for a 185 km swath (1 = yes)', weave && weave.tight ? 1 : 0, 1, 0);
    add('Tilt where the perigee stops turning (degrees)', criticalTilt(), 63.435, 0.001);
    add('Local-time drift over 30 days at 51.6 degrees (hours)', ltDriftHours(circular(705, 51.6), 30), -10.55, 0.05);
    add('Local-time drift over 30 days at 97.8 degrees (hours)', ltDriftHours(circular(705, 97.8), 30), -0.1, 0.05);
    let total = 0;
    let caps = 0;
    for (let r = 0; r < GRID_H; r++) {
      const share = cellAreaFraction(r) * GRID_W;
      total += share;
      if (Math.abs(89.5 - r) > 60) caps += share;
    }
    add('Stitch areas add up to the whole planet', total, 1, 1e-9);
    add('Share of the planet beyond 60 degrees latitude', caps, 0.13397, 1e-4);
  });
  await pause();

  const run = async (sats, days) => {
    const sim = createSim(sats, 0);
    await advanceSliced(sim, days, SLICE_MS);
    return sim;
  };
  await attempt('Coverage runs', async () => {
    const weave = await run([circular(699.59, 98.186)], 16);
    add('16-day weave: share of the 60S to 60N band covered', weave.coverageIn([[-60, 60]]), 1, 0.001);
    add('16-day weave: share of the planet covered', weave.metrics(0).planet, 0.9925, 0.005);
    add('3 days at 420 km, 51.6 degrees, 400 km swath: planet covered', (await run([circular(420, 51.6, 0, 400)], 3)).metrics(0).planet, 0.716, 0.01);
    add('3 days at 500 km, 98 degrees, 400 km swath: planet covered', (await run([circular(500, 98, 0, 400)], 3)).metrics(0).planet, 0.806, 0.01);
    add('10 days sun-synchronous, node -90: time near sunrise or sunset', (await run([circular(705, 98.208, -90)], 10)).metrics(0).twilightShare, 0.81, 0.02);
    add('10 days sun-synchronous, node 90: time near sunrise or sunset', (await run([circular(705, 98.208, 90)], 10)).metrics(0).twilightShare, 0.41, 0.02);
    const stretched = { alt: 500, inc: 63.4, ecc: 0.74, node: 0, argp: 270, swath: 185 };
    add('4 days stretched orbit: time north of 60 degrees', (await run([stretched], 4)).metrics(0).northShare, 0.337, 0.015);
    add('Stretched orbit: highest point (km)', satInfo(stretched).apogeeKm, 39652, 5);
  });
  await pause();

  for (const card of CARDS) {
    await attempt(card.title, async () => {
      const replay = await verifyPar(card, SLICE_MS);
      items.push({ name: `Par replay, ${card.title} (points)`, ok: replay.ok, got: replay.score, want: replay.par, tol: PAR_TOLERANCE });
    });
    await pause();
  }
  const passed = items.filter((item) => item.ok).length;
  return { passed, total: items.length, items };
}
