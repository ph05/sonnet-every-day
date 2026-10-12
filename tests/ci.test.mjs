// Guards the CI workflow files: the test job must provision everything the browser tests need,
// because tests/qa.test.mjs drives a real Chromium and has no skip logic of its own; and the step of
// sync-main.yml that moves `main` is run for real against local remotes (it decides the Pages build request).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/env.mjs';

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
