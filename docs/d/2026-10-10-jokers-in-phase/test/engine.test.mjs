// Headless tests for the rules, the solver and the controller: node --test test/engine.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ACTIONS, N_HANDS, mulberry32, nextSeed, makeDeal, evalHand, openRound, swap, undo, play, preview, project,
  actionFor, applyInto, syncPct, makeScratch, stepInto,
} from '../js/engine.js';
import { solve, enumerate, hintFor } from '../js/solver.js';
import { createGame, parseHash } from '../js/game.js';
import * as tables from '../data/tables.js';
import * as engine from '../js/engine.js';
import * as solver from '../js/solver.js';
import * as game from '../js/game.js';
import { SIN, COS, HAND, JOKERS, OMEGA, PULL, F, W } from '../data/tables.js';
import { CHALLENGES, CHALLENGE_MAX_LOCK } from '../data/challenges.js';

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const names = (list) => Array.from(list, (j) => JOKERS[j]);
const ids = (...list) => list.map((id) => JOKERS.indexOf(id));
const phases = (lantern, ember, spark) => [0, 0, 0, 0, 0, lantern, ember, spark];

function advance(round, action) {
  const moved = action > 0 ? swap(round, ACTIONS[action][0], ACTIONS[action][1]) : { round, ok: true };
  assert.ok(moved.ok, `action ${action} is always legal at a beat boundary`);
  return play(moved.round).round;
}

function runLine(seed, k, line) {
  return [...line].reduce((round, letter) => advance(round, letter.charCodeAt(0) - 97), openRound(seed, k));
}

function trial(rail, ph, k, { cat = 0, hand = 0, pOff = 0 } = {}) {
  const out = makeScratch();
  const trace = { hand: 0, cat: 0, pts0: 0, mult0: 0, steps: [null, null, null, null, null], pts: 0, mult: 0, score: 0, flashN: 0 };
  stepInto(Int8Array.from(rail), Int16Array.from(ph), k, cat, hand, pOff, out, trace);
  return { out, trace, ph2: Array.from(out.ph).slice(5), flash: Array.from(out.flash).slice(5), steps: trace.steps };
}

test('every name the interface contract promises is exported with the right kind', () => {
  const kinds = [
    [engine, 'function', ['mulberry32', 'makeDeal', 'evalHand', 'openRound', 'swap', 'undo', 'play', 'preview', 'actionFor', 'syncPct']],
    [engine, 'number', ['P', 'N_HANDS']],
    [solver, 'function', ['solve', 'enumerate', 'hintFor']],
    [game, 'function', ['createGame']],
    [tables, 'number', ['TAU', 'LOCK']],
  ];
  for (const [module, kind, list] of kinds) for (const name of list) assert.equal(typeof module[name], kind, name);
  assert.deepEqual([engine.P, engine.N_HANDS, tables.TAU, tables.LOCK], [64, 4, 8, 92]);
  assert.equal(engine.ACTIONS.length, 26);
  for (const name of ['SIN', 'HAND', 'JOKERS', 'OMEGA', 'PULL', 'W', 'F']) assert.ok(Array.isArray(tables[name]), name);
  assert.deepEqual([tables.JOKERS.length, tables.PULL, tables.F, tables.W], [8, [0, 3, 5, 8], [6, 5, 4, 3], [0, 1000, 500, 250, 125]]);
  assert.deepEqual([tables.OMEGA[5], tables.OMEGA[6], tables.OMEGA[7]], [7, 10, 13]);
  assert.deepEqual(CHALLENGES, [{ id: 1, seed: 789, k: 0, par: 1025, best: 1864 }, { id: 2, seed: 3338, k: 1, par: 1894, best: 2706 }, { id: 3, seed: 9187, k: 2, par: 1531, best: 2785 }]);
  const controller = game.createGame({ target: null, storage: null, writeHash() {} });
  assert.deepEqual(Object.keys(controller).sort(), ['dispatch', 'start', 'vm']);
});

// ---- tables, PRNG, hands ---------------------------------------------------------------------------------------

test('SIN is a committed literal: spec prefix, checksum, symmetry, and it matches the rounded sine', () => {
  assert.equal(SIN.length, 64);
  assert.deepEqual(SIN.slice(0, 17), [0, 98, 195, 290, 383, 471, 556, 634, 707, 773, 831, 882, 924, 957, 981, 995, 1000]);
  assert.equal(SIN.reduce((sum, v) => sum + Math.abs(v), 0), 40708);
  for (let k = 0; k <= 16; k++) {
    assert.equal(SIN[32 - k], SIN[k]);
    assert.ok(SIN[32 + k] === -SIN[k], `SIN[${32 + k}]`);
  }
  SIN.forEach((v, k) => assert.equal(v, Math.round(1000 * Math.sin((2 * Math.PI * k) / 64)), `SIN[${k}]`));
  COS.forEach((v, k) => assert.equal(v, SIN[(k + 16) & 63]));
});

test('mulberry32 and nextSeed are pinned', () => {
  const r = mulberry32(1);
  assert.deepEqual([r(), r(), r()], [0.6270739405881613, 0.002735721180215478, 0.5274470399599522]);
  const again = mulberry32(1);
  assert.equal(again(), 0.6270739405881613);
  assert.deepEqual([789, 1, 99999, 3338].map(nextSeed), [37721, 78904, 25011, 44129]);
  for (let s = 1; s <= 99999; s += 7) assert.ok(nextSeed(s) >= 1 && nextSeed(s) <= 99999);
});

test('evalHand: exact category counts over all 2,598,960 hands', () => {
  const counts = new Array(9).fill(0);
  const hand = [0, 0, 0, 0, 0];
  let royal = 0;
  for (let a = 0; a < 48; a++) {
    hand[0] = a;
    for (let b = a + 1; b < 49; b++) {
      hand[1] = b;
      for (let c = b + 1; c < 50; c++) {
        hand[2] = c;
        for (let d = c + 1; d < 51; d++) {
          hand[3] = d;
          for (let e = d + 1; e < 52; e++) {
            hand[4] = e;
            const cat = evalHand(hand);
            counts[cat]++;
            if (cat === 8 && hand.every((x) => x % 13 + 2 >= 10)) royal++;
          }
        }
      }
    }
  }
  assert.deepEqual(counts, [1302540, 1098240, 123552, 54912, 10200, 5108, 3744, 624, 40]);
  assert.equal(royal, 4);
});

test('evalHand: the wheel is a straight, there is no wrap-around, a royal is a straight flush', () => {
  const card = (rank, suit) => rank - 2 + 13 * suit;
  assert.equal(evalHand([card(14, 0), card(2, 0), card(3, 1), card(4, 2), card(5, 3)]), 4);
  assert.equal(evalHand([card(14, 2), card(2, 2), card(3, 2), card(4, 2), card(5, 2)]), 8);
  assert.equal(evalHand([card(12, 0), card(13, 1), card(14, 2), card(2, 3), card(3, 0)]), 0);
  assert.equal(evalHand([card(10, 3), card(11, 3), card(12, 3), card(13, 3), card(14, 3)]), 8);
  assert.equal(evalHand([card(9, 0), card(9, 1), card(9, 2), card(9, 3), card(2, 0)]), 7);
  assert.equal(evalHand([card(9, 0), card(9, 1), card(9, 2), card(2, 3), card(2, 0)]), 6);
});

// ---- deals and the nine reference lines ------------------------------------------------------------------------

const DEALS = [
  { seed: 789, cats: '4010', ph: [59, 51, 28], pOff: 1, rail: 'spark,twofold,ember,tally,steady', bench: 'pendulum,handshake,lantern', first: [43, 31, 32, 7, 47] },
  { seed: 3338, cats: '1040', ph: [51, 36, 38], pOff: 1, rail: 'steady,twofold,pendulum,tally,spark', bench: 'handshake,lantern,ember', first: [2, 38, 1, 9, 12] },
  { seed: 9187, cats: '1004', ph: [41, 29, 36], pOff: 1, rail: 'steady,handshake,ember,twofold,pendulum', bench: 'tally,lantern,spark', first: [19, 14, 27, 30, 20] },
];

test('makeDeal reproduces the reference deals', () => {
  for (const want of DEALS) {
    const deal = makeDeal(want.seed);
    assert.equal(deal.cats.join(''), want.cats);
    assert.deepEqual(deal.ph0.slice(5), want.ph);
    assert.equal(deal.pOff, want.pOff);
    assert.equal(names(deal.rail).join(), want.rail);
    assert.equal(names(deal.bench).join(), want.bench);
    assert.deepEqual(deal.hands[0], want.first);
  }
});

