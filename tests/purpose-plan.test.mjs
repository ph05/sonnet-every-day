// Tests for the purpose plan (scripts/novelty.mjs purposePlan, DESIGN section 3): the plan on the real first three days,
// playBlockedUntil, the cooldowns and their three-purpose floor, the starved rule, the override, the CLI exit codes, and a
// 60-day simulation with three ways of picking among the wanted purposes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { purposePlan, PLAY } from '../scripts/novelty.mjs';
import { addDays, mulberry32, hashStr } from '../scripts/lib/common.mjs';
import { makeSandbox, REAL_ROOT } from './fixtures/gate-helpers.mjs';

const NOVELTY_CLI = path.join(REAL_ROOT, 'scripts', 'novelty.mjs');
const CONFIG = JSON.parse(fs.readFileSync(path.join(REAL_ROOT, 'config.json'), 'utf8'));
const TAXONOMY = JSON.parse(fs.readFileSync(path.join(REAL_ROOT, 'ops', 'taxonomy.json'), 'utf8'));
const PURPOSES = Object.keys(TAXONOMY.purposes);
const NON_PLAY = PURPOSES.filter((p) => p !== PLAY);

/** A config with mix.purposes changed by `over` (the real config is never touched). */
function cfgWith(over = {}) {
  const c = JSON.parse(JSON.stringify(CONFIG));
  Object.assign(c.mix.purposes, over);
  return c;
}

function ent(date, purpose, { counts = true } = {}) {
  const fingerprint = { category: 'science-sim', mechanic: 'toy', tone: ['playful'], tags: [], keywords: [], slot: 'wildcard', political: false };
  if (purpose !== null) fingerprint.purpose = purpose; // null: an entry from before the purpose axis
  return { date, slug: `s-${date}`, title: `t ${date}`, tier: counts ? 2 : 3, countsForNovelty: counts, fingerprint };
}

/** The real first three days as they are in state/history.json (all three are play). */
const REAL_DAYS = ['2026-10-10', '2026-10-11', '2026-10-12'];
const realHistory = (purpose = PLAY) => ({ schema: 1, startDate: '2026-10-10', entries: REAL_DAYS.map((d) => ent(d, purpose)) });

const plan = (date, history, opts = {}) => purposePlan({ date, history, config: opts.config ?? CONFIG, taxonomy: TAXONOMY, purpose: opts.purpose });

test('config and taxonomy carry what the plan needs (play is reserved, the canonical order is tool, lesson, explorer, studio, play)', () => {
  assert.deepEqual(PURPOSES, ['tool', 'lesson', 'explorer', 'studio', 'play']);
  assert.deepEqual(CONFIG.mix.purposes, {
    windowDays: 7, cooldownDays: 2, playCooldownDays: 3, maxPlayPer7Days: 2, wantedCount: 2, wantedBonus: 5, starvedDays: 6,
    quota: { tool: 2, lesson: 2, explorer: 1, studio: 1 }, legacyDefault: 'play',
  });
});

