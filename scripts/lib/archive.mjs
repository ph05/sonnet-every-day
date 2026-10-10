// Pure helpers for the static site generator: escaping, archive model, feed, sitemap, template rendering.
// No filesystem or clock access here, so everything is deterministic and unit-testable.
import { addDays, dayNumber, hashStr } from './common.mjs';

export const DEFAULT_TAGLINE = 'A new, one-of-a-kind web toy every day at 4am ET, built by a team of Sonnet agents.';
export const FEED_LIMIT = 30;
export const PLACEHOLDERS = ['SITE_NAME', 'SITE_TAGLINE', 'SITE_URL', 'ARCHIVE_JSON', 'NOSCRIPT_LIST', 'GENERATED_AT'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Characters that may not appear in an XML 1.0 document (or are pointless in HTML text).
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

const clean = (v) => String(v ?? '').replace(BAD_CHARS, '');

/** Escapes for HTML text and for double- or single-quoted attribute values. */
export function escapeHtml(v) {
  return clean(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Escapes for XML text and attribute values. */
export function escapeXml(v) {
  return clean(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
}

/**
 * JSON for an inline <script type="application/json"> block. `<`, `>` and `&` are written as \u escapes
 * (still valid JSON inside strings), so `</script>` and `<!--` can never end the block; U+2028/2029 are
 * escaped because they are line terminators in some script contexts.
 */
export function jsonForScript(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Absolute, https/http, trailing-slash site URL. Throws on anything unusable. */
export function normalizeSiteUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new Error(`config.siteUrl is not a valid absolute URL: ${JSON.stringify(raw)}`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`config.siteUrl must be http(s): ${raw}`);
  u.hash = '';
  u.search = '';
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return u.toString();
}

/** Resolves a site-relative path (`d/x/`, `feed.xml`) against the site URL, encoding each segment. */
export function absoluteUrl(siteUrl, rel) {
  const encoded = String(rel).split('/').map((seg) => encodeURIComponent(seg)).join('/');
  return new URL(encoded, siteUrl).toString();
}

/** Consecutive dates ending at the latest date in `dates`. */
export function streakOf(dates) {
  const set = new Set(dates);
  if (set.size === 0) return 0;
  let cursor = [...set].sort().at(-1);
  let streak = 0;
  while (set.has(cursor)) {
    streak++;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

/** Every calendar date in [from, through] that is not in `have`, ascending. */
export function missingDatesBetween(from, through, have) {
  const set = new Set(have);
  const out = [];
  if (!DATE_RE.test(from) || !DATE_RE.test(through)) return out;
  for (let d = from, guard = 0; d <= through && guard < 20000; d = addDays(d, 1), guard++) {
    if (!set.has(d)) out.push(d);
  }
  return out;
}

const strArray = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
const sortedCounts = (map) => Object.fromEntries([...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** One archive.json `days[]` item from a validated project.json plus its history entry. */
export function dayRecord({ entry, project, startDate }) {
  const fp = project.fingerprint && typeof project.fingerprint === 'object' ? project.fingerprint : {};
  const dirPath = `d/${project.date}-${project.slug}/`;
  const thumb = typeof project.thumb === 'string' && /^[\w.-]+$/.test(project.thumb) ? project.thumb : 'thumb.png';
  return {
    n: dayNumber(project.date, startDate),
    date: project.date,
    slug: project.slug,
    path: dirPath,
    title: String(project.title ?? entry.title ?? project.slug),
    tagline: String(project.tagline ?? entry.tagline ?? ''),
    description: String(project.description ?? ''),
    tier: project.tier,
    category: String(fp.category ?? ''),
    mechanic: String(fp.mechanic ?? ''),
    tone: strArray(fp.tone),
    tech: strArray(fp.tech),
    tags: strArray(fp.tags),
    palette: strArray(project.palette),
    thumb: `${dirPath}${thumb}`,
  };
}

/**
 * Builds the archive document. `projects` is [{entry, project}] (already validated). `through` is the last
 * date that counts for missing-day purposes. `publishedAt` metadata is kept out of archive.json on purpose:
 * the gallery does not need it and it would make the file churn when history is re-added.
 * `kaizen` is the optional teaser from kaizenTeaser(); it is left out when there is nothing to tease.
 */
export function buildArchive({ projects, config, siteUrl, now, through, kaizen = null }) {
  const days = projects
    .map((p) => dayRecord({ ...p, startDate: config.startDate }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const dates = days.map((d) => d.date);
  const categories = new Map();
  const tiers = new Map();
  for (const d of days) {
    categories.set(d.category, (categories.get(d.category) ?? 0) + 1);
    tiers.set(String(d.tier), (tiers.get(String(d.tier)) ?? 0) + 1);
  }
  const lastDate = dates[0] ?? null;
  const firstDate = dates.at(-1) ?? null;
  const refDate = through && (!lastDate || through > lastDate) ? through : lastDate;
  const missingDates = refDate ? missingDatesBetween(config.startDate, refDate, dates) : [];
  return {
    schema: 1,
    generatedAt: now.toISOString(),
    site: {
      name: config.name || 'Sonnet Every Day',
      tagline: config.tagline || DEFAULT_TAGLINE,
      url: siteUrl,
      startDate: config.startDate,
    },
    stats: {
      days: refDate ? Math.max(0, dayNumber(refDate, config.startDate)) : 0,
      projects: days.length,
      streak: streakOf(dates),
      categories: sortedCounts(categories),
      tiers: sortedCounts(tiers),
      firstDate,
      lastDate,
      missingDates,
    },
    ...(kaizen ? { kaizen } : {}),
    days,
  };
}

/** Server-rendered `<li>` links so the gallery works without JavaScript. */
export function renderNoscriptList(archive) {
  return archive.days
    .map((d) => {
      const tagline = d.tagline ? ` <span class="tagline">${escapeHtml(d.tagline)}</span>` : '';
      return `<li><a href="${escapeHtml(d.path)}">${escapeHtml(d.title)}</a> <time datetime="${escapeHtml(d.date)}">${escapeHtml(d.date)}</time>${tagline}</li>`;
    })
    .join('\n');
}

/**
 * Plain placeholder substitution in a single pass, so substituted values are never re-scanned
 * and `$` sequences in values are never interpreted. `expected` lists the placeholders a template
 * should use; the ones it never used come back in `missing`.
 * @returns {{html: string, unknown: string[], missing: string[]}}
 */
function fillTemplate(template, values, expected) {
  const unknown = new Set();
  const seen = new Set();
  const html = template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, name) => {
    if (Object.hasOwn(values, name)) {
      seen.add(name);
      return values[name];
    }
    unknown.add(whole);
    return whole;
  });
  return { html, unknown: [...unknown], missing: expected.filter((p) => !seen.has(p)) };
}

export function renderTemplate(template, archive) {
  return fillTemplate(template, {
    SITE_NAME: escapeHtml(archive.site.name),
    SITE_TAGLINE: escapeHtml(archive.site.tagline),
    SITE_URL: escapeHtml(archive.site.url),
    ARCHIVE_JSON: jsonForScript(archive),
    NOSCRIPT_LIST: renderNoscriptList(archive),
    GENERATED_AT: escapeHtml(archive.generatedAt),
  }, PLACEHOLDERS);
}

/** Atom feed of the newest FEED_LIMIT days. `publishedAt` comes from history entries keyed by date. */
export function renderFeed({ archive, publishedAtByDate = {}, diary = false }) {
  const siteUrl = archive.site.url;
  const items = archive.days.slice(0, FEED_LIMIT).map((d) => {
    const raw = publishedAtByDate[d.date];
    const parsed = raw ? new Date(raw) : null;
    const updated = parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : `${d.date}T00:00:00.000Z`;
    return { d, updated };
  });
  const feedUpdated = items.reduce((m, i) => (i.updated > m ? i.updated : m), '') || archive.generatedAt;
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <id>${escapeXml(siteUrl)}</id>`,
    `  <title>${escapeXml(archive.site.name)}</title>`,
    `  <subtitle>${escapeXml(archive.site.tagline)}</subtitle>`,
    `  <updated>${escapeXml(feedUpdated)}</updated>`,
    `  <link rel="self" type="application/atom+xml" href="${escapeXml(absoluteUrl(siteUrl, 'feed.xml'))}"/>`,
    `  <link rel="alternate" type="text/html" href="${escapeXml(siteUrl)}"/>`,
    `  <author><name>${escapeXml(archive.site.name)}</name></author>`,
  ];
  if (diary) lines.push(`  <link rel="related" type="text/html" title="${escapeXml(KAIZEN_TITLE)}" href="${escapeXml(absoluteUrl(siteUrl, KAIZEN_PATH))}"/>`);
  for (const { d, updated } of items) {
    const url = absoluteUrl(siteUrl, d.path);
    lines.push(
      '  <entry>',
      `    <id>${escapeXml(url)}</id>`,
      `    <title>${escapeXml(`Day ${d.n}: ${d.title}`)}</title>`,
      `    <link rel="alternate" type="text/html" href="${escapeXml(url)}"/>`,
      `    <link rel="enclosure" type="image/png" href="${escapeXml(absoluteUrl(siteUrl, d.thumb))}"/>`,
      `    <published>${escapeXml(updated)}</published>`,
      `    <updated>${escapeXml(updated)}</updated>`,
    );
    if (d.category) lines.push(`    <category term="${escapeXml(d.category)}"/>`);
    lines.push(`    <summary>${escapeXml(d.description || d.tagline || d.title)}</summary>`, '  </entry>');
  }
  lines.push('</feed>', '');
  return lines.join('\n');
}

/** `extraPages` is [{path, lastmod?}] for pages that are not projects (the swarm's diary). */
export function renderSitemap(archive, extraPages = []) {
  const siteUrl = archive.site.url;
  const urls = [
    { loc: siteUrl, lastmod: archive.stats.lastDate },
    ...extraPages.map((p) => ({ loc: absoluteUrl(siteUrl, p.path), lastmod: p.lastmod })),
    ...archive.days.map((d) => ({ loc: absoluteUrl(siteUrl, d.path), lastmod: d.date })),
  ];
  const lines = ['<?xml version="1.0" encoding="utf-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'];
  for (const u of urls) {
    lines.push('  <url>', `    <loc>${escapeXml(u.loc)}</loc>`);
    if (u.lastmod) lines.push(`    <lastmod>${escapeXml(u.lastmod)}</lastmod>`);
    lines.push('  </url>');
  }
  lines.push('</urlset>', '');
  return lines.join('\n');
}

export function renderRobots(siteUrl) {
  return `User-agent: *\nAllow: /\n\nSitemap: ${absoluteUrl(siteUrl, 'sitemap.xml')}\n`;
}

// ---------------------------------------------------------------------------------------------- the swarm's diary
// Everything below turns ops/kaizen/INDEX.json into docs/kaizen/. The ledger text is written by language
// models, so every field is validated, length-capped and escaped; nothing from it is ever emitted as markup.

export const KAIZEN_PATH = 'kaizen/';
export const KAIZEN_TITLE = 'The swarm’s diary';
export const KAIZEN_PLACEHOLDERS = [
  'SITE_NAME', 'SITE_URL', 'GENERATED_AT', 'KAIZEN_LEDE', 'KAIZEN_STATS', 'KAIZEN_FILTERS', 'KAIZEN_ENTRIES', 'KAIZEN_EMPTY', 'KAIZEN_PROPOSALS',
];

const KAIZEN_STATUSES = ['applied', 'rejected', 'reverted', 'proposed'];
const STATUS_BADGE = { applied: 'Applied', rejected: 'Rejected', reverted: 'Reverted', proposed: 'Proposal' };
const REASON_LABEL = { applied: 'Note', rejected: 'Why it was rejected', reverted: 'Why it was reverted', proposed: 'Note' };
// One line per roster member (from their role files); unknown agents are shown by name only.
const PERSONAS = {
  pulse: 'the current-events and culture scout',
  cards: 'the odds-and-games specialist',
  lab: 'the science-and-systems specialist',
  jester: 'the humor-and-words specialist',
  architect: 'structure and integration',
  artisan: 'look, feel and motion',
  engineer: 'logic, performance and correctness',
  critic: 'quality, honesty and adversarial review',
  clerk: 'exact, mechanical, unflappable',
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const AGENT_RE = /^[a-z][a-z0-9-]{0,31}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PROPOSALS_DIR = 'ops/kaizen/proposals/';
const MAX_FILES_SHOWN = 6;
const LIMITS = { title: 200, observation: 1200, reason: 800, question: 400, file: 200, files: 40 };

/** Collapses whitespace, drops illegal characters and cuts to `max` characters without splitting a surrogate pair. */
function tidy(v, max) {
  const s = clean(v).replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  let cut = s.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

function validDate(v) {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
  const t = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === v;
}
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const formatDate = (date) => {
  const [y, m, d] = date.split('-');
  return `${MONTHS[Number(m) - 1]} ${Number(d)}, ${y}`;
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function githubUrl(repo, ...parts) {
  return `https://github.com/${repo}/${parts.map((p) => String(p).split('/').map(encodeURIComponent).join('/')).join('/')}`;
}

/**
 * Validates the kaizen ledger. A missing ledger (undefined/null) is an empty diary. Anything that is not
 * `{entries: []}` is reported as `ok:false` so the caller can keep the page it already has. Single bad entries
 * are skipped with a warning.
 * @param {unknown} raw parsed INDEX.json
 * @param {{repo?: string, workBranch?: string, members?: string[]}} [opts]
 * @returns {{ok: boolean, error?: string, entries: object[], warnings: string[]}} entries newest first
 */
export function normalizeKaizen(raw, { repo, workBranch = 'main', members = Object.keys(PERSONAS) } = {}) {
  const warnings = [];
  if (raw === undefined || raw === null) return { ok: true, entries: [], warnings };
  if (typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.entries)) {
    return { ok: false, error: 'ops/kaizen/INDEX.json is not {entries: [...]}', entries: [], warnings };
  }
  const links = typeof repo === 'string' && REPO_RE.test(repo);
  if (!links) warnings.push('config.repo is not "owner/name"; diary entries get no GitHub links');
  const byId = new Map();
  raw.entries.forEach((e, index) => {
    const skip = (why) => warnings.push(`ops/kaizen/INDEX.json entry ${index} skipped: ${why}`);
    if (!e || typeof e !== 'object' || Array.isArray(e)) return skip('not an object');
    if (!validDate(e.date)) return skip(`bad date ${JSON.stringify(e.date)}`);
    const agent = typeof e.agent === 'string' ? e.agent.trim().toLowerCase() : '';
    if (!AGENT_RE.test(agent)) return skip(`bad agent ${JSON.stringify(e.agent)}`);
    const title = tidy(e.title, LIMITS.title);
    if (!title) return skip('no title');
    const status = typeof e.status === 'string' ? e.status.trim().toLowerCase() : '';
    if (!KAIZEN_STATUSES.includes(status)) return skip(`unknown status ${JSON.stringify(e.status)}`);
    const files = (Array.isArray(e.files) ? e.files : [])
      .filter((f) => typeof f === 'string' && f.trim())
      .slice(0, LIMITS.files)
      .map((f) => tidy(f, LIMITS.file));
    const sha = typeof e.sha === 'string' && SHA_RE.test(e.sha.trim()) ? e.sha.trim().toLowerCase() : null;
    const lines = Number(e.linesChanged);
    const id = typeof e.id === 'string' && SLUG_RE.test(e.id.toLowerCase()) ? e.id.toLowerCase() : `${e.date}-${agent}`;
    const proposalFile = files.find((f) => f.startsWith(PROPOSALS_DIR) && f.endsWith('.md')) ?? null;
    const category = tidy(e.category, 32).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (byId.has(id)) warnings.push(`ops/kaizen/INDEX.json has more than one entry with id ${id}; using the last`);
    byId.set(id, {
      index,
      entry: {
        id,
        date: e.date,
        agent,
        persona: capitalize(agent),
        role: Object.hasOwn(PERSONAS, agent) ? PERSONAS[agent] : '',
        title,
        observation: tidy(e.observation, LIMITS.observation),
        category: category || 'uncategorised',
        files,
        linesChanged: Number.isFinite(lines) && lines >= 0 ? Math.trunc(lines) : 0,
        status,
        sha,
        commitUrl: links && sha ? githubUrl(repo, 'commit', sha) : null,
        proposalUrl: links && proposalFile ? githubUrl(repo, 'blob', workBranch, proposalFile) : null,
        question: tidy(e.question, LIMITS.question) || null,
        reason: tidy(e.reason, LIMITS.reason) || null,
      },
    });
  });
  const rank = new Map(members.map((m, i) => [m, i]));
  const entries = [...byId.values()]
    .sort((a, b) => (a.entry.date === b.entry.date ? b.index - a.index : a.entry.date < b.entry.date ? 1 : -1))
    .map((x) => x.entry);
  for (const e of entries) e.hue = rank.has(e.agent) ? (rank.get(e.agent) * 41) % 360 : hashStr(e.agent) % 360;
  return { ok: true, entries, warnings };
}

/** Counts for the diary header and kaizen.json. */
export function summarizeKaizen(entries, members = Object.keys(PERSONAS)) {
  const count = (status) => entries.filter((e) => e.status === status).length;
  const tally = (key, list) => {
    const m = new Map();
    for (const e of list) m.set(e[key], (m.get(e[key]) ?? 0) + 1);
    return m;
  };
  const applied = entries.filter((e) => e.status === 'applied');
  const dates = entries.map((e) => e.date);
  return {
    entries: entries.length,
    applied: applied.length,
    rejected: count('rejected'),
    reverted: count('reverted'),
    proposed: count('proposed'),
    linesChanged: applied.reduce((n, e) => n + e.linesChanged, 0),
    members: new Set(entries.map((e) => e.agent)).size,
    roster: members.length,
    agents: sortedCounts(tally('agent', entries)),
    categories: sortedCounts(tally('category', entries)),
    firstDate: dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null,
    lastDate: dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null,
  };
}

/** The optional `kaizen` field of archive.json: newest applied kaizen plus how many have landed; null if none. */
export function kaizenTeaser(entries) {
  const applied = entries.filter((e) => e.status === 'applied');
  if (applied.length === 0) return null;
  const { date, agent, title } = applied[0];
  return { latest: { date, agent, title }, count: applied.length };
}

/** docs/kaizen/kaizen.json */
export function renderKaizenJson({ archive, entries, repo, workBranch }) {
  return `${JSON.stringify({
    schema: 1,
    generatedAt: archive.generatedAt,
    site: { name: archive.site.name, url: archive.site.url },
    repo: typeof repo === 'string' && REPO_RE.test(repo) ? repo : null,
    branch: workBranch ?? null,
    stats: summarizeKaizen(entries),
    entries: entries.map(({ hue, ...e }) => e),
  }, null, 2)}\n`;
}

const attr = escapeHtml;

function renderEntry(e, withDate) {
  const files = e.files.slice(0, MAX_FILES_SHOWN).map((f) => `<li><code>${escapeHtml(f)}</code></li>`);
  if (e.files.length > MAX_FILES_SHOWN) files.push(`<li class="files-more">+${e.files.length - MAX_FILES_SHOWN} more</li>`);
  const lineLabel = { rejected: 'tried', proposed: 'in the note' }[e.status];
  const links = [];
  if (e.proposalUrl) links.push(`<a class="entry-link" href="${attr(e.proposalUrl)}">Read the proposal<span class="sr-only"> by ${escapeHtml(e.persona)}</span></a>`);
  if (e.commitUrl) links.push(`<a class="entry-link" href="${attr(e.commitUrl)}">Commit <code>${escapeHtml(e.sha.slice(0, 7))}</code><span class="sr-only"> by ${escapeHtml(e.persona)}</span></a>`);
  const foot = [];
  if (e.linesChanged || e.status === 'applied') foot.push(`<span class="lines">${plural(e.linesChanged, 'line')}${lineLabel ? ` ${lineLabel}` : ' changed'}</span>`);
  foot.push(...links);
  const domId = `e-${e.id}`;
  const heading = withDate ? 'h3' : 'h4';
  // Proposals are listed apart from the log, so the status filter never applies to them.
  const statusAttr = e.status === 'proposed' ? '' : ` data-status="${attr(e.status)}"`;
  return [
    `<li class="entry entry-${attr(e.status)}${e.status === 'proposed' ? ' proposal' : ''}" id="${attr(domId)}" data-agent="${attr(e.agent)}" data-category="${attr(e.category)}"${statusAttr} style="--hue:${e.hue}">`,
    '  <article>',
    '    <header class="entry-head">',
    `      <span class="avatar" aria-hidden="true">${escapeHtml(e.persona.charAt(0))}</span>`,
    '      <p class="who">',
    `        <span class="who-name">${escapeHtml(e.persona)}</span>`,
    e.role ? `        <span class="who-role">${escapeHtml(e.role)}</span>` : '',
    '      </p>',
    `      <span class="badge badge-${attr(e.status)} mono">${STATUS_BADGE[e.status]}</span>`,
    '    </header>',
    `    <p class="entry-meta mono">${withDate ? `<time datetime="${attr(e.date)}">${escapeHtml(formatDate(e.date))}</time><span aria-hidden="true"> · </span>` : ''}<span class="entry-cat">${escapeHtml(e.category)}</span></p>`,
    `    <${heading} class="entry-title"><a href="#${attr(domId)}">${escapeHtml(e.title)}</a></${heading}>`,
    e.observation ? `    <p class="entry-obs">${escapeHtml(e.observation)}</p>` : '',
    e.reason ? `    <p class="entry-reason"><strong>${REASON_LABEL[e.status]}.</strong> ${escapeHtml(e.reason)}</p>` : '',
    e.question ? `    <p class="entry-question"><span class="q-mark mono" aria-hidden="true">?</span><span><strong>Still wondering.</strong> ${escapeHtml(e.question)}</span></p>` : '',
    files.length ? `    <ul class="files mono" aria-label="Files touched">${files.join('')}</ul>` : '',
    ...(foot.length ? ['    <footer class="entry-foot mono">', ...foot.map((f) => `      ${f}`), '    </footer>'] : []),
    '  </article>',
    '</li>',
  ].filter(Boolean).join('\n');
}

function chip(key, value, label, count, pressed, hue) {
  const style = hue === undefined ? '' : ` style="--hue:${hue}"`;
  return `<button type="button" class="chip" data-key="${key}" data-value="${attr(value)}" aria-pressed="${pressed}"${style}>${escapeHtml(label)} <span class="chip-count">${count}</span></button>`;
}

function filterGroup(id, key, title, options, total) {
  return [
    `<div class="filter-group" role="group" aria-labelledby="filter-${id}">`,
    `  <p class="filter-label mono" id="filter-${id}">${escapeHtml(title)}</p>`,
    `  <div class="chips">${[chip(key, '', 'All', total, 'true'), ...options.map((o) => chip(key, o.value, o.label, o.count, 'false', o.hue))].join('')}</div>`,
    '</div>',
  ].join('\n');
}

function renderFilters(entries, main) {
  const members = [...new Set(entries.map((e) => e.agent))];
  const rank = (a) => (Object.hasOwn(PERSONAS, a) ? Object.keys(PERSONAS).indexOf(a) : 99);
  members.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
  const countBy = (list, key, v) => list.filter((e) => e[key] === v).length;
  const hueOf = (a) => entries.find((e) => e.agent === a).hue;
  const cats = [...new Set(entries.map((e) => e.category))].sort();
  const statuses = KAIZEN_STATUSES.filter((s) => s !== 'proposed' && main.some((e) => e.status === s));
  const groups = [
    filterGroup('agent', 'agent', 'Member', members.map((a) => ({ value: a, label: capitalize(a), count: countBy(entries, 'agent', a), hue: hueOf(a) })), entries.length),
    filterGroup('category', 'category', 'Category', cats.map((c) => ({ value: c, label: c, count: countBy(entries, 'category', c) })), entries.length),
  ];
  if (statuses.length > 1) groups.push(filterGroup('status', 'status', 'Status', statuses.map((s) => ({ value: s, label: STATUS_BADGE[s], count: countBy(main, 'status', s) })), main.length));
  return [
    '<div class="filters js-only" id="filters">',
    ...groups,
    '<p class="active-bar"><button type="button" class="btn-link" id="clear-filters" hidden>Clear all filters</button></p>',
    '</div>',
    `<p class="result-count mono js-only" id="result-count" role="status" aria-live="polite">${plural(main.length, 'entry', 'entries')}</p>`,
  ].join('\n');
}

function renderStats(stats) {
  const cell = (value, label, sub) => `<div class="stat"><p class="stat-value">${value}</p><p class="stat-label mono">${escapeHtml(label)}</p><p class="stat-sub">${escapeHtml(sub)}</p></div>`;
  const perKaizen = stats.applied ? Math.round(stats.linesChanged / stats.applied) : 0;
  return [
    cell(stats.applied, 'Kaizens landed', stats.firstDate ? `since ${formatDate(stats.firstDate)}` : 'none yet'),
    cell(stats.members, 'Members heard from', `of ${stats.roster} on the roster`),
    cell(stats.linesChanged, 'Lines changed', stats.applied ? `about ${perKaizen} per kaizen` : 'small on purpose'),
    cell(stats.rejected, 'Learnings logged', 'rejections are data'),
    cell(stats.proposed, 'Proposals waiting', 'for the owner'),
  ].join('\n');
}

function renderLede(stats) {
  const base = 'Every morning, after the day’s build is live, each member of the swarm makes one small change that leaves the whole system a little better, then writes down what it noticed. This is that notebook.';
  if (!stats.entries) return base;
  const bits = [`${plural(stats.applied, 'change')} landed`, `${plural(stats.rejected, 'rejection')} turned into ${stats.rejected === 1 ? 'a lesson' : 'lessons'}`];
  if (stats.proposed) bits.push(`${plural(stats.proposed, 'proposal')} waiting for the owner`);
  return `${base} So far: ${bits.join(', ')}.`;
}

function renderEmptyDiary() {
  return [
    '<section class="empty-diary" aria-labelledby="empty-diary-title">',
    '  <p class="empty-mark" aria-hidden="true">No. 0</p>',
    '  <h2 id="empty-diary-title">The first page is still blank.</h2>',
    '  <p>After the next build goes live, nine agents will each look around the machine, pick one small thing that bugged them, fix it, and write down why. Tiny, reversible, checked by a gate that does not take anyone’s word for it.</p>',
    '  <p>Nothing has been written yet. That is not a bug; it is the quiet before the first shift.</p>',
    '</section>',
  ].join('\n');
}

/** One <li> per date (the log is read by day), each holding that day's entries, newest first. */
function renderDays(entries, startDate) {
  const days = [];
  for (const e of entries) {
    if (days.at(-1)?.date === e.date) days.at(-1).items.push(e);
    else days.push({ date: e.date, items: [e] });
  }
  return days.map(({ date, items }) => {
    const n = dayNumber(date, startDate);
    const [y, m, d] = date.split('-');
    return [
      `<li class="day" data-date="${attr(date)}">`,
      `  <h3 class="day-head"><time datetime="${attr(date)}"><span class="d-day">${Number(d)}</span> <span class="d-mon mono">${MONTHS[Number(m) - 1]} ${y}</span></time>${n >= 1 ? ` <span class="d-num mono">Day ${n}</span>` : ''}</h3>`,
      '  <ol class="day-list">',
      items.map((e) => renderEntry(e, false)).join('\n'),
      '  </ol>',
      '</li>',
    ].join('\n');
  }).join('\n');
}

/**
 * Renders the diary page. `entries` come from normalizeKaizen (newest first).
 * @returns {{html: string, unknown: string[], missing: string[]}}
 */
export function renderKaizenPage(template, { archive, entries }) {
  const main = entries.filter((e) => e.status !== 'proposed');
  const proposals = entries.filter((e) => e.status === 'proposed');
  const stats = summarizeKaizen(entries);
  const none = '<li class="no-proposals"><p>No proposals waiting. When the swarm wants something that is off limits to it, such as the config, the gate or the contract, it writes the case here instead of doing it.</p></li>';
  return fillTemplate(template, {
    SITE_NAME: escapeHtml(archive.site.name),
    SITE_URL: escapeHtml(archive.site.url),
    GENERATED_AT: escapeHtml(archive.generatedAt),
    KAIZEN_LEDE: escapeHtml(renderLede(stats)),
    KAIZEN_STATS: entries.length ? renderStats(stats) : '',
    KAIZEN_FILTERS: main.length ? renderFilters(entries, main) : '',
    KAIZEN_ENTRIES: main.length
      ? `<ol class="log" id="log" aria-label="Kaizen entries by day, newest first">\n${renderDays(main, archive.site.startDate)}\n</ol>\n<div class="empty-results js-only" id="no-match" hidden><p class="empty-big">Nothing matches.</p><p>No entry fits that combination. The swarm has not got round to it. Yet.</p><button type="button" class="btn" id="no-match-clear">Clear the filters</button></div>`
      : '',
    KAIZEN_EMPTY: entries.length ? '' : renderEmptyDiary(),
    KAIZEN_PROPOSALS: proposals.length ? proposals.map((e) => renderEntry(e, true)).join('\n') : none,
  }, KAIZEN_PLACEHOLDERS);
}
