// git helpers for unattended runs: a non-throwing git runner and `sync` (CONTRACT 6.1).
//
// sync = stage -> commit (if anything is staged) -> fetch + rebase (autostash) -> push, with 4 retries
// (2/4/8/16 s backoff). Rules: git runs through execFileSync with argument arrays (never a shell),
// nothing is ever force-pushed, the user's git config is never modified, and a rebase conflict is
// aborted cleanly so the working tree stays usable.
//
// Git is the only arbiter between containers. Two containers can legitimately write the same
// state/runs/<date>.json (a watchdog's directive against the primary's phase-done), so a conflict on
// a run file is resolved by a semantic 3-way merge (runstate.mergeRuns), and a writer that lost the
// lease race is told so (`displaced`) instead of being allowed to push over the winner.
//
// The push target is pinned: the branch comes from the COMMITTED config.json (an agent can edit the
// working copy), must be a claude/* branch, and may never be the remote's default branch. config.json is
// only staged when --paths names it explicitly. Liveness heartbeats never ride on the work branch (every push
// to it starts the CI and sync-main Actions, and one that reaches main rebuilds GitHub Pages): they live on config.heartbeatBranch, see fetchRemoteHeartbeat and heartbeat.mjs.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot, loadConfig, localParts, resolveNow } from './common.mjs';
import { mergeRuns, parseRunText, readRunFile, saveRun, runLockPath, runPath, withLock, validHeartbeat, heartbeatRel, removeFallbackDir, sleepSync } from './runstate.mjs';

export const BACKOFF_SECONDS = [2, 4, 8, 16];
export const DEFAULT_PATHS = ['state', 'docs', 'work'];
const CONFIG_FILE = 'config.json';
const RUN_FILE_RE = /^state\/runs\/(\d{4}-\d{2}-\d{2})\.json$/;
const BRANCH_RE = /^claude\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
// Lock and temp files are transient; they must never be committed even if a sync races a writer.
// Heartbeat files belong to the heartbeat branch only.
const EXCLUDES = [':(exclude,glob)**/*.lock', ':(exclude,glob)**/*.tmp', ':(exclude,glob)**/*.lock.stale.*', ':(exclude)state/heartbeats'];
const LOCAL_TIMEOUT_MS = 60_000;
const NETWORK_TIMEOUT_MS = 120_000;
const FRESHEN_TIMEOUT_MS = 10_000;
const FETCH_BREAKER_MS = 60_000; // after a failed fetch, skip the bounded fetch of state commands for a minute
// A single dropped fetch must not make a live primary look dead: the heartbeat fetch is tried again after these pauses.
const HEARTBEAT_RETRY_MS = [1000, 2000];
const MISSING_REMOTE_REF = /couldn't find remote ref/i;
const FALLBACK_IDENTITY = { name: 'Claude', email: 'noreply@anthropic.com' };

export function firstLine(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.find((l) => /rejected|denied|declined|error:|fatal:|conflict/i.test(l)) ?? lines[0] ?? 'no output';
}

const looksLikeSigningFailure = (text) => /gpg|sign(ing)? (failed|error)|failed to sign|signing (key|program)/i.test(String(text));

/**
 * A git runner bound to `cwd`. run() never throws: it returns { ok, code, stdout, stderr, timedOut }.
 * Prompts are disabled so a missing credential fails instead of hanging at 4am; messages are forced
 * to English so failure classification is stable.
 */
export function createGit(cwd, extraEnv = {}) {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: 'true',
    GIT_MERGE_AUTOEDIT: 'no',
    LC_ALL: 'C',
    LANG: 'C',
    ...extraEnv,
  };
  let signing = true;

  function run(args, { network = false, input, timeoutMs } = {}) {
    const argv = signing ? args : ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args];
    try {
      const stdout = execFileSync('git', argv, {
        cwd,
        env,
        input,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: timeoutMs ?? (network ? NETWORK_TIMEOUT_MS : LOCAL_TIMEOUT_MS),
        maxBuffer: 64 * 1024 * 1024,
      });
      return { ok: true, code: 0, stdout, stderr: '', timedOut: false };
    } catch (err) {
      return {
        ok: false,
        code: typeof err.status === 'number' ? err.status : -1,
        stdout: String(err.stdout ?? ''),
        stderr: String(err.stderr ?? err.message ?? ''),
        timedOut: err.code === 'ETIMEDOUT',
      };
    }
  }

  const g = {
    cwd,
    run,
    /** Trimmed stdout of a successful command, else null. */
    out(args, opts) {
      const r = run(args, opts);
      return r.ok ? r.stdout.trim() : null;
    },
    /** Retry future commands without commit signing (a broken signer must not cost the day). */
    disableSigning() {
      signing = false;
    },
  };

  // Unattended containers sometimes have no identity configured; borrow one through the environment only.
  if (!g.out(['config', 'user.email'])) {
    env.GIT_AUTHOR_NAME ??= FALLBACK_IDENTITY.name;
    env.GIT_AUTHOR_EMAIL ??= FALLBACK_IDENTITY.email;
    env.GIT_COMMITTER_NAME ??= FALLBACK_IDENTITY.name;
    env.GIT_COMMITTER_EMAIL ??= FALLBACK_IDENTITY.email;
  }
  return g;
}

