// view.js: renders a ViewModel into the DOM. It is the only writer of the output regions and imports nothing.
// Every string from a ViewModel reaches the page through textContent, never through innerHTML.

const WEEKDAY_SHORT = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const TONES = ['ok', 'skip', 'error'];
// A formula such as "13 + 214 + 2329430 - 32045", with its optional "a = 0, y = 6382, m = 7; " prefix.
const FORMULA = /(?:a = \d+, y = \d+, m = \d+; )?\d+(?: [+-] \d+)+(?: = \d+)?/g;

const motion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
const motionAllowed = () => !(motion && motion.matches);

let hooks = {};
let moreOpen = false;
let stepsOpen = false;
let lastGridTitle = '';
let statusTimer = 0;

const byId = (id) => document.getElementById(id);
const str = (v) => (typeof v === 'string' ? v : '');
const list = (v) => (Array.isArray(v) ? v : []);

function make(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function setText(id, value) {
  const node = byId(id);
  if (node) node.textContent = str(value);
  return node;
}

function setLabel(button, label) {
  const holder = button && button.querySelector('.hdc-label');
  if (holder) holder.textContent = label;
}

// Removing the class, forcing a reflow and adding it again replays a CSS animation.
function restart(node, className) {
  node.classList.remove(className);
  void node.offsetWidth;
  node.classList.add(className);
}

function listen(id, type, handler) {
  const node = byId(id);
  if (!node) return;
  node.addEventListener(type, (event) => {
    try {
      handler(event);
    } catch (_) {
      // A handler must never break the page; the next interaction starts clean.
    }
  });
}

function setMore(open) {
  moreOpen = open;
  const panel = byId('more-panel');
  const button = byId('btn-more');
  if (panel) panel.hidden = !open;
  if (button) {
    button.setAttribute('aria-expanded', String(open));
    setLabel(button, open ? 'Fewer options' : 'More options');
  }
}

// The Steps toggle remembers what the visitor chose; an error result has no steps and hides the panel meanwhile.
function syncSteps() {
  const items = byId('steps-list');
  const panel = byId('steps-panel');
  const button = byId('btn-steps');
  const has = !!items && items.childElementCount > 0;
  const show = stepsOpen && has;
  if (panel) panel.hidden = !show;
  if (button) {
    button.disabled = !has;
    button.setAttribute('aria-expanded', String(show));
    setLabel(button, show ? 'Hide the steps' : 'Show the steps');
  }
}

export function mountView(given) {
  hooks = given && typeof given === 'object' ? given : {};
  listen('btn-more', 'click', () => setMore(!moreOpen));
  listen('btn-steps', 'click', () => {
    stepsOpen = !stepsOpen;
    syncSteps();
  });
  listen('more-panel', 'keydown', (event) => {
    if (event.key !== 'Escape') return;
    setMore(false);
    const button = byId('btn-more');
    if (button) button.focus();
  });
  listen('grid-body', 'click', (event) => {
    const cell = event.target instanceof Element ? event.target.closest('[data-day]') : null;
    const day = cell ? Number(cell.dataset.day) : NaN;
    if (Number.isInteger(day) && typeof hooks.onPickDay === 'function') hooks.onPickDay(day);
  });
  setMore(false);
  syncSteps();
}

function fillRows(dl, rows) {
  if (!dl) return;
  dl.replaceChildren();
  for (const item of list(rows)) {
    if (!item || typeof item !== 'object') continue;
    const row = make('div', 'hdc-row');
    const dt = make('dt', '', str(item.label));
    const dd = make('dd', '', str(item.value));
    if (item.cal === 'julian' || item.cal === 'gregorian') {
      row.dataset.cal = item.cal;
      dd.dataset.cal = item.cal;
    }
    row.append(dt, dd);
    dl.append(row);
  }
}

function renderHeader(vm) {
  const result = byId('result');
  if (result) {
    result.dataset.tone = TONES.includes(vm.tone) ? vm.tone : 'error';
    result.dataset.sample = String(vm.sample === true);
  }
  setText('result-badge', vm.badge);
  const tag = byId('result-sample');
  if (tag) tag.hidden = vm.sample !== true;
  const copy = byId('btn-copy');
  if (copy) copy.disabled = !str(vm.copyText);
  setText('live', vm.announce);
}

function renderText(vm) {
  setText('result-headline', vm.headline);
  const detail = byId('result-detail');
  if (detail) {
    detail.replaceChildren(...list(vm.detail).filter((s) => typeof s === 'string' && s).map((s) => make('p', '', s)));
  }
  fillRows(byId('result-rows'), vm.rows);
  const box = byId('year-box');
  if (box) {
    const info = vm.yearBox && typeof vm.yearBox === 'object' ? vm.yearBox : null;
    box.hidden = !info;
    setText('year-box-title', info && info.title);
    fillRows(byId('year-box-rows'), info && info.rows);
  }
  const caption = setText('result-caption', vm.caption);
  if (caption) caption.hidden = !str(vm.caption);
}

function buildCalendar(grid) {
  const days = list(grid.days);
  const lead = Math.min(6, Math.max(0, Math.trunc(Number(grid.lead)) || 0));
  const gapAt = Number.isInteger(grid.gapAt) ? grid.gapAt : null;
  // Days carry no calendar tag: with a gap the dropped days sit between the old calendar's days and today's.
  const wholeMonthOld = /julian/i.test(str(grid.subtitle));
  const shortNames = list(grid.weekdays).length === 7 ? grid.weekdays : WEEKDAY_SHORT;
  const fullNames = list(grid.weekdayNames);

  const table = make('table', 'hdc-cal');
  table.setAttribute('aria-label', str(grid.label));
  const headRow = table.createTHead().insertRow();
  for (let i = 0; i < 7; i += 1) {
    const th = document.createElement('th');
    th.scope = 'col';
    const abbr = make('abbr', '', str(shortNames[i]));
    if (fullNames[i]) abbr.title = str(fullNames[i]);
    th.append(abbr);
    headRow.append(th);
  }

  const body = table.createTBody();
  const cells = Math.ceil((lead + days.length) / 7) * 7;
  let row = null;
  for (let c = 0; c < cells; c += 1) {
    if (c % 7 === 0) row = body.insertRow();
    const cell = row.insertCell();
    const index = c - lead;
    const entry = days[index];
    if (index < 0 || !entry || !Number.isInteger(entry.day)) {
      cell.className = 'blank';
      continue;
    }
    const old = gapAt === null ? wholeMonthOld : index < gapAt;
    const classes = ['d', old ? 'cal-j' : 'cal-g'];
    if (gapAt !== null && index === gapAt - 1) classes.push('is-tear-after');
    if (gapAt !== null && index === gapAt) classes.push('is-tear-before');
    cell.className = classes.join(' ');
    cell.dataset.day = String(entry.day);
    if (entry.day === grid.focus) cell.dataset.focus = 'true';
    cell.textContent = String(entry.day);
  }
  return table;
}

function renderGap(gap) {
  const box = byId('grid-gap');
  if (!box) return;
  box.replaceChildren();
  box.hidden = !gap || typeof gap !== 'object';
  if (box.hidden) return;
  box.append(make('p', 'hdc-gap-text', str(gap.text)));
  const chips = make('div', 'hdc-chips');
  chips.setAttribute('aria-hidden', 'true'); // the sentence above already says which days were skipped
  for (const day of list(gap.days)) {
    const chip = make('span', 'hdc-chip', String(day));
    if (day === gap.focus) chip.dataset.focus = 'true';
    chips.append(chip);
  }
  box.append(chips);
}

function renderGrid(vm) {
  const figure = byId('grid');
  const body = byId('grid-body');
  const grid = vm.grid && typeof vm.grid === 'object' ? vm.grid : null;
  if (!figure) return;
  figure.hidden = !grid;
  if (!grid) {
    if (body) body.replaceChildren();
    renderGap(null);
    return;
  }
  setText('grid-title', grid.title);
  setText('grid-sub', grid.subtitle);
  if (body) body.replaceChildren(buildCalendar(grid));
  renderGap(grid.gap);
}

const stepItem = (text) => {
  const item = document.createElement('li');
  let last = 0;
  for (const match of text.matchAll(FORMULA)) {
    item.append(text.slice(last, match.index), make('code', '', match[0]));
    last = match.index + match[0].length;
  }
  item.append(text.slice(last));
  return item;
};

function renderSteps(vm) {
  const ol = byId('steps-list');
  if (ol) ol.replaceChildren(...list(vm.steps).filter((s) => typeof s === 'string' && s).map(stepItem));
  syncSteps();
}

function renderForm(vm) {
  if (str(vm.yearRule)) setText('year-rule', vm.yearRule);
  const custom = byId('custom-box');
  if (custom) custom.hidden = vm.showCustom !== true;
  setText('c-line', vm.customLine);
  const between = setText('b-line', vm.betweenLine);
  if (between) {
    const tone = vm.betweenTone === 'ok' || vm.betweenTone === 'error' ? vm.betweenTone : 'none';
    between.dataset.tone = tone;
    between.hidden = tone === 'none' || !str(vm.betweenLine);
  }
  if (vm.openMore === true) setMore(true);
}

export function renderViewModel(vm, opts) {
  if (!vm || typeof vm !== 'object') return;
  const result = byId('result');
  const animate = !!(opts && opts.animate) && motionAllowed();
  const newMonth = !!vm.grid && str(vm.grid.title) !== lastGridTitle;
  for (const step of [renderHeader, renderText, renderGrid, renderSteps, renderForm]) {
    try {
      step(vm);
    } catch (_) {
      // One broken region must not stop the others from updating.
    }
  }
  lastGridTitle = vm.grid ? str(vm.grid.title) : '';
  if (!result) return;
  result.classList.remove('is-animate', 'is-flip');
  if (animate) {
    restart(result, 'is-animate');
    if (newMonth) restart(result, 'is-flip');
  }
}

export function renderPlaceTable(rows) {
  const table = byId('place-table');
  if (!table) return;
  const body = table.tBodies[0] || table.createTBody();
  body.replaceChildren();
  const heads = table.tHead && table.tHead.rows[0] ? Array.from(table.tHead.rows[0].cells) : [];
  for (const item of list(rows)) {
    if (!item || typeof item !== 'object') continue;
    const tr = body.insertRow();
    if (item.basisKind === 'search' || item.basisKind === 'mixed') tr.className = 'is-search';
    const name = document.createElement('th');
    name.scope = 'row';
    name.textContent = str(typeof item.place === 'string' ? item.place : item.place && item.place.name);
    tr.append(name);
    [item.lastOld, item.firstNew, item.skipped, item.basis].forEach((value, i) => {
      const td = tr.insertCell();
      td.textContent = str(value);
      if (heads[i + 1]) td.dataset.label = heads[i + 1].textContent; // the narrow layout shows it before the value
    });
  }
}

export function renderSelfTest(res) {
  const out = byId('selftest-out');
  if (!out) return;
  out.replaceChildren();
  const usable = !!res && typeof res === 'object' && Number.isInteger(res.total) && res.total > 0
    && Number.isInteger(res.passed);
  if (!usable) {
    out.dataset.state = 'error';
    out.textContent = 'The checks could not run.';
    return;
  }
  const allPassed = res.passed === res.total;
  out.dataset.state = allPassed ? 'pass' : 'fail';
  out.append(make('p', 'hdc-st-summary', allPassed ? `All ${res.total} checks passed.` : `${res.passed} of ${res.total} checks passed.`));
  const failing = list(res.cases).filter((c) => c && typeof c === 'object' && c.ok === false);
  if (failing.length) {
    const ul = make('ul', 'hdc-st-fails');
    for (const c of failing) ul.append(make('li', '', `${str(c.name)}: ${str(c.detail)}`));
    out.append(ul);
  }
}

export function flashCopied(ok, what) {
  const status = byId('copy-status');
  if (!status) return;
  const message = !ok ? 'Could not copy. Select the text and copy it yourself.' : what === 'link' ? 'Link copied.' : 'Copied.';
  status.textContent = '';
  void status.offsetWidth; // the toast is display:none while empty, so this replays its entrance
  status.textContent = message;
  status.dataset.ok = String(!!ok);
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    status.textContent = '';
  }, 2500);
  const button = byId(what === 'link' ? 'btn-link' : 'btn-copy');
  if (button && ok && motionAllowed()) restart(button, 'is-flash');
}
