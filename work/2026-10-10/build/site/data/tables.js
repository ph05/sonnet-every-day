// Constants and lookup tables for Jokers In Phase. Every number here is invented for this concept.
// Integer-only on purpose: a shared link must replay the same scores in any browser.

// round(1000 * sin(2 * pi * k / 64)) for k = 0..63, committed as a literal so no trig runs at play time.
export const SIN = [
  0, 98, 195, 290, 383, 471, 556, 634, 707, 773, 831, 882, 924, 957, 981, 995,
  1000, 995, 981, 957, 924, 882, 831, 773, 707, 634, 556, 471, 383, 290, 195, 98,
  0, -98, -195, -290, -383, -471, -556, -634, -707, -773, -831, -882, -924, -957, -981, -995,
  -1000, -995, -981, -957, -924, -882, -831, -773, -707, -634, -556, -471, -383, -290, -195, -98,
];

// A quarter turn (16 ticks) ahead of SIN.
export const COS = SIN.map((_, k) => SIN[(k + 16) & 63]);

// Catalog order matters: the engine works with indices, the view-model with these ids.
export const JOKERS = ['steady', 'twofold', 'tally', 'pendulum', 'handshake', 'lantern', 'ember', 'spark'];

// Five-card hand categories: [points, mult].
export const HAND = [
  [3, 1], // 0 High card
  [6, 2], // 1 Pair
  [9, 2], // 2 Two pair
  [12, 3], // 3 Three of a kind
  [16, 3], // 4 Straight
  [18, 4], // 5 Flush
  [22, 4], // 6 Full house
  [30, 6], // 7 Four of a kind
  [40, 8], // 8 Straight flush
];

// Fixed joker effects. A flashing Firefly's bonus depends on the coupling detent and lives in F below.
export const FX = { STEADY_MULT: 4, TWOFOLD_FACTOR: 2, TALLY_POINTS: 12, PENDULUM_OUT: 8, PENDULUM_BACK: 2, HANDSHAKE_FACTOR: 3 };

// Natural beat of each Firefly in phase ticks per hand, indexed by joker index (lantern 5, ember 6, spark 7).
export const OMEGA = [0, 0, 0, 0, 0, 7, 10, 13];

// Coupling detents k = 0..3 (Off, Soft, Medium, Firm): pull strength and the flash bonus each flashing Firefly adds.
export const PULL = [0, 3, 5, 8];
export const F = [6, 5, 4, 3];

// Pull weight by slot distance 1..4 (thousandths); index 0 is never read.
export const W = [0, 1000, 500, 250, 125];

// A Handshake matches when its two neighbours sit within TAU ticks of each other on the 64-tick ring.
export const TAU = 8;

// Percent of the Fireflies' mean phase vector that counts as locked.
export const LOCK = 92;
