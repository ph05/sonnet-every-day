// Tests for scripts/deadman.mjs (CONTRACT 6.1c). Fake clock via --now, SED_ROOT sandboxes, and temp bare remotes for the git path.
import './helpers/env.mjs';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { etIso } from './helpers/env.mjs';
import { localParts } from '../scripts/lib/common.mjs';
import { DATE, REPO_ROOT, makeRepoSandbox, makeSandbox } from './helpers/sandbox.mjs';
import { installPushHook, pushCount, remoteFile, remoteHas, removePushHook } from './helpers/git.mjs';
import { deadman, deadmanThresholds, DEADMAN_GRACE_EXTRA_MINUTES } from '../scripts/deadman.mjs';

const DEADMAN = path.join(REPO_ROOT, 'scripts', 'deadman.mjs');
const iso = (hhmm, date = DATE) => etIso(date, hhmm);

const SITE_TEMPLATES = {
  'site-src/index.template.html': '<!doctype html><html lang="en"><head><title>{{SITE_NAME}}</title></head><body><ul>{{NOSCRIPT_LIST}}</ul><script type="application/json" id="archive">{{ARCHIVE_JSON}}</script></body></html>\n',
  'site-src/404.template.html': '<!doctype html><html lang="en"><head><title>Lost</title></head><body><a href="{{SITE_URL}}">home</a></body></html>\n',
  'site-src/gallery.css': 'body{margin:0}\n',
  'site-src/gallery.js': '"use strict";\n',
};

function ideasFile(date = DATE) {
  const ideas = Array.from({ length: 10 }, (_, i) => ({
    id: `i${String(i + 1).padStart(2, '0')}`,
    title: `Idea number ${i + 1}`,
    pitch: 'A small thing that does one clever trick.',
    fingerprint: { category: 'math-puzzle', mechanic: 'toy', tone: ['playful'], tech: ['svg'], tags: ['one-two', 'three', 'four'], keywords: ['a', 'b', 'c'], slot: 'wildcard' },
    research: { summary: 's', sources: [{ title: 'Src', url: `https://example.org/${i}`, note: 'n', verified: true }], facts: [] },
    scores: { sophistication: 5 + (i % 4), delight: 6, distinctness: 7, feasibility: 8, timeliness: 5, interestFit: 6, polishPotential: 7, safety: 10 },
    total: 54 + i,
  }));
  return { schema: 1, date, ideas, chosenId: 'i05', carryoverOutId: null, rejectedNotes: [], rationale: 'Best of ten.', selectedAt: iso('06:00', date) };
}

function prepare(box, { ideas = false, templates = true } = {}) {
  fs.mkdirSync(box.path('ops'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'ops', 'taxonomy.json'), box.path('ops', 'taxonomy.json'));
  if (templates) for (const [rel, content] of Object.entries(SITE_TEMPLATES)) box.write(rel, content);
  if (ideas) box.write(`state/ideas/${DATE}.json`, ideasFile());
  return box;
}

/** What a primary's `package` leaves behind for a tier-1 day: the project directory and its history entry. */
function publishRealBuild(box, { hhmm = '07:30', date = DATE } = {}) {
  const dir = `docs/d/${date}-real-thing`;
  const fingerprint = { category: 'math-puzzle', mechanic: 'toy', tone: ['playful'], tech: ['svg'], tags: ['a-b', 'c-d', 'e-f'], keywords: ['a', 'b', 'c'], slot: 'wildcard', political: false };
  box.write(`${dir}/index.html`, '<!doctype html><html lang="en"><title>Real</title><body>real</body></html>\n');
  box.write(`${dir}/project.json`, { schema: 1, date, slug: 'real-thing', title: 'Real Thing', tagline: 't', description: 'd', tier: 1, fingerprint, palette: ['#000000', '#111111', '#222222'], entry: 'index.html', thumb: 'thumb.png', network: [], sources: [], makingOf: 'm', stats: { files: 1, bytes: 1, ownLoc: 1 }, credits: 'c' });
  box.write('state/history.json', { schema: 1, startDate: DATE, entries: [{ n: 1, date, slug: 'real-thing', title: 'Real Thing', tagline: 't', tier: 1, fingerprint, path: `d/${date}-real-thing/`, publishedAt: iso(hhmm, date), countsForNovelty: true }] });
}

// deadman.mjs passes its own `noSleep` (false unless --no-sleep is given) to sync(), which then ignores SED_NO_SLEEP, so the flag itself is what
// keeps a refused push from sleeping through the real 2+4+8+16 s backoff (the tests that race a primary used to spend 30 s of wall time in it).
const run = (box, args, env) => box.cli(DEADMAN, args.includes('--no-sleep') ? args : [...args, '--no-sleep'], { SED_NO_SLEEP: '1', ...env });
const history = (box) => box.readJson('state/history.json');

function snapshot(root) {
  const out = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(root, p)] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(root);
  return out;
}

