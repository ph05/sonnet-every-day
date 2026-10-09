// Gallery front-end tests: substitute the template placeholders exactly like build-site does,
// serve the result from a tiny local server and drive it with Playwright Chromium.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { renderIndex, render404, readSource, SITE_SRC } from '../site-src/dev/render.mjs';

const SAMPLE = JSON.parse(fs.readFileSync(path.join(SITE_SRC, 'dev', 'archive.sample.json'), 'utf8'));
const SHOTS = fs.mkdtempSync(path.join(os.tmpdir(), 'sed-gallery-shots-'));
const TEMPLATE = readSource('index.template.html');
const TEMPLATE_404 = readSource('404.template.html');
const CSS = readSource('gallery.css');
const JS = readSource('gallery.js');

/* ---------- playwright + server plumbing ---------- */

const unwrap = (mod) => (mod.chromium ? mod : mod.default);

async function loadPlaywright() {
  try {
    return unwrap(await import('playwright'));
  } catch {
    /* fall through to the global install */
  }
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    const require = createRequire(path.join(globalRoot, 'noop.js'));
    return unwrap(await import(pathToFileURL(require.resolve('playwright')).href));
  } catch {
    return null;
  }
}

let pw = null;
let browser = null;
let skipReason = '';
let server = null;
let base = '';
const pages = new Map(); // pathname -> { type, body }
const served = []; // every pathname the server saw

function route(pathname, type, body) {
  pages.set(pathname, { type, body });
}

function resetRoutes(archive = SAMPLE, extra = {}) {
  pages.clear();
  route('/', 'text/html; charset=utf-8', renderIndex(TEMPLATE, archive, { siteUrl: 'https://example.invalid/sonnet-every-day/' }));
  route('/archive.json', 'application/json', JSON.stringify(archive));
  route('/assets/gallery.css', 'text/css; charset=utf-8', CSS);
  route('/assets/gallery.js', 'text/javascript; charset=utf-8', JS);
  route('/404.html', 'text/html; charset=utf-8', render404(TEMPLATE_404, archive, { siteUrl: base }));
  for (const [p, v] of Object.entries(extra)) route(p, v.type, v.body);
}

before(async () => {
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    served.push(pathname);
    let hit = pages.get(pathname);
    if (!hit && pathname.startsWith('/d/')) hit = { type: 'text/html; charset=utf-8', body: '<!doctype html><title>Project stub</title><p>stub</p>' };
    if (!hit) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': hit.type, 'cache-control': 'no-store' });
    res.end(hit.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/`;
  resetRoutes();

  pw = await loadPlaywright();
  if (!pw) {
    skipReason = 'playwright is not installed (npm i -g playwright)';
    return;
  }
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= '/opt/pw-browsers';
  try {
    browser = await pw.chromium.launch();
  } catch (err) {
    skipReason = `chromium unavailable: ${String(err.message).split('\n')[0]}`;
  }
});

after(async () => {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
  console.log(`# gallery screenshots: ${SHOTS}`);
});

/** Opens a page, collecting console errors, page errors and any request that leaves localhost. */
async function open(t, { width = 1280, height = 800, scheme = 'light', reducedMotion = 'no-preference', js = true, url = '/', storage, ready = js } = {}) {
  const context = await browser.newContext({
    viewport: { width, height }, colorScheme: scheme, reducedMotion, javaScriptEnabled: js, deviceScaleFactor: 1,
  });
  if (storage) await context.addInitScript((s) => { try { for (const k in s) localStorage.setItem(k, s[k]); } catch { /* ignore */ } }, storage);
  const page = await context.newPage();
  const problems = { errors: [], external: [] };
  page.on('console', (m) => { if (m.type() === 'error') problems.errors.push(m.text()); });
  page.on('pageerror', (e) => problems.errors.push(String(e)));
  await context.route('**/*', (r) => {
    const u = new URL(r.request().url());
    if (['data:', 'blob:', 'about:'].includes(u.protocol) || u.hostname === '127.0.0.1') return r.continue();
    problems.external.push(r.request().url());
    return r.abort();
  });
  await page.goto(base.replace(/\/$/, '') + url, { waitUntil: 'load' });
  if (ready) await page.waitForSelector('html.ready', { timeout: 5000 });
  t.after(() => context.close());
  return { page, problems };
}

async function shot(page, name) {
  // lazy thumbnails below the fold only load once scrolled into view
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)); }
    window.scrollTo(0, 0);
  }).catch(() => {}); // a JavaScript-disabled context cannot run page scripts
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}
const gate = (t) => { if (!browser) { t.skip(skipReason); return false; } return true; };
const cardDates = (page) => page.$$eval('#grid .card', (els) => els.map((e) => e.dataset.date));
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

