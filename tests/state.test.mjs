// Tests for scripts/state.mjs, scripts/lib/runstate.mjs, scripts/lib/throttle.mjs, scripts/lib/gitsync.mjs.
// Everything runs against SED_ROOT sandboxes in temp dirs and temp BARE git remotes.
import './helpers/env.mjs';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { etInstant, etIso, plusMinutes, tmpDir, GIT_GLOBAL_CONFIG } from './helpers/env.mjs';
import { DATE, REPO_ROOT, TEST_CONFIG, makeRepoSandbox, makeSandbox } from './helpers/sandbox.mjs';
import { BRANCH, git, gitTry, installPushHook, pushCount, remoteFile, remoteHas, remoteSha, removePushHook } from './helpers/git.mjs';
import * as rs from '../scripts/lib/runstate.mjs';
import { sync, BACKOFF_SECONDS } from '../scripts/lib/gitsync.mjs';
import { readJson } from '../scripts/lib/common.mjs';

const cfg = TEST_CONFIG;
const at = (hhmm, date = DATE) => etInstant(date, hhmm);
const iso = (hhmm, date = DATE) => etIso(date, hhmm);

// ---------------------------------------------------------------------------------------
// fixtures for the pure decision table
// ---------------------------------------------------------------------------------------

const lease = (holder, session, beat, acquired = '03:55') => ({
  holder,
  session,
  acquiredAt: iso(acquired),
  heartbeatAt: iso(beat),
});
const done = (...phases) => phases.map((phase) => ({ phase, at: iso('04:00'), by: 'primary', note: '' }));

function mkRun(over = {}) {
  const run = {
    schema: 1,
    date: DATE,
    status: 'in_progress',
    targetTier: 1,
    tier: null,
    phase: 'ideate',
    phasesDone: done('preflight'),
    attempts: { preflight: 1, ideate: 1 },
    lease: lease('primary', 'p1', '04:00'),
    directives: [],
    chosen: null,
    throttle: 'balanced',
    spend: { outputTokens: 0, agentCalls: 0, byPhase: {} },
    publishedAt: null,
    publishedUrl: null,
    createdAt: iso('03:55'),
    events: [],
    ...over,
  };
  // unless a test says otherwise, the current phase started at the holder's last beat (never "stuck")
  run.phaseStartedAt ??= { [run.phase]: run.lease?.heartbeatAt ?? iso('04:00') };
  return run;
}

function dec(role, session, hhmm, run, extra = {}) {
  return rs.decide({ config: cfg, role, session, now: at(hhmm), date: DATE, run, heartbeat: null, ...extra });
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    Object.values(o).forEach(deepFreeze);
  }
  return o;
}

describe('decide(): CONTRACT 7 table, row 1 (published)', () => {
  test('a published run is never redone, for any role', () => {
    const run = mkRun({ status: 'published', tier: 2, publishedAt: iso('05:10'), phase: 'done' });
    for (const role of rs.ROLES) {
      const d = dec(role, 's', '06:00', run);
      assert.equal(d.action, 'exit-published', role);
      assert.equal(d.changed, false);
      assert.equal(d.resumePhase, null);
    }
  });
  test('published beats the closer rule and a forced manual run', () => {
    const run = mkRun({ status: 'published', tier: 1, phase: 'done' });
    assert.equal(dec('closer', 'c', '07:27', run).action, 'exit-published');
    assert.equal(dec('manual', 'm', '07:27', run, { flags: { force: true } }).action, 'exit-published');
  });
});

describe('decide(): row 2 (no run file) and tier-by-time', () => {
  const cases = [
    ['primary', '03:55', 1], ['primary', '04:44', 1], ['primary', '04:45', 2], ['primary', '06:44', 2],
    ['primary', '06:45', 3], ['primary', '07:24', 3], ['primary', '07:25', 4], ['primary', '07:59', 4],
    ['wdA', '05:32', 2], ['wdB', '06:47', 3], ['closer', '07:27', 4],
  ];
  for (const [role, hhmm, tier] of cases) {
    test(`${role} at ${hhmm} with no run => proceed at tier ${tier}`, () => {
      const d = dec(role, 's1', hhmm, null);
      assert.equal(d.action, 'proceed');
      assert.equal(d.targetTier, tier);
      assert.equal(d.create, true);
      assert.equal(d.takeLease, true);
    });
  }
  test('resume point of a new run follows the tier path', () => {
    assert.equal(dec('primary', 's', '03:55', null).resumePhase, 'preflight');
    assert.equal(dec('wdA', 's', '05:32', null).resumePhase, 'preflight');
    assert.equal(dec('wdB', 's', '06:47', null).resumePhase, 'preflight'); // tier 3 still needs ideate first
    assert.equal(dec('closer', 's', '07:27', null).resumePhase, 'package'); // tier 4 needs nothing
  });
  test('a different date than "today" is treated as end of day (past) or start of day (future)', () => {
    const past = rs.decide({ config: cfg, role: 'primary', session: 's', now: at('04:00'), date: '2026-10-08', run: null, heartbeat: null });
    assert.equal(past.targetTier, 4);
    const future = rs.decide({ config: cfg, role: 'primary', session: 's', now: at('07:30'), date: '2026-10-10', run: null, heartbeat: null });
    assert.equal(future.targetTier, 1);
  });
  test('the throttle level minimal forces at least tier 2 (levels.minimal.forceTier)', () => {
    assert.equal(dec('primary', 's', '03:55', null, { throttleLevel: 'minimal' }).targetTier, 2);
    assert.equal(dec('primary', 's', '03:55', null, { throttleLevel: 'lean' }).targetTier, 1);
    assert.equal(dec('wdB', 's', '06:47', null, { throttleLevel: 'minimal' }).targetTier, 3);
  });
});

describe('decide(): row 3 (closer past the tier-3 cutoff)', () => {
  test('ideate done => force-degrade to tier 3 even over a FRESH primary lease, leaving ship-now', () => {
    const run = mkRun({ phase: 'build', phasesDone: done('preflight', 'ideate', 'select', 'spec'), lease: lease('primary', 'p1', '07:20') });
    const d = dec('closer', 'c1', '07:27', run);
    assert.equal(d.action, 'force-degrade');
    assert.equal(d.targetTier, 3);
    assert.equal(d.resumePhase, 'package');
    assert.equal(d.takeLease, true);
    assert.equal(d.events[0].kind, 'degrade');
    assert.deepEqual(d.directives, [{ kind: 'ship-now', tier: 3 }]);
  });
  test('nothing done => tier 4 postcard', () => {
    const run = mkRun({ phase: 'preflight', phasesDone: [], lease: lease('primary', 'p1', '07:10') });
    const d = dec('closer', 'c1', '07:27', run);
    assert.equal(d.action, 'force-degrade');
    assert.equal(d.targetTier, 4);
    assert.equal(d.resumePhase, 'package');
  });
  test('also applies to a failed run, and never improves an already worse target', () => {
    const failed = mkRun({ status: 'failed', phasesDone: done('preflight', 'ideate') });
    assert.equal(dec('closer', 'c', '07:27', failed).action, 'force-degrade');
    const worse = mkRun({ phasesDone: done('preflight', 'ideate'), targetTier: 4 });
    assert.equal(dec('closer', 'c', '07:27', worse).targetTier, 4);
  });
  test('before the cutoff the closer follows the normal rules', () => {
    const run = mkRun({ phase: 'build', lease: lease('primary', 'p1', '07:10') });
    assert.equal(dec('closer', 'c', '07:20', run).action, 'exit-alive');
  });
  test('re-running the closer in the same session resumes instead of degrading twice', () => {
    const run = mkRun({ phasesDone: done('preflight', 'ideate'), lease: lease('primary', 'p1', '07:20') });
    const first = dec('closer', 'c1', '07:27', run);
    const afterFirst = rs.applyDecision(run, first, { role: 'closer', session: 'c1', nowIso: iso('07:27'), date: DATE, throttleLevel: 'balanced' });
    const second = dec('closer', 'c1', '07:29', afterFirst);
    assert.equal(second.action, 'resume');
    assert.equal(second.resumePhase, 'package');
    assert.deepEqual(second.directives, []);
    const afterSecond = rs.applyDecision(afterFirst, second, { role: 'closer', session: 'c1', nowIso: iso('07:29'), date: DATE, throttleLevel: 'balanced' });
    assert.equal(afterSecond.directives.length, 1);
    assert.equal(afterSecond.events.filter((e) => e.kind === 'degrade').length, 1);
  });
  test('applying force-degrade moves the lease and leaves the ship-now directive un-acked', () => {
    const run = mkRun({ phasesDone: done('preflight', 'ideate'), lease: lease('primary', 'p1', '07:20') });
    const next = rs.applyDecision(run, dec('closer', 'c1', '07:27', run), { role: 'closer', session: 'c1', nowIso: iso('07:27'), date: DATE, throttleLevel: 'balanced' });
    assert.equal(next.lease.holder, 'closer');
    assert.equal(next.targetTier, 3);
    assert.equal(next.phase, 'package');
    assert.deepEqual(next.directives.map((d) => [d.kind, d.tier, d.ack]), [['ship-now', 3, false]]);
  });
});

describe('decide(): row 4 (failed / stale / no lease => takeover or resume)', () => {
  test('wdA at 05:32 with a stale primary takes over at the tier the clock allows', () => {
    const run = mkRun({ lease: lease('primary', 'p1', '04:10') });
    const d = dec('wdA', 'w1', '05:32', run);
    assert.equal(d.action, 'takeover');
    assert.equal(d.targetTier, 2);
    assert.equal(d.resumePhase, 'ideate');
    assert.equal(d.cleanPhase, 'ideate');
    assert.equal(d.ackDirectives, true);
    assert.equal(d.events[0].kind, 'takeover');
    assert.match(d.reason, /stale/);
  });
  test('the target tier never improves on the previous one', () => {
    const run = mkRun({ lease: lease('primary', 'p1', '04:10'), targetTier: 3 });
    assert.equal(dec('wdA', 'w1', '05:32', run).targetTier, 3);
  });
  test('wdB at 06:47 with ideate done lands on the Ideas Day path (tier 3, resume at package)', () => {
    const run = mkRun({ phase: 'build', phasesDone: done('preflight', 'ideate', 'select'), lease: lease('primary', 'p1', '05:50') });
    const d = dec('wdB', 'w2', '06:47', run);
    assert.equal(d.action, 'takeover');
    assert.equal(d.targetTier, 3);
    assert.equal(d.resumePhase, 'package');
  });
  test('a tier-1/2 takeover resumes at the first phase that is not done', () => {
    const run = mkRun({ phase: 'build', phasesDone: done('preflight', 'ideate', 'select', 'spec'), lease: lease('primary', 'p1', '04:10') });
    const d = dec('wdA', 'w1', '05:32', run);
    assert.equal(d.resumePhase, 'build');
    assert.equal(d.targetTier, 2);
  });
  test('failed status takes over even when the lease looks fresh; the same session resumes', () => {
    const run = mkRun({ status: 'failed', lease: lease('primary', 'p1', '04:20') });
    assert.equal(dec('wdA', 'w1', '04:25', run).action, 'takeover');
    const own = dec('primary', 'p1', '04:25', run);
    assert.equal(own.action, 'resume');
    assert.equal(own.clearFailed, true);
    assert.equal(own.cleanPhase, null);
  });
  test('no lease at all => takeover', () => {
    assert.equal(dec('wdA', 'w1', '05:32', mkRun({ lease: null })).action, 'takeover');
  });
  test('the same session coming back to a stale lease resumes (no cleaning)', () => {
    const run = mkRun({ lease: lease('primary', 'p1', '04:10') });
    const d = dec('primary', 'p1', '05:00', run);
    assert.equal(d.action, 'resume');
    assert.equal(d.cleanPhase, null);
    assert.equal(d.targetTier, 2);
  });
  test('same role but a different session is a takeover', () => {
    const run = mkRun({ lease: lease('primary', 'p1', '04:10') });
    assert.equal(dec('primary', 'p2', '05:00', run).action, 'takeover');
  });
  test('staleness boundary: exactly leaseStaleMinutes is still fresh, one more minute is stale', () => {
    const fresh = mkRun({ phase: 'build', lease: lease('primary', 'p1', '05:25') });
    assert.equal(dec('wdA', 'w', '06:00', fresh).action, 'exit-alive');
    const stale = mkRun({ phase: 'build', lease: lease('primary', 'p1', '05:24') });
    assert.equal(dec('wdA', 'w', '06:00', stale).action, 'takeover');
  });
  test('the heartbeat file of the SAME session keeps an otherwise stale lease alive', () => {
    const run = mkRun({ phase: 'build', lease: lease('primary', 'p1', '04:10') });
    const hb = { holder: 'primary', session: 'p1', phase: 'build', at: iso('05:20'), note: '' };
    assert.equal(dec('wdA', 'w', '05:32', run, { heartbeat: hb }).action, 'exit-alive');
  });
  test('a heartbeat file from another session, or from the far future, is ignored', () => {
    const run = mkRun({ phase: 'build', lease: lease('primary', 'p1', '04:10') });
    assert.equal(dec('wdA', 'w', '05:32', run, { heartbeat: { holder: 'x', session: 'other', phase: 'build', at: iso('05:30') } }).action, 'takeover');
    assert.equal(dec('wdA', 'w', '05:32', run, { heartbeat: { holder: 'primary', session: 'p1', phase: 'build', at: plusMinutes(iso('05:32'), 11) } }).action, 'takeover');
  });
  test('phase stuck longer than phaseStuckMinutes with a FRESH heartbeat => takeover', () => {
    const run = mkRun({ phase: 'ideate', phaseStartedAt: { ideate: iso('03:57') }, lease: lease('primary', 'p1', '05:30') });
    const d = dec('wdA', 'w', '05:32', run);
    assert.equal(d.action, 'takeover');
    assert.match(d.reason, /heartbeat is fresh/);
  });
  test('stuck boundary: exactly 90 minutes in a phase is not yet stuck', () => {
    const run = mkRun({ phase: 'build', phaseStartedAt: { build: iso('04:02') }, lease: lease('primary', 'p1', '05:30') });
    assert.equal(dec('wdA', 'w', '05:32', run).action, 'exit-alive');
    const stuck = mkRun({ phase: 'build', phaseStartedAt: { build: iso('04:01') }, lease: lease('primary', 'p1', '05:30') });
    assert.equal(dec('wdA', 'w', '05:32', stuck).action, 'takeover');
  });
  test('the holder itself is never "stuck" against itself', () => {
    const run = mkRun({ phase: 'ideate', phaseStartedAt: { ideate: iso('03:57') }, lease: lease('primary', 'p1', '05:30') });
    assert.equal(dec('primary', 'p1', '05:32', run).action, 'resume');
  });
  test('a lease without any timestamp counts as stale', () => {
    const run = mkRun({ lease: { holder: 'primary', session: 'p1' } });
    assert.equal(dec('wdA', 'w', '04:30', run).action, 'takeover');
  });

  describe('attempts >= maxAttemptsPerPhase degrades one tier', () => {
    test('build attempted twice at tier 1 => tier 2, same phase (compact retry)', () => {
      const run = mkRun({ phase: 'build', phasesDone: done('preflight', 'ideate', 'select', 'spec'), attempts: { build: 2 }, lease: lease('primary', 'p1', '04:00') });
      const d = dec('wdA', 'w', '04:40', run);
      assert.equal(d.action, 'takeover');
      assert.equal(d.targetTier, 2);
      assert.equal(d.resumePhase, 'build');
      assert.equal(d.events.at(-1).kind, 'degrade');
    });
    test('one attempt is not enough to degrade', () => {
      const run = mkRun({ phase: 'build', phasesDone: done('preflight', 'ideate', 'select', 'spec'), attempts: { build: 1 }, lease: lease('primary', 'p1', '04:00') });
      assert.equal(dec('wdA', 'w', '04:40', run).targetTier, 1);
    });
    test('spec attempted twice at tier 2 with ideas available => Ideas Day, straight to package', () => {
      const run = mkRun({ phase: 'spec', phasesDone: done('preflight', 'ideate', 'select'), attempts: { spec: 2 }, targetTier: 2, lease: lease('wdA', 'w', '05:00') });
      const d = dec('wdB', 'w2', '06:00', run);
      assert.equal(d.targetTier, 3);
      assert.equal(d.resumePhase, 'package');
    });
    test('ideate attempted twice at tier 2 => no ideas can be trusted, Postcard (tier 4)', () => {
      const run = mkRun({ phase: 'ideate', attempts: { ideate: 2 }, targetTier: 2, lease: lease('wdA', 'w', '05:00') });
      const d = dec('wdB', 'w2', '06:00', run);
      assert.equal(d.targetTier, 4);
      assert.equal(d.resumePhase, 'package');
    });
    test('qa attempted twice at tier 1 => tier 2, ship what exists (package)', () => {
      const run = mkRun({ phase: 'qa', phasesDone: done('preflight', 'ideate', 'select', 'spec', 'build'), attempts: { qa: 2 }, lease: lease('primary', 'p1', '04:00') });
      const d = dec('wdA', 'w', '04:40', run);
      assert.equal(d.targetTier, 2);
      assert.equal(d.resumePhase, 'package');
    });
    test('package attempted twice => straight to the Ideas Day fallback', () => {
      const withIdeas = mkRun({ phase: 'package', phasesDone: done('preflight', 'ideate', 'select', 'spec', 'build', 'qa', 'revise'), attempts: { package: 2 }, lease: lease('primary', 'p1', '04:00') });
      assert.equal(dec('wdA', 'w', '04:40', withIdeas).targetTier, 3);
      assert.equal(dec('wdA', 'w', '04:40', withIdeas).resumePhase, 'package');
    });
    test('already at tier 4 stays at tier 4', () => {
      const run = mkRun({ phase: 'package', phasesDone: [], attempts: { package: 5 }, targetTier: 4, lease: lease('closer', 'c', '06:20') });
      const d = dec('wdB', 'w', '07:10', run);
      assert.equal(d.targetTier, 4);
      assert.equal(d.resumePhase, 'package');
    });
  });
});

describe('decide(): row 5 (fresh lease held by someone else => exit-alive)', () => {
  test('wdA at 05:32 with a healthy primary quietly exits and writes nothing', () => {
    const run = mkRun({ phase: 'build', phasesDone: done('preflight', 'ideate', 'select', 'spec'), lease: lease('primary', 'p1', '05:20') });
    const d = dec('wdA', 'w1', '05:32', run);
    assert.equal(d.action, 'exit-alive');
    assert.equal(d.changed, false);
    assert.deepEqual(d.directives, []);
    assert.equal(d.takeLease, false);
  });
  test('wdA leaves a scope-cut when the primary is still in ideate/preflight from 05:30', () => {
    for (const phase of ['preflight', 'ideate']) {
      const d = dec('wdA', 'w1', '05:32', mkRun({ phase, lease: lease('primary', 'p1', '05:20') }));
      assert.equal(d.action, 'exit-alive', phase);
      assert.deepEqual(d.directives, [{ kind: 'scope-cut', tier: 2 }], phase);
    }
  });
  test('wdA before 05:30 does not', () => {
    assert.deepEqual(dec('wdA', 'w1', '05:29', mkRun({ phase: 'ideate', lease: lease('primary', 'p1', '05:20') })).directives, []);
  });
  test('wdB at 06:47 with the primary still in preflight/ideate/select/spec => exit-alive + scope-cut tier 2', () => {
    for (const phase of ['preflight', 'ideate', 'select', 'spec']) {
      const d = dec('wdB', 'w2', '06:47', mkRun({ phase, lease: lease('primary', 'p1', '06:40') }));
      assert.equal(d.action, 'exit-alive', phase);
      assert.deepEqual(d.directives, [{ kind: 'scope-cut', tier: 2 }], phase);
    }
  });
  test('wdB does not cut scope for a primary that is already building, or before t2Until', () => {
    assert.deepEqual(dec('wdB', 'w2', '06:47', mkRun({ phase: 'build', lease: lease('primary', 'p1', '06:40') })).directives, []);
    assert.deepEqual(dec('wdB', 'w2', '06:44', mkRun({ phase: 'spec', lease: lease('primary', 'p1', '06:40') })).directives, []);
  });
  test('an identical directive is not issued twice (acked or not)', () => {
    const existing = [{ kind: 'scope-cut', tier: 2, by: 'wdA', at: iso('05:32'), ack: true }];
    const d = dec('wdB', 'w2', '06:47', mkRun({ phase: 'ideate', directives: existing, lease: lease('primary', 'p1', '06:40') }));
    assert.deepEqual(d.directives, []);
    assert.match(d.reason, /already pending/);
  });
  test('two primaries: the second one exits', () => {
    const run = mkRun({ lease: lease('primary', 'p1', '04:20') });
    assert.equal(dec('primary', 'p2', '04:25', run).action, 'exit-alive');
  });
  test('applying a directive bumps the target tier and logs it', () => {
    const run = mkRun({ phase: 'ideate', lease: lease('primary', 'p1', '06:40') });
    const d = dec('wdB', 'w2', '06:47', run);
    const next = rs.applyDecision(run, d, { role: 'wdB', session: 'w2', nowIso: iso('06:47'), date: DATE, throttleLevel: 'balanced' });
    assert.equal(next.targetTier, 2);
    assert.deepEqual(next.directives.map((x) => [x.kind, x.tier, x.by, x.ack]), [['scope-cut', 2, 'wdB', false]]);
    assert.equal(next.lease.holder, 'primary'); // the watchdog does not touch the lease
    assert.equal(next.events.at(-1).kind, 'note');
  });
});

