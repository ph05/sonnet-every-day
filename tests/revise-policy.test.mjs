// Tests for the revise policy of a compact (tier 2) day: scripts/lib/revisepolicy.mjs (`state.mjs revise plan`), the config keys
// budget.levels.<level>.reviseLoopsTier2 and revisePolicy with their repo-validator checks, and the numbers it shares with the
// planner of PLAYBOOK Appendix A4 and with ops/workflows/revise.js. The workflow itself (loops in severity order, the working copy,
// promotion only of a strictly better loop) is covered by the revise.js suite of ops/workflows/_selfcheck.mjs.
// Every clock is a fixed instant (America/New_York through etIso), so nothing here depends on when it runs.
import './helpers/env.mjs';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DATE, TEST_CONFIG, makeSandbox, REPO_ROOT } from './helpers/sandbox.mjs';
import { etIso } from './helpers/env.mjs';
import * as rs from '../scripts/lib/runstate.mjs';
import * as rv from '../scripts/lib/revisepolicy.mjs';
import { validateRepo } from '../scripts/validate.mjs';
import { makeSandbox as makeGateSandbox } from './fixtures/gate-helpers.mjs';

const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const LIVE = JSON.parse(read('config.json'));
const PLAYBOOK = read('ops/PLAYBOOK.md');
const iso = (hhmm, date = DATE) => etIso(date, hhmm);
const LEVELS = ['all-in', 'balanced', 'lean', 'minimal'];

// What the expectations in this file are written for: the revise policy and the four budget levels as they shipped with the policy.
// The live config.json is the owner's to tune (revisePolicy, reviseLoops, reviseLoopsTier2), and a red suite stops the kaizen gate, so
// the logic below runs on this frozen copy of the live file; only the first test looks at the live numbers (that they validate).
const SHIPPED_POLICY = Object.freeze({ tier2MinSeverity: 'S2', tier2S3Threshold: 4, minMinutesLeftForRevise: 25, maxLoopsHardCap: 3 });
const SHIPPED_LEVELS = Object.freeze({
  'all-in': { outputTokens: 8000000, defaultEffort: 'max', maxEffortRoles: 'all', reviseLoops: 2, reviseLoopsTier2: 2, reserveForKaizenTokens: 600000 },
  balanced: { outputTokens: 3000000, defaultEffort: 'high', maxEffortRoles: ['architect', 'engineer', 'critic'], reviseLoops: 1, reviseLoopsTier2: 1 },
  lean: { outputTokens: 1500000, defaultEffort: 'high', maxEffortRoles: [], reviseLoops: 0, reviseLoopsTier2: 1, reserveForKaizenTokens: 150000 },
  minimal: { outputTokens: 500000, defaultEffort: 'medium', maxEffortRoles: [], reviseLoops: 0, reviseLoopsTier2: 0, forceTier: 2, reserveForKaizenTokens: 0 },
});
const REAL = structuredClone(LIVE);
REAL.revisePolicy = structuredClone(SHIPPED_POLICY);
REAL.budget.levels = structuredClone(SHIPPED_LEVELS);
const lc = (level, config = REAL) => ({ ...rs.levelConfigFor(config, level), level });

// ---------------------------------------------------------------------------------------
// the pure decision
// ---------------------------------------------------------------------------------------

const PLENTY = 200; // minutesToGraceUntil: 06:10 on a normal day
// slots: 8 pins the wide timetable (the numbers below are A4's at SLOTS=8); the narrow timetable has its own tests.
const decide = (over = {}) => rv.decideRevise({ tier: 2, counts: {}, levelConfig: lc('balanced'), policy: REAL.revisePolicy, minutesToGraceUntil: PLENTY, slots: 8, ...over });
const brief = (p) => [p.decision, p.code, p.loops, p.fixSeverity];

describe('config.json: the revise keys', () => {
  test('the live config carries the policy, every key and every level, and it validates (the numbers themselves are the owner\'s to tune)', () => {
    assert.deepEqual(rv.revisePolicyProblems(LIVE), { errors: [], warnings: [] });
    assert.deepEqual(Object.keys(LIVE.revisePolicy).sort(), Object.keys(rv.DEFAULT_REVISE_POLICY).sort());
    assert.deepEqual(rv.revisePolicyOf(LIVE), { policy: LIVE.revisePolicy, configured: true, warnings: [] });
    for (const l of LEVELS) {
      assert.ok(Number.isInteger(LIVE.budget.levels[l].reviseLoopsTier2), `${l} defines reviseLoopsTier2`);
      assert.equal(rs.levelConfigFor(LIVE, l).reviseLoopsTier2, LIVE.budget.levels[l].reviseLoopsTier2, `${l}: levelConfig carries it, so begin and throttle get print it`);
    }
  });

  test('the shipped numbers, which the rest of this file is written for: levels 2 / 1 / 1 / 0, four policy numbers, the code\'s defaults', () => {
    assert.deepEqual(Object.fromEntries(LEVELS.map((l) => [l, REAL.budget.levels[l].reviseLoopsTier2])), { 'all-in': 2, balanced: 1, lean: 1, minimal: 0 });
    assert.deepEqual(REAL.revisePolicy, { tier2MinSeverity: 'S2', tier2S3Threshold: 4, minMinutesLeftForRevise: 25, maxLoopsHardCap: 3 });
    assert.deepEqual(rv.revisePolicyProblems(REAL), { errors: [], warnings: [] });
    assert.deepEqual(rv.revisePolicyOf(REAL), { policy: REAL.revisePolicy, configured: true, warnings: [] });
    assert.deepEqual(rv.DEFAULT_REVISE_POLICY, REAL.revisePolicy, 'the defaults of a config without the block are the shipped values');
    for (const l of LEVELS) assert.equal(rs.levelConfigFor(REAL, l).reviseLoopsTier2, REAL.budget.levels[l].reviseLoopsTier2, `${l}: levelConfig carries it, so begin and throttle get print it`);
  });

  test('a config written before the policy has no problems and keeps the old behaviour', () => {
    const legacy = structuredClone(REAL);
    delete legacy.revisePolicy;
    for (const l of LEVELS) delete legacy.budget.levels[l].reviseLoopsTier2;
    assert.deepEqual(rv.revisePolicyProblems(legacy), { errors: [], warnings: [] });
    assert.deepEqual(rv.revisePolicyOf(legacy), { policy: rv.DEFAULT_REVISE_POLICY, configured: false, warnings: [] });
    assert.deepEqual(rv.revisePolicyProblems({}), { errors: [], warnings: [] });
    assert.deepEqual(rv.revisePolicyProblems(null), { errors: [], warnings: [] });
    // old rule: a compact day gets no routine revise, only the S1 rescue loop, at every level
    const l = lc('balanced', legacy);
    assert.equal(l.reviseLoopsTier2, undefined);
    assert.deepEqual(brief(decide({ counts: { S2: 3, S3: 9 }, levelConfig: l })), ['skip', 'level', 0, null]);
    const rescue = decide({ counts: { S1: 1 }, levelConfig: l });
    assert.deepEqual(brief(rescue), ['run', 'run', 1, 'S1']);
    assert.equal(rescue.legacy, true);
  });

  test('every damaged value is named', () => {
    const bad = {
      'min severity S4': (c) => { c.revisePolicy.tier2MinSeverity = 'S4'; },
      'min severity text': (c) => { c.revisePolicy.tier2MinSeverity = 'major'; },
      'threshold -1': (c) => { c.revisePolicy.tier2S3Threshold = -1; },
      'threshold 2.5': (c) => { c.revisePolicy.tier2S3Threshold = 2.5; },
      'threshold text': (c) => { c.revisePolicy.tier2S3Threshold = '4'; },
      'minutes negative': (c) => { c.revisePolicy.minMinutesLeftForRevise = -1; },
      'minutes text': (c) => { c.revisePolicy.minMinutesLeftForRevise = '25'; },
      'minutes huge': (c) => { c.revisePolicy.minMinutesLeftForRevise = 601; },
      'hard cap 0': (c) => { c.revisePolicy.maxLoopsHardCap = 0; },
      'hard cap 4': (c) => { c.revisePolicy.maxLoopsHardCap = 4; },
      'unknown key (a typo would silently fall back to the default)': (c) => { c.revisePolicy.tier2MinSeverty = 'S1'; },
      'policy is a list': (c) => { c.revisePolicy = [1]; },
      'policy is text': (c) => { c.revisePolicy = 'S2'; },
      'level loops 4': (c) => { c.budget.levels.balanced.reviseLoopsTier2 = 4; },
      'level loops -1': (c) => { c.budget.levels.lean.reviseLoopsTier2 = -1; },
      'level loops 1.5': (c) => { c.budget.levels.lean.reviseLoopsTier2 = 1.5; },
      'level loops text': (c) => { c.budget.levels.minimal.reviseLoopsTier2 = '0'; },
      'level loops above the hard cap': (c) => { c.revisePolicy.maxLoopsHardCap = 1; },
    };
    for (const [label, mutate] of Object.entries(bad)) {
      const c = structuredClone(REAL);
      mutate(c);
      const { errors } = rv.revisePolicyProblems(c);
      assert.ok(errors.length >= 1 && errors.every((e) => /revisePolicy|reviseLoopsTier2/.test(e)), `${label}: ${JSON.stringify(errors)}`);
    }
    // a level without the key, next to a policy, is a warning (the old rule applies there), not an error
    const c = structuredClone(REAL);
    delete c.budget.levels.lean.reviseLoopsTier2;
    const { errors, warnings } = rv.revisePolicyProblems(c);
    assert.deepEqual(errors, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /budget\.levels\.lean\.reviseLoopsTier2 is missing/);
  });

  test('a damaged policy entry falls back to its default at run time, with a warning, instead of crashing a day', () => {
    const c = structuredClone(REAL);
    c.revisePolicy = { tier2MinSeverity: 'S9', tier2S3Threshold: 6, minMinutesLeftForRevise: 'soon', maxLoopsHardCap: 2 };
    const { policy, configured, warnings } = rv.revisePolicyOf(c);
    assert.deepEqual(policy, { tier2MinSeverity: 'S2', tier2S3Threshold: 6, minMinutesLeftForRevise: 25, maxLoopsHardCap: 2 });
    assert.equal(configured, true);
    assert.equal(warnings.length, 2);
    assert.deepEqual(rv.revisePolicyOf({ revisePolicy: 'x' }).policy, rv.DEFAULT_REVISE_POLICY);
  });

  describe('the repo validator', () => {
    const check = async (mutate) => {
      const box = makeGateSandbox({ config: (c) => mutate(c) ?? c });
      try {
        return await validateRepo({ projects: false });
      } finally {
        box.cleanup();
      }
    };
    const configIssues = (res) => [...res.errors, ...res.warnings].filter((e) => /^config:.*(revisePolicy|reviseLoopsTier2)/.test(e));

    test('accepts the real config, a config without the keys, and 0 as "no tier 2 revise"', async () => {
      assert.deepEqual(configIssues(await check((c) => c)), []);
      assert.deepEqual(configIssues(await check((c) => {
        delete c.revisePolicy;
        for (const l of LEVELS) delete c.budget.levels[l].reviseLoopsTier2;
      })), []);
      // 0 is a legal figure: "this level runs no tier 2 revise" (the S1 rescue still runs)
      assert.deepEqual(configIssues(await check((c) => { c.budget.levels.lean.reviseLoopsTier2 = 0; })), []);
    });

    test('rejects damaged values with an error that names the key, and warns about a level the policy forgot', async () => {
      for (const [label, mutate, key] of [
        ['severity', (c) => { c.revisePolicy.tier2MinSeverity = 'S4'; }, 'revisePolicy.tier2MinSeverity'],
        ['threshold', (c) => { c.revisePolicy.tier2S3Threshold = -2; }, 'revisePolicy.tier2S3Threshold'],
        ['minutes', (c) => { c.revisePolicy.minMinutesLeftForRevise = null; }, 'revisePolicy.minMinutesLeftForRevise'],
        ['cap', (c) => { c.revisePolicy.maxLoopsHardCap = 9; }, 'revisePolicy.maxLoopsHardCap'],
        ['level loops', (c) => { c.budget.levels.balanced.reviseLoopsTier2 = 'one'; }, 'budget.levels.balanced.reviseLoopsTier2'],
        ['typo', (c) => { c.revisePolicy.tier2MinSeverty = 'S2'; }, 'revisePolicy.tier2MinSeverty'],
      ]) {
        const res = await check((c) => { mutate(c); return c; });
        assert.ok(res.errors.some((e) => e.startsWith('config:') && e.includes(key)), `${label}: ${JSON.stringify(res.errors)}`);
        assert.equal(res.ok, false, label);
      }
      const res = await check((c) => { delete c.budget.levels.minimal.reviseLoopsTier2; return c; });
      assert.ok(res.warnings.some((w) => w.includes('budget.levels.minimal.reviseLoopsTier2 is missing')), JSON.stringify(res.warnings));
      assert.equal(res.errors.filter((e) => e.startsWith('config:')).length, 0);
    });
  });
});