describe('deadman: time gate and no-op cases', () => {
  test('thresholds come from config.schedule: graceUntil + 5 minutes for a dead run, hardStop for any run', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config.json'), 'utf8'));
    assert.equal(DEADMAN_GRACE_EXTRA_MINUTES, 5);
    assert.deepEqual(deadmanThresholds(cfg), { staleAfter: 9 * 60 + 35, hardStop: 10 * 60 + 30 });
    const moved = { ...cfg, schedule: { ...cfg.schedule, graceUntil: '09:00', hardStop: '11:15' } };
    assert.deepEqual(deadmanThresholds(moved), { staleAfter: 9 * 60 + 5, hardStop: 11 * 60 + 15 });
    const squeezed = { ...cfg, schedule: { ...cfg.schedule, graceUntil: '10:28', hardStop: '10:30' } };
    assert.equal(deadmanThresholds(squeezed).staleAfter, 10 * 60 + 30, 'never later than the hard stop');
    const legacy = { ...cfg, schedule: { deadline: '08:00' } };
    assert.deepEqual(deadmanThresholds(legacy), { staleAfter: 8 * 60, hardStop: 8 * 60 });
  });

  test('no run at all (lease absent): nothing happens until 09:35, then it publishes', () => {
    const box = prepare(makeSandbox(), { ideas: true });
    try {
      for (const hhmm of ['04:00', '07:30', '08:00', '09:34']) {
        const before = snapshot(box.root);
        const r = run(box, ['--no-git', '--now', iso(hhmm)]);
        assert.equal(r.code, 0, r.stderr);
        assert.equal(r.json.ok, true);
        assert.equal(r.json.action, 'none', hhmm);
        assert.equal(r.json.reason, 'too-early', hhmm);
        assert.equal(r.json.notBefore, '09:35');
        assert.deepEqual(snapshot(box.root), before, `${hhmm}: nothing was written`);
      }
      const r = run(box, ['--no-git', '--now', iso('09:35')]);
      assert.equal(r.code, 0, r.stderr + r.stdout);
      assert.equal(r.json.action, 'published');
      assert.equal(r.json.tier, 3);
    } finally {
      box.cleanup();
    }
  });

  test('the level it records in the run it creates is the one in force at --now (the owner override is judged at the instant, not at the real clock)', () => {
    // an override that ends between the fixture clock and the real clock: 2026-10-09 23:00 EDT
    const cfg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config.json'), 'utf8'));
    cfg.budget.ownerOverride = { until: '2026-10-09T23:00:00-04:00', level: 'all-in', note: 'test' };
    const throttleOf = (date, hhmm) => {
      const box = prepare(makeSandbox({ config: cfg }), { ideas: true });
      try {
        const r = run(box, ['--no-git', '--date', date, '--now', etIso(date, hhmm)]);
        assert.equal(r.code, 0, r.stderr + r.stdout);
        assert.equal(r.json.action, 'published', r.stdout);
        return box.readJson(`state/runs/${date}.json`).throttle;
      } finally {
        box.cleanup();
      }
    };
    assert.equal(throttleOf(DATE, '09:40'), 'all-in', 'inside the window');
    assert.equal(throttleOf('2026-10-10', '09:40'), 'balanced', 'the next morning the stored level is back');
  });

  test('DST-aware boundary: 09:35 local in EDT (October) and in EST (January)', () => {
    for (const date of [DATE, '2027-01-12']) {
      const box = prepare(makeSandbox(), { ideas: false });
      try {
        const early = run(box, ['--no-git', '--date', date, '--now', etIso(date, '09:34')]);
        assert.equal(early.json.reason, 'too-early', date);
        const r = run(box, ['--no-git', '--date', date, '--now', etIso(date, '09:35')]);
        assert.equal(r.code, 0, r.stderr);
        assert.equal(r.json.action, 'published', date);
      } finally {
        box.cleanup();
      }
    }
  });

  test('the deadman Action wakes inside the grace window and again after the hard stop, in EDT and in EST', () => {
    const yml = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'deadman.yml'), 'utf8');
    const crons = [...yml.matchAll(/^\s*-\s*cron:\s*'(\d+) (\d+) \* \* \*'/gm)].map((m) => `${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}`);
    assert.ok(crons.length >= 2, yml);
    const cfg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config.json'), 'utf8'));
    const { staleAfter, hardStop } = deadmanThresholds(cfg);
    for (const date of ['2026-10-12', '2027-01-12']) {
      const local = crons.map((utc) => localParts(new Date(`${date}T${utc}:00Z`), cfg.timezone).minutes);
      assert.ok(local.some((m) => m >= staleAfter && m < hardStop), `${date}: a run between ${staleAfter} and ${hardStop} minutes (local ${local})`);
      // A lease that still looks alive at the grace run is only overruled after the hard stop: some run must come then.
      assert.ok(local.some((m) => m >= hardStop && m < hardStop + 90), `${date}: a run within 90 minutes after the hard stop (local ${local})`);
    }
  });

  describe('with a live run (the lease decides until the hard stop)', () => {
    /** A primary that began at 03:55, is now in `phase` and last beat at `lastBeat`. */
    function livePrimary(box, { phase = 'qa', phaseStart = '09:00', lastBeat = '09:25' } = {}) {
      const begin = box.state(['begin', '--role', 'primary', '--session', 'sess-p', '--now', iso('03:55')]);
      assert.equal(begin.json.action, 'proceed', begin.stdout);
      const start = box.state(['phase-start', '--phase', phase, '--session', 'sess-p', '--now', iso(phaseStart)]);
      assert.equal(start.code, 0, start.stdout + start.stderr);
      const beat = box.state(['beat', '--role', 'primary', '--session', 'sess-p', '--phase', phase, '--now', iso(lastBeat)]);
      assert.equal(beat.json.leaseHeld, true, beat.stdout);
    }

    test('a fresh lease is left alone through 10:29 and force-resolved at exactly 10:30', () => {
      const box = prepare(makeSandbox(), { ideas: true });
      try {
        livePrimary(box, { lastBeat: '10:20' });
        for (const hhmm of ['09:34', '09:35', '09:59', '10:29']) {
          const before = snapshot(box.root);
          const r = run(box, ['--no-git', '--now', iso(hhmm)]);
          assert.equal(r.code, 0, r.stderr);
          assert.equal(r.json.action, 'none', hhmm);
          assert.equal(r.json.reason, hhmm === '09:34' ? 'too-early' : 'lease-alive', hhmm);
          if (hhmm !== '09:34') {
            assert.equal(r.json.notBefore, '10:30');
            assert.equal(r.json.lease.alive, true);
            assert.equal(r.json.lease.holder, 'primary');
          }
          assert.deepEqual(snapshot(box.root), before, `${hhmm}: a healthy run is not touched`);
        }
        // the lease stays fresh at 10:30 (last beat 10:20) but the hard stop overrides health
        const r = run(box, ['--no-git', '--now', iso('10:30')]);
        assert.equal(r.code, 0, r.stderr + r.stdout);
        assert.equal(r.json.action, 'published');
        assert.equal(r.json.tier, 3);
        assert.equal(r.json.runAction, 'force-degrade');
        const state = box.run();
        assert.equal(state.status, 'published');
        assert.ok(state.directives.some((d) => d.kind === 'ship-now'), 'the live primary is told to stop');
      } finally {
        box.cleanup();
      }
    });

    test('a stale lease is taken over at 09:35, not before', () => {
      const box = prepare(makeSandbox(), { ideas: true });
      try {
        livePrimary(box, { lastBeat: '08:50' }); // 45 minutes of silence at 09:35, limit 35
        const early = run(box, ['--no-git', '--now', iso('09:34')]);
        assert.equal(early.json.action, 'none');
        assert.equal(early.json.reason, 'too-early');
        const r = run(box, ['--no-git', '--now', iso('09:35')]);
        assert.equal(r.code, 0, r.stderr + r.stdout);
        assert.equal(r.json.action, 'published');
        assert.equal(r.json.runAction, 'takeover');
        assert.equal(box.run().status, 'published');
      } finally {
        box.cleanup();
      }
    });

    test('a lease that is just inside the stale limit still protects the run', () => {
      const box = prepare(makeSandbox(), { ideas: true });
      try {
        livePrimary(box, { lastBeat: '09:01' }); // 34 minutes at 09:35
        const r = run(box, ['--no-git', '--now', iso('09:35')]);
        assert.equal(r.json.action, 'none');
        assert.equal(r.json.reason, 'lease-alive');
        // one minute later the silence is 35 minutes: still not stale (> limit), two minutes later it is
        assert.equal(run(box, ['--no-git', '--now', iso('09:36')]).json.reason, 'lease-alive');
        assert.equal(run(box, ['--no-git', '--now', iso('09:37')]).json.action, 'published');
      } finally {
        box.cleanup();
      }
    });

    test('the session\'s heartbeat file counts as a sign of life', () => {
      const box = prepare(makeSandbox(), { ideas: true });
      try {
        livePrimary(box, { lastBeat: '08:50' });
        box.write(`state/heartbeats/${DATE}/sess-p.json`, { holder: 'primary', session: 'sess-p', phase: 'qa', at: iso('09:30'), note: '' });
        const r = run(box, ['--no-git', '--now', iso('09:40')]);
        assert.equal(r.json.reason, 'lease-alive', r.stdout);
        assert.equal(r.json.lease.alive, true);
      } finally {
        box.cleanup();
      }
    });

    test('a run that already failed is dead whatever its lease says', () => {
      const box = prepare(makeSandbox(), { ideas: true });
      try {
        livePrimary(box, { lastBeat: '09:30' });
        box.state(['fail', '--reason', 'boom', '--session', 'sess-p', '--now', iso('09:31')]);
        const r = run(box, ['--no-git', '--now', iso('09:35')]);
        assert.equal(r.json.action, 'published');
        assert.equal(box.run().status, 'published');
      } finally {
        box.cleanup();
      }
    });

    test('--force bypasses the lease and the clock; --dry-run reports without writing', () => {
      const box = prepare(makeSandbox(), { ideas: true });
      try {
        livePrimary(box, { lastBeat: '09:30' });
        const before = snapshot(box.root);
        const dry = run(box, ['--dry-run', '--no-git', '--now', iso('09:40')]);
        assert.equal(dry.json.action, 'none');
        assert.equal(dry.json.reason, 'lease-alive');
        const dryForced = run(box, ['--dry-run', '--force', '--no-git', '--now', iso('09:40')]);
        assert.equal(dryForced.json.action, 'dry-run');
        assert.deepEqual(snapshot(box.root), before);
        const forced = run(box, ['--force', '--no-git', '--now', iso('09:40')]);
        assert.equal(forced.json.action, 'published');
        assert.equal(forced.json.forced, true);
      } finally {
        box.cleanup();
      }
    });
  });

  test('a day that is already in history is left alone, at any tier', () => {
    for (const tier of [1, 2, 3, 4]) {
      const box = prepare(makeSandbox(), { ideas: true });
      try {
        box.write('state/history.json', { schema: 1, startDate: DATE, entries: [{ n: 1, date: DATE, slug: 'thing', title: 'T', tagline: 't', tier, fingerprint: {}, path: `d/${DATE}-thing/`, publishedAt: iso('04:30'), countsForNovelty: tier < 3 }] });
        box.write(`docs/d/${DATE}-thing/index.html`, 'original');
        const before = snapshot(box.root);
        const r = run(box, ['--no-git', '--now', iso('09:45')]);
        assert.equal(r.code, 0);
        assert.equal(r.json.action, 'none');
        assert.equal(r.json.reason, 'already-published');
        assert.equal(r.json.tier, tier);
        assert.deepEqual(snapshot(box.root), before);
      } finally {
        box.cleanup();
      }
    }
  });

  test('a run file marked published counts even if history lags, and --force does not override it', () => {
    const box = prepare(makeSandbox(), { ideas: true });
    try {
      box.write(`state/runs/${DATE}.json`, { schema: 1, date: DATE, status: 'published', targetTier: 1, tier: 1, phase: 'done', phasesDone: [], events: [] });
      box.write(`docs/d/${DATE}-real-thing/index.html`, '<html></html>'); // the page is there, only history lags
      const before = snapshot(box.root);
      const r = run(box, ['--no-git', '--force', '--now', iso('05:00')]);
      assert.equal(r.json.action, 'none');
      assert.equal(r.json.reason, 'already-published');
      assert.equal(r.json.tier, 1);
      assert.deepEqual(snapshot(box.root), before);
    } finally {
      box.cleanup();
    }
  });
});

