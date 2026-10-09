// Tests for scripts/validate.mjs: every attack vector in fixtures/gate-vectors.mjs, structure rules, repo checks, speed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateProject, validateRepo } from '../scripts/validate.mjs';
import { MALICIOUS, BENIGN } from './fixtures/gate-vectors.mjs';
import {
  makeSandbox, buildProject, makePng, projectJson, fingerprint, codesOf, REAL_ROOT,
} from './fixtures/gate-helpers.mjs';

const VALIDATE = path.join(REAL_ROOT, 'scripts', 'validate.mjs');

function probe(box, spec) {
  const { errors, warnings, ...build } = spec;
  void errors;
  void warnings;
  return buildProject(path.join(box.root, 'docs', 'd'), build);
}

// Vectors run as tier 3 unless they name a tier (template leftovers only matter for the builder-made tiers).
const tierOf = (spec) => spec.tier ?? 3;

test('malicious vectors are all rejected with the expected codes', async (t) => {
  const box = makeSandbox();
  t.after(() => box.cleanup());
  for (const spec of MALICIOUS) {
    await t.test(spec.id, async () => {
      const res = await validateProject(probe(box, spec), { tier: tierOf(spec) });
      const errs = codesOf(res.errors);
      const warns = codesOf(res.warnings);
      for (const code of spec.errors ?? []) assert.ok(errs.includes(code), `expected error ${code}; errors=${JSON.stringify(res.errors)}`);
      for (const code of spec.warnings ?? []) assert.ok(warns.includes(code), `expected warning ${code}; warnings=${JSON.stringify(res.warnings)}`);
      if (spec.errors?.length) assert.equal(res.ok, false);
    });
  }
});

test('template leftovers and placeholder hosts are ignored on the generated fallback tiers', async () => {
  const box = makeSandbox();
  try {
    const dir = buildProject(path.join(box.root, 'docs', 'd'), { tier: 4, body: '<div data-sed-placeholder>x</div>', shell: { title: 'Project Title' }, pj: { sources: [{ title: 'Name of a page that was actually consulted', url: 'https://example.org/source' }], tagline: 'One line that makes someone want to try it' } });
    const res = await validateProject(dir, { tier: 4 });
    assert.deepEqual(res.errors, []);
    assert.deepEqual(res.warnings, []);
  } finally {
    box.cleanup();
  }
});

test('benign vectors produce no errors', async (t) => {
  const box = makeSandbox();
  t.after(() => box.cleanup());
  for (const spec of BENIGN) {
    await t.test(spec.id, async () => {
      const res = await validateProject(probe(box, spec), { tier: tierOf(spec) });
      assert.deepEqual(res.errors, [], `unexpected errors: ${JSON.stringify(res.errors)}`);
      for (const code of spec.warnings ?? []) assert.ok(codesOf(res.warnings).includes(code), `expected warning ${code}`);
      assert.equal(res.ok, true);
    });
  }
});

const BENIGN_FIXTURE = path.join(REAL_ROOT, 'tests', 'fixtures', 'gate-benign', '2026-10-09-sample-toy');

test('the benign fixture project validates cleanly at tier 1', async () => {
  const box = makeSandbox();
  try {
    const res = await validateProject(BENIGN_FIXTURE, { tier: 1 });
    assert.deepEqual(res.errors, []);
    assert.deepEqual(res.warnings, []);
    assert.equal(res.ok, true);
    assert.ok(res.stats.ownLoc >= 700, `ownLoc ${res.stats.ownLoc}`);
    assert.equal(res.stats.files, 10);
  } finally {
    box.cleanup();
  }
});

function project(box, opts = {}) {
  return buildProject(path.join(box.root, 'docs', 'd'), opts);
}

async function run(box, opts, vopts = { tier: 3 }) {
  return validateProject(project(box, opts), vopts);
}

