// Regenerates site-src/dev/archive.sample.json (its `kaizen` teaser comes from kaizen.sample.json): 21 fake days with generated SVG
// thumbnails (data URIs), every purpose, intros and concepts, so the gallery can be previewed with no project files.
// Usage: node site-src/dev/make-sample.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashStr, mulberry32, dayNumber, addDays } from '../../scripts/lib/common.mjs';
import { normalizeKaizen, kaizenTeaser } from '../../scripts/lib/archive.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const START = '2026-10-09';
const MISSING = ['2026-10-14', '2026-10-23'];

// [date, title, tagline, description, category, mechanic, tone[], tech[], tags[], tier]
const ROWS = [
  ['2026-10-09', 'Pocket Rockets Range Atlas', 'A 13x13 preflop grid you can paint, then stress-test against a solver.', 'Paint opening ranges by position, then let a tiny equity engine tell you which hands you are overfolding. Ships with five bundled spots.', 'cards-odds', 'solver', ['analytical', 'nerdy'], ['canvas2d', 'worker'], ['poker', 'gto', 'ranges', 'preflop'], 1],
  ['2026-10-10', 'Glass Tempo', 'Shift-by-shift line changes, where fatigue is the real opponent.', 'A hockey bench simulator. Juggle three lines through a 60-minute game and watch tempo, fatigue and momentum trade places.', 'hockey-sports', 'simulator', ['competitive', 'dramatic'], ['svg', 'dom-ui'], ['hockey', 'simulation', 'lines', 'tempo'], 1],
  ['2026-10-11', 'Joker Fold', 'Design a scoring joker, watch the chain reaction, break the game politely.', 'A mod-concept editor for a deckbuilder: compose triggers and effects, then run 1,000 seeded hands to see whether your joker is a delight or a crime.', 'modding-games', 'editor', ['nerdy', 'playful'], ['dom-ui', 'worker'], ['balatro-style', 'mods', 'scoring', 'design'], 1],
  ['2026-10-12', 'Thread Weather', 'The mood of a comment thread, drawn as a weather map.', 'Paste a thread, get a forecast: pressure fronts for arguments, sunshine for compliments, and a small hurricane for the word "actually".', 'pop-culture', 'visualizer', ['playful', 'satirical'], ['canvas2d'], ['reddit', 'sentiment', 'weather', 'threads'], 1],
  ['2026-10-13', 'The Committee of Pigeons', 'Run a city council made entirely of pigeons. Motions pass by seed.', 'A bureaucratic farce with real procedure: agendas, points of order, and a bread subsidy that must be balanced against the park budget.', 'humor-satire', 'game', ['absurd', 'playful'], ['dom-ui', 'localstorage'], ['pigeons', 'council', 'satire', 'sim'], 1],
  ['2026-10-15', 'Tidepool Clocks', 'A tiny ecosystem that keeps time by the moon.', 'Anemones, crabs and one smug starfish respond to a lunar tide table. Drag the moon to fast-forward a season and see who survives.', 'science-sim', 'simulator', ['serene', 'cozy'], ['canvas2d', 'web-animations'], ['tides', 'ecology', 'moon', 'cozy'], 1],
  ['2026-10-16', 'Ideas Day: Ten Pitches, No Build', 'Today the build slipped, so here are the ten ideas that almost were.', 'A stand-in edition. The shortlist for the day, with sources and scores, and a note on the idea that should have shipped.', 'tools-utility', 'explorer', ['analytical'], ['dom-ui'], ['ideas', 'shortlist', 'research'], 3],
  ['2026-10-17', 'Tangled Tangrams', 'Seven shapes, one silhouette, and a solver that sighs.', 'Drag, rotate and flip the classic seven pieces to fill daily silhouettes. A backtracking solver reveals one piece at a time if you ask nicely.', 'math-puzzle', 'puzzle', ['cozy', 'nerdy'], ['svg', 'pointer-events'], ['tangram', 'geometry', 'puzzle', 'solver'], 1],
  ['2026-10-18', 'Basement Orchestra', 'Eleven synthetic instruments, one cursed room, zero rehearsal.', 'A pointer-driven ensemble: each instrument is a few lines of WebAudio, tuned by the room you draw around them.', 'music-audio', 'instrument', ['dramatic', 'chaotic'], ['webaudio', 'procedural-audio'], ['music', 'synth', 'ensemble', 'room'], 1],
  ['2026-10-19', 'Moire Garden', 'Two lattices, one slider, endless flowers.', 'A compact build: overlay rotating line gratings and harvest the interference patterns as wallpapers.', 'generative-art', 'toy', ['serene'], ['canvas2d', 'shaders'], ['moire', 'patterns', 'wallpaper'], 2],
  ['2026-10-20', 'Pun Foundry', 'Feed it a word, receive an unreasonable number of puns.', 'A phoneme-aware wordplay engine with a groan meter. Bundled pronunciation data, no network, many regrets.', 'language-text', 'generator', ['playful', 'absurd'], ['dom-ui', 'worker'], ['puns', 'wordplay', 'phonemes', 'groans'], 1],
  ['2026-10-21', 'Postcard from the 21st', 'No build today. Here is a sky instead.', 'A stand-in edition: a generative postcard made from nothing but the date. Same date, same sky, every time.', 'generative-art', 'generator', ['serene'], ['canvas2d'], ['postcard', 'generative', 'date-seed'], 4],
  ['2026-10-22', 'Receipt Roulette', 'Split any bill fairly, or dramatically.', 'Paste a receipt, pick a mood, and settle the tab with fair shares, weighted dice, or a tiny round of poker for the appetizers.', 'personal-finance', 'calculator', ['playful', 'competitive'], ['dom-ui', 'localstorage'], ['bills', 'split', 'dice', 'utility'], 1],
  ['2026-10-24', 'Gravel Rally', 'A one-thumb rally game with tire physics you can feel.', 'Top-down gravel racing with weight transfer, handbrake slides and five hand-drawn stages. Keyboard, touch and gamepad.', 'games-arcade', 'game', ['competitive', 'chaotic'], ['canvas2d', 'gamepad'], ['racing', 'arcade', 'physics', 'rally'], 1],
  ['2026-10-25', 'Green Phosphor Terminal', 'A 1980s mainframe that only runs text adventures about its own uptime.', 'A faithful-feeling terminal emulator with a scanline shader, a fake filesystem and a game hidden in the man pages.', 'retro-tech', 'story', ['nerdy', 'cozy'], ['canvas2d', 'shaders'], ['terminal', 'retro', 'adventure', 'crt'], 1],
  ['2026-10-26', 'How Compound Interest Lies', 'A calm explainer about why the last decade is worth more than the first three.', 'Interactive curves that show exactly where intuition fails: slide the rate, the time and the fees. Simulated money only.', 'math-concepts', 'lesson', ['analytical', 'serene'], ['svg', 'dom-ui'], ['interest', 'exponential', 'explainer', 'fees'], 1],
  ['2026-10-27', 'Ruin Odds', 'How long does a bankroll last? Simulate ten thousand lifetimes.', 'A risk-of-ruin visualizer for made-up money: pick a win rate and a bet size and watch the fan of possible futures.', 'stats-literacy', 'lesson', ['analytical', 'dramatic'], ['canvas2d', 'worker'], ['risk', 'probability', 'bankroll', 'monte-carlo'], 1],
  ['2026-10-28', 'Pantry Chess', 'Plan a week of dinners from what is already in the cupboard.', 'Tell it what you have; it searches for a week of meals that uses it all before it expires, and explains each trade-off.', 'life-food-craft', 'solver', ['cozy', 'analytical'], ['dom-ui', 'localstorage'], ['cooking', 'planning', 'pantry', 'solver'], 1],
  ['2026-10-29', 'Headline Bingo, Satire Edition', 'A playful, clearly fictional bingo card for every news cycle.', 'Generates absurd, obviously invented headlines and lets you mark them off. Parody only, no real names, never partisan.', 'news-politics', 'game', ['satirical', 'playful'], ['dom-ui'], ['bingo', 'satire', 'headlines', 'fiction'], 1],
  ['2026-10-30', 'The Unbuttoned Page', 'A web page that politely refuses to behave.', 'Every control on this page does something adjacent to what it says. A study in expectation, with a secret ending.', 'weird-experimental', 'toy', ['chaotic', 'absurd'], ['dom-ui', 'pointer-events'], ['weird', 'ui', 'expectation', 'secret'], 1],
  ['2026-10-31', 'Eleven Years of Overtime', 'A scrolling data essay about the sudden-death minutes that decide seasons.', 'Bundled game data, one long scroll, and a handful of annotated charts about how overtime actually ends.', 'data-viz', 'visualizer', ['analytical', 'dramatic'], ['svg', 'canvas2d'], ['hockey', 'overtime', 'charts', 'data-essay'], 1],
];

