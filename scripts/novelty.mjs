#!/usr/bin/env node
// Novelty gate and recent-mix report for ideation.
//   novelty.mjs check --candidates <file.json> [--date D] [--now ISO]
//   novelty.mjs mix [--date D] [--now ISO]
// Only history entries with countsForNovelty:true that are dated before the target date count.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  readJson, loadConfig, loadTaxonomy, parseArgs, resolveNow, localParts, addDays, print, die,
} from './lib/common.mjs';
import { loadHistory } from './history.mjs';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLOT_ORDER = ['interest', 'currentEvents', 'humor', 'wildcard'];

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

function validateFingerprint(fp, taxonomy) {
  const problems = [];
  if (!fp || typeof fp !== 'object') return ['fingerprint missing'];
  if (!Object.hasOwn(taxonomy.categories, fp.category)) problems.push(`unknown category ${JSON.stringify(fp.category)}`);
  if (!taxonomy.mechanics.includes(fp.mechanic)) problems.push(`unknown mechanic ${JSON.stringify(fp.mechanic)}`);
  if (!Array.isArray(fp.tone) || !fp.tone.length || fp.tone.some((t) => !taxonomy.tones.includes(t))) {
    problems.push('tone must be a non-empty subset of the taxonomy tones');
  }
  if (!SLOT_ORDER.includes(fp.slot)) problems.push(`unknown slot ${JSON.stringify(fp.slot)}`);
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

  const results = candidates.map((cand, idx) => {
    const id = cand?.id ?? `#${idx}`;
    const fp = cand?.fingerprint;
    const conflicts = [];

    const bad = validateFingerprint(fp, taxonomy);
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

function slotNote(cfg, slot) {
  const note = cfg.mix?.targets?.[slot]?.note;
  return note ? `${slot} (${note})` : slot;
}

function wordCount(s) {
  return s.split(/\s+/).filter(Boolean).length;
}

/** Recent-mix report: what was built lately, what is owed, what to avoid. `summary` is pasted into scout prompts. */
export function mix({ date } = {}) {
  const day = targetDate(date);
  const cfg = loadConfig();
  const nov = cfg.novelty;
  const windowDays = cfg.mix.windowDays;
  const past = pastEntries(loadHistory(), day);
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

  // Drop optional sentences, then shorten the list of owed slot notes, until the paragraph is under 120 words.
  let kept = pieces;
  const render = (ps) => ps.map((p) => p.text).join(' ');
  if (wordCount(render(kept)) >= 110) kept = kept.filter((p) => p.must);
  let summary = render(kept);
  if (wordCount(summary) >= 110 && owed.length) {
    summary = render(kept.map((p) => (p.text.startsWith('Owed this week') ? { text: `Owed this week, so at least one idea each: ${owed.join(', ')}.` } : p)));
  }
  while (wordCount(summary) >= 118) {
    summary = summary.split(/\s+/).slice(0, 117).join(' ');
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
      print({ ok: true, ...mix({ date }) });
    } else {
      die('usage: novelty.mjs check|mix (see ops/CONTRACT.md 6.3)', 2);
    }
  } catch (err) {
    die(err.message, 1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
