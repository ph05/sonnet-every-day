// Controller: app:action in, app:state out. Owns the session (deal, round, exact solve), the URL hash and saved progress.
// The view-model carries ids, codes and numbers only; every human-readable word belongs to the UI.
import { N_HANDS, P, FIRST_FIREFLY, ACTIONS, LETTERS, nextSeed, openRound, swap, undo, play, project, syncPct } from './engine.js';
import { solve, hintFor } from './solver.js';
import { CHALLENGES, CHALLENGE_MAX_LOCK } from '../data/challenges.js';
import { HAND, JOKERS, LOCK } from '../data/tables.js';

const STORAGE_KEY = 'jip.v1.progress';
const CARDS = ['none', 'par', 'silver', 'gold']; // ascending rank
const HASH_KEYS = ['c', 's', 'k', 'l'];
const MAX_HASH = 64;
const MAX_SEED = 99999;
const MAX_SCORE = 99999999;
const MAX_LINE = N_HANDS - 1; // one swap window before each hand after the first
const MISSES_FOR_HINT = 3;
const SANDBOX_K = 2;
const SOLVES_KEPT = 8;
const PENDULUM = JOKERS.indexOf('pendulum');
const ROW_JOKERS = ['pendulum', 'lantern', 'ember', 'spark'].map((id) => JOKERS.indexOf(id));
// The three shipped deals already carry their exact answer, so the first frame needs no search: { best, maxLock } by deal.
const SHIPPED = new Map(CHALLENGES.map((c, i) => [`${c.seed}:${c.k}`, { best: c.best, maxLock: CHALLENGE_MAX_LOCK[i] }]));

