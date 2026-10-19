// The ladder figures in the explanation: each starts from a named preset and is drawn when it first scrolls near view.
import * as E from './engine.js';
import * as V from './views.js';
import { PEBBLE, FOG, curveLabel } from './hero.js';
import { judge300 } from './selftest.js';

const $ = (id) => document.getElementById(id);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const radioValue = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value;
const onRadio = (name, fn) => { for (const r of document.querySelectorAll(`input[name="${name}"]`)) r.addEventListener('change', () => { if (r.checked) fn(r.value); }); };
const ink = () => V.cssVar('--fg');
const muted = () => V.cssVar('--muted');
const CONE_COLORS = () => [V.cssVar('--cone-l'), V.cssVar('--cone-m'), V.cssVar('--cone-s')];
const hexOf = (R, lamp) => E.hex(E.displayRGB(R, lamp).rgb);
const label = (ctx, text, x, y, color, align = 'left') => {
  ctx.font = '600 12px system-ui, sans-serif';
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'top';
  ctx.fillText(text, x, y);
};
// Lamp spectra: a saturated, darker hue on light backgrounds and the pale glow on dark ones, so narrow lines always show.
const lampCol = (id) => V.lampInk(id, !V.isDark());
const wallVars = (el, lamp) => {
  const wall = E.flatRGB(E.WALL, lamp);
  el.style.setProperty('--m-hi', E.hex(wall));
  el.style.setProperty('--m-lo', E.hex(wall.map((v) => v * 0.78)));
};

// ---- figure 1: three lamps, one pair ------------------------------------------------------------------------------------------
function fig1() {
  const btn = $('fig1-swap');
  let swapped = false;
  const draw = () => {
    const Ra = E.curve(PEBBLE), Rb = E.curve(swapped ? PEBBLE : FOG);
    for (const m of document.querySelectorAll('#fig1-walls .mini')) {
      const lamp = m.dataset.lamp;
      wallVars(m.querySelector('.mini-wall'), lamp);
      m.querySelector('.mini-a').style.background = hexOf(Ra, lamp);
      m.querySelector('.mini-b').style.background = hexOf(Rb, lamp);
      m.querySelector('.mini-d').textContent = E.diff(Ra, Rb, lamp).toFixed(1);
    }
  };
  btn.addEventListener('click', () => {
    swapped = !swapped;
    btn.setAttribute('aria-pressed', String(swapped));
    btn.textContent = swapped ? 'Bring Fog back' : 'Replace Fog with a second can of Pebble';
    draw();
  });
  return draw;
}

// ---- figure 2: light times paint ----------------------------------------------------------------------------------------------
function fig2() {
  const c = $('fig2-canvas');
  const hit = $('fig2-drag');
  let h = Float64Array.from(PEBBLE);
  let lamp = 'A';
  let ed = null;
  const rows = (w, H) => {
    const x = 40, ww = w - 52, gap = 26, rh = (H - 22 - 2 * gap - 18) / 3;
    return [0, 1, 2].map((i) => ({ x, y: 18 + i * (rh + gap), w: ww, h: rh }));
  };
  const draw = () => {
    const { ctx, w, h: H } = V.fitCanvas(c);
    const [top, mid, bot] = rows(w, H);
    const spec = E.lampSpectrum(lamp);
    const col = lampCol(lamp);
    const R = E.curve(h);
    const fg = ink(), mu = muted();
    // the drag area covers the middle row only: elsewhere a vertical swipe scrolls the page
    hit.style.top = `${mid.y - 10}px`;
    hit.style.height = `${mid.h + 20}px`;
    label(ctx, `${E.LAMPS[lamp].name}: its light`, top.x, top.y - 16, mu);
    V.drawLamp(ctx, top, spec, col, 1.4, !V.isDark());
    if (spec.kind === 'table') V.drawCurve(ctx, top, spec.values, { fill: 0, color: `rgb(${col})`, width: 2, scale: 0.96 });
    V.drawBand(ctx, top, 3);
    label(ctx, 'times Pebble\'s curve (drag it)', mid.x, mid.y - 16, mu);
    V.drawAxis(ctx, mid, fg, { nm: false });
    V.drawCurve(ctx, mid, R, { fill: 0.4, color: fg, width: 2.2 });
    V.drawHandles(ctx, mid, h, ed ? ed.selected() : 6, ed ? ed.focused() : false, fg);
    V.drawBand(ctx, mid, 3);
    label(ctx, 'equals the light that reaches your eye', bot.x, bot.y - 16, mu);
    if (spec.kind === 'table') V.drawCurve(ctx, bot, R.map((r, i) => r * spec.values[i]), { fill: 0.6, color: fg, width: 1.8, scale: 0.96 });
    else {
      const x = V.xOf(spec.nm, bot), v = E.at(R, spec.nm);
      ctx.fillStyle = fg;
      ctx.fillRect(x - 2, V.yOf(v, bot), 4, v * bot.h);
    }
    V.drawBand(ctx, bot, 3);
    V.drawAxis(ctx, bot, fg, { pct: false });
    $('fig2-color').style.background = hexOf(R, lamp);
    c.setAttribute('aria-label', `${curveLabel('Pebble', h)} ${cap(E.LAMPS[lamp].under)} the light that reaches your eye looks ${E.colorName(E.labOfDisplay(E.displayRGB(R, lamp).rgb))}. Left and Right choose a point, Up and Down move it.`);
  };
  ed = V.curveEditor(c, { getH: () => h, setH: (v) => { h = v; }, getQ: () => null, box: (w, H) => rows(w, H)[1], draw, hit });
  onRadio('fig2-lamp', (v) => { lamp = v; draw(); });
  $('fig2-reset').addEventListener('click', () => {
    h = Float64Array.from(PEBBLE);
    lamp = 'A';
    for (const r of document.querySelectorAll('input[name="fig2-lamp"]')) r.checked = r.value === 'A';
    draw();
  });
  return draw;
}

