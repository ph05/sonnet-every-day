#!/usr/bin/env node
// Deterministic daily assignment of one research lens (plus 3 provocation words) to each of the 8 scouts.
//   lenses.mjs --date YYYY-MM-DD [--now ISO] [--purpose tool|lesson|explorer|studio|play]
// Same date + same state/ideas history => same output. Day D's own ideas file is ignored so reruns are stable.
// How many lenses of each kind a day gets follows the day's purpose plan (novelty.mjs mix, `purposes`): a wanted tool brings
// useful lenses, a wanted lesson teach lenses, and humor lenses are drawn only when play is allowed. --purpose P is the manual
// override, passed through to the plan.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  rp, readJson, loadConfig, loadTaxonomy, parseArgs, resolveNow, localParts, hashStr, mulberry32, print, die,
} from './lib/common.mjs';
import { mix, PLAY } from './novelty.mjs';
import { purposeVocabulary } from './history.mjs';

export const AGENTS = ['pulse', 'cards', 'lab', 'jester', 'architect', 'artisan', 'engineer', 'critic'];
export const KINDS = ['interest', 'current', 'humor', 'wildcard', 'craft', 'useful', 'teach'];
// The kinds loadLensPool needs at least 3 lenses of (validate.mjs repo checks the same minimum before a commit).
export const MAIN_KINDS = ['interest', 'current', 'humor', 'wildcard', 'useful', 'teach'];
const SLOT_TO_KIND = { interest: 'interest', currentEvents: 'current', humor: 'humor', wildcard: 'wildcard' };
// Each scout's natural home kind; the other two agents take whatever extra lenses the plan produces. jester's home (humor) is
// empty on days when play is not allowed, and jester then takes an extra lens too.
const AFFINITY = { pulse: 'current', cards: 'interest', lab: 'wildcard', jester: 'humor', engineer: 'useful', architect: 'teach' };
// Max lenses of one kind per day.
const CAP = { interest: 2, current: 2, humor: 2, wildcard: 3, craft: 1, useful: 3, teach: 3 };
// Lenses a wanted purpose asks for (play only through an override: it is never wanted on its own).
const DEMAND = {
  tool: { useful: 2 }, lesson: { teach: 2 }, explorer: { teach: 1, wildcard: 2 }, studio: { wildcard: 2 }, play: { humor: 1, interest: 2 },
};
// Relative appetite for the slots left after the plan's lenses and the owed ones (humor 0 when play is not allowed).
const EXTRA_WEIGHT = { useful: 2.5, teach: 2.5, wildcard: 2, craft: 2, interest: 1.5, current: 1.5, humor: 1.5 };
const NO_REPEAT_DAYS = 3;
const USAGE_WINDOW_FILES = 40;
const PROVOCATIONS_PER_AGENT = 3;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_PURPOSES = ['tool', 'lesson', 'explorer', 'studio', 'play'];

export function loadLensPool() {
  const file = rp('ops', 'lenses.json');
  const data = readJson(file);
  const { lenses, provocationWords } = data;
  if (!Array.isArray(lenses) || !Array.isArray(provocationWords)) {
    throw new Error(`${file}: expected "lenses" and "provocationWords" arrays`);
  }
  const seen = new Set();
  for (const l of lenses) {
    if (!l?.id || !l.name || !l.brief || !Array.isArray(l.sourceHints)) throw new Error(`${file}: malformed lens ${JSON.stringify(l?.id)}`);
    if (!KINDS.includes(l.kind)) throw new Error(`${file}: lens ${l.id} has unknown kind ${JSON.stringify(l.kind)}`);
    if (seen.has(l.id)) throw new Error(`${file}: duplicate lens id ${l.id}`);
    seen.add(l.id);
  }
  if (lenses.length < AGENTS.length * (NO_REPEAT_DAYS + 1)) throw new Error(`${file}: need at least ${AGENTS.length * (NO_REPEAT_DAYS + 1)} lenses`);
  for (const k of MAIN_KINDS) {
    if (lenses.filter((l) => l.kind === k).length < 3) throw new Error(`${file}: need at least 3 lenses of kind ${k}`);
  }
  if (provocationWords.length < AGENTS.length * PROVOCATIONS_PER_AGENT) throw new Error(`${file}: not enough provocation words`);
  return { lenses, provocationWords };
}