/* ---------- tests ---------- */

test('sample data covers what the brief demands', () => {
  const days = SAMPLE.days;
  assert.ok(days.length >= 14);
  assert.equal(new Set(days.map((d) => d.category)).size, 19, 'all taxonomy categories');
  assert.ok(days.some((d) => d.tier === 3) && days.some((d) => d.tier === 4) && days.some((d) => d.tier === 2));
  assert.ok(SAMPLE.stats.missingDates.length >= 1);
  assert.ok(days.every((d) => d.thumb.startsWith('data:image/svg+xml,') && d.palette.length === 3));
});

test('template placeholders are all substituted and escaped', () => {
  const evil = structuredClone(SAMPLE);
  evil.site.name = 'A <b>&"\'';
  evil.days[0].title = '</script><img src=x onerror=alert(1)>';
  const html = renderIndex(TEMPLATE, evil);
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(html), 'no placeholder left behind');
  assert.ok(!html.includes('</script><img'), 'archive JSON cannot break out of its script tag');
  assert.ok(html.includes('A &lt;b&gt;&amp;&quot;&#39;'));
  assert.match(html, /<script type="application\/json" id="archive">/);
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(render404(TEMPLATE_404, SAMPLE)));
});

for (const cfg of [
  { name: 'desktop-light', width: 1280, height: 800, scheme: 'light' },
  { name: 'desktop-dark', width: 1280, height: 800, scheme: 'dark' },
  { name: 'mobile-light', width: 390, height: 844, scheme: 'light' },
  { name: 'mobile-dark', width: 390, height: 844, scheme: 'dark' },
]) {
  test(`renders cleanly: ${cfg.name}`, async (t) => {
    if (!gate(t)) return;
    resetRoutes();
    const { page, problems } = await open(t, cfg);
    await page.waitForTimeout(900); // let the entrance animation settle for the screenshot
    await shot(page, cfg.name);
    assert.deepEqual(problems.errors, [], 'no console or page errors');
    assert.deepEqual(problems.external, [], 'no non-local requests');
    assert.equal(await page.locator('#grid .card').count(), SAMPLE.days.length);
    assert.equal(await page.locator('main').count(), 1);
    assert.equal(await page.locator('header[role=banner], footer[role=contentinfo], nav[aria-label]').count(), 3);
    assert.ok((await overflow(page)) <= 0, 'no horizontal overflow');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme || 'auto'), 'auto');
  });
}

test('no horizontal overflow at 360px and 320px, including the long-scroll ribbon', async (t) => {
  if (!gate(t)) return;
  for (const width of [360, 320]) {
    const { page } = await open(t, { width, height: 740 });
    assert.ok((await overflow(page)) <= 0, `overflow at ${width}px`);
    await page.locator('#more-filters > summary').click();
    assert.ok((await overflow(page)) <= 0, `overflow with filters open at ${width}px`);
    await page.locator('#surprise').click();
    await page.waitForSelector('#pick[open]');
    const box = await page.locator('#pick').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width, 'dialog fits the viewport');
    if (width === 320) await shot(page, 'mobile-320-dialog');
  }
});

