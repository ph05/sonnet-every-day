// Git fixtures: a temp BARE remote plus clones, and a way to make the remote misbehave.
import './env.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './env.mjs';

export const BRANCH = 'claude/sonnet-every-day';

export function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function gitTry(cwd, ...args) {
  try {
    return { ok: true, out: git(cwd, ...args) };
  } catch (err) {
    return { ok: false, out: String(err.stderr ?? err.message) };
  }
}

// A finished remote is built once per process and per content (about nine git processes: init, clone, add, commit, push, checkout, push) and
// every sandbox after that is a file copy of it: a bare repository holds no absolute paths, and each copy gets its own hooks and push counter.
const remoteTemplates = new Map();

/** Bare remote whose `main` (and optionally the work branch) holds `files` ({relPath: content}). */
export function makeRemote({ files = { 'README.md': 'seed\n' }, workBranch = true } = {}) {
  const key = JSON.stringify([files, workBranch]);
  let template = remoteTemplates.get(key);
  if (!template) {
    template = buildRemote({ files, workBranch }).remote;
    remoteTemplates.set(key, template);
  }
  const base = tmpDir('sed-remote-');
  const remote = path.join(base, 'remote.git');
  fs.cpSync(template, remote, { recursive: true });
  return { remote, base };
}

function buildRemote({ files, workBranch }) {
  const base = tmpDir('sed-remote-template-');
  const remote = path.join(base, 'remote.git');
  execFileSync('git', ['init', '--bare', '-b', 'main', remote], { stdio: 'ignore' });
  const seed = path.join(base, 'seed');
  execFileSync('git', ['clone', '-q', remote, seed], { stdio: 'ignore' });
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(seed, rel)), { recursive: true });
    fs.writeFileSync(path.join(seed, rel), content);
  }
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'seed');
  git(seed, 'push', '-q', 'origin', 'main');
  if (workBranch) {
    git(seed, 'checkout', '-q', '-b', BRANCH);
    git(seed, 'push', '-q', 'origin', BRANCH);
  }
  return { remote, base };
}

export function cloneOf(remote, name, branch) {
  const dir = path.join(path.dirname(remote), name);
  execFileSync('git', ['clone', '-q', ...(branch ? ['--branch', branch] : []), remote, dir], { stdio: 'ignore' });
  return dir;
}

export const remoteSha = (remote, branch = BRANCH) => git(remote, 'rev-parse', `refs/heads/${branch}`);
export const remoteFile = (remote, rel, branch = BRANCH) => git(remote, 'show', `refs/heads/${branch}:${rel}`);
export const remoteHas = (remote, branch = BRANCH) => gitTry(remote, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`).ok;

/**
 * Installs a pre-receive hook on the bare remote.
 *  - failFirst:  reject the first N pushes
 *  - sneakFirst: on the first push, also land a commit adding sneaky.txt on the branch (a concurrent writer
 *                winning the race), then reject, so the pusher must pull --rebase / refetch and try again
 *  - always:     reject every push
 * Pushes the hook counted are recorded in <remote>/push-count.
 */
export function installPushHook(remote, { failFirst = 0, sneakFirst = false, always = false, branch = BRANCH } = {}) {
  const script = `#!/bin/sh
COUNT_FILE="$GIT_DIR/push-count"
n=$(cat "$COUNT_FILE" 2>/dev/null || echo 0)
n=$((n+1))
echo $n > "$COUNT_FILE"
if [ "${always ? 1 : 0}" = "1" ]; then
  echo "rejected by test hook (always)" >&2
  exit 1
fi
if [ "${sneakFirst ? 1 : 0}" = "1" ] && [ "$n" -eq 1 ]; then
  # a pre-receive hook runs in a quarantine; step out of it so the competing commit really lands
  unset GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
  blob=$(echo sneaky | git hash-object -w --stdin)
  tree=$( (git ls-tree refs/heads/${branch}; printf '100644 blob %s\\tsneaky.txt\\n' "$blob") | git mktree)
  parent=$(git rev-parse refs/heads/${branch})
  new=$(GIT_AUTHOR_NAME=x GIT_AUTHOR_EMAIL=x@x.invalid GIT_COMMITTER_NAME=x GIT_COMMITTER_EMAIL=x@x.invalid git commit-tree "$tree" -p "$parent" -m sneaky)
  git update-ref refs/heads/${branch} "$new"
  echo "rejected by test hook (race lost)" >&2
  exit 1
fi
if [ "$n" -le ${failFirst} ]; then
  echo "rejected by test hook (n=$n)" >&2
  exit 1
fi
exit 0
`;
  const hook = path.join(remote, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, script, { mode: 0o755 });
}

export const pushCount = (remote) => {
  try {
    return Number(fs.readFileSync(path.join(remote, 'push-count'), 'utf8'));
  } catch {
    return 0;
  }
};

export function removePushHook(remote) {
  fs.rmSync(path.join(remote, 'hooks', 'pre-receive'), { force: true });
}
