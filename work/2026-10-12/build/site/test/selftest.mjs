// Between Periods: the Node proof. Run `node test/selftest.mjs` from the site directory; it prints one
// JSON document and exits 1 when any check fails.
//   T1 determinism: the same seed and inputs give the same digest however the ticks are chunked
//   T2 attainability: the next 365 daily rinks are well formed and the par planner gleams 95 percent
//   T3 depth: the planners differ, the best beats the mow, and shaky hands cost at most a grade band
//   T4 hash fuzz: hostile URL hashes never throw and always come out inside the grammar
//   T5 game wiring: only the player's own timed lap answers a challenge; a bot lap or a practice lap never does

import {
  TUNING, MISHAPS, hashSeed, mulberry32, sinq, cosq, atan2q, boardDepth, outlinePoint, outlineLength, createRink, createSim,
} from '../js/sim.js';
import { PLANNERS, makePlanner, runBot } from '../js/bot.js';
import {
  SEED_RE, isValidSeed, todaySeed, parseHash, buildHash, gradeRank, beats, shareText,
} from '../js/share.js';
import { createGame } from '../js/game.js';

const started = Date.now();
const failures = [];
const report = {};

function check(group, name, pass, detail) {
  if (!pass) failures.push(group + ': ' + name + (detail === undefined ? '' : ' (' + detail + ')'));
  return pass;
}

const median = (a) => {
  const b = Array.from(a).sort((x, y) => x - y);
  return b[Math.floor(b.length / 2)];
};

// ---- T1 determinism ---------------------------------------------------------------------------------

const GOLDEN = { seed: 'qa1', route: 'weave', ticks: 1800, digest: '7bd6e55d', hashQa1: 'e8ea61b8' };

function makeRoutes() {
  const rng = mulberry32(99);
  const table = [];
  while (table.length < 2400) {
    const steer = Math.round((rng() * 2 - 1) * 32), len = 20 + Math.floor(rng() * 100);
    for (let i = 0; i < len; i++) table.push(steer);
  }
  return {
    weave: (t) => [Math.round(32 * sinq(t * 0.031)), t % 420 < 30 ? 1 : 0],
    random: (t) => [table[t], t % 333 < 20 ? 1 : 0],
    circle: (t) => [t % 300 < 150 ? 32 : -32, t % 500 < 60 ? 1 : 0],
  };
}

const fingerprint = (sim, seed) => JSON.stringify(Object.entries(sim.result('timed', seed)).map(([k, v]) => [k, v && v.buffer ? Array.from(v) : v]));

function driveScripted(rink, route, ticks, chunk) {
  const sim = createSim(rink, { timed: true });
  const arc = new Float32Array(48);
  for (let t = 0; t < ticks;) {
    for (let k = 0; k < chunk && t < ticks; k++, t++) {
      const [steer, slow] = route(t);
      sim.step(steer, slow);
    }
    // Observers between chunks must not disturb the state.
    sim.stats();
    sim.predict(sim.m.steer, arc);
    sim.clearFresh();
  }
  return sim;
}