test('makeDeal is a pure function of the seed and always well formed', () => {
  assert.deepEqual(makeDeal(4242), makeDeal(4242));
  for (let seed = 1; seed <= 3000; seed += 13) {
    const deal = makeDeal(seed);
    assert.equal(new Set(deal.hands.flat()).size, 20, 'twenty distinct cards');
    assert.ok(deal.hands.flat().every((c) => c >= 0 && c < 52));
    assert.deepEqual([...deal.rail, ...deal.bench].sort(), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.ok(deal.bench[0] < deal.bench[1] && deal.bench[1] < deal.bench[2], 'bench in catalog order');
    assert.ok(deal.ph0.slice(5).every((p) => p >= 0 && p < 64));
  }
});

const LINES = [
  [1, 'aaa', [280, 180, 360, 90], 910, 0],
  [1, 'haa', [280, 330, 432, 150], 1192, 0],
  [1, 'hra', [280, 330, 864, 390], 1864, 0],
  [2, 'aaa', [432, 345, 784, 270], 1831, 0],
  [2, 'hqa', [432, 540, 1344, 390], 2706, 0],
  [2, 'hnz', [432, 540, 896, 135], 2003, 3],
  [3, 'aaa', [144, 54, 60, 480], 738, 0],
  [3, 'uxm', [144, 195, 150, 2296], 2785, 2],
  [3, 'qlw', [144, 54, 1020, 420], 1638, 3],
];

test('the nine reference lines reproduce to the letter', () => {
  for (const [cid, line, scores, total, lock] of LINES) {
    const { seed, k } = CHALLENGES[cid - 1];
    const round = runLine(seed, k, line);
    assert.deepEqual(round.scores, scores, `#c=${cid}&l=${line}`);
    assert.equal(round.total, total);
    assert.equal(round.lock, lock);
    assert.equal(round.line, line);
    assert.equal(round.hand, N_HANDS);
  }
});

test('phases after hand 1 match the reference (Lantern, Ember, Spark)', () => {
  const want = [[2, 61, 41], [58, 46, 51], [48, 39, 49]];
  CHALLENGES.forEach(({ seed, k }, i) => assert.deepEqual(openRound(seed, k).ph.slice(5), want[i]));
});

// ---- solver ----------------------------------------------------------------------------------------------------

test('the exact solver finds the shipped par, best, bestLine and goldLine', () => {
  const want = [
    { best: 1864, bestLine: 'hra', maxLock: 0, goldBest: 0, goldLine: '' },
    { best: 2706, bestLine: 'hqa', maxLock: 3, goldBest: 2003, goldLine: 'hnz' },
    { best: 2785, bestLine: 'uxm', maxLock: 3, goldBest: 1638, goldLine: 'qlw' },
  ];
  CHALLENGES.forEach(({ seed, k, best, par }, i) => {
    const sol = solve(openRound(seed, k));
    assert.deepEqual(sol, want[i]);
    assert.equal(sol.best, best);
    assert.equal(sol.maxLock, CHALLENGE_MAX_LOCK[i]);
    assert.ok(par < best, 'par is reachable');
  });
});

test('the solver and enumerate agree with play() on every one of the 17,576 lines', () => {
  const { seed, k } = CHALLENGES[1];
  const open = openRound(seed, k);
  const seen = new Map();
  let visits = 0;
  let previous = '';
  enumerate(open, (v) => {
    assert.ok(v.line > previous, 'ascending order');
    previous = v.line;
    visits++;
    seen.set(v.line, [v.total, v.lock, names(v.rail).join()]);
  });
  assert.equal(visits, 17576);
  for (let a = 0; a < 26; a++) {
    const r1 = advance(open, a);
    for (let b = 0; b < 26; b++) {
      const r2 = advance(r1, b);
      for (let c = 0; c < 26; c++) {
        const r3 = advance(r2, c);
        assert.deepEqual([r3.total, r3.lock, names(r3.rail).join()], seen.get(LETTERS[a] + LETTERS[b] + LETTERS[c]));
      }
    }
  }
});

test('solving from a later beat searches only the remaining windows from the post-hand arrangement', () => {
  const { seed, k } = CHALLENGES[0];
  const afterH = runLine(seed, k, 'h');
  const sol = solve(afterH);
  assert.equal(sol.best, 1864);
  assert.equal(sol.bestLine, 'ra');
  const pending = swap(afterH, 0, 2).round;
  assert.deepEqual(solve(pending), sol, 'a pending swap does not change the search');
  let lines = 0;
  enumerate(afterH, () => lines++);
  assert.equal(lines, 676);
  const done = runLine(seed, k, 'hra');
  assert.deepEqual(solve(done), { best: 1864, bestLine: '', maxLock: 0, goldBest: 0, goldLine: '' });
  assert.deepEqual(hintFor(runLine(seed, k, 'hr')), { noop: true, a: -1, b: -1 });
  assert.deepEqual(hintFor(openRound(seed, k)), { noop: false, a: 1, b: 4 });
  assert.deepEqual(hintFor(runLine(CHALLENGES[2].seed, 2, 'u')), { noop: false, a: 4, b: 5 }, 'x is the rail slot 4 with the first bench joker');
});

test('depth criteria hold for every shipped challenge', () => {
  const finalRails = [];
  for (const { id, seed, k, par } of CHALLENGES) {
    const open = openRound(seed, k);
    const sol = solve(open);
    const totals = [];
    const nearBest = new Set();
    let gold = 0;
    let oneSwapReachesPar = false;
    let bestRail = '';
    enumerate(open, (v) => {
      totals.push(v.total);
      if (v.lock === 3) gold++;
      const rail = names(v.rail).join();
      if (v.total >= 0.95 * sol.best) nearBest.add(rail);
      if (v.line === sol.bestLine) bestRail = rail;
      if (v.total >= par && [...v.line].filter((c) => c !== 'a').length === 1) oneSwapReachesPar = true;
    });
    totals.sort((x, y) => x - y);
    const median = (totals[totals.length / 2 - 1] + totals[totals.length / 2]) / 2;
    const aaa = runLine(seed, k, 'aaa');
    assert.ok(aaa.total < par && aaa.lock === 0, `C${id}: doing nothing misses par`);
    assert.ok(sol.best >= 1.5 * median, `C${id}: the best line stands out`);
    assert.ok(nearBest.size >= 2, `C${id}: more than one rail is near the best`);
    finalRails.push(bestRail);
    if (id === 1) assert.ok(oneSwapReachesPar, 'one well-chosen swap reaches par in challenge 1');
    if (id > 1) {
      assert.ok(gold / totals.length > 0.01 && gold / totals.length < 0.1, `C${id}: gold share ${gold}`);
      assert.notEqual(sol.goldLine, sol.bestLine, `C${id}: the best score is not the gold line`);
      assert.ok(sol.goldBest >= 0.5 * sol.best && sol.goldBest <= 0.9 * sol.best && sol.goldBest >= par, `C${id}: gold total`);
    }
  }
  assert.equal(new Set(finalRails).size, 3, 'the three best rails differ');
});

// ---- swaps -----------------------------------------------------------------------------------------------------

test('ACTIONS: 26 entries, rail pairs then rail-bench pairs, letters a..z', () => {
  assert.equal(ACTIONS.length, 26);
  assert.deepEqual(ACTIONS.slice(0, 11), [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [1, 2], [1, 3], [1, 4], [2, 3], [2, 4], [3, 4]]);
  for (let r = 0; r < 5; r++) for (let t = 0; t < 3; t++) assert.deepEqual(ACTIONS[11 + 3 * r + t], [r, 5 + t]);
});

test('every action round-trips through swap, actionFor and the line letter, and each gives a different arrangement', () => {
  for (const seed of [1, 789, 9187, 54321]) {
    const round = openRound(seed, 1);
    const arrangements = new Set();
    for (let action = 0; action < 26; action++) {
      const moved = action === 0 ? round : swap(round, ACTIONS[action][0], ACTIONS[action][1]).round;
      assert.equal(actionFor(round.base, moved), action);
      assert.equal(play(moved).round.line, LETTERS[action]);
      arrangements.add(moved.rail.concat(moved.bench).join());
      const flat = Int8Array.from(round.rail.concat(round.bench));
      const into = new Int8Array(8);
      applyInto(into, flat, action);
      assert.deepEqual(Array.from(into), moved.rail.concat(moved.bench));
      assert.ok(into[5] < into[6] && into[6] < into[7], 'bench stays in catalog order');
    }
    assert.equal(arrangements.size, 26);
  }
});

test('swap: one transposition per beat, bench re-sorted, undo and the same-slot rules', () => {
  const round = openRound(789, 0); // rail spark,twofold,ember,tally,steady; bench pendulum,handshake,lantern
  const first = swap(round, 0, 1);
  assert.deepEqual([first.ok, first.reason, names(first.round.rail).join()], [true, null, 'twofold,spark,ember,tally,steady']);
  assert.deepEqual(swap(first.round, 2, 3), { round: first.round, ok: false, reason: 'limit' });
  assert.deepEqual(swap(first.round, 0, 6), { round: first.round, ok: false, reason: 'limit' });
  const back = swap(first.round, 0, 1);
  assert.ok(back.ok);
  assert.equal(actionFor(back.round.base, back.round), 0, 'swapping back is no change at all');
  assert.deepEqual(undo(first.round).rail, round.rail);

  const viaBench = swap(round, 0, 5); // pendulum in, spark out, bench re-sorted
  assert.deepEqual(names(viaBench.round.rail), ['pendulum', 'twofold', 'ember', 'tally', 'steady']);
  assert.deepEqual(names(viaBench.round.bench), ['handshake', 'lantern', 'spark']);
  const twice = swap(viaBench.round, 0, 5); // handshake in: still one transposition of the base (slot 0 with the handshake)
  assert.ok(twice.ok);
  assert.equal(actionFor(round.base, twice.round), 12);

  for (const [a, b] of [[3, 3], [5, 6], [6, 7], [5, 7], [-1, 2], [2, 8], [0.5, 1], [NaN, 1], ['1', 2], [null, undefined]]) {
    assert.deepEqual(swap(round, a, b), { round, ok: false, reason: 'same' }, `swap(${a}, ${b})`);
  }
  const played = play(first.round).round;
  assert.ok(swap(played, 2, 3).ok, 'a new beat allows a new swap');
  assert.deepEqual(swap(runLine(789, 0, 'aaa'), 0, 1).reason, 'limit', 'nothing is swappable after the last hand');
});

test('the rules never mutate a round they are given', () => {
  const deepFreeze = (value) => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.freeze(value);
      Object.values(value).forEach(deepFreeze);
    }
    return value;
  };
  const round = deepFreeze(runLine(3338, 1, 'h'));
  const copy = structuredClone(round);
  swap(round, 0, 1);
  swap(round, 2, 6);
  swap(round, 5, 6);
  undo(swap(round, 0, 3).round);
  play(swap(round, 1, 4).round);
  preview(round);
  project(round);
  actionFor(round.base, round);
  solve(round);
  hintFor(round);
  enumerate(round, () => {});
  assert.deepEqual(round, copy);
});