test('hero, stats and the run reflect the archive', async (t) => {
  if (!gate(t)) return;
  const { page } = await open(t);
  const latest = SAMPLE.days[0];
  assert.equal(await page.locator('#lead-title').textContent(), latest.title);
  assert.match(await page.locator('.kicker').textContent(), new RegExp(`Day ${latest.n}\\b`));
  assert.equal(await page.locator('.day-numeral').textContent(), String(latest.n));
  assert.equal(await page.locator('#lead-open').getAttribute('href'), latest.path);
  const stats = await page.locator('.stat-value').allTextContents();
  assert.deepEqual(stats.slice(0, 3), [String(SAMPLE.days.length), String(SAMPLE.stats.streak), '19']);
  const cells = await page.locator('.run-cell').count();
  const missing = await page.locator('.run-cell.is-missing').count();
  assert.equal(missing, 2, 'the two gaps are drawn');
  assert.equal(cells, SAMPLE.days.length + 2);
  assert.equal(await page.locator('a.run-cell.is-standin').count(), 2);
  assert.equal(await page.locator('a.run-cell[tabindex="0"]').count(), 1, 'roving tabindex: one tab stop');
  // Hover caption
  await page.locator('a.run-cell').nth(3).hover();
  assert.match(await page.locator('#run-caption').textContent(), /^Day 4/);
  await page.locator('.run-cell.is-missing').first().hover();
  assert.match(await page.locator('#run-caption').textContent(), /no build/);
});

test('stand-in days look distinct but are labelled', async (t) => {
  if (!gate(t)) return;
  const { page } = await open(t);
  const stand = page.locator('.card.is-standin');
  assert.equal(await stand.count(), 2);
  assert.match(await stand.first().locator('.stamp').textContent(), /Ideas Day|Postcard/);
  assert.equal(await stand.first().evaluate((el) => getComputedStyle(el).borderStyle), 'dashed');
});

test('search, filters, sort and the URL hash', async (t) => {
  if (!gate(t)) return;
  const { page } = await open(t);
  await page.fill('#q', 'hockey');
  await page.waitForFunction(() => document.querySelectorAll('#grid .card').length < 21);
  const dates = await cardDates(page);
  assert.ok(dates.length >= 2 && dates.length < SAMPLE.days.length);
  assert.ok(dates.every((d) => /hockey|overtime|tempo/i.test(JSON.stringify(SAMPLE.days.find((x) => x.date === d)))));
  assert.match(await page.evaluate(() => location.hash), /q=hockey/);
  assert.match(await page.locator('#result-count').textContent(), /Showing \d+ of 21 builds/);

  // category chip narrows further (AND across groups)
  await page.click('.chip[data-key="cat"][data-value="hockey-sports"]');
  await page.waitForFunction(() => location.hash.includes('cat=hockey-sports'));
  const narrowed = await cardDates(page);
  assert.ok(narrowed.every((d) => SAMPLE.days.find((x) => x.date === d).category === 'hockey-sports'));
  assert.equal(await page.locator('.chip[data-value="hockey-sports"]').getAttribute('aria-pressed'), 'true');

  // deep link restores the state in a fresh page
  const hash = await page.evaluate(() => location.hash);
  const second = await open(t, { url: '/' + hash });
  assert.equal(await second.page.inputValue('#q'), 'hockey');
  assert.deepEqual(await cardDates(second.page), narrowed);

  // clear
  await page.click('#clear-filters');
  assert.equal((await cardDates(page)).length, SAMPLE.days.length);
  assert.equal(await page.evaluate(() => location.hash), '');

  // empty result state has personality and a way out
  await page.fill('#q', 'zzzzqx');
  await page.waitForSelector('#empty-results:not([hidden])');
  assert.match(await page.locator('#empty-results-text').textContent(), /zzzzqx/);
  await page.click('#empty-clear');
  assert.equal((await cardDates(page)).length, SAMPLE.days.length);

  // tone / tech / tag / kind live under "More filters"
  await page.locator('#more-filters > summary').click();
  await page.click('.chip[data-key="kind"][data-value="standin"]');
  assert.equal((await cardDates(page)).length, 2);
  await page.click('#clear-filters');
  await page.click('.chip[data-key="tone"][data-value="serene"]');
  const serene = await cardDates(page);
  assert.ok(serene.length >= 3 && serene.every((d) => SAMPLE.days.find((x) => x.date === d).tone.includes('serene')));
  await page.click('#clear-filters');
  await page.click('.chip[data-key="tech"][data-value="webaudio"]');
  assert.equal((await cardDates(page)).length, 1);
  await page.click('#clear-filters');

  // a tag button on a card toggles the tag filter
  await page.locator('.card .tag').first().click();
  assert.match(await page.evaluate(() => location.hash), /tag=/);
  await page.click('#clear-filters');

  // sort
  await page.selectOption('#sort', 'old');
  assert.equal((await cardDates(page))[0], SAMPLE.days.at(-1).date);
  await page.selectOption('#sort', 'title');
  const titles = await page.$$eval('#grid .card-link', (els) => els.map((e) => e.textContent.toLowerCase()));
  assert.deepEqual(titles, [...titles].sort());
  await page.selectOption('#sort', 'category');
  assert.match(await page.evaluate(() => location.hash), /sort=category/);
});

