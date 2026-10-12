// The page's face. createUI() binds the DOM, renders every panel from the app:* events, turns input (buttons, sliders,
// keys, touch, drag on the map) into intent events, and owns the renderer. It never touches engine state: main.js
// emits what happened, this file emits what the visitor wants.
import { createRenderer } from './render.js';

const REQUIRED = [
  'app', 'stage', 'map', 'overlay', 'clock', 'btn-play', 'btn-step', 'btn-reset', 'speed', 'sats', 'btn-add-sat',
  'btn-remove-sat', 'ctl-alt', 'ctl-inc', 'ctl-ecc', 'ctl-node', 'ctl-argp', 'ctl-swath', 'out-alt', 'out-inc',
  'out-ecc', 'out-node', 'out-argp', 'out-swath', 'alt-ticks', 'btn-snap', 'btn-sso', 'btn-share', 'ro-period',
  'ro-apogee', 'ro-regress', 'ro-ltan', 'ro-revs', 'ro-shift', 'ro-repeat', 'ro-maxlat', 'ro-sunsync', 'sc-planet',
  'sc-map', 'sc-overlap', 'sc-revisit', 'sc-drift', 'sc-lie', 'card-list', 'card-goal', 'card-progress',
  'card-result', 'toast', 'sr-announcer', 'fatal',
];
const PARAMS = ['alt', 'inc', 'ecc', 'node', 'argp', 'swath'];
const PARAM_LABELS = {
  alt: 'Height', inc: 'Tilt', ecc: 'Stretch', node: 'Start longitude', argp: 'Perigee turn', swath: 'Swath width',
  season: 'Sun date',
};
const LETTERS = ['A', 'B', 'C'];
const BADGES = { swatch: 'Swatch', sweater: 'Sweater', heirloom: 'Heirloom' };
const SHAPE_PATHS = [
  'M10 3.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13z',
  'M4 4h12v12H4z',
  'M10 2.5l7.5 7.5-7.5 7.5L2.5 10z',
];
const CAPTIONS = {
  flat: 'Flat map: the poles are inflated',
  polar: 'Equal-area view: a stitch is the same size on screen as on the planet',
};
const FREE_GOAL = 'Free knit: no goal, no par. Slide the needles around, press Tune sun-sync, or pick a pattern card to chase a badge.';
const FREE_DAYS = 365;
const EARTH_KM = 6378.137;
const TOASTS = {
  shareCopied: 'Link copied. Anyone who opens it gets your exact needles.',
  shareManual: "Couldn't reach the clipboard. The link is in the box below.",
  badLink: "Part of that link didn't make sense, so I used safe defaults.",
  storageOff: "Can't save your best badges in this browser. Everything else works.",
  locked: '{param} is fixed by this card.',
  tooLow: 'Height raised to 200 km, the lowest this toy allows.',
  tooHigh: 'Orbit shortened: apogee is capped at 60,000 km (the model has no Moon).',
  ssoNone: 'No sun-synchronous tilt exists at this height and shape.',
  tuned: 'Tilted to {inc} degrees: the orbit now turns with the sun.',
  snapped: 'Snapped to {alt} km: {k} orbits in {m} days, tracks {spacing} km apart.',
  noRepeat: 'No repeat height within 16 days near here.',
  peeked: 'Par setup loaded. Peeking means no badge this round.',
  cardPassed: 'Bound off! {badge}, {score} points.',
  cardMissed: '{short} points short of a pass. Pull a loose thread and try again.',
  newBest: 'New personal best on this card.',
  runReset: 'Unravelled. Casting on again.',
  maxSats: 'Three needles is the most this frame holds.',
  maxSatsOne: 'This card knits with one needle.',
  maxSatsTwo: 'This card holds two needles.',
  alreadyFree: 'Already knitting freely. Use Frog it to start over.',
  runDone: 'This run is finished. Press Play to knit it again.',
  minSats: 'A knitter needs at least one needle.',
  randomized: 'Shuffled. A fresh set of needles.',
};

const nf = (min, max) => new Intl.NumberFormat('en-US', { minimumFractionDigits: min, maximumFractionDigits: max });
const F0 = nf(0, 0);
const F1 = nf(1, 1);
const F2 = nf(2, 2);
const F3 = nf(3, 3);
const T1 = nf(0, 1);
const dayFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// Fractions from the engine are trusted to be numbers, but a missing field should read as zero, not throw.
const unit = (v) => (Number.isFinite(v) ? clamp(v, 0, 1) : 0);
const t1 = (v) => (Number.isFinite(v) ? T1.format(v) : '–');

// Formats with en-US digits, a real minus sign, and no "-0.0".
function num(f, v) {
  if (!Number.isFinite(v)) return '–';
  const s = f.format(v);
  return /^-0(?:\.0+)?$/.test(s) ? s.slice(1) : s.replace('-', '−');
}

function pct(v, digits) {
  return Number.isFinite(v) ? (clamp(v, 0, 1) * 100).toFixed(digits) + '%' : '–';
}

function hhmm(hours) {
  if (!Number.isFinite(hours)) return '–';
  const h = ((hours % 24) + 24) % 24;
  let whole = Math.floor(h);
  let minutes = Math.round((h - whole) * 60);
  if (minutes === 60) {
    whole = (whole + 1) % 24;
    minutes = 0;
  }
  return String(whole).padStart(2, '0') + ':' + String(minutes).padStart(2, '0');
}

function lonText(v) {
  const a = Math.abs(v);
  return T1.format(a) + '°' + (a < 0.05 ? '' : v < 0 ? ' W' : ' E');
}

function lonSpoken(v) {
  const a = Math.abs(v);
  return T1.format(a) + ' degrees' + (a < 0.05 ? '' : v < 0 ? ' west' : ' east');
}

function latLonText(lat, lon) {
  return T1.format(Math.abs(lat)) + '° ' + (lat < 0 ? 'S' : 'N') + ', ' + T1.format(Math.abs(lon)) + '° ' + (lon < 0 ? 'W' : 'E');
}

function sunDate(v) {
  return dayFormat.format(new Date(Date.UTC(2001, 2, 20 + Math.round(v))));
}

