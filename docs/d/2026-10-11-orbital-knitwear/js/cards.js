// The eight pattern cards: goals, scoring, badges against a baked par, and par re-verification.
// Pars come from an offline search with this very engine (random restarts and local moves on the slider grid,
// 5 to 10 minutes of Node per card). They are the best setups found, not proofs of optimality, and every one clears
// its card's pass level, so no pass level had to be lowered. verifyPar replays them in the page.
import { ssoInclination } from './orbit.js';
import { createSim, advanceSliced } from './coverage.js';

const sso = (alt) => Math.round(ssoInclination(alt, 0) * 100) / 100;
const needle = (alt, inc, node, swath, ecc = 0, argp = 0) => ({ alt, inc, ecc, node, argp, swath });
// A pass condition is a function giving the points still missing (0 once it holds); this one reads "value >= min".
const atLeast = (get, min) => (m, sim) => (min - get(m, sim)) * 100;
const round2 = (v) => Math.round(v * 100) / 100;

export const PAR_TOLERANCE = 0.1;
const POLES = [[-90, -51.6], [51.6, 90]];
const TROPICS = [[-60, 60]];

const DEFS = [
  {
    id: 'first-swatch',
    title: 'First Swatch',
    blurb: 'Your first square of fabric.',
    goal: "Cover 76% of the planet's surface in 3 days with one needle (swath fixed at 400 km).",
    hint: "Tilt the orbit toward the poles: the station's 51.6 degrees never sees the caps.",
    passText: 'Pass: at least 76% of the planet covered.',
    days: 3,
    maxSats: 1,
    locks: { swath: 400 },
    regions: null,
    start: [needle(420, 51.6, 0, 400)],
    par: { score: 97.4, sats: [needle(441, 86.7, 0, 400)] },
    score: (m) => 100 * m.planet,
    needs: [atLeast((m) => m.planet, 0.76)],
  },
  {
    id: 'past-the-station',
    title: 'Past the Station',
    blurb: "Knit where the space station can't.",
    goal: 'Cover 85% of the area beyond 51.6 degrees latitude in 3 days (swath fixed at 300 km).',
    hint: 'The station tops out at 51.6 degrees. Go steeper.',
    passText: 'Pass: at least 85% of the area beyond 51.6 degrees latitude covered.',
    days: 3,
    maxSats: 1,
    locks: { swath: 300 },
    regions: POLES,
    start: [needle(420, 51.6, 0, 300)],
    par: { score: 100, sats: [needle(759, 88.75, 0, 300)] },
    score: (m, sim) => 100 * sim.coverageIn(POLES),
    needs: [atLeast((m, sim) => sim.coverageIn(POLES), 0.85)],
  },
  {
    id: 'sixteen-day-weave',
    title: 'Sixteen-Day Weave',
    blurb: "Landsat's trick: tracks that tile exactly.",
    goal: 'Cover 99% of the band from 60 degrees south to 60 north in 16 days (swath fixed at 185 km).',
    hint: 'Look for the tall ticks on the height slider: those heights repeat with tracks closer than your swath.',
    passText: 'Pass: at least 99% of the band from 60 degrees south to 60 degrees north covered.',
    days: 16,
    maxSats: 1,
    locks: { swath: 185 },
    regions: TROPICS,
    start: [needle(650, sso(650), 0, 185)],
    par: { score: 100, sats: [needle(699.57, 98.19, 0, 185)] },
    score: (m, sim) => 100 * sim.coverageIn(TROPICS),
    needs: [atLeast((m, sim) => sim.coverageIn(TROPICS), 0.99)],
  },
  {
    id: 'same-time-tomorrow',
    title: 'Same Time Tomorrow',
    blurb: 'Keep the sun at the same angle.',
    goal: 'Cover 95% of the planet in 30 days while your local time at the node drifts less than 0.25 hours (swath fixed at 185 km).',
    hint: 'The tilt that makes the orbit turn with the sun is about 98 degrees. Try Tune sun-sync.',
    passText: 'Pass: local time at the node drifts 0.25 hours or less and at least 95% of the planet is covered.',
    days: 30,
    maxSats: 1,
    locks: { swath: 185 },
    regions: null,
    start: [needle(705, 90, 0, 185)],
    par: { score: 99.4, sats: [needle(236, 96.45, 0, 185)] },
    score: (m) => 100 * m.planet * Math.max(0, 1 - Math.abs(m.ltDriftH)),
    needs: [(m) => (Math.min(Math.abs(m.ltDriftH), 1) - 0.25) * 100 * m.planet, atLeast((m) => m.planet, 0.95)],
  },
  {
    id: 'dawn-patrol',
    title: 'Dawn Patrol',
    blurb: 'Ride the line between night and day.',
    goal: 'Spend 65% of 10 days within 6 degrees of sunrise (sun elevation between -6 and +6 degrees).',
    hint: 'You need a sun-synchronous orbit that crosses the equator at 6 in the morning: a start longitude near -90 degrees.',
    passText: 'Pass: at least 65% of the time with the sun between -6 and +6 degrees.',
    days: 10,
    maxSats: 1,
    locks: { swath: 185, season: 0 },
    regions: null,
    start: [needle(705, sso(705), 0, 185)],
    par: { score: 100, sats: [needle(705, 93.5, -88, 185)] },
    score: (m) => 100 * m.twilightShare,
    needs: [atLeast((m) => m.twilightShare, 0.65)],
  },
  {
    id: 'two-needle-cable',
    title: 'Two-Needle Cable',
    blurb: 'Two needles, one pattern.',
    goal: 'Cover 97% of the planet in 8 days with two needles (swath fixed at 150 km).',
    hint: 'Same height and tilt, start longitudes 180 degrees apart, then fine-tune the height.',
    passText: 'Pass: at least 97% of the planet covered.',
    days: 8,
    maxSats: 2,
    locks: { swath: 150 },
    regions: null,
    start: [needle(700, 98, 0, 150), needle(700, 98, 90, 150)],
    par: { score: 100, sats: [needle(222, 89.7, 0, 150), needle(222, 89.7, 180, 150)] },
    score: (m) => 100 * m.planet,
    needs: [atLeast((m) => m.planet, 0.97)],
  },
  {
    id: 'linger-up-north',
    title: 'Linger Up North',
    blurb: 'A stretched orbit that hangs over the pole.',
    goal: 'Spend 30% of 4 days north of 60 degrees.',
    hint: 'Stretch the orbit (eccentricity above 0.7), tilt it to 63.4 degrees, and point the perigee south (argument 270).',
    passText: 'Pass: at least 30% of the time north of 60 degrees latitude.',
    days: 4,
    maxSats: 1,
    locks: { swath: 185 },
    regions: [[60, 90]],
    start: [needle(700, 90, 0, 185)],
    par: { score: 69.9, sats: [needle(200, 90, 0, 185, 0.8, 272)] },
    score: (m) => 100 * m.northShare,
    needs: [atLeast((m) => m.northShare, 0.3)],
  },
  {
    id: 'map-lies',
    title: 'The Map Lies',
    blurb: 'Make a flat map brag.',
    goal: 'Make the flat map look 9 points more covered than the planet really is, after 1 day (swath fixed at 1,500 km).',
    hint: 'Polar orbits pile up stitches near the poles, which are huge on the map and tiny on the planet.',
    passText: 'Pass: the flat map looks at least 9 points more covered than the planet.',
    days: 1,
    maxSats: 1,
    locks: { swath: 1500 },
    regions: null,
    start: [needle(420, 51.6, 0, 1500)],
    par: { score: 13.7, sats: [needle(1213, 85.05, 0, 1500, 0.565, 72)] },
    score: (m) => 100 * Math.max(0, m.map - m.planet),
    needs: [atLeast((m) => m.map - m.planet, 0.09)],
  },
];

