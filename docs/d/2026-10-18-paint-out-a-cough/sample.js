// The built-in sample: an original music-box tune over a held chord, soft room tone, a cough, a phone-style
// ping and a click, all synthesized here from a fixed seed (no recorded audio). Oscillators are rotating
// phasors and decays are running multipliers, so the 10-second clip takes a few tens of milliseconds.

export const SAMPLE_RATE = 44100;
export const SAMPLE_SEED = 20261018;
export const SAMPLE_SECONDS = 10;
const SR = SAMPLE_RATE;

export function mulberry32(seed) {
  let a = seed | 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// unit-variance noise from four uniforms
const noiseFrom = (rnd) => () => (rnd() + rnd() + rnd() + rnd() - 2) * Math.sqrt(3);
const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

// RBJ cookbook biquads (band-pass with constant peak gain, low-pass, high-pass)
function biquad(type, f0, q) {
  const w0 = (2 * Math.PI * f0) / SR, c = Math.cos(w0), s = Math.sin(w0), alpha = s / (2 * q);
  let b0, b1, b2;
  const a0 = 1 + alpha, a1 = -2 * c, a2 = 1 - alpha;
  if (type === 'bp') { b0 = alpha; b1 = 0; b2 = -alpha; }
  else if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }
  else { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
  const B0 = b0 / a0, B1 = b1 / a0, B2 = b2 / a0, A1 = a1 / a0, A2 = a2 / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x) => { const y = B0 * x + B1 * x1 + B2 * x2 - A1 * y1 - A2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; };
}

// add amp * env * sin(2 pi f t + phase) for n samples from i0, env multiplied by `decay` each sample
function addPartial(out, i0, n, f, phase, amp, decay, shape) {
  const w = (2 * Math.PI * f) / SR;
  const cw = Math.cos(w), sw = Math.sin(w);
  let c = Math.cos(phase), s = Math.sin(phase), e = amp;
  const end = Math.min(n, out.length - i0);
  for (let i = 0; i < end; i++) {
    out[i0 + i] += e * shape[i] * s;
    const c2 = c * cw - s * sw;
    s = c * sw + s * cw;
    c = c2;
    e *= decay;
  }
}

// Music-box note: partials 1, 2, 3, 4.2 and 5.4 times the pitch, higher ones dying faster
const MB_PARTIALS = [[1, 1.0, 0.55], [2, 0.3, 0.3], [3, 0.11, 0.2], [4.2, 0.05, 0.13], [5.4, 0.02, 0.09]];
const MB_LEN = Math.round(1.6 * SR);
const MB_SHAPE = (() => {
  const fadeN = Math.round(0.4 * SR);
  const a = new Float64Array(MB_LEN);
  for (let i = 0; i < MB_LEN; i++) {
    const att = Math.min(1, i / SR / 0.004);
    a[i] = att * (i > MB_LEN - fadeN ? 0.5 + 0.5 * Math.cos((Math.PI * (i - (MB_LEN - fadeN))) / fadeN) : 1);
  }
  return a;
})();
function musicBox(out, t0, midi, amp) {
  const f = midiHz(midi);
  const i0 = Math.round(t0 * SR);
  for (const [r, a, tau] of MB_PARTIALS) {
    if (f * r > 15000) continue;
    addPartial(out, i0, MB_LEN, f * r, 0, amp * a, Math.exp(-1 / (tau * SR)), MB_SHAPE);
  }
}

// Held pad chord: additive, gentle roll-off, slow attack and release, steady pitch
function pad(out, t0, t1, midis, amp) {
  const att = 0.6, rel = 0.9;
  const i0 = Math.round(t0 * SR), i1 = Math.round(t1 * SR);
  const n = Math.min(out.length, i1 + Math.round(rel * SR)) - i0;
  const shape = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR, tt = (i0 + i - i1) / SR;
    let e = Math.min(1, t / att);
    if (tt > 0) e *= Math.max(0, 1 - tt / rel);
    shape[i] = e * e * (3 - 2 * e);
  }
  for (const m of midis) {
    const f = midiHz(m);
    for (let h = 1; h <= 6; h++) {
      if (f * h > 4000) break;
      addPartial(out, i0, n, f * h, (m * 0.37 + h * 1.3) % (2 * Math.PI), amp / Math.pow(h, 1.9), 1, shape);
    }
  }
}

// Soft room tone: pink-ish noise (an economy pink filter on white noise), low-passed
function room(out, rnd, level) {
  const g = noiseFrom(rnd);
  const lp = biquad('lp', 9000, 0.7);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < out.length; i++) {
    const w = g();
    b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913;
    out[i] += level * lp(b0 + b1 + b2 + w * 0.1848) * 0.25;
  }
}

