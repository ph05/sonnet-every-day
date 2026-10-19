// Live figures for the explainer. Each figure is static markup in index.html (panels, captions, a hidden Play
// button); this module draws the demo clip into the panels with the page's own picture code (view.js), from
// data that the page's own engine computes in figures-worker.js, and plays a panel's stretch with the page's
// own player (audio.js). Nothing runs until a figure comes near the screen; nothing here touches the app above.
import { createView } from './view.js';
import { createPlayer } from './audio.js';

const FIGS = [...document.querySelectorAll('figure.pos-xfig')].filter((f) => f.querySelector('.pos-xfig-pic'));
const reducedMQ = matchMedia('(prefers-reduced-motion: reduce)');
const reduced = () => reducedMQ.matches;
const KNIT_MS = 1100; // Fill in: the chord grows back from both edges of the hole, as in the picture at the top
const KNIT_DELAY = 250;

// The first note of the demo clip (sample.js: the tune's first note, E5, starts at 0.15 s; each music-box
// note has partials at 1, 2, 3, 4.2 and 5.4 times its pitch).
const NOTE = { t: 0.15, hz: 440 * Math.pow(2, 7 / 12), partials: [1, 2, 3, 4.2, 5.4] };
const INK = 'rgba(244, 241, 255, 0.82)';

let data = null;
let loading = null;
// the stretch of sound a panel's Play button plays: its own version (original, erase or fill) and window
const clipKey = (el) => `${el.dataset.show || 'original'}@${el.dataset.t0}-${el.dataset.t1}`;
const panels = [];
let player = null;
let playing = null; // the panel whose stretch is playing
let want = null; // the panel the visitor last asked to play (playing starts after the audio unlocks)
let raf = 0;
let broken = false;
// a figure must never break the page: any error leaves the figures as they are and stops their animation
function safe(fn) { return (...a) => { if (broken) return undefined; try { return fn(...a); } catch (err) { broken = true; for (const f of FIGS) f.dataset.drawn = 'failed'; return undefined; } }; }

// ---- data: one worker, one answer --------------------------------------------------------------------------

function loadData() {
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    let w;
    try { w = new Worker(new URL('./figures-worker.js', import.meta.url), { type: 'module' }); } catch (err) { reject(err); return; }
    w.onmessage = (e) => {
      const m = e.data || {};
      w.terminate();
      if (m.op === 'figures') { m.zero = new Uint8Array(m.before.length); data = m; resolve(m); } else reject(new Error(m.message || 'no figures'));
    };
    w.onerror = (e) => { if (e && e.preventDefault) e.preventDefault(); w.terminate(); reject(new Error('figure worker failed')); };
    const clips = [];
    for (const f of FIGS) {
      for (const el of f.querySelectorAll('.pos-xfig-panel')) {
        if (el.querySelector('.pos-xfig-play')) clips.push({ key: clipKey(el), show: el.dataset.show || 'original', t0: Number(el.dataset.t0), t1: Number(el.dataset.t1) });
      }
    }
    w.postMessage({ op: 'figures', clips });
  });
  return loading;
}

// ---- panels -------------------------------------------------------------------------------------------------

function pictureFor(show) {
  const d = data;
  const after = show === 'erase' ? d.erase : show === 'fill' ? (reduced() ? d.fill : d.erase) : d.before;
  return { first: d.first, frames: d.frames, rows: d.rows, rate: d.rate, H: d.H, N: d.N, melLo: d.melLo, melHi: d.melHi, duration: d.duration, before: d.before, after, removed: d.zero };
}