test('project.json rules', async (t) => {
  const box = makeSandbox();
  t.after(() => box.cleanup());
  const has = (res, code) => assert.ok(codesOf(res.errors).includes(code), `expected ${code}; got ${JSON.stringify(res.errors)}`);
  const hasW = (res, code) => assert.ok(codesOf(res.warnings).includes(code), `expected warning ${code}; got ${JSON.stringify(res.warnings)}`);

  await t.test('a clean tier 3 probe has no errors', async () => {
    const res = await run(box, {});
    assert.deepEqual(res.errors, []);
    assert.equal(res.ok, true);
  });
  await t.test('missing project.json', async () => {
    const dir = project(box, {});
    fs.rmSync(path.join(dir, 'project.json'));
    has(await validateProject(dir, { tier: 3 }), 'project-json');
  });
  await t.test('unparseable project.json', async () => {
    const dir = project(box, {});
    fs.writeFileSync(path.join(dir, 'project.json'), '{nope');
    has(await validateProject(dir, { tier: 3 }), 'project-json');
  });
  await t.test('wrong schema, missing title, tier out of range', async () => {
    const res = await run(box, { pj: { schema: 2, title: '', tier: 7 } }, {});
    assert.ok(res.errors.filter((e) => e.startsWith('project-json')).length >= 3, JSON.stringify(res.errors));
  });
  await t.test('directory name must match date and slug', async () => {
    const dir = project(box, {});
    const other = path.join(path.dirname(dir), '2026-10-10-probe');
    fs.rmSync(other, { recursive: true, force: true });
    fs.renameSync(dir, other);
    has(await validateProject(other, { tier: 3 }), 'dir-name');
  });
  await t.test('directory name must look like a dated slug', async () => {
    const dir = project(box, {});
    const other = path.join(path.dirname(dir), 'whatever');
    fs.rmSync(other, { recursive: true, force: true });
    fs.renameSync(dir, other);
    has(await validateProject(other, { tier: 3 }), 'dir-name');
  });
  await t.test('tagline over 120 chars', async () => {
    has(await run(box, { pj: { tagline: 'x'.repeat(121) } }), 'project-json');
  });
  await t.test('requested tier must match project.json', async () => {
    has(await run(box, { tier: 3 }, { tier: 1 }), 'tier-mismatch');
  });
  await t.test('fingerprint vocabulary is enforced', async () => {
    for (const bad of [{ category: 'nope' }, { mechanic: 'nope' }, { tone: ['nope'] }, { tone: [] }, { slot: 'nope' }, { political: 'yes' }]) {
      has(await run(box, { pj: { fingerprint: fingerprint(bad) } }), 'fingerprint');
    }
  });
  await t.test('tag shape is an error for tier 1/2 and a warning for fallbacks', async () => {
    const bad = fingerprint({ tags: ['One Tag'] });
    has(await run(box, { tier: 1, pj: { tier: 1, fingerprint: bad } }, { tier: 1 }), 'fingerprint');
    hasW(await run(box, { tier: 3, pj: { fingerprint: bad } }), 'fingerprint');
  });
  await t.test('palette must be hex colours', async () => {
    has(await run(box, { pj: { palette: ['red', 'blue'] } }), 'project-json');
    has(await run(box, { pj: { palette: ['#fff'] } }), 'project-json');
  });
  await t.test('network entries must be bare hostnames', async () => {
    for (const bad of ['https://api.example.org', '*.example.org', 'api.example.org/v1', 'localhost', '10.0.0.1', 'api.example.org:8080', '']) {
      has(await run(box, { pj: { network: [bad] } }), 'project-json');
    }
  });
  await t.test('network must be an array', async () => {
    has(await run(box, { pj: { network: 'api.example.org' } }), 'project-json');
  });
  await t.test('sources must be {title,url}', async () => {
    has(await run(box, { pj: { sources: [{ title: 'x', url: 'javascript:1' }] } }), 'project-json');
    has(await run(box, { pj: { sources: 'x' } }), 'project-json');
  });
  await t.test('entry and thumb must exist and be relative', async () => {
    has(await run(box, { pj: { entry: 'main.html' } }), 'missing-entry');
    has(await run(box, { pj: { entry: '../x.html' } }), 'project-json');
    has(await run(box, { pj: { thumb: 'nope.png' } }), 'missing-thumb');
  });
  await t.test('a future project date is a warning', async () => {
    const res = await run(box, { date: '2027-01-01' }, { tier: 3, now: new Date('2026-10-09T12:00:00Z') });
    hasW(res, 'project-date');
  });
  await t.test('a missing directory is an error, not a crash', async () => {
    const res = await validateProject(path.join(box.root, 'nope'), {});
    has(res, 'no-such-dir');
  });
});

test('thumbnail checks', async (t) => {
  const box = makeSandbox();
  t.after(() => box.cleanup());
  const has = (res, code) => assert.ok(codesOf(res.errors).includes(code), `expected ${code}; got ${JSON.stringify(res.errors)}`);
  await t.test('valid 1200x630 PNG', async () => {
    assert.deepEqual((await run(box, {})).errors, []);
  });
  await t.test('wrong dimensions', async () => {
    has(await run(box, { thumb: makePng(1199, 630) }), 'thumb-size');
    has(await run(box, { thumb: makePng(1200, 600) }), 'thumb-size');
  });
  await t.test('not a PNG', async () => {
    has(await run(box, { thumb: Buffer.from('GIF89a plus some padding bytes to pass the length floor.........') }), 'thumb-not-png');
    has(await run(box, { thumb: Buffer.alloc(0) }), 'thumb-not-png');
  });
  await t.test('truncated PNG', async () => {
    const full = makePng();
    has(await run(box, { thumb: full.subarray(0, full.length - 20) }), 'thumb-corrupt');
  });
  await t.test('corrupt IHDR checksum', async () => {
    const bad = Buffer.from(makePng());
    bad[29] ^= 0xff;
    has(await run(box, { thumb: bad }), 'thumb-corrupt');
  });
  await t.test('IHDR not first', async () => {
    const bad = Buffer.from(makePng());
    bad.write('IDAT', 12, 'latin1');
    has(await run(box, { thumb: bad }), 'thumb-corrupt');
  });
  await t.test('thumb over the byte cap', async () => {
    const small = makeSandbox({ config: (c) => { c.limits.thumbMaxBytes = 500; return c; } });
    try {
      has(await run(small, {}), 'thumb-too-large');
    } finally {
      small.cleanup();
      process.env.SED_ROOT = box.root;
    }
  });
  await t.test('missing thumb', async () => {
    has(await run(box, { thumb: null }), 'missing-thumb');
  });
});

