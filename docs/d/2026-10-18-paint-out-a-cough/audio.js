// Playback. Two sources run together from the same moment: the original ("before") and the cleaned
// recording ("after"). Switching what you hear only moves two gains, so the switch lands on the same
// sample: after = (0, 1), before = (1, 0), removed = (1, -1), which is before minus after, exactly.

const LISTEN_GAINS = { after: [0, 1], before: [1, 0], removed: [1, -1] };
const MASTER = 0.8; // volume starts below full
const FADE = 0.01; // 10 ms crossfades
const RESTART_LEAD = 0.05;
const XFADE = 0.016; // when a patch lands while playing: the old and the new sources crossfade over 16 ms. They play
// the same samples at the same moment, so equal-gain (linear) fades sum to exactly the old level: no dip, no bump

export function createPlayer({ onEnded } = {}) {
  let ctx = null, master = null;
  let before = null, after = null; // AudioBuffers
  let pair = null; // { a, b, ga, gb, startCtx, offset }
  let listen = 'after';
  let position = 0; // seconds, while paused
  let playFrom = 0;
  let playing = false;

  function ensureContext() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC({ latencyHint: 'interactive' });
    master = ctx.createGain();
    master.gain.value = MASTER;
    master.connect(ctx.destination);
    return ctx;
  }

  function makeBuffer(rate, channels) {
    const buf = new AudioBuffer({ length: channels[0].length, numberOfChannels: channels.length, sampleRate: rate });
    channels.forEach((c, i) => buf.copyToChannel(c, i));
    return buf;
  }

  // The recording is kept as plain arrays until the first Play: opening a long file then costs no copy
  // into audio buffers (src.after is null while the cleaned recording still equals the original).
  let src = null; // { rate, before: Float32Array[], after: Float32Array[] | null }

  function load(rate, channels) {
    stop();
    before = null; after = null;
    src = { rate, before: channels, after: null };
    position = 0;
    playFrom = 0;
  }

  function ensureBuffers() {
    if (before || !src) return;
    before = makeBuffer(src.rate, src.before);
    after = makeBuffer(src.rate, src.after || src.before);
    src = null;
  }

  // replace the whole cleaned recording (window size change)
  function replaceAfter(channels) {
    if (!after) { if (src) src.after = channels; return; }
    channels.forEach((c, i) => after.copyToChannel(c, i));
    if (playing) scheduleRestart();
  }

  function patch(start, channels) {
    if (!after) {
      if (!src) return;
      if (!src.after) src.after = src.before.map((c) => c.slice());
      channels.forEach((c, i) => src.after[i].set(c, start));
      return;
    }
    channels.forEach((c, i) => after.copyToChannel(c, i, start));
    if (playing) scheduleRestart();
  }

  // Restarts are at least 80 ms apart, so a new pair has always started (50 ms lead) and finished its 16 ms
  // fade-in before the next one replaces it; patches that arrive meanwhile are picked up by the one restart.
  let restartTimer = 0, lastRestart = -Infinity;
  function scheduleRestart() {
    if (restartTimer) return;
    const wait = Math.max(0, (lastRestart + 0.08 - ctx.currentTime) * 1000);
    restartTimer = window.setTimeout(() => { restartTimer = 0; if (playing && pair) { lastRestart = ctx.currentTime; restart(); } }, wait);
  }
  function cancelRestart() { if (restartTimer) { window.clearTimeout(restartTimer); restartTimer = 0; } }

  function duration() { return before ? before.duration : src ? src.before[0].length / src.rate : 0; }

  function now() {
    if (!playing || !pair) return position;
    const t = pair.offset + Math.max(0, ctx.currentTime - pair.startCtx);
    return Math.min(t, duration());
  }

  // lead: how far ahead a new pair is scheduled. A patch restart uses 50 ms, so the start lies ahead of
  // whatever the audio thread has already rendered and the new pair is sample-aligned with the old one
  function startPair(offset, fadeIn, fade = 0.008, lead = 0.02) {
    const a = ctx.createBufferSource(), b = ctx.createBufferSource();
    a.buffer = before; b.buffer = after;
    const ga = ctx.createGain(), gb = ctx.createGain();
    const [x, y] = LISTEN_GAINS[listen];
    const t = ctx.currentTime + lead;
    if (fadeIn) {
      ga.gain.setValueAtTime(0, t); gb.gain.setValueAtTime(0, t);
      ga.gain.linearRampToValueAtTime(x, t + fade); gb.gain.linearRampToValueAtTime(y, t + fade);
    } else { ga.gain.value = x; gb.gain.value = y; }
    a.connect(ga).connect(master); b.connect(gb).connect(master);
    a.start(t, offset); b.start(t, offset);
    const p = { a, b, ga, gb, startCtx: t, offset };
    b.onended = () => { if (pair === p && playing) { playing = false; position = playFrom; pair = null; if (onEnded) onEnded(); } };
    return p;
  }

  // fades a pair out over `dur`, starting at context time `at` (default: now)
  function fadeOutPair(p, dur = 0.008, at = null) {
    if (!p) return;
    const now0 = ctx.currentTime;
    if (p.startCtx > now0 + 0.001) {
      // it has not started yet: it never sounds (its scheduled fade-in is cancelled, so silence it outright)
      for (const g of [p.ga, p.gb]) { g.gain.cancelScheduledValues(now0); g.gain.setValueAtTime(0, now0); }
      p.b.onended = null;
      try { p.a.stop(p.startCtx); p.b.stop(p.startCtx); } catch (e) { /* already stopped */ }
      return;
    }
    const t = at === null ? now0 : Math.max(now0, at);
    for (const g of [p.ga, p.gb]) { g.gain.cancelScheduledValues(now0); g.gain.setValueAtTime(g.gain.value, t); g.gain.linearRampToValueAtTime(0, t + dur); }
    p.b.onended = null;
    try { p.a.stop(t + dur + 0.03); p.b.stop(t + dur + 0.03); } catch (e) { /* already stopped */ }
  }

  async function play() {
    if (!before && !src) return false;
    // a phone with its ring/silent switch on still plays the sound (Safari's audio session), set before the context starts
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* not supported */ }
    ensureContext();
    ensureBuffers();
    if (ctx.state !== 'running') { try { await ctx.resume(); } catch (e) { return false; } }
    if (playing) return true;
    if (position >= duration() - 0.02) position = 0;
    playFrom = position;
    pair = startPair(position, true);
    playing = true;
    return true;
  }

  function pause() {
    cancelRestart();
    if (!playing) return;
    position = now();
    fadeOutPair(pair);
    pair = null;
    playing = false;
  }

  function stop() {
    cancelRestart();
    if (playing && pair) fadeOutPair(pair);
    pair = null;
    playing = false;
  }

  // after a patch: the new pair starts 20 ms ahead, exactly where the old one will be by then, and the two
  // crossfade over the same 8 ms, so the sound never drops out or repeats
  function restart() {
    const old = pair;
    // every pair keeps the same mapping from context time to position, so read it at the new start time
    // directly (a pair started a few ms ago may not be sounding yet; now() would clamp it)
    const offset = old ? old.offset + (ctx.currentTime + RESTART_LEAD - old.startCtx) : now() + RESTART_LEAD;
    pair = startPair(offset, true, XFADE, RESTART_LEAD); // sample-aligned with the old pair at its start
    fadeOutPair(old, XFADE, pair.startCtx);
  }

  function seek(t) {
    const d = duration();
    const clamped = Math.max(0, Math.min(d, t));
    if (playing) { cancelRestart(); position = clamped; playFrom = clamped; const old = pair; pair = startPair(clamped, true); fadeOutPair(old); lastRestart = ctx.currentTime; }
    else { position = clamped; playFrom = clamped; }
  }

  function setListen(mode) {
    if (!LISTEN_GAINS[mode]) return;
    listen = mode;
    if (!playing || !pair) return;
    const [x, y] = LISTEN_GAINS[mode];
    const t = ctx.currentTime;
    for (const [g, v] of [[pair.ga, x], [pair.gb, y]]) { g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(g.gain.value, t); g.gain.linearRampToValueAtTime(v, t + FADE); }
  }

  return {
    load, patch, replaceAfter, play, pause, seek, setListen, now, duration,
    isPlaying: () => playing,
    afterChannels: () => (after ? Array.from({ length: after.numberOfChannels }, (_, i) => after.getChannelData(i)) : src ? (src.after || src.before) : []),
    rate: () => (after ? after.sampleRate : src ? src.rate : 0),
  };
}