// ---- figure 3: three numbers ----------------------------------------------------------------------------------------------------
function fig3() {
  const c = $('fig3-canvas');
  const bars = $('fig3-bars');
  bars.innerHTML = ['L', 'M', 'S'].map((k, i) => `<span class="bigbar"><i style="background:var(--cone-${k.toLowerCase()})"></i><b>${k}<br><span data-v="${i}">0.000</span></b></span>`).join('');
  const draw = () => {
    const paint = radioValue('fig3-paint') === 'b' ? FOG : PEBBLE;
    const lamp = radioValue('fig3-lamp') || 'FL11';
    const { ctx, w, h } = V.fitCanvas(c);
    const box = { x: 12, y: 22, w: w - 24, h: h - 50 };
    const R = E.curve(paint);
    const spec = E.lampSpectrum(lamp).values;
    const light = R.map((r, i) => r * spec[i]);
    const peak = Math.max(...light.slice(4, 65));
    V.drawCurve(ctx, box, light.map((v) => v / peak), { fill: 0.55, color: ink(), width: 1.6, scale: 0.92 });
    const cols = CONE_COLORS();
    E.coneCurves.forEach((cc, k) => V.drawCurve(ctx, box, cc, { fill: 0, color: cols[k], width: 2.2, scale: 0.98 }));
    V.drawBand(ctx, box, 4);
    V.drawAxis(ctx, box, ink(), { pct: false });
    label(ctx, w < 520 ? `Light from ${paint === FOG ? 'Fog' : 'Pebble'}, with the 3 cone curves` : `Light from ${paint === FOG ? 'Fog' : 'Pebble'} ${E.LAMPS[lamp].under}, with the L, M and S cone curves`, box.x, 4, muted());
    const cs = E.cones(R, lamp);
    V.setBars(bars, cs);
    for (const s of bars.querySelectorAll('[data-v]')) s.textContent = cs[+s.dataset.v].toFixed(3);
    bars.setAttribute('aria-label', `Cone signals: long ${cs[0].toFixed(3)}, medium ${cs[1].toFixed(3)}, short ${cs[2].toFixed(3)}`);
  };
  onRadio('fig3-paint', draw);
  onRadio('fig3-lamp', draw);
  return draw;
}