/**
 * Remote tip of a branch: { state: 'ok', sha } | { state: 'missing' } | { state: 'error', message }.
 * `remote` is a remote name or a URL (a URL lets callers probe without trusting a possibly broken clone).
 */
export function remoteHead(g, branch, remote = 'origin') {
  const r = g.run(['ls-remote', '--heads', remote, `refs/heads/${branch}`], { network: true });
  if (!r.ok) return { state: 'error', message: r.timedOut ? 'timed out' : firstLine(r.stderr) };
  const line = r.stdout.split('\n').find((l) => l.trim());
  return line ? { state: 'ok', sha: line.split(/\s+/)[0] } : { state: 'missing' };
}

/** Local mutation of the commit step so tests and heartbeat share it: commits when something is staged. */
export function commitStaged(g, message) {
  if (g.run(['diff', '--cached', '--quiet']).ok) return { committed: false };
  let r = g.run(['commit', '--no-verify', '-m', message]);
  if (!r.ok && looksLikeSigningFailure(r.stderr + r.stdout)) {
    g.disableSigning();
    r = g.run(['commit', '--no-verify', '-m', message]);
  }
  if (!r.ok) return { committed: false, error: `commit failed: ${firstLine(r.stderr || r.stdout)}` };
  return { committed: true };
}

