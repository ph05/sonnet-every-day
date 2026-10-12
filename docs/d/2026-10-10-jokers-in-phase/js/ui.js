// View layer. Renders only from the view-model carried by app:state and talks back through app:action.
import { createRing } from './ring.js';
import { jokerGlyph, cardFace, conceptCard, JOKER_NAME, CHALLENGE_NAME, COUPLING } from './art.js';

const HAND_NAME = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'];
const BEAT = { lantern: 'slow', ember: 'middle', spark: 'quick' };
const FLASH_BONUS = [6, 5, 4, 3];
const TIER_LABEL = { none: 'Practice sketch', par: 'Par card', silver: 'Silver lock', gold: 'Gold lock' };
const NOTICE = {
  'swap-limit': 'One swap per beat. Undo it or play the hand.',
  'bad-hash': 'That link did not parse, so here is a fresh deal.',
  'seed-clamped': 'Deal numbers run from 1 to 99999.',
  'line-clipped': 'That link had more moves than hands; the extra moves were ignored.',
  'no-hint': 'Hints open here after three rounds below par. First Beat and Sandbox have them from the start.'
};
const EASE = 'cubic-bezier(.2,.8,.2,1)';
const PREF_KEY = 'jip.v1.ui';

const $ = (id) => document.getElementById(id);
const fmt = (n) => (Number.isFinite(n) ? Math.round(n) : 0).toLocaleString('en-US');
const posName = (p) => (p < 5 ? 'slot ' + (p + 1) : 'bench ' + (p - 4));
const nameOf = (id) => JOKER_NAME[id] || String(id);

function noticeText(v) {
  if (!v.notice) return '';
  const text = NOTICE[v.notice.code] || '';
  if (v.notice.code !== 'no-hint') return text;
  const n = v.round.misses;
  return text.replace('three rounds below par.', `three rounds below par (${n > 3 ? 3 : n} of 3 so far).`);
}

function jokerDesc(id) {
  switch (id) {
    case 'steady': return 'Adds +4 mult.';
    case 'twofold': return 'Multiplies mult by 2.';
    case 'tally': return 'Adds +12 points.';
    case 'pendulum': return 'Swings each hand: out adds +8 mult, back multiplies mult by 2.';
    case 'handshake': return 'Multiplies mult by 3 when the jokers on both sides are in matching phase.';
    default: return BEAT[id] ? `Firefly, ${BEAT[id]} beat. Flashes when its phase passes the top: adds mult, more when others flash together.` : '';
  }
}

let E = null;
let ring = null;
let vm = null;
let lastTrace = null;
let tab = 'next';
let grabbed = -1;
let focusPos = 0;
let drag = null;
let suppressClick = false;
let reduced = false;
let soundOn = false;
let audio = null;
let casc = null;
let raf = 0;
let dirty = true;
let lastDraw = 0;
let lastGlow = -1e9;
let cardKey = '';
let liveFlip = false;
let copyTimer = 0;
let readyStarted = false;
let readyDone = false;
let basePos = null; // the arrangement before the pending swap: the last one seen with nothing moved
let putBack = false; // the hint on screen was asked for while a swap was pending, so the page put that swap back first
let toast = null; // the floating cascade summary: { el, timer }
let keysOn = true; // single-key shortcuts can be switched off (WCAG 2.1.4); saved in the ui prefs
let appActive = true; // shortcuts are live while the visitor is working in the app, not while they read the footer or follow links
let armed = null; // a destructive shortcut waiting for its second press: { key, timer }

function act(detail) {
  finishCascade();
  try {
    document.dispatchEvent(new CustomEvent('app:action', { detail }));
  } catch (err) {
    console.warn('action failed', err);
  }
}

function announce(msg) {
  if (!msg || !E.live) return;
  liveFlip = !liveFlip;
  E.live.textContent = msg + (liveFlip ? '' : ' ');
}

function playClass(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
}

function dealKey(v) {
  const c = v.challenge;
  return [v.mode, c.id, c.seed, c.k, v.round.attempt].join('|');
}

/* ---- Sound ------------------------------------------------------------------------------------------------ */
function loadPrefs() {
  try {
    const o = JSON.parse(localStorage.getItem(PREF_KEY) || 'null');
    soundOn = !!(o && o.v === 1 && o.muted === false);
    keysOn = !(o && o.v === 1 && o.keys === false);
  } catch (err) {
    soundOn = false;
    keysOn = true;
  }
}

function savePrefs() {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({ v: 1, muted: !soundOn, keys: keysOn }));
  } catch (err) {
    /* storage is a convenience only */
  }
}

function ensureAudio() {
  if (audio) return audio;
  try {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    audio = Ctor ? new Ctor() : null;
    if (audio && audio.state === 'suspended') audio.resume().catch(() => {});
  } catch (err) {
    audio = null;
  }
  return audio;
}

function note(freq, ms, gain, delayMs) {
  if (!soundOn || !audio || audio.state !== 'running') return;
  try {
    const t = audio.currentTime + delayMs / 1000;
    const osc = audio.createOscillator();
    const amp = audio.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    amp.gain.setValueAtTime(gain, t);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    osc.connect(amp);
    amp.connect(audio.destination);
    osc.start(t);
    osc.stop(t + ms / 1000 + 0.02);
    if (casc) casc.notes.push(osc);
  } catch (err) {
    /* a failed AudioContext stays silent */
  }
}

function toggleSound() {
  soundOn = !soundOn;
  if (soundOn) {
    ensureAudio();
    note(660, 45, 0.04, 0);
  }
  savePrefs();
  renderSoundButton();
  announce(soundOn ? 'Sound on.' : 'Sound off.');
}

function renderKeysToggle() {
  const on = keysOn;
  E.keysToggle.textContent = on ? 'Turn keyboard shortcuts off' : 'Turn keyboard shortcuts on';
  E.keysLine.classList.toggle('is-off', !on);
  for (const b of [E.play, E.undo, E.retry, E.hint, E.sound, ...E.navBtns]) {
    const k = b.dataset.keys || b.getAttribute('aria-keyshortcuts');
    if (!k) continue;
    b.dataset.keys = k;
    if (on) b.setAttribute('aria-keyshortcuts', k);
    else b.removeAttribute('aria-keyshortcuts');
  }
}

function toggleKeys() {
  keysOn = !keysOn;
  disarm();
  savePrefs();
  renderKeysToggle();
  announce(keysOn ? 'Keyboard shortcuts on.' : 'Keyboard shortcuts off. The buttons still work.');
}

function renderSoundButton() {
  E.sound.setAttribute('aria-pressed', soundOn ? 'true' : 'false');
  E.sound.textContent = soundOn ? 'Sound on' : 'Sound off';
}