test('2026-10-13 on the real first three days: tool and lesson wanted, play paused until 2026-10-18', () => {
  const p = plan('2026-10-13', realHistory());
  assert.deepEqual(p, {
    windowDays: 7,
    counts: { tool: 0, lesson: 0, explorer: 0, studio: 0, play: 3 },
    lastShipped: { tool: null, lesson: null, explorer: null, studio: null, play: '2026-10-12' },
    wanted: ['tool', 'lesson'],
    avoid: ['play'],
    playAllowed: false,
    // max(last play + playCooldownDays, second most recent play + windowDays) = max(10-15, 10-18)
    playBlockedUntil: '2026-10-18',
    bonus: 5,
    override: null,
    legacyAssumed: [],
  });
  // nothing new ships: play stays paused through 10-17 and is allowed on 10-18
  for (let i = 0; i < 7; i++) {
    const d = addDays('2026-10-13', i);
    const q = plan(d, realHistory());
    assert.equal(q.playAllowed, d >= '2026-10-18', d);
    assert.equal(q.playBlockedUntil, d >= '2026-10-18' ? null : '2026-10-18', d);
    assert.deepEqual(q.wanted, ['tool', 'lesson'], d);
  }
  // the same days without fingerprint.purpose count as the legacy default and are listed
  const legacy = plan('2026-10-13', realHistory(null));
  assert.deepEqual(legacy.legacyAssumed, REAL_DAYS);
  assert.deepEqual([legacy.counts.play, legacy.playBlockedUntil], [3, '2026-10-18']);
  const asLesson = plan('2026-10-13', realHistory('bogus'), { config: cfgWith({ legacyDefault: 'lesson' }) });
  assert.deepEqual([asLesson.counts.lesson, asLesson.counts.play, asLesson.playAllowed, asLesson.avoid], [3, 0, true, ['lesson']]);
});

test('inputs: only countsForNovelty entries dated before the date; the window is the six days before it', () => {
  const h = {
    startDate: '2026-10-01',
    entries: [ent('2026-10-03', 'tool'), ent('2026-10-04', 'studio'), ent('2026-10-08', 'lesson', { counts: false }), ent('2026-10-10', 'explorer'), ent('2026-10-11', 'tool')],
  };
  const p = plan('2026-10-10', h);
  assert.deepEqual(p.counts, { tool: 0, lesson: 0, explorer: 0, studio: 1, play: 0 }, '10-03 is 7 days back: outside; 10-04 is 6: inside; 10-10 and later never count');
  assert.deepEqual(p.lastShipped, { tool: '2026-10-03', lesson: null, explorer: null, studio: '2026-10-04', play: null });
  // the history object is not changed
  assert.equal(h.entries.length, 5);
  assert.equal(JSON.stringify(plan('2026-10-10', h)), JSON.stringify(p), 'pure: same input, same plan');
});

test('playBlockedUntil is the first date on which play would be allowed if nothing new ships (brute force on random histories)', () => {
  const rng = mulberry32(hashStr('playBlockedUntil'));
  let blocked = 0;
  for (let n = 0; n < 400; n++) {
    const D = addDays('2026-12-01', Math.floor(rng() * 30));
    const entries = [];
    for (let back = 1; back <= 14; back++) {
      const r = rng();
      if (r < 0.35) entries.push(ent(addDays(D, -back), PLAY));
      else if (r < 0.7) entries.push(ent(addDays(D, -back), NON_PLAY[Math.floor(rng() * 4)]));
    }
    const config = rng() < 0.5 ? CONFIG : cfgWith({ playCooldownDays: 1 + Math.floor(rng() * 5), maxPlayPer7Days: 1 + Math.floor(rng() * 3) });
    const h = { startDate: '2026-11-01', entries };
    const p = plan(D, h, { config });
    if (p.playAllowed) {
      assert.equal(p.playBlockedUntil, null);
      continue;
    }
    blocked++;
    let first = null;
    for (let k = 1; k <= 30 && !first; k++) if (plan(addDays(D, k), h, { config }).playAllowed) first = addDays(D, k);
    assert.equal(p.playBlockedUntil, first, `${D} ${JSON.stringify(entries.map((e) => [e.date, e.fingerprint.purpose]))} ${JSON.stringify(config.mix.purposes)}`);
    assert.ok(p.avoid.includes(PLAY));
  }
  assert.ok(blocked > 100, `the sample exercises blocked days (${blocked})`);
});