function ensureBranch(g, branch) {
  const current = g.out(['symbolic-ref', '--short', '-q', 'HEAD']);
  if (current === branch) return { ok: true };
  let r;
  if (g.run(['rev-parse', '--verify', '-q', `refs/heads/${branch}`]).ok) {
    r = g.run(['checkout', branch]);
  } else {
    const remote = remoteHead(g, branch);
    if (remote.state === 'ok') {
      g.run(['fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { network: true });
      r = g.run(['checkout', '-b', branch, '--track', `origin/${branch}`]);
    } else {
      r = g.run(['checkout', '-b', branch]); // first push creates the remote branch
    }
  }
  return r.ok ? { ok: true } : { ok: false, reason: `could not check out ${branch}: ${firstLine(r.stderr)}` };
}

/**
 * Stages `paths`. config.json holds the guardrails, the budget and the push target, so an edited copy is only
 * committed when `paths` names it explicitly: whichever other path pulled it into the index (`.`, `./config.json`,
 * a parent directory) it is unstaged again and reported as `configIgnored`; the working copy is left as it was.
 */
function stage(g, paths) {
  const allowConfig = paths.includes(CONFIG_FILE);
  for (const p of paths) {
    const r = g.run(['add', '-A', '--', p, ...EXCLUDES]);
    // A listed path that does not exist and was never tracked is simply nothing to stage.
    if (!r.ok && !/did not match any files/.test(r.stderr)) return { ok: false, reason: `git add ${p} failed: ${firstLine(r.stderr)}` };
  }
  let configIgnored = false;
  if (!allowConfig && !g.run(['diff', '--cached', '--quiet', '--', CONFIG_FILE]).ok) {
    g.run(['reset', '-q', '--', CONFIG_FILE]);
    configIgnored = true;
  }
  return { ok: true, configIgnored };
}

/**
 * Reasons a branch may not be pushed to. The work branch is a claude/* branch; the remote's default branch
 * (main) must never be written by an unattended run, whatever a config file or a flag says.
 */
export function branchProblem(g, branch) {
  if (typeof branch !== 'string' || !BRANCH_RE.test(branch) || branch.includes('..') || branch.endsWith('/') || branch.endsWith('.lock')) {
    return `refusing to use branch "${branch}": a branch unattended runs write to must look like claude/<name>`;
  }
  const head = g.out(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']);
  if (head === `origin/${branch}`) return `refusing to use branch "${branch}": it is the remote's default branch`;
  return null;
}

/**
 * A branch name (`key` of config.json) from the COMMITTED config.json (HEAD), falling back to the working copy only
 * when HEAD has none. Returns { branch, edited } where `edited` means the working copy names a different branch.
 */
function committedBranch(g, config, key) {
  let committed = null;
  const text = g.out(['show', `HEAD:${CONFIG_FILE}`]);
  if (text) {
    try {
      committed = JSON.parse(text)[key] ?? null;
    } catch {
      /* unreadable committed config: fall back below */
    }
  }
  let working = null;
  try {
    working = (config ?? loadConfig())[key] ?? null;
  } catch {
    /* no readable working config */
  }
  const branch = committed ?? working;
  return { branch, edited: committed !== null && working !== null && working !== committed };
}

export const committedWorkBranch = (g, config) => committedBranch(g, config, 'workBranch');

/**
 * The branch heartbeats go to (CONTRACT 14): { branch, problem }. It must pass the same checks as the work
 * branch and must be a different branch, otherwise every beat would start the CI and sync-main Actions (and a Pages build once on main).
 */
export function resolveHeartbeatBranch(g, config) {
  const { branch } = committedBranch(g, config, 'heartbeatBranch');
  if (!branch) return { branch: null, problem: 'config.heartbeatBranch is not set; heartbeats must not go to the work branch' };
  const problem = branchProblem(g, branch);
  if (problem) return { branch, problem };
  const work = committedWorkBranch(g, config).branch;
  if (branch === work) return { branch, problem: `heartbeatBranch must differ from the work branch (${work}): heartbeats there would start the CI and sync-main Actions on every beat` };
  return { branch, problem: null };
}

const unmergedFiles = (g) => (g.out(['diff', '--name-only', '--diff-filter=U']) ?? '').split('\n').filter(Boolean);

function rebaseInProgress(g) {
  return ['rebase-merge', 'rebase-apply'].some((name) => {
    const p = g.out(['rev-parse', '--git-path', name]);
    return p !== null && fs.existsSync(path.resolve(g.cwd, p));
  });
}

export function abortRebase(g) {
  if (!rebaseInProgress(g)) return;
  if (g.run(['rebase', '--abort']).ok) return;
  g.run(['rebase', '--quit']);
  g.run(['reset', '--merge']);
}

/**
 * A git process killed mid-operation (an interrupted session) leaves .git/index.lock behind, which would fail
 * every later git command. Real git operations hold it for milliseconds, so one older than this is dead.
 */
const STALE_INDEX_LOCK_MS = 2 * 60_000;
export function clearStaleIndexLock(g, log = () => {}) {
  const rel = g.out(['rev-parse', '--git-path', 'index.lock']);
  if (!rel) return false;
  const file = path.resolve(g.cwd, rel);
  try {
    if (Date.now() - fs.statSync(file).mtimeMs < STALE_INDEX_LOCK_MS) return false;
    fs.unlinkSync(file);
    log(`removed stale ${rel}`);
    return true;
  } catch {
    return false;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const envFlag = (v) => v !== undefined && v !== '' && v !== '0' && v !== 'false';

const isAncestor = (g, ancestor, descendant) => g.run(['merge-base', '--is-ancestor', ancestor, descendant]).ok;

/** Key-sorted JSON so two runs that differ only in key order compare equal. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // git's well-known empty tree
const runText = (run) => JSON.stringify(run, null, 2) + '\n';

const HISTORY_FILE = 'state/history.json';
const DAY_PATH_RE = /^(?:work|docs\/d|state\/ideas|state\/reports)\/(\d{4}-\d{2}-\d{2})(?:[-/.]|$)/;
// Files build-site regenerates from history; a conflict in one is resolved by taking upstream and rebuilding.
const SITE_GENERATED_RE = /^docs\/(index\.html|archive\.json|feed\.xml|sitemap\.xml|404\.html|robots\.txt|\.nojekyll|assets\/.+)$/;
// The usage observation log (usage.mjs) is machine-local diagnostics (.gitignore keeps it out of every sync and out of the kaizen
// gate's dirt); the decisions live in the run file. A copy somebody committed by hand is still tracked, though: two containers appending
// to the same end of it must never block a push, so a conflict in it takes upstream (the losing side's lines are dropped).
const USAGE_LOG_FILE = 'state/usage.json';

const entryMap = (history) => new Map(history.entries.filter((e) => e && typeof e.date === 'string').map((e) => [e.date, e]));

/**
 * 3-way merge of state/history.json, entry by entry (keyed by date): an entry only one side touched is taken
 * as it is, a deletion only counts when the other side left the entry alone, and two different versions of one
 * day resolve to the better (lower) tier, local on a tie. Returns null when a version is not a history file.
 */
export function mergeHistories(base, remote, local) {
  const usable = (h) => h && typeof h === 'object' && Array.isArray(h.entries);
  if (!usable(remote) || !usable(local)) return null;
  const b = usable(base) ? entryMap(base) : new Map();
  const r = entryMap(remote);
  const l = entryMap(local);
  const same = (x, y) => canonical(x) === canonical(y);
  const entries = [];
  for (const date of new Set([...r.keys(), ...l.keys()])) {
    const re = r.get(date);
    const le = l.get(date);
    const be = b.get(date);
    let keep;
    if (!le) keep = be && same(re, be) ? null : re; // deleted locally
    else if (!re) keep = be && same(le, be) ? null : le; // deleted upstream
    else if (same(re, le)) keep = le;
    else if (be && same(le, be)) keep = re;
    else if (be && same(re, be)) keep = le;
    else keep = (re.tier ?? 4) < (le.tier ?? 4) ? re : le;
    if (keep) entries.push(keep);
  }
  entries.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  return { ...remote, ...local, entries };
}

/**
 * Prepares the semantic merge of every state file that BOTH sides changed since their common ancestor: run files
 * (mergeRuns) and the history (mergeHistories). Returns { displaced, file, remoteLease } when this checkout lost
 * the lease race on a run file, else { merged: Map<relPath, { text, run? }> }. Files whose versions cannot be
 * parsed are left to git.
 */
function planMerges(g, remoteRef, { today = null, log = () => {} } = {}) {
  const base = g.out(['merge-base', 'HEAD', remoteRef]);
  const changed = (from, to) =>
    new Set((g.out(['diff', '--name-only', from, to, '--', 'state/runs', HISTORY_FILE]) ?? '').split('\n').filter((f) => RUN_FILE_RE.test(f) || f === HISTORY_FILE));
  const ours = changed(base ?? EMPTY_TREE, 'HEAD');
  const theirs = changed(base ?? EMPTY_TREE, remoteRef);
  // pushing a day's work (build output, pages, ideas) without touching its run file still claims that day
  const touched = new Set(ours);
  const dayWork = new Set(); // days whose work, pages or ideas the local commits change (beyond the run file)
  for (const f of (g.out(['diff', '--name-only', base ?? EMPTY_TREE, 'HEAD']) ?? '').split('\n')) {
    const day = f.match(DAY_PATH_RE)?.[1];
    if (day) {
      touched.add(`state/runs/${day}.json`);
      dayWork.add(day);
    }
  }
  const merged = new Map();
  const show = (ref, file) => g.out(['show', `${ref}:${file}`]) ?? '';
  for (const file of touched) {
    if (!theirs.has(file)) continue;
    if (file === HISTORY_FILE) {
      const parse = (text) => {
        try {
          return JSON.parse(text);
        } catch {
          return null;
        }
      };
      const result = mergeHistories(base ? parse(show(base, file)) : null, parse(show(remoteRef, file)), parse(show('HEAD', file)));
      if (result) merged.set(file, { text: runText(result), history: result });
      continue;
    }
    const date = file.match(RUN_FILE_RE)[1];
    const baseRun = base ? parseRunText(show(base, file), date) : null;
    const remote = parseRunText(show(remoteRef, file), date);
    const local = parseRunText(show('HEAD', file), date);
    if (!remote || !local) continue;
    const result = mergeRuns(baseRun, remote, local);
    // A copy of an EARLIER day's run file that the remote has already resolved, with nothing else of that day in the local commits,
    // is a leftover of an earlier turn in a persistent clone (FM-110), usually a copy a state command merged the remote into.
    const leftover = today && date < today && (remote.status === 'published' || remote.status === 'failed') && !dayWork.has(date);
    if (result.displaced) {
      // There is no lease left to race for, so it is not a displacement of this session: the remote's copy is kept as it is.
      if (leftover) {
        log(`${file}: a leftover copy of a finished earlier day (remote lease ${result.remoteLease.holder}/${result.remoteLease.session}); kept the remote's copy`);
        if (ours.has(file)) {
          const raw = g.run(['show', `${remoteRef}:${file}`]);
          if (raw.ok) merged.set(file, { text: raw.stdout, run: remote });
        }
        continue;
      }
      return { displaced: true, file, remoteLease: result.remoteLease };
    }
    // Its spend is the remote's: a merged copy already holds the remote's increments since the old base, and the 3-way sum against
    // that base would count them twice (a finished day records no new spend; its events and notes are still unioned).
    if (leftover) result.run.spend = structuredClone(remote.spend);
    if (ours.has(file)) merged.set(file, { text: runText(result.run), run: result.run });
  }
  return { displaced: false, merged };
}

/**
 * Rebases HEAD onto `remoteRef`, resolving conflicts in merged state files with their precomputed merge and in
 * generated site files by taking upstream. Returns { ok, rebuildSite } | { ok:false, conflicts, error }. The tree is
 * always left usable (a failed rebase is aborted).
 */
function rebaseOnto(g, remoteRef, merged, log) {
  const resolvable = (f) => merged.has(f) || SITE_GENERATED_RE.test(f) || f === USAGE_LOG_FILE;
  let rebuildSite = false;
  let r = g.run(['rebase', '--autostash', remoteRef]);
  for (let step = 0; !r.ok && step < 200; step++) {
    const conflicts = unmergedFiles(g);
    if (!rebaseInProgress(g) || !conflicts.length || !conflicts.every(resolvable)) break;
    for (const f of conflicts) {
      if (merged.has(f)) {
        fs.writeFileSync(path.join(g.cwd, f), merged.get(f).text);
      } else {
        g.run(['checkout', '--ours', '--', f]); // during a rebase "ours" is the upstream being rebased onto
        if (f !== USAGE_LOG_FILE) rebuildSite = true;
      }
      g.run(['add', '--', f]);
    }
    log(`resolved ${conflicts.join(', ')} while rebasing`);
    r = g.run(['rebase', '--continue']);
    // a resolution identical to what upstream already holds leaves an empty commit: drop it
    if (!r.ok && rebaseInProgress(g) && g.run(['diff', '--cached', '--quiet']).ok && !unmergedFiles(g).length) r = g.run(['rebase', '--skip']);
  }
  if (r.ok) return { ok: true, rebuildSite };
  const conflicts = unmergedFiles(g);
  if (rebaseInProgress(g) || conflicts.length) {
    abortRebase(g);
    return { ok: false, conflicts, error: 'conflict' };
  }
  return { ok: false, conflicts: [], error: `rebase failed: ${r.timedOut ? 'timed out' : firstLine(r.stderr)}` };
}

/**
 * Brings the checkout up to origin/<branch>. Returns { ok, remoteTip, rebuildSite? } | { ok:false, reason, conflicts?, remoteLease? }
 * with reason 'conflict' | 'displaced' | 'autostash-conflict' | a transient failure message.
 */
function integrate(g, branch, log, today = null) {
  const remoteRef = `refs/remotes/origin/${branch}`;
  const fetched = g.run(['fetch', '--no-tags', 'origin', `+refs/heads/${branch}:${remoteRef}`], { network: true });
  if (!fetched.ok) return { ok: false, reason: `fetch failed: ${fetched.timedOut ? 'timed out' : firstLine(fetched.stderr)}` };
  const remoteTip = g.out(['rev-parse', remoteRef]);
  if (isAncestor(g, remoteRef, 'HEAD')) return { ok: true, remoteTip };

  const plan = planMerges(g, remoteRef, { today, log });
  if (plan.displaced) {
    log(`displaced: ${plan.remoteLease.holder}/${plan.remoteLease.session} holds the lease in ${plan.file}; nothing pushed`);
    return { ok: false, reason: 'displaced', conflicts: [plan.file], remoteLease: plan.remoteLease };
  }
  const rebased = rebaseOnto(g, remoteRef, plan.merged, log);
  if (!rebased.ok) {
    if (rebased.error === 'conflict') log(`rebase conflict in ${rebased.conflicts.join(', ') || 'unknown files'}; aborted, tree restored`);
    return { ok: false, reason: rebased.error, conflicts: rebased.conflicts };
  }
  const leftover = unmergedFiles(g);
  if (leftover.length) return { ok: false, reason: 'autostash-conflict', conflicts: leftover };

  // git's text merge of a file both sides edited can be clean yet semantically wrong: lay the semantic merge on top
  let fixed = 0;
  for (const [file, { text }] of plan.merged) {
    const abs = path.join(g.cwd, file);
    if (fs.existsSync(abs) && fs.readFileSync(abs, 'utf8') === text) continue;
    fs.writeFileSync(abs, text);
    g.run(['add', '--', file]);
    fixed++;
  }
  // a real build published on one side and a fallback page on the other: only the real build may stay on the site
  const realBuilds = [];
  for (const { run, history } of plan.merged.values()) {
    if (run?.status === 'published' && run.tier <= 2) realBuilds.push({ date: run.date, tier: run.tier, slug: run.chosen?.slug });
    for (const e of history?.entries ?? []) if (e.tier <= 2) realBuilds.push({ date: e.date, tier: e.tier, slug: e.slug });
  }
  for (const { date, tier, slug } of realBuilds) {
    for (const fallbackTier of [3, 4]) {
      for (const dir of removeFallbackDir(date, fallbackTier, tier, slug, g.cwd)) {
        g.run(['add', '-A', '--', dir]);
        fixed++;
      }
    }
  }
  if (fixed) {
    const c = commitStaged(g, 'sync: merge concurrent state updates');
    if (c.error) return { ok: false, reason: c.error };
  }
  return { ok: true, remoteTip: g.out(['rev-parse', remoteRef]), ...(rebased.rebuildSite ? { rebuildSite: true } : {}) };
}

/**
 * sync({ message, paths?, branch?, noSleep?, sleep?, root?, config?, log? })
 * -> { ok, pushed, sha, reason, branch, committed, attempts, conflicts?, remoteLease?, configIgnored? }
 * ok:false only for conflict / displaced / unreachable remote / push refusal; "nothing to commit" is ok:true, pushed:false.
 */
export async function sync(opts = {}) {
  const log = opts.log ?? ((m) => process.stderr.write(`[sync] ${m}\n`));
  const message = opts.message;
  if (typeof message !== 'string' || !message.trim()) throw new Error('sync needs a commit message');
  const cwd = opts.root ?? repoRoot();
  const paths = opts.paths?.length ? opts.paths : DEFAULT_PATHS;
  const noSleep = opts.noSleep ?? envFlag(process.env.SED_NO_SLEEP);
  const sleep = opts.sleep ?? (noSleep ? async () => {} : defaultSleep);
  const g = createGit(cwd);
  const head = () => g.out(['rev-parse', 'HEAD']);
  let branch = opts.branch ?? null;
  const done = (ok, pushed, reason, extra = {}) => ({ ok, pushed, sha: head(), reason, branch, ...extra });

  if (g.out(['rev-parse', '--is-inside-work-tree']) !== 'true') return done(false, false, `${cwd} is not a git work tree`, { committed: false });
  if (!g.run(['remote', 'get-url', 'origin']).ok) return done(false, false, 'no remote named origin', { committed: false });

  if (branch === null) {
    const resolved = committedWorkBranch(g, opts.config);
    branch = resolved.branch;
    if (resolved.edited) log(`config.json in the working tree names a different work branch; using the committed one (${branch})`);
  }
  const problem = branchProblem(g, branch);
  if (problem) return done(false, false, problem, { committed: false });
  // The local date of this sync (opts.now, else --now/SED_NOW, else the clock): a leftover copy of an earlier, finished day's run
  // file is not a lease race (planMerges). Without a clock or a config every displacement stays terminal.
  let today = null;
  try {
    today = localParts(resolveNow({ now: opts.now }), (opts.config ?? loadConfig()).timezone).date;
  } catch {
    /* keep today null */
  }

  clearStaleIndexLock(g, log);
  if (rebaseInProgress(g)) {
    log('a rebase from an interrupted run was still open; aborting it');
    abortRebase(g);
  }
  const onBranch = ensureBranch(g, branch);
  if (!onBranch.ok) return done(false, false, onBranch.reason, { committed: false });
  const staged = stage(g, paths);
  if (!staged.ok) return done(false, false, staged.reason, { committed: false });
  const extra = staged.configIgnored ? { configIgnored: true } : {}; // result fields set along the way (configIgnored, rebuildSite)
  if (staged.configIgnored) log('config.json has uncommitted edits; not staged (name config.json in --paths to commit them)');
  const commit = commitStaged(g, message);
  if (commit.error) return done(false, false, commit.error, { committed: false, ...extra });
  if (commit.committed) log(`committed ${head()?.slice(0, 9)}: ${message.split('\n')[0]}`);

  let lastError = 'unknown failure';
  for (let attempt = 0; attempt <= BACKOFF_SECONDS.length; attempt++) {
    if (attempt > 0) {
      log(`retry ${attempt}/${BACKOFF_SECONDS.length} in ${BACKOFF_SECONDS[attempt - 1]}s (${lastError})`);
      await sleep(BACKOFF_SECONDS[attempt - 1] * 1000);
    }
    const remote = remoteHead(g, branch);
    if (remote.state === 'error') {
      lastError = `remote unreachable: ${remote.message}`;
      continue;
    }
    let remoteTip = null;
    if (remote.state === 'ok') {
      const merged = integrate(g, branch, log, today);
      if (!merged.ok) {
        const terminal = ['conflict', 'displaced', 'autostash-conflict'].includes(merged.reason);
        if (terminal) {
          return done(false, false, merged.reason, {
            committed: commit.committed,
            attempts: attempt + 1,
            conflicts: merged.conflicts,
            ...(merged.remoteLease ? { remoteLease: merged.remoteLease } : {}),
            ...extra,
          });
        }
        lastError = merged.reason;
        continue;
      }
      remoteTip = merged.remoteTip;
      if (merged.rebuildSite) extra.rebuildSite = true;
    }
    if (remoteTip && remoteTip === head()) {
      // After a failed attempt this means the earlier push actually landed (e.g. the client timed out first).
      if (attempt > 0) return done(true, true, null, { committed: commit.committed, attempts: attempt + 1, ...extra });
      return done(true, false, 'nothing-to-commit', { committed: commit.committed, attempts: attempt + 1, ...extra });
    }
    const push = g.run(['push', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], { network: true });
    if (push.ok) {
      log(`pushed ${head()?.slice(0, 9)} to ${branch}`);
      return done(true, true, null, { committed: commit.committed, attempts: attempt + 1, ...extra });
    }
    lastError = `push failed: ${push.timedOut ? 'timed out' : firstLine(push.stderr)}`;
  }
  return done(false, false, lastError, { committed: commit.committed, attempts: BACKOFF_SECONDS.length + 1, ...extra });
}

// ---------------------------------------------------------------------------------------
// freshen: let a running operator see what other containers pushed (lease, directives, status)
// ---------------------------------------------------------------------------------------

function breakerFile(g, name = 'sed-fetch-failed') {
  const rel = g.out(['rev-parse', '--git-path', name]);
  return rel ? path.resolve(g.cwd, rel) : null;
}

function breakerOpen(file) {
  try {
    return Date.now() - fs.statSync(file).mtimeMs < FETCH_BREAKER_MS;
  } catch {
    return false;
  }
}

/**
 * fetchRemoteHeartbeat({ date, session, root?, config?, timeoutMs? }) -> never throws.
 * The liveness record `session` pushed for `date` to the heartbeat branch (CONTRACT 14): a bounded
 * `git fetch` of that branch (retried twice after 1 s and 2 s: one network blip must not decide a takeover), then `git show` of the session's file. Best effort: whenever the fetch fails (no
 * network, no such branch yet, a recent failure) it reports why and `heartbeat:null`, and the caller falls back
 * to the lease's own heartbeatAt, so the stale/stuck thresholds still decide.
 *
 * `unknown:true` says the channel itself could not be read (the fetch failed even after retries, was skipped
 * because one failed a moment ago, or the branch does not exist): "no record" then proves nothing about the
 * holder, and `begin` must not call a lease dead on its own age. `unknown:false` with `heartbeat:null` means the
 * branch was read and holds no record for the session.
 *
 * Returns { fetched, unknown, heartbeat, branch?, reason? }.
 */
export function fetchRemoteHeartbeat({ date, session, root, config, timeoutMs = FRESHEN_TIMEOUT_MS, retryDelaysMs = HEARTBEAT_RETRY_MS } = {}) {
  const out = { fetched: false, unknown: false, heartbeat: null };
  try {
    const cwd = root ?? repoRoot();
    const g = createGit(cwd);
    const top = g.out(['rev-parse', '--show-toplevel']);
    if (!top || fs.realpathSync(top) !== fs.realpathSync(cwd)) return { ...out, reason: 'not-a-repo-root' };
    if (!g.run(['remote', 'get-url', 'origin']).ok) return { ...out, reason: 'no-origin' };
    const { branch, problem } = resolveHeartbeatBranch(g, config);
    if (problem) return { ...out, reason: problem };
    out.branch = branch;
    out.unknown = true;

    const breaker = breakerFile(g, 'sed-hb-fetch-failed');
    if (breaker && breakerOpen(breaker)) return { ...out, reason: 'fetch-recently-failed' };
    const ref = `refs/remotes/origin/${branch}`;
    const fetchArgs = ['fetch', '--no-tags', 'origin', `+refs/heads/${branch}:${ref}`];
    let fetched = g.run(fetchArgs, { network: true, timeoutMs });
    for (const pause of retryDelaysMs) {
      if (fetched.ok || MISSING_REMOTE_REF.test(fetched.stderr)) break;
      if (!envFlag(process.env.SED_NO_SLEEP)) sleepSync(pause);
      fetched = g.run(fetchArgs, { network: true, timeoutMs });
    }
    if (!fetched.ok) {
      // a heartbeat branch that nobody has created yet is not a network failure and must not silence later fetches
      if (MISSING_REMOTE_REF.test(fetched.stderr)) return { ...out, missing: true, reason: 'no-heartbeat-branch' };
      if (breaker) {
        try {
          fs.writeFileSync(breaker, new Date().toISOString());
        } catch {
          /* best effort */
        }
      }
      return { ...out, reason: `fetch failed: ${fetched.timedOut ? 'timed out' : firstLine(fetched.stderr)}` };
    }
    if (breaker) fs.rmSync(breaker, { force: true });
    out.fetched = true;
    out.unknown = false;

    const text = g.out(['show', `${ref}:${heartbeatRel(date, session).split(path.sep).join('/')}`]);
    if (text) {
      try {
        out.heartbeat = validHeartbeat(JSON.parse(text), session);
      } catch {
        /* a torn or foreign file proves nothing */
      }
    }
    return out;
  } catch (err) {
    return { ...out, unknown: out.branch !== undefined, reason: `heartbeat fetch failed: ${err.message}` };
  }
}

/**
 * freshenRun({ date, root?, adoptOnDisplaced?, timeoutMs? }) -> never throws.
 * A bounded fetch of the work branch, then a semantic merge of the REMOTE run file for `date` into the local one
 * (directives, a published/failed status, counters), under the per-date lock. Fails soft: with no git, no
 * origin, no network or a recently failed fetch it reports `fetched:false` and changes nothing.
 *
 * Returns { fetched, reason?, branch?, adopted: null|'remote-run'|'merged', displaced, remoteLease?, remoteStatus?, remoteDirectives?, wrote? }
 * where `wrote` = { before, after }: the run file text this call replaced (null: none) and the text it wrote.
 * `displaced` = the remote lease belongs to another session and is newer than the local one: the local writer
 * lost and must stop. The local file is then left alone (so `sync` still sees the conflict) unless
 * `adoptOnDisplaced`, which replaces it with the remote run (begin / status / the late finisher's finish).
 */
export function freshenRun({ date, root, adoptOnDisplaced = false, timeoutMs = FRESHEN_TIMEOUT_MS, config } = {}) {
  const out = { fetched: false, adopted: null, displaced: false };
  try {
    const cwd = root ?? repoRoot();
    const g = createGit(cwd);
    const top = g.out(['rev-parse', '--show-toplevel']);
    if (!top || fs.realpathSync(top) !== fs.realpathSync(cwd)) return { ...out, reason: 'not-a-repo-root' };
    if (!g.run(['remote', 'get-url', 'origin']).ok) return { ...out, reason: 'no-origin' };
    const { branch } = committedWorkBranch(g, config);
    if (!branch || branchProblem(g, branch)) return { ...out, reason: 'no-valid-work-branch' };
    out.branch = branch;

    const breaker = breakerFile(g);
    if (breaker && breakerOpen(breaker)) return { ...out, reason: 'fetch-recently-failed' };
    const remoteRef = `refs/remotes/origin/${branch}`;
    const fetched = g.run(['fetch', '--no-tags', 'origin', `+refs/heads/${branch}:${remoteRef}`], { network: true, timeoutMs });
    if (!fetched.ok) {
      if (breaker) {
        try {
          fs.writeFileSync(breaker, new Date().toISOString());
        } catch {
          /* best effort */
        }
      }
      return { ...out, reason: `fetch failed: ${fetched.timedOut ? 'timed out' : firstLine(fetched.stderr)}` };
    }
    if (breaker) fs.rmSync(breaker, { force: true });
    out.fetched = true;

    const file = `state/runs/${date}.json`;
    const remote = parseRunText(g.out(['show', `${remoteRef}:${file}`]) ?? '', date);
    if (!remote) return out;
    out.remoteStatus = remote.status;
    out.remoteDirectives = remote.directives.filter((d) => !d.ack);

    withLock(runLockPath(date), () => {
      const local = readRunFile(date);
      if (local.status === 'corrupt') return;
      // `wrote` = the exact text this freshen replaced (null: there was no file) and the text it wrote, read under the lock, so a
      // command that only looked can undo exactly this write and nothing another process wrote (state.mjs keepRunFileAsFound).
      const textNow = () => {
        try {
          return fs.readFileSync(runPath(date), 'utf8');
        } catch {
          return null;
        }
      };
      const before = textNow();
      const save = (run) => {
        saveRun(run);
        out.wrote = { before, after: textNow() };
      };
      if (local.status === 'missing') {
        save(remote);
        out.adopted = 'remote-run';
        return;
      }
      const mergeBase = g.out(['merge-base', 'HEAD', remoteRef]);
      const baseRun = mergeBase ? parseRunText(g.out(['show', `${mergeBase}:${file}`]) ?? '', date) : null;
      if (baseRun && canonical(baseRun) === canonical(remote)) return; // the remote changed nothing since we forked
      const result = mergeRuns(baseRun, remote, local.run);
      if (result.displaced) {
        out.displaced = true;
        out.remoteLease = result.remoteLease;
        if (adoptOnDisplaced) {
          save(remote);
          out.adopted = 'remote-run';
        }
        return;
      }
      if (canonical(result.run) !== canonical(local.run)) {
        save(result.run);
        out.adopted = 'merged';
      }
    });
    return out;
  } catch (err) {
    return { ...out, reason: `freshen failed: ${err.message}` };
  }
}