/* ---- Copy ------------------------------------------------------------------------------------------------- */
function shareUrl(v) {
  const h = String(v.share.hash || '').replace(/^#/, '');
  return location.href.split('#')[0] + (h ? '#' + h : '');
}

function shareText(v) {
  const url = shareUrl(v);
  if (!v.round.finished) return url;
  const tier = v.result ? v.result.card : 'none';
  const label = tier === 'none' ? '' : ' · ' + TIER_LABEL[tier];
  return `Jokers In Phase · ${CHALLENGE_NAME[v.challenge.id] || 'Sandbox'} · ${fmt(v.total)} points${label}\n${url}`;
}

async function copyLink() {
  if (!vm) return;
  let ok = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(shareText(vm));
      ok = true;
    }
  } catch (err) {
    ok = false;
  }
  if (!ok) {
    try {
      E.shareUrl.focus();
      E.shareUrl.select();
      ok = document.execCommand('copy');
    } catch (err) {
      ok = false;
    }
  }
  E.copy.textContent = ok ? 'Link copied' : 'Press Ctrl+C (Cmd+C on a Mac)';
  E.copy.toggleAttribute('data-manual', !ok); // the long label takes its own row under the link
  announce(ok ? 'Link copied.' : 'Link selected. Press Ctrl+C (Cmd+C on a Mac) to copy it.');
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => { E.copy.textContent = 'Copy link'; E.copy.removeAttribute('data-manual'); }, ok ? 2400 : 6000);
}

/* ---- Copy text for the coach and the steps ---------------------------------------------------------------- */
function coachText(v) {
  const r = v.round;
  if (r.finished && v.result) {
    const res = v.result;
    if (res.card === 'gold') return 'All three fireflies locked. The whole rail breathes together.';
    if (res.card === 'silver') return 'Two fireflies locked. One more for gold.';
    if (res.parMet) return `Par reached with ${fmt(res.total - res.par)} to spare.`;
    return `${fmt(res.par - res.total)} short of par. A retry costs nothing.`;
  }
  const n = r.hand + 1;
  if (v.mode === 'challenge' && v.challenge.id === 1 && r.hand === 1 && !v.changed.length) {
    return 'Hand 1 played itself. Order matters: tap one joker, then another, to swap them and watch the Play button\'s score change.';
  }
  if (v.changed.length) return `Swap made. The Play button shows what hand ${n} would score now. Undo it, or play.`;
  if (r.hand === 1 && v.challenge.id === 2) return 'Fireflies pull toward their neighbours. Watch the sync meter: 92% or more is a lock.';
  if (r.hand === 1 && v.challenge.id === 3) return 'The Handshake multiplies by 3 only when both neighbours are in matching phase.';
  return `Hand ${n} of 4. One swap per beat, then play.`;
}

function challengeDesc(v) {
  const c = v.challenge;
  if (v.mode === 'sandbox') return `Deal #${c.seed}, coupling ${COUPLING[c.k] || 'Off'}. Par is 70% of the best possible score.`;
  if (c.id === 1) return 'Coupling off, so the Fireflies (Lantern, Ember, Spark) blink alone. Reach par.';
  if (c.id === 2) return "Neighbours nudge each other's beat, nearest first. Lock the fireflies for silver or gold.";
  return 'Medium coupling, and a Handshake that scores only when its neighbours match.';
}

function stepText(s) {
  const name = nameOf(s.id);
  const val = (dflt) => (Number.isFinite(s.value) && s.value > 0 ? s.value : dflt);
  switch (s.id) {
    case 'steady': return `${name} adds +${val(4)} mult`;
    case 'twofold': return `${name} doubles mult`;
    case 'tally': return `${name} adds +${val(12)} points`;
    case 'pendulum': return s.why === 'back' ? `${name} swings back: mult ×${val(2)}` : `${name} swings out: +${val(8)} mult`;
    case 'handshake':
      if (s.why === 'match') return `${name}: neighbours match, mult ×${val(3)}`;
      if (s.why === 'apart') return `${name}: neighbours are out of phase`;
      if (s.why === 'unphased') return `${name}: both neighbours need a phase`;
      return `${name}: needs a neighbour on each side`;
    default:
      if (s.kind === 'idle' || s.why === 'dim') return `${name} is dark this beat`;
      return `${name} flashes: +${val(0)} mult` + (s.n >= 2 ? ` (${s.n} together)` : '');
  }
}

/* ---- Rendering --------------------------------------------------------------------------------------------- */
function renderTop(v) {
  for (const b of E.navBtns) {
    if (Number(b.dataset.challenge) === v.challenge.id) b.setAttribute('aria-current', 'true');
    else b.removeAttribute('aria-current');
  }
  // The description is one text node so a button after it (Sandbox only) keeps its focus across renders.
  if (!E.descText || E.descText.parentNode !== E.desc) {
    E.desc.textContent = '';
    E.descText = document.createTextNode('');
    E.desc.appendChild(E.descText);
  }
  E.descText.nodeValue = challengeDesc(v);
  if (v.mode === 'sandbox') {
    if (!E.changeDeal.parentNode) E.desc.appendChild(E.changeDeal);
  } else if (E.changeDeal.parentNode) {
    E.changeDeal.remove();
  }
  E.coach.textContent = coachText(v);
}

function renderDeal(v, prev, animate) {
  const same = prev && dealKey(prev) === dealKey(v);
  for (let i = 0; i < E.hands.length; i++) {
    const h = v.deal[i];
    const t = E.hands[i];
    if (!h) continue;
    const key = h.cards.map((c) => c.r * 4 + c.s).join(',');
    if (t.key !== key) {
      t.cards.replaceChildren(...h.cards.map((c) => cardFace(c)));
      t.key = key;
    }
    t.root.dataset.status = h.status;
    if (h.status === 'next') t.root.setAttribute('aria-current', 'step');
    else t.root.removeAttribute('aria-current');
    t.tag.textContent = h.status;
    t.name.textContent = HAND_NAME[h.cat] || '';
    t.base.textContent = `${h.base.pts} × ${h.base.mult}`;
    t.score.textContent = h.score == null ? '–' : fmt(h.score);
    if (same && animate && !reduced && h.status === 'played' && prev.deal[i].status !== 'played') playClass(t.root, 'just-played');
  }
}

// Slots to flag after a swap. The bench re-sorts into catalog order, so a rail-bench swap shifts up to four positions;
// only a joker that left or entered the rail counts as moved, which flags exactly the two jokers the visitor swapped.
function markedOf(v) {
  const marks = new Set();
  if (!basePos) return marks;
  for (const pos of v.changed) {
    const was = basePos.indexOf(v.pos[pos]);
    if (was !== pos && (was < 5 || pos < 5)) marks.add(pos);
  }
  return marks;
}

