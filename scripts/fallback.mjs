#!/usr/bin/env node
// Tier 3 (Ideas Day) and Tier 4 (Postcard) page generators (CONTRACT 6.8).
//   fallback.mjs ideas-day --date D [--now ISO] [--force]
//   fallback.mjs postcard  --date D [--now ISO] [--force]
//   fallback.mjs notice    --date D --reason R [--now ISO]
// Both generators build into work/<D>/tmp/, validate the result with validate.mjs, and only then swap it into
// docs/d/<D>-<slug>/ and register a history entry (countsForNovelty:false). They never run build-site or git.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  rp, readJson, writeJsonAtomic, loadConfig, localParts, dayNumber, hashStr, parseArgs, resolveNow, print, die,
} from './lib/common.mjs';
import {
  Canvas, measureText, hslToRgb, toHex,
} from './lib/png.mjs';
import {
  escapeHtml, jsonForScript, fillTemplate, readAsset, renderPostcard, THUMB_WIDTH, THUMB_HEIGHT,
} from './lib/postcard.mjs';

export const DIMENSIONS = ['sophistication', 'delight', 'distinctness', 'feasibility', 'timeliness', 'interestFit', 'polishPotential', 'safety'];
const MAX_SCORE = DIMENSIONS.length * 10;
const MAX_IDEAS = 12;
const THUMB_MAX_BYTES = 300_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLOTS = ['interest', 'currentEvents', 'humor', 'wildcard'];

// ---------------------------------------------------------------------------------------------
// Sanitizing LLM-written data. Every string that reaches the page goes through here first.
// ---------------------------------------------------------------------------------------------

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Characters that never belong in display text: C0/C1 controls, zero-width and bidi override characters. */
const INVISIBLE = new RegExp(
  `[${[[0, 8], [11, 12], [14, 31], [127, 159], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff]]
    .map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`)
    .join('')}]`,
  'g',
);

// Mirrors the validator's secret scan so a stray token in LLM text can never fail a whole day's page.
const SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9]{32,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN /g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/g,
];

function redactSecrets(text) {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]');
  return out;
}

/** One-line display text: no control characters, collapsed whitespace, clipped to `max` characters. */
export function cleanText(value, max = 400) {
  let s = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof s !== 'string') return '';
  s = redactSecrets(s.replace(INVISIBLE, ' ')).replace(/\s+/g, ' ').trim();
  if (s.length > max) {
    s = s.slice(0, max - 1);
    const last = s.charCodeAt(s.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1);
    s = `${s.trimEnd()}…`;
  }
  return s;
}

/** A plain https URL on a DNS hostname, or null. Credentials, IP literals, localhost and odd lengths are rejected. */
export function cleanUrl(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > 600 || /[\s\x00-\x1f\x7f]/.test(text)) return null;
  let u;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  if (!u.hostname.includes('.') || /^\d+(?:\.\d+){3}$/.test(u.hostname) || u.hostname.startsWith('[')) return null;
  u.hash = '';
  const href = u.href;
  if (href.length > 600 || SECRET_PATTERNS.some((re) => new RegExp(re.source).test(href))) return null;
  return href;
}

function cleanScore(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.round(Math.max(0, Math.min(10, n)) * 10) / 10 : null;
}

function cleanList(value, max, perItem) {
  if (!Array.isArray(value)) return [];
  return value.map((x) => cleanText(x, perItem)).filter(Boolean).slice(0, max);
}

function cleanKebab(value, max = 40) {
  return typeof value === 'string' && value.length <= max && KEBAB_RE.test(value) ? value : '';
}

function conflictText(c) {
  if (typeof c === 'string') return cleanText(c, 200);
  if (!isObj(c)) return '';
  return cleanText([c.kind, c.detail ?? c.slug].filter(Boolean).join(': '), 200);
}

function normalizeIdea(raw, index, usedIds, warnings) {
  if (!isObj(raw)) {
    warnings.push(`idea #${index + 1} is not an object; skipped`);
    return null;
  }
  const title = cleanText(raw.title, 140);
  if (!title) {
    warnings.push(`idea #${index + 1} has no title; skipped`);
    return null;
  }
  let id = typeof raw.id === 'string' && /^[A-Za-z0-9_-]{1,24}$/.test(raw.id) ? raw.id : '';
  if (!id || usedIds.has(id)) {
    let n = index + 1;
    do id = `i${String(n++).padStart(2, '0')}`; while (usedIds.has(id));
  }
  usedIds.add(id);

  const rawScores = isObj(raw.scores) ? raw.scores : {};
  const scores = {};
  let sum = 0;
  for (const d of DIMENSIONS) {
    const v = cleanScore(rawScores[d]);
    scores[d] = v ?? 0;
    sum += v ?? 0;
  }
  const rawTotal = typeof raw.total === 'number' && Number.isFinite(raw.total) && raw.total >= 0 && raw.total <= MAX_SCORE ? raw.total : null;
  const total = Math.round((rawTotal ?? sum) * 10) / 10;
  // ideate writes the shortlist with every score and total at 0 and select fills them in; a zero total is "not scored yet",
  // never a real score, so it must not be drawn as a flat radar or compared to anything.
  const scored = total > 0;

  const research = isObj(raw.research) ? raw.research : {};
  const indexMap = new Map();
  const sources = [];
  (Array.isArray(research.sources) ? research.sources : []).forEach((s, i) => {
    if (!isObj(s) || sources.length >= 8) return;
    const url = cleanUrl(s.url);
    const stitle = cleanText(s.title, 160);
    if (!url && !stitle) return;
    indexMap.set(i, sources.length);
    sources.push({ title: stitle, url, note: cleanText(s.note, 300), verified: s.verified === true && url !== null });
  });
  const facts = (Array.isArray(research.facts) ? research.facts : []).slice(0, 8).flatMap((f) => {
    if (!isObj(f)) return [];
    const claim = cleanText(f.claim, 320);
    if (!claim) return [];
    return [{
      claim,
      source: Number.isInteger(f.sourceIndex) && indexMap.has(f.sourceIndex) ? indexMap.get(f.sourceIndex) : null,
      asOf: typeof f.asOf === 'string' && DATE_RE.test(f.asOf) ? f.asOf : '',
    }];
  });

  const design = isObj(raw.design) ? raw.design : {};
  const fp = isObj(raw.fingerprint) ? raw.fingerprint : {};
  const origin = isObj(raw.origin) ? [cleanText(raw.origin.agent, 40), cleanText(raw.origin.lens, 60)].filter(Boolean).join(' / ') : cleanText(raw.origin, 100);
  const nc = isObj(raw.noveltyCheck) ? raw.noveltyCheck : null;

  return {
    id,
    title,
    pitch: cleanText(raw.pitch, 700),
    whyNow: cleanText(raw.whyNow, 400),
    origin,
    category: cleanKebab(fp.category),
    mechanic: cleanKebab(fp.mechanic),
    slot: SLOTS.includes(fp.slot) ? fp.slot : '',
    tags: (Array.isArray(fp.tags) ? fp.tags : []).filter((t) => cleanKebab(t) === t).slice(0, 12),
    durable: typeof raw.durable === 'boolean' ? raw.durable : null,
    scored,
    scores,
    total,
    research: {
      summary: cleanText(research.summary, 1000),
      sources,
      facts,
      inspirations: cleanList(research.inspirations, 6, 200),
    },
    design: {
      coreLoop: cleanText(design.coreLoop, 500),
      scopeForOneDay: cleanText(design.scopeForOneDay, 500),
      dataNeeds: cleanText(design.dataNeeds, 160),
      sophisticationHooks: cleanList(design.sophisticationHooks, 6, 220),
      risks: cleanList(design.risks, 6, 220),
    },
    novelty: nc
      ? { ok: nc.ok !== false, conflicts: (Array.isArray(nc.conflicts) ? nc.conflicts : []).map(conflictText).filter(Boolean).slice(0, 6) }
      : null,
    carry: false,
  };
}