test('play: cooldown and weekly cap each block it; play is never wanted', () => {
  // cooldown: a play 2 days ago blocks (playCooldownDays 3), 3 days ago does not
  const twoAgo = plan('2026-11-10', { startDate: '2026-11-01', entries: [ent('2026-11-08', PLAY)] });
  assert.deepEqual([twoAgo.playAllowed, twoAgo.playBlockedUntil], [false, '2026-11-11']);
  const threeAgo = plan('2026-11-10', { startDate: '2026-11-01', entries: [ent('2026-11-07', PLAY)] });
  assert.deepEqual([threeAgo.playAllowed, threeAgo.playBlockedUntil, threeAgo.avoid], [true, null, []]);
  // cap: two plays in the window block until the older one leaves it
  const cap = plan('2026-11-10', { startDate: '2026-11-01', entries: [ent('2026-11-04', PLAY), ent('2026-11-06', PLAY)] });
  assert.deepEqual([cap.counts.play, cap.playAllowed, cap.playBlockedUntil], [2, false, '2026-11-11']);
  for (const p of [twoAgo, threeAgo, cap, plan('2026-11-10', { startDate: '2026-10-01', entries: [] })]) assert.ok(!p.wanted.includes(PLAY));
});

test('avoid: purposes shipped in the last cooldownDays days, plus play when blocked; at least three purposes stay allowed', () => {
  const h = (entries, startDate = '2026-11-01') => ({ startDate, entries });
  // yesterday and two days ago are cooling down, three days ago is not (a start 4 days ago: nothing is starved yet)
  const p = plan('2026-11-10', h([ent('2026-11-07', 'studio'), ent('2026-11-08', 'lesson'), ent('2026-11-09', 'tool'), ent('2026-11-02', PLAY)], '2026-11-06'));
  assert.deepEqual([p.avoid, p.playAllowed], [['tool', 'lesson'], true]);
  assert.deepEqual(p.wanted, ['explorer', 'studio'], 'explorer never shipped, studio once');
  // play blocked + two cooldowns would leave two purposes: the oldest cooldown (lesson, two days ago) is lifted, the play block never
  const floor = plan('2026-11-10', h([ent('2026-11-07', PLAY), ent('2026-11-08', 'lesson'), ent('2026-11-09', 'tool'), ent('2026-11-05', PLAY)]));
  assert.equal(floor.playAllowed, false);
  assert.deepEqual(floor.avoid, ['tool', 'play']);
  assert.deepEqual(floor.wanted, ['explorer', 'studio']);
  // a longer cooldown: three cooldowns and the play block leave one purpose, so the two oldest cooldowns are lifted
  const long = plan('2026-11-10', h([ent('2026-11-05', PLAY), ent('2026-11-06', PLAY), ent('2026-11-07', 'studio'), ent('2026-11-08', 'lesson'), ent('2026-11-09', 'tool')]), { config: cfgWith({ cooldownDays: 3 }) });
  assert.equal(long.playAllowed, false);
  assert.deepEqual(long.avoid, ['tool', 'play']);
  assert.equal(PURPOSES.length - long.avoid.length, 3);
  // play itself cooling down while the play block allows it (a short play cooldown, a long purpose cooldown): its cooldown can be lifted
  const own = plan('2026-11-10', h([ent('2026-11-07', PLAY), ent('2026-11-08', 'lesson'), ent('2026-11-09', 'tool')]), { config: cfgWith({ cooldownDays: 3, playCooldownDays: 1 }) });
  assert.equal(own.playAllowed, true);
  assert.deepEqual(own.avoid, ['tool', 'lesson'], 'the oldest cooldown (play) is lifted to keep three purposes');
});

test('wanted: lowest shipped-to-quota ratio first, then the longest gap, then canonical order; at most wantedCount', () => {
  const h = { startDate: '2026-11-05', entries: [ent('2026-11-05', 'explorer'), ent('2026-11-06', 'tool'), ent('2026-11-07', 'lesson')] };
  const p = plan('2026-11-10', h);
  // studio never shipped (ratio 0); tool and lesson shipped once against a quota of 2 (ratio 0.5, tool's gap of 4 days beats lesson's 3);
  // explorer shipped once against a quota of 1 (ratio 1)
  assert.deepEqual(p.avoid, []);
  assert.deepEqual(p.wanted, ['studio', 'tool']);
  assert.deepEqual(plan('2026-11-10', h, { config: cfgWith({ wantedCount: 1 }) }).wanted, ['studio']);
  // an empty history on the start date: every gap is 0, canonical order decides
  assert.deepEqual(plan('2026-11-05', { startDate: '2026-11-05', entries: [] }).wanted, ['tool', 'lesson']);
});

