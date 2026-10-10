#!/usr/bin/env node
// Out-of-process liveness (CONTRACT 6.1b, 14). A long workflow keeps this running (via a Haiku "pulse"
// agent) so a hung orchestrator is detectable even while it is busy: the beat is a real foreground
// wait followed by one tiny commit to state/heartbeats/<date>/<session>.json.
//
// The commit goes to config.heartbeatBranch, never to the work branch: every push to the Pages source
// branch can trigger a Pages build (soft limit about 10 an hour), and a beat every few minutes would eat
// that budget. Pushing to a branch that does not exist yet creates it as an orphan holding only .gitkeep:
// the single place where an unattended run creates a remote branch. Heartbeat files older than three days
// are removed in the same commit.
//
// One file per session: a hung old session's pulse and its replacement's pulse never share a path, so
// neither can overwrite the other's proof of life (a shared file made a healthy replacement look dead).
//
// It works in its OWN cached clone (default <tmp>/sed-hb-clone, override with SED_HB_DIR) so it can
// never race the orchestrator's working tree, and it never takes the repo lockfile. The clone is partial
// and sparse (only state/heartbeats is checked out), and a beat that changes nothing but the timestamp is
// pushed at most every 10 minutes.
// It never throws: every failure comes back as { ok:false, reason }.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, resolveNow, loadConfig, localParts, addDays, repoRoot, writeJsonAtomic, print } from './lib/common.mjs';
import { createGit, commitStaged, remoteHead, resolveHeartbeatBranch, firstLine, clearStaleIndexLock, BACKOFF_SECONDS } from './lib/gitsync.mjs';
import { acquireLock, releaseLock, heartbeatRel, ROLES, PHASES, UsageError, assertDate } from './lib/runstate.mjs';

export const MAX_WAIT_SECONDS = 540;
const DEPTH = '20';
const SPARSE_DIR = 'state/heartbeats';
export const MIN_PUSH_SECONDS = 600;
export const RETAIN_DAYS = 3;
const MISSING_REF = /couldn't find remote ref/i;
// A server or proxy that cannot do partial or sparse clones must not cost the heartbeat: each attempt asks for less.
const CLONE_ATTEMPTS = [
  ['--filter=blob:none', '--sparse'],
  ['--sparse'],
  [],
];
// What a git proxy that only lets a session write its own branch says; the beat then reports it instead of retrying blindly.
const REFUSED_PUSH = /denied|forbidden|not allowed|permission|protected|unauthori[sz]ed|\b40[13]\b|refus/i;
// A beat holding the clone must finish well inside this; a crashed one is broken after it.
const CLONE_LOCK = { waitMs: 30_000, staleMs: 15 * 60_000 };

/** Seconds to wait, clamped to 0..540 (NaN and negatives mean "no wait"). */
export function clampWait(value) {
  const n = Number(value ?? 0);
  if (Number.isNaN(n) || n < 0) return 0;
  return Math.min(n, MAX_WAIT_SECONDS);
}

export function defaultCloneDir() {
  return process.env.SED_HB_DIR ? path.resolve(process.env.SED_HB_DIR) : path.join(os.tmpdir(), 'sed-hb-clone');
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const noSleepEnv = () => !['', '0', 'false', undefined].includes(process.env.SED_NO_SLEEP);

/**
 * A brand-new local repo whose only commit is an empty .gitkeep on an orphan <branch>: what the heartbeat
 * branch looks like before its first beat. Nothing is pushed here; the first beat pushes it with its record.
 */
function initOrphan(cloneDir, url, branch) {
  fs.rmSync(cloneDir, { recursive: true, force: true });
  fs.mkdirSync(cloneDir, { recursive: true });
  const g = createGit(cloneDir);
  for (const args of [['init', '-q'], ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], ['remote', 'add', 'origin', url]]) {
    const r = g.run(args);
    if (!r.ok) return { ok: false, reason: `git ${args[0]} failed: ${firstLine(r.stderr)}` };
  }
  fs.writeFileSync(path.join(cloneDir, '.gitkeep'), '');
  const added = g.run(['add', '--', '.gitkeep']);
  if (!added.ok) return { ok: false, reason: `git add failed: ${firstLine(added.stderr)}` };
  const commit = commitStaged(g, `create the ${branch} branch for liveness heartbeats`);
  if (commit.error) return { ok: false, reason: commit.error };
  return { ok: true, g, created: true };
}

/**
 * Brings the cached clone to origin/<branch>, cloning (or re-cloning a broken cache) when needed. A remote
 * without the branch gets a fresh orphan one (`created:true`), see initOrphan.
 */