// Hash grammar: #c=<1|2|3> or #s=<seed>&k=<0..3>, plus optional &l=<up to three letters>. A recognised key with a bad
// value, or a recognised key without a deal, rejects the whole hash; unknown keys are ignored. Pure and total.
export function parseHash(hash) {
  const text = typeof hash === 'string' ? hash.replace(/^#/, '') : '';
  if (text === '') return { status: 'empty' };
  if (text.length > MAX_HASH) return { status: 'bad' };
  const found = {};
  for (const part of text.split('&')) {
    const eq = part.indexOf('=');
    const key = eq < 0 ? part : part.slice(0, eq);
    if (HASH_KEYS.includes(key) && !(key in found)) found[key] = eq < 0 ? '' : part.slice(eq + 1);
  }
  const { c, s, k, l } = found;
  if (HASH_KEYS.every((key) => !(key in found))) return { status: 'foreign' };
  const invalid =
    (c !== undefined && !/^[123]$/.test(c)) ||
    (s !== undefined && !(/^[0-9]{1,5}$/.test(s) && Number(s) >= 1)) ||
    (k !== undefined && !/^[0-3]$/.test(k)) ||
    (l !== undefined && !/^[a-z]{1,8}$/.test(l)) ||
    (c === undefined && s === undefined);
  if (invalid) return { status: 'bad' };
  const deal = c !== undefined ? CHALLENGES[Number(c) - 1] : { seed: Number(s), k: k === undefined ? SANDBOX_K : Number(k) };
  return {
    status: 'ok',
    cid: c === undefined ? 0 : Number(c),
    seed: deal.seed,
    k: deal.k,
    line: l === undefined ? '' : l.slice(0, MAX_LINE),
    clipped: l !== undefined && l.length > MAX_LINE,
  };
}

const toInt = (x) => (typeof x === 'number' || (typeof x === 'string' && x.trim() !== '') ? Number(x) : Number.NaN);
const cardView = (c) => ({ r: (c % 13) + 2, s: (c / 13) | 0 });
const cardOf = (lock, total, par) => (lock === 3 ? 'gold' : lock === 2 ? 'silver' : total >= par ? 'par' : 'none');

function seedFrom(raw, fallback) {
  if (raw === undefined || raw === null) return { seed: fallback, clamped: false };
  const n = Math.trunc(toInt(raw));
  if (Number.isNaN(n)) return { seed: fallback, clamped: true };
  return { seed: Math.min(MAX_SEED, Math.max(1, n)), clamped: n < 1 || n > MAX_SEED };
}

function couplingFrom(raw, fallback) {
  const n = toInt(raw);
  return raw === undefined || raw === null || Number.isNaN(n) ? fallback : Math.min(3, Math.max(0, Math.trunc(n)));
}

// Positions whose joker differs from the arrangement after the last played hand.
function changedOf(round) {
  const now = round.rail.concat(round.bench);
  const was = round.base.rail.concat(round.base.bench);
  return now.map((_, i) => i).filter((i) => now[i] !== was[i]);
}

// Pendulum and Firefly dots for one moment: where each sits on the 64-tick ring and whether it blinked on the rail.
function ringRows(round, ph, flash, hand, rail) {
  const side = (hand + round.pOff) & 1;
  return ROW_JOKERS.map((j) => {
    const onRail = rail.includes(j);
    return {
      id: JOKERS[j],
      ring: j === PENDULUM ? side * 32 : ph[j],
      onRail,
      flash: j !== PENDULUM && onRail && flash[j] === 1,
      side: j === PENDULUM ? side : null,
    };
  });
}

// A Handshake with a phased neighbour on each side draws a bridge; it is solid when the neighbours match.
function bridgeOf(trace) {
  const shake = trace.steps.find((step) => step.id === 'handshake' && (step.why === 'match' || step.why === 'apart'));
  if (!shake) return null;
  return { a: trace.steps[shake.slot - 1].id, b: trace.steps[shake.slot + 1].id, ok: shake.why === 'match' };
}

function hashOf(session) {
  const deal = session.cid ? `#c=${session.cid}` : `#s=${session.seed}&k=${session.k}`;
  return session.round.line ? `${deal}&l=${session.round.line}` : deal;
}

// Complete view-model for the "something jammed" screen when nothing better exists to show.
function blankVm() {
  const first = CHALLENGES[0];
  const rows = ROW_JOKERS.map((j) => ({ id: JOKERS[j], ring: 0, onRail: false, flash: false, side: j === PENDULUM ? 0 : null }));
  const blankHand = () => ({
    cards: Array.from({ length: 5 }, () => ({ r: 2, s: 0 })),
    cat: 0,
    base: { pts: HAND[0][0], mult: HAND[0][1] },
    status: 'waiting',
    score: null,
  });
  return {
    v: 1,
    fatal: true,
    notice: null,
    mode: 'challenge',
    challenge: { id: first.id, seed: first.seed, k: first.k, par: first.par, best: first.best, maxLock: 0, bestSaved: null, cardSaved: 'none', hasNext: true },
    round: { hand: 1, hands: N_HANDS, finished: false, attempt: 1, misses: 0, canPlay: false, canUndo: false, hintReady: false },
    deal: Array.from({ length: N_HANDS }, blankHand),
    pos: JOKERS.slice(),
    changed: [],
    phases: { P, now: rows, next: null, bridge: null },
    sync: { n: 0, now: null, next: null, lock: LOCK },
    total: 0,
    lock: 0,
    lockEvent: 0,
    next: null,
    hint: null,
    result: null,
    share: { hash: `#c=${first.id}`, card: { rail: JOKERS.slice(0, 5), seed: first.seed, k: first.k, total: 0, cid: first.id, line: '', tier: 'none' } },
  };
}

function loadProgress(storage) {
  const progress = { best: [0, 0, 0, 0], card: ['none', 'none', 'none', 'none'] };
  try {
    const data = JSON.parse(storage.getItem(STORAGE_KEY));
    if (data && data.v === 1) {
      for (let id = 1; id <= 3; id++) {
        const best = data.best && data.best[id];
        const card = data.card && data.card[id];
        if (Number.isInteger(best) && best >= 0 && best <= MAX_SCORE) progress.best[id] = best;
        if (CARDS.includes(card)) progress.card[id] = card;
      }
    }
  } catch {
    // Storage may be missing, blocked or corrupt; the page is correct without it, so start empty.
  }
  return progress;
}

function saveProgress(storage, progress) {
  const pick = (list) => ({ 1: list[1], 2: list[2], 3: list[3] });
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, best: pick(progress.best), card: pick(progress.card) }));
  } catch {
    // Quota or private mode: progress then lives for this page load only.
  }
}

function browserStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null; // merely reading the property throws when site data is blocked
  }
}

function writeBrowserHash(hash) {
  try {
    history.replaceState(null, '', location.pathname + location.search + hash);
  } catch {
    // Sandboxed frames and some file URLs refuse; the in-memory state does not depend on the URL.
  }
}