/**
 * Turns a state/ideas/<D>.json or work/<D>/ideas/shortlist.json document (or a bare array of ideas) into the
 * sanitized shape the page embeds. Throws if no usable idea survives. An unscored shortlist (select never ran) yields
 * `ranked:false`, `chosenId:null`, `pickKind:'none'`: the page then shows the ideas in delivery order with no pick.
 * @returns {{doc: object, warnings: string[]}}
 */
export function normalizeIdeas(raw, { date, source = '' } = {}) {
  const warnings = [];
  let list;
  let top = {};
  if (Array.isArray(raw)) list = raw;
  else if (isObj(raw)) {
    top = raw;
    list = ['ideas', 'shortlist', 'candidates'].map((k) => raw[k]).find(Array.isArray);
  }
  if (!list) throw new Error('no "ideas" array found');
  if (list.length > MAX_IDEAS) warnings.push(`${list.length} ideas listed; showing the first ${MAX_IDEAS}`);
  const used = new Set();
  const ideas = list.slice(0, MAX_IDEAS).map((r, i) => normalizeIdea(r, i, used, warnings)).filter(Boolean);
  if (!ideas.length) throw new Error('the ideas file holds no usable idea (each needs a title)');

  const wanted = [top.chosenId, top.winnerId, top.pickId, top.chosen?.id, top.selected?.id].find((v) => typeof v === 'string' && used.has(v));
  const ranked = ideas.some((i) => i.scored);
  const byTotal = [...ideas].sort((a, b) => b.total - a.total);
  const pick = wanted ? ideas.find((i) => i.id === wanted) : ranked ? byTotal[0] : null;
  const carryId = typeof top.carryoverOutId === 'string' ? top.carryoverOutId : null;
  for (const i of ideas) i.carry = i.id === carryId;

  const rejectedNotes = (Array.isArray(top.rejectedNotes) ? top.rejectedNotes : []).slice(0, 12).flatMap((n) => {
    const t = isObj(n) ? cleanText(n.title, 140) : '';
    return t ? [{ title: t, reason: cleanText(n.reason, 300) }] : [];
  });
  return {
    warnings,
    doc: {
      schema: 1,
      date: date ?? (DATE_RE.test(String(top.date)) ? top.date : ''),
      source,
      dimensions: DIMENSIONS,
      max: MAX_SCORE,
      ranked,
      chosenId: pick ? pick.id : null,
      pickKind: wanted ? 'chosen' : pick ? 'top-score' : 'none',
      carryoverOutId: ideas.some((i) => i.carry) ? carryId : null,
      rationale: wanted ? cleanText(top.rationale, 700) : '',
      rejectedNotes,
      ideas,
    },
  };
}