test('unknown hash values are ignored and a hash change re-filters', async (t) => {
  if (!gate(t)) return;
  const { page } = await open(t, { url: '/#cat=nope,science-sim&sort=bogus&tag=ghost' });
  assert.equal((await cardDates(page)).length, 1);
  await page.evaluate(() => { location.hash = 'q=pigeons'; });
  await page.waitForFunction(() => document.querySelectorAll('#grid .card').length === 1);
  assert.equal(await page.inputValue('#q'), 'pigeons');
});

test('surprise me opens a pick dialog (button and r), avoids repeats, and closes', async (t) => {
  if (!gate(t)) return;
  const { page } = await open(t);
  await page.click('#surprise');
  await page.waitForSelector('#pick[open]');
  await page.waitForFunction(() => document.querySelector('#pick-kicker').textContent === 'Your random pick');
  const href = await page.getAttribute('#pick-open', 'href');
  assert.ok(SAMPLE.days.some((d) => d.path === href));
  const first = await page.textContent('#pick-title');
  assert.ok(SAMPLE.days.some((d) => d.title === first));
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#pick[open]').count(), 0);

  const seen = new Set();
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('r');
    await page.waitForFunction(() => document.querySelector('#pick-kicker').textContent === 'Your random pick');
    seen.add(await page.textContent('#pick-title'));
    await page.keyboard.press('Escape');
  }
  assert.ok(seen.size >= 2, 'random picks vary');
  await page.keyboard.press('r');
  await page.waitForFunction(() => document.querySelector('#pick-kicker').textContent === 'Your random pick');
  await page.click('#pick-again');
  await page.waitForFunction(() => document.querySelector('#pick-kicker').textContent === 'Your random pick');
  await shot(page, 'desktop-pick');
  await page.click('#pick-close');

  // pool honours the active filter
  await page.click('.chip[data-value="music-audio"]');
  await page.keyboard.press('r');
  await page.waitForFunction(() => document.querySelector('#pick-kicker').textContent === 'Your random pick');
  assert.equal(await page.textContent('#pick-title'), SAMPLE.days.find((d) => d.category === 'music-audio').title);
  assert.match(await page.textContent('.pick-note'), /matching your filters/);
});

