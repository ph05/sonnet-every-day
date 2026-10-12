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
import { renderIndex, render404, renderKaizen, readSource, SITE_SRC } from '../site-src/dev/render.mjs';
import { buildArchive } from '../scripts/lib/archive.mjs';
import { loadFactor } from './helpers/cpu.mjs';

const SAMPLE = JSON.parse(fs.readFileSync(path.join(SITE_SRC, 'dev', 'archive.sample.json'), 'utf8'));
const SHOTS = fs.mkdtempSync(path.join(os.tmpdir(), 'sed-gallery-shots-'));
const TEMPLATE = readSource('index.template.html');
const TEMPLATE_404 = readSource('404.template.html');
const TEMPLATE_KAIZEN = readSource('kaizen.template.html');
const LEDGER = JSON.parse(fs.readFileSync(path.join(SITE_SRC, 'dev', 'kaizen.sample.json'), 'utf8'));
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
  route('/kaizen/', 'text/html; charset=utf-8', renderKaizen(TEMPLATE_KAIZEN, archive, LEDGER));
  route('/assets/kaizen.css', 'text/css; charset=utf-8', readSource('kaizen.css'));
  route('/assets/kaizen.js', 'text/javascript; charset=utf-8', readSource('kaizen.js'));
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
async function open(t, { width = 1280, height = 800, scheme = 'light', reducedMotion = 'no-preference', js = true, url = '/', storage, ready = js, observer = true } = {}) {
  const context = await browser.newContext({
    viewport: { width, height }, colorScheme: scheme, reducedMotion, javaScriptEnabled: js, deviceScaleFactor: 1,
  });
  // observer:false removes IntersectionObserver before any page script runs, so the gallery's scroll-driven "load the next page when
  // Show more nears the viewport" never fires; tests that count cards after an explicit click or key press need exactly one cause.
  if (!observer) await context.addInitScript(() => { delete window.IntersectionObserver; });
  if (storage) await context.addInitScript((s) => { try { for (const k in s) localStorage.setItem(k, s[k]); } catch { /* ignore */ } }, storage);
  const page = await context.newPage();
  if (!js) page.noScript = true; // shot() cannot scroll such a page
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
  // lazy thumbnails below the fold only load once scrolled into view. A JavaScript-disabled context cannot run page scripts, and page.evaluate
  // there does not fail at once: it waits out Playwright's 30 s timeout (this one call was 30 of the file's 70 seconds), so such a page is not scrolled.
  if (!page.noScript) {
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)); }
      window.scrollTo(0, 0);
    }).catch(() => {});
  }
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}
const gate = (t) => { if (!browser) { t.skip(skipReason); return false; } return true; };
const cardDates = (page) => page.$$eval('#grid .card', (els) => els.map((e) => e.dataset.date));
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

/* ---------- tests ---------- */

const TAXONOMY = JSON.parse(fs.readFileSync(path.join(SITE_SRC, '..', 'ops', 'taxonomy.json'), 'utf8'));
const PURPOSE_KEYS = Object.keys(TAXONOMY.purposes);
const SAMPLE_CATEGORIES = new Set(SAMPLE.days.map((d) => d.category));