/** Candidate input files for a date, best first. */
export function ideasSources(date) {
  return [
    { rel: `state/ideas/${date}.json`, file: rp('state', 'ideas', `${date}.json`) },
    { rel: `work/${date}/ideas/shortlist.json`, file: rp('work', date, 'ideas', 'shortlist.json') },
  ];
}

/**
 * Loads and sanitizes the day's ideas from the first source that is usable.
 * @returns {{doc, warnings, source, skipped: string[]}|null} null when there is nothing to show
 */
export function loadIdeasDoc(date) {
  const skipped = [];
  for (const { rel, file } of ideasSources(date)) {
    if (!fs.existsSync(file)) continue;
    try {
      const { doc, warnings } = normalizeIdeas(readJson(file), { date, source: rel });
      return { doc, warnings, source: rel, skipped };
    } catch (err) {
      skipped.push(`${rel}: ${err.message}`);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Ideas Day thumbnail
// ---------------------------------------------------------------------------------------------

const upper = (s) => String(s).toUpperCase();

function clipToWidth(text, scale, maxWidth) {
  let t = text;
  while (t.length > 1 && measureText(t, scale) > maxWidth) t = t.slice(0, -1);
  return t === text ? t : `${t.trimEnd().slice(0, -2)}...`;
}

function wrapLines(text, maxChars, maxLines) {
  const words = String(text).split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (cur && `${cur} ${w}`.length > maxChars) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1].slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
    return kept;
  }
  return lines;
}

const hsl = (h, s, l) => toHex(hslToRgb(h, s, l));

export function renderIdeasThumb({ doc, date, day, hue, maxBytes = THUMB_MAX_BYTES }) {
  const cv = new Canvas(THUMB_WIDTH, THUMB_HEIGHT, hsl(hue, 0.45, 0.07));
  const accent = hsl(hue, 0.8, 0.66);
  const gold = '#f2b632';
  const light = '#f4f1ec';
  const muted = hsl(hue, 0.18, 0.72);
  cv.fillLinearGradient(0, 0, THUMB_WIDTH, THUMB_HEIGHT, [[0, hsl(hue, 0.45, 0.07)], [1, hsl(hue + 35, 0.5, 0.16)]]);
  cv.glow(930, 280, 460, accent, 0.34);
  cv.glow(1120, 40, 260, gold, 0.16);
  cv.glow(120, 640, 360, hsl(hue + 60, 0.7, 0.5), 0.12);

  const pick = doc.ideas.find((i) => i.id === doc.chosenId) ?? null;
  const x0 = 64;
  cv.text(`SONNET EVERY DAY   DAY ${day}`, x0, 52, { scale: 3, color: muted });
  cv.text('IDEAS DAY', x0, 98, { scale: 12, color: light, shadow: { dx: 5, dy: 5, color: '#000000', alpha: 0.35 } });
  const dateLine = upper(new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }));
  cv.text(dateLine, x0, 202, { scale: 4, color: accent });

  const banner = "TODAY'S BUILD DIDN'T FINISH";
  const bw = measureText(banner, 3) + 40;
  cv.fillRoundRect(x0, 262, bw, 54, 27, gold, 0.97);
  cv.text(banner, x0 + 20, 262 + 17, { scale: 3, color: '#1a1204' });
  cv.text(`THE TEAM WAS WEIGHING ${doc.ideas.length} IDEA${doc.ideas.length === 1 ? '' : 'S'}`, x0, 340, { scale: 3, color: light });

  if (doc.ranked) drawScoreBoard(cv, { doc, pick, x0, accent, gold, light, muted });
  else drawShortlist(cv, { doc, pick, x0, accent, gold, light, muted });
  return cv.toPng({ maxBytes });
}