// Random driving on several rinks: the machine never leaves the boards, nothing goes non-finite, the
// incremental counters agree with a recount of the grid, and a renderer that replays `fresh` ends up with
// exactly the sim's grid.
function fuzzDrive() {
  const out = { ticks: 0, bumps: 0 };
  for (const seed of ['qa3', 'qa9', 'qa27', '2027-01-01', 'zz', 'q_-']) {
    const rink = createRink(seed), sim = createSim(rink, { timed: false }), rng = mulberry32(hashSeed(seed));
    const shadow = new Uint8Array(sim.grid.done.length);
    let steer = 0, hold = 0, worstDepth = Infinity, bad = '';
    for (let t = 0; t < 12000 && !bad; t++) {
      if (hold-- <= 0) {
        steer = rng() < 0.3 ? 0 : Math.round((rng() * 2 - 1) * 40);
        hold = Math.floor(rng() * 90);
      }
      const flags = sim.step(steer, rng() < 0.1 ? 1 : 0);
      const m = sim.m;
      if (![m.x, m.y, m.a, m.tank, m.speed].every(Number.isFinite)) bad = 'non-finite at ' + t;
      else if (m.tank < 0 || m.tank > TUNING.tankMax) bad = 'tank ' + m.tank;
      worstDepth = Math.min(worstDepth, boardDepth(m.x, m.y));
      if (sim.ended !== null || flags & 32) break;
      if (rng() < 0.3) {
        const f = sim.fresh;
        if (f.n < 0) shadow.set(sim.grid.done);
        else for (let k = 0; k < f.n; k++) shadow[f.idx[k]] = sim.grid.done[f.idx[k]];
        sim.clearFresh();
      }
      out.ticks++;
    }
    check('T1', 'fuzz drive ' + seed + ' stays sane', bad === '' && worstDepth >= TUNING.body - 1e-9, bad + ' depth ' + worstDepth);
    const f = sim.fresh;
    if (f.n < 0) shadow.set(sim.grid.done);
    else for (let k = 0; k < f.n; k++) shadow[f.idx[k]] = sim.grid.done[f.idx[k]];
    let same = true, fixed = 0, glossy = 0;
    for (let c = 0; c < shadow.length; c++) {
      if (shadow[c] !== sim.grid.done[c]) same = false;
      if (sim.grid.done[c] === 2) {
        glossy++;
        if (rink.scar[c] !== 0) fixed++;
      }
    }
    const stats = sim.stats();
    check('T1', 'fresh replay rebuilds the grid for ' + seed, same);
    check('T1', 'counters match a recount for ' + seed, stats.gleamPct === Math.round((1000 * fixed) / rink.scarTotal) / 10 && stats.left === rink.scarTotal - fixed && glossy > 0, stats.gleamPct + ' vs ' + fixed);
    out.bumps += stats.bumps;
  }
  return out;
}

