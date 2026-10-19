// Paint Out a Cough: the page controller. The worker draws and rebuilds, the player plays, the view
// draws; this file wires them to the toolbar, the brush, the keyboard and the words on the page.
import { createView } from './view.js';
import { createPlayer } from './audio.js';
import { writeWav, isWav, melOf, reportedDb } from './engine.js';
import { demoStroke } from './sample.js';

const $ = (id) => document.getElementById(id);
const els = {
  play: $('pos-play'), playLabel: $('pos-play-label'), ab: $('pos-ab'), undo: $('pos-undo'),
  open: $('pos-open'), save: $('pos-save'), more: $('pos-more'), moreLabel: $('pos-more-label'), file: $('pos-file'), confirm: $('pos-confirm'),
  confirmYes: $('pos-confirm-yes'), confirmNo: $('pos-confirm-no'), stage: $('pos-stage'), base: $('pos-base'),
  canvas: $('pos-canvas'), readout: $('pos-readout'), hint: $('pos-hint'), summary: $('pos-summary'), status: $('pos-status'),
  panel: $('pos-more-panel'), size: $('pos-size'), sizeOut: $('pos-size-out'),
  zoomIn: $('pos-zoom-in'), zoomOut: $('pos-zoom-out'), zoomFit: $('pos-zoom-fit'), sample: $('pos-sample'),
  app: $('app'),
};
const reducedMQ = matchMedia('(prefers-reduced-motion: reduce)');
const coarseMQ = matchMedia('(pointer: coarse)');
const reduced = () => reducedMQ.matches;
const coarse = () => coarseMQ.matches;

const HOLD_MS = 250; // a finger held this long starts a stroke in any direction
const SLOP = 8; // px a finger may move before its direction decides between painting and scrolling
const LONG_FILE = 12; // seconds: longer recordings open at a 10-second view
const S = {
  token: 0, loaded: false, loading: true, name: '', rate: 44100, duration: 0, isSample: false, events: null, nch: 1,
  ev: null, ev0: null, // the demo clip's noises, measured by the worker: removed or not, and what is left
  strokes: [], cursor: 0, nextId: 2, mode: 'fill', brushPx: coarseMQ.matches ? 20 : 18, lastKept: false,
  listen: 'after', userStrokes: 0, playedOnce: false, flipped: false, triedRemoved: false, busy: 0,
  demo: { phase: 'none' }, split: false, longView: false, note: null,
  paint: null, pointers: new Map(), gesture: null, seeking: false, key: null, hover: null, brushAt: null, touch: null,
  pendingFile: null,
};

let thumbDone;
window.__sedThumbReady = new Promise((resolve) => { thumbDone = resolve; setTimeout(resolve, 7000); });

const view = createView({ stage: els.stage, base: els.base, overlay: els.canvas });
const player = createPlayer({ onEnded: () => { setPlaying(false); updateHint(); requestDraw(); } });

// ---- words on the page ------------------------------------------------------------------------------

function announce(text) { els.status.textContent = ''; window.setTimeout(() => { els.status.textContent = text; }, 30); }

function setReadout(parts) {
  // parts: array of strings and {b: text}; built as text nodes, never as HTML
  els.readout.textContent = '';
  for (const p of parts) {
    if (typeof p === 'string') els.readout.append(p);
    else { const b = document.createElement('b'); b.textContent = p.b; els.readout.append(b); }
  }
}

