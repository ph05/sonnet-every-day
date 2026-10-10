// Tests for scripts/history.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { addProject, removeDate, digest, loadHistory } from '../scripts/history.mjs';
import { makeSandbox, projectJson, fingerprint, REAL_ROOT } from './fixtures/gate-helpers.mjs';

const HISTORY_CLI = path.join(REAL_ROOT, 'scripts', 'history.mjs');

function makeProject(box, { date = '2026-10-09', slug = 'sample-toy', ...over } = {}) {
  const dir = path.join(box.root, 'docs', 'd', `${date}-${slug}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(projectJson({ date, slug, tier: 1, ...over }), null, 2));
  return dir;
}

const raw = (box) => JSON.parse(fs.readFileSync(path.join(box.root, 'state', 'history.json'), 'utf8'));

test('loadHistory: missing file gives an empty history, corrupt file throws', () => {
  const box = makeSandbox();
  try {
    fs.rmSync(path.join(box.root, 'state', 'history.json'));
    const h = loadHistory();
    assert.deepEqual(h.entries, []);
    assert.equal(h.startDate, box.cfg.startDate);
    fs.writeFileSync(path.join(box.root, 'state', 'history.json'), '{nope');
    assert.throws(() => loadHistory(), /readJson/);
    fs.writeFileSync(path.join(box.root, 'state', 'history.json'), '{"entries": 5}');
    assert.throws(() => loadHistory(), /entries/);
  } finally {
    box.cleanup();
  }
});

test('addProject builds the entry from project.json', () => {
  const box = makeSandbox();
  try {
    const dir = makeProject(box, { tagline: 'A tagline', title: 'Sample Toy' });
    const now = new Date('2026-10-09T13:30:00Z');
    const { entry, replaced } = addProject(dir, { now });
    assert.equal(replaced, false);
    assert.deepEqual(entry, {
      n: 1, date: '2026-10-09', slug: 'sample-toy', title: 'Sample Toy', tagline: 'A tagline', tier: 1,
      fingerprint: fingerprint(), path: 'd/2026-10-09-sample-toy/', publishedAt: '2026-10-09T13:30:00.000Z', countsForNovelty: true,
    });
    assert.deepEqual(raw(box).entries, [entry]);
    assert.equal(raw(box).schema, 1);
  } finally {
    box.cleanup();
  }
});

test('addProject: n is the day number, entries stay sorted by date', () => {
  const box = makeSandbox();
  try {
    addProject(makeProject(box, { date: '2026-10-12', slug: 'c' }), {});
    addProject(makeProject(box, { date: '2026-10-09', slug: 'a' }), {});
    addProject(makeProject(box, { date: '2026-10-10', slug: 'b' }), {});
    const h = raw(box);
    assert.deepEqual(h.entries.map((e) => [e.date, e.n]), [['2026-10-09', 1], ['2026-10-10', 2], ['2026-10-12', 4]]);
  } finally {
    box.cleanup();
  }
});

test('addProject is idempotent and keeps n and publishedAt', () => {
  const box = makeSandbox();
  try {
    const dir = makeProject(box);
    addProject(dir, { now: new Date('2026-10-09T12:00:00Z') });
    const first = fs.readFileSync(path.join(box.root, 'state', 'history.json'), 'utf8');
    const again = addProject(dir, { now: new Date('2026-10-09T18:00:00Z') });
    assert.equal(again.replaced, true);
    assert.equal(fs.readFileSync(path.join(box.root, 'state', 'history.json'), 'utf8'), first);
    assert.equal(raw(box).entries.length, 1);
  } finally {
    box.cleanup();
  }
});

test('addProject keeps n when the entry is replaced even if startDate later changes', () => {
  const box = makeSandbox();
  try {
    const dir = makeProject(box);
    addProject(dir, {});
    const h = raw(box);
    h.entries[0].n = 7;
    fs.writeFileSync(path.join(box.root, 'state', 'history.json'), JSON.stringify(h));
    addProject(dir, {});
    assert.equal(raw(box).entries[0].n, 7);
  } finally {
    box.cleanup();
  }
});

test('addProject replaces the entry when a better tier takes over the date', () => {
  const box = makeSandbox();
  try {
    const fallback = makeProject(box, { slug: 'postcard', tier: 4, title: 'Postcard' });
    addProject(fallback, { countsForNovelty: false, now: new Date('2026-10-09T11:00:00Z') });
    assert.equal(raw(box).entries[0].countsForNovelty, false);
    const real = makeProject(box, { slug: 'sample-toy', tier: 1 });
    const { replaced, entry } = addProject(real, { now: new Date('2026-10-09T20:00:00Z') });
    assert.equal(replaced, true);
    assert.equal(raw(box).entries.length, 1);
    assert.equal(entry.slug, 'sample-toy');
    assert.equal(entry.publishedAt, '2026-10-09T20:00:00.000Z');
    assert.equal(entry.countsForNovelty, true);
  } finally {
    box.cleanup();
  }
});

test('addProject: countsForNovelty defaults by tier and honours the option', () => {
  const box = makeSandbox();
  try {
    assert.equal(addProject(makeProject(box, { date: '2026-10-09', slug: 'a', tier: 2 }), {}).entry.countsForNovelty, true);
    assert.equal(addProject(makeProject(box, { date: '2026-10-10', slug: 'ideas-day', tier: 3 }), {}).entry.countsForNovelty, false);
    assert.equal(addProject(makeProject(box, { date: '2026-10-11', slug: 'postcard', tier: 4 }), {}).entry.countsForNovelty, false);
    assert.equal(addProject(makeProject(box, { date: '2026-10-12', slug: 'b', tier: 1 }), { countsForNovelty: false }).entry.countsForNovelty, false);
  } finally {
    box.cleanup();
  }
});

test('addProject: taglines are clipped to 120 characters', () => {
  const box = makeSandbox();
  try {
    const { entry } = addProject(makeProject(box, { tagline: `${'word '.repeat(60)}end` }), {});
    assert.ok(entry.tagline.length <= 120);
    assert.ok(entry.tagline.endsWith('…'));
  } finally {
    box.cleanup();
  }
});

test('addProject refuses bad input without touching the history file', () => {
  const box = makeSandbox();
  try {
    const before = fs.readFileSync(path.join(box.root, 'state', 'history.json'), 'utf8');
    assert.throws(() => addProject(path.join(box.root, 'nope')), /not found/);

    const noJson = path.join(box.root, 'docs', 'd', '2026-10-09-empty');
    fs.mkdirSync(noJson, { recursive: true });
    assert.throws(() => addProject(noJson), /readJson/);

    assert.throws(() => addProject(makeProject(box, { tier: 9 })), /tier/);
    assert.throws(() => addProject(makeProject(box, { slug: 'Bad Slug', date: '2026-10-10' })), /slug/);
    assert.throws(() => addProject(makeProject(box, { title: '', date: '2026-10-11', slug: 'x' })), /title/);

    const mismatched = makeProject(box, { date: '2026-10-12', slug: 'real' });
    const renamed = path.join(path.dirname(mismatched), '2026-10-12-other');
    fs.renameSync(mismatched, renamed);
    assert.throws(() => addProject(renamed), /does not match/);

    assert.throws(() => addProject(makeProject(box, { date: '2026-09-01', slug: 'early' })), /before the start date/);
    assert.equal(fs.readFileSync(path.join(box.root, 'state', 'history.json'), 'utf8'), before);
  } finally {
    box.cleanup();
  }
});

test('addProject refuses to overwrite a corrupt history file', () => {
  const box = makeSandbox();
  try {
    fs.writeFileSync(path.join(box.root, 'state', 'history.json'), '{corrupt');
    assert.throws(() => addProject(makeProject(box)), /readJson/);
    assert.equal(fs.readFileSync(path.join(box.root, 'state', 'history.json'), 'utf8'), '{corrupt');
  } finally {
    box.cleanup();
  }
});

test('addProject: slugs are unique for real builds, fallback slugs may repeat', () => {
  const box = makeSandbox();
  try {
    addProject(makeProject(box, { date: '2026-10-09', slug: 'same' }), {});
    assert.throws(() => addProject(makeProject(box, { date: '2026-10-10', slug: 'same' }), {}), /already used/);
    addProject(makeProject(box, { date: '2026-10-11', slug: 'postcard', tier: 4 }), {});
    addProject(makeProject(box, { date: '2026-10-12', slug: 'postcard', tier: 4 }), {});
    assert.equal(raw(box).entries.length, 3);
  } finally {
    box.cleanup();
  }
});

test('writes are atomic: no temp files linger and the file is always valid JSON', () => {
  const box = makeSandbox();
  try {
    for (let i = 0; i < 8; i++) addProject(makeProject(box, { date: `2026-10-${String(9 + i).padStart(2, '0')}`, slug: `p${i}` }), {});
    const names = fs.readdirSync(path.join(box.root, 'state'));
    assert.deepEqual(names.filter((n) => n.endsWith('.tmp')), []);
    assert.equal(raw(box).entries.length, 8);
  } finally {
    box.cleanup();
  }
});

test('removeDate removes the entry, tolerates a missing date, optionally deletes the directory', () => {
  const box = makeSandbox();
  try {
    const dir = makeProject(box);
    addProject(dir, {});
    assert.deepEqual(removeDate('2026-10-20'), { removed: false, entry: null, dirDeleted: false });
    const keep = removeDate('2026-10-09');
    assert.equal(keep.removed, true);
    assert.equal(keep.dirDeleted, false);
    assert.ok(fs.existsSync(dir));
    assert.deepEqual(raw(box).entries, []);

    addProject(dir, {});
    const gone = removeDate('2026-10-09', { deleteDir: true });
    assert.equal(gone.dirDeleted, true);
    assert.ok(!fs.existsSync(dir));
    assert.throws(() => removeDate('tomorrow'), /bad date/);
  } finally {
    box.cleanup();
  }
});

test('removeDate never deletes outside docs/d', () => {
  const box = makeSandbox();
  try {
    const victim = path.join(box.root, 'keepme');
    fs.mkdirSync(victim);
    const h = raw(box);
    h.entries.push({ n: 1, date: '2026-10-09', slug: 'x', title: 'x', path: '../../keepme/', tier: 1, fingerprint: fingerprint(), countsForNovelty: true });
    fs.writeFileSync(path.join(box.root, 'state', 'history.json'), JSON.stringify(h));
    assert.equal(removeDate('2026-10-09', { deleteDir: true }).dirDeleted, false);
    assert.ok(fs.existsSync(victim));
  } finally {
    box.cleanup();
  }
});

test('digest: one plain line per project, oldest first, limit keeps the newest', () => {
  const box = makeSandbox();
  try {
    assert.equal(digest(), '(no past projects yet)');
    addProject(makeProject(box, { date: '2026-10-09', slug: 'a', title: 'Alpha | Pipe', fingerprint: fingerprint({ category: 'cards-odds', mechanic: 'solver', tags: ['poker', 'gto', 'ranges'] }) }), {});
    addProject(makeProject(box, { date: '2026-10-10', slug: 'postcard', tier: 4, title: 'Postcard' }), {});
    addProject(makeProject(box, { date: '2026-10-11', slug: 'c', title: 'Gamma\nLine' }), {});
    const lines = digest().split('\n');
    assert.equal(lines.length, 3);
    assert.equal(lines[0], '2026-10-09 | Alpha Pipe | cards-odds | solver | poker,gto,ranges');
    assert.equal(lines[1], '2026-10-10 | Postcard (fallback day) | math-puzzle | toy | automaton,cells,palette');
    assert.equal(lines[2], '2026-10-11 | Gamma Line | math-puzzle | toy | automaton,cells,palette');
    for (const l of lines) assert.equal(l.split(' | ').length, 5);
    assert.deepEqual(digest({ limit: 2 }).split('\n').map((l) => l.slice(0, 10)), ['2026-10-10', '2026-10-11']);
    assert.equal(digest({ limit: '1' }).split('\n').length, 1);
    assert.equal(digest({ limit: 0 }).split('\n').length, 3);
  } finally {
    box.cleanup();
  }
});

function cli(box, args) {
  const r = spawnSync(process.execPath, [HISTORY_CLI, ...args], { env: { ...process.env, SED_ROOT: box.root }, encoding: 'utf8', cwd: box.root });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('CLI: add, digest, remove print one JSON document', () => {
  const box = makeSandbox();
  try {
    const dir = makeProject(box);
    const add = cli(box, ['add', '--project', dir, '--now', '2026-10-09T12:00:00Z']);
    assert.equal(add.code, 0, add.err);
    const added = JSON.parse(add.out);
    assert.equal(added.ok, true);
    assert.equal(added.replaced, false);
    assert.equal(added.entry.publishedAt, '2026-10-09T12:00:00.000Z');

    const again = JSON.parse(cli(box, ['add', '--project', path.relative(box.root, dir)]).out);
    assert.equal(again.replaced, true);
    assert.equal(raw(box).entries.length, 1);

    const d = JSON.parse(cli(box, ['digest', '--limit', '5']).out);
    assert.equal(d.ok, true);
    assert.equal(d.count, 1);
    assert.match(d.digest, /^2026-10-09 \| Probe \|/);

    const text = cli(box, ['digest', '--text']);
    assert.equal(text.code, 0);
    assert.match(text.out, /^2026-10-09 \| Probe \|/);

    const rm = JSON.parse(cli(box, ['remove', '--date', '2026-10-09']).out);
    assert.equal(rm.removed, true);
    assert.equal(JSON.parse(cli(box, ['digest']).out).count, 0);
  } finally {
    box.cleanup();
  }
});

test('CLI: usage errors exit 2, runtime errors exit 1 with ok:false', () => {
  const box = makeSandbox();
  try {
    assert.equal(cli(box, []).code, 2);
    assert.equal(cli(box, ['add']).code, 2);
    assert.equal(cli(box, ['remove']).code, 2);
    const bad = cli(box, ['add', '--project', path.join(box.root, 'missing')]);
    assert.equal(bad.code, 1);
    assert.equal(JSON.parse(bad.out).ok, false);
  } finally {
    box.cleanup();
  }
});

test('importing history.mjs has no side effects', () => {
  const r = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(HISTORY_CLI)}).then(() => console.log('imported'))`], { encoding: 'utf8' });
  assert.equal(r.stdout.trim(), 'imported');
  assert.equal(r.stderr, '');
});