describe('decide(): row 6 (own fresh lease => resume)', () => {
  test('the same role+session continues where it was', () => {
    const run = mkRun({ phase: 'spec', lease: lease('primary', 'p1', '04:30') });
    const d = dec('primary', 'p1', '04:35', run);
    assert.equal(d.action, 'resume');
    assert.equal(d.resumePhase, 'spec');
    assert.equal(d.targetTier, 1);
    assert.equal(d.setPhase, false);
  });
  test('applying it only refreshes the heartbeat and keeps acquiredAt', () => {
    const run = mkRun({ phase: 'spec', lease: lease('primary', 'p1', '04:30') });
    const next = rs.applyDecision(run, dec('primary', 'p1', '04:35', run), { role: 'primary', session: 'p1', nowIso: iso('04:35'), date: DATE, throttleLevel: 'balanced' });
    assert.equal(next.lease.heartbeatAt, iso('04:35'));
    assert.equal(next.lease.acquiredAt, iso('03:55'));
    assert.equal(next.phase, 'spec');
  });
});

describe('decide(): manual role', () => {
  test('creates a run at --target-tier (default 1) regardless of the clock', () => {
    assert.equal(dec('manual', 'm', '07:40', null).targetTier, 1);
    assert.equal(dec('manual', 'm', '07:40', null, { flags: { targetTier: 3 } }).targetTier, 3);
    assert.equal(dec('manual', 'm', '04:00', null, { flags: { targetTier: 2 } }).resumePhase, 'preflight');
  });
  test('ignores the closer rule and tier-by-time when taking over a stale run', () => {
    const run = mkRun({ phasesDone: done('preflight', 'ideate'), phase: 'select', lease: lease('primary', 'p1', '05:00'), targetTier: 3 });
    const d = dec('manual', 'm', '07:40', run);
    assert.equal(d.action, 'takeover');
    assert.equal(d.targetTier, 1);
    assert.equal(d.resumePhase, 'select');
  });
  test('still exits on a fresh lease unless --force', () => {
    const run = mkRun({ lease: lease('primary', 'p1', '04:20') });
    assert.equal(dec('manual', 'm', '04:25', run).action, 'exit-alive');
    const forced = dec('manual', 'm', '04:25', run, { flags: { force: true } });
    assert.equal(forced.action, 'takeover');
    assert.equal(forced.cleanPhase, forced.resumePhase);
    assert.match(forced.events[0].msg, /FORCED/);
  });
  test('rejects a nonsense target tier', () => {
    assert.throws(() => dec('manual', 'm', '04:00', null, { flags: { targetTier: 7 } }), /target-tier/);
  });
  test('the lease holder is recorded as manual', () => {
    const d = dec('manual', 'm', '04:00', null);
    const run = rs.applyDecision(null, d, { role: 'manual', session: 'm', nowIso: iso('04:00'), date: DATE, throttleLevel: 'balanced' });
    assert.equal(run.lease.holder, 'manual');
  });
});

describe('decide(): input validation and purity', () => {
  test('unknown role and empty session are usage errors', () => {
    assert.throws(() => dec('boss', 's', '04:00', null), rs.UsageError);
    assert.throws(() => dec('primary', '  ', '04:00', null), rs.UsageError);
  });
  test('decide and applyDecision never mutate their inputs', () => {
    const run = deepFreeze(mkRun({ lease: lease('primary', 'p1', '04:10') }));
    const d = dec('wdA', 'w1', '05:32', run);
    const next = rs.applyDecision(run, d, { role: 'wdA', session: 'w1', nowIso: iso('05:32'), date: DATE, throttleLevel: 'balanced' });
    assert.equal(next.lease.holder, 'wdA');
    assert.equal(run.lease.holder, 'primary');
  });
  test('takeover acknowledges the directives of the dead holder', () => {
    const run = mkRun({ lease: lease('primary', 'p1', '04:10'), directives: [{ kind: 'scope-cut', tier: 2, by: 'wdA', at: iso('04:20'), ack: false }], targetTier: 2 });
    const next = rs.applyDecision(run, dec('wdB', 'w', '05:32', run), { role: 'wdB', session: 'w', nowIso: iso('05:32'), date: DATE, throttleLevel: 'balanced' });
    assert.ok(next.directives.every((x) => x.ack));
    assert.equal(next.phaseStartedAt[next.phase], iso('05:32'));
  });
  test('events are capped at the last 200', () => {
    const run = mkRun({ events: Array.from({ length: 250 }, (_, i) => ({ at: iso('04:00'), by: 'primary', kind: 'note', msg: `e${i}` })) });
    rs.pushEvent(run, 'note', 'newest', 'primary', iso('04:01'));
    assert.equal(run.events.length, 200);
    assert.equal(run.events.at(-1).msg, 'newest');
    assert.equal(run.events[0].msg, 'e51');
  });
  test('firstPending follows each tier path', () => {
    assert.equal(rs.firstPending(1, []), 'preflight');
    assert.equal(rs.firstPending(1, ['preflight', 'ideate']), 'select');
    assert.equal(rs.firstPending(3, ['preflight']), 'ideate');
    assert.equal(rs.firstPending(3, ['preflight', 'ideate', 'select']), 'package');
    assert.equal(rs.firstPending(4, []), 'package');
    assert.equal(rs.firstPending(1, ['ideate']), 'select'); // preflight is implied by later work
    assert.equal(rs.firstPending(1, rs.PHASES), 'done');
  });
});

// ---------------------------------------------------------------------------------------
// CLI tests (spawned processes against SED_ROOT sandboxes)
// ---------------------------------------------------------------------------------------

const boxes = [];
test.after(() => boxes.forEach((b) => b.cleanup()));
function sandbox(opts) {
  const b = makeSandbox(opts);
  boxes.push(b);
  return b;
}
function repoSandbox(opts) {
  const b = makeRepoSandbox(opts);
  boxes.push(b);
  return b;
}
const FALLBACK_SLUG = { 3: 'ideas-day', 4: 'postcard' };
/** Leaves what `package` leaves behind (docs page + history entry), because `finish` refuses a day with no page behind it. */
function seedPage(box, tier, { date = DATE, slug = FALLBACK_SLUG[tier] ?? 'real-project' } = {}) {
  const dir = `d/${date}-${slug}/`;
  box.write(`docs/${dir}index.html`, '<html></html>');
  const history = box.readJson('state/history.json');
  history.entries = history.entries.filter((e) => e.date !== date);
  history.entries.push({ n: 1, date, slug, title: 'T', tier, path: dir });
  box.write('state/history.json', history);
}
const NOW = (hhmm, date = DATE) => ['--now', iso(hhmm, date)];
const begin = (box, role, session, hhmm, extra = []) => box.state(['begin', '--role', role, '--session', session, ...NOW(hhmm), ...extra]);
const beat = (box, role, session, hhmm, extra = []) => box.state(['beat', '--role', role, '--session', session, ...NOW(hhmm), ...extra]);
const st = (box, args, hhmm) => box.state([...args, ...NOW(hhmm)]);
/** Asserts a clean exit with exactly one JSON document on stdout, and returns it. */
function good(r) {
  assert.equal(r.code, 0, `exit ${r.code}: ${r.stdout}${r.stderr}`);
  assert.ok(r.json && r.json.__unparseable === undefined, `stdout was not one JSON document: ${r.stdout}`);
  assert.equal(r.json.ok, true);
  return r.json;
}
const bytes = (box, rel) => fs.readFileSync(box.path(rel));

describe('CLI: today', () => {
  const box = sandbox();
  test('reports local date, time, tier and minutes to the deadline', () => {
    const j = good(box.state(['today', ...NOW('03:55')]));
    assert.deepEqual(
      { date: j.date, tz: j.tz, time: j.time, minutes: j.minutes, minutesToDeadline: j.minutesToDeadline, targetTierIfStartedNow: j.targetTierIfStartedNow, dayNumber: j.dayNumber },
      { date: DATE, tz: 'America/New_York', time: '03:55', minutes: 235, minutesToDeadline: 245, targetTierIfStartedNow: 1, dayNumber: 1 },
    );
  });
  test('tier by time and a negative countdown after the deadline', () => {
    assert.equal(good(box.state(['today', ...NOW('07:27')])).targetTierIfStartedNow, 4);
    assert.equal(good(box.state(['today', ...NOW('07:27')])).minutesToDeadline, 33);
    assert.equal(good(box.state(['today', ...NOW('09:00')])).minutesToDeadline, -60);
  });
  test('the local date comes from the timezone, not from UTC', () => {
    // 22:30 EST on Nov 1 is already Nov 2 in UTC
    const j = good(box.state(['today', '--now', '2026-11-02T03:30:00Z']));
    assert.equal(j.date, '2026-11-01');
    assert.equal(j.time, '22:30');
    assert.equal(j.dayNumber, 24);
  });
  test('DST fall-back day: 03:55 local is 08:55Z and still has 245 minutes to the deadline', () => {
    const j = good(box.state(['today', '--now', '2026-11-01T08:55:00Z']));
    assert.equal(j.time, '03:55');
    assert.equal(j.minutesToDeadline, 245);
    assert.equal(j.targetTierIfStartedNow, 1);
    assert.equal(good(box.state(['today', '--now', '2026-11-01T05:30:00Z'])).time, '01:30'); // still EDT before the change
  });
  test('DST spring-forward day', () => {
    const j = good(box.state(['today', '--now', '2027-03-14T07:55:00Z']));
    assert.equal(j.date, '2027-03-14');
    assert.equal(j.time, '03:55');
  });
  test('SED_NOW works like --now; --date overrides the date', () => {
    const j = good(box.cli('state', ['today'], { SED_NOW: iso('06:50') }));
    assert.equal(j.time, '06:50');
    assert.equal(j.targetTierIfStartedNow, 3);
    assert.equal(good(box.state(['today', ...NOW('04:00'), '--date', '2026-10-12'])).dayNumber, 4);
  });
  test('bad --now or --date or command => exit 2 with one JSON document', () => {
    for (const args of [['today', '--now', 'tomorrow-ish'], ['today', '--date', '2026-13-40'], ['frobnicate'], []]) {
      const r = box.state(args);
      assert.equal(r.code, 2, args.join(' '));
      assert.equal(r.json.ok, false);
    }
  });
});

describe('CLI: begin', () => {
  test('creates the run with the documented shape, takes the lease and reports budget + throttle', () => {
    const box = sandbox();
    const j = good(begin(box, 'primary', 'sess-1', '03:55'));
    assert.equal(j.action, 'proceed');
    assert.equal(j.targetTier, 1);
    assert.equal(j.resumePhase, 'preflight');
    assert.equal(j.wrote, true);
    assert.equal(j.levelConfig.outputTokens, 3_000_000);
    assert.equal(j.levelConfig.capTokens, 2_750_000);
    assert.equal(j.levelConfig.reviseLoops, 1);
    assert.deepEqual(j.levelConfig.maxEffortRoles, ['architect', 'engineer', 'critic']);
    assert.equal(j.throttle.level, 'balanced');
    const run = box.run();
    assert.equal(run.schema, 1);
    assert.equal(run.status, 'in_progress');
    assert.equal(run.phase, 'preflight');
    assert.equal(run.throttle, 'balanced');
    assert.deepEqual(run.lease, { holder: 'primary', session: 'sess-1', acquiredAt: iso('03:55'), heartbeatAt: iso('03:55') });
    assert.deepEqual(run.spend, { outputTokens: 0, agentCalls: 0, byPhase: {} });
    assert.equal(run.phaseStartedAt.preflight, iso('03:55'));
    assert.equal(run.events.length, 1);
    assert.deepEqual(j.run, run);
  });
  test('the same session calling again resumes and refreshes its heartbeat', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    const j = good(begin(box, 'primary', 's1', '04:20'));
    assert.equal(j.action, 'resume');
    assert.equal(j.resumePhase, 'preflight');
    assert.equal(box.run().lease.heartbeatAt, iso('04:20'));
    assert.equal(box.run().lease.acquiredAt, iso('03:55'));
  });
  test('a watchdog meeting a live primary exits and does not touch the file at all', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    for (const [phase, hhmm] of [['preflight', '04:00'], ['ideate', '04:30'], ['select', '04:45'], ['spec', '05:10']]) {
      good(st(box, ['phase-done', '--phase', phase, '--session', 's1'], hhmm));
    }
    beat(box, 'primary', 's1', '05:20');
    const before = bytes(box, box.runFile());
    const mtime = fs.statSync(box.path(box.runFile())).mtimeMs;
    const j = good(begin(box, 'wdA', 'w1', '05:32'));
    assert.equal(j.action, 'exit-alive');
    assert.equal(j.wrote, false);
    assert.deepEqual(bytes(box, box.runFile()), before);
    assert.equal(fs.statSync(box.path(box.runFile())).mtimeMs, mtime);
  });
  test('wdA/wdB leave a scope-cut once (and only once) for a primary that is behind', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    good(st(box, ['phase-done', '--phase', 'preflight', '--session', 's1'], '05:00')); // slow: ideate only started at 05:00
    beat(box, 'primary', 's1', '05:25');
    const first = good(begin(box, 'wdA', 'w1', '05:32'));
    assert.equal(first.action, 'exit-alive');
    assert.equal(first.directiveAdded, true);
    assert.equal(first.run.targetTier, 2);
    assert.deepEqual(box.run().directives.map((d) => [d.kind, d.tier, d.by, d.ack]), [['scope-cut', 2, 'wdA', false]]);
    const frozen = bytes(box, box.runFile());
    const again = good(begin(box, 'wdA', 'w1b', '05:35'));
    assert.equal(again.wrote, false);
    assert.deepEqual(bytes(box, box.runFile()), frozen);
    // the primary sees it on its next beat
    const b = good(beat(box, 'primary', 's1', '05:36'));
    assert.deepEqual(b.directives.map((d) => d.kind), ['scope-cut']);
    assert.equal(b.targetTier, 2);
  });
  test('a published day exits and never writes', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    seedPage(box, 1);
    good(st(box, ['finish', '--status', 'published', '--tier', '1', '--url', 'https://example.test/'], '05:00'));
    const before = bytes(box, box.runFile());
    const j = good(begin(box, 'closer', 'c1', '07:27'));
    assert.equal(j.action, 'exit-published');
    assert.equal(j.wrote, false);
    assert.deepEqual(bytes(box, box.runFile()), before);
  });
  test('closer at 07:27 forces tier 3 when ideate is done, over a live primary, leaving ship-now', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    good(st(box, ['phase-done', '--phase', 'preflight', '--session', 's1'], '04:00'));
    good(st(box, ['phase-done', '--phase', 'ideate', '--session', 's1'], '04:30'));
    beat(box, 'primary', 's1', '07:20');
    const j = good(begin(box, 'closer', 'c1', '07:27'));
    assert.equal(j.action, 'force-degrade');
    assert.equal(j.targetTier, 3);
    assert.equal(j.resumePhase, 'package');
    const run = box.run();
    assert.equal(run.lease.holder, 'closer');
    assert.deepEqual(run.directives.map((d) => [d.kind, d.tier, d.ack]), [['ship-now', 3, false]]);
    assert.ok(run.events.some((e) => e.kind === 'degrade'));
    // the primary's next beat tells it to stop
    const b = good(beat(box, 'primary', 's1', '07:28'));
    assert.equal(b.leaseHeld, false);
    assert.equal(b.holder, 'closer');
  });
  test('closer with nothing at all => proceed at tier 4 (no run file)', () => {
    const box = sandbox();
    const j = good(begin(box, 'closer', 'c1', '07:27'));
    assert.equal(j.action, 'proceed');
    assert.equal(j.targetTier, 4);
    assert.equal(j.resumePhase, 'package');
  });
  test('closer with a started-but-empty run => force-degrade to tier 4', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    const j = good(begin(box, 'closer', 'c1', '07:27'));
    assert.equal(j.action, 'force-degrade');
    assert.equal(j.targetTier, 4);
  });
  test('manual: --target-tier / --force only with manual; manual ignores the clock', () => {
    const box = sandbox();
    assert.equal(begin(box, 'primary', 's1', '04:00', ['--target-tier', '2']).code, 2);
    assert.equal(begin(box, 'wdA', 's1', '04:00', ['--force']).code, 2);
    const j = good(begin(box, 'manual', 'm1', '07:40', ['--target-tier', '3']));
    assert.equal(j.action, 'proceed');
    assert.equal(j.targetTier, 3);
    assert.equal(box.run().lease.holder, 'manual');
    assert.equal(begin(box, 'manual', 'm2', '07:41', ['--target-tier', '9']).code, 2);
    // another manual run meets the fresh lease: exit-alive unless forced
    assert.equal(good(begin(box, 'manual', 'm2', '07:41')).action, 'exit-alive');
    const forced = good(begin(box, 'manual', 'm2', '07:41', ['--force']));
    assert.equal(forced.action, 'takeover');
    assert.equal(box.run().lease.session, 'm2');
  });
  test('a minimal throttle level starts the day at tier 2', () => {
    const box = sandbox();
    good(box.state(['throttle', 'set', '--level', 'minimal', ...NOW('03:50')]));
    const j = good(begin(box, 'primary', 's1', '03:55'));
    assert.equal(j.targetTier, 2);
    assert.equal(j.levelConfig.outputTokens, 500_000);
    assert.equal(j.levelConfig.forceTier, 2);
  });
  test('usage errors exit 2', () => {
    const box = sandbox();
    assert.equal(box.state(['begin', '--session', 's', ...NOW('04:00')]).code, 2);
    assert.equal(box.state(['begin', '--role', 'primary', ...NOW('04:00')]).code, 2);
    assert.equal(begin(box, 'overlord', 's', '04:00').code, 2);
    assert.equal(box.state(['begin', '--role', 'primary', '--session', 's', '--date', 'nope']).code, 2);
  });
  test('--date works for any date and uses that date\'s run file', () => {
    const box = sandbox();
    const j = good(box.state(['begin', '--role', 'manual', '--session', 'm', '--date', '2026-10-08', ...NOW('10:00')]));
    assert.equal(j.date, '2026-10-08');
    assert.ok(box.exists('state/runs/2026-10-08.json'));
  });
});