// env is for tests: { target: EventTarget, storage: {getItem,setItem}, writeHash(hash) }. Browsers pass nothing.
export function createGame(env = {}) {
  const target = 'target' in env ? env.target : typeof document === 'undefined' ? null : document;
  const storage = 'storage' in env ? env.storage : browserStorage();
  const writeHash = env.writeHash || writeBrowserHash;
  const progress = loadProgress(storage);
  const misses = [0, 0, 0, 0]; // finished rounds below par, per challenge, since page load
  const solved = new Map();
  const checked = new Set(); // deals whose shipped answer has been confirmed by the exact solve
  let session = null;
  let current = null;
  let fatal = false;

  const hintReady = () => session.cid <= 1 || misses[session.cid] >= MISSES_FOR_HINT;

  function buildVm() {
    const { round, cid, sol } = session;
    const finished = round.hand >= N_HANDS;
    const sandbox = cid === 0;
    const par = sandbox ? Math.floor((sol.best * 70) / 100) : CHALLENGES[cid - 1].par;
    const changed = changedOf(round);
    const ahead = finished ? null : project(round);
    const flies = round.rail.filter((j) => j >= FIRST_FIREFLY);
    const card = sandbox ? 'none' : cardOf(round.lock, round.total, par);
    const lock = sandbox ? 0 : round.lock;
    return {
      v: 1,
      fatal,
      notice: session.notice ? { code: session.notice } : null,
      mode: sandbox ? 'sandbox' : 'challenge',
      challenge: {
        id: cid,
        seed: session.seed,
        k: session.k,
        par,
        best: sol.best,
        maxLock: sol.maxLock,
        bestSaved: sandbox || progress.best[cid] === 0 ? null : progress.best[cid],
        cardSaved: sandbox ? 'none' : progress.card[cid],
        hasNext: cid >= 1 && cid < CHALLENGES.length,
      },
      round: {
        hand: round.hand,
        hands: N_HANDS,
        finished,
        attempt: session.attempt,
        misses: misses[cid],
        canPlay: !finished,
        canUndo: changed.length > 0,
        hintReady: !finished && hintReady(),
      },
      deal: round.hands.map((cards, h) => ({
        cards: cards.map(cardView),
        cat: round.cats[h],
        base: { pts: HAND[round.cats[h]][0], mult: HAND[round.cats[h]][1] },
        status: h < round.hand ? 'played' : h === round.hand ? 'next' : 'waiting',
        score: h < round.hand ? round.scores[h] : null,
      })),
      pos: round.rail.concat(round.bench).map((j) => JOKERS[j]),
      changed,
      phases: {
        P,
        now: ringRows(round, round.ph, round.flash, round.hand - 1, round.base.rail),
        next: ahead && ringRows(round, ahead.ph, ahead.flash, round.hand, round.rail),
        bridge: ahead ? bridgeOf(ahead.trace) : null,
      },
      sync: {
        n: flies.length,
        now: round.k > 0 && flies.length > 1 ? syncPct(flies, round.ph) : null,
        next: ahead && round.k > 0 && flies.length > 1 ? syncPct(flies, ahead.ph) : null,
        lock: LOCK,
      },
      total: round.total,
      lock,
      lockEvent: sandbox ? 0 : session.event,
      next: ahead && ahead.trace,
      hint: session.hint,
      result: finished ? { total: round.total, par, parMet: round.total >= par, lock, card, best: sol.best } : null,
      share: {
        hash: hashOf(session),
        card: {
          rail: round.rail.map((j) => JOKERS[j]),
          seed: session.seed,
          k: session.k,
          total: round.total,
          cid,
          line: round.line,
          tier: finished ? card : 'none',
        },
      },
    };
  }

  function announce(trace, animate) {
    if (target && typeof CustomEvent === 'function') {
      target.dispatchEvent(new CustomEvent('app:state', { detail: { vm: current, trace, animate } }));
    }
  }

  function emit(trace, animate) {
    current = buildVm();
    announce(trace, animate);
  }

  function failed(err) {
    console.warn('Jokers In Phase:', err && err.message ? err.message : err);
    fatal = true;
    current = { ...(current || blankVm()), fatal: true };
    announce(null, false);
  }

  // A finished challenge round updates misses and saved progress, unless it began from a shared line.
  function settle() {
    const { round, cid } = session;
    if (round.hand < N_HANDS || session.fromLink || cid === 0) return;
    const par = CHALLENGES[cid - 1].par;
    const card = cardOf(round.lock, round.total, par);
    if (round.total < par) misses[cid]++;
    progress.best[cid] = Math.max(progress.best[cid], round.total);
    if (CARDS.indexOf(card) > CARDS.indexOf(progress.card[cid])) progress.card[cid] = card;
    saveProgress(storage, progress);
  }

  function replay(round, letter) {
    const action = LETTERS.indexOf(letter);
    const moved = action > 0 ? swap(round, ACTIONS[action][0], ACTIONS[action][1]).round : round;
    return play(moved).round;
  }

  // The shipped deals are answered from data for the first frame; this runs the exact 17,576-line solve right after it
  // (outside the first paint and outside any input), keeps the full result and corrects the view if the data ever disagreed.
  function confirmLater(key, seed, k) {
    if (checked.has(key)) return;
    checked.add(key);
    setTimeout(() => {
      try {
        const known = solved.get(key);
        const exact = solve(openRound(seed, k));
        if (solved.has(key)) solved.set(key, exact);
        if (session && session.sol === known && known && (known.best !== exact.best || known.maxLock !== exact.maxLock)) {
          session.sol = exact;
          emit(session.round.last, false);
        } else if (session && session.sol === known) {
          session.sol = exact;
        }
      } catch (err) {
        failed(err);
      }
    }, 0);
  }

  // Starts a deal (and replays a shared line hand by hand). The exact solve is cached per deal. Starting the deal that
  // is already on the table counts as another attempt, so the UI can tell a restart from a redraw.
  function launch(cid, seed, k, line, notice) {
    let round = openRound(seed, k);
    const key = `${seed}:${k}`;
    if (!solved.has(key)) {
      const shipped = SHIPPED.get(key);
      solved.set(key, shipped || solve(round));
      if (shipped) confirmLater(key, seed, k);
      if (solved.size > SOLVES_KEPT) solved.delete(solved.keys().next().value);
    }
    for (const letter of line) round = replay(round, letter);
    const again = session !== null && session.cid === cid && session.seed === seed && session.k === k;
    const attempt = again ? session.attempt + 1 : 1;
    session = { cid, seed, k, round, sol: solved.get(key), attempt, fromLink: line !== '', notice, hint: null, event: round.lockEvent };
    fatal = false;
    settle();
  }

  function begin(cid, seed, k, notice) {
    launch(cid, seed, k, '', notice);
    writeHash(hashOf(session));
    emit(session.round.last, false);
  }

  function start(hash) {
    try {
      const parsed = parseHash(hash);
      if (parsed.status === 'foreign' && session) return; // an in-page anchor must not reset play
      if (!fatal && current && hash === current.share.hash) return;
      if (parsed.status === 'ok') {
        launch(parsed.cid, parsed.seed, parsed.k, parsed.line, parsed.clipped ? 'line-clipped' : null);
      } else {
        const first = CHALLENGES[0];
        launch(first.id, first.seed, first.k, '', parsed.status === 'bad' ? 'bad-hash' : null);
      }
      if (parsed.status === 'bad' || parsed.clipped) writeHash(hashOf(session));
      emit(session.round.last, false);
    } catch (err) {
      failed(err);
    }
  }

  // A state that does not directly follow a played hand carries no notice and no lock glow.
  function quiet() {
    session.notice = null;
    session.event = 0;
  }

  function dispatch(action) {
    try {
      if (!session || !action || typeof action !== 'object') return;
      const round = session.round;
      const finished = round.hand >= N_HANDS;
      switch (action.type) {
        case 'play': {
          quiet();
          if (finished) return emit(null, false);
          const done = play(round);
          session.round = done.round;
          session.hint = null;
          session.event = done.round.lockEvent;
          settle();
          writeHash(hashOf(session));
          return emit(done.trace, true);
        }
        case 'swap': {
          quiet();
          const moved = swap(round, toInt(action.a), toInt(action.b));
          if (moved.ok) {
            session.round = moved.round;
            session.hint = null;
          } else if (moved.reason === 'limit' && !finished) {
            session.notice = 'swap-limit';
          }
          return emit(null, false);
        }
        case 'undo': {
          quiet();
          if (changedOf(round).length > 0) {
            session.round = undo(round);
            session.hint = null;
          }
          return emit(null, false);
        }
        case 'retry':
          return begin(session.cid, session.seed, session.k, null);
        case 'challenge': {
          const id = toInt(action.id);
          if (![1, 2, 3].includes(id)) return;
          return begin(id, CHALLENGES[id - 1].seed, CHALLENGES[id - 1].k, null);
        }
        case 'sandbox': {
          const dealt = seedFrom(action.seed, nextSeed(session.seed));
          const k = couplingFrom(action.k, session.cid === 0 ? session.k : SANDBOX_K);
          return begin(0, dealt.seed, k, dealt.clamped ? 'seed-clamped' : null);
        }
        case 'hint': {
          quiet();
          if (finished || !hintReady()) {
            session.notice = 'no-hint';
          } else {
            // The hint is read from the post-hand arrangement, so a pending swap is put back first.
            if (changedOf(round).length > 0) session.round = undo(round);
            session.hint = hintFor(session.round);
          }
          return emit(null, false);
        }
        default:
          return;
      }
    } catch (err) {
      failed(err);
    }
  }

  if (target && typeof target.addEventListener === 'function') {
    target.addEventListener('app:action', (event) => dispatch(event.detail));
  }

  return { start, dispatch, vm: () => current };
}