/** Thumbnail, scored day: bars of the team scores (best first) and the pick's radar. */
function drawScoreBoard(cv, { doc, pick, x0, accent, gold, light, muted }) {
  // team scores, best to worst; the pick in gold
  const ranked = [...doc.ideas].sort((a, b) => b.total - a.total);
  const chartW = 470;
  const gap = 10;
  const barW = Math.floor((chartW - gap * (ranked.length - 1)) / ranked.length);
  const base = 566;
  const top = Math.max(...ranked.map((i) => i.total), 1);
  cv.text('SCORES, BEST FIRST', x0, 392, { scale: 2, color: muted });
  ranked.forEach((idea, i) => {
    const h = Math.max(6, Math.round((idea.total / Math.max(top, 1)) * 140));
    const isPick = pick !== null && idea.id === pick.id;
    const bx = x0 + i * (barW + gap);
    cv.fillRoundRect(bx, base - h, barW, h, 5, isPick ? gold : accent, isPick ? 1 : 0.78);
    if (isPick) cv.fillRect(bx, base + 8, barW, 4, gold, 1);
  });
  cv.fillRect(x0 - 6, base + 1, chartW + 12, 2, muted, 0.5);

  // the pick's radar
  const cx = 930;
  const cy = 258;
  const R = 150;
  const point = (k, r) => {
    const a = -Math.PI / 2 + (k / DIMENSIONS.length) * Math.PI * 2;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r, Math.cos(a), Math.sin(a)];
  };
  for (const f of [0.25, 0.5, 0.75, 1]) {
    cv.strokePath(DIMENSIONS.flatMap((_, k) => point(k, R * f).slice(0, 2)), f === 1 ? 2 : 1.4, light, f === 1 ? 0.4 : 0.2, { closed: true });
  }
  DIMENSIONS.forEach((d, k) => {
    const [px, py, ux, uy] = point(k, R);
    cv.line(cx, cy, px, py, 1.4, light, 0.22);
    const label = { sophistication: 'SOPH', delight: 'DLGT', distinctness: 'DIST', feasibility: 'FEAS', timeliness: 'TIME', interestFit: 'FIT', polishPotential: 'POL', safety: 'SAFE' }[d];
    const lx = cx + ux * (R + 22);
    const ly = cy + uy * (R + 20) - 7;
    cv.text(label, lx, ly, { scale: 2, color: muted, align: ux > 0.3 ? 'left' : ux < -0.3 ? 'right' : 'center' });
  });
  if (!pick) return;
  if (pick.scored) {
    const area = DIMENSIONS.flatMap((d, k) => point(k, (R * Math.max(pick.scores[d] ?? 0, 0.3)) / 10).slice(0, 2));
    cv.fillPolygon(area, accent, 0.36);
    cv.strokePath(area, 4, accent, 1, { closed: true });
    DIMENSIONS.forEach((d, k) => {
      const [px, py] = point(k, (R * Math.max(pick.scores[d] ?? 0, 0.3)) / 10);
      cv.fillCircle(px, py, 6, light, 1);
    });
  }

  const cap = doc.pickKind === 'chosen' ? 'THE PICK' : 'TOP SCORE';
  cv.text(cap, cx, 452, { scale: 3, color: gold, align: 'center' });
  const lines = wrapLines(upper(pick.title), 27, 2);
  lines.forEach((line, i) => cv.text(clipToWidth(line, 3, 480), cx, 488 + i * 34, { scale: 3, color: light, align: 'center' }));
}

/** Thumbnail, unscored shortlist: the ideas in delivery order, no scores, no chart, and a pick only if one was recorded. */
function drawShortlist(cv, { doc, pick, x0, accent, gold, light, muted }) {
  const left = pick ? 'THE PICK' : 'NOT RANKED YET';
  cv.text(left, x0, 392, { scale: 3, color: pick ? gold : muted });
  const lines = pick
    ? wrapLines(upper(pick.title), 27, 2)
    : wrapLines('RESEARCHED, NOT YET SCORED. NO PICK WAS MADE.', 30, 3);
  lines.forEach((line, i) => cv.text(clipToWidth(line, 3, 520), x0, 432 + i * 36, { scale: 3, color: light }));

  const px = 740;
  const rowH = 46;
  const rows = doc.ideas.slice(0, 10);
  cv.text('THE SHORTLIST', px, 70, { scale: 2, color: muted });
  rows.forEach((idea, i) => {
    const y = 108 + i * rowH;
    const isPick = pick !== null && idea.id === pick.id;
    cv.fillRoundRect(px, y, 400, 38, 10, isPick ? gold : light, isPick ? 0.95 : 0.08);
    cv.text(String(i + 1).padStart(2, '0'), px + 14, y + 12, { scale: 2, color: isPick ? '#1a1204' : accent });
    cv.text(clipToWidth(upper(idea.title), 2, 330), px + 54, y + 12, { scale: 2, color: isPick ? '#1a1204' : light });
  });
}

// ---------------------------------------------------------------------------------------------
// Page assembly
// ---------------------------------------------------------------------------------------------

function countLines(text) {
  return text.split('\n').filter((l) => l.trim()).length;
}