describe('CLI: takeover mechanics', () => {
  function progressedRun(box, ideateAt = '03:58') {
    begin(box, 'primary', 's1', '03:55');
    good(st(box, ['phase-done', '--phase', 'preflight', '--session', 's1'], ideateAt));
    good(st(box, ['phase-start', '--phase', 'ideate', '--session', 's1'], ideateAt));
  }
  test('a stale-lease takeover wipes the interrupted phase\'s staging and nothing else', () => {
    const box = sandbox();
    progressedRun(box);
    box.write(`work/${DATE}/ideate/partial.json`, '{}');
    box.write(`work/${DATE}/ideas/shortlist.json`, '[]');
    box.write(`work/${DATE}/build/keep.txt`, 'keep');
    box.write(`work/2026-10-08/ideate/other-day.txt`, 'keep');
    const j = good(begin(box, 'wdA', 'w1', '05:32'));
    assert.equal(j.action, 'takeover');
    assert.equal(j.resumePhase, 'ideate');
    assert.equal(j.targetTier, 2);
    assert.deepEqual(j.cleaned.sort(), [`work/${DATE}/ideas`, `work/${DATE}/ideate`]);
    assert.equal(box.exists(`work/${DATE}/ideate`), false);
    assert.equal(box.exists(`work/${DATE}/ideas`), false);
    assert.equal(box.exists(`work/${DATE}/build/keep.txt`), true);
    assert.equal(box.exists('work/2026-10-08/ideate/other-day.txt'), true);
    const run = box.run();
    assert.equal(run.lease.holder, 'wdA');
    assert.equal(run.phase, 'ideate');
    assert.equal(run.phaseStartedAt.ideate, iso('05:32'));
    assert.equal(run.events.at(-1).kind, 'takeover');
  });
  test('the same session resuming a stale lease does NOT clean its own staging', () => {
    const box = sandbox();
    progressedRun(box);
    box.write(`work/${DATE}/ideate/partial.json`, '{}');
    const j = good(begin(box, 'primary', 's1', '05:00'));
    assert.equal(j.action, 'resume');
    assert.deepEqual(j.cleaned, []);
    assert.equal(box.exists(`work/${DATE}/ideate/partial.json`), true);
  });
  test('phases that already wrote DONE.json are recovered instead of redone or wiped', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    for (const p of ['preflight', 'ideate', 'select']) good(st(box, ['phase-done', '--phase', p, '--session', 's1'], '04:00'));
    box.write(`work/${DATE}/spec/DONE.json`, { ok: true });
    box.write(`work/${DATE}/spec/SPEC.md`, 'the spec');
    box.write(`work/${DATE}/build/DONE.json`, { ok: true });
    box.write(`work/${DATE}/qa/half-written.txt`, 'junk');
    const j = good(begin(box, 'wdA', 'w1', '05:32'));
    assert.equal(j.action, 'takeover');
    assert.deepEqual(j.recovered, ['spec', 'build']);
    assert.equal(j.resumePhase, 'qa');
    assert.deepEqual(j.cleaned, [`work/${DATE}/qa`]);
    assert.equal(box.exists(`work/${DATE}/spec/SPEC.md`), true);
    const run = box.run();
    assert.deepEqual(run.phasesDone.map((e) => e.phase), ['preflight', 'ideate', 'select', 'spec', 'build']);
    assert.equal(run.phasesDone.find((e) => e.phase === 'spec').by, 'recovery');
  });
  test('a DONE.json that says ok:false is not trusted; phase-start removes a stale marker', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    for (const p of ['preflight', 'ideate', 'select']) good(st(box, ['phase-done', '--phase', p, '--session', 's1'], '04:00'));
    box.write(`work/${DATE}/spec/DONE.json`, { ok: false });
    const j = good(begin(box, 'wdA', 'w1', '05:32'));
    assert.equal(j.resumePhase, 'spec');
    assert.deepEqual(j.recovered, []);
    box.write(`work/${DATE}/spec/DONE.json`, { ok: true });
    good(st(box, ['phase-start', '--phase', 'spec', '--session', 'w1'], '05:33'));
    assert.equal(box.exists(`work/${DATE}/spec/DONE.json`), false);
  });
  test('the out-of-process heartbeat file keeps a silent-lease primary alive for watchdogs', () => {
    const box = sandbox();
    progressedRun(box, '05:00');
    box.write(`state/heartbeats/${DATE}/s1.json`, { holder: 'primary', session: 's1', phase: 'ideate', at: iso('05:25'), note: '' });
    const j = good(begin(box, 'wdA', 'w1', '05:32'));
    assert.equal(j.action, 'exit-alive');
    assert.equal(j.lease.source, 'heartbeat-file');
    // another session's file (and a record whose session field does not match its owner) counts for nothing
    fs.rmSync(box.path(`state/heartbeats/${DATE}/s1.json`));
    box.write(`state/heartbeats/${DATE}/someone-else.json`, { holder: 'primary', session: 'someone-else', phase: 'ideate', at: iso('05:25'), note: '' });
    box.write(`state/heartbeats/${DATE}/s1.json`, { holder: 'primary', session: 'someone-else', phase: 'ideate', at: iso('05:25'), note: '' });
    assert.equal(good(begin(box, 'wdA', 'w1', '05:40')).action, 'takeover'); // lease itself last beat at 05:00
  });
  test('a zombie session pulsing on its own file cannot keep a dead lease alive for the replacement, nor hide the replacement', () => {
    const box = sandbox();
    progressedRun(box, '04:30');
    // wdA takes over at 05:32 (the primary's lease is stale); the zombie primary keeps pulsing
    assert.equal(good(begin(box, 'wdA', 'a1', '05:32')).action, 'takeover');
    for (const [a, z] of [['05:33', '05:34'], ['05:38', '05:39'], ['06:03', '06:04'], ['06:28', '06:29'], ['06:43', '06:44']]) {
      box.write(`state/heartbeats/${DATE}/a1.json`, { holder: 'wdA', session: 'a1', phase: 'ideate', at: iso(a), note: '' });
      box.write(`state/heartbeats/${DATE}/s1.json`, { holder: 'primary', session: 's1', phase: 'ideate', at: iso(z), note: '' });
    }
    const wdB = good(begin(box, 'wdB', 'b1', '06:47'));
    assert.equal(wdB.action, 'exit-alive', wdB.reason); // wdA's own pulse (06:43) is what counts
    assert.equal(wdB.lease.holder, 'wdA');
    assert.equal(wdB.lease.source, 'heartbeat-file');
  });
  test('heartbeat file names are filesystem-safe and collision-free', () => {
    assert.equal(rs.heartbeatName('session_01AbC-x.y'), 'session_01AbC-x.y');
    const odd = rs.heartbeatName('../../etc/passwd');
    assert.match(odd, /^[A-Za-z0-9._-]+$/);
    assert.ok(!odd.includes('/') && !odd.startsWith('.'));
    assert.notEqual(rs.heartbeatName('a/b'), rs.heartbeatName('a_b'));
    assert.match(rs.heartbeatName(''), /^session-[0-9a-f]{8}$/);
  });
  test('a hung orchestrator with a live heartbeat is taken over once its phase exceeds phaseStuckMinutes', () => {
    const box = sandbox();
    progressedRun(box); // ideate started 03:58
    beat(box, 'primary', 's1', '05:30');
    const j = good(begin(box, 'wdA', 'w1', '05:35'));
    assert.equal(j.action, 'takeover');
    assert.match(j.reason, /heartbeat is fresh/);
  });
  test('a failed run is taken over by anyone; its own session resumes', () => {
    const box = sandbox();
    progressedRun(box);
    const f = st(box, ['fail', '--reason', 'build exploded', '--session', 's1'], '04:10');
    assert.equal(f.json.ok, true);
    assert.equal(box.run().status, 'failed');
    const own = good(begin(box, 'primary', 's1', '04:12'));
    assert.equal(own.action, 'resume');
    assert.equal(box.run().status, 'in_progress');
    st(box, ['fail', '--reason', 'again', '--session', 's1'], '04:15');
    const other = good(begin(box, 'wdA', 'w1', '04:20'));
    assert.equal(other.action, 'takeover');
    assert.equal(box.run().status, 'in_progress');
  });
  test('repeated attempts degrade the tier (phase-start counts attempts)', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    good(st(box, ['phase-done', '--phase', 'preflight', '--session', 's1'], '03:56'));
    good(st(box, ['phase-start', '--phase', 'ideate', '--session', 's1'], '03:57'));
    const j2 = good(begin(box, 'wdA', 'w1', '04:40')); // ideate attempted once => retried at the same tier
    assert.equal(j2.action, 'takeover');
    assert.equal(j2.targetTier, 1);
    const s2 = good(st(box, ['phase-start', '--phase', 'ideate', '--session', 'w1'], '04:41'));
    assert.equal(s2.attempt, 2);
    const j3 = good(begin(box, 'wdB', 'w2', '06:47')); // ideate attempted twice => degrade; ideate never finished => postcard
    assert.equal(j3.action, 'takeover');
    assert.equal(j3.targetTier, 4);
    assert.equal(j3.resumePhase, 'package');
    assert.ok(box.run().events.some((e) => e.kind === 'degrade'));
  });
});

describe('CLI: beat', () => {
  test('refreshes the holder\'s lease and records phase and note', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    const j = good(beat(box, 'primary', 's1', '04:10', ['--phase', 'ideate', '--note', 'scouts running']));
    assert.equal(j.leaseHeld, true);
    assert.deepEqual(j.directives, []);
    assert.equal(j.targetTier, 1);
    assert.equal(j.spend.overCap, false);
    const lease = box.run().lease;
    assert.equal(lease.heartbeatAt, iso('04:10'));
    assert.equal(lease.phase, 'ideate');
    assert.equal(lease.note, 'scouts running');
  });
  test('a non-holder gets leaseHeld:false and nothing is written', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    const before = bytes(box, box.runFile());
    for (const [role, session] of [['wdA', 'w1'], ['primary', 'other-session']]) {
      const j = good(beat(box, role, session, '04:00'));
      assert.equal(j.leaseHeld, false);
      assert.equal(j.holder, 'primary');
      assert.match(j.reason, /stop writing/);
    }
    assert.deepEqual(bytes(box, box.runFile()), before);
  });
  test('a non-holder facing a stale lease is told to call begin', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    const j = good(beat(box, 'wdA', 'w1', '05:00'));
    assert.equal(j.leaseHeld, false);
    assert.match(j.reason, /stale/);
    assert.match(j.reason, /begin/);
  });
  test('errors: no run file => exit 1; bad role/phase => exit 2', () => {
    const box = sandbox();
    const r = beat(box, 'primary', 's1', '04:00');
    assert.equal(r.code, 1);
    assert.match(r.json.error, /no run file/);
    begin(box, 'primary', 's1', '04:00');
    assert.equal(beat(box, 'ghost', 's1', '04:01').code, 2);
    assert.equal(beat(box, 'primary', 's1', '04:01', ['--phase', 'nap']).code, 2);
  });
  test('does not record a heartbeat on a published run', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    seedPage(box, 2);
    good(st(box, ['finish', '--status', 'published', '--tier', '2'], '05:00'));
    const j = good(beat(box, 'primary', 's1', '05:10'));
    assert.equal(j.leaseHeld, true);
    assert.equal(box.run().lease.heartbeatAt, iso('03:55'));
  });
});

describe('CLI: phases', () => {
  test('phase-start / phase-done keep phase, attempts, phaseStartedAt and phasesDone consistent', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    const s = good(st(box, ['phase-start', '--phase', 'preflight', '--session', 's1'], '03:56'));
    assert.equal(s.attempt, 1);
    assert.equal(s.overLimit, false);
    const d = good(st(box, ['phase-done', '--phase', 'preflight', '--note', 'synced; lenses ok', '--session', 's1'], '03:58'));
    assert.equal(d.next, 'ideate');
    assert.deepEqual(d.phasesDone, ['preflight']);
    const run = box.run();
    assert.equal(run.phase, 'ideate');
    assert.equal(run.phaseStartedAt.ideate, iso('03:58'));
    assert.deepEqual(run.phasesDone, [{ phase: 'preflight', at: iso('03:58'), by: 'primary', note: 'synced; lenses ok' }]);
    assert.equal(run.attempts.preflight, 1);
    assert.equal(run.lease.heartbeatAt, iso('03:58'));
  });
  test('phase-done without phase-start still records one attempt; repeating it is idempotent', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    good(st(box, ['phase-done', '--phase', 'preflight'], '03:58'));
    const again = good(st(box, ['phase-done', '--phase', 'preflight'], '03:59'));
    assert.equal(again.alreadyDone, true);
    assert.equal(box.run().phasesDone.length, 1);
    assert.equal(box.run().attempts.preflight, 1);
  });
  test('re-starting a phase increments attempts and flags when over the limit', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    const a = [1, 2, 3].map((i) => good(st(box, ['phase-start', '--phase', 'ideate'], `04:0${i}`)));
    assert.deepEqual(a.map((x) => x.attempt), [1, 2, 3]);
    assert.deepEqual(a.map((x) => x.overLimit), [false, false, true]);
  });
  test('tier 3/4 skip straight to package after ideate / preflight', () => {
    const box = sandbox();
    begin(box, 'wdB', 'w', '06:47'); // tier 3
    good(st(box, ['phase-done', '--phase', 'preflight'], '06:50'));
    assert.equal(good(st(box, ['phase-done', '--phase', 'ideate'], '07:05')).next, 'package');
    assert.equal(good(st(box, ['phase-done', '--phase', 'package'], '07:10')).next, 'publish');
    const box4 = sandbox();
    begin(box4, 'closer', 'c', '07:27'); // tier 4 starts at package
    assert.equal(box4.run().phase, 'package');
  });
  test('the --session guard stops a zombie from writing', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    begin(box, 'wdA', 'w1', '05:32'); // takes over
    const before = bytes(box, box.runFile());
    for (const args of [['phase-start', '--phase', 'ideate'], ['phase-done', '--phase', 'preflight'], ['spend', '--tokens', '5'], ['choose', '--idea-id', 'i1', '--slug', 'x', '--title', 'X'], ['fail', '--reason', 'zombie']]) {
      const r = st(box, [...args, '--session', 's1'], '05:40');
      assert.equal(r.code, 1, args[0]);
      assert.equal(r.json.leaseHeld, false, args[0]);
    }
    assert.deepEqual(bytes(box, box.runFile()), before);
  });
  test('phases cannot be started or finished on a published or failed run', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    seedPage(box, 1);
    good(st(box, ['finish', '--status', 'published', '--tier', '1'], '05:00'));
    assert.equal(st(box, ['phase-start', '--phase', 'ideate'], '05:05').code, 1);
    assert.equal(st(box, ['phase-done', '--phase', 'ideate'], '05:05').code, 1);
  });
  test('bad phase => exit 2', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    assert.equal(st(box, ['phase-start', '--phase', 'dessert'], '04:00').code, 2);
    assert.equal(st(box, ['phase-start'], '04:00').code, 2);
  });
});

describe('CLI: directive, ack-directive, event, spend, choose', () => {
  test('directive: defaults, tier bump, dedupe, validation', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    const j = good(st(box, ['directive', '--kind', 'scope-cut', '--by', 'wdA'], '05:32'));
    assert.equal(j.tier, 2);
    assert.equal(j.added, true);
    assert.equal(box.run().targetTier, 2);
    assert.equal(good(st(box, ['directive', '--kind', 'scope-cut', '--tier', '2', '--by', 'wdA'], '05:33')).added, false);
    const ship = good(st(box, ['directive', '--kind', 'ship-now', '--tier', '4', '--by', 'closer'], '07:27'));
    assert.equal(ship.added, true);
    assert.equal(box.run().targetTier, 4);
    assert.equal(st(box, ['directive', '--kind', 'bogus', '--by', 'wdA'], '05:32').code, 2);
    assert.equal(st(box, ['directive', '--kind', 'scope-cut'], '05:32').code, 2);
    assert.equal(st(box, ['directive', '--kind', 'scope-cut', '--tier', '9', '--by', 'x'], '05:32').code, 2);
  });
  test('ship-now with no tier picks 3 when ideate is done, else 4', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    assert.equal(good(st(box, ['directive', '--kind', 'ship-now', '--by', 'wdB'], '06:50')).tier, 4);
    const box2 = sandbox();
    begin(box2, 'primary', 's1', '03:55');
    good(st(box2, ['phase-done', '--phase', 'ideate'], '04:30'));
    assert.equal(good(st(box2, ['directive', '--kind', 'ship-now', '--by', 'wdB'], '06:50')).tier, 3);
  });
  test('ack-directive acknowledges all (or a filtered subset) and beat stops reporting them', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    st(box, ['directive', '--kind', 'scope-cut', '--by', 'wdA'], '05:32');
    st(box, ['directive', '--kind', 'ship-now', '--tier', '4', '--by', 'closer'], '07:27');
    assert.equal(good(st(box, ['ack-directive', '--kind', 'scope-cut'], '07:28')).acked, 1);
    assert.deepEqual(good(beat(box, 'primary', 's1', '07:29')).directives.map((d) => d.kind), ['ship-now']);
    assert.equal(good(st(box, ['ack-directive'], '07:30')).acked, 1);
    assert.deepEqual(good(beat(box, 'primary', 's1', '07:31')).directives, []);
  });
  test('event: appends with by/kind, validates kind, caps at 200', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    good(st(box, ['event', '--kind', 'error', '--msg', 'scout pulse died', '--by', 'primary'], '04:00'));
    assert.deepEqual(box.run().events.at(-1), { at: iso('04:00'), by: 'primary', kind: 'error', msg: 'scout pulse died' });
    assert.equal(st(box, ['event', '--kind', 'party', '--msg', 'x', '--by', 'primary'], '04:00').code, 2);
    assert.equal(st(box, ['event', '--kind', 'note', '--by', 'primary'], '04:00').code, 2);
    const run = box.run();
    run.events = Array.from({ length: 199 }, (_, i) => ({ at: iso('04:00'), by: 'primary', kind: 'note', msg: `old${i}` }));
    box.write(box.runFile(), run);
    for (let i = 0; i < 4; i++) good(st(box, ['event', '--kind', 'note', '--msg', `new${i}`, '--by', 'primary'], '04:05'));
    const events = box.run().events;
    assert.equal(events.length, 200);
    assert.equal(events[0].msg, 'old3');
    assert.equal(events.at(-1).msg, 'new3');
  });
  test('spend accumulates per phase and raises one budget event when the level cap is crossed', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    good(st(box, ['spend', '--tokens', '1000', '--calls', '3', '--phase', 'ideate'], '04:00'));
    const j = good(st(box, ['spend', '--tokens', '500', '--calls', '1', '--phase', 'ideate'], '04:01'));
    assert.equal(j.spend.outputTokens, 1500);
    assert.equal(j.spend.agentCalls, 4);
    assert.deepEqual(j.spend.byPhase.ideate, { outputTokens: 1500, agentCalls: 4 });
    assert.equal(j.spend.capTokens, 2_750_000);
    assert.equal(j.overCap, false);
    const over = good(st(box, ['spend', '--tokens', '2749000'], '04:02'));
    assert.equal(over.overCap, true);
    assert.equal(over.spend.remainingTokens, 0);
    good(st(box, ['spend', '--tokens', '10'], '04:03'));
    assert.equal(box.run().events.filter((e) => e.kind === 'budget').length, 1);
    assert.equal(box.run().spend.byPhase.preflight.outputTokens, 2749010); // defaults to the current phase
    assert.equal(good(beat(box, 'primary', 's1', '04:04')).spend.overCap, true);
    assert.equal(st(box, ['spend', '--tokens', '-5'], '04:05').code, 2);
    assert.equal(st(box, ['spend', '--tokens', 'lots'], '04:05').code, 2);
  });
  test('choose normalizes the slug and validates', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    const j = good(st(box, ['choose', '--idea-id', 'i04', '--slug', 'Power Play: Odds!!', '--title', 'Power Play Odds'], '05:00'));
    assert.equal(j.chosen.slug, 'power-play-odds');
    assert.equal(j.slugNormalized, true);
    assert.deepEqual(box.run().chosen, { ideaId: 'i04', slug: 'power-play-odds', title: 'Power Play Odds' });
    assert.equal(st(box, ['choose', '--idea-id', 'i04', '--slug', '***', '--title', 'X'], '05:00').code, 2);
    assert.equal(st(box, ['choose', '--slug', 'x', '--title', 'X'], '05:00').code, 2);
  });
});

