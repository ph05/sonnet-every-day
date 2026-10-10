// Pure rules for Jokers In Phase: seeded deal, hand evaluator, integer phase dynamics, scoring and swaps.
// No DOM, no clock, no floating-point maths in the state paths: a shared link must replay the same scores everywhere.
import { SIN, COS, HAND, JOKERS, FX, OMEGA, PULL, F, W, TAU, LOCK } from '../data/tables.js';

export const P = 64;
export const N_HANDS = 4;
// A line of play is one letter per swap before a hand: a = no swap, b..z = the other 25 actions (see ACTIONS).
export const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

const MASK = P - 1;
const [STEADY, TWOFOLD, TALLY, PENDULUM, HANDSHAKE] = ['steady', 'twofold', 'tally', 'pendulum', 'handshake'].map((id) => JOKERS.indexOf(id));
export const FIRST_FIREFLY = JOKERS.indexOf('lantern');
const WHEEL = (1 << 14) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5); // A-2-3-4-5, the only low straight

export function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function nextSeed(s) {
  return (((Math.imul(s, 1664525) + 1013904223) >>> 0) % 99999) + 1;
}

function shuffle(list, rng) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = list[i];
    list[i] = list[j];
    list[j] = t;
  }
  return list;
}

// ---- hands -------------------------------------------------------------------------------------------------

const RANK_COUNT = new Uint8Array(15);

// Category 0..8 of five card numbers (0..51, rank = c % 13 + 2, suit = floor(c / 13)).
// Nine exclusive classes; a royal flush is a straight flush; the only low straight is A-2-3-4-5.
export function evalHand(cards) {
  let mask = 0;
  let flush = true;
  const suit = (cards[0] / 13) | 0;
  for (let i = 0; i < 5; i++) {
    const c = cards[i];
    RANK_COUNT[(c % 13) + 2]++;
    mask |= 1 << ((c % 13) + 2);
    if (((c / 13) | 0) !== suit) flush = false;
  }
  let distinct = 0;
  let most = 0;
  for (let i = 0; i < 5; i++) {
    const r = (cards[i] % 13) + 2;
    const n = RANK_COUNT[r];
    if (n === 0) continue;
    distinct++;
    if (n > most) most = n;
    RANK_COUNT[r] = 0;
  }
  if (most === 4) return 7;
  if (most === 3) return distinct === 2 ? 6 : 3;
  if (most === 2) return distinct === 3 ? 2 : 1;
  const low = 31 - Math.clz32(mask & -mask);
  const high = 31 - Math.clz32(mask);
  if (high - low === 4 || mask === WHEEL) return flush ? 8 : 4;
  return flush ? 5 : 0;
}

// Fixed draw order: deck shuffle, three Firefly phases, Pendulum offset, joker order.
export function makeDeal(seed) {
  const rng = mulberry32(seed);
  const deck = shuffle(Array.from({ length: 52 }, (_, i) => i), rng);
  const hands = [0, 1, 2, 3].map((h) => deck.slice(h * 5, h * 5 + 5));
  const ph0 = [0, 0, 0, 0, 0, 0, 0, 0];
  for (let f = FIRST_FIREFLY; f < JOKERS.length; f++) ph0[f] = Math.floor(rng() * P);
  const pOff = rng() < 0.5 ? 0 : 1;
  const order = shuffle([0, 1, 2, 3, 4, 5, 6, 7], rng);
  return {
    seed,
    hands,
    cats: hands.map(evalHand),
    ph0,
    pOff,
    rail: order.slice(0, 5),
    bench: order.slice(5).sort((a, b) => a - b),
  };
}

// ---- phases, scoring and lock (allocation-free; the solver calls these 18,000 times per deal) --------------------

const SLOT_OF = new Int8Array(8);
const FIREFLIES = new Int8Array(3);