const SHOWN = {
  alt: (v) => T1.format(v) + ' km',
  inc: (v) => num(F2, v) + '°',
  ecc: (v) => num(F3, v),
  node: lonText,
  argp: (v) => F0.format(v) + '°',
  swath: (v) => F0.format(v) + ' km',
  season: sunDate,
};
const SPOKEN = { ...SHOWN, inc: (v) => num(F2, v) + ' degrees', node: lonSpoken, argp: (v) => F0.format(v) + ' degrees' };

function toastParam(name, value) {
  if (value === undefined || value === null || value === '') return '–';
  if (name === 'param') return PARAM_LABELS[value] || String(value);
  if (name === 'badge') return BADGES[value] || String(value);
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value).slice(0, 40);
  if (name === 'inc') return F2.format(n);
  if (name === 'k' || name === 'm') return F0.format(n);
  return T1.format(n);
}

export function createUI({ seed = 1011, reducedMotion = false } = {}) {
  const $ = (id) => document.getElementById(id);
  for (const id of REQUIRED) if (!$(id)) throw new Error('ui: missing #' + id);
  const el = {};
  for (const id of REQUIRED) el[id] = $(id);
  let reduced = !!reducedMotion;

  const renderer = createRenderer(el.stage, { seed, reducedMotion: reduced });

  const S = {
    sats: [], sel: 0, view: 'flat', speed: 1, season: 0, terminator: true, playing: false, peeked: false, card: 'free',
    cards: [], activeCard: null, info: null, tick: null, tab: 'orbit', short: null, finishedShown: false,
    booted: false, tickSig: '', labelAt: 0, focusOn: false, frozen: false, userPicked: false, drawFails: 0, seenCard: null,
  };
  const timers = new Set();
  const listeners = [];
  const logged = new Set();
  let announceTimer = 0;
  let toastTimer = 0;
  let selftestTimer = 0;
  let readoutTimer = 0;
  let destroyed = false;

  const on = (target, type, fn, opts) => {
    if (!target) return;
    const wrapped = (e) => {
      if (destroyed) return;
      try {
        fn(e);
      } catch (err) {
        logOnce(type, err);
      }
    };
    target.addEventListener(type, wrapped, opts);
    listeners.push([target, type, wrapped, opts]);
  };
  const later = (fn, ms) => {
    const id = setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
    return id;
  };
  function logOnce(tag, err) {
    if (logged.has(tag)) return;
    logged.add(tag);
    console.error('ui: ' + tag + ' failed', err);
  }
  function emit(name, detail) {
    try {
      document.dispatchEvent(new CustomEvent('app:' + name, { detail: detail || {} }));
    } catch (err) {
      logOnce('emit ' + name, err);
    }
  }
  const setText = (node, text) => {
    if (node && node.textContent !== text) node.textContent = text;
  };
  function announce(text) {
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => {
      el['sr-announcer'].textContent = '';
      el['sr-announcer'].textContent = text;
    }, 150);
  }

  // ---- controls ----------------------------------------------------------------------------------------------------
  const ctl = {};
  for (const param of [...PARAMS, 'season']) {
    const input = $('ctl-' + param);
    if (!input) continue;
    const wrap = input.closest('.kn-ctl');
    const hint = wrap && wrap.querySelector('.kn-hint');
    ctl[param] = {
      input, wrap, hint, hintText: hint ? hint.textContent : '', out: $('out-' + param),
      min: Number(input.min), max: Number(input.max), hold: 0,
    };
  }

  function showValue(param, value) {
    const c = ctl[param];
    if (!c || !Number.isFinite(value)) return;
    const f = clamp((value - c.min) / (c.max - c.min), 0, 1);
    c.input.style.setProperty('--f', f.toFixed(4));
    setText(c.out, SHOWN[param](value));
    c.input.setAttribute('aria-valuetext', SPOKEN[param](value));
  }

  function setControl(param, value) {
    const c = ctl[param];
    if (!c || !Number.isFinite(value)) return;
    const before = c.out ? c.out.textContent : '';
    showValue(param, value);
    // while the visitor holds the thumb the slider's own value is the truth; do not nudge it to the state's rounding
    if (document.activeElement === c.input && performance.now() - c.hold < 300) return;
    c.input.value = String(value);
    // a value that moved without the visitor's thumb (Tune, Snap, Surprise me, a card) gets a brief highlight
    if (S.booted && c.out && before !== c.out.textContent) {
      c.out.classList.remove('is-changed');
      void c.out.offsetWidth;
      c.out.classList.add('is-changed');
    }
  }

  function renderControls() {
    const sat = S.sats[S.sel];
    if (!sat) return;
    for (const param of PARAMS) setControl(param, sat[param]);
    if (ctl.season) setControl('season', S.season);
    if (ctl.argp && ctl.argp.wrap) ctl.argp.wrap.toggleAttribute('data-inert', !(sat.ecc > 0.0005));
  }

  function renderLocks() {
    const locks = (S.activeCard && S.activeCard.locks) || {};
    for (const param of Object.keys(ctl)) {
      const c = ctl[param];
      const locked = Number.isFinite(locks[param]);
      c.input.disabled = locked;
      c.input.toggleAttribute('data-locked', locked);
      if (c.wrap) c.wrap.toggleAttribute('data-locked', locked);
      if (c.hint) setText(c.hint, locked ? 'Fixed by this card.' : c.hintText);
    }
  }

  for (const param of Object.keys(ctl)) {
    on(ctl[param].out, 'animationend', () => ctl[param].out.classList.remove('is-changed'));
    on(ctl[param].input, 'input', () => {
      const c = ctl[param];
      const v = Number(c.input.value);
      if (!Number.isFinite(v)) return;
      c.hold = performance.now();
      showValue(param, v);
      if (param === 'season') emit('set-season', { season: v });
      else emit('set-sat', { index: S.sel, patch: { [param]: v } });
    });
  }

  // ---- needles -----------------------------------------------------------------------------------------------------
  const chipTemplate = $('tpl-chip');

  function makeChip(i) {
    const btn = chipTemplate.content.firstElementChild.cloneNode(true);
    btn.dataset.index = String(i);
    btn.querySelector('path').setAttribute('d', SHAPE_PATHS[i] || SHAPE_PATHS[0]);
    on(btn, 'click', () => emit('select-sat', { index: i }));
    on(btn, 'keydown', (e) => {
      const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!step && e.key !== 'Home' && e.key !== 'End') return;
      e.preventDefault();
      const n = S.sats.length;
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (i + step + n) % n;
      emit('select-sat', { index: next });
      const target = el.sats.children[next];
      if (target) target.focus();
    });
    return btn;
  }

  function renderSats() {
    const n = S.sats.length;
    while (el.sats.children.length > n) el.sats.lastElementChild.remove();
    while (chipTemplate && el.sats.children.length < n) el.sats.appendChild(makeChip(el.sats.children.length));
    for (let i = 0; i < n; i++) {
      const btn = el.sats.children[i];
      const sat = S.sats[i];
      btn.setAttribute('aria-selected', i === S.sel ? 'true' : 'false');
      btn.tabIndex = i === S.sel ? 0 : -1;
      setText(btn.querySelector('.chip-name'), 'Needle ' + LETTERS[i]);
      setText(btn.querySelector('.chip-sum'), t1(sat.alt) + ' km, ' + num(F2, sat.inc) + '°');
    }
    const max = S.activeCard ? S.activeCard.maxSats : 3;
    // at the limit the buttons stay clickable (main answers with a toast); they only look spent
    el['btn-add-sat'].dataset.limit = n >= max ? 'true' : 'false';
    el['btn-remove-sat'].dataset.limit = n <= 1 ? 'true' : 'false';
    const name = 'Needle ' + (LETTERS[S.sel] || 'A');
    setText($('tune-for'), name);
    setText($('ro-for'), name);
  }

  // ---- readouts and repeat ticks -----------------------------------------------------------------------------------
  function renderInfo() {
    const i = S.info;
    if (!i) return;
    const set = (id, text) => setText(el[id], text);
    set('ro-period', num(F1, i.periodMin) + ' min');
    const stretched = Math.abs(i.apogeeKm - i.perigeeKm) > 1; // false for NaN too
    set('ro-apogee', t1(i.apogeeKm) + ' km' + (stretched ? ' (low point ' + t1(i.perigeeKm) + ' km)' : ''));
    set('ro-regress', num(F2, i.nodeDriftDegDay) + '° per day' + (i.isSunSync ? ', in step with the sun' : ''));
    set('ro-ltan', hhmm(i.ltanH));
    set('ro-revs', num(F2, i.revsPerDay) + ' per day');
    set('ro-shift', num(F2, i.shiftDegOrbit) + '° west');
    set('ro-repeat', i.repeat ? i.repeat.k + ' orbits in ' + i.repeat.m + ' days, ' + t1(i.repeat.spacingKm) + ' km apart' : 'none near this height');
    set('ro-maxlat', num(F1, i.maxLatDeg) + '° north and south');
    set('ro-sunsync', i.isSunSync ? 'Yes' : Number.isFinite(i.ssoIncDeg) ? 'No (tilt ' + num(F2, i.ssoIncDeg) + '° would do it)' : 'No tilt works here');
  }

  // Tall accent ticks are repeats whose tracks are closer than the swath; short ones are quick repeats (3 days or fewer).
  // Ticks closer than about three pixels share one bucket, and the stronger one wins.
  function renderTicks(ticks) {
    const c = ctl.alt;
    const picked = new Map();
    for (const t of Array.isArray(ticks) ? ticks : []) {
      if (!t || !Number.isFinite(t.alt) || !Number.isFinite(t.m)) continue;
      if (!t.tight && t.m > 3) continue;
      const f = (t.alt - c.min) / (c.max - c.min);
      if (f < 0 || f > 1) continue;
      const bucket = Math.round(f * 100);
      const cur = picked.get(bucket);
      if (!cur || (t.tight ? 0 : 100) + t.m < (cur.tight ? 0 : 100) + cur.m) picked.set(bucket, t);
    }
    const chosen = [...picked.values()].sort((a, b) => a.alt - b.alt);
    const sig = chosen.map((t) => t.alt + '/' + t.m + (t.tight ? 't' : '')).join(' ');
    if (sig === S.tickSig) return;
    S.tickSig = sig;
    const frag = document.createDocumentFragment();
    for (const t of chosen) {
      const tick = document.createElement('i');
      tick.className = 'kn-tick' + (t.tight ? ' is-tight' : '');
      tick.style.left = (((t.alt - c.min) / (c.max - c.min)) * 100).toFixed(2) + '%';
      tick.title = F0.format(t.k) + ' orbits in ' + F0.format(t.m) + ' days, tracks ' + T1.format(t.spacingKm) + ' km apart';
      frag.appendChild(tick);
    }
    el['alt-ticks'].replaceChildren(frag);
  }

  // ---- cards, goal, result -----------------------------------------------------------------------------------------
  const cardTemplate = $('tpl-card');

  function cardOrder() {
    return ['free', ...S.cards.map((c) => c.id)];
  }

  function renderCards() {
    const list = el['card-list'];
    if (!cardTemplate) return;
    const same = list.children.length === S.cards.length && S.cards.every((c, i) => list.children[i].dataset.cardId === c.id);
    if (!same) {
      list.replaceChildren();
      for (const c of S.cards) {
        const btn = cardTemplate.content.firstElementChild.cloneNode(true);
        btn.dataset.cardId = c.id;
        on(btn, 'click', () => {
          S.userPicked = true;
          emit('pick-card', { id: c.id });
        });
        list.appendChild(btn);
      }
    }
    S.cards.forEach((c, i) => {
      const btn = list.children[i];
      const best = c.best && BADGES[c.best.badge] ? c.best : null;
      btn.dataset.badge = best ? best.badge : 'none';
      btn.setAttribute('aria-current', c.id === S.card ? 'true' : 'false');
      setText(btn.querySelector('.kn-card-title'), c.title);
      setText(btn.querySelector('.kn-card-blurb'), c.blurb);
      const meta = [c.days + (c.days === 1 ? ' day' : ' days'), c.maxSats + (c.maxSats === 1 ? ' needle' : ' needles')];
      if (Number.isFinite(c.par)) meta.push('par ' + T1.format(c.par));
      if (c.best && Number.isFinite(c.best.score)) meta.push('best ' + T1.format(c.best.score));
      setText(btn.querySelector('.kn-card-meta'), meta.join(' · '));
      const badge = btn.querySelector('.kn-badge');
      badge.hidden = !best;
      badge.dataset.badge = best ? best.badge : 'none';
      setText(badge, best ? BADGES[best.badge] : '');
    });
  }

  function renderGoal() {
    const card = S.activeCard;
    const free = !card;
    setText($('h-goal'), free ? 'Free knit' : card.title);
    setText(el['card-goal'], free ? FREE_GOAL : card.goal);
    const pass = $('goal-pass');
    if (pass) {
      pass.hidden = free || !card.passText;
      setText(pass, free ? '' : card.passText || '');
    }
    const peek = $('btn-peek');
    if (peek) peek.setAttribute('aria-disabled', free || S.peeked ? 'true' : 'false');
    const freeBtn = $('btn-free');
    if (freeBtn) freeBtn.setAttribute('aria-pressed', free ? 'true' : 'false');
    renderProgress();
  }

  function renderProgress() {
    const t = S.tick;
    const card = S.activeCard;
    const total = card ? card.days : FREE_DAYS;
    const day = t && Number.isFinite(t.day) ? t.day : 0;
    const progress = unit(card && t && t.card ? t.card.progress : day / total);
    if (el['card-progress'].value !== progress) el['card-progress'].value = progress;
    const label = 'Day ' + Math.min(Math.floor(day) + 1, total) + ' of ' + total;
    setText($('goal-days'), label);
    el['card-progress'].setAttribute('aria-valuetext', label);
    const chip = $('goal-status');
    const status = t && t.card;
    if (chip) {
      chip.hidden = !(status && !status.finished);
      if (status) {
        setText(chip, status.pass ? 'Passing now' : 'Not passing yet');
        chip.classList.toggle('is-pass', !!status.pass);
      }
    }
  }

  // A card run is over when the engine says so; a free run is over at the end of the year.
  function isFinished() {
    const t = S.tick;
    if (!t) return false;
    return !!(t.card && t.card.finished) || (!S.activeCard && !t.running && t.day >= FREE_DAYS - 0.01);
  }

  function nextCardId() {
    const order = cardOrder();
    const i = order.indexOf(S.card);
    return i >= 0 && i < order.length - 1 ? order[i + 1] : 'free';
  }

  function renderResult() {
    const box = el['card-result'];
    const t = S.tick;
    const status = t && t.card;
    const finished = isFinished();
    const freeDone = finished && !S.activeCard;
    if (!finished) {
      box.hidden = true;
      S.finishedShown = false;
      S.short = null;
      return;
    }
    const card = S.activeCard;
    const title = $('result-title');
    const text = $('result-text');
    const show = (id, visible) => {
      const b = $(id);
      if (b) b.hidden = !visible;
    };
    let kind;
    if (freeDone) {
      kind = 'free';
      setText(title, 'Bound off at day ' + FREE_DAYS + '.');
      setText(text, 'The planet is ' + pct(t.metrics.planet, 0) + ' covered; the flat map says ' + pct(t.metrics.map, 0) + '.');
    } else if (status.pass && !status.peeked) {
      kind = 'pass';
      setText(title, 'Bound off!');
      setText(text, (BADGES[status.badge] || 'Swatch') + ': ' + t1(status.score) + ' points (par ' + t1(status.par) + ').');
    } else if (status.peeked) {
      kind = 'peek';
      setText(title, 'Peeked, so no badge.');
      setText(text, 'The par setup scored ' + t1(status.score) + ' points (par ' + t1(status.par) + '). Try again with your own needles.');
    } else {
      kind = 'miss';
      const short = Number.isFinite(status.short) && status.short > 0 ? status.short : S.short;
      setText(title, Number.isFinite(short) ? T1.format(short) + ' points short of a pass.' : 'Not quite a pass.');
      setText(text, card && card.hint ? card.hint : '');
    }
    const rosette = $('result-rosette');
    if (rosette) rosette.dataset.badge = kind === 'pass' && BADGES[status.badge] ? status.badge : 'none';
    box.classList.toggle('is-miss', kind === 'miss' || kind === 'peek');
    show('btn-result-retry', kind === 'miss' || kind === 'peek');
    show('btn-result-share', kind === 'pass' || kind === 'free');
    show('btn-result-next', kind === 'pass');
    if (box.hidden || !S.finishedShown) {
      box.hidden = false;
      box.classList.add('is-new');
      later(() => box.classList.remove('is-new'), 700);
      announce(kind === 'pass' ? 'Bound off. ' + (BADGES[status.badge] || '') + ', ' + t1(status.score) + ' points.' : title.textContent);
    }
    S.finishedShown = true;
  }

  // ---- clock, score, labels ----------------------------------------------------------------------------------------
  function renderTick() {
    const t = S.tick;
    if (!t || !t.metrics) return;
    const m = t.metrics;
    const day = Number.isFinite(t.day) ? t.day : 0;
    const total = S.activeCard ? S.activeCard.days : FREE_DAYS;
    const dayNo = Math.min(Math.floor(day) + 1, total);
    const clockTime = hhmm(12 + (day - Math.floor(day)) * 24) + ' UTC';
    setText(el.clock, isFinished() ? 'Day ' + total + ' done · ' + clockTime : 'Day ' + dayNo + ' · ' + clockTime);
    setText(el['sc-planet'], pct(m.planet, 1));
    setText(el['sc-map'], pct(m.map, 1));
    setText(el['sc-overlap'], pct(m.overlap, 1));
    setText(el['sc-revisit'], m.revisitH === null || !Number.isFinite(m.revisitH) ? 'none yet' : m.revisitH >= 48 ? T1.format(m.revisitH / 24) + ' days' : T1.format(m.revisitH) + ' h');
    setText(el['sc-drift'], Number.isFinite(m.ltDriftH) ? (m.ltDriftH > 0.004 ? '+' : '') + num(F2, m.ltDriftH) + ' h' : '–');
    const planet = Math.round(unit(m.planet) * 100);
    const map = Math.round(unit(m.map) * 100);
    if (!planet && !map) setText(el['sc-lie'], 'Nothing knit yet.');
    else if (Math.abs(unit(m.map) - unit(m.planet)) < 0.01) setText(el['sc-lie'], 'The map and the planet agree for once: ' + planet + '%.');
    else setText(el['sc-lie'], 'The flat map looks ' + map + '% covered; the planet is ' + planet + '%.');
    const barPlanet = $('bar-planet');
    const barMap = $('bar-map');
    if (barPlanet) barPlanet.style.setProperty('--v', unit(m.planet).toFixed(4));
    if (barMap) barMap.style.setProperty('--v', unit(m.map).toFixed(4));
    setText($('hud-planet'), planet + '%');
    setText($('hud-map'), map + '%');
    const now = performance.now();
    if (now - S.labelAt > 2000) {
      S.labelAt = now;
      el.map.setAttribute('aria-label', 'World map being knitted: day ' + dayNo + ', planet ' + planet + '% covered, flat map ' + map + '% covered.');
    }
    const hint = $('empty-hint');
    if (hint) hint.hidden = !(day < 0.05 && !t.running && !planet);
    renderProgress();
    renderResult();
  }

  function renderPlay() {
    const playing = S.playing && !isFinished();
    const btn = el['btn-play'];
    btn.dataset.playing = playing ? 'true' : 'false';
    setText(btn.querySelector('.kn-btn-label'), playing ? 'Pause' : 'Play');
    const use = btn.querySelector('use');
    if (use) use.setAttribute('href', playing ? '#i-pause' : '#i-play');
    el['btn-step'].setAttribute('aria-disabled', isFinished() ? 'true' : 'false'); // still clickable: main answers with a toast
  }

  function renderView() {
    el.stage.dataset.view = S.view;
    const flat = $('btn-view-flat');
    const polar = $('btn-view-polar');
    if (flat) flat.setAttribute('aria-pressed', S.view === 'flat' ? 'true' : 'false');
    if (polar) polar.setAttribute('aria-pressed', S.view === 'polar' ? 'true' : 'false');
    setText($('map-caption'), CAPTIONS[S.view]);
  }

  function renderNotes() {
    const note = $('focus-note');
    if (!note) return;
    const parts = [];
    if (S.focusOn) parts.push('The dashed band is the part of the map this card scores.');
    if (S.frozen) parts.push('Above a day or two per second the night line rests at 12:00 UTC.');
    note.hidden = !parts.length;
    setText(note, parts.join(' '));
  }

  // ---- events from main --------------------------------------------------------------------------------------------
  function showFatal(message) {
    const app = el.app;
    app.dataset.state = 'error';
    app.setAttribute('aria-busy', 'false');
    const detail = $('fatal-detail');
    const clean = String(message || 'something went wrong').replace(/[\s.]+$/, '').slice(0, 160);
    if (detail) setText(detail, clean);
    el.fatal.hidden = false;
  }

  on(document, 'app:status', (e) => {
    const d = e.detail || {};
    if (d.kind === 'loading') {
      el.app.dataset.state = 'loading';
      el.app.setAttribute('aria-busy', 'true');
    } else if (d.kind === 'ready') {
      el.app.dataset.state = 'ready';
      el.app.setAttribute('aria-busy', 'false');
      el.fatal.hidden = true;
      announce(S.playing ? 'Ready. The satellites are already knitting; press Space to pause.' : 'Ready. The map is paused; press Space or Play to start knitting.');
    } else if (d.kind === 'error') {
      showFatal(d.message);
    }
  });

  on(document, 'app:cards', (e) => {
    const d = e.detail || {};
    S.cards = Array.isArray(d.cards) ? d.cards.filter((c) => c && typeof c.id === 'string') : [];
    if (typeof d.active === 'string') S.card = d.active;
    S.activeCard = S.cards.find((c) => c.id === S.card) || null;
    renderCards();
    renderGoal();
    renderLocks();
    renderSats();
  });

  on(document, 'app:state', (e) => {
    const d = e.detail || {};
    const st = d.state;
    if (!st || !Array.isArray(st.sats) || !st.sats.length) return;
    const before = { sel: S.sel, view: S.view, playing: S.playing };
    S.booted = S.booted || d.reason !== 'boot';
    S.sats = st.sats.slice(0, 3).map((s) => ({ alt: +s.alt, inc: +s.inc, ecc: +s.ecc, node: +s.node, argp: +s.argp, swath: +s.swath }));
    S.sel = clamp(Math.floor(Number(st.sel) || 0), 0, S.sats.length - 1);
    S.view = st.view === 'polar' ? 'polar' : 'flat';
    S.speed = Number(st.speed) || 1;
    S.season = Number.isFinite(st.season) ? st.season : 0;
    S.terminator = !!st.terminator;
    S.playing = !!st.playing;
    S.peeked = !!st.peeked;
    if (typeof st.card === 'string') S.card = st.card;
    S.activeCard = S.cards.find((c) => c.id === S.card) || null;
    el.speed.value = String(S.speed);
    const night = $('btn-terminator');
    if (night) night.setAttribute('aria-pressed', S.terminator ? 'true' : 'false');
    renderView();
    renderPlay();
    renderSats();
    renderControls();
    renderLocks();
    renderCards();
    renderGoal();
    if (d.reason === 'reset' || d.reason === 'card') S.short = null;
    // app:cards always arrives first and has already moved S.card, so compare with the card this handler saw last.
    const cardChanged = S.seenCard !== null && S.seenCard !== S.card;
    S.seenCard = S.card;
    if (cardChanged) {
      announce((S.activeCard ? 'Pattern card: ' + S.activeCard.title + '. ' + S.activeCard.goal : 'Free knit.'));
      if (S.userPicked) revealStage();
    }
    S.userPicked = false;
    if (before.view !== S.view) announce(S.view === 'polar' ? 'Polar view' : 'Flat map');
    if (before.sel !== S.sel && d.reason === 'user') announce('Needle ' + LETTERS[S.sel] + ' selected');
  });

  on(document, 'app:info', (e) => {
    const d = e.detail || {};
    if (!Array.isArray(d.sats)) return;
    S.info = d.sats[Number.isFinite(d.sel) ? d.sel : S.sel] || d.sats[0] || null;
    renderInfo();
    renderTicks(d.ticks);
  });

  on(document, 'app:tick', (e) => {
    const d = e.detail || {};
    if (!d.metrics) return;
    S.tick = d;
    renderPlay();
    renderTick();
  });

  on(document, 'app:toast', (e) => {
    const d = e.detail || {};
    let template = TOASTS[d.key];
    // the needle limit is the card's own (one needle on seven cards, two on Two-Needle Cable), not always three
    if (d.key === 'maxSats' && S.activeCard && S.activeCard.maxSats < 3) template = S.activeCard.maxSats === 1 ? TOASTS.maxSatsOne : TOASTS.maxSatsTwo;
    if (!template) return;
    const params = d.params || {};
    if (d.key === 'cardMissed' && Number.isFinite(Number(params.short))) {
      S.short = Number(params.short);
      renderResult();
    }
    showToast(template.replace(/\{(\w+)\}/g, (m, name) => toastParam(name, params[name])));
    const box = $('share-url');
    if (box && d.key === 'shareManual') {
      box.value = typeof params.url === 'string' && params.url ? params.url : location.href;
      box.hidden = false;
      box.focus();
      box.select();
    } else if (box && d.key === 'shareCopied') {
      box.hidden = true;
    }
  });

  on(document, 'app:selftest', (e) => {
    const r = e.detail || {};
    const box = $('selftest-result');
    if (!box || !Array.isArray(r.items)) return;
    clearTimeout(selftestTimer);
    const sum = document.createElement('p');
    sum.className = 'sum';
    sum.textContent = r.passed + ' of ' + r.total + ' checks pass';
    const list = document.createElement('ul');
    for (const item of r.items.filter((it) => it && typeof it === 'object').slice(0, 40)) {
      const li = document.createElement('li');
      li.className = item.ok ? 'ok' : 'fail';
      li.textContent = String(item.name) + ': got ' + shortValue(item.got) + ', expected ' + shortValue(item.want);
      list.appendChild(li);
    }
    box.replaceChildren(sum, list);
  });

  function shortValue(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : 'n/a';
    return String(typeof v === 'object' ? JSON.stringify(v) : v).slice(0, 60);
  }

  // ---- toast -------------------------------------------------------------------------------------------------------
  function showToast(text) {
    const box = el.toast;
    clearTimeout(toastTimer);
    box.textContent = text;
    box.classList.add('is-on');
    toastTimer = later(hideToast, 4800);
  }

  function hideToast() {
    el.toast.classList.remove('is-on');
    clearTimeout(toastTimer);
    toastTimer = later(() => {
      if (!el.toast.classList.contains('is-on')) el.toast.textContent = '';
    }, 400);
  }
  on(el.toast, 'click', hideToast);

  // ---- buttons -----------------------------------------------------------------------------------------------------
  const press = (id, handler) => on($(id), 'click', handler);
  press('btn-play', () => emit('toggle-play'));
  press('btn-step', () => emit('step', { days: 1 }));
  press('btn-reset', () => emit('reset'));
  press('btn-view-flat', () => emit('set-view', { view: 'flat' }));
  press('btn-view-polar', () => emit('set-view', { view: 'polar' }));
  press('btn-terminator', () => emit('set-terminator', { on: !S.terminator }));
  press('btn-add-sat', () => emit('add-sat'));
  press('btn-remove-sat', () => emit('remove-sat', { index: S.sel }));
  press('btn-snap', () => emit('snap-repeat', { index: S.sel, dir: 0 }));
  press('btn-sso', () => emit('tune-sso', { index: S.sel }));
  press('btn-random', () => emit('randomize'));
  press('btn-share', () => emit('share'));
  press('btn-peek', () => {
    if ($('btn-peek').getAttribute('aria-disabled') !== 'true') emit('peek-par');
  });
  press('btn-free', () => emit('pick-card', { id: 'free' }));
  // After a peek the par needles are loaded and the flag only clears when a card is picked, so Try again re-picks the card.
  press('btn-result-retry', () => {
    if (S.peeked && S.activeCard) emit('pick-card', { id: S.card });
    else emit('reset');
  });
  press('btn-result-share', () => emit('share'));
  press('btn-result-next', () => {
    S.userPicked = true;
    emit('pick-card', { id: nextCardId() });
  });
  on(el.speed, 'change', () => {
    const v = Number(el.speed.value);
    if (Number.isFinite(v)) emit('set-speed', { speed: v });
  });

  // ---- tabs (phones) and the wide layout ---------------------------------------------------------------------------
  const tabNames = ['orbit', 'cards', 'score'];
  const panels = { orbit: [$('panel-orbit'), $('readouts')], cards: [$('panel-cards')], score: [$('panel-score')] };
  const tabsBar = $('tabs');
  const wideQuery = matchMedia('(min-width: 768px)');

  function applyLayout() {
    const wide = wideQuery.matches;
    if (tabsBar) tabsBar.hidden = wide;
    for (const name of tabNames) {
      const tab = $('tab-' + name);
      const selected = name === S.tab;
      if (tab) {
        tab.setAttribute('aria-selected', selected ? 'true' : 'false');
        tab.tabIndex = selected ? 0 : -1;
      }
      for (const p of panels[name]) {
        if (!p) continue;
        p.hidden = !wide && !selected;
      }
      const main = panels[name][0];
      if (main && wide) {
        main.removeAttribute('role');
        main.removeAttribute('aria-labelledby');
      } else if (main) {
        main.setAttribute('role', 'tabpanel');
        main.setAttribute('aria-labelledby', 'tab-' + name);
        main.removeAttribute('aria-label');
      }
    }
  }

  for (const name of tabNames) {
    const tab = $('tab-' + name);
    on(tab, 'click', () => {
      S.tab = name;
      applyLayout();
    });
    on(tab, 'keydown', (e) => {
      const i = tabNames.indexOf(name);
      const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!step && e.key !== 'Home' && e.key !== 'End') return;
      e.preventDefault();
      const next = tabNames[e.key === 'Home' ? 0 : e.key === 'End' ? tabNames.length - 1 : (i + step + tabNames.length) % tabNames.length];
      S.tab = next;
      applyLayout();
      const target = $('tab-' + next);
      if (target) target.focus();
    });
  }
  on(wideQuery, 'change', applyLayout);
  applyLayout();

  // After picking a card on a long page the map or the goal may be out of sight; bring them back, and do not jump when they are in view.
  // Phones pin the map to the top, so the playback bar and the goal come back right under it. From 1024 px the map is pinned in the
  // left column and the goal heads the rail (far above the card list), so the goal scrolls to the top of the window.
  function revealStage() {
    const behavior = reduced ? 'auto' : 'smooth';
    const r = el.stage.getBoundingClientRect();
    if (r.top < 0 || r.bottom > innerHeight) {
      el.stage.scrollIntoView({ behavior, block: 'start' });
      return;
    }
    const goal = $('h-goal') && $('h-goal').closest('.kn-goal');
    if (!goal) return;
    const pinned = getComputedStyle(el.stage).position === 'sticky';
    if (goal.getBoundingClientRect().top >= (pinned ? r.bottom : 0)) return;
    const grid = el.stage.closest('.kn-grid');
    if (pinned && grid) scrollBy({ top: grid.getBoundingClientRect().top - 8, behavior }); // the map's own place: all of it flows under the pinned map
    else goal.scrollIntoView({ behavior, block: 'start' });
  }

  // ---- About -------------------------------------------------------------------------------------------------------
  const about = document.querySelector('details.sed-about');

  function openAbout() {
    if (!about) return;
    about.open = true;
    const summary = about.querySelector('summary');
    about.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    if (summary) summary.focus({ preventScroll: true });
  }

  on(about, 'toggle', () => {
    if (!about.open) return;
    emit('about-open');
    const box = $('selftest-result');
    if (box && !box.querySelector('ul')) {
      setText(box, 'Running the physics checks...');
      clearTimeout(selftestTimer);
      selftestTimer = later(() => {
        if (!box.querySelector('ul')) setText(box, 'The checks did not finish in this browser; the team ran them while building the page.');
      }, 8000);
    }
  });

  // ---- keyboard ----------------------------------------------------------------------------------------------------
  // Single-character shortcuts (WCAG 2.1.4) can be switched off here, and never fire from links, the About panel or the footer.
  const KEYS_PREF = 'orbital.v1.keys';
  const keysBtn = $('btn-keys-toggle');
  let keysOn = true;
  try {
    keysOn = localStorage.getItem(KEYS_PREF) !== 'off';
  } catch (err) {
    keysOn = true; // storage is a convenience only
  }
  function renderKeysSwitch() {
    setText(keysBtn, keysOn ? 'Turn single-key shortcuts off' : 'Turn single-key shortcuts on');
  }
  renderKeysSwitch();
  on(keysBtn, 'click', () => {
    keysOn = !keysOn;
    try {
      localStorage.setItem(KEYS_PREF, keysOn ? 'on' : 'off');
    } catch (err) {
      // not saved; the switch still works for this visit
    }
    renderKeysSwitch();
    announce(keysOn ? 'Single-key shortcuts on.' : 'Single-key shortcuts off. Every action still has a button.');
  });

  const NATIVE_KEYS = new Set([' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

  function onKey(e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    const tag = t && t.tagName;
    const editing = tag === 'TEXTAREA' || (tag === 'INPUT' && t.type !== 'range' && !t.readOnly) || (t && t.isContentEditable);
    if (e.key === 'Escape') {
      const shareBox = $('share-url');
      if (shareBox && !shareBox.hidden && document.activeElement === shareBox) {
        shareBox.hidden = true;
        el['btn-share'].focus();
      } else if (about && about.open) {
        about.open = false;
        const summary = about.querySelector('summary');
        if (summary) summary.focus();
      } else {
        hideToast();
      }
      return;
    }
    if (editing) return;
    if (e.key === '?') {
      e.preventDefault();
      openAbout();
      return;
    }
    const isRange = tag === 'INPUT' && t.type === 'range';
    const isSelect = tag === 'SELECT';
    if ((isRange || isSelect) && NATIVE_KEYS.has(e.key)) return;
    if ((e.key === ' ' || e.key === 'Enter') && (tag === 'BUTTON' || tag === 'SUMMARY' || tag === 'A')) return;
    if (e.repeat) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k.length === 1 && k !== ' ' && (!keysOn || (t && t.closest && t.closest('a, summary, .sed-about, .sed-footer, .sed-header')))) return;
    switch (k) {
      case ' ': emit('toggle-play'); break;
      case 'r': emit('reset'); break;
      case 'd': emit('step', { days: 1 }); break;
      case 'v': emit('set-view', { view: S.view === 'flat' ? 'polar' : 'flat' }); break;
      case 't': emit('set-terminator', { on: !S.terminator }); break;
      case 'n': emit('add-sat'); break;
      case 'x': case 'Delete': emit('remove-sat', { index: S.sel }); break;
      case 's': emit('snap-repeat', { index: S.sel, dir: 0 }); break;
      case ',': emit('snap-repeat', { index: S.sel, dir: -1 }); break;
      case '.': emit('snap-repeat', { index: S.sel, dir: 1 }); break;
      case 'u': emit('tune-sso', { index: S.sel }); break;
      case 'p': emit('peek-par'); break;
      case 'l': emit('share'); break;
      case 'm': emit('randomize'); break;
      case '[': case ']': {
        const order = cardOrder();
        const next = clamp(order.indexOf(S.card) + (k === ']' ? 1 : -1), 0, order.length - 1);
        if (order[next] !== S.card) emit('pick-card', { id: order[next] });
        break;
      }
      case '1': case '2': case '3': {
        const i = Number(k) - 1;
        if (!isSelect && i < S.sats.length) emit('select-sat', { index: i });
        break;
      }
      default: return;
    }
    if (k === ' ') e.preventDefault();
  }
  on(document, 'keydown', onKey);

  // ---- pointer on the map: drag sets the start longitude, hover or press shows the stitch under the finger ------------
  const overlay = el.overlay;
  const ptr = { id: -1, mode: 'idle', type: '', x0: 0, y0: 0, node0: 0, prevAngle: 0, acc: 0, x: 0, y: 0, press: 0, frame: 0 };
  const readout = $('map-readout');

  function angleAt(x, y) {
    const r = overlay.getBoundingClientRect();
    return (Math.atan2(x - (r.left + r.width / 2), y - (r.top + r.height / 2)) * 180) / Math.PI;
  }

  function wrap180(v) {
    return ((((v + 180) % 360) + 360) % 360) - 180;
  }

  function hideReadout() {
    clearTimeout(readoutTimer);
    if (readout) readout.hidden = true;
    renderer.probe(null);
  }

  // A stitch is one degree of latitude by one of longitude: R^2 * (pi / 180) * (sin(top) - sin(bottom)) square kilometres.
  function showReadout(x, y) {
    const p = renderer.pick(x, y);
    if (!p || !readout) {
      hideReadout();
      return;
    }
    const top = ((90 - p.row) * Math.PI) / 180;
    const bottom = ((89 - p.row) * Math.PI) / 180;
    const area = EARTH_KM * EARTH_KM * (Math.PI / 180) * (Math.sin(top) - Math.sin(bottom));
    const passes = p.hits >= 255 ? '255 or more passes' : p.hits === 1 ? '1 pass' : p.hits ? p.hits + ' passes' : 'not knit yet';
    readout.textContent = latLonText(90 - p.row - 0.5, p.col - 179.5) + ' · ' + passes + ' · stitch ' + F0.format(area) + ' km²';
    readout.hidden = false;
    renderer.probe({ lat: 90 - p.row - 0.5, lon: p.col - 179.5 });
  }

  function dragTo(x, y) {
    const r = overlay.getBoundingClientRect();
    let delta;
    if (S.view === 'polar') {
      const a = angleAt(x, y);
      ptr.acc += wrap180(a - ptr.prevAngle);
      ptr.prevAngle = a;
      delta = ptr.acc;
    } else {
      delta = ((x - ptr.x0) / r.width) * 360;
    }
    const node = Math.round(wrap180(ptr.node0 + delta) * 10) / 10;
    emit('set-sat', { index: S.sel, patch: { node } });
  }

  function endPointer() {
    clearTimeout(ptr.press);
    cancelAnimationFrame(ptr.frame);
    ptr.frame = 0;
    ptr.id = -1;
    ptr.mode = 'idle';
  }

  on(overlay, 'pointerdown', (e) => {
    if (ptr.id !== -1 || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const sat = S.sats[S.sel];
    ptr.id = e.pointerId;
    ptr.type = e.pointerType;
    ptr.mode = 'pending';
    ptr.x0 = ptr.x = e.clientX;
    ptr.y0 = ptr.y = e.clientY;
    ptr.node0 = sat ? sat.node : 0;
    ptr.acc = 0;
    ptr.prevAngle = angleAt(e.clientX, e.clientY);
    try {
      overlay.setPointerCapture(e.pointerId);
    } catch (err) {
      logOnce('pointer capture', err);
    }
    if (e.pointerType !== 'mouse') {
      ptr.press = setTimeout(() => {
        if (ptr.mode !== 'pending') return;
        ptr.mode = 'probe';
        showReadout(ptr.x, ptr.y);
      }, 420);
    }
  });

  on(overlay, 'pointermove', (e) => {
    if (ptr.id === -1) {
      if (e.pointerType === 'mouse') showReadout(e.clientX, e.clientY);
      return;
    }
    if (e.pointerId !== ptr.id) return;
    ptr.x = e.clientX;
    ptr.y = e.clientY;
    if (ptr.mode === 'pending') {
      const dx = ptr.x - ptr.x0;
      const dy = ptr.y - ptr.y0;
      if (Math.hypot(dx, dy) < 6) return;
      clearTimeout(ptr.press);
      if (ptr.type !== 'mouse' && Math.abs(dy) > Math.abs(dx)) return; // a vertical swipe belongs to page scrolling
      ptr.mode = 'drag';
      hideReadout();
    }
    if (ptr.mode === 'drag') {
      if (!ptr.frame) {
        ptr.frame = requestAnimationFrame(() => {
          ptr.frame = 0;
          if (ptr.mode === 'drag') dragTo(ptr.x, ptr.y);
        });
      }
    } else if (ptr.mode === 'probe') {
      showReadout(ptr.x, ptr.y);
    }
  });

  const release = (e) => {
    if (e.pointerId !== ptr.id) return;
    const tap = ptr.mode === 'pending' && ptr.type !== 'mouse' && e.type === 'pointerup';
    if (ptr.mode === 'probe' || tap) {
      if (tap) showReadout(e.clientX, e.clientY);
      clearTimeout(readoutTimer);
      readoutTimer = later(hideReadout, tap ? 3500 : 1500);
    }
    endPointer();
  };
  on(overlay, 'pointerup', release);
  on(overlay, 'pointercancel', release);
  on(overlay, 'pointerleave', (e) => {
    if (ptr.id === -1 && e.pointerType === 'mouse') hideReadout();
  });
  on(overlay, 'contextmenu', (e) => e.preventDefault());

  // ---- frames ------------------------------------------------------------------------------------------------------
  // The renderer lets the night line go home about 0.7 s after fast motion stops, with no new frame from main, so poll for it.
  let frozenWatch = false;
  function watchFrozen() {
    if (frozenWatch) return;
    frozenWatch = true;
    later(() => {
      frozenWatch = false;
      const now = renderer.isSunFrozen();
      if (now !== S.frozen) {
        S.frozen = now;
        renderNotes();
      }
      if (now) watchFrozen();
    }, 900);
  }

  function draw(frame) {
    if (destroyed || !frame) return;
    try {
      const view = frame.view === 'polar' ? 'polar' : 'flat';
      if (el.stage.dataset.view !== view) {
        S.view = view;
        renderView();
      }
      renderer.draw(frame);
      const focusOn = !!(frame.focus && frame.focus.length);
      const frozen = renderer.isSunFrozen();
      if (focusOn !== S.focusOn || frozen !== S.frozen) {
        S.focusOn = focusOn;
        S.frozen = frozen;
        renderNotes();
      }
      if (frozen) watchFrozen();
      S.drawFails = 0;
    } catch (err) {
      logOnce('draw', err);
      S.drawFails++;
      if (S.drawFails >= 3) showFatal('the map could not be drawn');
    }
  }

  function onMotion(e) {
    reduced = e.matches;
  }
  const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
  on(motionQuery, 'change', onMotion);

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const [target, type, fn, opts] of listeners) target.removeEventListener(type, fn, opts);
    listeners.length = 0;
    for (const id of timers) clearTimeout(id);
    timers.clear();
    clearTimeout(announceTimer);
    clearTimeout(toastTimer);
    clearTimeout(selftestTimer);
    clearTimeout(readoutTimer);
    endPointer();
    renderer.destroy();
  }

  return { draw, destroy };
}