function fmtTime(s) { const m = Math.floor(s / 60); const r = Math.floor(s % 60); return `${m}:${String(r).padStart(2, '0')}`; }
function fmtHz(hz) { return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 1 : 2)} kHz` : `${Math.round(hz)} Hz`; }

// "22 dB" and what the drop means, the fraction computed from the number shown (amplitude: 20 dB is a tenth,
// 6 dB about half); the legend under the picture says what dB is. Past 60 dB the sound is gone for any ear (over
// digital silence the raw number would be absurd), so the line says "now silent" instead of a number.
function dbParts(db) {
  const n = Math.round(db);
  if (n > 60) return { silent: true, num: 'more than 60 dB', plain: '' };
  const plain = n > 40 ? 'under a hundredth of' : n === 40 ? 'a hundredth of' : n >= 30 ? 'under a thirtieth of' : n >= 9 ? `about 1/${Math.round(10 ** (n / 20))} of` : n >= 7 ? 'under half of' : n >= 5 ? 'about half of' : n >= 3 ? 'about two-thirds of' : 'most of';
  return { num: `${n} dB`, plain };
}
// "19 dB quieter where it was, about 1/9 of its strength." (or "now silent where it was: more than 60 dB quieter.")
function quieter(d, where, whose = 'its') {
  return d.silent ? [`now silent${where}: `, { b: d.num }, ' quieter.'] : [{ b: d.num }, ` quieter${where}, ${d.plain} ${whose} strength.`];
}

const EVENT_NAMES = { cough: 'cough', ping: 'ping', click: 'click' };
const evRemoved = (n) => !!(S.ev && S.ev[n] && S.ev[n].removed);
// a noise that a stroke reached (its cells changed) but did not take out
const evTouched = (n) => !!(S.ev && S.ev0 && S.ev[n] && !S.ev[n].removed && (S.ev[n].touched || S.ev[n].excess < S.ev0[n].excess - 1.5));

function partLeftText(n) {
  const e = S.ev[n], left = e.left, p = S.events[n];
  if (n === 'ping' && left) {
    if (left.t0 < p.t0 + 0.12 && left.t1 < p.t0 + 0.5) return 'Part of the ping is still there: paint over its bright left end too.';
    if (left.t0 > p.t0 + 0.35) return 'Part of the ping is still there: paint over its fading right end too.';
    return 'Part of the ping is still there: paint over what the glowing outline shows.';
  }
  if (n === 'click') return 'Part of the click is still there: paint down through all of it, top to bottom.';
  return 'Part of the cough is still there: paint over what the glowing outline shows, top to bottom.';
}

const STILL_THERE = {
  ping: 'The ping is still there: paint along all of it, from its bright start to where it fades.',
  cough: 'The cough is still there: paint across all of it, top to bottom.',
  click: 'The click is still there: paint down through all of it, top to bottom.',
};

// what a finished stroke did, in words; prev = the noises' state before this stroke. When the worker widened
// the stroke (it sat inside a longer loud sound that a wider stroke takes out), the line says so first.
function readoutFor(stroke, p, prev) {
  const r0 = stroke.readout;
  const parts = readoutCore(stroke, p, prev);
  if (r0 && r0.widened && stroke.mode !== 'erase') parts.unshift(`The sound carried on past your stroke, so the page widened it to ${(2 * r0.widened).toFixed(2)} s. `);
  return parts;
}

function readoutCore(stroke, p, prev) {
  if (p.noBorders) return ['Nothing untouched on either side to fill from, so this stroke was erased instead.'];
  if (stroke.mode === 'erase') {
    const gone = S.isSample && prev ? Object.keys(EVENT_NAMES).find((n) => !prev[n].removed && evRemoved(n)) : null;
    return [gone ? `${cap(gone)} erased: turned down by ` : 'Erased: turned down by ', { b: '60 dB' }, ', to a thousandth of its strength. Erase also takes out whatever was under it.'];
  }
  if (S.isSample && prev) {
    const gone = Object.keys(EVENT_NAMES).find((n) => !prev[n].removed && evRemoved(n));
    const part = Object.keys(EVENT_NAMES).find((n) => !S.ev[n].removed && S.ev[n].excess < prev[n].excess - 1.5);
    if (gone) {
      // the demo clip's noises are measured on their own: how much quieter the noise's own spots became
      const d = dbParts(S.ev[gone].drop);
      // the demo's own line, short: it rests under the first frame
      if (stroke.demo) return d.silent ? ['Cough removed, chord kept · now silent'] : ['Cough removed, chord kept · ', { b: d.num }, ' quieter'];
      if (gone === 'ping' && stroke.readout && stroke.readout.grew === 'ping') return ['Ping removed: the brush took the whole ping, ', ...quieter(d, ' where it was')];
      return [`${cap(gone)} removed: `, ...quieter(d, ' where it was')];
    }
    if (part) return [partLeftText(part)];
    // a stroke that reached a noise's box and left it is never silent about it (and never shows a dB success)
    const hitLeft = (p.hit || []).find((n) => !S.ev[n].removed);
    if (hitLeft) return [STILL_THERE[hitLeft]];
  }
  const r = stroke.readout;
  if (r && r.carries) return ['Something under your stroke goes on past it, such as speech or a held note, so Fill in left it as it was. Over words, use Erase (under More) to turn a cough down.'];
  // at the very start or end of a file there is sound on one side only
  const sd = p.sides || stroke.sides;
  if (p.sides) stroke.sides = p.sides;
  const from = sd && sd.after > sd.both + sd.before ? 'Filled in from the sound after it' : sd && sd.before > sd.both + sd.after ? 'Filled in from the sound before it' : 'Filled in from both sides';
  if (!r || r.db === null || r.clear === false) return [`${from}; nothing here stood out from the sound around it, so nothing was really taken out.`];
  // almost everything that changed was taken out (a narrow ping holds most of the energy in few spots): say how much
  // quieter the painted part became as a whole; otherwise the middle drop of the spots that changed
  const whole = reportedDb(r) !== r.db;
  const d = dbParts(reportedDb(r));
  return whole ? [`${from}. What you painted is `, ...quieter(d, '')] : [`${from}. The painted spots that changed are `, ...quieter(d, '', 'their')];
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// the hint, recomputed from what is on the page right now; at: 'target' (beside the outline) or 'top'
function hintNow() {
  if (!S.loaded || S.loading) return null;
  if (S.note && performance.now() < S.note.until) return { text: S.note.text, at: 'top' };
  return hintCore();
}

function hintCore() {
  if (!S.loaded || S.loading) return null;
  if (S.busy > 0 || S.paint || (S.touch && S.touch.decided === 'paint')) return null;
  const touchLine = coarse() ? 'Drag sideways to paint, or hold, then drag.' : null;
  if (S.listen === 'removed') return { text: 'Removed plays and shows only what was taken out. Choose After to go back.', at: 'top' };
  if (S.lastKept) return { text: 'Nothing changed: try Erase (under More).', at: 'top' };
  if (S.isSample) {
    if (storyRunning()) return null;
    for (const n of ['ping', 'cough', 'click']) if (evTouched(n)) return { text: partLeftText(n), at: 'target', target: n, more: touchLine };
    const pingLeft = !evRemoved('ping');
    // the visitor has not taken anything out yet (strokes that missed the noises do not count)
    const nothingYet = !evRemoved('ping') && !evRemoved('click');
    if (nothingYet && S.playedOnce && !S.flipped && evRemoved('cough') && S.listen === 'after') return { text: player.isPlaying() ? 'You are hearing the cleaned version: the cough is already gone. Flip to Before to hear it.' : 'Play gives you the cleaned version: the cough is already gone. Flip to Before to hear it.', at: 'top' };
    if (nothingYet) {
      // a phone shows the ping too small to see its start and fade: the ring is what to follow
      if (coarse()) return { text: view.size().W < 560 ? 'Paint along the ping in the ring: drag sideways, or hold, then drag.' : 'Paint along the ping, from its bright start to where it fades: drag sideways, or hold, then drag.', at: 'target', target: 'ping' };
      return { text: 'Paint along the ping, from its bright start to where it fades.', at: 'target', target: 'ping' };
    }
    if (!S.playedOnce) return { text: 'Now press Play, and flip Before / After while it plays.', at: 'top' };
    if (!S.flipped) return { text: 'Flip to Before to hear what you painted out come back.', at: 'top' };
    if (!S.triedRemoved) return { text: 'Now choose Removed to hear only what was taken out.', at: 'top' };
    if (pingLeft) return { text: 'Paint along the ping, from its bright start to where it fades.', at: 'target', target: 'ping', more: touchLine };
    if (!evRemoved('click')) return { text: 'There is a click near 1.5 s too: paint down through it, top to bottom.', at: 'target', target: 'click', more: touchLine };
    return { text: S.cursor > 0 ? 'Undo takes the strokes back one at a time. Or open a recording of your own.' : 'Everything is back as recorded. Ctrl+Shift+Z puts the strokes back.', at: 'top' };
  }
  if (S.userStrokes === 0 && S.longView) return { text: `Showing ${fmtTime(view.view().t0)} to ${fmtTime(view.view().t1)} of ${fmtTime(S.duration)}. Zoom out or Fit (under More) shows more.`, at: 'top', more: touchLine };
  if (S.userStrokes === 0) return { text: 'Paint over a noise, then press Play.', at: 'top', more: touchLine };
  if (!S.playedOnce) return { text: 'Now press Play, and flip Before / After while it plays.', at: 'top' };
  if (!S.flipped) return { text: 'Flip Before / After to compare, or choose Removed to hear only what went.', at: 'top' };
  return { text: 'Save WAV keeps the result. Near words, Erase (under More) often works better.', at: 'top' };
}

function updateHint() {
  const h = hintNow();
  const text = !S.loaded ? 'Drawing the picture…' : S.loading ? 'Opening the recording…' : h ? `${h.text}${h.text.endsWith('.') ? '' : '.'}${h.more ? ` ${h.more}` : ''}` : '';
  if (els.hint.textContent !== text) els.hint.textContent = text;
}

function updateSummary() {
  if (!S.loaded) return;
  const showing = `Showing the ${S.listen === 'before' ? 'original' : S.listen === 'removed' ? 'removed part' : 'cleaned recording'}.`;
  if (S.isSample) {
    const st = (n) => (evRemoved(n) ? ' (removed)' : evTouched(n) ? ' (partly removed)' : '');
    els.summary.textContent = `The 10-second demo clip: a held chord from 2.4 to 7.6 seconds; a cough at 4.6 seconds${st('cough')}; a phone ping at 8.6 seconds${st('ping')}; a click at 1.5 seconds${st('click')}. ${showing}`;
  } else {
    els.summary.textContent = `${S.name}, ${fmtTime(S.duration)} long, ${S.cursor} stroke${S.cursor === 1 ? '' : 's'} painted. ${showing}`;
  }
}

function updateButtons() {
  els.undo.disabled = !S.loaded || S.cursor <= 0;
  els.save.disabled = !S.loaded || S.loading || S.busy > 0;
  els.play.disabled = !S.loaded;
}

function showError(text) { setReadout([text]); announce(text); }

// ---- the worker ------------------------------------------------------------------------------------

let worker = null;
try {
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => { try { handle(e.data); } catch (err) { showError(`Something went wrong while drawing: ${err.message}`); } };
  worker.onerror = (e) => { if (e && e.preventDefault) e.preventDefault(); showError('Something went wrong while rebuilding the sound. Undo the last stroke or reload the page.'); thumbDone(); };
} catch (err) {
  showError('This browser cannot run the sound engine (it needs module workers). Try a current browser.');
}
const send = (msg, transfer) => { if (worker) worker.postMessage(msg, transfer || []); };
const windowChoice = () => { const r = document.querySelector('input[name="pos-window"]:checked'); return r ? r.value : 'balanced'; };

function handle(m) {
  if (!m || !m.op) return;
  if (m.op === 'progress') { setReadout([`Drawing the picture… ${Math.round((100 * m.done) / m.total)}%`]); return; }
  if (m.op === 'loaded') { onLoaded(m); return; }
  if (m.op === 'reject') { S.loading = !S.loaded ? S.loading : false; showError(m.message); updateHint(); updateButtons(); return; }
  if (m.op === 'wav-fallback') { const f = S.pendingFile; if (f && f.name === m.name) f.file.arrayBuffer().then((b) => decodeAndSend(f.name, b, f.file.size)).catch(() => cannotOpen(f.name)); return; }
  if (m.op === 'error') { S.busy = 0; updateButtons(); showError('Something went wrong while rebuilding the sound. Undo the last stroke or reload the page.'); return; }
  if (m.token !== S.token) return;
  if (m.op === 'patch') onPatch(m);
  else if (m.op === 'repicture') onRepicture(m);
}

function onLoaded(m) {
  stopPlayback();
  S.token = m.token; S.loaded = true; S.loading = false; S.name = m.name; S.rate = m.rate; S.duration = m.length / m.rate;
  S.isSample = !!m.isSample; S.events = m.events || null; S.nch = m.channels.length; S.deep = !!m.deep;
  S.ev = m.eventState || null; S.ev0 = m.eventState ? JSON.parse(JSON.stringify(m.eventState)) : null;
  S.strokes = []; S.cursor = 0; S.userStrokes = 0; S.playedOnce = false; S.flipped = false; S.triedRemoved = false; S.busy = 0; S.paint = null; S.key = null; S.touch = null;
  S.pendingFile = null; S.note = null; S.split = false;
  player.load(m.rate, m.channels);
  view.setPicture({
    first: m.first, frames: m.frames, rows: m.rows, before: m.before, after: m.before.slice(), removed: new Uint8Array(m.before.length),
    rate: m.rate, H: m.H, N: m.N, melLo: m.melLo, melHi: m.melHi, duration: S.duration,
  });
  view.setOverride(null);
  S.longView = !S.isSample && S.duration > LONG_FILE;
  if (S.longView) view.setView(0, 10);
  setListen('after', true);
  view.setStrokes([]);
  if (S.isSample) {
    const d = demoStroke(m.melLo, m.melHi);
    S.strokes = [{ ...d, status: 'pending', hidden: true }];
    S.cursor = 1;
    S.busy = 1;
    S.demo = { phase: 'wait', t: performance.now(), played: false };
    setReadout(['Painting out the cough on the held chord…']);
  } else {
    S.demo = { phase: 'none' };
    const kind = S.nch === 1 ? 'mono' : 'stereo';
    setReadout([`${S.name} · ${fmtTime(S.duration)} · ${S.rate.toLocaleString('en-US')} Hz · ${kind}.${m.notice ? ` ${m.notice}` : ''}`]);
    announce(`${S.name} is open. Paint over a noise, then press Play.`);
  }
  updateBrushOut(); updateHint(); updateButtons(); updateSummary();
  view.setStrokes(activeStrokes());
  requestDraw();
}

function activeStrokes() { return S.strokes.slice(0, S.cursor); }

function onPatch(p) {
  S.busy = Math.max(0, S.busy - 1);
  const stroke = S.strokes.find((s) => s.id === p.strokeId);
  const prev = S.ev;
  if (p.events) S.ev = p.events;
  if (p.empty) {
    if (stroke) stroke.status = 'done';
    if (p.action === 'add') setReadout(['Nothing to paint there: the stroke was outside the recording.']);
    finishPatch();
    return;
  }
  S.lastKept = p.action !== 'undo' && !!p.kept;
  if (stroke && p.action !== 'undo') {
    stroke.readout = p.readout;
    // the worker widened the stroke: draw its outline as wide as what was rebuilt
    if (p.readout && p.readout.widened) { stroke.rT = p.readout.widened; view.invalidateOutlines(); }
  }
  player.patch(p.start, p.channels);
  if (stroke && stroke.demo && p.action === 'add' && S.demo.phase === 'wait') {
    // the first frame: the cough is painted out at once; the picture rests clean, with the removed cough as a faint ghost
    view.patchColumns(p.colFrom, p.colCount, p.after, p.removed, 0);
    stroke.status = 'done'; stroke.hidden = false;
    S.demo = { phase: 'split', t: performance.now(), played: false, colFrom: p.colFrom, colCount: p.colCount };
    S.split = false;
    view.setOverride(null);
    setReadout(readoutFor(stroke, p, prev));
    maybeStartStory();
    if (S.demo.phase === 'split') thumbDone();
    finishPatch();
    return;
  }
  const anim = reduced() ? 0 : p.action === 'undo' ? 220 : 260;
  view.patchColumns(p.colFrom, p.colCount, p.after, p.removed, anim);
  if (stroke) stroke.status = 'done';
  if (p.action === 'undo') {
    const back = S.isSample && prev ? Object.keys(EVENT_NAMES).find((n) => prev[n].removed && !evRemoved(n)) : null;
    const top = S.strokes[S.cursor - 1];
    const text = back ? `Undone: the ${back} is back.` : S.cursor === 0 ? 'Undone: back to the recording as it was.' : 'Stroke undone.';
    setReadout(top && top.readout && !back && S.cursor > 0 ? [`${text} `, ...readoutFor(top, { noBorders: false }, top.demo ? S.ev0 : null)] : [text]);
    S.note = { text, until: performance.now() + 3500 };
    window.setTimeout(() => { updateHint(); requestDraw(); }, 3600);
    announce(text);
  } else if (stroke) {
    setReadout(readoutFor(stroke, p, prev));
    announce(els.readout.textContent);
  }
  finishPatch();
}

function finishPatch() {
  view.setStrokes(activeStrokes());
  updateButtons(); updateSummary(); updateHint();
  requestDraw();
}

function onRepicture(m) {
  const pic = view.picture();
  const keep = view.view();
  view.setPicture({ ...pic, first: m.first, frames: m.frames, rows: m.rows, before: m.before, after: m.after, removed: m.removed, H: m.H, N: m.N, melLo: m.melLo, melHi: m.melHi });
  view.setView(keep.t0, keep.t1);
  if (m.events) S.ev = m.events;
  player.replaceAfter(m.channels);
  S.loading = false;
  if (S.split) applySplit();
  setReadout([`Redrawn and rebuilt with ${m.N.toLocaleString('en-US')}-sample slices (${((m.N / S.rate) * 1000).toFixed(1)} ms each).`]);
  view.setStrokes(activeStrokes());
  updateButtons(); updateHint(); updateSummary();
  requestDraw();
}

// ---- the first frame: the cough painted out, then shown as a story when the picture comes into view -------
// Story: a dark gap opens where the brush passes, the chord grows back in from both edges, and the removed
// cough lifts out and fades to a faint ghost. At rest the picture is the clean one, with that faint ghost lifted above
// where the cough was (phase 'split' is the resting phase; the before | after split itself is no longer shown).

const STORY = { delay: 450, sweep: 900, knit: 900, lift: 950 };
let inView = false;

function demoStrokeObj() { return S.strokes.find((s) => s.demo); }
function storyRunning() { return ['delay', 'sweep', 'knit', 'lift'].includes(S.demo.phase); }

function demoCols() {
  const s = demoStrokeObj(), pic = view.picture();
  if (!s || !pic) return null;
  const t = s.points[0][0];
  const c = (x) => Math.round((x * pic.rate) / pic.H) - pic.first;
  return { t, rT: s.rT, c0: c(t - s.rT), c1: c(t + s.rT), cm: c(t) };
}

function applySplit() {
  const d = demoCols();
  if (!d || !S.split || S.cursor < 1 || !S.strokes[0].demo) { view.setOverride(null); return; }
  view.setOverride({ c0: d.c0, c1: d.cm });
}

function endSplit() {
  if (!S.split) return;
  S.split = false;
  view.setOverride(null);
  requestDraw();
}

function maybeStartStory() {
  if (S.demo.phase !== 'split' || S.demo.played || !inView || reduced() || !S.isSample) return;
  S.demo.phase = 'delay'; S.demo.t = performance.now();
  requestDraw();
}

function replayStory() {
  // never after the visitor has painted: the story would cover their own result
  if (!S.isSample || reduced() || storyRunning() || S.busy > 0 || S.userStrokes > 0) return;
  const s = demoStrokeObj();
  if (!s || S.cursor < 1 || s.status !== 'done') return;
  S.demo.phase = 'sweep'; S.demo.t = performance.now();
  startSweep();
  requestDraw();
}

function startSweep() {
  const d = demoCols();
  view.setOverride(d ? { c0: d.c0 - 3, c1: d.c1 + 3 } : null); // the cough is back for the brush to paint out
  const s = demoStrokeObj();
  if (s) { s.hidden = true; view.setStrokes(activeStrokes()); }
  setReadout(['Watch: the brush paints out the cough on the held chord.']);
}

function startKnit() {
  const d = demoCols(), pic = view.picture();
  view.setOverride(null);
  if (!d || !pic) return;
  // the chord grows back in from both edges of a dark gap
  const a = d.c0 - 3, b = d.c1 + 3, rows = pic.rows;
  const prev = pic.before.slice(a * rows, (b + 1) * rows);
  for (let c = a; c <= b; c++) {
    const t = ((c + pic.first) * pic.H) / pic.rate;
    const u = Math.abs(t - d.t) / d.rT;
    const m = u <= 0.8 ? 1 : u < 1 ? 0.5 + 0.5 * Math.cos((Math.PI * (u - 0.8)) / 0.2) : 0;
    if (m <= 0) continue;
    const o = (c - a) * rows;
    for (let r = 0; r < rows; r++) prev[o + r] = Math.round(prev[o + r] * (1 - m));
  }
  view.knit(a, b, prev, STORY.knit);
}

function endStory() {
  S.demo.phase = 'split'; S.demo.played = true;
  const s = demoStrokeObj();
  if (s) { s.hidden = false; view.setStrokes(activeStrokes()); }
  if (S.split) applySplit(); else view.setOverride(null);
  const p = { noBorders: false };
  // the demo's line only while the visitor has no stroke of their own (the story never overwrites their result)
  if (s && S.userStrokes === 0 && S.cursor >= 1) setReadout(readoutFor(s, p, S.ev0));
  thumbDone();
  updateHint();
  requestDraw();
}

function storyFrame(now) {
  const d = S.demo;
  if (d.phase === 'delay' && now - d.t >= STORY.delay) { d.phase = 'sweep'; d.t = now; startSweep(); }
  if (d.phase === 'sweep' && now - d.t >= STORY.sweep) { d.phase = 'knit'; d.t = now; startKnit(); }
  if (d.phase === 'knit' && now - d.t >= STORY.knit) { d.phase = 'lift'; d.t = now; }
  if (d.phase === 'lift' && now - d.t >= STORY.lift) endStory();
  return storyRunning();
}

// what the overlay draws for the story at this moment
function storyLayers(now) {
  const d = S.demo, s = demoStrokeObj(), pic = view.picture();
  if (!s || !pic || !storyRunning() || d.phase === 'delay') return {};
  const t = s.points[0][0];
  if (d.phase === 'sweep') {
    let u = Math.min(1, (now - d.t) / STORY.sweep);
    u = u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u);
    const mel = pic.melHi - u * (pic.melHi - pic.melLo);
    return { gap: { t, rT: s.rT, fromMel: pic.melHi, toMel: mel }, sweep: { t, mel, rT: s.rT } };
  }
  if (d.phase === 'lift') {
    const u = Math.min(1, (now - d.t) / STORY.lift);
    const dc = demoCols();
    return { lift: { c0: dc.c0 - 3, c1: dc.c1 + 3, alpha: GHOST.alpha + (0.95 - GHOST.alpha) * (1 - u) * (1 - u), dy: GHOST.dy * u } };
  }
  return {};
}

// at rest the removed cough stays as a faint ghost, lifted above where it was (After only, while the demo stroke stands)
const GHOST = { alpha: 0.3, dy: 26 };
function restGhost() {
  if (!S.isSample || S.demo.phase !== 'split' || S.listen !== 'after' || !evRemoved('cough') || S.busy > 0) return null;
  const s = demoStrokeObj(), dc = demoCols();
  if (!s || !dc || s.hidden || s.status !== 'done' || S.strokes.indexOf(s) >= S.cursor) return null;
  return { c0: dc.c0 - 3, c1: dc.c1 + 3, alpha: GHOST.alpha, dy: GHOST.dy };
}

// ---- drawing loop --------------------------------------------------------------------------------------

let raf = 0;
function requestDraw() { if (!raf) raf = requestAnimationFrame(frame); }

function frame(now) {
  raf = 0;
  let again = false;
  if (storyRunning()) again = storyFrame(now) || again;
  if (view.stepReveals()) again = true;
  if (player.isPlaying()) { again = true; follow(); }
  if (S.touch && !S.touch.decided) again = true;
  const tg = targetNow();
  if (tg && !reduced()) again = true;
  drawOverlay(now, tg);
  if (S.note && now >= S.note.until) { S.note = null; updateHint(); }
  if (again) requestDraw();
}

// the pulsing outline: over the whole ping (or the part of a noise a stroke left), never while painting or rebuilding
function targetNow() {
  if (!S.loaded || !S.isSample || !S.ev || S.listen === 'removed' || S.busy > 0 || S.paint || storyRunning() || S.demo.phase === 'wait') return null;
  if (S.touch && S.touch.decided === 'paint') return null;
  const h = hintCore();
  const n = h && h.target;
  if (!n || evRemoved(n)) return null;
  const e = S.events[n], pic = view.picture();
  if (evTouched(n) && S.ev[n].left) {
    const l = S.ev[n].left;
    const full = n !== 'ping';
    return { n, t0: l.t0 - 0.05, t1: l.t1 + 0.05, hz0: full ? null : l.hz0 / 1.08, hz1: full ? null : l.hz1 * 1.08 };
  }
  if (n === 'ping') return { n, t0: e.t0 - 0.05, t1: e.t1, hz0: e.f1 / 1.1, hz1: e.f2 * 1.1 };
  void pic;
  return { n, t0: e.t0 - 0.03, t1: e.t1 + 0.03, hz0: null, hz1: null };
}

function labels() {
  if (!S.isSample || !S.events || S.listen === 'removed' || !S.ev) return [];
  const after = S.listen === 'after';
  const narrow = view.size().W < 560;
  const ev = S.events;
  const out = [
    { n: 'click', text: after && evRemoved('click') ? 'click removed' : after && evTouched('click') ? 'part of the click is left' : 'a click', t: ev.click.t0, hz: narrow ? 6900 : 7600 },
    { text: 'a held chord', t: 7.72, hz: 165, align: 'left' },
    { n: 'ping', text: after && evRemoved('ping') ? 'ping removed' : after && evTouched('ping') ? 'part of the ping is left' : 'a phone ping', t: ev.ping.t0 + 0.42, hz: narrow ? 8700 : 8200 },
  ];
  const ct = (ev.cough.t0 + ev.cough.t1) / 2;
  if (S.split && after && evRemoved('cough') && !storyRunning()) {
    out.push({ text: narrow ? 'before' : 'before: a cough', t: ct - 0.06, hz: narrow ? 3300 : 9300, align: 'right' });
    out.push({ text: narrow ? 'after' : 'after: chord kept', t: ct + 0.06, hz: narrow ? 3300 : 9300, align: 'left' });
  } else if (!storyRunning() || S.demo.phase === 'lift') {
    out.push({ n: 'cough', text: after && evRemoved('cough') ? (activeStrokes().some((s) => s.mode === 'erase' && s.points.some((q) => Math.abs(q[0] - ct) < s.rT + 0.15)) ? 'cough erased' : 'cough removed, chord kept') : after && evTouched('cough') ? 'part of the cough is left' : 'a cough', t: ct, hz: narrow ? 3300 : 9300 });
  }
  return out;
}

function brushRT() {
  // the brush's half-width in time follows the view up to a cap, so it never grows past about 0.03 s (18 px)
  // (0.12 s for a finger) however far the view is zoomed out. Narrow is right for clicks; a stroke that lands
  // inside a longer sound (a cough) is widened by the worker when a wider one clearly takes it out.
  const capT = (coarse() ? 0.006 : 0.0016) * S.brushPx;
  return Math.min(S.brushPx * view.secPerPx(), capT);
}

function drawOverlay(now, tg) {
  const st = storyLayers(now);
  const h = hintNow();
  const s = {
    reduced: reduced(),
    message: !S.loaded ? 'Drawing the demo clip…' : null,
    labels: labels(),
    target: tg ? { ...tg, phase: (now % 1600) / 1600 } : null,
    hint: h && !storyRunning() ? { ...h, box: tg } : null,
    trail: S.paint ? { points: S.paint.points, rT: S.paint.rT, rM: S.paint.rM } : S.key && S.key.points ? { points: S.key.points, rT: S.key.rT, rM: S.key.rM } : null,
    gap: st.gap || null,
    ghost: st.sweep ? { t: st.sweep.t, fromMel: view.picture().melHi, mel: st.sweep.mel, rT: st.sweep.rT } : null,
    lift: st.lift || restGhost(),
    split: S.split && !storyRunning() && S.listen === 'after' && evRemoved('cough') ? { t: demoCols() ? demoCols().t : null } : null,
    brush: null,
    playhead: S.loaded && (player.isPlaying() || player.now() > 0) ? player.now() : null,
    hover: S.hover,
  };
  const rx = brushRT() / view.secPerPx();
  if (S.touch && !S.touch.decided && !S.paint) {
    s.brush = { x: S.touch.x0, y: S.touch.y0, rx, ry: S.brushPx, erase: S.mode === 'erase', hold: Math.min(1, (now - S.touch.t0) / HOLD_MS) };
  } else if (S.brushAt) s.brush = { ...S.brushAt, rx, ry: S.brushPx, erase: S.mode === 'erase' };
  else if (S.key) s.brush = { x: view.tToX(S.key.t), y: view.melToY(S.key.mel), rx, ry: S.brushPx, erase: S.mode === 'erase' };
  view.drawOverlay(s);
}

function follow() {
  const t = player.now();
  const { t0, t1 } = view.view();
  if (t1 - t0 >= S.duration - 1e-6) return;
  if (t > t1 - 0.05 * (t1 - t0) || t < t0) { const span = t1 - t0; view.setView(t - 0.1 * span, t + 0.9 * span); view.invalidateOutlines(); }
}

// ---- listening and playback -------------------------------------------------------------------------------

const LISTEN_WORDS = { before: 'Before, the original recording', after: 'After, the cleaned recording', removed: 'Removed, only what was taken out' };
function setListen(mode, quiet) {
  S.listen = mode;
  player.setListen(mode);
  view.setShow(mode);
  els.ab.dataset.listen = mode;
  els.ab.setAttribute('aria-label', `Listening to ${LISTEN_WORDS[mode]}. Press to switch Before and After; the arrow keys also reach Removed.`);
  if (!quiet) announce(mode === 'removed' ? 'Hearing and showing only what was removed.' : mode === 'after' ? 'Hearing the cleaned recording (After).' : 'Hearing the original recording (Before).');
  updateSummary();
  requestDraw();
}

function chooseListen(mode) {
  if (!S.loaded) return;
  endSplit();
  if (mode === S.listen) return;
  if (mode === 'before' || (mode === 'after' && S.listen === 'before')) S.flipped = true;
  if (mode === 'removed') S.triedRemoved = true;
  setListen(mode);
  updateHint();
}

function setPlaying(on) {
  els.play.dataset.playing = on ? 'true' : 'false';
  els.playLabel.textContent = on ? 'Pause' : 'Play';
  els.play.setAttribute('aria-label', on ? 'Pause' : 'Play');
}

async function togglePlay() {
  if (!S.loaded) return;
  endSplit();
  if (player.isPlaying()) { player.pause(); setPlaying(false); updateHint(); requestDraw(); return; }
  const ok = await player.play().catch(() => false);
  setPlaying(!!ok);
  if (ok) { S.playedOnce = true; updateHint(); }
  else showError('This browser blocked the sound. Press Play again.');
  requestDraw();
}

function stopPlayback() { if (player.isPlaying()) player.pause(); player.seek(0); setPlaying(false); }

function flip() {
  if (!S.loaded) return;
  chooseListen(S.listen === 'before' ? 'after' : 'before');
}

// ---- strokes ---------------------------------------------------------------------------------------------------

function localXY(e) { const r = els.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
const picH = () => view.size().picH;

function beginStroke(x, y, id) {
  endSplit();
  S.paint = { id, points: [[view.xToT(x), view.yToMel(Math.max(0, Math.min(picH(), y)))]], rT: brushRT(), rM: S.brushPx * view.melPerPx(), lastX: x, lastY: y, mode: S.mode };
}

function extendStroke(x, y) {
  const p = S.paint;
  if (!p) return;
  if (Math.hypot(x - p.lastX, y - p.lastY) < 2) return;
  if (p.points.length >= 600) return;
  p.points.push([view.xToT(x), view.yToMel(Math.max(0, Math.min(picH(), y)))]);
  p.lastX = x; p.lastY = y;
}

function commitStroke(p) {
  if (!p || !S.loaded || S.loading) return;
  const pic = view.picture();
  const pts = p.points.filter((q) => q[0] > -p.rT && q[0] < S.duration + p.rT);
  if (!pts.length) return;
  const stroke = {
    id: S.nextId++, mode: p.mode, points: pts, rT: p.rT, rM: p.rM,
    top: pts.some((q) => q[1] + p.rM >= pic.melHi), bottom: pts.some((q) => q[1] - p.rM <= pic.melLo), status: 'pending',
  };
  S.strokes.length = S.cursor;
  S.strokes.push(stroke);
  S.cursor += 1;
  S.busy += 1;
  S.userStrokes += 1;
  S.note = null;
  S.lastKept = false;
  send({ op: 'stroke', token: S.token, stroke: { id: stroke.id, mode: stroke.mode, points: stroke.points, rT: stroke.rT, rM: stroke.rM, top: stroke.top, bottom: stroke.bottom } });
  setReadout(['Rebuilding the painted part…']);
  view.setStrokes(activeStrokes());
  updateButtons(); updateHint();
  requestDraw();
}

function undo() {
  if (!S.loaded || S.cursor <= 0) return;
  endSplit();
  S.cursor -= 1;
  const s = S.strokes[S.cursor];
  if (s.demo && storyRunning()) endStory();
  S.busy += 1;
  send({ op: 'undo', token: S.token });
  view.setStrokes(activeStrokes());
  updateButtons(); updateSummary();
  requestDraw();
}

function redo() {
  if (!S.loaded || S.cursor >= S.strokes.length) return;
  S.cursor += 1;
  S.strokes[S.cursor - 1].status = 'pending';
  S.busy += 1;
  send({ op: 'redo', token: S.token });
  view.setStrokes(activeStrokes());
  updateButtons();
  requestDraw();
}

// is a point over the demo stroke's outline? (hover or tap replays the story)
function overDemo(x, y) {
  const s = demoStrokeObj();
  if (!s || S.cursor < 1 || s.hidden || y > picH()) return false;
  return Math.abs(view.xToT(x) - s.points[0][0]) <= s.rT;
}

// pointer input on the picture. Mouse and pen paint at once. A finger paints at once when it moves sideways,
// scrolls the page when it moves up or down, and paints in any direction after a 250 ms hold.
els.canvas.addEventListener('pointerdown', (e) => {
  if (!S.loaded || S.loading) return;
  if (storyRunning()) endStory(); // any press on the picture jumps the story to its end
  stopHoverReplay();
  const { x, y } = localXY(e);
  S.pointers.set(e.pointerId, { x, y });
  if (S.pointers.size === 2) {
    // a second finger: no painting; pinch to zoom the picture, or pan it when zoomed
    S.paint = null;
    if (S.touch) { clearTimeout(S.touch.timer); S.touch = null; }
    const pts = [...S.pointers.values()];
    S.gesture = { mid: (pts[0].x + pts[1].x) / 2, midY: (pts[0].y + pts[1].y) / 2, dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1 };
    requestDraw();
    return;
  }
  if (S.pointers.size > 2) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (y > picH()) { try { els.canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } S.seeking = true; player.seek(view.xToT(x)); requestDraw(); return; }
  if (e.pointerType === 'touch') {
    const t = { id: e.pointerId, x0: x, y0: y, t0: performance.now(), decided: null, timer: 0 };
    t.timer = window.setTimeout(() => {
      if (S.touch !== t || t.decided) return;
      t.decided = 'paint';
      beginStroke(t.x0, t.y0, t.id);
      S.brushAt = { x: t.x0, y: t.y0 };
      requestDraw();
    }, HOLD_MS);
    S.touch = t;
    requestDraw();
    return;
  }
  try { els.canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  e.preventDefault();
  beginStroke(x, y, e.pointerId);
  requestDraw();
});

els.canvas.addEventListener('pointermove', (e) => {
  const { x, y } = localXY(e);
  if (S.pointers.has(e.pointerId)) S.pointers.set(e.pointerId, { x, y });
  if (S.gesture && S.pointers.size >= 2) { gestureMove(); return; }
  if (S.seeking) { player.seek(view.xToT(x)); requestDraw(); return; }
  const t = S.touch;
  if (t && e.pointerId === t.id) {
    if (!t.decided) {
      const dx = Math.abs(x - t.x0), dy = Math.abs(y - t.y0);
      if (dx > SLOP && dx > dy) { t.decided = 'paint'; clearTimeout(t.timer); beginStroke(t.x0, t.y0, t.id); }
      else if (dy > SLOP) { t.decided = 'scroll'; clearTimeout(t.timer); }
    }
    if (t.decided === 'paint') { extendStroke(x, y); S.brushAt = { x, y }; }
    requestDraw();
    return;
  }
  if (e.pointerType === 'mouse' || S.paint) {
    S.brushAt = y <= picH() ? { x, y } : null;
    els.canvas.style.cursor = y > picH() ? 'col-resize' : 'none';
    S.hover = S.loaded && y <= picH() ? `${view.xToT(x).toFixed(2)} s · ${fmtHz(view.hzOfY(y))} · brush ${(2 * brushRT()).toFixed(2)} s wide` : null;
    // resting still on the demo's outline for 600 ms plays the story again (once; a click or tap on it replays it
    // too), but never after the visitor has painted
    if (e.pointerType === 'mouse' && !S.paint && e.buttons === 0 && overDemo(x, y) && !S.demo.hoverReplayed && S.demo.played && S.userStrokes === 0) {
      const h = S.demo.hover;
      if (!h || Math.hypot(x - h.x, y - h.y) > 4) {
        stopHoverReplay();
        const nh = { x, y, timer: 0 };
        nh.timer = window.setTimeout(() => { if (S.demo.hover !== nh) return; S.demo.hover = null; S.demo.hoverReplayed = true; replayStory(); }, 600);
        S.demo.hover = nh;
      }
    } else stopHoverReplay();
  }
  if (S.paint && S.paint.id === e.pointerId) extendStroke(x, y);
  requestDraw();
});

// while a finger paints, the page must not scroll: cancel the touch moves (only possible before scrolling starts)
els.canvas.addEventListener('touchmove', (e) => {
  if ((S.touch && S.touch.decided === 'paint') || S.pointers.size >= 2) e.preventDefault();
}, { passive: false });

function endPointer(e, commit) {
  S.pointers.delete(e.pointerId);
  if (S.pointers.size < 2) S.gesture = null;
  if (S.seeking) { S.seeking = false; return; }
  const t = S.touch;
  if (t && e.pointerId === t.id) {
    clearTimeout(t.timer);
    S.touch = null;
    if (!t.decided && commit) {
      // a quick tap: on the demo's outline it replays the story; elsewhere it does nothing
      const { x, y } = localXY(e);
      if (overDemo(x, y)) replayStory();
    }
  }
  if (S.paint && S.paint.id === e.pointerId) {
    const p = S.paint;
    S.paint = null;
    // a mouse click that did not move, on the demo's outline, replays the story (until the visitor has painted)
    const { x, y } = localXY(e);
    if (commit && e.pointerType === 'mouse' && p.points.length === 1 && S.userStrokes === 0 && S.isSample && overDemo(x, y)) replayStory();
    else if (commit) commitStroke(p);
  }
  if (e.pointerType !== 'mouse') S.brushAt = null;
  updateHint();
  requestDraw();
}
els.canvas.addEventListener('pointerup', (e) => endPointer(e, true));
els.canvas.addEventListener('pointercancel', (e) => endPointer(e, false));
els.canvas.addEventListener('pointerleave', (e) => { stopHoverReplay(); if (e.pointerType === 'mouse' && !S.paint) { S.brushAt = null; S.hover = null; requestDraw(); } });
function stopHoverReplay() { if (S.demo && S.demo.hover) { clearTimeout(S.demo.hover.timer); S.demo.hover = null; } }

function gestureMove() {
  const pts = [...S.pointers.values()];
  const mid = (pts[0].x + pts[1].x) / 2, midY = (pts[0].y + pts[1].y) / 2;
  const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
  const g = S.gesture;
  const { t0, t1 } = view.view();
  const zoomed = t1 - t0 < S.duration - 1e-6;
  const scale = g.dist / dist;
  if (Math.abs(scale - 1) > 0.02 || zoomed) {
    const span = Math.min(S.duration, (t1 - t0) * scale);
    const tm = view.xToT(g.mid);
    const a = tm - (mid / view.size().W) * span;
    view.setView(a, a + span);
    viewChanged();
  } else {
    window.scrollBy(0, g.midY - midY);
  }
  S.gesture = { mid, midY, dist };
  requestDraw();
}

function viewChanged() {
  view.invalidateOutlines();
  const { t0, t1 } = view.view();
  if (S.longView && t1 - t0 >= Math.min(S.duration, 20) - 1e-6) S.longView = false;
  updateHint();
  updateBrushOut();
  requestDraw();
}

els.canvas.addEventListener('wheel', (e) => {
  if (!S.loaded) return;
  const { x } = localXY(e);
  if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomAround(e.deltaY > 0 ? 1.25 : 0.8, view.xToT(x)); return; }
  const { t0, t1 } = view.view();
  const zoomed = t1 - t0 < S.duration - 1e-6;
  const dx = e.shiftKey ? e.deltaY : e.deltaX;
  if (zoomed && Math.abs(dx) > Math.abs(e.shiftKey ? 0 : e.deltaY)) {
    e.preventDefault();
    panBy((dx / view.size().W) * (t1 - t0));
  }
}, { passive: false });

function panBy(dt) {
  const { t0, t1 } = view.view();
  view.setView(t0 + dt, t1 + dt);
  viewChanged();
}

function zoomAround(factor, tc) {
  const { t0, t1 } = view.view();
  const span = Math.min(S.duration, (t1 - t0) * factor);
  const a = tc - ((tc - t0) / (t1 - t0)) * span;
  view.setView(a, a + span);
  viewChanged();
}
const zoomCenter = (f) => { const { t0, t1 } = view.view(); zoomAround(f, (t0 + t1) / 2); };
const zoomFit = () => { if (S.loaded) { view.setView(0, S.duration); viewChanged(); } };

// keyboard brush on the picture
els.canvas.addEventListener('focus', () => {
  if (!S.loaded || S.key) return;
  const t = S.isSample && S.events ? S.events.ping.t0 : (view.view().t0 + view.view().t1) / 2;
  const mel = S.isSample ? (melOf(S.events.ping.f1) + melOf(S.events.ping.f2)) / 2 : (view.picture().melLo + view.picture().melHi) / 2;
  S.key = { t, mel, points: null, rT: 0, rM: 0 };
  requestDraw();
});
els.canvas.addEventListener('blur', () => { S.key = null; requestDraw(); });
els.canvas.addEventListener('keydown', (e) => {
  if (storyRunning()) endStory(); // any key on the picture jumps the story to its end
  if (!S.loaded || !S.key) return;
  const k = e.key;
  const { t0, t1 } = view.view();
  const pic = view.picture();
  const stepT = (e.shiftKey ? 0.05 : 0.01) * (t1 - t0), stepM = (e.shiftKey ? 0.1 : 0.02) * (pic.melHi - pic.melLo);
  let moved = false;
  if (k === 'ArrowLeft') { S.key.t = Math.max(0, S.key.t - stepT); moved = true; }
  else if (k === 'ArrowRight') { S.key.t = Math.min(S.duration, S.key.t + stepT); moved = true; }
  else if (k === 'ArrowUp') { S.key.mel = Math.min(pic.melHi, S.key.mel + stepM); moved = true; }
  else if (k === 'ArrowDown') { S.key.mel = Math.max(pic.melLo, S.key.mel - stepM); moved = true; }
  else if (k === 'Enter') {
    e.preventDefault(); e.stopPropagation();
    endSplit();
    if (S.key.points) {
      const p = { points: S.key.points, rT: S.key.rT, rM: S.key.rM, mode: S.mode };
      S.key.points = null;
      commitStroke(p);
    } else {
      S.key.points = [[S.key.t, S.key.mel]];
      S.key.rT = brushRT(); S.key.rM = S.brushPx * view.melPerPx();
      announce('Painting. Move with the arrow keys, then press Enter to finish.');
    }
    requestDraw();
    return;
  } else if (k === 'Escape') { if (S.key.points) { S.key.points = null; announce('Stroke cancelled.'); e.preventDefault(); requestDraw(); } return; }
  if (moved) {
    e.preventDefault(); e.stopPropagation();
    if (S.key.points && S.key.points.length < 600) S.key.points.push([S.key.t, S.key.mel]);
    // the view follows the brush
    const v = view.view(), span = v.t1 - v.t0;
    if (S.key.t < v.t0 || S.key.t > v.t1) { view.setView(S.key.t - span / 2, S.key.t + span / 2); viewChanged(); }
    requestDraw();
  }
});

// global keys
document.addEventListener('keydown', (e) => {
  const t = e.target;
  const tag = (t && t.tagName) || '';
  if (t && (t.isContentEditable || tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && !['checkbox', 'radio', 'range'].includes(t.type)))) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return; }
  if (mod || e.altKey) return;
  // Space plays or pauses only on the picture; anywhere else it scrolls or presses the focused control as usual
  if (e.key === ' ' && t === els.canvas) { e.preventDefault(); togglePlay(); return; }
  if (tag === 'INPUT' && t.type === 'range' && e.key.startsWith('Arrow')) return;
  switch (e.key) {
    case 'b': case 'B': flip(); break;
    case 'r': case 'R': chooseListen(S.listen === 'removed' ? 'after' : 'removed'); break;
    case '[': setBrush(S.brushPx - 2); break;
    case ']': setBrush(S.brushPx + 2); break;
    case 'f': case 'F': setMode('fill'); break;
    case 'e': case 'E': setMode('erase'); break;
    case '+': case '=': if (S.loaded) zoomCenter(0.8); break;
    case '-': case '_': if (S.loaded) zoomCenter(1.25); break;
    case '0': zoomFit(); break;
    case 'PageUp': case 'PageDown':
      // only on the picture, and only when the view can move (otherwise the page scrolls as usual)
      if (S.loaded && t === els.canvas) {
        const v = view.view();
        if (v.t1 - v.t0 < S.duration - 1e-6) { e.preventDefault(); panBy((e.key === 'PageUp' ? -0.5 : 0.5) * (v.t1 - v.t0)); }
      }
      break;
    case 'Home': if (S.loaded && t === els.canvas) { e.preventDefault(); player.seek(0); requestDraw(); } break;
    case 'End': if (S.loaded && t === els.canvas) { e.preventDefault(); player.seek(Math.max(0, S.duration - 0.05)); requestDraw(); } break;
    default: break;
  }
});

function updateBrushOut() {
  if (!S.loaded) { els.sizeOut.textContent = `about ${(2 * (coarse() ? 0.006 : 0.0016) * S.brushPx).toFixed(2)} s wide`; return; }
  els.sizeOut.textContent = `about ${(2 * brushRT()).toFixed(2)} s wide`;
}
function setBrush(px) {
  S.brushPx = Math.max(6, Math.min(48, Math.round(px)));
  els.size.value = String(S.brushPx);
  updateBrushOut();
  requestDraw();
}
function setMode(mode) {
  S.mode = mode;
  for (const r of document.querySelectorAll('input[name="pos-mode"]')) r.checked = r.value === mode;
  announce(mode === 'erase' ? 'Brush: Erase.' : 'Brush: Fill in.');
  requestDraw();
}

// ---- toolbar ---------------------------------------------------------------------------------------------------

els.play.addEventListener('click', () => { togglePlay(); });
els.ab.addEventListener('click', (e) => {
  const opt = e.target && e.target.closest ? e.target.closest('.pos-ab-opt') : null;
  if (opt && e.detail !== 0) chooseListen(opt.dataset.v);
  else chooseListen(S.listen === 'after' ? 'before' : 'after');
});
els.ab.addEventListener('keydown', (e) => {
  const order = ['before', 'after', 'removed'];
  const i = order.indexOf(S.listen);
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); chooseListen(order[Math.min(2, i + 1)]); }
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); chooseListen(order[Math.max(0, i - 1)]); }
});
els.undo.addEventListener('click', undo);
function setMore(open) {
  els.panel.hidden = !open;
  els.more.setAttribute('aria-expanded', open ? 'true' : 'false');
  els.moreLabel.textContent = open ? 'Less' : 'More';
  if (open) {
    els.panel.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' });
    const first = els.panel.querySelector('input:checked, input, button');
    if (first) first.focus({ preventScroll: true });
  }
}
els.more.addEventListener('click', () => setMore(els.panel.hidden));
els.panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setMore(false); els.more.focus(); } });
els.save.addEventListener('click', () => {
  if (!S.loaded || S.busy > 0) return;
  try {
    const chs = player.afterChannels();
    if (!chs.length) return;
    const bytes = writeWav(chs, player.rate(), { dither: S.deep });
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    const a = document.createElement('a');
    const base = S.isSample ? 'paint-out-a-cough-demo' : `${S.name.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[^\w.-]+/g, '-').slice(0, 60) || 'recording'}-painted`;
    a.href = url; a.download = `${base}.wav`;
    document.body.append(a); a.click(); a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
    announce(`Saved ${base}.wav: a 16-bit WAV file at ${player.rate().toLocaleString('en-US')} Hz.`);
  } catch (err) { showError(`Could not save the file: ${err.message}`); }
});

function hasUserEdits() { return S.strokes.slice(0, S.cursor).some((s) => !s.demo); }
els.open.addEventListener('click', () => {
  if (hasUserEdits()) { els.confirm.hidden = false; els.confirmYes.focus(); return; }
  els.file.click();
});
els.confirmYes.addEventListener('click', () => { els.confirm.hidden = true; els.file.click(); });
els.confirmNo.addEventListener('click', () => { els.confirm.hidden = true; els.open.focus(); });
els.file.addEventListener('change', () => {
  const f = els.file.files && els.file.files[0];
  els.file.value = '';
  if (f) openFile(f);
});

const MAX_SECONDS = 120;
// a long compressed file is decoded from its first few megabytes only: 6 MB hold 2 minutes at up to 400 kbit/s
// (MP3, Ogg, Opus, AAC), 24 MB cover most lossless files; formats that need the whole file fall back to it
const PREFIXES = [6e6, 24e6];
const MAX_FULL_BYTES = 160e6;

function cannotOpen(name) {
  S.loading = false; updateHint(); updateButtons();
  showError(`This browser could not open ${name}. Try another browser, or save it as WAV or MP3 first.`);
}

async function openFile(file) {
  try {
    stopPlayback();
    endSplit();
    S.loading = true;
    updateHint(); updateButtons();
    setReadout([`Opening ${file.name}…${file.size > 6e6 ? ' If it is longer than 2 minutes, only the first 2 are kept.' : ''}`]);
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    if (isWav(head)) {
      S.pendingFile = { name: file.name, file };
      const buffer = await file.arrayBuffer();
      send({ op: 'wav', name: file.name, buffer, choice: windowChoice() }, [buffer]);
    } else await decodeAndSend(file.name, null, file.size, file);
  } catch (err) {
    cannotOpen(file.name);
  }
}

async function decodeAndSend(name, buffer, size, file) {
  const decode = async (buf) => new OfflineAudioContext(1, 1, 48000).decodeAudioData(buf);
  try {
    let audio = null, prefixed = false;
    for (const bytes of PREFIXES) {
      if (buffer || !file || size <= bytes * 1.05) break;
      try { audio = await decode(await file.slice(0, bytes).arrayBuffer()); } catch (err) { audio = null; }
      if (audio && audio.duration >= MAX_SECONDS) { prefixed = true; break; }
      audio = null;
    }
    if (!audio) {
      if (!buffer && size > MAX_FULL_BYTES) { S.loading = false; updateHint(); updateButtons(); showError(`${name} is too large to open here. Trim it to 2 minutes first.`); return; }
      audio = await decode(buffer || await file.arrayBuffer());
    }
    const keep = Math.min(audio.length, Math.floor(MAX_SECONDS * audio.sampleRate));
    const chs = [];
    for (let c = 0; c < Math.min(2, audio.numberOfChannels); c++) chs.push(audio.getChannelData(c).slice(0, keep));
    const notice = [];
    if (audio.numberOfChannels > 2) notice.push(`${name} has ${audio.numberOfChannels} channels; the first two were kept.`);
    send({ op: 'pcm', name, rate: audio.sampleRate, channels: chs, choice: windowChoice(), cut: keep < audio.length || prefixed, notice: notice.join(' ') || null }, chs.map((c) => c.buffer));
  } catch (err) {
    cannotOpen(name);
  }
}

// drag and drop onto the picture
els.stage.addEventListener('dragover', (e) => { e.preventDefault(); els.app.classList.add('pos-drop'); });
els.stage.addEventListener('dragleave', () => els.app.classList.remove('pos-drop'));
els.stage.addEventListener('drop', (e) => {
  e.preventDefault();
  els.app.classList.remove('pos-drop');
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) openFile(f);
});

// ---- More ---------------------------------------------------------------------------------------------------------

for (const r of document.querySelectorAll('input[name="pos-mode"]')) r.addEventListener('change', () => { if (r.checked) setMode(r.value); });
els.size.addEventListener('input', () => setBrush(Number(els.size.value)));
for (const r of document.querySelectorAll('input[name="pos-window"]')) {
  r.addEventListener('change', () => {
    if (!r.checked || !S.loaded) return;
    S.loading = true; updateButtons();
    setReadout(['Redrawing and rebuilding with the new slice length…']);
    send({ op: 'window', token: S.token, choice: r.value });
  });
}
els.zoomIn.addEventListener('click', () => { if (S.loaded) zoomCenter(0.5); });
els.zoomOut.addEventListener('click', () => { if (S.loaded) zoomCenter(2); });
els.zoomFit.addEventListener('click', zoomFit);
els.sample.addEventListener('click', () => {
  stopPlayback();
  S.loading = true; updateHint(); updateButtons();
  send({ op: 'sample', choice: windowChoice() });
});

// ---- start --------------------------------------------------------------------------------------------------------

setBrush(S.brushPx);
setPlaying(false);
updateButtons();
const ro = new ResizeObserver(() => { view.resize(); updateBrushOut(); requestDraw(); });
ro.observe(els.stage);
view.resize();
if ('IntersectionObserver' in window) {
  // the story plays once the picture is at least 60% in view (or fills most of a short screen)
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const h = en.boundingClientRect.height || 1;
      inView = en.intersectionRatio >= 0.6 || en.intersectionRect.height >= Math.min(0.6 * h, 0.8 * window.innerHeight);
      if (inView) maybeStartStory();
    }
  }, { threshold: [0, 0.2, 0.4, 0.6, 0.8, 1] });
  io.observe(els.stage);
} else inView = true;
send({ op: 'sample', choice: windowChoice() });
requestDraw();
