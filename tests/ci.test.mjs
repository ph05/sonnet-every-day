// Guards the CI workflow files: the test job must provision everything the browser tests need,
// because tests/qa.test.mjs drives a real Chromium and has no skip logic of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