function runT1() {
  const routes = makeRoutes();
  const seeds = ['qa1', '2026-10-12', 'qa42'];
  const out = { runs: 0, mismatches: 0 };
  for (const seed of seeds) {
    const rink = createRink(seed);
    for (const [name, route] of Object.entries(routes)) {
      const ref = driveScripted(rink, route, 1800, 1);
      const refDigest = ref.digest(), refResult = fingerprint(ref, seed);
      for (const chunk of [7, 60]) {
        const sim = driveScripted(rink, route, 1800, chunk);
        const digest = sim.digest();
        const result = fingerprint(sim, seed);
        out.runs++;
        if (digest !== refDigest || result !== refResult) {
          out.mismatches++;
          check('T1', 'chunk ' + chunk + ' differs for ' + seed + '/' + name, false);
        }
      }
      // A second, independently built rink and sim must agree with the first.
      const again = driveScripted(createRink(seed), route, 1800, 1);
      check('T1', 'rebuild differs for ' + seed + '/' + name, again.digest() === refDigest);
      out.runs++;
      if (seed === GOLDEN.seed && name === GOLDEN.route) out.goldenDigest = refDigest;
    }
  }
  const rink = createRink(GOLDEN.seed);
  let h = 0x811c9dc5;
  for (let i = 0; i < rink.scar.length; i++) h = Math.imul(h ^ rink.scar[i] ^ (rink.reach[i] << 4), 16777619);
  out.scarHash = (h >>> 0).toString(16).padStart(8, '0');
  check('T1', 'golden digest', out.goldenDigest === GOLDEN.digest, out.goldenDigest);
  check('T1', 'golden rink hash', out.scarHash === GOLDEN.hashQa1, out.scarHash);

  let worst = 0;
  for (let i = -3000; i <= 3000; i++) {
    const x = i * 0.0173;
    worst = Math.max(worst, Math.abs(sinq(x) - Math.sin(x)), Math.abs(cosq(x) - Math.cos(x)));
  }
  let worstAtan = 0;
  for (let i = 0; i < 4000; i++) {
    const t = (i / 4000) * 2 * Math.PI - Math.PI, r = 0.5 + (i % 37);
    let d = Math.abs(atan2q(r * Math.sin(t), r * Math.cos(t)) - Math.atan2(r * Math.sin(t), r * Math.cos(t)));
    if (d > Math.PI) d = 2 * Math.PI - d;
    worstAtan = Math.max(worstAtan, d);
  }
  check('T1', 'trig error below 1e-7', worst < 1e-7 && worstAtan < 1e-7, worst + ' / ' + worstAtan);
  out.trigError = Math.max(worst, worstAtan);
  check('T1', 'hashSeed is FNV-1a', hashSeed('') === 0x811c9dc5 && hashSeed('a') === 0xe40c292c, hashSeed('a').toString(16));
  const r = mulberry32(1);
  check('T1', 'mulberry32 stream', r() === 0.6270739405881613 && r() === 0.002735721180215478);

  // The geometry helpers the renderer and the bot lean on: an inset outline stays an even distance off the boards.
  const p = { x: 0, y: 0, a: 0 }, q = { x: 0, y: 0, a: 0 };
  const total = outlineLength(95, 37.5, 23);
  let worstInset = 0;
  for (let s = 0; s < total; s += 7.3) {
    outlinePoint(95, 37.5, 23, s, p);
    worstInset = Math.max(worstInset, Math.abs(boardDepth(p.x, p.y) - 5));
  }
  outlinePoint(95, 37.5, 23, 13.3, p);
  outlinePoint(95, 37.5, 23, 13.3 + total, q);
  check('T1', 'outline wraps and holds its inset', Math.abs(p.x - q.x) < 1e-9 && Math.abs(p.y - q.y) < 1e-9 && worstInset < 1e-6, worstInset);
  check('T1', 'board depth at centre ice', Math.abs(boardDepth(100, 42.5) - 42.5) < 1e-9 && boardDepth(0.5, 42.5) === 0.5);

  // predict() is the same law as step(): hold a steer and compare (clear of the boards).
  const rk = createRink('qa5'), sim = createSim(rk, { timed: false }), pr = new Float32Array(48);
  for (let i = 0; i < 70; i++) sim.step(0, 0);
  sim.step(12, 0);
  const n = sim.predict(12, pr);
  let maxGap = 0;
  const clone = createSim(rk, { timed: false });
  for (let i = 0; i < 70; i++) clone.step(0, 0);
  clone.step(12, 0);
  for (let i = 0; i < 24; i++) {
    for (let k = 0; k < 5; k++) clone.step(12, 0);
    maxGap = Math.max(maxGap, Math.hypot(clone.m.x - pr[2 * i], clone.m.y - pr[2 * i + 1]));
  }
  check('T1', 'predict follows the sim', n === 24 && maxGap < 0.05, maxGap);

  // The route stays inside the 3000-point cap on a very long practice lap and ends on the last pose.
  const long = createSim(createRink('qa3'), { timed: false });
  for (let i = 0; i < 40000; i++) long.step(i % 400 < 200 ? 20 : -20, 0);
  long.finish();
  const res = long.result('practice', 'qa3');
  check('T1', 'route capped', res.route.length <= 6000 && res.route.length >= 2000 && res.ticks === 40000, res.route.length);
  check('T1', 'step after the end is a no-op', long.step(5, 0) === 0 && long.tick === 40000);
  out.fuzz = fuzzDrive();

  // Budget: a tick costs well under 0.05 ms once the engine has warmed up.
  const bench = createSim(createRink('qa8'), { timed: false });
  for (let i = 0; i < 3000; i++) bench.step(i % 200 < 100 ? 12 : -12, 0);
  const t0 = performance.now();
  for (let i = 0; i < 20000; i++) bench.step(i % 200 < 100 ? 12 : -12, 0);
  out.msPerTick = Math.round(((performance.now() - t0) / 20000) * 10000) / 10000;
  check('T1', 'a tick costs under 0.05 ms', out.msPerTick < 0.05, out.msPerTick);
  out.t1 = 'deterministic';
  return out;
}

// ---- T2 attainability -------------------------------------------------------------------------------

function inRect(r, x, y) {
  return Math.abs(x - r.x) <= r.w / 2 && Math.abs(y - r.y) <= r.h / 2;
}

// Drive the par planner and count the sim's event flags: 1 bump, 2 refill start, 4 refill end, 32 ended.
function flagCounts(rink) {
  const sim = createSim(rink, { timed: true }), planner = makePlanner('spiral', rink, {});
  const f = { bump: 0, refillStart: 0, refillEnd: 0, ended: 0, lastIsEnd: false };
  while (sim.ended === null && sim.tick < rink.tune.clockTicks) {
    const c = planner.control(sim);
    const flags = sim.step(c.steer, c.slow);
    if (flags & 1) f.bump++;
    if (flags & 2) f.refillStart++;
    if (flags & 4) f.refillEnd++;
    if (flags & 32) { f.ended++; f.lastIsEnd = sim.ended !== null; }
    if (planner.done) break;
  }
  f.statRefills = sim.stats().refills;
  return f;
}

