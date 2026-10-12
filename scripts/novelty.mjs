#!/usr/bin/env node
// Novelty gate, recent-mix report and purpose plan for ideation.
//   novelty.mjs check --candidates <file.json> [--date D] [--now ISO]
//   novelty.mjs mix [--date D] [--now ISO] [--purpose tool|lesson|explorer|studio|play]
// Only history entries with countsForNovelty:true that are dated before the target date count.
// mix also prints the purpose plan (`purposes`: what to make today, what to avoid, whether play is allowed; see purposePlan);
// --purpose P is the manual override (wanted [P], nothing avoided). check takes no --purpose: a purpose is never a novelty conflict.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  readJson, loadConfig, loadTaxonomy, parseArgs, resolveNow, localParts, addDays, print, die,
} from './lib/common.mjs';
import { loadHistory, purposeOf, purposeVocabulary } from './history.mjs';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLOT_ORDER = ['interest', 'currentEvents', 'humor', 'wildcard'];
/** The reserved purpose the plan special-cases: never wanted, capped and cooled down on its own (validate.mjs repo requires it). */
export const PLAY = 'play';
/** Weekly shares used when config.mix.purposes.quota is missing (tools and lessons first). */
const PURPOSE_QUOTA_DEFAULT = { tool: 2, lesson: 2, explorer: 1, studio: 1 };
/** Used when a config.mix.purposes value is missing or damaged (validate.mjs repo reports the damage). */
const PURPOSE_DEFAULTS = {
  windowDays: 7, cooldownDays: 2, playCooldownDays: 3, maxPlayPer7Days: 2, wantedCount: 2, wantedBonus: 5, starvedDays: 6, legacyDefault: PLAY,
};
/** Fewer allowed purposes than this and the oldest cooldowns are lifted (never the play block). */
const MIN_ALLOWED_PURPOSES = 3;

export function daysBetween(later, earlier) {
  return Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86400000);
}

function normToken(s) {
  return String(s).toLowerCase().trim();
}