describe('CLI: finish and fail', () => {
  test('finish publishes: status, tier, publishedAt, url, phase done', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    seedPage(box, 1);
    const j = good(st(box, ['finish', '--status', 'published', '--tier', '1', '--url', 'https://example.test/d/x/'], '05:00'));
    assert.equal(j.action, 'published');
    const run = box.run();
    assert.equal(run.status, 'published');
    assert.equal(run.tier, 1);
    assert.equal(run.publishedAt, iso('05:00'));
    assert.equal(run.publishedUrl, 'https://example.test/d/x/');
    assert.equal(run.phase, 'done');
    assert.ok(run.phasesDone.some((e) => e.phase === 'done'));
  });
  test('the url defaults to the configured site url; --tier is required', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    assert.equal(st(box, ['finish', '--status', 'published'], '05:00').code, 2);
    seedPage(box, 2);
    good(st(box, ['finish', '--tier', '2'], '05:00'));
    assert.equal(box.run().publishedUrl, TEST_CONFIG.siteUrl);
  });
  test('never downgrades; same tier is a no-op; the file is untouched', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    seedPage(box, 2);
    good(st(box, ['finish', '--tier', '2', '--url', 'https://example.test/two/'], '05:00'));
    const before = bytes(box, box.runFile());
    const down = st(box, ['finish', '--tier', '3', '--url', 'https://example.test/three/'], '07:30');
    assert.equal(down.code, 1);
    assert.equal(down.json.ok, false);
    assert.equal(down.json.action, 'refused');
    assert.match(down.json.error, /downgrade/);
    const same = good(st(box, ['finish', '--tier', '2', '--url', 'https://example.test/other/'], '07:31'));
    assert.equal(same.action, 'noop');
    assert.deepEqual(bytes(box, box.runFile()), before);
  });
  test('upgrades a fallback to a better tier, removes the replaced fallback page, remembers what it replaced', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    box.write(`docs/d/${DATE}-ideas-day/index.html`, '<html>');
    box.write(`docs/d/${DATE}-postcard/index.html`, '<html>');
    box.write(`docs/d/${DATE}-other/index.html`, '<html>');
    good(begin(box, 'closer', 'c1', '07:27'));
    seedPage(box, 3);
    good(st(box, ['finish', '--tier', '3', '--url', 'https://example.test/ideas/', '--by', 'closer'], '07:40'));
    seedPage(box, 1);
    const up = good(st(box, ['finish', '--tier', '1', '--url', 'https://example.test/real/', '--by', 'primary'], '09:15'));
    assert.equal(up.action, 'upgraded');
    assert.deepEqual(up.removedDirs, [`docs/d/${DATE}-ideas-day`]);
    assert.equal(box.exists(`docs/d/${DATE}-ideas-day`), false);
    assert.equal(box.exists(`docs/d/${DATE}-postcard`), true); // only the replaced tier's page goes
    assert.equal(box.exists(`docs/d/${DATE}-other`), true);
    const run = box.run();
    assert.equal(run.tier, 1);
    assert.equal(run.publishedUrl, 'https://example.test/real/');
    assert.equal(run.replaced.length, 1);
    assert.equal(run.replaced[0].tier, 3);
    assert.equal(run.replaced[0].publishedUrl, 'https://example.test/ideas/');
  });
  test('the upgrade window closes at 23:59 local on the run date', () => {
    const box = sandbox();
    begin(box, 'closer', 'c1', '07:27');
    seedPage(box, 4);
    good(st(box, ['finish', '--tier', '4'], '07:40'));
    const late = st(box, ['finish', '--tier', '1'], '23:59');
    assert.equal(late.code, 1);
    assert.match(late.json.error, /23:59/);
    const nextDay = box.state(['finish', '--tier', '1', '--now', iso('00:30', '2026-10-10')]);
    assert.equal(nextDay.code, 1);
    seedPage(box, 2);
    good(st(box, ['finish', '--tier', '2'], '23:58'));
    assert.equal(box.run().tier, 2);
  });
  test('finish and fail on a day without a run => exit 1', () => {
    const box = sandbox();
    assert.equal(st(box, ['finish', '--tier', '1'], '05:00').code, 1);
    assert.equal(st(box, ['fail', '--reason', 'x'], '05:00').code, 1);
  });
  test('fail marks the run failed with an error event, but refuses to unpublish', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    good(st(box, ['fail', '--reason', 'qa found S1 defects twice', '--by', 'primary'], '06:00'));
    const run = box.run();
    assert.equal(run.status, 'failed');
    assert.deepEqual(run.events.at(-1), { at: iso('06:00'), by: 'primary', kind: 'error', msg: 'run failed: qa found S1 defects twice' });
    seedPage(box, 3);
    good(st(box, ['finish', '--tier', '3'], '07:00')); // a failed run can still be published
    const r = st(box, ['fail', '--reason', 'late regret'], '07:05');
    assert.equal(r.code, 1);
    assert.equal(box.run().status, 'published');
    assert.equal(st(box, ['fail'], '07:05').code, 2);
  });
});

describe('CLI: status', () => {
  test('no run yet: says what to do and shows the history tail', () => {
    const box = sandbox();
    box.write('state/history.json', {
      schema: 1,
      startDate: DATE,
      entries: Array.from({ length: 7 }, (_, i) => ({ n: i + 1, date: `2026-10-${String(9 + i).padStart(2, '0')}`, slug: `s${i}`, title: `T${i}`, tier: 1 })),
    });
    const j = good(st(box, ['status'], '03:50'));
    assert.equal(j.exists, false);
    assert.equal(j.targetTierIfStartedNow, 1);
    assert.match(j.nextAction, /begin --role primary/);
    assert.equal(j.history.length, 5);
    assert.equal(j.history.at(-1).slug, 's6');
    assert.equal(j.throttle.level, 'balanced');
  });
  test('in progress: phase, tier, lease staleness, directives, events tail, spend, throttle', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    good(st(box, ['phase-done', '--phase', 'preflight', '--session', 's1'], '03:58'));
    good(st(box, ['spend', '--tokens', '4200', '--calls', '9'], '04:00'));
    st(box, ['directive', '--kind', 'scope-cut', '--by', 'wdA'], '04:05');
    const j = good(st(box, ['status'], '04:10'));
    assert.equal(j.status, 'in_progress');
    assert.equal(j.phase, 'ideate');
    assert.equal(j.targetTier, 2);
    assert.equal(j.lease.holder, 'primary');
    assert.equal(j.lease.ageMinutes, 12);
    assert.equal(j.lease.alive, true);
    assert.equal(j.lease.stale, false);
    assert.equal(j.phaseMinutes, 12);
    assert.deepEqual(j.directives.map((d) => d.kind), ['scope-cut']);
    assert.equal(j.spend.outputTokens, 4200);
    assert.ok(j.eventsTail.length >= 1 && j.eventsTail.length <= 10);
    assert.equal(j.minutesToDeadline, 230);
    assert.match(j.nextAction, /alive/);
    assert.match(j.nextAction, /Pending directives/);
    assert.deepEqual(j.phasesDone, ['preflight']);
  });
  test('stale and stuck holders are called out with the way forward', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    const stale = good(st(box, ['status'], '05:00'));
    assert.equal(stale.lease.stale, true);
    assert.equal(stale.lease.alive, false);
    assert.match(stale.nextAction, /STALE/);
    assert.match(stale.nextAction, /begin/);
    beat(box, 'primary', 's1', '05:30');
    const stuck = good(st(box, ['status'], '05:35'));
    assert.equal(stuck.lease.stuck, true);
    assert.match(stuck.nextAction, /hung/);
  });
  test('published: url and tier up front; it never writes', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    seedPage(box, 3);
    good(st(box, ['finish', '--tier', '3', '--url', 'https://example.test/ideas/'], '07:30'));
    const before = bytes(box, box.runFile());
    const j = good(st(box, ['status'], '07:45'));
    assert.equal(j.publishedUrl, 'https://example.test/ideas/');
    assert.equal(j.tier, 3);
    assert.match(j.nextAction, /Published at tier 3/);
    assert.match(j.nextAction, /better tier/);
    assert.deepEqual(bytes(box, box.runFile()), before);
  });
  test('a corrupt run file is reported, not thrown on', () => {
    const box = sandbox();
    box.write(box.runFile(), '{"schema": 1, "date": "2026-10-09", "sta');
    const j = good(st(box, ['status'], '05:00'));
    assert.equal(j.runFile, 'corrupt');
    assert.match(j.nextAction, /corrupt/);
  });
  test('after the deadline without a publish it says to ship a fallback', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    beat(box, 'primary', 's1', '08:05');
    assert.match(good(st(box, ['status'], '08:10')).nextAction, /deadline/);
  });
});

describe('CLI: throttle', () => {
  test('get shows level, bounds and the effective level config', () => {
    const box = sandbox();
    const j = good(box.state(['throttle', 'get']));
    assert.equal(j.level, 'balanced');
    assert.equal(j.floor, 'minimal');
    assert.equal(j.ceiling, 'balanced');
    assert.equal(j.upAfterCleanDays, 5);
    assert.equal(j.levelConfig.outputTokens, 3_000_000);
    assert.equal(good(box.state(['throttle'])).level, 'balanced'); // get is the default
  });
  test('down goes one notch at a time, never below the floor, always resets cleanDays', () => {
    const box = sandbox();
    // one notch per run date: --force is the operator deliberately stepping down again on the same day
    const steps = ['lean', 'minimal', 'minimal', 'minimal'].map((expected) => {
      const j = good(box.state(['throttle', 'down', '--force', '--reason', 'rate-limit', ...NOW('04:00')]));
      assert.equal(j.to, expected);
      return j;
    });
    assert.deepEqual(steps.map((s) => s.changed), [true, true, false, false]);
    assert.equal(steps[0].levelConfig.outputTokens, 1_500_000);
    const stored = box.readJson('state/throttle.json');
    assert.equal(stored.level, 'minimal');
    assert.equal(stored.lastChange, iso('04:00'));
    assert.equal(stored.log.length, 4);
    assert.deepEqual(stored.log[0], { at: iso('04:00'), action: 'down', from: 'balanced', to: 'lean', reason: 'rate-limit', date: DATE });
    assert.ok(stored.log[3].held);
  });
  test('down is idempotent per run date: repeated signals in one run cost one notch, the next date steps again', () => {
    const box = sandbox();
    box.write(`state/runs/${DATE}.json`, JSON.parse(JSON.stringify(mkRun())));
    const first = good(st(box, ['throttle', 'down', '--reason', 'rate-limit: 429'], '04:00'));
    assert.deepEqual([first.from, first.to, first.changed], ['balanced', 'lean', true]);
    for (const t of ['04:05', '04:10']) {
      const again = good(st(box, ['throttle', 'down', '--reason', 'rate-limit: 429 again'], t));
      assert.deepEqual([again.from, again.to, again.changed, again.alreadyDownToday], ['lean', 'lean', false, true]);
      assert.equal(again.run.updated, false, 'a held signal must not touch the run');
    }
    const stored = box.readJson('state/throttle.json');
    assert.equal(stored.level, 'lean');
    assert.equal(stored.log.length, 3);
    assert.match(stored.log[2].held, /already stepped down/);
    const next = good(box.state(['throttle', 'down', '--reason', 'rate-limit', '--date', '2026-10-10', ...NOW('04:00', '2026-10-10')]));
    assert.deepEqual([next.from, next.to], ['lean', 'minimal']);
  });
  test('a held down still resets the clean-day streak; set clears the once-per-date memory', () => {
    const box = sandbox();
    good(st(box, ['throttle', 'down', '--reason', 'x'], '04:00'));
    good(box.state(['throttle', 'day-clean', '--date', '2026-10-08', ...NOW('04:00')]));
    assert.equal(box.readJson('state/throttle.json').cleanDays, 1);
    good(st(box, ['throttle', 'down', '--reason', 'y'], '04:05'));
    assert.equal(box.readJson('state/throttle.json').cleanDays, 0);
    good(st(box, ['throttle', 'set', '--level', 'balanced'], '04:06'));
    assert.equal(good(st(box, ['throttle', 'down', '--reason', 'z'], '04:07')).to, 'lean');
  });
  test('up goes one notch at a time and never above the ceiling', () => {
    const box = sandbox();
    box.write('state/throttle.json', { schema: 1, level: 'minimal', cleanDays: 3, lastChange: null, log: [] });
    assert.equal(good(box.state(['throttle', 'up', ...NOW('04:00')])).to, 'lean');
    assert.equal(box.readJson('state/throttle.json').cleanDays, 0);
    assert.equal(good(box.state(['throttle', 'up', ...NOW('04:00')])).to, 'balanced');
    const top = good(box.state(['throttle', 'up', ...NOW('04:00')]));
    assert.equal(top.to, 'balanced');
    assert.equal(top.changed, false);
  });
  test('set is an explicit override (even all-in), validated', () => {
    const box = sandbox();
    assert.equal(good(box.state(['throttle', 'set', '--level', 'all-in', ...NOW('04:00')])).level, 'all-in');
    const up = good(box.state(['throttle', 'up']));
    assert.equal(up.to, 'all-in'); // above the ceiling: up does nothing
    assert.equal(good(box.state(['throttle', 'down', '--reason', 'usage-limit'])).to, 'balanced');
    assert.equal(box.state(['throttle', 'set', '--level', 'turbo']).code, 2);
    assert.equal(box.state(['throttle', 'set']).code, 2);
    assert.equal(box.state(['throttle', 'sideways']).code, 2);
  });
  test('day-clean counts once per date and auto-ups after upAfterCleanDays', () => {
    const box = sandbox();
    box.write('state/throttle.json', { schema: 1, level: 'lean', cleanDays: 0, lastChange: null, log: [] });
    const clean = (date) => good(box.state(['throttle', 'day-clean', '--date', date, ...NOW('08:30', date)]));
    assert.equal(clean('2026-10-09').alreadyCounted, false);
    assert.equal(clean('2026-10-09').alreadyCounted, true); // re-running the playbook step is harmless
    assert.equal(box.readJson('state/throttle.json').cleanDays, 1);
    for (const d of ['2026-10-10', '2026-10-11', '2026-10-12']) clean(d);
    assert.equal(box.readJson('state/throttle.json').level, 'lean');
    assert.equal(box.readJson('state/throttle.json').cleanDays, 4);
    const fifth = clean('2026-10-13');
    assert.equal(fifth.changed, true);
    assert.equal(fifth.to, 'balanced');
    assert.equal(box.readJson('state/throttle.json').cleanDays, 0);
    for (const d of ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20']) clean(d);
    assert.equal(box.readJson('state/throttle.json').level, 'balanced'); // at the ceiling
    assert.equal(box.readJson('state/throttle.json').cleanDays, 5); // and the counter stops growing
  });
  test('down after clean days resets the streak', () => {
    const box = sandbox();
    good(box.state(['throttle', 'day-clean', '--date', '2026-10-09', ...NOW('08:30')]));
    good(box.state(['throttle', 'day-clean', '--date', '2026-10-10', ...NOW('08:30', '2026-10-10')]));
    assert.equal(box.readJson('state/throttle.json').cleanDays, 2);
    good(box.state(['throttle', 'down', '--reason', 'overage-warning']));
    assert.equal(box.readJson('state/throttle.json').cleanDays, 0);
  });
  test('a throttle-down during a live run is mirrored into it (level, event kind, forced scope-cut)', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    const lean = good(st(box, ['throttle', 'down', '--reason', 'rate-limit hit in ideate'], '04:10'));
    assert.equal(lean.run.updated, true);
    let run = box.run();
    assert.equal(run.throttle, 'lean');
    assert.deepEqual(run.events.at(-1), { at: iso('04:10'), by: 'throttle', kind: 'rate-limit', msg: 'throttle -> lean: rate-limit hit in ideate' });
    assert.equal(run.targetTier, 1);
    const min = good(st(box, ['throttle', 'down', '--force', '--reason', 'budget-exhausted'], '04:20'));
    assert.deepEqual(min.run.directive, { kind: 'scope-cut', tier: 2 });
    run = box.run();
    assert.equal(run.throttle, 'minimal');
    assert.equal(run.targetTier, 2);
    assert.equal(run.events.at(-1).kind, 'budget');
    assert.deepEqual(run.directives.map((d) => [d.kind, d.tier, d.by]), [['scope-cut', 2, 'throttle']]);
    // begin and beat now report the new budget
    assert.equal(good(begin(box, 'primary', 's1', '04:25')).levelConfig.outputTokens, 500_000);
    assert.equal(good(beat(box, 'primary', 's1', '04:26')).spend.capTokens, 250_000);
  });
  test('no live run => throttle still changes, run mirroring is skipped', () => {
    const box = sandbox();
    assert.equal(good(box.state(['throttle', 'down', '--reason', 'x', ...NOW('04:00')])).run.updated, false);
  });
  test('an unreadable throttle.json falls back to the configured level', () => {
    const box = sandbox();
    box.write('state/throttle.json', '{oops');
    assert.equal(good(box.state(['throttle', 'get'])).level, 'balanced');
    assert.equal(good(box.state(['throttle', 'down', '--reason', 'x', ...NOW('04:00')])).to, 'lean');
    assert.equal(box.readJson('state/throttle.json').level, 'lean');
  });
});

// ---------------------------------------------------------------------------------------
// robustness: corrupt files, atomic writes, locks, concurrency
// ---------------------------------------------------------------------------------------

describe('run file robustness', () => {
  const garbage = [
    ['truncated JSON', (good) => good.slice(0, 40)],
    ['empty file', () => ''],
    ['a JSON array', () => '[]'],
    ['an object without the required fields', () => '{"schema":1}'],
    ['binary junk', () => '\u0000\u0001\u0002not json'],
    ['a run for another date', (good) => good.replace('"date": "2026-10-09"', '"date": "2026-10-08"')],
    ['an unknown phase', (good) => good.replace('"phase": "preflight"', '"phase": "brunch"')],
  ];
  for (const [label, damage] of garbage) {
    test(`${label} => treated as missing, preserved as .corrupt-1, event recorded`, () => {
      const box = sandbox();
      begin(box, 'primary', 's1', '03:55');
      const original = box.read(box.runFile());
      const damaged = damage(original);
      fs.writeFileSync(box.path(box.runFile()), damaged);
      const j = good(begin(box, 'primary', 's2', '04:30'));
      assert.equal(j.action, 'proceed');
      assert.equal(j.targetTier, 1);
      assert.equal(j.corrupt.preservedAs, `state/runs/${DATE}.json.corrupt-1`);
      assert.equal(fs.readFileSync(box.path(`${box.runFile()}.corrupt-1`), 'utf8'), damaged);
      const ev = box.run().events[0];
      assert.equal(ev.kind, 'error');
      assert.equal(ev.code, 'corrupt-run');
      assert.match(ev.msg, /corrupt-run/);
      assert.equal(box.run().lease.session, 's2');
    });
  }
  test('a second corruption never overwrites the first preserved file', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    fs.writeFileSync(box.path(box.runFile()), 'first damage');
    begin(box, 'primary', 's2', '04:00');
    fs.writeFileSync(box.path(box.runFile()), 'second damage');
    const j = good(begin(box, 'primary', 's3', '04:05'));
    assert.equal(j.corrupt.preservedAs, `state/runs/${DATE}.json.corrupt-2`);
    assert.equal(box.read(`${box.runFile()}.corrupt-1`), 'first damage');
    assert.equal(box.read(`${box.runFile()}.corrupt-2`), 'second damage');
  });
  test('other commands report a corrupt file clearly instead of crashing, and leave it alone', () => {
    const box = sandbox();
    box.write(box.runFile(), '{"schema":1,"da');
    for (const args of [['beat', '--role', 'primary', '--session', 's'], ['phase-start', '--phase', 'ideate'], ['finish', '--tier', '1'], ['spend', '--tokens', '1']]) {
      const r = st(box, args, '05:00');
      assert.equal(r.code, 1, args[0]);
      assert.match(r.json.error, /corrupt/);
      assert.match(r.json.error, /begin/);
    }
    assert.equal(box.read(box.runFile()), '{"schema":1,"da');
  });
  test('loadRun (the module export other components use) returns null for missing and corrupt files without touching them', () => {
    const box = sandbox();
    const prev = process.env.SED_ROOT;
    process.env.SED_ROOT = box.root;
    try {
      assert.equal(rs.loadRun(DATE), null);
      box.write(box.runFile(), 'nope');
      assert.equal(rs.loadRun(DATE), null);
      assert.equal(box.read(box.runFile()), 'nope');
      begin(box, 'primary', 's1', '03:55'); // quarantines and recreates
      assert.equal(rs.loadRun(DATE).lease.session, 's1');
    } finally {
      if (prev === undefined) delete process.env.SED_ROOT;
      else process.env.SED_ROOT = prev;
    }
  });
  test('decide({role, session, now, date}) works with the contract signature (reads config and run from disk)', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    good(st(box, ['phase-done', '--phase', 'preflight', '--session', 's1'], '05:00'));
    beat(box, 'primary', 's1', '05:20');
    const prev = process.env.SED_ROOT;
    process.env.SED_ROOT = box.root;
    try {
      const d = rs.decide({ role: 'wdA', session: 'w1', now: at('05:32'), date: DATE });
      assert.equal(d.action, 'exit-alive');
      assert.equal(rs.decide({ role: 'primary', session: 's1', now: at('05:32'), date: DATE }).action, 'resume');
    } finally {
      if (prev === undefined) delete process.env.SED_ROOT;
      else process.env.SED_ROOT = prev;
    }
  });
  test('no temp or lock files are left behind after a busy sequence of commands', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    for (let i = 0; i < 6; i++) good(st(box, ['spend', '--tokens', '10'], '04:00'));
    good(st(box, ['event', '--kind', 'note', '--msg', 'x', '--by', 'primary'], '04:01'));
    good(st(box, ['throttle', 'down', '--reason', 'x'], '04:02'));
    assert.deepEqual(fs.readdirSync(box.path('state/runs')).filter((f) => f !== '.gitkeep').sort(), [`${DATE}.json`]);
    assert.deepEqual(fs.readdirSync(box.path('state')).filter((f) => f.endsWith('.lock') || f.endsWith('.tmp')), []);
  });
  test('writes are atomic: SIGKILLing a process mid-write never leaves a half-written run file', async () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    const base = box.run();
    const runstate = new URL('../scripts/lib/runstate.mjs', import.meta.url).href;
    const code = `
      import { saveRun } from ${JSON.stringify(runstate)};
      const run = ${JSON.stringify(base)};
      run.events = [];
      for (let i = 0; ; i++) {
        run.events.push({ at: 'x', by: 'primary', kind: 'note', msg: 'padding '.repeat(200) + i });
        if (run.events.length > 150) run.events.shift();
        run.spend.outputTokens = i;
        saveRun(run);
        if (i === 5) process.stdout.write('started\\n');
      }`;
    for (const delay of [20, 60, 120, 250, 400]) {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, SED_ROOT: box.root }, stdio: ['ignore', 'pipe', 'ignore'] });
      await new Promise((resolve) => child.stdout.once('data', resolve));
      await new Promise((resolve) => setTimeout(resolve, delay));
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('close', resolve));
      const parsed = JSON.parse(box.read(box.runFile())); // would throw on a torn write
      assert.equal(parsed.schema, 1);
      assert.equal(parsed.date, DATE);
      assert.ok(parsed.spend.outputTokens >= 5);
    }
    const leftovers = fs.readdirSync(box.path('state/runs')).filter((f) => f !== `${DATE}.json` && f !== '.gitkeep');
    assert.ok(leftovers.every((f) => f.endsWith('.tmp') || f.startsWith('.')), leftovers.join(','));
    assert.equal(good(begin(box, 'primary', 's1', '04:00')).ok, true); // and the next session simply carries on
  });
});

