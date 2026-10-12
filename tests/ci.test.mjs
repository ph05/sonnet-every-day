// Guards the CI workflow files: the test job must provision everything the browser tests need,
// because tests/qa.test.mjs drives a real Chromium and has no skip logic of its own; and the step of
// sync-main.yml that moves `main` is run for real against local remotes (it decides the Pages build request).
import './helpers/env.mjs'; // git identity and isolation for the scratch repositories below
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/env.mjs';
import { git } from './helpers/git.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const validate = read('.github', 'workflows', 'validate.yml');

/** The text of the step whose `name:` is given (up to the next step). */
function step(name) {
  const lines = validate.split('\n');
  const start = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.notEqual(start, -1, `validate.yml has a step named "${name}"`);
  let end = lines.findIndex((l, i) => i > start && /^\s*- (name|uses):/.test(l));
  if (end === -1) end = lines.length;
  return lines.slice(start, end).join('\n');
}

test('validate.yml installs Playwright and Chromium before npm test, only when tests run', () => {
  const install = step('Install Playwright and Chromium');
  assert.match(install, /npm install -g playwright@\d+\.\d+\.\d+/, 'pinned global playwright (the tests resolve it via `npm root -g`)');
  assert.match(install, /playwright install .*chromium/);
  assert.match(install, /if: steps\.changes\.outputs\.code == 'true'/, 'skipped on docs-only pushes like the tests');
  assert.ok(validate.indexOf('Install Playwright and Chromium') < validate.indexOf('run: npm test'), 'install precedes npm test');
});

test('validate.yml installs the browser where qa.test.mjs looks for it', () => {
  const m = validate.match(/^\s+PLAYWRIGHT_BROWSERS_PATH:\s*(\S+)/m);
  assert.ok(m, 'PLAYWRIGHT_BROWSERS_PATH is set for the job');
  const qa = read('tests', 'qa.test.mjs');
  const dflt = qa.match(/process\.env\.PLAYWRIGHT_BROWSERS_PATH \|\| '([^']+)'/);
  assert.ok(dflt, 'qa.test.mjs documents its default browsers path');
  assert.equal(m[1], dflt[1]);
  assert.match(step('Install Playwright and Chromium'), /\$PLAYWRIGHT_BROWSERS_PATH/);
});

test('the workflows keep least-privilege defaults and a concurrency group', () => {
  assert.match(validate, /^permissions:\n  contents: read$/m);
  assert.match(validate, /^concurrency:/m);
  assert.match(validate, /node scripts\/validate\.mjs repo/);
});

/** The `run: |` script of the step called `name` in a workflow file, dedented. */
function runScript(file, name) {
  const lines = read('.github', 'workflows', file).split('\n');
  const start = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.notEqual(start, -1, `${file} has a step named "${name}"`);
  const run = lines.findIndex((l, i) => i > start && l.trim() === 'run: |');
  assert.notEqual(run, -1, `"${name}" has a block script`);
  const indent = lines[run].length - lines[run].trimStart().length + 2;
  const body = [];
  for (let i = run + 1; i < lines.length && (lines[i].trim() === '' || lines[i].length - lines[i].trimStart().length >= indent); i++) body.push(lines[i].slice(indent));
  return body.join('\n');
}