function renderSlots(v, prev) {
  const same = prev && dealKey(prev) === dealKey(v);
  const locked = v.round.finished || v.fatal;
  const marks = markedOf(v);
  for (let pos = 0; pos < E.slots.length; pos++) {
    const s = E.slots[pos];
    const id = v.pos[pos] || '';
    if (s.dataset.joker !== id) {
      s.dataset.joker = id;
      E.parts[pos].glyph.replaceChildren(jokerGlyph(id));
      E.parts[pos].name.textContent = nameOf(id);
      const from = same ? prev.pos.indexOf(id) : -1;
      if (from >= 0 && from !== pos && !reduced) flip(s, E.parts[pos].tok, E.slots[from]);
    }
    const isChanged = marks.has(pos);
    const isHint = !!v.hint && !v.hint.noop && (v.hint.a === pos || v.hint.b === pos);
    s.classList.toggle('is-changed', isChanged);
    s.classList.toggle('is-hint', isHint);
    s.setAttribute('aria-disabled', locked ? 'true' : 'false');
    s.setAttribute('aria-label', `${posName(pos).replace(/^./, (c) => c.toUpperCase())}: ${nameOf(id)}. ${jokerDesc(id)}` + (isChanged ? ' Moved this beat.' : '') + (isHint ? ' Hint: swap this one.' : ''));
  }
  if (grabbed >= 0 && locked) setGrab(-1);
}

function flip(slot, tok, origin) {
  const a = origin.getBoundingClientRect();
  const b = slot.getBoundingClientRect();
  slot.style.zIndex = '5';
  const anim = tok.animate([{ transform: `translate(${a.left - b.left}px, ${a.top - b.top}px)` }, { transform: 'none' }], { duration: 180, easing: 'ease-out' });
  anim.onfinish = anim.oncancel = () => { slot.style.zIndex = ''; };
}

function renderButtons(v) {
  const r = v.round;
  const hadFocus = document.activeElement;
  E.play.disabled = !r.canPlay || v.fatal;
  E.play.textContent = r.finished ? 'Round over' : `Play hand ${r.hand + 1}`;
  // The projected score rides on the button (CSS ::after), so a swap shows its effect right under the rail.
  if (!r.finished && v.next) E.play.dataset.pre = `If played: ${fmt(v.next.score)} points`;
  else delete E.play.dataset.pre;
  E.undo.disabled = !r.canUndo || v.fatal;
  E.hint.disabled = r.finished || v.fatal;
  if (hadFocus && hadFocus.disabled) {
    const next = [E.play, E.retry].find((b) => !b.disabled);
    if (next) next.focus();
  }
  E.hintText.textContent = '';
  if (v.hint) {
    const said = v.hint.noop ? 'Hold still: no swap is best before this hand.' : `Try swapping ${posName(v.hint.a)} with ${posName(v.hint.b)}.`;
    E.hintText.textContent = (putBack ? 'Your swap was put back first. ' : '') + said;
  }
  E.notice.textContent = noticeText(v);
}

function lastScore(v) {
  for (let i = v.deal.length - 1; i >= 0; i--) if (v.deal[i].status === 'played' && v.deal[i].score != null) return v.deal[i].score;
  return 0;
}

function paintTotals(v) {
  E.total.textContent = fmt(v.total);
  E.total.dataset.value = String(v.total);
  E.hand.textContent = fmt(lastScore(v));
  // Saved progress, shown from the first frame so a returning visitor sees it persisted (a cascade defers it to its end).
  const saved = v.challenge.bestSaved;
  const tier = v.challenge.cardSaved;
  E.best.hidden = saved == null;
  if (saved != null) E.best.textContent = `Your best here: ${fmt(saved)}` + (tier && tier !== 'none' ? ` · ${TIER_LABEL[tier]}` : '') + '.';
}

function renderScore(v, prev, skipTotals) {
  const par = Math.max(0, v.challenge.par);
  const max = Math.max(1, par);
  if (!skipTotals) paintTotals(v);
  const nextScore = v.next ? v.next.score : null;
  E.nextScore.textContent = nextScore == null ? '–' : fmt(nextScore);
  if (prev && prev.next && v.next && prev.next.score !== nextScore && !reduced && dealKey(prev) === dealKey(v)) bump(E.nextScore);
  E.par.textContent = fmt(par);
  E.bar.setAttribute('aria-valuemax', String(max));
  E.bar.setAttribute('aria-valuenow', String(Math.min(v.total, max)));
  E.bar.setAttribute('aria-valuetext', `${fmt(v.total)} of ${fmt(par)}`);
  E.bar.dataset.met = par > 0 && v.total >= par ? '1' : '0';
  E.barFill.style.width = Math.min(100, (v.total / max) * 100).toFixed(1) + '%';
}

function bump(el) {
  el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.1)' }, { transform: 'scale(1)' }], { duration: 280, easing: 'ease-out' });
}

function findRow(rows, id) {
  if (!Array.isArray(rows)) return null;
  for (let i = 0; i < rows.length; i++) if (rows[i] && rows[i].id === id) return rows[i];
  return null;
}

function phaseCell(row) {
  if (!row) return '–';
  if (row.id === 'pendulum') return `${row.ring} (${row.side === 1 || (row.side == null && row.ring === 32) ? 'back' : 'out'})`;
  return row.flash ? `${row.ring}, flash` : String(row.ring);
}

function renderScope(v) {
  const c = v.challenge;
  E.scope.dataset.lock = String(v.lock);
  E.badge.hidden = v.lock === 0;
  E.badge.textContent = v.lock === 3 ? 'Gold lock' : v.lock === 2 ? 'Silver lock' : '';
  E.coupling.textContent = c.k === 0 ? 'Coupling Off. Fireflies blink alone.' : `Coupling ${COUPLING[c.k]}, flash bonus +${FLASH_BONUS[c.k]} mult per firefly.`;

  const s = v.sync;
  const pct = v.next ? s.next : s.now;
  const has = Number.isFinite(pct);
  E.syncMeter.setAttribute('aria-valuenow', has ? String(pct) : '0');
  E.syncMeter.setAttribute('aria-valuetext', has ? `${pct} percent${pct >= s.lock ? ', locked' : ''}` : 'Not available');
  E.syncMeter.dataset.locked = has && pct >= s.lock ? '1' : '0';
  E.syncFill.style.width = has ? pct + '%' : '0%';
  E.syncVal.textContent = has ? pct + '%' : '–';
  if (c.k === 0) E.syncNote.textContent = 'Coupling is off, so there is nothing to lock.';
  else if (!has) E.syncNote.textContent = `Needs two fireflies on the rail. Locks at ${s.lock}%.`;
  else E.syncNote.textContent = `Locks at ${s.lock}%.` + (v.next && Number.isFinite(s.now) ? ` Right now: ${s.now}%.` : '');

  const parts = [];
  for (const tr of E.phaseRows) {
    const id = tr.dataset.id;
    const place = v.pos.indexOf(id);
    const cells = tr.children;
    cells[1].textContent = phaseCell(findRow(v.phases.now, id));
    cells[2].textContent = v.next ? phaseCell(findRow(v.phases.next, id)) : '–';
    cells[3].textContent = place < 0 ? '–' : place < 5 ? `Slot ${place + 1}` : `Bench ${place - 4}`;
    const row = findRow(v.phases.next || v.phases.now, id);
    if (row) parts.push(`${nameOf(id)} ${id === 'pendulum' ? (row.ring === 32 ? 'back' : 'out') : row.ring}`);
  }
  E.ring.setAttribute('aria-label', `Phase ring, 64 steps, 0 at the top, clockwise. ${v.next ? 'If you play now' : 'Last hand'}: ${parts.join(', ')}. ${has ? `Sync ${pct} percent.` : 'Sync not available.'}`);
}