test('size and census limits', async (t) => {
  const box = makeSandbox({
    config: (c) => {
      c.limits.singleFileMaxBytes = 4000;
      c.limits.projectMaxFiles = 6;
      c.limits.projectMaxBytes = 20000;
      return c;
    },
  });
  t.after(() => box.cleanup());
  const has = (res, code) => assert.ok(codesOf(res.errors).includes(code), `expected ${code}; got ${JSON.stringify(res.errors)}`);
  await t.test('single file too large', async () => {
    has(await run(box, { files: { 'big.txt': 'x'.repeat(4001) } }), 'file-too-large');
  });
  await t.test('too many files', async () => {
    const files = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}.txt`, 'x']));
    has(await run(box, { files }), 'too-many-files');
  });
  await t.test('project too large', async () => {
    const files = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`f${i}.txt`, 'x'.repeat(3900)]));
    has(await run(box, { files }), 'project-too-large');
  });
  await t.test('symbolic links are rejected', async () => {
    const dir = project(box, {});
    fs.symlinkSync('/etc/hosts', path.join(dir, 'link.txt'));
    has(await validateProject(dir, { tier: 3 }), 'symlink');
  });
});

test('own lines of code', async (t) => {
  const box = makeSandbox();
  t.after(() => box.cleanup());
  const lines = (n) => Array.from({ length: n }, (_, i) => `const v${i} = ${i};`).join('\n') + '\n';
  const asTier = (tier, extra = {}) => ({ tier, pj: { tier, fingerprint: fingerprint() }, ...extra });
  const codes = (res) => ({ e: codesOf(res.errors), w: codesOf(res.warnings) });

  await t.test('tier 1 needs 700 (error under 70%)', async () => {
    const res = await run(box, asTier(1, { js: lines(100) }), { tier: 1 });
    assert.ok(codes(res).e.includes('own-loc'), JSON.stringify(res.errors));
  });
  await t.test('tier 1 within 30% of the minimum only warns', async () => {
    const res = await run(box, asTier(1, { js: lines(600) }), { tier: 1 });
    assert.ok(!codes(res).e.includes('own-loc'), JSON.stringify(res.errors));
    assert.ok(codes(res).w.includes('own-loc'));
  });
  await t.test('tier 1 at the minimum passes', async () => {
    const res = await run(box, asTier(1, { js: lines(700) }), { tier: 1 });
    assert.ok(!codes(res).e.includes('own-loc') && !codes(res).w.includes('own-loc'), JSON.stringify(res));
  });
  await t.test('tier 2 needs 350', async () => {
    assert.ok(codes(await run(box, asTier(2, { js: lines(100) }), { tier: 2 })).e.includes('own-loc'));
    assert.ok(codes(await run(box, asTier(2, { js: lines(300) }), { tier: 2 })).w.includes('own-loc'));
    const ok = codes(await run(box, asTier(2, { js: lines(360) }), { tier: 2 }));
    assert.ok(!ok.e.includes('own-loc') && !ok.w.includes('own-loc'));
  });
  await t.test('tiers 3 and 4 are exempt', async () => {
    for (const tier of [3, 4]) {
      const res = await run(box, { tier, pj: { tier } }, { tier });
      assert.ok(!codes(res).e.includes('own-loc'));
    }
  });
  await t.test('blank lines, comments, long lines, data and vendor files are not counted', async () => {
    const js = [
      '// a comment', '', '/* block', '   still comment */', 'const a = 1; // trailing comment still counts the line', '   ', '/* x */ const b = 2;',
      `const blob = "${'x'.repeat(420)}";`, 'const c = 3;',
    ].join('\n');
    const res = await run(box, {
      js,
      css: '/* css comment */\nbody { margin: 0; }\n\n/* multi\nline */\n.a { color: red; }\n',
      files: { 'data/table.js': lines(500), 'vendor/lib.js': lines(500), 'lib/vendor-thing.js': lines(500), 'data/rows.json': '[1,2,3]' },
      body: '<!-- html comment -->\n<script src="data/table.js"></script>\n<script src="vendor/lib.js"></script>\n<script src="lib/vendor-thing.js"></script>',
    });
    // app.js: the `a` line (trailing comment), the `/* x */ const b` line and `c`; the 420-char line is skipped. app.css: 2 rules.
    const html = fs.readFileSync(path.join(box.root, 'docs', 'd', '2026-10-09-probe', 'index.html'), 'utf8');
    const htmlLines = html.split('\n').filter((l) => l.trim() && !/^\s*<!--.*-->\s*$/.test(l)).length;
    assert.equal(res.stats.ownLoc, 3 + 2 + htmlLines);
  });
  await t.test('inline script and style lines count, their comments do not', async () => {
    const res = await run(box, {
      head: '<style>\n/* c */\nbody { margin: 0; }\n</style>',
      inlineJs: '// comment\nconst x = 1;\n/* c\nc */\nconst y = 2;',
    });
    const html = fs.readFileSync(path.join(box.root, 'docs', 'd', '2026-10-09-probe', 'index.html'), 'utf8').split('\n');
    const skip = (l) => !l.trim() || /^\s*\/\/ comment\s*$/.test(l) || /^\s*\/\* c\s*$/.test(l) || /^\s*c \*\/\s*$/.test(l) || /^\s*\/\* c \*\/\s*$/.test(l);
    assert.equal(res.stats.ownLoc, html.filter((l) => !skip(l)).length);
  });
});

test('stats report files and bytes', async () => {
  const box = makeSandbox();
  try {
    const dir = project(box, { files: { 'a.txt': 'abc', 'sub/b.txt': 'defg' } });
    const res = await validateProject(dir, { tier: 3 });
    assert.equal(res.stats.files, 5);
    const sum = ['index.html', 'project.json', 'thumb.png', 'a.txt', 'sub/b.txt'].reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
    assert.equal(res.stats.bytes, sum);
  } finally {
    box.cleanup();
  }
});

test('internals: entity decoding and URL classification', async () => {
  const { __internals: I } = await import('../scripts/validate.mjs');
  assert.equal(I.decodeEntities('&#104;&#x74;&#x0074;p&colon;&sol;&sol;'), 'http://');
  assert.equal(I.decodeEntities('a&ampb &amp; &lt;&gt; &bogus; &#0; &#xD800;'), 'a&ampb & <> &bogus; ' + String.fromCharCode(0xfffd) + ' ' + String.fromCharCode(0xfffd));
  const k = (u) => I.classifyUrl(u);
  assert.deepEqual([k('').kind, k('#x').kind, k('a/b.png').kind, k('../../').kind, k('/abs').kind], ['empty', 'fragment', 'relative', 'relative', 'relative']);
  assert.equal(k('HTTPS://Example.COM./x').host, 'example.com');
  assert.equal(k('https://u:p@Example.com:8443/x').host, 'example.com');
  assert.equal(k('//a.example/x').host, 'a.example');
  assert.equal(k('\\\\a.example\\x').host, 'a.example');
  assert.equal(k('https://%65xample.com/').host, 'example.com');
  assert.equal(k('https://good.example\\@evil.example/').host, 'good.example');
  assert.equal(k('data:text/plain,hi').kind, 'data');
  assert.equal(k('blob:https://a/b').kind, 'blob');
  assert.equal(k(' \tjava\nscript:alert(1)').kind, 'javascript');
  assert.equal(k('mailto:a@b.c').kind, 'other');
  assert.equal(k('ftp://x.example/f').kind, 'external');
  assert.equal(k('file:///etc/passwd').kind, 'external');
});

test('internals: tokenizer follows browser comment and raw-text rules', async () => {
  const { __internals: I } = await import('../scripts/validate.mjs');
  const names = (html) => I.tokenizeHtml(html).filter((t) => t.t === 'start').map((t) => t.name);
  assert.deepEqual(names('<!-- <b> --><i>'), ['i']);
  assert.deepEqual(names('<!--><b>'), ['b']);
  assert.deepEqual(names('<!---><b>'), ['b']);
  assert.deepEqual(names('<!-- x --!><b>'), ['b']);
  assert.deepEqual(names('<script>var a="<b>";</script><i>'), ['script', 'i']);
  assert.deepEqual(names('<textarea><b></textarea><i>'), ['textarea', 'i']);
  assert.deepEqual(names('<title><b></title><i>'), ['title', 'i']);
  assert.deepEqual(names('<SCRIPT >x</SCRIPT\n><i>'), ['script', 'i']);
  assert.deepEqual(names('</><?php x ?><!DOCTYPE html><b>'), ['b']);
  const [tag] = I.tokenizeHtml('<a b=1 c="2" d=\'3\' e f/g href=x>').filter((t) => t.t === 'start');
  assert.deepEqual(tag.attrs.map((a) => [a.name, a.value]), [['b', '1'], ['c', '2'], ['d', '3'], ['e', ''], ['f', ''], ['g', ''], ['href', 'x']]);
});

test('internals: JS lexer handles regex, templates, comments and escapes', async () => {
  const { __internals: I } = await import('../scripts/validate.mjs');
  const lex = (src) => I.lexJs(src);
  const vals = (src) => lex(src).tokens.map((t) => t.value ?? t.type);
  assert.deepEqual(vals('a = b / c / d'), ['a', '=', 'b', '/', 'c', '/', 'd']);
  assert.deepEqual(lex('x = /["\']/g.test(y)').tokens.map((t) => t.type), ['id', 'punc', 'regex', 'punc', 'id', 'punc', 'id', 'punc']);
  const tpl = lex('`a${b + `c${d}`}e`').tokens[0];
  assert.equal(tpl.type, 'tpl');
  assert.deepEqual(tpl.quasis, ['a', 'e']);
  assert.equal(tpl.exprs.length, 1);
  assert.equal(lex("'a\\x41\\u0042\\u{43}\\n'").tokens[0].value, 'aABC\n');
  const c = lex('a // x\n/* y */ b');
  assert.equal(c.comments.length, 2);
  assert.deepEqual(c.tokens.map((t) => t.value), ['a', 'b']);
  assert.equal(lex('\\u0066etch').tokens[0].value, 'fetch');
});

test('performance: an 8 MB project validates in under 2 seconds', async () => {
  const box = makeSandbox();
  try {
    const minified = (bytes) => {
      const parts = [];
      let n = 0;
      for (let i = 0; n < bytes; i++) {
        const s = `function f${i}(a,b){var c=a<b?a:b;for(var d=0;d<c;d++){if(a[d]===b[d]&&"s${i}"!==c){return [a.x${i},b.y${i},${i}]}}return /r${i}[a-z]+/g.test("k${i}")?{k:${i},v:'v${i}'}:null}`;
        parts.push(s);
        n += s.length;
      }
      return parts.join('');
    };
    const numbers = (bytes) => {
      const parts = [];
      let n = 0;
      for (let i = 0; n < bytes; i++) {
        const s = String((i * 7919) % 100003);
        parts.push(s);
        n += s.length + 1;
      }
      return parts.join(',');
    };
    const mb = 1024 * 1024;
    const files = {
      'vendor/bundle.js': minified(2.4 * mb),
      'vendor/data.js': `window.D=[${numbers(1.5 * mb)}];`,
      'data/big.json': `[${numbers(2.2 * mb)}]`,
      'big.css': Array.from({ length: 12000 }, (_, i) => `.c${i}{color:#${(i * 2654435761 >>> 0).toString(16).slice(0, 6).padStart(6, '0')};background:url(data:image/png;base64,AAAA)}`).join('\n'),
    };
    for (let i = 0; i < 100; i++) files[`js/m${i}.js`] = minified(2500);
    const dir = project(box, { files, mjs: 'export const a = 1;\n' });
    const times = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const res = await validateProject(dir, { tier: 3 });
      times.push(performance.now() - t0);
      assert.deepEqual(res.errors, []);
      assert.ok(res.stats.bytes > 6.5 * mb, `project is only ${res.stats.bytes} bytes`);
    }
    assert.ok(Math.min(...times) < 2000, `took ${times.map((x) => x.toFixed(0)).join('ms, ')}ms`);
  } finally {
    box.cleanup();
  }
});