function prepareClone(cloneDir, url, branch) {
  if (fs.existsSync(path.join(cloneDir, '.git'))) {
    const g = createGit(cloneDir);
    clearStaleIndexLock(g);
    if (g.out(['remote', 'get-url', 'origin']) !== url) g.run(['remote', 'set-url', 'origin', url]);
    const fetched = g.run(['fetch', '--depth', DEPTH, 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { network: true });
    if (fetched.ok && g.run(['checkout', '-q', '-B', branch, `origin/${branch}`]).ok && g.run(['reset', '--hard', '-q', `origin/${branch}`]).ok) {
      g.run(['sparse-checkout', 'set', SPARSE_DIR]); // also slims clones cached by an older version
      g.run(['clean', '-fdq']);
      return { ok: true, g };
    }
  }
  // Probe the URL itself: asking through a damaged cache would blame the network for a broken clone.
  const remote = remoteHead(createGit(os.tmpdir()), branch, url);
  if (remote.state === 'error') return { ok: false, reason: `remote unreachable: ${remote.message}` };
  if (remote.state === 'missing') return initOrphan(cloneDir, url, branch);
  // The remote has the branch but the cache is missing or broken: rebuild it from scratch.
  fs.mkdirSync(path.dirname(cloneDir), { recursive: true });
  let cloned;
  for (const extra of CLONE_ATTEMPTS) {
    fs.rmSync(cloneDir, { recursive: true, force: true });
    cloned = createGit(path.dirname(cloneDir)).run(['clone', '--quiet', '--depth', DEPTH, ...extra, '--branch', branch, url, cloneDir], { network: true });
    if (cloned.ok) break;
  }
  if (!cloned.ok) return { ok: false, reason: `clone failed: ${firstLine(`${cloned.stderr}${cloned.stdout}`)}` };
  const g = createGit(cloneDir);
  g.run(['sparse-checkout', 'set', SPARSE_DIR]); // a no-op error on a full clone: the branch holds nothing but heartbeats anyway
  return { ok: true, g };
}

/**
 * Deletes state/heartbeats entries (a <date> directory, or a file named after a date) dated before `cutoff`,
 * except the day being recorded right now; returns how many.
 */
function pruneOld(cloneDir, cutoff, keepDay) {
  const dir = path.join(cloneDir, SPARSE_DIR);
  let removed = 0;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const day = name.match(/^(\d{4}-\d{2}-\d{2})(?:[./]|$)/)?.[1];
    if (!day || day >= cutoff || day === keepDay) continue;
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    removed++;
  }
  return removed;
}

/** Seconds a beat that only advances the timestamp may wait before being pushed (0 = push every beat). */
function minPushSeconds(opts) {
  const raw = [opts.minPushSeconds, process.env.SED_HB_MIN_PUSH_S].find((v) => v !== undefined && v !== '');
  const n = raw === undefined ? MIN_PUSH_SECONDS : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : MIN_PUSH_SECONDS;
}

function readPrevious(file, session) {
  try {
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    return rec && rec.session === session && typeof rec.at === 'string' ? rec : null;
  } catch {
    return null;
  }
}

/**
 * heartbeat({ role, session, phase?, wait?, note?, date?, now?, push?, minPushSeconds?, cloneDir?, sleep?, root? })
 * -> { ok, pushed, at, date, branch?, pruned?, reason? }.
 * `now` is an ISO instant (tests); when absent the instant is taken AFTER the wait.
 */
