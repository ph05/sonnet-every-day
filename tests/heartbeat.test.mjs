// Tests for scripts/heartbeat.mjs: the out-of-process liveness beat that works in its own cached clone and
// pushes to config.heartbeatBranch (CONTRACT 14), never to the work branch.
import './helpers/env.mjs';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { etIso, tmpDir } from './helpers/env.mjs';
import { DATE, TEST_CONFIG, makeRepoSandbox, makeSandbox } from './helpers/sandbox.mjs';
import { BRANCH, cloneOf, git, gitTry, installPushHook, pushCount, remoteFile, remoteHas, remoteSha } from './helpers/git.mjs';
import { MAX_WAIT_SECONDS, RETAIN_DAYS, clampWait, defaultCloneDir, heartbeat } from '../scripts/heartbeat.mjs';

const HB = TEST_CONFIG.heartbeatBranch;
const iso = (hhmm, date = DATE) => etIso(date, hhmm);
const boxes = [];
test.after(() => boxes.forEach((b) => b.cleanup()));

function fixture(opts) {
  const box = makeRepoSandbox(opts);
  boxes.push(box);
  const hbDir = path.join(tmpDir('sed-hb-'), 'clone');
  // push throttling is tested on its own; the other tests want every beat on the remote
  const env = { SED_HB_DIR: hbDir, SED_NO_SLEEP: '1', SED_HB_MIN_PUSH_S: '0' };
  const beat = (args, extraEnv = {}) =>
    box.cli('heartbeat', ['--role', 'primary', '--session', 's1', '--phase', 'ideate', '--wait', '0', ...args], { ...env, ...extraEnv });
  return { box, hbDir, env, beat };
}
const hbRecord = (box, date = DATE, session = 's1') => JSON.parse(remoteFile(box.remote, `state/heartbeats/${date}/${session}.json`, HB));
const hbTree = (box) => git(box.remote, 'ls-tree', '-r', '--name-only', `refs/heads/${HB}`).split('\n').filter(Boolean);

/** Creates the heartbeat branch on the remote the way the script does (an orphan with only .gitkeep), plus `files`. */
function seedHeartbeatBranch(box, files = {}) {
  const dir = cloneOf(box.remote, `seed-hb-${Math.random().toString(36).slice(2, 8)}`);
  git(dir, 'checkout', '-q', '--orphan', HB);
  git(dir, 'rm', '-rfq', '--ignore-unmatch', '.');
  fs.writeFileSync(path.join(dir, '.gitkeep'), '');
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'seed heartbeat branch');
  git(dir, 'push', '-q', 'origin', HB);
  fs.rmSync(dir, { recursive: true, force: true });
}
const beatJson = (session, at, role = 'primary', phase = 'ideate') => JSON.stringify({ holder: role, session, phase, at, note: '' });

