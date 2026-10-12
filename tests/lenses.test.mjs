// Tests for scripts/lenses.mjs and ops/lenses.json: pool quality, determinism, daily constraints under the purpose plan, long-run variety.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  assignLenses, loadLensPool, lensNeed, AGENTS, KINDS,
} from '../scripts/lenses.mjs';
import { addDays } from '../scripts/lib/common.mjs';
import { makeSandbox, REAL_ROOT } from './fixtures/gate-helpers.mjs';

const LENSES_CLI = path.join(REAL_ROOT, 'scripts', 'lenses.mjs');
// Kinds every day has at least one lens of; humor joins them only on days when play is allowed.
const ALWAYS = ['interest', 'current', 'wildcard', 'useful', 'teach'];
const MAIN = ['interest', 'current', 'humor', 'wildcard', 'useful', 'teach'];
const SLOT_OF_KIND = { interest: 'interest', current: 'currentEvents', humor: 'humor', wildcard: 'wildcard' };
const START = '2026-10-09';
const CAP = { interest: 2, current: 2, humor: 2, wildcard: 3, craft: 1, useful: 3, teach: 3 };
const PURPOSES = ['tool', 'lesson', 'explorer', 'studio', 'play'];

const poolFile = JSON.parse(fs.readFileSync(path.join(REAL_ROOT, 'ops', 'lenses.json'), 'utf8'));
const sentencesOf = (brief) => brief.split(/(?<=[.!?])\s+/).filter(Boolean);
const kindCounts = (day) => {
  const counts = Object.fromEntries(KINDS.map((k) => [k, 0]));
  for (const a of day.agents) counts[a.lens.kind]++;
  return counts;
};
const plan = (over = {}) => ({ wanted: ['tool', 'lesson'], avoid: [], playAllowed: true, ...over });

