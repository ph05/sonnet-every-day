// Tests for scripts/heartbeat.mjs: the out-of-process liveness beat that works in its own cached clone.
import './helpers/env.mjs';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { etIso, tmpDir } from './helpers/env.mjs';
import { DATE, makeRepoSandbox, makeSandbox } from './helpers/sandbox.mjs';
import { BRANCH, git, gitTry, installPushHook, pushCount, remoteFile, remoteHas, remoteSha } from './helpers/git.mjs';
import { MAX_WAIT_SECONDS, clampWait, defaultCloneDir, heartbeat } from '../scripts/heartbeat.mjs';

const iso = (hhmm, date = DATE) => etIso(date, hhmm);
const boxes = [];
test.after(() => boxes.forEach((b) => b.cleanup()));

function fixture() {
  const box = makeRepoSandbox();
  boxes.push(box);
  const hbDir = path.join(tmpDir('sed-hb-'), 'clone');
  // push throttling is tested on its own; the other tests want every beat on the remote
  const env = { SED_HB_DIR: hbDir, SED_NO_SLEEP: '1', SED_HB_MIN_PUSH_S: '0' };
  const beat = (args, extraEnv = {}) =>
    box.cli('heartbeat', ['--role', 'primary', '--session', 's1', '--phase', 'ideate', '--wait', '0', ...args], { ...env, ...extraEnv });
  return { box, hbDir, env, beat };
}
const hbRecord = (box, date = DATE, session = 's1') => JSON.parse(remoteFile(box.remote, `state/heartbeats/${date}/${session}.json`));