// ---- figure 4: the invisible wiggle -----------------------------------------------------------------------------------------------
function fig4() {
  const c = $('fig4-canvas');
  const btn = $('fig4-wiggle');
  const R0 = E.curve(FOG);
  let cur = Float64Array.from(FOG);
  let run = null;
  let seed = 500;
  const other = (lamp) => (lamp === 'A' ? 'D65' : 'A');
  const draw = () => {
    const lamp = radioValue('fig4-lamp') || 'FL11';
    const { ctx, w, h } = V.fitCanvas(c);
    const box = { x: 40, y: 12, w: w - 52, h: h - 40 };
    V.drawAxis(ctx, box, ink());
    V.drawLamp(ctx, box, E.lampSpectrum(lamp), lampCol(lamp), 1.3, !V.isDark());
    V.drawCurve(ctx, box, R0, { fill: 0, color: muted(), width: 1.5, dash: [5, 4] });
    const R = E.curve(cur);
    V.drawCurve(ctx, box, R, { fill: 0.4, color: ink(), width: 2.2 });
    V.drawBand(ctx, box, 4);
    if (E.LAMPS[lamp].kind === 'line') {
      // the one height this lamp can see: it stays pinned while everything else moves
      const x = V.xOf(E.LAMPS[lamp].nm, box), y = V.yOf(E.at(R, E.LAMPS[lamp].nm), box);
      ctx.beginPath();
      ctx.arc(x, y, 5.5, 0, Math.PI * 2);
      ctx.fillStyle = V.cssVar('--surface');
      ctx.fill();
      ctx.lineWidth = 2.4;
      ctx.strokeStyle = ink();
      ctx.stroke();
      const tx = `pinned at ${E.LAMPS[lamp].nm} nm`, ty = Math.max(box.y, y - 24);
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.fillStyle = V.cssVar('--surface');
      ctx.fillRect(x + 8, ty - 2, ctx.measureText(tx).width + 8, 18);
      label(ctx, tx, x + 12, ty, ink());
    }
    const o = other(lamp);
    const same = E.diff(R0, R, lamp), diff = E.diff(R0, R, o);
    $('fig4-same').textContent = `${cap(E.LAMPS[lamp].under)} (the lamp it hides from): difference from the original Fog ${same.toFixed(1)}`;
    $('fig4-other').textContent = `${cap(E.LAMPS[o].under)}: ${diff.toFixed(1)}`;
    $('fig4-sw0').style.background = hexOf(R0, lamp);
    $('fig4-sw1').style.background = hexOf(R, lamp);
    $('fig4-sw2').style.background = hexOf(R0, o);
    $('fig4-sw3').style.background = hexOf(R, o);
  };
  const stop = () => {
    if (run) cancelAnimationFrame(run.raf);
    run = null;
    btn.textContent = 'Wiggle Fog';
  };
  const start = () => {
    if (run) { run.stopAt = run.stopAt ?? (performance.now() - run.t0) / 1000; return; }
    const lamp = radioValue('fig4-lamp') || 'FL11';
    run = Object.assign(E.wiggleBumps(() => seed++, FOG, E.seenBasis(lamp)), { lamp, t0: performance.now(), stopAt: null });
    btn.textContent = 'Stop';
    const at = (t, env) => E.wiggleAt(run, t, env);
    if (V.reduceMotion()) {
      cur = at(1 + 1.7 * seed, 1);
      draw();
      run = null;
      btn.textContent = 'Show another';
      return;
    }
    const tick = (now) => {
      if (!run) return;
      const t = (now - run.t0) / 1000;
      let env = Math.min(1, t / 0.6, (6 - t) / 0.6);
      if (run.stopAt !== null) env = Math.min(env, 1 - (t - run.stopAt) / 0.6);
      env = Math.max(0, env);
      cur = at(t, env);
      draw();
      if (t >= 6 || (run.stopAt !== null && t - run.stopAt >= 0.6)) { cur = Float64Array.from(FOG); draw(); stop(); return; }
      run.raf = requestAnimationFrame(tick);
    };
    run.raf = requestAnimationFrame(tick);
  };
  btn.addEventListener('click', start);
  onRadio('fig4-lamp', () => { stop(); cur = Float64Array.from(FOG); draw(); });
  return draw;
}