// ---- phase dynamics and scoring --------------------------------------------------------------------------------

test('Fireflies keep their own beat with coupling off, and wrap past the top to flash', () => {
  const t = trial(ids('lantern', 'ember', 'spark', 'steady', 'twofold'), phases(10, 60, 50), 0);
  assert.deepEqual(t.ph2, [17, 6, 63]);
  assert.deepEqual(t.flash, [0, 1, 0]);
  assert.deepEqual(trial(ids('lantern', 'steady', 'twofold', 'tally', 'ember'), phases(57, 0, 0), 0).flash.slice(0, 1), [1]);
  assert.deepEqual(trial(ids('lantern', 'steady', 'twofold', 'tally', 'ember'), phases(56, 0, 0), 0).flash.slice(0, 1), [0]);
});

test('coupling: neighbours ahead pull, neighbours behind push back, weights fall with slot distance', () => {
  const t = trial(ids('lantern', 'ember', 'steady', 'twofold', 'tally'), phases(0, 16, 0), 1);
  assert.deepEqual(t.ph2, [7 + 3, 16 + 10 - 3, 13], 'Spark on the bench is uncoupled');
  const pulls = { 1: [3, 1, 0, 0], 2: [5, 2, 1, 0], 3: [8, 4, 2, 1] };
  for (const k of [1, 2, 3]) {
    for (let d = 1; d <= 4; d++) {
      const rail = ids('steady', 'twofold', 'tally', 'pendulum', 'handshake');
      rail[0] = JOKERS.indexOf('lantern');
      rail[d] = JOKERS.indexOf('ember');
      const lantern = trial(rail, phases(0, 16, 0), k).ph2[0];
      assert.equal(lantern, OMEGA[5] + pulls[k][d - 1], `k=${k} distance ${d}`);
    }
  }
});

test('coupling: truncation is toward zero, the step never goes below zero, benched Fireflies are never pulled', () => {
  const behind = trial(ids('lantern', 'steady', 'ember', 'twofold', 'tally'), phases(16, 0, 0), 1);
  assert.equal(behind.ph2[0], 16 + 7 - 1, 'trunc(-1.5) is -1, not -2');
  const stalled = trial(ids('lantern', 'ember', 'spark', 'steady', 'twofold'), phases(16, 0, 0), 3);
  assert.deepEqual(stalled.ph2, [16, 18, 17]);
  assert.deepEqual(stalled.flash, [0, 0, 0]);
  const bench = trial(ids('lantern', 'steady', 'twofold', 'tally', 'pendulum'), phases(0, 16, 16), 3);
  assert.deepEqual(bench.ph2, [7, 26, 29]);
});

test('scoring: left to right, so order matters (the worked example on the About panel)', () => {
  assert.deepEqual(HAND[1], [6, 2]);
  const early = trial(ids('steady', 'twofold', 'lantern', 'ember', 'spark'), phases(0, 0, 0), 0, { cat: 1 });
  const late = trial(ids('twofold', 'steady', 'lantern', 'ember', 'spark'), phases(0, 0, 0), 0, { cat: 1 });
  assert.deepEqual([early.trace.pts, early.trace.mult, early.trace.score], [6, 12, 72]);
  assert.deepEqual([late.trace.pts, late.trace.mult, late.trace.score], [6, 8, 48]);
});

test('the Pendulum swings out (+8 mult) and back (x2) by hand parity and the deal offset', () => {
  const rail = ids('pendulum', 'steady', 'tally', 'lantern', 'ember');
  const read = (hand, pOff) => {
    const step = trial(rail, phases(0, 0, 0), 0, { hand, pOff }).steps[0];
    return [step.kind, step.value, step.why];
  };
  assert.deepEqual(read(0, 0), ['add', 8, 'out']);
  assert.deepEqual(read(1, 0), ['mul', 2, 'back']);
  assert.deepEqual(read(2, 0), ['add', 8, 'out']);
  assert.deepEqual(read(0, 1), ['mul', 2, 'back']);
  assert.deepEqual(read(3, 1), ['add', 8, 'out']);
});

test('Handshake: edges, unphased neighbours, and the match tolerance across the wrap', () => {
  const shake = (rail, ph, opts) => trial(ids(...rail), ph, 0, opts).steps.find((s) => s.id === 'handshake');
  const why = (rail, ph, opts) => shake(rail, ph, opts).why;
  assert.equal(why(['handshake', 'pendulum', 'lantern', 'steady', 'twofold'], phases(0, 0, 0)), 'edge');
  assert.equal(why(['steady', 'twofold', 'tally', 'lantern', 'handshake'], phases(0, 0, 0)), 'edge');
  assert.equal(why(['steady', 'handshake', 'lantern', 'twofold', 'tally'], phases(0, 0, 0)), 'unphased');
  assert.equal(why(['lantern', 'handshake', 'tally', 'steady', 'twofold'], phases(0, 0, 0)), 'unphased');
  // Pendulum on the left sits at ring 0 on an out beat; Lantern advances by 7, so its new phase is ph + 7.
  const rail = ['pendulum', 'handshake', 'lantern', 'steady', 'twofold'];
  for (const [lantern, expected] of [[1, 'match'], [2, 'apart'], [57, 'match'], [49, 'match'], [48, 'apart'], [56, 'match']]) {
    assert.equal(why(rail, phases(lantern, 0, 0)), expected, `Lantern ph ${lantern} -> ${(lantern + 7) % 64}`);
  }
  assert.equal(why(rail, phases(33, 0, 0), { hand: 1 }), 'match', 'on the back beat the Pendulum is at 32 (33 + 7 = 40)');
  assert.equal(why(rail, phases(34, 0, 0), { hand: 1 }), 'apart');
  const between = ['lantern', 'handshake', 'ember', 'steady', 'twofold'];
  const close = shake(between, phases(0, 0, 0)); // new phases 7 and 10
  assert.deepEqual([close.why, close.kind, close.value], ['match', 'mul', 3]);
  const far = shake(between, phases(0, 20, 0)); // new phases 7 and 30
  assert.deepEqual([far.why, far.kind, far.value], ['apart', 'idle', 0]);
});