test('starved: a purpose idle for starvedDays with nothing in the window becomes the only wanted one', () => {
  // studio never shipped since the start 6 days ago, everything else recently: studio alone is wanted
  const h = { startDate: '2026-11-04', entries: [ent('2026-11-05', 'explorer'), ent('2026-11-06', 'tool'), ent('2026-11-07', 'lesson'), ent('2026-11-08', 'explorer')] };
  const p = plan('2026-11-10', h);
  assert.deepEqual(p.wanted, ['studio']);
  // one day earlier studio's gap is 5: not starved, the normal ranking picks two
  assert.deepEqual(plan('2026-11-09', h).wanted, ['studio', 'tool']);
  // two starved purposes: both, longest gap first
  const two = plan('2026-11-20', { startDate: '2026-11-01', entries: [ent('2026-11-10', 'tool'), ent('2026-11-12', 'lesson'), ent('2026-11-18', 'explorer'), ent('2026-11-19', 'tool')] });
  assert.deepEqual(two.wanted, ['studio', 'lesson'], 'studio (never shipped, 19 days) before lesson (8 days)');
  // six days idle but shipped inside the window (counts 1) is not starved: studio and explorer are ranked normally
  const inWindow = plan('2026-11-20', { startDate: '2026-11-01', entries: [ent('2026-11-14', 'studio'), ent('2026-11-17', 'explorer'), ent('2026-11-18', 'lesson'), ent('2026-11-19', 'tool')] });
  assert.deepEqual([inWindow.avoid, inWindow.wanted], [['tool', 'lesson'], ['studio', 'explorer']]);
  // starvedDays follows the config
  assert.deepEqual(plan('2026-11-09', h, { config: cfgWith({ starvedDays: 5 }) }).wanted, ['studio']);
});

test('override: wanted [P] and every other purpose avoided, so only P can win; play allowed only for P=play; counts stay real; an unknown purpose throws', () => {
  for (const P of PURPOSES) {
    const p = plan('2026-10-13', realHistory(), { purpose: P });
    assert.deepEqual([p.wanted, p.avoid, p.playAllowed, p.override], [[P], PURPOSES.filter((q) => q !== P), P === PLAY, P], P);
    // play is paused until 2026-10-18 anyway: a play override allows it today, any other override keeps that date
    assert.equal(p.playBlockedUntil, P === PLAY ? null : '2026-10-18', P);
    assert.equal(p.counts.play, 3);
    assert.ok(p.avoid.length === PURPOSES.length - 1 && !p.avoid.includes(P), `${P}: everything but ${P} is avoided`);
  }
  // a day on which play would be allowed (the last play was 8 days before): a lesson override pauses play for this run only,
  // so the first date it is allowed again is the next day; without the override nothing is avoided and play is allowed
  const free = plan('2026-10-20', realHistory());
  assert.deepEqual([free.override, free.avoid, free.playAllowed, free.playBlockedUntil], [null, [], true, null]);
  const lesson = plan('2026-10-20', realHistory(), { purpose: 'lesson' });
  assert.deepEqual([lesson.wanted, lesson.avoid, lesson.playAllowed, lesson.playBlockedUntil], [['lesson'], ['tool', 'explorer', 'studio', 'play'], false, '2026-10-21']);
  assert.deepEqual(plan('2026-10-20', realHistory(), { purpose: 'play' }).avoid, ['tool', 'lesson', 'explorer', 'studio']);
  // the override touches only wanted, avoid, play and override: counts, lastShipped, bonus, window and legacy stay the plan's own
  const { wanted, avoid, playAllowed, playBlockedUntil, override, ...rest } = lesson;
  const { wanted: w0, avoid: a0, playAllowed: p0, playBlockedUntil: b0, override: o0, ...rest0 } = free;
  assert.deepEqual(rest, rest0);
  assert.throws(() => plan('2026-10-13', realHistory(), { purpose: 'game' }), /unknown purpose "game" \(one of tool, lesson, explorer, studio, play\)/);
  assert.throws(() => plan('2026-10-13', realHistory(), { purpose: '' }), /unknown purpose ""/);
});