// ---- figure 5: the lamp lab -------------------------------------------------------------------------------------------------------
function fig5() {
  const hist = $('fig5-hist');
  const runBtn = $('fig5-run');
  const out = $('fig5-result');
  let pairs = null;
  let seed = 1;
  const sparks = () => {
    for (const s of document.querySelectorAll('.lamp-spark')) {
      const { ctx, w, h } = V.fitCanvas(s);
      const box = { x: 1, y: 2, w: w - 2, h: h - 6 };
      const id = s.dataset.lamp;
      V.drawLamp(ctx, box, E.lampSpectrum(id), lampCol(id), 1.5, !V.isDark());
      const spec = E.lampSpectrum(id);
      if (spec.kind === 'table') V.drawCurve(ctx, box, spec.values, { fill: 0, color: ink(), width: 1.2, scale: 0.96 });
      V.drawBand(ctx, box, 3);
    }
  };
  const pair = () => {
    const lamp = radioValue('fig5-lamp') || 'FL11';
    const Ra = E.curve(PEBBLE), Rb = E.curve(FOG);
    wallVars($('fig5-wall'), lamp);
    $('fig5-a').style.background = hexOf(Ra, lamp);
    $('fig5-b').style.background = hexOf(Rb, lamp);
    const d = E.diff(Ra, Rb, lamp);
    $('fig5-d').textContent = `Pebble and Fog ${E.LAMPS[lamp].under}: ${d.toFixed(1)}, ${E.verdict(d).toLowerCase()}`;
    const note = $('fig5-note');
    if (lamp === 'sodium') note.textContent = `In this modeled lamp only lightness is left: Pebble sends back ${(100 * E.at(Ra, 589)).toFixed(0)}% at 589 nm and Fog ${(100 * E.at(Rb, 589)).toFixed(0)}%.`;
    else if (lamp === 'FL11' || lamp === 'P3999') {
      const a = E.chroma(E.white('FL11')), b = E.chroma(E.white('P3999'));
      note.textContent = `The shop light and the smooth glow give light of the same color: the CIE's two numbers for the color of a light, x and y, are (${a[0].toFixed(4)}, ${a[1].toFixed(4)}) and (${b[0].toFixed(4)}, ${b[1].toFixed(4)}). Their shapes are nothing alike.`;
    } else note.textContent = `${E.LAMPS[lamp].detail}.`;
  };
  const drawHist = () => {
    const { ctx, w, h } = V.fitCanvas(hist);
    const box = { x: 30, y: 28, w: w - 40, h: h - 66 };
    const cols = ['#c0683a', '#4d6bc0'];
    label(ctx, 'Pairs matched under the warm bulb, judged by:', box.x, 4, muted());
    const lx = w < 560 ? box.x : box.x + 300, ly = w < 560 ? 18 : 4;
    ctx.fillStyle = cols[0]; ctx.fillRect(lx, ly + 3, 10, 10); label(ctx, 'shop light', lx + 14, ly, ink());
    ctx.fillStyle = cols[1]; ctx.fillRect(lx + 100, ly + 3, 10, 10); label(ctx, 'smooth glow', lx + 114, ly, ink());
    const maxD = 12, nb = 24;
    const counts = [new Array(nb).fill(0), new Array(nb).fill(0)];
    for (const p of pairs || []) for (let s = 0; s < 2; s++) counts[s][Math.min(nb - 1, Math.floor((p[s] / maxD) * nb))]++;
    const top = Math.max(4, ...counts[0], ...counts[1]);
    const bw = box.w / nb;
    for (let s = 0; s < 2; s++) for (let i = 0; i < nb; i++) {
      const v = counts[s][i] / top;
      ctx.fillStyle = cols[s];
      ctx.globalAlpha = 0.72;
      ctx.fillRect(box.x + i * bw + (s ? bw / 2 : 1), box.y + box.h - v * box.h, bw / 2 - 1, v * box.h);
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = muted();
    ctx.beginPath(); ctx.moveTo(box.x, box.y + box.h + 0.5); ctx.lineTo(box.x + box.w, box.y + box.h + 0.5); ctx.stroke();
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = muted();
    ctx.textBaseline = 'top';
    for (const d of [0, 2, 4, 6, 8, 10, 12]) { ctx.textAlign = d === 12 ? 'right' : d === 0 ? 'left' : 'center'; ctx.fillText(d === 12 ? '12 or more' : String(d), box.x + (d / maxD) * box.w, box.y + box.h + 6); }
    ctx.textAlign = 'center';
    ctx.fillText('color difference of the pair', box.x + box.w / 2, box.y + box.h + 6 + 13);
  };
  const say = (s) => {
    out.textContent = `${s.n} pairs: the shop light split them more than the smooth glow in ${Math.round(100 * s.more)} of every 100 (typical split ${s.medA.toFixed(1)} against ${s.medB.toFixed(1)}).`;
  };
  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true;
    out.textContent = 'Making pairs...';
    if (seed === 1) {
      const s = await judge300();
      pairs = s.pairs; drawHist(); say(s);
    } else {
      const j = E.judge(seed);
      let s = null;
      for (let i = 0; i < 12; i++) {
        s = j.step(25); pairs = s.pairs; drawHist();
        out.textContent = `${s.n} pairs so far...`;
        await new Promise((r) => requestAnimationFrame(r));
      }
      say(s);
    }
    seed++;
    runBtn.disabled = false;
    runBtn.textContent = 'Test 300 new random pairs';
  });
  onRadio('fig5-lamp', pair);
  return () => { sparks(); pair(); drawHist(); };
}