test('keyboard shortcuts: / j k o ? t Esc', async (t) => {
  if (!gate(t)) return;
  const { page } = await open(t);
  await page.keyboard.press('/');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'q');
  assert.equal(await page.inputValue('#q'), '', 'the slash is not typed into the box');
  await page.keyboard.type('j'); // typing into the box must not trigger shortcuts
  assert.equal(await page.inputValue('#q'), 'j');
  await page.keyboard.press('Escape'); // clears
  assert.equal(await page.inputValue('#q'), '');
  await page.keyboard.press('Escape'); // leaves
  assert.notEqual(await page.evaluate(() => document.activeElement.id), 'q');
  await page.waitForFunction(() => document.querySelectorAll('#grid .card').length === 21);

  await page.keyboard.press('j');
  assert.equal(await page.evaluate(() => document.activeElement.closest('.card').dataset.date), SAMPLE.days[0].date);
  await page.keyboard.press('j');
  await page.keyboard.press('j');
  assert.equal(await page.evaluate(() => document.activeElement.closest('.card').dataset.date), SAMPLE.days[2].date);
  await page.keyboard.press('k');
  assert.equal(await page.evaluate(() => document.activeElement.closest('.card').dataset.date), SAMPLE.days[1].date);
  await shot(page, 'desktop-keyboard-focus');

  await page.keyboard.press('o');
  await page.waitForURL(new RegExp(SAMPLE.days[1].path.replace(/\//g, '\\/')));
  await page.goBack();
  await page.waitForSelector('html.ready');

  await page.keyboard.press('?');
  await page.waitForSelector('#help[open]');
  assert.match(await page.textContent('#help'), /Surprise me/);
  await shot(page, 'desktop-help');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#help[open]').count(), 0);

  await page.keyboard.press('t');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('o');
  await page.waitForURL(new RegExp(SAMPLE.days[0].path.replace(/\//g, '\\/')), { timeout: 4000 }); // no card focused: opens the lead
});

test('the run supports arrow-key travel', async (t) => {
  if (!gate(t)) return;
  const { page } = await open(t);
  await page.focus('a.run-cell[tabindex="0"]');
  const first = await page.evaluate(() => document.activeElement.dataset.date);
  await page.keyboard.press('ArrowLeft');
  const second = await page.evaluate(() => document.activeElement.dataset.date);
  assert.ok(second < first);
  await page.keyboard.press('Home');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.date), SAMPLE.days.at(-1).date);
  await page.keyboard.press('End');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.date), SAMPLE.days[0].date);
});

test('theme toggle persists and honours the system preference', async (t) => {
  if (!gate(t)) return;
  const { page } = await open(t, { scheme: 'dark' });
  assert.equal(await page.getAttribute('#theme-toggle', 'aria-pressed'), 'true');
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const dark = await bg();
  await page.click('#theme-toggle');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  assert.notEqual(await bg(), dark);
  await page.reload();
  await page.waitForSelector('html.ready');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light', 'stored in localStorage');
  assert.equal(await page.getAttribute('#theme-toggle', 'aria-pressed'), 'false');
});

test('storage failures never break the page', async (t) => {
  if (!gate(t)) return;
  const context = await browser.newContext();
  t.after(() => context.close());
  await context.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(base);
  await page.waitForSelector('html.ready');
  await page.click('#theme-toggle');
  assert.deepEqual(errors, []);
  assert.equal(await page.locator('#grid .card').count(), 21);
});

test('colour tokens meet WCAG AA in both themes', async (t) => {
  if (!gate(t)) return;
  const lum = ([r, g, b]) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const scheme of ['light', 'dark']) {
    const { page } = await open(t, { scheme });
    const rgb = await page.evaluate(() => {
      const probe = document.createElement('i');
      document.body.append(probe);
      const get = (name) => { probe.style.color = `var(${name})`; const m = getComputedStyle(probe).color.match(/[\d.]+/g).map(Number); return m.slice(0, 3); };
      const out = Object.fromEntries(['--paper', '--card', '--ink', '--muted', '--accent', '--on-accent', '--focus'].map((k) => [k, get(k)]));
      probe.remove();
      return out;
    });
    const pairs = [['--ink', '--paper', 4.5], ['--ink', '--card', 4.5], ['--muted', '--paper', 4.5], ['--muted', '--card', 4.5], ['--accent', '--paper', 4.5], ['--accent', '--card', 4.5], ['--on-accent', '--accent', 4.5], ['--focus', '--paper', 3], ['--focus', '--card', 3]];
    for (const [fg, bg, min] of pairs) {
      const r = ratio(rgb[fg], rgb[bg]);
      assert.ok(r >= min, `${scheme}: ${fg} on ${bg} is ${r.toFixed(2)}, needs ${min}`);
    }
  }
});

