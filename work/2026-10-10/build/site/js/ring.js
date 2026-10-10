// Canvas phase ring: 64 ticks, clockwise from 12 o'clock. Each joker lives on its own lane, so a locked
// rail reads as a radial spoke. The main dots show the hand that would score if you played now (phases.next);
// ghosts show where the beat is at this moment (phases.now). Animation only tweens between discrete states.
const TAU = Math.PI * 2;
const TWEEN_MS = 520;
const PULSE_MS = 320;
const IDX = { lantern: 0, ember: 1, spark: 2, pendulum: 3 };
const LANE = [0.84, 0.7, 0.56, 1];
const LETTER = ['L', 'E', 'S', 'P'];
const COL = { track: '#5560a8', fg: '#e8e9f6', muted: '#aab0d8', glow: '#d9f55c', pend: '#ff9f6e', bridge: '#ffe8a3', ink: '#0f1226' };
const STAR = new Float32Array(32);
for (let i = 0; i < 16; i++) {
  const a = (Math.PI * i) / 8 - Math.PI / 2;
  const rad = i % 2 ? 0.45 : 1;
  STAR[i * 2] = Math.cos(a) * rad;
  STAR[i * 2 + 1] = Math.sin(a) * rad;
}

export function createRing(canvas) {
  const ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
  if (!ctx) return { draw() {}, resize() {}, busy() { return false; } };

  const cur = new Float64Array(4);
  const from = new Float64Array(4);
  const to = new Float64Array(4);
  const nt = new Float64Array(4);
  const ghost = new Float64Array(4);
  const px = new Float64Array(4);
  const py = new Float64Array(4);
  const onRail = new Uint8Array(4);
  const flash = new Uint8Array(4);
  const present = new Uint8Array(4);
  const ghostOn = new Uint8Array(4);
  let size = 0;
  let scale = 0;
  let cx = 0;
  let cy = 0;
  let R = 0;
  let dotR = 7;
  let minor = null;
  let major = null;
  let labels = null;
  let seen = false;
  let lastVm = null;
  let tweenStart = -1e9;
  let pulseStart = -1e9;
  let bridgeA = -1;
  let bridgeB = -1;
  let bridgeOk = false;
  let lastT = 0;

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(canvas.clientWidth);
    if (w < 120 || (w === size && dpr === scale)) return;
    size = w;
    scale = dpr;
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx = cy = size / 2;
    R = size / 2 - 24;
    dotR = Math.min(9, Math.max(6, size * 0.026));
    minor = new Path2D();
    major = new Path2D();
    labels = [];
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * TAU - Math.PI / 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const path = i % 16 === 0 ? major : minor;
      const len = i % 16 === 0 ? 9 : 4;
      path.moveTo(cx + c * R, cy + s * R);
      path.lineTo(cx + c * (R - len), cy + s * (R - len));
      if (i % 16 === 0) labels.push(String(i), cx + c * (R + 15), cy + s * (R + 15));
    }
    lastVm = null;
  }

  function ingest(vm, t, reduced) {
    const ph = vm.phases;
    const rows = ph.next || ph.now;
    present.fill(0);
    onRail.fill(0);
    ghostOn.fill(0);
    let anyFlash = false;
    let changed = !seen;
    const prevFlash = flash.join('');
    flash.fill(0);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const k = row && IDX[row.id];
      if (k === undefined) continue;
      present[k] = 1;
      nt[k] = ((Number(row.ring) || 0) % 64 + 64) % 64;
      onRail[k] = row.onRail ? 1 : 0;
      if (row.flash && row.onRail) {
        flash[k] = 1;
        anyFlash = true;
      }
    }
    if (ph.next && ph.now) {
      for (let i = 0; i < ph.now.length; i++) {
        const row = ph.now[i];
        const k = row && IDX[row.id];
        if (k === undefined) continue;
        ghost[k] = ((Number(row.ring) || 0) % 64 + 64) % 64;
        ghostOn[k] = 1;
      }
    }
    for (let k = 0; k < 4; k++) if (present[k] && nt[k] !== to[k]) changed = true;
    if (flash.join('') !== prevFlash) changed = true;
    const b = ph.bridge;
    bridgeA = b ? (IDX[b.a] === undefined ? -1 : IDX[b.a]) : -1;
    bridgeB = b ? (IDX[b.b] === undefined ? -1 : IDX[b.b]) : -1;
    bridgeOk = !!(b && b.ok);
    if (!seen || reduced) cur.set(nt);
    else from.set(cur);
    to.set(nt);
    tweenStart = seen && !reduced ? t : -1e9;
    if (changed && anyFlash && !reduced) pulseStart = t;
    seen = true;
  }

  function shape(k, x, y, r) {
    ctx.beginPath();
    if (k === 1) {
      ctx.moveTo(x, y - r * 1.3);
      ctx.lineTo(x + r * 1.3, y);
      ctx.lineTo(x, y + r * 1.3);
      ctx.lineTo(x - r * 1.3, y);
      ctx.closePath();
    } else if (k === 2) {
      const s = r * 1.45;
      ctx.moveTo(x + STAR[0] * s, y + STAR[1] * s);
      for (let i = 1; i < 16; i++) ctx.lineTo(x + STAR[i * 2] * s, y + STAR[i * 2 + 1] * s);
      ctx.closePath();
    } else {
      ctx.arc(x, y, k === 3 ? r : r * 1.05, 0, TAU);
    }
  }

  function render(vm, t, reduced) {
    ctx.clearRect(0, 0, size, size);
    const p = Math.min(1, Math.max(0, (t - tweenStart) / TWEEN_MS));
    const e = p * p * (3 - 2 * p);
    for (let k = 0; k < 4; k++) {
      let d = to[k] - from[k];
      if (k < 3) d = ((d + 96) % 64) - 32;
      cur[k] = p >= 1 ? to[k] : (from[k] + d * e + 64) % 64;
      const a = (cur[k] / 64) * TAU - Math.PI / 2;
      px[k] = cx + Math.cos(a) * R * LANE[k];
      py[k] = cy + Math.sin(a) * R * LANE[k];
    }

    ctx.lineWidth = 1.5;
    ctx.strokeStyle = COL.track;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.stroke(minor);
    ctx.lineWidth = 2;
    ctx.stroke(major);
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COL.muted;
    for (let i = 0; i < labels.length; i += 3) ctx.fillText(labels[i], labels[i + 1], labels[i + 2]);

    ctx.globalAlpha = 0.16;
    ctx.lineWidth = 1;
    ctx.strokeStyle = COL.muted;
    for (let k = 0; k < 3; k++) {
      ctx.beginPath();
      ctx.arc(cx, cy, R * LANE[k], 0, TAU);
      ctx.stroke();
    }
    if (present[3]) {
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = COL.pend;
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.arc(cx, cy, R, -Math.PI / 2, Math.PI / 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.lineCap = 'round';
    for (let k = 0; k < 3; k++) {
      if (!ghostOn[k]) continue;
      const da = (to[k] - ghost[k] + 64) % 64;
      const a0 = (ghost[k] / 64) * TAU - Math.PI / 2;
      if (da > 0 && da <= 40) {
        ctx.globalAlpha = 0.3;
        ctx.strokeStyle = COL.glow;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(cx, cy, R * LANE[k], a0, a0 + (da / 64) * TAU);
        ctx.stroke();
      }
      ctx.globalAlpha = 0.45;
      ctx.strokeStyle = COL.muted;
      ctx.lineWidth = 1.5;
      shape(k, cx + Math.cos(a0) * R * LANE[k], cy + Math.sin(a0) * R * LANE[k], dotR * 0.8);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    let n = 0;
    let sx = 0;
    let sy = 0;
    for (let k = 0; k < 3; k++) {
      if (!present[k] || !onRail[k]) continue;
      const a = (cur[k] / 64) * TAU;
      sx += Math.sin(a);
      sy -= Math.cos(a);
      n++;
    }
    if (n >= 2) {
      const rn = R * 0.4;
      const mx = sx / n;
      const my = sy / n;
      const locked = mx * mx + my * my >= 0.8464;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = COL.muted;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.arc(cx, cy, rn, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = locked ? COL.glow : COL.fg;
      ctx.lineWidth = locked ? 3 : 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + mx * rn, cy + my * rn);
      ctx.stroke();
      ctx.fillStyle = locked ? COL.glow : COL.fg;
      ctx.beginPath();
      ctx.arc(cx + mx * rn, cy + my * rn, 3.5, 0, TAU);
      ctx.fill();
    }

    if (bridgeA >= 0 && bridgeB >= 0 && present[bridgeA] && present[bridgeB]) {
      ctx.strokeStyle = COL.bridge;
      ctx.lineWidth = bridgeOk ? 3 : 2;
      ctx.setLineDash(bridgeOk ? [] : [5, 5]);
      ctx.beginPath();
      ctx.moveTo(px[bridgeA], py[bridgeA]);
      ctx.lineTo(px[bridgeB], py[bridgeB]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    const pulse = reduced ? 1 : (t - pulseStart) / PULSE_MS;
    for (let k = 0; k < 4; k++) {
      if (!present[k]) continue;
      const rail = onRail[k] === 1;
      const color = k === 3 ? COL.pend : COL.glow;
      if (rail && k < 3 && !reduced) {
        ctx.globalAlpha = 0.06 + 0.05 * Math.sin(t / 700 + k * 2);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(px[k], py[k], dotR * 2.3, 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = rail ? 1 : 0.4;
      ctx.fillStyle = color;
      shape(k, px[k], py[k], dotR);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = rail ? COL.ink : color;
      ctx.lineWidth = rail ? 1 : 1.5;
      ctx.stroke();
      ctx.fillStyle = rail ? COL.ink : COL.fg;
      ctx.font = '700 ' + Math.round(dotR * 1.15) + 'px system-ui, sans-serif';
      ctx.fillText(LETTER[k], px[k], py[k] + 0.5);
      if (flash[k]) {
        ctx.strokeStyle = COL.glow;
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.arc(px[k], py[k], dotR * 1.75, 0, TAU);
        ctx.stroke();
        if (pulse >= 0 && pulse < 1) {
          ctx.globalAlpha = 0.9 * (1 - pulse);
          ctx.beginPath();
          ctx.arc(px[k], py[k], dotR * (1.75 + 1.4 * pulse), 0, TAU);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
    }
  }

  return {
    draw(vm, opt) {
      if (!size) resize();
      if (!size || !vm || !vm.phases || !(vm.phases.next || vm.phases.now)) return;
      const t = opt && Number.isFinite(opt.t) ? opt.t : 0;
      const reduced = !!(opt && opt.reduced);
      lastT = t;
      if (vm !== lastVm) {
        ingest(vm, t, reduced);
        lastVm = vm;
      }
      render(vm, t, reduced);
    },
    resize,
    busy(t) {
      const now = Number.isFinite(t) ? t : lastT;
      return now - tweenStart < TWEEN_MS + 40 || now - pulseStart < PULSE_MS + 40;
    }
  };
}