test('no plan: a config without mix.purposes or a taxonomy without purposes (or without play) gives null; damaged values fall back', () => {
  const noBlock = JSON.parse(JSON.stringify(CONFIG));
  delete noBlock.mix.purposes;
  assert.equal(purposePlan({ date: '2026-10-13', history: realHistory(), config: noBlock, taxonomy: TAXONOMY }), null);
  assert.throws(() => purposePlan({ date: '2026-10-13', history: realHistory(), config: noBlock, taxonomy: TAXONOMY, purpose: 'tool' }), /no purpose plan/);
  const noPurposes = { ...TAXONOMY, purposes: undefined };
  assert.equal(purposePlan({ date: '2026-10-13', history: realHistory(), config: CONFIG, taxonomy: noPurposes }), null);
  const noPlay = { ...TAXONOMY, purposes: { tool: 't', lesson: 'l', explorer: 'e' } };
  assert.equal(purposePlan({ date: '2026-10-13', history: realHistory(), config: CONFIG, taxonomy: noPlay }), null);
  // a damaged value falls back to its default instead of producing NaN or an empty plan
  const damaged = plan('2026-10-13', realHistory(), { config: cfgWith({ windowDays: 'seven', maxPlayPer7Days: -1, wantedCount: 0, legacyDefault: 'nope', wantedBonus: null }) });
  assert.deepEqual([damaged.windowDays, damaged.wanted.length, damaged.bonus, damaged.playBlockedUntil], [7, 2, 5, '2026-10-18']);
  assert.throws(() => purposePlan({ date: 'soon', history: realHistory(), config: CONFIG, taxonomy: TAXONOMY }), /bad date/);
});

/**
 * 60 days from 2026-10-13 on the real first three days. Each day ships one purpose chosen by `pick` among the wanted ones; on
 * every 5th day play ships instead whenever the plan allows it. `skip(i)` makes day i a fallback day (nothing counts).
 */
function simulate(pick, { days = 60, skip = () => false, seed = 'sim', playEvery = 5 } = {}) {
  const rng = mulberry32(hashStr(seed));
  const history = realHistory();
  const shipped = [];
  for (let i = 0; i < days; i++) {
    const date = addDays('2026-10-13', i);
    const p = plan(date, history);
    assert.ok(p.wanted.length >= 1 && p.wanted.length <= 2, `${date}: wanted ${p.wanted}`);
    assert.ok(!p.wanted.includes(PLAY) && p.wanted.every((w) => !p.avoid.includes(w)), `${date}: wanted ${p.wanted}, avoid ${p.avoid}`);
    assert.ok(PURPOSES.length - p.avoid.length >= 3, `${date}: avoid ${p.avoid}`);
    if (skip(i)) {
      history.entries.push(ent(date, p.wanted[0], { counts: false }));
      shipped.push(null);
      continue;
    }
    const purpose = playEvery > 0 && i % playEvery === playEvery - 1 && p.playAllowed ? PLAY : pick(p.wanted, rng);
    assert.ok(purpose === PLAY ? p.playAllowed : !p.avoid.includes(purpose), `${date}: shipped ${purpose} while avoided`);
    history.entries.push(ent(date, purpose));
    shipped.push(purpose);
  }
  return { shipped, history };
}