describe('heartbeat: recording liveness', () => {
  test('writes state/heartbeats/<date>/<session>.json to the HEARTBEAT branch with exactly {holder, session, phase, at, note}', () => {
    const { box, beat, hbDir } = fixture();
    seedHeartbeatBranch(box);
    const before = box.git('rev-parse', 'HEAD');
    const workBefore = remoteSha(box.remote);
    const r = beat(['--note', 'scouts running', '--now', iso('04:10')]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.deepEqual({ ok: r.json.ok, pushed: r.json.pushed, at: r.json.at, date: r.json.date, branch: r.json.branch }, { ok: true, pushed: true, at: iso('04:10'), date: DATE, branch: HB });
    assert.deepEqual(hbRecord(box), { holder: 'primary', session: 's1', phase: 'ideate', at: iso('04:10'), note: 'scouts running' });
    assert.equal(git(box.remote, 'log', '-1', '--format=%s', `refs/heads/${HB}`), `heartbeat ${DATE} primary ideate`);
    assert.equal(git(box.remote, 'show', '--stat', '--format=', `refs/heads/${HB}`).split('\n').filter((l) => l.includes('|')).length, 1);
    assert.ok(fs.existsSync(path.join(hbDir, '.git')));
    // the orchestrator's own working tree and the work branch are never touched
    assert.equal(box.git('rev-parse', 'HEAD'), before);
    assert.equal(box.git('status', '--porcelain'), '');
    assert.equal(box.exists(`state/heartbeats/${DATE}/s1.json`), false);
    assert.equal(remoteSha(box.remote), workBefore);
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
    const files = hbTree(box).filter((f) => f.startsWith('state/heartbeats/'));
    assert.equal(files.length, 1);
    assert.match(files[0], /^state\/heartbeats\/2026-10-09\/[A-Za-z0-9._-]+\.json$/);
    assert.ok(!files[0].includes('..'));
  });

  test('the date is the LOCAL date (America/New_York), not the UTC date; --date overrides', () => {
    const { box, beat } = fixture();
    const late = beat(['--now', '2026-11-02T03:30:00Z']); // 22:30 on Nov 1 in New York
    assert.equal(late.json.date, '2026-11-01');
    assert.ok(remoteFile(box.remote, 'state/heartbeats/2026-11-01/s1.json', HB));
    const forced = beat(['--now', iso('04:00'), '--date', '2026-10-31']);
    assert.equal(forced.json.date, '2026-10-31');
    assert.ok(remoteFile(box.remote, 'state/heartbeats/2026-10-31/s1.json', HB));
  });

  test('--no-push commits in the cache only and reports it', () => {
    const { box, beat, hbDir } = fixture();
    seedHeartbeatBranch(box);
    const before = remoteSha(box.remote, HB);
    const r = beat(['--no-push', '--now', iso('04:10')]);
    assert.equal(r.code, 0);
    assert.deepEqual({ ok: r.json.ok, pushed: r.json.pushed, reason: r.json.reason }, { ok: true, pushed: false, reason: 'no-push' });
    assert.equal(remoteSha(box.remote, HB), before);
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

  describe('visibility to `begin` (it fetches the heartbeat branch itself; nothing is pulled into the working tree)', () => {
    // primary leased at 03:55, last stamped its lease at 05:00, then went silent
    function silentPrimary() {
      const f = fixture();
      const begin = (role, session, hhmm) => f.box.state(['begin', '--role', role, '--session', session, '--now', iso(hhmm)], f.env);
      begin('primary', 's1', '03:55');
      f.box.state(['phase-done', '--phase', 'preflight', '--session', 's1', '--now', iso('05:00')]);
      return { ...f, begin };
    }
    test('with a heartbeat branch that holds no record of the holder, 40 minutes of silence means takeover', () => {
      const { box, env, begin } = silentPrimary();
      box.cli('heartbeat', ['--role', 'wdA', '--session', 'someone-else', '--phase', 'ideate', '--wait', '0', '--now', iso('05:10')], env); // creates the branch
      const j = begin('wdA', 'w1', '05:40');
      assert.equal(j.json.action, 'takeover');
      assert.equal(j.json.remote.heartbeat.found, false);
      assert.equal(j.json.remote.heartbeat.unknown, false);
      assert.equal(j.json.heartbeatAvailable, true);
    });
    test('a heartbeat branch that does not exist is no error, but it is no proof of death either: hb-unreadable until the lease is silent for phaseStuckMinutes', () => {
      const { box, begin } = silentPrimary();
      const j = begin('wdA', 'w1', '05:40');
      assert.equal(j.json.action, 'exit-alive', j.stdout);
      assert.equal(j.json.remote.heartbeat.reason, 'no-heartbeat-branch');
      assert.equal(j.json.remote.heartbeat.found, false);
      assert.equal(j.json.remote.heartbeat.unknown, true);
      assert.deepEqual([j.json.heartbeatAvailable, j.json.hbUnreadable], [false, true]);
      assert.match(j.json.reason, /hb-unreadable/);
      assert.equal(box.run().lease.session, 's1');
      // 95 minutes of silence is past phaseStuckMinutes (90): the backstop takes over
      const late = begin('wdB', 'b1', '06:35');
      assert.equal(late.json.action, 'takeover');
      assert.equal(late.json.heartbeatAvailable, false);
    });
    test('a zombie old session and its replacement pulse alternately: the replacement is judged by ITS OWN pulses', () => {
      const { box, env, begin } = silentPrimary();
      const pulse = (role, session, hhmm) =>
        box.cli('heartbeat', ['--role', role, '--session', session, '--phase', 'ideate', '--wait', '0', '--now', iso(hhmm)], env);
      assert.equal(pulse('primary', 's1', '05:01').json.pushed, true); // the branch exists from now on
      assert.equal(begin('wdA', 'a1', '05:40').json.action, 'takeover'); // the primary's last sign of life was 05:01
      for (const [a, z] of [['05:41', '05:42'], ['05:46', '05:47'], ['06:11', '06:12'], ['06:36', '06:37'], ['06:43', '06:44']]) {
        assert.equal(pulse('wdA', 'a1', a).json.pushed, true);
        assert.equal(pulse('primary', 's1', z).json.pushed, true);
      }
      const j = begin('wdB', 'b1', '06:47');
      assert.equal(j.json.action, 'exit-alive', j.stdout);
      assert.equal(j.json.lease.holder, 'wdA');
      assert.equal(j.json.lease.source, 'heartbeat-file');
      assert.equal(j.json.remote.heartbeat.found, true);
    });
    test('beats on the heartbeat branch keep the primary alive for a begin whose checkout never pulled them', () => {
      const { box, beat, begin } = silentPrimary();
      assert.equal(beat(['--now', iso('05:35')]).json.pushed, true);
      const alive = begin('wdA', 'w1', '05:40');
      assert.equal(alive.json.action, 'exit-alive');
      assert.equal(alive.json.lease.source, 'heartbeat-file');
      assert.equal(box.exists(`state/heartbeats/${DATE}/s1.json`), false, 'nothing was pulled into the working tree');
    });
    test('a heartbeat file that only exists on the WORK branch is not consulted', () => {
      const { box, env, begin } = silentPrimary();
      box.cli('heartbeat', ['--role', 'wdA', '--session', 'someone-else', '--phase', 'ideate', '--wait', '0', '--now', iso('05:10')], env); // the branch exists, without s1
      box.write(`state/heartbeats/${DATE}/s1.json`, { holder: 'primary', session: 's1', phase: 'ideate', at: iso('05:35'), note: '' });
      box.git('add', '-A');
      box.git('commit', '-q', '-m', 'heartbeat on the wrong branch');
      box.git('push', '-q', 'origin', BRANCH);
      fs.rmSync(box.path(`state/heartbeats/${DATE}/s1.json`));
      assert.equal(begin('wdA', 'w1', '05:40').json.action, 'takeover');
    });
    test('fetch failure: the lease is not declared dead on its own age before phaseStuckMinutes; the reason is reported (and the failure is remembered for a minute)', () => {
      const { box, begin } = silentPrimary();
      box.git('remote', 'set-url', 'origin', path.join(box.base, 'nowhere.git'));
      const first = begin('wdA', 'w1', '05:40');
      assert.equal(first.json.action, 'exit-alive', first.stdout); // 40 minutes of silence, but the heartbeat channel is unreadable
      assert.equal(first.json.hbUnreadable, true);
      assert.equal(first.json.heartbeatAvailable, false);
      assert.equal(first.json.remote.fetched, false);
      assert.match(first.json.remote.heartbeat.reason, /fetch failed|recently/);
      assert.deepEqual([first.json.remote.heartbeat.found, first.json.remote.heartbeat.unknown], [false, true]);
      const second = begin('wdA', 'w1', '05:41');
      assert.equal(second.code, 0);
      assert.equal(second.json.remote.heartbeat.reason, 'fetch-recently-failed');
      assert.equal(second.json.action, 'exit-alive');
      assert.equal(begin('wdB', 'b1', '06:35').json.action, 'takeover'); // 95 minutes: the stuck/silence backstop
    });
    test('the fresh lease of a live primary needs no heartbeat at all', () => {
      const { box, begin } = silentPrimary();
      box.state(['beat', '--role', 'primary', '--session', 's1', '--now', iso('05:30')]);
      assert.equal(begin('wdA', 'w1', '05:40').json.action, 'exit-alive');
      assert.equal(box.run().lease.session, 's1');
    });
  });
});

describe('heartbeat: the heartbeat branch (CONTRACT 14)', () => {
  test('branch absent: it is created as an orphan holding only .gitkeep, then the record goes on top; main and the work branch are untouched', () => {
    const { box, beat } = fixture();
    assert.equal(remoteHas(box.remote, HB), false);
    const mainBefore = remoteSha(box.remote, 'main');
    const workBefore = remoteSha(box.remote);
    const r = beat(['--now', iso('04:10')]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.deepEqual({ ok: r.json.ok, pushed: r.json.pushed, branch: r.json.branch }, { ok: true, pushed: true, branch: HB });
    assert.equal(remoteHas(box.remote, HB), true);
    const commits = git(box.remote, 'rev-list', '--reverse', `refs/heads/${HB}`).split('\n');
    assert.equal(commits.length, 2, 'the orphan root and the first beat');
    assert.equal(git(box.remote, 'rev-list', '--parents', '-n', '1', commits[0]).split(' ').length, 1, 'the root has no parent');
    assert.deepEqual(git(box.remote, 'ls-tree', '-r', '--name-only', commits[0]).split('\n'), ['.gitkeep']);
    assert.deepEqual(hbTree(box).sort(), ['.gitkeep', `state/heartbeats/${DATE}/s1.json`]);
    assert.equal(gitTry(box.remote, 'merge-base', `refs/heads/${HB}`, `refs/heads/${BRANCH}`).ok, false, 'unrelated history: never mergeable into the work branch');
    assert.equal(remoteSha(box.remote, 'main'), mainBefore);
    assert.equal(remoteSha(box.remote), workBefore);
  });

  test('branch present: it is reused as it is (no second orphan, history grows linearly)', () => {
    const { box, beat } = fixture();
    seedHeartbeatBranch(box);
    const root = git(box.remote, 'rev-list', '--max-parents=0', `refs/heads/${HB}`);
    assert.equal(beat(['--now', iso('04:10')]).json.pushed, true);
    assert.equal(beat(['--now', iso('04:15')]).json.pushed, true);
    assert.equal(git(box.remote, 'rev-list', '--max-parents=0', `refs/heads/${HB}`), root);
    assert.equal(git(box.remote, 'rev-list', '--count', `refs/heads/${HB}`), '3');
    assert.equal(git(box.remote, 'log', '--merges', '--oneline', `refs/heads/${HB}`), '');
  });

  test('the work branch never receives a heartbeat commit, even over many beats and with the work branch missing altogether', () => {
    const { box, beat } = fixture();
    const workBefore = remoteSha(box.remote);
    for (const t of ['04:10', '04:15', '04:20', '04:25']) assert.equal(beat(['--now', iso(t)]).json.pushed, true);
    assert.equal(remoteSha(box.remote), workBefore);
    assert.ok(!git(box.remote, 'ls-tree', '-r', '--name-only', `refs/heads/${BRANCH}`).includes('heartbeats'));
    assert.equal(git(box.remote, 'rev-list', '--count', `refs/heads/${HB}`), '5');

    // a remote that has no work branch yet does not matter to a heartbeat, and the beat does not create it
    const bare = fixture({ workBranch: false });
    const r = bare.beat(['--now', iso('04:10')]);
    assert.equal(r.json.pushed, true, r.stdout + r.stderr);
    assert.equal(remoteHas(bare.box.remote, BRANCH), false);
    assert.equal(remoteHas(bare.box.remote, HB), true);
  });

  test('heartbeat files older than three days are pruned in the beat\'s own commit (dirs and flat files, fresh ones stay)', () => {
    const { box, beat } = fixture();
    seedHeartbeatBranch(box, {
      'state/heartbeats/2026-10-04/a.json': beatJson('a', '2026-10-04T08:00:00.000Z'),
      'state/heartbeats/2026-10-04/b.json': beatJson('b', '2026-10-04T08:00:00.000Z'),
      'state/heartbeats/2026-10-05.legacy.json': beatJson('legacy', '2026-10-05T08:00:00.000Z'),
      'state/heartbeats/2026-10-06/c.json': beatJson('c', '2026-10-06T08:00:00.000Z'),
      'state/heartbeats/2026-10-08/d.json': beatJson('d', '2026-10-08T08:00:00.000Z'),
    });
    assert.equal(RETAIN_DAYS, 3);
    const r = beat(['--now', iso('04:10')]); // today 10-09: 10-06 is exactly three days old and stays
    assert.equal(r.json.pushed, true, r.stdout + r.stderr);
    assert.equal(r.json.pruned, 2);
    assert.deepEqual(hbTree(box).sort(), ['.gitkeep', 'state/heartbeats/2026-10-06/c.json', 'state/heartbeats/2026-10-08/d.json', `state/heartbeats/${DATE}/s1.json`].sort());
    assert.equal(git(box.remote, 'rev-list', '--count', `refs/heads/${HB}`), '2', 'seed + one beat that also deletes the old days');
    // the next beat has nothing left to prune
    assert.equal(beat(['--now', iso('04:15')]).json.pruned, undefined);
  });

  test('pruning counts from the clock, not from --date: a repair beat for an old date cannot delete today\'s files', () => {
    const { box, beat } = fixture();
    seedHeartbeatBranch(box, { 'state/heartbeats/2026-10-08/d.json': beatJson('d', '2026-10-08T08:00:00.000Z') });
    assert.equal(beat(['--now', iso('04:10'), '--date', '2026-09-01']).json.pushed, true);
    assert.ok(hbTree(box).includes('state/heartbeats/2026-10-08/d.json'));
    assert.ok(hbTree(box).includes('state/heartbeats/2026-09-01/s1.json'), 'its own record is written, even though it is old');
  });

  test('a rejected push of the not-yet-created branch is retried and then succeeds (the orphan is pushed as it is)', () => {
    const { box, beat } = fixture();
    installPushHook(box.remote, { failFirst: 1, branch: HB });
    const r = beat(['--now', iso('04:10')]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.json.pushed, true);
    assert.equal(pushCount(box.remote), 2);
    assert.deepEqual(hbTree(box).sort(), ['.gitkeep', `state/heartbeats/${DATE}/s1.json`]);
  });

  test('a branch that is never accepted stays absent and the beat reports ok:false after 5 attempts', () => {
    const { box, beat } = fixture();
    installPushHook(box.remote, { always: true, branch: HB });
    const r = beat(['--now', iso('04:10')]);
    assert.equal(r.code, 1);
    assert.match(r.json.reason, /push failed/);
    assert.equal(pushCount(box.remote), 5);
    assert.equal(remoteHas(box.remote, HB), false);
  });

  test('another session creating the branch first (our orphan push loses the race): our record is laid on the rival\'s tip', () => {
    const { box, beat } = fixture();
    // pre-receive: on the first push a rival orphan commit takes the branch, then the push is rejected
    const hook = path.join(box.remote, 'hooks', 'pre-receive');
    fs.writeFileSync(
      hook,
      `#!/bin/sh
COUNT_FILE="$GIT_DIR/push-count"
n=$(cat "$COUNT_FILE" 2>/dev/null || echo 0)
n=$((n+1))
echo $n > "$COUNT_FILE"
if [ "$n" -eq 1 ]; then
  unset GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
  blob=$(echo rival | git hash-object -w --stdin)
  tree=$(printf '100644 blob %s\\trival.txt\\n' "$blob" | git mktree)
  new=$(GIT_AUTHOR_NAME=x GIT_AUTHOR_EMAIL=x@x.invalid GIT_COMMITTER_NAME=x GIT_COMMITTER_EMAIL=x@x.invalid git commit-tree "$tree" -m rival)
  git update-ref refs/heads/${HB} "$new"
  echo "rejected by test hook (race lost)" >&2
  exit 1
fi
exit 0
`,
      { mode: 0o755 },
    );
    const r = beat(['--now', iso('04:10')]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.json.pushed, true);
    assert.equal(pushCount(box.remote), 2);
    assert.deepEqual(hbTree(box).sort(), ['rival.txt', `state/heartbeats/${DATE}/s1.json`]);
    assert.equal(git(box.remote, 'rev-list', '--max-parents=0', `refs/heads/${HB}`).split('\n').length, 1, 'exactly one root: ours was dropped for the rival\'s');
  });

  test('refuses to use the work branch, main, a non-claude branch, or no branch at all (nothing is pushed anywhere)', () => {
    const cases = [
      [{ heartbeatBranch: BRANCH }, /must differ from the work branch/],
      [{ heartbeatBranch: 'main' }, /refusing to use branch "main"/],
      [{ heartbeatBranch: 'hb' }, /refusing to use branch "hb"/],
      [{ heartbeatBranch: undefined }, /heartbeatBranch is not set/],
    ];
    for (const [patch, pattern] of cases) {
      const { box, beat } = fixture();
      // the COMMITTED config is what counts: an edit in the working copy alone must not redirect the push
      box.write('config.json', { ...box.readJson('config.json'), ...patch });
      const workingOnly = beat(['--now', iso('04:10')]);
      assert.equal(workingOnly.json.pushed, true, `an uncommitted edit must be ignored: ${workingOnly.stdout}`);
      assert.equal(remoteHas(box.remote, HB), true);
      box.git('add', 'config.json');
      box.git('commit', '-q', '-m', 'config edit');
      const mainBefore = remoteSha(box.remote, 'main');
      const workBefore = remoteSha(box.remote);
      const r = beat(['--now', iso('04:20')]);
      assert.equal(r.code, 1, JSON.stringify(patch));
      assert.equal(r.json.pushed, false);
      assert.match(r.json.reason, pattern, JSON.stringify(patch));
      assert.equal(remoteSha(box.remote, 'main'), mainBefore);
      assert.equal(remoteSha(box.remote), workBefore);
    }
  });

  test('the remote\'s default branch is refused even when it is named like a claude branch', () => {
    const { box, beat } = fixture();
    git(box.remote, 'branch', '-q', HB, 'main');
    git(box.remote, 'symbolic-ref', 'HEAD', `refs/heads/${HB}`);
    box.git('fetch', '-q', 'origin');
    box.git('remote', 'set-head', 'origin', HB);
    const r = beat(['--now', iso('04:10')]);
    assert.equal(r.code, 1);
    assert.match(r.json.reason, /default branch/);
  });
});

describe('heartbeat: cost (every push to the Pages source branch may rebuild the site)', () => {
  test('the cached clone of an existing branch is partial and sparse: only state/heartbeats is checked out', () => {
    const { box, beat, hbDir } = fixture();
    seedHeartbeatBranch(box, { 'docs/stray/index.html': 'x'.repeat(5000), 'work/stray.js': 'y'.repeat(5000) });
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
    const before = remoteSha(box.remote, HB);
    const skipped = beat(['--now', iso('04:15')], slow);
    assert.deepEqual({ ok: skipped.json.ok, pushed: skipped.json.pushed, reason: skipped.json.reason }, { ok: true, pushed: false, reason: 'throttled' });
    assert.equal(remoteSha(box.remote, HB), before);
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
    seedHeartbeatBranch(box);
    installPushHook(box.remote, { sneakFirst: true, branch: HB });
    const r = beat(['--now', iso('04:10')]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.json.pushed, true);
    assert.equal(pushCount(box.remote), 2);
    assert.equal(hbRecord(box).at, iso('04:10'));
    assert.equal(remoteFile(box.remote, 'sneaky.txt', HB), 'sneaky'); // the other writer's commit survived
    assert.equal(git(box.remote, 'log', '--merges', '--oneline', `refs/heads/${HB}`), '');
  });

  test('a remote that keeps refusing gives ok:false after 5 attempts, never throws, never forces', () => {
    const { box, beat } = fixture();
    seedHeartbeatBranch(box);
    const before = remoteSha(box.remote, HB);
    installPushHook(box.remote, { always: true, branch: HB });
    const r = beat(['--now', iso('04:10')]);
    assert.equal(r.code, 1);
    assert.deepEqual({ ok: r.json.ok, pushed: r.json.pushed }, { ok: false, pushed: false });
    assert.match(r.json.reason, /push failed/);
    assert.equal(pushCount(box.remote), 5);
    assert.equal(remoteSha(box.remote, HB), before);
  });

  test('two heartbeats racing on the same cache both succeed (the clone is serialized)', async () => {
    const { box, env } = fixture();
    const args = (session) => ['--role', 'primary', '--session', session, '--phase', 'build', '--wait', '0', '--now', iso('04:10')]; // a fixed instant: the real clock may be on another local date than DATE
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
    assert.ok(remoteHas(box.remote, HB));
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

  test('a cache left by an older version (a checkout of the WORK branch) switches over to the heartbeat branch', () => {
    const { box, beat, hbDir } = fixture();
    seedHeartbeatBranch(box);
    git(path.dirname(hbDir), 'clone', '-q', '--branch', BRANCH, box.remote, hbDir);
    fs.writeFileSync(path.join(hbDir, 'README.md'), 'work branch content');
    const r = beat(['--now', iso('04:10')]);
    assert.equal(r.json.pushed, true, r.stdout + r.stderr);
    assert.equal(git(hbDir, 'rev-parse', '--abbrev-ref', 'HEAD'), HB);
    assert.equal(fs.existsSync(path.join(hbDir, 'README.md')), false);
    assert.equal(hbRecord(box).at, iso('04:10'));
  });

  test('when the origin URL changes the cache follows it', () => {
    const { box, beat } = fixture();
    assert.equal(beat(['--now', iso('04:10')]).json.pushed, true);
    const moved = path.join(path.dirname(box.remote), 'moved.git');
    fs.cpSync(box.remote, moved, { recursive: true });
    box.git('remote', 'set-url', 'origin', moved);
    const r = beat(['--now', iso('04:20')]);
    assert.equal(r.json.pushed, true);
    assert.equal(JSON.parse(git(moved, 'show', `refs/heads/${HB}:state/heartbeats/${DATE}/s1.json`)).at, iso('04:20'));
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

  test('kaizen is a valid phase to beat in', () => {
    const { box, env } = fixture();
    const r = box.cli('heartbeat', ['--role', 'primary', '--session', 's1', '--phase', 'kaizen', '--wait', '0', '--now', iso('06:30')], env);
    assert.equal(r.json.pushed, true, r.stdout + r.stderr);
    assert.equal(hbRecord(box).phase, 'kaizen');
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
    const r = box.cli('heartbeat', ['--role', 'closer', '--session', 'c1', '--wait', '0', '--now', iso('08:47')], env);
    assert.equal(r.json.pushed, true);
    assert.equal(hbRecord(box, DATE, 'c1').phase, null);
    assert.equal(gitTry(box.remote, 'rev-parse', `refs/heads/${HB}`).ok, true);
  });
});

describe('heartbeat: git servers and proxies that cannot do everything', () => {
  /** A `git` first on PATH that fails every command whose arguments match `pattern` (a sh case pattern). */
  function gitShim(pattern, message) {
    const dir = path.join(tmpDir('sed-gitshim-'), 'bin');
    fs.mkdirSync(dir, { recursive: true });
    const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(dir, 'git'), `#!/bin/sh\ncase "$*" in\n  ${pattern}) echo "${message}" >&2; exit 128;;\nesac\nexec "${real}" "$@"\n`, { mode: 0o755 });
    return { PATH: `${dir}${path.delimiter}${process.env.PATH}` };
  }

  test('a server that refuses partial clones (--filter) still gets its heartbeat: the clone retries without it', () => {
    const { box, beat, hbDir } = fixture();
    seedHeartbeatBranch(box, { [`state/heartbeats/${DATE}/old.json`]: beatJson('old', iso('03:00')) });
    const r = beat(['--now', iso('04:10')], gitShim('*--filter*', 'fatal: filter not supported by this server'));
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.json.pushed, true);
    assert.equal(hbRecord(box).at, iso('04:10'));
    assert.ok(hbTree(box).includes(`state/heartbeats/${DATE}/old.json`), 'the rival record is kept');
    assert.ok(fs.existsSync(path.join(hbDir, '.git')));
  });

  test('a server that refuses --sparse as well gets a plain shallow clone', () => {
    const { box, beat, hbDir } = fixture();
    seedHeartbeatBranch(box);
    const r = beat(['--now', iso('04:10')], gitShim('*--filter*|*--sparse*', 'fatal: unsupported option'));
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.json.pushed, true);
    assert.equal(hbRecord(box).at, iso('04:10'));
    assert.ok(fs.existsSync(path.join(hbDir, '.gitkeep')) || fs.existsSync(path.join(hbDir, 'state')));
  });

  test('a clone that fails whatever it asks for reports the failure instead of throwing', () => {
    const { box, beat } = fixture();
    seedHeartbeatBranch(box);
    const r = beat(['--now', iso('04:10')], gitShim('clone*', 'fatal: clone is not allowed here'));
    assert.equal(r.code, 1);
    assert.equal(r.json.ok, false);
    assert.match(r.json.reason, /clone failed/);
  });

  test('a proxy that refuses pushes to a second branch is named once (refused:true, with a hint) instead of retried for 30 seconds', () => {
    const { box, beat } = fixture();
    const hook = path.join(box.remote, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, `#!/bin/sh\necho x >> "$GIT_DIR/refusals"\necho "remote: denied: this session may only push its own branch" >&2\nexit 1\n`, { mode: 0o755 });
    const r = beat(['--now', iso('04:10')]);
    assert.equal(r.code, 1);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.refused, true);
    assert.match(r.json.reason, /push failed/);
    assert.match(r.json.hint, /heartbeatAvailable:false/);
    assert.equal(fs.readFileSync(path.join(box.remote, 'refusals'), 'utf8').trim().split('\n').length, 1);
    assert.equal(remoteHas(box.remote, HB), false);
  });
});