function runT2() {
  const out = { rinks: 0, minGleam: 100, bumps: 0, minRefills: 99 };
  const gleams = [], ticks95 = [];
  const day0 = Date.UTC(2026, 9, 12);
  for (let i = 0; i < 365; i++) {
    const seed = todaySeed(day0 + i * 86400000);
    const rink = createRink(seed);
    out.rinks++;
    let off = 0, reachCells = 0;
    for (let c = 0; c < rink.scar.length; c++) {
      if (rink.scar[c] !== 0 && rink.reach[c] !== 1) off++;
      reachCells += rink.reach[c];
    }
    const share = rink.scarTotal / reachCells;
    check('T2', seed + ' scar off the reachable ice', off === 0, off);
    if (i === 0) {
      // createRink measures one quadrant and mirrors it: prove that equals the plain test on every cell.
      let wrong = 0;
      for (let r = 0; r < 170; r++) {
        for (let c = 0; c < 400; c++) {
          if (rink.reach[r * 400 + c] !== (boardDepth((c + 0.5) * 0.5, (r + 0.5) * 0.5) >= TUNING.reachDepth ? 1 : 0)) wrong++;
        }
      }
      check('T2', 'reach mask equals the board depth test on every cell', wrong === 0, wrong);
    }
    check('T2', seed + ' scarTotal range', rink.scarTotal >= 2000 && rink.scarTotal <= 7000, rink.scarTotal);
    check('T2', seed + ' scar share range', share >= 0.05 && share <= 0.12, share.toFixed(4));
    const d = rink.door, s = rink.start;
    check('T2', seed + ' door on a long board', (d.y === d.h / 2 || d.y === 85 - d.h / 2) && d.h >= 12 && d.x - d.w / 2 >= 40 && d.x + d.w / 2 <= 160);
    check('T2', seed + ' start in the door facing in', inRect(d, s.x, s.y) && Math.abs(Math.cos(s.a)) < 1e-9 && Math.sign(Math.sin(s.a)) === d.ny && boardDepth(s.x, s.y) >= TUNING.body);
    check('T2', seed + ' mishap', MISHAPS.includes(rink.mishap.id));
    const z = rink.mishap.zone;
    if (z) check('T2', seed + ' zone inside', boardDepth(z.x, z.y) > 0 && boardDepth(z.x + z.w, z.y + z.h) > 0 && boardDepth(z.x, z.y + z.h) > 0 && boardDepth(z.x + z.w, z.y) > 0);
    if (rink.mishap.id === 'hats') check('T2', seed + ' hats', rink.mishap.items.length >= 12 && rink.mishap.items.length <= 18);
    if (rink.mishap.id === 'gate') check('T2', seed + ' the gate door sits near an end', d.x <= 54 || d.x >= 146, d.x);
    check('T2', seed + ' tank starts full, or at 85 when leaking', createSim(rink).m.tank === (rink.mishap.id === 'drip' ? TUNING.dripStart : TUNING.tankMax));
    if (i < 12) check('T2', seed + ' rink is pure', createRink(seed).scarTotal === rink.scarTotal);

    if (i < 10) {
      const f = flagCounts(rink);
      check('T2', seed + ' flags are consistent', f.ended === 1 && f.lastIsEnd && f.refillStart >= 1 && f.refillEnd === f.statRefills && f.refillEnd <= f.refillStart, JSON.stringify(f));
    }
    const lap = runBot(seed, 'spiral', { rink });
    const r = lap.result;
    gleams.push(r.gleamPct);
    out.minGleam = Math.min(out.minGleam, r.gleamPct);
    out.bumps += r.bumps;
    out.minRefills = Math.min(out.minRefills, r.refills);
    check('T2', seed + ' par lap reaches 95 percent', r.gleamPct >= 95 && lap.ticks <= rink.tune.clockTicks, r.gleamPct);
    check('T2', seed + ' lap is clean', r.bumps <= 3, r.bumps);
    ticks95.push(r.gleamPct >= 95 ? lap.ticks : 9999);
  }
  out.medianGleam = median(gleams);
  out.minGleam = Math.min(...gleams);
  out.note = 'par planner: spiral; bumps counted over all 365 laps';
  return out;
}

