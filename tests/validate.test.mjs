// Tests for scripts/validate.mjs: every attack vector in fixtures/gate-vectors.mjs, structure rules, repo checks, speed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateProject, validateRepo, analyzeContract, countWords, firstSentence } from '../scripts/validate.mjs';
import { MALICIOUS, BENIGN } from './fixtures/gate-vectors.mjs';
import { startMeter, childCpuMs, childCpuAvailable } from './helpers/cpu.mjs';
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

test('the CPU meter of the performance tests sees the work of a child process (Linux), and a sleep is wall time only', { skip: !childCpuAvailable() && 'no /proc/self/stat' }, () => {
  const burn = startMeter();
  // the child burns 300 ms of its OWN CPU time (not of wall time: on a loaded machine the same loop takes longer, it never burns less)
  spawnSync(process.execPath, ['-e', 'const t0 = process.cpuUsage(); while ((process.cpuUsage(t0).user + process.cpuUsage(t0).system) / 1000 < 300);']);
  const burned = burn.stop();
  assert.ok(burned.childMs >= 250, `a child that burned 300 ms of CPU read ${burned.childMs} ms`);
  assert.ok(burned.cpuMs >= burned.childMs, JSON.stringify(burned));
  const sleep = startMeter();
  spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400)']);
  const slept = sleep.stop();
  assert.ok(slept.wallMs >= 380 && slept.childMs < 250, `a sleeping child read ${slept.childMs} ms of CPU in ${slept.wallMs} ms of wall time`);
  assert.ok(childCpuMs() >= burned.childMs, 'the counter only grows');
});