// What each day is for (ops/taxonomy.json purposes), its intro and concepts. Day 1 stands for a page from before the
// page contract (no purpose, no intro); the stand-ins (tiers 3 and 4) never have one.
const PURPOSE = {
  '2026-10-10': 'play', '2026-10-11': 'studio', '2026-10-12': 'play', '2026-10-13': 'play', '2026-10-15': 'explorer', '2026-10-17': 'play',
  '2026-10-18': 'studio', '2026-10-19': 'studio', '2026-10-20': 'play', '2026-10-22': 'tool', '2026-10-24': 'play', '2026-10-25': 'play',
  '2026-10-26': 'lesson', '2026-10-27': 'lesson', '2026-10-28': 'tool', '2026-10-29': 'play', '2026-10-30': 'play', '2026-10-31': 'explorer',
};
const INTRO = {
  '2026-10-31': 'An explorer of eleven seasons of hockey overtime: every sudden-death goal on one long, scrolling page. It is for fans who wonder how overtime really ends. Scroll down to read the story, or tap any dot in a chart to see the game it stands for and the minute the goal came.',
  '2026-10-28': 'A planner that turns what is already in your cupboard into a week of dinners, using everything before it goes off. It is for anyone who hates throwing food away. Tick what you have; the plan and a short shopping list appear at once, and each swap says why.',
  '2026-10-27': 'A lesson on the risk of ruin: how likely a pot of pretend money is to run out, even when every bet is in your favour. It is for anyone who has wondered why gamblers go broke. Pick a win rate and a bet size, then watch a thousand futures fan out.',
  '2026-10-26': 'A lesson on compound growth: why money that grows by a steady percentage gains most of its value in the last years, not the first. It is for anyone saving for something far away. Slide the rate and the years and watch where the curve bends, with simulated money only.',
  '2026-10-22': 'A calculator that splits a restaurant bill between friends, fairly by what each person ordered or evenly with tax and tip shared. It is for anyone who has done this sum on a napkin. Paste or type the receipt, tick who had what, and copy the result to the group chat.',
  '2026-10-15': 'An explorer of a small rock pool that keeps time by the moon: anemones, crabs and a starfish react to a real tide table. It is for curious people of any age. Drag the moon to fast-forward a season and see which creatures cope with the tides and which do not.',
  '2026-10-10': 'A hockey bench game: you are the coach, and you decide when each of three lines goes on the ice during one game. It is for hockey fans and for anyone who likes a quick tactics puzzle. Press Start, then tap a line to change it before the players get too tired.',
};
const CONCEPTS = {
  '2026-10-31': ['sudden death', 'overtime'], '2026-10-27': ['risk of ruin', 'expected value'], '2026-10-26': ['compound growth', 'exponential curve'],
  '2026-10-22': ['bill splitting'], '2026-10-15': ['tides', 'lunar cycle'],
};