describe('deadman: publishing', () => {
  test('with ideas it publishes Tier 3, rebuilds the site, marks the run published, and writes a notice', () => {
    const box = prepare(makeSandbox(), { ideas: true });
    try {
      const r = run(box, ['--no-git', '--now', iso('09:40')]);
      assert.equal(r.code, 0, r.stderr + r.stdout);
      assert.equal(r.json.ok, true);
      assert.equal(r.json.action, 'published');
      assert.equal(r.json.tier, 3);
      assert.equal(r.json.slug, 'ideas-day');
      assert.equal(r.json.siteBuilt, true);
      assert.equal(r.json.url, `${box.readJson('config.json').siteUrl}d/${DATE}-ideas-day/`);

      assert.ok(box.exists(`docs/d/${DATE}-ideas-day/index.html`));
      const h = history(box);
      assert.equal(h.entries.length, 1);
      assert.equal(h.entries[0].tier, 3);
      assert.equal(h.entries[0].countsForNovelty, false);

      const archive = box.readJson('docs/archive.json');
      assert.deepEqual(archive.days.map((d) => d.date), [DATE]);
      assert.equal(archive.days[0].tier, 3);
      assert.ok(box.exists('docs/index.html'));

      const run1 = box.run();
      assert.equal(run1.status, 'published');
      assert.equal(run1.tier, 3);
      assert.equal(run1.publishedUrl, r.json.url);
      assert.ok(run1.publishedAt);
      assert.ok(run1.events.some((e) => e.by === 'deadman' && /published tier 3/.test(e.msg)));
      assert.ok(run1.events.some((e) => e.kind === 'degrade'));

      const notice = box.readJson(`work/${DATE}/fallback-notice.json`);
      assert.match(notice.reasons.at(-1).reason, /deadman published tier 3/);
      assert.equal(notice.published.tier, 3);
    } finally {
      box.cleanup();
    }
  });

  test('without ideas it publishes the Postcard (Tier 4)', () => {
    const box = prepare(makeSandbox(), { ideas: false });
    try {
      const r = run(box, ['--no-git', '--now', iso('09:35')]);
      assert.equal(r.code, 0, r.stderr + r.stdout);
      assert.equal(r.json.tier, 4);
      assert.equal(r.json.slug, 'postcard');
      assert.equal(box.run().tier, 4);
      assert.equal(history(box).entries[0].tier, 4);
      assert.ok(box.exists(`docs/d/${DATE}-postcard/thumb.png`));
    } finally {
      box.cleanup();
    }
  });

  test('uses work/<D>/ideas/shortlist.json when the final ideas file is missing', () => {
    const box = prepare(makeSandbox(), { ideas: false });
    try {
      box.write(`work/${DATE}/ideas/shortlist.json`, { ideas: ideasFile().ideas });
      const r = run(box, ['--no-git', '--now', iso('09:45')]);
      assert.equal(r.json.tier, 3);
    } finally {
      box.cleanup();
    }
  });

  test('an unusable ideas file degrades to the Postcard with a warning instead of failing the day', () => {
    const box = prepare(makeSandbox(), { ideas: false });
    try {
      box.write(`state/ideas/${DATE}.json`, '{ truncated');
      const r = run(box, ['--no-git', '--now', iso('09:45')]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.json.tier, 4);

      const other = prepare(makeSandbox(), { ideas: false });
      try {
        other.write(`state/ideas/${DATE}.json`, { ideas: [{ pitch: 'no titles anywhere' }] });
        const o = run(other, ['--no-git', '--now', iso('09:45')]);
        assert.equal(o.json.tier, 4);
        assert.equal(o.json.action, 'published');
      } finally {
        other.cleanup();
      }
    } finally {
      box.cleanup();
    }
  });

  test('is idempotent: a second run changes nothing', () => {
    const box = prepare(makeSandbox(), { ideas: true });
    try {
      assert.equal(run(box, ['--no-git', '--now', iso('09:40')]).json.action, 'published');
      const before = snapshot(box.root);
      const again = run(box, ['--no-git', '--now', iso('09:55')]);
      assert.equal(again.code, 0);
      assert.equal(again.json.action, 'none');
      assert.equal(again.json.reason, 'already-published');
      assert.equal(again.json.tier, 3);
      assert.deepEqual(snapshot(box.root), before);
    } finally {
      box.cleanup();
    }
  });

  test('--force publishes before the thresholds; --dry-run reports the plan and writes nothing', () => {
    const box = prepare(makeSandbox(), { ideas: true });
    try {
      const before = snapshot(box.root);
      const dry = run(box, ['--dry-run', '--no-git', '--now', iso('09:45')]);
      assert.equal(dry.code, 0);
      assert.equal(dry.json.action, 'dry-run');
      assert.deepEqual(dry.json.wouldPublish, { tier: 3, slug: 'ideas-day', path: `docs/d/${DATE}-ideas-day/` });
      assert.deepEqual(snapshot(box.root), before);

      const dryEarly = run(box, ['--dry-run', '--force', '--no-git', '--now', iso('05:00')]);
      assert.equal(dryEarly.json.action, 'dry-run');
      assert.equal(dryEarly.json.forced, true);
      assert.deepEqual(snapshot(box.root), before);

      const noForce = run(box, ['--no-git', '--now', iso('05:00')]);
      assert.equal(noForce.json.reason, 'too-early');
      const forced = run(box, ['--force', '--no-git', '--now', iso('05:00')]);
      assert.equal(forced.code, 0, forced.stderr);
      assert.equal(forced.json.action, 'published');
      assert.equal(forced.json.forced, true);
      assert.equal(box.run().status, 'published');
    } finally {
      box.cleanup();
    }
  });

  test('--date for a past day is eligible whatever the clock says', () => {
    const box = prepare(makeSandbox(), { ideas: false });
    try {
      const r = run(box, ['--no-git', '--date', DATE, '--now', iso('01:00', '2026-10-10')]);
      assert.equal(r.json.action, 'published');
      assert.equal(r.json.date, DATE);
      const future = run(box, ['--no-git', '--date', '2026-10-12', '--now', iso('09:00', '2026-10-10')]);
      assert.equal(future.json.reason, 'too-early');
    } finally {
      box.cleanup();
    }
  });

  test('--force takes the lease from a primary that is still "alive" and leaves a ship-now directive', () => {
    const box = prepare(makeSandbox(), { ideas: true });
    try {
      const begin = box.state(['begin', '--role', 'primary', '--session', 'sess-p', '--now', iso('03:55')]);
      assert.equal(begin.json.action, 'proceed');
      box.state(['phase-start', '--phase', 'qa', '--session', 'sess-p', '--now', iso('09:00')]);
      box.state(['beat', '--role', 'primary', '--session', 'sess-p', '--phase', 'qa', '--now', iso('09:29')]);
      const r = run(box, ['--force', '--no-git', '--now', iso('09:31')]);
      assert.equal(r.code, 0, r.stderr + r.stdout);
      assert.equal(r.json.action, 'published');
      assert.equal(r.json.runAction, 'force-degrade');
      const state = box.run();
      assert.equal(state.status, 'published');
      assert.equal(state.tier, 3);
      assert.equal(state.lease.holder, 'closer');
      assert.ok(state.directives.some((d) => d.kind === 'ship-now'));
      // the primary finds out on its next beat
      const beat = box.state(['beat', '--role', 'primary', '--session', 'sess-p', '--phase', 'qa', '--now', iso('09:35')]);
      assert.equal(beat.json.leaseHeld, false);
    } finally {
      box.cleanup();
    }
  });

  test('a late primary can still upgrade the published fallback', () => {
    const box = prepare(makeSandbox(), { ideas: false });
    try {
      assert.equal(run(box, ['--no-git', '--now', iso('09:40')]).json.tier, 4);
      // the late primary packages its real build (page + history entry) before it can finish at tier 1
      publishRealBuild(box, { hhmm: '08:19' });
      const up = box.state(['finish', '--status', 'published', '--tier', '1', '--url', 'https://example.test/', '--now', iso('08:20')]);
      assert.equal(up.json.ok, true, up.stdout);
      assert.equal(up.json.action, 'upgraded');
      assert.equal(box.run().tier, 1);
      // and the deadman never fights it
      assert.equal(run(box, ['--no-git', '--now', iso('09:00')]).json.action, 'none');
    } finally {
      box.cleanup();
    }
  });

  test('without site templates the page is still published and the problem is reported, not fatal', () => {
    const box = prepare(makeSandbox(), { ideas: true, templates: false });
    try {
      const r = run(box, ['--no-git', '--now', iso('09:40')]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.json.action, 'published');
      assert.equal(r.json.siteBuilt, false);
      assert.ok(r.json.warnings.some((w) => /build-site failed/.test(w)));
      assert.equal(box.run().status, 'published');
      assert.ok(box.exists(`docs/d/${DATE}-ideas-day/index.html`));
    } finally {
      box.cleanup();
    }
  });

  test('works with no run file, a corrupt run file, and a failed run', () => {
    const corrupt = prepare(makeSandbox(), { ideas: false });
    try {
      corrupt.write(`state/runs/${DATE}.json`, '{"half": ');
      const r = run(corrupt, ['--no-git', '--now', iso('09:40')]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.json.action, 'published');
      assert.equal(corrupt.run().status, 'published');
      assert.ok(fs.readdirSync(corrupt.path('state', 'runs')).some((f) => f.includes('corrupt')), 'the bad file was preserved');
    } finally {
      corrupt.cleanup();
    }
    const failed = prepare(makeSandbox(), { ideas: true });
    try {
      failed.state(['begin', '--role', 'primary', '--session', 's1', '--now', iso('03:55')]);
      failed.state(['fail', '--reason', 'boom', '--session', 's1', '--now', iso('05:00')]);
      const r = run(failed, ['--no-git', '--now', iso('09:40')]);
      assert.equal(r.json.action, 'published');
      assert.equal(failed.run().status, 'published');
    } finally {
      failed.cleanup();
    }
  });

  test('a corrupt state/history.json is repaired, not fatal: the model-free net still publishes', () => {
    const marker = '<<<<<<< HEAD\n{"schema":1,"entries":[]}\n=======\n>>>>>>> origin\n';
    const box = prepare(makeSandbox(), { ideas: true });
    try {
      box.write('state/history.json', marker);
      const dry = run(box, ['--dry-run', '--force', '--no-git', '--now', iso('09:45')]);
      assert.equal(dry.code, 0, dry.stderr);
      assert.ok(dry.json.warnings.some((w) => /history\.json is unreadable/.test(w)));
      assert.equal(box.read('state/history.json'), marker, 'a dry run never repairs');

      const r = run(box, ['--force', '--no-git', '--now', iso('09:45')]);
      assert.equal(r.code, 0, r.stderr + r.stdout);
      assert.equal(r.json.action, 'published');
      assert.equal(r.json.tier, 3);
      assert.ok(r.json.warnings.some((w) => /history\.json was unreadable/.test(w)));
      assert.equal(box.read('state/history.json.corrupt-1'), marker);
      assert.deepEqual(history(box).entries.map((e) => [e.date, e.tier]), [[DATE, 3]]);
      assert.equal(run(box, ['--no-git', '--now', iso('09:55')]).json.action, 'none');
    } finally {
      box.cleanup();
    }
  });

  test('bad arguments exit 2', () => {
    const box = prepare(makeSandbox());
    try {
      assert.equal(run(box, ['--now', 'garbage']).code, 2);
      assert.equal(run(box, ['--date', 'soon']).code, 2);
    } finally {
      box.cleanup();
    }
  });

  test('is importable and callable as a function', async () => {
    const box = prepare(makeSandbox(), { ideas: false });
    const prior = process.env.SED_ROOT;
    process.env.SED_ROOT = box.root;
    try {
      const early = await deadman({ now: new Date(iso('09:00')), git: false });
      assert.equal(early.reason, 'too-early');
      const r = await deadman({ now: new Date(iso('09:40')), git: false });
      assert.equal(r.action, 'published');
      assert.equal((await deadman({ now: new Date(iso('09:41')), git: false })).action, 'none');
    } finally {
      if (prior === undefined) delete process.env.SED_ROOT;
      else process.env.SED_ROOT = prior;
      box.cleanup();
    }
  });
});

