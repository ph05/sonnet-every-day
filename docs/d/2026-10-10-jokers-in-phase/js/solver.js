// Exhaustive search over the swap lines of a round: 26 actions before each remaining hand, 17,576 lines from hand 1.
// Pure and synchronous; it shares every rule with the engine, so a solved score is exactly what play() would produce.
import { ACTIONS, LETTERS, N_HANDS, applyInto, makeScratch, stepInto } from './engine.js';

const lineOf = (actions) => Array.from(actions, (a) => LETTERS[a]).join('');

// Calls leaf(total, lock, actions, arrangement) for every complete line in ascending order ('aaa' first).
// The arguments are reused buffers: read them inside the callback, never keep them.
function walk(round, leaf) {
  const windows = N_HANDS - round.hand;
  const actions = new Int8Array(Math.max(windows, 0));
  const arrangements = Array.from({ length: windows + 1 }, () => new Int8Array(8));
  const scratch = Array.from({ length: windows }, () => makeScratch());
  arrangements[0].set(round.base.rail.concat(round.base.bench));
  if (windows <= 0) {
    leaf(round.total, round.lock, actions, arrangements[0]);
    return;
  }
  const opening = Int16Array.from(round.ph);
  const descend = (d, total, lock) => {
    const hand = round.hand + d;
    const phases = d === 0 ? opening : scratch[d - 1].ph;
    for (let action = 0; action < ACTIONS.length; action++) {
      applyInto(arrangements[d + 1], arrangements[d], action);
      stepInto(arrangements[d + 1], phases, round.k, round.cats[hand], hand, round.pOff, scratch[d], null);
      actions[d] = action;
      const sum = total + scratch[d].score;
      const level = scratch[d].lock > lock ? scratch[d].lock : lock;
      if (d === windows - 1) leaf(sum, level, actions, arrangements[d + 1]);
      else descend(d + 1, sum, level);
    }
  };
  descend(0, round.total, round.lock);
}

// visit({ line, total, lock, rail }) once per line. The object is reused; rail holds the five final slots.
export function enumerate(round, visit) {
  const seen = { line: '', total: 0, lock: 0, rail: new Int8Array(5) };
  walk(round, (total, lock, actions, arrangement) => {
    seen.line = lineOf(actions);
    seen.total = total;
    seen.lock = lock;
    for (let i = 0; i < 5; i++) seen.rail[i] = arrangement[i];
    visit(seen);
  });
}

// Best total (and the first line that reaches it), the highest lock any line reaches, and the best total among
// lines that end in a full lock (goldBest 0 and goldLine '' when no line does).
export function solve(round) {
  let best = -1;
  let bestLine = '';
  let maxLock = 0;
  let goldBest = 0;
  let goldLine = '';
  walk(round, (total, lock, actions) => {
    if (total > best) {
      best = total;
      bestLine = lineOf(actions);
    }
    if (lock > maxLock) maxLock = lock;
    if (lock === 3 && total > goldBest) {
      goldBest = total;
      goldLine = lineOf(actions);
    }
  });
  return { best, bestLine, maxLock, goldBest, goldLine };
}

// The first move of the best line from the post-hand arrangement, as the two positions to swap.
export function hintFor(round) {
  const first = LETTERS.indexOf(solve(round).bestLine[0]);
  if (first < 1) return { noop: true, a: -1, b: -1 };
  return { noop: false, a: ACTIONS[first][0], b: ACTIONS[first][1] };
}