function hex(h, s, l) {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function paletteFor(i) {
  const hue = (i * 47 + 12) % 360;
  const light = i % 4 === 3;
  return light
    ? [hex(hue, 55, 90), hex((hue + 20) % 360, 80, 52), hex((hue + 180) % 360, 70, 38)]
    : [hex(hue, 45, 14), hex(hue, 85, 60), hex((hue + 45) % 360, 90, 70)];
}

function motif(kind, rnd, [bg, a, b]) {
  const out = [];
  const W = 1200, H = 630;
  switch (kind % 6) {
    case 0:
      for (let i = 0; i < 9; i++) out.push(`<circle cx='${Math.round(rnd() * W)}' cy='${Math.round(rnd() * H)}' r='${40 + Math.round(rnd() * 160)}' fill='none' stroke='${i % 2 ? a : b}' stroke-width='${6 + Math.round(rnd() * 18)}'/>`);
      break;
    case 1:
      for (let i = 0; i < 14; i++) out.push(`<rect x='${i * 90 - 40}' y='-20' width='46' height='700' fill='${i % 3 ? a : b}' opacity='.${6 + (i % 4)}' transform='rotate(18 600 315)'/>`);
      break;
    case 2:
      for (let i = 0; i < 6; i++) out.push(`<path d='M0 ${200 + i * 70} Q 300 ${100 + i * 60 + Math.round(rnd() * 100)} 600 ${220 + i * 60} T 1200 ${200 + i * 70} V 700 H 0Z' fill='${i % 2 ? a : b}' opacity='.${3 + (i % 5)}'/>`);
      break;
    case 3:
      for (let y = 0; y < 8; y++) for (let x = 0; x < 15; x++) if (rnd() > 0.35) out.push(`<circle cx='${40 + x * 80}' cy='${40 + y * 80}' r='${6 + Math.round(rnd() * 26)}' fill='${(x + y) % 2 ? a : b}'/>`);
      break;
    case 4:
      out.push(`<circle cx='${380 + Math.round(rnd() * 440)}' cy='330' r='230' fill='${a}'/>`, `<circle cx='${380 + Math.round(rnd() * 440)}' cy='290' r='120' fill='${b}'/>`);
      for (let i = 0; i < 5; i++) out.push(`<rect x='0' y='${430 + i * 40}' width='1200' height='${14 - i * 2}' fill='${bg}' opacity='.8'/>`);
      break;
    default:
      for (let i = 0; i < 7; i++) out.push(`<path d='M${Math.round(rnd() * W)} 640 l${-200 - Math.round(rnd() * 200)} -${200 + Math.round(rnd() * 330)} l${220 + Math.round(rnd() * 160)} 0z' fill='${i % 2 ? a : b}' opacity='.85'/>`);
  }
  return out.join('');
}

function thumb(date, palette, i) {
  const rnd = mulberry32(hashStr(date));
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 630'><rect width='1200' height='630' fill='${palette[0]}'/>${motif(i, rnd, palette)}</svg>`;
  return 'data:image/svg+xml,' + svg.replace(/</g, '%3C').replace(/>/g, '%3E').replace(/#/g, '%23');
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40).replace(/-$/, '');
}

const days = ROWS.map(([date, title, tagline, description, category, mechanic, tone, tech, tags, tier], i) => {
  const slug = slugify(title);
  const palette = paletteFor(i);
  return {
    n: dayNumber(date, START), date, slug, path: `d/${date}-${slug}/`, title, tagline, description, tier,
    category, mechanic, tone, tech, tags, palette, thumb: thumb(date, palette, i),
    purpose: PURPOSE[date] ?? '', intro: INTRO[date] ?? '', concepts: CONCEPTS[date] ?? [],
  };
}).sort((x, y) => (x.date < y.date ? 1 : -1));

let streak = 0;
for (let d = days[0].date; days.some((x) => x.date === d); d = addDays(d, -1)) streak++;

const categories = {};
for (const d of days) categories[d.category] = (categories[d.category] || 0) + 1;
const purposes = {};
for (const p of ['tool', 'lesson', 'explorer', 'studio', 'play']) {
  const n = days.filter((d) => d.purpose === p).length;
  if (n) purposes[p] = n;
}

const archive = {
  schema: 1,
  generatedAt: '2026-10-31T09:12:44.000Z',
  site: {
    name: 'Sonnet Every Day',
    tagline: 'A new tool, lesson, explorable or game every day, built by a team of Sonnet agents.',
    url: 'https://example.invalid/sonnet-every-day/',
    startDate: START,
  },
  stats: {
    days: days.length, projects: days.length, streak, categories, purposes,
    firstDate: days[days.length - 1].date, lastDate: days[0].date, missingDates: MISSING,
  },
  kaizen: kaizenTeaser(normalizeKaizen(JSON.parse(fs.readFileSync(path.join(HERE, 'kaizen.sample.json'), 'utf8'))).entries),
  days,
};

fs.writeFileSync(path.join(HERE, 'archive.sample.json'), JSON.stringify(archive, null, 1) + '\n');
console.log(`wrote ${days.length} days, ${Object.keys(categories).length} categories, streak ${streak}`);