describe('locking and concurrency', () => {
  const lockFile = (box) => box.path(`state/runs/.${DATE}.lock`);
  test('a stale lock (older than 30 s) is broken and the command proceeds', () => {
    const box = sandbox();
    fs.mkdirSync(box.path('state/runs'), { recursive: true });
    fs.writeFileSync(lockFile(box), JSON.stringify({ pid: 99999999, token: 'dead', at: 'long ago' }));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockFile(box), old, old);
    const t0 = Date.now();
    const j = good(begin(box, 'primary', 's1', '03:55'));
    assert.equal(j.action, 'proceed');
    assert.ok(Date.now() - t0 < 10_000);
    assert.equal(fs.existsSync(lockFile(box)), false);
  });
  test('a fresh lock held by someone else is waited on for a bounded time, then reported', () => {
    const box = sandbox();
    fs.mkdirSync(box.path('state/runs'), { recursive: true });
    fs.writeFileSync(lockFile(box), JSON.stringify({ pid: process.pid, token: 'mine', at: new Date().toISOString() }));
    const t0 = Date.now();
    const slow = box.cli('state', ['begin', '--role', 'primary', '--session', 's1', ...NOW('03:55')], { SED_LOCK_WAIT_MS: '500' });
    assert.equal(slow.code, 1);
    assert.match(slow.json.error, /could not acquire lock/);
    assert.ok(Date.now() - t0 < 30_000);
    assert.equal(fs.existsSync(box.path(box.runFile())), false);
    assert.equal(fs.existsSync(lockFile(box)), true); // someone else's lock is never removed
  });
  test('a lock held by a crashed process is broken after SED_LOCK_STALE_MS', () => {
    const box = sandbox();
    fs.mkdirSync(box.path('state/runs'), { recursive: true });
    fs.writeFileSync(lockFile(box), JSON.stringify({ pid: 99999999, token: 'dead', at: 'then' }));
    const r = box.cli('state', ['begin', '--role', 'primary', '--session', 's1', ...NOW('03:55')], { SED_LOCK_STALE_MS: '200', SED_LOCK_WAIT_MS: '5000' });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.json.action, 'proceed');
  });
  test('two processes racing `begin` for the same date: exactly one proceeds, the other sees a live lease', async () => {
    for (let round = 0; round < 4; round++) {
      const box = sandbox();
      const [a, b] = await Promise.all([
        box.cliAsync('state', ['begin', '--role', 'primary', '--session', 'racer-a', ...NOW('03:55')]),
        box.cliAsync('state', ['begin', '--role', 'primary', '--session', 'racer-b', ...NOW('03:55')]),
      ]);
      const actions = [a.json.action, b.json.action].sort();
      assert.deepEqual(actions, ['exit-alive', 'proceed'], `round ${round}: ${a.stdout}${b.stdout}`);
      const winner = a.json.action === 'proceed' ? 'racer-a' : 'racer-b';
      const run = box.run();
      assert.equal(run.lease.session, winner);
      assert.equal(run.events.filter((e) => e.msg.startsWith('run created')).length, 1);
      assert.equal(fs.existsSync(lockFile(box)), false);
    }
  });
  test('eight racers (mixed roles): still exactly one proceed', async () => {
    const box = sandbox();
    const specs = [['primary', 'p1'], ['primary', 'p2'], ['primary', 'p3'], ['wdA', 'a1'], ['wdA', 'a2'], ['wdB', 'b1'], ['manual', 'm1'], ['manual', 'm2']];
    const results = await Promise.all(specs.map(([role, session]) => box.cliAsync('state', ['begin', '--role', role, '--session', session, ...NOW('04:00')])));
    const actions = results.map((r) => r.json.action);
    assert.equal(actions.filter((a) => a === 'proceed').length, 1, actions.join(','));
    assert.equal(actions.filter((a) => a === 'exit-alive').length, 7, actions.join(','));
    assert.equal(box.run().events.filter((e) => e.msg.startsWith('run created')).length, 1);
  });
  test('parallel mutations never lose an update', async () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    const results = await Promise.all(Array.from({ length: 12 }, () => box.cliAsync('state', ['spend', '--tokens', '100', '--calls', '1', ...NOW('04:00')])));
    assert.ok(results.every((r) => r.code === 0), results.map((r) => r.stderr).join(''));
    assert.equal(box.run().spend.outputTokens, 1200);
    assert.equal(box.run().spend.agentCalls, 12);
  });
  test('a racing begin and beat leave a valid, consistent file', async () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    const calls = [];
    for (let i = 0; i < 5; i++) {
      calls.push(box.cliAsync('state', ['beat', '--role', 'primary', '--session', 's1', ...NOW('04:10')]));
      calls.push(box.cliAsync('state', ['begin', '--role', 'wdA', '--session', `w${i}`, ...NOW('04:10')]));
    }
    const results = await Promise.all(calls);
    assert.ok(results.every((r) => r.code === 0));
    const run = box.run();
    assert.equal(run.lease.holder, 'primary');
    assert.equal(run.lease.heartbeatAt, iso('04:10'));
  });
});

describe('contract with config.json', () => {
  test('the real config.json has every key this component reads', () => {
    const real = readJson(path.join(REPO_ROOT, 'config.json'));
    const need = (obj, keys, where) => keys.forEach((k) => assert.ok(obj?.[k] !== undefined, `config.json is missing ${where}${k}`));
    need(real, ['timezone', 'workBranch', 'startDate', 'siteUrl', 'leaseStaleMinutes', 'maxAttemptsPerPhase', 'phaseStuckMinutes', 'heartbeatEverySeconds', 'schedule', 'tierCutoffs', 'budget'], '');
    need(real.schedule, ['deadline', 'closer', 'watchdogA', 'watchdogB', 'primary'], 'schedule.');
    need(real.tierCutoffs, ['t1Until', 't2Until', 't3Until'], 'tierCutoffs.');
    need(real.budget, ['level', 'levels', 'reserveForPublishTokens', 'autoThrottle'], 'budget.');
    need(real.budget.autoThrottle, ['floor', 'ceiling', 'upAfterCleanDays', 'downOn'], 'budget.autoThrottle.');
    for (const level of ['all-in', 'balanced', 'lean', 'minimal']) need(real.budget.levels[level], ['outputTokens', 'defaultEffort', 'reviseLoops'], `budget.levels.${level}.`);
  });
  test('the frozen test config still matches the shape of the real one', () => {
    const real = readJson(path.join(REPO_ROOT, 'config.json'));
    for (const key of ['timezone', 'leaseStaleMinutes', 'maxAttemptsPerPhase', 'phaseStuckMinutes']) assert.equal(typeof real[key], typeof TEST_CONFIG[key], key);
    assert.deepEqual(Object.keys(real.budget.levels).sort(), Object.keys(TEST_CONFIG.budget.levels).sort());
  });
});

// ---------------------------------------------------------------------------------------
// git sync (temp BARE remote + clones)
// ---------------------------------------------------------------------------------------

