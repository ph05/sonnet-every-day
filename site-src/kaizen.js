/* The swarm's diary: progressive enhancement for the server-rendered log.
 * Everything is already in the HTML; this only adds the theme toggle and the member / category / status filters.
 * No network, no innerHTML: it reads data-* attributes and toggles `hidden`. */
(function () {
  'use strict';

  const doc = document;
  const root = doc.documentElement;
  const KEYS = ['agent', 'category', 'status'];
  const $ = (sel, scope) => (scope || doc).querySelector(sel);
  const $$ = (sel, scope) => Array.from((scope || doc).querySelectorAll(sel));

  function store(op, key, value) {
    try {
      return op === 'get' ? localStorage.getItem(key) : localStorage.setItem(key, value);
    } catch (e) {
      return null; // blocked storage: everything works, nothing persists
    }
  }

  /* ---------- theme (same key and behaviour as the gallery) ---------- */

  const dark = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
  const themeButton = $('#theme-toggle');
  const effectiveTheme = () => root.getAttribute('data-theme') || (dark && dark.matches ? 'dark' : 'light');
  const paintTheme = () => themeButton && themeButton.setAttribute('aria-pressed', effectiveTheme() === 'dark' ? 'true' : 'false');
  if (themeButton) {
    themeButton.addEventListener('click', () => {
      const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      store('set', 'sed-theme', next);
      paintTheme();
    });
    if (dark && dark.addEventListener) dark.addEventListener('change', paintTheme);
    paintTheme();
  }

  const stamp = $('#generated');
  if (stamp) {
    const when = new Date(stamp.getAttribute('datetime'));
    if (!Number.isNaN(when.getTime())) stamp.textContent = when.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  /* ---------- filters ---------- */

  root.classList.add('ready');
  const filters = $('#filters');
  if (!filters) return;
  const entries = $$('li.entry');
  const days = $$('li.day');
  const chips = $$('.chip', filters);
  const clear = $('#clear-filters');
  const count = $('#result-count');
  const noMatch = $('#no-match');
  const total = $$('#log li.entry').length;
  const state = { agent: '', category: '', status: '' };

  // Only values that exist on the page are accepted from the URL, so a hand-edited hash cannot do anything odd.
  const known = {};
  for (const key of KEYS) known[key] = new Set(chips.filter((c) => c.dataset.key === key).map((c) => c.dataset.value));

  function readHash() {
    const raw = location.hash.replace(/^#/, '');
    if (raw.indexOf('=') === -1) return; // an entry anchor such as #e-2026-10-10-pulse
    const p = new URLSearchParams(raw);
    for (const key of KEYS) {
      const v = p.get(key) || '';
      state[key] = known[key].has(v) ? v : '';
    }
  }

  function writeHash() {
    const p = new URLSearchParams();
    for (const key of KEYS) if (state[key]) p.set(key, state[key]);
    const hash = p.toString();
    try {
      history.replaceState(null, '', location.pathname + location.search + (hash ? '#' + hash : ''));
    } catch (e) {
      /* sandboxed or file://: the URL just will not mirror the filters */
    }
  }

  const visible = (el) => KEYS.every((key) => !state[key] || !el.dataset[key] || el.dataset[key] === state[key]);

  function apply() {
    let shown = 0;
    for (const el of entries) {
      const show = visible(el);
      el.hidden = !show;
      if (show && el.closest('#log')) shown++;
    }
    const note = $('#proposals-filtered');
    if (note) note.hidden = !$('#proposals li.proposal') || !!$('#proposals li.proposal:not([hidden])');
    for (const day of days) day.hidden = !$('li.entry:not([hidden])', day);
    for (const chip of chips) chip.setAttribute('aria-pressed', String(state[chip.dataset.key] === chip.dataset.value));
    const active = KEYS.some((k) => state[k]);
    clear.hidden = !active;
    if (noMatch) noMatch.hidden = shown !== 0;
    const log = $('#log');
    if (log) log.hidden = shown === 0;
    count.textContent = active ? 'Showing ' + shown + ' of ' + total + (total === 1 ? ' entry' : ' entries') : total + (total === 1 ? ' entry' : ' entries');
  }

  function reset() {
    for (const key of KEYS) state[key] = '';
    writeHash();
    apply();
  }

  filters.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) {
      state[chip.dataset.key] = chip.dataset.value;
      writeHash();
      apply();
    } else if (e.target.closest('#clear-filters')) {
      reset();
    }
  });
  const emptyClear = $('#no-match-clear');
  if (emptyClear) emptyClear.addEventListener('click', reset);
  window.addEventListener('hashchange', () => {
    for (const key of KEYS) state[key] = '';
    readHash();
    apply();
  });

  readHash();
  apply();
})();
