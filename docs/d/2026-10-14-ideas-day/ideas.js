/* Ideas Day page: renders the sanitized shortlist embedded in the page.
 * The data came from LLM-written files, so it is treated as untrusted: strings only ever reach the DOM
 * through textContent, and the only links are plain https URLs. */
(function () {
  'use strict';

  var dataEl = document.getElementById('ideas-data');
  var listEl = document.getElementById('ideas');
  if (!dataEl || !listEl) return;
  var data;
  try {
    data = JSON.parse(dataEl.textContent);
  } catch (e) {
    return;
  }
  var ideas = Array.isArray(data.ideas) ? data.ideas : [];
  var dims = Array.isArray(data.dimensions) ? data.dimensions : [];
  if (!ideas.length) return;

  var LABELS = {
    sophistication: 'Sophistication', delight: 'Delight', distinctness: 'Distinctness', feasibility: 'Feasibility',
    timeliness: 'Timeliness', interestFit: 'Interest fit', polishPotential: 'Polish potential', safety: 'Safety', clarity: 'Clarity',
  };
  var SHORT = {
    sophistication: 'SOPH', delight: 'DLGT', distinctness: 'DIST', feasibility: 'FEAS',
    timeliness: 'TIME', interestFit: 'FIT', polishPotential: 'POL', safety: 'SAFE', clarity: 'CLAR',
  };
  var label = function (d) { return LABELS[d] || d; };
  var short = function (d) { return SHORT[d] || d.slice(0, 4).toUpperCase(); };

  // ---- tiny DOM helpers (no innerHTML anywhere) ----
  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v === false || v === null || v === undefined) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else el.setAttribute(k, v === true ? '' : String(v));
      });
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) child.forEach(function (c) { append(el, c); });
    else el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function s(tag, attrs, text) {
    var el = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, String(attrs[k])); });
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function safeUrl(u) {
    try {
      var x = new URL(String(u));
      return x.protocol === 'https:' && !x.username && !x.password ? x : null;
    } catch (e) {
      return null;
    }
  }
  var num = function (n) { return String(Math.round(n * 10) / 10); };
  function hueOf(str) {
    var hsh = 0;
    for (var i = 0; i < str.length; i++) hsh = (hsh * 31 + str.charCodeAt(i)) >>> 0;
    return hsh % 360;
  }
  function slotLabel(v) { return { interest: 'Interest', currentEvents: 'Current events', humor: 'Humor', wildcard: 'Wildcard' }[v] || v; }

  // ---- derived data ----
  var order = ideas.map(function (_, i) { return i; });
  // An unscored shortlist (the day degraded before the judges ran) has no ranking and no pick: nothing is invented.
  var isRanked = data.ranked === true;
  var ranked = order.slice().sort(function (a, b) { return (ideas[b].total || 0) - (ideas[a].total || 0) || a - b; });
  ideas.forEach(function (idea, i) { idea._order = i; idea._rank = ranked.indexOf(i) + 1; });
  var pick = null;
  ideas.forEach(function (idea) { if (idea.id === data.chosenId) pick = idea; });
  var defaults = isRanked ? { sort: 'total', dir: 'desc' } : { sort: 'order', dir: 'asc' };
  var max = data.max || 100; // select's total runs 0 to 100

  // ---- charts ----
  function radar(idea, size) {
    var c = size / 2;
    var R = size * 0.33;
    var svg = s('svg', { viewBox: '0 0 ' + size + ' ' + size, class: 'radar', role: 'img', 'aria-label': 'Radar chart of the scores for ' + idea.title });
    svg.appendChild(s('title', {}, dims.map(function (d) { return label(d) + ' ' + num(idea.scores[d] || 0); }).join(', ')));
    var pt = function (k, r) {
      var a = -Math.PI / 2 + (k / dims.length) * Math.PI * 2;
      return [c + Math.cos(a) * r, c + Math.sin(a) * r, Math.cos(a), Math.sin(a)];
    };
    [0.25, 0.5, 0.75, 1].forEach(function (f) {
      svg.appendChild(s('polygon', { class: 'ring', points: dims.map(function (_, k) { var p = pt(k, R * f); return p[0] + ',' + p[1]; }).join(' ') }));
    });
    dims.forEach(function (d, k) {
      var p = pt(k, R);
      svg.appendChild(s('line', { class: 'axis', x1: c, y1: c, x2: p[0], y2: p[1] }));
      var q = pt(k, R * 1.16);
      var anchor = q[2] > 0.3 ? 'start' : q[2] < -0.3 ? 'end' : 'middle';
      svg.appendChild(s('text', { x: q[0], y: q[1] + (q[3] > 0.5 ? 10 : q[3] < -0.5 ? -2 : 4), 'text-anchor': anchor }, short(d)));
    });
    svg.appendChild(s('polygon', { class: 'area', points: dims.map(function (d, k) { var p = pt(k, R * Math.max(0, Math.min(10, idea.scores[d] || 0)) / 10); return p[0] + ',' + p[1]; }).join(' ') }));
    dims.forEach(function (d, k) {
      var p = pt(k, R * Math.max(0, Math.min(10, idea.scores[d] || 0)) / 10);
      svg.appendChild(s('circle', { class: 'dot', cx: p[0], cy: p[1], r: 3.5 }));
    });
    return svg;
  }

  function bars(idea) {
    var ul = h('ul', { class: 'bars', 'aria-label': 'Scores out of 10' });
    dims.forEach(function (d) {
      var v = Math.max(0, Math.min(10, idea.scores[d] || 0));
      var fill = h('span', { class: 'fill' });
      fill.style.width = v * 10 + '%';
      ul.appendChild(h('li', null, h('span', { text: label(d) }), h('span', { class: 'track', 'aria-hidden': 'true' }, fill), h('span', { class: 'val', text: num(v) })));
    });
    return ul;
  }

  // ---- dossier ----
  function sourceItem(src) {
    var u = safeUrl(src.url);
    var li = h('li');
    if (u) li.appendChild(h('a', { href: u.href, rel: 'noopener noreferrer nofollow', target: '_blank', text: src.title || u.hostname }));
    else li.appendChild(h('span', { text: src.title || 'Untitled source' }));
    append(li, ' ');
    li.appendChild(h('span', { class: 'chip ' + (src.verified ? 'ok' : 'warn'), text: src.verified ? 'verified' : 'unverified' }));
    if (u) li.appendChild(h('span', { class: 'src-url', text: u.hostname + (u.pathname.length > 1 ? u.pathname : '') }));
    if (src.note) li.appendChild(h('p', { class: 'note', text: src.note }));
    return li;
  }

  function dossier(idea, id) {
    var r = idea.research || {};
    var d = idea.design || {};
    var sources = r.sources || [];
    var left = h('div');
    if (idea.pitch) left.appendChild(h('p', { class: 'lead', text: idea.pitch }));
    if (idea.whyNow) left.appendChild(h('p', null, h('strong', { text: 'Why now: ' }), idea.whyNow));
    if (r.summary) left.appendChild(h('div', { class: 'block' }, h('h4', { text: 'Research summary' }), h('p', { text: r.summary })));
    var right = idea.scored
      ? h('div', null, h('h4', { text: 'Scores' }), h('div', { class: 'radar-wrap' }, radar(idea, 300)), bars(idea))
      : h('div', null, h('h4', { text: 'Scores' }), h('p', { class: 'muted', text: 'Not scored: the judges had not seen this idea when the day ended.' }));
    var wrap = h('div', { class: 'dossier', id: id, role: 'region', 'aria-label': 'Dossier: ' + idea.title }, left, right);

    if (r.facts && r.facts.length) {
      var facts = h('ul', { class: 'facts' });
      r.facts.forEach(function (f) {
        var src = f.source !== null && f.source !== undefined ? sources[f.source] : null;
        var ok = !!(src && src.verified);
        var li = h('li', { class: ok ? '' : 'unverified' }, f.claim, ' ');
        li.appendChild(h('span', { class: 'chip ' + (ok ? 'ok' : 'warn'), text: ok ? 'sourced' : 'unverified' }));
        var bits = [];
        if (src) bits.push('source: ' + (src.title || 'untitled'));
        if (f.asOf) bits.push('as of ' + f.asOf);
        if (bits.length) li.appendChild(h('span', { class: 'src-url', text: bits.join(', ') }));
        facts.appendChild(li);
      });
      wrap.appendChild(h('div', { class: 'wide' }, h('h4', { text: 'Claims the research made' }), facts));
    }
    if (sources.length) {
      var ul = h('ul', { class: 'sources' });
      sources.forEach(function (src) { ul.appendChild(sourceItem(src)); });
      wrap.appendChild(h('div', { class: 'wide' }, h('h4', { text: 'Sources (' + sources.length + ')' }), ul));
    }
    var kv = h('dl', { class: 'kv' });
    var row = function (k, v) { if (v) kv.appendChild(h('div', null, h('dt', { text: k }), h('dd', null, v))); };
    row('Core loop', d.coreLoop);
    row('Scope for one day', d.scopeForOneDay);
    row('Data needs', d.dataNeeds);
    if (d.sophisticationHooks && d.sophisticationHooks.length) row('Sophistication hooks', h('ul', null, d.sophisticationHooks.map(function (x) { return h('li', { text: x }); })));
    if (d.risks && d.risks.length) row('Risks', h('ul', null, d.risks.map(function (x) { return h('li', { text: x }); })));
    if (r.inspirations && r.inspirations.length) row('Inspirations', r.inspirations.join('; '));
    if (idea.novelty) row('Novelty check', idea.novelty.ok ? 'Clear of recent builds.' : 'Flagged: ' + (idea.novelty.conflicts.join('; ') || 'overlaps recent work') + '.');
    if (idea.origin) row('Proposed by', idea.origin);
    if (kv.childNodes.length) wrap.appendChild(h('div', { class: 'wide' }, h('h4', { text: 'Design notes' }), kv));
    return wrap;
  }

  // ---- cards ----
  var cards = [];
  function buildCard(idea) {
    var pid = 'dossier-' + idea.id;
    var meta = h('span', { class: 't-meta' });
    if (pick && idea.id === pick.id) meta.appendChild(h('span', { class: 'chip gold', text: data.pickKind === 'chosen' ? 'The pick' : 'Top score' }));
    if (idea.carry) meta.appendChild(h('span', { class: 'chip gold', text: 'Saved for another day' }));
    if (idea.category) {
      var cat = h('span', { class: 'chip cat', text: idea.category });
      cat.style.setProperty('--ch', String(hueOf(idea.category)));
      meta.appendChild(cat);
    }
    if (idea.mechanic) meta.appendChild(h('span', { class: 'chip', text: idea.mechanic }));
    if (idea.slot) meta.appendChild(h('span', { class: 'chip', text: slotLabel(idea.slot) }));
    var total = isRanked ? h('span', { class: 'total' }, idea.scored ? num(idea.total) : 'n/a', h('small', { text: idea.scored ? 'of ' + max : 'unscored' })) : null;
    var btn = h('button', { type: 'button', class: 'toggle', 'aria-expanded': 'false', 'aria-controls': pid },
      h('span', { class: 'rank', 'aria-hidden': 'true', text: isRanked ? '#' + idea._rank : String(idea._order + 1) }),
      h('span', { class: 't-main' }, h('span', { class: 't-title', text: idea.title }), meta, h('span', { class: 't-pitch', text: idea.pitch })),
      h('span', null, total, h('span', { class: 'chev', 'aria-hidden': 'true' })));
    var panel = dossier(idea, pid);
    panel.hidden = true;
    var li = h('li', { class: 'idea' + (pick && idea.id === pick.id ? ' is-pick' : ''), id: 'idea-' + idea.id });
    li.appendChild(h('h3', { class: 'idea-head' }, btn));
    li.appendChild(panel);
    btn.addEventListener('click', function () { setOpen(card, btn.getAttribute('aria-expanded') !== 'true', true); });
    var card = { idea: idea, li: li, btn: btn, panel: panel, search: [idea.title, idea.pitch, idea.category, idea.mechanic, idea.slot, (idea.tags || []).join(' '), idea.origin || ''].join(' ').toLowerCase() };
    return card;
  }

  function setOpen(card, open, updateHash) {
    card.btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    card.panel.hidden = !open;
    if (open && updateHash) {
      try { history.replaceState(null, '', '#idea-' + card.idea.id); } catch (e) { /* file: or sandboxed */ }
    }
    syncToggleAll();
  }

  // ---- pick hero ----
  function renderPick() {
    var box = document.getElementById('pick');
    if (!box) return;
    if (!pick) {
      box.className = 'pick unranked';
      box.appendChild(h('div', null,
        h('span', { class: 'pick-label', text: 'Not ranked yet' }),
        h('h2', { id: 'pick-h', text: 'No pick was made' }),
        h('p', { class: 'pitch', text: 'The team had researched these ' + ideas.length + ' ideas but had not scored them when the day ended, so no idea is singled out. They are listed in the order they were delivered, each with its sources and notes.' })));
      box.hidden = false;
      return;
    }
    var left = h('div', null,
      h('span', { class: 'pick-label', text: data.pickKind === 'chosen' ? 'The pick: what should have been built' : 'Highest score on the shortlist' }),
      h('h2', { id: 'pick-h', text: pick.title }),
      pick.pitch ? h('p', { class: 'pitch', text: pick.pitch }) : null,
      data.pickKind === 'chosen' && data.rationale ? h('p', { class: 'why' }, h('strong', { text: 'Why it won: ' }), data.rationale) : null,
      !pick.scored || !isRanked ? null : h('p', { class: 'why', text: 'Team score ' + num(pick.total) + ' of ' + max + (pick._rank === 1 ? ', the highest on the list.' : ', ranked #' + pick._rank + ' by score.') }));
    var open = h('button', { type: 'button', class: 'solid', text: 'Open the dossier' });
    open.addEventListener('click', function () { openCard(pick.id); });
    left.appendChild(h('div', { class: 'pick-actions' }, open));
    box.appendChild(left);
    if (pick.scored) box.appendChild(h('div', { class: 'radar-wrap' }, radar(pick, 340)));
    box.hidden = false;
  }

  function openCard(id) {
    var card = cards.filter(function (c) { return c.idea.id === id; })[0];
    if (!card) return;
    if (card.li.hidden) resetFilters();
    setOpen(card, true, true);
    card.li.scrollIntoView({ block: 'start' });
    card.btn.focus({ preventScroll: true });
  }

  // ---- toolbar ----
  var $ = function (id) { return document.getElementById(id); };
  var state = { q: '', cat: '', slot: '', sort: defaults.sort, dir: defaults.dir };
  var toolbar = $('toolbar');
  var qEl = $('q');
  var catEl = $('cat');
  var slotEl = $('slot');
  var sortEl = $('sort');
  var dirEl = $('dir');
  var countEl = $('count');
  var emptyEl = $('empty');
  var allEl = $('toggle-all');

  function fillSelect(el, values, fmt) {
    values.forEach(function (v) { el.appendChild(h('option', { value: v, text: fmt ? fmt(v) : v })); });
  }
  function uniq(key) {
    var seen = {};
    ideas.forEach(function (i) { if (i[key]) seen[i[key]] = true; });
    return Object.keys(seen).sort();
  }

  var SORTS = (isRanked ? [['total', 'Team score']] : []).concat([['order', 'Shortlist order'], ['title', 'Title (A to Z)']]);
  function sortValue(idea) {
    if (state.sort === 'total') return idea.total || 0;
    if (state.sort === 'order') return idea._order;
    if (state.sort === 'title') return idea.title.toLowerCase();
    return idea.scores[state.sort] || 0;
  }
  function defaultDir(sort) { return sort === 'title' || sort === 'order' ? 'asc' : 'desc'; }

  function apply() {
    var q = state.q.trim().toLowerCase();
    var shown = cards.filter(function (c) {
      return (!q || c.search.indexOf(q) !== -1) && (!state.cat || c.idea.category === state.cat) && (!state.slot || c.idea.slot === state.slot);
    });
    var sign = state.dir === 'asc' ? 1 : -1;
    shown.sort(function (a, b) {
      var x = sortValue(a.idea);
      var y = sortValue(b.idea);
      return (x < y ? -1 : x > y ? 1 : 0) * sign || a.idea._order - b.idea._order;
    });
    cards.forEach(function (c) { c.li.hidden = shown.indexOf(c) === -1; });
    shown.forEach(function (c) { listEl.appendChild(c.li); });
    countEl.textContent = 'Showing ' + shown.length + ' of ' + cards.length + ' ideas';
    emptyEl.hidden = shown.length > 0;
    dirEl.textContent = state.dir === 'desc' ? 'High to low' : 'Low to high';
    if (state.sort === 'title') dirEl.textContent = state.dir === 'asc' ? 'A to Z' : 'Z to A';
    if (state.sort === 'order') dirEl.textContent = state.dir === 'asc' ? 'First to last' : 'Last to first';
    dirEl.setAttribute('aria-label', 'Sort direction: ' + dirEl.textContent.toLowerCase());
    syncToggleAll();
  }

  function resetFilters() {
    state = { q: '', cat: '', slot: '', sort: defaults.sort, dir: defaults.dir };
    qEl.value = '';
    catEl.value = '';
    slotEl.value = '';
    sortEl.value = defaults.sort;
    apply();
  }

  function visibleCards() { return cards.filter(function (c) { return !c.li.hidden; }); }
  function syncToggleAll() {
    if (!allEl) return;
    var vis = visibleCards();
    var allOpen = vis.length > 0 && vis.every(function (c) { return c.btn.getAttribute('aria-expanded') === 'true'; });
    allEl.textContent = allOpen ? 'Collapse all' : 'Expand all';
  }

  function initToolbar() {
    fillSelect(catEl, uniq('category'));
    fillSelect(slotEl, uniq('slot'), slotLabel);
    SORTS.forEach(function (x) { sortEl.appendChild(h('option', { value: x[0], text: x[1] })); });
    if (isRanked) {
      var group = h('optgroup', { label: 'Score for one dimension' });
      dims.forEach(function (d) { group.appendChild(h('option', { value: d, text: label(d) })); });
      sortEl.appendChild(group);
    }
    sortEl.value = state.sort;
    qEl.addEventListener('input', function () { state.q = qEl.value; apply(); });
    qEl.addEventListener('keydown', function (e) { if (e.key === 'Escape' && qEl.value) { qEl.value = ''; state.q = ''; apply(); e.stopPropagation(); } });
    catEl.addEventListener('change', function () { state.cat = catEl.value; apply(); });
    slotEl.addEventListener('change', function () { state.slot = slotEl.value; apply(); });
    sortEl.addEventListener('change', function () { state.sort = sortEl.value; state.dir = defaultDir(state.sort); apply(); });
    dirEl.addEventListener('click', function () { state.dir = state.dir === 'asc' ? 'desc' : 'asc'; apply(); });
    $('reset').addEventListener('click', resetFilters);
    allEl.addEventListener('click', function () {
      var vis = visibleCards();
      var open = !(vis.length && vis.every(function (c) { return c.btn.getAttribute('aria-expanded') === 'true'; }));
      vis.forEach(function (c) { setOpen(c, open, false); });
    });
    toolbar.hidden = false;
  }

  // ---- afterword ----
  function renderAfter() {
    var body = $('after-body');
    var box = $('afterword');
    if (!body || !box) return;
    if (data.rationale) body.appendChild(h('p', null, h('strong', { text: data.pickKind === 'chosen' ? 'Why the pick won. ' : 'Notes. ' }), data.rationale));
    var carry = ideas.filter(function (i) { return i.carry; })[0];
    if (carry) body.appendChild(h('p', null, h('strong', { text: 'Saved for later. ' }), '"' + carry.title + '" was set aside so it can be reconsidered on another day.'));
    if (data.rejectedNotes && data.rejectedNotes.length) {
      body.appendChild(h('p', null, h('strong', { text: 'Set aside along the way' })));
      body.appendChild(h('ul', null, data.rejectedNotes.map(function (n) { return h('li', null, h('strong', { text: n.title + ': ' }), n.reason); })));
    }
    box.hidden = !body.childNodes.length;
  }

  // ---- keyboard ----
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.key === '/') {
      e.preventDefault();
      qEl.focus();
    } else if (e.key === 'j' || e.key === 'k') {
      var btns = visibleCards().map(function (c) { return c.btn; });
      if (!btns.length) return;
      var at = btns.indexOf(document.activeElement);
      var next = e.key === 'j' ? Math.min(btns.length - 1, at + 1) : Math.max(0, at < 0 ? 0 : at - 1);
      btns[next].focus();
    }
  });

  // ---- go ----
  ideas.forEach(function (idea) {
    var card = buildCard(idea);
    cards.push(card);
    listEl.appendChild(card.li);
  });
  renderPick();
  initToolbar();
  renderAfter();
  apply();
  var hint = $('hint');
  if (hint) hint.hidden = false;

  function fromHash() {
    var m = /^#idea-([A-Za-z0-9_-]{1,24})$/.exec(location.hash || '');
    if (m) openCard(m[1]);
  }
  window.addEventListener('hashchange', fromHash);
  fromHash();
})();