describe('gitsync: sync()', () => {
  const syncA = (box, opts = {}) => sync({ root: box.root, branch: BRANCH, message: 'test sync', noSleep: true, log: () => {}, ...opts });
  const tree = (remote, branch = BRANCH) => git(remote, 'ls-tree', '-r', '--name-only', `refs/heads/${branch}`).split('\n');
  const subject = (cwd, ref = 'HEAD') => git(cwd, 'log', '-1', '--format=%s', ref);
  const gitDirHas = (box, name) => fs.existsSync(path.resolve(box.root, git(box.root, 'rev-parse', '--git-path', name)));

  test('stages only state, docs, work and config.json; never lock or temp files; pushes', async () => {
    const box = repoSandbox();
    box.write('state/runs/2026-10-09.json', { a: 1 });
    box.write('docs/index.html', '<html>');
    box.write('work/2026-10-09/ideas/x.json', '[]');
    box.write('scripts/other.txt', 'not part of the default paths');
    box.write('state/runs/.2026-10-09.lock', 'lock');
    box.write('state/scratch.tmp', 'tmp');
    box.write('docs/deep/leftover.tmp', 'tmp');
    const r = await syncA(box, { message: 'run 2026-10-09: preflight' });
    assert.deepEqual({ ok: r.ok, pushed: r.pushed, reason: r.reason, committed: r.committed }, { ok: true, pushed: true, reason: null, committed: true });
    assert.equal(r.sha, remoteSha(box.remote));
    const files = tree(box.remote);
    for (const f of ['state/runs/2026-10-09.json', 'docs/index.html', 'work/2026-10-09/ideas/x.json', 'config.json']) assert.ok(files.includes(f), f);
    for (const f of ['scripts/other.txt', 'state/runs/.2026-10-09.lock', 'state/scratch.tmp', 'docs/deep/leftover.tmp']) assert.ok(!files.includes(f), f);
    assert.equal(subject(box.remote, `refs/heads/${BRANCH}`), 'run 2026-10-09: preflight');
    assert.match(box.git('status', '--porcelain'), /scripts\//); // still untracked, not swept up
  });

  test('CLI: `sync -m` prints one JSON {ok,pushed,sha,reason}, defaults to config.workBranch, honours --paths', () => {
    const box = repoSandbox();
    box.write('state/a.json', { a: 1 });
    box.write('docs/b.txt', 'b');
    const j = good(box.state(['sync', '-m', 'only docs', '--paths', 'docs', '--no-sleep']));
    assert.deepEqual(Object.keys(j).slice(0, 4), ['ok', 'pushed', 'sha', 'reason']);
    assert.equal(j.pushed, true);
    assert.deepEqual(tree(box.remote).filter((f) => f.startsWith('docs/') || f === 'state/a.json'), ['docs/b.txt']);
    assert.match(box.git('status', '--porcelain'), /state\/a\.json/);
    assert.equal(box.state(['sync']).code, 2);
    assert.equal(box.state(['sync', '-m', '  ']).code, 2);
  });

  test('nothing to commit => ok, pushed:false, reason nothing-to-commit', async () => {
    const box = repoSandbox();
    box.write('state/a.json', { a: 1 });
    await syncA(box);
    const again = await syncA(box);
    assert.deepEqual({ ok: again.ok, pushed: again.pushed, reason: again.reason, committed: again.committed }, { ok: true, pushed: false, reason: 'nothing-to-commit', committed: false });
    assert.equal(again.sha, remoteSha(box.remote));
  });

  test('nothing new to commit but an unpushed local commit => it is still pushed', async () => {
    const box = repoSandbox();
    box.write('docs/a.txt', 'a');
    box.git('add', 'docs/a.txt');
    box.git('commit', '-q', '-m', 'local only');
    const r = await syncA(box);
    assert.equal(r.committed, false);
    assert.equal(r.pushed, true);
    assert.ok(tree(box.remote).includes('docs/a.txt'));
  });

  test('remote moved ahead (someone else pushed): pull --rebase then push, history stays linear', async () => {
    const box = repoSandbox();
    const other = box.cloneB();
    other.write('docs/b.txt', 'from b');
    other.git('add', '-A');
    other.git('commit', '-q', '-m', 'b was here');
    other.git('push', '-q', 'origin', BRANCH);
    box.write('docs/a.txt', 'from a');
    const r = await syncA(box, { message: 'a was here' });
    assert.equal(r.pushed, true);
    const files = tree(box.remote);
    assert.ok(files.includes('docs/a.txt') && files.includes('docs/b.txt'));
    assert.equal(git(box.remote, 'log', '--merges', '--oneline', `refs/heads/${BRANCH}`), '');
    assert.deepEqual(git(box.remote, 'log', '-2', '--format=%s', `refs/heads/${BRANCH}`).split('\n'), ['a was here', 'b was here']);
  });

  test('non-fast-forward rejection (a concurrent writer wins the race): re-pull, rebase and retry succeed', async () => {
    const box = repoSandbox();
    installPushHook(box.remote, { sneakFirst: true });
    box.write('state/x.json', { x: 1 });
    const r = await syncA(box);
    assert.equal(r.ok, true);
    assert.equal(r.pushed, true);
    assert.equal(r.attempts, 2);
    assert.equal(pushCount(box.remote), 2);
    const files = tree(box.remote);
    assert.ok(files.includes('sneaky.txt') && files.includes('state/x.json'));
    assert.equal(git(box.remote, 'log', '--merges', '--oneline', `refs/heads/${BRANCH}`), '');
    assert.equal(r.sha, remoteSha(box.remote));
  });

  test('rebase conflict => {pushed:false, reason:"conflict"}, clean abort, tree and local work intact', async () => {
    const box = repoSandbox();
    box.write('state/runs/2026-10-09.json', { v: 'base' });
    await syncA(box, { message: 'base' });
    const other = box.cloneB();
    other.git('pull', '-q', '--rebase', 'origin', BRANCH);
    other.write('state/runs/2026-10-09.json', { v: 'from b' });
    other.git('add', '-A');
    other.git('commit', '-q', '-m', 'b edits the run');
    other.git('push', '-q', 'origin', BRANCH);
    const remoteBefore = remoteSha(box.remote);

    box.write('state/runs/2026-10-09.json', { v: 'from a' });
    fs.appendFileSync(box.path('.gitignore'), '# local tweak outside the synced paths\n'); // gets autostashed during the pull
    const r = await syncA(box, { message: 'a edits the run' });
    assert.deepEqual({ ok: r.ok, pushed: r.pushed, reason: r.reason }, { ok: false, pushed: false, reason: 'conflict' });
    assert.deepEqual(r.conflicts, ['state/runs/2026-10-09.json']);
    assert.equal(remoteSha(box.remote), remoteBefore); // nothing was pushed, nothing forced
    assert.equal(gitDirHas(box, 'rebase-merge'), false);
    assert.equal(gitDirHas(box, 'rebase-apply'), false);
    assert.equal(box.git('diff', '--name-only', '--diff-filter=U'), '');
    assert.equal(box.git('diff', '--name-only'), '.gitignore'); // the local tweak was restored by the autostash...
    assert.equal(box.git('diff', '--cached', '--name-only'), ''); // ...and nothing is left half-staged
    assert.equal(subject(box.root), 'a edits the run'); // our commit is still there
    assert.deepEqual(box.readJson('state/runs/2026-10-09.json'), { v: 'from a' });
    assert.equal(box.git('stash', 'list'), ''); // the autostash was applied back, not left behind

    // "usable afterward": discard the conflicting commit and sync fresh work
    box.git('fetch', '-q', 'origin');
    box.git('reset', '-q', '--hard', `origin/${BRANCH}`);
    box.write('docs/after.txt', 'fine');
    const next = await syncA(box, { message: 'after the conflict' });
    assert.equal(next.pushed, true);
    assert.ok(tree(box.remote).includes('docs/after.txt'));
  });

  test('push failures back off 2/4/8/16 s (injected clock), give up cleanly, never force, and succeed on a later call', async () => {
    const box = repoSandbox();
    installPushHook(box.remote, { always: true });
    const before = remoteSha(box.remote);
    box.write('docs/a.txt', 'a');
    const slept = [];
    const r = await syncA(box, { noSleep: undefined, sleep: async (ms) => slept.push(ms) });
    assert.deepEqual(BACKOFF_SECONDS, [2, 4, 8, 16]);
    assert.deepEqual(slept, [2000, 4000, 8000, 16000]);
    assert.deepEqual({ ok: r.ok, pushed: r.pushed, attempts: r.attempts, committed: r.committed }, { ok: false, pushed: false, attempts: 5, committed: true });
    assert.match(r.reason, /^push failed: .*rejected/);
    assert.equal(pushCount(box.remote), 5);
    assert.equal(remoteSha(box.remote), before);
    removePushHook(box.remote);
    const later = await syncA(box);
    assert.equal(later.pushed, true); // the earlier commit goes out with the next sync
    assert.equal(later.committed, false);
  });

  test('transient failures recover: two rejected pushes then success on attempt 3', async () => {
    const box = repoSandbox();
    installPushHook(box.remote, { failFirst: 2 });
    box.write('docs/a.txt', 'a');
    const slept = [];
    const r = await syncA(box, { noSleep: undefined, sleep: async (ms) => slept.push(ms) });
    assert.equal(r.pushed, true);
    assert.equal(r.attempts, 3);
    assert.deepEqual(slept, [2000, 4000]);
  });

  test('--no-sleep / SED_NO_SLEEP skip the backoff entirely', async () => {
    const box = repoSandbox();
    installPushHook(box.remote, { failFirst: 4 });
    box.write('docs/a.txt', 'a');
    const t0 = Date.now();
    const r1 = await syncA(box, { noSleep: true });
    assert.equal(r1.pushed, true);
    assert.equal(r1.attempts, 5);
    assert.ok(Date.now() - t0 < 5000, 'would take 30 s with real backoff');

    const box2 = repoSandbox();
    installPushHook(box2.remote, { failFirst: 4 });
    box2.write('docs/a.txt', 'a');
    process.env.SED_NO_SLEEP = '1';
    try {
      const t1 = Date.now();
      const r2 = await syncA(box2, { noSleep: undefined });
      assert.equal(r2.pushed, true);
      assert.ok(Date.now() - t1 < 5000);
    } finally {
      delete process.env.SED_NO_SLEEP;
    }
    // and through the CLI flag
    const box3 = repoSandbox();
    installPushHook(box3.remote, { failFirst: 2 });
    box3.write('docs/a.txt', 'a');
    const t2 = Date.now();
    assert.equal(good(box3.state(['sync', '-m', 'cli', '--no-sleep'])).pushed, true);
    assert.ok(Date.now() - t2 < 8000);
  });

  test('first push creates the work branch on the remote and leaves main alone', async () => {
    const box = repoSandbox({ workBranch: false });
    assert.equal(remoteHas(box.remote), false);
    const mainBefore = remoteSha(box.remote, 'main');
    box.write('state/x.json', { x: 1 });
    const j = good(box.state(['sync', '-m', 'first ever push', '--no-sleep']));
    assert.equal(j.pushed, true);
    assert.equal(remoteHas(box.remote), true);
    assert.equal(remoteSha(box.remote, 'main'), mainBefore);
    assert.equal(box.git('rev-parse', '--abbrev-ref', 'HEAD'), BRANCH);
    assert.ok(tree(box.remote).includes('state/x.json'));
    assert.equal(remoteFile(box.remote, 'state/x.json'), JSON.stringify({ x: 1 }, null, 2));
  });

  test('a checkout on main with the work branch already on the remote lands on the work branch', async () => {
    const box = repoSandbox();
    box.git('checkout', '-q', 'main');
    box.write('state/x.json', { x: 1 });
    const r = await syncA(box);
    assert.equal(r.pushed, true);
    assert.equal(box.git('rev-parse', '--abbrev-ref', 'HEAD'), BRANCH);
    assert.equal(git(box.remote, 'log', '-1', '--format=%s', 'refs/heads/main'), 'seed'); // main untouched
  });

  test('--branch pushes to another branch', async () => {
    const box = repoSandbox();
    box.write('state/x.json', { x: 1 });
    const j = good(box.state(['sync', '-m', 'elsewhere', '--branch', 'claude/elsewhere', '--no-sleep']));
    assert.equal(j.branch, 'claude/elsewhere');
    assert.ok(remoteHas(box.remote, 'claude/elsewhere'));
    assert.ok(!tree(box.remote).includes('state/x.json'));
  });

  test('deleted tracked files and removed directories are committed too', async () => {
    const box = repoSandbox();
    box.write('docs/d/x/index.html', '<html>');
    await syncA(box);
    assert.ok(tree(box.remote).includes('docs/d/x/index.html'));
    fs.rmSync(box.path('docs'), { recursive: true });
    const r = await syncA(box, { message: 'remove the fallback page' });
    assert.equal(r.pushed, true);
    assert.ok(!tree(box.remote).some((f) => f.startsWith('docs/')));
  });

  test('unusable setups come back as ok:false instead of throwing', async () => {
    const box = repoSandbox();
    box.write('docs/a.txt', 'a');
    box.git('remote', 'set-url', 'origin', path.join(box.base, 'does-not-exist.git'));
    const gone = await syncA(box);
    assert.equal(gone.ok, false);
    assert.equal(gone.pushed, false);
    assert.match(gone.reason, /unreachable/);
    assert.equal(gone.committed, true); // the work is safe locally
    box.git('remote', 'remove', 'origin');
    assert.match((await syncA(box)).reason, /no remote/);
    const plain = sandbox();
    const r = plain.state(['sync', '-m', 'x', '--no-sleep']);
    assert.equal(r.code, 1);
    assert.equal(r.json.ok, false);
    assert.match(r.json.reason, /not a git work tree/);
  });

  test('without any configured identity it borrows one through the environment, and never touches global config', async () => {
    const box = repoSandbox();
    const emptyGlobal = path.join(tmpDir('sed-noid-'), 'gitconfig');
    fs.writeFileSync(emptyGlobal, '');
    const globalBefore = fs.readFileSync(GIT_GLOBAL_CONFIG, 'utf8');
    const saved = { ...process.env };
    process.env.GIT_CONFIG_GLOBAL = emptyGlobal;
    for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) delete process.env[k];
    try {
      box.write('docs/a.txt', 'a');
      const r = await syncA(box);
      assert.equal(r.pushed, true, JSON.stringify(r));
      assert.equal(git(box.remote, 'log', '-1', '--format=%an <%ae>', `refs/heads/${BRANCH}`), 'Claude <noreply@anthropic.com>');
    } finally {
      Object.assign(process.env, saved);
    }
    assert.equal(fs.readFileSync(emptyGlobal, 'utf8'), '');
    assert.equal(fs.readFileSync(GIT_GLOBAL_CONFIG, 'utf8'), globalBefore);
    assert.equal(gitTry(box.root, 'config', '--local', '--get', 'user.email').ok, false, 'local repo config must not be modified');
  });

  test('a broken commit signer cannot cost the day: it commits unsigned and carries on (including during the rebase)', async () => {
    const box = repoSandbox();
    box.git('config', 'commit.gpgsign', 'true');
    box.git('config', 'gpg.program', '/bin/false');
    const other = box.cloneB();
    other.write('docs/b.txt', 'b');
    other.git('add', '-A');
    other.git('commit', '-q', '-m', 'b');
    other.git('push', '-q', 'origin', BRANCH);
    box.write('docs/a.txt', 'a');
    const r = await syncA(box);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.pushed, true);
    assert.equal(git(box.remote, 'log', '-1', '--format=%G?', `refs/heads/${BRANCH}`), 'N');
    assert.ok(tree(box.remote).includes('docs/a.txt') && tree(box.remote).includes('docs/b.txt'));
  });

  test('nothing in the sync or heartbeat code can force-push or rewrite the remote', () => {
    for (const rel of ['scripts/lib/gitsync.mjs', 'scripts/heartbeat.mjs']) {
      const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      assert.doesNotMatch(src, /--force|-f['"]|\+refs\/heads\/[^'"]*:refs\/heads/, rel);
      assert.doesNotMatch(src, /shell\s*:\s*true|execSync\(|exec\(/, rel);
    }
  });
});

describe('self-healing after an interrupted session', () => {
  const syncA = (box, opts = {}) => sync({ root: box.root, branch: BRANCH, message: 'recover', noSleep: true, log: () => {}, ...opts });

  test('a stale .git/index.lock left by a killed git is removed; a fresh one is respected', async () => {
    const box = repoSandbox();
    const lock = path.join(box.root, '.git', 'index.lock');
    fs.writeFileSync(lock, '');
    box.write('docs/a.txt', 'a');
    const fresh = await syncA(box);
    assert.equal(fresh.ok, false); // another git may really be running: do not steal its lock
    assert.equal(fs.existsSync(lock), true);
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(lock, old, old);
    const healed = await syncA(box);
    assert.equal(healed.pushed, true, JSON.stringify(healed));
    assert.equal(fs.existsSync(lock), false);
  });

  test('a rebase left open by a killed sync is aborted first, then the sync proceeds', async () => {
    const box = repoSandbox();
    box.write('docs/one.txt', 'one');
    box.git('add', '-A');
    box.git('commit', '-q', '-m', 'one');
    execFileSync('git', ['rebase', '-i', 'HEAD~1'], { cwd: box.root, env: { ...process.env, GIT_SEQUENCE_EDITOR: "sed -i 's/^pick/edit/'" }, stdio: 'ignore' });
    assert.ok(fs.existsSync(path.join(box.root, '.git', 'rebase-merge')), 'fixture: repo should be mid-rebase');
    box.write('docs/two.txt', 'two');
    const r = await syncA(box);
    assert.equal(r.pushed, true, JSON.stringify(r));
    assert.equal(fs.existsSync(path.join(box.root, '.git', 'rebase-merge')), false);
    const files = git(box.remote, 'ls-tree', '-r', '--name-only', `refs/heads/${BRANCH}`);
    assert.match(files, /docs\/one\.txt/);
    assert.match(files, /docs\/two\.txt/);
  });

  test('bad role/session is rejected BEFORE a corrupt run file is quarantined', () => {
    const box = sandbox();
    box.write(box.runFile(), '{broken');
    assert.equal(begin(box, 'overlord', 's1', '04:00').code, 2);
    assert.equal(box.read(box.runFile()), '{broken');
    assert.equal(fs.existsSync(box.path(`${box.runFile()}.corrupt-1`)), false);
    assert.equal(good(begin(box, 'primary', 's1', '04:00')).corrupt.preservedAs, `state/runs/${DATE}.json.corrupt-1`);
  });
});

// ---------------------------------------------------------------------------------------
// whole-day scenarios, driven exactly like the playbook drives the CLI
// ---------------------------------------------------------------------------------------

describe('scenarios', () => {
  const run = (box, args, hhmm) => st(box, args, hhmm);
  const phase = (box, name, session, start, end) => {
    good(run(box, ['phase-start', '--phase', name, '--session', session], start));
    good(run(box, ['phase-done', '--phase', name, '--session', session, '--note', `${name} ok`], end));
  };

  test('A: a healthy day. Watchdogs and the closer stay quiet; throttle counts a clean day', () => {
    const box = sandbox();
    assert.equal(good(box.state(['today', ...NOW('03:54')])).targetTierIfStartedNow, 1);
    assert.equal(good(begin(box, 'primary', 'p', '03:55')).action, 'proceed');
    const times = [['preflight', '03:56', '04:00'], ['ideate', '04:00', '04:20'], ['select', '04:20', '04:25'], ['spec', '04:25', '04:40'], ['build', '04:40', '05:20'], ['qa', '05:20', '05:30']];
    for (const [name, a, b] of times) {
      phase(box, name, 'p', a, b);
      good(run(box, ['spend', '--tokens', '120000', '--calls', '20', '--phase', name, '--session', 'p'], b));
    }
    good(run(box, ['choose', '--idea-id', 'i04', '--slug', 'rake-ladder', '--title', 'Rake Ladder', '--session', 'p'], '04:25'));
    // wdA fires at 05:32 and finds a primary that beat 2 minutes ago
    good(beat(box, 'primary', 'p', '05:30'));
    const before = bytes(box, box.runFile());
    assert.equal(good(begin(box, 'wdA', 'a', '05:32')).action, 'exit-alive');
    assert.deepEqual(bytes(box, box.runFile()), before);
    phase(box, 'revise', 'p', '05:30', '05:50');
    phase(box, 'package', 'p', '05:50', '06:05');
    phase(box, 'publish', 'p', '06:05', '06:10');
    seedPage(box, 1);
    good(run(box, ['finish', '--status', 'published', '--tier', '1', '--url', 'https://example.test/d/2026-10-09-rake-ladder/', '--by', 'primary'], '06:10'));
    good(run(box, ['throttle', 'day-clean'], '06:11'));
    assert.equal(good(begin(box, 'wdB', 'b', '06:47')).action, 'exit-published');
    assert.equal(good(begin(box, 'closer', 'c', '07:27')).action, 'exit-published');
    const status = good(run(box, ['status'], '07:28'));
    assert.equal(status.status, 'published');
    assert.equal(status.tier, 1);
    assert.deepEqual(status.phasesDone, ['preflight', 'ideate', 'select', 'spec', 'build', 'qa', 'revise', 'package', 'publish', 'done']);
    assert.equal(status.chosen.slug, 'rake-ladder');
    assert.equal(status.spend.outputTokens, 720000);
    assert.equal(box.readJson('state/throttle.json').cleanDays, 1);
  });

  test('B: the primary dies in spec. wdA takes over at tier 2, finishes the compact build and publishes', () => {
    const box = sandbox();
    begin(box, 'primary', 'p', '03:55');
    phase(box, 'preflight', 'p', '03:56', '04:00');
    phase(box, 'ideate', 'p', '04:00', '04:20');
    phase(box, 'select', 'p', '04:20', '04:25');
    good(run(box, ['phase-start', '--phase', 'spec', '--session', 'p'], '04:26'));
    box.write(`work/${DATE}/spec/half.md`, 'half a spec');
    // ...silence. The pulse never ran, so nothing else refreshes the lease.
    const j = good(begin(box, 'wdA', 'a', '05:32'));
    assert.equal(j.action, 'takeover');
    assert.equal(j.targetTier, 2);
    assert.equal(j.resumePhase, 'spec');
    assert.deepEqual(j.cleaned, [`work/${DATE}/spec`]);
    assert.equal(box.exists(`work/${DATE}/spec/half.md`), false);
    assert.equal(good(beat(box, 'primary', 'p', '05:33')).leaseHeld, false); // the old primary learns it lost the lease
    phase(box, 'spec', 'a', '05:33', '05:50');
    phase(box, 'build', 'a', '05:50', '06:25');
    phase(box, 'qa', 'a', '06:25', '06:35');
    good(run(box, ['phase-done', '--phase', 'revise', '--note', 'skipped: tier 2', '--session', 'a'], '06:36'));
    phase(box, 'package', 'a', '06:36', '06:40');
    phase(box, 'publish', 'a', '06:40', '06:44');
    seedPage(box, 2);
    good(run(box, ['finish', '--tier', '2', '--url', 'https://example.test/d/b/', '--by', 'wdA'], '06:44'));
    assert.equal(good(begin(box, 'wdB', 'b', '06:47')).action, 'exit-published');
    const events = box.run().events.map((e) => e.kind);
    assert.ok(events.includes('takeover'));
  });

  test('C: everything dies early. attempts run out, wdB degrades to a Postcard, a late primary upgrades it', () => {
    const box = sandbox();
    begin(box, 'primary', 'p', '03:55');
    phase(box, 'preflight', 'p', '03:56', '04:00');
    good(run(box, ['phase-start', '--phase', 'ideate', '--session', 'p'], '04:01')); // attempt 1, then silence
    const a = good(begin(box, 'wdA', 'a', '05:32'));
    assert.equal(a.action, 'takeover');
    assert.equal(a.targetTier, 2);
    assert.equal(a.resumePhase, 'ideate');
    good(run(box, ['phase-start', '--phase', 'ideate', '--session', 'a'], '05:34')); // attempt 2, then silence again
    const b = good(begin(box, 'wdB', 'b', '06:47'));
    assert.equal(b.action, 'takeover');
    assert.equal(b.targetTier, 4);
    assert.equal(b.resumePhase, 'package');
    assert.ok(box.run().events.some((e) => e.kind === 'degrade'));
    good(run(box, ['phase-start', '--phase', 'package', '--session', 'b'], '06:50'));
    box.write(`docs/d/${DATE}-postcard/index.html`, '<html>postcard</html>');
    good(run(box, ['phase-done', '--phase', 'package', '--session', 'b'], '06:55'));
    seedPage(box, 4);
    good(run(box, ['finish', '--tier', '4', '--url', 'https://example.test/d/postcard/', '--by', 'wdB'], '06:58'));
    assert.equal(good(begin(box, 'closer', 'c', '07:27')).action, 'exit-published');
    // the first primary eventually recovers and its real build wins
    seedPage(box, 2);
    good(run(box, ['finish', '--tier', '2', '--url', 'https://example.test/d/real/', '--by', 'primary'], '09:15'));
    assert.equal(box.run().tier, 2);
    assert.equal(box.exists(`docs/d/${DATE}-postcard`), false);
    assert.equal(box.run().replaced[0].tier, 4);
  });

  test('D: the primary is still alive but slow at 07:27. The closer force-degrades to the Ideas Day; the primary then yields, and may upgrade later', () => {
    const box = sandbox();
    begin(box, 'primary', 'p', '03:55');
    phase(box, 'preflight', 'p', '03:56', '04:00');
    phase(box, 'ideate', 'p', '04:00', '04:30');
    phase(box, 'select', 'p', '04:30', '04:35');
    phase(box, 'spec', 'p', '04:35', '05:30');
    good(run(box, ['phase-start', '--phase', 'build', '--session', 'p'], '05:30'));
    for (const t of ['05:55', '06:20', '06:40', '07:05', '07:25']) good(beat(box, 'primary', 'p', t));
    // wdB at 06:47 sees a live primary building: quiet
    assert.equal(good(begin(box, 'wdB', 'b', '06:47')).wrote, false);
    const c = good(begin(box, 'closer', 'c', '07:27'));
    assert.equal(c.action, 'force-degrade');
    assert.equal(c.targetTier, 3);
    assert.equal(c.resumePhase, 'package');
    const pb = good(beat(box, 'primary', 'p', '07:28'));
    assert.equal(pb.leaseHeld, false);
    assert.deepEqual(pb.directives.map((d) => d.kind), ['ship-now']);
    assert.equal(run(box, ['phase-start', '--phase', 'qa', '--session', 'p'], '07:29').code, 1); // zombie writes are refused
    phase(box, 'package', 'c', '07:28', '07:35');
    seedPage(box, 3);
    good(run(box, ['finish', '--tier', '3', '--url', 'https://example.test/d/ideas/', '--by', 'closer'], '07:38'));
    assert.equal(box.run().status, 'published');
    // the primary finishes its real build at 08:20 and upgrades the page
    box.write(`docs/d/${DATE}-ideas-day/index.html`, '<html>');
    seedPage(box, 1);
    const up = good(run(box, ['finish', '--tier', '1', '--url', 'https://example.test/d/real/', '--by', 'primary'], '08:20'));
    assert.equal(up.action, 'upgraded');
    assert.deepEqual(up.removedDirs, [`docs/d/${DATE}-ideas-day`]);
  });

  test('E: a manual genesis run (ROLE_OVERRIDE=manual TARGET_TIER=1) at 10:00 builds a full day, then a rerun refuses to redo it', () => {
    const box = sandbox();
    const j = good(begin(box, 'manual', 'm', '10:00', ['--target-tier', '1']));
    assert.equal(j.action, 'proceed');
    assert.equal(j.targetTier, 1);
    assert.equal(j.resumePhase, 'preflight');
    phase(box, 'preflight', 'm', '10:01', '10:05');
    seedPage(box, 1);
    good(run(box, ['finish', '--tier', '1', '--url', 'https://example.test/'], '12:00'));
    assert.equal(good(begin(box, 'manual', 'm2', '12:30', ['--target-tier', '1'])).action, 'exit-published');
    assert.equal(good(begin(box, 'manual', 'm2', '12:30', ['--target-tier', '1', '--force'])).action, 'exit-published');
  });
});

// ---------------------------------------------------------------------------------------
// several containers, one shared branch: git is the only arbiter
// ---------------------------------------------------------------------------------------

describe('cross-container: lease, directives and concurrent writers', () => {
  const OFFLINE = ['--no-fetch']; // a container that has not (yet) seen what the others pushed
  const push = (box, msg = 'checkpoint') => box.state(['sync', '-m', msg, '--no-sleep']);
  const remoteRun = (box, date = DATE) => JSON.parse(remoteFile(box.remote, `state/runs/${date}.json`));
  const pair = () => {
    const a = repoSandbox();
    return { a, b: a.cloneB() };
  };
  const noRebase = (box) => !fs.existsSync(path.join(box.root, '.git', 'rebase-merge')) && !fs.existsSync(path.join(box.root, '.git', 'rebase-apply'));

  test('double fire from two clones: the second `begin` that never saw the first loses at `sync` and is told it was displaced', () => {
    const { a, b } = pair();
    assert.equal(good(begin(a, 'primary', 'P1', '03:55', OFFLINE)).action, 'proceed');
    assert.equal(good(begin(b, 'primary', 'P2', '03:55', OFFLINE)).action, 'proceed'); // both clones believe they won
    assert.equal(good(push(a)).pushed, true);

    const lost = push(b);
    assert.equal(lost.code, 1);
    assert.deepEqual({ ok: lost.json.ok, pushed: lost.json.pushed, reason: lost.json.reason }, { ok: false, pushed: false, reason: 'displaced' });
    assert.equal(lost.json.remoteLease.session, 'P1');
    assert.ok(noRebase(b), 'the loser\'s tree must stay usable');
    assert.equal(b.git('status', '--porcelain'), '');

    // it keeps learning it lost, on every command that matters
    const bt = good(beat(b, 'primary', 'P2', '03:56'));
    assert.deepEqual({ leaseHeld: bt.leaseHeld, displaced: bt.displaced, holder: bt.holder, holderSession: bt.holderSession }, { leaseHeld: false, displaced: true, holder: 'primary', holderSession: 'P1' });
    for (const args of [['phase-done', '--phase', 'preflight', '--session', 'P2'], ['phase-start', '--phase', 'ideate', '--session', 'P2'], ['spend', '--tokens', '5', '--session', 'P2'], ['choose', '--idea-id', 'i1', '--slug', 's', '--title', 'T', '--session', 'P2'], ['fail', '--reason', 'x', '--session', 'P2']]) {
      const r = st(b, args, '03:57');
      assert.equal(r.code, 1, args[0]);
      assert.equal(r.json.leaseHeld, false, args[0]);
      assert.equal(r.json.displaced, true, args[0]);
      assert.match(r.json.error, /lease is held by primary\/P1/);
    }
    // P2 wrote nothing to the shared run; a second sync still says so
    assert.equal(remoteRun(a).lease.session, 'P1');
    assert.equal(push(b).json.reason, 'displaced');
    // and a fresh `begin` adopts the winner's run instead of fighting it
    assert.equal(good(begin(b, 'primary', 'P2', '03:58')).action, 'exit-alive');
    assert.equal(b.run().lease.session, 'P1');
  });

  test('a second `begin` that DOES see the first one (it fetched) simply exits alive', () => {
    const { a, b } = pair();
    good(begin(a, 'primary', 'P1', '03:55'));
    good(push(a));
    const j = good(begin(b, 'primary', 'P2', '03:56'));
    assert.equal(j.action, 'exit-alive');
    assert.equal(j.wrote, false);
    assert.equal(j.remote.adopted, 'remote-run');
    assert.equal(b.run().lease.session, 'P1');
  });

  test('a takeover of a partitioned primary: the old primary can no longer write or push, and learns it from beat/sync', () => {
    const { a, b } = pair();
    good(begin(a, 'primary', 'P1', '03:55'));
    good(st(a, ['phase-done', '--phase', 'preflight', '--session', 'P1'], '04:00'));
    good(push(a));
    const wdA = a.cloneB('wda');
    const t = good(begin(wdA, 'wdA', 'A1', '05:40'));
    assert.equal(t.action, 'takeover');
    good(push(wdA, 'takeover'));

    // P1 is partitioned: its commands cannot fetch, so they succeed locally...
    assert.equal(good(st(a, ['phase-done', '--phase', 'ideate', '--session', 'P1', ...OFFLINE], '05:41')).ok, true);
    // ...but the moment it can reach git it is told
    const bt = good(beat(a, 'primary', 'P1', '05:42'));
    assert.deepEqual({ leaseHeld: bt.leaseHeld, displaced: bt.displaced, holderSession: bt.holderSession }, { leaseHeld: false, displaced: true, holderSession: 'A1' });
    const next = st(a, ['phase-start', '--phase', 'select', '--session', 'P1'], '05:43');
    assert.equal(next.code, 1);
    assert.equal(next.json.displaced, true);
    const lost = push(a);
    assert.equal(lost.json.reason, 'displaced');
    assert.equal(lost.json.remoteLease.holder, 'wdA');
    // the shared run is exactly wdA's: nothing of the zombie leaked in
    const shared = remoteRun(a);
    assert.equal(shared.lease.session, 'A1');
    assert.equal(shared.phase, 'ideate');
    assert.ok(!shared.phasesDone.some((e) => e.phase === 'ideate'));
    assert.ok(noRebase(a));
  });

  test('the zombie\'s own sync is displaced even when its run file did not conflict textually (git would have merged it silently)', () => {
    const { a } = pair();
    good(begin(a, 'primary', 'P1', '03:55'));
    good(push(a));
    const wdA = a.cloneB('wda');
    good(begin(wdA, 'wdA', 'A1', '05:40'));
    good(push(wdA, 'takeover'));
    // only a heartbeat refresh differs locally (a different hunk than wdA's takeover touched? no: the lease), so make the edit far away
    const run = a.run();
    run.createdAt = '2026-10-09T07:55:00.000Z';
    run.lease.heartbeatAt = iso('05:30');
    a.write(a.runFile(), run);
    const lost = push(a);
    assert.equal(lost.json.reason, 'displaced');
  });

  test('a watchdog\'s directive pushed while the primary checkpoints: no conflict, both writers\' updates survive in one valid file', () => {
    const { a, b } = pair();
    good(begin(a, 'primary', 'P1', '03:55'));
    good(st(a, ['phase-done', '--phase', 'preflight', '--session', 'P1'], '04:30'));
    good(beat(a, 'primary', 'P1', '05:30'));
    good(push(a));
    const wdA = a.cloneB('wda');
    const d = good(begin(wdA, 'wdA', 'A1', '05:32'));
    assert.equal(d.action, 'exit-alive');
    assert.equal(d.directiveAdded, true);
    assert.equal(good(push(wdA, 'scope-cut')).pushed, true);

    // meanwhile the primary (not having fetched) logs, spends and finishes a phase
    good(st(a, ['event', '--kind', 'note', '--msg', 'scouts back', '--by', 'primary', ...OFFLINE], '05:33'));
    good(st(a, ['spend', '--tokens', '120000', '--calls', '8', '--phase', 'ideate', '--session', 'P1', ...OFFLINE], '05:34'));
    good(st(a, ['phase-done', '--phase', 'ideate', '--session', 'P1', ...OFFLINE], '05:35'));
    const r = push(a, 'ideate done');
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json.pushed, true);

    const shared = remoteRun(a);
    assert.equal(shared.lease.session, 'P1');
    assert.deepEqual(shared.directives.map((x) => [x.kind, x.tier, x.by, x.ack]), [['scope-cut', 2, 'wdA', false]]);
    assert.equal(shared.targetTier, 2);
    assert.deepEqual(shared.phasesDone.map((e) => e.phase), ['preflight', 'ideate']);
    assert.equal(shared.spend.outputTokens, 120000);
    const msgs = shared.events.map((e) => e.msg);
    assert.ok(msgs.includes('scouts back'));
    assert.ok(msgs.some((m) => /scope-cut directive/.test(m)));
    assert.equal(new Set(shared.events.map((e) => JSON.stringify(e))).size, shared.events.length, 'no duplicated events');
    assert.ok(noRebase(a));
    assert.equal(a.git('status', '--porcelain'), '');
    // the primary's next beat hands it the directive it never fetched separately
    assert.deepEqual(good(beat(a, 'primary', 'P1', '05:36')).directives.map((x) => x.kind), ['scope-cut']);
  });

  test('a textually clean git merge of the run file is still replaced by the semantic merge (state of two writers never half-mixed)', () => {
    const { a } = pair();
    good(begin(a, 'primary', 'P1', '03:55'));
    good(st(a, ['phase-done', '--phase', 'preflight', '--session', 'P1'], '04:30'));
    good(beat(a, 'primary', 'P1', '05:30'));
    good(push(a));
    const wdA = a.cloneB('wda');
    good(begin(wdA, 'wdA', 'A1', '05:32'));
    good(push(wdA, 'scope-cut'));
    // the primary only finishes a phase: git alone could merge these hunks without a conflict
    good(st(a, ['phase-done', '--phase', 'ideate', '--session', 'P1', ...OFFLINE], '05:35'));
    const r = push(a, 'ideate done');
    assert.equal(r.json.pushed, true, r.stdout);
    const shared = remoteRun(a);
    assert.deepEqual(shared.phasesDone.map((e) => e.phase), ['preflight', 'ideate']);
    assert.deepEqual(shared.directives.map((x) => x.kind), ['scope-cut']);
    assert.equal(shared.targetTier, 2);
    assert.equal(shared.lease.session, 'P1');
    assert.deepEqual(JSON.parse(a.read(a.runFile())), shared, 'the working tree and the remote agree');
  });

  test('beat and phase-start see a watchdog\'s directive without any sync of their own', () => {
    const { a } = pair();
    good(begin(a, 'primary', 'P1', '03:55'));
    good(st(a, ['phase-done', '--phase', 'preflight', '--session', 'P1'], '04:30'));
    good(beat(a, 'primary', 'P1', '05:30'));
    good(push(a));
    const wdA = a.cloneB('wda');
    good(begin(wdA, 'wdA', 'A1', '05:32'));
    good(push(wdA, 'scope-cut'));
    assert.deepEqual(a.run().directives, []);
    const bt = good(beat(a, 'primary', 'P1', '05:36'));
    assert.deepEqual(bt.directives.map((x) => [x.kind, x.tier]), [['scope-cut', 2]]);
    assert.equal(bt.targetTier, 2);
    assert.equal(bt.leaseHeld, true);
    // acknowledging it locally and syncing keeps it acknowledged for everybody
    good(st(a, ['ack-directive', '--kind', 'scope-cut'], '05:37'));
    good(push(a));
    assert.equal(remoteRun(a).directives[0].ack, true);
    assert.deepEqual(good(beat(wdA, 'wdA', 'A1', '05:38')).directives, []);
  });

  test('the closer\'s force-degrade displaces a live primary: beat says so, with the ship-now directive, and nothing it does is accepted', () => {
    const { a } = pair();
    good(begin(a, 'primary', 'P1', '03:55'));
    for (const p of ['preflight', 'ideate']) good(st(a, ['phase-done', '--phase', p, '--session', 'P1'], '04:30'));
    good(beat(a, 'primary', 'P1', '07:20'));
    good(push(a));
    const closer = a.cloneB('closer');
    const f = good(begin(closer, 'closer', 'C1', '07:27'));
    assert.equal(f.action, 'force-degrade');
    good(push(closer, 'force-degrade'));

    const bt = good(beat(a, 'primary', 'P1', '07:28'));
    assert.deepEqual({ leaseHeld: bt.leaseHeld, displaced: bt.displaced, holder: bt.holder }, { leaseHeld: false, displaced: true, holder: 'closer' });
    assert.deepEqual(bt.directives.map((x) => [x.kind, x.tier]), [['ship-now', 3]]);
    assert.equal(st(a, ['phase-done', '--phase', 'package', '--session', 'P1'], '07:29').json.displaced, true);
    assert.equal(a.run().lease.session, 'P1', 'a displaced writer\'s local file is left alone so that sync still sees the conflict');
    // with nothing of its own to push there is nothing to refuse: the sync just brings it up to date
    const idle = good(push(a));
    assert.equal(idle.pushed, false);
    assert.equal(a.run().lease.session, 'C1');
  });

  test('work files for a day whose lease was lost are not pushed either, even though no run file is involved', () => {
    const { a } = pair();
    good(begin(a, 'primary', 'P1', '03:55'));
    good(push(a));
    const wdA = a.cloneB('wda');
    good(begin(wdA, 'wdA', 'A1', '05:40'));
    good(push(wdA, 'takeover'));
    a.write(`work/${DATE}/build/site/app.js`, 'console.log(1)');
    a.write('docs/d/2026-10-01-other-day/index.html', '<html>');
    const lost = push(a, 'zombie build');
    assert.equal(lost.json.reason, 'displaced');
    assert.ok(!git(a.remote, 'ls-tree', '-r', '--name-only', `refs/heads/${BRANCH}`).includes('app.js'));
    // files for a different, unrelated day are not held hostage by this day's lost lease
    fs.rmSync(a.path(`work/${DATE}`), { recursive: true });
    a.git('reset', '-q', '--hard', 'origin/' + BRANCH);
    a.write('work/2026-10-01/ideas/x.json', '[]');
    assert.equal(good(push(a, 'other day')).pushed, true);
  });

  test('a displaced late finisher can still upgrade a fallback: finish adopts what was published, sync merges history and the fallback page goes', () => {
    const { a } = pair();
    good(begin(a, 'primary', 'P1', '03:55'));
    for (const p of ['preflight', 'ideate']) good(st(a, ['phase-done', '--phase', p, '--session', 'P1'], '04:30'));
    good(push(a));
    const closer = a.cloneB('closer');
    good(begin(closer, 'closer', 'C1', '07:27'));
    seedPage(closer, 3);
    closer.write('docs/index.html', '<html>gallery with the ideas day</html>');
    good(st(closer, ['finish', '--tier', '3', '--url', 'https://example.test/ideas/', '--by', 'closer'], '07:35'));
    good(push(closer, 'closer fallback'));

    // the primary's build was done all along; it notices at 08:20
    seedPage(a, 1, { slug: 'real' });
    a.write('docs/index.html', '<html>gallery with the real build</html>');
    const up = good(st(a, ['finish', '--tier', '1', '--url', 'https://example.test/real/', '--by', 'primary'], '08:20'));
    assert.equal(up.action, 'upgraded');
    const r = push(a, 'late finisher');
    assert.equal(r.code, 0, r.stdout);
    assert.equal(r.json.pushed, true);
    assert.equal(r.json.rebuildSite, true, 'the generated gallery page conflicted: the operator must rebuild the site');
    const shared = remoteRun(a);
    assert.equal(shared.status, 'published');
    assert.equal(shared.tier, 1);
    assert.equal(shared.publishedUrl, 'https://example.test/real/');
    assert.deepEqual(shared.replaced.map((x) => x.tier), [3]);
    const files = git(a.remote, 'ls-tree', '-r', '--name-only', `refs/heads/${BRANCH}`).split('\n');
    assert.ok(files.includes(`docs/d/${DATE}-real/index.html`));
    assert.ok(!files.some((f) => f.startsWith(`docs/d/${DATE}-ideas-day/`)), 'the replaced fallback page is gone from the branch');
    const history = JSON.parse(remoteFile(a.remote, 'state/history.json'));
    assert.deepEqual(history.entries.map((e) => [e.date, e.tier]), [[DATE, 1]]);
  });

  test('finish by a displaced primary never DOWNGRADES a better tier somebody else published', () => {
    const { a } = pair();
    good(begin(a, 'primary', 'P1', '03:55'));
    good(push(a));
    const wdA = a.cloneB('wda');
    good(begin(wdA, 'wdA', 'A1', '05:40'));
    seedPage(wdA, 2);
    good(st(wdA, ['finish', '--tier', '2', '--by', 'wdA'], '06:30'));
    good(push(wdA, 'published'));
    seedPage(a, 4);
    const r = st(a, ['finish', '--tier', '4', '--by', 'primary'], '07:00');
    assert.equal(r.code, 1);
    assert.equal(r.json.action, 'refused');
    assert.match(r.json.error, /downgrade/);
  });

  test('begin sees the remote heartbeat of the lease holder even when the working tree has not pulled it', () => {
    const { a } = pair();
    good(begin(a, 'primary', 'P1', '03:55'));
    good(st(a, ['phase-done', '--phase', 'preflight', '--session', 'P1'], '04:30'));
    good(push(a));
    const hbDir = path.join(tmpDir('sed-hb-'), 'clone');
    const hb = a.cli('heartbeat', ['--role', 'primary', '--session', 'P1', '--phase', 'ideate', '--wait', '0', '--now', iso('05:25')], { SED_HB_DIR: hbDir, SED_HB_MIN_PUSH_S: '0' });
    assert.equal(hb.json.pushed, true, hb.stdout + hb.stderr);
    const wdA = a.cloneB('wda'); // fresh clone: has the heartbeat already
    assert.equal(good(begin(wdA, 'wdA', 'A1', '05:32')).action, 'exit-alive');
    // `a` has NOT pulled the heartbeat, yet its own begin (as a watchdog on the same stale checkout) must honour it
    assert.equal(a.exists(`state/heartbeats/${DATE}/P1.json`), false);
    const j = good(begin(a, 'wdB', 'B1', '05:36'));
    assert.equal(j.action, 'exit-alive');
    assert.equal(j.lease.source, 'heartbeat-file');
  });

  test('an unreachable remote costs one bounded fetch, then a minute of silence; commands keep working locally', () => {
    const a = repoSandbox();
    a.git('remote', 'set-url', 'origin', path.join(a.base, 'nowhere.git'));
    const first = good(begin(a, 'primary', 'P1', '03:55'));
    assert.equal(first.remote.fetched, false);
    assert.match(first.remote.reason, /fetch failed/);
    const second = good(beat(a, 'primary', 'P1', '03:56'));
    assert.equal(second.leaseHeld, true);
    assert.equal(second.remote.reason, 'fetch-recently-failed');
  });

  test('--no-fetch and SED_NO_FETCH switch the remote look off', () => {
    const { a } = pair();
    good(begin(a, 'primary', 'P1', '03:55'));
    assert.equal(good(beat(a, 'primary', 'P1', '03:56', OFFLINE)).remote, null);
    assert.equal(good(a.cli('state', ['beat', '--role', 'primary', '--session', 'P1', ...NOW('03:57')], { SED_NO_FETCH: '1' })).remote, null);
  });
});

// ---------------------------------------------------------------------------------------
// pure merge of two writers of one run file
// ---------------------------------------------------------------------------------------

describe('mergeRuns() and mergeHistories()', () => {
  const R = (over = {}) => mkRun({ phase: 'ideate', phasesDone: done('preflight'), ...over });
  const withLease = (holder, session, acquired, beat) => ({ lease: lease(holder, session, beat, acquired) });
  const dir = (kind, tier, by, ack = false) => ({ kind, tier, by, at: iso('05:32'), ack });

  test('same holder: directives, events and phasesDone are unioned, counters are summed against the base, acks are OR-ed', () => {
    const base = R({ spend: { outputTokens: 100, agentCalls: 1, byPhase: { preflight: { outputTokens: 100, agentCalls: 1 } } } });
    const remote = R({
      directives: [dir('scope-cut', 2, 'wdA')],
      targetTier: 2,
      events: [{ at: iso('05:32'), by: 'wdA', kind: 'note', msg: 'scope-cut directive (tier 2) issued by wdA' }],
      spend: base.spend,
    });
    const local = R({
      directives: [dir('scope-cut', 2, 'wdA', true)],
      phasesDone: done('preflight', 'ideate'),
      lease: lease('primary', 'p1', '05:34'),
      events: [{ at: iso('05:33'), by: 'primary', kind: 'note', msg: 'x' }],
      spend: { outputTokens: 400, agentCalls: 4, byPhase: { preflight: { outputTokens: 100, agentCalls: 1 }, ideate: { outputTokens: 300, agentCalls: 3 } } },
    });
    const { displaced, run } = rs.mergeRuns(base, remote, local);
    assert.equal(displaced, false);
    assert.deepEqual(run.directives.map((d) => [d.kind, d.ack]), [['scope-cut', true]]);
    assert.deepEqual(run.phasesDone.map((e) => e.phase), ['preflight', 'ideate']);
    assert.deepEqual(run.events.map((e) => e.msg), ['scope-cut directive (tier 2) issued by wdA', 'x']);
    assert.equal(run.spend.outputTokens, 400);
    assert.equal(run.spend.byPhase.ideate.outputTokens, 300);
    assert.equal(run.lease.heartbeatAt, iso('05:34'));
  });

  test('both sides spending: the increments add up instead of one overwriting the other', () => {
    const base = R({ spend: { outputTokens: 100, agentCalls: 1, byPhase: {} } });
    const a = R({ spend: { outputTokens: 150, agentCalls: 2, byPhase: {} } });
    const b = R({ spend: { outputTokens: 130, agentCalls: 1, byPhase: {} } });
    assert.equal(rs.mergeRuns(base, a, b).run.spend.outputTokens, 180);
    assert.equal(rs.mergeRuns(base, a, b).run.spend.agentCalls, 2);
  });

  test('a directive only the other side has still raises the target tier; an acknowledged one does not', () => {
    const base = R();
    const remote = R({ directives: [dir('scope-cut', 2, 'wdA')], targetTier: 2 });
    assert.equal(rs.mergeRuns(base, remote, R()).run.targetTier, 2);
    const acked = R({ directives: [dir('scope-cut', 2, 'wdA', true)], targetTier: 1 });
    assert.equal(rs.mergeRuns(base, acked, R()).run.targetTier, 1);
  });

  test('a takeover (later acquiredAt) beats an older lease whichever side it is on; the loser is "displaced"', () => {
    const old = R();
    const taken = R({ ...withLease('wdA', 'a1', '05:40', '05:40'), phase: 'ideate' });
    const asLocal = rs.mergeRuns(old, old, taken);
    assert.equal(asLocal.displaced, false);
    assert.equal(asLocal.run.lease.session, 'a1');
    const asRemote = rs.mergeRuns(old, taken, old);
    assert.equal(asRemote.displaced, true);
    assert.equal(asRemote.remoteLease.session, 'a1');
  });

  test('takeover winner is authoritative for the phase machinery: the loser\'s progress does not leak, its events do', () => {
    const base = R();
    const zombie = R({ phasesDone: done('preflight', 'ideate'), phase: 'select', attempts: { preflight: 1, ideate: 1, select: 1 }, events: [{ at: iso('05:41'), by: 'primary', kind: 'note', msg: 'zombie' }] });
    const winner = R({ ...withLease('wdA', 'a1', '05:40', '05:40'), phase: 'ideate', attempts: { preflight: 1, ideate: 2 } });
    const { run } = rs.mergeRuns(base, zombie, winner);
    assert.equal(run.lease.session, 'a1');
    assert.equal(run.phase, 'ideate');
    assert.deepEqual(run.phasesDone.map((e) => e.phase), ['preflight']);
    assert.deepEqual(run.attempts, { preflight: 1, ideate: 2, select: 1 }); // attempts only ever grow
    assert.ok(run.events.some((e) => e.msg === 'zombie'));
  });

  test('both created the day (no common ancestor): the one already on the shared branch wins', () => {
    const mine = R({ ...withLease('primary', 'P2', '03:55', '03:55') });
    const theirs = R({ ...withLease('primary', 'P1', '03:55', '03:55') });
    assert.equal(rs.mergeRuns(null, theirs, mine).displaced, true);
    assert.equal(rs.mergeRuns(null, mine, theirs).displaced, true);
    // same session on both sides is just the same writer
    assert.equal(rs.mergeRuns(null, mine, R({ ...withLease('primary', 'P2', '03:55', '04:00') })).displaced, false);
  });

  test('published stays published at the better tier, from whichever side; a late finisher is never displaced for it', () => {
    const base = R();
    const fallback = R({ ...withLease('closer', 'c1', '07:27', '07:35'), status: 'published', tier: 3, publishedAt: iso('07:35'), publishedUrl: 'u3', phase: 'done', phasesDone: done('preflight', 'ideate', 'done') });
    const late = R({ status: 'published', tier: 1, publishedAt: iso('08:20'), publishedUrl: 'u1', phase: 'done', replaced: [{ tier: 3 }] });
    const up = rs.mergeRuns(base, fallback, late);
    assert.equal(up.displaced, false);
    assert.deepEqual([up.run.status, up.run.tier, up.run.publishedUrl], ['published', 1, 'u1']);
    assert.deepEqual(up.run.replaced, [{ tier: 3 }]);
    assert.equal(up.run.lease.session, 'c1');
    // the other way around (the fallback publisher merging the late finisher's version) agrees
    const down = rs.mergeRuns(base, late, fallback);
    assert.deepEqual([down.run.tier, down.run.publishedUrl], [1, 'u1']);
    // an in-progress zombie against a published day: published wins, and the zombie is displaced
    assert.equal(rs.mergeRuns(base, fallback, R()).displaced, true);
    assert.equal(rs.mergeRuns(base, R({ ...withLease('primary', 'p1', '03:55', '04:00') }), fallback).run.status, 'published');
  });

  test('the same content in a different key order merges to itself, and the inputs are never mutated', () => {
    const base = deepFreeze(R());
    const a = deepFreeze(R({ directives: [dir('ship-now', 3, 'closer')] }));
    const b = deepFreeze(R());
    assert.doesNotThrow(() => rs.mergeRuns(base, a, b));
  });

  test('mergeHistories: per-day 3-way merge; deletions only stand when the other side left the entry alone; better tier wins a true conflict', async () => {
    const { mergeHistories } = await import('../scripts/lib/gitsync.mjs');
    const e = (date, tier, slug = 'x') => ({ n: 1, date, slug, tier, path: `d/${date}-${slug}/` });
    const H = (...entries) => ({ schema: 1, startDate: DATE, entries });
    const base = H(e('2026-10-09', 3, 'ideas-day'), e('2026-10-10', 1, 'b'));
    // remote added a day; local replaced the fallback with a real build
    const merged = mergeHistories(base, H(...base.entries, e('2026-10-11', 1, 'c')), H(e('2026-10-09', 1, 'real'), base.entries[1]));
    assert.deepEqual(merged.entries.map((x) => [x.date, x.tier]), [['2026-10-09', 1], ['2026-10-10', 1], ['2026-10-11', 1]]);
    // local removed 10-10 (remote did not touch it): gone; remote removed 10-09 but local changed it: kept
    const gone = mergeHistories(base, H(base.entries[0], base.entries[1]), H(e('2026-10-09', 1, 'real')));
    assert.deepEqual(gone.entries.map((x) => x.date), ['2026-10-09']);
    const kept = mergeHistories(base, H(base.entries[1]), H(e('2026-10-09', 1, 'real'), base.entries[1]));
    assert.deepEqual(kept.entries.map((x) => [x.date, x.tier]), [['2026-10-09', 1], ['2026-10-10', 1]]);
    // both changed the same day differently: better tier
    const fight = mergeHistories(base, H(e('2026-10-09', 4, 'postcard'), base.entries[1]), H(e('2026-10-09', 2, 'real'), base.entries[1]));
    assert.equal(fight.entries[0].tier, 2);
    assert.equal(mergeHistories(base, { nope: 1 }, base), null);
  });
});

// ---------------------------------------------------------------------------------------
// the push target is pinned
// ---------------------------------------------------------------------------------------

describe('sync: the push target cannot be redirected', () => {
  const syncCli = (box, extra = []) => box.state(['sync', '-m', 'agent-tampered', '--no-sleep', ...extra]);
  const remoteBranches = (box) => git(box.remote, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').sort();
  const tip = (box, branch) => git(box.remote, 'rev-parse', `refs/heads/${branch}`);
  const tamperConfig = (box, patch) => {
    const cfgNow = box.readJson('config.json');
    box.write('config.json', { ...cfgNow, ...patch });
  };

  test('an edited workBranch in the WORKING config.json is ignored: the committed one decides, and the edit is not committed', () => {
    const box = repoSandbox();
    const mainBefore = tip(box, 'main');
    tamperConfig(box, { workBranch: 'main' });
    box.write('state/note.json', { a: 1 });
    const r = syncCli(box);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.json.branch, BRANCH);
    assert.equal(r.json.pushed, true);
    assert.equal(r.json.configIgnored, true);
    assert.equal(tip(box, 'main'), mainBefore, 'main must not move');
    assert.equal(JSON.parse(remoteFile(box.remote, 'config.json')).workBranch, BRANCH, 'the tampered config is not on the remote');
    assert.ok(remoteFile(box.remote, 'state/note.json'));
    assert.match(r.stderr, /different work branch/);
  });

  test('--branch must be a claude/* branch: main, other names and option-looking values are refused before anything is committed', () => {
    const box = repoSandbox();
    box.write('state/note.json', { a: 1 });
    const head = box.git('rev-parse', 'HEAD');
    for (const bad of ['main', 'master', 'release', '-f', 'claude/../main', 'claude/', 'claude/x.lock', 'claude/with space']) {
      const r = syncCli(box, ['--branch', bad]);
      assert.equal(r.code, 1, bad);
      assert.equal(r.json.pushed, false, bad);
      assert.match(r.json.reason, /refusing to use branch/, bad);
      assert.equal(box.git('rev-parse', 'HEAD'), head, `${bad}: nothing may be committed`);
    }
    assert.deepEqual(remoteBranches(box), ['claude/sonnet-every-day', 'main']);
  });

  test('a claude/* branch that is the remote\'s default branch is refused too', () => {
    const box = repoSandbox();
    git(box.remote, 'symbolic-ref', 'HEAD', `refs/heads/${BRANCH}`);
    box.git('fetch', '-q', 'origin');
    box.git('remote', 'set-head', 'origin', BRANCH);
    box.write('state/note.json', { a: 1 });
    const r = syncCli(box);
    assert.equal(r.code, 1);
    assert.match(r.json.reason, /default branch/);
  });

  test('a COMMITTED config naming main is refused as well (e.g. after an --allow-config commit)', () => {
    const box = repoSandbox();
    tamperConfig(box, { workBranch: 'main' });
    assert.equal(good(syncCli(box, ['--allow-config'])).pushed, true); // lands on the real branch, with the bad value
    const mainBefore = tip(box, 'main');
    box.write('state/note.json', { a: 2 });
    const r = syncCli(box);
    assert.equal(r.code, 1);
    assert.match(r.json.reason, /refusing to use branch "main"/);
    assert.equal(tip(box, 'main'), mainBefore);
  });

  test('config.json edits are only committed with --allow-config; other changes still go through', () => {
    const box = repoSandbox();
    tamperConfig(box, { leaseStaleMinutes: 9999 });
    box.write('state/note.json', { a: 1 });
    const plain = good(syncCli(box));
    assert.equal(plain.configIgnored, true);
    assert.equal(JSON.parse(remoteFile(box.remote, 'config.json')).leaseStaleMinutes, TEST_CONFIG.leaseStaleMinutes);
    assert.equal(box.readJson('config.json').leaseStaleMinutes, 9999, 'the working copy is left as it was');
    const allowed = good(syncCli(box, ['--allow-config']));
    assert.equal(allowed.configIgnored, undefined);
    assert.equal(JSON.parse(remoteFile(box.remote, 'config.json')).leaseStaleMinutes, 9999);
  });

  test('config.json cannot be smuggled in through a broad --paths either', () => {
    const box = repoSandbox();
    tamperConfig(box, { leaseStaleMinutes: 9999 });
    box.write('state/note.json', { a: 1 });
    for (const paths of ['.', './config.json', 'state,.']) {
      const r = good(syncCli(box, ['--paths', paths]));
      assert.equal(r.configIgnored, true, paths);
    }
    assert.equal(JSON.parse(remoteFile(box.remote, 'config.json')).leaseStaleMinutes, TEST_CONFIG.leaseStaleMinutes);
    assert.ok(remoteFile(box.remote, 'state/note.json'));
  });

  test('an unmodified config.json is simply not reported', () => {
    const box = repoSandbox();
    box.write('state/note.json', { a: 1 });
    assert.equal(good(syncCli(box)).configIgnored, undefined);
  });
});

// ---------------------------------------------------------------------------------------
// "published" must mean a page is on the site
// ---------------------------------------------------------------------------------------

describe('finish: a day is only published when its page and history entry exist', () => {
  const inRoot = (box, fn) => {
    const prev = process.env.SED_ROOT;
    process.env.SED_ROOT = box.root;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.SED_ROOT;
      else process.env.SED_ROOT = prev;
    }
  };

  test('finish on an empty repo (out of order, nothing packaged) is refused and the run stays open', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    const r = st(box, ['finish', '--status', 'published', '--tier', '1', '--by', 'primary'], '05:00');
    assert.equal(r.code, 1);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.action, 'refused');
    assert.match(r.json.error, /no entry for 2026-10-09/);
    assert.equal(box.run().status, 'in_progress');
  });

  test('history entry with the wrong tier, or a page directory without index.html, is refused', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    seedPage(box, 2);
    const wrongTier = st(box, ['finish', '--tier', '1'], '05:00');
    assert.equal(wrongTier.code, 1);
    assert.match(wrongTier.json.error, /records tier 2 .* not tier 1/);
    fs.rmSync(box.path(`docs/d/${DATE}-real-project/index.html`));
    const noIndex = st(box, ['finish', '--tier', '2'], '05:01');
    assert.equal(noIndex.code, 1);
    assert.match(noIndex.json.error, /no index\.html/);
    assert.equal(box.run().status, 'in_progress');
    box.write(`docs/d/${DATE}-real-project/index.html`, '<html>');
    assert.equal(good(st(box, ['finish', '--tier', '2'], '05:02')).action, 'published');
  });

  test('a history path that escapes docs/d does not count as a page', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    box.write('state/history.json', { schema: 1, startDate: DATE, entries: [{ n: 1, date: DATE, slug: 'x', title: 'T', tier: 1, path: '../state/' }] });
    box.write('state/index.html', 'not a page');
    assert.equal(st(box, ['finish', '--tier', '1'], '05:00').code, 1);
  });

  test('a published claim with no page behind it: begin and status say so (and write nothing); once the page lands the claim is true again', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    const run = box.run();
    run.status = 'published';
    run.tier = 1;
    run.publishedAt = iso('05:00');
    run.publishedUrl = 'https://example.test/';
    box.write(box.runFile(), run);
    const before = bytes(box, box.runFile());
    const j = good(begin(box, 'closer', 'c1', '07:27'));
    assert.equal(j.action, 'exit-published');
    assert.equal(j.publicationBacked, false);
    assert.match(j.reason, /no page for it/);
    assert.equal(j.wrote, false);
    assert.deepEqual(bytes(box, box.runFile()), before);
    assert.equal(good(st(box, ['status'], '07:28')).publicationBacked, false);
    seedPage(box, 1);
    assert.equal(good(st(box, ['status'], '07:29')).publicationBacked, true);
    assert.equal(good(begin(box, 'closer', 'c1', '07:30')).publicationBacked, undefined);
    assert.equal(good(st(box, ['finish', '--tier', '1'], '07:31')).action, 'noop');
  });

  test('beginRun({flags.reopenUnbacked}) reopens a phantom publication as failed so a repair can take over', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    for (const phase of ['preflight', 'ideate']) good(st(box, ['phase-done', '--phase', phase, '--session', 's1'], '04:30'));
    const run = box.run();
    Object.assign(run, { status: 'published', tier: 1, publishedAt: iso('05:00') });
    box.write(box.runFile(), run);
    const out = inRoot(box, () =>
      rs.beginRun({ role: 'closer', session: 'deadman', date: DATE, now: at('07:30'), config: cfg, flags: { reopenUnbacked: true, force: true } }),
    );
    assert.equal(out.action, 'force-degrade');
    assert.equal(out.targetTier, 3);
    assert.equal(out.run.status, 'in_progress');
    assert.ok(out.run.events.some((e) => /published claim discarded/.test(e.msg)));
    // a genuine publication is left alone even with the flag
    const real = sandbox();
    begin(real, 'primary', 's1', '03:55');
    seedPage(real, 1);
    good(st(real, ['finish', '--tier', '1'], '05:00'));
    const kept = inRoot(real, () => rs.beginRun({ role: 'closer', session: 'deadman', date: DATE, now: at('07:30'), config: cfg, flags: { reopenUnbacked: true } }));
    assert.equal(kept.action, 'exit-published');
    assert.equal(kept.wrote, false);
  });

  test('deadman --force repairs a day whose run claims "published" but whose page never landed', () => {
    const box = sandbox();
    box.write('ops/taxonomy.json', fs.readFileSync(path.join(REPO_ROOT, 'ops', 'taxonomy.json'), 'utf8'));
    begin(box, 'primary', 's1', '03:55');
    const run = box.run();
    Object.assign(run, { status: 'published', tier: 1, publishedAt: iso('05:00'), publishedUrl: 'https://example.test/' });
    box.write(box.runFile(), run);
    const r = box.cli(path.join(REPO_ROOT, 'scripts', 'deadman.mjs'), ['--force', '--no-git', '--date', DATE, '--now', iso('07:30')]);
    assert.equal(r.json.ok, true, r.stdout + r.stderr);
    assert.equal(r.json.action, 'published', r.stdout);
    assert.ok(box.exists(`docs/d/${DATE}-postcard/index.html`));
    assert.equal(box.run().status, 'published');
    assert.equal(box.run().tier, 4);
    // and now that the page exists, deadman agrees the day is done
    const again = box.cli(path.join(REPO_ROOT, 'scripts', 'deadman.mjs'), ['--force', '--no-git', '--date', DATE, '--now', iso('07:31')]);
    assert.equal(again.json.action, 'none');
  });
});