// Every Firefly advances by its own beat; on the rail it is also pulled by the other rail Fireflies, nearest first.
// Reads only the OLD phases, so the update is order-independent. Writes new phases and "wrapped past the top" flags.
function advanceInto(rail, ph, k, out, flash) {
  SLOT_OF[FIRST_FIREFLY] = SLOT_OF[FIRST_FIREFLY + 1] = SLOT_OF[FIRST_FIREFLY + 2] = -1;
  for (let i = 0; i < 5; i++) if (rail[i] >= FIRST_FIREFLY) SLOT_OF[rail[i]] = i;
  for (let f = FIRST_FIREFLY; f < JOKERS.length; f++) {
    let step = OMEGA[f];
    const slot = SLOT_OF[f];
    if (k > 0 && slot >= 0) {
      let pull = 0;
      for (let g = FIRST_FIREFLY; g < JOKERS.length; g++) {
        if (g === f || SLOT_OF[g] < 0) continue;
        const dist = slot > SLOT_OF[g] ? slot - SLOT_OF[g] : SLOT_OF[g] - slot;
        pull += Math.trunc((PULL[k] * W[dist] * SIN[(ph[g] - ph[f]) & MASK]) / 1000000);
      }
      step = Math.min(63, Math.max(0, step + pull));
    }
    const raw = ph[f] + step;
    flash[f] = raw >= P ? 1 : 0;
    out[f] = raw & MASK;
  }
}

function circ(a, b) {
  const d = (a - b) & MASK;
  return d < P - d ? d : P - d;
}

const isPhased = (j) => j === PENDULUM || j >= FIRST_FIREFLY;

// Score one hand with the phases already advanced. With rec, also writes the step-by-step trace.
function scoreInto(rail, cat, h, pOff, ph2, flash, k, rec) {
  let pts = HAND[cat][0];
  let mult = HAND[cat][1];
  let n = 0;
  for (let i = 0; i < 5; i++) if (rail[i] >= FIRST_FIREFLY && flash[rail[i]]) n++;
  const side = (h + pOff) & 1;
  const pendulumRing = side === 0 ? 0 : 32;
  if (rec) {
    rec.hand = h;
    rec.cat = cat;
    rec.pts0 = pts;
    rec.mult0 = mult;
    rec.flashN = n;
  }
  for (let slot = 0; slot < 5; slot++) {
    const j = rail[slot];
    let kind = 'idle';
    let value = 0;
    let why = null;
    let together = null;
    if (j === STEADY) {
      kind = 'add';
      value = FX.STEADY_MULT;
      mult += value;
    } else if (j === TWOFOLD) {
      kind = 'mul';
      value = FX.TWOFOLD_FACTOR;
      mult *= value;
    } else if (j === TALLY) {
      kind = 'pts';
      value = FX.TALLY_POINTS;
      pts += value;
    } else if (j === PENDULUM) {
      if (side === 0) {
        kind = 'add';
        value = FX.PENDULUM_OUT;
        why = 'out';
        mult += value;
      } else {
        kind = 'mul';
        value = FX.PENDULUM_BACK;
        why = 'back';
        mult *= value;
      }
    } else if (j === HANDSHAKE) {
      if (slot === 0 || slot === 4) {
        why = 'edge';
      } else if (!isPhased(rail[slot - 1]) || !isPhased(rail[slot + 1])) {
        why = 'unphased';
      } else {
        const left = rail[slot - 1] === PENDULUM ? pendulumRing : ph2[rail[slot - 1]];
        const right = rail[slot + 1] === PENDULUM ? pendulumRing : ph2[rail[slot + 1]];
        if (circ(left, right) <= TAU) {
          kind = 'mul';
          value = FX.HANDSHAKE_FACTOR;
          why = 'match';
          mult *= value;
        } else {
          why = 'apart';
        }
      }
    } else if (flash[j]) {
      kind = 'add';
      value = F[k] * n;
      why = 'flash';
      together = n;
      mult += value;
    } else {
      why = 'dim';
    }
    if (rec) rec.steps[slot] = { slot, id: JOKERS[j], kind, value, why, n: together, pts, mult };
  }
  if (rec) {
    rec.pts = pts;
    rec.mult = mult;
    rec.score = pts * mult;
  }
  return pts * mult;
}