// ---- T3 depth ---------------------------------------------------------------------------------------

function timedLap(rink, name, opts) {
  const sim = createSim(rink, { timed: true }), planner = makePlanner(name, rink, opts);
  let at90 = 9999;
  while (sim.ended === null && sim.tick < rink.tune.clockTicks + 60) {
    const c = planner.control(sim);
    sim.step(c.steer, c.slow);
    if (at90 === 9999 && sim.tick % 10 === 0 && sim.stats().gleamPct >= 90) at90 = sim.tick;
    if (planner.done) break;
  }
  if (sim.ended === null) sim.finish();
  return { result: sim.result('auto', rink.seed), at90 };
}

function runT3() {
  const rinks = [];
  for (let i = 1; i <= 100; i++) rinks.push(createRink('qa' + i));
  const stat = {};
  for (const name of PLANNERS) {
    const laps = rinks.map((r) => timedLap(r, name, {}));
    stat[name] = {
      gleam: median(laps.map((l) => l.result.gleamPct)),
      points: median(laps.map((l) => l.result.points)),
      at90: median(laps.map((l) => l.at90)),
      below90: laps.filter((l) => l.result.gleamPct < 90).length,
      bumps: laps.reduce((s, l) => s + l.result.bumps, 0),
      grades: laps.map((l) => l.result.grade),
    };
  }
  const strong = PLANNERS.filter((n) => stat[n].gleam >= 90);
  check('T3', 'at least two planners gleam 90 percent in time', strong.length >= 2, strong.join(','));
  const best = PLANNERS.slice().sort((a, b) => stat[b].points - stat[a].points || stat[a].at90 - stat[b].at90)[0];
  const gain = stat[best].points - stat.mow.points;
  const faster = (stat.mow.at90 - stat[best].at90) / stat.mow.at90;
  check('T3', 'the best planner beats the mow by 40 points or 8 percent of time', gain >= 40 || faster >= 0.08, gain + ' pts, ' + (100 * faster).toFixed(1) + '%');
  check('T3', 'the best planner is not the mow', best !== 'mow', best);

  // Shaky hands: the best planner with 3 degrees of input jitter, seed by seed.
  const drops = {};
  const jitterPoints = [];
  let worst = 0;
  rinks.forEach((r, i) => {
    const shaky = timedLap(r, best, { jitterDeg: 3, seed: 7 }).result;
    const drop = gradeRank(stat[best].grades[i]) - gradeRank(shaky.grade);
    drops[drop] = (drops[drop] || 0) + 1;
    worst = Math.max(worst, drop);
    jitterPoints.push(shaky.points);
  });
  check('T3', 'jitter costs at most one grade band', worst <= 1, JSON.stringify(drops));

  // The planners really are different routes, and every one of them found the refill door.
  const a = runBot('qa1', 'mow', { rink: rinks[0] }).result, b = runBot('qa1', 'spiral', { rink: rinks[0] }).result;
  let same = a.route.length === b.route.length;
  for (let i = 0; same && i < a.route.length; i++) same = a.route[i] === b.route[i];
  check('T3', 'planners drive different routes', !same);
  for (const name of PLANNERS) check('T3', name + ' refills', runBot('qa2', name, { rink: rinks[1] }).result.refills >= 1);

  const out = { best, gainPoints: gain, fasterPercent: Math.round(1000 * faster) / 10, jitterDrops: drops, jitterMedianPoints: median(jitterPoints) };
  for (const name of PLANNERS) out[name] = { medianGleam: stat[name].gleam, medianPoints: stat[name].points, medianTicksTo90: stat[name].at90, below90: stat[name].below90, bumps: stat[name].bumps };
  return out;
}

// ---- T4 hash fuzz and the share helpers -------------------------------------------------------------

const HASH_OK = /^[A-Za-z0-9_=&.-]{0,512}$/;

