// HUD, buttons, result dialog, toasts, live region and the coach line. This module owns every user-facing string:
// game.js only sends codes and numbers. All dynamic text goes through textContent, and update() touches the DOM only
// when a value actually changed.

const IDS = ['rink', 'hud-clock', 'hud-clock-l', 'hud-tank', 'hud-tank-fill', 'hud-tank-val', 'hud-gleam', 'hud-laps', 'hud-feet', 'hud-grade',
  'coach', 'rink-info', 'best', 'banner', 'banner-text', 'banner-action', 'toasts', 'live', 'veil', 'demo-chip',
  'btn-start', 'btn-practice', 'btn-watch', 'watch-select', 'btn-pause', 'btn-slow', 'btn-sound', 'btn-assist', 'btn-shake', 'btn-finish',
  'btn-restart', 'btn-result', 'seed-input', 'btn-seed-load', 'btn-seed-today', 'seed-note',
  'result', 'res-grade', 'res-title', 'res-line', 'res-meta', 'res-stats', 'res-challenge', 'postcard', 'share-text',
  'btn-copy-text', 'btn-copy-link', 'btn-save-card', 'btn-result-close', 'btn-result-again'];

const GRADES = {
  S: { name: 'Mirror', line: 'Skate-ready. Nobody can tell you were here.' },
  A: { name: 'Glass', line: 'Fast and clean. The crowd approves.' },
  B: { name: 'Sheen', line: 'Solid. A few scars survived.' },
  C: { name: 'Matte', line: 'Passable. The first period will leave marks.' },
  D: { name: 'Slush', line: 'The next period will be interesting.' },
};

const MISHAPS = {
  drip: 'leaky tank',
  hats: 'hat-trick aftermath',
  slush: 'slush patch',
  gate: 'jammed gate, refill door moved',
  puddle: 'puddle by the boards',
};

const REASONS = { complete: 'Every scar gleams', buzzer: 'Buzzer', finish: 'Called it' };
const PREFS = {
  sound: ['btn-sound', 'Sound on', 'Sound off', '#i-sound', '#i-mute'],
  assist: ['btn-assist', 'Guides on', 'Guides off', '#i-guide', '#i-guide-off'],
  shake: ['btn-shake', 'Shake on', 'Shake off', '#i-shake', '#i-shake-off'],
};

const T = {
  ready: 'Cover every scar before the buzzer. Steer with ← → or A D, or drag on the rink.',
  demoKeys: 'Demo lap. Press Enter to take the wheel.',
  demoTouch: 'Demo lap. Tap Start to take the wheel.',
  firstRun: 'The machine only goes forward. Turns need room.',
  timed: 'Cover every scar before the buzzer.',
  low: 'Water is low. The refill door is the gap in the boards.',
  dry: 'Tank dry: passes only shave now. Refill at the door.',
  practice: 'Practice lap. No clock, same rink.',
  paused: 'Paused.',
  bot: 'Bot lap at fast forward. Press any key to take over.',
  refilling: 'Refilling…',
  full: 'Tank full.',
  bump: 'Boards. The machine does not enjoy that.',
  m25: 'A quarter gleams.',
  m50: 'Half the sheet shines.',
  m75: 'Three quarters. Nearly skate-ready.',
  badLink: "That link looked odd, so you got today's rink.",
  badSeed: 'Seeds are 1 to 24 letters, digits, - or _.',
  storage: "Can't save settings here. Everything else works.",
  frame: 'Something slipped on the ice. Restart the lap.',
  beat: 'You beat the challenge.',
  copied: 'Copied.',
  copyBlocked: 'Copying is blocked here. The text is selected: press Ctrl+C or Cmd+C.',
  saveFailed: 'Could not make the card image here.',
  noSound: 'Sound unavailable in this browser',
};

