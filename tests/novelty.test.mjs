// Tests for scripts/novelty.mjs: every conflict kind, cooldown edges, politics cap, similarity maths, mix summary.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  checkCandidates, mix, trigrams, jaccard, titleSimilarity, daysBetween, tagSet,
} from '../scripts/novelty.mjs';
import { makeSandbox, fingerprint, REAL_ROOT } from './fixtures/gate-helpers.mjs';

const NOVELTY_CLI = path.join(REAL_ROOT, 'scripts', 'novelty.mjs');
const TODAY = '2026-11-10';

function dayBefore(n, from = TODAY) {
  return new Date(Date.parse(`${from}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
}

function entry(daysAgo, over = {}) {
  const date = over.date ?? dayBefore(daysAgo);
  const slug = over.slug ?? `proj-${date}`;
  return {
    n: 1, date, slug, title: over.title ?? `Unrelated Title ${date}`, tagline: 't', tier: 1,
    fingerprint: fingerprint({ category: 'science-sim', mechanic: 'simulator', tags: [`t-${date}-a`, `t-${date}-b`, `t-${date}-c`], keywords: [`k-${date}-a`, `k-${date}-b`, `k-${date}-c`], slot: 'wildcard', ...(over.fp ?? {}) }),
    path: `d/${date}-${slug}/`, publishedAt: `${date}T12:00:00Z`, countsForNovelty: over.counts ?? true,
  };
}

function withHistory(entries, fn, opts) {
  const box = makeSandbox(opts);
  try {
    box.write('state/history.json', { schema: 1, startDate: '2026-10-09', entries });
    return fn(box);
  } finally {
    box.cleanup();
  }
}

/** A candidate that conflicts with nothing unless overridden. */
function cand(over = {}, fpOver = {}) {
  return {
    id: 'c1', title: 'Zebra Quartz Harbor Lens',
    fingerprint: fingerprint({ category: 'music-audio', mechanic: 'instrument', tags: ['zzz-one', 'zzz-two', 'zzz-three'], keywords: ['zzz-four', 'zzz-five', 'zzz-six'], slot: 'wildcard', ...fpOver }),
    ...over,
  };
}

const kinds = (res, i = 0) => res.results[i].conflicts.map((c) => c.kind);
const check = (candidates) => checkCandidates(candidates, { date: TODAY });

test('helpers: trigrams, jaccard, title similarity, day arithmetic', () => {
  assert.deepEqual([...trigrams('ab')].sort(), ['  a', ' ab', 'ab '].sort());
  assert.equal(trigrams('').size, 0);
  assert.deepEqual(trigrams('Hello, World!'), trigrams('hello world'));
  assert.equal(titleSimilarity('Pocket Range Trainer', 'pocket range trainer'), 1);
  assert.ok(titleSimilarity('Pocket Range Trainer', 'Pocket Range Trainers') > 0.8);
  assert.ok(titleSimilarity('Pocket Range Trainer', 'Rainy Day Ocarina') < 0.2);
  assert.equal(titleSimilarity('', 'x'), 0);
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['b', 'c'])), 1 / 3);
  assert.equal(jaccard(new Set(), new Set(['a'])), 0);
  assert.equal(jaccard(new Set(), new Set()), 0);
  assert.equal(daysBetween('2026-11-10', '2026-11-09'), 1);
  assert.equal(daysBetween('2026-03-09', '2026-03-08'), 1, 'DST changes do not shift calendar days');
  assert.equal(daysBetween('2026-11-02', '2026-11-01'), 1);
  assert.deepEqual([...tagSet({ tags: ['A', ' b '], keywords: ['b', 'C'] })].sort(), ['a', 'b', 'c']);
});

test('no history: nothing conflicts and the score is perfect', () => {
  withHistory([], () => {
    const res = check([cand()]);
    assert.equal(res.ok, true);
    assert.deepEqual(res.results, [{ id: 'c1', ok: true, conflicts: [], score: 10 }]);
  });
});

test('category-cooldown: yesterday conflicts, two days ago does not', () => {
  withHistory([entry(1, { fp: { category: 'music-audio', mechanic: 'toy' } })], () => {
    const res = check([cand()]);
    assert.deepEqual(kinds(res), ['category-cooldown']);
    const c = res.results[0].conflicts[0];
    assert.equal(c.date, dayBefore(1));
    assert.equal(c.slug, `proj-${dayBefore(1)}`);
    assert.match(c.detail, /music-audio/);
    assert.equal(res.results[0].ok, false);
  });
  withHistory([entry(2, { fp: { category: 'music-audio', mechanic: 'toy' } })], () => {
    assert.deepEqual(kinds(check([cand()])), []);
  });
});

test('category cooldown follows config.novelty.categoryCooldownDays', () => {
  withHistory([entry(3, { fp: { category: 'music-audio', mechanic: 'toy' } })], () => {
    assert.deepEqual(kinds(check([cand()])), ['category-cooldown']);
  }, { config: (c) => { c.novelty.categoryCooldownDays = 3; return c; } });
});

test('entries dated today or later never conflict (reruns and upgrades)', () => {
  withHistory([entry(0, { fp: { category: 'music-audio', mechanic: 'instrument' } }), entry(-1, { fp: { category: 'music-audio', mechanic: 'instrument' } })], () => {
    assert.deepEqual(kinds(check([cand()])), []);
  });
});

test('category-saturation: the window ending today holds at most 2 per category', () => {
  const fp = { category: 'music-audio', mechanic: 'toy' };
  withHistory([entry(2, { fp }), entry(4, { fp: { ...fp, mechanic: 'game' } })], () => {
    const res = check([cand()]);
    assert.deepEqual(kinds(res), ['category-saturation']);
    assert.match(res.results[0].conflicts[0].detail, /2x/);
  });
  withHistory([entry(2, { fp }), entry(7, { fp: { ...fp, mechanic: 'game' } })], () => {
    assert.deepEqual(kinds(check([cand()])), [], 'an entry 7 days ago is outside the 7-day window that includes today');
  });
  withHistory([entry(2, { fp }), entry(6, { fp: { ...fp, mechanic: 'game' } })], () => {
    assert.deepEqual(kinds(check([cand()])), ['category-saturation'], 'an entry 6 days ago is inside the window');
  });
  withHistory([entry(3, { fp })], () => {
    assert.deepEqual(kinds(check([cand()])), []);
  });
});

test('category-saturation honours maxPerCategoryIn7Days', () => {
  const fp = { category: 'music-audio', mechanic: 'toy' };
  withHistory([entry(2, { fp }), entry(4, { fp: { ...fp, mechanic: 'game' } })], () => {
    assert.deepEqual(kinds(check([cand()])), []);
  }, { config: (c) => { c.novelty.maxPerCategoryIn7Days = 3; return c; } });
});

test('mechanic-cooldown: within 7 days conflicts, 8 days does not', () => {
  withHistory([entry(7, { fp: { mechanic: 'instrument' } })], () => {
    assert.deepEqual(kinds(check([cand()])), ['mechanic-cooldown']);
  });
  withHistory([entry(8, { fp: { mechanic: 'instrument' } })], () => {
    assert.deepEqual(kinds(check([cand()])), []);
  });
  withHistory([entry(1, { fp: { mechanic: 'instrument' } })], () => {
    assert.deepEqual(kinds(check([cand()])), ['mechanic-cooldown']);
  });
});

test('category+mechanic-repeat: within 30 days conflicts, 31 does not', () => {
  const fp = { category: 'music-audio', mechanic: 'instrument' };
  withHistory([entry(30, { fp })], () => {
    assert.deepEqual(kinds(check([cand()])), ['category+mechanic-repeat']);
  });
  withHistory([entry(31, { fp })], () => {
    assert.deepEqual(kinds(check([cand()])), []);
  });
  withHistory([entry(20, { fp: { category: 'music-audio', mechanic: 'toy' } })], () => {
    assert.deepEqual(kinds(check([cand()])), [], 'same category with a different mechanic is fine after the cooldown');
  });
});

test('tag-overlap: Jaccard of tags and keywords at the threshold, against any past entry', () => {
  // 9 shared tags; |A| = 14 and |B| = 15 give a union of 20, so the Jaccard index is exactly 0.45.
  const shared = Array.from({ length: 9 }, (_, i) => `shared-${i}`);
  const A = { tags: shared.concat(['a1', 'a2', 'a3', 'a4', 'a5']), keywords: [] };
  const B = { tags: shared.concat(['b1', 'b2', 'b3', 'b4', 'b5', 'b6']), keywords: [] };
  assert.equal(jaccard(tagSet(A), tagSet(B)), 0.45);
  withHistory([entry(200, { fp: { category: 'life-food-craft', mechanic: 'calculator', ...B } })], () => {
    const res = check([cand({}, { ...A })]);
    assert.deepEqual(kinds(res), ['tag-overlap'], 'even a very old entry counts');
    assert.match(res.results[0].conflicts[0].detail, /0\.45/);
    // 8 shared of 21 is below the threshold.
    const lower = { tags: shared.slice(0, 8).concat(['a1', 'a2', 'a3', 'a4', 'a5']), keywords: [] };
    assert.deepEqual(kinds(check([cand({}, lower)])), []);
  });
});

test('tag-overlap is case-insensitive and unions tags with keywords', () => {
  withHistory([entry(40, { fp: { category: 'life-food-craft', mechanic: 'calculator', tags: ['Poker', 'GTO', 'ranges'], keywords: ['preflop'] } })], () => {
    const res = check([cand({}, { tags: ['poker', 'gto'], keywords: ['RANGES', 'preflop'] })]);
    assert.deepEqual(kinds(res), ['tag-overlap']);
  });
});

test('title-similar: trigram Jaccard at or above 0.6 against any past entry', () => {
  const past = entry(90, { title: 'Pocket Range Trainer', fp: { category: 'life-food-craft', mechanic: 'calculator' } });
  withHistory([past], () => {
    assert.deepEqual(kinds(check([cand({ title: 'Pocket Range Trainer' })])), ['title-similar']);
    assert.deepEqual(kinds(check([cand({ title: 'pocket-range TRAINERS!' })])), ['title-similar']);
    assert.deepEqual(kinds(check([cand({ title: 'Ocarina for Rainy Days' })])), []);
  });
  const sim = titleSimilarity('Pocket Range Trainer', 'Range Trainer Pocket');
  assert.ok(sim >= 0.6, `word order barely matters for trigrams (${sim})`);
});

test('title-similar threshold follows config', () => {
  withHistory([entry(90, { title: 'Pocket Range Trainer', fp: { category: 'life-food-craft', mechanic: 'calculator' } })], () => {
    assert.deepEqual(kinds(check([cand({ title: 'Pocket Range Trainers' })])), []);
  }, { config: (c) => { c.novelty.titleSimilarityMax = 0.99; return c; } });
});

test('politics-cap: a second political build inside 14 days conflicts', () => {
  const polit = (d) => entry(d, { fp: { category: 'news-politics', mechanic: 'quiz', political: true } });
  withHistory([polit(13)], () => {
    assert.deepEqual(kinds(check([cand({}, { political: true })])), ['politics-cap']);
    assert.deepEqual(kinds(check([cand({}, { political: false })])), [], 'non-political candidates are unaffected');
  });
  withHistory([polit(14)], () => {
    assert.deepEqual(kinds(check([cand({}, { political: true })])), [], '14 days ago is outside the 14-day window that includes today');
  });
  withHistory([polit(1)], () => {
    const res = check([cand({}, { political: true })]);
    assert.ok(kinds(res).includes('politics-cap'));
  });
});

test('politics cap follows config.mix.politicsMaxPer14Days', () => {
  const polit = (d) => entry(d, { fp: { category: 'news-politics', mechanic: 'quiz', political: true } });
  withHistory([polit(5)], () => {
    assert.deepEqual(kinds(check([cand({}, { political: true })])), []);
  }, { config: (c) => { c.mix.politicsMaxPer14Days = 2; return c; } });
});

test('only entries with countsForNovelty:true count for every conflict kind', () => {
  const same = { category: 'music-audio', mechanic: 'instrument', political: true, tags: ['zzz-one', 'zzz-two', 'zzz-three'], keywords: ['zzz-four', 'zzz-five', 'zzz-six'] };
  withHistory([entry(1, { counts: false, title: 'Zebra Quartz Harbor Lens', fp: same }), entry(2, { counts: false, fp: same })], () => {
    assert.deepEqual(kinds(check([cand({}, { political: true })])), []);
  });
});

test('several conflicts are all reported, with a lower score', () => {
  const fp = { category: 'music-audio', mechanic: 'instrument', tags: ['zzz-one', 'zzz-two', 'zzz-three'], keywords: ['zzz-four', 'zzz-five', 'zzz-six'] };
  withHistory([entry(1, { title: 'Zebra Quartz Harbor Lens', fp })], () => {
    const res = check([cand()]);
    const got = new Set(kinds(res));
    for (const k of ['category-cooldown', 'mechanic-cooldown', 'category+mechanic-repeat', 'tag-overlap', 'title-similar']) assert.ok(got.has(k), `${k} missing from ${[...got]}`);
    assert.ok(res.results[0].score < 1, `score ${res.results[0].score}`);
    assert.ok(res.results[0].score >= 0);
  });
});

test('score is higher for more distinct candidates', () => {
  withHistory([entry(40, { title: 'Pocket Range Trainer', fp: { category: 'life-food-craft', mechanic: 'calculator', tags: ['poker', 'gto', 'ranges', 'grid'], keywords: ['preflop', 'equity'] } })], () => {
    const res = check([
      cand({ id: 'far' }),
      cand({ id: 'near', title: 'Range Trainer Pocket Edition' }, { tags: ['poker', 'gto', 'ranges'], keywords: ['preflop', 'icm'] }),
    ]);
    assert.ok(res.results[0].score > res.results[1].score, JSON.stringify(res.results.map((r) => r.score)));
    assert.ok(res.results[0].score > 8);
  });
});

test('invalid fingerprints are reported instead of crashing', () => {
  withHistory([], () => {
    const res = check([
      cand({ id: 'a' }, { category: 'nope' }),
      cand({ id: 'b' }, { mechanic: 'nope' }),
      cand({ id: 'c' }, { tone: ['nope'] }),
      cand({ id: 'd' }, { slot: 'nope' }),
      { id: 'e', title: 'No fingerprint' },
      { id: 'f', fingerprint: fingerprint() },
    ]);
    assert.equal(res.ok, true);
    for (const r of res.results) {
      assert.equal(r.ok, false, r.id);
      assert.ok(r.conflicts.some((c) => c.kind === 'invalid-fingerprint'), r.id);
    }
  });
});

test('results keep candidate order and ids; candidates must be an array', () => {
  withHistory([], () => {
    const res = check([cand({ id: 'x' }), cand({ id: 'y' }), { title: 'no id', fingerprint: cand().fingerprint }]);
    assert.deepEqual(res.results.map((r) => r.id), ['x', 'y', '#2']);
    assert.throws(() => checkCandidates({}, { date: TODAY }), /array/);
    assert.deepEqual(checkCandidates([], { date: TODAY }), { ok: true, results: [] });
    assert.throws(() => checkCandidates([], { date: 'soon' }), /bad date/);
  });
});

test('date defaults to today in the configured timezone (SED_NOW)', () => {
  withHistory([entry(1, { date: '2026-11-09', fp: { category: 'music-audio', mechanic: 'toy' } })], () => {
    process.env.SED_NOW = '2026-11-10T05:00:00Z'; // 00:00 in New York, still Nov 10 locally
    try {
      assert.deepEqual(kinds(checkCandidates([cand()])), ['category-cooldown']);
      process.env.SED_NOW = '2026-11-10T04:30:00Z'; // Nov 9 23:30 in New York
      assert.deepEqual(kinds(checkCandidates([cand()])), [], 'yesterday is now today, so the entry is not in the past');
    } finally {
      delete process.env.SED_NOW;
    }
  });
});

/* ---- mix -------------------------------------------------------------------------------------- */

const words = (s) => s.split(/\s+/).filter(Boolean).length;

test('mix with an empty history owes every slot and allows politics', () => {
  withHistory([], () => {
    const m = mix({ date: TODAY });
    assert.deepEqual(m.owed.sort(), ['currentEvents', 'humor', 'interest', 'wildcard']);
    assert.deepEqual(m.categoryCounts, {});
    assert.deepEqual(m.avoidCategories, []);
    assert.deepEqual(m.avoidMechanics, []);
    assert.equal(m.politicsAllowed, true);
    assert.equal(m.window.days, 14);
    assert.equal(m.window.builds, 0);
    assert.ok(words(m.summary) < 120);
    assert.match(m.summary, /wide open/);
    assert.match(m.summary, /poker/i, 'owed interest slot mentions its note');
  });
});

test('mix reports counts, owed slots, avoid lists and politics', () => {
  const slot = (s) => ({ slot: s });
  withHistory([
    entry(1, { fp: { category: 'cards-odds', mechanic: 'solver', ...slot('interest') } }),
    entry(3, { fp: { category: 'cards-odds', mechanic: 'game', ...slot('interest') } }),
    entry(4, { fp: { category: 'hockey-sports', mechanic: 'visualizer', ...slot('currentEvents') } }),
    entry(9, { fp: { category: 'humor-satire', mechanic: 'toy', ...slot('humor') } }),
    entry(5, { fp: { category: 'news-politics', mechanic: 'quiz', political: true, ...slot('currentEvents') } }),
    entry(2, { counts: false, fp: { category: 'math-puzzle', mechanic: 'puzzle', ...slot('wildcard') } }),
    entry(20, { fp: { category: 'math-puzzle', mechanic: 'puzzle', ...slot('wildcard') } }),
  ], () => {
    const m = mix({ date: TODAY });
    assert.deepEqual(m.categoryCounts, { 'cards-odds': 2, 'hockey-sports': 1, 'humor-satire': 1, 'news-politics': 1 });
    assert.deepEqual(m.slotCounts, { interest: 2, currentEvents: 2, humor: 1, wildcard: 0 });
    assert.deepEqual(m.owed, ['wildcard', 'humor'].sort((a, b) => (a === 'wildcard' ? -1 : 1) - (b === 'wildcard' ? -1 : 1)), 'least recently used first: wildcard 20 days, humor 9 days');
    assert.deepEqual(m.owedDetail.map((o) => o.slot), m.owed);
    assert.equal(m.owedDetail[0].daysSince, 20);
    assert.deepEqual(m.avoidCategories, ['cards-odds'], 'yesterday plus twice this week');
    assert.deepEqual(m.avoidMechanics, ['game', 'quiz', 'solver', 'visualizer']);
    assert.equal(m.politicsAllowed, false);
    assert.ok(words(m.summary) < 120, m.summary);
    assert.match(m.summary, /cards-odds/);
    assert.match(m.summary, /No political/);
    assert.ok(!/\n/.test(m.summary));
  });
});

test('mix owed edge: a slot used 6 days ago is satisfied, 7 days ago is owed', () => {
  const base = (days, slotName) => entry(days, { fp: { slot: slotName, category: 'science-sim', mechanic: 'simulator' } });
  const entries = (interestDays) => [base(interestDays, 'interest'), base(2, 'currentEvents'), base(3, 'humor'), base(4, 'wildcard')];
  withHistory(entries(6), () => assert.deepEqual(mix({ date: TODAY }).owed, []));
  withHistory(entries(7), () => assert.deepEqual(mix({ date: TODAY }).owed, ['interest']));
});

test('mix owed honours config.mix.targets minimums', () => {
  withHistory([entry(2, { fp: { slot: 'interest' } })], () => {
    assert.ok(mix({ date: TODAY }).owed.includes('interest'));
  }, { config: (c) => { c.mix.targets.interest.minPer7Days = 2; return c; } });
});

test('mix politicsAllowed: 14 days ago is outside the cap window', () => {
  const polit = (d) => entry(d, { fp: { category: 'news-politics', political: true, slot: 'currentEvents' } });
  withHistory([polit(13)], () => assert.equal(mix({ date: TODAY }).politicsAllowed, false));
  withHistory([polit(14)], () => assert.equal(mix({ date: TODAY }).politicsAllowed, true));
});

test('mix summary stays under 120 words even with every category on cooldown', () => {
  const cats = ['cards-odds', 'hockey-sports', 'pop-culture', 'news-politics', 'humor-satire', 'science-sim', 'math-puzzle', 'data-viz', 'music-audio', 'generative-art', 'language-text', 'tools-utility', 'games-arcade', 'retro-tech', 'education-explainer', 'modding-games', 'finance-economics', 'life-food-craft', 'weird-experimental'];
  const mechs = ['simulator', 'solver', 'generator', 'game', 'toy', 'visualizer', 'tool'];
  const entries = cats.map((category, i) => entry(1 + (i % 6), { date: dayBefore(1 + i), fp: { category, mechanic: mechs[i % mechs.length], slot: ['interest', 'currentEvents', 'humor', 'wildcard'][i % 4] } }));
  withHistory(entries, () => {
    const m = mix({ date: TODAY });
    assert.equal(m.avoidCategories.length, 19);
    assert.ok(words(m.summary) < 120, `${words(m.summary)} words: ${m.summary}`);
    assert.ok(m.summary.length > 40);
    assert.match(m.summary, /Do not propose/);
  }, { config: (c) => { c.novelty.categoryCooldownDays = 30; return c; } });
});

test('mix ignores fallback entries and entries on or after the date', () => {
  withHistory([entry(1, { counts: false }), entry(0), entry(-2)], () => {
    const m = mix({ date: TODAY });
    assert.equal(m.window.builds, 0);
    assert.deepEqual(m.avoidCategories, []);
  });
});

/* ---- CLI -------------------------------------------------------------------------------------- */

function cli(box, args, env = {}) {
  const r = spawnSync(process.execPath, [NOVELTY_CLI, ...args], { env: { ...process.env, SED_ROOT: box.root, ...env }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('CLI: check and mix print one JSON document', () => {
  withHistory([entry(1, { fp: { category: 'music-audio', mechanic: 'toy' } })], (box) => {
    const file = box.write('cands.json', [cand({ id: 'a' }), cand({ id: 'b', title: 'Totally Other Words' }, { category: 'cards-odds', mechanic: 'solver' })]);
    const res = cli(box, ['check', '--candidates', file, '--date', TODAY]);
    assert.equal(res.code, 0, res.err);
    const out = JSON.parse(res.out);
    assert.equal(out.ok, true);
    assert.equal(out.results.length, 2);
    assert.equal(out.results[0].ok, false);
    assert.equal(out.results[1].ok, true);

    const wrapped = box.write('wrapped.json', { candidates: [cand({ id: 'a' })] });
    assert.equal(JSON.parse(cli(box, ['check', '--candidates', wrapped, '--date', TODAY]).out).results.length, 1);

    const m = cli(box, ['mix', '--date', TODAY]);
    assert.equal(m.code, 0);
    const mo = JSON.parse(m.out);
    assert.equal(mo.ok, true);
    assert.ok(Array.isArray(mo.owed) && typeof mo.summary === 'string');

    const viaNow = JSON.parse(cli(box, ['mix', '--now', '2026-11-10T15:00:00Z']).out);
    assert.equal(viaNow.window.to, '2026-11-09');
  });
});

test('CLI: usage errors exit 2, bad data exits 1', () => {
  withHistory([], (box) => {
    assert.equal(cli(box, []).code, 2);
    assert.equal(cli(box, ['check']).code, 2);
    assert.equal(cli(box, ['check', '--candidates', path.join(box.root, 'missing.json')]).code, 2);
    box.write('bad.json', '{nope');
    const bad = cli(box, ['check', '--candidates', path.join(box.root, 'bad.json')]);
    assert.equal(bad.code, 1);
    assert.equal(JSON.parse(bad.out).ok, false);
    const obj = box.write('obj.json', { not: 'an array' });
    assert.equal(cli(box, ['check', '--candidates', obj]).code, 1);
    assert.equal(cli(box, ['mix', '--date', 'nope']).code, 1);
  });
});

test('importing novelty.mjs has no side effects', () => {
  const r = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(NOVELTY_CLI)}).then(() => console.log('imported'))`], { encoding: 'utf8' });
  assert.equal(r.stdout.trim(), 'imported');
  assert.equal(r.stderr, '');
});

test('fs sanity: the sandbox keeps the real state untouched', () => {
  const real = fs.readFileSync(path.join(REAL_ROOT, 'state', 'history.json'), 'utf8');
  withHistory([entry(1)], () => {});
  assert.equal(fs.readFileSync(path.join(REAL_ROOT, 'state', 'history.json'), 'utf8'), real);
});