function stepRow(n, text, run, cls) {
  const li = document.createElement('li');
  li.className = 'step ' + cls;
  for (const [c, t] of [['step-n', n], ['step-t', text], ['step-r', run]]) {
    const span = document.createElement('span');
    span.className = c;
    span.textContent = t;
    li.appendChild(span);
  }
  return li;
}

function renderSteps(v) {
  const showLast = tab === 'last';
  const tr = showLast ? lastTrace : v.next;
  E.tabLast.setAttribute('aria-selected', showLast ? 'true' : 'false');
  E.tabLast.tabIndex = showLast ? 0 : -1;
  E.tabNext.setAttribute('aria-selected', showLast ? 'false' : 'true');
  E.tabNext.tabIndex = showLast ? -1 : 0;
  E.stepsBody.setAttribute('aria-labelledby', showLast ? 'tab-last' : 'tab-next');
  const rows = [];
  if (!tr) {
    E.stepsTitle.textContent = '';
    rows.push(stepRow('', showLast ? 'No hand has been played yet.' : 'Round over: there is no next hand to preview.', '', 'kind-idle'));
  } else {
    E.stepsTitle.textContent = showLast ? `Hand ${tr.hand + 1} played` : `Hand ${tr.hand + 1} if you play now`;
    rows.push(stepRow('', `${HAND_NAME[tr.cat] || 'Hand'}: ${tr.pts0} × ${tr.mult0}`, '', 'step-base'));
    for (const s of tr.steps) rows.push(stepRow(String(s.slot + 1), stepText(s), `${s.pts} × ${s.mult}`, 'kind-' + s.kind));
    rows.push(stepRow('', `= ${fmt(tr.score)}`, `${tr.pts} × ${tr.mult}`, 'step-total'));
  }
  E.steps.replaceChildren(...rows);
}

function renderResult(v, reveal) {
  const res = v.result;
  const was = !E.result.hidden;
  if (!res) {
    E.result.hidden = true;
    E.btnNext.hidden = true;
    return;
  }
  const c = v.challenge;
  E.result.hidden = false;
  E.result.dataset.tier = res.card;
  E.resultTitle.textContent = res.card === 'gold' ? 'Gold lock' : res.card === 'silver' ? 'Silver lock' : res.parMet ? 'Par reached' : 'Round over';
  const lines = [`Total ${fmt(res.total)}, par ${fmt(res.par)}: ${res.parMet ? `${fmt(res.total - res.par)} to spare.` : `${fmt(res.par - res.total)} short.`}`];
  if (c.k > 0 && v.mode === 'challenge') lines.push(res.lock > 0 ? `Locked: ${res.lock} of 3 fireflies.` : 'No lock this round.');
  lines.push(`Best possible on this deal: ${fmt(res.best)} (all 17,576 lines checked).`);
  if (c.k > 0) lines.push(c.maxLock > 0 ? `The most in-step rail on this deal locks ${c.maxLock} of 3.` : 'No rail on this deal locks.');
  if (c.bestSaved != null) lines.push(`Your best: ${fmt(c.bestSaved)}.`);
  E.resultLines.textContent = lines.join('\n');
  const showNext = v.mode === 'challenge' && c.hasNext;
  E.btnNext.hidden = !showNext;
  if (showNext) E.btnNext.textContent = `Next: ${CHALLENGE_NAME[c.id + 1] || 'challenge'}`;
  if (!was && reveal && !reduced) playClass(E.result, 'reveal');
}

function renderCard(v, reveal) {
  const card = v.share.card;
  const key = JSON.stringify(card);
  if (key !== cardKey) {
    const earned = reveal && cardKey && card.tier !== 'none' && !reduced;
    cardKey = key;
    E.cardHost.replaceChildren(conceptCard(card));
    if (earned) playClass(E.cardHost, 'reveal');
  }
  // A sandbox deal never earns a card (the panel above says so), so its sketch must not promise one.
  const sketch = v.mode === 'sandbox' ? 'Practice sketch. Sandbox deals do not earn a card.' : 'Practice sketch. Finish the round to earn this card.';
  E.cardCaption.textContent = card.tier === 'none' ? sketch : `${TIER_LABEL[card.tier]}. Share it with the link below.`;
  const url = shareUrl(v);
  if (E.shareUrl.value !== url) E.shareUrl.value = url;
}

function renderSandbox(v) {
  E.sandbox.hidden = v.mode !== 'sandbox';
  if (v.mode !== 'sandbox') return;
  if (document.activeElement !== E.seedInput) E.seedInput.value = String(v.challenge.seed);
  for (const r of E.kRadios) r.checked = Number(r.value) === v.challenge.k;
}

function glow(level) {
  const now = performance.now();
  if (reduced || now - lastGlow < 4000) return;
  lastGlow = now;
  E.scope.classList.remove('glow-2', 'glow-3');
  void E.scope.offsetWidth;
  E.scope.classList.add(level === 3 ? 'glow-3' : 'glow-2');
  setTimeout(() => E.scope.classList.remove('glow-2', 'glow-3'), level === 3 ? 1000 : 700);
}

function settle(v, reveal) {
  renderResult(v, reveal);
  renderCard(v, reveal);
  if (v.lockEvent) {
    glow(v.lockEvent);
    note(440, 700, 0.05, 0);
    note(659.25, 700, 0.05, 0);
  }
}