function commas(n) { return String(Math.round(+n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function mmss(s) { return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
function challengeText(c) { return `Challenge loaded: grade ${c.grade} in ${commas(c.feet)} ft or less.`; }

export function createUI(root, actions) {
  const doc = (root && root.ownerDocument) || document;
  const E = {};
  for (const id of IDS) E[id] = doc.getElementById(id);
  const win = doc.defaultView || window;
  const mq = (q) => { try { return win.matchMedia(q); } catch (err) { return null; } };
  const mqReduce = mq('(prefers-reduced-motion: reduce)');
  const mqCoarse = mq('(pointer: coarse)');
  const hasAudio = !!(win.AudioContext || win.webkitAudioContext);

  const shown = {};
  let last = null;
  let prevPhase = '';
  let shownResult = null;
  let slowOn = false;
  let hashNote = '';
  let frameError = false;
  let userLoad = false;
  let cardLoad = null;
  let reported = false;
  let quiet = false;

  const call = (name, ...args) => {
    const fn = actions && actions[name];
    return typeof fn === 'function' ? fn.apply(actions, args) : undefined;
  };

  function put(key, node, text) {
    if (shown[key] === text) return;
    shown[key] = text;
    if (node) node.textContent = text;
  }

  function attr(key, node, name, value) {
    if (shown[key] === value) return;
    shown[key] = value;
    if (node) node.setAttribute(name, value);
  }

  function flag(key, node, cls, on) {
    if (shown[key] === on) return;
    shown[key] = on;
    if (node) node.classList.toggle(cls, on);
  }

  function show(key, node, on) {
    if (shown[key] === on) return;
    shown[key] = on;
    if (node) node.hidden = !on;
  }

  function label(btn) { return btn ? btn.querySelector('span:not(.rk-ic)') : null; }
  function iconUse(btn) { return btn ? btn.querySelector('use') : null; }

  function say(text) {
    const l = E.live;
    if (!l) return;
    l.textContent = l.textContent === text ? text + '\u00a0' : text;
  }

  function toast(text, error) {
    const host = E.toasts;
    if (!host) return;
    while (host.firstChild) host.removeChild(host.firstChild);
    const node = doc.createElement('div');
    node.className = error ? 'rk-toast is-error' : 'rk-toast';
    node.textContent = text;
    host.appendChild(node);
    setTimeout(() => {
      node.classList.add('is-out');
      setTimeout(() => node.remove(), mqReduce && mqReduce.matches ? 0 : 170);
    }, error ? 6000 : 3500);
  }

  function focusNode(node) {
    try { if (node) node.focus({ preventScroll: true }); } catch (err) { /* focus can fail on hidden nodes */ }
  }

  // ---- result dialog -------------------------------------------------------------------------------------------

  const statRows = [
    ['Gleam', (r) => (+r.gleamPct || 0).toFixed(1) + '%'],
    ['Scars left', (r) => commas(r.left)],
    ['Distance', (r) => commas(r.feet) + ' ft'],
    ['Tidy', (r) => Math.round(+r.tidyPct || 0) + '%'],
    ['Refills', (r) => commas(r.refills)],
    ['Bumps', (r) => commas(r.bumps)],
    ['Clean laps', (r) => commas(r.cleanLaps)],
    ['Points', (r) => commas(r.points)],
    ['Time', (r) => mmss(Math.max(0, Math.round(+r.seconds || 0)))],
  ];
  const statCells = [];
  if (E['res-stats']) {
    for (const [name] of statRows) {
      const row = doc.createElement('div');
      const dt = doc.createElement('dt');
      const dd = doc.createElement('dd');
      dt.textContent = name;
      row.append(dt, dd);
      E['res-stats'].append(row);
      statCells.push(dd);
    }
  }

  function drawCard(result) {
    const canvas = E.postcard;
    if (!canvas) return;
    const done = (fn) => {
      const ok = typeof fn === 'function';
      canvas.hidden = !ok;
      if (E['btn-save-card']) E['btn-save-card'].hidden = !ok;
      if (!ok) return;
      try { fn(canvas, result); } catch (err) { canvas.hidden = true; if (E['btn-save-card']) E['btn-save-card'].hidden = true; }
    };
    if (!cardLoad) cardLoad = import('./postcard.js').then((mod) => mod.drawPostcard, () => null);
    cardLoad.then(done);
  }

  function fillResult(result, view) {
    const g = GRADES[result.grade] ? result.grade : 'D';
    const dlg = E.result;
    if (dlg && dlg.firstElementChild) dlg.firstElementChild.setAttribute('data-grade', g);
    if (E['res-grade']) { E['res-grade'].textContent = g; E['res-grade'].setAttribute('aria-label', 'Grade ' + g); }
    if (E['res-title']) E['res-title'].textContent = GRADES[g].name;
    if (E['res-line']) E['res-line'].textContent = GRADES[g].line;
    if (E['res-meta']) {
      E['res-meta'].textContent = `Rink ${result.seed || (view && view.seed) || ''} · ${REASONS[result.reason] || 'Done'}${result.mode === 'practice' ? ' · Practice' : ''}`;
    }
    statRows.forEach((row, i) => { if (statCells[i]) statCells[i].textContent = row[1](result); });
    const ch = E['res-challenge'];
    const c = view && view.challenge;
    if (ch) {
      if (c && typeof result.beat === 'boolean') {
        ch.hidden = false;
        ch.classList.toggle('is-lost', !result.beat);
        ch.textContent = result.beat ? T.beat : `Not this time: grade ${c.grade} in ${commas(c.feet)} ft is the bar.`;
      } else ch.hidden = true;
    }
    setShareText();
    drawCard(result);
  }

  function setShareText() {
    const ta = E['share-text'];
    if (!ta) return;
    try { ta.value = String(call('shareText') || ''); } catch (err) { ta.value = ''; }
  }

  function openDialog() {
    const d = E.result;
    if (!d || d.open) return;
    try {
      if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
    } catch (err) { return; }
    focusNode(E['res-title']);
  }

  function closeDialog() {
    const d = E.result;
    if (!d || !d.open) return;
    try { if (typeof d.close === 'function') d.close(); else d.removeAttribute('open'); } catch (err) { /* already closed */ }
  }

  async function copyOut(text) {
    let ok = false;
    try {
      if (win.navigator.clipboard && win.navigator.clipboard.writeText) { await win.navigator.clipboard.writeText(text); ok = true; }
    } catch (err) { ok = false; }
    if (ok) { toast(T.copied); return; }
    const ta = E['share-text'];
    if (ta) {
      ta.value = text;
      focusNode(ta);
      try { ta.select(); ta.setSelectionRange(0, text.length); } catch (err) { /* selection is best effort */ }
    }
    toast(T.copyBlocked);
  }

  function saveCard() {
    const canvas = E.postcard;
    if (!canvas || typeof canvas.toBlob !== 'function') return;
    canvas.toBlob((blob) => {
      if (!blob) { toast(T.saveFailed, true); return; }
      const href = win.URL.createObjectURL(blob);
      const anchor = doc.createElement('a');
      anchor.href = href;
      anchor.download = 'between-periods-' + String((last && last.seed) || 'rink').replace(/[^A-Za-z0-9_-]/g, '') + '.png';
      doc.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => win.URL.revokeObjectURL(href), 4000);
    }, 'image/png');
  }

  // ---- actions -------------------------------------------------------------------------------------------------

  function againFromResult() {
    quiet = !!(E.result && E.result.open);
    closeDialog();
    if (last && last.phase === 'done') call('start', last.result && last.result.mode === 'practice' ? 'practice' : 'timed');
    else call('restart');
  }

  function loadSeedFromInput() {
    const input = E['seed-input'];
    const note = E['seed-note'];
    const raw = input ? String(input.value || '').trim() : '';
    userLoad = true;
    if (!raw) { call('loadToday'); return; }
    const res = call('loadSeed', raw);
    const ok = !!(res && res.ok);
    if (input) input.setAttribute('aria-invalid', ok ? 'false' : 'true');
    if (note) {
      note.textContent = ok ? '' : T.badSeed;
      note.classList.toggle('is-error', !ok);
    }
    if (!ok) userLoad = false;
  }

  function togglePref(name) {
    const v = last;
    call('setPref', name, !(v && v.prefs && v.prefs[name]));
  }

  function setSlow(on) {
    slowOn = on;
    call('setSlow', on);
    attr('slow', E['btn-slow'], 'aria-pressed', on ? 'true' : 'false');
  }

  function on(id, type, fn) {
    const node = E[id];
    if (!node) return;
    node.addEventListener(type, (e) => {
      try { fn(e); } catch (err) { fail(err); }
    });
  }

  function fail(err) {
    if (reported) return;
    reported = true;
    try {
      doc.dispatchEvent(new CustomEvent('app:error', { detail: { where: 'ui', message: String((err && err.message) || err), fatal: false } }));
    } catch (e) { /* nothing left to tell */ }
  }

  on('btn-start', 'click', () => call('start', 'timed'));
  on('btn-practice', 'click', () => call('start', 'practice'));
  on('btn-watch', 'click', () => {
    const v = E['watch-select'] ? E['watch-select'].value : 'mow';
    call('watch', v === 'spiral' || v === 'race' ? v : 'mow');
  });
  on('btn-pause', 'click', () => call('togglePause'));
  on('btn-slow', 'click', () => setSlow(!slowOn));
  on('btn-sound', 'click', () => togglePref('sound'));
  on('btn-assist', 'click', () => togglePref('assist'));
  on('btn-shake', 'click', () => togglePref('shake'));
  on('btn-finish', 'click', () => call('finish'));
  on('btn-restart', 'click', againFromResult);
  on('btn-result', 'click', () => { if (last && last.result) { fillResult(last.result, last); openDialog(); } });
  on('btn-seed-load', 'click', loadSeedFromInput);
  on('btn-seed-today', 'click', () => {
    userLoad = true;
    if (E['seed-note']) E['seed-note'].textContent = '';
    if (E['seed-input']) E['seed-input'].setAttribute('aria-invalid', 'false');
    call('loadToday');
  });
  on('seed-input', 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); loadSeedFromInput(); } });
  on('seed-input', 'input', () => {
    if (E['seed-input']) E['seed-input'].setAttribute('aria-invalid', 'false');
    if (E['seed-note']) E['seed-note'].textContent = '';
  });
  on('banner-action', 'click', () => {
    frameError = false;
    call('restart');
    if (last && last.phase === 'ready') call('start', 'timed');
  });
  on('btn-result-close', 'click', closeDialog);
  on('btn-result-again', 'click', againFromResult);
  on('btn-copy-text', 'click', () => copyOut(String(call('shareText') || '')));
  on('btn-copy-link', 'click', () => copyOut(String(call('shareLink') || '')));
  on('btn-save-card', 'click', saveCard);
  on('result', 'click', (e) => { if (e.target === E.result) closeDialog(); });
  on('result', 'close', () => {
    if (quiet) { quiet = false; return; }
    if (last && last.phase === 'done') focusNode(E['btn-restart']);
  });

  if (E['btn-sound'] && !hasAudio) {
    E['btn-sound'].disabled = true;
    E['btn-sound'].title = T.noSound;
  }

  // ---- first-screen fit ----------------------------------------------------------------------------------------------
  // The stylesheet caps the rink at 100dvh minus --rk-chrome, the room the rest of the first screen needs (header, title,
  // HUD, control bar). Wrapping text and the challenge banner change that number, so it is measured instead of guessed; the
  // CSS values stay as the fallback. Nothing here touches the layout except that one custom property.
  let fitFrame = 0;
  function chromeNow() {
    const wrap = root.querySelector('.rk-rinkwrap');
    const bar = root.querySelector('.rk-bar');
    if (!wrap || !bar) return 0;
    // The primary button is the first visible one in the bar (Start intermission, or Pause); a second row of quiet buttons may wrap below.
    const primary = Array.from(bar.querySelectorAll('.rk-primary')).find((el) => el.getClientRects().length > 0);
    const w = wrap.getBoundingClientRect();
    const b = (primary || bar).getBoundingClientRect();
    return w.height > 0 && b.height > 0 ? Math.ceil(w.top + win.scrollY + (b.bottom - w.bottom)) + 4 : 0;
  }
  function fitFirstScreen() {
    fitFrame = 0;
    try {
      root.style.removeProperty('--rk-chrome');
      let chrome = chromeNow();
      for (let i = 0; i < 4 && chrome > 0; i++) {
        root.style.setProperty('--rk-chrome', chrome + 'px');
        const next = chromeNow();
        if (next <= chrome) return;
        chrome = next;
      }
      if (chrome > 0) root.style.setProperty('--rk-chrome', chrome + 'px');
    } catch (err) { /* the CSS fallback stays in force */ }
  }
  function scheduleFit() {
    if (!fitFrame) fitFrame = win.requestAnimationFrame(fitFirstScreen);
  }
  win.addEventListener('resize', scheduleFit);
  if (doc.fonts && doc.fonts.ready) doc.fonts.ready.then(scheduleFit, () => {});
  scheduleFit();

  // ---- events from game.js (codes and numbers only) ------------------------------------------------------------

  doc.addEventListener('app:note', (e) => {
    try {
      const d = e.detail || {};
      const n = +d.n || 0;
      switch (d.code) {
        case 'tank-low': say(T.low); break;
        case 'tank-empty': toast(T.dry, true); say(T.dry); break;
        case 'refill-start': toast(T.refilling); say(T.refilling); break;
        case 'refill-done': toast(T.full); say(T.full); break;
        case 'bump': if (n === 1 || n % 5 === 0) toast(T.bump); break;
        case 'milestone': { const t = n === 25 ? T.m25 : n === 50 ? T.m50 : n === 75 ? T.m75 : ''; if (t) { toast(t); say(t); } break; }
        case 'bad-hash': case 'bad-seed': hashNote = d.code; toast(T.badLink, true); say(T.badLink); break;
        case 'storage-off': toast(T.storage); say(T.storage); break;
        case 'autoplay': toast(T.bot); say(T.bot); break;
        case 'challenge': if (last && last.challenge) say(challengeText(last.challenge)); break;
        default: break;
      }
    } catch (err) { fail(err); }
  });

  doc.addEventListener('app:phase', (e) => {
    try {
      const d = e.detail || {};
      if (d.reason === 'start' || d.reason === 'restart') {
        frameError = false;
        hashNote = '';
        if (d.phase === 'playing') focusNode(E.rink);
      }
      if (d.reason === 'load') {
        frameError = false;
        if (userLoad) hashNote = '';
        userLoad = false;
      }
      if (d.phase === 'paused') say(T.paused);
      else if (d.reason === 'resume') say('Resumed.');
    } catch (err) { fail(err); }
  });

  doc.addEventListener('app:finish', (e) => {
    try {
      const r = (e.detail && e.detail.result) || (last && last.result);
      if (!r) return;
      const g = GRADES[r.grade] || GRADES.D;
      say(`Grade ${r.grade}, ${g.name}. ${g.line} ${(+r.gleamPct || 0).toFixed(1)} percent gleam, ${commas(r.feet)} feet.`);
    } catch (err) { fail(err); }
  });

  doc.addEventListener('app:error', (e) => {
    try {
      const d = e.detail || {};
      if (d.fatal) return;
      if (d.where === 'frame' || d.where === 'render') { frameError = true; say(T.frame); } else toast(T.frame, true);
    } catch (err) { /* the error reporter must not throw */ }
  });

  // ---- per-frame diffed update ---------------------------------------------------------------------------------

  function coachFor(v) {
    const m = v.m || {};
    if (v.phase === 'paused') return T.paused;
    if (v.phase === 'done' && v.result) return (GRADES[v.result.grade] || GRADES.D).line;
    if (v.mode === 'auto') return T.bot;
    if (v.phase === 'playing') {
      if (m.tankMax > 0 && m.tank <= 0) return T.dry;
      if (m.tankMax > 0 && (100 * m.tank) / m.tankMax < 25) return T.low;
      if (v.mode === 'practice') return T.practice;
      return !v.best && v.tick < 900 ? T.firstRun : T.timed;
    }
    if (v.phase === 'ready' && v.mode === 'attract') return mqCoarse && mqCoarse.matches ? T.demoTouch : T.demoKeys;
    return '';
  }

  function updateHud(v) {
    const st = v.stats || {};
    const m = v.m || {};
    const hz = (v.rink && v.rink.tune && v.rink.tune.tickHz) || 60;
    const timed = v.clockTicks > 0;
    const secs = timed ? Math.max(0, Math.ceil((v.clockTicks - v.tick) / hz)) : Math.floor(v.tick / hz);
    if (shown.secs !== secs || shown.timed !== timed) {
      shown.secs = secs;
      shown.timed = timed;
      if (E['hud-clock']) E['hud-clock'].textContent = mmss(secs);
      if (E['hud-clock-l']) E['hud-clock-l'].textContent = timed ? 'Time' : 'Elapsed';
    }
    flag('warn', E['hud-clock'] && E['hud-clock'].parentElement, 'is-warn', timed && secs <= 10 && v.phase === 'playing');
    const g10 = Math.round((+st.gleamPct || 0) * 10);
    if (shown.g10 !== g10) { shown.g10 = g10; if (E['hud-gleam']) E['hud-gleam'].textContent = (g10 / 10).toFixed(1) + '%'; }
    const laps = st.cleanLaps | 0;
    if (shown.laps !== laps) { shown.laps = laps; if (E['hud-laps']) E['hud-laps'].textContent = String(laps); }
    const feet = Math.round(+st.feet || 0);
    if (shown.feet !== feet) { shown.feet = feet; if (E['hud-feet']) E['hud-feet'].textContent = commas(feet) + ' ft'; }
    put('grade', E['hud-grade'], st.grade || 'D');

    const max = m.tankMax > 0 ? m.tankMax : 100;
    const exact = Math.max(0, Math.min(100, (100 * (+m.tank || 0)) / max));
    const pct = Math.round(exact);
    const q = Math.round(exact * 2) / 2;
    if (shown.fill !== q) { shown.fill = q; if (E['hud-tank']) E['hud-tank'].style.setProperty('--fill', String(q)); }
    if (shown.pct !== pct) {
      shown.pct = pct;
      if (E['hud-tank']) { E['hud-tank'].setAttribute('aria-valuenow', String(pct)); E['hud-tank'].setAttribute('aria-valuetext', pct + ' percent'); }
      if (E['hud-tank-val']) E['hud-tank-val'].textContent = pct + '%';
    }
    const dry = !!m.dry || (m.tankMax > 0 && m.tank <= 0);
    flag('dry', E['hud-tank'], 'is-dry', dry);
    flag('low', E['hud-tank'], 'is-low', !dry && pct < 25);
  }

  function updateControls(v) {
    const prefs = v.prefs || {};
    for (const name of Object.keys(PREFS)) {
      const [id, onText, offText, onIcon, offIcon] = PREFS[name];
      const btn = E[id];
      if (!btn) continue;
      const pressed = !!prefs[name];
      attr('pref-' + name, btn, 'aria-pressed', pressed ? 'true' : 'false');
      const lab = btn.querySelector('.rk-lab');
      put('lab-' + name, lab, pressed ? onText : offText);
      attr('ico-' + name, iconUse(btn), 'href', pressed ? onIcon : offIcon);
    }
    const paused = v.phase === 'paused';
    put('pause-l', label(E['btn-pause']), paused ? 'Resume' : 'Pause');
    attr('pause-i', iconUse(E['btn-pause']), 'href', paused ? '#i-play' : '#i-pause');
    show('veil', E.veil, paused);
    show('demo', E['demo-chip'], v.phase === 'ready' && v.mode === 'attract');
    if (E['demo-chip']) attr('demo-t', E['demo-chip'], 'title', mqCoarse && mqCoarse.matches ? T.demoTouch : T.demoKeys);
    if (slowOn && v.phase !== 'playing') setSlow(false);
  }

  function updateInfo(v) {
    const seed = String(v.seed || '');
    if (shown.seed !== seed) {
      shown.seed = seed;
      const input = E['seed-input'];
      if (input && doc.activeElement !== input) input.value = seed;
    }
    const mishapId = (v.rink && v.rink.mishap && v.rink.mishap.id) || '';
    const infoKey = seed + '|' + mishapId;
    if (shown.infoKey !== infoKey) {
      shown.infoKey = infoKey;
      const mishap = MISHAPS[mishapId];
      if (E['rink-info']) E['rink-info'].textContent = `Rink ${seed}. Daily rinks use the UTC date; type another seed for a different sheet.${mishap ? ` Mishap: ${mishap} (invented).` : ''}`;
    }
    const b = v.best;
    const bestKey = b ? b.grade + '|' + b.points + '|' + b.feet : '';
    if (shown.bestKey !== bestKey) {
      shown.bestKey = bestKey;
      if (E.best) E.best.textContent = 'Best on this rink: ' + (b ? `${b.grade}, ${commas(b.points)} pts, ${commas(b.feet)} ft` : 'None yet');
    }
  }

  function updateBanner(v) {
    const c = v.challenge;
    const key = frameError ? 'frame' : hashNote ? 'link' : c ? 'c|' + c.grade + '|' + c.feet : '';
    if (shown.bannerKey !== key) {
      shown.bannerKey = key;
      const text = key === 'frame' ? T.frame : key === 'link' ? T.badLink : c ? challengeText(c) : '';
      if (E['banner-text']) E['banner-text'].textContent = text;
      scheduleFit();
    }
    show('banner-on', E.banner, key !== '');
    flag('banner-err', E.banner, 'is-error', frameError);
    flag('banner-pad', root, 'has-banner', key !== '');
    show('banner-btn', E['banner-action'], frameError);
  }

  function update(v) {
    if (!v) return;
    last = v;
    try {
      if (v.phase !== prevPhase) {
        prevPhase = v.phase;
        if (v.phase !== 'done') closeDialog();
        scheduleFit();
      }
      if (v.phase === 'done' && v.result && v.result !== shownResult) {
        shownResult = v.result;
        fillResult(v.result, v);
        openDialog();
      } else if (!v.result) shownResult = null;
      updateHud(v);
      updateControls(v);
      put('coach', E.coach, coachFor(v));
      updateInfo(v);
      updateBanner(v);
    } catch (err) { fail(err); }
  }

  return { update };
}