// A small polite cough: an explosive burst, then a breathy "huh" with vowel-like resonances
function cough(out, t0, rnd, peak) {
  const g = noiseFrom(rnd);
  const n = Math.round(0.3 * SR);
  const f1 = biquad('bp', 480, 1.4), f2 = biquad('bp', 1150, 1.8), f3 = biquad('bp', 2400, 2.2);
  const hp = biquad('hp', 160, 0.7), lpA = biquad('lp', 4200, 0.6), lpB = biquad('lp', 4200, 0.6);
  const tmp = new Float64Array(n);
  let mx = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const burst = Math.exp(-t / 0.035) * Math.min(1, t / 0.003);
    const huh = (t > 0.02 ? Math.min(1, (t - 0.02) / 0.03) : 0) * Math.exp(-Math.max(0, t - 0.05) / 0.09);
    const w = g();
    const shaped = f1(w) + f2(w) * 0.8 + f3(w) * 0.45;
    const s = lpB(lpA(hp(1.6 * burst * w + 2.4 * huh * shaped))) + 0.5 * burst * w;
    tmp[i] = s * Math.min(1, (n - i) / (0.02 * SR));
    if (Math.abs(tmp[i]) > mx) mx = Math.abs(tmp[i]);
  }
  const i0 = Math.round(t0 * SR);
  for (let i = 0; i < n && i0 + i < out.length; i++) out[i0 + i] += (peak / mx) * tmp[i];
  return { t0, t1: t0 + n / SR };
}

// Phone-style ping: two pure bell notes a whole tone apart, ringing out
function ping(out, t0, peak, f) {
  const n = Math.round(0.9 * SR);
  const tail = Math.round(0.1 * SR);
  const tmp = new Float64Array(n);
  for (const [dt, fr] of [[0, f], [0.12, f * Math.pow(2, 2 / 12)]]) {
    const j0 = Math.round(dt * SR);
    const shape = new Float64Array(n - j0);
    for (let i = 0; i < shape.length; i++) {
      const t = i / SR;
      shape[i] = Math.min(1, t / 0.002) * (j0 + i > n - tail ? (n - (j0 + i)) / tail : 1);
    }
    addPartial(tmp, j0, n - j0, fr, 0, 1, Math.exp(-1 / (0.22 * SR)), shape);
  }
  let mx = 0;
  for (let i = 0; i < n; i++) if (Math.abs(tmp[i]) > mx) mx = Math.abs(tmp[i]);
  const i0 = Math.round(t0 * SR);
  for (let i = 0; i < n && i0 + i < out.length; i++) out[i0 + i] += (peak / mx) * tmp[i];
  return { t0, t1: t0 + n / SR, f1: f, f2: f * Math.pow(2, 2 / 12) };
}

// A click: a 0.4 ms raised-cosine tick and a tiny damped ring
function click(out, t0, peak) {
  const i0 = Math.round(t0 * SR);
  const n = Math.round(0.006 * SR);
  for (let i = 0; i < n && i0 + i < out.length; i++) {
    const t = i / SR;
    const tick = t < 0.0004 ? 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / 0.0004) : 0;
    out[i0 + i] += peak * (tick + Math.exp(-t / 0.0012) * Math.sin(2 * Math.PI * 3100 * t) * 0.35);
  }
  return { t0, t1: t0 + n / SR };
}

// The tune (beats of 0.6 s): no new note between 3.75 s and 5.91 s, so the cough lands on the chord
const BEAT = 0.6;
const MELODY = [[0, 76], [1, 79], [2, 84], [3, 83], [4, 81], [4.5, 79], [5, 76], [6, 77],
  [9.6, 81], [10.1, 84], [10.6, 89], [11.1, 88], [11.6, 86], [12.1, 84], [12.6, 79], [13.6, 84]];
const PAD = { t0: 2.4, t1: 7.6, midis: [48, 55, 64] };
export const SAMPLE_EVENTS = { cough: 4.62, ping: 8.55, click: 1.52 };

export function makeSample() {
  const L = Math.round(SAMPLE_SECONDS * SR);
  const rnd = mulberry32(SAMPLE_SEED);
  const music = new Float64Array(L);
  for (const [b, m] of MELODY) musicBox(music, b * BEAT + 0.15, m, 0.11);
  pad(music, PAD.t0, PAD.t1, PAD.midis, 0.07);
  room(music, rnd, 0.0022);
  const coughPart = new Float64Array(L), pingPart = new Float64Array(L), clickPart = new Float64Array(L);
  const c = cough(coughPart, SAMPLE_EVENTS.cough, rnd, 0.3);
  const p = ping(pingPart, SAMPLE_EVENTS.ping, 0.12, 4699);
  const k = click(clickPart, SAMPLE_EVENTS.click, 0.28);
  const mix = new Float32Array(L);
  const coughOnly = new Float32Array(L), pingOnly = new Float32Array(L), clickOnly = new Float32Array(L);
  for (let i = 0; i < L; i++) {
    mix[i] = music[i] + coughPart[i] + pingPart[i] + clickPart[i];
    coughOnly[i] = coughPart[i]; pingOnly[i] = pingPart[i]; clickOnly[i] = clickPart[i];
  }
  return {
    rate: SR,
    channels: [mix],
    cough: coughOnly,
    parts: { cough: coughOnly, ping: pingOnly, click: clickOnly },
    events: {
      cough: c,
      ping: p,
      click: k,
      chord: { t0: PAD.t0, t1: PAD.t1, hz: 196 },
    },
  };
}

// The ghost brush of the first frame: one sweep down the cough column, 0.22 s either side in time.
export function demoStroke(melLo, melHi) {
  const t = (SAMPLE_EVENTS.cough + SAMPLE_EVENTS.cough + 0.3) / 2;
  return { id: 1, mode: 'fill', demo: true, points: [[t, melHi], [t, (melHi + melLo) / 2], [t, melLo]], rT: 0.22, rM: 260, top: true, bottom: true };
}