// ---------------------------------------------------------------------------------------
// a finished build is packaged, not thrown away
// ---------------------------------------------------------------------------------------

describe('decide(): exhausted QA/revise and late takeovers keep the built site', () => {
  const built = (extra = {}) =>
    mkRun({
      targetTier: 2,
      phase: 'qa',
      phasesDone: done('preflight', 'ideate', 'select', 'spec', 'build'),
      attempts: { preflight: 1, ideate: 1, select: 1, spec: 1, build: 1, qa: 1 },
      lease: lease('primary', 'p1', '04:30'),
      ...extra,
    });

  test('qa attempted twice: a takeover at 05:32 skips QA/revise and packages at tier 2 (it used to fall to the Ideas Day)', () => {
    const run = built({ attempts: { preflight: 1, ideate: 1, select: 1, spec: 1, build: 1, qa: 2 } });
    const d = dec('wdA', 'a1', '05:32', run);
    assert.equal(d.action, 'takeover');
    assert.equal(d.targetTier, 2);
    assert.equal(d.resumePhase, 'package');
    assert.deepEqual(d.skipPhases, ['qa', 'revise']);
    assert.ok(d.events.some((e) => e.kind === 'degrade' && /skipping QA\/revise/.test(e.msg)));
    const next = rs.applyDecision(run, d, { role: 'wdA', session: 'a1', nowIso: iso('05:32'), date: DATE });
    assert.deepEqual(next.phasesDone.map((e) => e.phase), ['preflight', 'ideate', 'select', 'spec', 'build', 'qa', 'revise']);
    assert.match(next.phasesDone.at(-1).note, /^skipped/);
    assert.equal(next.phase, 'package');
  });

  test('revise attempted twice behaves the same, and a tier-1 target degrades to tier 2 (QA was skipped), never to tier 3', () => {
    const run = built({ targetTier: 1, phase: 'revise', phasesDone: done('preflight', 'ideate', 'select', 'spec', 'build', 'qa'), attempts: { build: 1, qa: 1, revise: 2 }, lease: lease('primary', 'p1', '04:00') });
    const d = dec('wdA', 'a1', '04:50', run);
    assert.equal(d.targetTier, 2);
    assert.equal(d.resumePhase, 'package');
    assert.deepEqual(d.skipPhases, ['revise']);
  });

  test('after the rescued package, `next` is publish (the skipped phases are not walked back to)', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    for (const p of ['preflight', 'ideate', 'select', 'spec', 'build']) good(st(box, ['phase-done', '--phase', p, '--session', 's1'], '04:50'));
    good(st(box, ['phase-start', '--phase', 'qa', '--session', 's1'], '04:51'));
    good(st(box, ['phase-start', '--phase', 'qa', '--session', 's1'], '04:52'));
    const j = good(begin(box, 'wdA', 'a1', '05:32'));
    assert.deepEqual([j.action, j.targetTier, j.resumePhase, j.builtSiteAvailable], ['takeover', 2, 'package', true]);
    good(st(box, ['phase-start', '--phase', 'package', '--session', 'a1'], '05:33'));
    const pd = good(st(box, ['phase-done', '--phase', 'package', '--session', 'a1'], '05:45'));
    assert.equal(pd.next, 'publish');
  });

  test('wdB at 06:47 with a finished build packages it at tier 2 instead of publishing the Ideas Day', () => {
    const d = dec('wdB', 'b1', '06:47', built());
    assert.deepEqual([d.action, d.targetTier, d.resumePhase, d.builtSiteAvailable], ['takeover', 2, 'package', true]);
    assert.deepEqual(d.skipPhases, ['qa', 'revise']);
    assert.ok(d.events.some((e) => /packaging it as tier 2/.test(e.msg)));
  });

  test('the closer at 07:27 tries one validated package of the finished build before any fallback; the ship-now directive says tier 2', () => {
    const d = dec('closer', 'c1', '07:27', built({ lease: lease('primary', 'p1', '07:20') }));
    assert.deepEqual([d.action, d.targetTier, d.resumePhase], ['force-degrade', 2, 'package']);
    assert.deepEqual(d.directives.map((x) => [x.kind, x.tier]), [['ship-now', 2]]);
    assert.match(d.reason, /package the finished build/);
    // its own re-run resumes instead of degrading again
    const first = rs.applyDecision(built({ lease: lease('primary', 'p1', '07:20') }), d, { role: 'closer', session: 'c1', nowIso: iso('07:27'), date: DATE });
    assert.equal(dec('closer', 'c1', '07:31', first).action, 'resume');
  });

  test('...but not with too little time left (the rescue needs ~20 min before the deadline), after a failed package, or for a run already cut to tier 3', () => {
    assert.equal(dec('closer', 'c1', '07:41', built()).targetTier, 3);
    assert.equal(dec('closer', 'c1', '07:41', built()).resumePhase, 'package');
    const failedPackage = built({ phase: 'package', attempts: { build: 1, package: 2 } });
    assert.equal(dec('closer', 'c1', '07:27', failedPackage).targetTier, 3);
    assert.equal(dec('wdB', 'b1', '06:47', failedPackage).targetTier, 3);
    assert.equal(dec('wdB', 'b1', '06:47', built({ targetTier: 3 })).targetTier, 3);
    // no build at all: unchanged behaviour
    const noBuild = mkRun({ phase: 'spec', phasesDone: done('preflight', 'ideate', 'select') });
    const d = dec('wdB', 'b1', '06:47', noBuild);
    assert.deepEqual([d.targetTier, d.resumePhase, d.builtSiteAvailable], [3, 'package', false]);
  });

  test('a manual run picks its own tier: no rescue, even from a stale lease', () => {
    const d = dec('manual', 'm1', '06:47', built(), { flags: { targetTier: 4 } });
    assert.deepEqual([d.targetTier, d.resumePhase], [4, 'package']);
    assert.deepEqual(d.skipPhases, []);
  });

  test('a rescue never touches work/<D>/build', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    for (const p of ['preflight', 'ideate', 'select', 'spec', 'build']) good(st(box, ['phase-done', '--phase', p, '--session', 's1'], '04:50'));
    box.write(`work/${DATE}/build/site/index.html`, '<html>');
    const j = good(begin(box, 'wdB', 'b1', '06:47'));
    assert.equal(j.resumePhase, 'package');
    assert.deepEqual(j.cleaned, []);
    assert.equal(box.exists(`work/${DATE}/build/site/index.html`), true);
  });
});