test('reduced motion switches animation off', async (t) => {
  if (!gate(t)) return;
  const { page } = await open(t, { reducedMotion: 'reduce' });
  const anim = await page.evaluate(() => getComputedStyle(document.querySelector('.card')).animationName);
  assert.equal(anim, 'none');
  await page.click('#surprise');
  await page.waitForSelector('#pick[open]');
  assert.equal(await page.textContent('#pick-kicker'), 'Your random pick', 'no reel when motion is reduced');
});

test('keyboard focus is visible', async (t) => {
  if (!gate(t)) return;
  const { page } = await open(t);
  for (let i = 0; i < 4; i++) await page.keyboard.press('Tab');
  const style = await page.evaluate(() => {
    const cs = getComputedStyle(document.activeElement);
    return { width: cs.outlineWidth, style: cs.outlineStyle };
  });
  assert.equal(style.style, 'solid');
  assert.ok(parseFloat(style.width) >= 2);
});

test('without JavaScript the plain list of builds is present', async (t) => {
  if (!gate(t)) return;
  const { page, problems } = await open(t, { js: false });
  const items = await page.locator('.noscript .plain-list li a').count();
  assert.equal(items, SAMPLE.days.length);
  assert.equal(await page.locator('.noscript .plain-list li a').first().getAttribute('href'), SAMPLE.days[0].path);
  assert.ok(await page.locator('.noscript').isVisible());
  assert.equal(await page.locator('#grid').isVisible(), false);
  assert.ok((await overflow(page)) <= 0);
  await shot(page, 'no-js');
  assert.deepEqual(problems.errors, []);
});

test('day 0: an empty archive gets a friendly empty state', async (t) => {
  if (!gate(t)) return;
  const empty = { schema: 1, generatedAt: '2026-10-09T01:00:00Z', site: { name: 'Sonnet Every Day', tagline: 'Soon.', url: 'https://example.invalid/', startDate: '2999-01-01' }, stats: { days: 0, projects: 0, streak: 0, categories: {}, firstDate: null, lastDate: null }, days: [] };
  resetRoutes(empty);
  const { page, problems } = await open(t, { width: 1280, height: 800 });
  assert.match(await page.locator('#lead-title').textContent(), /Nothing is in the gallery/);
  assert.match(await page.locator('.kicker').textContent(), /Day 0/);
  assert.match(await page.locator('.lead-desc').textContent(), /Doors open/);
  assert.equal(await page.locator('#builds').isVisible(), false);
  assert.equal(await page.locator('#run').isVisible(), false);
  await page.keyboard.press('r');
  assert.match(await page.textContent('#toast'), /Day 1 is still in the oven/);
  await page.keyboard.press('j');
  await page.keyboard.press('/');
  await page.keyboard.press('o');
  await shot(page, 'empty-desktop');
  assert.deepEqual(problems.errors, []);
  const mobile = await open(t, { width: 390, height: 844, scheme: 'dark' });
  assert.ok((await overflow(mobile.page)) <= 0);
  await shot(mobile.page, 'empty-mobile-dark');
  resetRoutes();
});