const PICKERS = {
  first: (wanted) => wanted[0],
  last: (wanted) => wanted.at(-1),
  random: (wanted, rng) => wanted[Math.floor(rng() * wanted.length)],
};

/** Longest run of consecutive days on which `purpose` did not ship, counting from `from`. */
function longestAbsence(shipped, purpose, from) {
  let worst = 0;
  let run = 0;
  for (let i = from; i < shipped.length; i++) {
    run = shipped[i] === purpose ? 0 : run + 1;
    worst = Math.max(worst, run);
  }
  return worst;
}

for (const [name, pick] of Object.entries(PICKERS)) {
  test(`60 simulated days, picker "${name}": play at most twice in any 7 days, every purpose within a week, no purpose twice in a row`, () => {
    for (const seed of ['a', 'b', 'c']) {
      const { shipped, history } = simulate(pick, { seed });
      const all = history.entries.filter((e) => e.countsForNovelty).map((e) => ({ date: e.date, purpose: e.fingerprint.purpose }));
      // play <= 2 in any 7-day window (windows that start after the first real day; 10-10..10-12 were three plays before the plan existed)
      for (let i = 0; i < all.length; i++) {
        if (all[i].date <= REAL_DAYS[0]) continue;
        const end = addDays(all[i].date, 6);
        const plays = all.filter((e) => e.date >= all[i].date && e.date <= end && e.purpose === PLAY).length;
        assert.ok(plays <= 2, `${name}/${seed}: ${plays} plays in the week from ${all[i].date}`);
      }
      // after a one-week warm-up no non-play purpose is absent for more than 7 days
      for (const p of NON_PLAY) {
        const worst = longestAbsence(shipped, p, 7);
        assert.ok(worst <= 7, `${name}/${seed}: ${p} absent ${worst} days: ${shipped.join(' ')}`);
      }
      // no purpose on two consecutive days (the last real day, play, included)
      const seq = [PLAY, ...shipped];
      for (let i = 1; i < seq.length; i++) assert.notEqual(seq[i], seq[i - 1], `${name}/${seed}: ${seq[i]} twice in a row on day ${i - 1}`);
      // play does come back
      assert.ok(shipped.filter((s) => s === PLAY).length >= 6, `${name}/${seed}: play ${shipped.filter((s) => s === PLAY).length}x`);
    }
  });
}

test('quota: with no play, tools and lessons ship clearly more often than explorers and studios (56 days, three pickers)', () => {
  for (const [name, pick] of Object.entries(PICKERS)) {
    const { shipped } = simulate(pick, { days: 56, playEvery: 0, seed: name });
    const n = Object.fromEntries(NON_PLAY.map((p) => [p, shipped.filter((s) => s === p).length]));
    for (const p of NON_PLAY) assert.ok(n[p] >= 6, `${name}: ${p} only ${n[p]} times in 56 days`);
    // only a picker that takes the best-ranked purpose shows the quota (always taking the second-ranked one is its own bias)
    if (name !== 'first') continue;
    assert.ok(n.tool >= 1.2 * n.explorer && n.tool >= 1.2 * n.studio, `${name}: tool ${n.tool} vs explorer ${n.explorer} studio ${n.studio}`);
    assert.ok(n.lesson >= 1.2 * n.explorer && n.lesson >= 1.2 * n.studio, `${name}: lesson ${n.lesson} vs explorer ${n.explorer} studio ${n.studio}`);
    for (const p of NON_PLAY) assert.ok(n[p] >= 6, `${name}: ${p} only ${n[p]} times in 56 days`);
  }
});