describe('deadman: git', () => {
  test('commits and pushes the page, history, run file and site to the work branch', () => {
    const box = prepare(makeRepoSandbox(), { ideas: true });
    try {
      const r = run(box, ['--now', iso('09:40'), '--no-sleep']);
      assert.equal(r.code, 0, r.stderr + r.stdout);
      assert.equal(r.json.action, 'published');
      assert.equal(r.json.sync.ok, true);
      assert.equal(r.json.sync.pushed, true);
      const remoteHistory = JSON.parse(remoteFile(box.remote, 'state/history.json'));
      assert.equal(remoteHistory.entries[0].tier, 3);
      assert.match(remoteFile(box.remote, `docs/d/${DATE}-ideas-day/project.json`), /"tier": 3/);
      assert.match(remoteFile(box.remote, `state/runs/${DATE}.json`), /"status": "published"/);
      assert.ok(remoteFile(box.remote, 'docs/archive.json').includes(DATE));
      assert.equal(box.git('status', '--porcelain', '--', 'state', 'docs', 'work'), '');
    } finally {
      box.cleanup();
    }
  });

  test('a refused push is reported as a failure; rerunning later pushes the pending publication', () => {
    const box = prepare(makeRepoSandbox(), { ideas: false });
    try {
      installPushHook(box.remote, { always: true });
      const bad = run(box, ['--now', iso('09:40'), '--no-sleep']);
      assert.equal(bad.code, 1);
      assert.equal(bad.json.ok, false);
      assert.equal(bad.json.action, 'published');
      assert.equal(bad.json.sync.pushed, false);
      assert.match(bad.json.error, /could not be pushed/);
      assert.ok(pushCount(box.remote) >= 2, 'the push was retried');
      assert.equal(box.exists(`docs/d/${DATE}-postcard/index.html`), true, 'the page is still there locally');

      removePushHook(box.remote);
      const again = run(box, ['--now', iso('09:45'), '--no-sleep']);
      assert.equal(again.code, 0, again.stderr + again.stdout);
      assert.equal(again.json.action, 'none');
      assert.equal(again.json.reason, 'already-published');
      assert.equal(again.json.recovered.pushed, true);
      assert.match(remoteFile(box.remote, `docs/d/${DATE}-postcard/project.json`), /"tier": 4/);

      const third = run(box, ['--now', iso('09:55'), '--no-sleep']);
      assert.equal(third.json.action, 'none');
      assert.equal(third.json.recovered, undefined, 'nothing pending any more');
    } finally {
      box.cleanup();
    }
  });

  describe('racing a live primary', () => {
    const closerBegin = (box, hhmm) => box.state(['begin', '--role', 'closer', '--session', 'closer-1', '--now', iso(hhmm)]);

    /** The closer's checkout pulled before the primary's last checkpoint, then ran `begin` (dirtying the run file). */
    function racedCloser({ ideas = false } = {}) {
      const box = prepare(makeRepoSandbox(), { ideas });
      const primary = box.cloneB('primary');
      primary.state(['begin', '--role', 'primary', '--session', 'p-1', '--now', iso('03:55')]);
      primary.state(['phase-start', '--phase', 'qa', '--session', 'p-1', '--now', iso('09:00')]);
      primary.state(['beat', '--role', 'primary', '--session', 'p-1', '--phase', 'qa', '--now', iso('09:20')]);
      primary.state(['sync', '-m', 'primary checkpoint 1', '--no-sleep']);
      box.git('pull', '-q', '--rebase', 'origin', 'claude/sonnet-every-day');
      primary.state(['beat', '--role', 'primary', '--session', 'p-1', '--phase', 'qa', '--note', 'still going', '--now', iso('09:28')]);
      const pushed = primary.state(['sync', '-m', 'primary checkpoint 2', '--no-sleep']);
      assert.equal(pushed.json.pushed, true, pushed.stdout);
      const begin = closerBegin(box, '09:40');
      assert.equal(begin.json.action, 'force-degrade', begin.stdout);
      return { box, primary };
    }

    test('a closer whose checkout is behind the primary refreshes, publishes the fallback and pushes it', () => {
      const { box } = racedCloser();
      try {
        const r = run(box, ['--force', '--now', iso('09:40')]);
        assert.equal(r.code, 0, r.stderr + r.stdout);
        assert.equal(r.json.action, 'published');
        assert.equal(r.json.sync.pushed, true);
        assert.ok(r.json.refreshed, 'the checkout was refreshed from the remote first');
        const remoteRun = JSON.parse(remoteFile(box.remote, `state/runs/${DATE}.json`));
        assert.equal(remoteRun.status, 'published');
        assert.equal(remoteRun.tier, 4);
        assert.equal(remoteRun.lease.holder, 'closer');
        assert.ok(remoteRun.directives.some((d) => d.kind === 'ship-now'), 'the live primary is told to stop');
        assert.match(remoteFile(box.remote, `docs/d/${DATE}-postcard/project.json`), /"tier": 4/);
        assert.equal(box.git('status', '--porcelain', '--', 'state', 'docs', 'work'), '');
      } finally {
        box.cleanup();
      }
    });

    test('when the primary pushes between the closer\'s generation and its push, the fallback is regenerated on the new tip', () => {
      const { box, primary } = racedCloser();
      try {
        // The primary lands another checkpoint just before the closer's first push attempt (pre-receive "race lost").
        installPushHook(box.remote, { sneakFirst: true });
        const r = run(box, ['--force', '--now', iso('09:40')]);
        removePushHook(box.remote);
        assert.equal(r.code, 0, r.stderr + r.stdout);
        assert.equal(r.json.action, 'published');
        assert.equal(r.json.sync.pushed, true);
        assert.equal(remoteFile(box.remote, 'sneaky.txt'), 'sneaky', 'the competing commit is kept');
        assert.match(remoteFile(box.remote, `docs/d/${DATE}-postcard/project.json`), /"tier": 4/);
        assert.equal(primary.git('rev-parse', 'HEAD') !== box.git('rev-parse', 'HEAD'), true);
      } finally {
        box.cleanup();
      }
    });

    test('a push that loses the race on a shared file is retried on the new tip, not reported as stuck', () => {
      const { box } = racedCloser();
      try {
        // Pre-receive hook: on the first push a competing commit lands on history.json (the very lines the closer's
        // commit changes, so the rebase genuinely conflicts), then the push is rejected.
        const hook = path.join(box.remote, 'hooks', 'pre-receive');
        fs.writeFileSync(hook, `#!/bin/sh
COUNT_FILE="$GIT_DIR/push-count"
n=$(cat "$COUNT_FILE" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$COUNT_FILE"
if [ "$n" -eq 1 ]; then
  unset GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
  B=refs/heads/claude/sonnet-every-day
  blob=$(git show $B:state/history.json | sed 's/"entries": \\[\\]/"entries": [], "sneaky": true/' | git hash-object -w --stdin)
  export GIT_INDEX_FILE="$GIT_DIR/sneak-index"
  git read-tree $B
  git update-index --cacheinfo 100644,$blob,state/history.json
  tree=$(git write-tree)
  new=$(GIT_AUTHOR_NAME=x GIT_AUTHOR_EMAIL=x@x.invalid GIT_COMMITTER_NAME=x GIT_COMMITTER_EMAIL=x@x.invalid git commit-tree "$tree" -p "$(git rev-parse $B)" -m sneaky)
  git update-ref $B "$new"
  echo "rejected by test hook (race lost on history.json)" >&2
  exit 1
fi
exit 0
`, { mode: 0o755 });
        const r = run(box, ['--force', '--now', iso('09:40')]);
        removePushHook(box.remote);
        assert.equal(r.code, 0, r.stderr + r.stdout);
        assert.equal(r.json.sync.pushed, true, r.stdout);
        // sync now merges a concurrent edit of history.json itself, so no regeneration round is needed any more
        assert.ok(!r.json.warnings.some((w) => /round 1/.test(w)), `no retry round: ${r.stdout}`);
        const remoteHistory = JSON.parse(remoteFile(box.remote, 'state/history.json'));
        assert.equal(remoteHistory.sneaky, true, 'the competing commit is the base of the regenerated history');
        assert.deepEqual(remoteHistory.entries.map((e) => [e.date, e.tier]), [[DATE, 4]]);
        const remoteRun = JSON.parse(remoteFile(box.remote, `state/runs/${DATE}.json`));
        assert.equal(remoteRun.status, 'published');
        assert.equal(remoteRun.lease.holder, 'closer');
        assert.match(remoteFile(box.remote, `docs/d/${DATE}-postcard/project.json`), /"tier": 4/);
      } finally {
        box.cleanup();
      }
    });

    test('a plain sync after the primary published for real meanwhile merges the days and drops the closer\'s own fallback', () => {
      const { box, primary } = racedCloser();
      try {
        // First run: the remote refuses, so the fallback commit stays local and unpushed.
        installPushHook(box.remote, { always: true });
        const bad = run(box, ['--force', '--now', iso('09:40')]);
        removePushHook(box.remote);
        assert.equal(bad.json.ok, false);
        assert.equal(box.exists(`docs/d/${DATE}-postcard/index.html`), true);
        // Meanwhile the primary publishes its real build: both sides now added a history entry for the same date.
        publishRealBuild(primary, { hhmm: '07:31' });
        assert.equal(primary.state(['sync', '-m', 'primary publishes', '--no-sleep']).json.pushed, true);
        // sync merges history.json and the run file itself (the better tier wins) and drops the replaced fallback page
        const manual = box.state(['sync', '-m', 'closer retry', '--no-sleep']);
        assert.equal(manual.json.ok, true, manual.stdout);
        assert.equal(manual.json.pushed, true);
        assert.equal(box.exists(`docs/d/${DATE}-postcard`), false, 'the closer\'s page is gone, the real build stays');
        assert.deepEqual(JSON.parse(remoteFile(box.remote, 'state/history.json')).entries.map((e) => e.tier), [1]);

        const r = run(box, ['--force', '--now', iso('09:41')]);
        assert.equal(r.code, 0, r.stderr + r.stdout);
        assert.equal(r.json.action, 'none');
        assert.equal(r.json.reason, 'already-published');
        assert.equal(r.json.tier, 1);
        assert.equal(box.git('status', '--porcelain', '--', 'state', 'docs', 'work'), '');
      } finally {
        box.cleanup();
      }
    });

    test('a real build that won the race is respected: nothing is overwritten and nothing is lost', () => {
      const { box, primary } = racedCloser();
      try {
        publishRealBuild(primary, { hhmm: '07:30' });
        assert.equal(primary.state(['sync', '-m', 'primary publishes', '--no-sleep']).json.pushed, true);
        const r = run(box, ['--force', '--now', iso('09:40')]);
        assert.equal(r.code, 0, r.stderr + r.stdout);
        assert.equal(r.json.action, 'none');
        assert.equal(r.json.reason, 'already-published');
        assert.equal(r.json.tier, 1);
        assert.equal(box.exists(`docs/d/${DATE}-postcard`), false);
        assert.equal(box.exists(`docs/d/${DATE}-real-thing/index.html`), true);
      } finally {
        box.cleanup();
      }
    });

    test('a clone whose origin/HEAD names the work branch still reads the remote first: no fallback over a day the remote published', () => {
      const { box, primary } = racedCloser();
      try {
        publishRealBuild(primary, { hhmm: '07:30' });
        assert.equal(primary.state(['sync', '-m', 'primary publishes', '--no-sleep']).json.pushed, true);
        // The remote's default branch is the work branch (an owner switched it, or the clone predates main):
        // sync refuses every push from here, but reading the remote is still fine and decides the day.
        box.git('remote', 'set-head', 'origin', 'claude/sonnet-every-day');
        const r = run(box, ['--force', '--now', iso('09:40')]);
        assert.equal(r.json.action, 'none', r.stderr + r.stdout);
        assert.equal(r.json.reason, 'already-published');
        assert.equal(r.json.tier, 1);
        assert.equal(box.exists(`docs/d/${DATE}-postcard`), false, 'no fallback was generated over the real build');
        assert.equal(box.exists(`docs/d/${DATE}-real-thing/index.html`), true);
        assert.ok(r.json.warnings.some((w) => /default branch \(origin\/HEAD\).*Settings > General > Default branch/.test(w)), r.stdout);
        assert.ok(!r.json.warnings.some((w) => /could not refresh/.test(w)), r.stdout);
        // Recording the run as published is the one thing left to push, and the push guard refuses it: say so and how to fix it.
        assert.equal(r.code, 1);
        assert.equal(r.json.recovered.pushed, false);
        assert.match(r.json.error, /pending publication could not be pushed: .*default branch.*fix: make main the default branch again/);
      } finally {
        box.cleanup();
      }
    });

    test('origin/HEAD naming the work branch: an unpublished day is generated locally and the refused push names the fix', () => {
      const box = prepare(makeRepoSandbox(), { ideas: false });
      try {
        box.git('remote', 'set-head', 'origin', 'claude/sonnet-every-day');
        const r = run(box, ['--now', iso('09:40'), '--no-sleep']);
        assert.equal(r.code, 1, r.stdout);
        assert.equal(r.json.action, 'published');
        assert.equal(r.json.sync.pushed, false);
        assert.match(r.json.error, /could not be pushed: .*default branch.*fix: make main the default branch again/);
        assert.equal(box.exists(`docs/d/${DATE}-postcard/index.html`), true, 'the page waits locally for a later push');
      } finally {
        box.cleanup();
      }
    });

    test('unpushed work that cannot be regenerated (the researched ideas) is never discarded', () => {
      const box = prepare(makeRepoSandbox(), { ideas: false });
      try {
        const primary = box.cloneB('primary');
        primary.write('state/other.json', { x: 1 });
        primary.git('add', '-A');
        primary.git('commit', '-q', '-m', 'primary moves on');
        primary.git('push', '-q', 'origin', 'claude/sonnet-every-day');
        // The ideas exist only here (committed, not pushed) and the remote has moved on.
        box.write(`work/${DATE}/ideas/shortlist.json`, { ideas: ideasFile().ideas });
        box.git('add', '-A');
        box.git('commit', '-q', '-m', 'ideate output');
        const r = run(box, ['--force', '--now', iso('09:40')]);
        assert.equal(r.code, 0, r.stderr + r.stdout);
        assert.equal(r.json.tier, 3, 'the shortlist was still there to use');
        assert.equal(r.json.sync.pushed, true);
        assert.match(remoteFile(box.remote, `work/${DATE}/ideas/shortlist.json`), /Idea number 1/);
      } finally {
        box.cleanup();
      }
    });
  });

  test('a corrupt history does not hide a day that is already published: the committed copy restores it', () => {
    const box = prepare(makeRepoSandbox(), { ideas: false });
    try {
      assert.equal(run(box, ['--now', iso('09:40'), '--no-sleep']).json.sync.pushed, true);
      const good = box.read('state/history.json');
      box.write('state/history.json', '{"schema":1,"entries":[{"n":1,\n<<<<<<<');
      const again = run(box, ['--now', iso('09:45'), '--no-sleep']);
      assert.equal(again.code, 0, again.stderr + again.stdout);
      assert.equal(again.json.action, 'none');
      assert.equal(again.json.reason, 'already-published');
      assert.equal(again.json.tier, 4);
      assert.equal(JSON.parse(box.read('state/history.json')).entries[0].publishedAt, JSON.parse(good).entries[0].publishedAt);
      assert.ok(box.exists('state/history.json.corrupt-1'));
    } finally {
      box.cleanup();
    }
  });

  test('--no-git leaves the repository untouched', () => {
    const box = prepare(makeRepoSandbox(), { ideas: false });
    try {
      const head = box.git('rev-parse', 'HEAD');
      const r = run(box, ['--no-git', '--now', iso('09:40')]);
      assert.equal(r.code, 0);
      assert.equal(r.json.sync, undefined);
      assert.equal(box.git('rev-parse', 'HEAD'), head);
      assert.ok(remoteHas(box.remote));
      assert.throws(() => remoteFile(box.remote, `docs/d/${DATE}-postcard/project.json`));
    } finally {
      box.cleanup();
    }
  });
});