test('sync-main: a push that changes docs/ moves main and asks for the Pages build, a config-only push moves main without, any other push leaves it alone', () => {
  const workflow = read('.github', 'workflows', 'sync-main.yml');
  assert.match(workflow, /if: steps\.ff\.outputs\.moved == 'true' && steps\.ff\.outputs\.docs == 'true'/, 'the Pages build is requested when main moved and docs/ changed');
  const script = runScript('sync-main.yml', 'Fast-forward main to this push');
  const base = tmpDir('sed-sync-main-');
  const git = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const write = (dir, rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  const remoteMain = () => git(base, '--git-dir', 'remote.git', 'rev-parse', 'main');
  git(base, 'init', '-q', '--bare', 'remote.git');
  git(base, 'clone', '-q', 'remote.git', 'seed');
  const seed = path.join(base, 'seed');
  for (const [rel, text] of [['docs/a.txt', 'one\n'], ['config.json', '{}\n'], ['ops/x.md', 'x\n']]) write(seed, rel, text);
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'base');
  git(seed, 'push', '-q', 'origin', 'main');
  const base0 = git(seed, 'rev-parse', 'HEAD');
  git(seed, 'checkout', '-q', '-b', 'work');
  /** The work branch gets one more commit that changes `rel`, and the push is what the Action reacts to. */
  const push = (rel, text) => {
    write(seed, rel, text);
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', `change ${rel}`);
    git(seed, 'push', '-q', 'origin', 'work');
    return git(seed, 'rev-parse', 'HEAD');
  };
  /** Runs the step the way the Action does: a checkout of the pushed commit, origin = the remote, outputs in a file. */
  const act = (sha) => {
    const runner = path.join(base, `runner-${sha.slice(0, 8)}`);
    git(base, 'clone', '-q', 'remote.git', runner);
    git(runner, 'checkout', '-q', '--detach', sha);
    const out = path.join(base, `out-${sha.slice(0, 8)}`);
    fs.writeFileSync(out, '');
    const r = spawnSync('bash', ['-c', script], { cwd: runner, encoding: 'utf8', env: { ...process.env, GITHUB_SHA: sha, GITHUB_OUTPUT: out } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const outputs = Object.fromEntries(fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
    return { outputs, text: r.stdout + r.stderr };
  };

  // a push that touches neither the site, the workflows nor the config (ops/, state/, work/ ...): main waits, no Pages build
  const o = act(push('ops/x.md', 'y\n'));
  assert.deepEqual([o.outputs.moved, o.outputs.docs, remoteMain()], ['false', 'false', base0]);
  // config.json alone moves main (every earlier commit goes along) but changes no page: no Pages build
  const config = push('config.json', '{"a":1}\n');
  const c = act(config);
  assert.deepEqual([c.outputs.moved, c.outputs.docs, remoteMain()], ['true', 'false', config]);
  // docs/ moves main AND asks for the Pages build: the step decides it before the push, not against a main that already moved
  const docs = push('docs/a.txt', 'two\n');
  const d = act(docs);
  assert.deepEqual([d.outputs.moved, d.outputs.docs, remoteMain()], ['true', 'true', docs]);
  // someone committed to main: it is no ancestor of the next push, so nothing moves and the run says why
  git(base, 'clone', '-q', 'remote.git', 'direct');
  const direct = path.join(base, 'direct');
  write(direct, 'README.md', 'a commit made on main\n');
  git(direct, 'add', '-A');
  git(direct, 'commit', '-q', '-m', 'direct commit on main');
  git(direct, 'push', '-q', 'origin', 'main');
  const before = remoteMain();
  const diverged = act(push('docs/a.txt', 'three\n'));
  assert.deepEqual([diverged.outputs.moved, diverged.outputs.docs, remoteMain()], ['false', 'false', before]);
  assert.match(diverged.text, /::warning::main \(.*\) is not an ancestor/);
});

// ---------------------------------------------------------------------------------------------
// "Detect changes outside docs/": the step decides whether the unit tests run. It is exercised here as written in the workflow, in scratch
// repositories, with BASE and GITHUB_OUTPUT set the way GitHub sets them.
// ---------------------------------------------------------------------------------------------

/** The shell script of a step's `run: |` block, dedented. */
function script(name) {
  const lines = step(name).split('\n');
  const at = lines.findIndex((l) => /^\s+run: \|\s*$/.test(l));
  assert.notEqual(at, -1, `step "${name}" has a run: | block`);
  const indent = /^\s*/.exec(lines[at + 1])[0].length;
  const body = [];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() !== '' && /^\s*/.exec(l)[0].length < indent) break;
    body.push(l.slice(indent));
  }
  return body.join('\n');
}

const ZEROS = '0'.repeat(40);

/** A scratch repository with a commit() helper: files are {path: content}, a null content deletes the file. commit() returns the new HEAD. */
function scratch() {
  const dir = tmpDir('sed-ci-detect-');
  git(dir, 'init', '-q', '-b', 'main');
  const commit = (files = {}, message = 'c') => {
    for (const [rel, content] of Object.entries(files)) {
      const file = path.join(dir, rel);
      if (content === null) {
        fs.rmSync(file, { force: true });
        continue;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '--allow-empty', '-m', message);
    return git(dir, 'rev-parse', 'HEAD');
  };
  return { dir, commit };
}

/**
 * What the step answers ('true': run the tests, 'false': docs only) for a push whose previous tip was `base`. `gh` is a stand-in for the
 * API call that asks how many successful runs of this workflow `base` has: `tested` is the total_count it prints, or 'fail' for an API error.
 */
function detect(dir, base, tested = '1') {
  const root = tmpDir('sed-ci-detect-run-');
  const output = path.join(root, 'github-output');
  fs.writeFileSync(output, '');
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(path.join(root, 'bin', 'gh'), '#!/bin/sh\necho "$*" >> "$GH_CALLS"\n[ "$FAKE_GH_COUNT" = fail ] && exit 1\necho "$FAKE_GH_COUNT"\n', { mode: 0o755 });
  const env = {
    ...process.env, BASE: base, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: 'owner/repo', GH_TOKEN: 'x',
    PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}`, FAKE_GH_COUNT: tested, GH_CALLS: path.join(root, 'gh-calls'),
  };
  const r = spawnSync('bash', ['-c', script('Detect changes outside docs/')], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `the step itself must not fail: ${r.stdout}${r.stderr}`);
  const m = /^code=(true|false)$/m.exec(fs.readFileSync(output, 'utf8'));
  assert.ok(m, `the step writes code=true|false to GITHUB_OUTPUT: ${fs.readFileSync(output, 'utf8')}`);
  const calls = fs.existsSync(env.GH_CALLS) ? fs.readFileSync(env.GH_CALLS, 'utf8') : '';
  if (calls) assert.match(calls, new RegExp(`repos/owner/repo/actions/workflows/validate\\.yml/runs\\?head_sha=${base}&status=success`), 'the API is asked about the previous tip');
  detect.asked = calls !== ''; // whether the API was consulted at all (only a docs-only diff needs it)
  return m[1];
}

test('change detection: a push of several commits is judged by the whole push, not by its last commit', () => {
  const { dir, commit } = scratch();
  commit({ 'scripts/a.mjs': 'a\n', 'docs/index.html': 'x\n' });
  const before = git(dir, 'rev-parse', 'HEAD');
  commit({ 'docs/d/2026-10-12-x/index.html': '1\n' });
  commit({ 'scripts/a.mjs': 'b\n' });
  commit({ 'docs/archive.json': '{}\n' }); // the last commit alone is docs only
  assert.equal(detect(dir, before), 'true');
});

test('change detection: pushes that only touch docs/ skip the unit tests, however many commits they hold', () => {
  const { dir, commit } = scratch();
  commit({ 'scripts/a.mjs': 'a\n', 'docs/index.html': 'x\n' });
  const before = git(dir, 'rev-parse', 'HEAD');
  commit({ 'docs/d/2026-10-12-x/index.html': '1\n' });
  commit({ 'docs/archive.json': '{}\n', 'docs/feed.xml': '<feed/>\n' });
  assert.equal(detect(dir, before), 'false');
  // a code change that was reverted inside the same push leaves nothing to test
  commit({ 'scripts/a.mjs': 'changed\n' });
  commit({ 'scripts/a.mjs': 'a\n' });
  assert.equal(detect(dir, before), 'false');
});

test('change detection: docs only after a previous tip that was never tested (its run was cancelled by this push) runs the tests', () => {
  const { dir, commit } = scratch();
  commit({ 'scripts/a.mjs': 'a\n', 'docs/index.html': 'x\n' });
  const before = git(dir, 'rev-parse', 'HEAD');
  commit({ 'docs/archive.json': '{}\n' });
  assert.equal(detect(dir, before, '1'), 'false');
  assert.equal(detect.asked, true);
  assert.equal(detect(dir, before, '0'), 'true', 'no successful run of the previous tip');
  assert.equal(detect(dir, before, 'fail'), 'true', 'the API failed: untested');
  assert.equal(detect(dir, before, 'garbage'), 'true', 'an answer that is not a number: untested');
  // code changed: the answer is true without asking anyone
  commit({ 'scripts/a.mjs': 'b\n' });
  assert.equal(detect(dir, before, '1'), 'true');
  assert.equal(detect.asked, false);
});

test('change detection: the first push of a branch, an unknown or empty previous tip and a force-push run everything', () => {
  const { dir, commit } = scratch();
  commit({ 'scripts/a.mjs': 'a\n' });
  commit({ 'docs/index.html': 'only docs since the root\n' });
  assert.equal(detect(dir, ZEROS), 'true', 'github.event.before is all zeros on the first push of a branch');
  assert.equal(detect(dir, ''), 'true', 'no previous tip');
  assert.equal(detect(dir, '1234567890abcdef1234567890abcdef12345678'), 'true', 'the old tip of a force-push is not in the clone');
});

test('change detection: a pull request is judged against its base branch', () => {
  const { dir, commit } = scratch();
  commit({ 'scripts/a.mjs': 'a\n', 'docs/index.html': 'x\n' });
  const base = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', '-b', 'feature');
  commit({ 'docs/index.html': 'y\n' });
  assert.equal(detect(dir, base), 'false');
  commit({ 'README.md': 'a root file is not docs/\n' });
  assert.equal(detect(dir, base), 'true');
});

test('change detection: moving a file out of code into docs/ is a code change', () => {
  const { dir, commit } = scratch();
  const source = 'export const answer = 42;\n'.repeat(20);
  commit({ 'scripts/answer.mjs': source, 'docs/index.html': 'x\n' });
  const before = git(dir, 'rev-parse', 'HEAD');
  commit({ 'scripts/answer.mjs': null, 'docs/answer.mjs': source }); // git reports this as a rename, and --name-only then shows the new name only
  assert.equal(detect(dir, before), 'true');
});

test('change detection: a huge code change is not mistaken for docs only (grep -q closing the pipe under pipefail)', () => {
  const { dir, commit } = scratch();
  commit({ 'docs/index.html': 'x\n' });
  const before = git(dir, 'rev-parse', 'HEAD');
  const files = {};
  for (let i = 0; i < 3000; i++) files[`a-first-in-sort-order/generated-file-with-a-long-name-so-the-list-fills-the-pipe-${i}.txt`] = `${i}\n`;
  commit(files);
  assert.equal(detect(dir, before), 'true');
});

// ---------------------------------------------------------------------------------------------
// The two big test modules run in parts (one process each, side by side). A part nobody starts would be a silent loss of tests.
// ---------------------------------------------------------------------------------------------

test('the e2e and state parts are each started by a test file of their own', () => {
  const e2e = read('tests', 'e2e.test.mjs');
  const parts = Object.keys(new Function(`return ${/const PARTS = (\{[\s\S]*?\n\});/.exec(e2e)[1].replace(/\/\/.*$/gm, '')}`)());
  const defaultPart = /const DEFAULT_PART = '(\w+)'/.exec(e2e)[1];
  assert.ok(parts.includes(defaultPart) && parts.length >= 4, `e2e parts: ${parts}`);
  for (const part of parts.filter((p) => p !== defaultPart)) {
    assert.match(read('tests', `e2e-${part}.test.mjs`), new RegExp(`__sedE2ePart = '${part}';\\nawait import\\('\\./e2e\\.test\\.mjs'\\);`), `tests/e2e-${part}.test.mjs starts part "${part}"`);
  }
  const state = read('tests', 'state', 'cases.mjs');
  const starts = JSON.parse(/const PART_STARTS = (\[[\d, ]+\]);/.exec(state)[1]);
  assert.equal(starts[0], 0);
  starts.forEach((_, i) => {
    assert.match(read('tests', `state-${i + 1}.test.mjs`), new RegExp(`__sedStatePart = ${i + 1};\\nawait import\\('\\./state/cases\\.mjs'\\);`), `tests/state-${i + 1}.test.mjs starts part ${i + 1}`);
  });
  assert.equal(fs.existsSync(path.join(ROOT, 'tests', `state-${starts.length + 1}.test.mjs`)), false, 'no state part file without a part');
});