describe('decideRevise: the matrix', () => {
  // tier 2, plenty of time. [counts, then the expected [decision, code, loops, fixSeverity] for all-in, balanced, lean, minimal]
  const TIER2 = [
    ['nothing at all', {}, ['skip', 'no-trigger', 0, null], ['skip', 'no-trigger', 0, null], ['skip', 'no-trigger', 0, null], ['skip', 'no-trigger', 0, null]],
    ['S3 below the threshold (3 < 4)', { S3: 3, S4: 9 }, ['skip', 'no-trigger', 0, null], ['skip', 'no-trigger', 0, null], ['skip', 'no-trigger', 0, null], ['skip', 'no-trigger', 0, null]],
    ['S3 at the threshold (4)', { S3: 4 }, ['run', 'run', 2, 'S3'], ['run', 'run', 1, 'S3'], ['run', 'run', 1, 'S3'], ['skip', 'level', 0, null]],
    ['one S2', { S2: 1 }, ['run', 'run', 2, 'S2'], ['run', 'run', 1, 'S2'], ['run', 'run', 1, 'S2'], ['skip', 'level', 0, null]],
    ['the first live day: S2 1, S3 11, S4 8', { S2: 1, S3: 11, S4: 8 }, ['run', 'run', 2, 'S3'], ['run', 'run', 1, 'S3'], ['run', 'run', 1, 'S3'], ['skip', 'level', 0, null]],
    ['one S1', { S1: 1 }, ['run', 'run', 2, 'S2'], ['run', 'run', 1, 'S2'], ['run', 'run', 1, 'S2'], ['run', 'run', 1, 'S1']],
    ['S1 and S2 and S3', { S1: 1, S2: 2, S3: 5 }, ['run', 'run', 2, 'S3'], ['run', 'run', 1, 'S3'], ['run', 'run', 1, 'S3'], ['run', 'run', 1, 'S1']],
    ['S4 only', { S4: 20 }, ['skip', 'no-trigger', 0, null], ['skip', 'no-trigger', 0, null], ['skip', 'no-trigger', 0, null], ['skip', 'no-trigger', 0, null]],
  ];
  for (const [label, counts, ...expected] of TIER2) {
    test(`tier 2, ${label}`, () => {
      LEVELS.forEach((level, i) => {
        const p = decide({ counts, levelConfig: lc(level) });
        assert.deepEqual(brief(p), expected[i], `${level}: ${JSON.stringify(brief(p))} (${p.reason})`);
        assert.equal(p.compact, true);
        assert.equal(p.tier, 2);
      });
    });
  }

  test('tier 1 keeps the old rules: S1 or S2 with the level\'s reviseLoops, the S1 rescue as the floor, S3 never', () => {
    const t1 = (counts, level, over = {}) => brief(decide({ tier: 1, counts, levelConfig: lc(level), ...over }));
    assert.deepEqual(t1({ S2: 1 }, 'all-in'), ['run', 'run', 2, 'S2']);
    assert.deepEqual(t1({ S2: 1 }, 'balanced'), ['run', 'run', 1, 'S2']);
    assert.deepEqual(t1({ S2: 1 }, 'lean'), ['skip', 'level', 0, null], 'S2 with a level that has no revise loops ships as a known issue');
    assert.deepEqual(t1({ S1: 1 }, 'lean'), ['run', 'run', 1, 'S2'], 'but an S1 is rescued at any level');
    assert.deepEqual(t1({ S1: 1 }, 'minimal'), ['run', 'run', 1, 'S2']);
    assert.deepEqual(t1({ S3: 12 }, 'all-in'), ['skip', 'no-trigger', 0, null], 'the S3 trigger is for compact days only');
    assert.deepEqual(t1({}, 'balanced'), ['skip', 'no-trigger', 0, null]);
    assert.equal(decide({ tier: 1, counts: { S2: 1 } }).compact, false);
    assert.equal(decide({ tier: 1, counts: { S2: 1 } }).workflow.seconds, 20);
    assert.equal(decide({ tier: 2, counts: { S2: 1 } }).workflow.seconds, 10);
    // a compact flag on a tier-1 run (a scope-cut, forceTier 2) makes it a compact day
    assert.equal(decide({ tier: 1, compact: true, counts: { S2: 1 } }).tier, 2);
  });

  test('queued extra defects (validator errors) count as S1: they trigger, and they are the floor', () => {
    assert.deepEqual(brief(decide({ counts: {}, extraDefects: 2 })), ['run', 'run', 1, 'S2']);
    assert.deepEqual(brief(decide({ counts: {}, extraDefects: 1, levelConfig: lc('minimal') })), ['run', 'run', 1, 'S1']);
    assert.deepEqual(brief(decide({ tier: 1, counts: {}, extraDefects: 1, levelConfig: lc('lean') })), ['run', 'run', 1, 'S2']);
    assert.equal(decide({ counts: {}, extraDefects: 1 }).trigger.by, 's1');
  });

  test('minutes left: the policy bar (25) for S2 and S3, the planner of A4 alone for the S1 rescue', () => {
    // minutesToGraceUntil m gives MTD = m - 15 and available = m - 50
    const at = (m, counts, over = {}) => decide({ counts, minutesToGraceUntil: m, ...over });
    assert.deepEqual([at(75, { S2: 1 }).decision, at(75, { S2: 1 }).minutes.available], ['run', 25], '25 minutes left meets the bar');
    const late = at(74, { S2: 1 });
    assert.deepEqual([late.decision, late.code, late.minutes.available], ['skip', 'no-time', 24]);
    assert.match(late.reason, /only 24 min/);
    assert.equal(late.blocksShipping, false, 'an S2 that cannot be revised ships as a known issue');
    assert.equal(at(74, { S3: 4 }).decision, 'skip');
    // S1: A4 says revise + package + publish (15 + 12 + 5 = 32) must fit into available + 10, so 22 minutes is the edge
    assert.equal(at(72, { S1: 1 }).decision, 'run');
    assert.equal(at(72, { S1: 1 }).minutes.available, 22);
    const edge = at(71, { S1: 1 });
    assert.deepEqual([edge.decision, edge.code, edge.blocksShipping], ['skip', 'no-time', true], 'an S1 build that cannot be revised is not shippable: Tier 3');
    // tier 1: 30 + 15 + 5 = 50 must fit, available 40 is the edge
    assert.equal(decide({ tier: 1, counts: { S2: 1 }, minutesToGraceUntil: 90 }).decision, 'run');
    assert.equal(decide({ tier: 1, counts: { S2: 1 }, minutesToGraceUntil: 89 }).code, 'no-time');
    // the bar is the config's: lower it and the same moment runs, raise it and it does not
    assert.equal(at(74, { S2: 1 }, { policy: { ...REAL.revisePolicy, minMinutesLeftForRevise: 20 } }).decision, 'run');
    assert.equal(at(100, { S2: 1 }, { policy: { ...REAL.revisePolicy, minMinutesLeftForRevise: 60 } }).code, 'no-time');
    // already past the grace window: no negative minutes in the prose
    assert.match(at(10, { S1: 1 }).note, /planner: 0 min left/);
    // a manual run has no clock (PLAYBOOK 5.5): the planner is not applied and the workflow gets no phase budget
    const manual = at(null, { S2: 1 });
    assert.deepEqual([manual.decision, manual.phaseBudgetMinutes, manual.minutes], ['run', null, null]);
    assert.equal(manual.workflow.phaseBudgetMinutes, null);
  });

  test('the revise budget is the A4 figure, never below one loop, never above the cap of the phase', () => {
    const budget = (m, over = {}) => decide({ counts: { S2: 1 }, minutesToGraceUntil: m, ...over }).phaseBudgetMinutes;
    assert.equal(budget(PLENTY), 40, 'the planner cap of the revise phase');
    assert.equal(budget(75), rv.LOOP_MINUTES, '25 minutes left would leave 8 for revise after package and publish: one loop\'s worth is the floor');
    assert.equal(budget(110), 40, 'available 60 - tail 17 = 43 is above the cap of the phase');
    assert.equal(budget(90), 23, 'available 40 - tail 17');
    // the owner's phase budget for revise (config.phaseBudgetMinutes.revise) caps it further
    assert.equal(budget(PLENTY, { phaseCapMinutes: 20 }), 20);
    assert.equal(budget(PLENTY, { phaseCapMinutes: 90 }), 40, 'but never raises it above the planner\'s 40');
    assert.equal(budget(PLENTY, { phaseCapMinutes: 5 }), rv.LOOP_MINUTES);
    assert.equal(decide({ counts: { S2: 1 }, minutesToGraceUntil: PLENTY }).workflow.phaseBudgetMinutes, 40);
  });

  test('every other reason to skip, and the reasons that are not skips', () => {
    const c = { S2: 1 };
    assert.deepEqual(brief(decide({ counts: c, overCap: true })), ['skip', 'over-cap', 0, null]);
    assert.deepEqual(brief(decide({ counts: c, shipNow: true })), ['skip', 'ship-now', 0, null]);
    assert.deepEqual(brief(decide({ counts: c, usageStop: true })), ['skip', 'usage-stop', 0, null]);
    assert.deepEqual(brief(decide({ counts: c, attemptsExhausted: true })), ['skip', 'attempts', 0, null]);
    // nothing to revise beats every blocker in the reason (the note says why the QA'd build simply ships)
    assert.equal(decide({ counts: {}, overCap: true, shipNow: true }).code, 'no-trigger');
    // an S1 that is blocked is flagged: the build cannot ship (PLAYBOOK 8.6: Tier 3)
    for (const blocker of [{ overCap: true }, { shipNow: true }, { usageStop: true }, { attemptsExhausted: true }, { minutesToGraceUntil: 5 }]) {
      const p = decide({ counts: { S1: 1 }, ...blocker });
      assert.equal(p.decision, 'skip');
      assert.equal(p.blocksShipping, true, JSON.stringify(blocker));
    }
    // tiers 3 and 4 have no revise phase
    for (const tier of [3, 4]) assert.deepEqual(brief(decide({ tier, counts: { S1: 1 } })), ['skip', 'tier', 0, null]);
    assert.equal(decide({ tier: 3, counts: { S1: 1 } }).blocksShipping, false);
    // a report nobody reviewed is neither a skip nor a run: the playbook's first row (rerun qa) comes first
    const held = decide({ counts: { S1: 1, S2: 3 }, unreviewed: true });
    assert.deepEqual([held.decision, held.code, held.run, held.note], ['hold', 'unreviewed', false, null]);
    assert.equal(held.blocksShipping, false, 'a hold decides nothing yet: an S1 in an unreviewed report does not send the day to Tier 3');
    // every plan says in one line what to do with it
    assert.match(decide({ counts: c }).next, /^phase-start revise, arm the watch and launch the revise Workflow with `workflow`/);
    assert.match(decide({ counts: { S1: 1 }, overCap: true }).next, /^Tier 3: an S1 build that cannot be revised is not shippable/);
    assert.match(decide({ counts: {} }).next, /^package \(PLAYBOOK 10\.2\); list the open S2 and S3 defects as known issues/);
    assert.match(decide({ counts: c, overCap: true }).next, /^package/, 'an S2 that cannot be revised simply ships as a known issue');
    assert.match(held.next, /^rerun qa/);
    assert.match(decide({ tier: 4, counts: c }).next, /fallback path/);
  });

  test('the policy knobs: minimum severity, S3 threshold, hard cap', () => {
    const pol = (over) => ({ ...REAL.revisePolicy, ...over });
    // tier2MinSeverity S1: an S2 alone no longer triggers a compact day
    assert.equal(decide({ counts: { S2: 2 }, policy: pol({ tier2MinSeverity: 'S1' }) }).code, 'no-trigger');
    assert.deepEqual(brief(decide({ counts: { S1: 1 }, policy: pol({ tier2MinSeverity: 'S1' }) })), ['run', 'run', 1, 'S1']);
    // S3: any S3 triggers, and the loops reach S3
    assert.deepEqual(brief(decide({ counts: { S3: 1 }, policy: pol({ tier2MinSeverity: 'S3' }) })), ['run', 'run', 1, 'S3']);
    assert.equal(decide({ counts: { S4: 5 }, policy: pol({ tier2MinSeverity: 'S3' }) }).code, 'no-trigger');
    // threshold: 1 means any S3, 0 switches the trigger off
    assert.equal(decide({ counts: { S3: 1 }, policy: pol({ tier2S3Threshold: 1 }) }).decision, 'run');
    assert.equal(decide({ counts: { S3: 50 }, policy: pol({ tier2S3Threshold: 0 }) }).code, 'no-trigger');
    assert.equal(decide({ counts: { S3: 11 }, policy: pol({ tier2S3Threshold: 12 }) }).code, 'no-trigger');
    // the threshold decides how deep the loops reach: with an S2 and 3 S3 the loops stop at S2, with 4 they take S3
    assert.equal(decide({ counts: { S2: 1, S3: 3 } }).fixSeverity, 'S2');
    assert.equal(decide({ counts: { S2: 1, S3: 4 } }).fixSeverity, 'S3');
    // hard cap: whatever the level says
    const loops = (cap, level) => decide({ counts: { S2: 1 }, levelConfig: lc(level), policy: pol({ maxLoopsHardCap: cap }) }).loops;
    assert.deepEqual([loops(1, 'all-in'), loops(2, 'all-in'), loops(3, 'all-in')], [1, 2, 2]);
    assert.equal(decide({ counts: { S2: 1 }, levelConfig: { level: 'x', reviseLoopsTier2: 9 } }).loops, 3, 'even a damaged level cannot exceed 3');
    assert.equal(decide({ counts: { S2: 1 }, levelConfig: { level: 'x', reviseLoopsTier2: -2 } }).code, 'level');
    assert.equal(decide({ counts: { S2: 1 }, levelConfig: { level: 'x', reviseLoopsTier2: '2' } }).legacy, true, 'a text figure is not a figure');
  });

  test('never worse than before: tier 1 decides exactly as the old playbook table, and a compact day revises everywhere the old rescue did', () => {
    // the old PLAYBOOK 8.6 table, written out: does a revise run, how many loops
    const old = ({ tier, counts, extra, level, feasible }) => {
      const s1 = counts.S1 + extra;
      if (tier === 1) {
        if (s1 + counts.S2 > 0 && level.reviseLoops > 0 && feasible) return Math.min(3, level.reviseLoops);
        if (s1 > 0 && feasible) return 1;
        return 0;
      }
      return s1 > 0 && feasible ? 1 : 0; // compact: the workflow ran one rescue loop, for S1 only
    };
    let compared = 0;
    for (const tier of [1, 2]) for (const level of LEVELS) for (const S1 of [0, 1]) for (const S2 of [0, 2]) for (const S3 of [0, 3, 4, 12]) for (const extra of [0, 1]) for (const m of [15, 71, 72, 74, 75, 90, 120, PLENTY]) {
      const counts = { S1, S2, S3, S4: 0 };
      const l = lc(level);
      const typical = rv.PLANNER.TYPICAL[tier];
      const available = m - 15 - rv.PLANNER.RESERVE;
      const feasible = typical.revise + typical.package + typical.publish <= available + rv.PLANNER.SLACK;
      const before = old({ tier, counts, extra, level: l, feasible });
      const now = decide({ tier, counts, extraDefects: extra, levelConfig: l, minutesToGraceUntil: m });
      const label = `tier ${tier} ${level} ${JSON.stringify(counts)} extra ${extra} m ${m}`;
      compared++;
      if (tier === 1) assert.equal(now.loops, before, `${label}: tier 1 must not change`);
      if (before > 0) {
        assert.equal(now.decision, 'run', `${label}: ran before, must run now (${now.reason})`);
        assert.ok(now.loops >= before, `${label}: loops ${now.loops} < ${before}`);
        assert.ok(['S1', 'S2', 'S3'].indexOf(now.fixSeverity) >= 0);
      }
      // and the result is always consistent
      assert.equal(now.run, now.decision === 'run', label);
      assert.ok(now.loops >= 0 && now.loops <= REAL.revisePolicy.maxLoopsHardCap, label);
      assert.equal(now.run, now.loops > 0, label);
      assert.equal(now.fixSeverity !== null, now.run, label);
      if (now.run) assert.ok(now.phaseBudgetMinutes >= rv.LOOP_MINUTES && now.phaseBudgetMinutes <= 40, label);
      assert.equal(now.note === null, now.decision !== 'skip', label);
      if (now.note) assert.match(now.note, /^skipped: [A-Za-z0-9 ,.:;()/+-]+$/, `${label}: the note goes into a shell argument, so it uses a plain alphabet`);
      JSON.parse(JSON.stringify(now));
    }
    assert.equal(compared, 2048, 'the grid: 2 tiers x 4 levels x 2 x 2 x 4 x 2 x 8');
  });

  test('more budget never means fewer loops, and a compact day with a trigger always revises when nothing stands in the way', () => {
    for (const counts of [{ S2: 1 }, { S3: 4 }, { S1: 1 }, { S1: 2, S2: 5, S3: 20 }]) {
      const loops = LEVELS.map((l) => decide({ counts, levelConfig: lc(l) }).loops);
      assert.deepEqual(loops, [...loops].sort((a, b) => b - a), `${JSON.stringify(counts)}: all-in >= balanced >= lean >= minimal, got ${loops}`);
    }
    for (const level of LEVELS.slice(0, 3)) for (const counts of [{ S2: 1 }, { S3: 4 }, { S1: 1 }]) {
      const p = decide({ counts, levelConfig: lc(level) });
      assert.equal(p.decision, 'run', `${level} ${JSON.stringify(counts)}: ${p.reason}`);
    }
  });
});

