// Tests for the phase watchdog: scripts/lib/phasewatch.mjs, `state.mjs watch arm|bind|check|disarm|status`, and the lease
// rule in scripts/lib/runstate.mjs (an armed watch that is overdue by more than 15 minutes makes its holder's lease stale).
//
// Most scenarios run the real CLI in-process (main() of state.mjs against SED_ROOT sandboxes, every instant pinned with --now):
// fast, deterministic and independent of machine load. A few spawned runs pin the contract with the shell (one JSON document on
// stdout, exit codes, SED_NOW) and a temp bare remote proves the cross-container parts.
// Clock facts of the frozen test config (same as the real one): hard stop 10:30, grace 09:30, lease stale after 35 minutes,
// phaseStuckMinutes 90, two attempts per phase. Local times are America/New_York (EDT on the fixture date).
// Files a test writes under work/<D> carry the real clock's mtime, which is far in the future of the pinned --now instants: the watch
// ignores such times (a skewed clock is no progress), so only tests that set an mtime with `touch` below see a Workflow "still working".
import './helpers/env.mjs';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { etIso, plusMinutes, tmpDir } from './helpers/env.mjs';
import { DATE, TEST_CONFIG, makeRepoSandbox, makeSandbox } from './helpers/sandbox.mjs';
import { remoteFile } from './helpers/git.mjs';
import { main } from '../scripts/state.mjs';
import * as rs from '../scripts/lib/runstate.mjs';
import * as pw from '../scripts/lib/phasewatch.mjs';

// The real config.json now carries these budgets; the frozen test config does not (that is the "table's own default" case).
const BUDGETS = { preflight: 15, ideate: 90, select: 45, spec: 75, build: 150, qa: 90, revise: 90, package: 25, kaizen: 120 };
const CFG = { ...TEST_CONFIG, phaseBudgetMinutes: BUDGETS };

const iso = (hhmm, date = DATE) => etIso(date, hhmm);
/** An ISO instant, or a local HH:MM on `date`. */
const stamp = (t, date = DATE) => (t.includes('T') ? t : iso(t, date));
const noMillis = (s) => s.replace('.000Z', 'Z');
const pick = (o, ks) => Object.fromEntries(ks.map((k) => [k, o[k]]));
const keys = (o) => Object.keys(o).sort();

// ---------------------------------------------------------------------------------------
// sandboxes and CLI helpers
// ---------------------------------------------------------------------------------------

const boxes = [];
test.after(() => boxes.forEach((b) => b.cleanup()));
function sandbox(config = CFG) {
  const b = makeSandbox({ config });
  boxes.push(b);
  return b;
}
function repoSandbox(config = CFG) {
  const b = makeRepoSandbox({ config });
  boxes.push(b);
  return b;
}

/** One state.mjs invocation in-process against the sandbox: { code, json } like a spawned run, minus the process. */
async function cli(box, args) {
  const prev = process.env.SED_ROOT;
  process.env.SED_ROOT = box.root;
  try {
    const { code, body } = await main(args);
    return { code, json: JSON.parse(JSON.stringify(body)) };
  } finally {
    if (prev === undefined) delete process.env.SED_ROOT;
    else process.env.SED_ROOT = prev;
  }
}
/** Any state.mjs command for the fixture date at `t` (no git fetch). */
const ST = (box, args, t = '04:00') => cli(box, [...args, '--date', DATE, '--now', stamp(t), '--no-fetch']);
/** `watch <sub>` for the fixture date at `t`. */
const W = (box, sub, args, t = '04:00') => ST(box, ['watch', sub, ...args], t);
const arm = (box, phase, t, extra = []) => W(box, 'arm', ['--phase', phase, '--session', 'P1', '--role', 'primary', ...extra], t);
const chk = (box, phase, t, extra = []) => W(box, 'check', ['--phase', phase, '--session', 'P1', ...extra], t);

/** Asserts a clean exit with ok:true and returns the document (works for in-process and spawned results). */
function good(r) {
  assert.equal(r.code, 0, `exit ${r.code}: ${JSON.stringify(r.json)}${r.stderr ?? ''}`);
  assert.ok(r.json && r.json.__unparseable === undefined, `stdout was not one JSON document: ${r.stdout}`);
  assert.equal(r.json.ok, true);
  return r.json;
}
const bytes = (box) => fs.readFileSync(box.path(box.runFile()));
const watchEvents = (run, code) => run.events.filter((e) => e.code === code);
/** Writes `rel` under the sandbox and gives it the modification time of `t` (a local HH:MM on the fixture date): "the Workflow wrote this then". */
function touch(box, rel, t, content = 'x') {
  box.write(rel, content);
  const when = new Date(stamp(t));
  fs.utimesSync(box.path(rel), when, when);
}

/** What `package` leaves behind (a docs page and a history entry): `finish` refuses a day without them. */
function seedPage(box, tier = 1, slug = 'real-project') {
  const dir = `d/${DATE}-${slug}/`;
  box.write(`docs/${dir}index.html`, '<html></html>');
  const history = box.readJson('state/history.json');
  history.entries = history.entries.filter((e) => e.date !== DATE);
  history.entries.push({ n: 1, date: DATE, slug, title: 'T', tier, path: dir });
  box.write('state/history.json', history);
}

/** A primary (session P1) running `phase`: every earlier phase done at `start`, the phase itself started at `at`. */
async function inPhase(phase, { config = CFG, start = '03:55', at = '04:00' } = {}) {
  const box = sandbox(config);
  good(await ST(box, ['begin', '--role', 'primary', '--session', 'P1'], start));
  for (const p of rs.PHASES) {
    if (p === phase) break;
    good(await ST(box, ['phase-done', '--phase', p, '--session', 'P1', '--role', 'primary'], start));
  }
  good(await ST(box, ['phase-start', '--phase', phase, '--session', 'P1'], at));
  return box;
}

/** A primary running `phase` with a bound watch. With the default budgets (ideate 90 + 10 margin) an ideate watch armed at 04:00 falls due at 05:40. */
async function armed(phase = 'ideate', { config = CFG, start = '03:55', at = '04:00', extra = [] } = {}) {
  const box = await inPhase(phase, { config, start, at });
  const a = good(await arm(box, phase, at, extra));
  good(await W(box, 'bind', ['--phase', phase, '--session', 'P1', '--trigger-id', 'trig_1', '--workflow-task', 'wf-1'], at));
  return { box, due: a.dueAt };
}

/** A published day whose kaizen is running (phase kaizen started). */
async function kaizenRun(config = CFG) {
  const box = sandbox(config);
  good(await ST(box, ['begin', '--role', 'primary', '--session', 'P1'], '03:55'));
  for (const p of ['preflight', 'ideate', 'select', 'spec', 'build', 'qa', 'revise', 'package']) {
    good(await ST(box, ['phase-done', '--phase', p, '--session', 'P1', '--role', 'primary'], '04:00'));
  }
  seedPage(box, 1);
  good(await ST(box, ['finish', '--status', 'published', '--tier', '1', '--by', 'primary'], '08:30'));
  good(await ST(box, ['phase-start', '--phase', 'kaizen', '--session', 'P1'], '08:35'));
  return box;
}

/**
 * A primary in build since 04:30 with a fresh heartbeat (05:50) and, unless `arming` is false, a watch that fell due at 05:40.
 * Every instant between 05:50 and 06:00 is therefore "alive by heartbeat, not stuck (phaseStuckMinutes 90 ends at 06:00)":
 * only the watch can make a `begin` there see a dead holder.
 */
async function slowBuild({ arming = true, config = CFG } = {}) {
  const box = await inPhase('build', { config, at: '04:30' });
  if (arming) assert.equal(good(await arm(box, 'build', '04:30', ['--minutes', '60'])).dueAt, iso('05:40'));
  good(await ST(box, ['beat', '--role', 'primary', '--session', 'P1', '--phase', 'build'], '05:50'));
  return box;
}

/** The state.mjs commands among a verdict's steps as argv arrays (the trailing "   (comment)" dropped); they are meant to be run as printed. */
function stateCommands(steps) {
  const prefix = 'run: node scripts/state.mjs ';
  return steps
    .filter((s) => s.startsWith(prefix))
    .map((s) => s.slice(prefix.length).replace(/\s{3,}\(.*$/, ''))
    .map((cmd) => [...cmd.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]));
}
/** Runs a verdict's state.mjs steps in order at `t`; every one must succeed. Returns their documents. */
async function runSteps(box, steps, t) {
  const out = [];
  for (const argv of stateCommands(steps)) out.push(good(await cli(box, [...argv, '--now', stamp(t), '--no-fetch'])));
  return out;
}

// ---------------------------------------------------------------------------------------
// pure pieces
// ---------------------------------------------------------------------------------------

