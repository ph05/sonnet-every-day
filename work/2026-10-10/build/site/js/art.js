// Inline SVG art: joker glyphs, card faces and the concept card. Pure drawing, no engine imports.
const NS = 'http://www.w3.org/2000/svg';

export const JOKER_NAME = {
  steady: 'Steady', twofold: 'Twofold', tally: 'Tally', pendulum: 'Pendulum',
  handshake: 'Handshake', lantern: 'Lantern', ember: 'Ember', spark: 'Spark'
};
export const CHALLENGE_NAME = ['Sandbox', 'First Beat', 'Soft Pull', 'Shake On It'];
export const COUPLING = ['Off', 'Soft', 'Medium', 'Firm'];

const RANK_TEXT = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const RANK_WORD = { 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace' };
const SUIT_WORD = ['spades', 'hearts', 'diamonds', 'clubs'];
const SUIT_PATH = [
  'M12 2C12 2 3 9 3 14.2a4.4 4.4 0 0 0 8.1 2.4C11 19 10 20.5 8 22h8c-2-1.5-3-3-3.1-5.4A4.4 4.4 0 0 0 21 14.2C21 9 12 2 12 2Z',
  'M12 21C5 15 2 11 2 7.5A4.5 4.5 0 0 1 12 6a4.5 4.5 0 0 1 10 1.5C22 11 19 15 12 21Z',
  'M12 2 21 12 12 22 3 12Z',
  'M12 2.5a4.2 4.2 0 0 1 3.4 6.7 4.2 4.2 0 1 1-2.5 7.4c0 2 .8 3.5 2.6 5.4H8.5c1.8-1.9 2.6-3.4 2.6-5.4a4.2 4.2 0 1 1-2.5-7.4A4.2 4.2 0 0 1 12 2.5Z'
];

function node(tag, attrs, kids) {
  const e = document.createElementNS(NS, tag);
  if (attrs) for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  if (kids) for (const c of kids) e.appendChild(c);
  return e;
}

function text(x, y, str, attrs) {
  const t = node('text', Object.assign({ x, y }, attrs));
  t.textContent = str;
  return t;
}

function starPath(cx, cy, ro, ri, n) {
  let d = '';
  for (let i = 0; i < n * 2; i++) {
    const a = (Math.PI * i) / n - Math.PI / 2;
    const rad = i % 2 ? ri : ro;
    d += (i ? 'L' : 'M') + (cx + rad * Math.cos(a)).toFixed(1) + ' ' + (cy + rad * Math.sin(a)).toFixed(1);
  }
  return d + 'Z';
}

const SOLID = { class: 'f', 'fill-opacity': 0.3, stroke: 'currentColor', 'stroke-width': 1.75, 'stroke-linejoin': 'round' };
const LINE = { fill: 'none', stroke: 'currentColor', 'stroke-width': 1.75, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
const SPARK_D = starPath(24, 24, 20, 8, 8);

const GLYPH = {
  steady: () => [
    node('polygon', Object.assign({ points: '24,4 41,14 41,34 24,44 7,34 7,14' }, SOLID)),
    node('path', Object.assign({ d: 'M24 14v14M17 21h14M17 34h14' }, LINE))
  ],
  twofold: () => [
    node('circle', Object.assign({ cx: 18, cy: 24, r: 12 }, SOLID)),
    node('circle', Object.assign({ cx: 30, cy: 24, r: 12 }, SOLID))
  ],
  tally: () => [
    node('rect', Object.assign({ x: 7, y: 7, width: 34, height: 34, rx: 9 }, SOLID)),
    node('path', Object.assign({ d: 'M16 16v16M22 16v16M28 16v16M34 16v16M11 35 37 13' }, LINE))
  ],
  pendulum: () => [
    node('path', Object.assign({ d: 'M7 30A26 26 0 0 0 41 30', 'stroke-dasharray': '3 4', opacity: 0.55 }, LINE)),
    node('path', Object.assign({ d: 'M24 8 33 32' }, LINE)),
    node('circle', Object.assign({ cx: 24, cy: 8, r: 3.5 }, SOLID)),
    node('circle', Object.assign({ cx: 34, cy: 35, r: 7 }, SOLID))
  ],
  handshake: () => [
    node('path', Object.assign({ d: 'M6 31C6 17 24 13 27 26M42 17C42 31 24 35 21 22', 'stroke-width': 3.5 }, LINE)),
    node('circle', Object.assign({ cx: 24, cy: 24, r: 5 }, SOLID))
  ],
  lantern: () => [
    node('circle', Object.assign({ cx: 24, cy: 24, r: 19 }, LINE)),
    node('circle', Object.assign({ cx: 24, cy: 24, r: 10 }, SOLID, { 'fill-opacity': 0.75 }))
  ],
  ember: () => [
    node('polygon', Object.assign({ points: '24,4 42,24 24,44 6,24' }, SOLID)),
    node('polygon', { points: '24,15 33,24 24,33 15,24', fill: '#ffffff', 'fill-opacity': 0.6 })
  ],
  spark: () => [node('path', Object.assign({ d: SPARK_D }, SOLID))]
};

export function jokerGlyph(id) {
  const svg = node('svg', { viewBox: '0 0 48 48', class: 'glyph-svg', 'aria-hidden': 'true', focusable: 'false' });
  const make = Object.prototype.hasOwnProperty.call(GLYPH, id) ? GLYPH[id] : null;
  const parts = make ? make() : [node('circle', Object.assign({ cx: 24, cy: 24, r: 16 }, LINE))];
  for (const p of parts) svg.appendChild(p);
  return svg;
}

export function cardName(card) {
  const r = Math.min(14, Math.max(2, Math.trunc(Number(card && card.r)) || 2));
  const s = Math.min(3, Math.max(0, Math.trunc(Number(card && card.s)) || 0));
  return (RANK_WORD[r] || String(r)) + ' of ' + SUIT_WORD[s];
}

export function cardFace(card) {
  const r = Math.min(14, Math.max(2, Math.trunc(Number(card && card.r)) || 2));
  const s = Math.min(3, Math.max(0, Math.trunc(Number(card && card.s)) || 0));
  const ink = s === 1 || s === 2 ? '#b3261e' : '#1b1a24';
  const label = RANK_TEXT[r] || String(r);
  return node('svg', { viewBox: '0 0 40 56', class: 'card-face', role: 'img', 'aria-label': cardName({ r, s }) }, [
    node('rect', { x: 1, y: 1, width: 38, height: 54, rx: 5, fill: '#ffffff', stroke: '#b9b2a2', 'stroke-width': 1.5 }),
    text(label === '10' ? 4 : 6, 17, label, { fill: ink, 'font-size': 15, 'font-weight': 700, 'font-family': 'system-ui, sans-serif' }),
    node('path', { d: SUIT_PATH[s], fill: ink, transform: 'translate(8 26)' })
  ]);
}

const TIER = {
  none: { label: 'Practice sketch', bg: '#f3eee4', edge: '#8d8676', ribbon: '#d9d0bf', rInk: '#1d1b26', dash: '7 6' },
  par: { label: 'Par card', bg: '#fffdf8', edge: '#5b3fd1', ribbon: '#5b3fd1', rInk: '#ffffff', dash: null },
  silver: { label: 'Silver lock', bg: '#eef0f6', edge: '#8c93a8', ribbon: '#c3c8d6', rInk: '#0f1226', dash: null },
  gold: { label: 'Gold lock', bg: '#fff4d6', edge: '#e0a82e', ribbon: '#e0a82e', rInk: '#0f1226', dash: null }
};
const INK = '#1d1b26';
const MUTED = '#4f4d5c';
const FIRE_LANE = { lantern: 52, ember: 38, spark: 24 };

function fireflyDot(id, x, y, solid) {
  const paint = { fill: solid ? '#d9f55c' : 'none', stroke: INK, 'stroke-width': 1.5 };
  if (id === 'ember') return node('polygon', Object.assign({ points: `${x},${y - 7} ${x + 7},${y} ${x},${y + 7} ${x - 7},${y}` }, paint));
  if (id === 'spark') return node('path', Object.assign({ d: starPath(x, y, 8, 3.5, 8) }, paint));
  return node('circle', Object.assign({ cx: x, cy: y, r: 6 }, paint));
}

function phaseMotif(tier, cx, cy) {
  const g = node('g');
  g.appendChild(node('circle', { cx, cy, r: 52, fill: 'none', stroke: INK, 'stroke-opacity': 0.35, 'stroke-width': 2 }));
  g.appendChild(node('circle', { cx, cy, r: 52, fill: 'none', stroke: INK, 'stroke-opacity': 0.25, 'stroke-width': 8, 'stroke-dasharray': '2 18.4' }));
  const angles = tier === 'gold' ? [0, 0, 0] : tier === 'silver' ? [0, 0, 140] : [0, 100, 220];
  Object.keys(FIRE_LANE).forEach((id, i) => {
    const a = (angles[i] * Math.PI) / 180;
    const lane = FIRE_LANE[id];
    g.appendChild(fireflyDot(id, +(cx + lane * Math.sin(a)).toFixed(1), +(cy - lane * Math.cos(a)).toFixed(1), tier !== 'none'));
  });
  g.appendChild(node('circle', { cx, cy: cy + 52, r: 5.5, fill: tier === 'none' ? 'none' : '#ff9f6e', stroke: INK, 'stroke-width': 1.5 }));
  return g;
}

const clampInt = (v, lo, hi, dflt) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

export function conceptCard(card) {
  const c = card || {};
  const tier = Object.prototype.hasOwnProperty.call(TIER, c.tier) ? c.tier : 'none';
  const T = TIER[tier];
  const rail = (Array.isArray(c.rail) ? c.rail : []).slice(0, 5).filter((id) => Object.prototype.hasOwnProperty.call(JOKER_NAME, id));
  const seed = clampInt(c.seed, 1, 99999, 1);
  const k = clampInt(c.k, 0, 3, 0);
  const cid = clampInt(c.cid, 0, 3, 0);
  const total = clampInt(c.total, 0, 99999999, 0);
  const line = typeof c.line === 'string' && /^[a-z]{1,3}$/.test(c.line) ? c.line : '';
  const face = { 'font-family': 'system-ui, -apple-system, "Segoe UI", sans-serif', fill: INK };

  const svg = node('svg', {
    viewBox: '0 0 240 344', class: 'concept-card', role: 'img',
    'aria-label': `Concept card, ${T.label}. ${CHALLENGE_NAME[cid]}, deal ${seed}, ${total} points.`,
    // The page surface is dark in the dark scheme; the card paints its own paper (same corner radius as the rect below).
    style: `--fam:#d9921a;color:#1d1b26;background:${T.bg};border-radius:6.67% / 4.65%`
  });
  svg.appendChild(node('rect', { x: 2, y: 2, width: 236, height: 340, rx: 16, fill: T.bg, stroke: T.edge, 'stroke-width': 3, 'stroke-dasharray': T.dash || 'none' }));
  svg.appendChild(text(20, 34, 'Concept card', Object.assign({ 'font-size': 13, 'font-weight': 700 }, face)));
  svg.appendChild(text(220, 34, CHALLENGE_NAME[cid], Object.assign({ 'font-size': 13, 'text-anchor': 'end' }, face)));
  svg.appendChild(phaseMotif(tier, 120, 112));
  svg.appendChild(text(120, 196, 'Rail, scored left to right', Object.assign({}, face, { 'font-size': 10.5, 'text-anchor': 'middle', fill: MUTED })));
  rail.forEach((id, i) => {
    const x = 22 + i * 39.5;
    const glyph = jokerGlyph(id);
    glyph.setAttribute('x', x);
    glyph.setAttribute('y', 204);
    glyph.setAttribute('width', 38);
    glyph.setAttribute('height', 38);
    svg.appendChild(glyph);
    svg.appendChild(text(x + 19, 254, JOKER_NAME[id], Object.assign({}, face, { 'font-size': 8, 'text-anchor': 'middle' })));
  });
  svg.appendChild(text(120, 282, total.toLocaleString('en-US') + ' points', Object.assign({}, face, { 'font-size': 22, 'font-weight': 700, 'text-anchor': 'middle' })));
  svg.appendChild(text(120, 300, `Deal #${seed} · Coupling ${COUPLING[k]}`, Object.assign({}, face, { 'font-size': 10.5, 'text-anchor': 'middle', fill: MUTED })));
  if (line) svg.appendChild(text(120, 312, `Line ${line}`, Object.assign({}, face, { 'font-size': 10.5, 'text-anchor': 'middle', fill: MUTED })));
  svg.appendChild(node('rect', { x: 50, y: 320, width: 140, height: 18, rx: 9, fill: T.ribbon }));
  svg.appendChild(text(120, 333, T.label, { 'font-size': 11.5, 'font-weight': 700, 'text-anchor': 'middle', fill: T.rInk, 'font-family': face['font-family'] }));
  return svg;
}
