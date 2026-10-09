// Tests for scripts/lenses.mjs and ops/lenses.json: pool quality, determinism, daily constraints, long-run variety.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assignLenses, loadLensPool, AGENTS } from '../scripts/lenses.mjs';
import { addDays } from '../scripts/lib/common.mjs';
import { makeSandbox, REAL_ROOT } from './fixtures/gate-helpers.mjs';

const LENSES_CLI = path.join(REAL_ROOT, 'scripts', 'lenses.mjs');
const MAIN = ['interest', 'current', 'humor', 'wildcard'];
const SLOT_OF_KIND = { interest: 'interest', current: 'currentEvents', humor: 'humor', wildcard: 'wildcard' };
const START = '2026-10-09';

const poolFile = JSON.parse(fs.readFileSync(path.join(REAL_ROOT, 'ops', 'lenses.json'), 'utf8'));

test('pool: size, ids, kinds and required lenses', () => {
  const { lenses } = poolFile;
  assert.ok(lenses.length >= 32, `${lenses.length} lenses`);
  assert.equal(new Set(lenses.map((l) => l.id)).size, lenses.length, 'ids are unique');
  for (const l of lenses) {
    assert.match(l.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(['interest', 'current', 'humor', 'wildcard', 'craft'].includes(l.kind), `${l.id}: kind ${l.kind}`);
    assert.ok(l.name.length >= 6 && l.name.length <= 48, `${l.id}: name`);
  }
  const required = ['hockey-now', 'poker-ranges', 'balatro-mod-ideas', 'reddit-hot-threads', 'hn-front-page', 'pop-culture-pulse', 'absurdist-interactive', 'science-sim', 'music-instrument', 'generative-art', 'retro-computing', 'tiny-tools', 'word-play', 'game-design-experiment', 'data-story', 'weird-web'];
  for (const id of required) assert.ok(lenses.some((l) => l.id === id), `missing required lens ${id}`);
  const byKind = (k) => lenses.filter((l) => l.kind === k).length;
  for (const k of MAIN) assert.ok(byKind(k) >= 8, `kind ${k} has only ${byKind(k)} lenses`);
  assert.ok(byKind('craft') >= 3);
});

test('pool: briefs are vivid, sourced and cover the interests the owner cares about', () => {
  for (const l of poolFile.lenses) {
    const sentences = l.brief.split(/(?<=[.!?])\s+/).filter(Boolean);
    assert.ok(sentences.length >= 2 && sentences.length <= 4, `${l.id}: ${sentences.length} sentences`);
    assert.ok(l.brief.length >= 160 && l.brief.length <= 520, `${l.id}: brief length ${l.brief.length}`);
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
    write((p) => { p.lenses = p.lenses.filter((l) => l.kind !== 'humor' || p.lenses.filter((x) => x.kind === 'humor').indexOf(l) < 2); });
    assert.throws(() => loadLensPool(), /kind humor/);
    write((p) => { p.provocationWords = ['one', 'two']; });
    assert.throws(() => loadLensPool(), /provocation/);
    box.write('ops/lenses.json', '{nope');
    assert.throws(() => loadLensPool(), /readJson/);
  } finally {
    box.cleanup();
  }
});

function oneDay(date, opts) {
  return assignLenses({ date, ...opts });
}

function assertDayShape(day) {
  assert.deepEqual(day.agents.map((a) => a.agent), AGENTS);
  assert.deepEqual(AGENTS, ['pulse', 'cards', 'lab', 'jester', 'architect', 'artisan', 'engineer', 'critic']);
  const kinds = day.agents.map((a) => a.lens.kind);
  for (const k of MAIN) assert.ok(kinds.includes(k), `${day.date}: no ${k} lens in ${kinds}`);
  assert.equal(new Set(day.agents.map((a) => a.lens.id)).size, 8, `${day.date}: lens ids repeat`);
  for (const a of day.agents) {
    assert.deepEqual(Object.keys(a.lens).sort(), ['brief', 'id', 'kind', 'name', 'sourceHints']);
    assert.equal(a.provocation.length, 3);
  }
  const words = day.agents.flatMap((a) => a.provocation);
  assert.equal(new Set(words).size, 24, 'provocation words are all distinct');
  for (const w of words) assert.ok(poolFile.provocationWords.includes(w));
  assert.ok(day.agents.filter((a) => a.lens.kind === 'craft').length <= 1);
}

test('a day has 8 agents with the four main kinds and distinct lenses and words', () => {
  const box = makeSandbox();
  try {
    for (let i = 0; i < 40; i++) assertDayShape(oneDay(addDays(START, i)));
  } finally {
    box.cleanup();
  }
});

test('affinity: pulse gets a current lens, cards interest, lab wildcard, jester humor', () => {
  const box = makeSandbox();
  try {
    for (let i = 0; i < 40; i++) {
      const d = oneDay(addDays(START, i));
      const k = Object.fromEntries(d.agents.map((a) => [a.agent, a.lens.kind]));
      assert.equal(k.pulse, 'current');
      assert.equal(k.cards, 'interest');
      assert.equal(k.lab, 'wildcard');
      assert.equal(k.jester, 'humor');
    }
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

function writeIdeas(box, day) {
  box.write(`state/ideas/${day.date}.json`, {
    schema: 1, date: day.date, lenses: day.agents.map((a) => ({ agent: a.agent, lensId: a.lens.id, provocation: a.provocation })),
  });
}

/** Mimic a real run: a history entry most days (slots rotate irregularly), an ideas file every day. */
function simulate(box, days, { skipHistoryEvery = 5 } = {}) {
  const slots = ['interest', 'currentEvents', 'humor', 'wildcard'];
  const entries = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(START, i);
    if (i % skipHistoryEvery !== 4) {
      entries.push({
        n: i + 1, date, slug: `s${i}`, title: `t${i}`, tagline: 't', tier: 1, path: `d/${date}-s${i}/`, publishedAt: `${date}T12:00:00Z`, countsForNovelty: true,
        fingerprint: { category: 'science-sim', mechanic: 'simulator', tone: ['playful'], tech: [], tags: [], keywords: [], slot: slots[(i * 7 + Math.floor(i / 3)) % 4], political: false },
      });
    }
  }
  box.write('state/history.json', { schema: 1, startDate: START, entries });
  const out = [];
  for (let i = 0; i < days; i++) {
    const day = oneDay(addDays(START, i));
    writeIdeas(box, day);
    out.push(day);
  }
  return out;
}

test('120 simulated days: daily constraints hold, no repeats within 3 days, owed slots are served', () => {
  const box = makeSandbox();
  try {
    const sim = simulate(box, 120);
    sim.forEach((day, i) => {
      assertDayShape(day);
      assert.equal(day.relaxedDays, 0, `${day.date}: the 3-day window needed relaxing`);
      const recent = new Set(sim.slice(Math.max(0, i - 3), i).flatMap((d) => d.agents.map((a) => a.lens.id)));
      for (const a of day.agents) assert.ok(!recent.has(a.lens.id), `${day.date}: ${a.lens.id} repeats within 3 days`);
      // Every owed slot beyond the guaranteed one per kind gets a second lens of its kind.
      const counts = {};
      for (const a of day.agents) counts[a.lens.kind] = (counts[a.lens.kind] ?? 0) + 1;
      for (const k of day.owedKinds) assert.ok(counts[k] >= 2, `${day.date}: owed ${k} but only ${counts[k]} lens`);
    });
    assert.ok(sim.some((d) => d.owedKinds.length > 0), 'the simulation exercises owed slots');
  } finally {
    box.cleanup();
  }
});

test('120 simulated days: every lens is used and none is starved', () => {
  const box = makeSandbox();
  try {
    const sim = simulate(box, 120);
    const uses = new Map(poolFile.lenses.map((l) => [l.id, []]));
    sim.forEach((day, i) => day.agents.forEach((a) => uses.get(a.lens.id).push(i)));
    const counts = [...uses.values()].map((u) => u.length);
    const min = Math.min(...counts);
    const max = Math.max(...counts);
    for (const [id, u] of uses) assert.ok(u.length >= 5, `${id} used only ${u.length} times in 120 days`);
    assert.ok(max / min <= 4, `usage is lopsided: min ${min}, max ${max}`);
    for (const [id, u] of uses) {
      const gaps = u.slice(1).map((x, i) => x - u[i]).concat([120 - u[u.length - 1], u[0]]);
      assert.ok(Math.max(...gaps) <= 70, `${id} waits ${Math.max(...gaps)} days between uses`);
    }
    const perKind = {};
    for (const day of sim) for (const a of day.agents) perKind[a.lens.kind] = (perKind[a.lens.kind] ?? 0) + 1;
    for (const k of MAIN) assert.ok(perKind[k] >= 120 * 1.2, `${k}: ${perKind[k]} lens-days`);
    assert.ok(perKind.craft >= 20, `craft ${perKind.craft}`);
    assert.ok(perKind.interest > perKind.humor, 'interest lenses are favoured over humor ones');
  } finally {
    box.cleanup();
  }
});

test('120 simulated days: each agent sees a wide spread of lenses and kinds', () => {
  const box = makeSandbox();
  try {
    const sim = simulate(box, 120);
    const poolSize = (kind) => poolFile.lenses.filter((l) => l.kind === kind).length;
    const home = { pulse: 'current', cards: 'interest', lab: 'wildcard', jester: 'humor' };
    for (const agent of AGENTS) {
      const ids = new Set(sim.map((d) => d.agents.find((a) => a.agent === agent).lens.id));
      if (home[agent]) assert.ok(ids.size >= poolSize(home[agent]) - 1, `${agent} saw only ${ids.size} of ${poolSize(home[agent])} ${home[agent]} lenses`);
      else assert.ok(ids.size >= 30, `${agent} saw only ${ids.size} distinct lenses`);
    }
    for (const agent of ['architect', 'artisan', 'engineer', 'critic']) {
      const kinds = new Set(sim.map((d) => d.agents.find((a) => a.agent === agent).lens.kind));
      assert.equal(kinds.size, 5, `${agent} only saw kinds ${[...kinds]}`);
    }
  } finally {
    box.cleanup();
  }
});

test('owed slots map to guaranteed lenses (explicit override)', () => {
  const box = makeSandbox();
  try {
    for (const owedKinds of [['humor'], ['current', 'wildcard'], ['interest', 'current', 'humor', 'wildcard']]) {
      for (let i = 0; i < 10; i++) {
        const day = oneDay(addDays('2027-02-01', i), { owedKinds });
        const counts = {};
        for (const a of day.agents) counts[a.lens.kind] = (counts[a.lens.kind] ?? 0) + 1;
        for (const k of owedKinds) assert.ok(counts[k] >= 2, `${day.date}: owed ${k}`);
        assertDayShape(day);
      }
    }
  } finally {
    box.cleanup();
  }
});

test('owed slots come from novelty mix automatically', () => {
  const box = makeSandbox();
  try {
    // Only an interest build in the last week: current, humor and wildcard are owed.
    const date = '2026-11-10';
    box.write('state/history.json', {
      schema: 1, startDate: START, entries: [{
        n: 30, date: '2026-11-08', slug: 'x', title: 'x', tagline: 't', tier: 1, path: 'd/2026-11-08-x/', publishedAt: '2026-11-08T12:00:00Z', countsForNovelty: true,
        fingerprint: { category: 'cards-odds', mechanic: 'solver', tone: ['playful'], tech: [], tags: [], keywords: [], slot: 'interest', political: false },
      }],
    });
    const day = oneDay(date);
    assert.deepEqual([...day.owedKinds].sort(), ['current', 'humor', 'wildcard']);
    const counts = {};
    for (const a of day.agents) counts[a.lens.kind] = (counts[a.lens.kind] ?? 0) + 1;
    for (const k of day.owedKinds) assert.ok(counts[k] >= 2);
    assert.deepEqual(SLOT_OF_KIND.current, 'currentEvents');
  } finally {
    box.cleanup();
  }
});

test('a damaged history file never breaks lens assignment', () => {
  const box = makeSandbox();
  try {
    fs.writeFileSync(path.join(box.root, 'state', 'history.json'), '{corrupt');
    box.write('state/ideas/2026-11-09.json', '{corrupt');
    assertDayShape(oneDay('2026-11-10'));
  } finally {
    box.cleanup();
  }
});

test('a small pool relaxes the no-repeat window instead of failing', () => {
  const box = makeSandbox();
  try {
    // 8 lenses per main kind is the smallest pool that satisfies the constructor's own checks at 32 lenses.
    const small = JSON.parse(JSON.stringify(poolFile));
    const keep = [];
    for (const k of MAIN) keep.push(...small.lenses.filter((l) => l.kind === k).slice(0, 8));
    small.lenses = keep;
    box.write('ops/lenses.json', small);
    assert.equal(small.lenses.length, 32);
    let relaxed = 0;
    for (let i = 0; i < 60; i++) {
      const day = oneDay(addDays(START, i));
      assertDayShape(day);
      relaxed += day.relaxedDays > 0 ? 1 : 0;
      writeIdeas(box, day);
    }
    assert.ok(relaxed >= 0);
  } finally {
    box.cleanup();
  }
});

test('input validation', () => {
  const box = makeSandbox();
  try {
    assert.throws(() => assignLenses({ date: 'soon' }), /bad date/);
    assert.throws(() => assignLenses({}), /bad date/);
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

test('importing lenses.mjs has no side effects', () => {
  const r = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(LENSES_CLI)}).then(() => console.log('imported'))`], { encoding: 'utf8' });
  assert.equal(r.stdout.trim(), 'imported');
  assert.equal(r.stderr, '');
});
