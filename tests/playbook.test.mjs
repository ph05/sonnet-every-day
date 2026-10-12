// Regression tests for the operator documents (ops/PLAYBOOK.md, ops/FAILURE_MODES.md, ops/OPERATING.md): every
// claim a recipe makes about the scripts is exercised against the real scripts in a throwaway sandbox, and the
// inline tools of the playbook's appendix are run exactly as printed.
import './helpers/env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeSandbox, makeRepoSandbox, REPO_ROOT } from './helpers/sandbox.mjs';
import { etIso, tmpDir } from './helpers/env.mjs';
import { levelConfigFor, stagingDirs } from '../scripts/lib/runstate.mjs';

const D = '2026-10-09';
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const PLAYBOOK = read('ops/PLAYBOOK.md');
const REAL_CONFIG = JSON.parse(read('config.json'));
// The owner's time-limited budget override (config.budget.ownerOverride) is a live setting, not something these recipes verify:
// while it is active every level below would read the override's level. tests/usage.test.mjs covers the override itself.
const FIXTURE_CONFIG = structuredClone(REAL_CONFIG);
delete FIXTURE_CONFIG.budget.ownerOverride;
const TAXONOMY = read('ops/taxonomy.json');

function section(text, heading) {
  const start = text.indexOf(heading);
  assert.ok(start >= 0, `missing heading ${heading}`);
  const rest = text.slice(start + heading.length);
  const next = rest.search(/\n#{2,3} /);
  return next < 0 ? rest : rest.slice(0, next);
}

function snippet(id) {
  const m = new RegExp(`### ${id} [^\\n]*\\n[\\s\\S]*?\`\`\`bash\\n([\\s\\S]*?)\\n\`\`\``).exec(PLAYBOOK);
  assert.ok(m, `PLAYBOOK.md has no snippet ${id}`);
  const lines = m[1].split('\n');
  assert.match(lines[0], /node --input-type=module - <<'EOF'$/, `${id}: unexpected first line`);
  assert.equal(lines[lines.length - 1], 'EOF', `${id}: heredoc must end with EOF`);
  return lines.slice(1, -1).join('\n');
}

/** Runs one of the playbook's inline programs from the repo root against the data of `box`. */
function runSnippet(box, id, env = {}) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-'], {
    cwd: REPO_ROOT,
    env: { ...process.env, SED_ROOT: box.root, ...env },
    input: snippet(id),
    encoding: 'utf8',
    timeout: 120_000,
  });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* leave null */
  }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

/** A sandbox that carries the real config and taxonomy (the playbook's tools read both). */
function realBox({ git = false } = {}) {
  const box = git ? makeRepoSandbox({ config: FIXTURE_CONFIG }) : makeSandbox({ config: FIXTURE_CONFIG });
  box.write('ops/taxonomy.json', TAXONOMY);
  return box;
}

const at = (hhmm) => etIso(D, hhmm);
const st = (box, args, hhmm) => box.state([...args, '--date', D, '--now', at(hhmm)]);
const must = (box, args, hhmm) => {
  const r = st(box, args, hhmm);
  assert.equal(r.code, 0, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
  return r.json;
};

/** Primary session `sP` walks the pipeline up to (and not including) `until`, finishing each phase. */
function walk(box, until, { session = 'sP', role = 'primary', start = '03:55' } = {}) {
  must(box, ['begin', '--role', role, '--session', session], start);
  const order = ['preflight', 'ideate', 'select', 'spec', 'build', 'qa', 'revise'];
  let minute = 4 * 60;
  for (const phase of order) {
    if (phase === until) break;
    minute += 10;
    const hhmm = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
    must(box, ['phase-start', '--phase', phase, '--session', session], hhmm);
    if (['ideate', 'select', 'spec', 'build', 'qa'].includes(phase)) box.write(`work/${D}/${phase}/DONE.json`, { ok: true, phase });
    must(box, ['phase-done', '--phase', phase, '--note', 'test', '--session', session, '--role', role], hhmm);
  }
}

const ideaWords = ['amber', 'basalt', 'cobalt', 'dune', 'ember', 'fjord', 'garnet', 'harbor', 'indigo', 'jasper', 'kelp', 'lichen'];
function makeIdeas(n) {
  const tax = JSON.parse(TAXONOMY);
  const categories = Object.keys(tax.categories);
  const slots = Object.keys(tax.slots);
  return Array.from({ length: n }, (_, i) => {
    const w = (k) => `${ideaWords[(i + k) % ideaWords.length]}-${ideaWords[(i * 3 + k + 5) % ideaWords.length]}${i}${k}`;
    const scores = Object.fromEntries(['sophistication', 'delight', 'distinctness', 'feasibility', 'timeliness', 'interestFit', 'polishPotential', 'safety'].map((d) => [d, 5 + (i % 4)]));
    return {
      id: `i${String(i + 1).padStart(2, '0')}`,
      title: `Idea number ${w(1)}`,
      pitch: 'A small toy.',
      whyNow: 'Now.',
      origin: { agent: 'pulse', lens: 'hockey-now' },
      fingerprint: {
        category: categories[i % categories.length],
        mechanic: tax.mechanics[i % tax.mechanics.length],
        tone: [tax.tones[0]],
        tech: ['canvas2d'],
        tags: [w(1), w(2), w(3)],
        keywords: [w(4), w(5), w(6)],
        slot: slots[i % slots.length],
        political: false,
      },
      research: { summary: 's', sources: [{ title: 'S', url: `https://example.org/${i}`, note: 'n', verified: true }], facts: [], inspirations: [] },
      design: { coreLoop: 'loop', sophisticationHooks: ['x'], dataNeeds: 'bundled', scopeForOneDay: 'one screen', risks: ['r'] },
      durable: i % 2 === 0,
      scores,
      total: Object.values(scores).reduce((a, b) => a + b, 0),
      noveltyCheck: { ok: true, conflicts: [] },
    };
  });
}
const ideasDoc = (n) => ({ schema: 1, date: D, lenses: [], carryoverIn: null, ideas: makeIdeas(n), chosenId: null, carryoverOutId: null });

// ---------------------------------------------------------------------------------------------
// finding 1: the fallback spend estimate must leave room for a whole day at every level
// ---------------------------------------------------------------------------------------------

const SHARES = JSON.parse(/```json spend-shares\n([\s\S]*?)\n```/.exec(PLAYBOOK)?.[1] ?? 'null');

test('spend shares: the fallback estimate of a whole day stays under the usable cap at every level', () => {
  assert.ok(SHARES?.full && SHARES?.compact, 'PLAYBOOK §6.5 must carry the machine-readable spend-shares block');
  for (const level of Object.keys(REAL_CONFIG.budget.levels)) {
    const lc = levelConfigFor(REAL_CONFIG, level);
    const days = {
      compact: ['ideate', 'select', 'spec', 'build', 'qa', 'package'],
      ...(lc.forceTier === 2 ? {} : { full: ['ideate', 'select', 'spec', 'build', 'qa', 'package'], 'full with revise': ['ideate', 'select', 'spec', 'build', 'qa', 'revise', 'package'] }),
    };
    for (const [kind, phases] of Object.entries(days)) {
      const column = SHARES[kind === 'compact' ? 'compact' : 'full'];
      let total = 0;
      for (const phase of phases) {
        total += Math.round(column[phase] * lc.capTokens);
        assert.ok(total <= lc.capTokens, `${level} ${kind} day: overCap after ${phase} (${total} > ${lc.capTokens})`);
      }
      assert.ok(total >= 0.4 * lc.capTokens, `${level} ${kind} day: the estimate (${total}) is implausibly low against the cap ${lc.capTokens}`);
    }
  }
});

test('spend shares: the formula this replaced really did overrun minimal and lean (the test has teeth)', () => {
  const old = { ideate: 700000, select: 250000, spec: 300000, build: 800000, qa: 300000 };
  const oldT2 = { ...old, build: 450000 };
  const estimate = (defaults, level) => Object.fromEntries(Object.entries(defaults).map(([p, v]) => [p, Math.round((v * REAL_CONFIG.budget.levels[level].outputTokens) / 3000000) + 20000]));
  const sum = (e) => Object.values(e).reduce((a, b) => a + b, 0);
  assert.ok(sum(estimate(oldT2, 'minimal')) > levelConfigFor(REAL_CONFIG, 'minimal').capTokens);
  assert.ok(sum(estimate(old, 'lean')) > levelConfigFor(REAL_CONFIG, 'lean').capTokens);
});

for (const [level, kind] of [['minimal', 'compact'], ['lean', 'full'], ['balanced', 'full']]) {
  test(`spend shares: ${level} day with ${kind} estimates is never overCap according to state.mjs`, () => {
    const box = realBox();
    try {
      must(box, ['throttle', 'set', '--level', level, '--reason', 'test'], '03:50');
      const begin = must(box, ['begin', '--role', 'primary', '--session', 'sP'], '03:55');
      assert.equal(begin.levelConfig.capTokens, levelConfigFor(REAL_CONFIG, level).capTokens);
      if (level === 'minimal') assert.equal(begin.targetTier, 2, 'minimal forces a compact day');
      const phases = ['ideate', 'select', 'spec', 'build', 'qa', ...(kind === 'full' ? ['revise'] : []), 'package'];
      for (const phase of phases) {
        const r = must(box, ['spend', '--tokens', String(Math.round(SHARES[kind][phase] * begin.levelConfig.capTokens)), '--calls', '8', '--phase', phase, '--session', 'sP'], '04:10');
        assert.equal(r.overCap, false, `${level}: overCap after ${phase}: ${JSON.stringify(r.spend)}`);
      }
    } finally {
      box.cleanup();
    }
  });
}

// ---------------------------------------------------------------------------------------------
// finding 2: the backup closer
// ---------------------------------------------------------------------------------------------

test('backup closer: the second closer session (09:37) takes over a dead closer, and force-degrades a closer that is still beating', () => {
  const box = realBox();
  try {
    walk(box, 'select');
    // The primary is alive but stuck in `select` (a phase before qa gets no grace, and 90 minutes in one phase is hung).
    must(box, ['beat', '--role', 'primary', '--session', 'sP', '--phase', 'select'], '08:40');
    const c1 = must(box, ['begin', '--role', 'closer', '--session', 'closer-1'], '08:47');
    assert.equal(c1.action, 'force-degrade');
    assert.equal(c1.targetTier, 3);
    // closer-1's container dies here. Fifty minutes later its lease is stale (limit 35), so the backup takes over normally.
    const c2 = must(box, ['begin', '--role', 'closer', '--session', 'closer-2'], '09:37');
    assert.equal(c2.action, 'takeover');
    assert.equal(c2.targetTier, 3);
    assert.equal(c2.lease.session, 'closer-2');
    const status = must(box, ['status'], '09:39');
    assert.equal(status.lease.holder, 'closer');
    assert.equal(typeof status.lease.ageMinutes, 'number', 'the closer wait rule of PLAYBOOK §5.4 reads lease.ageMinutes');
    assert.equal(status.lease.session, 'closer-2');
    // closer-1 comes back to life and begins again: past graceUntil a fresh lease of another closer is simply displaced
    const c1again = must(box, ['begin', '--role', 'closer', '--session', 'closer-1'], '09:46');
    assert.equal(c1again.action, 'force-degrade');
  } finally {
    box.cleanup();
  }
  // a closer that is still beating when the backup arrives is not waited for by the state script (the playbook waits, §5.4 step 2)
  const alive = realBox();
  try {
    walk(alive, 'select');
    must(alive, ['beat', '--role', 'primary', '--session', 'sP', '--phase', 'select'], '08:40');
    must(alive, ['begin', '--role', 'closer', '--session', 'closer-1'], '08:47');
    must(alive, ['beat', '--role', 'closer', '--session', 'closer-1', '--phase', 'package'], '09:35');
    const c2 = must(alive, ['begin', '--role', 'closer', '--session', 'closer-2'], '09:37');
    assert.equal(c2.action, 'force-degrade');
    assert.equal(must(alive, ['status'], '09:38').lease.ageMinutes < 8, true);
  } finally {
    alive.cleanup();
  }
});

test('backup closer: the documents describe the second routine consistently', () => {
  const closer = section(PLAYBOOK, '### 5.4 closer');
  assert.match(closer, /backup closer/i);
  assert.match(closer, /09:37/);
  assert.match(closer, /ageMinutes/);
  assert.match(read('ops/prompts/README.md'), /closer backup[^\n]*`37 9 \* \* \*`[^\n]*`closer\.md`/);
  assert.match(read('ops/OPERATING.md'), /09:37[^\n]*closer backup/);
  assert.match(read('ops/OPERATING.md'), /`37 9 \* \* \*`/);
  assert.match(read('ops/OPERATING.md'), /`47 8 \* \* \*`/);
  const fm = read('ops/FAILURE_MODES.md');
  assert.match(fm, /^\| FM-81 \|[^\n]*closer[^\n]*backup closer/im);
  assert.match(fm, /FM-75[^\n]*09:37/);
});

// ---------------------------------------------------------------------------------------------
// routines, prompt files and the Pages setup (F12): what the routines are called, how a prompt edit reaches them, what the owner is told
// ---------------------------------------------------------------------------------------------

test('bootstrap: step 2 keeps unpushed commits with ONE conditional command, a backup branch only when there is something to keep', () => {
  const boot = read('ops/prompts/_bootstrap.md');
  const cmd = /with this single command[\s\S]*?: `(cd \/home\/user\/sonnet-every-day && \{[^`]*\})`/.exec(boot)?.[1];
  assert.ok(cmd, 'the bootstrap has its one-command backup step');
  assert.ok(!/`git branch backup-\$\(date \+%s\) HEAD`/.test(boot), 'the unconditional branch command is not quoted on its own any more');
  const base = tmpDir('sed-bootstrap-backup-');
  const run = (c) => spawnSync('bash', ['-c', c], { cwd: base, encoding: 'utf8' });
  const git = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const work = REAL_CONFIG.workBranch;
  git(base, 'init', '-q', '--bare', 'remote.git');
  git(base, 'clone', '-q', 'remote.git', 'clone');
  const clone = path.join(base, 'clone');
  fs.writeFileSync(path.join(clone, 'a.txt'), 'one\n');
  git(clone, 'add', '-A');
  git(clone, 'commit', '-q', '-m', 'one');
  git(clone, 'push', '-q', 'origin', 'main');
  git(clone, 'checkout', '-q', '-b', work);
  git(clone, 'push', '-q', '-u', 'origin', work);
  const backups = (dir) => git(dir, 'branch', '--list', 'backup-*').split('\n').map((l) => l.trim()).filter(Boolean);
  const at = (dir) => cmd.replaceAll('/home/user/sonnet-every-day', dir);

  // everything is pushed: nothing to keep, nothing created, and a quiet exit 0
  let r = run(at(clone));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '');
  assert.deepEqual(backups(clone), []);

  // an unpushed commit: exactly one backup branch, at that commit
  fs.writeFileSync(path.join(clone, 'a.txt'), 'two\n');
  git(clone, 'commit', '-q', '-am', 'two, never pushed');
  r = run(at(clone));
  assert.equal(r.status, 0, r.stderr);
  const made = backups(clone);
  assert.equal(made.length, 1, `one backup branch, got ${made}`);
  assert.equal(git(clone, 'rev-parse', made[0]), git(clone, 'rev-parse', 'HEAD'));
  assert.equal(run(at(clone)).status, 0, 'a name already taken (same second) must not stop the bootstrap');

  // a clone of another branch has never seen the work branch: nothing to compare with, nothing created
  git(base, 'clone', '-q', '--single-branch', '--branch', 'main', 'remote.git', 'other');
  const other = path.join(base, 'other');
  fs.writeFileSync(path.join(other, 'b.txt'), 'local\n');
  git(other, 'add', '-A');
  git(other, 'commit', '-q', '-m', 'local on main');
  r = run(at(other));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(backups(other), []);

  // no clone at all: the step fails at `cd`, which is where the bootstrap's "directory does not exist" branch takes over
  assert.notEqual(run(at(path.join(base, 'missing'))).status, 0);
});

test('routines: the README table carries the names the routines really have, and its print recipe renders every stored prompt', () => {
  const readme = read('ops/prompts/README.md');
  const s = REAL_CONFIG.schedule;
  const escape = (t) => t.replace(/[()]/g, '\\$&');
  for (const [role, name] of [
    ['primary', `Sonnet Every Day: primary (${s.primary} ET)`],
    ['wdA', `Sonnet Every Day: watchdog A (${s.watchdogA} ET)`],
    ['wdB', `Sonnet Every Day: watchdog B (${s.watchdogB} ET)`],
    ['closer', `Sonnet Every Day: closer (${s.closer} ET)`],
    ['closerBackup', `Sonnet Every Day: closer backup (${s.closerBackup} ET)`],
  ]) assert.match(readme, new RegExp(`^\\| ${role} \\| ${escape(name)} \\|`, 'm'), `${role} is called "${name}" (routine and session)`);
  assert.match(readme, /^\| manual \|[^\n]*Sonnet Every Day: manual run \(button\)[^\n]*Sonnet Every Day: manual operator \(ad hoc runs, demo\)[^\n]*`manual\.md`/m);
  assert.match(read('ops/OPERATING.md'), /Sonnet Every Day: manual run \(button\)/);
  assert.ok(!/stays empty until someone records them/.test(read('ops/OPERATING.md')), 'state/routines.json already holds every trigger id');
  const routines = JSON.parse(read('state/routines.json'));
  assert.match(routines.note, /cse_/, 'the registry explains the cse_ form of a session id');
  for (const id of Object.values(routines.sessions)) assert.match(id, /^session_/);

  // the recipe that prints a routine's prompt (what update_trigger must be given after an edit) runs and renders every prompt file
  const recipe = /```\n(node --input-type=module -e "[^\n]*" primary\.md)\n```/.exec(readme)?.[1];
  assert.ok(recipe, 'ops/prompts/README.md has the print recipe');
  assert.match(readme, /update_trigger/);
  // ...and the listing that pairs every trigger id with its prompt file agrees with the table above and with the registry
  const listing = /```\n(node --input-type=module -e "[^\n]*console\.log\(role\.padEnd[^\n]*")\n```/.exec(readme)?.[1];
  assert.ok(listing, 'ops/prompts/README.md has the listing command');
  const listed = spawnSync('bash', ['-c', listing], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  const rows = listed.stdout.trim().split('\n').map((line) => line.trim().split(/\s+/));
  assert.deepEqual(rows.map((r) => r[0]), ['primary', 'wdA', 'wdB', 'closer', 'closerBackup', 'manualButton']);
  const tableFile = Object.fromEntries([...readme.matchAll(/^\| (primary|wdA|wdB|closer|closerBackup|manual) \|[^\n]*\| `([\w-]+\.md)`/gm)].map((m) => [m[1] === 'manual' ? 'manualButton' : m[1], m[2]]));
  for (const [role, id, file] of rows) {
    assert.equal(id, routines.triggers[role], `${role}: the trigger id is the one in state/routines.json`);
    assert.match(id, /^trig_/);
    assert.equal(file, tableFile[role], `${role}: the prompt file is the one in the table`);
    assert.ok(fs.existsSync(path.join(REPO_ROOT, 'ops/prompts', file)), `${file} exists`);
  }
  const boot = read('ops/prompts/_bootstrap.md').trimEnd();
  for (const file of ['primary.md', 'watchdog-a.md', 'watchdog-b.md', 'closer.md', 'manual.md']) {
    const r = spawnSync('bash', ['-c', recipe.replace(/ primary\.md$/, ` ${file}`)], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(r.status, 0, `${file}: ${r.stderr}`);
    const source = read(`ops/prompts/${file}`).trimEnd();
    assert.ok(source.includes('{{BOOTSTRAP}}'), `${file} has the slot`);
    assert.ok(!r.stdout.includes('{{'), `${file}: no placeholder is left`);
    assert.ok(r.stdout.startsWith('ultracode\n\n'), `${file}: the prompt starts with ultracode`);
    assert.ok(r.stdout.includes(boot), `${file}: the whole bootstrap is inside`);
    assert.equal(r.stdout.length, source.length - '{{BOOTSTRAP}}'.length + boot.length, `${file}: nothing else changed`);
  }
});

test('docs: no stale word about the Pages source, the deadman Action, agent slots or the push rate remains, and the Pages fix is written down', () => {
  const problems = [];
  const files = ['README.md', 'ops/OPERATING.md', 'ops/FAILURE_MODES.md', 'ops/PLAYBOOK.md', 'ops/CONTRACT.md', 'ops/prompts/README.md', 'ops/prompts/_bootstrap.md'];
  const stale = [
    [/\bdormant\b/i, 'the deadman Action is not dormant: main follows the work branch (sync-main)'],
    [/activate the deadman/i, 'nothing has to be merged to activate the deadman Action'],
    [/(?:Pages|Deploy from a branch)[^\n]{0,120}`claude\/sonnet-every-day`[^\n]{0,40}`\/docs`/, 'the Pages source is main, folder /docs'],
    [/work branch[^\n]{0,60}works too/i, 'Pages must not be pointed at the work branch (a build per push)'],
    [/every push to the work branch starts a (?:GitHub )?Pages build/i, 'Pages reads main, which sync-main moves only for docs pushes'],
    [/Workflows use pools of 8/, 'a Workflow pool is args.maxAgents wide (2 on the 4-CPU container)'],
    [/use pools of 8\b/, 'a Workflow pool is min(8, args.maxAgents) wide'],
  ];
  for (const file of files) {
    read(file).split('\n').forEach((line, i) => {
      for (const [re, why] of stale) if (re.test(line)) problems.push(`${file}:${i + 1}: ${why}: ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(problems, []);

  // Pages points at main + /docs and the owner can fix the folder in one click
  const operating = read('ops/OPERATING.md');
  const pages = section(operating, '## Turn on GitHub Pages (once)');
  assert.match(pages, /Branch `main`, and in the second dropdown the folder \*\*`\/docs`\*\*/);
  assert.match(pages, /The one-click fix when the site shows the README/);
  assert.match(pages, /What you see if the folder is wrong/);
  assert.match(pages, /`\/ \(root\)`/);
  assert.match(read('README.md'), /the folder is `\/ \(root\)`/);
  assert.match(read('ops/FAILURE_MODES.md'), /^\| FM-65 \|[^\n]*`\/ \(root\)`[^\n]*`main` > `\/docs` > Save/m);

  // the deadman's schedule is a best-effort one (2026-10-11: both runs about 4.5 hours late)
  assert.match(section(operating, '## Merge the branch to `main`'), /best-effort basis: on 2026-10-11 the two deadman runs began at 18:25 and 19:09 UTC, about 4\.5 hours late/);
  assert.match(read('ops/FAILURE_MODES.md'), /^\| FM-75 \|[^\n]*best-effort[^\n]*4\.5 hours late/m);
});