// Sync as an integer percent: the largest p in 0..100 with |sum of unit phase vectors| / count >= p / 100.
export function syncPct(ids, ph) {
  if (ids.length === 0) return 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < ids.length; i++) {
    sx += COS[ph[ids[i]]];
    sy += SIN[ph[ids[i]]];
  }
  const total = (sx * sx + sy * sy) * 10000;
  const span = 1000 * ids.length;
  let lo = 0;
  let hi = 100;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (mid * mid * span * span <= total) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function locked(sx, sy, count) {
  const span = 1000 * count;
  return (sx * sx + sy * sy) * 10000 >= LOCK * LOCK * span * span;
}

// 3 when all three Fireflies are on the rail and in step, 2 when some rail pair is, else 0.
function lockOf(rail, ph2) {
  let count = 0;
  for (let i = 0; i < 5; i++) if (rail[i] >= FIRST_FIREFLY) FIREFLIES[count++] = rail[i];
  if (count < 2) return 0;
  if (count === 3) {
    const a = ph2[FIREFLIES[0]];
    const b = ph2[FIREFLIES[1]];
    const c = ph2[FIREFLIES[2]];
    if (locked(COS[a] + COS[b] + COS[c], SIN[a] + SIN[b] + SIN[c], 3)) return 3;
  }
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      const a = ph2[FIREFLIES[i]];
      const b = ph2[FIREFLIES[j]];
      if (locked(COS[a] + COS[b], SIN[a] + SIN[b], 2)) return 2;
    }
  }
  return 0;
}

export function makeScratch() {
  return { ph: new Int16Array(8), flash: new Uint8Array(8), score: 0, lock: 0 };
}

// One whole hand: advance the phases, score, measure lock. The new phases land in out.ph; rec (optional) gets a trace.
export function stepInto(rail, ph, k, cat, h, pOff, out, rec) {
  advanceInto(rail, ph, k, out.ph, out.flash);
  out.score = scoreInto(rail, cat, h, pOff, out.ph, out.flash, k, rec);
  out.lock = k > 0 ? lockOf(rail, out.ph) : 0;
}

// ---- swaps -------------------------------------------------------------------------------------------------

// 0 none; 1..10 the rail pairs; 11..25 = (rail slot r, bench joker t) at 11 + 3r + t. Positions: 0-4 rail, 5-7 bench.
export const ACTIONS = (() => {
  const list = [[0, 0]];
  for (let a = 0; a < 5; a++) for (let b = a + 1; b < 5; b++) list.push([a, b]);
  for (let r = 0; r < 5; r++) for (let t = 0; t < 3; t++) list.push([r, 5 + t]);
  return list;
})();

function exchange(dst, src, a, b) {
  for (let i = 0; i < 8; i++) dst[i] = src[i];
  let t = dst[a];
  dst[a] = dst[b];
  dst[b] = t;
  if (b > 4 || a > 4) {
    // The bench is always shown in catalog order: a three-element bubble pass.
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 5; i < 7; i++) {
        if (dst[i] > dst[i + 1]) {
          t = dst[i];
          dst[i] = dst[i + 1];
          dst[i + 1] = t;
        }
      }
    }
  }
}

// dst and src hold eight joker indices: five rail slots, then the three bench jokers.
export function applyInto(dst, src, action) {
  exchange(dst, src, ACTIONS[action][0], ACTIONS[action][1]);
}

const TRY = new Int8Array(8);

// The single action that turns baseRound's arrangement into curRound's, or -1 when it takes more than one.
export function actionFor(baseRound, curRound) {
  const base = baseRound.rail.concat(baseRound.bench);
  const cur = curRound.rail.concat(curRound.bench);
  for (let action = 0; action < ACTIONS.length; action++) {
    applyInto(TRY, base, action);
    let same = true;
    for (let i = 0; i < 8 && same; i++) same = TRY[i] === cur[i];
    if (same) return action;
  }
  return -1;
}

