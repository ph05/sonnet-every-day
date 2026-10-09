// A throwaway repo root (SED_ROOT) for CLI tests: config.json + empty state, optionally a git clone of a
// temp bare remote. Never touches the real state/, docs/ or work/.
import './env.mjs';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './env.mjs';
import { BRANCH, cloneOf, git, makeRemote } from './git.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');
export const SCRIPT = {
  state: path.join(REPO_ROOT, 'scripts', 'state.mjs'),
  heartbeat: path.join(REPO_ROOT, 'scripts', 'heartbeat.mjs'),
};
export const TEST_CONFIG = JSON.parse(fs.readFileSync(path.join(HERE, 'test-config.json'), 'utf8'));
export const DATE = '2026-10-09';

const SEED_STATE = {
  'state/throttle.json': { schema: 1, level: 'balanced', cleanDays: 0, lastChange: null, log: [] },
  'state/history.json': { schema: 1, startDate: DATE, entries: [] },
  'state/carryover.json': { schema: 1, idea: null, savedOn: null, carriedCount: 0 },
};

export function seedFiles(config = TEST_CONFIG) {
  const files = { 'config.json': JSON.stringify(config, null, 2) + '\n', '.gitignore': 'node_modules/\n*.tmp\n' };
  for (const [rel, data] of Object.entries(SEED_STATE)) files[rel] = JSON.stringify(data, null, 2) + '\n';
  files['state/runs/.gitkeep'] = '';
  return files;
}

function writeSeed(root, config) {
  for (const [rel, content] of Object.entries(seedFiles(config))) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
}

function parseOutput(stdout) {
  const text = stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { __unparseable: text };
  }
}

function toolkit(root, extraEnv = {}) {
  const envFor = (env) => ({ ...process.env, SED_ROOT: root, ...extraEnv, ...env });
  const api = {
    root,
    path: (...p) => path.join(root, ...p),
    read: (rel) => fs.readFileSync(path.join(root, rel), 'utf8'),
    readJson: (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')),
    exists: (rel) => fs.existsSync(path.join(root, rel)),
    write(rel, content) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
    },
    runFile: (date = DATE) => `state/runs/${date}.json`,
    run: (date = DATE) => api.readJson(`state/runs/${date}.json`),
    /** Runs `node <script> ...args` synchronously; returns { code, json, stdout, stderr }. */
    cli(script, args, env = {}) {
      const r = spawnSync(process.execPath, [SCRIPT[script] ?? script, ...args], { env: envFor(env), encoding: 'utf8', timeout: 120_000 });
      return { code: r.status, json: parseOutput(r.stdout), stdout: r.stdout, stderr: r.stderr };
    },
    state: (args, env) => api.cli('state', args, env),
    /** Asynchronous variant for racing several processes. */
    cliAsync(script, args, env = {}) {
      return new Promise((resolve) => {
        const child = spawn(process.execPath, [SCRIPT[script] ?? script, ...args], { env: envFor(env) });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('close', (code) => resolve({ code, json: parseOutput(stdout), stdout, stderr }));
      });
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
  return api;
}

/** Plain directory sandbox (no git). */
export function makeSandbox({ config = TEST_CONFIG, env } = {}) {
  const root = tmpDir('sed-sandbox-');
  writeSeed(root, config);
  return toolkit(root, env);
}

/**
 * Git-backed sandbox: a bare remote (main + work branch seeded with config/state), `root` = a clone on the
 * work branch (or on main when workBranch:false, so the first sync must create the branch). cloneB() makes a second working clone, like another session's checkout.
 */
export function makeRepoSandbox({ config = TEST_CONFIG, env, workBranch = true } = {}) {
  const { remote, base } = makeRemote({ files: seedFiles(config), workBranch });
  const root = cloneOf(remote, 'a', workBranch ? BRANCH : 'main');
  const box = toolkit(root, env);
  box.remote = remote;
  box.base = base;
  box.git = (...args) => git(root, ...args);
  box.cloneB = (name = 'b') => {
    const dir = cloneOf(remote, name, BRANCH);
    const other = toolkit(dir, env);
    other.git = (...args) => git(dir, ...args);
    return other;
  };
  box.cleanup = () => fs.rmSync(base, { recursive: true, force: true });
  return box;
}