/* ---- validateRepo ---------------------------------------------------------------------------- */

function historyEntry(over = {}) {
  const date = over.date ?? '2026-10-09';
  const slug = over.slug ?? 'sample-toy';
  return {
    n: 1, date, slug, title: 'Sample Toy', tagline: 'tagline', tier: 3, fingerprint: fingerprint(), path: `d/${date}-${slug}/`,
    publishedAt: `${date}T12:00:00.000Z`, countsForNovelty: false, ...over,
  };
}

/** A sandbox whose history entries each have a real, valid project directory (repo validation looks inside them). */
function repoBox(entries = [], { build = true } = {}) {
  const box = makeSandbox();
  const startDate = box.cfg.startDate;
  box.write('state/history.json', { schema: 1, startDate, entries });
  for (const e of entries) {
    if (build) buildProject(path.join(box.root, 'docs', 'd'), { date: e.date, slug: e.slug, tier: [1, 2, 3, 4].includes(e.tier) ? e.tier : 3 });
    else fs.mkdirSync(path.join(box.root, 'docs', e.path), { recursive: true });
  }
  return box;
}

test('validateRepo accepts a healthy sandbox', async () => {
  const box = repoBox([historyEntry()]);
  try {
    const res = await validateRepo();
    assert.deepEqual(res.errors, []);
    assert.equal(res.ok, true);
  } finally {
    box.cleanup();
  }
});