test('60 simulated days with a fallback day every 6th day: the play cap and the no-repeat rule still hold', () => {
  for (const [name, pick] of Object.entries(PICKERS)) {
    const { shipped } = simulate(pick, { skip: (i) => i % 6 === 5, seed: name });
    const counted = shipped.filter(Boolean);
    assert.ok(counted.length === 50);
    for (let i = 0; i + 7 <= shipped.length; i++) {
      assert.ok(shipped.slice(i, i + 7).filter((s) => s === PLAY).length <= 2, `${name}: too much play from day ${i}`);
    }
    for (let i = 1; i < shipped.length; i++) if (shipped[i]) assert.notEqual(shipped[i], shipped[i - 1], `${name}: day ${i}`);
    for (const p of NON_PLAY) assert.ok(longestAbsence(shipped, p, 7) <= 9, `${name}: ${p} absent ${longestAbsence(shipped, p, 7)} days`);
  }
});

/* ---- CLI ------------------------------------------------------------------------------------------- */

function cli(box, args) {
  const r = spawnSync(process.execPath, [NOVELTY_CLI, ...args], { env: { ...process.env, SED_ROOT: box.root }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, json: (() => { try { return JSON.parse(r.stdout); } catch { return null; } })() };
}

test('CLI: novelty.mjs mix prints the plan; --purpose overrides it; a bare --purpose exits 2 and an unknown one exits 1', () => {
  const box = makeSandbox();
  try {
    box.write('state/history.json', { ...realHistory(), startDate: '2026-10-09' });
    const m = cli(box, ['mix', '--date', '2026-10-13']);
    assert.equal(m.code, 0);
    assert.deepEqual([m.json.purposes.wanted, m.json.purposes.avoid, m.json.purposes.playAllowed, m.json.purposes.playBlockedUntil], [['tool', 'lesson'], ['play'], false, '2026-10-18']);
    assert.ok(m.json.summary.startsWith('Purpose mix this week: tool 0, lesson 0, explorer 0, studio 0, play 3. Today we want a tool or a lesson (lead with one); play is paused until 2026-10-18.'), m.json.summary);
    const o = cli(box, ['mix', '--date', '2026-10-13', '--purpose', 'play']);
    assert.equal(o.code, 0);
    assert.deepEqual([o.json.purposes.wanted, o.json.purposes.avoid, o.json.purposes.playAllowed, o.json.purposes.override], [['play'], ['tool', 'lesson', 'explorer', 'studio'], true, 'play']);
    const l = cli(box, ['mix', '--date', '2026-10-13', '--purpose', 'lesson']);
    assert.deepEqual([l.code, l.json.purposes.wanted, l.json.purposes.avoid, l.json.purposes.playAllowed], [0, ['lesson'], ['tool', 'explorer', 'studio', 'play'], false]);
    assert.ok(l.json.summary.startsWith('Purpose mix this week: tool 0, lesson 0, explorer 0, studio 0, play 3. Manual override: today we want a lesson and nothing else; every other purpose is avoided.'), l.json.summary);
    assert.deepEqual([cli(box, ['mix', '--date', '2026-10-13', '--purpose']).code, cli(box, ['mix', '--purpose', '--date', '2026-10-13']).code], [2, 2]);
    const bad = cli(box, ['mix', '--date', '2026-10-13', '--purpose', 'toy']);
    assert.deepEqual([bad.code, bad.json.ok], [1, false]);
    assert.match(bad.json.error, /unknown purpose "toy"/);
    // check takes no --purpose: it is ignored like any unknown flag, and the plan never turns into a novelty conflict
    const file = box.write('cands.json', [{ id: 'p', title: 'Zebra Quartz Harbor Lens', fingerprint: { category: 'music-audio', mechanic: 'instrument', tone: ['playful'], tags: ['zz-a', 'zz-b', 'zz-c'], keywords: ['zz-d', 'zz-e', 'zz-f'], slot: 'wildcard', political: false, purpose: 'play' } }]);
    const c = cli(box, ['check', '--candidates', file, '--date', '2026-10-13', '--purpose', 'tool']);
    assert.equal(c.code, 0);
    assert.deepEqual(c.json.results.map((r) => [r.ok, r.conflicts]), [[true, []]]);
  } finally {
    box.cleanup();
  }
});
