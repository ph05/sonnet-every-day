// Entry module (SPEC 4.8 and 4.13). It owns the value of every form control, the address-bar hash, the
// clipboard and the debounce. Every change is one pure pass: controls, readFields, buildViewModel,
// renderViewModel, hash, "app:rendered". It never writes into the output regions; view.js does.

import { PLACES, FAMOUS } from './data/places.js';
import { MONTH_NAMES, YEAR_MIN, YEAR_MAX } from './engine.js';
import { SAMPLE, parseHash, formatHash, readFields, sameState } from './state.js';
import { buildViewModel, placeTableRows } from './report.js';
import * as view from './view.js';

const DEBOUNCE_MS = 350;
const THUMB_FRAMES = 2;
const byId = (id) => document.getElementById(id);

// Numeric text boxes: ArrowUp and ArrowDown step them. `fallback` is what an empty or non-numeric box
// becomes on the first press; the second-date boxes start from the first date's own day and year.
const NUMERIC = {
  'f-day': { min: 1, max: 31, big: 1, fallback: () => SAMPLE.day },
  'f-year': { min: YEAR_MIN, max: YEAR_MAX, big: 10, fallback: () => SAMPLE.year },
  'c-day': { min: 1, max: 31, big: 1, fallback: () => SAMPLE.custom.day },
  'c-year': { min: YEAR_MIN, max: YEAR_MAX, big: 10, fallback: () => SAMPLE.custom.year },
  'b-day': { min: 1, max: 31, big: 1, fallback: () => digitsOf('f-day') || SAMPLE.day },
  'b-year': { min: YEAR_MIN, max: YEAR_MAX, big: 10, fallback: () => digitsOf('f-year') || SAMPLE.year },
};

// Selects that apply at once; the famous-date picker has its own path.
const SELECT_IDS = new Set(['f-month', 'f-place', 'c-month', 'f-written', 'b-month']);

let edited = false; // the visitor changed a control since the page loaded or the hash last changed
let pending = false; // a text box changed and its debounced render has not run yet
let timer = 0;
let current = { state: null, vm: null };
let lastValid = SAMPLE;

const reducedMotion = () => Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

function digitsOf(id) {
  const node = byId(id);
  const text = node ? node.value.trim() : '';
  return /^\d{1,4}$/.test(text) ? Number.parseInt(text, 10) : 0;
}

function cloneState(state) {
  return {
    ...state,
    custom: { ...state.custom },
    between: state.between ? { ...state.between } : null,
  };
}

function setValue(id, value) {
  const node = byId(id);
  if (node) node.value = value === null || value === undefined ? '' : String(value);
}

function fillSelect(id, options) {
  const select = byId(id);
  if (select) select.replaceChildren(...options.map(([value, label]) => new Option(label, value)));
}

function fillSelects() {
  const months = MONTH_NAMES.map((name, index) => [String(index + 1), name]);
  fillSelect('f-month', months);
  fillSelect('c-month', months);
  fillSelect('b-month', [['', 'Month'], ...months]);
  fillSelect('f-place', PLACES.map((place) => [place.id, place.name]));
  const famous = byId('f-famous');
  if (famous) {
    const blank = Array.from(famous.options).find((option) => option.value === '')
      || new Option('Try a famous date...', '');
    famous.replaceChildren(blank, ...FAMOUS.map((entry) => new Option(entry.label, entry.id)));
  }
}

function writeControls(state) {
  setValue('f-day', state.day);
  setValue('f-month', state.month);
  setValue('f-year', state.year);
  setValue('f-place', state.placeId);
  setValue('f-written', state.writtenIn);
  const custom = state.custom || SAMPLE.custom;
  setValue('c-day', custom.day);
  setValue('c-month', custom.month);
  setValue('c-year', custom.year);
  const between = state.between;
  setValue('b-day', between ? between.day : '');
  setValue('b-month', between ? between.month : '');
  setValue('b-year', between ? between.year : '');
}

function readRaw() {
  const text = (id) => {
    const node = byId(id);
    return node ? node.value : '';
  };
  return {
    day: text('f-day'),
    month: text('f-month'),
    year: text('f-year'),
    placeId: text('f-place'),
    writtenIn: text('f-written'),
    cday: text('c-day'),
    cmonth: text('c-month'),
    cyear: text('c-year'),
    bday: text('b-day'),
    bmonth: text('b-month'),
    byear: text('b-year'),
  };
}

