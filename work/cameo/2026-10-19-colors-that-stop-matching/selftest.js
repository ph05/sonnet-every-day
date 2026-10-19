// window.__sedSelfTest: the page checks its own numbers with its own functions. Each case names where its expected value
// comes from. The page also runs it once after loading and offers "Check the numbers" to run it again.
import * as E from './engine.js';
import { DATA } from './data.js';

// Sharma, Wu and Dalal (2005), Table 1: 34 pairs of CIELAB values and their CIEDE2000 difference.
const SHARMA = [
  [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425], [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
  [[50, 2.8361, -74.02], [50, 0, -82.7485], 3.4412], [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1],
  [[50, -1.1848, -84.8006], [50, 0, -82.7485], 1], [[50, -0.9009, -85.5211], [50, 0, -82.7485], 1],
  [[50, 0, 0], [50, -1, 2], 2.3669], [[50, -1, 2], [50, 0, 0], 2.3669],
  [[50, 2.49, -0.001], [50, -2.49, 0.0009], 7.1792], [[50, 2.49, -0.001], [50, -2.49, 0.001], 7.1792],
  [[50, 2.49, -0.001], [50, -2.49, 0.0011], 7.2195], [[50, 2.49, -0.001], [50, -2.49, 0.0012], 7.2195],
  [[50, -0.001, 2.49], [50, 0.0009, -2.49], 4.8045], [[50, -0.001, 2.49], [50, 0.001, -2.49], 4.8045],
  [[50, -0.001, 2.49], [50, 0.0011, -2.49], 4.7461], [[50, 2.5, 0], [50, 0, -2.5], 4.3065],
  [[50, 2.5, 0], [73, 25, -18], 27.1492], [[50, 2.5, 0], [61, -5, 29], 22.8977],
  [[50, 2.5, 0], [56, -27, -3], 31.903], [[50, 2.5, 0], [58, 24, 15], 19.4535],
  [[50, 2.5, 0], [50, 3.1736, 0.5854], 1], [[50, 2.5, 0], [50, 3.2972, 0], 1],
  [[50, 2.5, 0], [50, 1.8634, 0.5757], 1], [[50, 2.5, 0], [50, 3.2592, 0.335], 1],
  [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644], [[63.0109, -31.0961, -5.8663], [62.8187, -29.7946, -4.0864], 1.263],
  [[61.2901, 3.7196, -5.3901], [61.4292, 2.248, -4.962], 1.8731], [[35.0831, -44.1164, 3.7933], [35.0232, -40.0716, 1.5901], 1.8645],
  [[22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373], [[36.4612, 47.858, 18.3852], [36.2715, 50.5065, 21.2231], 1.4146],
  [[90.8027, -2.0831, 1.441], [91.1528, -1.6435, 0.0447], 1.4441], [[90.9257, -0.5406, -0.9208], [88.6381, -0.8985, -0.7239], 1.5381],
  [[6.7747, -0.2908, -2.4247], [5.8714, -0.0985, -2.2286], 0.6377], [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
];

const PEBBLE = Float64Array.from(DATA.pair.Pebble);
const FOG = E.toPlane(Float64Array.from(DATA.pair.Fog), PEBBLE, E.seenBasis('FL11'));
const idle = () => new Promise((r) => setTimeout(r, 0));

let judgeRun = null;
/** The lamp lab's default run (seed 1, 300 pairs), computed once in small chunks and shared with the page. */
export function judge300() {
  if (!judgeRun) {
    judgeRun = (async () => {
      const j = E.judge(1);
      let s = null;
      for (let i = 0; i < 12; i++) { s = j.step(25); await idle(); }
      return s;
    })();
  }
  return judgeRun;
}

// Expected values for the exercise checks, computed independently by oracle_exercises.py (colour-science with the CIE tables, its
// own spline and projections, and a bit-for-bit port of the seeded random cases) for the pair in data.js. If the pair changes,
// re-run that script and update these values and the exercise text together.
const EXPECT = {
  e2: { min: 3.9757, max: 4.6799, random: 3.2092, hairMax: 0.4297 },
  e3: { FL11: 0.8655, A: 5.6944, D65: 3.0552, P3999: 4.4638 },
  e4: { moved: 0.1705, fourAtLines: 0.1813 },
  e5: { shop: [0.4591, 0.3543, 0.1866], day: [0.3255, 0.4037, 0.2708] },
};
const SIX = ['FL11', 'A', 'D65', 'LED-B2', 'sodium', 'P3999'];
const tiny = (v) => (v === 0 ? '0' : v.toExponential(0));
const BAND_AREA = E.BANDS.map((b) => b.spd.reduce((a, v) => a + v, 0));
/** Each band's share of the light's power (strength times area), computed here; the self-test checks bandWeights().power too. */
const powerShares = (w) => { const p = w.map((v, j) => v * BAND_AREA[j]); const s = p.reduce((a, v) => a + v, 0); return p.map((v) => v / s); };

/** Numbers the exercises print; the self-test checks the same values. */
export function exerciseNumbers() {
  const P = E.curve(DATA.ex1.P), Q = E.curve(DATA.ex1.Q);
  const S = E.curve(FOG), R = E.curve(FOG.map((v) => v + 0.06)), H = E.curve(FOG.map((v) => v + 0.005));
  const Rp = E.curve(PEBBLE), Rf = E.curve(FOG);
  // exercise 3: a smooth bump added on the 81-sample grid (25 points at 650 nm, sigma 8 nm), so no handle moves and no spline rings
  const Rb = Rp.map((v, i) => v + 0.25 * Math.exp(-((E.WL[i] - 650) ** 2) / (2 * 8 * 8)));
  // exercise 5: the screen's three bands for Pebble and for Fog under the shop light (the same three numbers, so the same bands)
  const shopP = E.bandWeights(E.XYZ(Rp, 'FL11')), shopF = E.bandWeights(E.XYZ(Rf, 'FL11'));
  const day = E.bandWeights(E.XYZ(Rp, 'D65'));
  return {
    e1: { atP: E.at(P, 589), atQ: E.at(Q, 589), sodium: E.diff(P, Q, 'sodium'), day: E.diff(P, Q, 'D65'),
      sw: { day: [E.displayRGB(P, 'D65').rgb, E.displayRGB(Q, 'D65').rgb], sodium: [E.displayRGB(P, 'sodium').rgb, E.displayRGB(Q, 'sodium').rgb] } },
    e2: Object.fromEntries(SIX.map((k) => [k, E.diff(R, S, k)])),
    e2hair: Object.fromEntries(SIX.map((k) => [k, E.diff(H, S, k)])),
    e3: Object.fromEntries(SIX.map((k) => [k, E.diff(Rp, Rb, k)])),
    e5: { ok: shopP.ok && shopF.ok, power: powerShares(shopP.w), rel: Math.max(...shopP.w.map((v, j) => Math.abs(v - shopF.w[j]))) / Math.max(...shopP.w.map(Math.abs)) },
    day: { w: day.w, ok: day.ok, power: powerShares(day.w), engine: day.power },
  };
}

// ---- exercise 2's random lamps and exercise 4's line lamps: any lamp given as a spectrum on the grid -----------------------------------
/** CIEDE2000 between two curves under a lamp given as a spectrum on the grid (CIE 1931 observer, CIELAB against its own white). */
function diffSpd(R1, R2, spd) {
  const { x, y, z } = DATA.cmf;
  const a = [0, 0, 0], b = [0, 0, 0], w = [0, 0, 0];
  for (let i = 0; i < E.N; i++) {
    const ex = x[i] * spd[i], ey = y[i] * spd[i], ez = z[i] * spd[i];
    w[0] += ex; w[1] += ey; w[2] += ez;
    a[0] += ex * R1[i]; a[1] += ey * R1[i]; a[2] += ez * R1[i];
    b[0] += ex * R2[i]; b[1] += ey * R2[i]; b[2] += ez * R2[i];
  }
  return E.dE00(E.labOf(a, w), E.labOf(b, w));
}
/** What the eye sees under a lamp spectrum, as orthonormal directions in handle space (Gram-Schmidt, as E.seenBasis does). */
function basisOf(spd) {
  const Q = [];
  for (const c of ['x', 'y', 'z']) {
    const cmf = DATA.cmf[c], v = new Float64Array(E.K);
    for (let i = 0; i < E.N; i++) { const e = cmf[i] * spd[i]; if (e) for (let k = 0; k < E.K; k++) v[k] += e * E.B[i][k]; }
    const n0 = Math.hypot(...v);
    for (const q of Q) { let d = 0; for (let k = 0; k < E.K; k++) d += v[k] * q[k]; for (let k = 0; k < E.K; k++) v[k] -= d * q[k]; }
    const n = Math.hypot(...v);
    if (n0 > 0 && n > 1e-9 * n0) Q.push(v.map((q) => q / n));
  }
  return Q;
}
/** Wiggle Fog n times while it hides from a lamp of narrow lines [[nm, power], ...] at grid wavelengths: random targets (each
 *  handle +-0.15) kept by the page's own keepColour. Yields to the page every 10 wiggles. */
async function wiggleLines(lines, seed = 4, n = 200) {
  const spd = new Float64Array(E.N);
  for (const [nm, p] of lines) spd[Math.round((nm - DATA.start) / DATA.step)] += p;
  const Q = basisOf(spd), r = E.rng(seed), S = E.curve(FOG);
  let moved = 0, atLines = 0, same = 0, warm = 0;
  for (let m = 0; m < n; m++) {
    const R = E.curve(E.keepColour(Float64Array.from(FOG, (v) => v + 0.3 * (r() - 0.5)), FOG, Q));
    for (let i = 0; i < E.N; i++) moved = Math.max(moved, Math.abs(R[i] - S[i]));
    for (const [nm] of lines) atLines = Math.max(atLines, Math.abs(E.at(R, nm) - E.at(S, nm)));
    same = Math.max(same, diffSpd(R, S, spd));
    warm = Math.max(warm, E.diff(S, R, 'A'));
    if (m % 10 === 9) await idle();
  }
  return { rank: Q.length, moved, atLines, same, warm, fogAt: lines.map(([nm]) => E.at(S, nm)) };
}

let checksRun = null;
/** The exercises' heavier checks, computed once in small chunks after load and shared by the exercise text and the self-test:
 *  exercise 2 under 2,000 seeded random lamps (1 to 5 smooth or spiky bumps each), exercise 4's wiggles under line lamps. */
export function exerciseChecks() {
  if (!checksRun) {
    checksRun = (async () => {
      const S = E.curve(FOG), R = E.curve(FOG.map((v) => v + 0.06));
      const r = E.rng(2), spd = new Float64Array(E.N);
      let randomMin = Infinity;
      for (let n = 0; n < 2000; n++) {
        spd.fill(0);
        const parts = 1 + Math.floor(r() * 5);
        for (let m = 0; m < parts; m++) {
          const amp = 0.1 + 0.9 * r(), mu = 400 + 300 * r(), sg = 2 + 78 * r();
          for (let i = 0; i < E.N; i++) spd[i] += amp * Math.exp(-0.5 * ((E.WL[i] - mu) / sg) ** 2);
        }
        randomMin = Math.min(randomMin, diffSpd(R, S, spd));
        if (n % 50 === 49) await idle();
      }
      const two = await wiggleLines([[450, 1], [600, 1]]);
      const four = await wiggleLines([[450, 1], [525, 1], [600, 1], [650, 1]]);
      return { randomMin, two, four };
    })();
  }
  return checksRun;
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;
const xy = (id) => E.chroma(E.white(id));
const f2 = (v) => v.toFixed(2);

export async function selfTest() {
  const cases = [];
  const add = (name, ok, detail) => cases.push({ name, ok: !!ok, detail });
  const A = xy('A'), D = xy('D65'), F = xy('FL11');
  add('White point of CIE standard illuminant A is (0.4476, 0.4074) (CIE 15)', near(A[0], 0.4476, 5e-4) && near(A[1], 0.4074, 5e-4), `${A[0].toFixed(5)}, ${A[1].toFixed(5)}`);
  add('White point of CIE standard illuminant D65 is (0.3127, 0.3290) (CIE 15)', near(D[0], 0.3127, 5e-4) && near(D[1], 0.329, 5e-4), `${D[0].toFixed(5)}, ${D[1].toFixed(5)}`);
  add('White point of CIE illuminant FL11 is (0.3805, 0.3769) (CIE 15 table)', near(F[0], 0.3805, 5e-4) && near(F[1], 0.3769, 5e-4), `${F[0].toFixed(5)}, ${F[1].toFixed(5)}`);
  const L2 = xy('LED-B2');
  add('White point of CIE illuminant LED-B2 is (0.4357, 0.4012) (CIE 15:2018 table)', near(L2[0], 0.4357, 5e-4) && near(L2[1], 0.4012, 5e-4), `${L2[0].toFixed(5)}, ${L2[1].toFixed(5)}`);
  const G = xy('P3999');
  add("The shop light has the color of a 3999 K glow: Planck's law gives the same white point within 0.0002 (computed from the CIE FL11 table)", near(G[0], F[0], 2e-4) && near(G[1], F[1], 2e-4), `glow ${G[0].toFixed(5)}, ${G[1].toFixed(5)}; shop light ${F[0].toFixed(5)}, ${F[1].toFixed(5)}`);
  const s = ['x', 'y', 'z'].map((c) => DATA.cmf[c].reduce((a, b) => a + b, 0));
  const t = s[0] + s[1] + s[2];
  add('Equal-energy white is (1/3, 1/3) (definition of the CIE 1931 functions)', near(s[0] / t, 1 / 3, 5e-4) && near(s[1] / t, 1 / 3, 5e-4), `${(s[0] / t).toFixed(5)}, ${(s[1] / t).toFixed(5)}`);
  let worst = 0;
  for (const [l1, l2, d] of SHARMA) worst = Math.max(worst, Math.abs(E.dE00(l1, l2) - d));
  add('CIEDE2000 matches all 34 test pairs within 0.0001 (Sharma, Wu and Dalal 2005)', worst < 1e-4, `largest error ${worst.toExponential(1)}`);
  const Rp = E.curve(PEBBLE), Rf = E.curve(FOG);
  const shop = E.diff(Rp, Rf, 'FL11'), warm = E.diff(Rp, Rf, 'A'), day = E.diff(Rp, Rf, 'D65');
  add('Pebble and Fog match under the shop light: below 0.5 (they were designed to)', shop < 0.5, f2(shop));
  add('Pebble and Fog split under the warm bulb: above 10 (they were designed to)', warm > 10, f2(warm));
  add('Pebble and Fog split in daylight: above 10 (they were designed to)', day > 10, f2(day));
  const ten = E.diff10(Rp, Rf, 'FL11'), draft = E.diff10(E.curve(DATA.draft.Pebble), E.curve(DATA.draft.Fog), 'FL11');
  add('The match also holds for the CIE 1964 10-degree observer: below 0.01, while the first design, matched for the 1931 observer only, was above 5 (CIE 1964 table)', ten < 0.01 && draft > 5, `Pebble and Fog ${ten.toFixed(4)}; first design ${draft.toFixed(1)}`);
  const Q = E.seenBasis('FL11');
  const r = E.rng(77);
  const bumps = Array.from({ length: 6 }, () => E.randomBumps(r, 1, 0.4));
  let wmax = 0, move = 0;
  for (let f = 0; f < 120; f++) {
    const tt = f / 30;
    const env = Math.min(1, tt / 0.6);
    const target = Float64Array.from(FOG, (v, k) => v + env * bumps.reduce((acc, b, j) => acc + Math.sin((0.7 + 0.13 * j) * tt * 2 + j) * b[k], 0));
    const R = E.curve(E.keepColour(target, FOG, Q));
    wmax = Math.max(wmax, E.diff(Rf, R, 'FL11'));
    for (let i = 0; i < E.N; i++) move = Math.max(move, Math.abs(R[i] - Rf[i]));
    if (f % 40 === 39) await idle();
  }
  add('The wiggle keeps Fog\'s color under the shop light: below 0.5 over 120 frames (true by construction)', wmax < 0.5 && move > 0.2, `largest difference ${wmax.toExponential(1)} while the curve moved ${move.toFixed(2)}`);
  const X = exerciseNumbers();
  add('Exercise 1: both paints send back 40% at 589 nm, match under the sodium line and differ in daylight (the two paints were made to send back exactly 40% there)',
    near(X.e1.atP, 0.4, 1e-4) && near(X.e1.atQ, 0.4, 1e-4) && X.e1.sodium < 0.01 && X.e1.day > 30, `589 nm: ${(100 * X.e1.atP).toFixed(1)}% and ${(100 * X.e1.atQ).toFixed(1)}%; street lamp ${f2(X.e1.sodium)}; daylight ${X.e1.day.toFixed(1)}`);
  const e2v = Object.values(X.e2), hv = Object.values(X.e2hair);
  const XC = await exerciseChecks();
  add('Exercise 2: a curve 6 points above Fog never matches it: 4.0 to 4.7 under the six lamps and at least 3.2 under 2,000 random lamps; half a point above, it differs by less than 1, but never by 0 (independent script)',
    near(Math.min(...e2v), EXPECT.e2.min, 0.005) && near(Math.max(...e2v), EXPECT.e2.max, 0.005) && near(XC.randomMin, EXPECT.e2.random, 0.005) && near(Math.max(...hv), EXPECT.e2.hairMax, 0.005) && Math.min(...hv) > 0.1,
    `six lamps ${f2(Math.min(...e2v))} to ${f2(Math.max(...e2v))}, random lamps from ${f2(XC.randomMin)}; half a point: ${f2(Math.min(...hv))} to ${f2(Math.max(...hv))}`);
  add('Exercise 3: a smooth 25-point bump at 650 nm shows least under the shop light (0.87), then in daylight (3.06) and under the warm bulb (5.69); the smooth glow shows it at 4.46 (independent script)',
    near(X.e3.FL11, EXPECT.e3.FL11, 0.005) && near(X.e3.D65, EXPECT.e3.D65, 0.005) && near(X.e3.A, EXPECT.e3.A, 0.005) && near(X.e3.P3999, EXPECT.e3.P3999, 0.005),
    `shop ${f2(X.e3.FL11)}, daylight ${f2(X.e3.D65)}, warm bulb ${f2(X.e3.A)}, smooth glow ${f2(X.e3.P3999)}`);
  add('Exercise 4: wiggling Fog while it hides from a lamp with lines at 450 and 600 nm never moves its heights there, while the rest moves; with four lines the heights move too (true by construction; independent script)',
    XC.two.rank === 2 && XC.two.atLines < 1e-12 && XC.two.same < 1e-9 && near(XC.two.moved, EXPECT.e4.moved, 0.005) && XC.four.rank === 3 && XC.four.same < 1e-9 && near(XC.four.atLines, EXPECT.e4.fourAtLines, 0.005),
    `two lines: heights changed by ${tiny(XC.two.atLines)} while the curve moved ${f2(XC.two.moved)}; four lines: heights moved ${f2(XC.four.atLines)}, color change ${tiny(XC.four.same)}`);
  const J = await judge300();
  add('Lamp lab: the three-band lamp is the harsher judge in more than 70 of 100 random pairs (seed 1, 300 pairs; an independent Python run gives 84 of 100 on 3,000)', J.more > 0.7 && J.worstMatch < 1e-6, `${(100 * J.more).toFixed(1)}%, medians ${f2(J.medA)} and ${f2(J.medB)}`);
  const xyzP = E.XYZ(Rp, 'D65');
  const back = [0, 1, 2].map((c) => E.BANDS.reduce((acc, b, j) => acc + X.day.w[j] * b.xyz[c], 0));
  add('Screen model: three nonnegative bands give Pebble\'s daylight color exactly, and the page reports shares of their light power (true by construction; independent script)',
    X.day.ok && back.every((v, c) => near(v, xyzP[c], 1e-9)) && X.day.power.every((v, j) => near(v, EXPECT.e5.day[j], 5e-4) && near(v, (X.day.engine || [])[j], 1e-12)),
    `red ${(100 * X.day.power[0]).toFixed(1)}%, green ${(100 * X.day.power[1]).toFixed(1)}%, blue ${(100 * X.day.power[2]).toFixed(1)}% of the power`);
  add('Exercise 5: under the shop light the screen makes Pebble and Fog from the very same three bands (true by construction; independent script)',
    X.e5.ok && X.e5.rel < 1e-9 && X.e5.power.every((v, j) => near(v, EXPECT.e5.shop[j], 5e-4)),
    `band strengths differ by ${tiny(X.e5.rel)}; red ${(100 * X.e5.power[0]).toFixed(1)}%, green ${(100 * X.e5.power[1]).toFixed(1)}%, blue ${(100 * X.e5.power[2]).toFixed(1)}% of the power`);
  let clip = [];
  for (const id of E.LAMP_IDS) {
    for (const [n, rgb] of [['Pebble', E.linearRGB(Rp, id)], ['Fog', E.linearRGB(Rf, id)], ['wall', E.flatRGB(E.WALL, id)], ['card', E.flatRGB(E.CARD, id)]]) if (E.clipped(rgb)) clip.push(`${n} under ${id}`);
  }
  add('No displayed color of the pair, the wall or the card leaves sRGB under the six lamps (checked when the pair was designed)', clip.length === 0, clip.length ? clip.join(', ') : 'all inside');
  let h = Float64Array.from(PEBBLE);
  for (const [lam, y] of [[650, 0.85], [675, 0.9], [475, 0.15]]) for (let m = 0; m < 8; m++) h = E.brush(h, lam, y, Q);
  const Rh = E.curve(h);
  const bshop = E.diff(Rp, Rh, 'FL11'), bwarm = E.diff(Rp, Rh, 'A');
  add('Make my own pair: holding the shop-light match, three strokes push the warm-bulb split above 8 (the brush keeps the match exactly)', bshop < 0.01 && bwarm > 8, `shop ${bshop.toExponential(1)}, warm bulb ${f2(bwarm)}`);
  return { cases };
}
window.__sedSelfTest = selfTest;