const isPos = (x) => Number.isInteger(x) && x >= 0 && x <= 7;

// One swap per beat: the result must be the post-hand arrangement plus at most one transposition.
export function swap(round, a, b) {
  if (round.hand >= N_HANDS) return { round, ok: false, reason: 'limit' };
  if (!isPos(a) || !isPos(b) || a === b || (a > 4 && b > 4)) return { round, ok: false, reason: 'same' };
  const arr = new Int8Array(8);
  exchange(arr, round.rail.concat(round.bench), a, b);
  const next = { ...round, rail: Array.from(arr.subarray(0, 5)), bench: Array.from(arr.subarray(5)) };
  if (actionFor(round.base, next) < 0) return { round, ok: false, reason: 'limit' };
  return { round: next, ok: true, reason: null };
}

export function undo(round) {
  return { ...round, rail: round.base.rail, bench: round.base.bench };
}

// ---- rounds ------------------------------------------------------------------------------------------------

function newTrace() {
  return { hand: 0, cat: 0, pts0: 0, mult0: 0, steps: [null, null, null, null, null], pts: 0, mult: 0, score: 0, flashN: 0 };
}

// The next hand for the current arrangement, without committing it: the trace plus the phases, flashes and lock it leaves.
export function project(round) {
  if (round.hand >= N_HANDS) return null;
  const out = makeScratch();
  const trace = newTrace();
  stepInto(Int8Array.from(round.rail), Int16Array.from(round.ph), round.k, round.cats[round.hand], round.hand, round.pOff, out, trace);
  return { trace, ph: Array.from(out.ph), flash: Array.from(out.flash), lock: out.lock, side: (round.hand + round.pOff) & 1 };
}

export function preview(round) {
  const next = project(round);
  return next ? next.trace : null;
}

// Commits the pending arrangement and scores the next hand. The letter of the single action taken joins the line.
export function play(round) {
  if (round.hand >= N_HANDS) return { round, trace: null };
  const action = round.hand === 0 ? 0 : actionFor(round.base, round);
  if (action < 0) return { round, trace: null };
  const next = project(round);
  const done = {
    ...round,
    base: { rail: round.rail, bench: round.bench },
    ph: next.ph,
    flash: next.flash,
    hand: round.hand + 1,
    line: round.hand === 0 ? '' : round.line + LETTERS[action],
    total: round.total + next.trace.score,
    lock: Math.max(round.lock, next.lock),
    lockEvent: next.lock > round.lock ? next.lock : 0,
    scores: round.scores.concat(next.trace.score),
    last: next.trace,
  };
  return { round: done, trace: next.trace };
}

// A Round is a plain, never-mutated object; every function returns a new one. Fields:
//   seed, k, pOff       the deal and its coupling detent; pOff offsets the Pendulum's swing
//   hands, cats         the four dealt hands (card numbers) and their categories
//   rail, bench         the pending arrangement (joker indices); base is the arrangement after the last played hand
//   ph, flash           Firefly phases (indexed by joker index) and wrap flags after the last played hand
//   hand, line, scores  hands played so far, the letters of the swaps taken before hands 2.., the score of each hand
//   total, lock, last   running total, best lock level reached, trace of the last hand; lockEvent = lock this hand raised
// A fresh round with hand 1 already played with the opening rail.
export function openRound(seed, k) {
  const deal = makeDeal(seed);
  const coupling = Number.isInteger(k) && k >= 0 && k <= 3 ? k : 0;
  const opening = {
    seed,
    k: coupling,
    pOff: deal.pOff,
    hands: deal.hands,
    cats: deal.cats,
    rail: deal.rail,
    bench: deal.bench,
    base: { rail: deal.rail, bench: deal.bench },
    ph: deal.ph0,
    flash: [0, 0, 0, 0, 0, 0, 0, 0],
    hand: 0,
    line: '',
    total: 0,
    lock: 0,
    lockEvent: 0,
    scores: [],
    last: null,
  };
  return play(opening).round;
}