function fuzzInputs(rng) {
  const valid = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-=&.';
  const hostile = ['%', '+', '<', '>', '"', "'", ' ', '\n', '\0', '#', '/', '\\', '?', ';', '{', '}', '[', ']', '$', '`', 'é', '‮', '😀', '__proto__', 'constructor', 'toString', '=', '&', '&&', '=='];
  const bases = ['s=qa1&c=A-1400&a=mow', 's=2026-10-12', 'c=S-99999&a=race', 'a=spiral&s=x_y-z', 's=' + 'a'.repeat(24)];
  const out = [];
  for (let i = 0; i < 2000; i++) {
    const kind = i % 4;
    let s = '';
    if (kind === 0) {
      const len = Math.floor(rng() * 40);
      for (let k = 0; k < len; k++) s += valid[Math.floor(rng() * valid.length)];
    } else if (kind === 1) {
      const len = Math.floor(rng() * 30);
      for (let k = 0; k < len; k++) s += rng() < 0.5 ? valid[Math.floor(rng() * valid.length)] : hostile[Math.floor(rng() * hostile.length)];
    } else if (kind === 2) {
      s = bases[Math.floor(rng() * bases.length)];
      const edits = 1 + Math.floor(rng() * 4);
      for (let k = 0; k < edits; k++) {
        const at = Math.floor(rng() * (s.length + 1)), what = rng() < 0.5 ? valid[Math.floor(rng() * valid.length)] : hostile[Math.floor(rng() * hostile.length)];
        s = rng() < 0.4 ? s.slice(0, at) + s.slice(at + 1) : s.slice(0, at) + what + s.slice(at);
      }
    } else {
      const len = 500 + Math.floor(rng() * 200);
      for (let k = 0; k < len; k++) s += valid[Math.floor(rng() * valid.length)];
    }
    out.push(rng() < 0.7 ? '#' + s : s);
  }
  return out;
}