function uniqueVerifiedSources(doc, limit = 12) {
  const seen = new Set();
  const out = [];
  for (const idea of doc.ideas) {
    for (const s of idea.research.sources) {
      if (!s.verified || !s.url || seen.has(s.url)) continue;
      seen.add(s.url);
      out.push({ title: s.title || new URL(s.url).hostname, url: s.url });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function dateLabel(date) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/**
 * Files for docs/d/<date>-ideas-day/ except project.json stats (filled in by the caller).
 * @returns {{files: Record<string, string|Buffer>, project: object}}
 */
export function renderIdeasDay({ doc, date, day, siteName = 'Sonnet Every Day', maxThumbBytes = THUMB_MAX_BYTES }) {
  const hue = hashStr(`ideas-day:${date}`) % 360;
  const pick = doc.ideas.find((i) => i.id === doc.chosenId) ?? null;
  const noscript = (doc.ranked ? [...doc.ideas].sort((a, b) => b.total - a.total) : doc.ideas)
    .map((i) => `<li><strong>${escapeHtml(i.title)}</strong>${pick && i.id === pick.id ? ' (the pick)' : ''}${i.scored ? `, score ${escapeHtml(i.total)} of ${MAX_SCORE}` : ''}. ${escapeHtml(i.pitch)}</li>`)
    .join('\n');
  const html = fillTemplate(readAsset('ideas.template.html'), {
    DATE: date,
    DATE_LABEL: dateLabel(date),
    DAY: String(day),
    HUE: String(hue),
    SITE_NAME: siteName,
    COUNT: String(doc.ideas.length),
    BLURB: doc.ranked ? 'with sources, scores and the pick' : 'with sources and dossiers. They had not been scored, so there is no pick',
    SOURCE: doc.source || 'the daily ideas file',
    NOSCRIPT: noscript,
    DATA: jsonForScript(doc),
  });
  const ideasJson = `${JSON.stringify(doc, null, 2)}\n`;
  const files = {
    'index.html': html,
    'ideas.css': readAsset('ideas.css'),
    'ideas.js': readAsset('ideas.js'),
    'ideas.json': ideasJson,
    'thumb.png': renderIdeasThumb({ doc, date, day, hue, maxBytes: maxThumbBytes }),
  };
  const n = doc.ideas.length;
  const tagline = `Today's build didn't finish. Here are the ${n} researched ideas the team was weighing, with sources${doc.ranked ? ' and scores' : ''}.`;
  const outcome = pick
    ? `${doc.pickKind === 'chosen' ? 'The idea that was chosen' : 'The highest-scoring idea'} was "${pick.title}".`
    : 'The ideas had not been scored when the day ended, so none is singled out as a pick.';
  const project = {
    schema: 1,
    date,
    slug: 'ideas-day',
    title: 'Ideas Day',
    tagline: tagline.length > 120 ? `${tagline.slice(0, 117).trimEnd()}...` : tagline,
    description: `Today's full build did not finish, so this page shows what the team was weighing: ${n} researched ideas with their sources${doc.ranked ? ', scores' : ''} and dossiers. ${outcome}`,
    tier: 3,
    fingerprint: {
      category: 'data-viz',
      mechanic: 'explorer',
      tone: ['analytical', 'playful'],
      tech: ['svg', 'dom-ui'],
      tags: ['ideas-day', 'fallback-day', 'research-shortlist'],
      keywords: ['dossiers', 'score-radar', 'sortable-list'],
      slot: 'wildcard',
      political: false,
    },
    palette: [hsl(hue, 0.4, 0.1), hsl(hue, 0.7, 0.55), '#f2b632'],
    entry: 'index.html',
    thumb: 'thumb.png',
    network: [],
    sources: uniqueVerifiedSources(doc),
    makingOf: `A safety-net page. The day's build missed its deadline, so the researched shortlist (${doc.source || 'the ideas file'}) is published as it stood: every string was sanitized and is rendered as text, ${doc.ranked ? "scores are the team's own, " : 'the ideas are shown unscored and unranked, in the order they were delivered, '}sources that were not verified are marked as such, and nothing is fetched at view time. The thumbnail is drawn by a small software rasterizer, no browser needed.`,
    stats: { files: 0, bytes: 0, ownLoc: 0 },
    credits: `Built by the ${siteName} team`,
  };
  project.stats.ownLoc = ['index.html', 'ideas.css', 'ideas.js'].reduce((acc, f) => acc + countLines(files[f]), 0);
  return { files, project };
}

// ---------------------------------------------------------------------------------------------
// Publishing into docs/d
// ---------------------------------------------------------------------------------------------

async function tryImport(spec) {
  try {
    return await import(spec);
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && String(err.message).includes(spec.replace('./', ''))) return null;
    throw err;
  }
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function moveDir(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.cpSync(from, to, { recursive: true });
    rmrf(from);
  }
}

function writeProjectFiles(dir, files, project) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  // two passes: the stats describe the directory including project.json itself
  const measure = () => {
    let bytes = 0;
    let count = 0;
    for (const e of fs.readdirSync(dir)) {
      bytes += fs.statSync(path.join(dir, e)).size;
      count++;
    }
    return { files: count, bytes };
  };
  const write = () => fs.writeFileSync(path.join(dir, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
  write();
  const first = measure();
  project.stats.files = first.files;
  project.stats.bytes = first.bytes;
  write();
  const second = measure();
  if (second.bytes !== project.stats.bytes) {
    project.stats.bytes = second.bytes;
    write();
  }
}

// ---------------------------------------------------------------------------------------------
// state/history.json repair. history.mjs refuses to touch an unreadable file (it must never silently reset the
// record), but the last-resort fallback cannot fail a whole day on one corrupt shared file.
// ---------------------------------------------------------------------------------------------

const historyPath = () => rp('state', 'history.json');
const validHistory = (h) => isObj(h) && Array.isArray(h.entries);

/** { ok:true } for a missing or well-formed history file, else { ok:false, error }. */
export function historyHealth() {
  const file = historyPath();
  if (!fs.existsSync(file)) return { ok: true };
  try {
    const h = JSON.parse(fs.readFileSync(file, 'utf8'));
    return validHistory(h) ? { ok: true } : { ok: false, error: 'expected an object with an "entries" array' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function parseHistory(text) {
  try {
    const h = JSON.parse(text);
    return validHistory(h) ? h : null;
  } catch {
    return null;
  }
}

/** The last committed copy of the history (HEAD, else the remote tip), which a bad merge or edit cannot have touched. */
async function committedHistory(config) {
  const gs = await tryImport('./lib/gitsync.mjs');
  if (!gs?.createGit) return null;
  const g = gs.createGit(rp());
  if (g.out(['rev-parse', '--is-inside-work-tree']) !== 'true') return null;
  for (const ref of ['HEAD', `refs/remotes/origin/${config.workBranch}`]) {
    const text = g.out(['show', `${ref}:./state/history.json`]);
    const h = text ? parseHistory(text) : null;
    if (h) return { history: h, source: ref === 'HEAD' ? 'the last commit' : 'the remote branch' };
  }
  return null;
}

/** One entry per project directory under docs/d, in the shape history.mjs addProject writes. */
function entriesFromDisk(base, config, now) {
  const root = rp('docs', 'd');
  if (!fs.existsSync(root)) return [];
  const known = new Map((base?.entries ?? []).filter(isObj).map((e) => [`${e.date}|${e.slug}`, e]));
  const startDate = base?.startDate || config.startDate;
  const byDate = new Map();
  for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const pj = readJson(path.join(root, dirent.name, 'project.json'), null);
    if (!isObj(pj) || !DATE_RE.test(String(pj.date)) || !KEBAB_RE.test(String(pj.slug)) || dirent.name !== `${pj.date}-${pj.slug}`) continue;
    if (typeof pj.title !== 'string' || !pj.title.trim() || ![1, 2, 3, 4].includes(pj.tier) || !isObj(pj.fingerprint)) continue;
    const n = dayNumber(pj.date, startDate);
    if (!(n >= 1)) continue;
    const prior = known.get(`${pj.date}|${pj.slug}`);
    const run = readJson(rp('state', 'runs', `${pj.date}.json`), null);
    const entry = {
      n: Number.isInteger(prior?.n) ? prior.n : n,
      date: pj.date,
      slug: pj.slug,
      title: cleanText(pj.title, 200),
      tagline: cleanText(pj.tagline, 120),
      tier: pj.tier,
      fingerprint: pj.fingerprint,
      path: `d/${pj.date}-${pj.slug}/`,
      publishedAt: prior?.publishedAt ?? (run?.status === 'published' && run.tier === pj.tier ? run.publishedAt : null) ?? now.toISOString(),
      countsForNovelty: typeof prior?.countsForNovelty === 'boolean' ? prior.countsForNovelty : pj.tier <= 2,
    };
    // Two projects for one date should not exist; the better tier is the one that was published.
    const held = byDate.get(pj.date);
    if (!held || entry.tier < held.tier) byDate.set(pj.date, entry);
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * Makes state/history.json readable again. The bad file is kept as state/history.json.corrupt-<N>; the new one is the
 * entries rebuilt from the project.json files under docs/d (keeping n, publishedAt and countsForNovelty from the last committed
 * copy when there is one), else that committed copy, else an empty history.
 * @returns {Promise<{repaired: false}|{repaired: true, source: string, quarantined: string, entries: number, error: string}>}
 */
export async function repairHistory({ now } = {}) {
  const health = historyHealth();
  if (health.ok) return { repaired: false };
  const config = loadConfig();
  const instant = now instanceof Date ? now : resolveNow({ now });
  const committed = await committedHistory(config);
  const rebuilt = entriesFromDisk(committed?.history, config, instant);
  let source;
  let entries;
  if (rebuilt.length) {
    entries = rebuilt;
    source = `docs/d${committed ? ` and ${committed.source}` : ''}`;
  } else if (committed) {
    entries = committed.history.entries;
    source = committed.source;
  } else {
    entries = [];
    source = 'empty';
  }
  const file = historyPath();
  let n = 1;
  while (fs.existsSync(`${file}.corrupt-${n}`)) n++;
  const quarantined = `${file}.corrupt-${n}`;
  fs.renameSync(file, quarantined);
  writeJsonAtomic(file, { schema: 1, startDate: committed?.history.startDate || config.startDate, entries });
  return { repaired: true, source, quarantined: path.relative(rp(), quarantined).split(path.sep).join('/'), entries: entries.length, error: health.error };
}

function readHistoryEntries() {
  const h = readJson(rp('state', 'history.json'), { entries: [] });
  return Array.isArray(h?.entries) ? h.entries : [];
}

/** A better (lower number) tier already published for the date, from history or the run file; else null. */
export function betterTierPublished(date, tier) {
  const entry = readHistoryEntries().find((e) => e?.date === date);
  if (entry && Number.isInteger(entry.tier) && entry.tier < tier) return { tier: entry.tier, where: 'state/history.json' };
  const run = readJson(rp('state', 'runs', `${date}.json`), null);
  if (run?.status === 'published' && Number.isInteger(run.tier) && run.tier < tier) return { tier: run.tier, where: `state/runs/${date}.json` };
  return null;
}

function registerHistory(projectDir, project, { now }) {
  return tryImport('./history.mjs').then((mod) => {
    if (mod?.addProject) {
      try {
        return mod.addProject(projectDir, { countsForNovelty: false, now });
      } catch (err) {
        throw new Error(`history.addProject failed: ${err.message}`);
      }
    }
    const file = rp('state', 'history.json');
    const h = readJson(file, { schema: 1, startDate: loadConfig().startDate, entries: [] });
    const existing = h.entries.find((e) => e.date === project.date);
    const entry = {
      n: existing?.n ?? dayNumber(project.date, h.startDate || loadConfig().startDate),
      date: project.date,
      slug: project.slug,
      title: project.title,
      tagline: project.tagline.slice(0, 120),
      tier: project.tier,
      fingerprint: project.fingerprint,
      path: `d/${project.date}-${project.slug}/`,
      publishedAt: now.toISOString(),
      countsForNovelty: false,
    };
    h.entries = h.entries.filter((e) => e.date !== project.date).concat(entry).sort((a, b) => (a.date < b.date ? -1 : 1));
    writeJsonAtomic(file, h);
    return { entry, replaced: Boolean(existing) };
  });
}

/** Removes the other fallback page for the date (never a tier 1 or 2 project). */
function removeSiblingFallbacks(date, keepSlug) {
  const removed = [];
  for (const slug of ['ideas-day', 'postcard']) {
    if (slug === keepSlug) continue;
    const dir = rp('docs', 'd', `${date}-${slug}`);
    if (!fs.existsSync(dir)) continue;
    const pj = readJson(path.join(dir, 'project.json'), null);
    if (pj && Number.isInteger(pj.tier) && pj.tier < 3) continue;
    rmrf(dir);
    removed.push(`docs/d/${date}-${slug}`);
  }
  return removed;
}

function refusal(date, tier) {
  const better = betterTierPublished(date, tier);
  if (!better) return null;
  return { ok: false, action: 'refused', error: `tier ${better.tier} is already published for ${date} (${better.where}); refusing to replace it with tier ${tier}`, tier: better.tier };
}

async function publishPage({ date, slug, tier, files, project, now, validate = true }) {
  const refused = refusal(date, tier);
  if (refused) return refused;
  const name = `${date}-${slug}`;
  const stage = rp('work', date, 'tmp', 'fallback', name);
  const target = rp('docs', 'd', name);
  rmrf(stage);
  writeProjectFiles(stage, files, project);

  const warnings = [];
  let validated = false;
  if (validate) {
    const mod = await tryImport('./validate.mjs');
    if (mod?.validateProject) {
      const res = await mod.validateProject(stage, { tier, now });
      if (!res.ok) {
        rmrf(stage);
        throw new Error(`generated ${slug} page failed validation: ${res.errors.map((e) => (typeof e === 'string' ? e : e.message ?? JSON.stringify(e))).join('; ')}`);
      }
      validated = true;
      warnings.push(...res.warnings.map((w) => (typeof w === 'string' ? w : w.message ?? JSON.stringify(w))));
    } else warnings.push('validate.mjs is not available; the page was not validated');
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const aside = fs.existsSync(target) ? `${target}.old-${process.pid}` : null;
  if (aside) moveDir(target, aside);
  let history;
  try {
    moveDir(stage, target);
    history = await registerHistory(target, project, { now });
  } catch (err) {
    rmrf(target);
    if (aside) moveDir(aside, target);
    throw err;
  }
  if (aside) rmrf(aside);
  const removed = removeSiblingFallbacks(date, slug);
  rmrf(rp('work', date, 'tmp', 'fallback'));
  return {
    ok: true,
    tier,
    date,
    slug,
    title: project.title,
    path: `docs/d/${name}/`,
    files: Object.keys(files).concat('project.json').sort(),
    thumbBytes: files['thumb.png'].length,
    validated,
    warnings,
    history: history?.entry ?? null,
    replacedHistory: Boolean(history?.replaced),
    removed,
  };
}

// ---------------------------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------------------------

function context({ date, now }) {
  const config = loadConfig();
  const instant = now instanceof Date ? now : resolveNow({ now });
  const day = date ?? localParts(instant, config.timezone).date;
  if (!DATE_RE.test(String(day))) throw new Error(`bad --date value: ${date}`);
  return { config, now: instant, date: day, dayNo: dayNumber(day, config.startDate) };
}

/** Repairs an unreadable history before anything reads it; the returned note (if any) goes into the result's warnings. */
async function healHistory(ctx) {
  const fixed = await repairHistory({ now: ctx.now });
  if (!fixed.repaired) return [];
  const how = fixed.source === 'empty' ? 'replaced by an empty history' : `rebuilt from ${fixed.source}`;
  return [`state/history.json was unreadable (${fixed.error}); it was ${how} (${fixed.entries} entries) and the bad file is kept as ${fixed.quarantined}`];
}

/** Tier 3. Throws when there is no usable ideas file (callers fall back to the postcard). */
export async function ideasDay({ date, now } = {}) {
  const ctx = context({ date, now });
  const healed = await healHistory(ctx);
  const refused = refusal(ctx.date, 3);
  if (refused) return refused;
  const loaded = loadIdeasDoc(ctx.date);
  if (!loaded) throw new Error(`no usable ideas for ${ctx.date}: looked for ${ideasSources(ctx.date).map((s) => s.rel).join(' and ')}`);
  const { files, project } = renderIdeasDay({ doc: loaded.doc, date: ctx.date, day: ctx.dayNo, siteName: ctx.config.name });
  const result = await publishPage({ date: ctx.date, slug: 'ideas-day', tier: 3, files, project, now: ctx.now });
  if (result.ok) result.warnings.unshift(...healed, ...loaded.warnings, ...loaded.skipped.map((s) => `skipped ${s}`));
  return { ...result, source: loaded.source, ideas: loaded.doc.ideas.length };
}

/** Tier 4. Needs nothing but the date. */
export async function postcard({ date, now } = {}) {
  const ctx = context({ date, now });
  const healed = await healHistory(ctx);
  const refused = refusal(ctx.date, 4);
  if (refused) return refused;
  const { files, project, scene } = renderPostcard({ date: ctx.date, day: ctx.dayNo, siteName: ctx.config.name, maxThumbBytes: THUMB_MAX_BYTES });
  const result = await publishPage({ date: ctx.date, slug: 'postcard', tier: 4, files, project, now: ctx.now });
  if (result.ok) result.warnings.unshift(...healed);
  return { ...result, family: scene.family };
}

/** True when ideas-day can be generated for the date. */
export function ideasAvailable(date) {
  return loadIdeasDoc(date) !== null;
}

/** work/<D>/fallback-notice.json: what report writers need to describe a degraded day. */
export function notice({ date, reason, now } = {}) {
  const ctx = context({ date, now });
  const text = cleanText(reason, 500);
  if (!text) throw new Error('--reason is required');
  const file = rp('work', ctx.date, 'fallback-notice.json');
  const prior = readJson(file, null);
  const loaded = loadIdeasDoc(ctx.date);
  const pick = loaded ? loaded.doc.ideas.find((i) => i.id === loaded.doc.chosenId) : null;
  const entry = readHistoryEntries().find((e) => e?.date === ctx.date);
  const reasons = [...(Array.isArray(prior?.reasons) ? prior.reasons : []), { at: ctx.now.toISOString(), reason: text }].slice(-20);
  const data = {
    schema: 1,
    date: ctx.date,
    updatedAt: ctx.now.toISOString(),
    reasons,
    ideasSource: loaded?.source ?? null,
    intendedWinner: pick ? { id: pick.id, title: pick.title, pitch: pick.pitch, pickKind: loaded.doc.pickKind } : null,
    tiersAvailable: { 3: Boolean(loaded), 4: true },
    published: entry && entry.tier >= 3 ? { tier: entry.tier, slug: entry.slug, path: entry.path } : null,
  };
  writeJsonAtomic(file, data);
  return { ok: true, file: path.relative(rp(), file).split(path.sep).join('/'), notice: data };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const USAGE = 'usage: fallback.mjs ideas-day|postcard --date YYYY-MM-DD [--now ISO]  |  notice --date D --reason R';

async function main() {
  const flags = parseArgs();
  const cmd = flags._[0];
  let now;
  try {
    now = resolveNow(flags);
  } catch (err) {
    die(err.message, 2);
  }
  const date = typeof flags.date === 'string' ? flags.date : undefined;
  if (date !== undefined && !DATE_RE.test(date)) die(`bad --date value: ${date}`, 2);
  try {
    let result;
    if (cmd === 'ideas-day') result = await ideasDay({ date, now });
    else if (cmd === 'postcard') result = await postcard({ date, now });
    else if (cmd === 'notice') {
      if (typeof flags.reason !== 'string' || !flags.reason.trim()) die('notice needs --reason "<why the day degraded>"', 2);
      result = notice({ date, reason: flags.reason, now });
    } else die(USAGE, 2);
    for (const w of result.warnings ?? []) process.stderr.write(`warning: ${w}\n`);
    print(result);
    process.exitCode = result.ok ? 0 : 1;
  } catch (err) {
    die(err.message, 1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
