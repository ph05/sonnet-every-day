/* Sonnet Every Day: gallery front-end.
 * One file, no dependencies, no network (except a same-origin archive.json recovery fetch).
 * Everything that comes from archive.json is treated as untrusted text: it is only ever
 * written with textContent / setAttribute after validation, never as markup. */
(function () {
  'use strict';

  const doc = document;
  const root = doc.documentElement;
  const PAGE_SIZE = 24;
  const TOP_TAGS = 16;
  const DAY_MS = 86400000;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const HEX_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

  const CATEGORY_LABELS = {
    'cards-odds': 'Cards & odds',
    'hockey-sports': 'Hockey & sports',
    'pop-culture': 'Pop culture',
    'news-politics': 'News & politics',
    'humor-satire': 'Humor & satire',
    'science-sim': 'Science sims',
    'math-puzzle': 'Math & puzzles',
    'data-viz': 'Data viz',
    'music-audio': 'Music & audio',
    'generative-art': 'Generative art',
    'language-text': 'Language & text',
    'tools-utility': 'Tools',
    'games-arcade': 'Games',
    'retro-tech': 'Retro tech',
    'education-explainer': 'Explainers',
    'modding-games': 'Game mods',
    'finance-economics': 'Finance toys',
    'life-food-craft': 'Life & food',
    'weird-experimental': 'Weird & experimental',
  };
  const TIER_LABELS = { 2: 'Compact build', 3: 'Ideas Day', 4: 'Postcard' };
  const TIER_NOTES = {
    3: 'A stand-in edition: the build did not finish, so the day’s researched ideas were published instead.',
    4: 'A stand-in edition: no build made it, so here is a generative postcard made from the date alone.',
  };
  const SORTS = {
    new: (a, b) => cmp(b.date, a.date),
    old: (a, b) => cmp(a.date, b.date),
    title: (a, b) => cmp(a.title.toLowerCase(), b.title.toLowerCase()) || cmp(b.date, a.date),
    category: (a, b) => cmp(a.categoryLabel, b.categoryLabel) || cmp(b.date, a.date),
  };
  const FACETS = [
    { key: 'cat', field: 'category', title: 'Category' },
    { key: 'tone', field: 'tone', title: 'Tone' },
    { key: 'tech', field: 'tech', title: 'Tech' },
    { key: 'tag', field: 'tags', title: 'Tags' },
  ];

  /* ---------- small utilities ---------- */

  const $ = (sel, scope) => (scope || doc).querySelector(sel);
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const reduceMotion = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

  function h(tag, attrs) {
    const node = doc.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'text') node.textContent = v;
        else node.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (let i = 2; i < arguments.length; i++) {
      const kid = arguments[i];
      if (kid != null && kid !== false) node.append(kid);
    }
    return node;
  }

  function store(op, key, value) {
    try {
      return op === 'get' ? localStorage.getItem(key) : localStorage.setItem(key, value);
    } catch (e) {
      return null; // private mode / blocked storage: everything still works, nothing persists
    }
  }

  function hashStr(s) {
    let x = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      x ^= s.charCodeAt(i);
      x = Math.imul(x, 0x01000193) >>> 0;
    }
    return x >>> 0;
  }

  const utcDate = (s) => new Date(s + 'T00:00:00Z');
  const dayDiff = (a, b) => Math.round((utcDate(b) - utcDate(a)) / DAY_MS);
  const addDays = (s, n) => new Date(utcDate(s).getTime() + n * DAY_MS).toISOString().slice(0, 10);
  const validDate = (s) => typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(utcDate(s).getTime());
  const fmt = (opts) => new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: 'UTC' }, opts));
  const fmtShort = fmt({ month: 'short', day: 'numeric' });
  const fmtMid = fmt({ weekday: 'short', month: 'short', day: 'numeric' });
  const fmtLong = fmt({ weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const fmtMonth = fmt({ month: 'short' });
  const fmtMonthYear = fmt({ month: 'short', year: 'numeric' });
  const pad3 = (n) => String(n).padStart(3, '0');
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many || one + 's');

  function categoryLabel(slug) {
    if (!slug) return 'Uncategorized';
    if (CATEGORY_LABELS[slug]) return CATEGORY_LABELS[slug];
    const words = slug.replace(/[-_]+/g, ' ').trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  /* ---------- normalising archive.json (every field optional) ---------- */

  const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max || 600) : '');
  const list = (v, max) =>
    Array.isArray(v)
      ? Array.from(new Set(v.filter((x) => typeof x === 'string').map((x) => x.trim().replace(/[,&#=]/g, '').slice(0, 60)).filter(Boolean))).slice(0, max || 24)
      : [];

  function safeHref(v) {
    const s = text(v, 2000);
    if (!s) return '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^https?:/i.test(s)) return '';
    return s;
  }

  function safeImage(v) {
    const s = text(v, 200000);
    if (/^data:image\/(?:png|jpe?g|webp|gif|avif|svg\+xml)[;,]/i.test(s)) return s;
    return safeHref(s);
  }

  function fallbackPalette(seed) {
    const hue = hashStr(seed) % 360;
    return ['hsl(' + hue + ' 40% 16%)', 'hsl(' + hue + ' 80% 58%)', 'hsl(' + ((hue + 50) % 360) + ' 85% 68%)'];
  }

  function paletteOf(v, seed) {
    const colors = Array.isArray(v) ? v.filter((c) => typeof c === 'string' && HEX_RE.test(c.trim())).map((c) => c.trim()) : [];
    if (!colors.length) return fallbackPalette(seed);
    while (colors.length < 3) colors.push(colors[colors.length - 1]);
    return colors.slice(0, 3);
  }

  function normDay(r) {
    if (!r || typeof r !== 'object' || !validDate(r.date)) return null;
    const slug = text(r.slug, 80);
    const category = text(r.category, 60);
    const tier = Number.isInteger(r.tier) && r.tier >= 1 && r.tier <= 4 ? r.tier : 1;
    const day = {
      date: r.date,
      n: Number.isFinite(r.n) ? Math.trunc(r.n) : null,
      slug: slug,
      href: safeHref(r.path) || (slug ? 'd/' + r.date + '-' + slug + '/' : ''),
      title: text(r.title, 140) || slug || r.date,
      tagline: text(r.tagline, 300),
      description: text(r.description, 900),
      tier: tier,
      category: category,
      categoryLabel: categoryLabel(category),
      mechanic: text(r.mechanic, 40),
      tone: list(r.tone, 8),
      tech: list(r.tech, 12),
      tags: list(r.tags, 16),
      palette: paletteOf(r.palette, r.date + slug),
      thumb: safeImage(r.thumb),
    };
    day.haystack = [day.title, day.tagline, day.description, day.categoryLabel, day.category, day.mechanic, day.date, day.tone.join(' '), day.tech.join(' '), day.tags.join(' ')]
      .join(' \u0001 ')
      .toLowerCase();
    return day;
  }

  function normalize(raw) {
    const site = raw && typeof raw.site === 'object' && raw.site ? raw.site : {};
    const stats = raw && typeof raw.stats === 'object' && raw.stats ? raw.stats : {};
    const seen = new Set();
    const days = [];
    for (const r of Array.isArray(raw && raw.days) ? raw.days : []) {
      const d = normDay(r);
      if (d && !seen.has(d.date)) {
        seen.add(d.date);
        days.push(d);
      }
    }
    days.sort(SORTS.new);

    const oldest = days.length ? days[days.length - 1].date : '';
    const newest = days.length ? days[0].date : '';
    const start = validDate(site.startDate) ? site.startDate : validDate(stats.firstDate) ? stats.firstDate : oldest;
    for (const d of days) if (d.n == null) d.n = dayDiff(start, d.date) + 1;

    // Gaps between the first and last build, plus anything the generator flagged as missing.
    const missing = new Set();
    if (days.length) {
      for (let d = addDays(oldest, 1); d < newest; d = addDays(d, 1)) if (!seen.has(d)) missing.add(d);
      for (const m of Array.isArray(stats.missingDates) ? stats.missingDates : []) {
        if (validDate(m) && !seen.has(m) && m >= oldest && dayDiff(newest, m) <= 31) missing.add(m);
      }
    }

    let streak = 0;
    if (Number.isFinite(stats.streak) && stats.streak >= 0) streak = Math.trunc(stats.streak);
    else for (let d = newest; d && seen.has(d); d = addDays(d, -1)) streak++;

    const facets = {};
    for (const f of FACETS) facets[f.key] = new Map();
    for (const d of days) {
      for (const f of FACETS) {
        const vals = f.field === 'category' ? (d.category ? [d.category] : []) : d[f.field];
        for (const v of vals) facets[f.key].set(v, (facets[f.key].get(v) || 0) + 1);
      }
    }

    return {
      site: { name: text(site.name, 80), startDate: start },
      days: days,
      missing: missing,
      byDate: new Map(days.map((d) => [d.date, d])),
      streak: streak,
      facets: facets,
      categoryCount: facets.cat.size,
      first: oldest,
      last: newest,
    };
  }

  async function loadArchive() {
    let raw = null;
    const node = $('#archive');
    try {
      raw = JSON.parse(node ? node.textContent : '');
    } catch (e) {
      raw = null;
    }
    if (!raw || typeof raw !== 'object') {
      try {
        const res = await fetch('archive.json', { cache: 'no-cache' });
        if (res.ok) raw = await res.json();
      } catch (e) {
        raw = null;
      }
    }
    return normalize(raw && typeof raw === 'object' ? raw : {});
  }

  /* ---------- state + hash ---------- */

  const state = { q: '', sort: 'new', kind: '', cat: new Set(), tone: new Set(), tech: new Set(), tag: new Set() };
  let data = null;
  let filtered = [];
  let shown = 0;
  let cursor = -1;
  let lastPick = null;
  let pickTimer = 0;
  let toastTimer = 0;
  let searchTimer = 0;

  function readHash() {
    const p = new URLSearchParams(location.hash.replace(/^#/, ''));
    state.q = (p.get('q') || '').slice(0, 200);
    const sort = p.get('sort');
    state.sort = sort && SORTS[sort] ? sort : 'new';
    const kind = p.get('kind');
    state.kind = kind === 'built' || kind === 'standin' ? kind : '';
    for (const f of FACETS) {
      state[f.key] = new Set((p.get(f.key) || '').split(',').filter((v) => data.facets[f.key].has(v)));
    }
  }

  function writeHash() {
    const p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.sort !== 'new') p.set('sort', state.sort);
    if (state.kind) p.set('kind', state.kind);
    for (const f of FACETS) if (state[f.key].size) p.set(f.key, Array.from(state[f.key]).join(','));
    const hash = p.toString();
    try {
      history.replaceState(null, '', location.pathname + location.search + (hash ? '#' + hash : ''));
    } catch (e) {
      /* file:// or sandboxed: the URL just won't reflect the filters */
    }
  }

  const activeCount = () => FACETS.reduce((n, f) => n + state[f.key].size, 0) + (state.kind ? 1 : 0);
  const anyFilter = () => !!(state.q || activeCount());

  /* ---------- filtering ---------- */

  function matches(d, tokens) {
    if (state.kind === 'built' && d.tier >= 3) return false;
    if (state.kind === 'standin' && d.tier < 3) return false;
    if (state.cat.size && !state.cat.has(d.category)) return false;
    if (state.tone.size && !d.tone.some((t) => state.tone.has(t))) return false;
    if (state.tech.size && !d.tech.some((t) => state.tech.has(t))) return false;
    if (state.tag.size && !d.tags.some((t) => state.tag.has(t))) return false;
    for (const t of tokens) if (d.haystack.indexOf(t) < 0) return false;
    return true;
  }

  function applyFilters() {
    const tokens = state.q.toLowerCase().split(/\s+/).filter(Boolean);
    filtered = data.days.filter((d) => matches(d, tokens)).sort(SORTS[state.sort]);
    cursor = -1;
    renderGrid(true);
    updateChrome();
  }

  /* ---------- cards ---------- */

  function setPalette(node, palette) {
    node.style.setProperty('--p0', palette[0]);
    node.style.setProperty('--p1', palette[1]);
    node.style.setProperty('--p2', palette[2]);
  }

  function catHue(slug) {
    return hashStr(slug || 'none') % 360;
  }

  function thumbBox(d, cls) {
    const box = h('div', { class: cls, 'data-n': pad3(d.n) });
    if (d.thumb) {
      const img = h('img', { src: d.thumb, alt: '', width: 1200, height: 630, decoding: 'async' });
      if (cls === 'card-thumb') img.setAttribute('loading', 'lazy');
      img.addEventListener('error', () => img.remove());
      box.append(img);
    }
    return box;
  }

  function card(d, index) {
    const li = h('li', { class: 'card' + (d.tier >= 3 ? ' is-standin' : ''), 'data-date': d.date });
    setPalette(li, d.palette);
    li.style.setProperty('--i', String(Math.min(index, 11)));
    li.style.setProperty('--cat', 'hsl(' + catHue(d.category) + ' 70% 42%)');

    const thumb = thumbBox(d, 'card-thumb');
    thumb.append(h('span', { class: 'frame mono', text: '№ ' + pad3(d.n) }));
    if (d.tier >= 2) thumb.append(h('span', { class: 'stamp mono tier-' + d.tier, text: TIER_LABELS[d.tier] }));

    const title = d.href
      ? h('a', { class: 'card-link', href: d.href, text: d.title })
      : h('span', { class: 'card-link', tabindex: '0', text: d.title });
    const body = h(
      'div',
      { class: 'card-body' },
      h('p', { class: 'meta mono' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), h('time', { datetime: d.date, text: fmtShort.format(utcDate(d.date)) }), ' · ' + d.categoryLabel),
      h('h3', { class: 'card-title' }, title),
      d.tagline ? h('p', { class: 'card-tagline', text: d.tagline }) : null
    );
    const tags = d.tags.slice(0, 3);
    if (tags.length) {
      const ul = h('ul', { class: 'card-tags' });
      for (const t of tags) {
        ul.append(h('li', null, h('button', { type: 'button', class: 'tag mono', 'data-tag': t, 'aria-label': 'Filter by tag ' + t, text: '#' + t })));
      }
      body.append(ul);
    }
    li.append(thumb, body, h('div', { class: 'swatches', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')));
    return li;
  }

  const grid = $('#grid');
  const loadMore = $('#load-more');

  function renderGrid(reset) {
    if (reset) {
      grid.textContent = '';
      shown = 0;
    }
    const end = Math.min(filtered.length, shown + PAGE_SIZE);
    const frag = doc.createDocumentFragment();
    for (let i = shown; i < end; i++) frag.append(card(filtered[i], i - shown));
    grid.append(frag);
    shown = end;
    const left = filtered.length - shown;
    loadMore.hidden = left <= 0;
    loadMore.textContent = 'Show ' + Math.min(PAGE_SIZE, left) + ' more (' + left + ' left)';
  }

  /* ---------- chrome around the grid ---------- */

  function updateChrome() {
    const total = data.days.length;
    const status = $('#result-count');
    status.textContent = filtered.length === total ? plural(total, 'build') : 'Showing ' + filtered.length + ' of ' + plural(total, 'build');
    $('#empty-results').hidden = filtered.length > 0;
    grid.hidden = filtered.length === 0;
    $('#clear-filters').hidden = !anyFilter();
    const more = FACETS.slice(1).reduce((n, f) => n + state[f.key].size, 0) + (state.kind ? 1 : 0);
    $('#more-filters-label').textContent = more ? 'More filters (' + more + ' on)' : 'More filters';
    for (const chip of doc.querySelectorAll('.chip')) {
      const on = chip.dataset.key === 'kind' ? state.kind === chip.dataset.value : state[chip.dataset.key].has(chip.dataset.value);
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    const q = $('#q');
    if (q.value !== state.q) q.value = state.q;
    $('#sort').value = state.sort;
    if (state.q && !filtered.length) $('#empty-results-text').textContent = 'No build matches “' + state.q + '”. Even we are not that weird. Yet.';
    else $('#empty-results-text').textContent = 'No build matches that combination. Even we are not that weird. Yet.';
    writeHash();
  }

  function chip(key, value, label, count) {
    return h('button', { type: 'button', class: 'chip', 'data-key': key, 'data-value': value, 'aria-pressed': 'false' }, h('span', { text: label }), count != null ? h('span', { class: 'chip-count', text: String(count) }) : null);
  }

  function sortedFacet(key) {
    return Array.from(data.facets[key].entries()).sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]));
  }

  function renderFilters() {
    const cats = $('#chips-cat');
    cats.textContent = '';
    for (const [slug, n] of sortedFacet('cat')) {
      const c = chip('cat', slug, categoryLabel(slug), n);
      c.style.setProperty('--cat', 'hsl(' + catHue(slug) + ' 70% 42%)');
      cats.append(c);
    }

    const body = $('#more-body');
    body.textContent = '';
    const kinds = h('div', { class: 'filter-group', role: 'group', 'aria-labelledby': 'fl-kind' }, h('p', { class: 'filter-label mono', id: 'fl-kind', text: 'Edition' }));
    const kindChips = h('div', { class: 'chips' });
    const standins = data.days.filter((d) => d.tier >= 3).length;
    kindChips.append(chip('kind', 'built', 'Full builds', data.days.length - standins));
    if (standins) kindChips.append(chip('kind', 'standin', 'Stand-ins', standins));
    kinds.append(kindChips);
    body.append(kinds);

    for (const f of FACETS.slice(1)) {
      const entries = sortedFacet(f.key);
      if (!entries.length) continue;
      const labelId = 'fl-' + f.key;
      const group = h('div', { class: 'filter-group', role: 'group', 'aria-labelledby': labelId }, h('p', { class: 'filter-label mono', id: labelId, text: f.title }));
      const box = h('div', { class: 'chips' });
      const limit = f.key === 'tag' ? TOP_TAGS : entries.length;
      entries.forEach(([value, n], i) => {
        const c = chip(f.key, value, value, n);
        if (i >= limit) c.classList.add('is-extra');
        box.append(c);
      });
      group.append(box);
      if (entries.length > limit) {
        const btn = h('button', { type: 'button', class: 'btn-link', 'data-expand': f.key, 'aria-expanded': 'false', text: 'Show all ' + entries.length + ' tags' });
        group.append(btn);
        group.classList.add('is-collapsed');
      }
      body.append(group);
    }
  }

  function expandSelectedExtras() {
    // A tag chosen via a deep link may sit beyond the top-N; reveal the lot so it is visible.
    for (const group of doc.querySelectorAll('.filter-group.is-collapsed')) {
      if (group.querySelector('.chip.is-extra[aria-pressed="true"]')) toggleExpand(group.querySelector('[data-expand]'), true);
    }
  }

  function toggleExpand(btn, force) {
    const group = btn.closest('.filter-group');
    const open = force != null ? force : btn.getAttribute('aria-expanded') !== 'true';
    group.classList.toggle('is-collapsed', !open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.textContent = open ? 'Show fewer' : 'Show all ' + group.querySelectorAll('.chip').length + ' tags';
  }

  function toggleSet(set, value) {
    if (set.has(value)) set.delete(value);
    else set.add(value);
  }

  /* ---------- hero ---------- */

  function relativeLabel(date) {
    const now = new Date();
    const today = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    const diff = dayDiff(date, today);
    if (diff === 0) return 'Today’s build';
    if (diff === 1) return 'Yesterday’s build';
    return 'Latest build';
  }

  function renderLead() {
    const lead = $('#lead');
    lead.textContent = '';
    const d = data.days[0];
    if (!d) {
      renderEmpty(lead);
      return;
    }
    lead.classList.remove('is-empty');
    setPalette(lead, d.palette);
    lead.style.setProperty('--cat', 'hsl(' + catHue(d.category) + ' 70% 42%)');
    lead.classList.toggle('is-standin', d.tier >= 3);

    const art = h('div', { class: 'lead-art' });
    const frame = thumbBox(d, 'lead-thumb');
    const img = $('img', frame);
    if (img) img.setAttribute('fetchpriority', 'high');
    art.append(h('div', { class: 'lead-halftone', 'aria-hidden': 'true' }), frame);
    if (d.tier >= 3) art.append(h('span', { class: 'stamp stamp-lg mono tier-' + d.tier, text: 'Stand-in · ' + TIER_LABELS[d.tier] }));

    const meta = h(
      'p',
      { class: 'kicker mono' },
      relativeLabel(d.date) + ' · Day ' + d.n + ' · ',
      h('time', { datetime: d.date, text: fmtLong.format(utcDate(d.date)) })
    );
    const chips = h('ul', { class: 'lead-chips' }, h('li', { class: 'pill mono' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), d.categoryLabel));
    if (d.tier === 2) chips.append(h('li', { class: 'pill mono', text: TIER_LABELS[2] }));
    if (d.mechanic) chips.append(h('li', { class: 'pill mono', text: d.mechanic }));
    for (const t of d.tone.slice(0, 2)) chips.append(h('li', { class: 'pill mono', text: t }));

    const actions = h('div', { class: 'lead-actions' });
    if (d.href) actions.append(h('a', { class: 'btn btn-primary btn-lg', id: 'lead-open', href: d.href }, 'Open it ', h('span', { 'aria-hidden': 'true', text: '→' })));
    actions.append(h('button', { type: 'button', class: 'btn btn-lg', id: 'surprise' }, 'Surprise me ', h('kbd', { 'aria-hidden': 'true', text: 'r' })));

    const copy = h(
      'div',
      { class: 'lead-copy' },
      meta,
      h('p', { class: 'day-numeral', 'aria-hidden': 'true', text: String(d.n) }),
      h('h2', { class: 'lead-title', id: 'lead-title', text: d.title }),
      d.tagline ? h('p', { class: 'lead-tagline', text: d.tagline }) : null,
      d.description ? h('p', { class: 'lead-desc', text: d.description }) : null,
      d.tier >= 3 ? h('p', { class: 'lead-note', text: TIER_NOTES[d.tier] }) : null,
      chips,
      actions
    );
    lead.append(art, copy);
    // The visible h2 doubles as the section's accessible name.
    lead.setAttribute('aria-labelledby', 'lead-title');
  }

  function renderEmpty(lead) {
    lead.classList.add('is-empty');
    lead.setAttribute('aria-labelledby', 'lead-title');
    const start = data.site.startDate;
    let when = 'The first one lands at 4am Eastern.';
    if (validDate(start)) {
      const now = new Date();
      const today = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
      const wait = dayDiff(today, start);
      if (wait > 0) when = 'Doors open ' + fmtLong.format(utcDate(start)) + ' at 4am Eastern (' + plural(wait, 'day') + ' to go).';
    }
    lead.append(
      h('div', { class: 'empty-art', 'aria-hidden': 'true' }, h('span', { class: 'empty-zero', text: '0' }), h('span', { class: 'empty-caret' })),
      h(
        'div',
        { class: 'lead-copy' },
        h('p', { class: 'kicker mono', text: 'Day 0 · The oven is warm' }),
        h('h2', { class: 'lead-title', id: 'lead-title', text: 'Nothing is in the gallery. Yet.' }),
        h('p', { class: 'lead-tagline', text: 'Every morning a small team of Sonnets builds one new thing that fits on a web page. It has not happened yet, so please admire this empty frame.' }),
        h('p', { class: 'lead-desc', text: when + ' Come back after breakfast; there will be something to poke.' })
      )
    );
  }

  /* ---------- stats ---------- */

  function renderStats() {
    const box = $('#stats');
    box.textContent = '';
    const cell = (value, label, sub) =>
      h('div', { class: 'stat' }, h('p', { class: 'stat-value', text: String(value) }), h('p', { class: 'stat-label mono', text: label }), sub ? h('p', { class: 'stat-sub', text: sub }) : null);
    box.append(
      cell(data.days.length, 'Builds', data.days.length ? 'one per morning' : 'soon'),
      cell(data.streak, data.streak === 1 ? 'Day running' : 'Days running', 'current streak'),
      cell(data.categoryCount, data.categoryCount === 1 ? 'Category' : 'Categories', 'and counting'),
      cell(data.first ? fmtShort.format(utcDate(data.first)) : '—', 'Since', data.missing.size ? plural(data.missing.size, 'missed day') : 'no missed days')
    );
    box.hidden = !data.days.length;
  }

  /* ---------- the run (calendar ribbon) ---------- */

  function renderRun() {
    const section = $('#run');
    const track = $('#run-track');
    track.textContent = '';
    if (!data.days.length) {
      section.hidden = true;
      return;
    }
    let end = data.last;
    for (const m of data.missing) if (m > end) end = m;
    const frag = doc.createDocumentFragment();
    let monthKey = '';
    let cells = null;
    let firstFocusable = null;
    for (let date = data.first; date <= end; date = addDays(date, 1)) {
      const key = date.slice(0, 7);
      if (key !== monthKey) {
        monthKey = key;
        cells = h('ul', { class: 'run-cells' });
        const label = date === data.first || date.slice(5, 7) === '01' ? fmtMonthYear.format(utcDate(date)) : fmtMonth.format(utcDate(date));
        frag.append(h('div', { class: 'run-month' }, h('p', { class: 'run-month-label mono', 'aria-hidden': 'true', text: label }), cells));
      }
      const d = data.byDate.get(date);
      const li = h('li', { class: 'run-item' });
      if (d) {
        const a = h('a', {
          class: 'run-cell' + (d.tier >= 3 ? ' is-standin' : ''),
          href: d.href || null,
          tabindex: '-1',
          'data-date': date,
          'aria-label': 'Day ' + d.n + ', ' + fmtMid.format(utcDate(date)) + ': ' + d.title + (d.tier >= 3 ? ' (' + TIER_LABELS[d.tier] + ')' : ''),
        });
        if (!d.href) a.removeAttribute('href');
        a.style.setProperty('--p1', d.palette[1]);
        a.style.setProperty('--p2', d.palette[2]);
        li.append(a);
        firstFocusable = a;
      } else {
        li.append(h('span', { class: 'run-cell is-missing', 'data-date': date, 'data-missing': '' }, h('span', { class: 'sr-only', text: fmtMid.format(utcDate(date)) + ': no build' })));
      }
      cells.append(li);
    }
    track.append(frag);
    if (firstFocusable) firstFocusable.setAttribute('tabindex', '0'); // roving tabindex: one tab stop for the whole run
    section.hidden = false;
    const scroller = $('#run-scroll');
    scroller.scrollLeft = scroller.scrollWidth;
  }

  function runCaption(cell) {
    const caption = $('#run-caption');
    const date = cell.dataset.date;
    const d = data.byDate.get(date);
    caption.textContent = d
      ? 'Day ' + d.n + ' · ' + fmtMid.format(utcDate(date)) + ' · ' + d.title + (d.tier >= 3 ? ' (' + TIER_LABELS[d.tier] + ', a stand-in)' : '')
      : fmtMid.format(utcDate(date)) + ' · no build that day. It happens to the best of us.';
  }

  function wireRun() {
    const track = $('#run-track');
    track.addEventListener('pointerover', (e) => {
      const cell = e.target.closest && e.target.closest('.run-cell');
      if (cell) runCaption(cell);
    });
    track.addEventListener('focusin', (e) => {
      const cell = e.target.closest && e.target.closest('.run-cell');
      if (!cell) return;
      for (const a of track.querySelectorAll('a.run-cell[tabindex="0"]')) a.setAttribute('tabindex', '-1');
      cell.setAttribute('tabindex', '0');
      runCaption(cell);
    });
    track.addEventListener('keydown', (e) => {
      const keys = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity };
      if (!(e.key in keys) || e.ctrlKey || e.metaKey || e.altKey) return;
      const links = Array.from(track.querySelectorAll('a.run-cell'));
      const at = links.indexOf(doc.activeElement);
      if (at < 0) return;
      e.preventDefault();
      const step = keys[e.key];
      const next = Math.max(0, Math.min(links.length - 1, step === Infinity ? links.length - 1 : step === -Infinity ? 0 : at + step));
      links[next].focus();
    });
  }

  /* ---------- surprise me ---------- */

  const pickDialog = $('#pick');
  const helpDialog = $('#help');

  function openDialog(dlg) {
    if (dlg.open) return;
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  }

  function closeDialog(dlg) {
    if (!dlg.open) return;
    if (typeof dlg.close === 'function') dlg.close();
    else dlg.removeAttribute('open');
  }

  function toast(message) {
    const t = $('#toast');
    t.textContent = message;
    t.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('is-on'), 3200);
  }

  function showPick(d, poolSize, scoped) {
    const body = $('#pick-body');
    body.textContent = '';
    setPalette(pickDialog, d.palette);
    const thumb = thumbBox(d, 'pick-thumb');
    body.append(
      thumb,
      h('p', { class: 'pick-meta mono' }, 'Day ' + d.n + ' · ' + fmtMid.format(utcDate(d.date)) + ' · ' + d.categoryLabel),
      d.tagline ? h('p', { class: 'pick-tagline', text: d.tagline }) : null,
      h('p', { class: 'pick-note mono', text: 'Picked from ' + (scoped ? 'the ' + plural(poolSize, 'build') + ' matching your filters' : 'all ' + plural(poolSize, 'build')) + '.' })
    );
    $('#pick-title').textContent = d.title;
    $('#pick-kicker').textContent = 'Your random pick';
    const open = $('#pick-open');
    if (d.href) {
      open.setAttribute('href', d.href);
      open.hidden = false;
    } else {
      open.hidden = true;
    }
    lastPick = d;
  }

  function surprise() {
    const scoped = filtered.length > 0 && filtered.length < data.days.length;
    const pool = filtered.length ? filtered : data.days;
    if (!pool.length) {
      toast('Nothing to pick yet. Day 1 is still in the oven.');
      return;
    }
    let d = pool[Math.floor(Math.random() * pool.length)];
    for (let tries = 0; pool.length > 1 && d === lastPick && tries < 12; tries++) d = pool[Math.floor(Math.random() * pool.length)];

    clearTimeout(pickTimer);
    openDialog(pickDialog);
    if (reduceMotion() || pool.length < 3) {
      showPick(d, pool.length, scoped);
      focusPick();
      return;
    }
    // A short slot-machine reel of titles, then the real pick.
    $('#pick-body').textContent = '';
    $('#pick-kicker').textContent = 'Rolling...';
    $('#pick-open').hidden = true;
    let step = 0;
    const tick = () => {
      if (!pickDialog.open) return;
      if (step++ < 9) {
        $('#pick-title').textContent = pool[Math.floor(Math.random() * pool.length)].title;
        pickTimer = setTimeout(tick, 55 + step * 12);
      } else {
        showPick(d, pool.length, scoped);
        focusPick();
      }
    };
    tick();
  }

  function focusPick() {
    const open = $('#pick-open');
    (open.hidden ? $('#pick-again') : open).focus();
  }

  /* ---------- keyboard ---------- */

  function cardEls() {
    return Array.from(grid.querySelectorAll('.card'));
  }

  function moveCursor(delta) {
    let els = cardEls();
    if (!els.length) return;
    let at = els.findIndex((li) => li.contains(doc.activeElement));
    if (at < 0) at = cursor;
    let next = at < 0 ? 0 : at + delta;
    if (next >= els.length && shown < filtered.length) {
      renderGrid(false);
      els = cardEls();
    }
    next = Math.max(0, Math.min(els.length - 1, next));
    cursor = next;
    const target = els[next].querySelector('.card-link');
    target.focus({ preventScroll: true });
    els[next].scrollIntoView({ block: 'nearest', behavior: reduceMotion() ? 'auto' : 'smooth' });
  }

  function openCurrent() {
    const active = doc.activeElement && doc.activeElement.closest && doc.activeElement.closest('.card, .run-cell');
    let link = active && (active.matches('a') ? active : active.querySelector('a.card-link'));
    if (!link && cursor >= 0) {
      const li = cardEls()[cursor];
      link = li && li.querySelector('a.card-link');
    }
    if (!link) link = $('#lead-open');
    if (link) link.click();
  }

  function onKey(e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if (typing) {
      if (e.key === 'Escape' && t.id === 'q') {
        clearTimeout(searchTimer);
        if (t.value) {
          t.value = '';
          state.q = '';
          applyFilters();
        } else {
          t.blur();
        }
      }
      return;
    }
    if (pickDialog.open && (e.key === 'r' || e.key === 'R')) {
      e.preventDefault();
      surprise();
      return;
    }
    if (pickDialog.open || helpDialog.open) return;
    switch (e.key) {
      case '/':
        e.preventDefault();
        if (!$('#builds').hidden) $('#q').focus();
        break;
      case 'j':
        moveCursor(1);
        break;
      case 'k':
        moveCursor(-1);
        break;
      case 'o':
        openCurrent();
        break;
      case 'r':
      case 'R':
        surprise();
        break;
      case 't':
        toggleTheme();
        break;
      case '?':
        e.preventDefault();
        openDialog(helpDialog);
        break;
      default:
    }
  }

  /* ---------- theme ---------- */

  const dark = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
  const effectiveTheme = () => root.getAttribute('data-theme') || (dark && dark.matches ? 'dark' : 'light');

  function paintThemeButton() {
    const btn = $('#theme-toggle');
    const isDark = effectiveTheme() === 'dark';
    btn.setAttribute('aria-pressed', isDark ? 'true' : 'false');
  }

  function toggleTheme() {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    store('set', 'sed-theme', next);
    paintThemeButton();
  }

  /* ---------- wiring ---------- */

  function wire() {
    $('#filters').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.dataset.expand) {
        toggleExpand(btn);
        return;
      }
      if (btn.id === 'clear-filters') {
        clearAll();
        return;
      }
      if (!btn.classList.contains('chip')) return;
      const { key, value } = btn.dataset;
      if (key === 'kind') state.kind = state.kind === value ? '' : value;
      else toggleSet(state[key], value);
      applyFilters();
    });

    grid.addEventListener('click', (e) => {
      const tag = e.target.closest('button[data-tag]');
      if (!tag) return;
      toggleSet(state.tag, tag.dataset.tag);
      applyFilters();
      expandSelectedExtras();
    });
    grid.addEventListener('focusin', (e) => {
      const li = e.target.closest('.card');
      if (li) cursor = cardEls().indexOf(li);
    });

    $('#q').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      const value = e.target.value.slice(0, 200);
      searchTimer = setTimeout(() => {
        state.q = value;
        applyFilters();
      }, 110);
    });
    $('#sort').addEventListener('change', (e) => {
      state.sort = SORTS[e.target.value] ? e.target.value : 'new';
      applyFilters();
    });
    $('#empty-clear').addEventListener('click', clearAll);
    loadMore.addEventListener('click', () => renderGrid(false));
    if ('IntersectionObserver' in window) {
      new IntersectionObserver((entries) => {
        if (entries.some((en) => en.isIntersecting) && !loadMore.hidden) renderGrid(false);
      }, { rootMargin: '400px 0px' }).observe(loadMore);
    }

    doc.addEventListener('click', (e) => {
      const target = e.target.closest && e.target.closest('#surprise, #surprise-inline, #pick-again');
      if (target) surprise();
    });
    $('#pick-close').addEventListener('click', () => closeDialog(pickDialog));
    $('#help-close').addEventListener('click', () => closeDialog(helpDialog));
    $('#help-open').addEventListener('click', () => openDialog(helpDialog));
    for (const dlg of [pickDialog, helpDialog]) {
      dlg.addEventListener('click', (e) => {
        if (e.target === dlg) closeDialog(dlg);
      });
    }

    $('#theme-toggle').addEventListener('click', toggleTheme);
    if (dark) dark.addEventListener('change', paintThemeButton);
    doc.addEventListener('keydown', onKey);
    window.addEventListener('hashchange', () => {
      readHash();
      applyFilters();
      expandSelectedExtras();
    });
    wireRun();
  }

  function clearAll() {
    clearTimeout(searchTimer);
    state.q = '';
    state.kind = '';
    for (const f of FACETS) state[f.key].clear();
    applyFilters();
  }

  function dateline() {
    const d = data.days[0];
    const el = $('#dateline');
    if (!d) {
      el.textContent = 'Vol. I · No. 0 · Opening soon';
      return;
    }
    el.textContent = 'Vol. I · No. ' + d.n + ' · ' + fmtMid.format(utcDate(d.date)) + ' ' + d.date.slice(0, 4);
  }

  function localGenerated() {
    const t = $('#generated');
    const when = new Date(t.getAttribute('datetime'));
    if (Number.isNaN(when.getTime())) return;
    t.textContent = when.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  async function init() {
    paintThemeButton();
    data = await loadArchive();
    dateline();
    localGenerated();
    renderLead();
    renderStats();
    renderRun();
    renderFilters();
    const hasDays = data.days.length > 0;
    $('#builds').hidden = !hasDays;
    $('.sections').hidden = !hasDays;
    wire();
    if (hasDays) {
      readHash();
      applyFilters();
      expandSelectedExtras();
    }
    root.classList.add('ready');
  }

  init().catch((err) => {
    root.classList.add('ready');
    console.warn('gallery failed to start', err);
    const lead = $('#lead');
    lead.textContent = '';
    lead.append(h('p', { class: 'lead-note', text: 'The gallery hit a snag while starting up. The feed and archive.json still work.' }));
  });
})();
