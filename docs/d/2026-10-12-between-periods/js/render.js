// Canvas renderer for Between Periods. Rink, scars and the gleam layer live in two offscreen layers at 4 px per foot;
// everything that moves (sheen film, machine, guides, effects) is drawn on top each frame. Portrait boxes draw the
// rink rotated a quarter turn so the long axis runs down the screen. No project imports, no wall clock of its own:
// all timing comes from the nowMs the caller passes to draw().

const PPF_LO = 4;
const PPF_HI = 8;
const PAD = 3;
const FILM_MS = 2200;
const FILM_SEGS = 48;
const FILM_STEP = 0.7;
const PIXEL_CAP = 2.5e6;
const GLOW = '#bfeeff';
const FILM = '#8fe0f2';
const DASH_A = [1.1, 0.9];
const DASH_B = [0.6, 0.9];
const DASH_RING = [1.4, 1];
const CONFETTI = ['#f2a900', '#5fd3e8', '#c8412f', '#2b5fb4', '#ffffff'];
const LIGHT = { ice: '#f4fafc', dull: '#c9d8e0', gleam: '#ffffff', scar: '#4d6678', red: '#c8412f', blue: '#2b5fb4', machine: '#f2a900', ink: '#2a2f33', water: '#3fb6d1', apron: '#cfdde5' };
const DARK = { ...LIGHT, ice: '#cfe3ec', dull: '#9fb6c2', scar: '#2f4658', apron: '#0f2230' };
const EMPTY_M = { x: 0, y: 0, a: 0, speed: 0, steer: 0, tank: 100, tankMax: 100, door: false, dry: false, contact: false };
const EMPTY_STATS = { gleamPct: 0, bumps: 0, grade: 'D' };

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseHex(s) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s || '');
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4), 16)];
}

function mixHex(a, b, t) {
  const p = parseHex(a) || [255, 255, 255];
  const q = parseHex(b) || p;
  let out = '#';
  for (let i = 0; i < 3; i++) out += Math.round(p[i] + (q[i] - p[i]) * t).toString(16).padStart(2, '0');
  return out;
}

function rrect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function star(g, x, y, r) {
  const k = r * 0.22;
  g.beginPath();
  g.moveTo(x, y - r); g.lineTo(x + k, y - k); g.lineTo(x + r, y); g.lineTo(x + k, y + k);
  g.lineTo(x, y + r); g.lineTo(x - k, y + k); g.lineTo(x - r, y); g.lineTo(x - k, y - k);
  g.closePath();
}

function ease(t) { return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2; }