function famousIdFor(state) {
  const match = FAMOUS.find((entry) => entry.state.placeId === state.placeId && entry.state.year === state.year
    && entry.state.month === state.month && entry.state.day === state.day && state.writtenIn === 'auto');
  return match ? match.id : '';
}

function replaceHash(hash) {
  if (location.hash === hash) return;
  try {
    history.replaceState(null, '', hash);
  } catch {
    // Some sandboxes forbid history changes; the page still works, only the address stays as it was.
  }
}

function render({ animate, writeHash }) {
  const raw = readRaw();
  const fields = readFields(raw);
  const sample = fields.state !== null && !edited && sameState(fields.state, SAMPLE);
  const vm = buildViewModel({
    state: fields.state,
    error: fields.error,
    betweenError: fields.betweenError,
    sample,
    placeId: raw.placeId,
  });
  view.renderViewModel(vm, { animate: animate && !reducedMotion() });
  if (fields.state) {
    lastValid = fields.state;
    if (writeHash) replaceHash(formatHash(fields.state));
  }
  const famous = byId('f-famous');
  if (famous) famous.value = fields.state ? famousIdFor(fields.state) : '';
  current = { state: fields.state, vm };
  document.dispatchEvent(new CustomEvent('app:rendered', { detail: { tone: vm.tone, hash: location.hash } }));
}

function applyNow(animate = true) {
  clearTimeout(timer);
  pending = false;
  render({ animate, writeHash: true });
}

function schedule() {
  edited = true;
  pending = true;
  clearTimeout(timer);
  timer = setTimeout(() => applyNow(), DEBOUNCE_MS);
}

function flush() {
  if (pending) applyNow();
}

function applyFamous(id, fromExplainer) {
  const entry = FAMOUS.find((item) => item.id === id);
  if (!entry) return;
  edited = true;
  writeControls({ ...entry.state, custom: lastValid.custom, between: null });
  applyNow();
  const app = byId('app');
  if (fromExplainer && app && typeof app.scrollIntoView === 'function') {
    app.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  }
}

function pickDay(day) {
  edited = true;
  setValue('f-day', day);
  applyNow();
}

function stepNumber(input, event) {
  const spec = NUMERIC[input.id];
  const text = input.value.trim();
  const typed = /^\d{1,4}$/.test(text) ? Number.parseInt(text, 10) : null;
  const direction = event.key === 'ArrowUp' ? 1 : -1;
  const next = typed === null
    ? spec.fallback()
    : Math.min(spec.max, Math.max(spec.min, typed + direction * (event.shiftKey ? spec.big : 1)));
  edited = true;
  input.value = String(next);
  applyNow(!event.repeat); // a held key would restart the fade on every repeat
}

function legacyCopy(text) {
  const holder = document.createElement('textarea');
  holder.value = text;
  holder.setAttribute('readonly', '');
  holder.setAttribute('aria-hidden', 'true');
  holder.style.position = 'fixed';
  holder.style.top = '0';
  holder.style.left = '-9999px';
  holder.style.opacity = '0';
  const before = document.activeElement;
  document.body.append(holder);
  holder.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    // Refused outside a user gesture; `ok` stays false and the visitor is told to copy by hand.
  }
  holder.remove();
  if (before && typeof before.focus === 'function') before.focus();
  return ok;
}

async function writeClipboard(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied or no secure context: fall through to the textarea route.
    }
  }
  return legacyCopy(text);
}

function copyAndFlash(text, what) {
  writeClipboard(text).then((ok) => view.flashCopied(ok, what), () => view.flashCopied(false, what));
}

function runSelfTest() {
  let outcome = null;
  try {
    outcome = typeof window.__sedSelfTest === 'function' ? window.__sedSelfTest() : null;
  } catch {
    outcome = null;
  }
  Promise.resolve(outcome).then((result) => view.renderSelfTest(result), () => view.renderSelfTest(null));
}

function showInternalError() {
  try {
    const vm = buildViewModel({
      state: null, error: { code: 'internal', field: '' }, betweenError: null, sample: false, placeId: '',
    });
    view.renderViewModel(vm, { animate: false });
  } catch {
    // Nothing more can be shown; the controls keep working for the next attempt.
  }
}