function describe(v, prev, trace) {
  const out = [];
  const fresh = !prev || dealKey(prev) !== dealKey(v);
  if (fresh) {
    out.push(`${v.mode === 'sandbox' ? 'Sandbox deal ' + v.challenge.seed : 'Challenge ' + v.challenge.id + ', ' + CHALLENGE_NAME[v.challenge.id]}.`);
    if (trace) out.push(`Hand ${trace.hand + 1} played: ${HAND_NAME[trace.cat]}, ${fmt(trace.score)} points.`);
  } else if (v.round.hand > prev.round.hand) {
    const h = v.deal[v.round.hand - 1];
    out.push(`Hand ${v.round.hand} played: ${HAND_NAME[h.cat]}, ${fmt(h.score)} points. Total ${fmt(v.total)}.`);
  } else if (v.pos.join() !== prev.pos.join()) {
    if (!v.changed.length) { if (!putBack) out.push('Swap undone.'); }
    else {
      // A rail-bench swap re-sorts the bench, so three or four positions can move: describe it from the rail slots.
      const moved = [];
      for (let i = 0; i < 5; i++) if (v.pos[i] !== prev.pos[i]) moved.push(i);
      let said = '';
      if (moved.length === 2) said = `Swapped ${nameOf(prev.pos[moved[0]])} with ${nameOf(prev.pos[moved[1]])}.`;
      else if (moved.length === 1) said = `Swapped ${nameOf(prev.pos[moved[0]])} out for ${nameOf(v.pos[moved[0]])}.`;
      if (said) out.push(said + (v.next ? ` If you play now: ${fmt(v.next.score)} points.` : ''));
    }
  }
  if (v.hint && !(prev && prev.hint)) out.push(E.hintText.textContent);
  if (v.lockEvent) out.push(v.lockEvent === 3 ? 'Gold lock! All three fireflies are in phase.' : 'Silver lock! Two fireflies are in phase.');
  if (v.round.finished && (!prev || !prev.round.finished || fresh)) out.push(coachText(v));
  if (v.notice) out.push(noticeText(v));
  announce(out.join(' '));
}

// Keyboard focus must never fall to <body> because the control that had it was hidden or disabled by this render.
function repairFocus(hadFocus) {
  if (!hadFocus || hadFocus === document.body || hadFocus === document.documentElement) return;
  const gone = !hadFocus.isConnected || hadFocus.disabled || (hadFocus.closest && hadFocus.closest('[hidden]'));
  const now = document.activeElement; // the browser may not have cleared focus from a hidden element yet
  if (!gone || (now !== hadFocus && now !== document.body)) return;
  const slot = E.slots[Math.min(focusPos, 4)];
  const target = slot && slot.getAttribute('aria-disabled') !== 'true' ? slot : [E.play, E.retry].find((b) => !b.disabled);
  if (!target) return;
  target.focus({ preventScroll: true });
  // A keyboard or switch user must be able to see where focus went: when the ring would be off-screen, bring it into view.
  // (A pointer user whose button went away is not shown a ring, so the page does not jump for them.)
  const r = target.getBoundingClientRect();
  if (target.matches(':focus-visible') && (r.top < 0 || r.bottom > window.innerHeight)) {
    target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
  }
}

function render(v, trace, animate) {
  const prev = vm;
  const fresh = !prev || dealKey(prev) !== dealKey(v);
  const hadFocus = document.activeElement;
  vm = v;
  E.fatal.hidden = !v.fatal;
  if (v.fatal) {
    finishReady();
    return;
  }
  if (fresh) lastTrace = null;
  if (trace) lastTrace = trace;
  if (trace) tab = 'last';
  else if (prev && !fresh && prev.changed.join() !== v.changed.join()) tab = 'next';
  if (v.round.finished) tab = 'last';
  if (fresh || !basePos || !v.changed.length) basePos = v.pos.slice();
  if (!v.hint) putBack = false;
  else if (fresh) putBack = false;
  else if (prev.changed.length && !v.changed.length && !prev.hint) putBack = true;
  E.app.dataset.mode = v.mode;

  const cascade = animate && !!trace && !reduced && !document.hidden;
  renderTop(v);
  renderDeal(v, prev, animate);
  renderSlots(v, prev);
  renderButtons(v);
  renderScore(v, prev, cascade);
  renderScope(v);
  renderSteps(v);
  renderSandbox(v);
  describe(v, prev, trace);
  if (cascade) {
    E.result.hidden = true;
    startCascade(trace, v, prev ? prev.total : 0);
  } else {
    settle(v, animate);
    if (animate && trace && reduced && !document.hidden) showToast(trace, v.total);
  }
  repairFocus(hadFocus);
  ring.resize();
  dirty = true;
  kick();
}

/* ---- Cascade: the hand scores joker by joker ---------------------------------------------------------------- */
function startCascade(tr, v, prevTotal) {
  const lis = E.steps.children;
  const c = { anims: [], timers: [], tweens: [], notes: [], raf: 0, vm: v };
  casc = c;
  dropToast();
  const delays = [];
  let d = 0;
  let tick = 0;
  for (let i = 0; i < lis.length; i++) {
    const s = i >= 1 && i <= tr.steps.length ? tr.steps[i - 1] : null;
    const live = !!s && s.kind !== 'idle';
    const rise = [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }];
    c.anims.push(lis[i].animate(rise, { duration: 360, delay: d, easing: EASE, fill: 'backwards' }));
    delays.push(d);
    if (live) {
      const slot = E.slots[s.slot];
      if (slot) c.anims.push(slot.animate([{ boxShadow: '0 0 0 0 var(--accent)' }, { boxShadow: '0 0 0 6px transparent' }], { duration: 240, delay: d, easing: 'ease-out' }));
      note(660 + 40 * tick++, 45, 0.04, d);
      if (s.why === 'flash') note(1320, 90, 0.03, d + 50);
    }
    if (i === lis.length - 1) {
      const t0 = performance.now() + d;
      E.total.textContent = fmt(prevTotal);
      c.tweens.push({ el: E.total, from: prevTotal, to: v.total, t0, dur: 240, done: false });
      c.tweens.push({ el: E.hand, from: 0, to: tr.score, t0, dur: 240, done: false });
      c.timers.push(setTimeout(() => bump(E.total), d + 240));
    }
    d += live ? 300 : 90;
  }
  E.hand.textContent = '0';
  c.timers.push(setTimeout(() => finishCascade(true), d + 460));
  c.raf = requestAnimationFrame(runTweens);
  // The scoring list sits far below Play, so the same rows play in a floating summary at the same delays. It is built
  // after the first frame has been painted (it needs a layout read), and joins the rows part-way in by the time already gone.
  const t0 = performance.now();
  c.toastRaf = requestAnimationFrame(() => {
    c.toastRaf = 0;
    c.timers.push(setTimeout(() => {
      if (casc !== c) return;
      const rows = buildToast(tr, v.total);
      if (!rows) return;
      const late = performance.now() - t0;
      const rise = [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }];
      for (let i = 0; i < rows.length; i++) {
        c.anims.push(rows[i].animate(rise, { duration: 360, delay: Math.max(0, (delays[i] || 0) - late), easing: EASE, fill: 'backwards' }));
      }
    }, 0));
  });
}