/** Lens ids used by earlier days, newest first: [{date, ids:[…]}]. Unreadable files are skipped. */
function readHistory(date) {
  const dir = rp('state', 'ideas');
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((n) => /^(\d{4}-\d{2}-\d{2})\.json$/.exec(n)?.[1])
    .filter((d) => d && d < date)
    .sort()
    .reverse()
    .slice(0, USAGE_WINDOW_FILES)
    .map((d) => {
      try {
        const doc = readJson(rp('state', 'ideas', `${d}.json`));
        const ids = (Array.isArray(doc.lenses) ? doc.lenses : [])
          .map((l) => l?.lensId ?? l?.id ?? l?.lens?.id)
          .filter((x) => typeof x === 'string');
        return { date: d, ids };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** The purpose vocabulary of the taxonomy (canonical order), or the design's five purposes when it cannot be read. */
function vocabulary() {
  try {
    return purposeVocabulary(loadTaxonomy());
  } catch {
    return null;
  }
}

/**
 * The plan used when novelty mix cannot run (an unreadable history): the first wantedCount non-play purposes, nothing avoided,
 * play allowed; or the override. counts and lastShipped are unknown (null).
 */
export function neutralPlan(purpose = null) {
  let wantedCount = 2;
  let bonus = 5;
  let windowDays = 7;
  try {
    const pc = loadConfig().mix?.purposes ?? {};
    if (Number.isInteger(pc.wantedCount) && pc.wantedCount > 0) wantedCount = pc.wantedCount;
    if (Number.isFinite(pc.wantedBonus) && pc.wantedBonus >= 0) bonus = pc.wantedBonus;
    if (Number.isInteger(pc.windowDays) && pc.windowDays > 0) windowDays = pc.windowDays;
  } catch { /* defaults */ }
  const vocab = vocabulary() ?? DEFAULT_PURPOSES;
  return {
    windowDays,
    counts: null,
    lastShipped: null,
    wanted: purpose ? [purpose] : vocab.filter((p) => p !== PLAY).slice(0, wantedCount),
    avoid: [],
    playAllowed: true,
    playBlockedUntil: null,
    bonus,
    override: purpose ?? null,
    legacyAssumed: [],
  };
}

/** The day's purpose plan and owed lens kinds from novelty mix; the neutral plan and the error when mix cannot run. */
function planFor(date, purpose) {
  try {
    const m = mix({ date, purpose: purpose ?? undefined });
    return { plan: m.purposes ?? null, owed: m.owed.map((s) => SLOT_TO_KIND[s]).filter(Boolean), planError: null };
  } catch (err) {
    return { plan: neutralPlan(purpose), owed: [], planError: err.message };
  }
}

function pickWeighted(rng, items, weight) {
  const ws = items.map(weight);
  const total = ws.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= ws[i];
    if (r < 0) return i;
  }
  return items.length - 1;
}

const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

/**
 * Lenses each kind needs today before any extra: one of each main kind (humor only when play is allowed), raised by what the
 * wanted purposes ask for (DEMAND, at most CAP). Above 8 (only possible with more than two wanted purposes) the kinds no wanted
 * purpose asked for are trimmed first, last kinds first, never below 1 for a main kind other than humor.
 */
export function lensNeed(plan) {
  const playAllowed = plan ? plan.playAllowed !== false : true;
  const need = { interest: 1, current: 1, humor: playAllowed ? 1 : 0, wildcard: 1, craft: 0, useful: 1, teach: 1 };
  const demanded = new Set();
  for (const p of Array.isArray(plan?.wanted) ? plan.wanted : []) {
    for (const [k, n] of Object.entries(DEMAND[p] ?? {})) {
      need[k] = Math.max(need[k], Math.min(n, CAP[k]));
      demanded.add(k);
    }
  }
  if (!playAllowed) need.humor = 0;
  const floor = (k) => (MAIN_KINDS.includes(k) && k !== 'humor' ? 1 : 0);
  let total = sum(need);
  for (const anyKind of [false, true]) {
    for (const k of [...KINDS].reverse()) {
      while (total > AGENTS.length && need[k] > floor(k) && (anyKind || !demanded.has(k))) {
        need[k]--;
        total--;
      }
    }
  }
  return need;
}

/**
 * @param {{date:string, purpose?:string, owedKinds?:string[], plan?:object|null}} opts
 *   `purpose` is the manual override (passed to novelty mix). `owedKinds` and `plan` replace the novelty-derived values (tests).
 */
export function assignLenses({ date, purpose, owedKinds: owedOverride, plan: planOverride } = {}) {
  if (!DATE_RE.test(String(date))) throw new Error(`bad date: ${date}`);
  if (purpose !== undefined && purpose !== null) {
    const vocab = vocabulary();
    if (!vocab?.includes(purpose)) throw new Error(`unknown purpose ${JSON.stringify(purpose)}${vocab ? ` (one of ${vocab.join(', ')})` : ': the taxonomy has no purposes'}`);
  }
  const { lenses, provocationWords } = loadLensPool();
  const past = readHistory(date);
  const fromMix = owedOverride === undefined || planOverride === undefined ? planFor(date, purpose) : null;
  const plan = planOverride !== undefined ? planOverride : fromMix.plan;
  const owed = owedOverride ?? fromMix.owed;
  const planError = planOverride !== undefined ? null : fromMix.planError;
  const playAllowed = plan ? plan.playAllowed !== false : true;
  const need = lensNeed(plan);

  const uses = new Map();
  for (const day of past) for (const id of day.ids) uses.set(id, (uses.get(id) ?? 0) + 1);

  // Relax the no-repeat window (oldest day first) only if the remaining pool cannot satisfy the plan: every kind needs as many
  // fresh lenses as `need` asks for (not merely one), and the kinds that may be drawn must hold 8 (humor is left out when play
  // is not allowed).
  let window = NO_REPEAT_DAYS;
  let avail;
  const drawable = KINDS.filter((k) => k !== 'humor' || playAllowed);
  for (; window >= 0; window--) {
    const excluded = new Set(past.slice(0, window).flatMap((d) => d.ids));
    avail = Object.fromEntries(KINDS.map((k) => [k, lenses.filter((l) => l.kind === k && !excluded.has(l.id))]));
    const capacity = drawable.reduce((s, k) => s + Math.min(CAP[k], avail[k].length), 0);
    if (KINDS.every((k) => avail[k].length >= need[k]) && capacity >= AGENTS.length) break;
  }
  if (window < 0) throw new Error('lens pool cannot satisfy the daily constraints');
  const relaxedDays = NO_REPEAT_DAYS - window;

  const rng = mulberry32(hashStr(date));
  const limit = (k) => (k === 'humor' && !playAllowed ? 0 : Math.min(CAP[k], avail[k].length));
  const weight = (k) => (k === 'humor' && !playAllowed ? 0 : EXTRA_WEIGHT[k]);
  const counts = { ...need };
  let total = sum(counts);
  // owed slots are best effort after the purpose demand
  for (const k of owed) {
    if (total < AGENTS.length && counts[k] < limit(k) && weight(k) > 0) {
      counts[k]++;
      total++;
    }
  }
  while (total < AGENTS.length) {
    const open = KINDS.filter((k) => counts[k] < limit(k) && weight(k) > 0);
    if (!open.length) throw new Error('lens pool cannot fill the day');
    const k = open[pickWeighted(rng, open, weight)];
    counts[k]++;
    total++;
  }

  // Least-used lenses are favoured so every lens eventually gets its day.
  const chosen = {};
  for (const k of KINDS) {
    const pool = [...avail[k]];
    chosen[k] = [];
    for (let i = 0; i < counts[k]; i++) {
      const idx = pickWeighted(rng, pool, (l) => 1 / (1 + (uses.get(l.id) ?? 0)) ** 2);
      chosen[k].push(pool.splice(idx, 1)[0]);
    }
  }

  const assignment = {};
  for (const [agent, kind] of Object.entries(AFFINITY)) {
    const lens = chosen[kind].shift();
    if (lens) assignment[agent] = lens;
  }
  const leftovers = KINDS.flatMap((k) => chosen[k]);
  for (let i = leftovers.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [leftovers[i], leftovers[j]] = [leftovers[j], leftovers[i]];
  }
  for (const agent of AGENTS) if (!assignment[agent]) assignment[agent] = leftovers.shift();

  // 24 distinct words (Fisher-Yates prefix) from their own stream so lens choice never shifts the words.
  const wordRng = mulberry32(hashStr(`${date}|provocation`));
  const words = [...provocationWords];
  const needWords = AGENTS.length * PROVOCATIONS_PER_AGENT;
  for (let i = 0; i < needWords; i++) {
    const j = i + Math.floor(wordRng() * (words.length - i));
    [words[i], words[j]] = [words[j], words[i]];
  }

  const agents = AGENTS.map((agent, i) => {
    const { id, name, kind, brief, sourceHints } = assignment[agent];
    return {
      agent,
      lens: { id, name, kind, brief, sourceHints },
      provocation: words.slice(i * PROVOCATIONS_PER_AGENT, (i + 1) * PROVOCATIONS_PER_AGENT),
    };
  });
  const out = { date, agents, owedKinds: owed, relaxedDays, purposes: plan };
  if (planError) out.planError = planError;
  return out;
}

function main() {
  const flags = parseArgs();
  try {
    const date = flags.date && flags.date !== true
      ? flags.date
      : localParts(resolveNow(flags), loadConfig().timezone).date;
    let purpose;
    if (flags.purpose !== undefined) {
      if (flags.purpose === true || flags.purpose === '') die('usage: lenses.mjs --date YYYY-MM-DD [--purpose tool|lesson|explorer|studio|play]', 2);
      purpose = String(flags.purpose);
    }
    print({ ok: true, ...assignLenses({ date, purpose }) });
  } catch (err) {
    die(err.message, 1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