function freeze(def) {
  return Object.freeze({
    ...def,
    locks: Object.freeze({ ...def.locks }),
    regions: def.regions ? Object.freeze(def.regions.map((r) => Object.freeze(r.slice()))) : null,
    start: Object.freeze({ sats: Object.freeze(def.start.map((s) => Object.freeze(s))) }),
    par: Object.freeze({ score: def.par.score, sats: Object.freeze(def.par.sats.map((s) => Object.freeze(s))) }),
  });
}

export const CARDS = Object.freeze(DEFS.map(freeze));
const BY_ID = new Map(CARDS.map((card) => [card.id, card]));
const BADGE_NAMES = { swatch: 'Swatch', sweater: 'Sweater', heirloom: 'Heirloom' };

export const badgeName = (badge) => BADGE_NAMES[badge] || '';

export function getCard(id) {
  return typeof id === 'string' ? BY_ID.get(id) || null : null;
}

export function cardInfo(card, best) {
  if (!card) return null;
  const hasBest = best && Number.isFinite(best.score) && BADGE_NAMES[best.badge];
  return {
    id: card.id,
    title: card.title,
    blurb: card.blurb,
    goal: card.goal,
    hint: card.hint,
    passText: card.passText,
    days: card.days,
    maxSats: card.maxSats,
    locks: { ...card.locks },
    regions: card.regions ? card.regions.map((r) => r.slice()) : null,
    par: card.par.score,
    best: hasBest ? { score: best.score, badge: best.badge } : null,
  };
}

// Copies of the needles with the card's fixed parameters written in. Season locks live on the state.
export function applyLocks(card, sats) {
  const list = Array.isArray(sats) ? sats : [];
  const swath = card && card.locks ? card.locks.swath : undefined;
  return list.map((s) => (swath === undefined ? { ...s } : { ...s, swath }));
}

// Points still missing from the weakest condition (0 once every condition holds).
function shortfall(card, m, sim) {
  let worst = 0;
  for (const need of card.needs) {
    const gap = need(m, sim);
    if (Number.isNaN(gap)) return 100;
    if (gap > worst) worst = gap;
  }
  return worst;
}

export function evaluate(card, metrics, sim, finished, peeked, best) {
  if (!card || !metrics || !sim) return null;
  const score = Math.min(100, Math.max(0, card.score(metrics, sim)));
  const short = shortfall(card, metrics, sim);
  const pass = short <= 0;
  let badge = 'none';
  if (finished && pass) {
    badge = score >= card.par.score - 0.5 ? 'heirloom' : score >= 0.9 * card.par.score ? 'sweater' : 'swatch';
  }
  const bestScore = typeof best === 'number' ? best : best && Number.isFinite(best.score) ? best.score : null;
  return {
    id: card.id,
    score,
    pass,
    badge,
    finished: !!finished,
    progress: Math.min(1, Math.max(0, metrics.day / card.days)),
    par: card.par.score,
    best: bestScore,
    peeked: !!peeked,
    short: pass ? 0 : Math.max(0.1, Math.ceil(short * 10) / 10),
  };
}

// Replays the baked par setup in time slices and compares the score with the baked figure.
export async function verifyPar(card, sliceMs = 30) {
  if (!card || !card.par) return { ok: false, score: 0, par: 0 };
  const sim = createSim(applyLocks(card, card.par.sats), card.locks.season || 0);
  await advanceSliced(sim, card.days, sliceMs);
  const status = evaluate(card, sim.metrics(0), sim, true, false, null);
  return { ok: status.pass && Math.abs(status.score - card.par.score) <= PAR_TOLERANCE, score: round2(status.score), par: card.par.score };
}