test('config: the models block is documented as unread, and is unread; the kaizen header quotes the real budgets', () => {
  assert.equal(typeof REAL_CONFIG._note_models, 'string');
  assert.match(REAL_CONFIG._note_models, /nothing reads the models block/);
  const listJs = (dir) => fs.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    return e.isDirectory() ? listJs(rel) : /\.m?js$/.test(e.name) ? [rel] : [];
  });
  const readers = [];
  for (const file of [...listJs('scripts'), ...listJs('ops/workflows')]) {
    read(file).split('\n').forEach((line, i) => {
      if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
      if (/\.models\b|\[\s*['"]models['"]\s*\]|[{,]\s*models\s*[,}=]/.test(line.split('//')[0])) readers.push(`${file}:${i + 1}: ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(readers, [], 'something reads config.models now: drop the note in config.json (_note_models) or the reader');

  const head = read('ops/workflows/kaizen.js').split('\n').slice(0, 25).join('\n');
  assert.match(head, /Pass phaseBudgetMinutes below config\.phaseStuckMinutes \(90\) minus a margin/);
  assert.equal(REAL_CONFIG.phaseStuckMinutes, 90);
  const quoted = /config\.phaseBudgetMinutes\.kaizen is (\d+)/.exec(head)?.[1];
  assert.equal(Number(quoted), REAL_CONFIG.phaseBudgetMinutes.kaizen, 'the header quotes the budget config.json has');
  assert.ok(REAL_CONFIG.phaseBudgetMinutes.kaizen < REAL_CONFIG.phaseStuckMinutes, 'below the stuck limit, as the header asks');
  const handed = /hand this workflow phaseBudgetMinutes (\d+)/.exec(head)?.[1];
  assert.match(PLAYBOOK, new RegExp(`phaseBudgetMinutes: ${handed}\\b`), 'the playbook hands the workflow the budget the header names');
});

// ---------------------------------------------------------------------------------------------
// finding 3: untrusted text never reaches a shell line
// ---------------------------------------------------------------------------------------------

test('shell injection: no documented command line pastes an idea title or pitch inside quotes', () => {
  const problems = [];
  for (const file of ['ops/PLAYBOOK.md', 'ops/FAILURE_MODES.md', 'ops/OPERATING.md']) {
    read(file).split('\n').forEach((line, i) => {
      if (!/node scripts\//.test(line)) return;
      for (const m of line.matchAll(/"([^"]*)"/g)) {
        if (/<(title|pitch|idea title|summary|detail from [a-z ]+)>/i.test(m[1])) problems.push(`${file}:${i + 1}: untrusted placeholder in a quoted argument: ${m[0]}`);
      }
      const title = /--title\s+("\$\(cat [^)]+\)"|\S+)/.exec(line);
      if (title && !/^"\$\(cat [^)]+\)"$/.test(title[1])) problems.push(`${file}:${i + 1}: --title must be passed as "$(cat <file>)", got ${title[1]}`);
    });
  }
  assert.deepEqual(problems, []);
  assert.match(PLAYBOOK, /^11\. \*\*No untrusted text in a shell line\.\*\*/m);
  assert.match(section(PLAYBOOK, '### 8.3 select'), /Write tool/);
});

test('shell injection: the documented "$(cat file)" pattern passes a hostile title to choose verbatim and runs nothing', () => {
  const box = realBox();
  try {
    walk(box, 'spec');
    const marker = path.join(box.root, 'PWNED');
    const hostile = `x" $(touch ${marker}) \`touch ${marker}\` "; touch ${marker}; echo "`;
    box.write(`work/${D}/tmp/title.txt`, hostile);
    const script = `node "${path.join(REPO_ROOT, 'scripts', 'state.mjs')}" choose --idea-id i04 --slug hostile-title --title "$(cat work/${D}/tmp/title.txt)" --session sP --date ${D} --now ${at('05:00')}`;
    const r = spawnSync('bash', ['-c', script], { cwd: box.root, env: { ...process.env, SED_ROOT: box.root }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(fs.existsSync(marker), false, 'the hostile title executed a command');
    assert.equal(JSON.parse(r.stdout).chosen.title, hostile);
  } finally {
    box.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// finding 4: a compact spec must reach build, qa and packaging
// ---------------------------------------------------------------------------------------------

test('compact spec: the workflows really do derive their mode from args, so the playbook must carry spec\'s decision', () => {
  const spec = read('ops/workflows/spec.js');
  assert.match(spec, /compact: USE_COMPACT,\s*\n\s*tier: BUILD_TIER,\s*\n\s*builders:/, 'spec must return compact and tier');
  // a clean lint writes spec/DONE.json from its args file (the selfcheck asserts the file); a stalled spec keeps them in PROGRESS.json
  assert.match(spec, /lintArgs = \{ tier: BUILD_TIER, compact: USE_COMPACT,/, 'the lint that writes spec/DONE.json gets compact and tier');
  assert.match(spec, /const marker = \{ phase: 'spec', ok: true, date, ideaId: a\.done\.ideaId, tier: Number\(tierArg\), compact,/, 'spec/DONE.json must hold compact and tier');
  assert.match(spec, /compact: USE_COMPACT, tier: BUILD_TIER, minOwnLoc: MIN_LOC/, 'spec/PROGRESS.json holds the decision before the architect starts');
  assert.match(spec, /USE_COMPACT = COMPACT \|\| SCOPE_CUT \|\| room\(\) < 450000/, 'spec still downgrades itself');
  for (const file of ['build', 'qa']) {
    assert.match(read(`ops/workflows/${file}.js`), /const COMPACT = typeof A\.compact === 'boolean' \? A\.compact : TIER === 2;/, `${file}.js takes compact only from args`);
    assert.ok(!read(`ops/workflows/${file}.js`).includes('spec/DONE.json'), `${file}.js does not read spec/DONE.json: the orchestrator must forward it`);
  }
  const text = section(PLAYBOOK, '### 8.4 spec');
  for (const needle of [/compact/, /tier/, /spec\/DONE\.json/, /scope-cut/, /`build` and `qa`/, /ack-directive/]) assert.match(text, needle);
  assert.match(section(PLAYBOOK, '### 8.5 build'), /compact/);
  assert.match(section(PLAYBOOK, '### 8.6 qa'), /`tier` and `compact`/);
});

test('compact spec: the scope-cut directive the playbook issues after a compact spec raises the target tier and keeps every later phase', () => {
  const box = realBox();
  try {
    walk(box, 'build');
    const before = must(box, ['status'], '05:20');
    assert.equal(before.targetTier, 1);
    const d = must(box, ['directive', '--kind', 'scope-cut', '--tier', '2', '--by', 'primary'], '05:21');
    assert.equal(d.targetTier, 2);
    must(box, ['ack-directive', '--kind', 'scope-cut'], '05:21');
    must(box, ['event', '--kind', 'degrade', '--msg', 'spec went compact: mini-spec, tier 2 from here', '--by', 'primary'], '05:21');
    const after = must(box, ['status'], '05:22');
    assert.equal(after.targetTier, 2);
    assert.equal(after.directives.length, 0, 'acked');
    // a later takeover keeps the decision
    const takeover = must(box, ['begin', '--role', 'wdA', '--session', 'sA'], '06:15');
    assert.equal(takeover.action, 'takeover');
    assert.ok(takeover.targetTier >= 2);
  } finally {
    box.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// finding 5: a short ideate shortlist is kept, accepted when it is good enough, and never wiped
// ---------------------------------------------------------------------------------------------

test('partial shortlist: A1 demands exactly 10 by default and accepts 7 to 10 well-formed ideas with PARTIAL=1', () => {
  const box = realBox();
  try {
    const check = (n, env) => {
      box.write(`work/${D}/ideas/shortlist.json`, ideasDoc(n));
      return runSnippet(box, 'A1', { FILE: `work/${D}/ideas/shortlist.json`, D, MODE: 'shortlist', ...env });
    };
    const ten = check(10, {});
    assert.equal(ten.code, 0, ten.stdout);
    assert.equal(ten.json.partial, false);
    const strict = check(8, {});
    assert.equal(strict.code, 1);
    assert.match(strict.json.problems.join('|'), /expected exactly 10 ideas, found 8/);
    for (const n of [7, 8, 9, 10]) {
      const r = check(n, { PARTIAL: '1' });
      assert.equal(r.code, 0, `${n} ideas: ${r.stdout}`);
      assert.deepEqual([r.json.ok, r.json.count, r.json.partial], [true, n, true]);
    }
    const few = check(6, { PARTIAL: '1' });
    assert.equal(few.code, 1);
    assert.match(few.json.problems.join('|'), /expected 7 to 10 ideas, found 6/);
    assert.equal(check(11, { PARTIAL: '1' }).code, 1);
    // PARTIAL does not loosen any other check
    const bad = ideasDoc(8);
    bad.ideas[2].fingerprint.category = 'not-a-category';
    box.write(`work/${D}/ideas/shortlist.json`, bad);
    assert.equal(runSnippet(box, 'A1', { FILE: `work/${D}/ideas/shortlist.json`, D, MODE: 'shortlist', PARTIAL: '1' }).code, 1);
    // the final document of an accepted partial day also passes
    const final = ideasDoc(8);
    final.chosenId = 'i04';
    final.carryoverOutId = 'i03';
    final.rationale = 'because';
    box.write(`state/ideas/${D}.json`, final);
    const f = runSnippet(box, 'A1', { FILE: `state/ideas/${D}.json`, D, MODE: 'final', SLUG: 'a-new-slug', PARTIAL: '1' });
    assert.equal(f.code, 0, f.stdout);
  } finally {
    box.cleanup();
  }
});

test('partial shortlist: the premises of the playbook\'s rule hold in the scripts', () => {
  const ideate = read('ops/workflows/ideate.js');
  assert.match(ideate, /const written = chosen\.length \? await writeShortlist\(chosen, notes, degraded\) : null;/, 'a short shortlist is still written to disk');
  assert.match(ideate, /if \(complete\) \{/, 'ideate/DONE.json is only written for a complete shortlist');
  assert.match(read('ops/workflows/select.js'), /instead of 10: judging what exists/, 'select tolerates a short pool');
  assert.deepEqual(stagingDirs('ideate'), ['ideate', 'ideas'], 'a takeover wipes ideate and ideas, so the first attempt must be kept elsewhere');
  const text = section(PLAYBOOK, '### 6.7 A Workflow failed');
  for (const needle of [/Ideate came back short/, /PARTIAL=1/, /ideas\.attempt1/, /7 to 9/, /never deleted|never delete/]) assert.match(text, needle);
  assert.ok(!/rm -rf work\/<D>\/ideas(\s|`|$)/m.test(text.replace(/mv work\/<D>\/ideas work\/<D>\/ideas\.attempt1/g, '')) || /rm -rf work\/<D>\/ideas && cp -R/.test(text), 'the only rm of the ideas directory is the restore step');
});

test('partial shortlist: a takeover wipes work/<D>/ideas but leaves the preserved first attempt', () => {
  const box = realBox();
  try {
    must(box, ['begin', '--role', 'primary', '--session', 'sP'], '03:55');
    must(box, ['phase-start', '--phase', 'preflight', '--session', 'sP'], '03:56');
    must(box, ['phase-done', '--phase', 'preflight', '--session', 'sP', '--role', 'primary'], '04:00');
    must(box, ['phase-start', '--phase', 'ideate', '--session', 'sP'], '04:01');
    box.write(`work/${D}/ideas/shortlist.json`, ideasDoc(8));
    box.write(`work/${D}/ideas.attempt1/shortlist.json`, ideasDoc(8));
    const t = must(box, ['begin', '--role', 'wdA', '--session', 'sA'], '05:32');
    assert.equal(t.action, 'takeover');
    assert.equal(t.resumePhase, 'ideate');
    assert.equal(box.exists(`work/${D}/ideas/shortlist.json`), false, 'staging of the interrupted phase is wiped');
    assert.equal(box.exists(`work/${D}/ideas.attempt1/shortlist.json`), true, 'the preserved attempt survives');
  } finally {
    box.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// finding 6: a sync conflict is terminal; recipe R1 recovers without losing the operator's own run-file changes
// ---------------------------------------------------------------------------------------------

test('R1: the run-file diff (A6) finds exactly what a taken-remote resolution drops, and the documented commands restore it', () => {
  const box = realBox();
  try {
    walk(box, 'select');
    const remoteView = fs.readFileSync(box.path(box.runFile()), 'utf8'); // the other side: preflight and ideate only
    // the operator's own later work
    must(box, ['phase-start', '--phase', 'select', '--session', 'sP'], '05:00');
    box.write(`work/${D}/select/DONE.json`, { ok: true });
    must(box, ['spend', '--tokens', '123000', '--calls', '9', '--phase', 'select', '--session', 'sP'], '05:05');
    must(box, ['choose', '--idea-id', 'i04', '--slug', 'lost-and-found', '--title', 'Lost And Found', '--session', 'sP'], '05:06');
    must(box, ['event', '--kind', 'error', '--msg', 'a scout returned garbage once', '--by', 'primary'], '05:07');
    must(box, ['directive', '--kind', 'scope-cut', '--tier', '2', '--by', 'primary'], '05:08');
    must(box, ['phase-done', '--phase', 'select', '--note', 'chose lost-and-found', '--session', 'sP', '--role', 'primary'], '05:10');
    const saved = path.join(box.root, 'saved-run.json'); // R1 step 0 saves this outside the repo (here: next to it)
    fs.copyFileSync(box.path(box.runFile()), saved);

    // R1 step 2 on the run file: take the remote version
    fs.writeFileSync(box.path(box.runFile()), remoteView);
    const lost = runSnippet(box, 'A6', { D, LOCAL: saved });
    assert.equal(lost.code, 1, lost.stdout);
    assert.deepEqual(lost.json.missingPhases.map((p) => p.phase), ['select']);
    assert.equal(lost.json.chosenMissing.slug, 'lost-and-found');
    assert.equal(lost.json.spendMissing.outputTokens, 123000);
    assert.equal(lost.json.spendMissing.byPhase.select.outputTokens, 123000);
    assert.ok(lost.json.eventsMissing.some((e) => e.kind === 'error'));
    assert.deepEqual(lost.json.directivesMissing.map((d) => [d.kind, d.tier]), [['scope-cut', 2]]);

    // R1 step 3 checklist, in the documented order and with the documented flags
    const sel = lost.json;
    const t = '05:30';
    must(box, ['begin', '--role', 'primary', '--session', 'sP'], t); // "if a command answers lease is held by: begin first": harmless when it is yours
    for (const p of sel.missingPhases) must(box, ['phase-start', '--phase', p.phase, '--session', 'sP'], t), must(box, ['phase-done', '--phase', p.phase, '--note', 're-applied after sync conflict', '--session', 'sP', '--role', 'primary'], t);
    must(box, ['choose', '--idea-id', sel.chosenMissing.ideaId, '--slug', sel.chosenMissing.slug, '--title', 'Lost And Found', '--session', 'sP'], t);
    for (const [phase, v] of Object.entries(sel.spendMissing.byPhase)) must(box, ['spend', '--tokens', String(v.outputTokens), '--calls', String(v.agentCalls), '--phase', phase, '--session', 'sP'], t);
    for (const e of sel.eventsMissing.filter((x) => ['error', 'degrade', 'rate-limit', 'budget', 'takeover'].includes(x.kind))) must(box, ['event', '--kind', e.kind, '--msg', 'R1: re-applied', '--by', 'primary'], t);
    for (const d of sel.directivesMissing) must(box, ['directive', '--kind', d.kind, '--tier', String(d.tier), '--by', 'primary'], t);
    // the diff compares events by exact text, so the re-applied ones read as "missing" until the operator accepts them; everything else must be restored
    const again = runSnippet(box, 'A6', { D, LOCAL: saved });
    assert.deepEqual(again.json.missingPhases, []);
    assert.equal(again.json.chosenMissing, null);
    assert.equal(again.json.spendMissing, null);
    assert.deepEqual(again.json.directivesMissing, []);
    const run = JSON.parse(fs.readFileSync(box.path(box.runFile()), 'utf8'));
    assert.deepEqual(run.phasesDone.map((p) => p.phase), ['preflight', 'ideate', 'select']);
    assert.equal(run.chosen.slug, 'lost-and-found');
  } finally {
    box.cleanup();
  }
});

test('R1: a conflict never clears by retrying; the recipe\'s rebase steps resolve it and the next sync pushes without losing either side', () => {
  const box = realBox({ git: true });
  try {
    const sync = (b, msg, hhmm) => b.state(['sync', '-m', msg, '--no-sleep', '--date', D, '--now', at(hhmm)]);
    must(box, ['begin', '--role', 'primary', '--session', 'sP'], '03:55');
    assert.equal(sync(box, 'begin', '03:56').json.ok, true);
    const other = box.cloneB();
    for (const p of ['preflight', 'ideate']) {
      must(box, ['phase-start', '--phase', p, '--session', 'sP'], '04:10');
      must(box, ['phase-done', '--phase', p, '--note', 'x', '--session', 'sP', '--role', 'primary'], '04:20');
    }
    box.write('state/carryover.json', { schema: 1, idea: null, savedOn: 'a-side', carriedCount: 0 });
    assert.equal(sync(box, 'A work', '04:21').json.ok, true);

    other.write('state/carryover.json', { schema: 1, idea: null, savedOn: 'b-side', carriedCount: 0 });
    must(other, ['directive', '--kind', 'scope-cut', '--tier', '2', '--by', 'wdA'], '05:33');
    const first = sync(other, 'B work', '05:34');
    assert.equal(first.code, 1);
    assert.equal(first.json.reason, 'conflict');
    assert.deepEqual(first.json.conflicts, ['state/carryover.json']);
    const again = sync(other, 'B work again', '05:35');
    assert.equal(again.json.reason, 'conflict', 'running sync again cannot clear a conflict');

    // R1 step 0 and 2, literally as documented
    const saved = path.join(other.root, 'saved-run.json');
    fs.writeFileSync(saved, other.git('show', `HEAD:state/runs/${D}.json`));
    other.git('fetch', 'origin', 'claude/sonnet-every-day');
    let stopped = false;
    try {
      other.git('rebase', 'origin/claude/sonnet-every-day');
    } catch {
      stopped = true;
    }
    assert.ok(stopped, 'the manual rebase stops on the same conflict');
    for (const f of other.git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean)) {
      assert.equal(f, 'state/carryover.json');
      other.git('checkout', '--ours', '--', f);
      other.git('add', f);
    }
    other.git('-c', 'core.editor=true', 'rebase', '--continue');
    const diff = runSnippet(other, 'A6', { D, LOCAL: saved });
    assert.equal(diff.code, 0, `nothing of the run file was lost: ${diff.stdout}`);
    const pushed = sync(other, 'sed: resolved sync conflict', '05:40');
    assert.equal(pushed.code, 0, pushed.stdout);
    assert.equal(pushed.json.pushed, true);
    const remoteRun = JSON.parse(box.git('--git-dir', box.remote, 'show', `refs/heads/claude/sonnet-every-day:state/runs/${D}.json`));
    assert.deepEqual(remoteRun.phasesDone.map((p) => p.phase), ['preflight', 'ideate']);
    assert.ok(remoteRun.directives.some((d) => d.kind === 'scope-cut'));
  } finally {
    box.cleanup();
  }
});

test('R1 and §10.4: the documents say a conflict is terminal and point to the checklist', () => {
  const r1 = section(read('ops/FAILURE_MODES.md'), '### R1.');
  for (const needle of [/git show HEAD:state\/runs/, /A6/, /phase-done/, /choose/, /spend/, /event/, /directive/, /status --date <D>/, /--theirs/]) assert.match(r1, needle);
  const publish = section(PLAYBOOK, '### 10.4 Publish sequence');
  assert.match(publish, /conflict[^\n]*do not retry/i);
  assert.match(publish, /R1/);
  assert.match(section(PLAYBOOK, '### 6.1'), /terminal/);
  assert.match(section(PLAYBOOK, '### 6.8'), /never clears by retrying/);
  assert.match(read('ops/FAILURE_MODES.md'), /^\| FM-17 \|[^\n]*terminal/m);
});

// ---------------------------------------------------------------------------------------------
// finding 7: a takeover that finds a finished build packages it instead of discarding it
// ---------------------------------------------------------------------------------------------

test('rescue: a late takeover after build is done gets tier 2 at package, an early one resumes at qa, and the optional compact QA of PLAYBOOK §4.1 works', () => {
  const early = realBox();
  try {
    walk(early, 'qa');
    must(early, ['phase-start', '--phase', 'qa', '--session', 'sP'], '06:10');
    // 06:47 is still inside the compact-build window (t2Until 07:00): a plain takeover at qa, nothing to rescue
    const t = must(early, ['begin', '--role', 'wdB', '--session', 'sB'], '06:47');
    assert.deepEqual([t.action, t.targetTier, t.resumePhase, t.builtSiteAvailable], ['takeover', 2, 'qa', true]);
  } finally {
    early.cleanup();
  }
  const box = realBox();
  try {
    walk(box, 'qa');
    must(box, ['phase-start', '--phase', 'qa', '--session', 'sP'], '06:10');
    const t = must(box, ['begin', '--role', 'wdB', '--session', 'sB'], '07:10');
    assert.deepEqual([t.action, t.targetTier, t.resumePhase, t.builtSiteAvailable], ['takeover', 2, 'package', true]);
    // §4.1 step 2: the skipped qa phase can still be run and closed
    const s = must(box, ['phase-start', '--phase', 'qa', '--session', 'sB'], '07:12');
    assert.equal(s.overLimit, false);
    const d = must(box, ['phase-done', '--phase', 'qa', '--note', 'compact qa', '--session', 'sB', '--role', 'wdB'], '07:25');
    assert.deepEqual([d.alreadyDone, d.next, d.targetTier], [true, 'package', 2]);
  } finally {
    box.cleanup();
  }
});

test('rescue: the closer is also offered the finished build, and the documents route it to §4.1 and the salvage step', () => {
  const box = realBox();
  try {
    walk(box, 'qa');
    // the primary keeps beating but its qa phase has run for hours (hung): no grace, and the finished build is rescued
    must(box, ['beat', '--role', 'primary', '--session', 'sP', '--phase', 'qa'], '08:40');
    const c = must(box, ['begin', '--role', 'closer', '--session', 'closer-1'], '08:47');
    assert.deepEqual([c.action, c.targetTier, c.resumePhase, c.builtSiteAvailable], ['force-degrade', 2, 'package', true]);
    const late = realBox();
    try {
      walk(late, 'qa');
      const l = must(late, ['begin', '--role', 'closer', '--session', 'closer-1'], '10:15');
      assert.equal(l.targetTier, 3, 'with less than 20 minutes left before the hard stop the closer must fall back, not rescue');
    } finally {
      late.cleanup();
    }
  } finally {
    box.cleanup();
  }
  const four = section(PLAYBOOK, '### 4.1');
  for (const needle of [/builtSiteAvailable/, /targetTier. 2/, /resumePhase. `package`/, /not.*§9/s, /smoke/, /Tier 2/]) assert.match(four, needle);
  assert.match(section(PLAYBOOK, '### 5.3 wdB'), /§4\.1/);
  const closer = section(PLAYBOOK, '### 5.4 closer');
  assert.match(closer, /force-degrade. with `targetTier` 2 and `resumePhase` `package`/);
  assert.match(closer, /Salvage first/);
  assert.match(closer, /validate\.mjs project <DIR> --tier 2/);
  assert.match(read('ops/FAILURE_MODES.md'), /^\| FM-85 \|/m);
  assert.ok(!/If a usable run is further along than that \(`resumePhase` `package`\), go straight to §9/.test(PLAYBOOK), 'the old wrong rule is gone');
});

// ---------------------------------------------------------------------------------------------
// finding 8 (bootstrap): the playbook must be read to its last line
// ---------------------------------------------------------------------------------------------

test('reading: the playbook tells the reader to read in chunks to the end, the bootstrap does too, and the end is Appendix D', () => {
  const head = PLAYBOOK.split('\n').slice(0, 12).join('\n');
  assert.match(head, /chunks of at most 300 lines/);
  assert.match(head, /last line/);
  assert.match(read('ops/prompts/_bootstrap.md'), /chunks of at most 300 lines/);
  const headings = [...PLAYBOOK.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.match(headings[headings.length - 1], /^Appendix D/, 'the last section is the one the bootstrap names');
  // every appendix tool named in the opening paragraph exists
  for (const id of ['A1', 'A2', 'A3', 'A4', 'A5', 'A6']) assert.ok(new RegExp(`^### ${id} `, 'm').test(PLAYBOOK), `Appendix ${id}`);
});

// ---------------------------------------------------------------------------------------------
// round 2: time grace (CONTRACT §13), heartbeat branch (§14), culture and kaizen (§12)
// ---------------------------------------------------------------------------------------------

const DOCS = ['ops/PLAYBOOK.md', 'ops/FAILURE_MODES.md', 'ops/OPERATING.md'];

/** The sandbox day, built and published by `role` at the given tier so that `finish` accepts it. */
function publish(box, { role = 'primary', session = 'sP', tier = 1, hhmm = '08:10' } = {}) {
  const dir = tier === 4 ? `${D}-postcard` : `${D}-fixture`;
  box.write(`docs/d/${dir}/index.html`, '<!doctype html><title>x</title>');
  box.write('state/history.json', { schema: 1, startDate: D, entries: [{ n: 1, date: D, slug: dir.slice(D.length + 1), title: 'Fixture', tagline: 't', tier, path: `d/${dir}/`, publishedAt: at(hhmm), countsForNovelty: tier <= 2 }] });
  return must(box, ['finish', '--status', 'published', '--tier', String(tier), '--url', `https://example.test/d/${dir}/`, '--by', role, '--session', session], hhmm);
}

test('time grace: the documents carry the contract schedule and none of the old fixed times', () => {
  const sched = REAL_CONFIG.schedule;
  const timeline = section(PLAYBOOK, '## 2. The day at a glance');
  for (const t of [sched.primary, sched.watchdogA, sched.watchdogB, sched.deadline, sched.closer, sched.closerBackup, sched.graceUntil, sched.hardStop, ...Object.values(REAL_CONFIG.tierCutoffs)]) {
    assert.ok(timeline.includes(`| ${t} |`), `the day timeline has no row for ${t}`);
  }
  assert.match(timeline, /\| 08:00 \| `deadline`: the \*\*guideline\*\*/);
  assert.match(read('ops/OPERATING.md'), new RegExp(`\\| ${sched.closer} \\| closer \\|`));
  assert.match(read('ops/OPERATING.md'), new RegExp(`\\| ${sched.closerBackup} \\| closer backup \\|`));
  // 07:25 / 07:27 / 07:30 / 07:42 and 06:45 were the old closer and tier times; "by 08:00" the old hard deadline
  for (const file of DOCS) {
    const text = read(file);
    assert.ok(!/\b(07:25|07:27|07:30|07:42|06:45)\b/.test(text), `${file} still carries an old closer or tier time`);
    assert.ok(!/(by|before) 08:00/i.test(text.replace(/never (ship|cut)[^.]*08:00/gi, '')), `${file} still treats 08:00 as a deadline`);
  }
  const head = PLAYBOOK.split('\n').slice(0, 8).join('\n');
  assert.match(head, /guideline/);
  assert.match(head, /Quality beats punctuality/);
});

test('time grace: the closer babysit loop and the planner offset use commands and fields that exist', () => {
  const closer = section(PLAYBOOK, '### 5.4 closer');
  const wait = /node scripts\/heartbeat\.mjs --role closer --session <S> --wait 480 --no-push/;
  assert.match(closer, wait);
  assert.ok(!/--phase wait/.test(PLAYBOOK), '"wait" is not a phase: heartbeat.mjs would exit 2');
  assert.match(closer, /grace:true/);
  assert.match(closer, /Babysit/);
  assert.match(closer, /Salvage first/);
  // the wait command itself works (offline: it only records locally and pushes nothing)
  const box = realBox({ git: true });
  try {
    const hb = box.cli('heartbeat', ['--role', 'closer', '--session', 'closer-1', '--wait', '0', '--no-push', '--date', D, '--now', at('08:50')], { SED_HB_DIR: path.join(box.root, '..', 'hb-clone-playbook') });
    assert.equal(hb.code, 0, hb.stdout + hb.stderr);
    assert.deepEqual([hb.json.ok, hb.json.pushed, hb.json.reason], [true, false, 'no-push']);
    assert.equal(box.cli('heartbeat', ['--role', 'closer', '--session', 'closer-1', '--phase', 'wait', '--wait', '0', '--no-push']).code, 2);
  } finally {
    box.cleanup();
  }
  // the offset in §6.3: a run planned to the grace window minus 15 minutes keeps a compact build alive at 06:47
  const planner = (mtd, tier, phase) => runSnippet(realBox(), 'A4', { MTD: String(mtd), TIER: String(tier), PHASE: phase, SLOTS: '8' }).json;
  const mtdAt = (hhmm, minutesToGrace) => minutesToGrace - 15 + 0 * hhmm.length;
  const at0647 = mtdAt('06:47', (9 * 60 + 30) - (6 * 60 + 47));
  assert.equal(planner(at0647, 2, 'build').feasible, true);
  assert.equal(planner(at0647, 2, 'ideate').feasible, true, 'a compact build started at 06:47 still fits the grace window');
  assert.equal(planner(at0647, 1, 'ideate').feasible, false);
  assert.match(section(PLAYBOOK, '### 6.3'), /minutesToGraceUntil - 15/);
  assert.match(section(PLAYBOOK, '### 5.3 wdB'), /minutesToGraceUntil - 15/);
});

test('time grace: the closer sees grace for a healthy late run, force-degrades an early or hung one, and the status fields exist', () => {
  const healthy = realBox();
  try {
    walk(healthy, 'qa');
    must(healthy, ['phase-start', '--phase', 'qa', '--session', 'sP'], '08:30');
    must(healthy, ['beat', '--role', 'primary', '--session', 'sP', '--phase', 'qa'], '08:44');
    const g = must(healthy, ['begin', '--role', 'closer', '--session', 'closer-1'], '08:47');
    assert.deepEqual([g.action, g.grace, g.wrote], ['exit-alive', true, true], 'the first grace is recorded once');
    const g2 = must(healthy, ['begin', '--role', 'closer', '--session', 'closer-1'], '08:55');
    assert.deepEqual([g2.action, g2.grace, g2.wrote], ['exit-alive', true, false], 'later babysit rounds write nothing, so the closer has nothing to sync');
    const st = must(healthy, ['status'], '08:56');
    for (const key of ['minutesToGraceUntil', 'minutesToHardStop', 'kaizenPending', 'phaseIsLate']) assert.ok(key in st, `status lacks ${key}`);
    assert.equal(must(healthy, ['today'], '08:56').minutesToGraceUntil, 34);
    must(healthy, ['beat', '--role', 'primary', '--session', 'sP', '--phase', 'qa'], '09:25');
    const over = must(healthy, ['begin', '--role', 'closer', '--session', 'closer-1'], '09:31');
    assert.equal(over.action, 'force-degrade', 'the grace window ends at 09:30');
  } finally {
    healthy.cleanup();
  }
  const early = realBox();
  try {
    walk(early, 'build');
    must(early, ['phase-start', '--phase', 'build', '--session', 'sP'], '08:30');
    must(early, ['beat', '--role', 'primary', '--session', 'sP', '--phase', 'build'], '08:44');
    assert.equal(must(early, ['begin', '--role', 'closer', '--session', 'closer-1'], '08:47').action, 'force-degrade', 'a run that has not reached qa gets no grace');
  } finally {
    early.cleanup();
  }
  const wdB = realBox();
  try {
    walk(wdB, 'build');
    must(wdB, ['phase-start', '--phase', 'build', '--session', 'sP'], '06:30');
    must(wdB, ['beat', '--role', 'primary', '--session', 'sP', '--phase', 'build'], '06:40');
    const w = must(wdB, ['begin', '--role', 'wdB', '--session', 'sB'], '06:47');
    assert.deepEqual([w.action, w.directiveAdded], ['exit-alive', false], 'wdB leaves a run that has reached build alone');
    const slow = realBox();
    try {
      walk(slow, 'spec');
      must(slow, ['phase-start', '--phase', 'spec', '--session', 'sP'], '06:30');
      must(slow, ['beat', '--role', 'primary', '--session', 'sP', '--phase', 'spec'], '06:40');
      const s = must(slow, ['begin', '--role', 'wdB', '--session', 'sB'], '06:47');
      assert.deepEqual([s.action, s.directiveAdded], ['exit-alive', true], 'a run still before build gets a scope-cut');
    } finally {
      slow.cleanup();
    }
  } finally {
    wdB.cleanup();
  }
});

test('heartbeat branch: the documents name it, use the explicit-refspec recovery and never create the work branch', () => {
  assert.equal(REAL_CONFIG.heartbeatBranch, 'claude/sonnet-every-day-heartbeat');
  for (const file of ['ops/PLAYBOOK.md', 'ops/FAILURE_MODES.md', 'ops/OPERATING.md']) assert.ok(read(file).includes(REAL_CONFIG.heartbeatBranch), `${file} never names the heartbeat branch`);
  const orient = section(PLAYBOOK, '**3.1 Repo.**');
  assert.ok(orient.includes('git fetch origin +refs/heads/claude/sonnet-every-day:refs/remotes/origin/claude/sonnet-every-day'));
  assert.ok(orient.includes('git checkout -B claude/sonnet-every-day origin/claude/sonnet-every-day'));
  assert.match(orient, /never create it/);
  for (const file of DOCS) assert.ok(!/git checkout claude\/sonnet-every-day\b/.test(read(file)), `${file} still has the bare checkout`);
  assert.match(read('ops/FAILURE_MODES.md'), /^\| FM-98 \|[^\n]*orphan/m);
  assert.match(section(PLAYBOOK, '### 6.1'), /Push budget/);
  assert.match(section(PLAYBOOK, '### 6.1'), /orphan branch/);
});

test('kaizen: the documented phase sequence works against the real state script', () => {
  const box = realBox();
  try {
    walk(box, 'revise');
    must(box, ['phase-done', '--phase', 'revise', '--note', 'skipped: test', '--session', 'sP', '--role', 'primary'], '07:00');
    for (const phase of ['package']) {
      must(box, ['phase-start', '--phase', phase, '--session', 'sP'], '07:05');
      must(box, ['phase-done', '--phase', phase, '--note', 'x', '--session', 'sP', '--role', 'primary'], '07:20');
    }
    must(box, ['phase-start', '--phase', 'publish', '--session', 'sP'], '07:21');
    const fin = publish(box, { hhmm: '07:25' });
    assert.equal(fin.action, 'published');
    assert.equal(fin.kaizenPending, true, 'finish tells the operator that the kaizen is owed (PLAYBOOK §10.4 step 3)');
    // the closer finds it published, must not run the kaizen, and closes it the way §5.4 step 3 says
    const closer = must(box, ['begin', '--role', 'closer', '--session', 'closer-1'], '08:47');
    assert.deepEqual([closer.action, closer.kaizenPending], ['exit-published', true]);
    // (a primary that is still beating owns its kaizen; one that went silent for hours no longer does: e2e (kz6) and state.test.mjs cover that half)
    must(box, ['beat', '--role', 'primary', '--session', 'sP', '--phase', 'kaizen'], '08:44');
    const refused = st(box, ['skip-phase', '--phase', 'kaizen', '--reason', 'closer never runs the kaizen round', '--session', 'closer-1', '--role', 'closer'], '08:47');
    assert.equal(refused.code, 1, 'while the primary is alive and holds the lease the closer cannot close its kaizen');
    assert.match(JSON.stringify(refused.json), /lease is held by/);
    // §10.6 step 1: beat (spend for the budget floor), phase-start, sync
    const beat = must(box, ['beat', '--role', 'primary', '--session', 'sP', '--phase', 'kaizen'], '07:30');
    assert.equal(beat.kaizenPending, true);
    assert.equal(typeof beat.spend.remainingTokens, 'number');
    const start = must(box, ['phase-start', '--phase', 'kaizen', '--session', 'sP'], '07:31');
    assert.deepEqual([start.attempt, start.overLimit], [1, false]);
    // context lost mid-round: the same session asks `begin` and is told to resume the kaizen, nothing else
    const again = must(box, ['begin', '--role', 'primary', '--session', 'sP'], '07:50');
    assert.equal(again.action, 'resume-kaizen');
    assert.equal(again.resumePhase, 'kaizen');
    const done = must(box, ['phase-done', '--phase', 'kaizen', '--note', '3 applied, 1 rejected, 0 proposed, 5 skipped', '--session', 'sP', '--role', 'primary'], '08:30');
    assert.equal(done.next, 'done');
    const status = must(box, ['status'], '08:31');
    assert.deepEqual([status.status, status.phase, status.kaizenPending], ['published', 'done', false]);
    assert.ok(status.phasesDone.includes('kaizen') && status.phasesDone.includes('done'));
    // published stays published: a later closer has nothing to do
    assert.equal(must(box, ['begin', '--role', 'closer', '--session', 'closer-1'], '08:47').action, 'exit-published');
  } finally {
    box.cleanup();
  }
  // the closer publishing a fallback closes the kaizen itself with skip-phase (PLAYBOOK §5.4)
  const fallback = realBox();
  try {
    must(fallback, ['begin', '--role', 'closer', '--session', 'closer-1'], '08:50');
    const fin = publish(fallback, { role: 'closer', session: 'closer-1', tier: 4, hhmm: '08:55' });
    assert.equal(fin.kaizenPending, true);
    const skip = must(fallback, ['skip-phase', '--phase', 'kaizen', '--reason', 'closer never runs the kaizen round', '--session', 'closer-1', '--role', 'closer'], '08:56');
    assert.equal(skip.skipped, true);
    const status = must(fallback, ['status'], '08:57');
    assert.deepEqual([status.kaizenPending, status.phase], [false, 'done']);
  } finally {
    fallback.cleanup();
  }
});

test('kaizen: the playbook section matches the workflow, the gate script and the config', () => {
  const text = section(PLAYBOOK, '### 10.6 Kaizen phase');
  for (const needle of [/phase-start --phase kaizen/, /phase-done --phase kaizen/, /skip-phase --phase kaizen/, /kaizen\.js/, /dayNumber/, /phaseBudgetMinutes: 75/, /kaizen\.mjs queue --skip/, /state\/kaizen-queue\.json/, /kaizenMinTokensToStart/, /degradedDay/, /closer/, /never changes `published`/, /resume-kaizen/, /one at a time/, /proposals/]) assert.match(text, needle);
  // the order matters: everything that writes to the tree comes before the sync that precedes the workflow
  assert.ok(text.indexOf('beat --role') < text.indexOf('phase-start --phase kaizen') && text.indexOf('phase-start --phase kaizen') < text.indexOf('sync -m "sed(<D>): <R> kaizen start"'));
  const wf = read('ops/workflows/kaizen.js');
  assert.match(wf, /checkArgs\('kaizen', \['date', 'repoDir', 'dayNumber'\]/, 'the workflow requires exactly the args the playbook passes');
  assert.match(wf, /the closer never runs the kaizen round/);
  assert.match(wf, /pass phaseBudgetMinutes below config\.phaseStuckMinutes|phaseBudgetMinutes below config\.phaseStuckMinutes/);
  assert.ok(75 < REAL_CONFIG.phaseStuckMinutes);
  const gate = read('scripts/kaizen.mjs');
  for (const sub of ['begin', 'digest', 'status', 'queue', 'commit', 'propose']) assert.ok(gate.includes(`'${sub}'`), `kaizen.mjs has no ${sub}`);
  assert.equal(REAL_CONFIG.kaizen.minTokensToStart, 60000);
  assert.ok(text.includes('(60k)'));
  assert.match(section(PLAYBOOK, '### 10.7 Handoff'), /state\/handoff\.md/);
  assert.match(section(PLAYBOOK, '### 10.7 Handoff'), /docs\/kaizen\/index\.html/);
  // the premortem and the handoff are read at preflight, and the templates exist
  const pre = section(PLAYBOOK, '### 8.1 preflight');
  for (const needle of [/state\/handoff\.md/, /kaizen\.mjs digest --limit 10/, /Premortem/, /premortem\.txt/, /three bullets/, /`premortem`/]) assert.match(pre, needle);
  assert.match(PLAYBOOK, /^### B2 handoff template/m);
  assert.match(PLAYBOOK, /^## Kaizen$/m);
  assert.match(PLAYBOOK, /^## What went wrong \(blameless\)$/m);
  assert.match(section(PLAYBOOK, '### 6.9'), /notes-<agent>\.md/);
  // spend: the earlier phases leave the kaizen reserve
  assert.match(PLAYBOOK, /minus `levelConfig\.reserveForKaizenTokens`/);
  assert.equal(REAL_CONFIG.budget.reserveForKaizenTokens, 350000);
});

test('kaizen: the failure table has at least ten kaizen rows and every protected block is balanced', () => {
  const fm = read('ops/FAILURE_MODES.md');
  const rows = fm.split('\n').filter((l) => /^\| FM-\d+ \|/.test(l));
  assert.ok(rows.length >= 45, `${rows.length} failure modes`);
  const block = section(fm, '## Culture, kaizen and handoff');
  const kaizenRows = block.split('\n').filter((l) => /^\| FM-\d+ \|/.test(l));
  assert.ok(kaizenRows.length >= 10, `${kaizenRows.length} culture and kaizen rows`);
  for (const row of rows) assert.equal(row.split(/(?<!\\)\|/).length - 2, 5, `a failure row does not have 5 columns: ${row.slice(0, 40)}`);
  for (const topic of [/breaks tests/, /protected path/, /ledger/, /conflict/, /thrash/, /web page/, /bloat/, /hangs/, /Push rejected/, /degraded/]) assert.ok(kaizenRows.some((r) => topic.test(r)), `no kaizen row for ${topic}`);
  for (const file of DOCS) {
    const text = read(file);
    const open = (text.match(/<!-- protected:begin -->/g) ?? []).length;
    const close = (text.match(/<!-- protected:end -->/g) ?? []).length;
    assert.ok(open >= 1 && open === close, `${file}: ${open} protected:begin vs ${close} protected:end`);
  }
  const rules = /<!-- protected:begin -->([\s\S]*?)<!-- protected:end -->/.exec(PLAYBOOK)[1];
  for (const needle of [/Untrusted data/, /Never force-push/, /never push another branch/, /Never publish unvalidated output/, /Never accept, enable or work around overage/, /No untrusted text in a shell line/]) assert.match(rules, needle);
});

test('kaizen: the documents stay inside their line caps and never reference what does not exist', () => {
  const caps = REAL_CONFIG.kaizen.docLineCaps;
  for (const file of ['ops/PLAYBOOK.md', 'ops/FAILURE_MODES.md']) {
    const lines = read(file).split('\n').length;
    assert.ok(lines <= caps[file], `${file} has ${lines} lines, over the kaizen cap ${caps[file]}`);
  }
  for (const rel of ['ops/CULTURE.md', 'ops/rubrics/kaizen.md', 'ops/kaizen/README.md', 'ops/kaizen/LOG.md', 'ops/kaizen/INDEX.json', 'ops/workflows/kaizen.js', 'scripts/kaizen.mjs']) assert.ok(fs.existsSync(path.join(REPO_ROOT, rel)), `${rel} is missing`);
  const operating = read('ops/OPERATING.md');
  for (const needle of [/The daily kaizen/, /git revert --no-commit <sha>/, /git checkout HEAD -- ops\/kaizen\/INDEX\.json ops\/kaizen\/LOG\.md/, /renderLog/, /"enabled": false/, /maxChangedLines/, /proposals/, /kaizen\//]) assert.match(operating, needle);
});

test('kaizen: the revert recipe in OPERATING.md really reverts a kaizen commit, keeps the ledger consistent and regenerates the log like the script', async () => {
  const { renderLog } = await import('../scripts/kaizen.mjs');
  const text = read('ops/OPERATING.md');
  const code = /node --input-type=module -e "\n([\s\S]*?)\n"\n/.exec(text)?.[1];
  assert.ok(code, 'OPERATING.md has no revert snippet');
  const gitSteps = /```\n(git revert --no-commit <sha>\ngit checkout HEAD -- ops\/kaizen\/INDEX\.json ops\/kaizen\/LOG\.md)\n/.exec(text)?.[1];
  assert.ok(gitSteps, 'OPERATING.md has no git steps for the revert');
  const box = realBox({ git: true });
  try {
    const g = (...args) => box.git(...args);
    g('config', 'user.email', 'owner@example.test');
    g('config', 'user.name', 'owner');
    fs.cpSync(path.join(REPO_ROOT, 'scripts'), box.path('scripts'), { recursive: true });
    box.write('ops/roles/pulse.md', 'line one\nline two\n');
    box.write('ops/kaizen/INDEX.json', { schema: 1, entries: [] });
    box.write('ops/kaizen/LOG.md', renderLog({ schema: 1, entries: [] }));
    g('add', '-A');
    g('commit', '-qm', 'base');
    // what kaizen.mjs commit does: the change and the ledger entry in one commit, then a ledger-only commit stamps the sha
    const entry = { id: '2026-10-12-pulse', date: '2026-10-12', agent: 'pulse', title: 'Tighten a prompt', observation: 'saw x', category: 'clarity', files: ['ops/roles/pulse.md'], sha: null, status: 'applied', linesChanged: 2, question: null };
    box.write('ops/roles/pulse.md', 'line one\nline two, tighter\n');
    box.write('ops/kaizen/INDEX.json', { schema: 1, entries: [entry] });
    box.write('ops/kaizen/LOG.md', renderLog({ schema: 1, entries: [entry] }));
    g('add', '-A');
    g('commit', '-qm', 'kaizen(pulse): Tighten a prompt');
    const sha = g('rev-parse', 'HEAD').trim();
    const stamped = { ...entry, sha };
    box.write('ops/kaizen/INDEX.json', { schema: 1, entries: [stamped] });
    box.write('ops/kaizen/LOG.md', renderLog({ schema: 1, entries: [stamped] }));
    g('add', '-A');
    g('commit', '-qm', 'kaizen ledger: stamp sha');

    // the documented git steps, verbatim (the revert reports its expected ledger conflict; the checkout settles it)
    const script = gitSteps.replace('<sha>', sha).split('\n').map((l, i) => (i === 0 ? `${l} || true` : l)).join('\n');
    const steps = spawnSync('bash', ['-c', script], { cwd: box.root, encoding: 'utf8' });
    assert.equal(steps.status, 0, steps.stderr);
    assert.equal(fs.readFileSync(box.path('ops/roles/pulse.md'), 'utf8'), 'line one\nline two\n', 'the change is undone');
    assert.equal(box.readJson('ops/kaizen/INDEX.json').entries[0].sha, sha, 'the ledger is kept as it was');
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: box.root, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const index = box.readJson('ops/kaizen/INDEX.json');
    assert.deepEqual([index.entries[0].status, index.entries[0].sha], ['reverted', sha]);
    assert.match(index.entries[0].reason, /\S/);
    assert.equal(box.read('ops/kaizen/LOG.md'), renderLog(index), 'LOG.md is exactly what the script would have written');
    assert.match(box.read('ops/kaizen/LOG.md'), /reverted · Tighten a prompt/);
    g('add', '-A', 'ops');
    g('commit', '-qm', 'revert kaizen 2026-10-12-pulse');
    assert.equal(g('status', '--short', '--', 'ops').trim(), '', 'nothing is left half-reverted');
  } finally {
    box.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// round 2 fixes: QA gate on rescue, closer lease and liveness, planner, spend shares, kaizen feedback loop
// ---------------------------------------------------------------------------------------------

test('QA gate: a blocking or unreviewed QA report is never rescued or salvaged as Tier 2, and status says so (PLAYBOOK §4.1, §5.4 step 4, §6.2)', () => {
  const cases = [
    ['S1 defects left', { verdict: 'revise', counts: { S1: 2, S2: 0, S3: 0, S4: 0 } }, true],
    ['verdict block', { verdict: 'block', counts: { S1: 0, S2: 1, S3: 0, S4: 0 } }, true],
    ['unreviewed:true is never "ship"', { verdict: 'ship', counts: { S1: 0, S2: 0, S3: 0, S4: 0 }, unreviewed: true }, true],
    ['S2 only, reviewed: shippable with known issues (§8.6)', { verdict: 'revise', counts: { S1: 0, S2: 3, S3: 0, S4: 0 } }, false],
    ['a clean report', { verdict: 'ship', counts: { S1: 0, S2: 0, S3: 0, S4: 0 } }, false],
  ];
  for (const [label, report, blocked] of cases) {
    // the primary died during revise (qa done, revise started); a fresh closer clone arrives at 08:47
    const box = realBox();
    try {
      walk(box, 'revise');
      must(box, ['phase-start', '--phase', 'revise', '--session', 'sP'], '06:00');
      box.write(`work/${D}/build/site/index.html`, '<!doctype html><title>x</title>');
      box.write(`work/${D}/qa/report.json`, report);
      const status = must(box, ['status'], '08:46');
      assert.equal(status.qaBlock !== null, blocked, `${label}: status.qaBlock ${JSON.stringify(status.qaBlock)}`);
      const c = must(box, ['begin', '--role', 'closer', '--session', 'closer-1'], '08:47');
      if (blocked) {
        assert.equal(c.builtSiteAvailable, true, label);
        assert.equal(c.targetTier, 3, `${label}: the blocked build must not be offered as a Tier 2 rescue (${c.reason})`);
        assert.ok(!/QA\/revise skipped/.test(c.reason), label);
      } else {
        assert.deepEqual([c.targetTier, c.resumePhase], [2, 'package'], label);
      }
    } finally {
      box.cleanup();
    }
  }
  // an unreadable report counts as blocking, and a missing one does not
  const box = realBox();
  try {
    assert.equal(must(box, ['status'], '08:00').qaBlock, null);
    box.write(`work/${D}/qa/report.json`, '{ not json');
    assert.match(must(box, ['status'], '08:00').qaBlock.reason, /unreadable/);
  } finally {
    box.cleanup();
  }
  assert.match(section(PLAYBOOK, '### 4.1'), /qaBlock: null/);
  assert.match(section(PLAYBOOK, '### 5.4 closer'), /non-null `qaBlock`/);
  assert.match(section(PLAYBOOK, '### 6.2'), /`qaBlock: null`/);
});

test('planner (A4): the timetable follows the agent slots; below 6 a Tier 1 day never fits and the compact day gets realistic budgets', () => {
  const planner = (mtd, tier, phase, extra = {}) => runSnippet(realBox(), 'A4', { MTD: String(mtd), TIER: String(tier), PHASE: phase, ...extra }).json;
  // 03:56 on a scheduled day: minutesToGraceUntil 334, MTD 319
  const wide = planner(319, 1, 'ideate', { SLOTS: '8' });
  assert.deepEqual([wide.slots, wide.narrow, wide.feasible, wide.suggestTier], [8, false, true, 1]);
  const narrow = planner(319, 1, 'ideate', { SLOTS: '2' });
  assert.deepEqual([narrow.slots, narrow.narrow, narrow.feasible, narrow.suggestTier], [2, true, false, 2], 'on 2 slots the full build never fits: go compact before ideate');
  const compact = planner(319, 2, 'ideate', { SLOTS: '2' });
  assert.equal(compact.feasible, true, 'the compact day fits from 03:56');
  assert.ok(compact.phaseBudgetMinutes >= 90 && compact.phaseBudgetMinutes <= 110, `ideate gets a budget that covers 8 scouts in 4 waves plus batched verification (${compact.phaseBudgetMinutes})`);
  assert.equal(planner(319, 2, 'ideate', { SLOTS: '2' }).available, 319 - 10, 'the narrow reserve is 10 minutes (planned finish about 09:05)');
  // the measured 2026-10-11 moments: build started at 06:47 (163 minutes to grace, MTD 148) and qa at 08:27 (MTD 48)
  assert.equal(planner(148, 2, 'build', { SLOTS: '2' }).feasible, true, 'a compact build at 06:47 still fits');
  assert.ok(planner(148, 2, 'build', { SLOTS: '2' }).phaseBudgetMinutes >= 80, `build is not squeezed (${planner(148, 2, 'build', { SLOTS: '2' }).phaseBudgetMinutes})`);
  const lateQa = planner(48, 2, 'qa', { SLOTS: '2' });
  assert.deepEqual([lateQa.feasible, lateQa.available, lateQa.suggestTier], [true, 58, 2], 'from qa on, a built site is measured against the grace window (MTD + 10): the 2026-10-11 qa at 08:27 was right to run');
  assert.ok(lateQa.phaseBudgetMinutes >= 30, 'and qa keeps a real budget');
  assert.equal(planner(20, 2, 'qa', { SLOTS: '2' }).feasible, false, 'twenty minutes before 09:15 even qa + package do not fit the window');
  assert.equal(planner(148, 1, 'build', { SLOTS: '2' }).suggestTier, 2, 'a Tier 1 build at 06:47 is priced compact');
  assert.equal(planner(5, 3, 'package', { SLOTS: '2' }).feasible, true, 'a fallback publish is never refused');
  // without SLOTS the snippet measures the machine: either table, never a third
  const auto = planner(319, 2, 'ideate');
  assert.ok([8, 7, 6, 5, 4, 3, 2, 1].includes(auto.slots) && auto.narrow === (auto.slots < 6));
  assert.deepEqual(auto.phaseBudgetMinutes, planner(319, 2, 'ideate', { SLOTS: String(auto.slots) }).phaseBudgetMinutes);
  assert.match(section(PLAYBOOK, '### 6.3'), /SLOTS=<n>/);
  assert.match(section(PLAYBOOK, '### 8.1'), /narrow timetable/);
});

test('planner (A4): a mid-run Tier 1 is priced for Tier 2 from the phase it is in, not as a restart from preflight', () => {
  const planner = (mtd, tier, phase, extra = {}) => runSnippet(realBox(), 'A4', { MTD: String(mtd), TIER: String(tier), PHASE: phase, SLOTS: '8', ...extra }).json;
  // the finding: 90 minutes to the offset deadline, Tier 1 about to start build
  const b = planner(90, 1, 'build');
  assert.equal(b.feasible, false, 'a full build, qa, package and publish do not fit');
  assert.equal(b.suggestTier, 2, 'but the compact build still fits: build 35 + qa 12 + package 12 + publish 5 = 64');
  assert.ok(b.phaseBudgetMinutes > 0 && b.phaseBudgetMinutes <= 35, `the build gets its compact budget (${b.phaseBudgetMinutes})`);
  // later phases keep working the same way
  assert.equal(planner(70, 1, 'qa').suggestTier, 1);
  assert.equal(planner(60, 1, 'qa').feasible, false);
  assert.equal(planner(60, 1, 'qa').suggestTier, 2);
  // the restart cost is still charged where work really restarts
  assert.equal(planner(70, 1, 'preflight').suggestTier, 3, 'a Tier 2 day from scratch needs 116 minutes');
  assert.equal(planner(50, 1, 'preflight').suggestTier, 4, 'not even the ideas fit');
  assert.equal(planner(20, 1, 'ideate').suggestTier, 4, 'no time for even the ideas');
  // an Ideas Day after ideate is only the package
  assert.equal(planner(45, 2, 'spec').suggestTier, 3);
  assert.equal(planner(5, 2, 'build').suggestTier, 4);
});

test('spend shares: a full Tier 1 day through revise fits under the workflow cap (capTokens minus the kaizen reserve) at every level that can afford the reserve', () => {
  for (const level of Object.keys(REAL_CONFIG.budget.levels)) {
    const lc = levelConfigFor(REAL_CONFIG, level);
    if (lc.capTokens <= lc.reserveForKaizenTokens || lc.forceTier === 2) continue; // `minimal` is a compact-only level
    const workflowCap = lc.capTokens - lc.reserveForKaizenTokens;
    const throughRevise = ['ideate', 'select', 'spec', 'build', 'qa', 'revise'].reduce((a, p) => a + Math.round(SHARES.full[p] * lc.capTokens), 0);
    assert.ok(throughRevise <= workflowCap, `${level}: ideate..revise estimate ${throughRevise} exceeds the workflow cap ${workflowCap}, so revise would always be skipped`);
    const withPackage = throughRevise + Math.round(SHARES.full.package * lc.capTokens);
    assert.ok(withPackage <= workflowCap, `${level}: the whole day (${withPackage}) leaves no room under ${workflowCap}`);
  }
  assert.match(PLAYBOOK, /a full day without revise totals 64% of it, with revise 71%/);
});

/** A bare remote whose pre-receive hook refuses every push to a branch with `heartbeat` in its name. */
function refuseHeartbeatBranch(remote) {
  const hook = path.join(remote, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do\n  case "$ref" in *heartbeat*) echo "refused by test hook" >&2; exit 1;; esac\ndone\nexit 0\n', { mode: 0o755 });
}

test('closer: the lease is pushed the moment it is taken, so a backup closer sees it, and the same sync refreshes a stale checkout (PLAYBOOK §5.4 steps 2 and 4)', () => {
  const box = realBox({ git: true });
  try {
    walk(box, 'select');
    must(box, ['beat', '--role', 'primary', '--session', 'sP', '--phase', 'select'], '08:40');
    assert.equal(must(box, ['sync', '-m', 'primary state', '--no-sleep'], '08:41').ok, true);
    const c1 = box.cloneB('closer-1');
    const c = must(c1, ['begin', '--role', 'closer', '--session', 'closer-1'], '08:47');
    assert.equal(c.action, 'force-degrade');
    // meanwhile the primary lands a newer page and history
    box.write('docs/late.txt', 'newer page\n');
    assert.equal(must(box, ['sync', '-m', 'primary newer commit', '--no-sleep'], '08:48').ok, true);
    assert.equal(c1.exists('docs/late.txt'), false, 'the closer clone is stale, as after a long babysit');
    // the race window of the finding: a backup closer clones now, before the closer pushed anything
    const early = box.cloneB('backup-early');
    assert.equal(must(early, ['status'], '08:49').lease.holder, 'primary', 'without a push the backup closer cannot see the closer');
    // §5.4 step 4: sync first
    const synced = must(c1, ['sync', '-m', 'sed: closer took the lease', '--no-sleep'], '08:50');
    assert.equal(synced.ok, true);
    assert.equal(c1.exists('docs/late.txt'), true, 'the same sync brought the primary\'s newest commit into the closer\'s tree');
    const backup = box.cloneB('backup');
    const seen = must(backup, ['status'], '08:52');
    assert.deepEqual([seen.lease.holder, seen.lease.session], ['closer', 'closer-1']);
    assert.ok(seen.lease.ageMinutes <= 8, `the backup closer's step-2 rule waits for a lease this fresh (age ${seen.lease.ageMinutes})`);
  } finally {
    box.cleanup();
  }
  const closer = section(PLAYBOOK, '### 5.4 closer');
  assert.match(closer, /4\. \*\*Take the lease visibly, then salvage\.\*\* First `node scripts\/state\.mjs sync -m/);
  assert.match(closer, /While `grace:true` do not `sync`/, 'the babysit rule says it overrides the generic push rule');
  assert.match(PLAYBOOK, /closer's `grace:true` answer writes only a local note and is never pushed/);
});

test('closer: a salvaging closer that pushes a heartbeat every 4 minutes stays visible to the backup closer; `beat` alone does not (PLAYBOOK §5.4 step 4)', () => {
  const hb = tmpDir('sed-hb-');
  const box = realBox({ git: true });
  const env = { SED_HB_DIR: hb, SED_NO_SLEEP: '1' };
  try {
    walk(box, 'select');
    must(box, ['beat', '--role', 'primary', '--session', 'sP', '--phase', 'select'], '09:30');
    assert.equal(must(box, ['sync', '-m', 'primary state', '--no-sleep'], '09:31').ok, true);
    const c1 = box.cloneB('closer-1');
    assert.equal(must(c1, ['begin', '--role', 'closer', '--session', 'closer-1'], '09:35').action, 'force-degrade');
    assert.equal(must(c1, ['sync', '-m', 'closer took the lease', '--no-sleep'], '09:35').ok, true);
    const beatArgs = (at, extra = []) => ['--role', 'closer', '--session', 'closer-1', '--phase', 'package', '--wait', '0', '--date', D, '--now', etIso(D, at), ...extra];
    // the documented command: every call pushes
    const first = c1.cli('heartbeat', beatArgs('09:39', ['--min-push-seconds', '0']), env);
    assert.equal(first.json.pushed, true, first.stdout);
    const second = c1.cli('heartbeat', beatArgs('09:43', ['--min-push-seconds', '0']), env);
    assert.equal(second.json.pushed, true, `a beat 4 minutes later must be pushed too: ${second.stdout}`);
    // without the flag the default 10-minute throttle would hide it
    const hidden = c1.cli('heartbeat', beatArgs('09:44'), env);
    assert.equal(hidden.json.reason, 'throttled');
    // the backup closer, 09:44: with the pushed heartbeat the closer is 1 minute old; the lease alone says 9 (the finding's repro)
    const backup = box.cloneB('backup');
    const seen = must(backup, ['status'], '09:44');
    assert.equal(seen.lease.source, 'heartbeat-file');
    assert.ok(seen.lease.ageMinutes <= 2, `age ${seen.lease.ageMinutes}`);
    assert.equal(JSON.parse(backup.git('show', `origin/${'claude/sonnet-every-day'}:state/runs/${D}.json`)).lease.heartbeatAt, etIso(D, '09:35'), 'a local `beat` never reaches the remote');
  } finally {
    box.cleanup();
    fs.rmSync(hb, { recursive: true, force: true });
  }
  assert.match(section(PLAYBOOK, '### 5.4 closer'), /node scripts\/heartbeat\.mjs --role closer --session <S> --phase package --wait 0 --min-push-seconds 0 --date <D>/);
});

test('heartbeat canary: a refused heartbeat-branch push shows as ok:false, and the documented work-branch liveness loop keeps the lease fresh with one tiny push (PLAYBOOK §4)', () => {
  const hb = tmpDir('sed-hb-');
  const box = realBox({ git: true });
  try {
    must(box, ['begin', '--role', 'primary', '--session', 'sP'], '03:55');
    must(box, ['sync', '-m', 'begin', '--no-sleep'], '03:56');
    const ok = box.cli('heartbeat', ['--role', 'primary', '--session', 'sP', '--phase', 'preflight', '--wait', '0', '--date', D, '--now', at('03:57')], { SED_HB_DIR: hb, SED_NO_SLEEP: '1' });
    assert.equal(ok.json.ok, true, ok.stdout);
    assert.equal(ok.json.pushed, true);
    // the proxy refuses the second branch from now on
    refuseHeartbeatBranch(box.remote);
    fs.rmSync(hb, { recursive: true, force: true });
    const refused = box.cli('heartbeat', ['--role', 'primary', '--session', 'sP', '--phase', 'ideate', '--wait', '0', '--date', D, '--now', at('03:58')], { SED_HB_DIR: hb, SED_NO_SLEEP: '1' });
    assert.equal(refused.json.ok, false, 'the canary must be able to see the refusal');
    assert.equal(refused.code, 1);
    // the fallback loop body of §4: beat, then sync only the run file, while agents are writing under work/
    box.write(`work/${D}/build/site/half-written.js`, 'in flight\n');
    must(box, ['beat', '--role', 'primary', '--session', 'sP', '--phase', 'build'], '04:17');
    const synced = must(box, ['sync', '-m', 'sed: liveness', '--paths', `state/runs/${D}.json`, '--no-sleep'], '04:17');
    assert.equal(synced.ok, true);
    assert.equal(synced.pushed, true);
    const remoteRun = JSON.parse(box.git('show', `origin/claude/sonnet-every-day:state/runs/${D}.json`));
    assert.equal(remoteRun.lease.heartbeatAt, at('04:17'));
    assert.equal(box.git('ls-tree', '-r', '--name-only', 'origin/claude/sonnet-every-day', '--', 'work').trim(), '', 'the liveness push carries nothing from work/');
    assert.match(box.git('status', '--short'), /work\//, 'the in-flight agent files stay in the tree, untouched');
  } finally {
    box.cleanup();
    fs.rmSync(hb, { recursive: true, force: true });
  }
  const four = section(PLAYBOOK, '## 4. Step 1');
  assert.match(four, /node scripts\/heartbeat\.mjs --role <R> --session <S> --phase <resumePhase> --wait 0 --date <D>/);
  assert.match(four, /--paths state\/runs\/<D>\.json/);
  assert.match(read('ops/OPERATING.md'), /Prove the heartbeat branch/);
  assert.match(read('ops/FAILURE_MODES.md'), /^\| FM-111 \|[^\n]*heartbeat branch/m);
});

test('closer: skip-phase before the final sync pushes the kaizen close and leaves a clean tree; the old order left a dirty run file (PLAYBOOK §5.4 steps 3 and 6)', () => {
  const seed = (box) => {
    const phases = ['preflight', 'ideate', 'select', 'spec', 'build', 'qa', 'revise', 'package', 'publish'];
    const run = {
      schema: 1, date: D, status: 'published', targetTier: 1, tier: 1, phase: 'kaizen',
      phasesDone: phases.map((phase) => ({ phase, at: at('06:00'), by: 'primary', note: '' })),
      attempts: {}, phaseStartedAt: { kaizen: at('07:30') },
      lease: { holder: 'primary', session: 'sP', acquiredAt: at('03:55'), heartbeatAt: at('07:30') },
      directives: [], chosen: { ideaId: 'i01', slug: 'toy', title: 'Toy' }, throttle: 'balanced',
      spend: { outputTokens: 0, agentCalls: 0, byPhase: {} }, publishedAt: at('07:30'), publishedUrl: 'u', events: [],
    };
    box.write(`state/runs/${D}.json`, run);
    box.write(`docs/d/${D}-toy/index.html`, 'x');
    box.write('state/history.json', { schema: 1, startDate: D, entries: [{ n: 1, date: D, slug: 'toy', title: 'Toy', tier: 1, path: `d/${D}-toy/` }] });
    box.git('add', '-A');
    box.git('commit', '-qm', 'published, kaizen owed');
    box.git('push', '-q', 'origin', 'claude/sonnet-every-day');
  };
  const skip = (c, hhmm) => must(c, ['skip-phase', '--phase', 'kaizen', '--reason', 'closer never runs the kaizen round', '--session', 'sC', '--role', 'closer'], hhmm);
  const oldOrder = realBox({ git: true });
  try {
    seed(oldOrder);
    const c = oldOrder.cloneB('closer');
    assert.deepEqual([must(c, ['begin', '--role', 'closer', '--session', 'sC'], '08:47').action, must(c, ['begin', '--role', 'closer', '--session', 'sC'], '08:47').kaizenPending], ['exit-published', true]);
    must(c, ['sync', '-m', 'x', '--no-sleep'], '08:48');
    skip(c, '08:49');
    assert.match(c.git('status', '--short'), /state\/runs\/.*\.json/, 'sync before skip-phase leaves the closure unpushed and the file dirty');
  } finally {
    oldOrder.cleanup();
  }
  const box = realBox({ git: true });
  try {
    seed(box);
    const c = box.cloneB('closer');
    assert.equal(must(c, ['begin', '--role', 'closer', '--session', 'sC'], '08:47').action, 'exit-published');
    skip(c, '08:49');
    const s = must(c, ['sync', '-m', 'closer pushes pending publication and closes kaizen', '--no-sleep'], '08:50');
    assert.deepEqual([s.ok, s.pushed], [true, true]);
    assert.equal(c.git('status', '--short'), '');
    assert.equal(JSON.parse(c.git('show', `origin/claude/sonnet-every-day:state/runs/${D}.json`)).phase, 'done');
  } finally {
    box.cleanup();
  }
  const closer = section(PLAYBOOK, '### 5.4 closer');
  const exitPublished = /\* `exit-published`:[^\n]*/.exec(closer)[0];
  assert.ok(exitPublished.indexOf('skip-phase') < exitPublished.indexOf('state.mjs sync'), 'skip-phase comes before the sync');
  assert.match(closer, /the kaizen `skip-phase` of step 3 when `kaizenPending` \(before the sync/);
});

test('kaizen feedback loop: the preflight commands exist, A5 tolerates a missing day, the git log lists shas only, and a hold file is harmless to the gates (PLAYBOOK §8.1, §10.6)', () => {
  const box = realBox();
  try {
    const none = runSnippet(box, 'A5', { D: '2026-10-07' });
    assert.equal(none.code, 0);
    assert.deepEqual(none.json, { clean: null, status: null, reason: 'no run file' });
    must(box, ['begin', '--role', 'primary', '--session', 'sP'], '03:55');
    assert.equal(runSnippet(box, 'A5', { D }).json.clean, false, 'an unpublished day is not clean');
  } finally {
    box.cleanup();
  }
  const preflight = section(PLAYBOOK, '### 8.1 preflight');
  const log = /`(git log --since="3 days ago"[^`]*)`/.exec(preflight)?.[1];
  assert.ok(log, 'the preflight carries the git log command');
  assert.match(log, /--format=%h --grep='\^kaizen\(' -- ops\/workflows scripts ops\/templates tests/);
  assert.match(preflight, /kaizen\.mjs digest --days 2/);
  assert.match(preflight, /state\/kaizen-hold\.md/);
  assert.match(section(PLAYBOOK, '### 10.6'), /`state\/kaizen-hold\.md` exists/);
  // run the documented log command in a repo with kaizen commits: only shas come out, whatever the subjects say
  const g = realBox({ git: true });
  try {
    g.write('ops/workflows/a.js', '// a\n');
    g.git('add', '-A');
    g.git('commit', '-qm', 'kaizen(pulse): $(touch /tmp/pwned) `x`');
    g.write('docs/other.txt', 'not a kaizen path\n');
    g.git('add', '-A');
    g.git('commit', '-qm', 'kaizen(cards): docs only');
    const out = spawnSync('bash', ['-c', log], { cwd: g.root, encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    const lines = out.stdout.trim().split('\n');
    assert.equal(lines.length, 1, 'only the kaizen commit that touched ops/workflows is a suspect');
    assert.match(lines[0], /^[0-9a-f]{7,40}$/);
  } finally {
    g.cleanup();
  }
  // the hold file lives under state/: the repo gate and the kaizen gate's clean-tree rule treat it as an ordinary tracked file
  const h = realBox();
  try {
    h.write('state/kaizen-hold.md', 'kaizen on hold since 2026-10-09\n');
    const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'validate.mjs'), 'repo'], { env: { ...process.env, SED_ROOT: h.root }, encoding: 'utf8' });
    assert.ok(!/kaizen-hold/.test(r.stdout), `validate repo must not trip over the hold file: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
  assert.match(read('ops/OPERATING.md'), /Quarantine\./);
  assert.match(read('ops/FAILURE_MODES.md'), /^\| FM-112 \|[^\n]*quarantine/m);
});

test('workflows: no escape sequence can sit in program text a clerk writes verbatim (2026-10-10 ideate lost both normalize rounds to one)', () => {
  // A clerk may decode \uXXXX or \xXX into the character, which changes the byte count and fails runFiles' size check
  // (only .json files get slack). Build such characters from code points instead. asciiJson is host code that is never shipped.
  const escape = /\\u[0-9a-fA-F]{4}|\\u\{|\\x[0-9a-fA-F]{2}/;
  for (const f of fs.readdirSync(path.join(REPO_ROOT, 'ops/workflows')).filter((n) => n.endsWith('.js'))) {
    read(`ops/workflows/${f}`).split('\n').forEach((line, i) => {
      if (!line.startsWith('const asciiJson =')) assert.ok(!escape.test(line), `ops/workflows/${f}:${i + 1} has an escape sequence a clerk may decode: ${line.trim().slice(0, 80)}`);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// consistency pass (2026-10-12): every number and command the playbook states agrees with the scripts and with itself
// ---------------------------------------------------------------------------------------------

test('A1: the day\'s own history entry is no slug clash (a rerun after history.mjs add), an earlier day\'s slug still is', () => {
  const box = realBox();
  try {
    const doc = { ...ideasDoc(10), chosenId: 'i01', carryoverOutId: null, rationale: 'the best one' };
    box.write(`state/ideas/${D}.json`, doc);
    const entry = (date, slug) => ({ n: 1, date, slug, title: slug, tier: 2, countsForNovelty: false });
    box.write('state/history.json', { schema: 1, startDate: '2026-10-01', entries: [entry('2026-10-08', 'older-page'), entry(D, 'todays-page')] });
    const a1 = (slug) => runSnippet(box, 'A1', { FILE: `state/ideas/${D}.json`, D, MODE: 'final', SLUG: slug });
    const own = a1('todays-page');
    assert.deepEqual([own.code, own.json.ok, own.json.problems], [0, true, []], 'history.mjs add replaces the same date: A1 must agree');
    const clash = a1('older-page');
    assert.equal(clash.code, 1);
    assert.deepEqual(clash.json.problems, ['slug "older-page" is already used by an earlier project']);
    assert.match(read('scripts/history.mjs'), /e\.slug === slug && e\.date !== date/, 'the rule A1 mirrors');
  } finally {
    box.cleanup();
  }
});

test('timetable: the §2 table is the planner\'s (A4, both timetables), the phase watch defaults to its wide caps, and the kaizen budget is one number', async () => {
  const a4 = snippet('A4');
  const pair = (name) => {
    const m = new RegExp(`const ${name} = NARROW\\n\\s*\\? (\\{[\\s\\S]*?\\})\\n\\s*: (\\{[\\s\\S]*?\\});`).exec(a4);
    assert.ok(m, `A4 has no ${name}`);
    return { narrow: new Function(`return ${m[1]}`)(), wide: new Function(`return ${m[2]}`)() };
  };
  const typical = pair('TYPICAL');
  const cap = pair('CAP');
  const two = section(PLAYBOOK, '## 2. The day at a glance');
  const rows = two.split('\n').filter((l) => /^\| [a-z]/.test(l) && l.split('|').length === 9).map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));
  const phases = ['preflight', 'ideate', 'select', 'spec', 'build', 'qa', 'revise', 'package', 'publish'];
  assert.deepEqual(rows.map((r) => r[0].split(' ')[0]), phases, 'one row per planned phase, in order');
  for (const [phase, ...cells] of rows) {
    const p = phase.split(' ')[0];
    const want = [typical.wide[1][p], typical.wide[2][p], cap.wide[p], typical.narrow[1][p], typical.narrow[2][p], cap.narrow[p]].map(String);
    assert.deepEqual(cells, want, `§2 row ${p} differs from A4`);
  }
  const pw = await import('../scripts/lib/phasewatch.mjs');
  assert.deepEqual({ ...pw.DEFAULT_PHASE_MINUTES }, { ...cap.wide, kaizen: 75 }, 'the watch default is "the hard cap column of PLAYBOOK section 2"');
  assert.match(two, /kaizen round[^\n]*`phaseBudgetMinutes` 75 \(§10\.6\)/);
  const kaizen = section(PLAYBOOK, '### 10.6 Kaizen phase');
  assert.match(kaizen, /--phase kaizen --minutes 75/);
  assert.match(kaizen, /phaseBudgetMinutes: 75/);
  assert.ok(!/\| kaizen[^\n]*\| 60 \|/.test(PLAYBOOK), 'no "typical 60" kaizen row: the round always ran to its budget');
  assert.match(section(PLAYBOOK, '### 6.3'), /35 minutes of reserve \(10 on a narrow machine\)/);
  assert.match(a4, /const RESERVE = NARROW \? 10 : 35;/);
});

test('liveness loops: the hand-written loops of §6.1 and §7.5 end inside their Bash timeout, like the loops watch arm prints', () => {
  const timeoutMs = 6_600_000;
  const canary = section(PLAYBOOK, '## 4. Step 1');
  assert.match(canary, /`timeout: 6600000`/);
  const workBranch = /`for i in ([\d ]+); do node -e "setTimeout\(\(\)=>\{\},(\d+)\)"/.exec(canary);
  assert.ok(workBranch, '§4 heartbeat canary has the work-branch loop');
  const rounds = workBranch[1].trim().split(/\s+/).length;
  assert.ok(rounds * Number(workBranch[2]) <= timeoutMs, `${rounds} rounds of ${workBranch[2]} ms outlast the ${timeoutMs} ms timeout: the last rounds never run`);
  assert.match(read('scripts/lib/phasewatch.mjs'), /workBranch \? Math\.min\(5,/, 'watch arm caps its work-branch loop at the same 5 rounds');
  const hb = /for i in \$\(seq 1 (\d+)\); do node scripts\/heartbeat\.mjs [^\n]*--wait (\d+)/.exec(section(PLAYBOOK, '### 7.5'));
  assert.ok(hb && Number(hb[1]) * Number(hb[2]) * 1000 <= timeoutMs, '§7.5 heartbeat loop fits its timeout');
});

test('timers: a phase-watch timer is deleted only while it is pending, in every place the playbook deletes one', () => {
  const sevenOneA = section(PLAYBOOK, '### 7.1a');
  assert.match(sevenOneA, /never `delete_trigger` it/);
  assert.match(sevenOneA, /the `deleteTrigger` it printed \(null: the timer fired or fell due/);
  assert.match(section(PLAYBOOK, '### 6.5a'), /the `deleteTrigger` it prints \(null: the timer fired or fell due, delete nothing\)/);
  assert.match(section(PLAYBOOK, '### 10.6 Kaizen phase'), /`state:"armed"` with `dueInMinutes` above 0 means the timer is still pending/);
  assert.match(section(PLAYBOOK, '## Appendix C'), /`deleteTrigger` \(null once the timer fired or fell due\)/);
  assert.match(read('scripts/lib/phasewatch.mjs'), /const timerFired = Boolean\(w\.firedAt \|\| w\.timerFiredAt\) \|\| at\.getTime\(\) >= w\.dueMs;/);
});

test('remote tools: every claude-code-remote tool the playbook has the operator call is allowed by rule 7 and loaded by the ToolSearch lines', () => {
  const rules = /<!-- protected:begin -->([\s\S]*?)<!-- protected:end -->/.exec(PLAYBOOK)[1];
  const allowed = /the only claude-code-remote tools you call are ([^\n]*?)\)\.\n/.exec(rules)?.[1] ?? '';
  const called = new Set([...PLAYBOOK.matchAll(/`(get_session|send_later|delete_trigger|update_trigger|add_repo|register_repo_root|list_triggers|create_trigger|send_message|archive_session)`/g)].map((m) => m[1]));
  assert.ok(called.has('update_trigger'), '7.1a falls back to update_trigger when a delete is denied');
  for (const tool of called) assert.ok(allowed.includes(`\`${tool}\``), `rule 7 does not allow ${tool}, which the playbook tells the operator to call`);
  const loads = [...PLAYBOOK.matchAll(/select:(mcp__claude-code-remote__[^`]*)`/g)].map((m) => m[1]).join(',');
  for (const tool of called) assert.ok(loads.includes(`mcp__claude-code-remote__${tool}`), `no ToolSearch line loads ${tool}`);
});

test('watchdogs and the deadman Action: CONTRACT and PLAYBOOK describe what begin and the workflows really do', () => {
  const contract = read('ops/CONTRACT.md');
  const row5 = contract.split('\n').find((l) => l.startsWith('| 5 |'));
  assert.ok(row5 && !/t2Until/.test(row5) && /no time threshold/.test(row5) && /`preflight` or `ideate` at ≥ 05:30/.test(row5), row5);
  const box = realBox();
  try {
    // wdB at its own 06:47, before t2Until (07:00): the scope-cut is added (the old row 5 said only from 07:00)
    must(box, ['begin', '--role', 'primary', '--session', 'sP'], '06:00');
    for (const [phase, hhmm] of [['preflight', '06:01'], ['ideate', '06:05']]) {
      must(box, ['phase-start', '--phase', phase, '--session', 'sP'], hhmm);
      if (phase === 'ideate') box.write(`work/${D}/ideate/DONE.json`, { ok: true, phase });
      must(box, ['phase-done', '--phase', phase, '--note', 'x', '--session', 'sP', '--role', 'primary'], hhmm);
    }
    must(box, ['phase-start', '--phase', 'select', '--session', 'sP'], '06:20');
    const wdB = must(box, ['begin', '--role', 'wdB', '--session', 'wdB-1'], '06:47');
    assert.deepEqual([wdB.action, wdB.directiveAdded], ['exit-alive', true]);
  } finally {
    box.cleanup();
  }
  const early = realBox();
  try {
    // wdA at 05:32 with the primary still in preflight: a scope-cut (the old row 5 named ideate only)
    must(early, ['begin', '--role', 'primary', '--session', 'sP'], '05:00');
    must(early, ['phase-start', '--phase', 'preflight', '--session', 'sP'], '05:01');
    const wdA = must(early, ['begin', '--role', 'wdA', '--session', 'wdA-1'], '05:32');
    assert.deepEqual([wdA.action, wdA.directiveAdded], ['exit-alive', true]);
  } finally {
    early.cleanup();
  }
  for (const [name, text] of [['PLAYBOOK', PLAYBOOK], ['CONTRACT', contract]]) assert.ok(!/dormant/.test(text), `${name} still calls the deadman Action dormant; sync-main keeps main in step (FM-75)`);
  assert.ok(fs.existsSync(path.join(REPO_ROOT, '.github/workflows/sync-main.yml')));
  assert.match(read('.github/workflows/deadman.yml'), /cron: '40 13 \* \* \*'/);
});