describe('heartbeat: recording liveness', () => {
  test('writes state/heartbeats/<date>/<session>.json to the remote branch with exactly {holder, session, phase, at, note}', () => {
    const { box, beat, hbDir } = fixture();
    const before = box.git('rev-parse', 'HEAD');
    const r = beat(['--note', 'scouts running', '--now', iso('04:10')]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.deepEqual({ ok: r.json.ok, pushed: r.json.pushed, at: r.json.at, date: r.json.date }, { ok: true, pushed: true, at: iso('04:10'), date: DATE });
    assert.deepEqual(hbRecord(box), { holder: 'primary', session: 's1', phase: 'ideate', at: iso('04:10'), note: 'scouts running' });
    assert.equal(git(box.remote, 'log', '-1', '--format=%s', `refs/heads/${BRANCH}`), `heartbeat ${DATE} primary ideate`);
    assert.equal(git(box.remote, 'show', '--stat', '--format=', `refs/heads/${BRANCH}`).split('\n').filter((l) => l.includes('|')).length, 1);
    assert.ok(fs.existsSync(path.join(hbDir, '.git')));
    // the orchestrator's own working tree is never touched
    assert.equal(box.git('rev-parse', 'HEAD'), before);
    assert.equal(box.git('status', '--porcelain'), '');
    assert.equal(box.exists(`state/heartbeats/${DATE}/s1.json`), false);
  });

  test('every beat of a session updates the same file; the cached clone is reused (fetch + reset, no re-clone)', () => {
    const { box, beat, hbDir } = fixture();
    assert.equal(beat(['--now', iso('04:10')]).json.pushed, true);
    fs.writeFileSync(path.join(hbDir, '.git', 'cache-marker'), 'still here');
    fs.writeFileSync(path.join(hbDir, 'junk-from-a-crash.txt'), 'x'); // leftovers from a killed run are swept
    const second = beat(['--phase', 'build', '--now', iso('04:15')]);
    assert.equal(second.json.pushed, true);
    assert.equal(fs.readFileSync(path.join(hbDir, '.git', 'cache-marker'), 'utf8'), 'still here');
    assert.equal(fs.existsSync(path.join(hbDir, 'junk-from-a-crash.txt')), false);
    assert.equal(hbRecord(box).at, iso('04:15'));
    assert.equal(hbRecord(box).phase, 'build'); // a later --phase overrides the fixture's default
  });

  test('a new holder writes its OWN file: the old session\'s record is never overwritten (single writer per file)', () => {
    const { box, env } = fixture();
    box.cli('heartbeat', ['--role', 'primary', '--session', 's1', '--phase', 'build', '--wait', '0', '--now', iso('05:00')], env);
    const r = box.cli('heartbeat', ['--role', 'wdA', '--session', 'w9', '--phase', 'ideate', '--wait', '0', '--now', iso('05:40')], env);
    assert.equal(r.json.pushed, true);
    assert.deepEqual(hbRecord(box, DATE, 'w9'), { holder: 'wdA', session: 'w9', phase: 'ideate', at: iso('05:40'), note: '' });
    assert.deepEqual(hbRecord(box, DATE, 's1'), { holder: 'primary', session: 's1', phase: 'build', at: iso('05:00'), note: '' });
    // the zombie pulses again: the replacement's file is untouched
    box.cli('heartbeat', ['--role', 'primary', '--session', 's1', '--phase', 'build', '--wait', '0', '--now', iso('05:45')], env);
    assert.equal(hbRecord(box, DATE, 'w9').at, iso('05:40'));
    assert.equal(hbRecord(box, DATE, 's1').at, iso('05:45'));
  });

  test('session ids that are not filesystem-safe get a safe, unique file name', () => {
    const { box, env } = fixture();
    const r = box.cli('heartbeat', ['--role', 'primary', '--session', '../evil/../x y', '--phase', 'build', '--wait', '0', '--now', iso('05:00')], env);
    assert.equal(r.json.pushed, true, r.stdout + r.stderr);
    const files = git(box.remote, 'ls-tree', '-r', '--name-only', `refs/heads/${BRANCH}`).split('\n').filter((f) => f.startsWith('state/heartbeats/'));
    assert.equal(files.length, 1);
    assert.match(files[0], /^state\/heartbeats\/2026-10-09\/[A-Za-z0-9._-]+\.json$/);
    assert.ok(!files[0].includes('..'));
  });

  test('the date is the LOCAL date (America/New_York), not the UTC date; --date overrides', () => {
    const { box, beat } = fixture();
    const late = beat(['--now', '2026-11-02T03:30:00Z']); // 22:30 on Nov 1 in New York
    assert.equal(late.json.date, '2026-11-01');
    assert.ok(remoteFile(box.remote, 'state/heartbeats/2026-11-01/s1.json'));
    const forced = beat(['--now', iso('04:00'), '--date', '2026-10-31']);
    assert.equal(forced.json.date, '2026-10-31');
    assert.ok(remoteFile(box.remote, 'state/heartbeats/2026-10-31/s1.json'));
  });

  test('--no-push commits in the cache only and reports it', () => {
    const { box, beat, hbDir } = fixture();
    const before = remoteSha(box.remote);
    const r = beat(['--no-push', '--now', iso('04:10')]);
    assert.equal(r.code, 0);
    assert.deepEqual({ ok: r.json.ok, pushed: r.json.pushed, reason: r.json.reason }, { ok: true, pushed: false, reason: 'no-push' });
    assert.equal(remoteSha(box.remote), before);
    assert.match(git(hbDir, 'log', '-1', '--format=%s'), /^heartbeat /);
  });

  test('never takes the repo lockfile: a held state/runs/.<date>.lock does not slow it down', () => {
    const { box, beat } = fixture();
    box.write(`state/runs/.${DATE}.lock`, JSON.stringify({ pid: process.pid, token: 'orchestrator', at: new Date().toISOString() }));
    const t0 = Date.now();
    const r = beat(['--now', iso('04:10')]);
    assert.equal(r.json.pushed, true);
    assert.ok(Date.now() - t0 < 20_000);
    assert.equal(JSON.parse(box.read(`state/runs/.${DATE}.lock`)).token, 'orchestrator');
  });

  describe('visibility to `begin`', () => {
    // primary leased at 03:55, last stamped its lease at 05:00, then went silent
    function silentPrimary() {
      const f = fixture();
      const begin = (role, session, hhmm) => f.box.state(['begin', '--role', role, '--session', session, '--now', iso(hhmm)]);
      begin('primary', 's1', '03:55');
      f.box.state(['phase-done', '--phase', 'preflight', '--session', 's1', '--now', iso('05:00')]);
      return { ...f, begin };
    }
    test('without beats, 40 minutes of silence means takeover', () => {
      const { begin } = silentPrimary();
      assert.equal(begin('wdA', 'w1', '05:40').json.action, 'takeover');
    });
    test('a zombie old session and its replacement pulse alternately: the replacement is judged by ITS OWN pulses', () => {
      const { box, env, begin } = silentPrimary();
      const pulse = (role, session, hhmm) =>
        box.cli('heartbeat', ['--role', role, '--session', session, '--phase', 'ideate', '--wait', '0', '--now', iso(hhmm)], env);
      assert.equal(begin('wdA', 'a1', '05:40').json.action, 'takeover'); // the primary's lease last beat at 05:00
      for (const [a, z] of [['05:41', '05:42'], ['05:46', '05:47'], ['06:11', '06:12'], ['06:36', '06:37'], ['06:43', '06:44']]) {
        assert.equal(pulse('wdA', 'a1', a).json.pushed, true);
        assert.equal(pulse('primary', 's1', z).json.pushed, true);
      }
      box.git('pull', '-q', '--rebase', 'origin', BRANCH);
      const j = begin('wdB', 'b1', '06:47');
      assert.equal(j.json.action, 'exit-alive', j.stdout);
      assert.equal(j.json.lease.holder, 'wdA');
      assert.equal(j.json.lease.source, 'heartbeat-file');
    });
    test('with beats pulled into the working tree, the same silence keeps the primary alive', () => {
      const { box, beat, begin } = silentPrimary();
      assert.equal(beat(['--now', iso('05:35')]).json.pushed, true);
      box.git('pull', '-q', '--rebase', 'origin', BRANCH);
      const alive = begin('wdA', 'w1', '05:40');
      assert.equal(alive.json.action, 'exit-alive');
      assert.equal(alive.json.lease.source, 'heartbeat-file');
    });
  });
});

describe('heartbeat: cost on the work branch (which also serves GitHub Pages)', () => {
  test('the cached clone is partial and sparse: only state/heartbeats is checked out, however big the rest grows', () => {
    const { box, beat, hbDir } = fixture();
    box.write('docs/d/2026-10-01-big/index.html', 'x'.repeat(5000));
    box.write('work/2026-10-09/build/site/app.js', 'y'.repeat(5000));
    box.git('add', '-A');
    box.git('commit', '-q', '-m', 'lots of pages');
    box.git('push', '-q', 'origin', BRANCH);
    assert.equal(beat(['--now', iso('04:10')]).json.pushed, true);
    assert.ok(fs.existsSync(path.join(hbDir, 'state', 'heartbeats', DATE, 's1.json')));
    assert.equal(fs.existsSync(path.join(hbDir, 'docs')), false);
    assert.equal(fs.existsSync(path.join(hbDir, 'work')), false);
    assert.match(git(hbDir, 'sparse-checkout', 'list'), /state\/heartbeats/);
    // and a second beat (fetch + reset) keeps it that way
    assert.equal(beat(['--now', iso('04:20')]).json.pushed, true);
    assert.equal(fs.existsSync(path.join(hbDir, 'docs')), false);
  });

  test('a beat that only advances the timestamp is pushed at most every 10 minutes (default); a phase change is pushed at once', () => {
    const { box, beat } = fixture();
    const slow = { SED_HB_MIN_PUSH_S: '' };
    assert.equal(beat(['--now', iso('04:10')], slow).json.pushed, true);
    const before = remoteSha(box.remote);
    const skipped = beat(['--now', iso('04:15')], slow);
    assert.deepEqual({ ok: skipped.json.ok, pushed: skipped.json.pushed, reason: skipped.json.reason }, { ok: true, pushed: false, reason: 'throttled' });
    assert.equal(remoteSha(box.remote), before);
    assert.equal(hbRecord(box).at, iso('04:10'));
    const phase = beat(['--phase', 'build', '--now', iso('04:16')], slow);
    assert.equal(phase.json.pushed, true);
    assert.equal(hbRecord(box).phase, 'build');
    assert.equal(beat(['--phase', 'build', '--now', iso('04:25')], slow).json.pushed, false);
    assert.equal(beat(['--phase', 'build', '--now', iso('04:27')], slow).json.pushed, true);
    assert.equal(hbRecord(box).at, iso('04:27'));
  });

  test('throttling is per session: a replacement session is never held back by the old one\'s recent beat', () => {
    const { box, env } = fixture();
    const slow = { ...env, SED_HB_MIN_PUSH_S: '' };
    const pulse = (session, hhmm) => box.cli('heartbeat', ['--role', 'primary', '--session', session, '--phase', 'build', '--wait', '0', '--now', iso(hhmm)], slow);
    assert.equal(pulse('s1', '04:10').json.pushed, true);
    assert.equal(pulse('s2', '04:11').json.pushed, true);
  });

  test('SED_HB_MIN_PUSH_S=0 and --min-push-seconds 0 turn the throttle off', () => {
    const { beat } = fixture();
    assert.equal(beat(['--now', iso('04:10')]).json.pushed, true);
    assert.equal(beat(['--now', iso('04:11')]).json.pushed, true);
    assert.equal(beat(['--now', iso('04:12')], { SED_HB_MIN_PUSH_S: '' }).json.pushed, false);
    assert.equal(beat(['--now', iso('04:13'), '--min-push-seconds', '0'], { SED_HB_MIN_PUSH_S: '' }).json.pushed, true);
  });
});

describe('heartbeat: waiting', () => {
  test('clampWait bounds the wait to 0..540 seconds', () => {
    assert.equal(MAX_WAIT_SECONDS, 540);
    assert.equal(clampWait(300), 300);
    assert.equal(clampWait('45'), 45);
    assert.equal(clampWait(9999), 540);
    assert.equal(clampWait(540), 540);
    for (const bad of [-5, 'abc', NaN, undefined, null]) assert.equal(clampWait(bad), 0, String(bad));
    assert.equal(clampWait(Infinity), 540);
  });

  test('heartbeat() sleeps the clamped wait BEFORE taking the instant, then beats', async () => {
    const { box, hbDir } = fixture();
    const prev = process.env.SED_ROOT;
    process.env.SED_ROOT = box.root;
    try {
      const slept = [];
      const run = (wait) => heartbeat({ role: 'primary', session: 's1', phase: 'ideate', wait, cloneDir: hbDir, sleep: async (ms) => slept.push(ms) });
      const r1 = await run(300);
      assert.equal(r1.ok, true);
      assert.deepEqual(slept, [300_000]);
      const t = Date.parse(r1.at);
      assert.ok(Math.abs(t - Date.now()) < 60_000, 'the recorded instant is "now", after the wait');
      slept.length = 0;
      await run(9999);
      assert.deepEqual(slept, [540_000]);
      slept.length = 0;
      await run(0);
      await run(undefined);
      assert.deepEqual(slept, []);
    } finally {
      if (prev === undefined) delete process.env.SED_ROOT;
      else process.env.SED_ROOT = prev;
    }
  });

  test('the CLI really waits in the foreground (--wait 0.5)', () => {
    const { box, env } = fixture();
    const t0 = Date.now();
    const r = box.cli('heartbeat', ['--role', 'primary', '--session', 's1', '--phase', 'qa', '--wait', '0.5'], env);
    const elapsed = Date.now() - t0;
    assert.equal(r.json.pushed, true);
    assert.ok(elapsed >= 500, `elapsed ${elapsed}ms`);
    assert.ok(Date.parse(r.json.at) >= t0 + 450, 'at is stamped after the wait');
  });
});

describe('heartbeat: concurrent writers and flaky remotes', () => {
  test('a push lost to a concurrent writer is retried on top of the new remote state', () => {
    const { box, beat } = fixture();
    installPushHook(box.remote, { sneakFirst: true });
    const r = beat(['--now', iso('04:10')]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.json.pushed, true);
    assert.equal(pushCount(box.remote), 2);
    assert.equal(hbRecord(box).at, iso('04:10'));
    assert.equal(remoteFile(box.remote, 'sneaky.txt'), 'sneaky'); // the other writer's commit survived
    assert.equal(git(box.remote, 'log', '--merges', '--oneline', `refs/heads/${BRANCH}`), '');
  });

  test('a remote that keeps refusing gives ok:false after 5 attempts, never throws, never forces', () => {
    const { box, beat } = fixture();
    const before = remoteSha(box.remote);
    installPushHook(box.remote, { always: true });
    const r = beat(['--now', iso('04:10')]);
    assert.equal(r.code, 1);
    assert.deepEqual({ ok: r.json.ok, pushed: r.json.pushed }, { ok: false, pushed: false });
    assert.match(r.json.reason, /push failed/);
    assert.equal(pushCount(box.remote), 5);
    assert.equal(remoteSha(box.remote), before);
  });

  test('two heartbeats racing on the same cache both succeed (the clone is serialized)', async () => {
    const { box, env } = fixture();
    const args = (session) => ['--role', 'primary', '--session', session, '--phase', 'build', '--wait', '0'];
    const [a, b] = await Promise.all([box.cliAsync('heartbeat', args('s1'), env), box.cliAsync('heartbeat', args('s2'), env)]);
    assert.equal(a.code, 0, a.stdout + a.stderr);
    assert.equal(b.code, 0, b.stdout + b.stderr);
    assert.equal(hbRecord(box, DATE, 's1').session, 's1');
    assert.equal(hbRecord(box, DATE, 's2').session, 's2');
  });

  test('a lock left by a crashed beat does not block forever', () => {
    const { box, beat, hbDir } = fixture();
    fs.mkdirSync(path.dirname(hbDir), { recursive: true });
    const lock = `${hbDir}.lock`;
    fs.writeFileSync(lock, JSON.stringify({ pid: 99999999, token: 'dead', at: 'then' }));
    const old = new Date(Date.now() - 20 * 60_000);
    fs.utimesSync(lock, old, old);
    const r = beat(['--now', iso('04:10')]);
    assert.equal(r.json.pushed, true);
    assert.ok(remoteHas(box.remote));
  });

  test('a damaged cache is rebuilt from the remote', () => {
    const { box, beat, hbDir } = fixture();
    assert.equal(beat(['--now', iso('04:10')]).json.pushed, true);
    fs.rmSync(path.join(hbDir, '.git', 'HEAD'));
    fs.rmSync(path.join(hbDir, '.git', 'refs'), { recursive: true });
    const r = beat(['--now', iso('04:20')]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.json.pushed, true);
    assert.equal(hbRecord(box).at, iso('04:20'));
  });

  test('when the origin URL changes the cache follows it', () => {
    const { box, beat } = fixture();
    assert.equal(beat(['--now', iso('04:10')]).json.pushed, true);
    const moved = path.join(path.dirname(box.remote), 'moved.git');
    fs.cpSync(box.remote, moved, { recursive: true });
    box.git('remote', 'set-url', 'origin', moved);
    const r = beat(['--now', iso('04:20')]);
    assert.equal(r.json.pushed, true);
    assert.equal(JSON.parse(git(moved, 'show', `refs/heads/${BRANCH}:state/heartbeats/${DATE}/s1.json`)).at, iso('04:20'));
    assert.equal(hbRecord(box).at, iso('04:10'));
  });
});

describe('heartbeat: failures never throw', () => {
  test('unreachable origin => ok:false with a reason and exit 1', () => {
    const { box, beat } = fixture();
    box.git('remote', 'set-url', 'origin', path.join(box.base, 'nowhere.git'));
    const r = beat(['--now', iso('04:10')]);
    assert.equal(r.code, 1);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.pushed, false);
    assert.match(r.json.reason, /clone failed|unreachable/);
  });

  test('a remote without the work branch is reported, and the branch is NOT created by a heartbeat', () => {
    const box = makeRepoSandbox({ workBranch: false });
    boxes.push(box);
    const env = { SED_HB_DIR: path.join(tmpDir('sed-hb-'), 'clone') };
    const r = box.cli('heartbeat', ['--role', 'primary', '--session', 's1', '--phase', 'ideate', '--wait', '0'], env);
    assert.equal(r.code, 1);
    assert.match(r.json.reason, /does not exist/);
    assert.equal(remoteHas(box.remote), false);
  });

  test('a repo without an origin remote', () => {
    const { box, beat } = fixture();
    box.git('remote', 'remove', 'origin');
    const r = beat([]);
    assert.equal(r.code, 1);
    assert.match(r.json.reason, /no origin/);
  });

  test('not a git checkout at all', () => {
    const plain = makeSandbox();
    boxes.push(plain);
    const r = plain.cli('heartbeat', ['--role', 'primary', '--session', 's1', '--wait', '0'], { SED_HB_DIR: path.join(tmpDir('sed-hb-'), 'clone') });
    assert.equal(r.code, 1);
    assert.equal(r.json.ok, false);
  });

  test('a missing config.json is a result, not a crash', () => {
    const plain = makeSandbox();
    boxes.push(plain);
    fs.rmSync(plain.path('config.json'));
    const r = plain.cli('heartbeat', ['--role', 'primary', '--session', 's1', '--wait', '0'], { SED_HB_DIR: path.join(tmpDir('sed-hb-'), 'clone') });
    assert.equal(r.code, 1);
    assert.match(r.json.reason, /unexpected/);
  });
});