test('validateRepo validates the real repo seeds', async () => {
  const prior = process.env.SED_ROOT;
  process.env.SED_ROOT = REAL_ROOT;
  try {
    const res = await validateRepo();
    assert.deepEqual(res.errors, []);
  } finally {
    if (prior === undefined) delete process.env.SED_ROOT;
    else process.env.SED_ROOT = prior;
  }
});

test('validateRepo: history rules', async (t) => {
  const codesFor = async (entries, mutate) => {
    const box = repoBox(entries);
    try {
      mutate?.(box);
      const res = await validateRepo();
      return { e: codesOf(res.errors), w: codesOf(res.warnings), res };
    } finally {
      box.cleanup();
    }
  };
  await t.test('duplicate dates are errors', async () => {
    const { e } = await codesFor([historyEntry(), historyEntry({ slug: 'other' })]);
    assert.ok(e.includes('state-history'));
  });
  await t.test('duplicate slugs are errors for real builds', async () => {
    const { res } = await codesFor([historyEntry({ tier: 1, countsForNovelty: true }), historyEntry({ date: '2026-10-10', n: 2, tier: 1, countsForNovelty: true })]);
    assert.ok(res.errors.some((x) => /slug "sample-toy" is also used/.test(x)), JSON.stringify(res.errors));
  });
  await t.test('fallback slugs may repeat', async () => {
    const { res } = await codesFor([
      historyEntry({ slug: 'postcard', tier: 4, countsForNovelty: false }),
      historyEntry({ date: '2026-10-10', n: 2, slug: 'postcard', tier: 4, countsForNovelty: false }),
    ]);
    assert.deepEqual(res.errors, []);
  });
  await t.test('an entry without a directory is an error', async () => {
    const { e } = await codesFor([historyEntry()], (box) => fs.rmSync(path.join(box.root, 'docs', 'd'), { recursive: true }));
    assert.ok(e.includes('history-no-dir'));
  });
  await t.test('a directory without an entry is an error: Pages would serve it', async () => {
    const { e } = await codesFor([], (box) => fs.mkdirSync(path.join(box.root, 'docs', 'd', '2026-10-09-stray')));
    assert.ok(e.includes('dir-no-history'));
  });
  await t.test('unsorted entries and wrong n are warnings', async () => {
    const { w, e } = await codesFor([historyEntry({ date: '2026-10-11', n: 3 }), historyEntry({ date: '2026-10-10', n: 9, slug: 'b' })]);
    assert.deepEqual(e, []);
    assert.ok(w.filter((x) => x === 'state-history').length >= 2);
  });
  await t.test('bad tier, tagline, path, timestamp and category are errors', async () => {
    const { res } = await codesFor([historyEntry({ tier: 9, tagline: 'x'.repeat(130), path: 'wrong/', publishedAt: 'never', fingerprint: fingerprint({ category: 'nope' }) })]);
    assert.ok(res.errors.length >= 5, JSON.stringify(res.errors));
  });
  await t.test('fallback tiers should not count for novelty (warning)', async () => {
    const { w } = await codesFor([historyEntry({ tier: 3, slug: 'ideas-day', countsForNovelty: true })]);
    assert.ok(w.includes('state-history'));
  });
  await t.test('unparseable history is an error', async () => {
    const { e } = await codesFor([], (box) => box.write('state/history.json', '{nope'));
    assert.ok(e.includes('state-history'));
  });
});