test('robust to missing optional fields, junk entries and hostile strings', async (t) => {
  if (!gate(t)) return;
  const sparse = {
    schema: 1,
    days: [
      { date: '2026-11-03' },
      { date: '2026-11-02', title: '<img src=x onerror="window.__pwned=1">', path: 'javascript:window.__pwned=2', thumb: 'javascript:alert(1)', palette: ['red; background:url(//evil.example/x)', 'not a color'], tags: [null, 5, 'ok-tag'], tier: 'three', category: 'brand-new-category' },
      { date: '2026-11-02', title: 'duplicate date is dropped' },
      { title: 'no date is dropped' },
      null,
      'junk',
      { date: '2026-13-45', title: 'impossible date' },
      { date: '2026-10-31', slug: 'only-a-slug', tier: 4, thumb: 'data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27/%3E' },
    ],
  };
  resetRoutes(sparse);
  const { page, problems } = await open(t);
  assert.equal(await page.locator('#grid .card').count(), 3);
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.equal(await page.locator('#grid a[href^="javascript"]').count(), 0);
  assert.equal(await page.locator('#lead-title').textContent(), '2026-11-03', 'title falls back to the date');
  assert.equal(await page.locator('.card[data-date="2026-10-31"] .card-link').getAttribute('href'), 'd/2026-10-31-only-a-slug/');
  assert.equal(await page.locator('.card[data-date="2026-11-02"] .card-link').evaluate((e) => e.tagName), 'SPAN', 'no safe link, no anchor');
  assert.match(await page.textContent('.card[data-date="2026-11-02"] .meta'), /Brand new category/);
  assert.equal(await page.locator('.run-cell.is-missing').count(), 1, 'Nov 1 is a gap');
  assert.ok((await overflow(page)) <= 0);
  assert.deepEqual(problems.errors, []);
  assert.deepEqual(problems.external, []);

  // Corrupt inline JSON: recover from archive.json.
  resetRoutes(SAMPLE);
  pages.set('/', { type: 'text/html; charset=utf-8', body: renderIndex(TEMPLATE, SAMPLE).replace(/(<script type="application\/json" id="archive">)[\s\S]*?(<\/script>)/, '$1{oops$2') });
  const recovered = await open(t);
  assert.equal(await recovered.page.locator('#grid .card').count(), 21);
  assert.deepEqual(recovered.problems.errors, []);
  resetRoutes();
});

test('1,500 days: paginates, stays fast and never overflows', async (t) => {
  if (!gate(t)) return;
  const days = [];
  const start = Date.UTC(2026, 9, 9);
  const cats = Object.keys(SAMPLE.stats.categories);
  for (let i = 1499; i >= 0; i--) {
    if (i % 17 === 5) continue; // sprinkle gaps
    const date = new Date(start + i * 86400000).toISOString().slice(0, 10);
    const proto = SAMPLE.days[i % SAMPLE.days.length];
    days.push({ ...proto, n: i + 1, date, slug: `s${i}`, path: `d/${date}-s${i}/`, title: `${proto.title} #${i + 1}`, category: cats[i % cats.length], tier: i % 41 === 0 ? 3 : 1 });
  }
  const big = { ...SAMPLE, days, stats: { ...SAMPLE.stats, days: days.length, missingDates: [] } };
  resetRoutes(big);
  const started = Date.now();
  const { page, problems } = await open(t, { width: 390, height: 844 });
  const loadMs = Date.now() - started;
  assert.ok(loadMs < 4000, `loaded in ${loadMs}ms`);
  assert.equal(await page.locator('#grid .card').count(), 24, 'only one page rendered');
  assert.match(await page.textContent('#load-more'), /Show 24 more/);
  assert.equal(await page.locator('.run-cell').count() >= days.length, true);
  assert.ok((await overflow(page)) <= 0);
  await page.click('#load-more');
  assert.equal(await page.locator('#grid .card').count(), 48);
  // j past the last rendered card pulls in the next page
  await page.focus('#grid .card:last-child .card-link');
  await page.keyboard.press('j');
  assert.equal(await page.locator('#grid .card').count(), 72);
  await page.fill('#q', 'pigeons');
  await page.waitForFunction(() => /Showing/.test(document.querySelector('#result-count').textContent));
  const t0 = Date.now();
  await page.fill('#q', '');
  await page.waitForFunction(() => document.querySelectorAll('#grid .card').length === 24);
  assert.ok(Date.now() - t0 < 2000);
  await shot(page, 'big-mobile');
  assert.deepEqual(problems.errors, []);
  assert.deepEqual(problems.external, []);
  resetRoutes();
});

test('the 404 page renders and offers a way home', async (t) => {
  if (!gate(t)) return;
  resetRoutes();
  const { page, problems } = await open(t, { url: '/404.html', width: 390, height: 844, ready: false });
  assert.match(await page.textContent('h1'), /wandered off/);
  assert.equal(await page.locator('a.btn-primary').getAttribute('href'), './');
  await page.waitForSelector('#suggest:not([hidden])');
  assert.ok((await overflow(page)) <= 0);
  await shot(page, '404-mobile');
  assert.deepEqual(problems.errors, []);
  assert.deepEqual(problems.external, []);
});