describe('heartbeat: usage', () => {
  test('bad arguments exit 2 with one JSON document', () => {
    const { box } = fixture();
    const cases = [
      ['--session', 's1'],
      ['--role', 'primary'],
      ['--role', 'overlord', '--session', 's1'],
      ['--role', 'primary', '--session', 's1', '--phase', 'dessert'],
      ['--role', 'primary', '--session', 's1', '--date', 'yesterday'],
    ];
    for (const args of cases) {
      const r = box.cli('heartbeat', ['--wait', '0', ...args], {});
      assert.equal(r.code, 2, args.join(' '));
      assert.equal(r.json.ok, false);
    }
  });

  test('the default clone dir is <tmp>/sed-hb-clone unless SED_HB_DIR says otherwise', () => {
    const saved = process.env.SED_HB_DIR;
    try {
      delete process.env.SED_HB_DIR;
      assert.equal(defaultCloneDir(), path.join(os.tmpdir(), 'sed-hb-clone'));
      process.env.SED_HB_DIR = '/tmp/elsewhere';
      assert.equal(defaultCloneDir(), '/tmp/elsewhere');
    } finally {
      if (saved === undefined) delete process.env.SED_HB_DIR;
      else process.env.SED_HB_DIR = saved;
    }
  });

  test('phase is optional (recorded as null)', () => {
    const { box, env } = fixture();
    const r = box.cli('heartbeat', ['--role', 'closer', '--session', 'c1', '--wait', '0', '--now', iso('07:30')], env);
    assert.equal(r.json.pushed, true);
    assert.equal(hbRecord(box, DATE, 'c1').phase, null);
    assert.equal(gitTry(box.remote, 'rev-parse', `refs/heads/${BRANCH}`).ok, true);
  });
});
