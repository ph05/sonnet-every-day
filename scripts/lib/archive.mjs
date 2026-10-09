// Pure helpers for the static site generator: escaping, archive model, feed, sitemap, template rendering.
// No filesystem or clock access here, so everything is deterministic and unit-testable.
import { addDays, dayNumber } from './common.mjs';

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
 */
export function buildArchive({ projects, config, siteUrl, now, through }) {
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
 * and `$` sequences in values are never interpreted.
 * @returns {{html: string, unknown: string[], missing: string[]}}
 */
export function renderTemplate(template, archive) {
  const values = {
    SITE_NAME: escapeHtml(archive.site.name),
    SITE_TAGLINE: escapeHtml(archive.site.tagline),
    SITE_URL: escapeHtml(archive.site.url),
    ARCHIVE_JSON: jsonForScript(archive),
    NOSCRIPT_LIST: renderNoscriptList(archive),
    GENERATED_AT: escapeHtml(archive.generatedAt),
  };
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
  return { html, unknown: [...unknown], missing: PLACEHOLDERS.filter((p) => !seen.has(p)) };
}

/** Atom feed of the newest FEED_LIMIT days. `publishedAt` comes from history entries keyed by date. */
export function renderFeed({ archive, publishedAtByDate = {} }) {
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

export function renderSitemap(archive) {
  const siteUrl = archive.site.url;
  const urls = [{ loc: siteUrl, lastmod: archive.stats.lastDate }, ...archive.days.map((d) => ({ loc: absoluteUrl(siteUrl, d.path), lastmod: d.date }))];
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