test('Fireflies that flash together each add F[k] times the number flashing; the others stay dark', () => {
  for (let k = 0; k <= 3; k++) {
    const t = trial(ids('lantern', 'steady', 'ember', 'twofold', 'spark'), phases(60, 60, 0), k, { cat: 0 });
    const flashing = t.steps.filter((s) => s.why === 'flash');
    assert.equal(t.trace.flashN, flashing.length);
    assert.ok(flashing.length >= 1);
    for (const s of flashing) assert.deepEqual([s.kind, s.value, s.n], ['add', F[k] * flashing.length, flashing.length]);
    const dark = t.steps.find((s) => s.id === 'spark');
    assert.deepEqual([dark.kind, dark.value, dark.why, dark.n], ['idle', 0, 'dim', null]);
  }
});

test('trace bookkeeping: running totals, final score, one step per slot in slot order', () => {
  for (const [cid, line] of [[1, 'hra'], [2, 'hnz'], [3, 'uxm']]) {
    let round = openRound(CHALLENGES[cid - 1].seed, CHALLENGES[cid - 1].k);
    for (const letter of line) {
      const action = letter.charCodeAt(0) - 97;
      if (action > 0) round = swap(round, ACTIONS[action][0], ACTIONS[action][1]).round;
      const peek = preview(round);
      const { trace } = play(round);
      assert.deepEqual(peek, trace, 'preview is exactly what play scores');
      round = play(round).round;
      assert.equal(trace.steps.length, 5);
      trace.steps.forEach((s, i) => assert.equal(s.slot, i));
      assert.equal(trace.steps[4].pts, trace.pts);
      assert.equal(trace.steps[4].mult, trace.mult);
      assert.equal(trace.score, trace.pts * trace.mult);
      assert.deepEqual([trace.pts0, trace.mult0], HAND[trace.cat]);
    }
  }
});

// A naive restatement of the written rules (maps, modulo, floats for the order parameter) to check the optimised path.
function reference(rail, ph, k, cat, hand, pOff) {
  const slot = new Map(rail.map((j, i) => [j, i]));
  const next = {};
  const flash = {};
  for (const f of [5, 6, 7]) {
    let step = OMEGA[f];
    if (k > 0 && slot.has(f)) {
      let c = 0;
      for (const g of [5, 6, 7]) {
        if (g !== f && slot.has(g)) c += Math.trunc((PULL[k] * W[Math.abs(slot.get(f) - slot.get(g))] * SIN[(((ph[g] - ph[f]) % 64) + 64) % 64]) / 1e6);
      }
      step = Math.min(63, Math.max(0, step + c));
    }
    flash[f] = ph[f] + step >= 64;
    next[f] = (ph[f] + step) % 64;
  }
  let [pts, mult] = HAND[cat];
  const n = rail.filter((j) => j >= 5 && flash[j]).length;
  const side = (hand + pOff) % 2;
  const ring = (j) => (j === 3 ? side * 32 : next[j]);
  const circ = (a, b) => Math.min(((a - b) % 64 + 64) % 64, 64 - (((a - b) % 64) + 64) % 64);
  rail.forEach((j, s) => {
    if (j === 0) mult += 4;
    else if (j === 1) mult *= 2;
    else if (j === 2) pts += 12;
    else if (j === 3) mult = side === 0 ? mult + 8 : mult * 2;
    else if (j === 4) {
      const [left, right] = [rail[s - 1], rail[s + 1]];
      if (s >= 1 && s <= 3 && (left === 3 || left >= 5) && (right === 3 || right >= 5) && circ(ring(left), ring(right)) <= 8) mult *= 3;
    } else if (flash[j]) mult += F[k] * n;
  });
  const flies = rail.filter((j) => j >= 5);
  const R = (set) => Math.hypot(...[Math.cos, Math.sin].map((fn) => set.reduce((sum, j) => sum + fn((2 * Math.PI * next[j]) / 64), 0))) / set.length;
  const pairs = flies.flatMap((a, i) => flies.slice(i + 1).map((b) => R([a, b])));
  const margin = [...pairs, ...(flies.length === 3 ? [R(flies)] : [])].reduce((m, r) => Math.min(m, Math.abs(r - 0.92)), 1);
  const lock = flies.length === 3 && R(flies) >= 0.92 ? 3 : pairs.some((r) => r >= 0.92) ? 2 : 0;
  return { score: pts * mult, ph: [5, 6, 7].map((f) => next[f]), flash: [5, 6, 7].map((f) => (flash[f] ? 1 : 0)), lock: k > 0 ? lock : 0, margin };
}

test('the optimised step equals a naive restatement of the rules on 6,000 random configurations', () => {
  const rng = mulberry32(2026);
  const pick = (n) => Math.floor(rng() * n);
  let locked = 0;
  for (let i = 0; i < 6000; i++) {
    const rail = [0, 1, 2, 3, 4, 5, 6, 7];
    for (let a = rail.length - 1; a > 0; a--) {
      const b = pick(a + 1);
      [rail[a], rail[b]] = [rail[b], rail[a]];
    }
    const ph = phases(pick(64), pick(64), pick(64));
    const [k, cat, hand, pOff] = [pick(4), pick(9), pick(4), pick(2)];
    const want = reference(rail.slice(0, 5), ph, k, cat, hand, pOff);
    const got = trial(rail.slice(0, 5), ph, k, { cat, hand, pOff });
    assert.equal(got.trace.score, want.score, `case ${i}`);
    assert.deepEqual(got.ph2, want.ph);
    assert.deepEqual(got.flash, want.flash);
    if (want.margin > 0.004) assert.equal(got.out.lock, want.lock, `lock, case ${i}`);
    if (got.out.lock > 0) locked++;
  }
  assert.ok(locked > 100, 'the random cases exercise both lock levels');
});

test('syncPct agrees with the floating-point order parameter within one percent', () => {
  const rng = mulberry32(77);
  for (let i = 0; i < 2000; i++) {
    const ph = phases(Math.floor(rng() * 64), Math.floor(rng() * 64), Math.floor(rng() * 64));
    const members = [[5, 6], [5, 7], [6, 7], [5, 6, 7]][i % 4];
    const x = members.reduce((sum, j) => sum + Math.cos((2 * Math.PI * ph[j]) / 64), 0);
    const y = members.reduce((sum, j) => sum + Math.sin((2 * Math.PI * ph[j]) / 64), 0);
    const exact = (100 * Math.hypot(x, y)) / members.length;
    assert.ok(Math.abs(syncPct(members, ph) - Math.floor(exact + 1e-9)) <= 1, `${members} ${ph}`);
  }
  assert.equal(syncPct([5, 6, 7], phases(0, 32, 0)), 33);
  assert.equal(syncPct([5, 6], phases(0, 32, 0)), 0);
  assert.equal(syncPct([], phases(0, 0, 0)), 0);
});

// ---- hash grammar ----------------------------------------------------------------------------------------------

test('parseHash: valid forms, clipping, defaults, foreign anchors and rejections', () => {
  const ok = (hash) => parseHash(hash);
  assert.deepEqual(ok('#c=2'), { status: 'ok', cid: 2, seed: 3338, k: 1, line: '', clipped: false });
  assert.deepEqual(ok('c=3&l=uxm'), { status: 'ok', cid: 3, seed: 9187, k: 2, line: 'uxm', clipped: false });
  assert.deepEqual(ok('#s=00789&k=0&l=h'), { status: 'ok', cid: 0, seed: 789, k: 0, line: 'h', clipped: false });
  assert.deepEqual(ok('#s=99999'), { status: 'ok', cid: 0, seed: 99999, k: 2, line: '', clipped: false });
  assert.deepEqual(ok('#c=1&l=abcdefgh'), { status: 'ok', cid: 1, seed: 789, k: 0, line: 'abc', clipped: true });
  assert.deepEqual(ok('#c=1&s=5&k=3'), { status: 'ok', cid: 1, seed: 789, k: 0, line: '', clipped: false }, 'c beats s and k');
  assert.deepEqual(ok('#c=2&c=9&x=1&&l=h'), { status: 'ok', cid: 2, seed: 3338, k: 1, line: 'h', clipped: false }, 'first duplicate wins, unknown keys ignored');
  assert.equal(ok('').status, 'empty');
  assert.equal(ok('#').status, 'empty');
  assert.equal(ok(undefined).status, 'empty');
  for (const anchor of ['#main', '#about', '#x=1&y=2', '#C=1']) assert.equal(ok(anchor).status, 'foreign', anchor);
  const bad = ['#c=4', '#c=0', '#c=', '#c', '#c=12', '#s=0', '#s=100000', '#s=123456', '#s=-5', '#s=1.5', '#s=abc', '#s=5&k=4', '#s=5&k=', '#s=5&k=-1',
    '#c=1&l=', '#c=1&l=ABC', '#c=1&l=abcdefghi', '#c=1&l=a1', '#k=1', '#l=hra', '#c=1&s=x', '#c=1%26l=a', `#c=1&l=${'a'.repeat(70)}`, `#${'x'.repeat(65)}`];
  for (const hash of bad) assert.equal(ok(hash).status, 'bad', hash);
});

