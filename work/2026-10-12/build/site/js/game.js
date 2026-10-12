// Between Periods: the game around the sim. A fixed 60 Hz loop, keyboard and pointer steering, the
// phases (ready, playing, paused, done), preferences, URL-hash state and the app:* events. The view
// object it hands to the renderer and the UI is one object mutated in place every frame.

import { TICK_HZ, TUNING, GRADES, createRink, createSim, atan2q } from './sim.js';
import { PLANNERS, makePlanner } from './bot.js';
import { parseHash, buildHash, todaySeed, isValidSeed, beats, shareText as buildShareText } from './share.js';

const STORE_KEY = 'sed.between-periods.v1';
const MAX_BEST = 40;
const TICK_MS = 1000 / TICK_HZ;
const FRAME_CAP_MS = 50;
const DEMO_RUNIN = 2100;     // ticks the attract lap has driven before the first frame
const DEMO_MAX = 5400;       // the attract lap restarts when it passes this
const TWO_PI = 6.283185307179586;
const DEAD_ZONE = (8 * Math.PI) / 180;
const FULL_LOCK = (25 * Math.PI) / 180;
const MILESTONES = [25, 50, 75];

export function createGame({ canvas, toLogical }) {
  const tankMax = TUNING.tankMax;
  const view = {
    v: 1, phase: 'boot', mode: 'attract', seed: '', seedIsToday: false,
    rink: null, gridVersion: 0,
    grid: { cols: 0, rows: 0, cell: TUNING.cell, scar: null, reach: null, done: null },
    fresh: { idx: new Int32Array(0), n: -1 },
    tick: 0, clockTicks: 0,
    m: { x: 0, y: 0, a: 0, speed: 0, steer: 0, tank: tankMax, tankMax, door: false, dry: false, contact: false },
    stats: { gleamPct: 0, left: 0, feet: 0, tidyPct: 100, refills: 0, bumps: 0, cleanLaps: 0, points: 0, grade: 'D' },
    arcs: { now: new Float32Array(48), left: new Float32Array(48), right: new Float32Array(48), n: 0 },
    aim: null, challenge: null, best: null,
    prefs: { sound: false, assist: true, shake: true },
    result: null,
  };
  const frameCbs = [];
  const scratchStats = {};
  const aimPoint = { x: 0, y: 0 };
  const keys = { left: false, right: false, down: false };
  const best = new Map();

  let rink = null, sim = null, planner = null;
  let phase = 'boot', mode = 'attract', seed = '';
  let challenge = null, lastTimed = null, lastHash = null;
  let acc = 0, last = 0, raf = 0, speedMul = 1, perFrame = 4, alpha = 1;
  let px = 0, py = 0, pa = 0;
  let slowToggle = false, aimOn = false, pointerId = -1, pointerType = '';
  let nextMilestone = 0, reduced = false, faulted = false, storageWarned = false, destroyed = false;
  let bootResolve = null, booted = false;

  // ---- events and faults ------------------------------------------------------------------------

  function emit(name, detail) {
    document.dispatchEvent(new CustomEvent('app:' + name, { detail }));
  }

  // One report per fault episode: a console line and an app:error event, then the run is paused.
  function fault(where, err) {
    if (!faulted) {
      faulted = true;
      console.error('Between Periods:', where, err);
      emit('error', { where, message: String((err && err.message) || err).slice(0, 200), fatal: false });
    }
    if (phase === 'playing') setPhase('paused', mode, 'pause');
  }

  const guard = (where, fn) => (...args) => {
    try {
      return fn(...args);
    } catch (err) {
      fault(where, err);
      return undefined;
    }
  };

  // Listeners run synchronously, so the view is brought up to date before the event goes out.
  function setPhase(next, nextMode, reason) {
    phase = next;
    mode = nextMode;
    view.phase = next;
    view.mode = nextMode;
    if (sim !== null) syncView();
    const el = document.documentElement;
    el.dataset.phase = next;
    el.dataset.mode = nextMode;
    emit('phase', { phase: next, mode: nextMode, seed, reason });
  }

  // ---- stored preferences and best results ------------------------------------------------------

  function storageOff() {
    if (!storageWarned) {
      storageWarned = true;
      emit('note', { code: 'storage-off' });
    }
  }

  function validBest(entry) {
    return Array.isArray(entry) && entry.length === 3 && Number.isInteger(entry[0]) && entry[0] >= 0 && entry[0] <= 1000 &&
      GRADES.includes(entry[1]) &&
      Number.isInteger(entry[2]) && entry[2] >= 0 && entry[2] <= 99999;
  }

  function loadStore() {
    view.prefs.shake = !reduced;
    let raw = null;
    try {
      raw = window.localStorage.getItem(STORE_KEY);
    } catch (err) {
      storageOff();
      return;
    }
    if (raw === null) return;
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      storageOff();
      return;
    }
    if (!data || typeof data !== 'object' || data.v !== 1 || typeof data.sound !== 'boolean' || typeof data.assist !== 'boolean' ||
        typeof data.shake !== 'boolean' || !data.best || typeof data.best !== 'object') {
      storageOff();
      return;
    }
    view.prefs.sound = data.sound;
    view.prefs.assist = data.assist;
    view.prefs.shake = data.shake;
    for (const key of Object.keys(data.best)) {
      if (isValidSeed(key) && validBest(data.best[key]) && best.size < MAX_BEST) best.set(key, data.best[key]);
    }
  }

  function saveStore() {
    const bestObj = {};
    best.forEach((v, k) => { bestObj[k] = v; });
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify({
        v: 1, sound: view.prefs.sound, assist: view.prefs.assist, shake: view.prefs.shake, best: bestObj,
      }));
    } catch (err) {
      storageOff();
    }
  }

  function refreshBest() {
    const b = best.get(seed);
    view.best = b ? { points: b[0], grade: b[1], feet: b[2] } : null;
  }

  function recordBest(result) {
    const old = best.get(seed);
    if (old && (old[0] > result.points || (old[0] === result.points && old[2] <= result.feet))) return;
    best.delete(seed);
    best.set(seed, [result.points, result.grade, result.feet]);
    if (best.size > MAX_BEST) best.delete(best.keys().next().value);
    saveStore();
    refreshBest();
  }

  // ---- the URL hash -----------------------------------------------------------------------------

  function baseUrl() {
    const o = window.location.origin;
    return (o && o !== 'null' ? o : 'file://') + window.location.pathname;
  }

  function writeHash() {
    const h = buildHash({ seed, challenge: lastTimed || challenge });
    lastHash = h;
    try {
      if (window.location.hash.slice(1) !== h) window.history.replaceState(null, '', '#' + h);
    } catch (err) {
      // Some sandboxes forbid replaceState; the page still works, it just cannot mirror its state.
    }
  }

  // ---- the rink, the demo lap and the runs ------------------------------------------------------

  // Point the view at the current sim. The renderer rebuilds its layers when gridVersion changes.
  function attach() {
    view.rink = rink;
    view.grid.cols = rink.cols;
    view.grid.rows = rink.rows;
    view.grid.cell = rink.cell;
    view.grid.scar = rink.scar;
    view.grid.reach = rink.reach;
    view.grid.done = sim.grid.done;
    view.fresh = sim.fresh;
    view.gridVersion++;
    view.result = null;
    px = sim.m.x; py = sim.m.y; pa = sim.m.a;
    acc = 0;
    alpha = 1;
    nextMilestone = 0;
  }

  function startDemo() {
    sim = createSim(rink, { timed: true });
    planner = makePlanner(PLANNERS[rink.id % PLANNERS.length], rink, {});
    for (let i = 0; i < DEMO_RUNIN && sim.ended === null && !planner.done; i++) {
      const c = planner.control(sim);
      sim.step(c.steer, c.slow);
    }
    sim.clearFresh();
    view.clockTicks = rink.tune.clockTicks;
    speedMul = 1;
    perFrame = 4;
    attach();
  }

  function enterReady(reason) {
    startDemo();
    refreshBest();
    setPhase('ready', 'attract', reason);
    writeHash();
    settleBoot();
  }

  function loadRink(nextSeed, nextChallenge, reason) {
    seed = nextSeed;
    rink = createRink(seed);
    challenge = nextChallenge;
    lastTimed = null;
    faulted = false;
    view.seed = seed;
    view.seedIsToday = seed === todaySeed(Date.now());
    view.challenge = challenge;
    enterReady(reason);
  }

  function beginRun(runMode, why, botName, multiplier) {
    sim = createSim(rink, { timed: runMode !== 'practice' });
    planner = runMode === 'auto' ? makePlanner(botName, rink, {}) : null;
    view.clockTicks = runMode === 'practice' ? 0 : rink.tune.clockTicks;
    speedMul = multiplier || 1;
    perFrame = multiplier >= 16 ? 16 : 4;
    faulted = false;
    attach();
    setPhase('playing', runMode, why);
    if (runMode === 'auto') emit('note', { code: 'autoplay', n: speedMul });
  }

  function applyHash(parsed, reason) {
    if (parsed.note) emit('note', { code: parsed.note });
    loadRink(parsed.seed, parsed.challenge, reason);
    if (parsed.challenge) emit('note', { code: 'challenge' });
    if (parsed.auto) beginRun('auto', 'start', parsed.auto, 16);
  }

  function finishRun() {
    const runMode = mode;
    const result = sim.result(runMode, seed);
    // Only the player's own timed lap answers a challenge. A bot lap (Watch a lap, #a=) or a practice lap keeps
    // beat null, so the result card never claims the visitor beat, or missed, a bar they did not drive.
    if (challenge && runMode === 'timed') result.beat = beats(result, challenge);
    if (runMode === 'timed') {
      lastTimed = { grade: result.grade, feet: result.feet };
      recordBest(result);
    }
    sim.stats(view.stats);
    view.result = result;
    view.aim = null;
    writeHash();
    setPhase('done', runMode, 'finish');
    emit('finish', { result });
  }

  // ---- steering -----------------------------------------------------------------------------------

  function aimSteer() {
    if (!aimOn) return 0;
    const m = sim.m, dx = aimPoint.x - m.x, dy = aimPoint.y - m.y, reachR = 1.5 * TUNING.radius;
    if (dx * dx + dy * dy < reachR * reachR) return 0;
    let d = atan2q(dy, dx) - m.a;
    d -= TWO_PI * Math.floor((d + Math.PI) / TWO_PI);
    const mag = d < 0 ? -d : d;
    if (mag <= DEAD_ZONE) return 0;
    const s = Math.min(1, (mag - DEAD_ZONE) / (FULL_LOCK - DEAD_ZONE));
    return d < 0 ? -s : s;
  }

  function playerSteer() {
    let s;
    if (keys.left || keys.right) s = keys.left && keys.right ? 0 : keys.left ? -1 : 1;
    else s = aimSteer();
    return Math.round(s * 32);
  }

  function noteFlags(f) {
    if (f & 1) emit('note', { code: 'bump', n: sim.stats(scratchStats).bumps });
    if (f & 2) emit('note', { code: 'refill-start' });
    if (f & 4) emit('note', { code: 'refill-done' });
    if (f & 8) emit('note', { code: 'tank-low', n: Math.round((100 * sim.m.tank) / tankMax) });
    if (f & 16) emit('note', { code: 'tank-empty' });
  }

  function tickOnce() {
    px = sim.m.x; py = sim.m.y; pa = sim.m.a;
    let flags;
    if (planner !== null) {
      const c = planner.control(sim);
      flags = sim.step(c.steer, c.slow);
      if (flags & 32) finishRun();
      else if (planner.done) {
        sim.finish();
        finishRun();
      }
      return;
    }
    flags = sim.step(playerSteer(), keys.down || slowToggle ? 1 : 0);
    noteFlags(flags);
    if (flags & 32) finishRun();
  }

  // ---- the frame ----------------------------------------------------------------------------------

  function advance(dt) {
    if (phase === 'playing') {
      acc += dt * speedMul;
      let n = 0;
      while (acc >= TICK_MS && n < perFrame && phase === 'playing') {
        tickOnce();
        acc -= TICK_MS;
        n++;
      }
      if (acc > TICK_MS) acc = 0;
    } else if (phase === 'ready' && !reduced) {
      acc += dt;
      let n = 0;
      while (acc >= TICK_MS && n < 4) {
        px = sim.m.x; py = sim.m.y; pa = sim.m.a;
        const c = planner.control(sim);
        sim.step(c.steer, c.slow);
        acc -= TICK_MS;
        n++;
        if (sim.ended !== null || planner.done || sim.tick > DEMO_MAX) {
          startDemo();
          break;
        }
      }
      if (acc > TICK_MS) acc = 0;
    }
    const smooth = (phase === 'playing' || (phase === 'ready' && !reduced)) && speedMul === 1;
    alpha = smooth ? acc / TICK_MS : 1;
  }

  function syncView() {
    const m = sim.m, vm = view.m;
    vm.x = px + (m.x - px) * alpha;
    vm.y = py + (m.y - py) * alpha;
    let da = m.a - pa;
    if (da > Math.PI) da -= TWO_PI;
    else if (da < -Math.PI) da += TWO_PI;
    vm.a = pa + da * alpha;
    vm.speed = m.speed;
    vm.steer = m.steer / 32;
    vm.tank = m.tank;
    vm.door = m.door;
    vm.dry = m.dry;
    vm.contact = m.contact;
    view.tick = sim.tick;
    sim.stats(view.stats);
    const player = planner === null && (phase === 'playing' || phase === 'paused');
    view.aim = player && aimOn ? aimPoint : null;
    const arcs = view.arcs;
    if (player && view.prefs.assist) {
      arcs.n = sim.predict(m.steer, arcs.now);
      sim.predict(-32, arcs.left);
      sim.predict(32, arcs.right);
    } else {
      arcs.n = 0;
    }
    if (player && phase === 'playing') {
      while (nextMilestone < MILESTONES.length && view.stats.gleamPct >= MILESTONES[nextMilestone]) {
        emit('note', { code: 'milestone', n: MILESTONES[nextMilestone++] });
      }
    }
  }

  function frame(t) {
    raf = 0;
    if (destroyed || document.hidden) return;
    try {
      const dt = last === 0 ? TICK_MS : Math.min(FRAME_CAP_MS, Math.max(0, t - last));
      last = t;
      advance(dt);
      syncView();
      for (let i = 0; i < frameCbs.length; i++) frameCbs[i](view, t);
      sim.clearFresh();
    } catch (err) {
      fault('frame', err);
    }
    schedule();
  }

  function schedule() {
    if (raf === 0 && !destroyed && !document.hidden) raf = window.requestAnimationFrame(frame);
  }

  function drawNow() {
    syncView();
    const t = window.performance.now();
    for (let i = 0; i < frameCbs.length; i++) frameCbs[i](view, t);
    sim.clearFresh();
  }

  // ---- actions ------------------------------------------------------------------------------------

  const running = () => phase === 'playing' || phase === 'paused';

  function start(runMode) {
    const want = runMode === 'practice' ? 'practice' : 'timed';
    if (phase === 'ready' || phase === 'done') beginRun(want, 'start');
    else if (running()) beginRun(want, 'restart');
  }

  function pause(reason) {
    if (phase !== 'playing') return;
    keys.left = keys.right = keys.down = false;
    setPhase('paused', mode, reason || 'pause');
  }

  function resume() {
    if (phase !== 'paused') return;
    acc = 0;
    last = 0;
    setPhase('playing', mode, 'resume');
  }

  function restart() {
    if (!running() && phase !== 'done') return;
    if (mode === 'auto') enterReady('restart');
    else beginRun(mode, 'restart');
  }

  function finish() {
    if (!running() || mode === 'auto') return;
    sim.finish();
    finishRun();
  }

  function cancelAuto() {
    if (phase === 'playing' && mode === 'auto') enterReady('cancel');
  }

  function loadSeed(text) {
    const s = typeof text === 'string' ? text.trim() : '';
    if (!isValidSeed(s)) return { ok: false, seed, code: 'bad-seed' };
    loadRink(s, null, 'load');
    return { ok: true, seed, code: '' };
  }

  function loadToday() {
    loadRink(todaySeed(Date.now()), null, 'load');
  }

  function watch(name) {
    if (phase !== 'ready' && phase !== 'done' && !(phase === 'playing' && mode === 'auto')) return;
    beginRun('auto', 'start', PLANNERS.indexOf(name) >= 0 ? name : PLANNERS[0], 2);
  }

  function setPref(name, on) {
    if ((name !== 'sound' && name !== 'assist' && name !== 'shake') || typeof on !== 'boolean') return;
    view.prefs[name] = on;
    saveStore();
  }

  const safeLoadSeed = guard('action', loadSeed);
  const safeShareLink = guard('action', () => baseUrl() + '#' + buildHash({ seed, challenge: lastTimed }));
  const safeShareText = guard('action', () => {
    const r = view.result;
    if (!r) return '';
    const h = buildHash({ seed: r.seed, challenge: r.mode === 'timed' ? { grade: r.grade, feet: r.feet } : null });
    return buildShareText(r, baseUrl() + '#' + h);
  });

  const actions = {
    start: guard('action', start),
    pause: guard('action', () => pause('pause')),
    resume: guard('action', resume),
    togglePause: guard('action', () => { if (phase === 'playing') pause('pause'); else resume(); }),
    restart: guard('action', restart),
    finish: guard('action', finish),
    loadSeed: (text) => safeLoadSeed(text) || { ok: false, seed, code: 'bad-seed' },
    loadToday: guard('action', loadToday),
    watch: guard('action', watch),
    setPref: guard('action', setPref),
    setSlow: (on) => { slowToggle = !!on; },
    shareText: () => safeShareText() || '',
    shareLink: () => safeShareLink() || '',
  };

  // ---- input --------------------------------------------------------------------------------------

  function typing(t) {
    if (!t || !t.tagName) return false;
    const tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable === true;
  }

  const actionable = (t) => !!t && !!t.tagName && (t.tagName === 'BUTTON' || t.tagName === 'A' || t.tagName === 'SUMMARY');

  const onKeyDown = guard('key', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
    if (e.target && e.target.closest && e.target.closest('dialog[open]')) return;
    if (typeof e.key !== 'string') return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const steering = key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowDown' || key === 'a' || key === 'd' || key === 's';
    if (e.repeat && !steering) return;
    if (key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta' || key === 'Tab') return;
    if (phase === 'playing' && mode === 'auto') {
      cancelAuto();
      return;
    }
    const plain = e.target === document.body || e.target === canvas || e.target === document.documentElement;
    let handled = true;
    if (key === 'ArrowLeft' || key === 'a') keys.left = true;
    else if (key === 'ArrowRight' || key === 'd') keys.right = true;
    else if (key === 'ArrowDown' || key === 's') keys.down = true;
    else if (key === ' ' || key === 'Enter') {
      if (actionable(e.target)) return;
      if (key === ' ' && phase === 'playing') pause('pause');
      else if (key === ' ' && phase === 'paused') resume();
      else if (phase === 'ready' || phase === 'done') start(key === 'Enter' && e.shiftKey ? 'practice' : 'timed');
      else handled = false;
    } else if (key === 'p') {
      if (phase === 'playing') pause('pause');
      else resume();
    } else if (key === 'Escape') {
      if (phase === 'playing') pause('pause');
      else handled = false;
    } else if (key === 'r') {
      if (phase !== 'playing') restart();
    } else if (key === 'm') {
      setPref('sound', !view.prefs.sound);
    } else handled = false;
    if (handled && plain) e.preventDefault();
  });

  const onKeyUp = guard('key', (e) => {
    if (typeof e.key !== 'string') return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (key === 'ArrowLeft' || key === 'a') keys.left = false;
    else if (key === 'ArrowRight' || key === 'd') keys.right = false;
    else if (key === 'ArrowDown' || key === 's') keys.down = false;
  });

  function setAim(e) {
    const p = toLogical ? toLogical(e.clientX, e.clientY) : null;
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      aimPoint.x = p.x;
      aimPoint.y = p.y;
      aimOn = true;
    }
  }

  const onPointerDown = guard('pointer', (e) => {
    if (pointerId !== -1 && e.pointerId !== pointerId && pointerType !== 'mouse') return;
    pointerId = e.pointerId;
    pointerType = e.pointerType;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch (err) {
      // A capture can fail for a pointer that has already ended; steering still works without it.
    }
    if (phase === 'playing' && mode === 'auto') {
      cancelAuto();
      return;
    }
    if (phase === 'paused') resume();
    setAim(e);
  });

  const onPointerMove = guard('pointer', (e) => {
    if (pointerId === -1) {
      if (e.pointerType !== 'mouse') return;
      pointerId = e.pointerId;
      pointerType = e.pointerType;
    }
    if (e.pointerId === pointerId) setAim(e);
  });

  const onPointerUp = guard('pointer', (e) => {
    if (e.pointerId !== pointerId || pointerType === 'mouse') return;
    pointerId = -1;
    aimOn = false;
  });

  const onPointerLeave = guard('pointer', (e) => {
    if (e.pointerId !== pointerId) return;
    pointerId = -1;
    aimOn = false;
  });

  const onVisibility = guard('visibility', () => {
    keys.left = keys.right = keys.down = false;
    if (document.hidden) {
      pause('hidden');
      if (raf !== 0) {
        window.cancelAnimationFrame(raf);
        raf = 0;
      }
    } else {
      last = 0;
      schedule();
    }
  });

  const onBlur = () => { keys.left = keys.right = keys.down = false; };

  const onHashChange = guard('hash', () => {
    if (window.location.hash.slice(1) === lastHash) return;
    applyHash(parseHash(window.location.hash, Date.now()), 'load');
  });

  let motionQuery = null;
  const onMotion = () => { reduced = !!(motionQuery && motionQuery.matches); };

  // ---- boot and teardown --------------------------------------------------------------------------

  // boot() waits for an autoplay lap to end; leaving that lap by any route settles it too.
  function settleBoot() {
    if (bootResolve === null) return;
    const done = bootResolve;
    bootResolve = null;
    // The frame after the result is drawn; a timer backs it up for a tab that stopped painting.
    window.requestAnimationFrame(done);
    window.setTimeout(done, 120);
  }

  function boot() {
    if (booted) return Promise.resolve();
    booted = true;
    return new Promise((resolve) => {
      if (typeof window.matchMedia === 'function') {
        motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
        reduced = motionQuery.matches;
        if (motionQuery.addEventListener) motionQuery.addEventListener('change', onMotion);
      }
      loadStore();
      document.addEventListener('keydown', onKeyDown);
      document.addEventListener('keyup', onKeyUp);
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('blur', onBlur);
      window.addEventListener('hashchange', onHashChange);
      canvas.addEventListener('pointerdown', onPointerDown);
      canvas.addEventListener('pointermove', onPointerMove);
      canvas.addEventListener('pointerup', onPointerUp);
      canvas.addEventListener('pointercancel', onPointerUp);
      canvas.addEventListener('pointerleave', onPointerLeave);
      document.addEventListener('app:finish', settleBoot);
      applyHash(parseHash(window.location.hash, Date.now()), 'boot');
      const autoplay = phase === 'playing' && mode === 'auto';
      if (autoplay && document.hidden) {
        // Nobody is watching: run the autoplay lap to the end without waiting for frames.
        while (phase === 'playing') tickOnce();
      }
      drawNow();
      if (autoplay && phase === 'playing') bootResolve = resolve;
      else resolve();
      schedule();
    });
  }

  function destroy() {
    destroyed = true;
    if (raf !== 0) window.cancelAnimationFrame(raf);
    raf = 0;
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('keyup', onKeyUp);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('hashchange', onHashChange);
    document.removeEventListener('app:finish', settleBoot);
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerUp);
    canvas.removeEventListener('pointerleave', onPointerLeave);
    if (motionQuery && motionQuery.removeEventListener) motionQuery.removeEventListener('change', onMotion);
  }

  return {
    boot,
    onFrame(cb) {
      frameCbs.push(cb);
      return () => {
        const i = frameCbs.indexOf(cb);
        if (i >= 0) frameCbs.splice(i, 1);
      };
    },
    getView: () => view,
    actions,
    destroy,
  };
}
