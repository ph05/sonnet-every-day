// QA probe, a template for the critic and the expert. Copy it (never edit it here) into work/<date>/qa/critic-tmp/expert/, set
// RESULT, DEMOS and SEQUENCES, and run: node <copy> <site dir> <repo root>. It serves the site on 127.0.0.1 and, in Chromium at 1280x800:
//   1. prints the first frame's result, then clicks every [data-sed-preset] and every DEMOS selector and prints the result after each;
//   2. plays each input sequence, then loads the page afresh with only the final inputs: a different result is a state bug (S2);
//   3. prints window.__sedSelfTest() (on a scratch copy with one constant changed, some case must fail).
// A template, not a test: no suite runs it, and it writes nothing.
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const RESULT = '[data-sed-result]'; // the element the visitor reads the answer or the demo from
const DEMOS = []; // demo buttons the explainer names that carry no data-sed-preset, for example '#demo-collide'
// A step is {fill: selector, value} | {select: selector, value} | {check: selector} | {click: selector} | {press: key}.
// `final` reaches the same end state from a fresh load (usually the last value of each input).
const SEQUENCES = [
  // { steps: [{ fill: '#cidr', value: '10.0.0.0/31' }, { fill: '#cidr', value: '192.168.1.0/24' }], final: [{ fill: '#cidr', value: '192.168.1.0/24' }] },
];

const [site, repo = process.cwd()] = process.argv.slice(2);
if (!site) { console.error('usage: node probe.mjs <site dir> [repo root]'); process.exit(2); }
async function loadPlaywright() {
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= '/opt/pw-browsers';
  try { return await import('playwright'); } catch { /* not installed locally: use the global install */ }
  const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  return import(pathToFileURL(createRequire(path.join(root, 'noop.js')).resolve('playwright')).href);
}
const { startServer } = await import(pathToFileURL(path.join(path.resolve(repo), 'scripts', 'qa', 'serve.mjs')).href);
const pw = await loadPlaywright();
const chromium = pw.chromium || pw.default.chromium;
const server = await startServer(path.resolve(site));
const browser = await chromium.launch();
async function open() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => console.log(`page error: ${e.message}`));
  await page.goto(server.url, { waitUntil: 'load' });
  await page.waitForTimeout(400);
  return page;
}
const shown = async (page) => (await page.locator(RESULT).first().innerText({ timeout: 2000 }).catch(() => `(no ${RESULT})`)).replace(/\s+/g, ' ').trim().slice(0, 300);
async function play(page, steps) {
  for (const s of steps) {
    if (s.fill) await page.fill(s.fill, String(s.value));
    else if (s.select) await page.selectOption(s.select, String(s.value));
    else if (s.check) await page.check(s.check);
    else if (s.click) await page.click(s.click);
    else if (s.press) await page.keyboard.press(s.press);
    await page.waitForTimeout(150);
  }
}
try {
  const page = await open();
  console.log(`first frame: ${await shown(page)}`);
  for (const sel of ['[data-sed-preset]', ...DEMOS]) {
    const all = page.locator(sel);
    for (let i = 0; i < (await all.count()); i++) {
      const el = all.nth(i);
      const name = (await el.getAttribute('data-sed-preset')) || (await el.innerText()).trim() || `${sel} #${i + 1}`;
      await el.scrollIntoViewIfNeeded();
      await el.click();
      await page.waitForTimeout(300);
      console.log(`preset ${JSON.stringify(name)}: ${await shown(page)}`);
    }
  }
  for (const [i, seq] of SEQUENCES.entries()) {
    const [a, b] = [await open(), await open()];
    await play(a, seq.steps);
    await play(b, seq.final);
    const [x, y] = [await shown(a), await shown(b)];
    console.log(`sequence ${i + 1}: ${x === y ? `same: ${x}` : `DIFFERENT (S2): after the sequence "${x}", on a fresh load "${y}"`}`);
    await Promise.all([a.close(), b.close()]);
  }
  const st = await page.evaluate(async () => (typeof window.__sedSelfTest === 'function' ? window.__sedSelfTest() : null));
  console.log(`self-test: ${st ? `${st.passed}/${st.total} passed${(st.cases || []).filter((c) => !c.ok).map((c) => `; FAILED ${c.name}`).join('')}` : 'none on this page'}`);
} finally {
  await browser.close();
  await server.close();
}