test('pool: size, ids, kinds and required lenses', () => {
  const { lenses } = poolFile;
  assert.deepEqual(KINDS, ['interest', 'current', 'humor', 'wildcard', 'craft', 'useful', 'teach'], 'new kinds are appended, the order is fixed');
  assert.ok(lenses.length >= 90, `${lenses.length} lenses`);
  assert.equal(new Set(lenses.map((l) => l.id)).size, lenses.length, 'ids are unique');
  for (const l of lenses) {
    assert.match(l.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(KINDS.includes(l.kind), `${l.id}: kind ${l.kind}`);
    assert.ok(l.name.length >= 6 && l.name.length <= 48, `${l.id}: name`);
  }
  const required = ['hockey-now', 'poker-ranges', 'balatro-mod-ideas', 'reddit-hot-threads', 'hn-front-page', 'pop-culture-pulse', 'absurdist-interactive', 'science-sim', 'music-instrument', 'generative-art', 'retro-computing', 'tiny-tools', 'word-play', 'game-design-experiment', 'data-story', 'weird-web'];
  for (const id of required) assert.ok(lenses.some((l) => l.id === id), `missing required lens ${id}`);
  const byKind = (k) => lenses.filter((l) => l.kind === k).length;
  for (const k of MAIN) assert.ok(byKind(k) >= 8, `kind ${k} has only ${byKind(k)} lenses`);
  assert.ok(byKind('useful') >= 18, `useful: ${byKind('useful')}`);
  assert.ok(byKind('teach') >= 18, `teach: ${byKind('teach')}`);
  assert.ok(byKind('wildcard') >= 24, `wildcard: ${byKind('wildcard')} (18 before the purpose mix, at least 6 studio and explorer sources added)`);
  assert.ok(byKind('craft') >= 3);
  for (const k of KINDS) assert.ok(typeof poolFile.kinds[k] === 'string' && poolFile.kinds[k].length >= 40, `kinds.${k} is described`);
  assert.match(poolFile.kinds.humor, /only on days when play is allowed/);
});

test('pool: briefs are vivid, sourced and cover the interests the owner cares about', () => {
  for (const l of poolFile.lenses) {
    // useful and teach briefs carry more (the gated products, the oracle and the limits; the concept, misconception and aha)
    const long = l.kind === 'useful' || l.kind === 'teach';
    const sentences = sentencesOf(l.brief);
    assert.ok(sentences.length >= 2 && sentences.length <= (long ? 6 : 4), `${l.id}: ${sentences.length} sentences`);
    assert.ok(l.brief.length >= 160 && l.brief.length <= (long ? 800 : 520), `${l.id}: brief length ${l.brief.length}`);
    assert.ok(Array.isArray(l.sourceHints) && l.sourceHints.length >= 3 && l.sourceHints.length <= 6, `${l.id}: hints`);
    for (const h of l.sourceHints) assert.ok(typeof h === 'string' && h.length >= 8, `${l.id}: hint ${h}`);
    assert.ok(!/TODO|lorem|placeholder/i.test(JSON.stringify(l)), l.id);
  }
  const ids = poolFile.lenses.map((l) => l.id);
  assert.ok(ids.filter((i) => i.startsWith('hockey-')).length >= 3, 'several hockey angles');
  assert.ok(ids.filter((i) => i.startsWith('poker-')).length >= 3, 'several poker angles');
  assert.ok(ids.filter((i) => i.startsWith('balatro-')).length >= 2, 'several Balatro angles');
  assert.ok(ids.filter((i) => i.includes('reddit')).length >= 2, 'Reddit-born ideas');
  assert.ok(ids.filter((i) => i.startsWith('anti-lens')).length >= 2, 'anti-lens wildcards');
  const text = JSON.stringify(poolFile.lenses).toLowerCase();
  for (const needle of ['icm', 'gto', 'joker', 'score', 'wikipedia', 'arxiv', 'github trending', 'hacker news', 'itch.io', 'are.na', 'nhl', 'on this day', 'current events']) {
    assert.ok(text.includes(needle), `no lens mentions ${needle}`);
  }
  for (const sub of ['r/balatro', 'r/hockey', 'r/poker', 'r/internetisbeautiful', 'r/dataisbeautiful', 'r/webdev', 'r/gamedev', 'r/mappor', 'r/damnthatsinteresting']) {
    assert.ok(text.includes(sub), `no source hint mentions ${sub}`);
  }
  const themes = [/music|instrument|audio/, /retro|vintage|beige/, /food|kitchen|cook/, /language|linguist|word/, /math/, /science|physics|lab bench/, /tool/, /weird/];
  for (const re of themes) assert.ok(poolFile.lenses.some((l) => re.test(`${l.id} ${l.name} ${l.brief}`.toLowerCase())), `no lens for ${re}`);
});

test('pool: useful and teach briefs carry what DESIGN 4a asks for, spread over many fields', () => {
  const useful = poolFile.lenses.filter((l) => l.kind === 'useful');
  const teach = poolFile.lenses.filter((l) => l.kind === 'teach');
  for (const l of useful) {
    // what is gated, the oracle, the limits to print; a search hint the scouts can use to verify the paywall claim
    // the gate, in the words of DESIGN 4a (account, upload, paid tier, watermark, caps, hidden results, licence, ads)
    assert.match(l.brief, /behind|paid|charge|subscription|upload|account|licen[cs]e|\bads?\b|ad-|watermark|tier|sign-up|contact details|\block|\bcap\b|hide/i, `${l.id}: what the paid products gate`);
    assert.match(l.brief, /oracle|check|against/i, `${l.id}: how correctness is checked`);
    assert.match(l.brief, /Print the limits/, `${l.id}: the limits to print`);
    assert.ok(l.sourceHints.some((h) => /"[^"]{6,}"/.test(h)), `${l.id}: a quoted search to verify the gap`);
    assert.doesNotMatch(l.brief, /\$\d|\d+ ?(USD|EUR|dollars|euros|per month|\/month)/i, `${l.id}: no pricing facts about vendors`);
  }
  for (const l of teach) {
    assert.match(l.brief, /misconception/i, `${l.id}: the misconception to bust`);
    assert.match(l.brief, /\baha\b/i, `${l.id}: the aha moment`);
    assert.match(l.brief, /Let the visitor/, `${l.id}: the interactive that fixes the usual explanation`);
    assert.match(l.brief, /\bfor\b[^.]*\.$/, `${l.id}: who it is for, at the end`);
  }
  // spread: the fields of DESIGN 4a each have a lens
  const has = (list, re) => list.some((l) => re.test(`${l.id} ${l.name} ${l.brief}`));
  for (const re of [/regex/i, /JSON|CSV/, /cron/i, /subnet|CIDR/i, /contrast/i, /image/i, /PDF/, /chord|scale/i, /tuner|metronome/i, /depth of field/i, /sunrise|golden hour/i, /resistor/i, /beam/i, /molar|stoichiometr|balanc/i, /amortization|loan/i, /time zone/i, /spaced repetition/i, /kana|IPA/i, /readability|citation/i, /SHA-256|hash/i]) {
    assert.ok(has(useful, re), `no useful lens for ${re}`);
  }
  for (const re of [/Bloom/, /Raft|CRDT/, /LSM/, /Huffman/, /consistent hashing/i, /unification|type inference|Algorithm W/i, /eigen/i, /Fourier/, /Bayes/, /group theory|wallpaper/i, /knot/i, /p-adic/i, /Lagrangian|phase space/i, /black-body/i, /Le Chatelier/, /Simpson/, /comparative advantage|auction/i, /Hardy-Weinberg|Lotka-Volterra/, /temperament|harmonic series/i, /ergative|phonotactics/i, /projection/i, /kerning|typograph/i, /Diffie-Hellman|hash/i, /PID|control/i]) {
    assert.ok(has(teach, re), `no teach lens for ${re}`);
  }
  // the wildcard additions: studio and explorer sources
  const ids = poolFile.lenses.filter((l) => l.kind === 'wildcard').map((l) => l.id);
  assert.ok(ids.filter((i) => i.startsWith('studio-')).length >= 4, 'studio sources');
  assert.ok(ids.filter((i) => i.startsWith('explore-')).length >= 2, 'explorer sources');
  // briefs differ from each other (no copy-paste): no two share a sentence
  const seen = new Map();
  for (const l of [...useful, ...teach]) {
    for (const s of sentencesOf(l.brief)) {
      assert.ok(!seen.has(s), `${l.id} repeats a sentence of ${seen.get(s)}: ${s}`);
      seen.set(s, l.id);
    }
  }
});

test('pool: provocation words', () => {
  const words = poolFile.provocationWords;
  assert.ok(words.length >= 240, `${words.length} words`);
  assert.equal(new Set(words).size, words.length, 'words are unique');
  for (const w of words) assert.match(w, /^[a-z]{2,16}$/, w);
  const brands = ['google', 'apple', 'amazon', 'microsoft', 'facebook', 'meta', 'twitter', 'netflix', 'nike', 'coca', 'pepsi', 'disney', 'nintendo', 'sony', 'tesla', 'uber', 'zamboni', 'kindle', 'velcro', 'xerox', 'jacuzzi', 'frisbee', 'sprite', 'thermos', 'teletype', 'lego', 'oreo', 'tupperware', 'photoshop'];
  for (const b of brands) assert.ok(!words.includes(b), `brand-like word ${b}`);
});

test('loadLensPool validates the file it reads', () => {
  const box = makeSandbox();
  try {
    const write = (mutate) => {
      const p = JSON.parse(JSON.stringify(poolFile));
      mutate(p);
      box.write('ops/lenses.json', p);
    };
    assert.equal(loadLensPool().lenses.length, poolFile.lenses.length);
    write((p) => { p.lenses[1].id = p.lenses[0].id; });
    assert.throws(() => loadLensPool(), /duplicate lens id/);
    write((p) => { p.lenses[0].kind = 'bogus'; });
    assert.throws(() => loadLensPool(), /unknown kind/);
    write((p) => { delete p.lenses[0].brief; });
    assert.throws(() => loadLensPool(), /malformed lens/);
    write((p) => { p.lenses = p.lenses.slice(0, 10); });
    assert.throws(() => loadLensPool(), /at least/);
    for (const k of ['humor', 'useful', 'teach']) {
      write((p) => { p.lenses = p.lenses.filter((l) => l.kind !== k || p.lenses.filter((x) => x.kind === k).indexOf(l) < 2); });
      assert.throws(() => loadLensPool(), new RegExp(`kind ${k}`));
    }
    write((p) => { p.provocationWords = ['one', 'two']; });
    assert.throws(() => loadLensPool(), /provocation/);
    box.write('ops/lenses.json', '{nope');
    assert.throws(() => loadLensPool(), /readJson/);
  } finally {
    box.cleanup();
  }
});

/* ---- the counts of one day ------------------------------------------------------------------------- */

test('need: one lens of each kind that is always there, humor only when play is allowed, DEMAND for the wanted purposes', () => {
  assert.deepEqual(lensNeed(plan({ wanted: [], playAllowed: true })), { interest: 1, current: 1, humor: 1, wildcard: 1, craft: 0, useful: 1, teach: 1 });
  assert.deepEqual(lensNeed(plan({ wanted: [], playAllowed: false })), { interest: 1, current: 1, humor: 0, wildcard: 1, craft: 0, useful: 1, teach: 1 });
  assert.deepEqual(lensNeed(plan({ wanted: ['tool', 'lesson'], playAllowed: false })), { interest: 1, current: 1, humor: 0, wildcard: 1, craft: 0, useful: 2, teach: 2 });
  assert.deepEqual(lensNeed(plan({ wanted: ['explorer', 'studio'] })), { interest: 1, current: 1, humor: 1, wildcard: 2, craft: 0, useful: 1, teach: 1 });
  assert.deepEqual(lensNeed(plan({ wanted: ['play'], playAllowed: true })), { interest: 2, current: 1, humor: 1, wildcard: 1, craft: 0, useful: 1, teach: 1 });
  // no plan (a config without mix.purposes): one of each main kind, humor included
  assert.deepEqual(lensNeed(null), { interest: 1, current: 1, humor: 1, wildcard: 1, craft: 0, useful: 1, teach: 1 });
  // every ordered pair of wanted purposes and every override, with play allowed or not
  const combos = [];
  for (const a of PURPOSES) for (const b of PURPOSES) if (a !== b && a !== 'play' && b !== 'play') combos.push([a, b]);
  for (const p of PURPOSES) combos.push([p]);
  for (const wanted of combos) {
    for (const playAllowed of [true, false]) {
      const need = lensNeed(plan({ wanted, playAllowed }));
      const total = Object.values(need).reduce((s, n) => s + n, 0);
      assert.ok(total <= 8, `${wanted} ${playAllowed}: ${total}`);
      for (const k of KINDS) assert.ok(need[k] <= CAP[k], `${wanted}: ${k} over its cap`);
      for (const k of ALWAYS) assert.ok(need[k] >= 1, `${wanted}: ${k}`);
      assert.equal(need.humor > 0, playAllowed, `${wanted}: humor ${need.humor} with playAllowed ${playAllowed}`);
      const demand = { tool: { useful: 2 }, lesson: { teach: 2 }, explorer: { teach: 1, wildcard: 2 }, studio: { wildcard: 2 }, play: { interest: 2 } };
      for (const w of wanted) for (const [k, n] of Object.entries(demand[w])) assert.ok(need[k] >= n, `${wanted}: ${w} wants ${n} ${k}`);
    }
  }
  // more than two wanted purposes would ask for 9: the kinds nobody asked for are trimmed (humor first), never below 1 for the others
  const three = lensNeed(plan({ wanted: ['tool', 'lesson', 'explorer'], playAllowed: true }));
  assert.deepEqual(three, { interest: 1, current: 1, humor: 0, wildcard: 2, craft: 0, useful: 2, teach: 2 });
  const four = lensNeed(plan({ wanted: ['tool', 'lesson', 'explorer', 'studio', 'play'], playAllowed: true }));
  assert.equal(Object.values(four).reduce((s, n) => s + n, 0), 8);
  for (const k of ALWAYS) assert.ok(four[k] >= 1);
});

function oneDay(date, opts) {
  return assignLenses({ date, ...opts });
}

function assertDayShape(day) {
  assert.deepEqual(day.agents.map((a) => a.agent), AGENTS);
  assert.deepEqual(AGENTS, ['pulse', 'cards', 'lab', 'jester', 'architect', 'artisan', 'engineer', 'critic']);
  const counts = kindCounts(day);
  for (const k of ALWAYS) assert.ok(counts[k] >= 1, `${day.date}: no ${k} lens in ${JSON.stringify(counts)}`);
  const playAllowed = day.purposes ? day.purposes.playAllowed !== false : true;
  assert.equal(counts.humor > 0, playAllowed, `${day.date}: humor ${counts.humor} while playAllowed is ${playAllowed}`);
  for (const k of KINDS) assert.ok(counts[k] <= CAP[k], `${day.date}: ${counts[k]} ${k} lenses`);
  assert.equal(new Set(day.agents.map((a) => a.lens.id)).size, 8, `${day.date}: lens ids repeat`);
  for (const a of day.agents) {
    assert.deepEqual(Object.keys(a.lens).sort(), ['brief', 'id', 'kind', 'name', 'sourceHints']);
    assert.equal(a.provocation.length, 3);
  }
  const words = day.agents.flatMap((a) => a.provocation);
  assert.equal(new Set(words).size, 24, 'provocation words are all distinct');
  for (const w of words) assert.ok(poolFile.provocationWords.includes(w));
  // every lens the plan asks for is there
  const need = lensNeed(day.purposes);
  for (const k of KINDS) assert.ok(counts[k] >= need[k], `${day.date}: ${k} ${counts[k]} < need ${need[k]}`);
}

test('a day has 8 agents, the lenses the plan asks for, distinct lenses and words (empty history: tool and lesson wanted, play allowed)', () => {
  const box = makeSandbox();
  try {
    for (let i = 0; i < 40; i++) {
      const day = oneDay(addDays(START, i));
      assertDayShape(day);
      assert.deepEqual([day.purposes.wanted, day.purposes.playAllowed], [['tool', 'lesson'], true]);
      assert.deepEqual(kindCounts(day), { interest: 1, current: 1, humor: 1, wildcard: 1, craft: 0, useful: 2, teach: 2 }, 'the need already fills the 8');
    }
  } finally {
    box.cleanup();
  }
});

test('affinity: pulse current, cards interest, lab wildcard, engineer useful, architect teach every day; jester humor exactly when play is allowed', () => {
  const box = makeSandbox();
  try {
    const sim = simulate(box, 40);
    let blocked = 0;
    for (const d of sim) {
      const k = Object.fromEntries(d.agents.map((a) => [a.agent, a.lens.kind]));
      assert.equal(k.pulse, 'current');
      assert.equal(k.cards, 'interest');
      assert.equal(k.lab, 'wildcard');
      assert.equal(k.engineer, 'useful');
      assert.equal(k.architect, 'teach');
      assert.equal(k.jester === 'humor', d.purposes.playAllowed, `${d.date}: jester ${k.jester}, playAllowed ${d.purposes.playAllowed}`);
      if (!d.purposes.playAllowed) blocked++;
    }
    assert.ok(blocked >= 5 && blocked <= 35, `the simulation has days with and without play (${blocked} blocked)`);
  } finally {
    box.cleanup();
  }
});

test('determinism: same date gives identical output, other dates differ', () => {
  const box = makeSandbox();
  try {
    const a = oneDay('2026-12-25');
    const b = oneDay('2026-12-25');
    assert.deepEqual(a, b);
    process.env.SED_NOW = '2030-01-01T00:00:00Z';
    try {
      assert.deepEqual(oneDay('2026-12-25'), a, 'the clock does not matter');
    } finally {
      delete process.env.SED_NOW;
    }
    const other = oneDay('2026-12-26');
    assert.notDeepEqual(other.agents.map((x) => x.lens.id), a.agents.map((x) => x.lens.id));
    assert.notDeepEqual(other.agents.map((x) => x.provocation), a.agents.map((x) => x.provocation));
  } finally {
    box.cleanup();
  }
});

test('the day\'s own ideas file does not change the answer (reruns are stable)', () => {
  const box = makeSandbox();
  try {
    const before = oneDay('2026-11-01');
    box.write('state/ideas/2026-11-01.json', { schema: 1, date: '2026-11-01', lenses: before.agents.map((a) => ({ agent: a.agent, lensId: a.lens.id })) });
    box.write('state/ideas/2026-11-02.json', { schema: 1, date: '2026-11-02', lenses: before.agents.map((a) => ({ agent: a.agent, lensId: a.lens.id })) });
    assert.deepEqual(oneDay('2026-11-01'), before);
  } finally {
    box.cleanup();
  }
});

test('2026-10-13 on the real first three days: 2 useful, 2 teach, no humor, 8 distinct lenses, identical on a rerun', () => {
  const box = makeSandbox();
  try {
    const real = JSON.parse(fs.readFileSync(path.join(REAL_ROOT, 'state', 'history.json'), 'utf8'));
    const firstThree = real.entries.filter((e) => e.date < '2026-10-13');
    assert.equal(firstThree.length, 3);
    box.write('state/history.json', { schema: 1, startDate: '2026-10-09', entries: firstThree });
    const day = oneDay('2026-10-13');
    assertDayShape(day);
    const counts = kindCounts(day);
    assert.deepEqual([counts.useful, counts.teach, counts.humor], [2, 2, 0]);
    assert.deepEqual([day.purposes.wanted, day.purposes.avoid, day.purposes.playAllowed], [['tool', 'lesson'], ['play'], false]);
    assert.notEqual(day.agents.find((a) => a.agent === 'jester').lens.kind, 'humor');
    assert.deepEqual(oneDay('2026-10-13'), day);
  } finally {
    box.cleanup();
  }
});

function writeIdeas(box, day) {
  box.write(`state/ideas/${day.date}.json`, {
    schema: 1, date: day.date, lenses: day.agents.map((a) => ({ agent: a.agent, lensId: a.lens.id, provocation: a.provocation })),
  });
}

/**
 * Mimic a real run: an ideas file every day, and a history entry most days (slots rotate irregularly) whose purpose follows the
 * day's plan: the first wanted purpose, or play on every 5th day when it is allowed. Without purposes in the history every entry
 * would count as legacy play and block humor almost every day.
 */
function simulate(box, days, { skipHistoryEvery = 5 } = {}) {
  const slots = ['interest', 'currentEvents', 'humor', 'wildcard'];
  const entries = [];
  const save = () => box.write('state/history.json', { schema: 1, startDate: START, entries });
  save();
  const out = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(START, i);
    const day = oneDay(date);
    writeIdeas(box, day);
    out.push(day);
    if (i % skipHistoryEvery !== 4) {
      const purpose = i % 5 === 2 && day.purposes.playAllowed ? 'play' : day.purposes.wanted[0];
      entries.push({
        n: i + 1, date, slug: `s${i}`, title: `t${i}`, tagline: 't', tier: 1, path: `d/${date}-s${i}/`, publishedAt: `${date}T12:00:00Z`, countsForNovelty: true,
        fingerprint: { category: 'science-sim', mechanic: 'simulator', tone: ['playful'], tech: [], tags: [], keywords: [], slot: slots[(i * 7 + Math.floor(i / 3)) % 4], political: false, purpose },
      });
      save();
    }
  }
  return out;
}

test('120 simulated days: daily constraints hold, no repeats within 3 days, owed slots are served when there is room', () => {
  const box = makeSandbox();
  try {
    const sim = simulate(box, 120);
    let served = 0;
    sim.forEach((day, i) => {
      assertDayShape(day);
      assert.equal(day.relaxedDays, 0, `${day.date}: the 3-day window needed relaxing`);
      assert.equal(day.planError, undefined);
      const recent = new Set(sim.slice(Math.max(0, i - 3), i).flatMap((d) => d.agents.map((a) => a.lens.id)));
      for (const a of day.agents) assert.ok(!recent.has(a.lens.id), `${day.date}: ${a.lens.id} repeats within 3 days`);
      // owed slots are best effort after the purpose demand: while the need leaves room, each owed kind in turn gets one more lens
      const need = lensNeed(day.purposes);
      let room = 8 - Object.values(need).reduce((s, n) => s + n, 0);
      const counts = kindCounts(day);
      for (const k of day.owedKinds) {
        if (room <= 0 || (k === 'humor' && !day.purposes.playAllowed) || need[k] >= CAP[k]) continue;
        assert.ok(counts[k] >= need[k] + 1, `${day.date}: owed ${k} with room but only ${counts[k]} lens`);
        room--;
        served++;
      }
    });
    assert.ok(sim.some((d) => d.owedKinds.length > 0), 'the simulation exercises owed slots');
    assert.ok(served >= 10, `owed slots served ${served} times`);
  } finally {
    box.cleanup();
  }
});

test('120 simulated days: every lens is used, tools and lessons lead, craft keeps its floor', () => {
  const box = makeSandbox();
  try {
    const sim = simulate(box, 120);
    const uses = new Map(poolFile.lenses.map((l) => [l.id, []]));
    sim.forEach((day, i) => day.agents.forEach((a) => uses.get(a.lens.id).push(i)));
    const kindOf = new Map(poolFile.lenses.map((l) => [l.id, l.kind]));
    // floors chosen from the simulation (observed in brackets when they were set): every lens outside craft at least once, and at least
    // 4 uses (6) and no wait longer than 70 days (48), usage within a factor 4 (2.5)
    // craft lenses only fill spare slots (about 10 lens-days in 120 across 6 lenses), so each one is not guaranteed a day; their total is checked below
    const nonCraft = [...uses].filter(([id]) => kindOf.get(id) !== 'craft');
    for (const [id, u] of nonCraft) assert.ok(u.length >= 1, `${id} never used in 120 days`);
    for (const [id, u] of nonCraft) {
      assert.ok(u.length >= 4, `${id} used only ${u.length} times in 120 days`);
      const gaps = u.slice(1).map((x, i) => x - u[i]).concat([120 - u[u.length - 1], u[0]]);
      assert.ok(Math.max(...gaps) <= 70, `${id} waits ${Math.max(...gaps)} days between uses`);
    }
    const counts = nonCraft.map(([, u]) => u.length);
    assert.ok(Math.max(...counts) / Math.min(...counts) <= 4, `usage is lopsided: min ${Math.min(...counts)}, max ${Math.max(...counts)}`);
    const perKind = Object.fromEntries(KINDS.map((k) => [k, 0]));
    for (const day of sim) for (const a of day.agents) perKind[a.lens.kind]++;
    for (const k of ALWAYS) assert.ok(perKind[k] >= 120, `${k}: ${perKind[k]} lens-days`);
    assert.ok(perKind.useful >= 150 && perKind.teach >= 150, `tools and lessons lead: useful ${perKind.useful}, teach ${perKind.teach} (184 and 191)`);
    assert.ok(perKind.useful > perKind.interest && perKind.teach > perKind.interest, JSON.stringify(perKind));
    const playDays = sim.filter((d) => d.purposes.playAllowed).length;
    assert.ok(perKind.humor >= playDays, `humor ${perKind.humor} on ${playDays} play days`);
    assert.ok(perKind.interest > perKind.humor, 'interest lenses are favoured over humor ones');
    // craft only gets the spare slots: its floor (10 lens-days when set) keeps it from vanishing
    assert.ok(perKind.craft >= 6, `craft ${perKind.craft}`);
  } finally {
    box.cleanup();
  }
});

test('120 simulated days: each agent sees a wide spread of lenses and kinds', () => {
  const box = makeSandbox();
  try {
    const sim = simulate(box, 120);
    const poolSize = (kind) => poolFile.lenses.filter((l) => l.kind === kind).length;
    const home = { pulse: 'current', cards: 'interest', lab: 'wildcard', engineer: 'useful', architect: 'teach' };
    for (const agent of AGENTS) {
      const ids = new Set(sim.map((d) => d.agents.find((a) => a.agent === agent).lens.id));
      if (home[agent]) assert.ok(ids.size >= poolSize(home[agent]) - 2, `${agent} saw only ${ids.size} of ${poolSize(home[agent])} ${home[agent]} lenses`);
      else assert.ok(ids.size >= 30, `${agent} saw only ${ids.size} distinct lenses`);
    }
    for (const agent of ['artisan', 'critic']) {
      const kinds = new Set(sim.map((d) => d.agents.find((a) => a.agent === agent).lens.kind));
      assert.ok(kinds.size >= 5, `${agent} only saw kinds ${[...kinds]}`);
    }
    const jesterKinds = new Set(sim.map((d) => d.agents.find((a) => a.agent === 'jester').lens.kind));
    assert.ok(jesterKinds.has('humor') && jesterKinds.size >= 3, `jester saw ${[...jesterKinds]}`);
  } finally {
    box.cleanup();
  }
});

test('owed slots are best effort after the purpose demand (explicit plan and owed kinds)', () => {
  const box = makeSandbox();
  try {
    for (let i = 0; i < 10; i++) {
      const date = addDays('2027-02-01', i);
      // play paused and one wanted tool: the need is 7, so the first owed kind gets its second lens
      const roomy = oneDay(date, { plan: plan({ wanted: ['tool'], playAllowed: false }), owedKinds: ['current', 'wildcard'] });
      assertDayShape(roomy);
      assert.ok(kindCounts(roomy).current >= 2, `${date}: owed current`);
      // play paused, nothing wanted: need 5, room for both owed kinds
      const empty = oneDay(date, { plan: plan({ wanted: [], playAllowed: false }), owedKinds: ['interest', 'current', 'humor', 'wildcard'] });
      assertDayShape(empty);
      const c = kindCounts(empty);
      assert.ok(c.interest >= 2 && c.current >= 2 && c.wildcard >= 2, `${date}: ${JSON.stringify(c)}`);
      assert.equal(c.humor, 0, 'an owed humor slot is ignored while play is paused');
      // tool and lesson wanted with play allowed: the need is 8, no room, yet every kind keeps its base lens
      const full = oneDay(date, { plan: plan(), owedKinds: ['current', 'wildcard'] });
      assertDayShape(full);
      assert.deepEqual(kindCounts(full), { interest: 1, current: 1, humor: 1, wildcard: 1, craft: 0, useful: 2, teach: 2 });
    }
  } finally {
    box.cleanup();
  }
});

test('owed slots and the plan come from novelty mix automatically', () => {
  const box = makeSandbox();
  try {
    // Only an interest build two days ago (no purpose: legacy play): current and wildcard are owed, play is paused, tool and lesson wanted.
    const date = '2026-11-10';
    box.write('state/history.json', {
      schema: 1, startDate: START, entries: [{
        n: 30, date: '2026-11-08', slug: 'x', title: 'x', tagline: 't', tier: 1, path: 'd/2026-11-08-x/', publishedAt: '2026-11-08T12:00:00Z', countsForNovelty: true,
        fingerprint: { category: 'cards-odds', mechanic: 'solver', tone: ['playful'], tech: [], tags: [], keywords: [], slot: 'interest', political: false },
      }],
    });
    const day = oneDay(date);
    assert.deepEqual([...day.owedKinds].sort(), ['current', 'wildcard'], 'humor has no weekly minimum any more');
    assert.deepEqual([day.purposes.wanted, day.purposes.avoid, day.purposes.playAllowed, day.purposes.legacyAssumed], [['tool', 'lesson'], ['play'], false, ['2026-11-08']]);
    assertDayShape(day);
    // need 7 (2 useful, 2 teach, no humor): room for the first owed kind
    assert.ok(kindCounts(day)[day.owedKinds[0]] >= 2);
    assert.deepEqual(SLOT_OF_KIND.current, 'currentEvents');
  } finally {
    box.cleanup();
  }
});

test('a damaged history file never breaks lens assignment: the neutral plan and planError', () => {
  const box = makeSandbox();
  try {
    fs.writeFileSync(path.join(box.root, 'state', 'history.json'), '{corrupt');
    box.write('state/ideas/2026-11-09.json', '{corrupt');
    const day = oneDay('2026-11-10');
    assertDayShape(day);
    assert.match(day.planError, /readJson/);
    assert.deepEqual([day.purposes.wanted, day.purposes.avoid, day.purposes.playAllowed, day.purposes.counts], [['tool', 'lesson'], [], true, null]);
    assert.deepEqual(day.owedKinds, []);
    // the override survives a broken history
    const forced = oneDay('2026-11-10', { purpose: 'studio' });
    assert.deepEqual([forced.purposes.wanted, forced.purposes.override], [['studio'], 'studio']);
    assert.ok(kindCounts(forced).wildcard >= 2);
    // a config without mix.purposes (tests/helpers/test-config.json): no plan, old counts (one of each main kind), nothing throws
    fs.writeFileSync(path.join(box.root, 'state', 'history.json'), JSON.stringify({ schema: 1, startDate: START, entries: [] }));
    const cfg = box.readJson('config.json');
    delete cfg.mix.purposes;
    delete cfg.pageContract;
    box.write('config.json', cfg);
    const noPlan = oneDay('2026-11-10');
    assert.equal(noPlan.purposes, null);
    assert.equal(noPlan.planError, undefined);
    assertDayShape(noPlan);
    for (const k of MAIN) assert.ok(kindCounts(noPlan)[k] >= 1, k);
  } finally {
    box.cleanup();
  }
});

test('--purpose override: the plan wants it, nothing is avoided, its lenses come; play brings humor and interest', () => {
  const box = makeSandbox();
  try {
    const real = JSON.parse(fs.readFileSync(path.join(REAL_ROOT, 'state', 'history.json'), 'utf8'));
    box.write('state/history.json', { schema: 1, startDate: '2026-10-09', entries: real.entries.filter((e) => e.date < '2026-10-13') });
    const play = oneDay('2026-10-13', { purpose: 'play' });
    assert.deepEqual([play.purposes.wanted, play.purposes.avoid, play.purposes.playAllowed, play.purposes.override], [['play'], [], true, 'play']);
    assertDayShape(play);
    const c = kindCounts(play);
    assert.ok(c.humor >= 1 && c.interest >= 2, JSON.stringify(c));
    assert.equal(play.agents.find((a) => a.agent === 'jester').lens.kind, 'humor');
    const explorer = oneDay('2026-10-13', { purpose: 'explorer' });
    assert.ok(kindCounts(explorer).wildcard >= 2 && kindCounts(explorer).teach >= 1);
    assert.throws(() => oneDay('2026-10-13', { purpose: 'game' }), /unknown purpose "game"/);
  } finally {
    box.cleanup();
  }
});

test('a pool with only 3 useful and 3 teach lenses survives day after day (the no-repeat window relaxes for the need, not only for empty kinds)', () => {
  const box = makeSandbox();
  try {
    // tool and lesson wanted every day (empty history): 2 useful and 2 teach lenses a day from pools of 3, so day 2 has only 1 of each
    // that day 1 did not use. Before the fix the relax loop only checked "at least 1", drew from an empty pool and crashed with
    // "Cannot destructure property 'id' of 'assignment[agent]' as it is undefined".
    const small = JSON.parse(JSON.stringify(poolFile));
    const keep = [];
    for (const k of ['interest', 'current', 'humor', 'wildcard']) keep.push(...small.lenses.filter((l) => l.kind === k).slice(0, 8));
    for (const k of ['useful', 'teach']) keep.push(...small.lenses.filter((l) => l.kind === k).slice(0, 3));
    small.lenses = keep;
    box.write('ops/lenses.json', small);
    assert.equal(small.lenses.length, 38);
    let relaxed = 0;
    for (let i = 0; i < 12; i++) {
      const day = oneDay(addDays('2026-11-01', i));
      assert.deepEqual(day.purposes.wanted, ['tool', 'lesson']);
      assertDayShape(day);
      relaxed += day.relaxedDays > 0 ? 1 : 0;
      writeIdeas(box, day);
    }
    assert.ok(relaxed >= 10, `the window relaxed on ${relaxed} days`);
  } finally {
    box.cleanup();
  }
});

test('a small pool relaxes the no-repeat window instead of failing, over 60 simulated days', () => {
  const box = makeSandbox();
  try {
    // 8 lenses per original main kind plus 3 useful and 3 teach: the smallest pool loadLensPool accepts that has every main kind
    const small = JSON.parse(JSON.stringify(poolFile));
    const keep = [];
    for (const k of ['interest', 'current', 'humor', 'wildcard']) keep.push(...small.lenses.filter((l) => l.kind === k).slice(0, 8));
    for (const k of ['useful', 'teach']) keep.push(...small.lenses.filter((l) => l.kind === k).slice(0, 3));
    small.lenses = keep;
    box.write('ops/lenses.json', small);
    const sim = simulate(box, 60);
    for (const day of sim) assertDayShape(day);
    assert.ok(sim.some((d) => d.relaxedDays > 0));
    assert.ok(sim.some((d) => !d.purposes.playAllowed) && sim.some((d) => d.purposes.playAllowed));
  } finally {
    box.cleanup();
  }
});

test('input validation', () => {
  const box = makeSandbox();
  try {
    assert.throws(() => assignLenses({ date: 'soon' }), /bad date/);
    assert.throws(() => assignLenses({}), /bad date/);
    assert.throws(() => assignLenses({ date: '2026-11-01', purpose: 'Tool' }), /unknown purpose "Tool"/);
  } finally {
    box.cleanup();
  }
});

function cli(box, args) {
  const r = spawnSync(process.execPath, [LENSES_CLI, ...args], { env: { ...process.env, SED_ROOT: box.root }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('CLI: prints one JSON document in the contract shape', () => {
  const box = makeSandbox();
  try {
    const r = cli(box, ['--date', '2026-10-12']);
    assert.equal(r.code, 0, r.err);
    const out = JSON.parse(r.out);
    assert.equal(out.ok, true);
    assert.equal(out.date, '2026-10-12');
    assert.equal(out.agents.length, 8);
    assert.deepEqual(out.agents[0], { agent: 'pulse', lens: out.agents[0].lens, provocation: out.agents[0].provocation });
    assert.deepEqual(Object.keys(out), ['ok', 'date', 'agents', 'owedKinds', 'relaxedDays', 'purposes']);
    assert.deepEqual(out.purposes.wanted, ['tool', 'lesson']);
    assert.deepEqual(JSON.parse(cli(box, ['--date', '2026-10-12']).out), out);
    const viaNow = JSON.parse(cli(box, ['--now', '2026-10-12T12:00:00Z']).out);
    assert.equal(viaNow.date, '2026-10-12');
    assert.deepEqual(viaNow.agents, out.agents);
    const bad = cli(box, ['--date', 'nope']);
    assert.equal(bad.code, 1);
    assert.equal(JSON.parse(bad.out).ok, false);
  } finally {
    box.cleanup();
  }
});

test('CLI: --purpose passes the override through; a bare --purpose exits 2, an unknown one exits 1', () => {
  const box = makeSandbox();
  try {
    const r = cli(box, ['--date', '2026-10-12', '--purpose', 'lesson']);
    assert.equal(r.code, 0, r.err);
    const out = JSON.parse(r.out);
    assert.deepEqual([out.purposes.wanted, out.purposes.avoid, out.purposes.override], [['lesson'], [], 'lesson']);
    assert.ok(out.agents.filter((a) => a.lens.kind === 'teach').length >= 2);
    for (const args of [['--date', '2026-10-12', '--purpose'], ['--purpose', '--date', '2026-10-12']]) {
      const u = cli(box, args);
      assert.equal(u.code, 2, args.join(' '));
      assert.match(JSON.parse(u.out).error, /usage: lenses\.mjs .*--purpose/);
    }
    const unknown = cli(box, ['--date', '2026-10-12', '--purpose', 'game']);
    assert.equal(unknown.code, 1);
    assert.equal(JSON.parse(unknown.out).ok, false);
    assert.match(JSON.parse(unknown.out).error, /unknown purpose "game"/);
    const head = fs.readFileSync(LENSES_CLI, 'utf8').split('\n').slice(0, 6).join('\n');
    assert.match(head, /^\/\/ {3}lenses\.mjs --date YYYY-MM-DD \[--now ISO\] \[--purpose tool\|lesson\|explorer\|studio\|play\]$/m, 'the header usage line lists the flag');
  } finally {
    box.cleanup();
  }
});

test('importing lenses.mjs has no side effects', () => {
  const r = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(LENSES_CLI)}).then(() => console.log('imported'))`], { encoding: 'utf8' });
  assert.equal(r.stdout.trim(), 'imported');
  assert.equal(r.stderr, '');
});