test('sample data covers what the brief demands', () => {
  const days = SAMPLE.days;
  assert.ok(days.length >= 14);
  assert.ok([...SAMPLE_CATEGORIES].every((c) => Object.hasOwn(TAXONOMY.categories, c)), 'every sample category is a taxonomy category');
  assert.ok(SAMPLE_CATEGORIES.size >= 19, `${SAMPLE_CATEGORIES.size} categories`);
  assert.ok(['personal-finance', 'math-concepts', 'stats-literacy'].every((c) => SAMPLE_CATEGORIES.has(c)), 'some of the eleven broader categories');
  assert.deepEqual(PURPOSE_KEYS.filter((p) => days.some((d) => d.purpose === p)), PURPOSE_KEYS, 'every purpose appears');
  assert.ok(days.some((d) => d.tier <= 2 && d.purpose === ''), 'a page from before the contract has no purpose');
  assert.ok(days.filter((d) => d.tier >= 3).every((d) => d.purpose === '' && d.intro === ''), 'stand-ins have no purpose');
  assert.ok(days[0].intro && days[0].purpose, 'the lead day has an intro and a purpose');
  assert.deepEqual(Object.keys(SAMPLE.stats.purposes), PURPOSE_KEYS, 'stats.purposes in canonical order');
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
  assert.deepEqual(stats.slice(0, 3), [String(SAMPLE.days.length), String(SAMPLE.stats.streak), String(SAMPLE_CATEGORIES.size)]);
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

test('the Type filter: chips in canonical order, before Category, outside More filters, in the hash, cleared by Clear all', async (t) => {
  if (!gate(t)) return;
  const { page, problems } = await open(t);
  const group = page.locator('#filter-type');
  assert.equal(await group.isVisible(), true);
  assert.equal(await page.evaluate(() => {
    const type = document.querySelector('#filter-type');
    const cat = document.querySelector('#filter-cat');
    return Boolean(type.compareDocumentPosition(cat) & Node.DOCUMENT_POSITION_FOLLOWING) && !document.querySelector('#more-filters').contains(type);
  }), true, 'Type comes before Category and is always visible');
  const chips = await page.$$eval('#chips-type .chip', (els) => els.map((e) => [e.dataset.value, e.querySelector('span').textContent, Number(e.querySelector('.chip-count').textContent)]));
  assert.deepEqual(chips, [['tool', 'Tools', 2], ['lesson', 'Lessons', 2], ['explorer', 'Explorers', 2], ['studio', 'Studios', 3], ['play', 'Play', 9]]);
  await page.click('.chip[data-key="type"][data-value="lesson"]');
  await page.click('.chip[data-key="type"][data-value="tool"]');
  await page.waitForFunction(() => location.hash.includes('type=tool,lesson'));
  const both = await cardDates(page);
  assert.deepEqual(both.sort(), SAMPLE.days.filter((d) => d.purpose === 'tool' || d.purpose === 'lesson').map((d) => d.date).sort());
  assert.equal(await page.textContent('#more-filters-label'), 'More filters', 'the type filter is not counted under More filters');
  assert.equal(await page.locator('.chip[data-value="tool"]').getAttribute('aria-pressed'), 'true');
  // AND with category, deep link in a fresh page, then Clear all
  await page.click('.chip[data-key="cat"][data-value="personal-finance"]');
  assert.deepEqual(await cardDates(page), ['2026-10-22']);
  const hash = await page.evaluate(() => location.hash);
  const second = await open(t, { url: '/' + hash });
  assert.deepEqual(await cardDates(second.page), ['2026-10-22']);
  await page.click('#clear-filters');
  assert.equal((await cardDates(page)).length, SAMPLE.days.length);
  assert.equal(await page.evaluate(() => location.hash), '');
  // keyboard: a chip is a real button
  await page.focus('.chip[data-key="type"][data-value="studio"]');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('.chip[data-value="studio"]').getAttribute('aria-pressed'), 'true');
  assert.equal((await cardDates(page)).length, 3);
  // unknown types in a hand-made hash are ignored
  const odd = await open(t, { url: '/#type=nope,explorer,play2' });
  assert.deepEqual((await cardDates(odd.page)).sort(), SAMPLE.days.filter((d) => d.purpose === 'explorer').map((d) => d.date).sort());
  assert.equal(await odd.page.evaluate(() => location.hash), '#type=explorer');
  assert.deepEqual(problems.errors, []);
});

test('every card shows its purpose pill before the category label; the lead shows the intro instead of the description', async (t) => {
  if (!gate(t)) return;
  const { page } = await open(t);
  for (const d of SAMPLE.days) {
    const meta = page.locator(`.card[data-date="${d.date}"] .meta`);
    const pill = meta.locator('.purpose-pill');
    if (!d.purpose) {
      assert.equal(await pill.count(), 0, `${d.date} has no purpose, so no pill`);
      continue;
    }
    assert.equal(await pill.textContent(), { tool: 'Tool', lesson: 'Lesson', explorer: 'Explorer', studio: 'Studio', play: 'Play' }[d.purpose]);
    // the pill sits between the date and the category label
    const around = await meta.evaluate((el) => {
      const pillEl = el.querySelector('.purpose-pill');
      const text = (from, dir) => {
        let out = '';
        for (let n = from[dir]; n; n = n[dir]) out = dir === 'nextSibling' ? out + n.textContent : n.textContent + out;
        return out.trim();
      };
      return { before: text(pillEl, 'previousSibling'), after: text(pillEl, 'nextSibling') };
    });
    assert.match(around.before, /·$/, `${d.date}: ${JSON.stringify(around)}`);
    assert.ok(around.after.length > 0, `${d.date}: the category label follows the pill`);
    if (d.category === 'personal-finance') assert.equal(around.after, 'Personal finance');
    if (d.category === 'stats-literacy') assert.equal(around.after, 'Stats literacy');
  }
  const lead = SAMPLE.days[0];
  assert.equal(await page.locator('.lead-intro').textContent(), lead.intro);
  assert.equal(await page.locator('.lead-tagline').textContent(), lead.tagline, 'the tagline stays');
  assert.equal(await page.locator('#lead').evaluate((el, desc) => el.textContent.includes(desc), lead.description), false, 'the intro takes the description\'s place');
  assert.equal(await page.locator('.lead-chips .pill-purpose').textContent(), 'Explorer');
  // a lead without an intro keeps its description
  const older = structuredClone(SAMPLE);
  older.days = older.days.map((d) => ({ ...d, intro: '', purpose: '' }));
  resetRoutes(older);
  t.after(() => resetRoutes());
  const plain = await open(t);
  assert.equal(await plain.page.locator('.lead-desc').textContent(), lead.description);
  assert.equal(await plain.page.locator('.purpose-pill, .pill-purpose').count(), 0);
  assert.equal(await plain.page.locator('#filter-type').isVisible(), false, 'no purposes, no Type group');
});

test('the search finds words that only appear in an intro or a concept', async (t) => {
  if (!gate(t)) return;
  const { page } = await open(t);
  const only = (date) => page.waitForFunction((want) => {
    const cards = document.querySelectorAll('#grid .card');
    return cards.length === 1 && cards[0].dataset.date === want;
  }, date);
  await page.fill('#q', 'napkin'); // only in the intro of Receipt Roulette
  await only('2026-10-22');
  await page.fill('#q', 'expected value'); // only in the concepts of Ruin Odds
  await only('2026-10-27');
  assert.deepEqual(await cardDates(page), ['2026-10-27']);
});

test('the conforming contract fixtures (tool, lesson, sample play page) render with their pill, the Type filter and the intro', async (t) => {
  if (!gate(t)) return;
  const fixtures = path.join(SITE_SRC, '..', 'tests', 'fixtures');
  const dirs = [path.join(fixtures, 'gate-benign', '2026-10-09-sample-toy'), path.join(fixtures, 'contract', '2026-10-20-contrast-checker'), path.join(fixtures, 'contract', '2026-10-21-parity-bit-lesson')];
  const projects = dirs.map((dir) => {
    const project = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
    return { project, entry: { date: project.date, slug: project.slug, title: project.title, tagline: project.tagline, tier: project.tier } };
  });
  const archive = buildArchive({ projects, config: { name: 'Sonnet Every Day', startDate: '2026-10-09' }, siteUrl: 'https://example.invalid/', now: new Date('2026-10-21T12:00:00Z'), through: '2026-10-21' });
  const thumbs = Object.fromEntries(dirs.map((dir, i) => [`/${archive.days.find((d) => d.slug === projects[i].project.slug).thumb}`, { type: 'image/png', body: fs.readFileSync(path.join(dir, 'thumb.png')) }]));
  resetRoutes(archive, thumbs);
  t.after(() => resetRoutes());
  const { page, problems } = await open(t);
  const pills = await page.$$eval('#grid .card', (els) => els.map((e) => [e.dataset.date, e.querySelector('.purpose-pill')?.textContent ?? '']));
  assert.deepEqual(pills, [['2026-10-21', 'Lesson'], ['2026-10-20', 'Tool'], ['2026-10-09', 'Play']]);
  assert.deepEqual(await page.$$eval('#chips-type .chip', (els) => els.map((e) => e.dataset.value)), ['tool', 'lesson', 'play']);
  assert.equal(await page.locator('.lead-intro').textContent(), projects[2].project.intro, 'the newest page leads with its intro');
  await page.click('.chip[data-key="type"][data-value="tool"]');
  assert.deepEqual(await cardDates(page), ['2026-10-20']);
  await page.waitForFunction(() => [...document.querySelectorAll('#grid .card img')].every((i) => i.complete && i.naturalWidth > 0));
  await shot(page, 'contract-fixtures-desktop');
  assert.deepEqual(problems.errors, []);
  assert.deepEqual(problems.external, []);
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
      { date: '2026-11-02', title: '<img src=x onerror="window.__pwned=1">', path: 'javascript:window.__pwned=2', thumb: 'javascript:alert(1)', palette: ['red; background:url(//evil.example/x)', 'not a color'], tags: [null, 5, 'ok-tag'], tier: 'three', category: 'brand-new-category', purpose: '<b>tool</b>', intro: '<img src=x onerror="window.__pwned=3">', concepts: 'not a list' },
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
  assert.equal(await page.locator('.purpose-pill').count(), 0, 'an unknown purpose gets no pill');
  assert.equal(await page.locator('#filter-type').isVisible(), false);
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

/** 1,500 days with a gap every 17th day: far more than one page of cards. */
function bigArchive() {
  const days = [];
  const start = Date.UTC(2026, 9, 9);
  const cats = Object.keys(SAMPLE.stats.categories);
  for (let i = 1499; i >= 0; i--) {
    if (i % 17 === 5) continue; // sprinkle gaps
    const date = new Date(start + i * 86400000).toISOString().slice(0, 10);
    const proto = SAMPLE.days[i % SAMPLE.days.length];
    days.push({ ...proto, n: i + 1, date, slug: `s${i}`, path: `d/${date}-s${i}/`, title: `${proto.title} #${i + 1}`, category: cats[i % cats.length], tier: i % 41 === 0 ? 3 : 1 });
  }
  return { ...SAMPLE, days, stats: { ...SAMPLE.stats, days: days.length, missingDates: [] } };
}
const cardCountIs = (page, n) => page.waitForFunction((want) => document.querySelectorAll('#grid .card').length === want, n);

test('1,500 days: paginates, stays fast and never overflows', async (t) => {
  if (!gate(t)) return;
  const big = bigArchive();
  const days = big.days;
  resetRoutes(big);
  t.after(() => resetRoutes()); // also when an assertion below throws: the next test must not inherit the big archive
  const started = Date.now();
  // The button and the j key are the explicit ways to load a page. The scroll-driven auto-load (next test) is off here: with it on,
  // the observer can load a page in addition, at a moment that depends on frame scheduling (and on the machine's load), so the
  // exact counts below were a race (once seen: 96 cards where 72 were expected).
  const { page, problems } = await open(t, { width: 390, height: 844, observer: false });
  const loadMs = Date.now() - started;
  assert.ok(loadMs < 4000 * loadFactor(), `loaded in ${loadMs}ms`);
  assert.equal(await page.locator('#grid .card').count(), 24, 'only one page rendered');
  assert.match(await page.textContent('#load-more'), /Show 24 more/);
  assert.equal(await page.locator('.run-cell').count() >= days.length, true);
  assert.ok((await overflow(page)) <= 0);
  await page.click('#load-more');
  await cardCountIs(page, 48);
  // j past the last rendered card pulls in the next page
  await page.focus('#grid .card:last-child .card-link');
  await page.keyboard.press('j');
  await cardCountIs(page, 72);
  await page.fill('#q', 'pigeons');
  await page.waitForFunction(() => /Showing/.test(document.querySelector('#result-count').textContent));
  const t0 = Date.now();
  await page.fill('#q', '');
  await cardCountIs(page, 24);
  assert.ok(Date.now() - t0 < 2000 * loadFactor());
  await shot(page, 'big-mobile');
  assert.deepEqual(problems.errors, []);
  assert.deepEqual(problems.external, []);
});

test('1,500 days: Show more loads the next page by itself once it nears the viewport', async (t) => {
  if (!gate(t)) return;
  resetRoutes(bigArchive());
  t.after(() => resetRoutes());
  const { page, problems } = await open(t, { width: 390, height: 844 });
  await cardCountIs(page, 24); // one page to begin with: the button is far below the fold
  await page.evaluate(() => document.querySelector('#load-more').scrollIntoView({ block: 'center' }));
  await page.waitForFunction(() => document.querySelectorAll('#grid .card').length > 24); // the observer loads at least one more page, whenever the browser gets to it
  const count = await page.locator('#grid .card').count();
  assert.equal(count % 24, 0, `only whole pages are added (${count} cards)`);
  assert.deepEqual(problems.errors, []);
  assert.deepEqual(problems.external, []);
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

/* ---------- the swarm's diary and its teaser on the gallery ---------- */

const ENTRY_COUNT = LEDGER.entries.filter((e) => e.status !== 'proposed').length;
const PROPOSAL_COUNT = LEDGER.entries.filter((e) => e.status === 'proposed').length;
const visibleEntries = (page) => page.$$eval('#log li.entry:not([hidden])', (els) => els.map((e) => e.id));
const clickChip = (page, key, value) => page.click(`.chip[data-key="${key}"][data-value="${value}"]`);

test('sample ledger covers every status and the teaser rides along in archive.json', () => {
  assert.deepEqual(new Set(LEDGER.entries.map((e) => e.status)), new Set(['applied', 'rejected', 'reverted', 'proposed']));
  assert.equal(new Set(LEDGER.entries.map((e) => e.agent)).size, 9);
  assert.equal(SAMPLE.kaizen.count, LEDGER.entries.filter((e) => e.status === 'applied').length);
  assert.ok(SAMPLE.kaizen.latest.title);
});

test('the gallery links to the diary and shows the latest kaizen as a one-line teaser', async (t) => {
  if (!gate(t)) return;
  resetRoutes();
  const { page, problems } = await open(t, { width: 1280, height: 800 });
  assert.equal(await page.locator('a#diary-link').getAttribute('href'), 'kaizen/');
  assert.equal(await page.locator('footer a[href="kaizen/"]').count(), 1);
  const teaser = page.locator('#kaizen-teaser');
  assert.ok(await teaser.isVisible());
  const text = await teaser.textContent();
  assert.ok(text.includes(SAMPLE.kaizen.latest.title), text);
  assert.ok(text.includes('Cards'), 'agent id is shown as a name');
  assert.match(text, new RegExp(`${SAMPLE.kaizen.count} kaizens`));
  assert.equal(await teaser.locator('a').getAttribute('href'), 'kaizen/');
  const box = await teaser.boundingBox();
  assert.ok(box.height < 60, `teaser stays one line on desktop (${box.height}px)`);
  assert.ok((await overflow(page)) <= 0);
  assert.deepEqual(problems.errors, []);
  const mobile = await open(t, { width: 360, height: 740 });
  assert.ok(await mobile.page.locator('#kaizen-teaser').isVisible());
  assert.ok((await overflow(mobile.page)) <= 0);
  await shot(mobile.page, 'gallery-teaser-mobile');
});

test('older archives without a kaizen field, or with a junk one, show no teaser', async (t) => {
  if (!gate(t)) return;
  for (const kaizen of [undefined, null, 'x', { latest: 'x' }, { latest: { date: 'nope', agent: 'a', title: 't' }, count: 3 }, { latest: { date: '2026-10-10', agent: '', title: 't' } }]) {
    const archive = structuredClone(SAMPLE);
    if (kaizen === undefined) delete archive.kaizen;
    else archive.kaizen = kaizen;
    resetRoutes(archive);
    const { page, problems } = await open(t);
    assert.equal(await page.locator('#kaizen-teaser').isVisible(), false, JSON.stringify(kaizen));
    assert.equal(await page.locator('#grid .card').count(), SAMPLE.days.length);
    assert.deepEqual(problems.errors, []);
  }
  const hostile = structuredClone(SAMPLE);
  hostile.kaizen = { latest: { date: '2026-10-10', agent: 'x<img src=x onerror=window.__pwned=1>', title: '<script>window.__pwned=1</script>' }, count: 'many' };
  resetRoutes(hostile);
  const { page } = await open(t);
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.match(await page.locator('#kaizen-teaser').textContent(), /<script>window/, 'shown as text');
  resetRoutes();
});

for (const cfg of [
  { name: 'desktop-light', width: 1280, height: 800, scheme: 'light' },
  { name: 'desktop-dark', width: 1280, height: 800, scheme: 'dark' },
  { name: 'mobile-light', width: 390, height: 844, scheme: 'light' },
  { name: 'mobile-dark', width: 390, height: 844, scheme: 'dark' },
]) {
  test(`diary renders cleanly: ${cfg.name}`, async (t) => {
    if (!gate(t)) return;
    resetRoutes();
    const { page, problems } = await open(t, { ...cfg, url: '/kaizen/' });
    await shot(page, `diary-${cfg.name}`);
    assert.deepEqual(problems.errors, [], 'no console or page errors');
    assert.deepEqual(problems.external, [], 'no non-local requests');
    assert.equal(await page.locator('#log li.entry').count(), ENTRY_COUNT);
    assert.equal(await page.locator('#proposals li.proposal').count(), PROPOSAL_COUNT);
    assert.equal(await page.locator('main').count(), 1);
    assert.equal(await page.locator('header[role=banner], footer[role=contentinfo], nav[aria-label]').count(), 3);
    assert.equal(await page.locator('h1').count(), 1);
    assert.ok((await overflow(page)) <= 0, 'no horizontal overflow');
    assert.equal(await page.locator('a[href="../"]').first().isVisible(), true, 'a way back to the gallery');
  });
}

test('the diary does not overflow at 360px and 320px, even with long unbroken text', async (t) => {
  if (!gate(t)) return;
  const ledger = structuredClone(LEDGER);
  ledger.entries[0].title = 'Supercalifragilisticexpialidocious'.repeat(4);
  ledger.entries[0].observation = 'o'.repeat(300);
  ledger.entries[0].files = ['ops/' + 'very-long-directory-name/'.repeat(6) + 'file.md'];
  resetRoutes(SAMPLE, { '/kaizen/': { type: 'text/html; charset=utf-8', body: renderKaizen(TEMPLATE_KAIZEN, SAMPLE, ledger) } });
  for (const width of [360, 320]) {
    const { page } = await open(t, { width, height: 740, url: '/kaizen/' });
    assert.ok((await overflow(page)) <= 0, `overflow at ${width}px`);
  }
  resetRoutes();
});

test('diary filters by member, category and status, and mirrors them in the URL hash', async (t) => {
  if (!gate(t)) return;
  resetRoutes();
  const { page, problems } = await open(t, { url: '/kaizen/' });
  const all = await visibleEntries(page);
  assert.equal(all.length, ENTRY_COUNT);
  assert.match(await page.textContent('#result-count'), new RegExp(`^${ENTRY_COUNT} entries`));

  await clickChip(page, 'agent', 'architect');
  const architect = LEDGER.entries.filter((e) => e.agent === 'architect' && e.status !== 'proposed').map((e) => `e-${e.id}`);
  assert.deepEqual((await visibleEntries(page)).sort(), architect.sort());
  assert.match(await page.textContent('#result-count'), new RegExp(`Showing ${architect.length} of ${ENTRY_COUNT}`));
  assert.equal(await page.getAttribute('.chip[data-key="agent"][data-value="architect"]', 'aria-pressed'), 'true');
  assert.equal(await page.getAttribute('.chip[data-key="agent"][data-value=""]', 'aria-pressed'), 'false');
  assert.ok(page.url().endsWith('#agent=architect'), page.url());
  assert.ok(await page.locator('#clear-filters').isVisible());
  // days with nothing left are hidden too
  assert.equal(await page.locator('li.day:not([hidden])').count(), new Set(LEDGER.entries.filter((e) => e.agent === 'architect' && e.status !== 'proposed').map((e) => e.date)).size);

  await clickChip(page, 'status', 'rejected');
  assert.deepEqual(await visibleEntries(page), [], 'architect has no rejected entry');
  assert.ok(await page.locator('#no-match').isVisible());
  assert.equal(await page.locator('#log').isVisible(), false);
  await page.click('#no-match-clear');
  assert.equal((await visibleEntries(page)).length, ENTRY_COUNT);
  assert.equal(new URL(page.url()).hash, '');

  await clickChip(page, 'status', 'rejected');
  await clickChip(page, 'category', 'prevention');
  const expected = LEDGER.entries.filter((e) => e.status === 'rejected' && e.category === 'prevention').map((e) => `e-${e.id}`);
  assert.deepEqual((await visibleEntries(page)).sort(), expected.sort());
  assert.ok(page.url().includes('category=prevention') && page.url().includes('status=rejected'));
  await page.click('#clear-filters');
  assert.equal((await visibleEntries(page)).length, ENTRY_COUNT);

  // proposals are a separate section: member and category apply, status never does
  await clickChip(page, 'agent', 'jester');
  assert.equal(await page.locator('#proposals li.proposal:not([hidden])').count(), LEDGER.entries.filter((e) => e.status === 'proposed' && e.agent === 'jester').length);
  assert.equal(await page.locator('#proposals-filtered').isVisible(), false);
  await clickChip(page, 'agent', 'pulse');
  assert.equal(await page.locator('#proposals li.proposal:not([hidden])').count(), 0);
  assert.equal(await page.locator('#proposals-filtered').isVisible(), true);
  await clickChip(page, 'agent', '');
  await clickChip(page, 'status', 'applied');
  assert.equal(await page.locator('#proposals li.proposal:not([hidden])').count(), PROPOSAL_COUNT);
  assert.deepEqual(problems.errors, []);
});

test('diary hash deep links apply, unknown values are ignored, and entry anchors are left alone', async (t) => {
  if (!gate(t)) return;
  resetRoutes();
  const { page } = await open(t, { url: '/kaizen/#agent=lab&category=tests' });
  const expected = LEDGER.entries.filter((e) => e.agent === 'lab' && e.category === 'tests' && e.status !== 'proposed');
  assert.equal((await visibleEntries(page)).length, expected.length);
  assert.equal(await page.getAttribute('.chip[data-key="agent"][data-value="lab"]', 'aria-pressed'), 'true');
  await page.evaluate(() => { location.hash = '#agent=%3Cscript%3E&status=bogus&category=nothing'; });
  await page.waitForFunction((n) => document.querySelectorAll('#log li.entry:not([hidden])').length === n, ENTRY_COUNT);
  await page.evaluate(() => { location.hash = '#e-2026-10-30-lab'; });
  assert.equal((await visibleEntries(page)).length, ENTRY_COUNT, 'an entry anchor is not a filter');
  await page.goto(base.replace(/\/$/, '') + '/kaizen/#e-2026-10-30-lab');
  await page.waitForSelector('html.ready');
  assert.equal((await visibleEntries(page)).length, ENTRY_COUNT);
});

test('diary: theme toggle persists, keyboard reaches the chips with a visible focus ring, links are real', async (t) => {
  if (!gate(t)) return;
  resetRoutes();
  const { page } = await open(t, { url: '/kaizen/', scheme: 'dark' });
  assert.equal(await page.getAttribute('#theme-toggle', 'aria-pressed'), 'true');
  await page.click('#theme-toggle');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  await page.reload();
  await page.waitForSelector('html.ready');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');

  await page.focus('.chip[data-key="agent"][data-value="pulse"]');
  const ring = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return [s.outlineStyle, parseFloat(s.outlineWidth)]; });
  assert.deepEqual(ring, ['solid', 3]);
  await page.keyboard.press('Enter');
  assert.ok((await visibleEntries(page)).length < ENTRY_COUNT);

  const links = await page.$$eval('#log a.entry-link', (as) => as.map((a) => a.href));
  assert.ok(links.length > 5);
  assert.ok(links.every((h) => /^https:\/\/github\.com\/example\/sonnet-every-day\/commit\/[0-9a-f]{40}$/.test(h)), links.join('\n'));
  const proposalLinks = await page.$$eval('#proposals a.entry-link', (as) => as.map((a) => a.href));
  assert.ok(proposalLinks.some((h) => h.includes('/blob/main/ops/kaizen/proposals/')));
  assert.equal(await page.locator('#proposals h2').textContent(), 'Proposals for the owner');
});

test('diary colour tokens used for text meet WCAG AA in both themes', async (t) => {
  if (!gate(t)) return;
  resetRoutes();
  for (const scheme of ['light', 'dark']) {
    const { page } = await open(t, { url: '/kaizen/', scheme });
    const worst = await page.evaluate(() => {
      const lum = (rgb) => {
        const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const parse = (c) => { const m = c.match(/[\d.]+/g).map(Number); return { rgb: m.slice(0, 3), a: m.length > 3 ? m[3] : 1 }; };
      const bgOf = (el) => {
        for (let n = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c.a > 0.5) return c.rgb; }
        return parse(getComputedStyle(document.body).backgroundColor).rgb;
      };
      let min = 21;
      let where = '';
      for (const el of document.querySelectorAll('.entry-obs, .entry-title a, .who-name, .who-role, .entry-meta, .lines, .entry-link, .badge, .files code, .entry-reason, .entry-question, .chip, .stat-value, .stat-sub, .section-intro, .tagline, .d-mon')) {
        if (!el.offsetParent) continue;
        const fg = parse(getComputedStyle(el).color).rgb;
        const bg = bgOf(el);
        const [a, b] = [lum(fg), lum(bg)];
        const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        if (ratio < min) { min = ratio; where = el.className || el.tagName; }
      }
      return { min, where };
    });
    assert.ok(worst.min >= 4.5, `${scheme}: ${worst.where} has contrast ${worst.min.toFixed(2)}`);
  }
});

test('diary without JavaScript is fully readable, and reduced motion switches animation off', async (t) => {
  if (!gate(t)) return;
  resetRoutes();
  const { page, problems } = await open(t, { url: '/kaizen/', js: false });
  assert.equal(await page.locator('#log li.entry').count(), ENTRY_COUNT);
  assert.equal(await page.locator('#log li.entry:visible').count(), ENTRY_COUNT);
  assert.equal(await page.locator('#filters').isVisible(), false, 'filters need JS and are hidden without it');
  assert.ok(await page.locator('#proposals').isVisible());
  assert.ok((await overflow(page)) <= 0);
  assert.deepEqual(problems.errors, []);
  const motion = await open(t, { url: '/kaizen/', reducedMotion: 'reduce' });
  assert.equal(await motion.page.evaluate(() => getComputedStyle(document.querySelector('.seal-text')).animationName), 'none');
});

test('diary day 0: an empty ledger gets a charming empty state, not an empty frame', async (t) => {
  if (!gate(t)) return;
  const body = renderKaizen(TEMPLATE_KAIZEN, SAMPLE, { schema: 1, entries: [] });
  resetRoutes(SAMPLE, { '/kaizen/': { type: 'text/html; charset=utf-8', body } });
  const { page, problems } = await open(t, { url: '/kaizen/' });
  assert.match(await page.textContent('.empty-diary h2'), /first page is still blank/);
  assert.equal(await page.locator('#log-section').isVisible(), false, 'no empty log section');
  assert.equal(await page.locator('.diary-stats').isVisible(), false);
  assert.match(await page.textContent('#proposals'), /No proposals waiting/);
  assert.ok((await overflow(page)) <= 0);
  await shot(page, 'diary-empty-desktop');
  assert.deepEqual(problems.errors, []);
  const mobile = await open(t, { url: '/kaizen/', width: 390, height: 844, scheme: 'dark' });
  assert.ok((await overflow(mobile.page)) <= 0);
  await shot(mobile.page, 'diary-empty-mobile-dark');
  resetRoutes();
});

test('hostile ledger text never becomes markup or runs script in the diary', async (t) => {
  if (!gate(t)) return;
  const evil = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';
  const ledger = {
    schema: 1,
    entries: [
      { id: 'x', date: '2026-10-31', agent: 'pulse', title: evil, observation: evil, category: evil, files: [evil], sha: null, status: 'rejected', linesChanged: 1, question: evil, reason: evil },
      { id: 'y', date: '2026-10-31', agent: 'cards', title: 'javascript:alert(1)', observation: 'ok', category: 'x', files: [], sha: 'zzzz', status: 'proposed', linesChanged: 1, question: null, reason: null },
    ],
  };
  const body = renderKaizen(TEMPLATE_KAIZEN, SAMPLE, ledger);
  resetRoutes(SAMPLE, { '/kaizen/': { type: 'text/html; charset=utf-8', body } });
  const { page, problems } = await open(t, { url: '/kaizen/' });
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.equal(await page.locator('#log img').count(), 0);
  assert.match(await page.locator('#log .entry-title').first().textContent(), /<script>window/);
  assert.deepEqual(problems.errors, []);
  assert.deepEqual(problems.external, []);
  resetRoutes();
});