// ---- the controller --------------------------------------------------------------------------------------------

function rig(options = {}) {
  const target = new EventTarget();
  const store = new Map(options.store ?? []);
  const hashes = [];
  const states = [];
  target.addEventListener('app:state', (event) => states.push(event.detail));
  const storage = options.storage === undefined
    ? { getItem: (key) => (store.has(key) ? store.get(key) : null), setItem: (key, value) => void store.set(key, value) }
    : options.storage;
  const game = createGame({ target, storage, writeHash: options.writeHash ?? ((hash) => hashes.push(hash)) });
  const act = (type, params = {}) => game.dispatch({ type, ...params });
  const move = (letter) => {
    const action = letter.charCodeAt(0) - 97;
    if (action > 0) act('swap', { a: ACTIONS[action][0], b: ACTIONS[action][1] });
    act('play');
  };
  return { game, target, store, hashes, states, act, move, last: () => states[states.length - 1], vm: () => game.vm() };
}

test('start: challenge 1 opens with hand 1 played, a straight, and a preview of hand 2', () => {
  const g = rig();
  assert.equal(g.vm(), null);
  g.act('play');
  assert.equal(g.states.length, 0, 'actions before start are ignored');
  g.game.start('');
  const { vm, trace, animate } = g.last();
  assert.equal(animate, false);
  assert.deepEqual([trace.hand, trace.score, trace.cat], [0, 280, 4]);
  assert.deepEqual([vm.mode, vm.challenge.id, vm.challenge.par, vm.challenge.best, vm.challenge.maxLock], ['challenge', 1, 1025, 1864, 0]);
  assert.deepEqual(vm.round, { hand: 1, hands: 4, finished: false, attempt: 1, misses: 0, canPlay: true, canUndo: false, hintReady: true });
  assert.deepEqual(vm.deal.map((h) => [h.cat, h.status, h.score]), [[4, 'played', 280], [0, 'next', null], [1, 'waiting', null], [0, 'waiting', null]]);
  assert.deepEqual(vm.deal[0].cards[0], { r: 6, s: 3 });
  assert.deepEqual([vm.pos.slice(0, 5).join(), vm.pos.slice(5).join()], ['spark,twofold,ember,tally,steady', 'pendulum,handshake,lantern']);
  assert.deepEqual([vm.total, vm.lock, vm.lockEvent, vm.next.score, vm.hint, vm.result, vm.notice], [280, 0, 0, 180, null, null, null]);
  assert.deepEqual(vm.phases.now.map((r) => [r.id, r.ring, r.onRail, r.flash, r.side]), [['pendulum', 32, false, false, 1], ['lantern', 2, false, false, null], ['ember', 61, true, false, null], ['spark', 41, true, false, null]]);
  assert.deepEqual(vm.phases.next.map((r) => [r.id, r.ring, r.flash]), [['pendulum', 0, false], ['lantern', 9, false], ['ember', 7, true], ['spark', 54, false]]);
  assert.deepEqual([vm.sync, vm.phases.bridge], [{ n: 2, now: null, next: null, lock: 92 }, null]);
  assert.deepEqual(vm.share, { hash: '#c=1', card: { rail: ['spark', 'twofold', 'ember', 'tally', 'steady'], seed: 789, k: 0, total: 280, cid: 1, line: '', tier: 'none' } });
  assert.deepEqual(g.hashes, [], 'a valid incoming hash is never rewritten');
});

test('start: ignores a hash equal to the current one and in-page anchors; rewrites bad and clipped hashes once', () => {
  const g = rig();
  g.game.start('#c=2&l=h');
  const count = g.states.length;
  g.game.start('#c=2&l=h');
  g.game.start('#main');
  assert.equal(g.states.length, count, 'no new state');
  assert.deepEqual(g.hashes, []);
  g.game.start('#c=9');
  assert.deepEqual([g.vm().notice, g.vm().challenge.id, g.vm().share.hash, g.hashes], [{ code: 'bad-hash' }, 1, '#c=1', ['#c=1']]);
  g.game.start('#s=789&k=1&l=hraxyz');
  assert.deepEqual([g.vm().notice, g.vm().share.hash, g.hashes.at(-1), g.vm().round.finished], [{ code: 'line-clipped' }, '#s=789&k=1&l=hra', '#s=789&k=1&l=hra', true]);
  g.game.start('');
  assert.deepEqual([g.vm().notice, g.vm().challenge.id, g.vm().round.hand], [null, 1, 1], 'an empty hash is a fresh Challenge 1');
});

test('start: a shipped deal answers from data in its first state, and the exact solve that follows changes and emits nothing', async () => {
  for (const { id, best } of CHALLENGES) {
    const g = rig();
    g.game.start(`#c=${id}`);
    const first = JSON.stringify(g.last());
    const count = g.states.length;
    assert.deepEqual([g.vm().challenge.best, g.vm().challenge.maxLock], [best, CHALLENGE_MAX_LOCK[id - 1]], `challenge ${id}: first state`);
    await new Promise((resolve) => setTimeout(resolve, 30)); // the confirming solve runs in a timer queued by start()
    assert.equal(g.states.length, count, `challenge ${id}: the data was right, so the confirming solve emits nothing`);
    assert.equal(JSON.stringify(g.last()), first, `challenge ${id}: the state is untouched`);
    g.act('play');
    assert.equal(g.vm().round.hand, 2, `challenge ${id}: play still works after the confirming solve`);
    assert.equal(g.vm().challenge.best, best);
  }
});

test('l= round trip: replaying a link equals playing the same moves, and the hash is written after each play', () => {
  const rng = mulberry32(5);
  for (let i = 0; i < 60; i++) {
    const cid = i % 4;
    const line = Array.from({ length: i % 4 }, () => LETTERS[Math.floor(rng() * 26)]).join('');
    const hash = cid === 0 ? `#s=${1 + Math.floor(rng() * 99999)}&k=${i % 4}` : `#c=${cid}`;
    const linked = rig();
    linked.game.start(line ? `${hash}&l=${line}` : hash);
    const played = rig();
    played.game.start(hash);
    for (const letter of line) played.move(letter);
    const ownProgress = (vm) => ({ ...vm, challenge: { ...vm.challenge, bestSaved: null, cardSaved: 'none' }, round: { ...vm.round, misses: 0 } });
    const [a, b] = [linked.vm(), played.vm()];
    assert.deepEqual(ownProgress(a), ownProgress(b), `${hash} ${line}`);
    assert.equal(a.share.hash, line ? `${hash}&l=${line}` : hash);
    assert.deepEqual(played.hashes.at(-1), line ? `${hash}&l=${line}` : undefined);
    assert.equal(parseHash(a.share.hash).line, line);
  }
  const g = rig();
  g.game.start('#c=3&l=qlw');
  assert.deepEqual([g.vm().total, g.vm().lock, g.vm().lockEvent, g.vm().result.card, g.last().animate, g.last().trace.score], [1638, 3, 3, 'gold', false, 420]);
  assert.equal(g.store.size, 0, 'a friend\'s line is never saved as your best');
});

