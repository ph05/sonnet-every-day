// Between Periods: boot and wiring. Finds the canvas, builds the renderer, the game and the UI,
// connects the frame loop and the sound, and reports a failed boot on the page instead of leaving
// the loading note up. The two test hooks exist from the first line so a screenshot tool can wait on them.

const root = document.documentElement;
let settleReady = () => {};

window.__sedThumbReady = new Promise((resolve) => { settleReady = resolve; });
window.__sedState = () => ({ phase: 'boot', mode: 'attract', seed: '', tick: 0, gleamPct: 0, grade: 'D', points: 0, tank: 0, x: 0, y: 0, a: 0, gridVersion: 0 });

function fail(err) {
  const reason = String((err && err.message) || err).slice(0, 120);
  console.error('Between Periods: boot failed', err);
  root.dataset.boot = 'error';
  const note = document.getElementById('boot-note');
  const box = document.getElementById('boot-error');
  const text = document.getElementById('boot-error-text');
  if (note) note.hidden = true;
  if (text) text.textContent = 'The rink would not load (' + reason + '). Reload to try again.';
  if (box) box.hidden = false;
  document.dispatchEvent(new CustomEvent('app:error', { detail: { where: 'boot', message: reason, fatal: true } }));
  settleReady();
}

// Sound is optional: any failure only leaves `audio` null. The first key or tap unlocks it.
async function loadAudio() {
  let audio = null;
  try {
    const mod = await import('./audio.js');
    audio = mod.createAudio();
  } catch (err) {
    return null;
  }
  const play = (code, n) => {
    try {
      audio.play(code, n);
    } catch (err) {
      audio = null;
    }
  };
  document.addEventListener('app:note', (e) => { if (audio) play(e.detail.code, e.detail.n); });
  document.addEventListener('app:phase', (e) => { if (audio && e.detail.reason === 'start') play('start'); });
  document.addEventListener('app:finish', (e) => { if (audio) play(e.detail.result.reason === 'buzzer' ? 'buzzer' : 'chime'); });
  const unlock = () => {
    if (!audio) return;
    try {
      audio.unlock();
    } catch (err) {
      audio = null;
    }
    document.removeEventListener('pointerdown', unlock, true);
    document.removeEventListener('keydown', unlock, true);
  };
  document.addEventListener('pointerdown', unlock, true);
  document.addEventListener('keydown', unlock, true);
  return { play, setMuted: (m) => { if (audio) audio.setMuted(m); }, update: (v) => { if (audio) audio.update(v); } };
}

async function start() {
  const canvas = document.getElementById('rink');
  const app = document.getElementById('app');
  if (!canvas || !app) throw new Error('page-incomplete');

  const [{ createGame }, { createRenderer }, { createUI }, audio] = await Promise.all([
    import('./game.js'), import('./render.js'), import('./ui.js'), loadAudio(),
  ]);
  const renderer = createRenderer(canvas);
  const game = createGame({ canvas, toLogical: (x, y) => renderer.toLogical(x, y) });
  const ui = createUI(app, game.actions);

  game.onFrame((v, t) => {
    renderer.draw(v, t);
    ui.update(v);
    if (audio) {
      audio.setMuted(!v.prefs.sound);
      audio.update(v);
    }
  });

  window.__sedState = () => {
    const v = game.getView();
    return {
      phase: v.phase, mode: v.mode, seed: v.seed, tick: v.tick, gleamPct: v.stats.gleamPct, grade: v.stats.grade,
      points: v.stats.points, tank: v.m.tank, x: v.m.x, y: v.m.y, a: v.m.a, gridVersion: v.gridVersion,
    };
  };

  const booted = game.boot();
  if (game.getView().phase !== 'boot') root.dataset.boot = 'ready';
  await booted;
  root.dataset.boot = 'ready';
  settleReady();
}

start().catch(fail);