test('validateRepo: carryover, runs, archive, config, size', async (t) => {
  const check = async (mutate, opts) => {
    const box = repoBox([]);
    try {
      mutate(box);
      const res = await validateRepo(opts);
      return { e: codesOf(res.errors), w: codesOf(res.warnings), res };
    } finally {
      box.cleanup();
    }
  };
  const idea = { id: 'i01', title: 'x', durable: true };
  await t.test('carryover with one durable idea is fine', async () => {
    const { res } = await check((b) => b.write('state/carryover.json', { schema: 1, idea, savedOn: '2026-10-09', carriedCount: 0 }));
    assert.deepEqual(res.errors, []);
  });
  await t.test('carryover may not hold an array', async () => {
    const { e } = await check((b) => b.write('state/carryover.json', { schema: 1, idea: [idea, idea], savedOn: '2026-10-09', carriedCount: 0 }));
    assert.ok(e.includes('state-carryover'));
  });
  await t.test('carriedCount above maxCarries', async () => {
    const { e } = await check((b) => b.write('state/carryover.json', { schema: 1, idea: null, savedOn: null, carriedCount: 2 }));
    assert.ok(e.includes('state-carryover'));
  });
  await t.test('non-durable idea cannot be saved', async () => {
    const { e } = await check((b) => b.write('state/carryover.json', { schema: 1, idea: { ...idea, durable: false }, savedOn: '2026-10-09', carriedCount: 0 }));
    assert.ok(e.includes('state-carryover'));
  });
  await t.test('saved idea needs a savedOn date', async () => {
    const { e } = await check((b) => b.write('state/carryover.json', { schema: 1, idea, savedOn: null, carriedCount: 0 }));
    assert.ok(e.includes('state-carryover'));
  });
  await t.test('run files must parse and match their name', async () => {
    const bad = await check((b) => b.write('state/runs/2026-10-09.json', '{nope'));
    assert.ok(bad.e.includes('state-run'));
    const wrong = await check((b) => b.write('state/runs/2026-10-09.json', { schema: 1, date: '2026-10-10', status: 'published' }));
    assert.ok(wrong.e.includes('state-run'));
    const status = await check((b) => b.write('state/runs/2026-10-09.json', { schema: 1, date: '2026-10-09', status: 'weird' }));
    assert.ok(status.e.includes('state-run'));
    const ok = await check((b) => b.write('state/runs/2026-10-09.json', { schema: 1, date: '2026-10-09', status: 'in_progress' }));
    assert.deepEqual(ok.res.errors, []);
  });
  await t.test('an unparseable ideas file is only a warning', async () => {
    const { e, w } = await check((b) => b.write('state/ideas/2026-10-09.json', '{nope'));
    assert.deepEqual(e, []);
    assert.ok(w.includes('state-ideas'));
  });
  await t.test('docs/archive.json must parse', async () => {
    assert.ok((await check((b) => b.write('docs/archive.json', '{nope'))).e.includes('archive'));
    assert.deepEqual((await check((b) => b.write('docs/archive.json', { schema: 1, days: [] }))).res.errors, []);
  });
  await t.test('bad config values are reported', async () => {
    const { e } = await check((b) => {
      const c = b.readJson('config.json');
      c.timezone = 'Mars/Olympus';
      c.tierCutoffs.t1Until = '25:99';
      c.budget.level = 'nope';
      b.write('config.json', c);
    });
    assert.ok(e.filter((x) => x === 'config').length >= 3, JSON.stringify(e));
  });
  await t.test('a missing config.json is an error', async () => {
    const { e } = await check((b) => fs.rmSync(path.join(b.root, 'config.json')));
    assert.ok(e.includes('config'));
  });
  await t.test('throttle level must exist', async () => {
    const { e } = await check((b) => b.write('state/throttle.json', { schema: 1, level: 'turbo' }));
    assert.ok(e.includes('state-throttle'));
  });
  await t.test('a file over 10 MB anywhere in the repo is an error', async () => {
    const { e } = await check((b) => b.write('work/2026-10-09/big.bin', Buffer.alloc(10 * 1024 * 1024 + 1)));
    assert.ok(e.includes('big-file'));
  });
  await t.test('.git and node_modules are not scanned for size', async () => {
    const { e } = await check((b) => b.write('.git/pack.bin', Buffer.alloc(10 * 1024 * 1024 + 1)));
    assert.deepEqual(e, []);
  });
  await t.test('docs over siteWarnBytes is a warning', async () => {
    const { e, w } = await check((b) => {
      const c = b.readJson('config.json');
      c.limits.siteWarnBytes = 100;
      b.write('config.json', c);
      b.write('docs/blob.bin', Buffer.alloc(500));
    });
    assert.deepEqual(e, []);
    assert.ok(w.includes('site-size'));
  });
  await t.test('project contents are validated by default; projects:false skips them', async () => {
    const box = repoBox([historyEntry({ tier: 3, slug: 'probe', countsForNovelty: false })], { build: false });
    try {
      fs.rmSync(path.join(box.root, 'docs', 'd', '2026-10-09-probe'), { recursive: true, force: true });
      buildProject(path.join(box.root, 'docs', 'd'), { tier: 3, js: 'eval("1")\n' });
      const skipped = await validateRepo({ projects: false });
      assert.deepEqual(skipped.errors, []);
      const byDefault = await validateRepo();
      assert.ok(byDefault.errors.some((x) => x.startsWith('project:') && x.includes('eval')), JSON.stringify(byDefault.errors));
      assert.equal(byDefault.ok, false);
    } finally {
      box.cleanup();
    }
  });
});

test('validateRepo looks inside docs/d, including directories nobody listed', async (t) => {
  await t.test('an unlisted directory with remote code fails the default repo check', async () => {
    const box = repoBox([]);
    try {
      const dir = path.join(box.root, 'docs', 'd', '2026-10-10-evil');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'index.html'), '<script src="https://evil.example/x.js"></script>');
      const res = await validateRepo();
      assert.equal(res.ok, false);
      const codes = codesOf(res.errors);
      assert.ok(codes.includes('dir-no-history'), JSON.stringify(res.errors));
      assert.ok(res.errors.some((x) => x.startsWith('project:') && x.includes('external-script')), JSON.stringify(res.errors));
    } finally {
      box.cleanup();
    }
  });
  await t.test('a listed directory is judged at its history tier', async () => {
    const box = repoBox([historyEntry({ tier: 2, slug: 'mid' })], { build: false });
    try {
      buildProject(path.join(box.root, 'docs', 'd'), { slug: 'mid', tier: 2, body: '<a href="https://phish.example/login">More</a>' });
      const res = await validateRepo();
      assert.ok(res.errors.some((x) => /external-link-undeclared/.test(x)), JSON.stringify(res.errors));
    } finally {
      box.cleanup();
    }
  });
  await t.test('project problems are labelled with the day', async () => {
    const box = repoBox([historyEntry({ slug: 'probe' })], { build: false });
    try {
      buildProject(path.join(box.root, 'docs', 'd'), { tier: 3, js: 'eval("1")\n' });
      const res = await validateRepo();
      assert.ok(res.errors.some((x) => x.startsWith('project: 2026-10-09: ')), JSON.stringify(res.errors));
    } finally {
      box.cleanup();
    }
  });
  await t.test('many projects stay fast', async () => {
    const entries = Array.from({ length: 16 }, (_, i) => historyEntry({ date: `2026-10-${String(10 + i).padStart(2, '0')}`, n: i + 2, slug: `day-${i}` }));
    const box = repoBox(entries);
    try {
      const t0 = performance.now();
      const res = await validateRepo();
      const ms = performance.now() - t0;
      assert.deepEqual(res.errors, []);
      assert.ok(ms < 15000, `16 projects took ${ms.toFixed(0)} ms`);
    } finally {
      box.cleanup();
    }
  });
});

