// Placeholder substitution for the gallery templates. It mirrors what
// scripts/build-site.mjs does, so previews and tests see the same page the
// public site serves. Dev/test helper only: never copied into docs/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeKaizen, renderKaizenPage } from '../../scripts/lib/archive.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SITE_SRC = path.resolve(HERE, '..');

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** JSON that is safe inside <script type="application/json">: no "</script>", no "<!--", no line-separator surprises. */
export function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function noscriptList(archive) {
  return (archive.days || [])
    .filter((d) => d && typeof d === 'object')
    .map((d) => {
      const label = `Day ${d.n ?? ''} · ${d.date ?? ''} · ${d.title ?? d.slug ?? ''}`;
      const tail = d.tagline ? ` — ${escapeHtml(d.tagline)}` : '';
      return `<li><a href="${escapeHtml(d.path ?? "")}">${escapeHtml(label)}</a>${tail}</li>`;
    })
    .join('\n');
}

function fill(template, values) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key) => (key in values ? values[key] : whole));
}

export function renderIndex(template, archive, { siteUrl = archive.site?.url ?? '' } = {}) {
  return fill(template, {
    SITE_NAME: escapeHtml(archive.site?.name ?? ''),
    SITE_TAGLINE: escapeHtml(archive.site?.tagline ?? ''),
    SITE_URL: escapeHtml(siteUrl),
    ARCHIVE_JSON: jsonForScript(archive),
    NOSCRIPT_LIST: noscriptList(archive),
    GENERATED_AT: escapeHtml(archive.generatedAt ?? ''),
  });
}

export function render404(template, archive, { siteUrl = archive.site?.url ?? '' } = {}) {
  return fill(template, {
    SITE_NAME: escapeHtml(archive.site?.name ?? ''),
    SITE_TAGLINE: escapeHtml(archive.site?.tagline ?? ''),
    SITE_URL: escapeHtml(siteUrl),
  });
}

export function readSource(name) {
  return fs.readFileSync(path.join(SITE_SRC, name), 'utf8');
}

/** The swarm's diary page, rendered by the same code build-site uses. `ledger` is a parsed ops/kaizen/INDEX.json. */
export function renderKaizen(template, archive, ledger, { repo = 'example/sonnet-every-day', workBranch = 'main' } = {}) {
  const { entries } = normalizeKaizen(ledger, { repo, workBranch });
  const site = { name: '', url: '', startDate: '', ...archive.site };
  return renderKaizenPage(template, { archive: { site, generatedAt: archive.generatedAt ?? '' }, entries }).html;
}