/* ---- Cascade toast: an aria-hidden copy of the scoring rows, pinned to the bottom of the screen ---------------- */
function dropToast() {
  if (!toast) return;
  clearTimeout(toast.timer);
  toast.el.remove();
  toast = null;
}

// Reduced motion: the summary appears at once and goes after a moment.
function showToast(tr, total) {
  dropToast();
  if (buildToast(tr, total)) toast.timer = setTimeout(dropToast, 2500);
}

// Returns the row elements (same order as #steps) so the cascade can reveal them at the same delays; null if no toast.
// The last row also names the running total: the Total panel is below the fold on a phone and on a 768 px tall laptop.
function buildToast(tr, total) {
  dropToast();
  const panel = E.stepsPanel.getBoundingClientRect();
  if (panel.top >= 0 && panel.bottom <= window.innerHeight) return null; // the real list is already on screen
  const el = document.createElement('div');
  el.id = 'cascade-toast';
  el.setAttribute('aria-hidden', 'true');
  const head = document.createElement('p');
  head.className = 'ct-head';
  head.textContent = `Hand ${tr.hand + 1} played`;
  const list = document.createElement('ol');
  list.className = 'steps';
  const rows = [stepRow('', `${HAND_NAME[tr.cat] || 'Hand'}: ${tr.pts0} × ${tr.mult0}`, '', 'step-base')];
  for (const s of tr.steps) rows.push(stepRow(String(s.slot + 1), stepText(s), `${s.pts} × ${s.mult}`, 'kind-' + s.kind));
  const running = Number.isFinite(total) && total !== tr.score ? ` · total ${fmt(total)}` : '';
  rows.push(stepRow('', `= ${fmt(tr.score)}${running}`, `${tr.pts} × ${tr.mult}`, 'step-total'));
  list.append(...rows);
  el.append(head, list);
  document.body.appendChild(el);
  toast = { el, timer: 0 };
  return rows;
}

function runTweens(now) {
  if (!casc) return;
  let live = false;
  for (const w of casc.tweens) {
    const p = (now - w.t0) / w.dur;
    if (p < 1) {
      if (p >= 0) w.el.textContent = fmt(w.from + (w.to - w.from) * p);
      live = true;
    } else if (!w.done) {
      w.el.textContent = fmt(w.to);
      w.done = true;
    }
  }
  casc.raf = live ? requestAnimationFrame(runTweens) : 0;
}

// natural: the cascade ran to its end by itself, so its toast stays a moment longer; any other finish is the visitor moving on.
function finishCascade(natural) {
  if (!casc) {
    if (natural !== true) dropToast();
    return;
  }
  const c = casc;
  casc = null;
  if (natural === true && toast) {
    clearTimeout(toast.timer);
    toast.timer = setTimeout(dropToast, 1200);
  } else {
    dropToast();
  }
  for (const t of c.timers) clearTimeout(t);
  if (c.raf) cancelAnimationFrame(c.raf);
  if (c.toastRaf) cancelAnimationFrame(c.toastRaf);
  for (const a of c.anims) {
    try { a.finish(); } catch (err) { /* already settled */ }
  }
  for (const o of c.notes) {
    try { o.stop(); } catch (err) { /* already stopped */ }
  }
  paintTotals(c.vm);
  settle(c.vm, true);
}

/* ---- Frame loop for the ring ------------------------------------------------------------------------------- */
function frame(t) {
  raf = 0;
  if (document.hidden || !vm) return;
  try {
    const busy = ring.busy(t);
    if (dirty || busy || t - lastDraw >= 66) {
      ring.draw(vm, { reduced, t });
      lastDraw = t;
      dirty = false;
    }
  } catch (err) {
    console.warn('ring failed', err);
    return;
  }
  if (!reduced || ring.busy(t)) raf = requestAnimationFrame(frame);
}

function kick() {
  if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
}

function finishReady() {
  if (readyDone) return;
  readyDone = true;
  document.documentElement.setAttribute('data-ready', '1');
  if (typeof window.__sedThumbResolve === 'function') window.__sedThumbResolve();
}

function whenReady() {
  if (readyStarted) return;
  readyStarted = true;
  let frames = 0;
  const step = () => {
    if (++frames >= 2) finishReady();
    else requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  setTimeout(finishReady, 1500);
}

/* ---- Moving jokers: tap-select, keyboard, drag ---------------------------------------------------------------- */
function canMove() {
  return !!vm && !vm.fatal && !vm.round.finished;
}

function setGrab(pos) {
  grabbed = pos;
  E.slots.forEach((s, i) => {
    s.classList.toggle('is-grabbed', i === pos);
    s.setAttribute('aria-pressed', i === pos ? 'true' : 'false');
  });
}

function showInfo(pos) {
  const id = vm && vm.pos[pos];
  if (id) E.info.textContent = `${nameOf(id)}: ${jokerDesc(id)}`;
}

function tapSelect(pos) {
  if (!canMove()) return;
  showInfo(pos);
  if (grabbed < 0) {
    setGrab(pos);
    announce(`Picked up ${nameOf(vm.pos[pos])} from ${posName(pos)}. Move to another slot and press Space or Enter to swap, or Escape to cancel.`);
  } else if (grabbed === pos) {
    setGrab(-1);
    announce('Put down.');
  } else {
    const a = grabbed;
    setGrab(-1);
    act({ type: 'swap', a, b: pos });
  }
}

function slotOf(ev) {
  const el = ev.target && ev.target.closest ? ev.target.closest('.slot') : null;
  return el ? Number(el.dataset.pos) : -1;
}

function setRoving(pos) {
  focusPos = pos;
  E.slots.forEach((s, i) => { s.tabIndex = i === pos ? 0 : -1; });
}

function onRigKey(ev) {
  const pos = slotOf(ev);
  if (pos < 0 || ev.altKey || ev.ctrlKey || ev.metaKey) return;
  let to = -1;
  if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') to = Math.max(0, pos - 1);
  else if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') to = Math.min(7, pos + 1);
  else if (ev.key === 'Home') to = 0;
  else if (ev.key === 'End') to = 7;
  if (to < 0) return;
  ev.preventDefault();
  E.slots[to].focus();
}

function dropTarget(ev) {
  const el = document.elementFromPoint(ev.clientX, ev.clientY);
  const slot = el && el.closest ? el.closest('.slot') : null;
  return slot ? Number(slot.dataset.pos) : -1;
}

function onPointerDown(ev) {
  const pos = slotOf(ev);
  if (pos < 0 || (ev.pointerType === 'mouse' && ev.button !== 0) || !canMove()) return;
  drag = { pos, id: ev.pointerId, x: ev.clientX, y: ev.clientY, on: false, ghost: null, over: -1 };
  try { E.slots[pos].setPointerCapture(ev.pointerId); } catch (err) { /* capture is a nicety */ }
}

function onPointerMove(ev) {
  if (!drag || drag.id !== ev.pointerId) return;
  if (!drag.on) {
    const dx = ev.clientX - drag.x;
    const dy = ev.clientY - drag.y;
    const touch = ev.pointerType !== 'mouse';
    if (Math.hypot(dx, dy) < (touch ? 8 : 6)) return;
    // A finger that starts out vertical is scrolling the page, not carrying a joker; the browser takes the gesture over
    // (pointercancel) and the joker stays put. Rail-to-bench moves on touch go through tap-select.
    if (touch && Math.abs(dx) <= Math.abs(dy)) {
      drag = null;
      return;
    }
    drag.on = true;
    setGrab(drag.pos);
    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.appendChild(E.slots[drag.pos].querySelector('.tok').cloneNode(true));
    document.body.appendChild(ghost);
    drag.ghost = ghost;
  }
  drag.ghost.style.transform = `translate(${ev.clientX - 28}px, ${ev.clientY - 40}px)`;
  const over = dropTarget(ev);
  if (over !== drag.over) {
    if (drag.over >= 0) E.slots[drag.over].classList.remove('is-drop');
    if (over >= 0 && over !== drag.pos) E.slots[over].classList.add('is-drop');
    drag.over = over;
  }
}

function endDrag(ev, commit) {
  if (!drag || drag.id !== ev.pointerId) return;
  const d = drag;
  drag = null;
  if (!d.on) return;
  d.ghost.remove();
  if (d.over >= 0) E.slots[d.over].classList.remove('is-drop');
  d.over = dropTarget(ev);
  setGrab(-1);
  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 60);
  if (commit && d.over >= 0 && d.over !== d.pos && canMove()) act({ type: 'swap', a: d.pos, b: d.over });
}