// ---------------------------------------------------------------------------------------
// manual runs are not judged by the deadline clock
// ---------------------------------------------------------------------------------------

describe('status: a manual run has no deadline pressure', () => {
  test('two hours into preflight at noon the manual run is alive and nextAction does not say to ship a fallback', () => {
    const box = sandbox();
    good(begin(box, 'manual', 'm1', '12:00', ['--target-tier', '1']));
    good(beat(box, 'manual', 'm1', '13:50'));
    const j = good(st(box, ['status'], '14:00'));
    assert.equal(j.manualRun, true);
    assert.equal(j.clockApplies, false);
    assert.equal(j.phaseMinutes, 120);
    assert.equal(j.stuckLimitMinutes, 180);
    assert.equal(j.lease.stuck, false);
    assert.equal(j.lease.alive, true);
    assert.doesNotMatch(j.nextAction, /deadline has passed|treated as hung|ship the best fallback|STALE/);
    assert.match(j.nextAction, /manual run/);
    assert.match(j.nextAction, /ignore clock hints/);
  });

  test('a manual phase that genuinely hangs is still called out, at twice the limit', () => {
    const box = sandbox();
    good(begin(box, 'manual', 'm1', '12:00', ['--target-tier', '1']));
    good(beat(box, 'manual', 'm1', '14:55'));
    const j = good(st(box, ['status'], '15:05')); // 185 minutes in preflight, heartbeat fresh
    assert.equal(j.lease.stuck, true);
    assert.match(j.nextAction, /limit 180\)/);
    assert.match(j.nextAction, /treated as hung/);
    assert.doesNotMatch(j.nextAction, /deadline has passed/);
  });

  test('a stale manual lease is still stale (a dead container is a dead container)', () => {
    const box = sandbox();
    good(begin(box, 'manual', 'm1', '12:00', ['--target-tier', '1']));
    const j = good(st(box, ['status'], '13:00'));
    assert.equal(j.lease.stale, true);
    assert.match(j.nextAction, /STALE/);
    assert.doesNotMatch(j.nextAction, /deadline has passed/);
  });

  test('non-manual runs keep the clock advice, and a takeover by another role of a manual run uses the manual stuck limit', () => {
    const box = sandbox();
    begin(box, 'primary', 's1', '03:55');
    assert.match(good(st(box, ['status'], '08:10')).nextAction, /deadline has passed/);
    const m = sandbox();
    good(begin(m, 'manual', 'm1', '12:00', ['--target-tier', '1']));
    good(beat(m, 'manual', 'm1', '13:50'));
    assert.equal(good(begin(m, 'wdA', 'a1', '14:00')).action, 'exit-alive');
  });
});