function buildPanel(el) {
  const pic = el.querySelector('.pos-xfig-pic');
  const [base, overlay] = pic.querySelectorAll('canvas');
  const show = el.dataset.show || 'original';
  const p = {
    el, pic, show, view: createView({ stage: pic, base, overlay }),
    t0: Number(el.dataset.t0), t1: Number(el.dataset.t1), marks: el.dataset.marks || null,
    btn: el.querySelector('.pos-xfig-play'), clip: data.clips[clipKey(el)] || null, knitted: show !== 'fill' || reduced(), w: 0, h: 0,
  };
  p.picture = pictureFor(show);
  const r = pic.getBoundingClientRect();
  p.w = Math.round(r.width); p.h = Math.round(r.height);
  // picture, window and outline first: until resize() sizes the canvases, view.js draws nothing, so the
  // panel is drawn once, at its own stretch of time
  p.view.setShow(show === 'original' ? 'before' : 'after');
  p.view.setPicture(p.picture);
  const [a, b] = windowFor(p, r.width);
  p.view.setView(a, b);
  if (show !== 'original') p.view.setStrokes([{ ...data.stroke, id: 1, mode: show === 'erase' ? 'erase' : 'fill', status: 'done' }]);
  p.view.resize();
  draw(p);
  if (p.btn && p.clip && (window.AudioContext || window.webkitAudioContext)) {
    p.btn.hidden = false;
    p.btn.dataset.label = p.btn.getAttribute('aria-label') || 'Play';
    p.btn.addEventListener('click', safe(() => { togglePlay(p).catch(() => {}); }));
  }
  panels.push(p);
  el.dataset.drawn = 'true';
  resizer.observe(pic);
  if (!p.knitted) knitWatch.observe(pic);
  return p;
}

// The panel's stretch of time, centred. Like view.js, never more than 4 css px per slice: a panel too wide for its
// stretch shows a little more time on both sides, so panels of one figure keep one time scale.
function windowFor(p, width) {
  const span = Math.max(p.t1 - p.t0, (width * data.H) / data.rate / 4, 0.25);
  const a = Math.max(0, Math.min(data.duration - span, (p.t0 + p.t1) / 2 - span / 2));
  return [a, a + span];
}
function frameWindow(p) {
  const [a, b] = windowFor(p, p.view.size().W);
  p.view.setView(a, b);
}

function draw(p) {
  const s = { reduced: reduced(), labels: p.marks === 'note' ? noteLabels(p) : [], playhead: playing === p && player ? p.clip.t0 + player.now() : null };
  p.view.drawOverlay(s);
  if (p.marks === 'note') noteBracket(p);
}

// "the pitch you hear" under the lowest line, "overtones" over the stack with a bracket down its left side
function noteLabels() {
  return [
    { text: 'the pitch you hear', t: NOTE.t + 0.055, hz: NOTE.hz, dy: 20, align: 'left' },
    { text: 'overtones', t: NOTE.t - 0.03, hz: NOTE.hz * NOTE.partials[NOTE.partials.length - 1], dy: -24, align: 'left' },
  ];
}

function noteBracket(p) {
  const v = p.view;
  const c = p.pic.querySelector('canvas:last-of-type').getContext('2d');
  const { dpr } = v.size();
  const x = v.tToX(NOTE.t - 0.03) + 3;
  const ys = NOTE.partials.slice(1).map((r) => v.hzToY(NOTE.hz * r));
  const y0 = Math.min(...ys) - 4, y1 = Math.max(...ys) + 4;
  c.save();
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.strokeStyle = INK; c.lineWidth = 1.25; c.lineCap = 'round';
  c.beginPath();
  c.moveTo(x, y0 - 7); c.lineTo(x, y1);
  for (const y of ys) { c.moveTo(x, y); c.lineTo(x + 6, y); }
  // and a short tick from "the pitch you hear" up to its line
  const yf = v.hzToY(NOTE.hz), xf = v.tToX(NOTE.t + 0.055) + 12;
  c.moveTo(xf, yf + 4); c.lineTo(xf, yf + 9);
  c.stroke();
  c.restore();
}

// ---- Fill in grows the chord back, once, when its panel is in view -----------------------------------------

function knit(p) {
  if (p.knitted) return;
  p.knitted = true;
  knitWatch.unobserve(p.pic);
  window.setTimeout(safe(() => {
    const d = data, rows = d.rows;
    p.picture.after = d.fill;
    if (reduced()) { p.view.renderBase(); return; }
    p.view.knit(d.c0, d.c1, d.erase.slice(d.c0 * rows, (d.c1 + 1) * rows), KNIT_MS);
    tick();
  }), KNIT_DELAY);
}

// ---- playing a panel's stretch ------------------------------------------------------------------------------

