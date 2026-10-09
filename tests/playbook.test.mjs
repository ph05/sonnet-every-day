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
import { etIso } from './helpers/env.mjs';
import { levelConfigFor, stagingDirs } from '../scripts/lib/runstate.mjs';

const D = '2026-10-09';
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const PLAYBOOK = read('ops/PLAYBOOK.md');
const REAL_CONFIG = JSON.parse(read('config.json'));
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
  const box = git ? makeRepoSandbox({ config: REAL_CONFIG }) : makeSandbox({ config: REAL_CONFIG });
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

test('backup closer: a second closer session takes over a dead closer without waiting for staleness', () => {
  const box = realBox();
  try {
    walk(box, 'select');
    const c1 = must(box, ['begin', '--role', 'closer', '--session', 'closer-1'], '07:27');
    assert.equal(c1.action, 'force-degrade');
    assert.equal(c1.targetTier, 3);
    // closer-1's container dies here. At 07:42 its lease is 15 minutes old: far from the 35-minute stale limit.
    const c2 = must(box, ['begin', '--role', 'closer', '--session', 'closer-2'], '07:42');
    assert.equal(c2.action, 'force-degrade', 'the backup closer must not exit-alive on the dead closer\'s lease');
    assert.equal(c2.lease.session, 'closer-2');
    const status = must(box, ['status'], '07:44');
    assert.equal(status.lease.holder, 'closer');
    assert.equal(typeof status.lease.ageMinutes, 'number', 'the closer grace rule of PLAYBOOK §5.4 reads lease.ageMinutes');
    assert.equal(status.lease.session, 'closer-2');
    // the first closer is back to life and begins again: it is simply displaced (the lease moved to closer-2)
    const c1again = must(box, ['begin', '--role', 'closer', '--session', 'closer-1'], '07:46');
    assert.equal(c1again.action, 'force-degrade');
  } finally {
    box.cleanup();
  }
});

test('backup closer: the documents describe the second routine consistently', () => {
  const closer = section(PLAYBOOK, '### 5.4 closer');
  assert.match(closer, /backup closer/i);
  assert.match(closer, /07:42/);
  assert.match(closer, /ageMinutes/);
  assert.match(read('ops/prompts/README.md'), /closer backup[^\n]*`42 7 \* \* \*`[^\n]*`closer\.md`/);
  assert.match(read('ops/OPERATING.md'), /07:42[^\n]*closer backup/);
  assert.match(read('ops/OPERATING.md'), /`42 7 \* \* \*`/);
  const fm = read('ops/FAILURE_MODES.md');
  assert.match(fm, /^\| FM-81 \|[^\n]*closer[^\n]*backup closer/im);
  assert.match(fm, /FM-75[^\n]*07:42/);
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
  assert.match(spec, /tier: BUILD_TIER,\s*\n\s*compact: USE_COMPACT,/, 'spec/DONE.json must hold compact and tier');
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

test('rescue: wdB taking over after build is done gets tier 2 at package, and the optional compact QA of PLAYBOOK §4.1 works', () => {
  const box = realBox();
  try {
    walk(box, 'qa');
    must(box, ['phase-start', '--phase', 'qa', '--session', 'sP'], '06:10');
    const t = must(box, ['begin', '--role', 'wdB', '--session', 'sB'], '06:47');
    assert.deepEqual([t.action, t.targetTier, t.resumePhase, t.builtSiteAvailable], ['takeover', 2, 'package', true]);
    // §4.1 step 2: the skipped qa phase can still be run and closed
    const s = must(box, ['phase-start', '--phase', 'qa', '--session', 'sB'], '06:49');
    assert.equal(s.overLimit, false);
    const d = must(box, ['phase-done', '--phase', 'qa', '--note', 'compact qa', '--session', 'sB', '--role', 'wdB'], '07:00');
    assert.deepEqual([d.alreadyDone, d.next, d.targetTier], [true, 'package', 2]);
  } finally {
    box.cleanup();
  }
});

test('rescue: the closer is also offered the finished build, and the documents route it to §4.1', () => {
  const box = realBox();
  try {
    walk(box, 'qa');
    const c = must(box, ['begin', '--role', 'closer', '--session', 'closer-1'], '07:30');
    assert.deepEqual([c.action, c.targetTier, c.resumePhase, c.builtSiteAvailable], ['force-degrade', 2, 'package', true]);
    const late = realBox();
    try {
      walk(late, 'qa');
      const l = must(late, ['begin', '--role', 'closer', '--session', 'closer-1'], '07:50');
      assert.equal(l.targetTier, 3, 'with less than 20 minutes left the closer must fall back, not rescue');
    } finally {
      late.cleanup();
    }
  } finally {
    box.cleanup();
  }
  const four = section(PLAYBOOK, '### 4.1');
  for (const needle of [/builtSiteAvailable/, /targetTier. 2/, /resumePhase. `package`/, /not.*§9/s, /smoke/, /Tier 2/]) assert.match(four, needle);
  assert.match(section(PLAYBOOK, '### 5.3 wdB'), /§4\.1/);
  assert.match(section(PLAYBOOK, '### 5.4 closer'), /force-degrade. with `targetTier` 2 and `resumePhase` `package`/);
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
