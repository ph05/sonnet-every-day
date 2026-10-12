// WebAudio synth for Between Periods. Everything is generated here: no samples, no network. The context is created on the
// first user gesture, the master gain starts at zero until setMuted(false), and every call is a safe no-op without WebAudio.

const LEVEL = 0.15;
const TOP_SPEED = 18;
const MIN_GAP_MS = { bump: 140, 'tank-low': 600, milestone: 300 };

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createAudio() {
  const Ctor = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null;
  let ctx = null;
  let master = null;
  let humOsc = null;
  let humGain = null;
  let noiseGain = null;
  let noiseBuf = null;
  let muted = true;
  let broken = !Ctor;
  let humLevel = -1;
  const lastAt = {};

  function noiseBuffer() {
    if (noiseBuf) return noiseBuf;
    const len = Math.floor(ctx.sampleRate * 0.8);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    const rnd = mulberry32(0x1ce5eed);
    for (let i = 0; i < len; i++) data[i] = rnd() * 2 - 1;
    return noiseBuf;
  }

  function startHum() {
    humOsc = ctx.createOscillator();
    humOsc.type = 'triangle';
    humOsc.frequency.value = 58;
    humGain = ctx.createGain();
    humGain.gain.value = 0;
    humOsc.connect(humGain).connect(master);
    humOsc.start();

    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer();
    src.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 380;
    band.Q.value = 0.7;
    noiseGain = ctx.createGain();
    noiseGain.gain.value = 0;
    src.connect(band).connect(noiseGain).connect(master);
    src.start();
  }

  function unlock() {
    if (broken) return;
    try {
      if (!ctx) {
        ctx = new Ctor();
        master = ctx.createGain();
        master.gain.value = muted ? 0 : LEVEL;
        master.connect(ctx.destination);
        startHum();
        document.addEventListener('visibilitychange', () => {
          if (!ctx) return;
          if (document.hidden) ctx.suspend().catch(() => {});
          else ctx.resume().catch(() => {});
        });
      }
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    } catch (err) {
      broken = true;
      ctx = null;
    }
  }

  // main.js calls this every frame, so only a real change touches the audio graph.
  function setMuted(m) {
    const next = !!m;
    if (next === muted) return;
    muted = next;
    if (!ctx || !master) return;
    try { master.gain.setTargetAtTime(muted ? 0 : LEVEL, ctx.currentTime, 0.03); } catch (err) { /* context closed */ }
  }

  // One enveloped oscillator: optional glide f0 -> f1, optional lowpass, exponential decay.
  function tone(type, f0, f1, delay, dur, gain, lowpass) {
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) osc.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let tail = osc;
    if (lowpass) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = lowpass;
      osc.connect(f);
      tail = f;
    }
    tail.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  function tick(delay, dur, gain, freq) {
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer();
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(master);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  function bell(freq, delay) {
    tone('sine', freq, 0, delay, 0.7, 0.5);
    tone('sine', freq * 2, 0, delay, 0.35, 0.16);
  }

  function play(code) {
    if (!ctx || muted || broken || ctx.state !== 'running') return;
    const gap = MIN_GAP_MS[code];
    if (gap) {
      const now = performance.now();
      if (now - (lastAt[code] || -1e9) < gap) return;
      lastAt[code] = now;
    }
    try {
      switch (code) {
        case 'start': tone('sine', 660, 0, 0, 0.08, 0.6); break;
        case 'tank-low': tone('sine', 440, 0, 0, 0.09, 0.55); tone('sine', 330, 0, 0.13, 0.11, 0.55); break;
        case 'tank-empty': tone('triangle', 330, 196, 0, 0.35, 0.6); break;
        case 'refill-start': tone('sine', 220, 440, 0, 0.4, 0.5); break;
        case 'refill-done': tone('sine', 660, 0, 0, 0.09, 0.5); tone('sine', 880, 0, 0.1, 0.14, 0.5); break;
        case 'bump': tone('sine', 90, 55, 0, 0.18, 0.9); tick(0, 0.03, 0.5, 1800); break;
        case 'milestone': bell(784, 0); break;
        case 'buzzer': tone('square', 110, 0, 0, 0.6, 0.45, 500); break;
        case 'chime': bell(587, 0); bell(880, 0.18); bell(740, 0.36); break;
        default: break;
      }
    } catch (err) { /* a failed blip must never break the page */ }
  }

  // Engine hum follows speed while a run is live; silent in the attract demo, paused and done.
  function update(view) {
    if (!ctx || !humGain || !view) return;
    const live = view.phase === 'playing' && view.mode !== 'attract';
    const speed = live && view.m ? Math.max(0, Math.min(1.4, (+view.m.speed || 0) / TOP_SPEED)) : 0;
    const level = live ? Math.round((0.18 + 0.5 * speed) * 50) / 50 : 0;
    if (level === humLevel) return;
    humLevel = level;
    try {
      const t = ctx.currentTime;
      humGain.gain.setTargetAtTime(level * 0.55, t, 0.1);
      noiseGain.gain.setTargetAtTime(level * 0.4, t, 0.1);
      humOsc.frequency.setTargetAtTime(52 + speed * 14, t, 0.15);
    } catch (err) { /* context closed */ }
  }

  return { unlock, setMuted, play, update };
}