/* ---- Keys and buttons ---------------------------------------------------------------------------------------- */
// Single-key shortcuts (WCAG 2.1.4) belong to the game: they work while focus or the last click is in the app, and never
// from links, the About summary or the footer, where a stray letter from speech input or a screen reader would be a surprise.
function shortcutsLive(t) {
  if (t && t.closest && t.closest('a, summary, .sed-about, .sed-footer, .sed-header')) return false;
  const a = document.activeElement;
  // Focus on <main> (a click on plain text, or Skip to content) is the same as no focus: the last pointer or skip-link action decides.
  if (a && a !== document.body && a !== document.documentElement && a !== E.main) return !!(E.app.contains(a) || E.app.contains(t));
  return appActive;
}

function disarm() {
  if (!armed) return;
  clearTimeout(armed.timer);
  armed = null;
  if (E.notice.dataset.armed) {
    delete E.notice.dataset.armed;
    E.notice.textContent = vm ? noticeText(vm) : '';
  }
}

// Restarting or switching deals throws away a round in progress, so past hand 1 the shortcut asks for a second press.
function confirmed(key, verb) {
  const r = vm && vm.round;
  if (!r || r.hand <= 1 || r.finished) return true;
  if (armed && armed.key === key) {
    disarm();
    return true;
  }
  disarm();
  const msg = `Press ${key.toUpperCase()} again to ${verb}.`;
  armed = { key, timer: setTimeout(disarm, 2000) };
  E.notice.dataset.armed = '1';
  E.notice.textContent = msg;
  announce(msg);
  return false;
}

function onGlobalKey(ev) {
  if (ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey || ev.repeat) return;
  const t = ev.target;
  const tag = t && t.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
  if (!shortcutsLive(t)) return;
  finishCascade();
  if (ev.key === 'Escape') {
    if (grabbed >= 0) {
      setGrab(-1);
      announce('Cancelled.');
      ev.preventDefault();
    }
    return;
  }
  if (!keysOn || !vm || ev.key.length !== 1) return;
  const r = vm.round;
  const key = ev.key.toLowerCase();
  switch (key) {
    case 'p': disarm(); if (r.canPlay) { setGrab(-1); act({ type: 'play' }); } break;
    case 'u': disarm(); if (r.canUndo) act({ type: 'undo' }); break;
    case 'r': if (confirmed(key, 'restart')) act({ type: 'retry' }); break;
    case 'h': disarm(); if (!r.finished) act({ type: 'hint' }); break;
    case 'm': disarm(); toggleSound(); break;
    case '1': case '2': case '3': {
      const id = Number(key);
      if (vm.mode === 'challenge' && vm.challenge.id === id) break;
      if (confirmed(key, `switch to challenge ${id}`)) goChallenge(id);
      break;
    }
    case 's': if (confirmed(key, 'deal a sandbox round')) act({ type: 'sandbox' }); break;
    default: return;
  }
  ev.preventDefault();
}

function goChallenge(id) {
  if (!vm || vm.mode !== 'challenge' || vm.challenge.id !== id) act({ type: 'challenge', id });
}

function selectedK() {
  const r = E.kRadios.find((x) => x.checked);
  return r ? Number(r.value) : 2;
}

function dealSandbox(fresh) {
  const n = Math.trunc(Number(E.seedInput.value));
  const detail = { type: 'sandbox', k: selectedK() };
  if (!fresh && Number.isFinite(n)) detail.seed = n;
  act(detail);
  // The deal controls can sit far from the rail (below it on a phone, below the fold beside it on a desktop): when the
  // new round is out of view, take the visitor back up to it.
  const rig = E.rig.getBoundingClientRect();
  if (rig.bottom < 0 || rig.top > window.innerHeight) {
    const slot = E.slots[Math.min(focusPos, 4)];
    if (slot) slot.focus({ preventScroll: true });
    E.desc.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
  }
}

// The deal controls live in their own panel, which is below the fold on most screens: one tap takes the visitor there.
function goChangeDeal() {
  E.sandbox.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
  E.seedInput.focus({ preventScroll: true });
  E.seedInput.select();
}

function pickTab(name) {
  tab = name;
  if (vm) renderSteps(vm);
}