test('performance: an 8 MB project validates in under 2 seconds of CPU time (children included), and never stalls', async () => {
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
    // The budget is CPU time, not wall time: on a loaded machine the same validation took 2 to 9 s of wall clock for 0.7 to 1.0 s of CPU (the
    // wall-clock version failed in 1 of 3 concurrent runs of this file). The CPU counted is this process's plus the `node --check` children it
    // waited for (a slow or serialized child shows up there), and a loose wall-clock backstop on the best run catches an order-of-magnitude
    // stall that burns no CPU (a hang, a sleep) without failing a busy machine.
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const meter = startMeter();
      const res = await validateProject(dir, { tier: 3 });
      runs.push(meter.stop());
      assert.deepEqual(res.errors, []);
      assert.ok(res.stats.bytes > 6.5 * mb, `project is only ${res.stats.bytes} bytes`);
    }
    const shown = runs.map((r) => `${r.cpuMs.toFixed(0)}ms (own ${r.ownMs.toFixed(0)}, children ${r.childMs.toFixed(0)}, wall ${r.wallMs.toFixed(0)})`).join(', ');
    assert.ok(Math.min(...runs.map((r) => r.cpuMs)) < 2000, `took ${shown} of CPU time`);
    assert.ok(Math.min(...runs.map((r) => r.wallMs)) < 8 * 2000, `stalled: ${shown}`);
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

/* ---- culture layer (CONTRACT 12.11) ---------------------------------------------------------- */

const MB = '<!-- protected:begin -->';
const ME = '<!-- protected:end -->';
const JB = '// protected:begin';
const JE = '// protected:end';

function ledgerEntry(over = {}) {
  const date = over.date ?? '2026-10-10';
  const agent = over.agent ?? 'pulse';
  return {
    id: `${date}-${agent}`, date, agent, title: 'Shorter preflight note', observation: 'The note was long.', category: 'clarity',
    files: ['ops/roles/pulse.md'], sha: 'abcdef1234', status: 'applied', linesChanged: 4, question: null, reason: null, ...over,
  };
}

const logFor = (entries) => `# Kaizen log\n\n${entries.map((e) => `## ${e.date} · ${e.agent} · ${e.status} · ${e.title}\n\n- observation: ${e.observation}`).join('\n\n')}\n`;

test('validateRepo: culture layer', async (t) => {
  const check = async (mutate) => {
    const box = repoBox([]);
    try {
      mutate(box);
      const res = await validateRepo();
      return { e: codesOf(res.errors), w: codesOf(res.warnings), res };
    } finally {
      box.cleanup();
    }
  };
  const withConfig = (fn) => (b) => {
    const c = b.readJson('config.json');
    fn(c.kaizen, c);
    b.write('config.json', c);
  };
  const ledger = (entries) => (b) => {
    b.write('ops/kaizen/INDEX.json', { schema: 1, entries });
    b.write('ops/kaizen/LOG.md', logFor(entries.filter((e) => e && typeof e === 'object')));
  };

  await t.test('the real repo ledger, queue, markers and doc caps are clean', async () => {
    const prior = process.env.SED_ROOT;
    process.env.SED_ROOT = REAL_ROOT;
    try {
      const res = await validateRepo({ projects: false });
      assert.deepEqual(res.errors, []);
      assert.deepEqual(res.warnings.filter((x) => /^(config-kaizen|kaizen-|protected-markers|doc-line-cap)/.test(x)), []);
    } finally {
      if (prior === undefined) delete process.env.SED_ROOT;
      else process.env.SED_ROOT = prior;
    }
  });

  await t.test('a consistent ledger with several statuses passes', async () => {
    const entries = [
      ledgerEntry(),
      ledgerEntry({ agent: 'cards', status: 'rejected', files: [], linesChanged: 0, sha: null, reason: 'too many lines', title: 'Big idea' }),
      ledgerEntry({ agent: 'lab', status: 'proposed', question: 'Why?', title: 'Needs a protected path' }),
      ledgerEntry({ agent: 'jester', status: 'reverted', title: 'Joke header', reason: 'broke the parser' }),
    ];
    const { res } = await check(ledger(entries));
    assert.deepEqual(res.errors, []);
    assert.deepEqual(res.warnings.filter((x) => x.startsWith('kaizen-')), []);
  });

  await t.test('INDEX.json and LOG.md must exist', async () => {
    assert.ok((await check((b) => fs.rmSync(path.join(b.root, 'ops', 'kaizen', 'INDEX.json')))).e.includes('kaizen-index'));
    assert.ok((await check((b) => fs.rmSync(path.join(b.root, 'ops', 'kaizen', 'LOG.md')))).e.includes('kaizen-log'));
    assert.ok((await check((b) => b.write('ops/kaizen/INDEX.json', '{nope'))).e.includes('kaizen-index'));
  });

  await t.test('INDEX shape errors', async () => {
    const bad = {
      'wrong schema': (b) => b.write('ops/kaizen/INDEX.json', { schema: 2, entries: [] }),
      'entries not an array': (b) => b.write('ops/kaizen/INDEX.json', { schema: 1, entries: {} }),
      'entry not an object': ledger(['x']),
      'duplicate ids': ledger([ledgerEntry(), ledgerEntry({ title: 'Other' })]),
      'missing id': ledger([ledgerEntry({ id: '' })]),
      'bad date': ledger([ledgerEntry({ date: 'tomorrow', id: 'tomorrow-pulse' })]),
      'bad status': ledger([ledgerEntry({ status: 'merged' })]),
      'empty title': ledger([ledgerEntry({ title: ' ' })]),
      'files not a list': ledger([ledgerEntry({ files: 'ops/x.md' })]),
      'file with ..': ledger([ledgerEntry({ files: ['../x'] })]),
      'negative lines': ledger([ledgerEntry({ linesChanged: -1 })]),
      'non-integer lines': ledger([ledgerEntry({ linesChanged: '4' })]),
      'bad sha': ledger([ledgerEntry({ sha: 'not a sha' })]),
      'question of the wrong type': ledger([ledgerEntry({ question: 5 })]),
    };
    for (const [label, mutate] of Object.entries(bad)) {
      const { e } = await check(mutate);
      assert.ok(e.includes('kaizen-index'), `${label}: ${JSON.stringify(e)}`);
    }
  });

  await t.test('a sha-less applied entry (the commit is stamped afterwards) is fine; odd agents and ids only warn', async () => {
    const { res, w } = await check(ledger([ledgerEntry({ sha: null }), ledgerEntry({ agent: 'ghost', id: 'custom-id' })]));
    assert.deepEqual(res.errors, []);
    assert.ok(w.includes('kaizen-index'));
  });

  await t.test('every applied entry must appear in LOG.md; other statuses need not', async () => {
    const entries = [ledgerEntry(), ledgerEntry({ agent: 'cards', status: 'rejected', title: 'Missing but rejected' })];
    const missing = await check((b) => {
      b.write('ops/kaizen/INDEX.json', { schema: 1, entries });
      b.write('ops/kaizen/LOG.md', '# Kaizen log\n\n## 2026-10-10 · pulse · applied · Something else\n');
    });
    assert.ok(missing.res.errors.some((x) => x.startsWith('kaizen-log:') && x.includes('2026-10-10-pulse')), JSON.stringify(missing.res.errors));
    const ok = await check((b) => {
      b.write('ops/kaizen/INDEX.json', { schema: 1, entries });
      b.write('ops/kaizen/LOG.md', logFor([entries[0]]));
    });
    assert.deepEqual(ok.res.errors, []);
  });

  await t.test('the queue: shape errors and tolerated absence', async () => {
    assert.ok((await check((b) => b.write('state/kaizen-queue.json', '{nope'))).e.includes('kaizen-queue'));
    assert.ok((await check((b) => b.write('state/kaizen-queue.json', { schema: 2, skipped: [] }))).e.includes('kaizen-queue'));
    assert.ok((await check((b) => b.write('state/kaizen-queue.json', { schema: 1, skipped: 'pulse' }))).e.includes('kaizen-queue'));
    assert.ok((await check((b) => b.write('state/kaizen-queue.json', { schema: 1, skipped: [{ agent: 'pulse' }] }))).e.includes('kaizen-queue'));
    const fine = await check((b) => b.write('state/kaizen-queue.json', { schema: 1, skipped: ['pulse', 'clerk'] }));
    assert.deepEqual(fine.res.errors, []);
    const odd = await check((b) => b.write('state/kaizen-queue.json', { schema: 1, skipped: ['pulse', 'pulse', 'ghost'] }));
    assert.deepEqual(odd.e, []);
    assert.ok(odd.w.includes('kaizen-queue'));
    const absent = await check((b) => fs.rmSync(path.join(b.root, 'state', 'kaizen-queue.json')));
    assert.deepEqual(absent.e, []);
    assert.ok(absent.w.includes('kaizen-queue'));
  });

  await t.test('config.kaizen: numbers, lists and paths', async () => {
    const cases = {
      'missing block': (k, c) => delete c.kaizen,
      'not an object': (k, c) => { c.kaizen = []; },
      'enabled not a boolean': (k) => { k.enabled = 'yes'; },
      'no members': (k) => { k.members = []; },
      'member not a string': (k) => { k.members = ['pulse', 7]; },
      'duplicate members': (k) => { k.members = ['pulse', 'pulse']; },
      'maxChangedLines zero': (k) => { k.maxChangedLines = 0; },
      'maxFiles a string': (k) => { k.maxFiles = '4'; },
      'minTokensToStart fractional': (k) => { k.minTokensToStart = 1.5; },
      'revertWindowDays missing': (k) => { delete k.revertWindowDays; },
      'allowedPaths empty': (k) => { k.allowedPaths = []; },
      'allowedPaths not strings': (k) => { k.allowedPaths = [1]; },
      'allowedPaths with ..': (k) => { k.allowedPaths.push('ops/../config.json'); },
      'allowedPaths absolute': (k) => { k.allowedPaths.push('/etc/'); },
      'allowedPaths drive letter': (k) => { k.allowedPaths.push('C:/x'); },
      'allowedPaths backslash': (k) => { k.allowedPaths.push('ops\\roles'); },
      'protectedPaths with ..': (k) => { k.protectedPaths.push('../x'); },
      'protectedPaths not an array': (k) => { k.protectedPaths = 'config.json'; },
      'docLineCaps not an object': (k) => { k.docLineCaps = []; },
      'docLineCaps zero': (k) => { k.docLineCaps['README.md'] = 0; },
      'docLineCaps escaping path': (k) => { k.docLineCaps['../outside.md'] = 10; },
    };
    for (const [label, fn] of Object.entries(cases)) {
      const { e } = await check(withConfig(fn));
      assert.ok(e.includes('config-kaizen'), `${label}: ${JSON.stringify(e)}`);
    }
  });

  await t.test('protectedPaths must keep the five load-bearing entries', async () => {
    for (const need of ['config.json', '.github/', 'ops/prompts/', 'scripts/validate.mjs', 'scripts/kaizen.mjs']) {
      const { res } = await check(withConfig((k) => { k.protectedPaths = k.protectedPaths.filter((p) => p !== need); }));
      assert.ok(res.errors.some((x) => x.startsWith('config-kaizen:') && x.includes(`include ${need}`)), `${need}: ${JSON.stringify(res.errors)}`);
    }
  });

  await t.test('an allowed path inside a protected one is only a warning', async () => {
    const { e, w } = await check(withConfig((k) => { k.allowedPaths.push('ops/prompts/'); }));
    assert.deepEqual(e, []);
    assert.ok(w.includes('config-kaizen'));
  });

  await t.test('a disabled kaizen block does not demand a ledger', async () => {
    const { e } = await check((b) => {
      withConfig((k) => { k.enabled = false; })(b);
      fs.rmSync(path.join(b.root, 'ops', 'kaizen'), { recursive: true });
    });
    assert.deepEqual(e, []);
  });

  await t.test('docLineCaps: at the cap passes, one over is an error, a missing file warns', async () => {
    const capped = (lines, cap) => (b) => {
      withConfig((k) => { k.docLineCaps = { 'ops/NOTES.md': cap }; })(b);
      b.write('ops/NOTES.md', 'line\n'.repeat(lines));
    };
    assert.deepEqual((await check(capped(10, 10))).res.errors, []);
    const over = await check(capped(11, 10));
    assert.ok(over.res.errors.some((x) => x.startsWith('doc-line-cap:') && x.includes('11 lines')), JSON.stringify(over.res.errors));
    const noNewline = await check((b) => {
      withConfig((k) => { k.docLineCaps = { 'ops/NOTES.md': 3 }; })(b);
      b.write('ops/NOTES.md', 'a\nb\nc\nd');
    });
    assert.ok(noNewline.e.includes('doc-line-cap'));
    const gone = await check(withConfig((k) => { k.docLineCaps = { 'ops/GONE.md': 3 }; }));
    assert.deepEqual(gone.e, []);
    assert.ok(gone.w.includes('doc-line-cap'));
  });

  await t.test('balanced protected blocks in markdown and JS pass; inline mentions are not markers', async () => {
    const { res } = await check((b) => {
      b.write('ops/roles/x.md', `Free text\n${MB}\n* rule\n${ME}\nmore\n${MB}\n* another\n${ME}\n`);
      b.write('scripts/x.mjs', `const a = 1;\n${JB}\nconst SAFE = true;\n${JE}\n`);
      b.write('ops/OPERATING.md', `Wrap rules in \`${MB}\` and \`${ME}\` lines; in JS use \`${JB}\`.\n`);
      b.write('ops/kaizen/README.md', `| marker | ${MB} |\n`);
    });
    assert.deepEqual(res.errors, []);
  });

  await t.test('unbalanced protected markers are errors with a file and line', async () => {
    const cases = {
      'unclosed md': ['ops/roles/x.md', `a\n${MB}\nrule\n`, /x\.md:2/],
      'end without begin': ['ops/roles/x.md', `a\n${ME}\n`, /x\.md:2/],
      nested: ['ops/roles/x.md', `${MB}\n${MB}\n${ME}\n`, /nested/],
      'double end': ['ops/roles/x.md', `${MB}\nr\n${ME}\n${ME}\n`, /without a matching/],
      'unclosed js': ['scripts/x.mjs', `${JB}\nconst a = 1;\n`, /x\.mjs:1/],
      'js end only': ['scripts/x.mjs', `const a = 1;\n${JE}\n`, /x\.mjs:2/],
      'html file': ['site-src/x.html', `<p>x</p>\n${MB}\n`, /x\.html:2/],
      'indented marker': ['tests/x.test.mjs', `  ${JB}\n  x\n`, /x\.test\.mjs:1/],
    };
    for (const [label, [rel, body, re]] of Object.entries(cases)) {
      const { res } = await check((b) => b.write(rel, body));
      assert.ok(res.errors.some((x) => x.startsWith('protected-markers:') && re.test(x)), `${label}: ${JSON.stringify(res.errors)}`);
    }
  });

  await t.test('generated output (docs, work, state) is not scanned for markers', async () => {
    const { res } = await check((b) => {
      b.write('docs/kaizen/index.html', `<pre>\n${MB}\n</pre>\n`);
      b.write('work/2026-10-10/notes.md', `${MB}\n`);
      b.write('state/handoff.md', `${ME}\n`);
    });
    assert.deepEqual(res.errors, []);
  });

  await t.test('in a git work tree, uncommitted files are scanned too and ignored ones are not', async () => {
    const box = repoBox([]);
    try {
      const git = (...args) => spawnSync('git', ['-C', box.root, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
      assert.equal(git('init', '-q').status, 0);
      box.write('.gitignore', 'ignored.md\n');
      box.write('ignored.md', `${MB}\n`);
      box.write('ops/roles/tracked.md', 'fine\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'seed');
      assert.deepEqual((await validateRepo()).errors, []);
      box.write('ops/roles/fresh.md', `${MB}\nnever closed\n`);
      const res = await validateRepo();
      assert.ok(res.errors.some((x) => /protected-markers:.*fresh\.md:1/.test(x)), JSON.stringify(res.errors));
      box.write('ops/roles/tracked.md', `${ME}\n`);
      assert.ok((await validateRepo()).errors.some((x) => /protected-markers:.*tracked\.md:1/.test(x)));
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

/* ---- the page contract (DESIGN 7.3): purpose, intro, explainer ------------------------------- */

const CONTRACT_FIXTURES = path.join(REAL_ROOT, 'tests', 'fixtures', 'contract');
const TOOL_FIXTURE = path.join(CONTRACT_FIXTURES, '2026-10-20-contrast-checker');
const LESSON_FIXTURE = path.join(CONTRACT_FIXTURES, '2026-10-21-parity-bit-lesson');
const withGate = (date) => (c) => {
  c.pageContract = { ...c.pageContract, requiredFrom: date };
  return c;
};

/** Copies a fixture into the sandbox, applies `html` / `pj` edits and returns the directory. */
function variant(box, fixture, { html, pj } = {}) {
  const dir = path.join(box.root, 'docs', 'd', path.basename(fixture));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(fixture, dir, { recursive: true });
  const project = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  if (pj) pj(project);
  fs.writeFileSync(path.join(dir, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
  if (html) {
    const page = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    const next = html(page);
    assert.notEqual(next, page, 'the variant must change the page');
    fs.writeFileSync(path.join(dir, 'index.html'), next);
  }
  return dir;
}

const introOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')).intro;
const INTRO_RE = /<p class="sed-intro" data-sed-intro>[\s\S]*?<\/p>/;
const setIntro = (text, markup = text) => ({
  html: (s) => s.replace(INTRO_RE, `<p class="sed-intro" data-sed-intro>${markup}</p>`),
  pj: (p) => { p.intro = text; },
});
/** An old-style page: the sample fixture without purpose, intro or explainer markup. */
const oldStyle = {
  html: (s) => s.replace(/\n {2}<p class="sed-intro" data-sed-intro>[\s\S]*?<\/p>/, '').replace(' class="sed-explainer" data-sed-explainer', ''),
  pj: (p) => {
    delete p.intro;
    delete p.concepts;
    delete p.fingerprint.purpose;
  },
};

test('page contract: the conforming tool, lesson and sample pages pass with --contract and with the date gate armed', async () => {
  for (const config of [undefined, withGate('2026-10-01')]) {
    const box = makeSandbox(config ? { config } : {});
    try {
      for (const dir of [TOOL_FIXTURE, LESSON_FIXTURE, BENIGN_FIXTURE]) {
        for (const contract of [false, true]) {
          const res = await validateProject(dir, { contract });
          assert.deepEqual(res.errors, [], `${path.basename(dir)} contract=${contract}: ${JSON.stringify(res.errors)}`);
          assert.deepEqual(res.warnings, [], `${path.basename(dir)}: ${JSON.stringify(res.warnings)}`);
        }
      }
    } finally {
      box.cleanup();
    }
  }
});

test('page contract: with requiredFrom null nothing new is enforced; the date gate and --contract arm it; tiers 3 and 4 are exempt', async () => {
  const run = async (config, opts = {}) => {
    const box = makeSandbox(config ? { config } : {});
    try {
      return await validateProject(variant(box, BENIGN_FIXTURE, oldStyle), opts);
    } finally {
      box.cleanup();
    }
  };
  const contractCodes = (res) => [...new Set(codesOf(res.errors).filter((c) => /^(purpose|intro-|explainer-)/.test(c)))];
  const off = await run(undefined, { tier: 1 });
  assert.deepEqual(off.errors, [], 'requiredFrom null: an old-style page still passes');
  assert.deepEqual(contractCodes(await run(withGate('2026-10-10'), { tier: 1 })), [], 'a page dated before requiredFrom is not affected');
  const on = await run(withGate('2026-10-09'), { tier: 1 });
  assert.deepEqual(contractCodes(on).sort(), ['explainer-missing', 'intro-missing', 'purpose'], JSON.stringify(on.errors));
  assert.match(on.errors.join('\n'), /pages dated from 2026-10-09 \(pageContract\.requiredFrom\)/);
  const forced = await run(undefined, { tier: 1, contract: true });
  assert.deepEqual(contractCodes(forced).sort(), ['explainer-missing', 'intro-missing', 'purpose']);
  assert.match(forced.errors.join('\n'), /--contract/);
  for (const tier of [3, 4]) {
    assert.deepEqual(contractCodes(await run(withGate('2026-10-01'), { tier, contract: true })), [], `tier ${tier} is exempt`);
  }
  // a config without the block (the test helpers' TEST_CONFIG) requires nothing and never throws
  const none = await run((c) => { delete c.pageContract; return c; }, { tier: 1 });
  assert.deepEqual(none.errors, []);
});

test('page contract: a present purpose, intro or intro element is validated at any date', async (t) => {
  const box = makeSandbox();
  t.after(() => box.cleanup());
  const errorsOf = async (spec) => validateProject(variant(box, BENIGN_FIXTURE, spec), { tier: 1 });
  await t.test('an unknown purpose', async () => {
    const res = await errorsOf({ pj: (p) => { p.fingerprint.purpose = 'game'; } });
    assert.ok(res.errors.some((e) => /^purpose: fingerprint\.purpose "game" is not one of tool, lesson, explorer, studio, play/.test(e)), JSON.stringify(res.errors));
  });
  await t.test('an intro element without a project.json intro', async () => {
    const res = await errorsOf({ pj: (p) => { delete p.intro; } });
    assert.ok(res.errors.some((e) => /^intro-missing: the page has a p\[data-sed-intro\] but project\.json has no "intro"/.test(e)), JSON.stringify(res.errors));
  });
  await t.test('an intro that is too long', async () => {
    const long = `${'word '.repeat(70)}end.`;
    const res = await errorsOf(setIntro(long));
    assert.ok(res.errors.some((e) => /^intro-length: project\.json intro has 71 words; pageContract\.intro allows 35 to 70/.test(e)), JSON.stringify(res.errors));
  });
  await t.test('concepts with the wrong shape', async () => {
    const res = await errorsOf({ pj: (p) => { p.concepts = ['x']; } });
    assert.ok(res.errors.some((e) => /^project-json: concepts must be an array of 1 to 6 strings of 2 to 40 characters/.test(e)), JSON.stringify(res.errors));
  });
  await t.test('the template intro left in project.json', async () => {
    // the opening words of ops/templates/project.json.example "intro" (tests/qa.test.mjs ties the two together; reading the template here
    // would put this suite on the kaizen gate's ops/templates/ row)
    const example = 'An example project that shows the shape of a page: what it is in one plain sentence, who it is for, and what to do first. Replace this paragraph with 35 to 70 words. Say what the thing literally is before any theme or metaphor. Then tell the visitor the first thing to try.';
    const res = await errorsOf(setIntro(example));
    assert.ok(codesOf(res.errors).includes('placeholder-text'), JSON.stringify(res.errors));
  });
});

test('page contract: every rule fails with its own code and a message that names the measured value and the limit', async (t) => {
  const box = makeSandbox();
  t.after(() => box.cleanup());
  const check = async (fixture, spec, code, pattern, { warning = false } = {}) => {
    const res = await validateProject(variant(box, fixture, spec), { contract: true });
    const list = warning ? res.warnings : res.errors;
    assert.ok(list.some((e) => e.startsWith(`${code}: `) && pattern.test(e)), `expected ${code} ${pattern}; errors ${JSON.stringify(res.errors)} warnings ${JSON.stringify(res.warnings)}`);
    if (!warning) assert.equal(res.ok, false);
    return res;
  };
  const tool = TOOL_FIXTURE;
  const lesson = LESSON_FIXTURE;
  const intro = introOf(tool);
  await t.test('purpose missing', () => check(tool, { pj: (p) => { delete p.fingerprint.purpose; } }, 'purpose', /fingerprint\.purpose is missing/));
  await t.test('intro missing from project.json', () => check(tool, { pj: (p) => { delete p.intro; } }, 'intro-missing', /project\.json has no "intro"/));
  await t.test('intro too short', () => check(tool, setIntro('A calculator for contrast.'), 'intro-length', /has 4 words; pageContract\.intro allows 35 to 70/));
  await t.test('first sentence too long (a warning)', async () => {
    const text = `A calculator that measures ${'the contrast between two colours and '.repeat(5)}more. It is for designers who check a palette before they ship it to everyone.`;
    await check(tool, setIntro(text), 'intro-first-sentence', /has 3\d words \(pageContract\.intro\.firstSentenceMaxWords is 30\)/, { warning: true });
  });
  await t.test('trap: an unclosed intro p', () => check(tool, { html: (s) => s.replace(/(data-sed-intro>[\s\S]*?)<\/p>/, '$1') }, 'intro-unclosed', /no explicit <\/p>/));
  await t.test('trap: a block inside the intro closes it early', async () => {
    const res = await check(tool, { html: (s) => s.replace('It is for designers', '<div>It is for designers').replace('Everything runs in your browser.</p>', 'Everything runs in your browser.</div></p>') }, 'intro-unclosed', /explicit/);
    assert.ok(codesOf(res.errors).includes('intro-mismatch'), JSON.stringify(res.errors));
  });
  await t.test('trap: the intro only inside a template', () => check(tool, { html: (s) => s.replace(INTRO_RE, (m) => `<template>${m}</template>`) }, 'intro-placement', /1 elsewhere: inside <template>/));
  await t.test('trap: the intro only inside noscript', () => check(tool, { html: (s) => s.replace(INTRO_RE, (m) => `<noscript>${m}</noscript>`) }, 'intro-missing', /no p\[data-sed-intro\] inside <main>/));
  await t.test('trap: a template copy next to the real intro is ignored', async () => {
    const res = await validateProject(variant(box, tool, { html: (s) => s.replace(INTRO_RE, (m) => `${m}<template>${m}</template><noscript>${m}</noscript>`) }), { contract: true });
    assert.deepEqual(res.errors, []);
  });
  await t.test('trap: the intro inside a details panel', () => check(tool, { html: (s) => s.replace(INTRO_RE, (m) => `<details open><summary>About</summary>${m}</details>`) }, 'intro-placement', /inside <details>/));
  await t.test('the intro hidden', () => check(tool, { html: (s) => s.replace('data-sed-intro>', 'data-sed-intro hidden>') }, 'intro-placement', /inside a \[hidden\] element/));
  await t.test('two intros', () => check(tool, { html: (s) => s.replace(INTRO_RE, (m) => `${m}\n${m}`) }, 'intro-placement', /2 p\[data-sed-intro\] elements inside <main>; exactly one/));
  await t.test('trap: br inside the intro', () => check(tool, setIntro(intro, intro.replace('colour, the number', 'colour,<br>the number')), 'intro-markup', /holds <br>/));
  await t.test('a control inside the intro', () => check(tool, { html: (s) => s.replace('Type or pick two colours;', 'Type or pick two colours <button type="button">now</button>;') }, 'intro-markup', /holds <button>/));
  await t.test('trap: typographic entities in the intro', () => check(tool, setIntro(intro.replace('colour, the number', 'colour – the “number”'), intro.replace('colour, the number', 'colour &ndash; the &ldquo;number&rdquo;')), 'intro-entity', /uses &ndash;, &ldquo;, &rdquo;; type the character instead/));
  await t.test('allowed entities and typed characters are fine', async () => {
    const text = intro.replace('colour, the number', 'colour – the “number” & more');
    const res = await validateProject(variant(box, tool, setIntro(text, intro.replace('colour, the number', 'colour &#8211; the “number”&nbsp;&amp; more'))), { contract: true });
    assert.deepEqual(res.errors, []);
  });
  await t.test('page text and project.json differ', () => check(tool, { html: (s) => s.replace('designers and developers', 'designers and engineers') }, 'intro-mismatch', /differs from project\.json "intro" at character \d+: page ".*engineers/));
  await t.test('explainer missing', () => check(tool, { html: (s) => s.replace(' data-sed-explainer', '') }, 'explainer-missing', /no section\[data-sed-explainer\] inside <main>/));
  await t.test('two explainers', () => check(tool, { html: (s) => s.replace('</main>', '<section data-sed-explainer><h2>Again</h2></section>\n</main>') }, 'explainer-placement', /2 section\[data-sed-explainer\] elements/));
  await t.test('explainer too short for a tool', () => check(tool, { html: (s) => s.replace(/<h3>How it is computed<\/h3>[\s\S]*?<h3>Limits<\/h3>/, '<h3>Limits</h3>') }, 'explainer-words', /has \d+ words of prose; a tool needs at least 250 \(pageContract\.explainer\.minWords\.tool\)/));
  await t.test('trap: a lesson explainer padded with template and hidden copies', () => check(lesson, { html: (s) => s.replace(/(<h3>A worked example<\/h3>)([\s\S]*?)(<h3>Why one flip)/, '$1<template>$2</template><div hidden>$2</div>$3') }, 'explainer-words', /a lesson needs at least 700/));
  await t.test('trap: the explainer inside a closed details counts nothing', () => check(tool, { html: (s) => s.replace(/<section class="sed-explainer"[\s\S]*?<\/section>/, (m) => `<details><summary>How it works</summary>${m}</details>`) }, 'explainer-words', /has 0 words .* inside a closed <details>/));
  await t.test('too few headings for a lesson', () => check(lesson, { html: (s) => s.replace(/<h3>(Counting the ones|A worked example|Why one flip is always caught|Why two flips slip through|Detecting is not correcting|Where you meet it|Exercise 1|Exercise 2)<\/h3>/g, '<p><strong>$1</strong></p>') }, 'explainer-headings', /has 1 h2\/h3 heading; a lesson needs at least 4 \(pageContract\.explainer\.minHeadings\.lesson/));
  await t.test('a lesson with one exercise', () => check(lesson, { html: (s) => s.replace('<div class="sed-check" data-sed-check>', '<div class="sed-check">') }, 'explainer-checks', /has 1 element with data-sed-check; a lesson needs at least 2 exercises/));
  await t.test('trap: an exercise copy inside a template does not count', () => check(lesson, { html: (s) => s.replace('<div class="sed-check" data-sed-check>', '<template><div data-sed-check>copy</div></template><div class="sed-check">') }, 'explainer-checks', /has 1 element/));
});

test('page contract: words are counted the way a reader sees them', () => {
  const words = (inner) => analyzeContract(`<main><section data-sed-explainer>${inner}</section></main>`).explainers[0].wordCount;
  assert.equal(words('<p>one<br>two</p>'), 2, 'br is a space, it never glues two words');
  assert.equal(words('<p>wo<b>rd</b></p>'), 1, 'inline markup does not split a word');
  assert.equal(words('<p>one</p><p>two</p>'), 2, 'a block boundary separates words');
  assert.equal(words('<p>one <button>two three</button> four</p>'), 2, 'text inside controls does not count');
  assert.equal(words('<p>one <svg><text>two</text></svg> <canvas>three</canvas></p>'), 1);
  assert.equal(words('<div>loose text outside prose</div><h3>heading</h3><p>counted</p>'), 1, 'only prose counts');
  assert.equal(words('<details><summary>More</summary><details><p>deep nested words</p></details></details>'), 3, 'nested details inside the explainer do count');
  assert.equal(words('<p hidden>gone</p><template><p>gone</p></template><noscript><p>gone</p></noscript><p>kept</p>'), 1);
  assert.equal(words('<ul><li>one<li>two</ul><dl><dt>term</dt><dd>three</dd></dl>'), 3, 'li closes an open li; dt is not prose');
  assert.equal(words('<p>caf&eacute;&nbsp;au&#160;lait &amp; more</p>'), 4, 'entities are decoded and nbsp separates words');
  assert.equal(countWords(' a  b c — d '), 4, 'a lone dash is not a word');
  assert.equal(firstSentence('One two. Three four.'), 'One two.');
  assert.equal(firstSentence('No full stop at all'), 'No full stop at all');
});

test('validateRepo: the purpose mix, the page contract, the purpose vocabulary and the lens pool', async (t) => {
  const check = async (config, mutate) => {
    const box = makeSandbox(config ? { config } : {});
    try {
      mutate?.(box);
      const res = await validateRepo({ projects: false });
      return { res, e: res.errors.filter((x) => /^(config|taxonomy|lenses|state-history):/.test(x)), w: res.warnings };
    } finally {
      box.cleanup();
    }
  };
  await t.test('the real config and taxonomy pass', async () => {
    const { e } = await check();
    assert.deepEqual(e, []);
  });
  await t.test('absent blocks are warnings, never errors', async () => {
    const { e, w } = await check((c) => { delete c.pageContract; delete c.mix.purposes; return c; });
    assert.deepEqual(e, []);
    assert.ok(w.some((x) => /mix\.purposes is missing/.test(x)) && w.some((x) => /pageContract is missing/.test(x)), JSON.stringify(w));
  });
  const damaged = {
    'requiredFrom must be null or a date': [(c) => { c.pageContract.requiredFrom = '2026-13-01'; }, /pageContract\.requiredFrom must be null or a date/],
    'requiredFrom may not be a word': [(c) => { c.pageContract.requiredFrom = 'tomorrow'; }, /pageContract\.requiredFrom/],
    'wantedCount 1 or 2': [(c) => { c.mix.purposes.wantedCount = 3; }, /mix\.purposes\.wantedCount must be 1 or 2/],
    'numbers are positive': [(c) => { c.mix.purposes.cooldownDays = -1; }, /mix\.purposes\.cooldownDays must be a positive number/],
    'legacyDefault is a purpose': [(c) => { c.mix.purposes.legacyDefault = 'toy'; }, /legacyDefault "toy" is not a purpose/],
    'minWords keys are purposes': [(c) => { c.pageContract.explainer.minWords.game = 100; }, /explainer\.minWords\.game: "game" is not a purpose/],
    'minHeadings are positive': [(c) => { c.pageContract.explainer.minHeadings.tool = 0; }, /explainer\.minHeadings\.tool must be a positive number/],
    'intro bounds are positive and ordered': [(c) => { c.pageContract.intro.minWords = 90; }, /intro\.minWords is above maxWords/],
    'control budget is ordered': [(c) => { c.pageContract.firstScreenControls.warn = 20; }, /firstScreenControls\.warn is above error/],
    'self-test minimum is positive': [(c) => { c.pageContract.toolMinSelfTests = 'eight'; }, /toolMinSelfTests must be a positive number/],
  };
  for (const [label, [mutate, pattern]] of Object.entries(damaged)) {
    await t.test(label, async () => {
      const { e } = await check((c) => { mutate(c); return c; });
      assert.ok(e.some((x) => pattern.test(x)), `${label}: ${JSON.stringify(e)}`);
    });
  }
  await t.test('taxonomy.purposes must keep "play"', async () => {
    const { e } = await check(undefined, (box) => {
      const tax = box.readJson('ops/taxonomy.json');
      delete tax.purposes.play;
      box.write('ops/taxonomy.json', tax);
    });
    assert.ok(e.some((x) => /^taxonomy: taxonomy\.purposes must contain "play"/.test(x)), JSON.stringify(e));
  });
  await t.test('a history entry with an unknown purpose', async () => {
    const { e } = await check(undefined, (box) => {
      box.write('state/history.json', { schema: 1, startDate: box.cfg.startDate, entries: [historyEntry({ fingerprint: fingerprint({ purpose: 'game' }) })] });
      buildProject(path.join(box.root, 'docs', 'd'), { slug: 'sample-toy' });
    });
    assert.ok(e.some((x) => /unknown purpose "game"/.test(x)), JSON.stringify(e));
  });
  await t.test('every main lens kind keeps at least three lenses', async () => {
    const { e } = await check(undefined, (box) => {
      const pool = box.readJson('ops/lenses.json');
      let kept = 0;
      pool.lenses = pool.lenses.filter((l) => l.kind !== 'humor' || kept++ < 2);
      box.write('ops/lenses.json', pool);
    });
    assert.ok(e.some((x) => /^lenses: ops\/lenses\.json has 2 lenses of kind "humor"; every main kind needs at least 3/.test(x)), JSON.stringify(e));
  });
});

test('CLI: validate.mjs project --contract (before or after the directory)', async () => {
  const box = makeSandbox();
  try {
    const dir = variant(box, BENIGN_FIXTURE, oldStyle);
    assert.equal(cli(['project', dir, '--tier', '1'], box.root).code, 0);
    for (const args of [['project', dir, '--tier', '1', '--contract'], ['project', '--contract', dir, '--tier', '1']]) {
      const r = cli(args, box.root);
      assert.equal(r.code, 1, r.out);
      const codes = codesOf(JSON.parse(r.out).errors);
      for (const c of ['purpose', 'intro-missing', 'explainer-missing']) assert.ok(codes.includes(c), `${args.join(' ')}: ${c} in ${codes}`);
    }
    assert.equal(cli(['project', TOOL_FIXTURE, '--contract'], box.root).code, 0);
    const head = fs.readFileSync(VALIDATE, 'utf8').split('\n').slice(0, 12).join('\n');
    assert.match(head, /validate\.mjs project <dir> \[--tier T\] \[--now ISO\] \[--contract\]/, 'the header usage line names the flag');
  } finally {
    box.cleanup();
  }
});