// An event handler must never throw: a failure becomes the plain "something went wrong" message.
function guarded(handler) {
  return (event) => {
    try {
      handler(event);
    } catch {
      showInternalError();
    }
  };
}

function onInput(event) {
  if (event.target instanceof HTMLInputElement && NUMERIC[event.target.id]) schedule();
}

function onChange(event) {
  const target = event.target;
  if (target instanceof HTMLInputElement) {
    flush();
  } else if (target instanceof HTMLSelectElement && target.id === 'f-famous') {
    applyFamous(target.value, false);
  } else if (target instanceof HTMLSelectElement && SELECT_IDS.has(target.id)) {
    edited = true;
    applyNow();
  }
}

function onKeydown(event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || !NUMERIC[target.id]) return;
  if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    flush();
  } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    event.preventDefault();
    stepNumber(target, event);
  }
}

function onFocusOut(event) {
  if (event.target instanceof HTMLInputElement && NUMERIC[event.target.id]) flush();
}

function onSubmit(event) {
  if (event.target && event.target.id === 'form') {
    event.preventDefault();
    flush();
  }
}

function onClick(event) {
  const origin = event.target instanceof Element
    ? event.target.closest('[data-famous], #btn-copy, #btn-link, #btn-selftest')
    : null;
  if (!origin) return;
  flush();
  if (origin.dataset.famous) {
    applyFamous(origin.dataset.famous, true);
  } else if (origin.id === 'btn-copy') {
    if (current.vm && current.vm.copyText) copyAndFlash(current.vm.copyText, 'result');
  } else if (origin.id === 'btn-link') {
    if (current.state) replaceHash(formatHash(current.state));
    copyAndFlash(location.href, 'link');
  } else if (origin.id === 'btn-selftest') {
    runSelfTest();
  }
}

// Links inside the page (the jump link, the limits link) change the hash too; only a hash that
// carries state (it always contains "=") is read as a new date, so those links keep the visitor's input.
function onHashChange() {
  const body = location.hash.replace(/^#/, '');
  if (!body.includes('=')) return;
  edited = false;
  clearTimeout(timer);
  pending = false;
  writeControls(parseHash(location.hash) || SAMPLE);
  render({ animate: false, writeHash: false });
}

function afterFrames(count) {
  return new Promise((resolve) => {
    let left = count;
    const tick = () => {
      left -= 1;
      if (left <= 0) resolve();
      else requestAnimationFrame(tick);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(tick);
    // Frames do not run in a hidden tab, so a timer settles the promise as well.
    setTimeout(resolve, 600);
  });
}

// Test hook: fields of `given` replace those of the current state; `custom` and `between` merge
// field by field, and `between: null` clears the second date.
function mergeState(base, given) {
  const merged = { ...base, ...given, custom: { ...base.custom, ...(given.custom || {}) } };
  if (given.between === null) merged.between = null;
  else if (given.between) merged.between = { ...(base.between || {}), ...given.between };
  else merged.between = base.between;
  return merged;
}

function exposeHooks() {
  window.__sedApp = {
    getState: () => (current.state ? cloneState(current.state) : null),
    getViewModel: () => current.vm,
    setState(partial) {
      const given = partial && typeof partial === 'object' ? partial : {};
      edited = true;
      writeControls(mergeState(cloneState(current.state || lastValid), given));
      applyNow();
      return current.vm;
    },
  };
}

function boot() {
  fillSelects();
  view.mountView({ onPickDay: pickDay });
  view.renderPlaceTable(placeTableRows());
  writeControls(parseHash(location.hash) || SAMPLE);
  render({ animate: false, writeHash: false });
  exposeHooks();
  window.__sedReady = true;
  window.__sedThumbReady = afterFrames(THUMB_FRAMES);

  document.addEventListener('input', guarded(onInput));
  document.addEventListener('change', guarded(onChange));
  document.addEventListener('keydown', guarded(onKeydown));
  document.addEventListener('focusout', guarded(onFocusOut));
  document.addEventListener('submit', guarded(onSubmit));
  document.addEventListener('click', guarded(onClick));
  window.addEventListener('hashchange', guarded(onHashChange));
}

boot();