// ---- figure 6: the screen ----------------------------------------------------------------------------------------------------------
function fig6() {
  const c = $('fig6-canvas');
  const draw = () => {
    const lamp = radioValue('fig6-lamp') || 'D65';
    const paint = radioValue('fig6-paint') === 'b' ? FOG : PEBBLE;
    const name = paint === FOG ? 'Fog' : 'Pebble';
    const R = E.curve(paint);
    const target = E.XYZ(R, lamp);
    const bw = E.bandWeights(target);
    const real = E.paintLight(R, lamp);
    const band = E.bandLight(bw.w);
    const back = [0, 1, 2].map((k) => E.BANDS.reduce((s, b, j) => s + bw.w[j] * b.xyz[k], 0));
    const cones = [E.conesOfXYZ(target, lamp), E.conesOfXYZ(back, lamp)];
    const { ctx, w, h } = V.fitCanvas(c);
    const narrow = w < 520;
    const pw = narrow ? w - 24 : (w - 48) / 2;
    const ph = narrow ? (h - 44) / 2 - 64 : h - 96;
    const panels = narrow ? [{ x: 12, y: 22, w: pw, h: ph }, { x: 12, y: 22 + ph + 84, w: pw, h: ph }] : [{ x: 12, y: 22, w: pw, h: ph }, { x: 36 + pw, y: 22, w: pw, h: ph }];
    const titles = [`Light off the real ${name} ${E.LAMPS[lamp].under}`, 'Three bands from a screen (modeled)'];
    const cols = CONE_COLORS();
    [real, band].forEach((spd, k) => {
      const box = panels[k];
      const peak = Math.max(...spd.slice(4, 65));
      label(ctx, titles[k], box.x, box.y - 18, muted());
      V.drawCurve(ctx, box, spd.map((v) => v / peak), { fill: 0.6, color: ink(), width: 1.6, scale: 0.94 });
      V.drawBand(ctx, box, 4);
      const by = box.y + box.h + 14;
      const cw = box.w / 3;
      ctx.font = '12px system-ui, sans-serif';
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      cones[k].forEach((v, i) => {
        const x = box.x + i * cw;
        ctx.fillStyle = ink();
        ctx.fillText(`${'LMS'[i]} cone ${v.toFixed(3)}`, x, by);
        ctx.fillStyle = 'rgb(128 128 128 / 22%)';
        ctx.fillRect(x, by + 18, cw - 14, 8);
        ctx.fillStyle = cols[i];
        ctx.fillRect(x, by + 18, Math.max(2, Math.min(1, v) * (cw - 14)), 8);
      });
    });
    c.setAttribute('aria-label', `${name} ${E.LAMPS[lamp].under}: the real paint sends back a broad curve of light; three screen bands at 460, 532 and 618 nm, mixed so that ${Math.round(100 * bw.power[0])}% of their light is in the red band, ${Math.round(100 * bw.power[1])}% in the green and ${Math.round(100 * bw.power[2])}% in the blue, give the same cone signals ${cones[0].map((v) => v.toFixed(3)).join(', ')}.`);
  };
  onRadio('fig6-lamp', draw);
  onRadio('fig6-paint', draw);
  return draw;
}

export function initFigures() {
  const figs = [['fig1', fig1], ['fig2', fig2], ['fig3', fig3], ['fig4', fig4], ['fig5', fig5], ['fig6', fig6]];
  const draws = new Map();
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const id = en.target.id;
      if (!draws.has(id)) {
        try { const d = figs.find((f) => f[0] === id)[1](); draws.set(id, d); d(); } catch (err) { console.error(err); }
      }
      io.unobserve(en.target);
    }
  }, { rootMargin: '300px 0px' });
  for (const [id] of figs) { const el = $(id); if (el) io.observe(el); }
  let t = 0;
  const redraw = () => { cancelAnimationFrame(t); t = requestAnimationFrame(() => { for (const d of draws.values()) d(); }); };
  addEventListener('resize', redraw);
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', redraw);
}