test('play, swap, undo, retry, challenge: state, notices, animate flag and hash writes', () => {
  const g = rig();
  g.game.start('#c=2');
  g.act('swap', { a: 1, b: 4 });
  assert.deepEqual([g.last().trace, g.last().animate, g.vm().changed, g.vm().round.canUndo, g.vm().next.score], [null, false, [1, 4], true, 540]);
  assert.equal(g.vm().pos.slice(0, 5).join(), 'steady,spark,pendulum,tally,twofold');
  g.act('swap', { a: 2, b: 3 });
  assert.deepEqual(g.vm().notice, { code: 'swap-limit' });
  assert.deepEqual(g.vm().changed, [1, 4], 'the rejected swap changed nothing');
  g.act('undo');
  assert.deepEqual([g.vm().notice, g.vm().changed, g.vm().round.canUndo], [null, [], false]);
  g.act('swap', { a: '1', b: '4' });
  g.act('play');
  assert.deepEqual([g.last().animate, g.last().trace.score, g.vm().round.hand, g.vm().total, g.vm().share.hash, g.hashes.at(-1)], [true, 540, 2, 972, '#c=2&l=h', '#c=2&l=h']);
  assert.deepEqual(g.vm().deal.map((h) => h.status), ['played', 'played', 'next', 'waiting']);
  g.act('retry');
  assert.deepEqual([g.vm().round.attempt, g.vm().round.hand, g.vm().total, g.vm().share.hash, g.hashes.at(-1), g.last().trace.score], [2, 1, 432, '#c=2', '#c=2', 432]);
  g.act('challenge', { id: 3 });
  assert.deepEqual([g.vm().challenge.id, g.vm().round.attempt, g.vm().challenge.hasNext, g.hashes.at(-1)], [3, 1, false, '#c=3']);
  const count = g.states.length;
  for (const bad of [{ id: 4 }, { id: 0 }, { id: 'x' }, {}]) g.act('challenge', bad);
  g.act('bogus');
  g.game.dispatch(null);
  g.game.dispatch('play');
  g.game.dispatch({});
  assert.equal(g.states.length, count, 'unknown or malformed actions emit nothing');
  for (const detail of [undefined, null, 7, 'play', [], { type: 42 }, { type: 'Play' }, { type: 'constructor' }, { type: '__proto__' }]) {
    g.target.dispatchEvent(new CustomEvent('app:action', { detail }));
  }
  assert.equal(g.states.length, count, 'junk events are ignored');
  g.target.dispatchEvent(new CustomEvent('app:action', { detail: { type: 'play' } }));
  assert.equal(g.vm().round.hand, 2, 'app:action events reach dispatch');
});

test('starting the deal that is already on the table counts as another attempt', () => {
  const g = rig();
  g.game.start('#c=2');
  g.act('retry');
  assert.equal(g.vm().round.attempt, 2);
  g.game.start('#c=2&l=h');
  assert.equal(g.vm().round.attempt, 3);
  g.act('sandbox', { seed: 3338, k: 1 });
  assert.equal(g.vm().round.attempt, 1, 'a sandbox deal is not the challenge');
  g.act('sandbox', { seed: 3338, k: 1 });
  assert.equal(g.vm().round.attempt, 2);
  g.act('sandbox', { seed: 3338, k: 2 });
  assert.equal(g.vm().round.attempt, 1);
});

test('finishing a round: result, cards, saved progress that never goes backwards, no swaps afterwards', () => {
  const g = rig();
  g.game.start('#c=2');
  for (const letter of 'hnz') g.move(letter);
  assert.deepEqual(g.vm().result, { total: 2003, par: 1894, parMet: true, lock: 3, card: 'gold', best: 2706 });
  assert.deepEqual([g.vm().round.finished, g.vm().round.canPlay, g.vm().phases.next, g.vm().next, g.vm().sync.next, g.vm().lockEvent], [true, false, null, null, null, 3]);
  assert.deepEqual(g.vm().share.card, { rail: ['ember', 'spark', 'pendulum', 'tally', 'lantern'], seed: 3338, k: 1, total: 2003, cid: 2, line: 'hnz', tier: 'gold' });
  assert.deepEqual(JSON.parse(g.store.get('jip.v1.progress')), { v: 1, best: { 1: 0, 2: 2003, 3: 0 }, card: { 1: 'none', 2: 'gold', 3: 'none' } });
  assert.deepEqual([g.vm().challenge.bestSaved, g.vm().challenge.cardSaved], [2003, 'gold']);
  const before = g.vm();
  g.act('swap', { a: 0, b: 1 });
  assert.deepEqual([g.vm().notice, g.vm().changed, g.vm().pos], [null, [], before.pos], 'no swap after the last hand');
  g.act('play');
  g.act('undo');
  assert.deepEqual(g.vm(), { ...before, lockEvent: 0 }, 'extra play and undo change nothing but the glow');
  g.act('retry');
  for (const letter of 'hqa') g.move(letter);
  assert.deepEqual(g.vm().result, { total: 2706, par: 1894, parMet: true, lock: 0, card: 'par', best: 2706 });
  assert.deepEqual([g.vm().challenge.bestSaved, g.vm().challenge.cardSaved], [2706, 'gold']);
  g.act('retry');
  for (const letter of 'aaa') g.move(letter);
  assert.deepEqual([g.vm().result.card, g.vm().result.parMet, g.vm().challenge.bestSaved, g.vm().challenge.cardSaved], ['none', false, 2706, 'gold']);
  g.act('challenge', { id: 3 });
  for (const letter of 'uxm') g.move(letter);
  assert.deepEqual([g.vm().result.card, g.vm().lock, g.vm().challenge.cardSaved], ['silver', 2, 'silver']);
});

test('saved progress is validated on read and storage failures are silent', () => {
  const key = 'jip.v1.progress';
  const good = rig({ store: [[key, JSON.stringify({ v: 1, best: { 1: 1500, 2: 0, 3: 99999999 }, card: { 1: 'silver', 2: 'none', 3: 'gold' } })]] });
  good.game.start('#c=1');
  assert.deepEqual([good.vm().challenge.bestSaved, good.vm().challenge.cardSaved], [1500, 'silver']);
  good.game.start('#c=2');
  assert.deepEqual([good.vm().challenge.bestSaved, good.vm().challenge.cardSaved], [null, 'none'], 'zero means nothing saved');
  good.game.start('#c=3');
  assert.deepEqual([good.vm().challenge.bestSaved, good.vm().challenge.cardSaved], [99999999, 'gold']);
  const junk = [
    'not json', '{"v":2,"best":{"1":5}}', '{"v":1,"best":{"1":-3,"2":1.5,"3":1e12},"card":{"1":"platinum","2":7,"3":"constructor"}}',
    '{"v":1,"best":null,"card":[]}', 'null', '[]', '"gold"', '',
  ];
  for (const raw of junk) {
    const g = rig({ store: [[key, raw]] });
    g.game.start('#c=1');
    assert.deepEqual([g.vm().challenge.bestSaved, g.vm().challenge.cardSaved, g.vm().fatal], [null, 'none', false], raw);
  }
  const hostile = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('full'); },
  };
  for (const storage of [hostile, null, undefined]) {
    const g = rig({ storage });
    g.game.start('#c=1');
    for (const letter of 'hra') g.move(letter);
    assert.deepEqual([g.vm().result.card, g.vm().fatal], ['par', false]);
  }
});

test('hints: always in challenge 1 and the sandbox, after three missed rounds in challenges 2 and 3', () => {
  const g = rig();
  g.game.start('#c=1');
  g.act('swap', { a: 0, b: 2 });
  g.act('hint');
  assert.deepEqual([g.vm().hint, g.vm().changed, g.vm().notice], [{ noop: false, a: 1, b: 4 }, [], null], 'a pending swap is put back first');
  g.act('swap', { a: 1, b: 4 });
  assert.equal(g.vm().hint, null, 'a swap clears the hint');
  g.act('undo');
  g.move('h');
  g.move('r');
  g.act('hint');
  assert.deepEqual(g.vm().hint, { noop: true, a: -1, b: -1 }, 'the best last move is to hold still');
  g.move('a');
  g.act('hint');
  assert.deepEqual([g.vm().hint, g.vm().notice], [null, { code: 'no-hint' }], 'no hint once the round is over');

  g.act('challenge', { id: 2 });
  assert.equal(g.vm().round.hintReady, false);
  g.act('hint');
  assert.deepEqual([g.vm().hint, g.vm().notice], [null, { code: 'no-hint' }]);
  for (let round = 1; round <= 3; round++) {
    for (const letter of 'aaa') g.move(letter);
    assert.deepEqual([g.vm().result.parMet, g.vm().round.misses], [false, round]);
    g.act('retry');
  }
  assert.deepEqual([g.vm().round.hintReady, g.vm().round.misses], [true, 3]);
  g.act('hint');
  assert.deepEqual([g.vm().hint, g.vm().notice], [{ noop: false, a: 1, b: 4 }, null]);
  g.act('challenge', { id: 3 });
  assert.deepEqual([g.vm().round.hintReady, g.vm().round.misses], [false, 0], 'misses are counted per challenge');

  g.act('sandbox', { seed: 31, k: 3 });
  assert.equal(g.vm().round.hintReady, true);
  g.act('hint');
  assert.deepEqual(g.vm().hint, hintFor(openRound(31, 3)), 'the sandbox hint is the exact solver move');
});