export function createRenderer(canvas) {
  let ctx = null;
  try { ctx = canvas.getContext('2d', { alpha: false }); } catch (err) { ctx = null; }
  if (!ctx) throw new Error('canvas2d-unavailable');

  const mq = (q) => { try { return window.matchMedia(q); } catch (err) { return null; } };
  const mqMotion = mq('(prefers-reduced-motion: reduce)');
  const mqDark = mq('(prefers-color-scheme: dark)');
  let reduced = !!(mqMotion && mqMotion.matches);
  let paletteDirty = true;
  const onMotion = (e) => { reduced = !!e.matches; };
  const onScheme = () => { paletteDirty = true; };
  if (mqMotion && mqMotion.addEventListener) mqMotion.addEventListener('change', onMotion);
  if (mqDark && mqDark.addEventListener) mqDark.addEventListener('change', onScheme);

  const under = document.createElement('canvas');
  const gleam = document.createElement('canvas');
  const uctx = under.getContext('2d');
  const gctx = gleam.getContext('2d');
  if (!uctx || !gctx) throw new Error('canvas2d-unavailable');

  let pal = null;
  let palRetry = 0;
  let palTries = 0;
  let frames = 0;
  let curRink = null;
  let curVer = -1;
  let gleamDirty = true;
  let prevPhase = '';
  let reported = false;
  let ppf = PPF_LO;
  const box = { w: 200, h: 85, dpr: 1 };
  const fit = { s: 1, tx: 0, ty: 0, portrait: false, cssW: 0, cssH: 0 };

  // Sheen film: ring buffer of the last FILM_SEGS+1 positions, with a wet flag and a timestamp each.
  const hx = new Float32Array(FILM_SEGS + 1);
  const hy = new Float32Array(FILM_SEGS + 1);
  const ht = new Float64Array(FILM_SEGS + 1);
  const hw = new Uint8Array(FILM_SEGS + 1);
  let hHead = 0;
  let hCount = 0;
  let backfilled = false;

  const fx = { ver: -1, bumps: 0, milestone: 25, shakeUntil: 0, shakeX: 0, shakeY: 0, sparkleAt: -1e9, sparkleX: 0, sparkleY: 0,
    buffAt: -1, confettiAt: -1 };
  const conf = { x: new Float32Array(64), y: new Float32Array(64), vx: new Float32Array(64), vy: new Float32Array(64), r: new Float32Array(64), s: new Float32Array(64), c: new Uint8Array(64) };

  function readPalette() {
    const base = mqDark && mqDark.matches ? DARK : LIGHT;
    let cs = null;
    try { cs = getComputedStyle(canvas); } catch (err) { cs = null; }
    const p = { ok: true };
    for (const k of Object.keys(base)) {
      const raw = cs ? cs.getPropertyValue('--rk-' + k).trim() : '';
      if (parseHex(raw)) p[k] = raw; else { p[k] = base[k]; p.ok = false; }
    }
    p.matte = mixHex(p.ice, p.dull, 0.38);
    p.gleamB = mixHex(p.gleam, GLOW, 0.24);
    p.slush = mixHex(p.gleam, p.dull, 0.25);
    p.sig = Object.keys(base).map((k) => p[k]).join();
    return p;
  }

  // The stylesheet can land after this module runs; keep re-reading (a few times) until every token resolves.
  function ensurePalette() {
    if (pal && !paletteDirty && (pal.ok || frames < palRetry || palTries >= 8)) return;
    const next = readPalette();
    if (!pal || next.sig !== pal.sig) curRink = null;
    pal = next;
    paletteDirty = false;
    palRetry = frames + 30;
    palTries++;
  }

  function sizeBacking(cw, ch) {
    let dpr = Math.min(2, window.devicePixelRatio || 1);
    while (dpr > 1 && cw * ch * dpr * dpr > PIXEL_CAP) dpr = Math.max(1, dpr - 0.25);
    const pw = Math.max(1, Math.round(cw * dpr));
    const ph = Math.max(1, Math.round(ch * dpr));
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;
    box.dpr = dpr;
  }

  function measure(cssW, cssH) {
    const portrait = cssH > cssW;
    const w = box.w;
    const h = box.h;
    fit.portrait = portrait;
    fit.cssW = cssW;
    fit.cssH = cssH;
    if (portrait) {
      fit.s = Math.min(cssW / (h + 2 * PAD), cssH / (w + 2 * PAD));
      fit.tx = (cssW + h * fit.s) / 2;
      fit.ty = (cssH - w * fit.s) / 2;
    } else {
      fit.s = Math.min(cssW / (w + 2 * PAD), cssH / (h + 2 * PAD));
      fit.tx = (cssW - w * fit.s) / 2;
      fit.ty = (cssH - h * fit.s) / 2;
    }
  }

  // Layers stay at 4 px per foot unless the screen shows more than about 9 device pixels per foot (large, dense displays).
  function chooseResolution() {
    const dpf = fit.s * box.dpr;
    const want = dpf >= 9.5 ? PPF_HI : dpf < 7 ? PPF_LO : ppf;
    if (want === ppf) return;
    ppf = want;
    curRink = null;
    gleamDirty = true;
  }

  function setWorld(dx, dy) {
    const k = fit.s * box.dpr;
    if (fit.portrait) ctx.setTransform(0, k, -k, 0, (fit.tx + dx) * box.dpr, (fit.ty + dy) * box.dpr);
    else ctx.setTransform(k, 0, 0, k, (fit.tx + dx) * box.dpr, (fit.ty + dy) * box.dpr);
  }

  // ---- static layers -------------------------------------------------------------------------------------------

  function buildUnder(rink) {
    const w = rink.w;
    const h = rink.h;
    box.w = w;
    box.h = h;
    under.width = Math.ceil(w * ppf);
    under.height = Math.ceil(h * ppf);
    const g = uctx;
    g.setTransform(ppf, 0, 0, ppf, 0, 0);
    rrect(g, 0, 0, w, h, rink.cornerR);
    g.fillStyle = pal.matte;
    g.fill();
    g.save();
    g.clip();

    const glow = g.createRadialGradient(w / 2, h / 2, 6, w / 2, h / 2, w * 0.6);
    glow.addColorStop(0, pal.ice);
    glow.addColorStop(1, pal.matte);
    g.globalAlpha = 0.6;
    g.fillStyle = glow;
    g.fillRect(0, 0, w, h);

    // Skate scratches: faint, matte, and gone wherever the gleam layer covers them.
    const rnd = mulberry32(((rink.id | 0) ^ 0x5bd1e995) >>> 0);
    g.globalAlpha = 0.55;
    g.strokeStyle = pal.dull;
    g.lineWidth = 0.14;
    g.lineCap = 'round';
    g.beginPath();
    for (let i = 0; i < 560; i++) {
      const x = rnd() * w;
      const y = rnd() * h;
      const len = 4 + rnd() * 16;
      const a = (rnd() - 0.5) * 0.9 + (rnd() < 0.25 ? 1.4 : 0);
      g.moveTo(x, y);
      g.quadraticCurveTo(x + Math.cos(a) * len * 0.5 + (rnd() - 0.5) * 3, y + Math.sin(a) * len * 0.5 + (rnd() - 0.5) * 3, x + Math.cos(a) * len, y + Math.sin(a) * len);
    }
    g.stroke();
    g.globalAlpha = 1;

    drawMarks(g, rink);
    drawZone(g, rink, rnd);
    drawScars(g, rink);
    g.restore();
  }

  function drawMarks(g, rink) {
    const mk = rink.marks || {};
    const h = rink.h;
    g.lineCap = 'butt';
    g.setLineDash([]);
    g.strokeStyle = pal.red;
    g.lineWidth = 0.4;
    for (const x of mk.goalX || []) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
    g.strokeStyle = pal.blue;
    g.lineWidth = 1.1;
    for (const x of mk.blueX || []) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
    if (mk.redX != null) {
      g.strokeStyle = pal.red;
      g.lineWidth = 1.1;
      g.beginPath(); g.moveTo(mk.redX, 0); g.lineTo(mk.redX, h); g.stroke();
      g.strokeStyle = pal.gleam;
      g.lineWidth = 0.42;
      g.setLineDash([1.6, 1.6]);
      g.beginPath(); g.moveTo(mk.redX, 0); g.lineTo(mk.redX, h); g.stroke();
      g.setLineDash([]);
    }
    const mid = mk.redX == null ? 100 : mk.redX;
    for (const d of mk.dots || []) {
      const dx = Array.isArray(d) ? d[0] : d.x;
      const dy = Array.isArray(d) ? d[1] : d.y;
      const centre = Math.abs(dx - mid) < 0.01 && Math.abs(dy - h / 2) < 0.01;
      g.fillStyle = centre ? pal.blue : pal.red;
      g.beginPath(); g.arc(dx, dy, centre ? 0.7 : 1, 0, 6.2832); g.fill();
      if (centre || Math.abs(dx - mid) > 50) {
        g.strokeStyle = centre ? pal.blue : pal.red;
        g.lineWidth = 0.38;
        g.beginPath(); g.arc(dx, dy, centre ? mk.centerR || 15 : mk.circleR || 15, 0, 6.2832); g.stroke();
      }
    }
    for (const c of mk.creases || []) {
      g.beginPath();
      g.arc(c.x, c.y, c.r, c.dir > 0 ? -Math.PI / 2 : Math.PI / 2, c.dir > 0 ? Math.PI / 2 : Math.PI * 1.5);
      g.closePath();
      g.globalAlpha = 0.55;
      g.fillStyle = '#9ec9ee';
      g.fill();
      g.globalAlpha = 1;
      g.strokeStyle = pal.red;
      g.lineWidth = 0.4;
      g.stroke();
    }
    for (const n of mk.nets || []) {
      const x0 = n.dir > 0 ? n.x - n.d : n.x;
      g.fillStyle = pal.red;
      g.globalAlpha = 0.14;
      g.fillRect(x0, n.y - n.w / 2, n.d, n.w);
      g.globalAlpha = 0.45;
      g.strokeStyle = pal.red;
      g.lineWidth = 0.1;
      g.beginPath();
      for (let k = 1; k < 6; k++) { g.moveTo(x0, n.y - n.w / 2 + k); g.lineTo(x0 + n.d, n.y - n.w / 2 + k); }
      g.stroke();
      g.globalAlpha = 1;
      g.lineWidth = 0.5;
      g.strokeRect(x0, n.y - n.w / 2, n.d, n.w);
    }
  }

  function drawZone(g, rink, rnd) {
    const ms = rink.mishap;
    const z = ms && ms.zone;
    if (!z) return;
    if (ms.id === 'slush') {
      rrect(g, z.x, z.y, z.w, z.h, 2.5);
      g.globalAlpha = 0.7;
      g.fillStyle = pal.slush;
      g.fill();
      g.globalAlpha = 0.8;
      g.fillStyle = pal.gleam;
      for (let i = 0; i < 150; i++) g.fillRect(z.x + rnd() * z.w, z.y + rnd() * z.h, 0.5 + rnd() * 0.5, 0.35);
      g.fillStyle = pal.dull;
      for (let i = 0; i < 90; i++) g.fillRect(z.x + rnd() * z.w, z.y + rnd() * z.h, 0.4, 0.4);
    } else if (ms.id === 'puddle') {
      const cx = z.x + z.w / 2;
      const cy = z.y + z.h / 2;
      g.globalAlpha = 0.32;
      g.fillStyle = pal.water;
      g.beginPath(); g.ellipse(cx, cy, z.w / 2, z.h / 2, 0, 0, 6.2832); g.fill();
      g.globalAlpha = 0.6;
      g.strokeStyle = pal.water;
      g.lineWidth = 0.22;
      for (let k = 1; k <= 3; k++) { g.beginPath(); g.ellipse(cx, cy, (z.w / 2) * (1 - k * 0.22), (z.h / 2) * (1 - k * 0.22), 0, 0, 6.2832); g.stroke(); }
    }
    g.globalAlpha = 1;
  }

  // Scars differ by shape as well as luminance: solid grooves, stippled divots, hatched snow ridges, hat footprints.
  function drawScars(g, rink) {
    const cols = rink.cols;
    const rows = rink.rows;
    const cs = rink.cell;
    const sc = rink.scar;
    if (!sc) return;
    const solid = new Path2D();
    const dotA = new Path2D();
    const dotB = new Path2D();
    const hatchA = new Path2D();
    const hatchB = new Path2D();
    // Round dots overlap their neighbours, which keeps diagonal grooves smooth instead of stair-stepped.
    const round = (path, cx, cy, k) => { path.moveTo(cx + cs * k, cy); path.arc(cx, cy, cs * k, 0, 6.2832); };
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = sc[r * cols + c];
        if (!v) continue;
        const x = c * cs;
        const y = r * cs;
        if (v === 2) {
          if ((c + r) & 1) dotB.rect(x, y, cs, cs); else round(dotA, x + cs / 2, y + cs / 2, 0.55);
        } else if (v === 3) ((c - r + 3 * rows) % 3 === 0 ? hatchA : hatchB).rect(x, y, cs, cs);
        else round(solid, x + cs / 2, y + cs / 2, 0.9);
      }
    }
    g.fillStyle = pal.scar;
    g.fill(solid);
    g.fill(dotA);
    g.fill(hatchA);
    g.globalAlpha = 0.34;
    g.fill(dotB);
    g.globalAlpha = 0.2;
    g.fill(hatchB);
    g.globalAlpha = 1;
  }

  // ---- gleam layer ---------------------------------------------------------------------------------------------

  function resizeGleam() {
    gleam.width = under.width;
    gleam.height = under.height;
  }

  // Discs just large enough to cover their cell corners: the union has a softer edge than a staircase of squares.
  function stampGleam(x, y, c, r, size) {
    gctx.fillStyle = ((c + r) >> 4) & 1 ? pal.gleamB : pal.gleam;
    gctx.beginPath();
    gctx.arc(x + size / 2, y + size / 2, size * 0.72, 0, 6.2832);
    gctx.fill();
  }

  function rebuildGleam(grid) {
    resizeGleam();
    const done = grid && grid.done;
    if (!done) return;
    const cols = grid.cols;
    const size = grid.cell * ppf;
    const halo = ppf / 2;
    const n = Math.min(done.length, cols * grid.rows);
    gctx.globalAlpha = 0.3;
    gctx.fillStyle = GLOW;
    for (let i = 0; i < n; i++) {
      if (done[i] !== 2) continue;
      gctx.fillRect(((i % cols) * size) - halo, (((i / cols) | 0) * size) - halo, size + 2 * halo, size + 2 * halo);
    }
    gctx.globalAlpha = 1;
    for (let i = 0; i < n; i++) {
      const v = done[i];
      if (!v) continue;
      const c = i % cols;
      const r = (i / cols) | 0;
      if (v === 2) stampGleam(c * size, r * size, c, r, size);
      else { gctx.globalAlpha = 0.7; gctx.fillStyle = pal.dull; gctx.fillRect(c * size, r * size, size, size); gctx.globalAlpha = 1; }
    }
  }

  function paintFresh(grid, fresh) {
    const done = grid.done;
    const cols = grid.cols;
    const size = grid.cell * ppf;
    const halo = ppf / 2;
    const n = Math.min(fresh.n, fresh.idx.length);
    for (let k = 0; k < n; k++) {
      const i = fresh.idx[k];
      const v = done[i];
      if (!v) continue;
      const c = i % cols;
      const r = (i / cols) | 0;
      if (v === 2) {
        gctx.globalCompositeOperation = 'destination-over';
        gctx.globalAlpha = 0.3;
        gctx.fillStyle = GLOW;
        gctx.fillRect(c * size - halo, r * size - halo, size + 2 * halo, size + 2 * halo);
        gctx.globalCompositeOperation = 'source-over';
        gctx.globalAlpha = 1;
        stampGleam(c * size, r * size, c, r, size);
      } else {
        gctx.globalAlpha = 0.7;
        gctx.fillStyle = pal.dull;
        gctx.fillRect(c * size, r * size, size, size);
        gctx.globalAlpha = 1;
      }
    }
  }

  function syncLayers(view) {
    const rink = view.rink;
    if (rink !== curRink) {
      buildUnder(rink);
      curRink = rink;
      gleamDirty = true;
    }
    if (view.gridVersion !== curVer) { curVer = view.gridVersion; gleamDirty = true; }
    const fresh = view.fresh;
    if ((fresh && fresh.n < 0) || (view.phase === 'done' && prevPhase !== 'done')) gleamDirty = true;
    if (gleamDirty) { rebuildGleam(view.grid); gleamDirty = false; }
    else if (fresh && fresh.n > 0 && view.grid && view.grid.done) paintFresh(view.grid, fresh);
  }

  // ---- per-frame state: film, shake, milestones, finish effects -------------------------------------------------

  function pushPoint(x, y, t, wet) {
    hHead = (hHead + 1) % hx.length;
    hx[hHead] = x; hy[hHead] = y; ht[hHead] = t; hw[hHead] = wet ? 1 : 0;
    if (hCount < hx.length) hCount++;
  }

  // Index of the k-th oldest stored point (0 = oldest).
  function filmAt(k) { return (hHead - hCount + 1 + k + hx.length * 2) % hx.length; }

  function backfillFilm(m, radius, now) {
    // First frame of a sim already in motion: extrapolate the arc just driven so the sheen is visible immediately.
    const kappa = (m.steer || 0) / (radius || 10);
    const n = 36;
    const step = 0.75;
    const px = new Float32Array(n);
    const py = new Float32Array(n);
    let x = m.x;
    let y = m.y;
    let a = m.a;
    for (let k = 0; k < n; k++) {
      px[k] = x; py[k] = y;
      x -= Math.cos(a) * step;
      y -= Math.sin(a) * step;
      a -= kappa * step;
    }
    const dt = (step / Math.max(6, m.speed)) * 1000;
    for (let k = n - 1; k >= 0; k--) pushPoint(px[k], py[k], now - k * dt, true);
  }

  function track(view, now) {
    const st = view.stats || EMPTY_STATS;
    const m = view.m || EMPTY_M;
    const phase = view.phase;
    const gp = +st.gleamPct || 0;
    if (fx.ver !== view.gridVersion) {
      fx.ver = view.gridVersion;
      fx.bumps = st.bumps | 0;
      fx.milestone = gp >= 75 ? 100 : gp >= 50 ? 75 : gp >= 25 ? 50 : 25;
      fx.shakeUntil = 0; fx.sparkleAt = -1e9; fx.buffAt = -1; fx.confettiAt = -1;
      hCount = 0; backfilled = false;
    }
    if (reduced) { hCount = 0; fx.shakeUntil = 0; fx.buffAt = -1; fx.confettiAt = -1; }

    if (phase === 'playing' && !reduced) {
      if ((st.bumps | 0) > fx.bumps && view.prefs && view.prefs.shake) fx.shakeUntil = now + 120;
      if (gp >= fx.milestone && fx.milestone <= 75) {
        if (now - fx.sparkleAt >= 1000) { fx.sparkleAt = now; fx.sparkleX = m.x; fx.sparkleY = m.y; }
        fx.milestone += 25;
      }
    }
    fx.bumps = st.bumps | 0;
    if (phase === 'done' && prevPhase !== 'done' && !reduced) {
      const g = view.result && view.result.grade;
      if (g === 'S' || g === 'A' || g === 'B') fx.buffAt = now;
      if (g === 'S' || g === 'A') {
        fx.confettiAt = now;
        const rnd = mulberry32((view.tick | 0) ^ 0x9e3779b9);
        const w = fit.cssW || 300;
        for (let i = 0; i < 64; i++) {
          conf.x[i] = rnd() * w;
          conf.y[i] = -10 - rnd() * 40;
          conf.vx[i] = (rnd() - 0.5) * 140;
          conf.vy[i] = 140 + rnd() * 160;
          conf.r[i] = rnd() * 6.28;
          conf.s[i] = 4 + rnd() * 5;
          conf.c[i] = (rnd() * CONFETTI.length) | 0;
        }
      }
    }
    prevPhase = phase;
    const t = fx.shakeUntil - now;
    if (t > 0) {
      const amp = 5 * (t / 120);
      fx.shakeX = Math.sin(now * 0.09) * amp;
      fx.shakeY = Math.cos(now * 0.13) * amp;
    } else { fx.shakeX = 0; fx.shakeY = 0; }

    if (!reduced) {
      const dry = !!m.dry || m.tank <= 0;
      if (hCount === 0 && !backfilled && m.speed > 0.1 && !dry && phase !== 'boot') {
        backfilled = true;
        backfillFilm(m, view.rink && view.rink.tune && view.rink.tune.radius, now);
      }
      const last = hCount ? hHead : -1;
      if (last < 0) pushPoint(m.x, m.y, now, !dry);
      else {
        const dx = m.x - hx[last];
        const dy = m.y - hy[last];
        const d2 = dx * dx + dy * dy;
        if (d2 > 64) hCount = 0;
        else if (d2 >= FILM_STEP * FILM_STEP && m.speed > 0.1) pushPoint(m.x, m.y, now, !dry);
      }
    }
  }

  // ---- dynamic drawing -----------------------------------------------------------------------------------------

  function lw(feet, minPx) { return Math.max(feet, minPx / fit.s); }

  function drawBoards(rink) {
    rrect(ctx, 0, 0, rink.w, rink.h, rink.cornerR);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = pal.ink;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = pal.dull;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = lw(0.35, 1);
    rrect(ctx, -1.5, -1.5, rink.w + 3, rink.h + 3, rink.cornerR + 1.5);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function drawLayers(rink) {
    ctx.save();
    rrect(ctx, 0, 0, rink.w, rink.h, rink.cornerR);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(under, 0, 0, rink.w, rink.h);
    ctx.drawImage(gleam, 0, 0, rink.w, rink.h);
    ctx.restore();
  }

  function drawDoor(rink, view, now) {
    const d = rink.door;
    if (!d) return;
    const m = view.m || EMPTY_M;
    const low = view.phase === 'playing' && m.tank < 25;
    const pulse = low && !reduced ? 0.5 + 0.5 * Math.sin((now / 1200) * 6.2832) : low ? 1 : 0;
    const x0 = d.x - d.w / 2;
    const y0 = d.y - d.h / 2;
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, y0, d.w, d.h); ctx.clip();
    ctx.globalAlpha = m.door ? 0.32 : 0.2 + 0.12 * pulse;
    ctx.strokeStyle = pal.machine;
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    for (let k = -d.h; k < d.w; k += 3) { ctx.moveTo(x0 + k, y0 + d.h); ctx.lineTo(x0 + k + d.h, y0); }
    ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = pal.machine;
    ctx.lineWidth = lw(0.4 + 0.3 * pulse, 2);
    ctx.setLineDash(DASH_A);
    ctx.globalAlpha = 0.95;
    ctx.strokeRect(x0, y0, d.w, d.h);
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    // The gap in the boards: a gate bar across the board line, opposite the inward normal.
    ctx.fillStyle = pal.machine;
    ctx.strokeStyle = pal.ink;
    ctx.lineWidth = 0.3;
    if (Math.abs(d.ny) >= Math.abs(d.nx)) {
      const by = d.y - Math.sign(d.ny || 1) * d.h / 2;
      ctx.fillRect(x0, by - 0.8, d.w, 1.6);
      ctx.strokeRect(x0, by - 0.8, d.w, 1.6);
    } else {
      const bx = d.x - Math.sign(d.nx) * d.w / 2;
      ctx.fillRect(bx - 0.8, y0, 1.6, d.h);
      ctx.strokeRect(bx - 0.8, y0, 1.6, d.h);
    }
    // Drop glyph in the middle of the zone.
    ctx.save();
    ctx.translate(d.x, d.y);
    ctx.fillStyle = pal.water;
    ctx.strokeStyle = pal.ink;
    ctx.lineWidth = lw(0.28, 1.2);
    ctx.beginPath();
    ctx.moveTo(0, -2); ctx.bezierCurveTo(1.8, 0.6, 1.8, 2, 0, 2); ctx.bezierCurveTo(-1.8, 2, -1.8, 0.6, 0, -2);
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  function drawHat(it, now, i) {
    const wob = reduced ? 0 : Math.sin(now / 520 + i * 1.7) * 0.07;
    ctx.save();
    ctx.translate(it.x, it.y);
    ctx.rotate((it.a || 0) + wob);
    ctx.lineWidth = lw(0.16, 1);
    ctx.strokeStyle = pal.ink;
    const k = (it.k | 0) & 3;
    if (k === 0) {
      ctx.fillStyle = '#3b4249';
      ctx.beginPath(); ctx.ellipse(0, 0, 1.25, 0.9, 0, 0, 6.2832); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#58616a';
      ctx.beginPath(); ctx.ellipse(0, 0, 0.62, 0.46, 0, 0, 6.2832); ctx.fill();
      ctx.strokeStyle = pal.red; ctx.lineWidth = 0.22;
      ctx.beginPath(); ctx.ellipse(0, 0, 0.7, 0.52, 0, 0, 6.2832); ctx.stroke();
    } else if (k === 1) {
      ctx.fillStyle = '#2b4f8f';
      ctx.beginPath(); ctx.ellipse(1.0, 0, 0.9, 0.85, 0, -1.57, 1.57); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, 0.95, 0, 6.2832); ctx.fill(); ctx.stroke();
      ctx.fillStyle = pal.gleam;
      ctx.beginPath(); ctx.arc(0, 0, 0.18, 0, 6.2832); ctx.fill();
    } else if (k === 2) {
      ctx.fillStyle = pal.machine;
      ctx.beginPath(); ctx.arc(0, 0, 0.95, 0, 6.2832); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = pal.ink; ctx.lineWidth = 0.1;
      ctx.beginPath(); for (let r = -0.6; r <= 0.61; r += 0.3) { ctx.moveTo(-0.8, r); ctx.lineTo(0.8, r); }
      ctx.stroke();
      ctx.fillStyle = pal.gleam; ctx.lineWidth = lw(0.12, 1);
      ctx.beginPath(); ctx.arc(0, 0, 0.3, 0, 6.2832); ctx.fill(); ctx.stroke();
    } else {
      ctx.fillStyle = '#a8814a';
      ctx.beginPath(); ctx.ellipse(0, 0, 1.3, 1.05, 0, 0, 6.2832); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#7d5c32';
      ctx.beginPath(); ctx.ellipse(0, 0, 0.62, 0.55, 0, 0, 6.2832); ctx.fill();
    }
    ctx.restore();
  }

  function drawHats(rink, view, now) {
    const ms = rink.mishap;
    if (!ms || ms.id !== 'hats' || !ms.items || !view.grid || !view.grid.done) return;
    const done = view.grid.done;
    const cols = view.grid.cols;
    const cs = view.grid.cell;
    for (let i = 0; i < ms.items.length; i++) {
      const it = ms.items[i];
      if (done[((it.y / cs) | 0) * cols + ((it.x / cs) | 0)] === 2) continue;
      drawHat(it, now, i);
    }
  }

  function drawZoneEdge(rink) {
    const z = rink.mishap && rink.mishap.zone;
    if (!z) return;
    ctx.strokeStyle = pal.water;
    ctx.lineWidth = lw(0.3, 1.5);
    ctx.setLineDash(DASH_B);
    if (rink.mishap.id === 'puddle') { ctx.beginPath(); ctx.ellipse(z.x + z.w / 2, z.y + z.h / 2, z.w / 2, z.h / 2, 0, 0, 6.2832); ctx.stroke(); }
    else { rrect(ctx, z.x, z.y, z.w, z.h, 2.5); ctx.stroke(); }
    ctx.setLineDash([]);
  }

  function drawFilm(now, swath) {
    if (reduced || hCount < 2) return;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';
    for (let g = 0; g < hCount - 1; g += 6) {
      const end = Math.min(g + 6, hCount - 1);
      const mid = filmAt((g + end) >> 1);
      const u = (now - ht[mid]) / FILM_MS;
      if (u >= 1) continue;
      const a = 0.8 * (1 - u) * (1 - u * 0.4);
      let started = false;
      ctx.beginPath();
      for (let j = g; j <= end; j++) {
        const p = filmAt(j);
        if (!hw[p]) { started = false; continue; }
        if (started) ctx.lineTo(hx[p], hy[p]); else { ctx.moveTo(hx[p], hy[p]); started = true; }
      }
      ctx.globalAlpha = a;
      ctx.strokeStyle = FILM;
      ctx.lineWidth = swath;
      ctx.stroke();
      ctx.globalAlpha = Math.min(1, a * 1.1);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = swath * 0.42;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function strokeArc(arr, n, x0, y0) {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    for (let i = 0; i < n; i++) ctx.lineTo(arr[i * 2], arr[i * 2 + 1]);
  }

  function drawArcs(view, m) {
    const ar = view.arcs;
    if (!ar || !(ar.n > 1) || !view.prefs || !view.prefs.assist) return;
    const n = Math.min(ar.n | 0, 24);
    ctx.lineCap = 'round';
    ctx.setLineDash(DASH_A);
    if (ar.left && ar.right) {
      ctx.strokeStyle = pal.machine;
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = lw(0.28, 1.4);
      strokeArc(ar.left, n, m.x, m.y); ctx.stroke();
      strokeArc(ar.right, n, m.x, m.y); ctx.stroke();
    }
    if (ar.now) {
      strokeArc(ar.now, n, m.x, m.y);
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = lw(0.9, 4);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = pal.blue;
      ctx.lineWidth = lw(0.45, 2.2);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  function drawMachine(view, m, swath, now) {
    const dry = !!m.dry || m.tank <= 0;
    const tankPct = m.tankMax > 0 ? (100 * m.tank) / m.tankMax : 100;
    ctx.save();
    ctx.translate(m.x, m.y);
    ctx.rotate(m.a);
    // Shadow, squeegee bar (the full stripe width), then the body.
    ctx.globalAlpha = 0.2;
    ctx.fillStyle = '#000000';
    rrect(ctx, -4.0, -2.6, 9, 6.4, 1.6); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = pal.ink;
    ctx.fillRect(-5.4, -swath / 2, 0.9, swath);
    ctx.fillStyle = dry ? pal.red : pal.water;
    ctx.fillRect(-5.4, -swath / 2, 0.25, swath);
    if (!dry && m.speed > 0.5) {
      ctx.strokeStyle = pal.water; ctx.lineWidth = 0.28;
      ctx.beginPath();
      for (const s of [-1, 1]) { ctx.moveTo(-4.4, s * 3.2); ctx.lineTo(-5.3, s * 3.9); ctx.moveTo(-3.8, s * 3.3); ctx.lineTo(-4.8, s * 4.0); }
      ctx.stroke();
    }
    // Wheels: front pair turns with the steering.
    ctx.fillStyle = pal.ink;
    const ang = (m.steer || 0) * 0.5;
    for (const s of [-1, 1]) {
      ctx.fillRect(-3.6, s * 3.0 - 0.5, 1.8, 1.0);
      ctx.save();
      ctx.translate(2.8, s * 3.0);
      ctx.rotate(ang);
      ctx.fillRect(-0.9, -0.5, 1.8, 1.0);
      ctx.restore();
    }
    ctx.fillStyle = pal.machine;
    ctx.strokeStyle = pal.ink;
    ctx.lineWidth = lw(0.3, 1.2);
    rrect(ctx, -4.4, -3.1, 8.8, 6.2, 1.6); ctx.fill(); ctx.stroke();
    ctx.fillStyle = pal.ink;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(3.9, -3.0, 0.6, 6.0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#ffe08a';
    rrect(ctx, -3.9, -2.5, 3.2, 5, 0.7); ctx.fill();
    ctx.lineWidth = 0.1;
    ctx.beginPath(); ctx.moveTo(-3.1, -2.2); ctx.lineTo(-3.1, 2.2); ctx.moveTo(-2.3, -2.2); ctx.lineTo(-2.3, 2.2); ctx.stroke();
    ctx.fillStyle = pal.ink;
    rrect(ctx, 0, -2.2, 3.2, 4.4, 1); ctx.fill();
    ctx.fillStyle = pal.water;
    ctx.globalAlpha = 0.7;
    ctx.fillRect(2.3, -1.8, 0.6, 3.6);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(4.0, -2.3, 0.35, 0, 6.2832); ctx.arc(4.0, 2.3, 0.35, 0, 6.2832); ctx.fill();
    ctx.restore();

    if (view.phase === 'playing' || view.phase === 'paused') {
      if (dry) {
        ctx.strokeStyle = pal.red; ctx.lineWidth = lw(0.4, 2); ctx.setLineDash(DASH_RING);
        ctx.beginPath(); ctx.arc(m.x, m.y, 6.6, 0, 6.2832); ctx.stroke(); ctx.setLineDash([]);
      } else if (tankPct < 25) {
        ctx.strokeStyle = pal.machine; ctx.lineWidth = lw(0.5, 2.5);
        if (reduced) ctx.setLineDash(DASH_RING);
        else ctx.globalAlpha = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin((now / 1200) * 6.2832));
        ctx.beginPath(); ctx.arc(m.x, m.y, 6.6, 0, 6.2832); ctx.stroke();
        ctx.setLineDash([]); ctx.globalAlpha = 1;
      }
    }
    if (m.door && !reduced && view.phase === 'playing') {
      const p = (now % 900) / 900;
      ctx.strokeStyle = pal.water; ctx.lineWidth = lw(0.4, 2);
      ctx.globalAlpha = 1 - p;
      ctx.beginPath(); ctx.arc(m.x, m.y, 3 + p * 6, 0, 6.2832); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    const ms = view.rink && view.rink.mishap;
    if (ms && ms.id === 'drip' && !dry && m.speed > 0.5 && !reduced) {
      const ph = (now % 360) / 360;
      ctx.fillStyle = pal.water;
      ctx.globalAlpha = 1 - ph;
      ctx.beginPath(); ctx.arc(m.x - Math.cos(m.a) * (7 + ph * 3), m.y - Math.sin(m.a) * (7 + ph * 3), 0.45, 0, 6.2832); ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  function drawAim(view) {
    const a = view.aim;
    if (!a || view.phase !== 'playing') return;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = lw(0.9, 4);
    ctx.beginPath(); ctx.arc(a.x, a.y, 1.6, 0, 6.2832); ctx.moveTo(a.x - 2.6, a.y); ctx.lineTo(a.x + 2.6, a.y); ctx.moveTo(a.x, a.y - 2.6); ctx.lineTo(a.x, a.y + 2.6); ctx.stroke();
    ctx.strokeStyle = pal.blue;
    ctx.lineWidth = lw(0.4, 2);
    ctx.stroke();
  }

  function drawSparkle(now) {
    const t = (now - fx.sparkleAt) / 300;
    if (t < 0 || t >= 1) return;
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = pal.water;
    ctx.lineWidth = lw(0.2, 1);
    ctx.globalAlpha = 1 - t;
    for (let i = 0; i < 7; i++) {
      const ang = i * 0.9 + 0.4;
      const d = 3 + t * 8 + (i % 3) * 1.5;
      star(ctx, fx.sparkleX + Math.cos(ang) * d, fx.sparkleY + Math.sin(ang) * d, 1.2 + (i % 2) * 0.8);
      ctx.fill(); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function drawBuff(rink, now) {
    const t = (now - fx.buffAt) / 900;
    if (fx.buffAt < 0 || t >= 1) return;
    const x = -25 + (rink.w + 50) * ease(t);
    const grad = ctx.createLinearGradient(x - 18, 0, x + 18, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.85)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.save();
    rrect(ctx, 0, 0, rink.w, rink.h, rink.cornerR);
    ctx.clip();
    ctx.fillStyle = grad;
    ctx.fillRect(x - 18, 0, 36, rink.h);
    ctx.restore();
  }

  function drawConfetti(now) {
    const t = (now - fx.confettiAt) / 1000;
    if (fx.confettiAt < 0 || t < 0 || t >= 1.4) return;
    const d = box.dpr;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.globalAlpha = t > 1.1 ? (1.4 - t) / 0.3 : 1;
    for (let i = 0; i < 64; i++) {
      const x = conf.x[i] + conf.vx[i] * t;
      const y = conf.y[i] + conf.vy[i] * t + 120 * t * t;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(conf.r[i] + t * 6);
      ctx.fillStyle = CONFETTI[conf.c[i]];
      ctx.fillRect(-conf.s[i] / 2, -conf.s[i] / 4, conf.s[i], conf.s[i] / 2);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  function drawFrame(view, now) {
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    if (!cw || !ch) return;
    ensurePalette();
    frames++;
    sizeBacking(cw, ch);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = pal.apron;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const rink = view && view.rink;
    if (!rink || !rink.scar || !(rink.w > 0)) return;
    if (rink.w !== box.w || rink.h !== box.h) { box.w = rink.w; box.h = rink.h; }
    measure(cw, ch);
    chooseResolution();
    syncLayers(view);
    track(view, now);
    const m = view.m || EMPTY_M;
    const swath = (rink.tune && rink.tune.swath) || 8;

    setWorld(fx.shakeX, fx.shakeY);
    drawBoards(rink);
    drawLayers(rink);
    drawZoneEdge(rink);
    drawDoor(rink, view, now);
    drawHats(rink, view, now);
    drawFilm(now, swath);
    drawArcs(view, m);
    drawMachine(view, m, swath, now);
    drawAim(view);
    if (!reduced) { drawSparkle(now); drawBuff(rink, now); drawConfetti(now); }
  }

  function report(err) {
    if (reported) return;
    reported = true;
    try {
      document.dispatchEvent(new CustomEvent('app:error', { detail: { where: 'render', message: String((err && err.message) || err), fatal: false } }));
    } catch (e) { /* nothing left to tell */ }
  }

  return {
    draw(view, nowMs) {
      try { drawFrame(view, +nowMs || 0); } catch (err) { report(err); }
    },
    toLogical(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      if (!(rect.width > 0) || !(rect.height > 0)) return null;
      measure(rect.width, rect.height);
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      return fit.portrait ? { x: (py - fit.ty) / fit.s, y: (fit.tx - px) / fit.s } : { x: (px - fit.tx) / fit.s, y: (py - fit.ty) / fit.s };
    },
    isPortrait() { return canvas.clientHeight > canvas.clientWidth; },
    dispose() {
      if (mqMotion && mqMotion.removeEventListener) mqMotion.removeEventListener('change', onMotion);
      if (mqDark && mqDark.removeEventListener) mqDark.removeEventListener('change', onScheme);
      under.width = 1; under.height = 1; gleam.width = 1; gleam.height = 1;
      curRink = null;
    },
  };
}