describe('phasewatch: pure pieces', () => {
  const at = (hhmm, date = DATE) => Date.parse(iso(hhmm, date));
  const due = { config: CFG, date: DATE, phase: 'ideate', budgetMinutes: 90 };

  test('zonedInstant: local wall time to an instant, DST aware, any zone', () => {
    const z = (date, hhmm, tz = 'America/New_York') => new Date(pw.zonedInstant(date, hhmm, tz)).toISOString();
    assert.equal(z('2026-10-09', '10:30'), '2026-10-09T14:30:00.000Z'); // EDT
    assert.equal(z('2026-11-01', '10:30'), '2026-11-01T15:30:00.000Z'); // the fall-back day, EST by then
    assert.equal(z('2026-11-01', '00:30'), '2026-11-01T04:30:00.000Z'); // and still EDT just after midnight
    assert.equal(z('2027-03-14', '10:30'), '2027-03-14T14:30:00.000Z'); // the spring-forward day, EDT by then
    assert.equal(z('2026-10-09', '10:30', 'Asia/Kolkata'), '2026-10-09T05:00:00.000Z'); // UTC+5:30
    assert.ok(Number.isFinite(pw.zonedInstant('2027-03-14', '02:30', 'America/New_York')), 'a wall time that does not exist still yields an instant');
    assert.ok(Number.isNaN(pw.zonedInstant('2026-10-09', 'soon', 'America/New_York')));
  });

  test('computeDue: budget + 10 minutes, scaled down to hard stop - 5, never below 5 minutes', () => {
    assert.deepEqual(pw.computeDue({ ...due, nowMs: at('04:00') }), { dueMs: at('05:40'), delayMinutes: 100, clamped: null });
    assert.deepEqual(pw.computeDue({ ...due, nowMs: at('08:45') }), { dueMs: at('10:25'), delayMinutes: 100, clamped: null }); // fits exactly
    assert.deepEqual(pw.computeDue({ ...due, nowMs: at('08:46') }), { dueMs: at('10:25'), delayMinutes: 99, clamped: 'hard-stop' });
    assert.deepEqual(pw.computeDue({ ...due, nowMs: at('10:20') }), { dueMs: at('10:25'), delayMinutes: 5, clamped: 'hard-stop' });
    assert.deepEqual(pw.computeDue({ ...due, nowMs: at('10:21') }), { dueMs: at('10:26'), delayMinutes: 5, clamped: 'min' });
    assert.deepEqual(pw.computeDue({ ...due, nowMs: at('11:30') }), { dueMs: at('11:35'), delayMinutes: 5, clamped: 'min' });
  });

  test('computeDue: kaizen is bounded by the 12:00 cutoff, a manual run and an over day by nothing, and nothing waits longer than 6 hours', () => {
    const kz = { ...due, phase: 'kaizen', budgetMinutes: 120 };
    // the kaizen margin is 10 + 15: the round is never extended, and its last member may start 15 minutes before the budget ends
    assert.deepEqual(pw.computeDue({ ...kz, nowMs: at('08:40') }), { dueMs: at('11:05'), delayMinutes: 145, clamped: null });
    assert.deepEqual([pw.watchMarginMinutes('kaizen'), pw.watchMarginMinutes('build'), pw.watchMarginMinutes('ideate')], [25, 10, 10]);
    assert.deepEqual(pw.computeDue({ ...kz, nowMs: at('10:30') }), { dueMs: at('11:55'), delayMinutes: 85, clamped: 'kaizen-cutoff' });
    assert.equal(pw.computeDue({ ...due, nowMs: at('09:30'), manual: true }).delayMinutes, 100);
    assert.equal(pw.computeDue({ ...due, nowMs: at('09:30'), manual: true }).clamped, null);
    // the local date has moved on: the day is over, the hard stop no longer means anything
    assert.equal(pw.computeDue({ ...due, nowMs: at('00:30', '2026-10-10') }).delayMinutes, 100);
    assert.deepEqual(pw.computeDue({ ...due, nowMs: at('04:00'), budgetMinutes: 1000 }), { dueMs: at('04:00') + 360 * 60_000, delayMinutes: 360, clamped: 'max' });
  });

  test('computeDue: a config without a usable hard stop or timezone entry cannot make it throw or NaN', () => {
    const noStop = { ...CFG, schedule: { deadline: '08:00' } }; // hardStop falls back to the deadline
    assert.equal(pw.computeDue({ ...due, config: noStop, nowMs: at('04:00') }).delayMinutes, 100);
    const broken = { ...CFG, schedule: {} };
    assert.deepEqual(pw.computeDue({ ...due, config: broken, nowMs: at('04:00') }), { dueMs: at('05:40'), delayMinutes: 100, clamped: null });
  });

  test('phaseBudget: the flag, then a positive number in config.phaseBudgetMinutes, then the PLAYBOOK hard caps', () => {
    assert.deepEqual(pw.phaseBudget(CFG, 'build', 20), { minutes: 20, source: 'flag' });
    assert.deepEqual(pw.phaseBudget(CFG, 'build'), { minutes: 150, source: 'config' });
    assert.deepEqual(pw.phaseBudget(TEST_CONFIG, 'build'), { minutes: 80, source: 'default' });
    for (const bad of [0, -3, '60', null, true, [], {}, Number.NaN, Infinity]) {
      assert.deepEqual(pw.phaseBudget({ ...CFG, phaseBudgetMinutes: { build: bad } }, 'build'), { minutes: 80, source: 'default' }, String(bad));
    }
    for (const bad of ['lots', 7, [], null]) assert.equal(pw.phaseBudget({ ...CFG, phaseBudgetMinutes: bad }, 'qa').source, 'default', String(bad));
    // the defaults are the "hard cap" column of PLAYBOOK section 2
    assert.deepEqual({ ...pw.DEFAULT_PHASE_MINUTES }, { preflight: 15, ideate: 75, select: 30, spec: 35, build: 80, qa: 30, revise: 40, package: 25, publish: 15, kaizen: 75 });
  });

  test('the PHASEWATCH line is one self-contained line of validated tokens; send_later.at is the due time rounded up to the minute', () => {
    const f = { date: DATE, phase: 'build', attempt: 2, session: 'cse_ab12', dueAt: '2026-10-09T13:41:30.000Z' };
    // it names the attempt (a timer of an earlier attempt must not act on the current one) and says it is the session's own timer
    assert.equal(pw.watchMessage(f), `PHASEWATCH ${DATE} build attempt 2 session cse_ab12 due 2026-10-09T13:41:30.000Z. Your own timer (phase watch, PLAYBOOK 7.1a). Run: node scripts/state.mjs watch check --date ${DATE} --phase build --session cse_ab12 --attempt 2 and obey its verdict.`);
    // and, with the repo root, the directory to run it in (quoted when the path needs it)
    assert.match(pw.watchMessage({ ...f, root: '/home/user/sonnet-every-day' }), /Run: cd \/home\/user\/sonnet-every-day && node scripts\/state\.mjs watch check .* --attempt 2 and obey/);
    assert.match(pw.watchMessage({ ...f, root: "/tmp/it's here" }), /Run: cd '\/tmp\/it'\\''s here' && node/);
    // the name carries the attempt: the routines list never shows two timers of one name
    assert.deepEqual(pw.sendLaterFor(f), { at: '2026-10-09T13:42:00Z', name: `sed-watch-${DATE}-build-a2`, message: pw.watchMessage(f) });
    assert.notEqual(pw.sendLaterFor({ ...f, attempt: 1 }).name, pw.sendLaterFor(f).name);
    assert.equal(pw.sendLaterFor({ ...f, dueAt: '2026-10-09T13:41:00.000Z' }).at, '2026-10-09T13:41:00Z');
    for (const bad of ['a b', 'x;y', '$(id)', '`id`', 'a"b', '', 'x\ny', 'é', '-flag'.padEnd(200, 'x')]) {
      assert.throws(() => pw.assertToken(bad, 'session'), /plain id/, JSON.stringify(bad));
    }
    for (const fine of ['s1', 'cse_01AbC', 'primary-1760000000', 'trig_01H.x:y@z', 'A'.repeat(120)]) assert.equal(pw.assertToken(fine, 'session'), fine);
  });

  test('readWatch: any junk is "no watch" or "corrupt-watch", never a throw; ids are sanitized', () => {
    const ok = { phase: 'build', session: 'P1', dueAt: iso('06:00'), attempt: 2, triggerId: 'trig_1', workflowTask: 'wf-1' };
    const r = pw.readWatch(ok);
    assert.equal(r.ok, true);
    assert.deepEqual([r.watch.attempt, r.watch.triggerId, r.watch.workflowTask, r.watch.dueMs], [2, 'trig_1', 'wf-1', Date.parse(iso('06:00'))]);
    assert.deepEqual(pw.readWatch({ ...ok, attempt: 'two', triggerId: { x: 1 }, workflowTask: 'a b', dueMs: 5 }).watch, { ...ok, attempt: 1, triggerId: null, workflowTask: null, dueMs: Date.parse(iso('06:00')), stoppedTasks: [] });
    // the tasks a watch stopped are a short list of plain ids, nothing else
    assert.deepEqual(pw.readWatch({ ...ok, stoppedTasks: ['wf-1', 'a b', 7, null, 'wf-2'] }).watch.stoppedTasks, ['wf-1', 'wf-2']);
    assert.deepEqual(pw.readWatch({ ...ok, stoppedTasks: 'wf-1' }).watch.stoppedTasks, []);
    for (const none of [undefined, null]) assert.deepEqual(pw.readWatch(none), { ok: false, reason: 'no-watch' });
    for (const bad of ['x', 0, 7, true, false, '', [], [ok], {}, { ...ok, dueAt: 5 }, { ...ok, dueAt: '2026' }, { ...ok, dueAt: 'tomorrow' }, { ...ok, phase: 'brunch' }, { ...ok, phase: 'done' }, { ...ok, session: '' }, { ...ok, session: 7 }]) {
      assert.deepEqual(pw.readWatch(bad), { ok: false, reason: 'corrupt-watch' }, JSON.stringify(bad));
    }
  });

  test('degradePlan is the two-failures table of PLAYBOOK 6.7', () => {
    const plan = (phase, extra = {}) => pw.degradePlan({ phase, targetTier: 1, hasIdeas: true, blocked: null, ...extra });
    for (const phase of ['select', 'spec', 'build', 'package', 'publish']) assert.deepEqual(pick(plan(phase), ['how', 'toTier', 'skip']), { how: 'tier', toTier: 3, skip: [] }, phase);
    assert.equal(plan('ideate').toTier, 3);
    assert.equal(plan('ideate', { hasIdeas: false }).toTier, 4); // no ideas on disk: only the Postcard needs nothing
    assert.equal(plan('build', { targetTier: 4 }).toTier, 4); // never back up
    assert.deepEqual(pick(plan('qa'), ['how', 'toTier', 'skip']), { how: 'skip', toTier: null, skip: ['qa', 'revise'] });
    assert.deepEqual(pick(plan('revise'), ['how', 'skip']), { how: 'skip', skip: ['revise'] });
    assert.deepEqual(pick(plan('revise', { blocked: { reason: 'S1' } }), ['how', 'toTier']), { how: 'tier', toTier: 3 }); // S1 left: not shippable
    assert.deepEqual(pick(plan('kaizen'), ['how', 'skip']), { how: 'skip', skip: ['kaizen'] });
    assert.deepEqual(pick(plan('preflight'), ['how', 'skip']), { how: 'skip', skip: [] });
  });

  test('planOverdue counts attempts against config.maxAttemptsPerPhase, not against a constant', () => {
    const run = { targetTier: 1, attempts: {}, phasesDone: [{ phase: 'ideate', at: iso('04:00'), by: 'primary' }], lease: { holder: 'primary', session: 'P1' } };
    const watch = { phase: 'build', attempt: 1, dueAt: iso('06:00'), workflowTask: 'wf-1', role: 'primary' };
    const facts = { doneMarker: false, outputs: { required: [], present: [], missing: [] }, hasIdeas: false, blocked: null };
    const plan = (max, used) => pw.planOverdue({ run: { ...run, attempts: { build: used } }, config: { maxAttemptsPerPhase: max }, watch, facts, date: DATE, session: 'P1', overdueMinutes: 5 });
    assert.deepEqual(pick(plan(3, 2), ['next', 'attemptsUsed', 'attemptsLeft', 'maxAttempts']), { next: 'retry', attemptsUsed: 2, attemptsLeft: 1, maxAttempts: 3 });
    assert.match(plan(3, 1).reason, /1 of 3 attempts spent, 2 are left/);
    assert.match(plan(2, 1).reason, /1 of 2 attempts spent, 1 is left/);
    assert.equal(plan(3, 3).next, 'degrade');
    assert.equal(plan(1, 1).next, 'degrade');
    assert.equal(plan(2, 0).attemptsUsed, 1, 'the watch itself is an attempt even when phase-start was forgotten');
    const unusable = pw.planOverdue({ run: { ...run, attempts: { build: 2 } }, config: {}, watch, facts, date: DATE, session: 'P1', overdueMinutes: 5 });
    assert.deepEqual([unusable.maxAttempts, unusable.next], [2, 'degrade']);
  });

  describe('classifyWatch', () => {
    const mkRun = (over = {}, watch = {}) => ({
      schema: 1,
      date: DATE,
      status: 'in_progress',
      targetTier: 1,
      tier: null,
      phase: 'build',
      phasesDone: ['preflight', 'ideate', 'select', 'spec'].map((phase) => ({ phase, at: iso('04:00'), by: 'primary', note: '' })),
      attempts: { build: 1 },
      phaseStartedAt: { build: iso('04:30') },
      lease: { holder: 'primary', session: 'P1', acquiredAt: iso('03:55'), heartbeatAt: iso('04:30') },
      directives: [],
      chosen: null,
      throttle: 'balanced',
      spend: { outputTokens: 0, agentCalls: 0, byPhase: {} },
      publishedAt: null,
      publishedUrl: null,
      events: [],
      watch: { phase: 'build', attempt: 1, armedAt: iso('04:30'), dueAt: iso('06:00'), session: 'P1', triggerId: 'trig_1', workflowTask: 'wf-1', ...watch },
      ...over,
    });
    const cl = (run, hhmm, extra = {}) => pw.classifyWatch({ run, phase: 'build', session: 'P1', nowMs: at(hhmm), ...extra });
    const code = (c) => [c.verdict, c.code];

    test('early, overdue and the 2 minute tolerance of a minute-granular timer', () => {
      assert.deepEqual(pick(cl(mkRun(), '05:00'), ['verdict', 'remainingMinutes']), { verdict: 'early', remainingMinutes: 60 });
      assert.equal(cl(mkRun(), '05:57').verdict, 'early'); // 3 minutes ahead
      assert.equal(cl(mkRun(), '05:58').verdict, 'overdue'); // exactly 2 minutes ahead is not "more than 2"
      const edge = Date.parse(iso('06:00')) - 2 * 60_000;
      assert.equal(pw.classifyWatch({ run: mkRun(), phase: 'build', session: 'P1', nowMs: edge - 1000 }).verdict, 'early');
      assert.equal(pw.classifyWatch({ run: mkRun(), phase: 'build', session: 'P1', nowMs: edge }).verdict, 'overdue'); // exactly 2 minutes ahead is not "more than 2"
      assert.deepEqual(pick(cl(mkRun(), '06:12'), ['verdict', 'overdueMinutes']), { verdict: 'overdue', overdueMinutes: 12 });
      assert.deepEqual(pick(pw.classifyWatch({ run: mkRun(), phase: 'build', session: 'P1', nowMs: Date.parse(iso('06:00')) - 90_000 }), ['verdict', 'overdueMinutes']), { verdict: 'overdue', overdueMinutes: 0 });
    });

    test('a run that already moved past the phase is stale, whatever the clock says (the race of a phase-done and a late timer)', () => {
      const done = mkRun({ phasesDone: [...mkRun().phasesDone, { phase: 'build', at: iso('05:59'), by: 'primary', note: '' }], phase: 'qa' });
      assert.deepEqual(code(cl(done, '06:30')), ['stale', 'phase-done']);
      // still the current phase, but in phasesDone: done is done
      assert.deepEqual(code(cl(mkRun({ phasesDone: [...mkRun().phasesDone, { phase: 'build', at: iso('05:59'), by: 'primary', note: '' }] }), '06:30')), ['stale', 'phase-done']);
      assert.deepEqual(code(cl(mkRun({ phase: 'qa' }), '06:30')), ['stale', 'phase-moved']);
      // ...except a phase that was started again after it was closed (a skipped phase run once more, PLAYBOOK 4.1)
      const again = mkRun({ phasesDone: [...mkRun().phasesDone, { phase: 'build', at: iso('05:00'), by: 'primary', note: 'skipped', skipped: true }], phaseStartedAt: { build: iso('05:30') } });
      assert.equal(cl(again, '06:30').verdict, 'overdue');
      assert.deepEqual(code(cl(mkRun({ phasesDone: [...mkRun().phasesDone, { phase: 'build', at: iso('05:00'), by: 'primary', note: '' }], phaseStartedAt: { build: iso('04:30') } }), '06:30')), ['stale', 'phase-done']);
    });

    test('every other reason a timer stops mattering', () => {
      assert.deepEqual(code(cl(mkRun({}, { disarmedAt: iso('05:00') }), '06:30')), ['stale', 'disarmed']);
      assert.deepEqual(code(cl(mkRun({ status: 'failed' }), '06:30')), ['stale', 'run-failed']);
      assert.deepEqual(code(cl(mkRun({ lease: { holder: 'wdA', session: 'A1', acquiredAt: iso('05:40'), heartbeatAt: iso('05:40') } }), '06:30')), ['stale', 'lease-held-by-other']);
      assert.deepEqual(code(cl(mkRun(), '06:30', { displacedBy: { holder: 'wdA', session: 'A1' } })), ['stale', 'displaced']);
      assert.deepEqual(code(cl(mkRun({ status: 'published', tier: 1, phase: 'kaizen' }), '06:30')), ['stale', 'published']);
      assert.deepEqual(code(cl(mkRun({ watch: undefined }), '06:30')), ['stale', 'no-watch']);
      assert.deepEqual(code(cl(mkRun({ watch: 'garbage' }), '06:30')), ['stale', 'corrupt-watch']);
      // a lease-less run is not "held by someone else": the watch still applies
      assert.equal(cl(mkRun({ lease: null }), '06:30').verdict, 'overdue');
    });

    test('a request that is not about the run\'s watch is stale and its trigger is not ours to delete (foreign)', () => {
      const run = mkRun();
      assert.deepEqual(pick(pw.classifyWatch({ run, phase: 'qa', session: 'P1', nowMs: at('06:30') }), ['code', 'foreign']), { code: 'other-phase', foreign: true });
      assert.deepEqual(pick(pw.classifyWatch({ run, phase: 'build', session: 'Z9', nowMs: at('06:30') }), ['code', 'foreign']), { code: 'other-session', foreign: true });
      assert.deepEqual(pick(pw.classifyWatch({ run, phase: 'build', session: 'P1', attempt: 3, nowMs: at('06:30') }), ['code', 'foreign']), { code: 'superseded', foreign: true });
      assert.equal(pw.classifyWatch({ run, phase: 'build', session: 'P1', attempt: 1, nowMs: at('06:30') }).verdict, 'overdue');
      assert.equal(cl(run, '06:30').foreign, undefined);
    });

    test('a watch that fired and whose phase was started again afterwards is stale: the retry needs a watch of its own', () => {
      const fired = { firedAt: iso('06:10'), attemptsAtFire: 1 };
      assert.equal(cl(mkRun({}, fired), '06:20').verdict, 'overdue'); // not restarted yet: the same decision again
      assert.deepEqual(code(cl(mkRun({ attempts: { build: 2 } }, fired), '06:20')), ['stale', 'restarted']);
    });
  });
});

// ---------------------------------------------------------------------------------------
// arm
// ---------------------------------------------------------------------------------------

describe('watch arm', () => {
  test('records run.watch, appends the watch-armed event and prints the send_later fields', async () => {
    const box = await inPhase('ideate');
    const j = good(await arm(box, 'ideate', '04:00'));
    const due = iso('05:40'); // config.phaseBudgetMinutes.ideate (90) + 10 minutes of margin
    assert.deepEqual(keys(j), ['armedAt', 'attempt', 'budgetMinutes', 'budgetSource', 'clamped', 'date', 'delayMinutes', 'dueAt', 'heartbeatLoop', 'marginMinutes', 'ok', 'osHeartbeat', 'phase', 'replaced', 'reused', 'role', 'sendLater', 'session', 'then']);
    assert.deepEqual(
      pick(j, ['phase', 'attempt', 'reused', 'session', 'role', 'armedAt', 'dueAt', 'delayMinutes', 'budgetMinutes', 'budgetSource', 'marginMinutes', 'clamped', 'replaced']),
      { phase: 'ideate', attempt: 1, reused: false, session: 'P1', role: 'primary', armedAt: iso('04:00'), dueAt: due, delayMinutes: 100, budgetMinutes: 90, budgetSource: 'config', marginMinutes: 10, clamped: null, replaced: null },
    );
    assert.deepEqual(j.sendLater, {
      at: noMillis(due),
      name: `sed-watch-${DATE}-ideate-a1`,
      message: pw.watchMessage({ date: DATE, phase: 'ideate', attempt: 1, session: 'P1', dueAt: due, root: box.root }), // self-contained: names the attempt and the directory
    });
    assert.ok(!j.sendLater.message.includes('\n'));
    assert.match(j.sendLater.message, /--attempt 1 and obey its verdict\.$/);
    // the launch sequence, in order: the timer, its bind (for this attempt), the heartbeat loop, ONE push, the Workflow, its task bind
    const then = j.then.join('\n');
    const at = (needle) => then.indexOf(needle);
    assert.ok(at('send_later') >= 0 && at('send_later') < at('watch bind --phase ideate --session P1') && at('watch bind --phase ideate --session P1') < at('heartbeat loop') && at('heartbeat loop') < at('state.mjs sync') && at('state.mjs sync') < at('launch the Workflow') && at('launch the Workflow') < at('--workflow-task <its task id>'), then);
    assert.match(then, /watch bind --phase ideate --session P1 --date \S+ --attempt 1 --trigger-id <the trigger_id>/);
    assert.match(then, /sync -m "sed\(\S+\): primary ideate launch \(watch armed\)"/);
    const run = box.run();
    assert.deepEqual(
      pick(run.watch, ['phase', 'attempt', 'armedAt', 'dueAt', 'session', 'triggerId', 'workflowTask']),
      { phase: 'ideate', attempt: 1, armedAt: iso('04:00'), dueAt: due, session: 'P1', triggerId: null, workflowTask: null },
    );
    assert.deepEqual(run.watch.arms, { ideate: 1 });
    const ev = run.events.at(-1);
    assert.deepEqual(pick(ev, ['kind', 'code', 'by', 'at']), { kind: 'note', code: 'watch-armed', by: 'primary', at: iso('04:00') });
    assert.match(ev.msg, /ideate attempt 1, due .*100 min: budget 90 \+ 10 margin/);
    assert.equal(run.lease.heartbeatAt, iso('04:00'), 'the session is demonstrably alive');
    // arming is a sign of life of its own, later than the phase-start before it
    const later = await inPhase('ideate'); // phase-start at 04:00
    good(await arm(later, 'ideate', '04:07'));
    assert.equal(later.run().lease.heartbeatAt, iso('04:07'));
    // ... but only for the session that holds the lease (another session's arm is refused before it can touch anything)
    const other = await inPhase('ideate');
    const refused = await W(other, 'arm', ['--phase', 'ideate', '--session', 'P2'], '04:08');
    assert.equal(refused.code, 1);
    assert.equal(other.run().lease.heartbeatAt, iso('04:00'));
  });

  test('minutes default to config.phaseBudgetMinutes[phase] plus the 10 minute margin, for every phase', async () => {
    for (const [phase, budget] of Object.entries(BUDGETS).filter(([p]) => p !== 'kaizen')) {
      const box = await inPhase(phase);
      const j = good(await arm(box, phase, '04:00'));
      assert.deepEqual([j.delayMinutes, j.dueAt, j.budgetSource], [budget + 10, plusMinutes(iso('04:00'), budget + 10), 'config'], phase);
    }
  });

  test('without config.phaseBudgetMinutes, or with an unusable entry, the PLAYBOOK hard caps apply', async () => {
    const plain = await inPhase('ideate', { config: TEST_CONFIG });
    assert.deepEqual(pick(good(await arm(plain, 'ideate', '04:00')), ['budgetMinutes', 'budgetSource', 'delayMinutes']), { budgetMinutes: 75, budgetSource: 'default', delayMinutes: 85 });
    const bad = await inPhase('build', { config: { ...TEST_CONFIG, phaseBudgetMinutes: { build: -5, ideate: 0, qa: '60' } } });
    assert.deepEqual(pick(good(await arm(bad, 'build', '04:00')), ['budgetMinutes', 'budgetSource', 'delayMinutes']), { budgetMinutes: 80, budgetSource: 'default', delayMinutes: 90 });
  });

  test('--minutes is the budget the Workflow was given: it replaces the configured one, the margin is still added', async () => {
    const box = await inPhase('ideate');
    const j = good(await arm(box, 'ideate', '04:00', ['--minutes', '20']));
    assert.deepEqual(pick(j, ['budgetMinutes', 'budgetSource', 'delayMinutes', 'dueAt']), { budgetMinutes: 20, budgetSource: 'flag', delayMinutes: 30, dueAt: iso('04:30') });
    assert.equal(good(await arm(box, 'ideate', '04:00', ['--minutes', '7.5'])).delayMinutes, 17.5);
  });

  test('--minutes must be a positive number (exit 2, nothing written)', async () => {
    const box = await inPhase('ideate');
    const before = bytes(box);
    for (const bad of ['0', '-5', 'abc', '', 'NaN', 'Infinity']) {
      const r = await arm(box, 'ideate', '04:00', ['--minutes', bad]);
      assert.equal(r.code, 2, JSON.stringify(bad));
      assert.equal(r.json.ok, false);
      assert.match(r.json.error, /minutes/);
    }
    assert.deepEqual(bytes(box), before);
  });

  test('the due time is scaled down to the hard stop minus 5 minutes (10:25) and is never less than 5 minutes away', async () => {
    const box = await inPhase('ideate');
    // [armed at, minutes until due, clamped by, due]
    const table = [
      ['08:45', 100, null, '10:25'], // fits exactly
      ['08:46', 99, 'hard-stop', '10:25'],
      ['09:30', 55, 'hard-stop', '10:25'],
      ['10:20', 5, 'hard-stop', '10:25'],
      ['10:21', 5, 'min', '10:26'],
      ['10:25', 5, 'min', '10:30'],
      ['11:00', 5, 'min', '11:05'], // after the hard stop nothing legitimate runs: a short leash
    ];
    for (const [hhmm, delay, clamped, dueAt] of table) {
      const j = good(await arm(box, 'ideate', hhmm));
      assert.deepEqual([j.delayMinutes, j.clamped, j.dueAt], [delay, clamped, iso(dueAt)], hhmm);
    }
    assert.match(box.run().events.at(-1).msg, /clamped by min/);
  });

  test('a manual run has no deadline pressure: no hard-stop clamp (by the lease holder, or by --role manual)', async () => {
    const manual = sandbox();
    good(await ST(manual, ['begin', '--role', 'manual', '--session', 'M1', '--target-tier', '1'], '09:00'));
    good(await ST(manual, ['phase-done', '--phase', 'preflight', '--session', 'M1', '--role', 'manual'], '09:00'));
    good(await ST(manual, ['phase-start', '--phase', 'ideate', '--session', 'M1'], '09:05'));
    const j = good(await W(manual, 'arm', ['--phase', 'ideate', '--session', 'M1'], '09:10'));
    assert.deepEqual([j.role, j.delayMinutes, j.clamped, j.dueAt], ['manual', 100, null, iso('10:50')]); // a primary would be clamped to 10:25
    const primary = await inPhase('ideate');
    assert.equal(good(await arm(primary, 'ideate', '09:10', ['--role', 'manual'])).clamped, null);
    assert.equal(good(await arm(primary, 'ideate', '09:10')).clamped, 'hard-stop');
  });

  test('midnight and timezone: the clamp follows the LOCAL date, not the UTC one', async () => {
    const box = await inPhase('ideate');
    const arm2 = (now) => cli(box, ['watch', 'arm', '--phase', 'ideate', '--session', 'P1', '--date', DATE, '--now', now, '--no-fetch']);
    // 2026-10-10T03:30Z is 23:30 on the 9th in New York: the day is not over, the hard stop is long gone: 5 minutes
    const late = good(await arm2('2026-10-10T03:30:00Z'));
    assert.deepEqual([late.delayMinutes, late.clamped, late.dueAt], [5, 'min', '2026-10-10T03:35:00.000Z']);
    // 2026-10-10T04:30Z is 00:30 on the 10th: the 9th is over, no deadline pressure for a rerun
    const over = good(await arm2('2026-10-10T04:30:00Z'));
    assert.deepEqual([over.delayMinutes, over.clamped], [100, null]);
    // the last minute before and the first after local midnight
    assert.equal(good(await arm2('2026-10-10T03:59:00Z')).clamped, 'min');
    assert.equal(good(await arm2('2026-10-10T04:00:00Z')).clamped, null);
  });

  test('without --date the run date is the LOCAL date of --now (and SED_NOW), not the UTC one', async () => {
    const box = await inPhase('ideate');
    const status = (now) => cli(box, ['watch', 'status', '--now', now, '--no-fetch']);
    assert.deepEqual(pick(good(await status('2026-10-10T03:30:00Z')), ['date', 'runFile']), { date: DATE, runFile: 'ok' }); // 23:30 on the 9th
    assert.deepEqual(pick(good(await status('2026-10-10T04:00:00Z')), ['date', 'runFile']), { date: '2026-10-10', runFile: 'missing' }); // 00:00 on the 10th
  });

  test('a past day rerun by a non-manual role (the package path of tier 4) is not clamped either', async () => {
    const box = sandbox();
    const past = '2026-10-08';
    const now = iso('10:00'); // the 9th, so the 8th is over
    const begun = good(await cli(box, ['begin', '--role', 'primary', '--session', 'P1', '--date', past, '--now', now, '--no-fetch']));
    assert.equal(begun.resumePhase, 'package');
    const j = good(await cli(box, ['watch', 'arm', '--phase', 'package', '--session', 'P1', '--date', past, '--now', iso('10:05'), '--no-fetch']));
    assert.deepEqual([j.delayMinutes, j.clamped], [35, null]);
  });

  test('DST: on the fall-back day the hard stop is 10:30 EST (15:30Z), on the spring-forward day 10:30 EDT (14:30Z)', async () => {
    for (const [date, begunAt, armedAt, dueAt] of [
      ['2026-11-01', '2026-11-01T08:55:00Z', '2026-11-01T14:30:00Z', '2026-11-01T15:25:00.000Z'],
      ['2027-03-14', '2027-03-14T07:55:00Z', '2027-03-14T13:30:00Z', '2027-03-14T14:25:00.000Z'],
    ]) {
      const box = sandbox();
      good(await cli(box, ['begin', '--role', 'primary', '--session', 'P1', '--date', date, '--now', begunAt, '--no-fetch']));
      const j = good(await cli(box, ['watch', 'arm', '--phase', 'preflight', '--session', 'P1', '--minutes', '100', '--date', date, '--now', armedAt, '--no-fetch']));
      assert.deepEqual([j.dueAt, j.delayMinutes, j.clamped], [dueAt, 55, 'hard-stop'], date);
    }
  });

  test('sendLater.at rounds the due time UP to the minute: the timer never fires before the watch is due', async () => {
    const box = await inPhase('ideate');
    const j = good(await cli(box, ['watch', 'arm', '--phase', 'ideate', '--session', 'P1', '--minutes', '75', '--date', DATE, '--now', '2026-10-09T08:02:30Z', '--no-fetch']));
    assert.deepEqual([j.dueAt, j.sendLater.at, j.delayMinutes], ['2026-10-09T09:27:30.000Z', '2026-10-09T09:28:00Z', 85]);
    assert.match(j.sendLater.message, /due 2026-10-09T09:27:30\.000Z\./);
  });

  test('kaizen (after the publish) is bounded by the 12:00 cutoff, a day that is over by nothing; at most 6 hours', async () => {
    const box = await kaizenRun();
    const early = good(await arm(box, 'kaizen', '08:40'));
    assert.deepEqual([early.delayMinutes, early.dueAt, early.clamped, early.marginMinutes], [145, iso('11:05'), null, 25]);
    const late = good(await arm(box, 'kaizen', '10:30'));
    assert.deepEqual([late.delayMinutes, late.dueAt, late.clamped], [85, iso('11:55'), 'kaizen-cutoff']);
    const long = await inPhase('ideate');
    const j = good(await arm(long, 'ideate', '04:00', ['--minutes', '1000']));
    assert.deepEqual([j.delayMinutes, j.clamped], [360, 'max']);
  });

  test('arming again counts the arms of the phase once per launch: attempt 2 means a retry; the counter is per phase and survives other phases', async () => {
    const box = await inPhase('ideate');
    const a1 = good(await arm(box, 'ideate', '04:00'));
    // the same launch armed twice (a compaction between two steps, a command that was run again) is ONE attempt, refreshed in place
    const again = good(await arm(box, 'ideate', '04:05'));
    assert.deepEqual([a1.attempt, a1.reused, again.attempt, again.reused], [1, false, 1, true]);
    assert.equal(again.dueAt, plusMinutes(iso('04:05'), 100), 'the due time follows the newer arm');
    assert.deepEqual([box.run().watch.attempt, box.run().watch.arms], [1, { ideate: 1 }]);
    assert.equal(watchEvents(box.run(), 'watch-armed').length, 2);
    assert.match(watchEvents(box.run(), 'watch-armed')[1].msg, /re-armed \(same launch\)/);
    // a phase-start in between is a new launch: the retry
    good(await ST(box, ['phase-start', '--phase', 'ideate', '--session', 'P1'], '04:06'));
    const a2 = good(await arm(box, 'ideate', '04:07'));
    assert.deepEqual([a2.attempt, a2.reused], [2, false]);
    assert.match(a2.sendLater.message, /^PHASEWATCH \S+ ideate attempt 2 /);
    assert.deepEqual([box.run().watch.attempt, box.run().watch.arms], [2, { ideate: 2 }]);
    assert.equal(a2.replaced, null, 'the first one was never bound: there is no trigger to delete');
    // another phase starts its own count, and coming back to ideate continues the old one
    good(await ST(box, ['phase-done', '--phase', 'ideate', '--session', 'P1', '--role', 'primary'], '04:10'));
    good(await ST(box, ['phase-start', '--phase', 'select', '--session', 'P1'], '04:11'));
    assert.equal(good(await arm(box, 'select', '04:12')).attempt, 1);
    good(await ST(box, ['phase-start', '--phase', 'ideate', '--session', 'P1'], '04:13'));
    const back = good(await arm(box, 'ideate', '04:14'));
    assert.equal(back.attempt, 3);
    assert.deepEqual(box.run().watch.arms, { ideate: 3, select: 1 });
  });

  test('arming the same launch again hands back the pending timer; a fired or disarmed watch is a new launch', async () => {
    const { box } = await armed('build');
    const again = good(await arm(box, 'build', '04:05'));
    assert.deepEqual([again.reused, again.attempt, again.replaced.triggerId], [true, 1, 'trig_1'], 'the timer of the first arm is still pending: delete it before creating the next');
    good(await W(box, 'bind', ['--trigger-id', 'trig_2', '--workflow-task', 'wf-2'], '04:06'));
    good(await W(box, 'disarm', [], '04:07'));
    const afterDisarm = good(await arm(box, 'build', '04:08'));
    assert.deepEqual([afterDisarm.reused, afterDisarm.attempt, afterDisarm.replaced], [false, 2, null], 'a disarmed watch is over: the next arm is a new attempt, and nothing is handed back');
  });

  test('a live trigger of the watch that is replaced is handed back for deletion; a fired (spent) one is not', async () => {
    const { box } = await armed('ideate');
    const again = good(await arm(box, 'ideate', '04:05'));
    assert.deepEqual(again.replaced, { phase: 'ideate', attempt: 1, triggerId: 'trig_1', workflowTask: 'wf-1' });
    assert.match(again.then[0], /^first delete_trigger\(\{ trigger_id: "trig_1" \}\)/);
    good(await W(box, 'bind', ['--trigger-id', 'trig_2'], '04:06'));
    good(await chk(box, 'ideate', '06:00')); // overdue: the one-shot has fired
    assert.equal(good(await arm(box, 'ideate', '06:01')).replaced, null);
  });

  test('the heartbeat loop of the launch: osHeartbeat is true only when the loop keeps the lease fresh past the watch, and the loop is printed as a command to run in the background', async () => {
    const ideate = await inPhase('ideate');
    const a = good(await arm(ideate, 'ideate', '04:00')); // 90 + 10 minutes
    // 25 beats of 270 s (113 minutes); the last pushed beat is at most 14 minutes older, and the lease looks stale 35 minutes after it
    assert.deepEqual(pick(a.heartbeatLoop, ['variant', 'background', 'timeoutMs', 'iterations', 'coversMinutes', 'freshUntilMinutes', 'coversWatch']), { variant: 'heartbeat-branch', background: true, timeoutMs: 7_200_000, iterations: 25, coversMinutes: 113, freshUntilMinutes: 134, coversWatch: true });
    assert.equal(a.osHeartbeat, true);
    assert.equal(a.heartbeatLoop.command, `for i in $(seq 1 25); do node scripts/heartbeat.mjs --role primary --session P1 --phase ideate --date ${DATE} --wait 270 >/dev/null 2>&1; done`);
    const start = a.then.find((x) => x.startsWith('start the heartbeat loop in the background now'));
    assert.match(start, /\(Bash run_in_background, timeout 7200000\): for i in .* then pass osHeartbeat:true to the Workflow; never stop the loop at launch$/);
    // a short watch gets a short loop (25 minutes: ceil(25 * 60 / 270) + 2 beats of 4.5 minutes)
    const pre = await inPhase('preflight');
    const p = good(await arm(pre, 'preflight', '04:00'));
    assert.deepEqual([p.heartbeatLoop.iterations, p.heartbeatLoop.coversMinutes, p.osHeartbeat], [8, 36, true]);
    // a long one outlives the lease the loop can keep fresh (the Bash background timeout is 2 hours: 26 beats, 117 minutes; the lease
    // looks stale from minute 138): osHeartbeat stays out, so the Workflow keeps its own pulse
    const build = await inPhase('build');
    const b = good(await arm(build, 'build', '04:00')); // 150 + 10
    assert.deepEqual([b.heartbeatLoop.coversWatch, b.osHeartbeat, b.heartbeatLoop.iterations, b.heartbeatLoop.coversMinutes, b.heartbeatLoop.freshUntilMinutes], [false, false, 26, 117, 138]);
    const would = b.then.find((x) => x.startsWith('the heartbeat loop would end before the watch'));
    assert.match(would, /\(117 of 160 min; the lease would look stale from minute 138\): you may still start it \(for i in .*\) but leave osHeartbeat out, so the Workflow keeps its own pulse$/);
    assert.ok(!b.then.some((x) => x.startsWith('start the heartbeat loop')));
  });

  test('when the heartbeat branch is known broken ($HOME/.sed-hb-broken-<D>, FM-111) the loop commits liveness to the work branch instead', async () => {
    const home = tmpDir('sed-home-');
    fs.writeFileSync(path.join(home, `.sed-hb-broken-${DATE}`), '');
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      const ideate = await inPhase('ideate');
      const a = good(await arm(ideate, 'ideate', '04:00')); // 100 minutes: 5 loops of 20 minutes, each beat pushed
      assert.deepEqual(pick(a.heartbeatLoop, ['variant', 'iterations', 'coversMinutes', 'freshUntilMinutes', 'coversWatch']), { variant: 'work-branch', iterations: 5, coversMinutes: 100, freshUntilMinutes: 135, coversWatch: true });
      assert.equal(a.heartbeatLoop.command, `for i in $(seq 1 5); do node -e "setTimeout(()=>{},1200000)"; node scripts/state.mjs beat --role primary --session P1 --phase ideate --date ${DATE}; node scripts/state.mjs sync -m "sed(${DATE}): liveness" --paths state/runs/${DATE}.json; done`);
      const build = await inPhase('build');
      const b = good(await arm(build, 'build', '04:00'));
      assert.deepEqual([b.heartbeatLoop.variant, b.heartbeatLoop.coversWatch, b.osHeartbeat], ['work-branch', false, false]);
    } finally {
      if (saved === undefined) delete process.env.HOME;
      else process.env.HOME = saved;
    }
    // another day's marker does not count
    const other = await inPhase('ideate');
    assert.equal(good(await arm(other, 'ideate', '04:00')).heartbeatLoop.variant, 'heartbeat-branch');
  });

  test('arm refuses what cannot be watched (exit 1, nothing written)', async () => {
    const none = sandbox();
    let r = await arm(none, 'ideate', '04:00');
    assert.equal(r.code, 1);
    assert.match(r.json.error, /no run file/);
    assert.match(r.json.error, /begin/);

    const box = await inPhase('ideate');
    const before = bytes(box);
    r = await arm(box, 'build', '04:00');
    assert.equal(r.code, 1);
    assert.match(r.json.error, /not the run's current phase \(ideate\)/);
    assert.match(r.json.error, /phase-start --phase build/);
    assert.equal(r.json.runPhase, 'ideate');

    r = await W(box, 'arm', ['--phase', 'ideate', '--session', 'OTHER'], '04:00'); // somebody else holds the lease
    assert.equal(r.code, 1);
    assert.equal(r.json.leaseHeld, false);
    assert.match(r.json.error, /lease is held by primary\/P1/);
    assert.deepEqual(bytes(box), before);

    const pub = await kaizenRun();
    r = await arm(pub, 'ideate', '08:40');
    assert.equal(r.code, 1);
    assert.match(r.json.error, /published/);

    const bad = sandbox();
    bad.write(bad.runFile(), '{"schema":1,"da');
    r = await arm(bad, 'ideate', '04:00');
    assert.equal(r.code, 1);
    assert.match(r.json.error, /corrupt/);
    assert.equal(bad.read(bad.runFile()), '{"schema":1,"da');
  });

  test('the run file stays inside the CONTRACT shapes: the closed event kinds, ISO instants, string authors', async () => {
    const { box } = await armed();
    good(await chk(box, 'ideate', '05:55'));
    good(await arm(box, 'ideate', '05:56'));
    good(await W(box, 'disarm', [], '05:57'));
    const run = box.run();
    for (const e of run.events) {
      assert.ok(rs.EVENT_KINDS.includes(e.kind), `event kind ${e.kind}`);
      assert.match(e.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
      assert.equal(typeof e.by, 'string');
      assert.equal(typeof e.msg, 'string');
    }
    // the watch events are machine-tagged through `code`, like grace and hb-unreadable
    assert.deepEqual(run.events.filter((e) => e.code).map((e) => [e.kind, e.code]), [['note', 'watch-armed'], ['error', 'watch-fired'], ['note', 'watch-armed']]);
    const r = await ST(box, ['event', '--kind', 'watch-fired', '--msg', 'x', '--by', 'primary'], '05:58');
    assert.equal(r.code, 2, 'the event command keeps its closed list of kinds');
  });

  test('usage errors exit 2 with the usage text', async () => {
    const box = await inPhase('ideate');
    const before = bytes(box);
    const cases = [
      [['arm', '--session', 'P1'], /--phase is required/],
      [['arm', '--phase', 'ideate'], /--session is required/],
      [['arm', '--phase', 'brunch', '--session', 'P1'], /unknown phase/],
      [['arm', '--phase', 'done', '--session', 'P1'], /nothing runs in phase done/],
      [['arm', '--phase', 'ideate', '--session', 'P 1'], /plain id/],
      [['arm', '--phase', 'ideate', '--session', 'x;rm -rf /'], /plain id/],
      [['arm', '--phase', 'ideate', '--session', '$(id)'], /plain id/],
      [['arm', '--phase', 'ideate', '--session', 'P1', '--role', 'boss'], /unknown role/],
      [['check', '--phase', 'ideate', '--session', 'P1', '--role', 'boss'], /unknown role/],
      [['check', '--phase', 'ideate', '--session', 'P1', '--attempt', '0'], /--attempt must be a positive integer/],
      [['check', '--phase', 'ideate', '--session', 'P1', '--attempt', 'x'], /--attempt must be a positive integer/],
      [['frobnicate'], /unknown watch subcommand/],
      [[], /unknown watch subcommand/],
    ];
    for (const [args, message] of cases) {
      const r = await W(box, args[0] ?? '', args.slice(1), '04:00').catch((e) => ({ code: 'threw', json: { error: String(e) } }));
      assert.equal(r.code, 2, args.join(' '));
      assert.equal(r.json.ok, false);
      assert.match(r.json.error, message, args.join(' '));
      assert.match(r.json.usage, /watch arm --phase P --session S/);
    }
    assert.deepEqual(bytes(box), before);
  });

  test('arm only touches the local run file: no extra files, no temp files left', async () => {
    const box = await inPhase('ideate');
    good(await arm(box, 'ideate', '04:00'));
    assert.deepEqual(fs.readdirSync(box.path('state/runs')).filter((f) => f !== '.gitkeep'), [`${DATE}.json`]);
    assert.deepEqual(fs.readdirSync(box.path('state')).filter((f) => f.endsWith('.lock') || f.endsWith('.tmp')), []);
  });
});

// ---------------------------------------------------------------------------------------
// bind
// ---------------------------------------------------------------------------------------

describe('watch bind', () => {
  test('stores the trigger id and the Workflow task id; binding the same values again changes nothing', async () => {
    const box = await inPhase('ideate');
    good(await arm(box, 'ideate', '04:00'));
    const first = good(await W(box, 'bind', ['--phase', 'ideate', '--session', 'P1', '--trigger-id', 'trig_9'], '04:01'));
    assert.deepEqual(keys(first), ['attempt', 'changed', 'date', 'ok', 'phase', 'triggerId', 'workflowTask']);
    assert.deepEqual(pick(first, ['phase', 'attempt', 'triggerId', 'workflowTask', 'changed']), { phase: 'ideate', attempt: 1, triggerId: 'trig_9', workflowTask: null, changed: true });
    assert.equal(box.run().lease.heartbeatAt, iso('04:01'), 'binding is a sign of life of the holder');
    const second = good(await W(box, 'bind', ['--workflow-task', 'wf-3'], '04:02')); // phase and session are optional
    assert.deepEqual(pick(second, ['triggerId', 'workflowTask', 'changed']), { triggerId: 'trig_9', workflowTask: 'wf-3', changed: true });
    assert.equal(box.run().lease.heartbeatAt, iso('04:02'));
    assert.deepEqual(pick(box.run().watch, ['triggerId', 'workflowTask', 'boundAt']), { triggerId: 'trig_9', workflowTask: 'wf-3', boundAt: iso('04:02') });
    const before = bytes(box);
    const again = good(await W(box, 'bind', ['--trigger-id', 'trig_9', '--workflow-task', 'wf-3'], '04:30'));
    assert.equal(again.changed, false);
    assert.deepEqual(bytes(box), before, 'an idempotent bind does not even rewrite the file');
    assert.equal(box.run().lease.heartbeatAt, iso('04:02'), 'and does not touch the heartbeat');
    // a new id replaces the old one (the early verdict re-arms the timer)
    assert.deepEqual(pick(good(await W(box, 'bind', ['--trigger-id', 'trig_10'], '04:31')), ['triggerId', 'workflowTask', 'changed']), { triggerId: 'trig_10', workflowTask: 'wf-3', changed: true });
  });

  test('it refuses to bind what is not an armed watch of this phase and session (exit 1)', async () => {
    const none = await inPhase('ideate');
    let r = await W(none, 'bind', ['--trigger-id', 'trig_1'], '04:00');
    assert.equal(r.code, 1);
    assert.match(r.json.error, /no usable phase watch.*watch arm/);

    const box = await inPhase('ideate');
    good(await arm(box, 'ideate', '04:00'));
    r = await W(box, 'bind', ['--phase', 'build', '--trigger-id', 'trig_1'], '04:01');
    assert.deepEqual([r.code, r.json.reason], [1, 'other-phase']);
    r = await W(box, 'bind', ['--session', 'Z9', '--trigger-id', 'trig_1'], '04:01');
    assert.deepEqual([r.code, r.json.reason], [1, 'other-session']);
    good(await W(box, 'disarm', [], '04:02'));
    r = await W(box, 'bind', ['--trigger-id', 'trig_1'], '04:03');
    assert.deepEqual([r.code, r.json.reason], [1, 'disarmed']);
    assert.equal(box.run().watch.triggerId, null);

    const missing = sandbox();
    r = await W(missing, 'bind', ['--trigger-id', 'trig_1'], '04:00');
    assert.equal(r.code, 1);
    assert.match(r.json.error, /no run file/);
  });

  test('--attempt binds for that attempt only: a command of an earlier attempt cannot overwrite the live attempt\'s ids', async () => {
    const { box } = await armed('build');
    good(await chk(box, 'build', '06:50')); // attempt 1 fires
    good(await ST(box, ['phase-start', '--phase', 'build', '--session', 'P1'], '06:52'));
    assert.equal(good(await arm(box, 'build', '06:53')).attempt, 2);
    const live = good(await W(box, 'bind', ['--attempt', '2', '--trigger-id', 'trig_A2', '--workflow-task', 'wf-A2'], '06:54'));
    assert.deepEqual(pick(live, ['attempt', 'triggerId', 'workflowTask', 'changed']), { attempt: 2, triggerId: 'trig_A2', workflowTask: 'wf-A2', changed: true });
    const before = bytes(box);
    // the old attempt's re-arm (a stale timer's early verdict) would have replaced the live trigger id: it is refused now
    const stale = await W(box, 'bind', ['--attempt', '1', '--trigger-id', 'trig_old'], '06:55');
    assert.deepEqual([stale.code, stale.json.reason, stale.json.runWatchAttempt], [1, 'other-attempt', 2]);
    assert.match(stale.json.error, /attempt 2, not 1.*earlier attempt/);
    assert.deepEqual(bytes(box), before);
    assert.equal(box.run().watch.triggerId, 'trig_A2');
    // without --attempt a bind works as it always did; a new trigger id clears the "this timer has fired" mark
    const run = box.run();
    run.watch.timerFiredAt = iso('06:56');
    box.write(box.runFile(), run);
    good(await W(box, 'bind', ['--trigger-id', 'trig_A2b'], '06:57'));
    assert.equal(box.run().watch.timerFiredAt, undefined);
    assert.equal(good(await W(box, 'bind', ['--attempt', '2', '--workflow-task', 'wf-A2'], '06:58')).changed, false);
    assert.equal((await W(box, 'bind', ['--attempt', '0', '--trigger-id', 'x'], '06:58')).code, 2);
    assert.equal((await W(box, 'bind', ['--attempt', 'two', '--trigger-id', 'x'], '06:58')).code, 2);
  });

  test('it needs an id and takes plain tokens only (exit 2)', async () => {
    const box = await inPhase('ideate');
    good(await arm(box, 'ideate', '04:00'));
    const before = bytes(box);
    for (const [args, message] of [
      [[], /needs --trigger-id and\/or --workflow-task/],
      [['--trigger-id', 'a b'], /plain id/],
      [['--trigger-id', '$(id)'], /plain id/],
      [['--workflow-task', 'wf;1'], /plain id/],
      [['--trigger-id', 'trig_1', '--phase', 'brunch'], /unknown phase/],
    ]) {
      const r = await W(box, 'bind', args, '04:01');
      assert.equal(r.code, 2, args.join(' '));
      assert.match(r.json.error, message);
    }
    assert.deepEqual(bytes(box), before);
  });
});

// ---------------------------------------------------------------------------------------
// check: early
// ---------------------------------------------------------------------------------------

describe('watch check: early', () => {
  test('a timer that fires well before the watch is due: remaining minutes and a fresh send_later, and nothing is written', async () => {
    const { box, due } = await armed();
    const before = bytes(box);
    const j = good(await chk(box, 'ideate', '04:30'));
    assert.deepEqual(keys(j), ['action', 'attempt', 'date', 'dueAt', 'instructions', 'now', 'ok', 'phase', 'remainingMinutes', 'sendLater', 'session', 'timerFired', 'verdict']);
    assert.deepEqual(pick(j, ['verdict', 'action', 'attempt', 'dueAt', 'remainingMinutes', 'phase', 'session', 'timerFired']), { verdict: 'early', action: 're-arm', attempt: 1, dueAt: due, remainingMinutes: 70, phase: 'ideate', session: 'P1', timerFired: true });
    assert.deepEqual(j.sendLater, {
      at: noMillis(due),
      name: `sed-watch-${DATE}-ideate-a1`,
      message: pw.watchMessage({ date: DATE, phase: 'ideate', attempt: 1, session: 'P1', dueAt: due, root: box.root }),
    });
    assert.match(j.instructions, /do NOT stop it/);
    assert.match(j.instructions, /watch bind --phase ideate --session P1 --date \S+ --attempt 1 --trigger-id/);
    assert.match(j.instructions, /do NOT delete it/, 'the timer that woke you is spent');
    assert.deepEqual(bytes(box), before);
  });

  test('the 2 minute tolerance: exactly 2 minutes before the due time already counts as due', async () => {
    const { box, due } = await armed();
    const at = (ms) => new Date(Date.parse(due) + ms).toISOString();
    assert.equal(good(await chk(box, 'ideate', at(-2 * 60_000 - 1000))).verdict, 'early');
    const edge = good(await chk(box, 'ideate', at(-2 * 60_000)));
    assert.deepEqual([edge.verdict, edge.overdueMinutes], ['overdue', 0]);
  });
});

// ---------------------------------------------------------------------------------------
// check: overdue
// ---------------------------------------------------------------------------------------

describe('watch check: overdue', () => {
  test('an attempt is left: retry with the compact hint, exact steps, and the watch-fired event written once', async () => {
    const { box, due } = await armed();
    const j = good(await chk(box, 'ideate', '05:55'));
    assert.deepEqual(keys(j), ['action', 'attempt', 'attemptsLeft', 'attemptsUsed', 'date', 'degrade', 'dueAt', 'hint', 'maxAttempts', 'next', 'now', 'ok', 'outputs', 'overdueMinutes', 'phase', 'progress', 'reason', 'repeat', 'session', 'steps', 'timerFired', 'triggerId', 'verdict', 'workflowTask']);
    assert.deepEqual(
      pick(j, ['verdict', 'action', 'next', 'hint', 'attempt', 'attemptsUsed', 'maxAttempts', 'attemptsLeft', 'workflowTask', 'triggerId', 'repeat', 'overdueMinutes', 'dueAt', 'degrade', 'timerFired']),
      { verdict: 'overdue', action: 'retry', next: 'retry', hint: 'compact', attempt: 1, attemptsUsed: 1, maxAttempts: 2, attemptsLeft: 1, workflowTask: 'wf-1', triggerId: 'trig_1', repeat: false, overdueMinutes: 15, dueAt: due, degrade: null, timerFired: true },
    );
    assert.match(j.reason, /ideate attempt 1 fell due .* \(15 min ago\)/);
    assert.deepEqual(j.progress, { newestAt: null, minutesAgo: null }, 'no file under work/<D> at all');
    assert.deepEqual(j.steps, [
      'TaskStop({ task_id: "wf-1" })   (the Workflow task bound at launch; stopping a finished task is harmless)',
      `state of ideate: present nothing; missing work/${DATE}/ideas/shortlist.json, work/${DATE}/ideate/DONE.json`,
      `run: if [ -d work/${DATE}/ideas ]; then mv work/${DATE}/ideas work/${DATE}/ideas.attempt1; fi; rm -rf work/${DATE}/ideate`,
      `run: node scripts/state.mjs phase-start --phase ideate --session P1 --date ${DATE}   (expect attempt 2 and overLimit:false)`,
      `run: node scripts/state.mjs directive --kind scope-cut --tier 2 --by primary --date ${DATE}`,
      `run: node scripts/state.mjs ack-directive --kind scope-cut --date ${DATE}`,
      `run: node scripts/state.mjs event --kind degrade --msg "ideate stalled (phase watch): retrying compact, tier 2" --by primary --date ${DATE}`,
      `run: node scripts/state.mjs watch arm --phase ideate --session P1 --role primary --date ${DATE}   (the retry needs a watch of its own: it must print attempt 2; add --minutes <the phaseBudgetMinutes you pass in args> when that is below the configured one)`,
      'Then finish the launch as "Launching any Workflow" says: send_later with the sendLater it printed, watch bind --attempt 2 --trigger-id <the trigger_id>, the heartbeat loop it printed, sync, then ideate with compact:true and tier:2 (planner for phaseBudgetMinutes) and watch bind --workflow-task.',
    ]);
    assert.deepEqual(j.outputs, { required: [`work/${DATE}/ideas/shortlist.json`, `work/${DATE}/ideate/DONE.json`], present: [], missing: [`work/${DATE}/ideas/shortlist.json`, `work/${DATE}/ideate/DONE.json`] });

    const run = box.run();
    const fired = watchEvents(run, 'watch-fired');
    assert.equal(fired.length, 1);
    assert.deepEqual(pick(fired[0], ['kind', 'by', 'at']), { kind: 'error', by: 'primary', at: iso('05:55') });
    assert.match(fired[0].msg, /ideate attempt 1 was still running 15 min after its due time .*next: retry/);
    assert.deepEqual(pick(run.watch, ['firedAt', 'timerFiredAt', 'attemptsAtFire', 'decision', 'stoppedTasks']), { firedAt: iso('05:55'), timerFiredAt: iso('05:55'), attemptsAtFire: 1, decision: 'retry', stoppedTasks: ['wf-1'] });
    assert.equal(run.lease.heartbeatAt, iso('05:55'));
    // the run's own phase machinery is untouched: nothing was counted, failed or moved
    assert.deepEqual([run.status, run.phase, run.attempts.ideate, run.targetTier, run.directives], ['in_progress', 'ideate', 1, 1, []]);
  });

  test('the steps are real commands: running them leaves the run exactly where the playbook says a compact retry starts', async () => {
    const { box } = await armed();
    const j = good(await chk(box, 'ideate', '05:55'));
    const out = await runSteps(box, j.steps, '05:56');
    assert.equal(out[0].attempt, 2); // phase-start
    assert.equal(out[0].overLimit, false);
    const run = box.run();
    assert.deepEqual([run.targetTier, run.attempts.ideate, run.phase], [2, 2, 'ideate']);
    assert.deepEqual(run.directives.map((d) => [d.kind, d.tier, d.ack]), [['scope-cut', 2, true]]);
    assert.ok(run.events.some((e) => e.kind === 'degrade' && /retrying compact/.test(e.msg)));
    // the last step arms the retry's own watch: attempt 2, a fresh block (the fired one is gone), the stopped task remembered
    const retryArm = out.at(-1);
    assert.deepEqual([retryArm.attempt, retryArm.reused, retryArm.replaced], [2, false, null]);
    assert.deepEqual(pick(run.watch, ['attempt', 'firedAt', 'triggerId', 'workflowTask', 'stoppedTasks']), { attempt: 2, firedAt: undefined, triggerId: null, workflowTask: null, stoppedTasks: ['wf-1'] });
    // arming that launch once more (a compaction in between) is still the same attempt
    assert.deepEqual(pick(good(await arm(box, 'ideate', '05:57')), ['attempt', 'reused']), { attempt: 2, reused: true });
    // and the healthy retry, watched by its own block, is left alone by the watchdogs
    good(await ST(box, ['beat', '--role', 'primary', '--session', 'P1', '--phase', 'ideate'], '06:40'));
    assert.equal(good(await ST(box, ['begin', '--role', 'wdB', '--session', 'B1'], '06:47')).action, 'exit-alive');
  });

  test('deciding again changes nothing: the same verdict with repeat:true and no second event', async () => {
    const { box } = await armed();
    const first = good(await chk(box, 'ideate', '05:55'));
    const afterFirst = bytes(box);
    const second = good(await chk(box, 'ideate', '05:58'));
    assert.deepEqual(pick(second, ['verdict', 'next', 'hint', 'repeat', 'overdueMinutes']), { verdict: 'overdue', next: 'retry', hint: 'compact', repeat: true, overdueMinutes: 18 });
    assert.deepEqual(second.steps, first.steps);
    assert.deepEqual(bytes(box), afterFirst);
    assert.equal(watchEvents(box.run(), 'watch-fired').length, 1);
  });

  test('a tier 2 day has no scope-cut to issue; a retry of the kaizen round has none either', async () => {
    const { box } = await armed('ideate', { start: '04:50', at: '04:55' }); // started at 04:50: tier 2 by the clock
    assert.equal(box.run().targetTier, 2);
    const j = good(await chk(box, 'ideate', '06:40')); // due 06:35
    assert.equal(j.next, 'retry');
    assert.ok(!j.steps.some((s) => s.includes('directive')));
    assert.ok(!j.steps.some((s) => s.includes('scope-cut')));

    const kz = await kaizenRun();
    good(await arm(kz, 'kaizen', '08:40'));
    const k = good(await chk(kz, 'kaizen', '11:10')); // due 11:05 (120 + 25)
    assert.deepEqual([k.next, k.hint], ['retry', 'compact']);
    assert.ok(!k.steps.some((s) => s.includes('scope-cut')), 'a published day takes no directive');
    // The retry of the kaizen round keeps the tree clean (kaizen.mjs refuses a dirty one): the watch-fired event is pushed BEFORE the check
    // `git status --short`, the run file is never restored with git, the new watch is pushed before the round starts, and no task is bound.
    const text = k.steps.join('\n');
    const order = ['TaskStop the kaizen Workflow task', 'state.mjs sync -m "sed(' + DATE + '): primary kaizen watch fired"', 'git status --short', 'phase-start --phase kaizen', 'watch arm --phase kaizen', 'sync, git status --short must print nothing'];
    order.reduce((from, needle) => {
      const at = text.indexOf(needle, from);
      assert.ok(at >= from, `${needle} comes in this order: ${text}`);
      return at;
    }, 0);
    assert.match(text, /never git checkout the run file/);
    assert.match(text, /\$HOME\/\.sed-wf-2026-10-09-kaizen/);
    assert.match(text, /\(no task bind\)/);
    // the commands run (the sync needs a git repo: the sandbox has none, so it is left out here and tested with a remote below)
    const out = await runSteps(kz, k.steps.filter((s) => !s.includes('state.mjs sync')), '11:11');
    assert.equal(out[0].attempt, 2); // phase-start --phase kaizen is allowed on a published day with its kaizen pending
    assert.deepEqual([out.at(-1).attempt, out.at(-1).phase], [2, 'kaizen']); // and the retry has its own watch
  });

  test('retry exhaustion: the second stall of a phase degrades through the two-failures table, and the steps lead the state machine there', async () => {
    const { box } = await armed('build');
    // build: due 04:00 + 160 min = 06:40
    const first = good(await chk(box, 'build', '06:50'));
    assert.equal(first.next, 'retry');
    assert.ok(first.steps.includes(`run: rm -rf work/${DATE}/build`));
    await runSteps(box, first.steps, '06:52'); // phase-start (attempt 2), scope-cut, ack, event, and the retry's own arm
    const a2 = good(await arm(box, 'build', '06:55')); // the same launch once more: attempt 2 still, due time from now
    assert.deepEqual([a2.attempt, a2.reused], [2, true]);
    good(await W(box, 'bind', ['--attempt', '2', '--trigger-id', 'trig_2', '--workflow-task', 'wf-2'], '06:56'));

    const second = good(await chk(box, 'build', '09:40')); // due 06:55 + 160 = 09:35
    assert.deepEqual(pick(second, ['next', 'hint', 'attemptsUsed', 'attemptsLeft', 'workflowTask', 'repeat']), { next: 'degrade', hint: null, attemptsUsed: 2, attemptsLeft: 0, workflowTask: 'wf-2', repeat: false });
    assert.deepEqual(pick(second.degrade, ['how', 'toTier', 'skip']), { how: 'tier', toTier: 3, skip: [] }); // ideate is done: the Ideas Day
    assert.deepEqual(second.steps.slice(0, 7), [
      'TaskStop({ task_id: "wf-2" })   (the Workflow task bound at launch; stopping a finished task is harmless)',
      `state of build: present nothing; missing work/${DATE}/build/site/index.html, work/${DATE}/build/DONE.json`,
      `run: node scripts/state.mjs directive --kind ship-now --tier 3 --by primary --date ${DATE}`,
      `run: node scripts/state.mjs ack-directive --kind ship-now --date ${DATE}`,
      `run: node scripts/state.mjs event --kind degrade --msg "build stalled 2 times (phase watch): tier 3" --by primary --date ${DATE}`,
      `run: node scripts/state.mjs watch disarm --phase build --session P1 --date ${DATE}   (the timer that woke you has fired and is spent: delete nothing)`,
      'Then: build has no attempts left: publish the Ideas Day (PLAYBOOK 9.1), and the carry-over settle saves the intended winner (PLAYBOOK 10.3).',
    ]);
    const out = await runSteps(box, second.steps, '09:41');
    assert.equal(out.at(-1).disarmed, true);
    assert.equal(out.at(-1).triggerId, 'trig_2');
    assert.deepEqual([out.at(-1).timerFired, out.at(-1).deleteTrigger], [true, null], 'the timer that woke the session is spent: it is never offered for deletion');
    const run = box.run();
    assert.deepEqual([run.targetTier, run.status, run.watch.disarmedAt], [3, 'in_progress', iso('09:41')]);
    assert.ok(run.events.some((e) => e.kind === 'degrade' && /build stalled 2 times/.test(e.msg)));
    // the existing machinery now walks the tier 3 path: preflight, ideate, then package
    const resumed = good(await ST(box, ['begin', '--role', 'primary', '--session', 'P1'], '09:42'));
    assert.deepEqual([resumed.action, resumed.targetTier], ['resume', 3]);
    assert.equal(good(await ST(box, ['phase-done', '--phase', 'build', '--session', 'P1', '--role', 'primary'], '09:43')).next, 'package');
  });

  test('the attempts are counted the way begin counts them (run.attempts) and by the watch itself, whichever is higher', async () => {
    // phase-start twice before the first watch: the phase has already failed once, so the first stall is the last
    const box = await inPhase('ideate');
    good(await ST(box, ['phase-start', '--phase', 'ideate', '--session', 'P1'], '04:01'));
    good(await arm(box, 'ideate', '04:02'));
    const j = good(await chk(box, 'ideate', '06:00'));
    assert.deepEqual([j.next, j.attemptsUsed], ['degrade', 2]);
    // a retry armed without its phase-start (the operator forgot it): the arm counter alone also exhausts the attempts
    const forgot = await inPhase('select');
    good(await arm(forgot, 'select', '04:00'));
    assert.equal(good(await chk(forgot, 'select', '05:30')).next, 'retry'); // due 04:55: fires, the first stall
    const rearmed = good(await arm(forgot, 'select', '05:31')); // the retry armed, its phase-start forgotten: still attempt 2 by the arm counter
    assert.deepEqual([rearmed.attempt, rearmed.reused], [2, false]);
    const f = good(await chk(forgot, 'select', '07:00'));
    assert.deepEqual([f.attempt, f.next, f.attemptsUsed], [2, 'degrade', 2]);
  });

  test('every phase degrades the way PLAYBOOK 6.7 says (the steps are executable)', async () => {
    const expectations = {
      select: { how: 'tier', toTier: 3 },
      spec: { how: 'tier', toTier: 3 },
      package: { how: 'tier', toTier: 3 },
      qa: { how: 'skip', skip: ['qa', 'revise'] },
    };
    for (const [phase, want] of Object.entries(expectations)) {
      const box = await inPhase(phase);
      good(await ST(box, ['phase-start', '--phase', phase, '--session', 'P1'], '04:01')); // attempt 2
      good(await arm(box, phase, '04:02'));
      const late = plusMinutes(iso('04:02'), BUDGETS[phase] + 15); // five minutes past its due time
      const j = good(await chk(box, phase, late));
      assert.equal(j.next, 'degrade', phase);
      assert.equal(j.degrade.how, want.how, phase);
      if (want.how === 'tier') assert.equal(j.degrade.toTier, want.toTier, phase);
      else assert.deepEqual(j.degrade.skip, want.skip, phase);
      await runSteps(box, j.steps, plusMinutes(late, 1));
      const run = box.run();
      if (want.how === 'tier') assert.equal(run.targetTier, want.toTier, phase);
      else {
        for (const p of want.skip) assert.ok(rs.doneNames(run).includes(p), `${phase}: ${p} skipped`);
        assert.equal(run.phase, 'package', `${phase}: the day goes on at package, tier unchanged`);
        assert.equal(run.targetTier, 1);
      }
    }
  });

  test('revise degrades by what QA says: S1 left means Tier 3, otherwise the revise is skipped', async () => {
    for (const blocked of [true, false]) {
      const box = await inPhase('revise');
      if (blocked) box.write(`work/${DATE}/qa/report.json`, { schema: 1, verdict: 'revise', counts: { S1: 1, S2: 0, S3: 0, S4: 0 } });
      good(await ST(box, ['phase-start', '--phase', 'revise', '--session', 'P1'], '04:01'));
      good(await arm(box, 'revise', '04:02')); // due 05:42
      const j = good(await chk(box, 'revise', '05:50'));
      assert.deepEqual(pick(j.degrade, ['how', 'toTier', 'skip']), blocked ? { how: 'tier', toTier: 3, skip: [] } : { how: 'skip', toTier: null, skip: ['revise'] });
      await runSteps(box, j.steps, '05:51');
      assert.equal(blocked ? box.run().targetTier : box.run().phase, blocked ? 3 : 'package');
    }
  });

  test('the first phases: ideate with no ideas on disk ends in the Postcard, with a shortlist in the Ideas Day', async () => {
    for (const hasIdeas of [false, true]) {
      const box = await inPhase('ideate');
      if (hasIdeas) box.write(`work/${DATE}/ideas/shortlist.json`, { ideas: [] });
      good(await ST(box, ['phase-start', '--phase', 'ideate', '--session', 'P1'], '04:01'));
      good(await arm(box, 'ideate', '04:02')); // due 05:42
      const j = good(await chk(box, 'ideate', '05:50'));
      assert.equal(j.degrade.toTier, hasIdeas ? 3 : 4);
      assert.deepEqual(j.outputs.present, hasIdeas ? [`work/${DATE}/ideas/shortlist.json`] : []);
      await runSteps(box, j.steps, '05:51');
      assert.equal(box.run().targetTier, hasIdeas ? 3 : 4);
    }
  });

  test('kaizen: a second stall closes the round on purpose; the page stays published', async () => {
    const box = await kaizenRun();
    good(await ST(box, ['phase-start', '--phase', 'kaizen', '--session', 'P1'], '08:36')); // attempt 2
    good(await arm(box, 'kaizen', '08:37')); // due 11:02
    const j = good(await chk(box, 'kaizen', '11:05'));
    assert.deepEqual([j.next, j.degrade.how, j.degrade.skip], ['degrade', 'skip', ['kaizen']]);
    await runSteps(box, j.steps, '11:06');
    const run = box.run();
    assert.deepEqual([run.status, run.phase, rs.doneNames(run).includes('kaizen')], ['published', 'done', true]);
    assert.equal(rs.kaizenPending(run), false);
  });

  test('qa: the skip order also skips revise, and a watch of the skipped phase is stale afterwards', async () => {
    const box = await inPhase('qa');
    good(await ST(box, ['phase-start', '--phase', 'qa', '--session', 'P1'], '04:01'));
    good(await arm(box, 'qa', '04:02')); // due 05:42
    const j = good(await chk(box, 'qa', '05:50'));
    const skips = stateCommands(j.steps).filter((c) => c[0] === 'skip-phase').map((c) => c[2]);
    assert.deepEqual(skips, ['qa', 'revise']);
    await runSteps(box, j.steps, '05:51');
    const after = good(await chk(box, 'qa', '05:55'));
    assert.deepEqual([after.verdict, after.code], ['stale', 'disarmed']);
  });

  test('a DONE.json means the Workflow finished: nothing to stop or retry, nothing written', async () => {
    const { box } = await armed();
    box.write(`work/${DATE}/ideate/DONE.json`, { ok: true, phase: 'ideate' });
    const before = box.run();
    const j = good(await chk(box, 'ideate', '05:55'));
    assert.deepEqual(pick(j, ['verdict', 'next', 'hint', 'degrade', 'repeat']), { verdict: 'overdue', next: 'nothing', hint: null, degrade: null, repeat: false });
    assert.match(j.reason, /DONE\.json exists/);
    assert.match(j.steps[0], /^Do NOT stop or retry ideate/);
    assert.ok(!j.steps.some((s) => s.includes('TaskStop')));
    assert.match(j.steps.at(-1), /the timer that woke you has fired and is spent: delete nothing/);
    // no event and no firedAt; the only trace is that this timer is spent, so a disarm in the notification turn never offers it for deletion
    const after = box.run();
    assert.deepEqual(after.events, before.events);
    assert.equal(after.watch.firedAt, undefined);
    assert.equal(after.watch.timerFiredAt, iso('05:55'));
    const notified = good(await W(box, 'disarm', ['--workflow-task', 'wf-1'], '05:57'));
    assert.deepEqual([notified.disarmed, notified.timerFired, notified.deleteTrigger], [true, true, null]);
    const again = await armed();
    again.box.write(`work/${DATE}/ideate/DONE.json`, { ok: true, phase: 'ideate' });
    good(await chk(again.box, 'ideate', '05:55'));
    const after2 = bytes(again.box);
    good(await chk(again.box, 'ideate', '05:58')); // the same answer again
    assert.deepEqual(bytes(again.box), after2, 'a second look writes nothing');
    // a marker that says ok:false is not a finish
    const bad = await armed();
    bad.box.write(`work/${DATE}/ideate/DONE.json`, { ok: false });
    assert.equal(good(await chk(bad.box, 'ideate', '05:56')).next, 'retry');
  });

  test('outputs lists what the stalled phase left behind (the PLAYBOOK 7.3 files)', async () => {
    const { box } = await armed('spec');
    box.write(`work/${DATE}/spec/SPEC.md`, '# spec');
    box.write(`work/${DATE}/spec/DESIGN.md`, '');
    const j = good(await chk(box, 'spec', '05:30')); // due 04:00 + 85 = 05:25
    assert.deepEqual(j.outputs.present, [`work/${DATE}/spec/SPEC.md`]); // an empty file does not count
    assert.deepEqual(j.outputs.missing, [`work/${DATE}/spec/DESIGN.md`, `work/${DATE}/spec/OWNERSHIP.json`, `work/${DATE}/spec/PROJECT.json`, `work/${DATE}/spec/DONE.json`]);
  });

  test('without a bound task the steps say how to find the Workflow task', async () => {
    const box = await inPhase('ideate');
    good(await arm(box, 'ideate', '04:00'));
    const j = good(await chk(box, 'ideate', '05:55'));
    assert.equal(j.workflowTask, null);
    assert.match(j.steps[0], /^TaskStop the running ideate Workflow task \(the id the Workflow tool printed at launch/);
  });

  test('--role picks the role named in the commands; a damaged role in the run file never reaches them', async () => {
    const { box } = await armed();
    const j = good(await chk(box, 'ideate', '05:55', ['--role', 'wdA']));
    assert.ok(j.steps.some((s) => s.includes('--by wdA')));
    assert.equal(watchEvents(box.run(), 'watch-fired')[0].by, 'wdA');
    const evil = await armed();
    const run = evil.box.run();
    run.watch.role = '$(touch /tmp/pwned)';
    run.lease.holder = '`id`';
    evil.box.write(evil.box.runFile(), run);
    const k = good(await chk(evil.box, 'ideate', '05:55'));
    assert.ok(k.steps.some((s) => s.includes('--by primary')));
    assert.ok(!k.steps.join('\n').match(/\$\(|`/), 'nothing from the run file is interpolated into a command');
    assert.deepEqual(pick(watchEvents(evil.box.run(), 'watch-fired')[0], ['by']), { by: 'watch' });
  });
});

// ---------------------------------------------------------------------------------------
// check: a working Workflow is given more time
// ---------------------------------------------------------------------------------------

describe('watch check: a Workflow that is still writing files is given more time, not stopped', () => {
  // Day 1 of the real project: build ran 85 minutes against a budget of 80, qa 38 against 30, kaizen 82 against 75 -- all healthy, all slow.
  // A timer measures elapsed time; the files say whether the Workflow still works.
  test('a file that changed within the phase\'s window (build: 35 minutes) moves the watch out by 15 minutes, twice at most; the third time the Workflow is stopped', async () => {
    const { box, due } = await armed('build'); // 150 + 10 minutes from 04:00: due 06:40
    assert.equal(due, iso('06:40'));
    touch(box, `work/${DATE}/build/site/app.js`, '06:35');
    const j = good(await chk(box, 'build', '06:41'));
    assert.deepEqual(pick(j, ['verdict', 'action', 'next', 'hint', 'attempt', 'overdueMinutes', 'repeat', 'timerFired', 'triggerId', 'workflowTask', 'degrade', 'dueAt']),
      { verdict: 'overdue', action: 'extend', next: 'extend', hint: null, attempt: 1, overdueMinutes: 1, repeat: false, timerFired: true, triggerId: 'trig_1', workflowTask: 'wf-1', degrade: null, dueAt: iso('06:56') });
    assert.deepEqual(j.progress, { newestAt: iso('06:35'), minutesAgo: 6 });
    assert.deepEqual(j.extension, { n: 1, max: 2, minutes: 15, dueAt: iso('06:56'), previousDueAt: due, clamped: null, windowMinutes: 35 });
    assert.deepEqual(j.sendLater, pw.sendLaterFor({ date: DATE, phase: 'build', attempt: 1, session: 'P1', dueAt: iso('06:56'), root: box.root }));
    assert.match(j.reason, /build attempt 1 fell due .* \(1 min ago\) but a file under work\/2026-10-09 changed 6 min ago: the Workflow is still working, so the watch moves out to .* \(extension 1 of 2\)/);
    assert.match(j.steps[0], /^Do NOT stop build: its files are still changing \(newest change 6 min ago\)\. The timer that woke you has fired and is spent: do NOT delete it/);
    assert.deepEqual(j.steps.slice(1).map((x) => x.replace(/ .*/, '')), ['call', 'run:', 'run:', 'end']);
    assert.match(j.steps[2], /watch bind --phase build --session P1 --date 2026-10-09 --attempt 1 --trigger-id <the trigger_id>$/);
    assert.match(j.steps[3], /state\.mjs sync -m "sed\(2026-10-09\): primary build watch extended"   \(other containers judge the pushed due time/);

    const run = box.run();
    assert.deepEqual(pick(run.watch, ['dueAt', 'extensions', 'extendedAt', 'triggerId', 'firedAt', 'timerFiredAt', 'decision', 'workflowTask']),
      { dueAt: iso('06:56'), extensions: 1, extendedAt: iso('06:41'), triggerId: null, firedAt: undefined, timerFiredAt: undefined, decision: undefined, workflowTask: 'wf-1' });
    assert.equal(run.lease.heartbeatAt, iso('06:41'));
    const ev = watchEvents(run, 'watch-extended');
    assert.equal(ev.length, 1);
    assert.deepEqual(pick(ev[0], ['kind', 'by', 'at']), { kind: 'note', by: 'primary', at: iso('06:41') });
    assert.match(ev[0].msg, /^phase watch extended: build attempt 1 was 1 min past .* but a file under work\/2026-10-09 changed 6 min ago; due .* now \(extension 1 of 2\)$/);
    assert.equal(watchEvents(run, 'watch-fired').length, 0, 'nothing was stopped, nothing counted against the phase');
    assert.deepEqual([run.status, run.phase, run.attempts.build, run.targetTier], ['in_progress', 'build', 1, 1]);

    // the new timer is bound; it falls due 15 minutes later, the files changed again: the second extension
    good(await W(box, 'bind', ['--phase', 'build', '--session', 'P1', '--attempt', '1', '--trigger-id', 'trig_2'], '06:42'));
    assert.equal(box.run().watch.triggerId, 'trig_2');
    touch(box, `work/${DATE}/build/site/style.css`, '06:50');
    const k = good(await chk(box, 'build', '06:57'));
    assert.deepEqual([k.action, k.extension.n, k.extension.dueAt, k.extension.previousDueAt], ['extend', 2, iso('07:12'), iso('06:56')]);
    assert.match(watchEvents(box.run(), 'watch-extended')[1].msg, /extension 2 of 2/);

    // two extensions are all a Workflow gets, however fresh its files are: it is stopped, with the ordinary verdict
    good(await W(box, 'bind', ['--phase', 'build', '--session', 'P1', '--attempt', '1', '--trigger-id', 'trig_3'], '06:58'));
    touch(box, `work/${DATE}/build/site/app.js`, '07:10');
    const l = good(await chk(box, 'build', '07:13'));
    assert.deepEqual([l.verdict, l.action, l.attemptsLeft, l.overdueMinutes], ['overdue', 'retry', 1, 1]);
    assert.deepEqual(pick(box.run().watch, ['extensions', 'firedAt', 'decision']), { extensions: 2, firedAt: iso('07:13'), decision: 'retry' });
    assert.equal(watchEvents(box.run(), 'watch-fired').length, 1);
  });

  test('exactly the window of silence still counts as working (20 minutes, build 35), a minute more does not; files stamped by a clock that is ahead are not progress', async () => {
    const verdict = async (stamp_, now = '06:41', phase = 'build', opts = {}) => {
      const { box } = await armed(phase, opts);
      if (stamp_) touch(box, `work/${DATE}/${phase}/x.js`, stamp_);
      return good(await chk(box, phase, now));
    };
    assert.equal((await verdict('06:06')).action, 'extend', 'build: 35 minutes of silence');
    assert.equal((await verdict('06:05')).action, 'retry', 'build: 36 minutes');
    assert.equal((await verdict('04:36', '04:56', 'select')).action, 'extend', 'select (45 + 10, due 04:55): 20 minutes of silence');
    assert.equal((await verdict('04:35', '04:56', 'select')).action, 'retry', 'select: 21 minutes');
    assert.equal((await verdict(null)).action, 'retry', 'no file at all');
    // a file time a few minutes ahead of the clock is a slightly skewed clock: it counts as "just now"; far ahead (or the real clock of a pinned run) is ignored
    const near = await verdict('06:44');
    assert.deepEqual([near.action, near.progress.minutesAgo], ['extend', 0]);
    assert.equal((await verdict('06:50')).action, 'retry');
    const unpinned = await armed('build');
    unpinned.box.write(`work/${DATE}/build/x.js`, 'x'); // written now, by the real clock: years after the pinned --now
    const u = good(await chk(unpinned.box, 'build', '06:41'));
    assert.deepEqual([u.action, u.progress.minutesAgo], ['retry', null]);
    // any file under work/<D> counts, also another phase's directory (the QA screenshots, the staging copies)
    const other = await armed('build');
    touch(other.box, `work/${DATE}/qa/shots/a.png`, '06:35');
    assert.equal(good(await chk(other.box, 'build', '06:41')).action, 'extend');
  });

  test('a late timer is not extended: half the budget (at least 15 minutes) past the due time is a Workflow that went quiet', async () => {
    const at = async (phase, now, touched) => {
      const { box } = await armed(phase); // ideate: 90 + 10 minutes from 04:00, due 05:40; the limit is max(15, 45) = 45 minutes
      touch(box, `work/${DATE}/${phase}/x.js`, touched);
      return good(await chk(box, phase, now)).action;
    };
    assert.equal(await at('ideate', '06:24', '06:20'), 'extend', '44 minutes late');
    assert.equal(await at('ideate', '06:25', '06:20'), 'retry', '45 minutes late');
    assert.equal(await at('build', '07:54', '07:50'), 'extend', 'build: 150 minutes of budget, 74 minutes late');
    assert.equal(await at('build', '07:55', '07:50'), 'retry', 'build: 75');
    // a short phase still gets 15 minutes of grace at least: preflight (15 + 10, due 04:25)
    const pre = async (now, touched) => {
      const { box } = await armed('preflight');
      touch(box, `work/${DATE}/preflight/x.json`, touched);
      return good(await chk(box, 'preflight', now)).action;
    };
    assert.equal(await pre('04:39', '04:36'), 'extend');
    assert.equal(await pre('04:40', '04:36'), 'retry');
  });

  test('never for the kaizen (its tree must stay clean), never for a Workflow that finished, never again once the decision is made', async () => {
    const kz = await kaizenRun();
    good(await arm(kz, 'kaizen', '08:40')); // 120 + 25: due 11:05
    touch(kz, `work/${DATE}/kaizen/notes.md`, '11:00');
    const k = good(await chk(kz, 'kaizen', '11:06'));
    assert.deepEqual([k.action, k.progress.minutesAgo], ['retry', 6]);
    assert.equal(watchEvents(kz.run(), 'watch-extended').length, 0);

    const done = await armed('build');
    touch(done.box, `work/${DATE}/build/site/app.js`, '06:35');
    touch(done.box, `work/${DATE}/build/DONE.json`, '06:36', '{"ok":true}');
    assert.equal(good(await chk(done.box, 'build', '06:41')).action, 'nothing');

    const fired = await armed('build');
    assert.equal(good(await chk(fired.box, 'build', '06:41')).action, 'retry'); // no files: stopped
    touch(fired.box, `work/${DATE}/build/site/app.js`, '06:50'); // the stopped Workflow's last write, a later look at the same timer
    const again = good(await chk(fired.box, 'build', '06:51'));
    assert.deepEqual([again.action, again.repeat], ['retry', true], 'the decision stands');
    assert.equal(watchEvents(fired.box.run(), 'watch-extended').length, 0);
  });

  test('the new due time is bound like a fresh arm: never later than the hard stop minus 5 minutes; with no room left there is no extension (and no retry)', async () => {
    const { box, due } = await armed('build', { at: '08:00', extra: ['--minutes', '120'] });
    assert.equal(due, iso('10:10'));
    touch(box, `work/${DATE}/build/site/app.js`, '10:05');
    const j = good(await chk(box, 'build', '10:11')); // 15 minutes would be 10:26; the hard stop allows 10:25
    assert.deepEqual([j.action, j.extension.dueAt, j.extension.minutes, j.extension.clamped], ['extend', iso('10:25'), 14, 'hard-stop']);
    good(await W(box, 'bind', ['--phase', 'build', '--session', 'P1', '--attempt', '1', '--trigger-id', 'trig_2'], '10:12'));
    // at 10:25 the bound leaves nothing: an extension would end past it ('min' 5 minutes: 10:30, the hard stop itself). The phase is
    // resolved now, and with no room for a retry either, by the two-failures table (the build files stay for the closer to salvage)
    touch(box, `work/${DATE}/build/site/style.css`, '10:24');
    const k = good(await chk(box, 'build', '10:25'));
    assert.deepEqual([k.verdict, k.action, k.tooLate, k.attemptsLeft, k.degrade.toTier, k.extension], ['overdue', 'degrade', true, 1, 3, undefined]);
    assert.match(k.reason, /0 min are left before the hard stop 10:30 \(minus 5\), a retry needs 30: no retry, the two-failures table applies$/);
    assert.ok(!k.steps.some((x) => /rm -rf|phase-start/.test(x)), 'nothing is wiped and nothing is relaunched');
    assert.ok(k.steps.some((x) => x.includes('event --kind degrade --msg "build stalled 0 min before the hard stop 10:30 (phase watch): tier 3"')));
    assert.equal(watchEvents(box.run(), 'watch-extended').length, 1);
    // a manual run is bound by nothing
    const manual = sandbox(CFG);
    good(await ST(manual, ['begin', '--role', 'manual', '--session', 'P1'], '03:55'));
    good(await ST(manual, ['phase-start', '--phase', 'preflight', '--session', 'P1'], '10:00'));
    good(await W(manual, 'arm', ['--phase', 'preflight', '--session', 'P1', '--role', 'manual', '--minutes', '20'], '10:00')); // due 10:30
    touch(manual, `work/${DATE}/preflight/x.json`, '10:28');
    const m = good(await chk(manual, 'preflight', '10:31', ['--role', 'manual']));
    assert.deepEqual([m.action, m.extension.dueAt, m.extension.clamped], ['extend', iso('10:46'), null]);
  });

  test('planExtension (pure): a damaged counter is zero, a damaged or missing progress is none, and the thresholds are exact', () => {
    const base = { config: CFG, date: DATE, overdueMinutes: 1, nowMs: Date.parse(iso('06:41')) };
    const watch = (over = {}) => ({ phase: 'build', budgetMinutes: 150, ...over });
    const facts = (minutesAgo, over = {}) => ({ doneMarker: false, progress: { minutesAgo }, ...over });
    const plan = (over) => pw.planExtension({ ...base, watch: watch(), facts: facts(6), ...over });
    assert.equal(plan().n, 1);
    for (const extensions of ['x', -1, 1.5, null, NaN, undefined]) assert.equal(plan({ watch: watch({ extensions }) }).n, 1, String(extensions));
    assert.equal(plan({ watch: watch({ extensions: 1 }) }).n, 2);
    for (const extensions of [2, 3, 99]) assert.equal(plan({ watch: watch({ extensions }) }), null, String(extensions));
    for (const minutesAgo of [null, undefined, '5', NaN, 35.1, 36, 1e9]) assert.equal(plan({ facts: facts(minutesAgo) }), null, String(minutesAgo));
    for (const minutesAgo of [0, 0.1, 20, 35]) assert.ok(plan({ facts: facts(minutesAgo) }), String(minutesAgo));
    assert.equal(plan({ facts: facts(6) }).windowMinutes, 35);
    // the window follows the phase: 20 minutes by default, longer where one agent call writes a big file in one go
    assert.deepEqual(Object.fromEntries(['preflight', 'ideate', 'select', 'spec', 'build', 'qa', 'revise', 'package'].map((p) => [p, pw.progressFreshMinutes(p)])),
      { preflight: 20, ideate: 30, select: 20, spec: 30, build: 35, qa: 25, revise: 30, package: 20 });
    assert.equal(plan({ watch: watch({ phase: 'select', budgetMinutes: 45 }), facts: facts(20.1) }), null);
    assert.ok(plan({ watch: watch({ phase: 'select', budgetMinutes: 45 }), facts: facts(20) }));
    assert.equal(plan({ facts: { doneMarker: false } }), null, 'no progress field at all');
    assert.equal(plan({ facts: facts(6, { doneMarker: true }) }), null);
    assert.equal(plan({ watch: watch({ firedAt: iso('06:41') }) }), null);
    assert.equal(plan({ watch: watch({ phase: 'kaizen' }) }), null);
    assert.ok(plan({ overdueMinutes: 74.9 }));
    assert.equal(plan({ overdueMinutes: 75 }), null);
    assert.ok(plan({ overdueMinutes: 14.9, watch: watch({ budgetMinutes: undefined }) }));
    assert.equal(plan({ overdueMinutes: 15, watch: watch({ budgetMinutes: undefined }) }), null, 'no budget on the block: 15 minutes');
    assert.equal(plan({ overdueMinutes: 15, watch: watch({ budgetMinutes: 'lots' }) }), null);
  });
});

// ---------------------------------------------------------------------------------------
// check: a phase that wrote everything but its DONE.json
// ---------------------------------------------------------------------------------------

describe('watch check: finish by hand', () => {
  const OUT = {
    ideate: { files: { 'ideas/shortlist.json': '{"ideas":[1]}' }, check: /Appendix A1 on work\/2026-10-09\/ideas\/shortlist\.json with MODE=shortlist/ },
    select: { files: { '../state/ideas/2026-10-09.json': '{"ideas":[]}' }, check: /Appendix A1 on state\/ideas\/2026-10-09\.json with MODE=final/ },
    spec: { files: { 'spec/SPEC.md': '# s', 'spec/DESIGN.md': '# d', 'spec/OWNERSHIP.json': '{"files":{}}', 'spec/PROJECT.json': '{"slug":"x"}' }, check: /SPEC\.md, DESIGN\.md, OWNERSHIP\.json and PROJECT\.json exist and are non-empty, and OWNERSHIP\.json and PROJECT\.json parse/ },
    build: { files: { 'build/site/index.html': '<html></html>' }, check: /build\/site\/index\.html exists and the trial stage of PLAYBOOK 10\.1 passes/ },
    qa: { files: { 'qa/report.json': '{"counts":{}}' }, check: /qa\/report\.json parses and has counts/ },
    revise: { files: { 'qa/report.json': '{"counts":{}}', 'revise/log.json': '{}' }, check: /qa\/report\.json was rewritten with a higher revision/ },
  };
  const write = (box, phase) => {
    for (const [rel, content] of Object.entries(OUT[phase].files)) box.write(rel.startsWith('../') ? rel.slice(3) : `work/${DATE}/${rel}`, content);
  };

  test('every phase that has all its outputs but the marker is finished, not redone: check, DONE.json, disarm, spend, checkpoint', async () => {
    for (const phase of Object.keys(OUT)) {
      const { box, due } = await armed(phase);
      write(box, phase);
      const j = good(await chk(box, phase, plusMinutes(due, 5)));
      assert.deepEqual(pick(j, ['verdict', 'action', 'next', 'hint', 'fallback', 'degrade']), { verdict: 'overdue', action: 'finish-by-hand', next: 'finish-by-hand', hint: null, fallback: 'retry', degrade: null }, phase);
      assert.deepEqual(j.outputs.missing, [`work/${DATE}/${phase}/DONE.json`], phase);
      assert.match(j.reason, /every required output except its DONE\.json is there, so finishing by hand beats redoing it \(if the check fails, the retry below applies\)/, phase);
      assert.match(j.steps[0], /^TaskStop\(\{ task_id: "wf-1" \}\)/, phase);
      assert.match(j.steps[1], new RegExp(`^${phase} wrote every required output but its DONE\\.json \\(`), phase);
      assert.match(j.steps[2], OUT[phase].check, phase);
      if (phase === 'spec') assert.match(j.steps[3], new RegExp(`^If the check passes: run: node -e '.*work/${DATE}/spec/PROGRESS\\.json.*work/${DATE}/spec/DONE\\.json.*'$`), phase);
      else assert.match(j.steps[3], new RegExp(`^If the check passes: run: mkdir -p work/${DATE}/${phase} && echo '\\{"ok":true,"phase":"${phase}","by":"orchestrator"\\}' > work/${DATE}/${phase}/DONE\\.json$`), phase);
      assert.match(j.steps[4], /^If the check passes: run: node scripts\/state\.mjs watch disarm --phase \w+ --session P1 --date 2026-10-09 .*delete nothing/, phase);
      assert.match(j.steps[5], new RegExp(`^If the check passes: spend .*checkpoint with note "${phase} ok \\(finished by hand after the phase watch\\)"`), phase);
      const fail = j.steps.indexOf('If the check fails, do exactly this instead (retry):');
      assert.ok(fail > 5, phase);
      assert.ok(j.steps.slice(fail + 1).some((x) => x.includes(`phase-start --phase ${phase}`)), `${phase}: the retry steps follow`);
      assert.ok(!j.steps.slice(0, fail).some((x) => x.includes('phase-start')), `${phase}: nothing is redone before the check`);
      assert.equal(box.run().watch.decision, 'finish-by-hand', phase);
      assert.match(watchEvents(box.run(), 'watch-fired')[0].msg, /next: finish-by-hand/, phase);
    }
  });

  test('the DONE.json step is a real command: afterwards the same timer reads "the Workflow finished"', async () => {
    const { box } = await armed('spec');
    write(box, 'spec');
    const j = good(await chk(box, 'spec', '05:30'));
    // the spec Workflow wrote its compact decision before the architect started (spec/PROGRESS.json): the hand-written marker carries it
    box.write(`work/${DATE}/spec/PROGRESS.json`, { phase: 'spec', compact: false, tier: 1 });
    execFileSync('sh', ['-c', j.steps[3].replace(/^If the check passes: run: /, '')], { cwd: box.root });
    assert.deepEqual(box.readJson(`work/${DATE}/spec/DONE.json`), { ok: true, phase: 'spec', by: 'orchestrator', compact: false, tier: 1 });
    // no marker (an older Workflow, a failed write): the safe side, compact at tier 2 (FM-83: a full build of a mini-spec fails it)
    fs.rmSync(`${box.root}/work/${DATE}/spec/PROGRESS.json`);
    execFileSync('sh', ['-c', j.steps[3].replace(/^If the check passes: run: /, '')], { cwd: box.root });
    assert.deepEqual(box.readJson(`work/${DATE}/spec/DONE.json`), { ok: true, phase: 'spec', by: 'orchestrator', compact: true, tier: 2 });
    const again = good(await chk(box, 'spec', '05:32'));
    assert.deepEqual([again.next, again.repeat], ['nothing', true]);
    // and the disarm step runs: the timer is recorded as spent
    const out = await runSteps(box, [j.steps[4].replace(/^If the check passes: /, '')], '05:33');
    assert.deepEqual([out[0].disarmed, out[0].timerFired, out[0].deleteTrigger], [true, true, null]);
  });

  test('not with a missing output, an empty one, or a single required file; revise also needs its log', async () => {
    const { box } = await armed('spec');
    box.write(`work/${DATE}/spec/SPEC.md`, '# s');
    box.write(`work/${DATE}/spec/DESIGN.md`, '# d');
    assert.equal(good(await chk(box, 'spec', '05:30')).next, 'retry', 'OWNERSHIP.json is missing');
    // build reads spec/PROJECT.json (heading, tagline, the package draft): without it the spec is not finished
    const noProject = await armed('spec');
    for (const f of ['SPEC.md', 'DESIGN.md']) noProject.box.write(`work/${DATE}/spec/${f}`, '# x');
    noProject.box.write(`work/${DATE}/spec/OWNERSHIP.json`, '{"index.html":"artisan"}');
    const np = good(await chk(noProject.box, 'spec', '05:30'));
    assert.deepEqual([np.next, np.outputs.missing], ['retry', [`work/${DATE}/spec/PROJECT.json`, `work/${DATE}/spec/DONE.json`]], 'PROJECT.json is missing');
    const empty = await armed('spec');
    for (const f of ['SPEC.md', 'DESIGN.md']) empty.box.write(`work/${DATE}/spec/${f}`, '# x');
    empty.box.write(`work/${DATE}/spec/OWNERSHIP.json`, '');
    assert.equal(good(await chk(empty.box, 'spec', '05:30')).next, 'retry', 'an empty file is not an output');
    const noLog = await armed('revise');
    noLog.box.write(`work/${DATE}/qa/report.json`, '{"counts":{}}');
    const j = good(await chk(noLog.box, 'revise', plusMinutes(noLog.due, 5)));
    assert.equal(j.next, 'retry');
    assert.deepEqual(j.outputs.missing, [`work/${DATE}/revise/log.json`, `work/${DATE}/revise/DONE.json`]);
    // nothing written at all is the ordinary retry (the other overdue tests); a DONE.json alone is a finished Workflow, not a partial one
  });

  test('when the attempts are spent the fallback is the degrade table, and its steps follow the failed check', async () => {
    const box = await inPhase('spec');
    good(await ST(box, ['phase-start', '--phase', 'spec', '--session', 'P1'], '04:20')); // attempt 2
    good(await arm(box, 'spec', '04:21')); // due 05:46
    write(box, 'spec');
    const j = good(await chk(box, 'spec', '05:50'));
    assert.deepEqual(pick(j, ['next', 'fallback']), { next: 'finish-by-hand', fallback: 'degrade' });
    assert.match(j.reason, /if the check fails, the degrade table below applies/);
    const fail = j.steps.indexOf('If the check fails, do exactly this instead (degrade):');
    assert.ok(fail > 5);
    assert.ok(j.steps.slice(fail + 1).some((x) => /directive --kind ship-now --tier \d/.test(x)));
    assert.equal(j.attemptsLeft, 0);
  });

  test('revise: a retry goes through `revise plan --apply` after phase-start and before the new watch', async () => {
    const box = await inPhase('revise');
    good(await arm(box, 'revise', '04:02')); // due 05:42
    const j = good(await chk(box, 'revise', '05:50'));
    assert.equal(j.next, 'retry');
    const idx = (needle) => j.steps.findIndex((x) => x.includes(needle));
    const plan = idx('revise plan --date');
    assert.ok(plan > 0);
    assert.match(j.steps[plan], new RegExp(`^run: node scripts/state\\.mjs revise plan --date ${DATE} --session P1 --role primary --apply   \\(decision run: relaunch with its workflow object; skip: it records phase-done revise itself, go on to package\\)$`));
    assert.ok(idx('phase-start --phase revise') < plan && plan < idx('watch arm --phase revise'));
    assert.ok(stateCommands(j.steps).some((c) => c[0] === 'revise' && c[1] === 'plan' && c.includes('--apply')));
  });
});

// ---------------------------------------------------------------------------------------
// check: stale
// ---------------------------------------------------------------------------------------

describe('watch check: stale', () => {
  const stale = (j, code) => {
    assert.equal(j.verdict, 'stale');
    assert.equal(j.code, code, j.reason);
    return j;
  };

  test('the shape: a reason and nothing to do; the timer that woke you is spent and is never offered for deletion', async () => {
    const { box } = await armed();
    good(await W(box, 'disarm', ['--phase', 'ideate', '--session', 'P1'], '04:20'));
    const j = stale(good(await chk(box, 'ideate', '05:55')), 'disarmed');
    assert.deepEqual(keys(j), ['action', 'code', 'date', 'deleteTrigger', 'instructions', 'now', 'ok', 'phase', 'reason', 'session', 'timerFired', 'triggerId', 'verdict']);
    // the id is shown as information; deleting a routine that has fired may delete the session it fired into (the platform says so), so no verdict asks for it
    assert.deepEqual([j.triggerId, j.deleteTrigger, j.timerFired, j.action], ['trig_1', null, true, 'nothing']);
    assert.match(j.instructions, /do NOT delete it/);
    assert.doesNotMatch(j.instructions, /delete_trigger\(/);
  });

  test('the phase finished before the timer fired (a phase-done raced it): stale, no event, whatever the clock says', async () => {
    const { box } = await armed();
    good(await ST(box, ['phase-done', '--phase', 'ideate', '--session', 'P1', '--role', 'primary'], '05:30'));
    const before = bytes(box);
    const j = stale(good(await chk(box, 'ideate', '06:30')), 'phase-done');
    assert.equal(j.triggerId, 'trig_1');
    assert.deepEqual(bytes(box), before);
    assert.equal(watchEvents(box.run(), 'watch-fired').length, 0);
  });

  test('check looks twice: a phase-done that lands between the first read and the lock turns an overdue into a stale, with no event', async () => {
    const { box } = await armed();
    const prev = process.env.SED_ROOT;
    process.env.SED_ROOT = box.root;
    try {
      let raced = false;
      const racing = () => {
        raced = true;
        rs.updateRun(DATE, (run) => {
          run.phasesDone.push({ phase: 'ideate', at: iso('05:54'), by: 'primary', note: 'raced' });
          run.phase = 'select';
          return { run, result: null };
        });
      };
      const j = pw.checkWatch({ date: DATE, phase: 'ideate', session: 'P1', now: iso('05:55'), config: CFG, beforeLock: racing });
      assert.equal(raced, true, 'the first read said overdue, so the seam ran');
      assert.deepEqual([j.verdict, j.code, j.action, j.triggerId], ['stale', 'phase-done', 'nothing', 'trig_1']);
      assert.equal(watchEvents(box.run(), 'watch-fired').length, 0);
      assert.equal(box.run().watch.firedAt, undefined);
      // without a race the same call is an ordinary overdue
      const { box: calm } = await armed();
      process.env.SED_ROOT = calm.root;
      assert.equal(pw.checkWatch({ date: DATE, phase: 'ideate', session: 'P1', now: iso('05:55'), config: CFG, beforeLock: () => {} }).verdict, 'overdue');
    } finally {
      if (prev === undefined) delete process.env.SED_ROOT;
      else process.env.SED_ROOT = prev;
    }
  });

  test('the run moved to another phase without finishing this one: stale (phase-moved)', async () => {
    const { box } = await armed();
    good(await ST(box, ['phase-start', '--phase', 'select', '--session', 'P1'], '05:30'));
    stale(good(await chk(box, 'ideate', '06:30')), 'phase-moved');
  });

  test('the day is published, or the run failed, or the lease went to another session', async () => {
    const pub = await armed('package');
    seedPage(pub.box, 1);
    good(await ST(pub.box, ['finish', '--status', 'published', '--tier', '1', '--by', 'primary'], '05:00'));
    stale(good(await chk(pub.box, 'package', '09:00')), 'published');

    const failed = await armed();
    good(await ST(failed.box, ['fail', '--reason', 'gave up', '--session', 'P1'], '05:00'));
    stale(good(await chk(failed.box, 'ideate', '06:30')), 'run-failed');

    const taken = await armed();
    const t = good(await ST(taken.box, ['begin', '--role', 'wdA', '--session', 'A1'], '05:40')); // P1's lease is 100 minutes old
    assert.equal(t.action, 'takeover');
    const j = stale(good(await chk(taken.box, 'ideate', '05:45')), 'lease-held-by-other');
    assert.match(j.reason, /held by wdA\/A1/);
    assert.equal(j.triggerId, 'trig_1', 'the displaced session may still delete its own trigger');
    // the new holder is not bothered by the old holder's block either: its own check says other-session
    const theirs = await W(taken.box, 'check', ['--phase', 'ideate', '--session', 'A1'], '05:46');
    stale(good(theirs), 'other-session');
  });

  test('absent, damaged or foreign: stale without a trigger (it is not ours to delete)', async () => {
    const empty = await inPhase('ideate');
    const none = stale(good(await chk(empty, 'ideate', '05:55')), 'no-watch');
    assert.deepEqual([none.triggerId, none.deleteTrigger], [null, null]);
    assert.equal(none.action, 'nothing');
    assert.match(none.instructions, /spent/);

    const { box } = await armed();
    stale(good(await chk(box, 'build', '05:55')), 'other-phase'); // a timer of another phase
    assert.equal(good(await chk(box, 'build', '05:55')).triggerId, null);
    const other = await W(box, 'check', ['--phase', 'ideate', '--session', 'Z9'], '05:55');
    assert.equal(stale(good(other), 'other-session').triggerId, null);
    stale(good(await chk(box, 'ideate', '05:55', ['--attempt', '3'])), 'superseded');
    assert.equal(good(await chk(box, 'ideate', '05:55', ['--attempt', '1'])).verdict, 'overdue');
    assert.equal(watchEvents(box.run(), 'watch-fired').length, 1, 'only the real overdue wrote');
  });

  test('a run that is missing or unreadable is a stale timer, not a crash', async () => {
    const none = sandbox();
    const m = good(await chk(none, 'ideate', '05:55'));
    assert.deepEqual([m.verdict, m.code, m.triggerId], ['stale', 'no-run', null]);
    const bad = sandbox();
    bad.write(bad.runFile(), '{"schema":1,"da');
    const c = good(await chk(bad, 'ideate', '05:55'));
    assert.deepEqual([c.verdict, c.code], ['stale', 'run-corrupt']);
    assert.match(c.reason, /begin/);
    assert.equal(bad.read(bad.runFile()), '{"schema":1,"da', 'left alone for begin to quarantine');
  });

  test('a phase that was started again after its watch fired, without a new arm: stale (restarted)', async () => {
    const { box } = await armed();
    good(await chk(box, 'ideate', '05:55')); // fires
    good(await ST(box, ['phase-start', '--phase', 'ideate', '--session', 'P1'], '05:56')); // the retry, but no arm yet
    const j = stale(good(await chk(box, 'ideate', '05:58')), 'restarted');
    assert.match(j.reason, /arm/);
  });

  test('a timer delivered hours or days late is too old to act on (an abandoned run must not be wiped and retried)', async () => {
    const { box } = await armed('build'); // due 06:40
    const edge = good(await chk(box, 'build', '08:40')); // exactly 120 minutes late is still overdue
    assert.equal(edge.verdict, 'overdue');
    const { box: late } = await armed('build');
    const lateBytes = bytes(late);
    const j = stale(good(await chk(late, 'build', '08:41')), 'expired'); // 121 minutes
    assert.match(j.reason, /121 min ago \(more than 120\)/);
    assert.match(j.reason, /`begin` decides/);
    assert.equal(j.timerFired, true);
    assert.deepEqual(bytes(late), lateBytes, 'nothing is written: no event, no firedAt');
    // two days later (the abandoned-run case), and the same evening
    for (const [day, t] of [['2026-10-11', '04:10'], [DATE, '23:50']]) {
      const stray = good(await cli(late, ['watch', 'check', '--phase', 'build', '--session', 'P1', '--date', DATE, '--now', iso(t, day), '--no-fetch']));
      assert.deepEqual([stray.verdict, stray.code, stray.action], ['stale', 'expired', 'nothing'], `${day} ${t}`);
    }
  });

  test('a phase that was started again after its watch fired is not a live overdue watch either: the healthy retry is not taken over (FM-W5)', async () => {
    const { box } = await armed('build'); // due 06:40
    good(await chk(box, 'build', '06:50')); // fires
    good(await ST(box, ['phase-start', '--phase', 'build', '--session', 'P1'], '06:52')); // the retry, whose arm the operator forgot (or could not do)
    good(await ST(box, ['beat', '--role', 'primary', '--session', 'P1', '--phase', 'build'], '07:20'));
    good(await ST(box, ['beat', '--role', 'primary', '--session', 'P1', '--phase', 'build'], '07:40'));
    const b = good(await ST(box, ['begin', '--role', 'wdB', '--session', 'B1'], '07:47')); // 57 minutes after the fired watch fell due
    assert.equal(b.action, 'exit-alive', b.reason);
    assert.equal(b.lease.watchStale, false);
    assert.equal(b.lease.watchOverdueMinutes, null);
    assert.equal(b.watch.live, false, 'the block is shown but it no longer counts');
    assert.doesNotMatch(good(await ST(box, ['status'], '07:47')).nextAction, /phase watch/);
    // the same run WITHOUT the restart is the takeover the lease rule always made
    const { box: stuck } = await armed('build');
    good(await chk(stuck, 'build', '06:50'));
    good(await ST(stuck, ['beat', '--role', 'primary', '--session', 'P1', '--phase', 'build'], '07:20'));
    good(await ST(stuck, ['beat', '--role', 'primary', '--session', 'P1', '--phase', 'build'], '07:40'));
    const t = good(await ST(stuck, ['begin', '--role', 'wdB', '--session', 'B1'], '07:47'));
    assert.equal(t.action, 'takeover');
    assert.match(t.reason, /phase watch for build is 67 min overdue/);
  });

  test('a skipped phase that runs once more (PLAYBOOK 4.1) is watched like any other, and stale again once it is closed', async () => {
    const box = await inPhase('qa');
    good(await ST(box, ['skip-phase', '--phase', 'qa', '--reason', 'no time', '--session', 'P1', '--role', 'primary'], '04:10'));
    good(await ST(box, ['phase-start', '--phase', 'qa', '--session', 'P1'], '04:20'));
    good(await arm(box, 'qa', '04:21'));
    assert.equal(good(await chk(box, 'qa', '04:30')).verdict, 'early');
    good(await ST(box, ['phase-done', '--phase', 'qa', '--session', 'P1', '--role', 'primary'], '04:40'));
    stale(good(await chk(box, 'qa', '07:00')), 'phase-done');
  });

  test('kaizen on a published day is a live watch; once the kaizen is closed it is stale', async () => {
    const box = await kaizenRun();
    good(await arm(box, 'kaizen', '08:40'));
    assert.equal(good(await chk(box, 'kaizen', '09:00')).verdict, 'early');
    good(await ST(box, ['phase-done', '--phase', 'kaizen', '--session', 'P1', '--role', 'primary'], '09:30'));
    stale(good(await chk(box, 'kaizen', '10:55')), 'published');
  });
});

// ---------------------------------------------------------------------------------------
// disarm and status
// ---------------------------------------------------------------------------------------

describe('watch disarm', () => {
  test('marks the watch disarmed and prints the trigger to delete; doing it again is harmless', async () => {
    const { box } = await armed();
    const j = good(await W(box, 'disarm', ['--phase', 'ideate', '--session', 'P1'], '04:20'));
    assert.deepEqual(keys(j), ['attempt', 'date', 'deleteTrigger', 'disarmed', 'disarmedAt', 'ifDeleteDenied', 'ok', 'phase', 'session', 'timerFired', 'triggerId', 'workflowTask']);
    assert.deepEqual(pick(j, ['disarmed', 'triggerId', 'workflowTask', 'deleteTrigger', 'disarmedAt', 'timerFired']), { disarmed: true, triggerId: 'trig_1', workflowTask: 'wf-1', deleteTrigger: { trigger_id: 'trig_1' }, disarmedAt: iso('04:20'), timerFired: false });
    // the permission classifier may refuse the delete (2026-10-11): the fallback of PLAYBOOK 7.1a step 4 comes with it
    assert.equal(j.ifDeleteDenied, 'update_trigger({ trigger_id: "trig_1", enabled: false }); denied too: leave it, it fires into a stale `watch check` (PLAYBOOK 7.1a step 4, FM-120)');
    assert.equal(box.run().watch.disarmedAt, iso('04:20'));
    assert.equal(box.run().lease.heartbeatAt, iso('04:20'));
    const before = bytes(box);
    const again = good(await W(box, 'disarm', ['--phase', 'ideate', '--session', 'P1'], '04:25'));
    assert.deepEqual(pick(again, ['disarmed', 'alreadyDisarmed', 'triggerId', 'disarmedAt']), { disarmed: false, alreadyDisarmed: true, triggerId: 'trig_1', disarmedAt: iso('04:20') });
    assert.deepEqual(bytes(box), before);
  });

  test('only a timer that is still pending is offered for deletion: one that has fired is spent (deleting a fired routine may delete the session it fired into)', async () => {
    const { box } = await armed();
    good(await chk(box, 'ideate', '05:55')); // the timer fires: overdue, retry
    const j = good(await W(box, 'disarm', ['--phase', 'ideate', '--session', 'P1'], '05:56'));
    assert.deepEqual(pick(j, ['disarmed', 'triggerId', 'timerFired', 'deleteTrigger']), { disarmed: true, triggerId: 'trig_1', timerFired: true, deleteTrigger: null });
    // a watch that was extended hands out no trigger at all until the new timer is bound; binding it makes it pending again
    const { box: ext } = await armed('build');
    touch(ext, `work/${DATE}/build/site/app.js`, '06:35');
    const e = good(await chk(ext, 'build', '06:41'));
    assert.equal(e.action, 'extend');
    assert.equal(ext.run().watch.triggerId, null);
    assert.equal(good(await W(ext, 'disarm', [], '06:42')).deleteTrigger, null);
    const { box: rebound } = await armed('build');
    touch(rebound, `work/${DATE}/build/site/app.js`, '06:35');
    good(await chk(rebound, 'build', '06:41'));
    good(await W(rebound, 'bind', ['--attempt', '1', '--trigger-id', 'trig_new'], '06:42'));
    assert.deepEqual(pick(good(await W(rebound, 'disarm', [], '06:43')), ['timerFired', 'deleteTrigger']), { timerFired: false, deleteTrigger: { trigger_id: 'trig_new' } });
  });

  test('a timer past its due time is spent even before its PHASEWATCH turn ran watch check: disarm and arm never hand it out for deletion', async () => {
    // The Workflow's notification and the timer's turn can arrive together; the notification turn disarms first (PLAYBOOK 7.1a).
    const { box } = await armed(); // ideate armed 04:00, budget 90 + 10: due 05:40; trig_1 bound, never checked
    assert.equal(good(await W(box, 'status', [], '05:41')).state, 'armed', 'nothing recorded the firing yet');
    const late = good(await W(box, 'disarm', ['--phase', 'ideate', '--session', 'P1'], '05:41'));
    assert.deepEqual(pick(late, ['disarmed', 'triggerId', 'timerFired', 'deleteTrigger']), { disarmed: true, triggerId: 'trig_1', timerFired: true, deleteTrigger: null });
    const { box: early } = await armed();
    assert.deepEqual(pick(good(await W(early, 'disarm', ['--phase', 'ideate', '--session', 'P1'], '05:39')), ['timerFired', 'deleteTrigger']), { timerFired: false, deleteTrigger: { trigger_id: 'trig_1' } }, 'a minute before its due time it is still pending');
    const { box: rearm } = await armed();
    assert.equal(good(await arm(rearm, 'ideate', '05:45')).replaced, null, 're-arming after the due time hands back no spent trigger');
  });

  test('--workflow-task: a notification of another task, or the echo of a TaskStop, is not allowed to unwatch the live attempt', async () => {
    const { box } = await armed('build'); // attempt 1: task wf-1, trigger trig_1
    good(await chk(box, 'build', '06:50')); // fires: wf-1 is to be stopped
    assert.deepEqual(box.run().watch.stoppedTasks, ['wf-1']);
    good(await ST(box, ['phase-start', '--phase', 'build', '--session', 'P1'], '06:52'));
    good(await arm(box, 'build', '06:53'));
    good(await W(box, 'bind', ['--attempt', '2', '--trigger-id', 'trig_A2', '--workflow-task', 'wf-2'], '06:54'));
    const before = bytes(box);
    // the late or echoed notification of attempt 1's Workflow
    const echo = good(await W(box, 'disarm', ['--phase', 'build', '--session', 'P1', '--workflow-task', 'wf-1'], '06:55'));
    assert.deepEqual(pick(echo, ['disarmed', 'reason', 'deleteTrigger', 'triggerId']), { disarmed: false, reason: 'echo', deleteTrigger: null, triggerId: null });
    assert.deepEqual(echo.current, { phase: 'build', attempt: 2, session: 'P1', workflowTask: 'wf-2' });
    assert.match(echo.note, /echo of your TaskStop.*Touch nothing/);
    // a notification of some other task (a Workflow this watch never bound)
    const other = good(await W(box, 'disarm', ['--workflow-task', 'wf-9'], '06:55'));
    assert.deepEqual(pick(other, ['disarmed', 'reason', 'deleteTrigger']), { disarmed: false, reason: 'other-task', deleteTrigger: null });
    assert.match(other.note, /belongs to task wf-2, not wf-9/);
    assert.deepEqual(bytes(box), before, 'neither wrote anything: the live attempt is still watched');
    assert.equal(good(await W(box, 'status', [], '06:56')).state, 'armed');
    // the live attempt's own notification disarms, and prints the pending timer
    const own = good(await W(box, 'disarm', ['--workflow-task', 'wf-2'], '06:57'));
    assert.deepEqual(pick(own, ['disarmed', 'deleteTrigger', 'timerFired']), { disarmed: true, deleteTrigger: { trigger_id: 'trig_A2' }, timerFired: false });
    // a watch that never bound a task (the kaizen binds none) cannot tell: it disarms
    const { box: kz } = await armed();
    const run = kz.run();
    run.watch.workflowTask = null;
    kz.write(kz.runFile(), run);
    assert.equal(good(await W(kz, 'disarm', ['--workflow-task', 'anything'], '04:20')).disarmed, true);
    // the id is a plain token like every other id (exit 2)
    assert.equal((await W(kz, 'disarm', ['--workflow-task', 'wf;1'], '04:21')).code, 2);
  });

  test('without --phase and --session it retires whatever watch there is', async () => {
    const { box } = await armed();
    assert.equal(good(await W(box, 'disarm', [], '04:20')).disarmed, true);
  });

  test('a missing, unreadable or empty run is tolerated (ok:true, nothing to delete)', async () => {
    const none = sandbox();
    const shape = ['date', 'deleteTrigger', 'disarmed', 'ok', 'phase', 'attempt', 'reason', 'triggerId', 'workflowTask'].sort();
    const missing = good(await W(none, 'disarm', ['--phase', 'ideate', '--session', 'P1'], '04:20'));
    assert.deepEqual(keys(missing), shape);
    assert.deepEqual(pick(missing, ['disarmed', 'reason', 'triggerId', 'deleteTrigger']), { disarmed: false, reason: 'no-run', triggerId: null, deleteTrigger: null });
    const bad = sandbox();
    bad.write(bad.runFile(), 'not json');
    assert.equal(good(await W(bad, 'disarm', [], '04:20')).reason, 'run-corrupt');
    assert.equal(bad.read(bad.runFile()), 'not json');
    const noWatch = await inPhase('ideate');
    assert.equal(good(await W(noWatch, 'disarm', [], '04:20')).reason, 'no-watch');
  });

  test('another phase\'s or session\'s watch is left alone and its trigger is not printed', async () => {
    const { box } = await armed();
    const before = bytes(box);
    const phase = good(await W(box, 'disarm', ['--phase', 'build'], '04:20'));
    assert.deepEqual(pick(phase, ['disarmed', 'reason', 'triggerId', 'deleteTrigger', 'current']), { disarmed: false, reason: 'other-phase', triggerId: null, deleteTrigger: null, current: { phase: 'ideate', attempt: 1, session: 'P1' } });
    const session = good(await W(box, 'disarm', ['--session', 'Z9'], '04:20'));
    assert.deepEqual([session.disarmed, session.reason, session.triggerId], [false, 'other-session', null]);
    assert.deepEqual(bytes(box), before);
  });

  test('a displaced session can still disarm its own watch locally and learn which trigger to delete', async () => {
    const { box } = await armed();
    good(await ST(box, ['begin', '--role', 'wdA', '--session', 'A1'], '05:40')); // takes P1's lease
    // wdA's takeover left P1's block in place; P1 retiring it is still allowed (it prints what to delete)
    const j = good(await W(box, 'disarm', ['--phase', 'ideate', '--session', 'P1'], '05:41'));
    assert.deepEqual([j.disarmed, j.triggerId], [true, 'trig_1']);
    assert.equal(box.run().lease.session, 'A1', 'the lease is not touched');
    assert.equal(box.run().lease.heartbeatAt, iso('05:40'), 'and not refreshed for a session that does not hold it');
  });
});

describe('watch status', () => {
  test('no watch, armed, fired and disarmed', async () => {
    const box = await inPhase('ideate');
    const none = good(await W(box, 'status', [], '04:05'));
    assert.deepEqual(pick(none, ['state', 'watch', 'live', 'overdueMinutes', 'staleLease', 'runPhase', 'runStatus', 'runFile']), { state: 'none', watch: null, live: false, overdueMinutes: null, staleLease: false, runPhase: 'ideate', runStatus: 'in_progress', runFile: 'ok' });

    good(await arm(box, 'ideate', '04:00'));
    const armedNow = good(await W(box, 'status', [], '04:30'));
    assert.deepEqual(keys(armedNow), ['date', 'dueInMinutes', 'live', 'now', 'ok', 'overdueMinutes', 'runFile', 'runPhase', 'runStatus', 'sendLater', 'staleLease', 'state', 'watch']);
    assert.deepEqual(pick(armedNow, ['state', 'live', 'dueInMinutes', 'overdueMinutes', 'staleLease']), { state: 'armed', live: true, dueInMinutes: 70, overdueMinutes: -70, staleLease: false });
    assert.equal(armedNow.watch.phase, 'ideate');
    assert.equal(armedNow.sendLater.name, `sed-watch-${DATE}-ideate-a1`);
    assert.equal(armedNow.sendLater.message, pw.watchMessage({ date: DATE, phase: 'ideate', attempt: 1, session: 'P1', dueAt: armedNow.watch.dueAt, root: box.root }));

    good(await chk(box, 'ideate', '05:50'));
    const fired = good(await W(box, 'status', [], '05:56'));
    assert.deepEqual(pick(fired, ['state', 'overdueMinutes', 'staleLease']), { state: 'fired', overdueMinutes: 16, staleLease: true });
    assert.equal(fired.watch.decision, 'retry');

    good(await W(box, 'disarm', [], '05:57'));
    const off = good(await W(box, 'status', [], '05:58'));
    assert.deepEqual(pick(off, ['state', 'live', 'overdueMinutes', 'staleLease', 'sendLater']), { state: 'disarmed', live: false, overdueMinutes: null, staleLease: false, sendLater: undefined });
  });

  test('a missing or unreadable run is reported, not fatal; nothing is written', async () => {
    const none = sandbox();
    assert.deepEqual(pick(good(await W(none, 'status', [], '04:00')), ['runFile', 'state', 'watch']), { runFile: 'missing', state: 'none', watch: null });
    const bad = sandbox();
    bad.write(bad.runFile(), '[');
    assert.equal(good(await W(bad, 'status', [], '04:00')).runFile, 'corrupt');
    assert.equal(bad.read(bad.runFile()), '[');
  });
});

// ---------------------------------------------------------------------------------------
// a damaged watch block never crashes anything
// ---------------------------------------------------------------------------------------

describe('a damaged run.watch', () => {
  // Every block names build/P1 and the due time 05:40 where it can, so only its damage keeps it from acting like slowBuild's real one.
  const due = iso('05:40');
  const GARBAGE = [
    ['a string', 'build'],
    ['a number', 42],
    ['true', true],
    ['false', false],
    ['an empty string', ''],
    ['an array', ['build', 'P1']],
    ['an empty object', {}],
    ['no dueAt', { phase: 'build', session: 'P1' }],
    ['a numeric dueAt (Date.parse would accept it)', { phase: 'build', session: 'P1', dueAt: 5 }],
    ['a fragment of a date', { phase: 'build', session: 'P1', dueAt: '2026' }],
    ['a dueAt in words', { phase: 'build', session: 'P1', dueAt: 'tomorrow' }],
    ['an unknown phase', { phase: 'brunch', session: 'P1', dueAt: due }],
    ['phase done', { phase: 'done', session: 'P1', dueAt: due }],
    ['no session', { phase: 'build', dueAt: due }],
    ['a numeric session', { phase: 'build', session: 7, dueAt: due }],
    ['nested junk', { phase: { a: [1, { b: 2 }] }, session: ['x'], dueAt: { y: 1 } }],
  ];

  /** slowBuild without a watch, with `value` written into run.watch by hand. */
  async function withWatch(value) {
    const box = await slowBuild({ arming: false });
    const run = box.run();
    run.watch = value;
    box.write(box.runFile(), run);
    return box;
  }

  for (const [label, value] of GARBAGE) {
    test(`${label}: check, status, disarm, bind, begin and status all stay calm, and arm replaces it`, async () => {
      const box = await withWatch(value);
      const c = good(await chk(box, 'build', '05:56'));
      assert.equal(c.verdict, 'stale', label);
      assert.match(c.code, /^(no-watch|corrupt-watch)$/);
      assert.deepEqual([c.triggerId, c.deleteTrigger], [null, null]);
      assert.match(good(await W(box, 'status', [], '05:56')).state, /^(none|corrupt)$/);
      const d = good(await W(box, 'disarm', [], '05:56'));
      assert.deepEqual([d.disarmed, d.triggerId], [false, null]);
      const b = await W(box, 'bind', ['--trigger-id', 'trig_1'], '05:56');
      assert.equal(b.code, 1);
      assert.doesNotMatch(b.json.error, /unexpected/);
      // The decision table and the status summary ignore it: the primary beat at 05:50 and its "watch" fell due 16 minutes ago,
      // yet it is alive. (A lenient Date.parse would have read 5 or '2026' as a date long past and declared the holder dead.)
      const begun = good(await ST(box, ['begin', '--role', 'wdA', '--session', 'A1'], '05:56'));
      assert.equal(begun.action, 'exit-alive', label);
      const status = good(await ST(box, ['status'], '05:56'));
      assert.equal(status.lease.alive, true, label);
      assert.doesNotMatch(status.nextAction, /phase watch/);
      // arming writes a clean block over the junk
      const a = good(await arm(box, 'build', '05:57'));
      assert.equal(a.attempt, 1);
      assert.deepEqual(pick(box.run().watch, ['phase', 'session']), { phase: 'build', session: 'P1' });
    });
  }

  test('sub-fields: ids that are not tokens, a damaged attempt, arms and times are sanitized, never trusted', async () => {
    const { box } = await armed();
    const run = box.run();
    Object.assign(run.watch, { triggerId: { x: 1 }, workflowTask: 'a b', attempt: 'two', arms: 'x', armedAt: 12 });
    box.write(box.runFile(), run);
    const early = good(await chk(box, 'ideate', '04:30'));
    assert.deepEqual([early.verdict, early.attempt], ['early', 1]);
    const over = good(await chk(box, 'ideate', '05:55'));
    assert.deepEqual([over.verdict, over.workflowTask, over.triggerId], ['overdue', null, null]);
    assert.match(over.steps[0], /^TaskStop the running/);
    const again = good(await arm(box, 'ideate', '06:00'));
    assert.equal(again.attempt, 1, 'a damaged arm counter is ignored');
    assert.equal(again.replaced, null);
    const run2 = box.run();
    run2.watch.arms = { ideate: -3, bogus: 4, select: 'x' };
    box.write(box.runFile(), run2);
    good(await ST(box, ['phase-start', '--phase', 'ideate', '--session', 'P1'], '06:04')); // the retry's own phase-start: a new launch
    assert.equal(good(await arm(box, 'ideate', '06:05')).attempt, 2, 'only the valid previous attempt counts');
  });

  test('a block of another session (a previous holder, or garbage) cannot make a live holder look dead', async () => {
    const box = await slowBuild();
    const run = box.run();
    run.watch.session = 'GHOST';
    box.write(box.runFile(), run);
    assert.equal(good(await ST(box, ['begin', '--role', 'wdA', '--session', 'A1'], '05:56')).action, 'exit-alive');
  });
});

// ---------------------------------------------------------------------------------------
// the decision table: an overdue watch makes the lease stale
// ---------------------------------------------------------------------------------------

describe('begin and status: an armed watch overdue by more than 15 minutes makes the lease stale', () => {
  const begin = (box, role, session, t) => ST(box, ['begin', '--role', role, '--session', session], t);

  test('exactly 15 minutes overdue is still alive; 16 is a takeover, and the reason names the watch', async () => {
    const box = await slowBuild();
    const edge = good(await begin(box, 'wdA', 'A1', '05:55'));
    assert.deepEqual([edge.action, edge.wrote], ['exit-alive', false]);
    assert.deepEqual(pick(edge.watch, ['phase', 'attempt', 'live', 'overdueMinutes', 'staleLease']), { phase: 'build', attempt: 1, live: true, overdueMinutes: 15, staleLease: false });
    assert.equal(edge.lease.stale, false);
    const taken = good(await begin(box, 'wdA', 'A1', '05:56'));
    assert.equal(taken.action, 'takeover');
    assert.equal(taken.resumePhase, 'build');
    assert.match(taken.reason, /phase watch for build is 16 min overdue \(> 15\) although the heartbeat is fresh; taking over at build/);
    assert.deepEqual(pick(taken.watch, ['session', 'live', 'overdueMinutes', 'staleLease']), { session: 'P1', live: false, overdueMinutes: null, staleLease: false }, 'the new holder is not the watch owner: the block is shown but no longer live');
    const run = box.run();
    assert.deepEqual([run.lease.holder, run.lease.session], ['wdA', 'A1']);
    assert.ok(run.events.some((e) => e.kind === 'takeover' && /phase watch for build/.test(e.msg)));
  });

  test('the same timeline without a watch is an ordinary live primary (the watch is the only cause)', async () => {
    const box = await slowBuild({ arming: false });
    const j = good(await begin(box, 'wdA', 'A1', '05:56'));
    assert.equal(j.action, 'exit-alive');
    assert.equal(j.watch, undefined, 'no block, no key');
  });

  test('a watch that was disarmed, finished, moved on from, or belongs to a previous holder is ignored', async () => {
    const disarmed = await slowBuild();
    good(await W(disarmed, 'disarm', [], '05:51'));
    assert.equal(good(await begin(disarmed, 'wdA', 'A1', '05:56')).action, 'exit-alive');

    const done = await slowBuild();
    good(await ST(done, ['phase-done', '--phase', 'build', '--session', 'P1', '--role', 'primary'], '05:51'));
    good(await ST(done, ['phase-start', '--phase', 'qa', '--session', 'P1'], '05:52'));
    assert.equal(good(await begin(done, 'wdA', 'A1', '05:56')).action, 'exit-alive');

    // wdA took over at 05:56; the old holder's overdue block must not make wdB take over wdA a little later
    const old = await slowBuild();
    assert.equal(good(await begin(old, 'wdA', 'A1', '05:56')).action, 'takeover');
    good(await ST(old, ['beat', '--role', 'wdA', '--session', 'A1', '--phase', 'build'], '06:40'));
    const b = good(await begin(old, 'wdB', 'B1', '06:47'));
    assert.equal(b.action, 'exit-alive');
    assert.equal(b.watch.session, 'P1');
    assert.equal(b.watch.live, false);
  });

  test('a watch of a phase that is already in phasesDone is no live watch even while the pointer still names it; started again afterwards it is live again', async () => {
    // a merge of two writers can leave run.phase behind its own phasesDone; the finished phase's overdue watch must not take the day over
    const box = await slowBuild(); // build since 04:30, the watch fell due 05:40, last beat 05:50
    const run = box.run();
    run.phasesDone.push({ phase: 'build', at: iso('05:45'), by: 'primary', note: 'ok' });
    box.write(box.runFile(), run);
    assert.equal(run.phase, 'build');
    assert.equal(rs.watchOverdueMinutes(box.run(), Date.parse(iso('05:56'))), null);
    assert.equal(good(await begin(box, 'wdA', 'A1', '05:56')).action, 'exit-alive');
    // the phase is started again after it was finished (a retry of a closed phase): its watch counts again
    const again = box.run();
    again.phaseStartedAt.build = iso('05:50');
    box.write(box.runFile(), again);
    assert.equal(rs.watchOverdueMinutes(box.run(), Date.parse(iso('05:56'))), 16);
    const taken = good(await begin(box, 'wdA', 'A1', '05:56'));
    assert.equal(taken.action, 'takeover');
    assert.match(taken.reason, /phase watch for build is 16 min overdue/);
  });

  test('the holder itself, resuming after the watch went stale, resumes (the lease rule treats it like any stale lease)', async () => {
    const box = await slowBuild();
    const j = good(await begin(box, 'primary', 'P1', '05:56'));
    assert.equal(j.action, 'resume');
    assert.match(j.reason, /phase watch for build is 16 min overdue/);
  });

  test('a healthy late run keeps the closer\'s grace until its own watch is 15 minutes late', async () => {
    const box = await inPhase('qa', { at: '08:10' });
    assert.equal(good(await arm(box, 'qa', '08:10', ['--minutes', '20'])).dueAt, iso('08:40'));
    good(await ST(box, ['beat', '--role', 'primary', '--session', 'P1', '--phase', 'qa'], '08:44'));
    const grace = good(await begin(box, 'closer', 'C1', '08:47'));
    assert.deepEqual([grace.action, grace.grace], ['exit-alive', true]); // 7 minutes late: the grace period holds
    good(await ST(box, ['beat', '--role', 'primary', '--session', 'P1', '--phase', 'qa'], '08:55'));
    const cut = good(await begin(box, 'closer', 'C1', '08:56'));
    assert.equal(cut.grace, false);
    assert.equal(cut.action, 'takeover');
    assert.match(cut.reason, /phase watch for qa is 16 min overdue/);
  });

  test('the kaizen phase counts too: a kaizen watch more than 15 minutes late frees the round for resume-kaizen', async () => {
    const box = await kaizenRun();
    good(await arm(box, 'kaizen', '08:40', ['--minutes', '20'])); // due 09:25 (20 + 25)
    good(await ST(box, ['beat', '--role', 'primary', '--session', 'P1', '--phase', 'kaizen'], '09:35'));
    const running = good(await begin(box, 'wdA', 'A1', '09:40')); // 15 minutes late: the owner is still running it
    assert.equal(running.action, 'exit-published');
    assert.match(running.reason, /its kaizen is running/);
    const freed = good(await begin(box, 'wdA', 'A1', '09:41')); // 16 minutes late
    assert.equal(freed.action, 'resume-kaizen');
    assert.match(freed.reason, /phase watch for kaizen is 16 min overdue/);
  });

  test('status: nextAction and the watch summary say what is going on, before and after the line', async () => {
    const box = await slowBuild();
    const before = good(await ST(box, ['status'], '05:30'));
    assert.deepEqual(pick(before.watch, ['phase', 'live', 'overdueMinutes']), { phase: 'build', live: true, overdueMinutes: -10 });
    assert.doesNotMatch(before.nextAction, /phase watch/);
    const late = good(await ST(box, ['status'], '05:45'));
    assert.equal(late.lease.alive, true);
    assert.match(late.nextAction, /phase watch for build fell due 5 min ago/);
    assert.match(late.nextAction, /watch check/);
    const stale = good(await ST(box, ['status'], '05:56'));
    assert.deepEqual([stale.lease.alive, stale.lease.stale, stale.lease.watchStale, stale.watch.staleLease], [false, true, true, true]);
    assert.match(stale.nextAction, /phase watch for build is 16 min overdue \(limit 15\) although primary still beats: treated as hung, `begin` takes over at build/);
    assert.equal(good(await ST(await slowBuild({ arming: false }), ['status'], '05:56')).watch, undefined);
  });

  test('the deadman\'s view of the lease agrees (leaseInfo is the one place that decides)', async () => {
    const box = await slowBuild();
    const prev = process.env.SED_ROOT;
    process.env.SED_ROOT = box.root;
    try {
      const run = rs.loadRun(DATE);
      const at = (hhmm) => Date.parse(iso(hhmm));
      assert.deepEqual(pick(rs.leaseInfo(CFG, run, null, at('05:55')), ['stale', 'beatStale', 'watchStale', 'watchOverdueMinutes']), { stale: false, beatStale: false, watchStale: false, watchOverdueMinutes: 15 });
      assert.deepEqual(pick(rs.leaseInfo(CFG, run, null, at('05:56')), ['stale', 'beatStale', 'watchStale', 'watchOverdueMinutes']), { stale: true, beatStale: false, watchStale: true, watchOverdueMinutes: 16 });
      // an unreadable heartbeat channel normally gives a silent lease the benefit of the doubt; an overdue watch does not
      const silent = { ...run, lease: { ...run.lease, heartbeatAt: iso('05:00') } }; // 56 minutes without a sign of life
      const calm = rs.leaseInfo(CFG, { ...silent, watch: undefined }, null, at('05:56'), { hbUnknown: true });
      assert.deepEqual(pick(calm, ['stale', 'hbUnreadable', 'watchStale']), { stale: false, hbUnreadable: true, watchStale: false });
      const watched = rs.leaseInfo(CFG, silent, null, at('05:56'), { hbUnknown: true });
      assert.deepEqual(pick(watched, ['stale', 'hbUnreadable', 'watchStale']), { stale: true, hbUnreadable: false, watchStale: true });
    } finally {
      if (prev === undefined) delete process.env.SED_ROOT;
      else process.env.SED_ROOT = prev;
    }
  });
});

describe('begin and status: a live watch moves the stuck limit out to its own window', () => {
  // phaseStuckMinutes is 90, but the owner's phase budgets are longer (build 150, ideate/qa/revise 90 + the watch margin, kaizen 120):
  // without this a healthy slow build would be called stuck at minute 90 and taken over by a watchdog, whatever its watch says.
  const begin = (box, role, session, t) => ST(box, ['begin', '--role', role, '--session', session], t);
  /**
   * A primary in build since 04:30, watch armed at 04:30 with the 150 minute budget (due 07:10, so the limit is 160 + 15 = 175 minutes),
   * beating at `beat`. `config` TEST_CONFIG has no phaseBudgetMinutes: the limit is then exactly what it always was (90) when no watch is live.
   */
  async function longBuild({ arming = true, beat = '06:40', config = CFG } = {}) {
    const box = await inPhase('build', { config, at: '04:30' });
    if (arming) assert.equal(good(await arm(box, 'build', '04:30', ['--minutes', '150'])).dueAt, iso('07:10'));
    good(await ST(box, ['beat', '--role', 'primary', '--session', 'P1', '--phase', 'build'], beat));
    return box;
  }

  test('wdB at 06:47 finds a healthy build 137 minutes in and leaves it alone; the same timeline without a watch and without a configured budget is a takeover as ever', async () => {
    const box = await longBuild();
    const alive = good(await begin(box, 'wdB', 'B1', '06:47'));
    assert.equal(alive.action, 'exit-alive');
    assert.equal(box.run().lease.session, 'P1', 'nothing was written');
    const status = good(await ST(box, ['status'], '06:47'));
    assert.deepEqual([status.lease.stuck, status.lease.alive, status.stuckLimitMinutes], [false, true, 175]);

    const plain = await longBuild({ arming: false, config: TEST_CONFIG });
    const taken = good(await begin(plain, 'wdB', 'B1', '06:47'));
    assert.equal(taken.action, 'takeover');
    assert.match(taken.reason, /phase build has run 137 min \(> 90\) although the heartbeat is fresh/);
    assert.equal(good(await ST(await longBuild({ arming: false, config: TEST_CONFIG }), ['status'], '06:47')).stuckLimitMinutes, 90);
  });

  test('another container does not see the watch until a push carries it: the configured phase budget stands in for it (budget + 10 + 15)', async () => {
    // build 150 minutes: without a visible watch the limit is 175, not 90; a configured budget below the base limit changes nothing
    const unseen = await longBuild({ arming: false });
    const alive = good(await begin(unseen, 'wdB', 'B1', '06:47'));
    assert.equal(alive.action, 'exit-alive', alive.reason);
    assert.equal(good(await ST(unseen, ['status'], '06:47')).stuckLimitMinutes, 175);
    // a genuinely hung build is still taken over, 175 minutes after it started (04:30 + 175 = 07:25)
    good(await ST(unseen, ['beat', '--role', 'primary', '--session', 'P1', '--phase', 'build'], '07:24'));
    assert.equal(good(await begin(unseen, 'wdB', 'B1', '07:25')).action, 'exit-alive', 'exactly at the limit is not yet stuck');
    const hung = good(await begin(unseen, 'wdB', 'B1', '07:26'));
    assert.equal(hung.action, 'takeover');
    assert.match(hung.reason, /phase build has run 176 min \(> 175\) although the heartbeat is fresh/);
    for (const [phase, budget, limit] of [['preflight', 15, 90], ['select', 45, 90], ['package', 25, 90], ['ideate', 90, 115], ['spec', 75, 100], ['qa', 90, 115], ['revise', 90, 115]]) {
      const box = await inPhase(phase, { at: '04:30' });
      const info = rs.leaseInfo(CFG, box.run(), null, Date.parse(iso('04:40')));
      assert.equal(info.stuckLimitMinutes, limit, `${phase} (budget ${budget}) ${limit}`);
    }
    // a damaged entry is no budget
    const bad = await inPhase('build', { config: { ...CFG, phaseBudgetMinutes: { build: -5 } }, at: '04:30' });
    assert.equal(rs.leaseInfo({ ...CFG, phaseBudgetMinutes: { build: -5 } }, bad.run(), null, Date.parse(iso('04:40'))).stuckLimitMinutes, 90);
    // the watch, when it IS visible, is the better statement: a smaller budget in the watch shortens the configured one
    const seen = await inPhase('build', { at: '04:30' });
    good(await arm(seen, 'build', '04:30', ['--minutes', '60'])); // due 05:40: limit 70 + 15 = 85, under the base 90: the base stands
    assert.equal(good(await ST(seen, ['status'], '04:40')).stuckLimitMinutes, 90);
    const bigger = await inPhase('build', { at: '04:30' });
    good(await arm(bigger, 'build', '04:30', ['--minutes', '100'])); // due 06:20: limit 125 (the configured 175 does not take over)
    assert.equal(good(await ST(bigger, ['status'], '04:40')).stuckLimitMinutes, 125);
  });

  test('the window ends where the watch goes stale: alive at 15 minutes past its due time, a takeover for the watch at 16', async () => {
    const box = await longBuild({ beat: '07:24' });
    const edge = good(await begin(box, 'wdB', 'B1', '07:25')); // due 07:10 + 15
    assert.equal(edge.action, 'exit-alive');
    const cut = good(await begin(box, 'wdB', 'B1', '07:26'));
    assert.equal(cut.action, 'takeover');
    assert.match(cut.reason, /phase watch for build is 16 min overdue \(> 15\) although the heartbeat is fresh/);
  });

  test('a silent heartbeat still ends it: the window only covers the stuck rule, not the 35 minute silence rule', async () => {
    const box = await longBuild({ beat: '05:50' }); // last sign of life 05:50
    const j = good(await begin(box, 'wdB', 'B1', '06:47')); // 57 minutes silent
    assert.equal(j.action, 'takeover');
    assert.match(j.reason, /silent|stale/i);
  });

  test('only the holder\'s live watch for the current phase counts: disarmed, finished, another phase or a previous holder move nothing', async () => {
    const disarmed = await longBuild({ config: TEST_CONFIG });
    good(await W(disarmed, 'disarm', [], '06:41'));
    assert.equal(good(await begin(disarmed, 'wdB', 'B1', '06:47')).action, 'takeover');

    const old = await longBuild({ config: TEST_CONFIG });
    assert.equal(good(await begin(old, 'wdA', 'A1', '07:27')).action, 'takeover', 'the watch went stale: wdA took over');
    good(await ST(old, ['beat', '--role', 'wdA', '--session', 'A1', '--phase', 'build'], '07:40'));
    const status = good(await ST(old, ['status'], '07:45'));
    assert.equal(status.stuckLimitMinutes, 90, "wdA holds the lease now: P1's watch no longer moves the limit");
  });

  test('a manual run keeps its doubled limit (the larger of the two wins)', async () => {
    const box = sandbox(CFG);
    good(await ST(box, ['begin', '--role', 'manual', '--session', 'M1'], '04:00'));
    good(await ST(box, ['phase-start', '--phase', 'preflight', '--session', 'M1'], '04:00'));
    assert.equal(good(await ST(box, ['status'], '04:30')).stuckLimitMinutes, 180);
    good(await W(box, 'arm', ['--phase', 'preflight', '--session', 'M1', '--role', 'manual', '--minutes', '15'], '04:00'));
    assert.equal(good(await ST(box, ['status'], '04:30')).stuckLimitMinutes, 180, 'a 40 minute window does not shorten it');
  });
});

// ---------------------------------------------------------------------------------------
// two writers of one run file
// ---------------------------------------------------------------------------------------

describe('mergeRuns keeps the phase watch of the lease holder', () => {
  const lease = (holder, session, acquired, beat) => ({ holder, session, acquiredAt: iso(acquired), heartbeatAt: iso(beat) });
  const run = (over = {}) => ({
    schema: 1,
    date: DATE,
    status: 'in_progress',
    targetTier: 1,
    tier: null,
    phase: 'build',
    phasesDone: [],
    attempts: {},
    phaseStartedAt: { build: iso('04:00') },
    lease: lease('primary', 'P1', '03:55', '04:10'),
    directives: [],
    chosen: null,
    throttle: 'balanced',
    spend: { outputTokens: 0, agentCalls: 0, byPhase: {} },
    publishedAt: null,
    publishedUrl: null,
    events: [],
    ...over,
  });
  const w = (extra = {}) => ({ phase: 'build', attempt: 1, armedAt: iso('04:05'), dueAt: iso('06:00'), session: 'P1', triggerId: null, workflowTask: null, ...extra });

  test('one holder on both sides keeps the block it touched last, whichever side that was', () => {
    const armedOnly = run({ watch: w() });
    const disarmed = run({ watch: w({ disarmedAt: iso('04:20') }), lease: lease('primary', 'P1', '03:55', '04:20') });
    assert.equal(rs.mergeRuns(armedOnly, armedOnly, disarmed).run.watch.disarmedAt, iso('04:20'));
    assert.equal(rs.mergeRuns(armedOnly, disarmed, armedOnly).run.watch.disarmedAt, iso('04:20')); // the other way round
    const bound = run({ watch: w({ triggerId: 'trig_1', boundAt: iso('04:06') }) });
    assert.equal(rs.mergeRuns(armedOnly, bound, armedOnly).run.watch.triggerId, 'trig_1');
    // a side that never had a watch does not erase the other's
    assert.equal(rs.mergeRuns(run(), armedOnly, run()).run.watch.phase, 'build');
    assert.equal(rs.mergeRuns(run(), run(), armedOnly).run.watch.phase, 'build');
    assert.equal('watch' in rs.mergeRuns(run(), run(), run()).run, false);
  });

  test('an extension and a spent timer count as touching the block: the side that did it last wins, whichever side that is', () => {
    const base = run({ watch: w({ triggerId: 'trig_1', boundAt: iso('04:06') }) });
    const extended = run({ watch: w({ triggerId: null, boundAt: iso('04:06'), dueAt: iso('06:15'), extensions: 1, extendedAt: iso('06:01') }), lease: lease('primary', 'P1', '03:55', '06:01') });
    for (const [remote, local] of [[base, extended], [extended, base]]) {
      const merged = rs.mergeRuns(base, remote, local).run.watch;
      assert.deepEqual(pick(merged, ['dueAt', 'extensions', 'extendedAt', 'triggerId']), { dueAt: iso('06:15'), extensions: 1, extendedAt: iso('06:01'), triggerId: null });
    }
    const spent = run({ watch: w({ triggerId: 'trig_1', boundAt: iso('04:06'), timerFiredAt: iso('06:05') }) });
    for (const [remote, local] of [[base, spent], [spent, base]]) assert.equal(rs.mergeRuns(base, remote, local).run.watch.timerFiredAt, iso('06:05'));
    // and an extension later than a spent-timer note beats it (the new timer is the live one)
    const later = run({ watch: w({ triggerId: null, dueAt: iso('06:30'), extensions: 1, extendedAt: iso('06:20') }) });
    assert.equal(rs.mergeRuns(base, spent, later).run.watch.extendedAt, iso('06:20'));
    assert.equal(rs.mergeRuns(base, later, spent).run.watch.extendedAt, iso('06:20'));
  });

  test('two holders: the winner\'s block stands and the loser\'s never leaks in', () => {
    const remote = run({ watch: w({ session: 'P1' }) });
    const local = run({ lease: lease('wdA', 'A1', '05:40', '05:41'), watch: w({ session: 'A1', attempt: 1, dueAt: iso('07:00') }) });
    const merged = rs.mergeRuns(remote, remote, local);
    assert.equal(merged.displaced, false);
    assert.equal(merged.run.watch.session, 'A1');
    const noWatch = rs.mergeRuns(remote, remote, run({ lease: lease('wdA', 'A1', '05:40', '05:41') }));
    assert.equal('watch' in noWatch.run, false, 'wdA won and has no watch of its own: the dead primary\'s block is gone');
  });
});

// ---------------------------------------------------------------------------------------
// the contract with the shell, and with a real remote
// ---------------------------------------------------------------------------------------

describe('spawned CLI: one JSON document, exit codes', () => {
  test('arm, bind, check, disarm and status as the operator runs them', () => {
    const box = sandbox();
    const run = (args, t, env) => box.cli('state', [...args, '--date', DATE, '--now', iso(t), '--no-fetch'], env);
    good(run(['begin', '--role', 'primary', '--session', 'P1'], '03:55'));
    good(run(['phase-done', '--phase', 'preflight', '--session', 'P1', '--role', 'primary'], '03:56'));
    good(run(['phase-start', '--phase', 'ideate', '--session', 'P1'], '04:00'));
    const a = good(run(['watch', 'arm', '--phase', 'ideate', '--session', 'P1', '--role', 'primary', '--minutes', '75'], '04:01'));
    assert.equal(a.dueAt, iso('05:26'));
    assert.equal(a.sendLater.at, noMillis(iso('05:26')));
    assert.equal(good(run(['watch', 'bind', '--phase', 'ideate', '--session', 'P1', '--trigger-id', 'trig_7', '--workflow-task', 'wf-7'], '04:02')).triggerId, 'trig_7');
    assert.equal(good(run(['watch', 'status'], '04:03')).state, 'armed');
    assert.equal(good(run(['watch', 'check', '--phase', 'ideate', '--session', 'P1'], '04:30')).verdict, 'early');
    const over = good(run(['watch', 'check', '--phase', 'ideate', '--session', 'P1'], '05:30'));
    assert.deepEqual([over.verdict, over.next], ['overdue', 'retry']);
    // the timer that fired is spent: the disarm names it but does not offer it for deletion
    const off = good(run(['watch', 'disarm', '--phase', 'ideate', '--session', 'P1'], '05:31'));
    assert.deepEqual([off.triggerId, off.timerFired, off.deleteTrigger], ['trig_7', true, null]);
    assert.equal(good(run(['watch', 'check', '--phase', 'ideate', '--session', 'P1'], '05:32')).code, 'disarmed');
  });

  test('SED_NOW works like --now; usage errors exit 2 with the usage text on stdout', () => {
    const box = sandbox();
    good(box.state(['begin', '--role', 'primary', '--session', 'P1', '--now', iso('03:55')]));
    good(box.state(['phase-start', '--phase', 'preflight', '--session', 'P1', '--now', iso('03:56')]));
    const j = good(box.cli('state', ['watch', 'arm', '--phase', 'preflight', '--session', 'P1'], { SED_NOW: iso('04:00') }));
    assert.equal(j.armedAt, iso('04:00'));
    for (const args of [['watch'], ['watch', 'frobnicate'], ['watch', 'check', '--phase', 'ideate'], ['watch', 'arm', '--session', 'P1'], ['watch', 'check', '--phase', 'ideate', '--session', 'P1', '--now', 'soon']]) {
      const r = box.state(args);
      assert.equal(r.code, 2, args.join(' '));
      assert.equal(r.json.ok, false);
    }
    assert.match(box.state(['watch']).json.usage, /watch check --phase P --session S/);
  });

  test('begin and status print the watch summary only when a block exists', () => {
    const box = sandbox();
    const run = (args, t) => box.state([...args, '--date', DATE, '--now', iso(t), '--no-fetch']);
    assert.equal('watch' in good(run(['begin', '--role', 'primary', '--session', 'P1'], '03:55')), false);
    good(run(['phase-start', '--phase', 'preflight', '--session', 'P1'], '03:56'));
    good(run(['watch', 'arm', '--phase', 'preflight', '--session', 'P1'], '03:57'));
    const s = good(run(['status'], '04:00'));
    assert.deepEqual(pick(s.watch, ['phase', 'attempt', 'live', 'staleLease', 'triggerId']), { phase: 'preflight', attempt: 1, live: true, staleLease: false, triggerId: null });
    assert.equal(good(run(['begin', '--role', 'primary', '--session', 'P1'], '04:01')).watch.phase, 'preflight');
  });
});

describe('with a real remote', () => {
  const fetching = (box, args, t) => box.state([...args, '--date', DATE, '--now', iso(t)]); // fetches, like a real turn
  const push = (box, msg = 'checkpoint') => box.state(['sync', '-m', msg, '--no-sleep']);

  test('the watch rides the next checkpoint push; a takeover elsewhere turns this session\'s timer into stale/displaced and arm into a refusal', () => {
    const a = repoSandbox();
    good(fetching(a, ['begin', '--role', 'primary', '--session', 'P1'], '03:55'));
    good(fetching(a, ['phase-done', '--phase', 'preflight', '--session', 'P1', '--role', 'primary'], '03:56'));
    good(fetching(a, ['phase-start', '--phase', 'ideate', '--session', 'P1'], '04:00'));
    good(fetching(a, ['watch', 'arm', '--phase', 'ideate', '--session', 'P1', '--role', 'primary'], '04:01'));
    good(fetching(a, ['watch', 'bind', '--phase', 'ideate', '--session', 'P1', '--trigger-id', 'trig_1'], '04:02'));
    good(push(a));
    const pushed = JSON.parse(remoteFile(a.remote, `state/runs/${DATE}.json`));
    assert.deepEqual(pick(pushed.watch, ['phase', 'attempt', 'session', 'triggerId']), { phase: 'ideate', attempt: 1, session: 'P1', triggerId: 'trig_1' });

    // wdA finds the lease 100 minutes old and takes over; P1 does not know yet
    const b = a.cloneB('wda');
    assert.equal(good(fetching(b, ['begin', '--role', 'wdA', '--session', 'A1'], '05:40')).action, 'takeover');
    good(push(b, 'takeover'));

    // P1's PHASEWATCH turn: the fetch shows the new holder, so the verdict is stale (and P1 may delete its trigger)
    const j = good(fetching(a, ['watch', 'check', '--phase', 'ideate', '--session', 'P1'], '05:41'));
    assert.deepEqual([j.verdict, j.code, j.triggerId], ['stale', 'displaced', 'trig_1']);
    assert.match(j.reason, /wdA\/A1 took the lease/);
    // and it cannot arm a new watch over the winner's day
    const r = fetching(a, ['watch', 'arm', '--phase', 'ideate', '--session', 'P1'], '05:42');
    assert.equal(r.code, 1);
    assert.deepEqual([r.json.leaseHeld, r.json.displaced], [false, true]);
    // retiring its own watch is still possible locally
    assert.equal(good(fetching(a, ['watch', 'disarm', '--phase', 'ideate', '--session', 'P1'], '05:43')).triggerId, 'trig_1');
  });

  test('wdB in another container never saw the watch (no push followed the arm) and still leaves a healthy 137 minute build alone; a build that outlives the configured window is taken over', () => {
    // The playbook pushes at the checkpoints, not at the arm: the pushed run file says "build since 05:11", lease heartbeat 05:10, and nothing of the
    // watch. Liveness comes from the heartbeat branch. Without the configured window (budget 150 + 10 + 15) the stuck limit would be 90.
    const a = repoSandbox();
    good(fetching(a, ['begin', '--role', 'primary', '--session', 'P1'], '03:55'));
    for (const p of ['preflight', 'ideate', 'select', 'spec']) good(fetching(a, ['phase-done', '--phase', p, '--session', 'P1', '--role', 'primary'], '05:10'));
    good(fetching(a, ['phase-start', '--phase', 'build', '--session', 'P1'], '05:11'));
    good(push(a)); // the checkpoint of spec/build-start; the arm below is NOT pushed
    good(fetching(a, ['watch', 'arm', '--phase', 'build', '--session', 'P1', '--role', 'primary', '--minutes', '150'], '05:12'));
    const hbDir = path.join(tmpDir('sed-hb-'), 'clone');
    const pulse = (t) => {
      const r = a.cli('heartbeat', ['--role', 'primary', '--session', 'P1', '--phase', 'build', '--wait', '0', '--date', DATE], { SED_NOW: iso(t), SED_HB_DIR: hbDir, SED_NO_SLEEP: '1', SED_HB_MIN_PUSH_S: '0' });
      assert.equal(r.json.ok, true, r.stdout + r.stderr);
    };
    for (const t of ['06:20', '06:45']) pulse(t);
    const b = a.cloneB('wdb');
    assert.equal(JSON.parse(remoteFile(a.remote, `state/runs/${DATE}.json`)).watch, undefined, 'the pushed run file carries no watch');
    const alive = good(fetching(b, ['begin', '--role', 'wdB', '--session', 'B1'], '06:47'));
    assert.equal(alive.action, 'exit-alive', alive.reason);
    assert.equal(alive.lease.stuckLimitMinutes, 175);
    assert.equal(alive.lease.phaseMinutes, 96);
    // the build really hangs: heartbeats go on, the phase outlives 175 minutes (05:11 + 175 = 08:06)
    pulse('08:05');
    assert.equal(good(fetching(b, ['begin', '--role', 'wdB', '--session', 'B1'], '08:05')).action, 'exit-alive', 'at the limit: not yet');
    pulse('08:08');
    const hung = good(fetching(b, ['begin', '--role', 'wdB', '--session', 'B1'], '08:08'));
    assert.equal(hung.action, 'takeover');
    assert.match(hung.reason, /phase build has run 177 min \(> 175\) although the heartbeat is fresh/);
  });

  test('revise plan --apply by a displaced session is refused like every other write', () => {
    const a = repoSandbox();
    good(fetching(a, ['begin', '--role', 'primary', '--session', 'P1'], '03:55'));
    for (const p of ['preflight', 'ideate', 'select', 'spec', 'build', 'qa']) good(fetching(a, ['phase-done', '--phase', p, '--session', 'P1', '--role', 'primary'], '04:00'));
    a.write(`work/${DATE}/qa/report.json`, { schema: 1, date: DATE, revision: 0, verdict: 'ship', counts: { S1: 0, S2: 0, S3: 1, S4: 0 }, browser: { ok: true, error: null }, defects: [{ id: 'd01', severity: 'S3', owner: 'artisan', file: 'index.html', title: 'nit', detail: 'd', evidence: 'e', suggestedFix: 'f' }] });
    good(push(a));
    const b = a.cloneB('wda');
    assert.equal(good(fetching(b, ['begin', '--role', 'wdA', '--session', 'A1'], '05:40')).action, 'takeover');
    good(push(b, 'takeover'));
    const r = fetching(a, ['revise', 'plan', '--apply', '--session', 'P1', '--role', 'primary'], '05:41');
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.deepEqual([r.json.leaseHeld, r.json.displaced], [false, true]);
    // reading the plan without --apply stays allowed for anyone
    assert.equal(fetching(a, ['revise', 'plan', '--session', 'P1', '--role', 'primary'], '05:42').code, 0);
  });

  test('a watch overdue by more than 15 minutes is visible to the next role through the pushed run file', () => {
    const a = repoSandbox();
    good(fetching(a, ['begin', '--role', 'primary', '--session', 'P1'], '03:55'));
    for (const p of ['preflight', 'ideate', 'select', 'spec']) good(fetching(a, ['phase-done', '--phase', p, '--session', 'P1', '--role', 'primary'], '04:00'));
    good(fetching(a, ['phase-start', '--phase', 'build', '--session', 'P1'], '04:30'));
    good(fetching(a, ['watch', 'arm', '--phase', 'build', '--session', 'P1', '--role', 'primary', '--minutes', '60'], '04:31')); // due 05:41
    good(fetching(a, ['beat', '--role', 'primary', '--session', 'P1', '--phase', 'build'], '05:50'));
    good(push(a)); // the checkpoint push carries the lease heartbeat and the watch
    const b = a.cloneB('wdb');
    const j = good(fetching(b, ['begin', '--role', 'wdB', '--session', 'B1'], '05:57')); // 16 minutes late, heartbeat 7 minutes old
    assert.equal(j.action, 'takeover');
    assert.match(j.reason, /phase watch for build is 16 min overdue/);
  });
});

// ---------------------------------------------------------------------------------------
// narrow machines (2 agent slots) and the 2026-10-11 run
// ---------------------------------------------------------------------------------------

describe('narrow machines: the planner\'s budgets (ideate 110, build 78 to 105), silent agents, the hard stop and the 2026-10-11 run', () => {
  const at = (t) => Date.parse(stamp(t));
  // the real config's kaizen budget (85) on top of the test budgets
  const REAL_KAIZEN = { ...CFG, phaseBudgetMinutes: { ...BUDGETS, kaizen: 85 } };
  /** pw.checkWatch in-process against the sandbox (for the displacedBy seam). */
  const direct = (box, opts) => {
    const prev = process.env.SED_ROOT;
    process.env.SED_ROOT = box.root;
    try {
      return pw.checkWatch({ date: DATE, session: 'P1', config: CFG, ...opts });
    } finally {
      if (prev === undefined) delete process.env.SED_ROOT;
      else process.env.SED_ROOT = prev;
    }
  };

  test('the heartbeat loop keeps the lease fresh past the due time of a 110-minute ideate, so osHeartbeat stays on and the Workflow keeps both slots', async () => {
    // Before: 24 beats (108 minutes) against a due time of 120 minutes gave osHeartbeat:false, and on 2 slots the Workflow's own pulse
    // then took one of the two: ideate ran on one slot.
    const box = await inPhase('ideate');
    const a = good(await arm(box, 'ideate', '04:00', ['--minutes', '110'])); // due 06:00
    assert.deepEqual([a.delayMinutes, a.dueAt, a.osHeartbeat], [120, iso('06:00'), true]);
    assert.deepEqual(pick(a.heartbeatLoop, ['iterations', 'coversMinutes', 'freshUntilMinutes', 'timeoutMs', 'coversWatch']), { iterations: 26, coversMinutes: 117, freshUntilMinutes: 138, timeoutMs: 7_200_000, coversWatch: true });
    assert.ok(a.then.some((x) => x.startsWith('start the heartbeat loop in the background now (Bash run_in_background, timeout 7200000)')));
    // what the claim rests on: the last beat that reached the branch (14 minutes before the loop's end at 117) keeps the lease fresh
    // until 10 minutes past the due time, where the PHASEWATCH turn has pushed a fresh one
    const lastPushed = { session: 'P1', at: plusMinutes(iso('04:00'), 117 - 14) };
    const run = box.run();
    assert.equal(rs.leaseInfo(CFG, run, lastPushed, at('06:10')).stale, false);
    assert.equal(rs.leaseInfo(CFG, run, lastPushed, at('06:19')).stale, true, 'past freshUntilMinutes (138) without the PHASEWATCH turn: stale, as designed');
    // the PHASEWATCH turn at the due time: the extension touches the lease (and its steps sync it), so the lease is fresh again
    good(await W(box, 'bind', ['--phase', 'ideate', '--session', 'P1', '--attempt', '1', '--trigger-id', 'trig_1'], '04:01'));
    touch(box, `work/${DATE}/ideate/cand/lab-1.json`, '05:50');
    assert.equal(good(await chk(box, 'ideate', '06:01')).action, 'extend');
    assert.equal(rs.leaseInfo(CFG, box.run(), lastPushed, at('06:30')).stale, false);
    // a narrow compact build gets 78 (a start at 06:47) to 105 minutes (06:20) since qa plans 45 (2026-10-13): 88 stands for that
    // range, and the planner's cap (110) is covered too
    for (const minutes of ['88', '110']) {
      const b = await inPhase('build');
      assert.equal(good(await arm(b, 'build', '07:00', ['--minutes', minutes])).osHeartbeat, true, minutes);
    }
    // a config without a usable leaseStaleMinutes falls back to the strict rule: the loop itself must reach the due time
    const strict = pw.heartbeatLoopFor({ phase: 'ideate', session: 'P1', role: 'primary', date: DATE, delayMinutes: 120 });
    assert.deepEqual([strict.coversWatch, strict.freshUntilMinutes], [false, 117]);
    assert.equal(pw.heartbeatLoopFor({ phase: 'ideate', session: 'P1', role: 'primary', date: DATE, delayMinutes: 117 }).coversWatch, true);
  });

  test('a builder writing one big file is silent for 25 minutes: the build is extended, not stopped and wiped', async () => {
    const { box, due } = await armed('build', { at: '07:00', extra: ['--minutes', '88'] });
    assert.equal(due, iso('08:38'));
    touch(box, `work/${DATE}/build/site/js/ui.js`, '08:14'); // the last write, 25 minutes before the check
    const j = good(await chk(box, 'build', '08:39'));
    assert.deepEqual([j.action, j.progress.minutesAgo, j.extension.windowMinutes, j.extension.dueAt], ['extend', 25, 35, iso('08:54')]);
    assert.ok(!j.steps.some((x) => /TaskStop|rm -rf/.test(x)), 'nothing stopped, nothing wiped');
    // the same silence in a phase without long single writes (select) is a stall
    const sel = await armed('select', { at: '07:00', extra: ['--minutes', '25'] }); // due 07:35
    touch(sel.box, `work/${DATE}/select/x.json`, '07:11');
    assert.equal(good(await chk(sel.box, 'select', '07:36')).action, 'retry');
  });

  test('near the hard stop a retry is not offered (it would wipe what the closer can salvage and run past 10:30); manual runs have no bound', async () => {
    const at0955 = await armed('build', { at: '08:00', extra: ['--minutes', '100'] }); // due 09:50
    const r = good(await chk(at0955.box, 'build', '09:55')); // 30 minutes before 10:25
    assert.deepEqual([r.action, r.tooLate], ['retry', undefined]);
    const at0956 = await armed('build', { at: '08:00', extra: ['--minutes', '100'] });
    const d = good(await chk(at0956.box, 'build', '09:56'));
    assert.deepEqual([d.action, d.tooLate, d.attemptsLeft, d.degrade.how, d.degrade.toTier], ['degrade', true, 1, 'tier', 3]);
    assert.ok(!d.steps.some((x) => /rm -rf|phase-start/.test(x)), 'nothing is wiped and nothing is relaunched');
    await runSteps(at0956.box, d.steps, '09:57');
    const run = at0956.box.run();
    assert.deepEqual([run.targetTier, run.attempts.build, run.watch.disarmedAt], [3, 1, iso('09:57')]);
    assert.ok(run.events.some((e) => e.kind === 'degrade' && /build stalled 29 min before the hard stop 10:30 \(phase watch\): tier 3/.test(e.msg)));
    // qa near the hard stop skips QA (validator and smoke run only) instead of starting it again
    const qa = await armed('qa', { at: '09:00', extra: ['--minutes', '45'] }); // due 09:55
    const q = good(await chk(qa.box, 'qa', '10:00'));
    assert.deepEqual([q.action, q.degrade.skip], ['degrade', ['qa', 'revise']]);
    // a manual run is bound by nothing: the retry stands
    const manual = sandbox(CFG);
    good(await ST(manual, ['begin', '--role', 'manual', '--session', 'P1'], '03:55'));
    good(await ST(manual, ['phase-start', '--phase', 'preflight', '--session', 'P1'], '10:00'));
    good(await W(manual, 'arm', ['--phase', 'preflight', '--session', 'P1', '--role', 'manual', '--minutes', '10'], '10:00')); // due 10:20
    assert.equal(good(await chk(manual, 'preflight', '10:21', ['--role', 'manual'])).action, 'retry');
    // the kaizen round is bound by the 12:00 cutoff the same way: a second round that cannot fit is closed on purpose
    const kz = await kaizenRun();
    good(await arm(kz, 'kaizen', '10:00', ['--minutes', '20'])); // due 10:45
    assert.equal(good(await chk(kz, 'kaizen', '11:25')).action, 'retry', '30 minutes before 11:55');
    const kz2 = await kaizenRun();
    good(await arm(kz2, 'kaizen', '10:00', ['--minutes', '20']));
    const k = good(await chk(kz2, 'kaizen', '11:26'));
    assert.deepEqual([k.action, k.tooLate, k.degrade.skip], ['degrade', true, ['kaizen']]);
    assert.match(k.reason, /before the 12:00 kaizen cutoff/);
    // planOverdue (pure) without a bound is unchanged
    const w = { phase: 'build', attempt: 1, dueAt: iso('09:50'), workflowTask: null };
    const facts = { doneMarker: false, outputs: { required: [], present: [], missing: [] } };
    const plain = { run: { attempts: { build: 1 }, targetTier: 1, phasesDone: [] }, config: CFG, watch: w, facts, date: DATE, session: 'P1', overdueMinutes: 6 };
    assert.equal(pw.planOverdue(plain).next, 'retry');
    assert.equal(pw.planOverdue({ ...plain, roomMinutes: 29.9 }).next, 'degrade');
    assert.equal(pw.planOverdue({ ...plain, roomMinutes: 30 }).next, 'retry');
  });

  test('a stale timer says what the PLAYBOOK stale row says: a replaced session stops its zombie Workflow, a restarted phase is armed', async () => {
    const taken = await armed();
    good(await ST(taken.box, ['begin', '--role', 'wdA', '--session', 'A1'], '05:40'));
    const t = good(await chk(taken.box, 'ideate', '05:45'));
    assert.deepEqual([t.code, t.action], ['lease-held-by-other', 'stop-zombie']);
    assert.match(t.instructions, /^You were replaced \(PLAYBOOK 6\.6\): TaskStop your ideate Workflow \(TaskStop\(\{ task_id: "wf-1" \}\)\): it is a zombie now/);
    assert.match(t.instructions, /do NOT delete it/);
    // displaced (another container took the lease): the same
    const disp = await armed();
    const j = direct(disp.box, { phase: 'ideate', now: iso('05:45'), displacedBy: { holder: 'wdB', session: 'B1' } });
    assert.deepEqual([j.code, j.action], ['displaced', 'stop-zombie']);
    assert.match(j.instructions, /TaskStop\(\{ task_id: "wf-1" \}\)/);
    // the kaizen binds no task: its zombie is found by the id the operator kept outside the repo
    const kz = await kaizenRun();
    good(await arm(kz, 'kaizen', '08:40'));
    const kj = direct(kz, { phase: 'kaizen', now: iso('09:00'), displacedBy: { holder: 'manual', session: 'M1' } });
    assert.deepEqual([kj.code, kj.action], ['displaced', 'stop-zombie']);
    assert.match(kj.instructions, /\$HOME\/\.sed-wf-2026-10-09-kaizen/);
    // restarted: the phase was started again after the watch fired, without a new arm
    const re = await armed('build');
    good(await chk(re.box, 'build', '06:41')); // retry decided
    good(await ST(re.box, ['phase-start', '--phase', 'build', '--session', 'P1'], '06:45'));
    const r = good(await chk(re.box, 'build', '06:50'));
    assert.deepEqual([r.code, r.action], ['restarted', 'arm']);
    assert.match(r.instructions, /arm one \(PLAYBOOK 7\.1a steps 3 to 6/);
    // expired: begin decides; the ordinary codes leave nothing to do
    const old = await armed();
    const e = good(await chk(old.box, 'ideate', '08:00'));
    assert.deepEqual([e.code, e.action], ['expired', 'nothing']);
    assert.match(e.instructions, /the next `begin` decides/);
    const done = await armed();
    good(await ST(done.box, ['phase-done', '--phase', 'ideate', '--session', 'P1', '--role', 'primary'], '05:30'));
    const p = good(await chk(done.box, 'ideate', '05:45'));
    assert.deepEqual([p.code, p.action], ['phase-done', 'nothing']);
    assert.match(p.instructions, /^Nothing else to do\./);
  });

  test('disarm with a task id that differs from the bound one: refused while the phase runs, accepted once its DONE.json is on disk', async () => {
    const { box } = await armed('build'); // wf-1 bound
    const before = bytes(box);
    const refused = good(await W(box, 'disarm', ['--phase', 'build', '--session', 'P1', '--workflow-task', 'wf-9'], '05:00'));
    assert.deepEqual([refused.disarmed, refused.reason], [false, 'other-task']);
    assert.match(refused.note, /Touch nothing; the watch stays armed\. Only if this notification is the build Workflow's own result \(it reports phase "build"\) was the id bound at launch wrong: then run node scripts\/state\.mjs watch bind --phase build --session P1 --date 2026-10-09 --attempt 1 --workflow-task wf-9 and this disarm again\.$/);
    assert.deepEqual(bytes(box), before, 'nothing written');
    // the Workflow wrote its DONE.json (the last thing it does): the notification is the phase's own, whatever id was bound
    touch(box, `work/${DATE}/build/DONE.json`, '05:10', '{"ok":true,"phase":"build"}');
    const j = good(await W(box, 'disarm', ['--phase', 'build', '--session', 'P1', '--workflow-task', 'wf-9'], '05:11'));
    assert.deepEqual(pick(j, ['disarmed', 'taskMismatch', 'deleteTrigger']), { disarmed: true, taskMismatch: { bound: 'wf-1', notified: 'wf-9' }, deleteTrigger: { trigger_id: 'trig_1' } });
    assert.match(j.note, /DONE\.json is on disk, so the build Workflow finished and this is its result/);
    assert.equal(box.run().watch.disarmedAt, iso('05:11'));
    // the echo of a stopped task stays an echo, DONE.json or not
    const echo = await armed('build');
    good(await chk(echo.box, 'build', '06:41')); // retry: wf-1 is stopped
    touch(echo.box, `work/${DATE}/build/DONE.json`, '06:42', '{"ok":true}');
    assert.equal(good(await W(echo.box, 'disarm', ['--phase', 'build', '--session', 'P1', '--workflow-task', 'wf-1'], '06:43')).reason, 'echo');
  });

  test('the replaced timer: the then-steps carry the update_trigger fallback of PLAYBOOK 7.1a step 4', async () => {
    const { box } = await armed('ideate');
    const again = good(await arm(box, 'ideate', '04:05'));
    assert.equal(again.then[0], 'first delete_trigger({ trigger_id: "trig_1" }): it is the pending timer of the ideate watch this arm replaced. Denied: update_trigger({ trigger_id: "trig_1", enabled: false }) instead (never retry a denied call as written); denied too: leave it, it fires into a stale `watch check` (FM-120)');
  });

  test('the kaizen watch: the configured 85-minute budget plus one member\'s turn and the margin; the lease rule widens the same way', async () => {
    const box = await kaizenRun(REAL_KAIZEN);
    const a = good(await arm(box, 'kaizen', '09:11')); // no --minutes: config.phaseBudgetMinutes.kaizen, the number the Workflow gets
    assert.deepEqual(pick(a, ['budgetMinutes', 'budgetSource', 'marginMinutes', 'delayMinutes', 'dueAt', 'osHeartbeat']), { budgetMinutes: 85, budgetSource: 'config', marginMinutes: 25, delayMinutes: 110, dueAt: iso('11:01'), osHeartbeat: true });
    assert.match(box.run().events.at(-1).msg, /\(110 min: budget 85 \+ 25 margin\)$/);
    // a healthy round of 100 minutes (day 1 ran 82 against 75; the last member may start 15 minutes before the budget ends) is no stall
    assert.equal(good(await chk(box, 'kaizen', '10:51')).verdict, 'early');
    // the lease rule of another container that cannot see the watch: budget + 25 + 15
    const blind = { ...box.run(), watch: undefined };
    assert.equal(rs.leaseInfo(REAL_KAIZEN, blind, { session: 'P1', at: iso('10:55') }, at('11:00')).stuckLimitMinutes, 125);
  });

  test('a DONE.json written long before the timer means the notification is lost: finish from the files now; a fresh one gets a follow-up check, not a wait for ever', async () => {
    // fresh (2 minutes old): the notification is probably queued behind this turn; a follow-up timer catches a lost one
    const { box } = await armed('build'); // due 06:40
    touch(box, `work/${DATE}/build/DONE.json`, '06:39', '{"ok":true}');
    const j = good(await chk(box, 'build', '06:41'));
    assert.deepEqual(pick(j, ['action', 'doneAgeMinutes', 'notificationLost']), { action: 'nothing', doneAgeMinutes: 2, notificationLost: false });
    assert.deepEqual(j.followUp, { ...pw.sendLaterFor({ date: DATE, phase: 'build', attempt: 1, session: 'P1', dueAt: iso('06:51'), root: box.root }), name: `sed-watch-${DATE}-build-a1-followup` });
    assert.match(j.steps.at(-1), /call send_later with followUp\.at, followUp\.name and followUp\.message \(one more check in 10 minutes; bind nothing\), then end the turn/);
    // the follow-up fires and the watch is still armed: the notification is lost, the files are the truth (nothing more is written)
    const before = bytes(box);
    const k = good(await chk(box, 'build', '06:51', ['--attempt', '1']));
    assert.deepEqual(pick(k, ['action', 'doneAgeMinutes', 'notificationLost', 'followUp']), { action: 'nothing', doneAgeMinutes: 12, notificationLost: true, followUp: undefined });
    assert.match(k.steps[0], /written 12 min ago .* it is lost\. Do not wait for it\./);
    assert.equal(k.steps[1], `run: node scripts/state.mjs watch disarm --phase build --session P1 --date ${DATE}   (the timer that woke you has fired and is spent: delete nothing)`);
    assert.deepEqual(bytes(box), before);
    await runSteps(box, k.steps, '06:52');
    assert.equal(box.run().watch.disarmedAt, iso('06:52'));
    // handled in between: the follow-up finds the watch disarmed (stale)
    const handled = await armed('build');
    touch(handled.box, `work/${DATE}/build/DONE.json`, '06:39', '{"ok":true}');
    good(await chk(handled.box, 'build', '06:41'));
    good(await W(handled.box, 'disarm', ['--phase', 'build', '--session', 'P1', '--workflow-task', 'wf-1'], '06:42'));
    assert.equal(good(await chk(handled.box, 'build', '06:51', ['--attempt', '1'])).code, 'disarmed');
  });

  test('2026-10-11 replay: qa extended once, its timer\'s delete denied, the leftover timer fires during the kaizen round and finds stale without writing', async () => {
    const box = await inPhase('qa', { config: REAL_KAIZEN, at: '08:28' });
    const a = good(await arm(box, 'qa', '2026-10-09T12:28:09.542Z', ['--minutes', '20']));
    assert.equal(a.dueAt, '2026-10-09T12:58:09.542Z');
    good(await W(box, 'bind', ['--phase', 'qa', '--session', 'P1', '--attempt', '1', '--trigger-id', 'trig_qa1', '--workflow-task', 'wf-qa'], '08:29'));
    touch(box, `work/${DATE}/qa/run/report.json`, '2026-10-09T12:58:55.000Z');
    const ext = good(await chk(box, 'qa', '2026-10-09T13:00:13.991Z'));
    assert.deepEqual([ext.action, ext.extension.dueAt, ext.sendLater.at], ['extend', '2026-10-09T13:15:13.991Z', '2026-10-09T13:16:00Z']);
    good(await W(box, 'bind', ['--phase', 'qa', '--session', 'P1', '--attempt', '1', '--trigger-id', 'trig_qa2'], '09:01'));
    // the notification: disarm prints the pending extension timer, with the fallback for a denied delete
    const dis = good(await W(box, 'disarm', ['--phase', 'qa', '--session', 'P1', '--workflow-task', 'wf-qa'], '09:08'));
    assert.deepEqual([dis.disarmed, dis.deleteTrigger, typeof dis.ifDeleteDenied], [true, { trigger_id: 'trig_qa2' }, 'string']);
    // (delete_trigger denied, update_trigger not tried): the timer stays pending. The day moves on to the kaizen round.
    for (const p of ['qa', 'revise', 'package']) good(await ST(box, ['phase-done', '--phase', p, '--session', 'P1', '--role', 'primary'], '09:09'));
    seedPage(box, 2);
    good(await ST(box, ['finish', '--status', 'published', '--tier', '2', '--by', 'primary'], '09:11'));
    good(await ST(box, ['phase-start', '--phase', 'kaizen', '--session', 'P1'], '09:11'));
    const k = good(await arm(box, 'kaizen', '09:11'));
    assert.equal(k.replaced, null, 'the qa watch was disarmed: nothing of it is handed back');
    const before = bytes(box);
    const j = good(await chk(box, 'qa', '2026-10-09T13:16:00.000Z', ['--attempt', '1']));
    assert.deepEqual(pick(j, ['verdict', 'code', 'action', 'triggerId', 'deleteTrigger']), { verdict: 'stale', code: 'other-phase', action: 'nothing', triggerId: null, deleteTrigger: null });
    assert.match(j.instructions, /^Nothing else to do\. The timer that woke you has fired and is spent: do NOT delete it/);
    assert.deepEqual(bytes(box), before, 'the kaizen round\'s tree stays clean: a stale timer writes nothing');
  });
});