test('sandbox: free deal with an exact best, par at 70 percent of it, no cards, no lock glow', () => {
  const g = rig();
  g.game.start('#c=1');
  g.act('sandbox');
  assert.deepEqual([g.vm().mode, g.vm().challenge.id, g.vm().challenge.seed, g.vm().challenge.k, g.hashes.at(-1)], ['sandbox', 0, nextSeed(789), 2, `#s=${nextSeed(789)}&k=2`]);
  g.act('sandbox', { seed: 3338, k: 1 });
  const vm = g.vm();
  assert.deepEqual([vm.challenge.best, vm.challenge.par, vm.challenge.maxLock, vm.challenge.bestSaved, vm.challenge.cardSaved, vm.challenge.hasNext], [2706, 1894, 3, null, 'none', false]);
  assert.equal(vm.challenge.par, Math.floor(0.7 * 2706));
  for (const letter of 'hnz') g.move(letter);
  assert.deepEqual([g.vm().total, g.vm().lock, g.vm().lockEvent, g.vm().result.card, g.vm().result.lock, g.vm().share.card.tier], [2003, 0, 0, 'none', 0, 'none']);
  assert.equal(g.store.size, 0, 'the sandbox saves nothing');
  g.act('sandbox');
  assert.equal(g.vm().challenge.k, 1, 'the coupling is kept when dealing again from the sandbox');
  assert.equal(g.vm().challenge.seed, nextSeed(3338));
  g.act('sandbox', { seed: 0 });
  assert.deepEqual([g.vm().challenge.seed, g.vm().notice], [1, { code: 'seed-clamped' }]);
  g.act('sandbox', { seed: 1e9, k: 9 });
  assert.deepEqual([g.vm().challenge.seed, g.vm().challenge.k, g.vm().notice], [99999, 3, { code: 'seed-clamped' }]);
  g.act('sandbox', { seed: '42', k: '0' });
  assert.deepEqual([g.vm().challenge.seed, g.vm().challenge.k, g.vm().notice], [42, 0, null]);
  g.act('sandbox', { seed: 'abc' });
  assert.deepEqual([g.vm().challenge.seed, g.vm().notice], [nextSeed(42), { code: 'seed-clamped' }]);
  g.act('challenge', { id: 2 });
  g.act('sandbox', { seed: 5 });
  assert.equal(g.vm().challenge.k, 2, 'a sandbox deal from a challenge starts at Medium');
  assert.equal(g.vm().sync.lock, 92);
});

test('lock glow fires once, on the state right after the hand that raised the lock', () => {
  const g = rig();
  g.game.start('#c=3');
  for (const letter of 'qlw') g.move(letter);
  assert.deepEqual(g.states.filter((s) => s.animate).map((s) => s.vm.lockEvent), [2, 0, 3]);
  assert.deepEqual(g.states.filter((s) => s.animate).map((s) => s.vm.lock), [2, 2, 3]);
  g.act('retry');
  assert.deepEqual([g.vm().lock, g.vm().lockEvent], [0, 0]);
});

test('view-model: the Handshake bridge follows its neighbours and the sync meter follows the rail Fireflies', () => {
  const g = rig();
  g.game.start('#c=3');
  assert.equal(g.vm().phases.bridge, null, 'the Handshake sits beside the Steady, which has no phase');
  assert.deepEqual([g.vm().sync.n, g.vm().sync.now, g.vm().sync.next], [1, null, null], 'one Firefly cannot be in step with itself');
  g.act('swap', { a: 0, b: 6 }); // Lantern in for the Steady, Steady out to the bench
  const vm = g.vm();
  assert.deepEqual(vm.pos.slice(0, 5), ['lantern', 'handshake', 'ember', 'twofold', 'pendulum']);
  const ring = (rows, id) => rows.find((row) => row.id === id).ring;
  const gap = (a, b) => Math.min((a - b + 64) % 64, (b - a + 64) % 64);
  assert.deepEqual(vm.phases.bridge, { a: 'lantern', b: 'ember', ok: gap(ring(vm.phases.next, 'lantern'), ring(vm.phases.next, 'ember')) <= 8 });
  assert.equal(vm.phases.bridge.ok, vm.next.steps[1].why === 'match');
  const flies = ids('lantern', 'ember');
  const ph = (rows) => rows.reduce((all, row) => { all[JOKERS.indexOf(row.id)] = row.ring; return all; }, new Array(8).fill(0));
  assert.deepEqual([vm.sync.n, vm.sync.now, vm.sync.next], [2, syncPct(flies, ph(vm.phases.now)), syncPct(flies, ph(vm.phases.next))]);
  assert.ok(vm.sync.now !== null && vm.sync.next !== null);
});

test('a failing action becomes a fatal view-model, never an exception, and a fresh start recovers', () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const g = rig();
    g.game.start('#c=1');
    g.game.dispatch({ get type() { throw new Error('boom'); } });
    assert.equal(g.vm().fatal, true);
    assert.equal(g.last().vm.fatal, true);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /boom/);
    g.game.start('#c=2');
    assert.deepEqual([g.vm().fatal, g.vm().challenge.id], [false, 2]);
    const broken = rig({ writeHash() { throw new Error('no history'); } });
    broken.game.start('#c=1&l=abcd');
    assert.equal(broken.vm().fatal, true);
    assert.equal(broken.vm().deal.length, 4, 'even the fallback view-model is complete');
    broken.game.start('#c=3&l=abcd');
    assert.equal(broken.vm().fatal, true, 'still failing, still contained');
    broken.game.start('#c=3');
    assert.equal(broken.vm().fatal, false, 'a clean start recovers');
  } finally {
    console.warn = original;
  }
});

// ---- view-model shape under fuzz -------------------------------------------------------------------------------

