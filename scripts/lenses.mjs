#!/usr/bin/env node
// Deterministic daily assignment of one research lens (plus 3 provocation words) to each of the 8 scouts.
//   lenses.mjs --date YYYY-MM-DD [--now ISO]
// Same date + same state/ideas history => same output. Day D's own ideas file is ignored so reruns are stable.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  rp, readJson, loadConfig, parseArgs, resolveNow, localParts, hashStr, mulberry32, print, die,
} from './lib/common.mjs';
import { mix } from './novelty.mjs';

export const AGENTS = ['pulse', 'cards', 'lab', 'jester', 'architect', 'artisan', 'engineer', 'critic'];
const KINDS = ['interest', 'current', 'humor', 'wildcard', 'craft'];
const MAIN_KINDS = ['interest', 'current', 'humor', 'wildcard'];
const SLOT_TO_KIND = { interest: 'interest', currentEvents: 'current', humor: 'humor', wildcard: 'wildcard' };
// Each scout's natural home kind; the other four agents take whatever extra lenses the plan produces.
const AFFINITY = { pulse: 'current', cards: 'interest', lab: 'wildcard', jester: 'humor' };
// Max lenses of one kind per day, and the relative appetite for extras beyond the guaranteed one per main kind.
const CAP = { interest: 3, current: 2, humor: 2, wildcard: 3, craft: 1 };
const EXTRA_WEIGHT = { interest: 3, current: 2, humor: 2, wildcard: 2, craft: 1.5 };
const NO_REPEAT_DAYS = 3;
const USAGE_WINDOW_FILES = 40;
const PROVOCATIONS_PER_AGENT = 3;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

function owedKinds(date) {
  try {
    return mix({ date }).owed.map((s) => SLOT_TO_KIND[s]).filter(Boolean);
  } catch {
    return [];
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

/**
 * @param {{date:string, owedKinds?:string[]}} opts  `owedKinds` overrides the novelty-derived owed slots (tests).
 */
export function assignLenses({ date, owedKinds: owedOverride } = {}) {
  if (!DATE_RE.test(String(date))) throw new Error(`bad date: ${date}`);
  const { lenses, provocationWords } = loadLensPool();
  const past = readHistory(date);
  const owed = owedOverride ?? owedKinds(date);

  const uses = new Map();
  for (const day of past) for (const id of day.ids) uses.set(id, (uses.get(id) ?? 0) + 1);

  // Relax the no-repeat window (oldest day first) only if the remaining pool cannot satisfy the plan.
  let window = NO_REPEAT_DAYS;
  let avail;
  for (; window >= 0; window--) {
    const excluded = new Set(past.slice(0, window).flatMap((d) => d.ids));
    avail = Object.fromEntries(KINDS.map((k) => [k, lenses.filter((l) => l.kind === k && !excluded.has(l.id))]));
    const capacity = KINDS.reduce((s, k) => s + Math.min(CAP[k], avail[k].length), 0);
    if (MAIN_KINDS.every((k) => avail[k].length >= 1) && capacity >= AGENTS.length) break;
  }
  if (window < 0) throw new Error('lens pool cannot satisfy the daily constraints');
  const relaxedDays = NO_REPEAT_DAYS - window;

  const rng = mulberry32(hashStr(date));
  const limit = (k) => Math.min(CAP[k], avail[k].length);
  const counts = Object.fromEntries(KINDS.map((k) => [k, MAIN_KINDS.includes(k) ? 1 : 0]));
  let total = MAIN_KINDS.length;
  for (const k of owed) {
    if (total < AGENTS.length && counts[k] < limit(k)) {
      counts[k]++;
      total++;
    }
  }
  while (total < AGENTS.length) {
    const open = KINDS.filter((k) => counts[k] < limit(k));
    const k = open[pickWeighted(rng, open, (x) => EXTRA_WEIGHT[x])];
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
  for (const [agent, kind] of Object.entries(AFFINITY)) assignment[agent] = chosen[kind].shift();
  const leftovers = KINDS.flatMap((k) => chosen[k]);
  for (let i = leftovers.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [leftovers[i], leftovers[j]] = [leftovers[j], leftovers[i]];
  }
  for (const agent of AGENTS) if (!assignment[agent]) assignment[agent] = leftovers.shift();

  // 24 distinct words (Fisher-Yates prefix) from their own stream so lens choice never shifts the words.
  const wordRng = mulberry32(hashStr(`${date}|provocation`));
  const words = [...provocationWords];
  const need = AGENTS.length * PROVOCATIONS_PER_AGENT;
  for (let i = 0; i < need; i++) {
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
  return { date, agents, owedKinds: owed, relaxedDays };
}

function main() {
  const flags = parseArgs();
  try {
    const date = flags.date && flags.date !== true
      ? flags.date
      : localParts(resolveNow(flags), loadConfig().timezone).date;
    print({ ok: true, ...assignLenses({ date }) });
  } catch (err) {
    die(err.message, 1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