export function tagSet(fp) {
  const out = new Set();
  for (const t of [...(fp?.tags ?? []), ...(fp?.keywords ?? [])]) {
    const v = normToken(t);
    if (v) out.add(v);
  }
  return out;
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** pg_trgm style: each word padded with two leading spaces and one trailing space. */
export function trigrams(text) {
  const words = String(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  const out = new Set();
  for (const w of words) {
    const padded = `  ${w} `;
    for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  }
  return out;
}

export function titleSimilarity(a, b) {
  return jaccard(trigrams(a), trigrams(b));
}

function targetDate(date) {
  if (date && date !== true) {
    if (!DATE_RE.test(String(date))) throw new Error(`bad date: ${date}`);
    return String(date);
  }
  return localParts(resolveNow({}), loadConfig().timezone).date;
}

function pastEntries(history, date) {
  return history.entries.filter((e) => e.countsForNovelty === true && e.date < date);
}

/** config.pageContract.requiredFrom when it is a date, else null (null: the page contract is not enforced yet). */
function requiredFromOf(cfg) {
  const r = cfg?.pageContract?.requiredFrom;
  return typeof r === 'string' && DATE_RE.test(r) ? r : null;
}

/**
 * A present purpose outside the vocabulary is a problem at any date; a missing one only from `requiredFrom` on.
 * Without a vocabulary in the taxonomy the purpose is not checked.
 */
function validateFingerprint(fp, taxonomy, { day = null, requiredFrom = null } = {}) {
  const problems = [];
  if (!fp || typeof fp !== 'object') return ['fingerprint missing'];
  if (!Object.hasOwn(taxonomy.categories, fp.category)) problems.push(`unknown category ${JSON.stringify(fp.category)}`);
  if (!taxonomy.mechanics.includes(fp.mechanic)) problems.push(`unknown mechanic ${JSON.stringify(fp.mechanic)}`);
  if (!Array.isArray(fp.tone) || !fp.tone.length || fp.tone.some((t) => !taxonomy.tones.includes(t))) {
    problems.push('tone must be a non-empty subset of the taxonomy tones');
  }
  if (!SLOT_ORDER.includes(fp.slot)) problems.push(`unknown slot ${JSON.stringify(fp.slot)}`);
  const vocab = purposeVocabulary(taxonomy);
  if (vocab) {
    if (fp.purpose !== undefined && fp.purpose !== null) {
      if (!vocab.includes(fp.purpose)) problems.push(`unknown purpose ${JSON.stringify(fp.purpose)} (one of ${vocab.join(', ')})`);
    } else if (requiredFrom && day && day >= requiredFrom) {
      problems.push(`purpose missing (required from ${requiredFrom}; one of ${vocab.join(', ')})`);
    }
  }
  return problems;
}

function mostRecent(entries) {
  return entries.reduce((best, e) => (!best || e.date > best.date ? e : best), null);
}

/**
 * @param {Array<{id:string,title:string,fingerprint:object}>} candidates
 * @returns {{ok:boolean, results:Array<{id:string, ok:boolean, conflicts:object[], score:number}>}}
 *   top-level `ok` means "the check ran"; each result carries its own verdict.
 */
export function checkCandidates(candidates, { date } = {}) {
  if (!Array.isArray(candidates)) throw new Error('candidates must be an array');
  const day = targetDate(date);
  const cfg = loadConfig();
  const taxonomy = loadTaxonomy();
  const nov = cfg.novelty;
  const past = pastEntries(loadHistory(), day);
  const ago = (e) => daysBetween(day, e.date);
  const conflict = (kind, e, detail) => ({ kind, date: e?.date ?? null, slug: e?.slug ?? null, detail });
  const requiredFrom = requiredFromOf(cfg);

  const results = candidates.map((cand, idx) => {
    const id = cand?.id ?? `#${idx}`;
    const fp = cand?.fingerprint;
    const conflicts = [];

    const bad = validateFingerprint(fp, taxonomy, { day, requiredFrom });
    if (bad.length) conflicts.push(conflict('invalid-fingerprint', null, bad.join('; ')));
    if (!cand?.title || typeof cand.title !== 'string') conflicts.push(conflict('invalid-fingerprint', null, 'title missing'));

    let worstTag = 0;
    let worstTitle = 0;
    let penalties = 0;

    if (!bad.length) {
      const sameCat = past.filter((e) => e.fingerprint?.category === fp.category);
      const recentCat = sameCat.filter((e) => ago(e) <= nov.categoryCooldownDays);
      if (recentCat.length) {
        const e = mostRecent(recentCat);
        conflicts.push(conflict('category-cooldown', e, `category ${fp.category} was built ${ago(e)} day(s) ago (cooldown ${nov.categoryCooldownDays})`));
        penalties += 3;
      }

      const inWeek = sameCat.filter((e) => ago(e) <= 6);
      if (inWeek.length >= nov.maxPerCategoryIn7Days) {
        const e = mostRecent(inWeek);
        conflicts.push(conflict('category-saturation', e, `category ${fp.category} already built ${inWeek.length}x in the 7-day window ending today (max ${nov.maxPerCategoryIn7Days}): ${inWeek.map((x) => x.date).join(', ')}`));
        penalties += 3;
      }

      const sameMech = past.filter((e) => e.fingerprint?.mechanic === fp.mechanic && ago(e) <= nov.mechanicCooldownDays);
      if (sameMech.length) {
        const e = mostRecent(sameMech);
        conflicts.push(conflict('mechanic-cooldown', e, `mechanic ${fp.mechanic} was built ${ago(e)} day(s) ago (cooldown ${nov.mechanicCooldownDays})`));
        penalties += 2;
      }

      const both = sameCat.filter((e) => e.fingerprint?.mechanic === fp.mechanic && ago(e) <= nov.sameCategoryAndMechanicDays);
      if (both.length) {
        const e = mostRecent(both);
        conflicts.push(conflict('category+mechanic-repeat', e, `${fp.category} + ${fp.mechanic} was built ${ago(e)} day(s) ago (window ${nov.sameCategoryAndMechanicDays})`));
        penalties += 3;
      }

      if (fp.political === true) {
        const polit = past.filter((e) => e.fingerprint?.political === true && ago(e) <= 13);
        if (polit.length >= cfg.mix.politicsMaxPer14Days) {
          const e = mostRecent(polit);
          conflicts.push(conflict('politics-cap', e, `${polit.length} political build(s) in the 14-day window ending today (max ${cfg.mix.politicsMaxPer14Days})`));
          penalties += 4;
        }
      }

      const mine = tagSet(fp);
      const overlaps = [];
      for (const e of past) {
        const j = jaccard(mine, tagSet(e.fingerprint));
        worstTag = Math.max(worstTag, j);
        if (j >= nov.tagJaccardMax) overlaps.push({ e, j });
      }
      overlaps.sort((a, b) => b.j - a.j);
      for (const { e, j } of overlaps.slice(0, 3)) {
        conflicts.push(conflict('tag-overlap', e, `tags/keywords overlap ${j.toFixed(2)} with "${e.title}" (max ${nov.tagJaccardMax})`));
        penalties += 2;
      }
    }

    if (typeof cand?.title === 'string' && cand.title) {
      const myTri = trigrams(cand.title);
      const similar = [];
      for (const e of past) {
        const s = jaccard(myTri, trigrams(e.title));
        worstTitle = Math.max(worstTitle, s);
        if (s >= nov.titleSimilarityMax) similar.push({ e, s });
      }
      similar.sort((a, b) => b.s - a.s);
      for (const { e, s } of similar.slice(0, 3)) {
        conflicts.push(conflict('title-similar', e, `title similarity ${s.toFixed(2)} with "${e.title}" (max ${nov.titleSimilarityMax})`));
        penalties += 2;
      }
    }

    // 0..10, higher = more distinct from what has shipped.
    const base = 10 * (1 - Math.max(worstTag, worstTitle));
    const score = Math.max(0, Math.round((base - penalties) * 10) / 10);
    return { id, ok: conflicts.length === 0, conflicts, score };
  });

  return { ok: true, results };
}

/** Positive integer settings from config.mix.purposes, each falling back to its default when missing or damaged. */
function purposeSettings(raw, vocab) {
  const s = {};
  for (const k of ['windowDays', 'cooldownDays', 'playCooldownDays', 'maxPlayPer7Days', 'wantedCount', 'starvedDays']) {
    s[k] = Number.isInteger(raw[k]) && raw[k] > 0 ? raw[k] : PURPOSE_DEFAULTS[k];
  }
  s.wantedBonus = Number.isFinite(raw.wantedBonus) && raw.wantedBonus >= 0 ? raw.wantedBonus : PURPOSE_DEFAULTS.wantedBonus;
  s.legacyDefault = vocab.includes(raw.legacyDefault) ? raw.legacyDefault : PLAY;
  // how many builds of each purpose a 7-day window should hold; tools and lessons come up twice as often as explorers and studios
  s.quota = {};
  for (const p of vocab) {
    const q = raw.quota?.[p];
    s.quota[p] = Number.isFinite(q) && q > 0 ? q : PURPOSE_QUOTA_DEFAULT[p] ?? 1;
  }
  return s;
}

/**
 * Today's purpose plan (DESIGN section 3), a pure function of the history: which purposes the scouts should lead with
 * (`wanted`), which to avoid, and whether play is allowed. Entries count when countsForNovelty is true and they are dated
 * before `date`; an entry without a known purpose counts as config.mix.purposes.legacyDefault (listed in `legacyAssumed`).
 * `purpose` is the manual override: wanted [purpose], nothing avoided, play allowed. Returns null (no plan) when config.mix.purposes
 * or taxonomy.purposes (with play) is missing; then an override throws, as does an unknown override.
 * @param {{date?:string, purpose?:string|null, history?:{entries:object[], startDate?:string}, config?:object, taxonomy?:object}} opts
 *   `history`, `config` and `taxonomy` default to the files of the repo.
 */
export function purposePlan({ date, purpose, history, config, taxonomy } = {}) {
  const day = targetDate(date);
  const cfg = config ?? loadConfig();
  const vocab = purposeVocabulary(taxonomy ?? loadTaxonomy());
  const raw = cfg?.mix?.purposes;
  const override = purpose === undefined || purpose === null ? null : String(purpose);
  if (override !== null && !vocab?.includes(override)) {
    throw new Error(`unknown purpose ${JSON.stringify(override)}${vocab ? ` (one of ${vocab.join(', ')})` : ': the taxonomy has no purposes'}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !vocab?.includes(PLAY)) {
    if (override !== null) throw new Error('no purpose plan: config.mix.purposes or taxonomy.purposes is missing, so a purpose override cannot apply');
    return null;
  }
  const s = purposeSettings(raw, vocab);
  const h = history ?? loadHistory();
  const ago = (d) => daysBetween(day, d);

  const counts = Object.fromEntries(vocab.map((p) => [p, 0]));
  const lastShipped = Object.fromEntries(vocab.map((p) => [p, null]));
  const legacyAssumed = [];
  const plays = [];
  for (const e of pastEntries(h, day)) {
    const p = purposeOf(e, vocab, s.legacyDefault);
    if (!vocab.includes(e.fingerprint?.purpose)) legacyAssumed.push(e.date);
    // the six days before `day`: with `day` itself, the 7-day window ending today
    if (ago(e.date) <= s.windowDays - 1) counts[p]++;
    if (!lastShipped[p] || e.date > lastShipped[p]) lastShipped[p] = e.date;
    if (p === PLAY) plays.push(e.date);
  }
  legacyAssumed.sort();
  plays.sort().reverse();
  const start = typeof h.startDate === 'string' && DATE_RE.test(h.startDate) ? h.startDate : null;
  const gap = (p) => (lastShipped[p] ? ago(lastShipped[p]) : start ? Math.max(0, ago(start)) : Infinity);

  const playAllowed = !plays.some((d) => ago(d) <= s.playCooldownDays - 1) && counts[PLAY] < s.maxPlayPer7Days;
  // the first date on which play would be allowed if nothing new ships
  let playBlockedUntil = null;
  if (!playAllowed) {
    const bounds = [addDays(plays[0], s.playCooldownDays)];
    if (plays.length >= s.maxPlayPer7Days) bounds.push(addDays(plays[s.maxPlayPer7Days - 1], s.windowDays));
    playBlockedUntil = bounds.sort().at(-1);
  }
  const plan = {
    windowDays: s.windowDays, counts, lastShipped, wanted: [], avoid: [], playAllowed, playBlockedUntil, bonus: s.wantedBonus, override: null, legacyAssumed,
  };
  if (override !== null) return { ...plan, wanted: [override], avoid: [], playAllowed: true, playBlockedUntil: null, override };

  const canonical = (a, b) => vocab.indexOf(a) - vocab.indexOf(b);
  const cooling = vocab.filter((p) => lastShipped[p] && ago(lastShipped[p]) <= s.cooldownDays);
  const avoid = new Set(cooling);
  if (!playAllowed) avoid.add(PLAY);
  // fewer than three purposes left: lift the oldest cooldowns first, never the play block
  const liftable = cooling
    .filter((p) => p !== PLAY || playAllowed)
    .sort((a, b) => (lastShipped[a] < lastShipped[b] ? -1 : lastShipped[a] > lastShipped[b] ? 1 : canonical(a, b)));
  while (vocab.length - avoid.size < MIN_ALLOWED_PURPOSES && liftable.length) avoid.delete(liftable.shift());

  const candidates = vocab.filter((p) => p !== PLAY && !avoid.has(p));
  // a purpose idle for starvedDays with nothing in the window becomes the only wanted one, so whichever wanted purpose wins,
  // every purpose ships within a week
  const starved = candidates.filter((p) => counts[p] === 0 && gap(p) >= s.starvedDays).sort((a, b) => gap(b) - gap(a) || canonical(a, b));
  const ranked = starved.length ? starved : [...candidates].sort((a, b) => counts[a] / s.quota[a] - counts[b] / s.quota[b] || gap(b) - gap(a) || canonical(a, b));
  return { ...plan, wanted: ranked.slice(0, s.wantedCount), avoid: vocab.filter((p) => avoid.has(p)) };
}

const PURPOSE_PHRASE = { tool: 'a tool', lesson: 'a lesson', explorer: 'an explorer', studio: 'a studio', play: 'a play idea (a game, toy or satire)' };
const phrase = (p) => PURPOSE_PHRASE[p] ?? `a ${p}`;
const listWith = (items, word) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} ${word} ${items.at(-1)}`);

/** The purpose sentence of the mix summary (always pieces[0]). */
function purposeSentence(plan, cfg) {
  const counts = `Purpose mix this week: ${Object.entries(plan.counts).map(([p, n]) => `${p} ${n}`).join(', ')}.`;
  if (plan.override) return `${counts} Manual override: today we want ${phrase(plan.override)}. Lead with it; no purpose is avoided.`;
  const parts = [];
  if (plan.wanted.length) parts.push(`Today we want ${listWith(plan.wanted.map(phrase), 'or')} (lead with ${plan.wanted.length > 1 ? 'one' : 'it'})`);
  const cooling = plan.avoid.filter((p) => p !== PLAY || plan.playAllowed);
  if (cooling.length) {
    const days = Number.isInteger(cfg.mix?.purposes?.cooldownDays) && cfg.mix.purposes.cooldownDays > 0 ? cfg.mix.purposes.cooldownDays : PURPOSE_DEFAULTS.cooldownDays;
    parts.push(`${parts.length ? 'skip' : 'Skip'} ${listWith(cooling, 'and')} (shipped in the last ${days} days)`);
  }
  if (!plan.playAllowed) parts.push(`${parts.length ? 'play' : 'Play'} is paused until ${plan.playBlockedUntil}`);
  else if (!plan.avoid.includes(PLAY)) parts.push(`${parts.length ? 'play' : 'Play'} is allowed but must win on merit`);
  return parts.length ? `${counts} ${parts.join('; ')}.` : counts;
}

function slotNote(cfg, slot) {
  const note = cfg.mix?.targets?.[slot]?.note;
  return note ? `${slot} (${note})` : slot;
}

function wordCount(s) {
  return s.split(/\s+/).filter(Boolean).length;
}

/**
 * Recent-mix report: what was built lately, what is owed, what to avoid, and the purpose plan (`purposes`, null without
 * config.mix.purposes). `summary` is pasted into scout prompts and starts with the purpose sentence.
 * @param {{date?:string, purpose?:string}} opts  `purpose` is the manual override of the plan (see purposePlan).
 */
export function mix({ date, purpose } = {}) {
  const day = targetDate(date);
  const cfg = loadConfig();
  const nov = cfg.novelty;
  const windowDays = cfg.mix.windowDays;
  const history = loadHistory();
  const purposes = purposePlan({ date: day, purpose, history, config: cfg });
  const past = pastEntries(history, day);
  const ago = (e) => daysBetween(day, e.date);
  const inWindow = past.filter((e) => ago(e) <= windowDays);

  const categoryCounts = {};
  const slotCounts = Object.fromEntries(SLOT_ORDER.map((s) => [s, 0]));
  for (const e of inWindow) {
    const c = e.fingerprint?.category;
    if (c) categoryCounts[c] = (categoryCounts[c] ?? 0) + 1;
    const s = e.fingerprint?.slot;
    if (s in slotCounts) slotCounts[s]++;
  }

  // A slot is owed when the six days before `day` (so the 7-day window ending today) hold fewer than its minimum.
  const owedDetail = [];
  for (const slot of SLOT_ORDER) {
    const min = cfg.mix.targets?.[slot]?.minPer7Days ?? 0;
    const recent = past.filter((e) => e.fingerprint?.slot === slot && ago(e) <= 6);
    if (recent.length < min) {
      const last = mostRecent(past.filter((e) => e.fingerprint?.slot === slot));
      owedDetail.push({ slot, lastDate: last?.date ?? null, daysSince: last ? ago(last) : null });
    }
  }
  owedDetail.sort((a, b) => (b.daysSince ?? Infinity) - (a.daysSince ?? Infinity));
  const owed = owedDetail.map((o) => o.slot);

  const avoid = new Set();
  const lastWeekCats = {};
  for (const e of past) {
    const c = e.fingerprint?.category;
    if (!c) continue;
    if (ago(e) <= nov.categoryCooldownDays) avoid.add(c);
    if (ago(e) <= 6) lastWeekCats[c] = (lastWeekCats[c] ?? 0) + 1;
  }
  for (const [c, n] of Object.entries(lastWeekCats)) if (n >= nov.maxPerCategoryIn7Days) avoid.add(c);
  const avoidCategories = [...avoid].sort();

  const avoidMechanics = [...new Set(
    past.filter((e) => ago(e) <= nov.mechanicCooldownDays).map((e) => e.fingerprint?.mechanic).filter(Boolean),
  )].sort();

  const politicalRecent = past.filter((e) => e.fingerprint?.political === true && ago(e) <= 13);
  const politicsAllowed = politicalRecent.length < cfg.mix.politicsMaxPer14Days;

  const topCats = Object.entries(categoryCounts)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([c, n]) => `${c} x${n}`);

  const pieces = [];
  if (purposes) pieces.push({ must: true, text: purposeSentence(purposes, cfg) });
  pieces.push({
    must: true,
    text: inWindow.length
      ? `In the last ${windowDays} days we shipped ${inWindow.length} build${inWindow.length === 1 ? '' : 's'}: ${topCats.slice(0, 6).join(', ')}.`
      : `Nothing has shipped in the last ${windowDays} days that counts for novelty, so the field is wide open.`,
  });
  if (avoidCategories.length) {
    pieces.push({ must: true, text: `Do not propose these categories today (cooldown or already used twice this week): ${avoidCategories.join(', ')}.` });
  }
  if (avoidMechanics.length) {
    pieces.push({ must: false, text: `Avoid these mechanics, used within the last ${nov.mechanicCooldownDays} days: ${avoidMechanics.join(', ')}.` });
  }
  if (owed.length) {
    pieces.push({ must: true, text: `Owed this week, so at least one idea each: ${owed.map((s) => slotNote(cfg, s)).join('; ')}.` });
  }
  pieces.push({
    must: true,
    text: politicsAllowed
      ? 'A political idea is permitted but rare: playful and satirical only, never partisan.'
      : `No political ideas today (cap of ${cfg.mix.politicsMaxPer14Days} per 14 days reached on ${politicalRecent[0]?.date ?? 'a recent day'}).`,
  });

  // Under 150 words: drop optional sentences at 140, then shorten the list of owed slot notes, then cut hard at 147 words
  // (the purpose sentence comes first, so the cut never reaches it).
  let kept = pieces;
  const render = (ps) => ps.map((p) => p.text).join(' ');
  if (wordCount(render(kept)) >= 140) kept = kept.filter((p) => p.must);
  let summary = render(kept);
  if (wordCount(summary) >= 140 && owed.length) {
    summary = render(kept.map((p) => (p.text.startsWith('Owed this week') ? { text: `Owed this week, so at least one idea each: ${owed.join(', ')}.` } : p)));
  }
  while (wordCount(summary) >= 148) {
    summary = summary.split(/\s+/).slice(0, 147).join(' ');
  }

  return {
    window: { days: windowDays, from: addDays(day, -windowDays), to: addDays(day, -1), builds: inWindow.length },
    categoryCounts,
    slotCounts,
    owed,
    owedDetail,
    avoidCategories,
    avoidMechanics,
    politicsAllowed,
    purposes,
    summary,
  };
}

function main() {
  const flags = parseArgs();
  const cmd = flags._[0];
  try {
    const date = flags.date && flags.date !== true
      ? flags.date
      : localParts(resolveNow(flags), loadConfig().timezone).date;
    if (cmd === 'check') {
      if (!flags.candidates || flags.candidates === true) die('usage: novelty.mjs check --candidates <file.json> [--date D]', 2);
      if (!fs.existsSync(flags.candidates)) die(`candidates file not found: ${flags.candidates}`, 2);
      let candidates = readJson(flags.candidates);
      if (candidates && !Array.isArray(candidates) && Array.isArray(candidates.candidates)) candidates = candidates.candidates;
      print(checkCandidates(candidates, { date }));
    } else if (cmd === 'mix') {
      let purpose;
      if (flags.purpose !== undefined) {
        if (flags.purpose === true || flags.purpose === '') die('usage: novelty.mjs mix [--date D] [--purpose tool|lesson|explorer|studio|play]', 2);
        purpose = String(flags.purpose);
      }
      print({ ok: true, ...mix({ date, purpose }) });
    } else {
      die('usage: novelty.mjs check|mix (see ops/CONTRACT.md 6.3)', 2);
    }
  } catch (err) {
    die(err.message, 1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