export async function heartbeat(opts) {
  if (!ROLES.includes(opts.role)) throw new UsageError(`--role must be one of ${ROLES.join('|')}`);
  if (typeof opts.session !== 'string' || !opts.session.trim()) throw new UsageError('--session is required');
  if (opts.phase !== undefined && !PHASES.includes(opts.phase)) throw new UsageError(`--phase must be one of ${PHASES.join('|')}`);
  if (opts.date !== undefined) assertDate(opts.date);

  const waitSeconds = clampWait(opts.wait);
  if (waitSeconds > 0) await (opts.sleep ?? defaultSleep)(waitSeconds * 1000); // the real, foreground wait
  const retrySleep = opts.sleep ?? (noSleepEnv() ? async () => {} : defaultSleep); // SED_NO_SLEEP only affects retry backoff

  let at = new Date().toISOString();
  let date = opts.date;
  try {
    const config = loadConfig();
    const now = resolveNow({ now: opts.now });
    at = now.toISOString();
    const today = localParts(now, config.timezone).date;
    date ??= today;
    const fail = (reason, extra = {}) => ({ ok: false, pushed: false, at, date, reason, ...extra });

    const mainGit = createGit(opts.root ?? repoRoot());
    const url = mainGit.out(['remote', 'get-url', 'origin']);
    if (!url) return fail('the repo has no origin remote to push heartbeats to');
    const { branch, problem } = resolveHeartbeatBranch(mainGit, config);
    if (problem) return fail(problem);
    const cloneDir = opts.cloneDir ?? defaultCloneDir();
    const cutoff = addDays(today, -RETAIN_DAYS);

    let lock;
    try {
      lock = acquireLock(`${cloneDir}.lock`, CLONE_LOCK);
    } catch (err) {
      return fail(`heartbeat clone is busy: ${err.message}`);
    }
    try {
      const prepared = prepareClone(cloneDir, url, branch);
      if (!prepared.ok) return fail(prepared.reason);
      const { g } = prepared;
      const rel = heartbeatRel(date, opts.session);
      const record = { holder: opts.role, session: opts.session, phase: opts.phase ?? null, at, note: opts.note ?? '' };
      const previous = readPrevious(path.join(g.cwd, rel), opts.session);
      if (
        previous &&
        previous.holder === record.holder &&
        previous.phase === record.phase &&
        previous.note === record.note &&
        Date.parse(at) - Date.parse(previous.at) < minPushSeconds(opts) * 1000 &&
        Date.parse(at) >= Date.parse(previous.at)
      ) {
        return { ok: true, pushed: false, at, date, branch, reason: 'throttled', lastPushedAt: previous.at };
      }
      const message = `heartbeat ${date} ${opts.role} ${opts.phase ?? '-'}`;

      let pruned = 0;
      const writeAndCommit = () => {
        writeJsonAtomic(path.join(g.cwd, rel), record);
        pruned = pruneOld(g.cwd, cutoff, date);
        const added = g.run(['add', '-A', '--', SPARSE_DIR]); // the record, and the deletions of expired days
        if (!added.ok) return { error: `git add failed: ${firstLine(added.stderr)}` };
        return commitStaged(g, message);
      };
      const result = (extra) => ({ ok: true, at, date, branch, ...(pruned ? { pruned } : {}), ...extra });

      let commit = writeAndCommit();
      if (commit.error) return fail(commit.error);
      if (opts.push === false) return result({ pushed: false, reason: 'no-push', committed: commit.committed });

      let lastError = 'unknown failure';
      let refused = false;
      for (let attempt = 0; attempt <= BACKOFF_SECONDS.length; attempt++) {
        if (attempt > 0) {
          await retrySleep(BACKOFF_SECONDS[attempt - 1] * 1000);
          // The file is a single record that this beat overwrites, so instead of rebasing: take the
          // remote state as it is now and lay our record on top (cannot conflict). A branch that still does
          // not exist remotely (our orphan was never accepted) is simply pushed again as it is.
          const fetched = g.run(['fetch', '--depth', DEPTH, 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { network: true });
          if (fetched.ok) {
            g.run(['reset', '--hard', '-q', `origin/${branch}`]);
            commit = writeAndCommit();
            if (commit.error) return fail(commit.error);
          } else if (!MISSING_REF.test(fetched.stderr)) {
            lastError = `fetch failed: ${fetched.timedOut ? 'timed out' : firstLine(fetched.stderr)}`;
            continue;
          }
        }
        if (!commit.committed && g.out(['rev-parse', 'HEAD']) === g.out(['rev-parse', `origin/${branch}`])) {
          return result({ pushed: false, reason: 'unchanged' });
        }
        const pushed = g.run(['push', 'origin', `HEAD:refs/heads/${branch}`], { network: true });
        if (pushed.ok) return result({ pushed: true, sha: g.out(['rev-parse', 'HEAD']) });
        lastError = `push failed: ${pushed.timedOut ? 'timed out' : firstLine(pushed.stderr)}`;
        refused = !pushed.timedOut && REFUSED_PUSH.test(pushed.stderr);
        if (refused) break; // a policy refusal does not heal in 30 seconds
      }
      return fail(lastError, refused ? { refused: true, hint: `the remote refuses pushes to ${branch}; \`begin\` will report heartbeatAvailable:false and leases are judged by their own checkpoint age` } : {});
    } finally {
      releaseLock(lock);
    }
  } catch (err) {
    return { ok: false, pushed: false, at, date: date ?? null, reason: `unexpected: ${err.message}` };
  }
}

export async function main(argv) {
  const flags = parseArgs(argv);
  const str = (name) => (flags[name] === true ? undefined : flags[name]);
  try {
    const result = await heartbeat({
      role: str('role'),
      session: str('session'),
      phase: str('phase'),
      wait: str('wait'),
      note: str('note'),
      minPushSeconds: str('min-push-seconds'),
      date: str('date'),
      now: str('now'),
      push: flags['no-push'] ? false : true,
    });
    return { code: result.ok ? 0 : 1, body: result };
  } catch (err) {
    if (err instanceof UsageError) {
      return { code: 2, body: { ok: false, error: err.message, usage: 'heartbeat.mjs --role R --session S [--phase P] [--wait SECONDS<=540] [--note N] [--date D] [--no-push] [--min-push-seconds N]' } };
    }
    process.stderr.write(`${err.stack ?? err}\n`);
    return { code: 1, body: { ok: false, pushed: false, reason: `unexpected: ${err.message}` } };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { code, body } = await main(process.argv.slice(2));
  print(body);
  process.exitCode = code;
}
