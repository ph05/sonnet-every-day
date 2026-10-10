// The three shipped deals. Seeds came from a build-time search; test/engine.test.mjs re-verifies par and best with the solver.
export const CHALLENGES = [
  { id: 1, seed: 789, k: 0, par: 1025, best: 1864 },
  { id: 2, seed: 3338, k: 1, par: 1894, best: 2706 },
  { id: 3, seed: 9187, k: 2, par: 1531, best: 2785 },
];
// Highest lock any line reaches on each shipped deal (index = id - 1); test/engine.test.mjs re-verifies it with the solver.
// Kept beside CHALLENGES, not inside it, so the challenge records stay exactly { id, seed, k, par, best }.
export const CHALLENGE_MAX_LOCK = [0, 3, 3];