const int = (lo, hi) => (x) => Number.isInteger(x) && x >= lo && x <= hi;
const oneOf = (...allowed) => (x) => allowed.includes(x);
const bool = (x) => typeof x === 'boolean';
const maybe = (spec) => ({ maybe: spec });
const each = (spec, length) => ({ each: spec, length });
const JOKER_ID = oneOf(...JOKERS);
const CARD = oneOf('none', 'par', 'silver', 'gold');
const ROW = { id: oneOf('pendulum', 'lantern', 'ember', 'spark'), ring: int(0, 63), onRail: bool, flash: bool, side: maybe(int(0, 1)) };
const STEP = { slot: int(0, 4), id: JOKER_ID, kind: oneOf('add', 'mul', 'pts', 'idle'), value: int(0, 1e9), why: maybe(oneOf('out', 'back', 'flash', 'match', 'dim', 'edge', 'unphased', 'apart')), n: maybe(int(1, 3)), pts: int(0, 1e9), mult: int(0, 1e9) };
const TRACE = { hand: int(0, 3), cat: int(0, 8), pts0: int(1, 99), mult0: int(1, 9), steps: each(STEP, 5), pts: int(0, 1e9), mult: int(0, 1e9), score: int(0, 1e12), flashN: int(0, 3) };
const VM = {
  v: oneOf(1),
  fatal: bool,
  notice: maybe({ code: oneOf('swap-limit', 'bad-hash', 'seed-clamped', 'line-clipped', 'no-hint') }),
  mode: oneOf('challenge', 'sandbox'),
  challenge: { id: int(0, 3), seed: int(1, 99999), k: int(0, 3), par: int(0, 1e9), best: int(0, 1e9), maxLock: oneOf(0, 2, 3), bestSaved: maybe(int(1, 99999999)), cardSaved: CARD, hasNext: bool },
  round: { hand: int(1, 4), hands: oneOf(4), finished: bool, attempt: int(1, 1e6), misses: int(0, 1e6), canPlay: bool, canUndo: bool, hintReady: bool },
  deal: each({ cards: each({ r: int(2, 14), s: int(0, 3) }, 5), cat: int(0, 8), base: { pts: int(1, 99), mult: int(1, 9) }, status: oneOf('played', 'next', 'waiting'), score: maybe(int(1, 1e12)) }, 4),
  pos: each(JOKER_ID, 8),
  changed: each(int(0, 7)),
  phases: { P: oneOf(64), now: each(ROW, 4), next: maybe(each(ROW, 4)), bridge: maybe({ a: JOKER_ID, b: JOKER_ID, ok: bool }) },
  sync: { n: int(0, 3), now: maybe(int(0, 100)), next: maybe(int(0, 100)), lock: oneOf(92) },
  total: int(0, 1e12),
  lock: oneOf(0, 2, 3),
  lockEvent: oneOf(0, 2, 3),
  next: maybe(TRACE),
  hint: maybe({ noop: bool, a: int(-1, 7), b: int(-1, 7) }),
  result: maybe({ total: int(0, 1e12), par: int(0, 1e9), parMet: bool, lock: oneOf(0, 2, 3), card: CARD, best: int(0, 1e9) }),
  share: { hash: (x) => typeof x === 'string' && /^#(c=[123]|s=[0-9]{1,5}&k=[0-3])(&l=[a-z]{1,3})?/.test(x), card: { rail: each(JOKER_ID, 5), seed: int(1, 99999), k: int(0, 3), total: int(0, 1e12), cid: int(0, 3), line: (x) => /^[a-z]{0,3}/.test(x) && x.length <= 3, tier: CARD } },
};

function expectShape(value, spec, path) {
  if (typeof spec === 'function') return assert.ok(spec(value), `${path} = ${JSON.stringify(value)}`);
  if (spec.maybe) return value === null ? undefined : expectShape(value, spec.maybe, path);
  if (spec.each) {
    assert.ok(Array.isArray(value), `${path} is a list`);
    if (spec.length !== undefined) assert.equal(value.length, spec.length, `${path}.length`);
    return value.forEach((item, i) => expectShape(item, spec.each, `${path}[${i}]`));
  }
  assert.ok(value !== null && typeof value === 'object', `${path} is an object`);
  assert.deepEqual(Object.keys(value).sort(), Object.keys(spec).sort(), `${path} has exactly the contract keys`);
  return Object.keys(spec).forEach((key) => expectShape(value[key], spec[key], `${path}.${key}`));
}

function expectCoherent(vm) {
  expectShape(vm, VM, 'vm');
  assert.deepEqual(JSON.parse(JSON.stringify(vm)), vm, 'JSON clean: no undefined, NaN or typed arrays');
  const played = vm.deal.filter((h) => h.status === 'played');
  assert.equal(played.length, vm.round.hand);
  assert.equal(vm.total, played.reduce((sum, h) => sum + h.score, 0));
  assert.equal(vm.round.finished, vm.round.hand === 4);
  assert.deepEqual([vm.result !== null, vm.next === null, vm.phases.next === null, vm.sync.next === null || vm.round.finished || vm.sync.n > 1], [vm.round.finished, vm.round.finished, vm.round.finished, true]);
  assert.deepEqual([...vm.pos].sort(), [...JOKERS].sort());
  assert.ok(vm.pos.slice(5).every((id, i, list) => i === 0 || JOKERS.indexOf(list[i - 1]) < JOKERS.indexOf(id)), 'bench in catalog order');
  assert.equal(vm.round.canUndo, vm.changed.length > 0);
  assert.equal(vm.mode === 'sandbox', vm.challenge.id === 0);
  if (vm.mode === 'sandbox' || vm.challenge.k === 0) assert.deepEqual([vm.lock, vm.lockEvent], [0, 0]);
  if (vm.challenge.k === 0) assert.deepEqual([vm.sync.now, vm.sync.next], [null, null]);
  const parsed = parseHash(vm.share.hash);
  assert.equal(parsed.status, 'ok');
  assert.deepEqual([parsed.cid, parsed.seed, parsed.k, parsed.line], [vm.challenge.id, vm.challenge.seed, vm.challenge.k, vm.share.card.line]);
  assert.equal(vm.share.card.tier, vm.result ? vm.result.card : 'none');
}

test('random actions, good and bad: every emission is whole, coherent and never fatal', () => {
  const rng = mulberry32(99);
  const pick = (n) => Math.floor(rng() * n);
  const junk = [undefined, null, NaN, -1, 8, 99, 0.5, '', 'x', '3', {}, [], true, 1e9, Infinity];
  const makers = [
    () => ({ type: 'play' }),
    () => ({ type: 'play' }),
    () => ({ type: 'swap', a: pick(8), b: pick(8) }),
    () => ({ type: 'swap', a: pick(8), b: pick(8) }),
    () => ({ type: 'swap', a: junk[pick(junk.length)], b: junk[pick(junk.length)] }),
    () => ({ type: 'undo' }),
    () => ({ type: 'retry' }),
    () => ({ type: 'hint' }),
    () => ({ type: 'challenge', id: 1 + pick(3) }),
    () => ({ type: 'challenge', id: junk[pick(junk.length)] }),
    () => ({ type: 'sandbox', seed: junk[pick(junk.length)], k: junk[pick(junk.length)] }),
    () => ({ type: 'sandbox', seed: 1 + pick(99999), k: pick(4) }),
    () => ({ type: junk[pick(junk.length)] }),
    () => junk[pick(junk.length)],
  ];
  const g = rig();
  g.game.start('');
  let emitted = 0;
  for (let i = 0; i < 2000; i++) {
    const action = makers[pick(makers.length)]();
    const before = g.states.length;
    g.game.dispatch(action);
    if (g.states.length > before) {
      emitted++;
      expectCoherent(g.last().vm);
      assert.equal(g.last().vm.fatal, false);
      assert.equal(g.last().animate, action.type === 'play' && g.last().trace !== null);
    }
    assert.deepEqual(g.vm(), g.last().vm, 'vm() returns the latest emission');
  }
  assert.ok(emitted > 1200);
});

test('hash fuzz: random strings never throw and always land on a whole, coherent state', () => {
  const rng = mulberry32(1234);
  const alphabet = '#&=cslk123abz90- %xé';
  for (let i = 0; i < 1000; i++) {
    const length = Math.floor(rng() * 40);
    const text = Array.from({ length }, () => alphabet[Math.floor(rng() * alphabet.length)]).join('');
    const hash = rng() < 0.5 ? `#${text}` : text;
    const parsed = parseHash(hash);
    assert.ok(['empty', 'foreign', 'bad', 'ok'].includes(parsed.status));
    const g = rig();
    g.game.start(hash);
    const { vm } = g.last();
    expectCoherent(vm);
    if (parsed.status === 'bad') {
      assert.deepEqual([vm.challenge.id, vm.round.hand, vm.notice, g.hashes], [1, 1, { code: 'bad-hash' }, ['#c=1']], JSON.stringify(hash));
    } else if (parsed.status === 'ok') {
      assert.deepEqual([vm.challenge.id, vm.challenge.seed, vm.challenge.k], [parsed.cid, parsed.seed, parsed.k]);
      assert.equal(vm.notice !== null, parsed.clipped);
    } else {
      assert.deepEqual([vm.challenge.id, vm.notice, g.hashes], [1, null, []]);
    }
  }
  for (const odd of [undefined, null, 42, {}, [], Symbol.iterator, () => 0]) {
    const g = rig();
    g.game.start(odd);
    assert.equal(g.vm().challenge.id, 1);
  }
});

// ---- budgets and source hygiene --------------------------------------------------------------------------------

test('speed: start with its exact solve under 100 ms, swap plus preview and play under 5 ms', () => {
  const g = rig();
  const startTimes = [];
  for (let seed = 500; seed < 512; seed++) {
    const t0 = performance.now();
    g.game.start(`#s=${seed}&k=${seed % 4}`);
    startTimes.push(performance.now() - t0);
  }
  startTimes.sort((x, y) => x - y);
  assert.ok(startTimes[6] < 100, `median start ${startTimes[6].toFixed(1)} ms`);
  const swapTimes = [];
  const playTimes = [];
  let round = openRound(789, 2);
  for (let i = 0; i < 300; i++) {
    const t0 = performance.now();
    const moved = swap(round, i % 5, 5 + (i % 3));
    preview(moved.round);
    const t1 = performance.now();
    const done = play(moved.round);
    playTimes.push(performance.now() - t1);
    swapTimes.push(t1 - t0);
    round = done.round.hand >= N_HANDS ? openRound(789 + i, 2) : done.round;
  }
  swapTimes.sort((x, y) => x - y);
  playTimes.sort((x, y) => x - y);
  assert.ok(swapTimes[150] < 5 && playTimes[150] < 5, `swap+preview ${swapTimes[150].toFixed(3)} ms, play ${playTimes[150].toFixed(3)} ms`);
});

test('state paths use no clock, no randomness and no floating-point maths; nothing else breaks the page rules', () => {
  const read = (name) => readFileSync(new URL(`../js/${name}`, import.meta.url), 'utf8');
  const banned = /Math\.(random|sin|cos|exp|pow|log|sqrt)\b|\bDate\b|performance\.now/;
  for (const name of ['engine.js', 'solver.js', 'game.js']) assert.doesNotMatch(read(name), banned, name);
  for (const name of ['engine.js', 'solver.js', 'game.js', 'main.js']) {
    const source = read(name);
    assert.doesNotMatch(source, /console\.error|https?:\/\//, name);
    assert.doesNotMatch(source, /\bdocument\.(?:getElementById|querySelector)/, `${name} leaves the DOM to the UI`);
  }
  for (const name of ['engine.js', 'solver.js']) assert.doesNotMatch(read(name), /\b(?:document|window|localStorage|location|history)\b/, `${name} stays DOM-free`);
});