function runT4() {
  const out = { inputs: 0, rejected: 0 };
  const now = Date.UTC(2026, 9, 12, 13, 0);
  const today = todaySeed(now);
  for (const input of fuzzInputs(mulberry32(2026))) {
    let p;
    try {
      p = parseHash(input, now);
    } catch (err) {
      check('T4', 'parseHash threw', false, JSON.stringify(input.slice(0, 40)));
      continue;
    }
    out.inputs++;
    const keys = Object.keys(p).sort().join();
    const challengeOk = p.challenge === null || (Object.keys(p.challenge).sort().join() === 'feet,grade' && gradeRank(p.challenge.grade) >= 0 && Number.isInteger(p.challenge.feet) && p.challenge.feet >= 0 && p.challenge.feet <= 99999);
    const ok = keys === 'auto,challenge,note,seed' && isValidSeed(p.seed) && challengeOk &&
      (p.auto === null || PLANNERS.includes(p.auto)) && ['', 'bad-hash', 'bad-seed'].includes(p.note);
    if (!check('T4', 'output outside the grammar', ok, JSON.stringify(input.slice(0, 40)))) continue;
    const body = input.charCodeAt(0) === 35 ? input.slice(1) : input;
    if (!HASH_OK.test(body)) {
      out.rejected++;
      check('T4', 'bad charset or length must default', p.seed === today && p.challenge === null && p.auto === null && p.note === 'bad-hash', JSON.stringify(input.slice(0, 40)));
    }
    const rebuilt = buildHash(p);
    check('T4', 'buildHash leaves the grammar', HASH_OK.test(rebuilt) && rebuilt.startsWith('s='), rebuilt);
    const back = parseHash(rebuilt, now);
    check('T4', 'hash round trip', back.seed === p.seed && JSON.stringify(back.challenge) === JSON.stringify(p.challenge) && back.note === '', rebuilt);
  }

  const cases = [
    ['#s=qa1&c=A-1400&a=mow', { seed: 'qa1', challenge: { grade: 'A', feet: 1400 }, auto: 'mow', note: '' }],
    ['s=qa1&s=other', { seed: 'qa1', challenge: null, auto: null, note: '' }],
    ['#s=' + 'a'.repeat(25), { seed: today, challenge: null, auto: null, note: 'bad-seed' }],
    ['#c=Z-1', { seed: today, challenge: null, auto: null, note: 'bad-hash' }],
    ['#a=nope&s=ok', { seed: 'ok', challenge: null, auto: null, note: 'bad-hash' }],
    ['#x=1&s=ok', { seed: 'ok', challenge: null, auto: null, note: '' }],
    ['', { seed: today, challenge: null, auto: null, note: '' }],
    ['#%41', { seed: today, challenge: null, auto: null, note: 'bad-hash' }],
    ['#c=B-007&s=qa9', { seed: 'qa9', challenge: { grade: 'B', feet: 7 }, auto: null, note: '' }],
  ];
  for (const [input, want] of cases) check('T4', 'case ' + input.slice(0, 30), JSON.stringify(parseHash(input, now)) === JSON.stringify(want), JSON.stringify(parseHash(input, now)));
  check('T4', 'non-string hash', parseHash(42, now).note === 'bad-hash' && parseHash(null, now).note === '' && parseHash(undefined, now).seed === today);
  check('T4', 'SEED_RE', SEED_RE.test('a-b_C9') && !SEED_RE.test('') && !SEED_RE.test('a b') && !SEED_RE.test('x'.repeat(25)));

  // Every UTC date agrees with the platform, including leap days and times before 1970.
  const rng = mulberry32(7);
  let dateMisses = 0;
  for (let i = 0; i < 3000; i++) {
    const t = Math.floor((rng() * 2 - 0.3) * 4.1e12);
    if (todaySeed(t) !== new Date(t).toISOString().slice(0, 10)) dateMisses++;
  }
  check('T4', 'todaySeed matches the calendar', dateMisses === 0 && todaySeed(Date.UTC(2028, 1, 29, 23, 59, 59)) === '2028-02-29' && todaySeed(NaN) === '1970-01-01', dateMisses);

  check('T4', 'beats', beats({ grade: 'A', feet: 1300 }, { grade: 'A', feet: 1384 }) && !beats({ grade: 'A', feet: 1384 }, { grade: 'A', feet: 1384 }) &&
    beats({ grade: 'S', feet: 99999 }, { grade: 'A', feet: 1 }) && !beats({ grade: 'B', feet: 1 }, { grade: 'A', feet: 9 }) && !beats(null, { grade: 'D', feet: 1 }));
  const text = shareText({ seed: '2026-10-12', mode: 'practice', gleamPct: 87.3, points: 812, grade: 'A', feet: 1384, cleanLaps: 4 }, 'rink.invalid/#s=x');
  const lines = text.split('\n');
  check('T4', 'share text', lines.length === 4 && lines[0] === 'Between Periods · rink 2026-10-12' && lines[1] === 'Practice · Gleam A (812 pts) · 1,384 ft · 4 clean laps' &&
    lines[2] === '🟦'.repeat(9) + '⬜' && lines[3] === 'rink.invalid/#s=x', text);
  out.cases = cases.length;
  return out;
}

// ---- T5 game wiring: which laps answer a challenge --------------------------------------------------

// game.js is a browser module, so Node lends it a stand-in page: the slice of document, window and the canvas
// that boot() and the actions touch. A hidden tab makes boot() play an #a= lap to its end on the spot; a visible
// tab runs on animation frames, which the test pumps by hand. Every app:* event is recorded.
function withPage(hash, hidden, body) {
  const none = () => {};
  const events = [];
  let pending = null;
  const stand = {
    document: {
      hidden,
      documentElement: { dataset: {} },
      addEventListener: none,
      removeEventListener: none,
      dispatchEvent: (e) => { events.push(e); return true; },
    },
    window: {
      location: { hash, origin: 'http://rink.invalid', pathname: '/' },
      history: { replaceState: none },
      localStorage: { getItem: () => null, setItem: none },
      matchMedia: () => ({ matches: false, addEventListener: none, removeEventListener: none }),
      requestAnimationFrame: (cb) => { pending = cb; return 1; },
      cancelAnimationFrame: () => { pending = null; },
      setTimeout: () => 1,
      addEventListener: none,
      removeEventListener: none,
      performance,
    },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
  };
  const saved = {};
  for (const name of Object.keys(stand)) {
    saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value: stand[name], configurable: true, writable: true });
  }
  const page = {
    events,
    // Run the animation frame the game asked for; false when it asked for none.
    frame(t) {
      const cb = pending;
      pending = null;
      if (cb) cb(t);
      return cb !== null;
    },
  };
  let game = null;
  try {
    game = createGame({ canvas: { addEventListener: none, removeEventListener: none, setPointerCapture: none }, toLogical: () => null });
    return body(game, page);
  } finally {
    if (game) game.destroy();
    for (const name of Object.keys(stand)) {
      if (saved[name]) Object.defineProperty(globalThis, name, saved[name]);
      else delete globalThis[name];
    }
  }
}