function bind() {
  document.addEventListener('app:state', (ev) => {
    const d = ev && ev.detail;
    if (!d || !d.vm) return;
    try {
      finishCascade();
      disarm();
      render(d.vm, d.trace || null, !!d.animate);
    } catch (err) {
      console.warn('render failed', err);
    }
    whenReady();
  });
  for (const b of E.navBtns) {
    b.addEventListener('click', () => {
      const id = Number(b.dataset.challenge);
      if (id === 0) act({ type: 'sandbox' });
      else goChallenge(id);
    });
  }
  E.play.addEventListener('click', () => { setGrab(-1); act({ type: 'play' }); });
  E.undo.addEventListener('click', () => act({ type: 'undo' }));
  E.retry.addEventListener('click', () => act({ type: 'retry' }));
  E.resultRetry.addEventListener('click', () => act({ type: 'retry' }));
  E.hint.addEventListener('click', () => act({ type: 'hint' }));
  E.sound.addEventListener('click', toggleSound);
  E.copy.addEventListener('click', copyLink);
  E.keysToggle.addEventListener('click', toggleKeys);
  E.shareUrl.addEventListener('focus', () => E.shareUrl.select());
  E.btnNext.addEventListener('click', () => { if (vm) act({ type: 'challenge', id: vm.challenge.id + 1 }); });
  E.changeDeal.addEventListener('click', goChangeDeal);
  $('btn-deal').addEventListener('click', () => dealSandbox(false));
  $('btn-newseed').addEventListener('click', () => dealSandbox(true));
  E.seedInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); dealSandbox(false); } });
  E.tabLast.addEventListener('click', () => pickTab('last'));
  E.tabNext.addEventListener('click', () => pickTab('next'));
  for (const [el, other, name] of [[E.tabLast, E.tabNext, 'next'], [E.tabNext, E.tabLast, 'last']]) {
    el.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
      ev.preventDefault();
      pickTab(name);
      other.focus();
    });
  }

  E.rig.addEventListener('click', (ev) => {
    const pos = slotOf(ev);
    if (pos < 0) return;
    if (suppressClick) { suppressClick = false; return; }
    tapSelect(pos);
  });
  E.rig.addEventListener('keydown', onRigKey);
  E.rig.addEventListener('focusin', (ev) => {
    const pos = slotOf(ev);
    if (pos >= 0) { setRoving(pos); showInfo(pos); }
  });
  E.rig.addEventListener('pointerover', (ev) => {
    const pos = slotOf(ev);
    if (pos >= 0 && ev.pointerType === 'mouse') showInfo(pos);
  });
  E.rig.addEventListener('pointerdown', onPointerDown);
  E.rig.addEventListener('pointermove', onPointerMove);
  E.rig.addEventListener('pointerup', (ev) => endDrag(ev, true));
  E.rig.addEventListener('pointercancel', (ev) => endDrag(ev, false));

  document.addEventListener('keydown', onGlobalKey);
  // Any key or tap puts the floating cascade summary away; where the visitor last worked decides if shortcuts are live.
  document.addEventListener('keydown', dropToast, true);
  document.addEventListener('pointerdown', (ev) => {
    dropToast();
    const t = ev.target;
    if (t && t.closest && t.closest('a, summary, .sed-footer, .sed-header')) appActive = false;
    else if (E.main.contains(t)) appActive = true; // the board, the title, the notes: all part of the game
  }, true);
  let skipFocus = false;
  document.addEventListener('focusin', (ev) => {
    const t = ev.target;
    if (t === E.main) {
      // A click on plain text lands focus on <main> right after pointerdown decided; only Skip to content changes the answer here.
      if (skipFocus) appActive = true;
    } else {
      appActive = E.app.contains(t);
    }
    skipFocus = !!(t && t.closest && t.closest('.sed-skip'));
  });
  if (soundOn) {
    const wake = () => { ensureAudio(); };
    document.addEventListener('pointerdown', wake, { once: true });
    document.addEventListener('keydown', wake, { once: true });
  }
  window.addEventListener('resize', () => {
    ring.resize();
    dirty = true;
    kick();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      finishCascade();
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    } else {
      dirty = true;
      kick();
    }
  });
}

export function mountUI() {
  if (E) return;
  const q = (sel) => Array.from(document.querySelectorAll(sel));
  E = {
    live: $('live'), fatal: $('fatal'), navBtns: q('#challenge-nav button'), desc: $('challenge-desc'), coach: $('coach'),
    deal: $('deal'), rig: document.querySelector('.rig'), info: $('joker-info'), slots: q('.slot').sort((a, b) => a.dataset.pos - b.dataset.pos),
    play: $('btn-play'), undo: $('btn-undo'), retry: $('btn-retry'), hint: $('btn-hint'), sound: $('btn-sound'), copy: $('btn-copy'),
    hintText: $('hint-text'), notice: $('notice'), total: $('score-total'), hand: $('score-hand'), nextScore: $('score-next'), par: $('score-par'),
    bar: $('score-bar'), barFill: document.querySelector('#score-bar .bar-fill'), best: $('score-best'), scope: $('scope'), badge: $('lock-badge'), coupling: $('coupling-line'),
    ring: $('ring'), syncMeter: $('sync-meter'), syncFill: document.querySelector('#sync-meter .sync-fill'), syncVal: $('sync-val'), syncNote: $('sync-note'),
    phaseRows: q('#phase-table tbody tr'), tabLast: $('tab-last'), tabNext: $('tab-next'), stepsBody: $('steps-body'), stepsTitle: $('steps-title'), steps: $('steps'),
    result: $('result'), resultTitle: $('result-h'), resultLines: $('result-lines'), btnNext: $('btn-next'), resultRetry: $('btn-result-retry'),
    cardHost: $('card-host'), cardCaption: $('card-caption'), shareUrl: $('share-url'), sandbox: $('sandbox'), seedInput: $('sandbox-seed'),
    kRadios: q('#sandbox input[name="k"]'), app: $('app'), main: $('main'), stepsPanel: $('steps-panel'), descText: null, changeDeal: document.createElement('button')
  };
  E.changeDeal.type = 'button';
  E.changeDeal.id = 'btn-change-deal';
  E.changeDeal.className = 'sed-btn is-quiet change-deal';
  E.changeDeal.textContent = 'Change deal';
  E.keysLine = document.querySelector('.keys') || document.createElement('p');
  E.keysToggle = document.createElement('button');
  E.keysToggle.type = 'button';
  E.keysToggle.id = 'btn-keys';
  E.keysToggle.className = 'keys-toggle';
  if (E.keysLine) E.keysLine.append(' ', E.keysToggle);
  E.parts = E.slots.map((s) => ({ tok: s.querySelector('.tok'), glyph: s.querySelector('.glyph'), name: s.querySelector('.jname') }));
  E.hands = Array.from(E.deal.children).map((li) => ({
    root: li, key: '', tag: li.querySelector('.hand-tag'), cards: li.querySelector('.hand-cards'), name: li.querySelector('.hand-name'),
    base: li.querySelector('.hand-base'), score: li.querySelector('.hand-score')
  }));
  const mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  reduced = !!(mq && mq.matches);
  if (mq) {
    const onChange = (ev) => { reduced = ev.matches; dirty = true; kick(); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }
  ring = createRing(E.ring);
  loadPrefs();
  renderSoundButton();
  renderKeysToggle();
  bind();
}