test('content guardrails gate tiers 1 and 2 and only report on the fallback tiers', async (t) => {
  const box = makeSandbox();
  t.after(() => box.cleanup());
  const run2 = (opts, tier = 2) => validateProject(project(box, { tier, ...opts }), { tier });
  const text = (body, extra = {}) => ({ body: `<p>${body}</p>`, ...extra });
  const cases = [
    ['guardrail-gambling', text('Deposit $20 USD and cash out real winnings. Play for real money poker.')],
    ['guardrail-gambling', text('Visit our sportsbook for live odds.')],
    ['guardrail-gambling', text('Bet with real cash on every hand.')],
    ['phishing-language', text('Sign in to your Google account to continue.')],
    ['phishing-language', text('Please verify your account within 24 hours.')],
    ['phishing-language', text('Enter your card number below.')],
    ['brand-impersonation', text('Official PokerStars Bonus')],
    ['brand-impersonation', text('This page is verified by PayPal.')],
    ['external-link-undeclared', { body: '<a href="https://free-poker-chips.example/download.exe" target="_blank">Get the full version</a>' }],
  ];
  for (const [code, opts] of cases) {
    await t.test(`${code} is an error at tier 2 and a warning at tier 3`, async () => {
      const hi = await run2(opts, 2);
      assert.ok(codesOf(hi.errors).includes(code), `tier 2 errors: ${JSON.stringify(hi.errors)}`);
      const lo = await run2(opts, 3);
      assert.ok(!codesOf(lo.errors).includes(code), `tier 3 errors: ${JSON.stringify(lo.errors)}`);
      assert.ok(codesOf(lo.warnings).includes(code), `tier 3 warnings: ${JSON.stringify(lo.warnings)}`);
    });
  }
  await t.test('harmless text passes every guardrail', async () => {
    const res = await run2(text('A play-money poker trainer. No real money, never real cash. Hockey stats from the 2025 season.'));
    const bad = codesOf(res.errors).filter((c) => /guardrail|phishing|brand|politics|external-link|placeholder/.test(c));
    assert.deepEqual(bad, []);
  });
  await t.test('links to the cited sources are fine, subdomains and parents match', async () => {
    const res = await run2({ body: '<a href="https://en.wikipedia.org/wiki/Ice_hockey" rel="noopener noreferrer" target="_blank">a</a><a href="https://wikipedia.org/">b</a><a href="mailto:a@example.com">c</a>' });
    assert.ok(!codesOf(res.errors).includes('external-link-undeclared'), JSON.stringify(res.errors));
    assert.ok(!codesOf(res.warnings).includes('external-link-rel'), JSON.stringify(res.warnings));
  });
  await t.test('a new-tab link without rel noopener warns', async () => {
    const res = await run2({ body: '<a href="https://en.wikipedia.org/wiki/Ice_hockey" target="_blank">a</a>' });
    assert.ok(codesOf(res.warnings).includes('external-link-rel'));
  });
  await t.test('a link host from the config allowlist is accepted', async () => {
    const box2 = makeSandbox({ config: (c) => ({ ...c, guardrails: { ...c.guardrails, linkAllowlist: ['nhl.com'] } }) });
    try {
      const res = await validateProject(buildProject(path.join(box2.root, 'docs', 'd'), { tier: 2, body: '<a href="https://www.nhl.com/">NHL</a>' }), { tier: 2 });
      assert.ok(!codesOf(res.errors).includes('external-link-undeclared'), JSON.stringify(res.errors));
    } finally {
      box2.cleanup();
    }
  });
  await t.test('undeclared politics is an error at tier 2 and not checked on the fallback tiers', async () => {
    const opts = text('Vote in the election: Democrats and Republicans battle for the senate.');
    assert.ok(codesOf((await run2(opts, 2)).errors).includes('politics-undeclared'));
    const lo = await run2(opts, 3);
    assert.ok(![...lo.errors, ...lo.warnings].some((x) => x.startsWith('politics-undeclared')));
  });
  await t.test('a declared political fingerprint passes the politics check', async () => {
    const res = await run2({ body: '<p>Vote in the election: Democrats and Republicans battle for the senate.</p>', pj: { fingerprint: fingerprint({ political: true }) } });
    assert.ok(!codesOf(res.errors).includes('politics-undeclared'));
  });
  await t.test('a single political word is only a warning', async () => {
    const res = await run2(text('The election of a card from the deck is random.'));
    assert.ok(!codesOf(res.errors).includes('politics-undeclared'));
    assert.ok(codesOf(res.warnings).includes('politics-undeclared'));
  });
  await t.test('brand names alone warn, advice without a disclaimer warns', async () => {
    const res = await run2(text('Works like PayPal. You should invest in diagnosing dosage.'));
    assert.ok(codesOf(res.warnings).includes('brand-name'));
    assert.ok(codesOf(res.warnings).includes('advice-claim'));
    const ok = await run2(text('You should invest wisely. This is not financial advice.'));
    assert.ok(!codesOf(ok.warnings).includes('advice-claim'));
  });
  await t.test('config brandDenylist extends the impersonation check', async () => {
    const box2 = makeSandbox({ config: (c) => ({ ...c, guardrails: { ...c.guardrails, brandDenylist: ['acmebank'] } }) });
    try {
      const res = await validateProject(buildProject(path.join(box2.root, 'docs', 'd'), { tier: 2, body: '<h1>Official AcmeBank rewards</h1>' }), { tier: 2 });
      assert.ok(codesOf(res.errors).includes('brand-impersonation'), JSON.stringify(res.errors));
    } finally {
      box2.cleanup();
    }
  });
  await t.test('bundled media needs a licenses entry', async () => {
    const pngish = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(32)]);
    const warn = await run2({ files: { 'sprites/a.png': pngish } });
    assert.ok(codesOf(warn.warnings).includes('unlicensed-asset'));
    const fine = await run2({ files: { 'sprites/a.png': pngish }, pj: { licenses: [{ file: 'sprites/a.png', license: 'CC0', source: 'self-made' }] } });
    assert.ok(!codesOf(fine.warnings).includes('unlicensed-asset'), JSON.stringify(fine.warnings));
  });
});