function playOut(game, page) {
  for (let i = 0, t = 0; i < 20000 && game.getView().phase === 'playing'; i++) {
    if (!page.frame((t += 1000 / 60))) break;
  }
}

function runT5() {
  const out = { botLaps: 0, humanLaps: 0 };
  // One bar that any lap clears and one that no lap reaches: a wrongly answered challenge shows as true or false.
  for (const bar of ['D-99999', 'S-1']) {
    const want = { grade: bar[0], feet: Number(bar.slice(2)) };
    const label = 'on a ' + bar + ' link ';
    const finishes = (page) => page.events.filter((e) => e.type === 'app:finish');
    const botLap = (game, page, how) => {
      const v = game.getView(), r = v.result;
      // The lap must really have ended, or "beat is null" would pass for the wrong reason.
      const ended = v.phase === 'done' && v.mode === 'auto' && !!r && r.mode === 'auto' && r.ticks > 600;
      check('T5', how + ' ' + label + 'ran to a bot result', ended, v.phase + '/' + v.mode + '/' + (r && r.ticks));
      if (!r) return;
      out.botLaps++;
      check('T5', how + ' ' + label + 'answers no challenge', r.beat === null, String(r.beat));
      const fin = finishes(page);
      check('T5', how + ' ' + label + 'app:finish carries the same unanswered result', fin.length === 1 && fin[0].detail.result === r);
      check('T5', how + ' ' + label + 'the challenge stays loaded for the player', JSON.stringify(v.challenge) === JSON.stringify(want), JSON.stringify(v.challenge));
      // A friend's link from a bot lap names the rink only: the bot's grade is never offered as a bar.
      check('T5', how + ' ' + label + 'shared link has no challenge', game.actions.shareText().split('\n')[3] === 'http://rink.invalid/#s=qa1', game.actions.shareText());
    };
    const humanLap = (game, mode, expected) => {
      game.actions.start(mode);
      game.actions.finish();
      const r = game.getView().result;
      out.humanLaps++;
      check('T5', mode + ' lap ' + label + 'answers ' + expected, !!r && r.mode === mode && r.beat === expected, r && r.mode + '/' + r.beat);
    };

    // The #a= hook: a hidden tab plays the whole bot lap inside boot().
    withPage('#s=qa1&a=mow&c=' + bar, true, (game, page) => {
      game.boot();
      botLap(game, page, '#a= hook');
    });

    // The Watch a lap button: a visible tab, the bot at 2x on pumped frames, then the player takes the wheel.
    withPage('#s=qa1&c=' + bar, false, (game, page) => {
      game.boot();
      game.actions.watch('mow');
      playOut(game, page);
      botLap(game, page, 'watch');
      humanLap(game, 'timed', bar === 'D-99999');
      humanLap(game, 'practice', null);
    });
  }
  return out;
}

// ---- run --------------------------------------------------------------------------------------------

const groups = { T1: runT1, T2: runT2, T3: runT3, T4: runT4, T5: runT5 };
for (const [name, fn] of Object.entries(groups)) {
  const t0 = Date.now();
  try {
    report[name] = fn();
  } catch (err) {
    failures.push(name + ': threw ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err));
  }
  if (report[name]) report[name].ms = Date.now() - t0;
}

const shown = failures.slice(0, 25);
console.log(JSON.stringify({ ok: failures.length === 0, ms: Date.now() - started, tuning: { speed: TUNING.speed, radius: TUNING.radius, swath: TUNING.swath, clockTicks: TUNING.clockTicks }, ...report, failures: shown, failureCount: failures.length }, null, 1));
process.exit(failures.length === 0 ? 0 : 1);