const heroPlay = document.getElementById('pos-play');
function pauseHero() { if (heroPlay && heroPlay.dataset.playing === 'true') heroPlay.click(); }

function setButton(p, on) {
  if (!p.btn) return;
  p.btn.dataset.playing = on ? 'true' : 'false';
  p.btn.setAttribute('aria-label', on ? 'Stop' : p.btn.dataset.label);
}

async function togglePlay(p) {
  if (playing === p) { stop(); return; }
  stop();
  pauseHero();
  if (!player) player = createPlayer({ onEnded: safe(() => { const q = playing; playing = null; want = null; if (q) { setButton(q, false); draw(q); } }) });
  want = p;
  player.load(data.rate, [p.clip.samples]);
  const ok = await player.play().catch(() => false);
  // the first Play waits for the audio to unlock; meanwhile the visitor may have asked for another panel
  // (that request owns the sound now) or stopped (then the sound that just started stops too)
  if (want !== p) { if (want === null && ok) safe(() => { player.pause(); player.seek(0); })(); return; }
  if (!ok) { want = null; return; }
  safe(() => { playing = p; setButton(p, true); tick(); })();
}

function stop() {
  want = null;
  const q = playing;
  if (!q) return;
  playing = null;
  player.pause();
  player.seek(0);
  setButton(q, false);
  draw(q);
}

// the page's own playback stops a figure's, so two sounds never play at once
if (heroPlay && 'MutationObserver' in window) {
  new MutationObserver(safe(() => { if (heroPlay.dataset.playing === 'true') stop(); })).observe(heroPlay, { attributes: true, attributeFilter: ['data-playing'] });
}

// ---- animation frames: the knit and the playhead ---------------------------------------------------------

function tick() { if (!raf && !broken) raf = requestAnimationFrame(frame); }
const frame = safe(() => {
  raf = 0;
  let again = false;
  for (const p of panels) if (p.view.revealing() && p.view.stepReveals()) again = true;
  if (playing) { draw(playing); again = true; }
  if (again) tick();
});

// ---- size changes: redraw at the new size and device pixel ratio ------------------------------------------

const resized = new Set();
const resizer = 'ResizeObserver' in window ? new ResizeObserver((entries) => {
  for (const en of entries) {
    const p = panels.find((q) => q.pic === en.target);
    if (!p) continue;
    const w = Math.round(en.contentRect.width), h = Math.round(en.contentRect.height);
    if (w === p.w && h === p.h) continue;
    p.w = w; p.h = h;
    resized.add(p);
  }
  if (resized.size) requestAnimationFrame(safe(() => { for (const p of resized) { p.view.resize(); frameWindow(p); draw(p); } resized.clear(); }));
}) : { observe() {}, unobserve() {} };

const knitWatch = 'IntersectionObserver' in window ? new IntersectionObserver(safe((entries) => {
  for (const en of entries) {
    const p = panels.find((q) => q.pic === en.target);
    if (p && en.isIntersecting && en.intersectionRatio >= 0.6) knit(p);
  }
}), { threshold: [0, 0.6, 1] }) : { observe() {}, unobserve() {} };

// ---- start: each figure is drawn when it comes near the screen, one panel per idle moment -----------------

const later = 'requestIdleCallback' in window ? (fn) => window.requestIdleCallback(fn, { timeout: 250 }) : (fn) => requestAnimationFrame(fn);

function buildFigure(fig) {
  if (fig.dataset.drawn === 'pending' || fig.dataset.drawn === 'true') return;
  fig.dataset.drawn = 'pending';
  const els = [...fig.querySelectorAll('.pos-xfig-panel')];
  const step = safe(() => {
    const el = els.shift();
    if (!el) { fig.dataset.drawn = 'true'; return; }
    buildPanel(el);
    later(step);
  });
  later(step);
}

if (FIGS.length && 'IntersectionObserver' in window) {
  const near = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      near.unobserve(en.target);
      if (!en.target.dataset.drawn) en.target.dataset.drawn = 'loading';
      loadData().then(safe(() => buildFigure(en.target)), () => { en.target.dataset.drawn = 'failed'; });
    }
  }, { rootMargin: '0px 0px 40% 0px' });
  for (const f of FIGS) near.observe(f);
}