test('ops/waivers.json downgrades only the judgement-call findings, per project', async (t) => {
  const box = makeSandbox();
  t.after(() => box.cleanup());
  const mic = { js: 'navigator.mediaDevices.getUserMedia({ audio: true });\n' };
  await t.test('without a waiver the privacy API is an error', async () => {
    assert.ok(codesOf((await run(box, mic)).errors).includes('privacy-api'));
  });
  await t.test('a waiver for this directory turns it into a warning that says so', async () => {
    box.write('ops/waivers.json', { '2026-10-09-probe': ['privacy-api', 'webrtc'] });
    const res = await run(box, { ...mic, js: `${mic.js}new RTCPeerConnection({});\n` });
    assert.ok(!codesOf(res.errors).includes('privacy-api'));
    assert.ok(res.warnings.some((w) => w.startsWith('privacy-api:') && /waived/.test(w)), JSON.stringify(res.warnings));
    assert.ok(codesOf(res.errors).includes('webrtc'), 'webrtc can never be waived');
  });
  await t.test('a waiver for another directory does nothing', async () => {
    box.write('ops/waivers.json', { '2026-10-09-other': ['privacy-api'] });
    assert.ok(codesOf((await run(box, mic)).errors).includes('privacy-api'));
  });
  await t.test('a broken waivers file waives nothing', async () => {
    box.write('ops/waivers.json', '{nope');
    assert.ok(codesOf((await run(box, mic)).errors).includes('privacy-api'));
  });
});

/* ---- CLI --------------------------------------------------------------------------------------- */

function cli(args, root) {
  const r = spawnSync(process.execPath, [VALIDATE, ...args], { env: { ...process.env, SED_ROOT: root }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('CLI: project prints one JSON document and exits 0/1/2', async () => {
  const box = makeSandbox();
  try {
    const good = project(box, {});
    const ok = cli(['project', good, '--tier', '3'], box.root);
    assert.equal(ok.code, 0, ok.err);
    const parsed = JSON.parse(ok.out);
    assert.equal(parsed.ok, true);
    assert.deepEqual(Object.keys(parsed).sort(), ['errors', 'ok', 'stats', 'warnings']);

    const bad = project(box, { slug: 'bad', js: 'eval("1")\n' });
    const fail = cli(['project', bad, '--tier', '3'], box.root);
    assert.equal(fail.code, 1);
    assert.equal(JSON.parse(fail.out).ok, false);

    assert.equal(cli(['project'], box.root).code, 2);
    assert.equal(cli(['bogus'], box.root).code, 2);
    assert.equal(cli(['project', good, '--tier', '9'], box.root).code, 2);
  } finally {
    box.cleanup();
  }
});

test('CLI: repo prints one JSON document', async () => {
  const box = repoBox([historyEntry()]);
  try {
    const r = cli(['repo'], box.root);
    assert.equal(r.code, 0, r.err + r.out);
    assert.equal(JSON.parse(r.out).ok, true);
    box.write('state/history.json', '{nope');
    const bad = cli(['repo'], box.root);
    assert.equal(bad.code, 1);
    assert.equal(JSON.parse(bad.out).ok, false);
  } finally {
    box.cleanup();
  }
});

test('CLI: repo checks project contents by default and --no-projects skips them', async () => {
  const box = repoBox([historyEntry({ slug: 'probe' })], { build: false });
  try {
    buildProject(path.join(box.root, 'docs', 'd'), { tier: 3, js: 'eval("1")\n' });
    const full = cli(['repo'], box.root);
    assert.equal(full.code, 1);
    assert.ok(JSON.parse(full.out).errors.some((x) => x.startsWith('project:')));
    const quick = cli(['repo', '--no-projects'], box.root);
    assert.equal(quick.code, 0, quick.out);
  } finally {
    box.cleanup();
  }
});

test('browser-check reports a page that touches WebRTC, even when the name is computed', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sed-gate-rtc-'));
  try {
    fs.cpSync(path.join(REAL_ROOT, 'tests', 'fixtures', 'qa-clean'), dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'app.js'), "\ntry { new window[['webkit', 'RTC', 'PeerConnection'].join('')]({ iceServers: [{ urls: 'stun:127.0.0.1:39999' }] }); } catch (e) { /* poisoned */ }\n");
    const r = spawnSync(process.execPath, [path.join(REAL_ROOT, 'scripts', 'qa', 'browser-check.mjs'), dir, '--out', path.join(dir, 'out'), '--seconds', '2', '--no-monkey'], { encoding: 'utf8', timeout: 120000 });
    const report = JSON.parse(r.stdout);
    if (report.error === 'no-browser') return t.skip('no Chromium available');
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => /webrtc blocked/.test(e)), JSON.stringify(report.errors));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('importing validate.mjs has no side effects', () => {
  const r = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(path.join(REAL_ROOT, 'scripts', 'validate.mjs'))}).then(() => console.log('imported'))`], { encoding: 'utf8' });
  assert.equal(r.stdout.trim(), 'imported');
  assert.equal(r.stderr, '');
});