// ---------------------------------------------------------------------------------------
// the numbers it shares with the planner (A4) and the workflow
// ---------------------------------------------------------------------------------------

describe('shared numbers', () => {
  test('spend shares: a compact day WITH its revise still fits under the workflow cap (capTokens minus the kaizen reserve) at every level', () => {
    const shares = JSON.parse(/```json spend-shares\n([\s\S]*?)\n```/.exec(PLAYBOOK)?.[1] ?? 'null')?.compact;
    assert.ok(shares, 'PLAYBOOK 6.5 carries the machine-readable spend-shares block');
    for (const level of LEVELS) {
      const l = rs.levelConfigFor(REAL, level);
      const cap = l.capTokens - l.reserveForKaizenTokens;
      const through = ['ideate', 'select', 'spec', 'build', 'qa', 'revise'].reduce((a, p) => a + Math.round(shares[p] * l.capTokens), 0);
      assert.ok(through <= cap, `${level}: ideate..revise of a compact day estimate ${through} exceeds the workflow cap ${cap}, so its revise would always be skipped`);
      assert.ok(through + Math.round(shares.package * l.capTokens) <= l.capTokens, `${level}: with package the compact day still fits the usable cap`);
    }
  });

  function a4(env) {
    const m = /### A4 [^\n]*\n[\s\S]*?```bash\n([\s\S]*?)\n```/.exec(PLAYBOOK);
    assert.ok(m, 'PLAYBOOK.md has no snippet A4');
    const lines = m[1].split('\n');
    assert.match(lines[0], /node --input-type=module - <<'EOF'$/);
    const r = spawnSync(process.execPath, ['--input-type=module', '-'], { cwd: REPO_ROOT, env: { ...process.env, SLOTS: '8', ...env }, input: lines.slice(1, -1).join('\n'), encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return JSON.parse(r.stdout);
  }

  test('the timetable follows the agent slots: 8 is the wide table, below 6 the narrow one measured on the 4-CPU container, and the default is this machine', () => {
    assert.deepEqual(rv.plannerFor(8).TYPICAL, rv.PLANNER.TYPICAL);
    assert.equal(rv.plannerFor(8).narrow, false);
    const narrow = rv.plannerFor(2);
    assert.deepEqual([narrow.narrow, narrow.slots, narrow.RESERVE, narrow.LATE_GRACE, narrow.TYPICAL[2].revise, narrow.TYPICAL[2].package], [true, 2, 10, 10, 20, 10]);
    assert.equal(rv.plannerFor(5).narrow, true);
    assert.equal(rv.plannerFor(6).narrow, false);
    assert.equal(rv.plannerFor(undefined).slots, rv.slotsOnThisMachine());
    assert.equal(rv.slotsOnThisMachine(), 8, 'the test env pins SED_AGENT_SLOTS=8');
    process.env.SED_AGENT_SLOTS = '2';
    try { assert.equal(rv.slotsOnThisMachine(), 2); assert.equal(decide({ slots: undefined, counts: { S2: 1 } }).minutes.narrow, true, 'the CLI default follows the env'); } finally { process.env.SED_AGENT_SLOTS = '8'; }
    // the decision carries the timetable it used
    assert.deepEqual([decide({ slots: 2, counts: { S2: 1 } }).minutes.slots, decide({ slots: 2, counts: { S2: 1 } }).minutes.narrow], [2, true]);
    assert.equal(decide({ counts: { S2: 1 } }).minutes.narrow, false);
    // on 2 slots a compact revise needs 20 + 10 + 5 = 35 minutes against the grace window (MTD + 10): 06:10 fits, the 2026-10-11 moment (09:08, 22 minutes to grace) does not
    assert.equal(decide({ slots: 2, counts: { S2: 1 } }).decision, 'run');
    const late = decide({ slots: 2, counts: { S2: 1 }, minutesToGraceUntil: 22 });
    assert.deepEqual([late.decision, late.code, late.minutes.available], ['skip', 'no-time', 17]);
    // a nominal narrow day (qa done about 08:25, 65 minutes to grace) gets its revise with the full 40-minute budget, ending inside the window
    const nominal = decide({ slots: 2, counts: { S2: 1 }, minutesToGraceUntil: 65 });
    assert.deepEqual([nominal.decision, nominal.minutes.available, nominal.phaseBudgetMinutes], ['run', 60, 40]);
    // the S2 bar (25 minutes left) still holds on the narrow clock (available = minutes to grace - 5): 30 minutes to grace is the edge
    assert.equal(decide({ slots: 2, counts: { S2: 1 }, minutesToGraceUntil: 30 }).decision, 'run');
    assert.deepEqual([decide({ slots: 2, counts: { S2: 1 }, minutesToGraceUntil: 29 }).decision, decide({ slots: 2, counts: { S2: 1 }, minutesToGraceUntil: 29 }).code], ['skip', 'no-time']);
  });

  test('A4 and the policy are one timetable: the revise tail, its cap, the reserve, the late-phase grace and the slack agree at both slot counts (the narrow compact day of 2026-10-13: spec 35, qa 45, caps 50 and 55)', () => {
    const m = /### A4 [^\n]*\n[\s\S]*?```bash\n([\s\S]*?)\n```/.exec(PLAYBOOK);
    assert.ok(m, 'PLAYBOOK.md has no snippet A4');
    const src = m[1];
    const pair = (name) => {
      const t = new RegExp(`const ${name} = NARROW\\n\\s*\\? (\\{[\\s\\S]*?\\})\\n\\s*: (\\{[\\s\\S]*?\\});`).exec(src);
      assert.ok(t, `A4 has no ${name}`);
      return { narrow: new Function(`return ${t[1]}`)(), wide: new Function(`return ${t[2]}`)() };
    };
    const typical = pair('TYPICAL');
    const cap = pair('CAP');
    const reserve = /const RESERVE = NARROW \? (\d+) : (\d+);/.exec(src);
    const slack = /const SLACK = (\d+);/.exec(src);
    const lateGrace = /const available = LATE\.includes\(FROM\) \? MTD \+ (\d+) : MTD - RESERVE;/.exec(src);
    assert.ok(reserve && slack && lateGrace, 'A4 keeps RESERVE, SLACK and the late-phase grace in their usual form');
    for (const [slots, table, capOf, res] of [[2, typical.narrow, cap.narrow, Number(reserve[1])], [8, typical.wide, cap.wide, Number(reserve[2])]]) {
      const P = rv.plannerFor(slots);
      for (const tier of [1, 2]) {
        for (const phase of ['revise', 'package', 'publish']) assert.equal(P.TYPICAL[tier][phase], table[tier][phase], `${slots} slots, tier ${tier}: ${phase}`);
      }
      assert.equal(P.CAP_REVISE, capOf.revise, `${slots} slots: the revise cap`);
      assert.equal(P.RESERVE, res, `${slots} slots: the reserve`);
      assert.equal(P.SLACK, Number(slack[1]), `${slots} slots: the slack`);
    }
    assert.equal(rv.plannerFor(2).LATE_GRACE, Number(lateGrace[1]), 'from qa on a narrow day is measured against the grace window, in both');
    // the numbers that moved on 2026-10-13 live in A4 only (revise plan needs only the tail), and they are these
    assert.deepEqual([typical.narrow[2].spec, typical.narrow[2].qa, cap.narrow.spec, cap.narrow.qa], [35, 45, 50, 55]);
    assert.deepEqual([typical.wide[2].spec, typical.wide[2].qa, cap.wide.spec, cap.wide.qa], [12, 12, 35, 30], 'the wide day is unchanged');
    // and they reach revise plan only through the clock: a narrow qa that ends later leaves less time, never a different tail
    const atQaEnd = (minutesToGraceUntil) => decide({ slots: 2, counts: { S2: 1 }, minutesToGraceUntil });
    assert.deepEqual([atQaEnd(60).decision, atQaEnd(60).minutes.need, atQaEnd(60).minutes.available], ['run', 35, 55]);
  });

  test('revise.js and the policy agree on the loop time and the loop ceiling', () => {
    const src = read('ops/workflows/revise.js');
    assert.equal(Number(/const MINUTES = \{ loop: (\d+) \}/.exec(src)?.[1]), rv.LOOP_MINUTES);
    assert.match(src, /CFG\.revisePolicy\.maxLoopsHardCap/, 'the workflow reads the hard cap from the config it is given');
    assert.match(src, /HARD_CAP = Math\.max\(1, Math\.min\(3,/, 'and clamps it to 3 like MAX_LOOPS');
    assert.equal(rv.MAX_LOOPS, 3);
  });

  test('the minutes arithmetic is the planner of Appendix A4 with REVISE=1, at both tiers and at both slot counts', () => {
    for (const slots of [8, 2]) for (const tier of [1, 2]) for (const m of [0, 60, 71, 72, 89, 90, 120, 245]) {
      const mtd = m - 15;
      const plan = a4({ MTD: String(mtd), TIER: String(tier), PHASE: 'revise', REVISE: '1', SLOTS: String(slots) });
      assert.deepEqual([plan.slots, plan.narrow], [slots, slots < 6], `A4 reports the slots it planned for`);
      const mine = decide({ tier, counts: { S1: 1 }, minutesToGraceUntil: m, slots }); // an S1 rescue: only the planner decides
      assert.equal(mine.minutes.available, plan.available, `tier ${tier} m ${m}: available`);
      assert.equal(mine.minutes.need, plan.needNow, `tier ${tier} m ${m}: need`);
      assert.equal(mine.minutes.feasible, plan.feasible, `tier ${tier} m ${m}: feasible`);
      assert.equal(mine.decision === 'run', plan.feasible, `tier ${tier} m ${m}: the S1 rescue runs exactly when A4 says it fits`);
      // A4's phase budget, where A4 stays at this tier and the figure leaves room for a loop (below that the policy grants one loop's worth)
      if (mine.decision === 'run' && plan.suggestTier === tier && plan.phaseBudgetMinutes >= rv.LOOP_MINUTES) assert.equal(mine.phaseBudgetMinutes, plan.phaseBudgetMinutes, `tier ${tier} m ${m}: budget`);
      if (mine.decision === 'run') assert.ok(mine.phaseBudgetMinutes >= Math.min(plan.phaseBudgetMinutes, 40), `tier ${tier} m ${m}: never less than A4 grants`);
    }
  });
});

// ---------------------------------------------------------------------------------------
// the CLI: state.mjs revise plan, in a sandbox
// ---------------------------------------------------------------------------------------

describe('state.mjs revise plan', () => {
  const OVERRIDE_UNTIL = '2026-10-11T19:00:00-04:00';
  /** The frozen test config with the real policy and the real tier-2 loops (the frozen levels carry no reviseLoopsTier2). */
  const policyConfig = (over = {}) => {
    const c = structuredClone(TEST_CONFIG);
    c.revisePolicy = structuredClone(REAL.revisePolicy);
    for (const l of LEVELS) c.budget.levels[l].reviseLoopsTier2 = REAL.budget.levels[l].reviseLoopsTier2;
    c.phaseBudgetMinutes = { revise: 90 };
    return Object.assign(c, over);
  };
  const boxes = [];
  test.after(() => boxes.forEach((b) => b.cleanup()));
  const sandbox = (config = policyConfig()) => {
    const b = makeSandbox({ config });
    boxes.push(b);
    return b;
  };
  const NOW = (hhmm, date = DATE) => ['--now', iso(hhmm, date)];
  const st = (box, args, hhmm, date = DATE) => box.state([...args, '--date', date, ...NOW(hhmm, date), '--no-fetch']);
  const ok = (r) => {
    assert.equal(r.code, 0, `exit ${r.code}: ${r.stdout}${r.stderr}`);
    assert.ok(r.json && r.json.__unparseable === undefined, r.stdout);
    return r.json;
  };
  const S = 'sP';
  /**
   * A run that finished every phase up to and including qa and waits at revise, as a compact day (a scope-cut raised the target to 2).
   * One `begin`, then the run file is completed directly: walking twelve phase commands per sandbox would only add process starts.
   */
  function atQa(box, { compact = true, role = 'primary', session = S, target } = {}) {
    ok(st(box, ['begin', '--role', role, '--session', session, ...(target ? ['--target-tier', String(target)] : [])], '03:55'));
    const run = box.run();
    const phases = ['preflight', 'ideate', 'select', 'spec', 'build', 'qa'];
    run.phasesDone = phases.map((phase) => ({ phase, at: iso('04:01'), by: role, note: 'ok' }));
    run.attempts = Object.fromEntries(phases.map((phase) => [phase, 1]));
    run.phase = 'revise';
    run.phaseStartedAt = { ...run.phaseStartedAt, revise: iso('04:01') };
    if (compact && role !== 'manual') {
      run.targetTier = 2;
      run.directives.push({ kind: 'scope-cut', tier: 2, by: role, at: iso('06:00'), ack: false });
    }
    box.write(`state/runs/${DATE}.json`, run);
  }
  const report = (counts, extra = {}) => {
    const defects = [];
    for (const sev of ['S1', 'S2', 'S3', 'S4']) for (let i = 0; i < (counts[sev] ?? 0); i++) {
      defects.push({ id: `d${String(defects.length + 1).padStart(2, '0')}`, severity: sev, owner: 'artisan', file: 'index.html', title: `${sev} problem ${i + 1}`, detail: 'detail', evidence: 'steps', suggestedFix: 'fix' });
    }
    return { schema: 1, date: DATE, revision: 0, verdict: counts.S1 || counts.S2 ? 'revise' : 'ship', counts: { S1: 0, S2: 0, S3: 0, S4: 0, ...counts }, browser: { ok: true, error: null }, defects, ...extra };
  };
  const putReport = (box, counts, extra) => box.write(`work/${DATE}/qa/report.json`, report(counts, extra));
  const plan = (box, hhmm, extra = []) => ok(st(box, ['revise', 'plan', ...extra], hhmm));
  const FIRST_DAY = { S2: 1, S3: 11, S4: 8 };

  test('the first live day: one S2 and eleven S3 on a compact day now get a revise that reaches S3, with the workflow arguments printed', () => {
    const box = sandbox();
    atQa(box);
    putReport(box, FIRST_DAY);
    const p = plan(box, '07:32');
    assert.deepEqual([p.decision, p.run, p.code, p.tier, p.compact, p.level], ['run', true, 'run', 2, true, 'balanced']);
    assert.deepEqual(p.counts, { S1: 0, S2: 1, S3: 11, S4: 8 });
    assert.deepEqual(p.workflow, { reviseLoops: 1, compact: true, tier: 2, fixSeverity: 'S3', seconds: 10, phaseBudgetMinutes: 40 });
    assert.deepEqual(p.trigger, { by: 'severity', severityHits: 1, s3Threshold: 4, s3ThresholdHit: true, minSeverity: 'S2' });
    assert.deepEqual(p.minutes, { toGraceUntil: 118, mtd: 103, available: 68, tail: 17, need: 32, slack: 10, feasible: true, min: 25, cap: 40, budget: 40, slots: 8, narrow: false });
    assert.deepEqual([p.targetTier, p.manual, p.blocksShipping, p.note], [2, false, false, null]);
    assert.deepEqual(p.policy, { ...REAL.revisePolicy, configured: true });
    assert.deepEqual(p.levelConfig, { level: 'balanced', reviseLoops: 1, reviseLoopsTier2: 1 });
    assert.equal(p.applied, undefined, 'a plan that runs changes nothing');
    assert.deepEqual(box.run().phasesDone.map((e) => e.phase), ['preflight', 'ideate', 'select', 'spec', 'build', 'qa']);
  });

  test('every level: all-in 2 loops, balanced 1, lean 1, minimal none (but the S1 rescue)', () => {
    const want = { 'all-in': ['run', 2, 'S3'], balanced: ['run', 1, 'S3'], lean: ['run', 1, 'S3'], minimal: ['skip', 0, null] };
    for (const level of LEVELS) {
      const box = sandbox();
      atQa(box);
      ok(st(box, ['throttle', 'set', '--level', level, '--reason', 'test'], '03:50'));
      putReport(box, FIRST_DAY);
      const p = plan(box, '07:32');
      assert.deepEqual([p.decision, p.loops, p.fixSeverity], want[level], level);
      assert.equal(p.level, level);
      if (level === 'minimal') assert.equal(p.code, 'level');
      // an S1 is rescued at every level
      putReport(box, { S1: 1, S2: 1 });
      const s1 = plan(box, '07:32');
      assert.equal(s1.decision, 'run', `${level}: the S1 rescue is the floor`);
      assert.equal(s1.fixSeverity, level === 'minimal' ? 'S1' : 'S2');
    }
  });

  test('the owner override: while it lasts the all-in loops apply, whatever level is stored; after it, the stored level', () => {
    const cfg = policyConfig();
    cfg.budget.ownerOverride = { until: OVERRIDE_UNTIL, level: 'all-in', note: 'owner lifted the budget' };
    const box = sandbox(cfg);
    atQa(box);
    ok(st(box, ['throttle', 'set', '--level', 'minimal', '--reason', 'test'], '03:50'));
    putReport(box, FIRST_DAY);
    const inside = plan(box, '07:32');
    assert.deepEqual([inside.decision, inside.loops, inside.fixSeverity, inside.level, inside.storedLevel], ['run', 2, 'S3', 'all-in', 'minimal']);
    assert.equal(inside.override.active, true);
    assert.equal(inside.levelConfig.reviseLoopsTier2, 2);
    // an S1 under the override also gets the full tier 2 reach, not the bare rescue of the stored minimal level
    putReport(box, { S1: 1 });
    assert.deepEqual([plan(box, '07:32').loops, plan(box, '07:32').fixSeverity], [2, 'S2']);
    putReport(box, FIRST_DAY);
    // after the window (Sunday 19:00 EDT = 23:00Z) the stored minimal level applies again: no tier 2 revise for S2 and S3
    const after = ok(box.state(['revise', 'plan', '--date', DATE, '--now', '2026-10-11T23:00:01Z', '--mtd', '100', '--no-fetch']));
    assert.deepEqual([after.decision, after.code, after.level, after.override.active, after.override.expired], ['skip', 'level', 'minimal', false, true]);
    // without an override block nothing about the output changes
    const plain = sandbox();
    atQa(plain);
    putReport(plain, FIRST_DAY);
    assert.equal('override' in plan(plain, '07:32'), false);
  });

  test('--apply records a skip the way the playbook does: phase-done with a "skipped: ..." note, so revise is never forgotten', () => {
    const box = sandbox();
    atQa(box);
    putReport(box, { S3: 2, S4: 5 });
    const p = ok(st(box, ['revise', 'plan', '--apply', '--session', S, '--role', 'primary'], '07:32'));
    assert.deepEqual([p.decision, p.code], ['skip', 'no-trigger']);
    assert.match(p.note, /^skipped: no S1\/S2 defects and the S3 count 2 is below 4$/);
    assert.deepEqual([p.applied.phase, p.applied.next, p.applied.alreadyDone], ['revise', 'package', false]);
    const entry = box.run().phasesDone.find((e) => e.phase === 'revise');
    assert.equal(entry.note, p.note);
    assert.equal(entry.by, 'primary');
    assert.equal(box.run().phase, 'package');
    // a second call knows revise is done and writes nothing
    const again = ok(st(box, ['revise', 'plan', '--apply', '--session', S, '--role', 'primary'], '07:33'));
    assert.deepEqual([again.code, again.decision, again.applied], ['done', 'skip', undefined]);
    assert.equal(box.run().phasesDone.filter((e) => e.phase === 'revise').length, 1);
    // without --apply nothing is written either
    const other = sandbox();
    atQa(other);
    putReport(other, {});
    const dry = plan(other, '07:32');
    assert.equal(dry.decision, 'skip');
    assert.equal(other.run().phasesDone.some((e) => e.phase === 'revise'), false);
    // a displaced session cannot record it
    const stale = st(other, ['revise', 'plan', '--apply', '--session', 'someone-else', '--role', 'primary'], '07:34');
    assert.equal(stale.code, 1);
    assert.match(stale.json.error, /lease is held by/);
  });

  test('a run goes through phase-start and phase-done like every other phase; the day continues at package', () => {
    const box = sandbox();
    atQa(box);
    putReport(box, { S2: 2 });
    const p = plan(box, '07:32');
    assert.equal(p.decision, 'run');
    const start = ok(st(box, ['phase-start', '--phase', 'revise', '--session', S], '07:33'));
    assert.deepEqual([start.attempt, start.overLimit, start.targetTier], [1, false, 2]);
    assert.equal(box.run().phase, 'revise');
    assert.equal(plan(box, '07:34').decision, 'run', 'still undecided work while the phase runs');
    const done = ok(st(box, ['phase-done', '--phase', 'revise', '--note', 'revise: S1=0 S2=0 left', '--session', S, '--role', 'primary'], '07:50'));
    assert.deepEqual([done.next, done.phasesDone.includes('revise')], ['package', true]);
    const after = plan(box, '07:51');
    assert.deepEqual([after.decision, after.code, after.run], ['skip', 'done', false]);
  });

  test('a revise that is started again after it was recorded (the rerun of a rescue) is planned again, not reported as done', () => {
    const box = sandbox();
    atQa(box);
    putReport(box, { S3: 2 });
    assert.equal(ok(st(box, ['revise', 'plan', '--apply', '--session', S, '--role', 'primary'], '07:32')).decision, 'skip');
    assert.equal(box.run().phase, 'package');
    assert.deepEqual(plan(box, '07:33').code, 'done', 'before the restart: recorded, go on to package');
    // a QA rerun finds an S1 and the playbook starts the revise phase once more (PLAYBOOK 4.1: a skipped phase runs again)
    putReport(box, { S1: 1 });
    ok(st(box, ['phase-start', '--phase', 'revise', '--session', S], '07:40'));
    assert.equal(box.run().phase, 'revise');
    const again = plan(box, '07:41');
    assert.deepEqual([again.decision, again.code, again.run, again.rescue], ['run', 'run', true, true]);
  });

  test('time: the policy bar on the clock, the S1 rescue on the planner alone', () => {
    const box = sandbox();
    atQa(box);
    putReport(box, { S2: 1 });
    assert.equal(plan(box, '08:15').decision, 'run', 'minutesToGraceUntil 75: 25 minutes left');
    const late = plan(box, '08:16');
    assert.deepEqual([late.decision, late.code, late.minutes.available], ['skip', 'no-time', 24]);
    putReport(box, { S1: 1 });
    assert.equal(plan(box, '08:18').decision, 'run', 'an S1 still fits (available 22)');
    const gone = plan(box, '08:19');
    assert.deepEqual([gone.decision, gone.blocksShipping], ['skip', true]);
    // --mtd hands the planner input in directly (minutesToGraceUntil - 15)
    assert.equal(plan(box, '23:00', ['--mtd', '100']).decision, 'run');
    assert.equal(st(box, ['revise', 'plan', '--mtd', 'soon'], '08:00').code, 2);
  });

  test('a manual run has no clock: it plans the same way at any hour and passes no phase budget', () => {
    const box = sandbox();
    atQa(box, { role: 'manual', session: 'sM', target: 2 });
    putReport(box, FIRST_DAY);
    const p = plan(box, '10:05');
    assert.deepEqual([p.decision, p.manual, p.minutes, p.phaseBudgetMinutes], ['run', true, null, null]);
    assert.equal(p.workflow.phaseBudgetMinutes, null);
    // and a past date is not "end of day" for it either
    const past = ok(box.state(['revise', 'plan', '--date', DATE, '--now', '2026-10-12T15:00:00Z', '--no-fetch']));
    assert.equal(past.decision, 'run');
    // an explicit --mtd still applies to it
    const told = plan(box, '10:05', ['--mtd', '5']);
    assert.deepEqual([told.decision, told.code, told.minutes.available], ['skip', 'no-time', -30]);
  });

  test('what blocks a revise: a ship-now directive, a usage stop, spend over the cap, used-up attempts', () => {
    // ship-now
    let box = sandbox();
    atQa(box);
    putReport(box, { S1: 1 });
    ok(st(box, ['directive', '--kind', 'ship-now', '--tier', '2', '--by', 'wdB'], '06:50'));
    let p = plan(box, '07:00');
    assert.deepEqual([p.code, p.blocksShipping], ['ship-now', true]);
    ok(st(box, ['ack-directive', '--kind', 'ship-now'], '07:01'));
    assert.equal(plan(box, '07:02').decision, 'run', 'an acknowledged directive no longer blocks');
    // the usual ship-now names tier 3 or 4: that raises the run's target, and a fallback tier has no revise phase at all
    ok(st(box, ['directive', '--kind', 'ship-now', '--tier', '3', '--by', 'wdB'], '07:03'));
    p = plan(box, '07:04');
    assert.deepEqual([p.code, p.tier, p.targetTier, p.compact], ['tier', 3, 3, false]);
    assert.match(p.reason, /ship-now directive or a degrade/);
    // usage stop (latched on the run by `usage observe`)
    box = sandbox();
    atQa(box);
    putReport(box, { S2: 1 });
    const run = box.run();
    run.usageStop = { at: iso('06:30'), reason: 'status rejected (five_hour)', resetsAt: null, rateLimitType: 'five_hour' };
    box.write(`state/runs/${DATE}.json`, run);
    assert.equal(plan(box, '07:00').code, 'usage-stop');
    // over the cap
    box = sandbox();
    atQa(box);
    putReport(box, { S2: 1 });
    ok(st(box, ['spend', '--tokens', '9999999', '--calls', '1', '--phase', 'build', '--session', S], '06:30'));
    p = plan(box, '07:00');
    assert.equal(p.code, 'over-cap');
    // attempts: phase-start counts an attempt before the Workflow runs, so the retry about to be relaunched (attempt 2 of 2) still plans as
    // a run; only a start beyond maxAttemptsPerPhase (phase-start answered overLimit) makes the plan give up
    box = sandbox();
    atQa(box);
    putReport(box, { S2: 1 });
    ok(st(box, ['phase-start', '--phase', 'revise', '--session', S], '07:00'));
    assert.equal(plan(box, '07:10').decision, 'run', 'one attempt used: a retry is allowed');
    const second = ok(st(box, ['phase-start', '--phase', 'revise', '--session', S], '07:11'));
    assert.equal(second.overLimit, false);
    assert.equal(plan(box, '07:12').decision, 'run', 'the retry\'s relaunch asks the plan for its budget after its phase-start');
    const third = ok(st(box, ['phase-start', '--phase', 'revise', '--session', S], '07:13'));
    assert.equal(third.overLimit, true);
    p = plan(box, '07:14');
    assert.deepEqual([p.code, p.decision], ['attempts', 'skip']);
    assert.match(p.reason, /pre-revise build/);
  });

  test('a revise that never finishes still ends at package with the QA\'d build; an S1 build goes to Tier 3 (the state machine side of "ship the pre-revise build")', () => {
    // S2 and S3 only: the policy says run, the Workflow stalls twice, the primary dies, a watchdog arrives
    let box = sandbox();
    atQa(box);
    putReport(box, FIRST_DAY);
    box.write(`work/${DATE}/build/site/index.html`, '<!doctype html><title>x</title>');
    assert.equal(plan(box, '06:00').decision, 'run');
    ok(st(box, ['phase-start', '--phase', 'revise', '--session', S], '06:00'));
    ok(st(box, ['phase-start', '--phase', 'revise', '--session', S], '06:50'));
    const take = ok(st(box, ['begin', '--role', 'wdB', '--session', 'sB'], '07:30'));
    assert.deepEqual([take.action, take.resumePhase, take.targetTier, take.builtSiteAvailable], ['takeover', 'package', 2, true]);
    assert.equal(box.run().phasesDone.find((e) => e.phase === 'revise').skipped, true, 'revise is recorded as skipped, so nothing walks back to it');
    assert.equal(ok(st(box, ['status'], '07:31')).qaBlock, null, 'the QA report is the one QA wrote: it allows shipping');
    // the same stall with an S1 in the QA report: the build is not shippable, the day degrades to Tier 3
    box = sandbox();
    atQa(box);
    putReport(box, { S1: 1, S2: 2 });
    box.write(`work/${DATE}/build/site/index.html`, '<!doctype html><title>x</title>');
    ok(st(box, ['phase-start', '--phase', 'revise', '--session', S], '06:00'));
    ok(st(box, ['phase-start', '--phase', 'revise', '--session', S], '06:50'));
    const t3 = ok(st(box, ['begin', '--role', 'wdB', '--session', 'sB'], '07:30'));
    assert.equal(t3.targetTier, 3);
    assert.notEqual(ok(st(box, ['status'], '07:31')).qaBlock, null);
  });

  test('reports that cannot be decided on: unreviewed, unreadable, missing; and the marker of a missing review is not a defect', () => {
    const box = sandbox();
    atQa(box);
    // unreviewed: the critic never looked. The marker is an S2 in the report's own counts but nothing a fix agent can repair
    box.write(`work/${DATE}/qa/report.json`, report({ S2: 1 }, { unreviewed: true, defects: [{ id: 'd01', severity: 'S2', kind: 'no-critic-review', owner: 'architect', file: '', title: 'No critic review' }] }));
    let p = plan(box, '07:32');
    assert.deepEqual([p.decision, p.code, p.note], ['hold', 'unreviewed', null]);
    assert.equal(p.qa.unreviewed, true);
    assert.deepEqual(p.counts, { S1: 0, S2: 0, S3: 0, S4: 0 }, 'the marker is not counted');
    // a marker next to a real defect: only the real one counts
    box.write(`work/${DATE}/qa/report.json`, report({ S3: 1 }, { defects: [{ id: 'd01', severity: 'S2', kind: 'no-critic-review', title: 'x' }, { id: 'd02', severity: 'S3', owner: 'artisan', file: 'index.html', title: 'y' }] }));
    p = plan(box, '07:32');
    assert.deepEqual([p.decision, p.counts.S2, p.counts.S3], ['hold', 0, 1]);
    // unreadable
    box.write(`work/${DATE}/qa/report.json`, '{ not json');
    p = plan(box, '07:32');
    assert.deepEqual([p.decision, p.code, p.note], ['hold', 'bad-report', null]);
    assert.match(p.reason, /unreadable/);
    // missing (QA was skipped or failed): nothing to revise
    fs.rmSync(path.join(box.root, 'work', DATE, 'qa', 'report.json'));
    p = plan(box, '07:32');
    assert.deepEqual([p.decision, p.code, p.note], ['skip', 'no-report', 'skipped: no QA report']);
    // counts come from the defect records when there are some, from the report's counts when there are none (a trimmed fixture)
    box.write(`work/${DATE}/qa/report.json`, { ...report({}), counts: { S1: 0, S2: 2, S3: 0, S4: 0 }, defects: [] });
    assert.equal(plan(box, '07:32').counts.S2, 2);
  });

  test('extra defects queued by the build\'s trial stage count as S1, at any level', () => {
    const box = sandbox();
    atQa(box);
    ok(st(box, ['throttle', 'set', '--level', 'minimal', '--reason', 'test'], '03:50'));
    putReport(box, {});
    assert.equal(plan(box, '07:32').decision, 'skip');
    box.write(`work/${DATE}/qa/extra-defects.json`, [{ title: 'validate: missing viewport meta', detail: 'index.html has no viewport meta' }, { id: 'x', severity: 'S1' }]);
    const p = plan(box, '07:32');
    assert.deepEqual([p.decision, p.extraDefects, p.fixSeverity, p.trigger.by], ['run', 1, 'S1', 's1'], 'only entries with a title or detail count');
    box.write(`work/${DATE}/qa/extra-defects.json`, '{{');
    const bad = plan(box, '07:32');
    assert.equal(bad.decision, 'skip');
    assert.match(bad.warnings.join(' '), /extra-defects\.json is unreadable/);
  });

  test('extra defects queued under work/<D>/build survive the qa retry wipe (PLAYBOOK 8.5): the old qa/ location did not', () => {
    const box = sandbox();
    atQa(box);
    ok(st(box, ['throttle', 'set', '--level', 'minimal', '--reason', 'test'], '03:50'));
    putReport(box, {});
    const defect = [{ title: 'validate: missing viewport meta', detail: 'index.html has no viewport meta' }];
    // the old place: the qa retry of PLAYBOOK 6.7 and the phase watch run `rm -rf work/<D>/qa` (stagingDirs('qa')), and the queue is gone
    box.write(`work/${DATE}/qa/extra-defects.json`, defect);
    assert.equal(plan(box, '07:32').decision, 'run');
    assert.deepEqual(rs.stagingDirs('qa'), ['qa']);
    fs.rmSync(path.join(box.root, 'work', DATE, 'qa'), { recursive: true, force: true });
    putReport(box, {});
    assert.equal(plan(box, '07:32').decision, 'skip', 'the wipe lost the queued S1');
    // the new place: the same wipe leaves it, so revise still runs for the build's validator error
    box.write(`work/${DATE}/build/extra-defects.json`, defect);
    fs.rmSync(path.join(box.root, 'work', DATE, 'qa'), { recursive: true, force: true });
    putReport(box, {});
    const p = plan(box, '07:32');
    assert.deepEqual([p.decision, p.extraDefects, p.fixSeverity], ['run', 1, 'S1']);
    // both files count, and a broken one is named in the warning
    box.write(`work/${DATE}/qa/extra-defects.json`, defect);
    assert.equal(plan(box, '07:32').extraDefects, 2);
    box.write(`work/${DATE}/build/extra-defects.json`, '{{');
    assert.match(plan(box, '07:32').warnings.join(' '), /build\/extra-defects\.json is unreadable/);
    assert.match(PLAYBOOK, /save to `work\/<D>\/build\/extra-defects\.json`/);
  });

  test('tier handling: --tier overrides the run, tiers 3 and 4 have no revise, a full build uses reviseLoops and A4\'s 20 minute tail', () => {
    const box = sandbox();
    atQa(box, { compact: false });
    putReport(box, { S2: 1 });
    let p = plan(box, '07:32');
    assert.deepEqual([p.tier, p.compact, p.decision, p.loops, p.fixSeverity], [1, false, 'run', 1, 'S2'], 'a full build: the old rule, reviseLoops of the level');
    assert.equal(p.minutes.need, 50);
    putReport(box, { S3: 9 });
    assert.equal(plan(box, '07:32').code, 'no-trigger', 'S3 alone never revises a full build');
    assert.equal(plan(box, '07:32', ['--tier', '2']).decision, 'run', 'but it does revise a compact one');
    p = plan(box, '07:32', ['--tier', '3', '--apply', '--session', S, '--role', 'primary']);
    assert.deepEqual([p.code, p.tier, p.compact, p.applied], ['tier', 3, false, undefined]);
    assert.equal(box.run().phasesDone.some((e) => e.phase === 'revise'), false, 'a fallback tier has no revise phase to record');
    assert.equal(st(box, ['revise', 'plan', '--tier', '9'], '07:32').code, 2);
    assert.equal(st(box, ['revise', 'nope'], '07:32').code, 2);
    // no run at all
    // a fallback target never reads the report
    const fall = sandbox();
    ok(st(fall, ['begin', '--role', 'primary', '--session', S], '03:55'));
    ok(st(fall, ['directive', '--kind', 'ship-now', '--tier', '3', '--by', 'wdB'], '04:00'));
    const fb = plan(fall, '07:32', ['--apply', '--session', S, '--role', 'primary']);
    assert.deepEqual([fb.code, fb.tier, fb.targetTier, fb.applied], ['tier', 3, 3, undefined]);
    const empty = sandbox();
    const none = st(empty, ['revise', 'plan'], '07:32');
    assert.equal(none.code, 1);
    assert.match(none.json.error, /no run file/);
  });

  test('a damaged policy in the config does not crash the plan: defaults and a warning', () => {
    const box = sandbox(policyConfig({ revisePolicy: { tier2S3Threshold: 'many', tier2MinSeverity: 'S2' } }));
    atQa(box);
    putReport(box, { S3: 4 });
    const p = plan(box, '07:32');
    assert.deepEqual([p.decision, p.policy.tier2S3Threshold], ['run', 4]);
    assert.ok(p.warnings.some((w) => w.includes('revisePolicy.tier2S3Threshold is damaged')));
  });

  test('--help style usage lists the command, and the output is one JSON document', () => {
    const box = sandbox();
    const r = st(box, ['revise', 'bogus'], '07:00');
    assert.equal(r.code, 2);
    assert.match(r.json.usage, /revise plan \[--apply --session S --role R\] \[--mtd M\] \[--tier T\]/);
    atQa(box);
    putReport(box, { S2: 1 });
    const out = st(box, ['revise', 'plan'], '07:32');
    assert.equal(out.stdout.trim().split('\n').length > 1, true, 'pretty-printed JSON like the other subcommands');
    assert.doesNotThrow(() => JSON.parse(out.stdout));
  });
});
