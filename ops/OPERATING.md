# Operating Sonnet Every Day

A short guide for the owner. Every morning a team of Claude agents builds one new web toy and puts it on the site around 08:00 America/New_York (a guideline: it is occasionally later, because quality beats punctuality). Once the page is live, each of the nine team members also makes one small improvement to the system itself (the daily "kaizen"). You do not have to do anything for that to happen. This page is for the moments when you want to steer: pause it, change how much it spends, run a build by hand, turn on the site, or clean up a day you do not like.

The operator's own runbook is [`PLAYBOOK.md`](PLAYBOOK.md) and the list of everything that can go wrong (with what the system already does about it) is [`FAILURE_MODES.md`](FAILURE_MODES.md). You rarely need either.

## What runs, and when

Five scheduled routines, all in America/New_York time, plus a manual one that you fire by hand. Each routine is a cron trigger that wakes its own long-lived Claude session (one session per role, created with the repo attached); every firing is a new turn in that conversation, which reads the playbook and does one job. Earlier turns are not memory and the repo is the only state, so a session can be replaced without losing anything. (A routine that starts a brand-new session per firing cannot work in this organization: such a session gets no repo, no credentials and no repo tools.) The sessions and triggers are listed in `state/routines.json`; the steps to recreate them are in [`prompts/README.md`](prompts/README.md).

| Time | Routine | Job |
|---|---|---|
| 03:55 | primary | Does the whole build: ideas, pick one, spec, build, QA, package, publish. |
| 05:32 | watchdog A | Checks the primary. Healthy: does nothing. Dead or stuck: takes over. |
| 06:47 | watchdog B | Same, with less time left: nudges a slow primary to scale down, or takes over. |
| 08:47 | closer | Guarantees something is live. A healthy run that is still in QA or packaging gets a grace window until 09:30 (the closer waits and watches); otherwise it tries to salvage the build, then publishes a fallback. Never runs the kaizen. |
| 09:37 | closer backup | The same prompt and job as the closer, fifty minutes later. If the day is already published it checks and stops; if the closer's session died halfway it finishes the job. |

Nothing is degraded merely for missing 08:00. A run is cut only after 09:30, and anything unpublished at 10:30 is force-resolved. Liveness pings go to a separate branch, `claude/sonnet-every-day-heartbeat`, so they never trigger a GitHub Pages build; it is recreated automatically if you delete it. Pushing to that second branch through the cloud session's git proxy has not been proven yet: see "Prove the heartbeat branch" below.

What lands on the site, best to worst: **Tier 1** a full build, **Tier 2** a compact build, **Tier 3** "Ideas Day" (the ten researched ideas, shown as the day's page, clearly marked as a fallback), **Tier 4** "Postcard" (a small generative page that says today's build did not complete). A fallback counts as a day but does not use up a category, and a late-recovering build can still replace a fallback until 23:59. After the publish the team runs the kaizen round and leaves a handoff note for tomorrow (see "The daily kaizen" below).

## Check on it

From a checkout of the repo (or ask Claude to run it for you):

```
node scripts/state.mjs status
node scripts/state.mjs status --date 2026-10-09
node scripts/kaizen.mjs status
```

Read `status` (`in_progress`, `published`, `failed`), `phase`, `tier`, `lease.alive`, `spend` and the plain-English `nextAction`. For the story of a day read `state/reports/<date>.md` (one file per day, written by the operator; it ends with the day's kaizen and a blameless "what went wrong"), and `state/handoff.md`, the note the last session left for tomorrow's. The raw state is in `state/runs/<date>.json`; the gallery's own data is `docs/archive.json`. A push notification arrives when a day publishes ("live", or "late" when it is after 08:30), when it falls back, or when it fails, if the notification tool is available to the routines.

## Pause and resume

Pause **all five** routines (the closer backup too). If you only pause the primary, the watchdogs notice there is no run and start the day themselves, which is the point of them. To pause only the self-improvement, see "The daily kaizen" below.

* Ask Claude: "disable the five Sonnet Every Day routines" (it uses `update_trigger` with `enabled:false` on each of them; `list_triggers` shows their names). Resume with `enabled:true`.
* Or use the routines list in Claude Code on the web and switch each one off and on.
* A disabled routine leaves its session untouched; switch the routine on again and the session carries on. A turn that is already running finishes its day; to stop it now, interrupt that session from the sessions list.
* If you have merged the branch to `main` (see below), also disable the deadman workflow in the repo's Actions tab while paused.

## Change how much it spends

The budget level lives in `state/throttle.json` (the seed is `budget.level` in `config.json`). Levels:

| Level | Output tokens per day | What it means |
|---|---|---|
| `all-in` | 8,000,000 | Max effort for all agents, two revise loops. |
| `balanced` (default) | 3,000,000 | Max effort for architect, engineer and critic; high for the rest; one revise loop. |
| `lean` | 1,500,000 | High effort, no revise loop. |
| `minimal` | 500,000 | Medium effort, always the compact Tier 2 build. |

Set it by hand (from a checkout, then push):

```
node scripts/state.mjs throttle set --level lean --reason "saving usage this week"
node scripts/state.mjs sync -m "throttle: lean"
```

Two things to know. The cap is enforced by the playbook itself, not by the prompts: a `+N` token directive in a routine prompt does nothing in this environment (the Workflow tool never sees it), so the day's cap is the level's `outputTokens` minus the publish and kaizen reserves, handed to every workflow as `args.capTokens` and measured with `budget.spent()`. A level change therefore takes effect with `throttle set` alone, `all-in` included; there is no prompt line to raise. And the system also moves the level by itself: any rate-limit, usage-limit or budget signal lowers it one notch (never below `minimal`), and five fully clean days in a row raise it one notch (never above `autoThrottle.ceiling`, which is `balanced`; raise it in `config.json` if you want automatic climbs to `all-in`).

## The daily kaizen (the swarm's diary)

After the page is live, each of the nine members (pulse, cards, lab, jester, architect, artisan, engineer, critic, clerk) makes ONE minor change that leaves the collective a little better: a clearer prompt, a missing check, a deleted duplicate. It need not relate to the member's own job. A script (`scripts/kaizen.mjs`) is the gate: small changes only (120 lines, 4 files), only allowed folders, never the safety rules or protected files, and every test must stay green, otherwise the change is rejected and logged as a learning. It runs after the publish, so it can never make the page late. The charter is [`CULTURE.md`](CULTURE.md).

* **Review it.** The public diary is the `kaizen/` page of the site (`https://ph05.github.io/sonnet-every-day/kaizen/`: newest first, filter by member, each entry links to its commit). The same record is [`ops/kaizen/LOG.md`](kaizen/LOG.md) (machine-readable twin `ops/kaizen/INDEX.json`); the commits are named `kaizen(<member>): <title>`. Ask Claude "summarize this week's kaizens" if you want a digest.
* **Proposals.** A good idea that needs a protected file (for example `config.json` or a safety rule) is never applied by itself: the member writes it to `ops/kaizen/proposals/<date>-<member>.md`. Read them now and then. To accept one, make the change yourself (or ask Claude to) as an ordinary commit and delete the proposal file; to decline, just delete it.
* **Revert one.** Find its commit (`git log --grep "kaizen(" --oneline`), undo the change, keep the ledger, and record the revert in it so the next members see why (or ask Claude: "revert the 2026-10-12 pulse kaizen, reason ..."). The first command reports a conflict in `ops/kaizen/INDEX.json`; that is expected (the ledger entry got its commit id stamped in a later commit), and the second command settles it by keeping the ledger as it is. The node snippet then marks the entry `reverted` and regenerates `ops/kaizen/LOG.md` exactly the way the script does:

```
git revert --no-commit <sha>
git checkout HEAD -- ops/kaizen/INDEX.json ops/kaizen/LOG.md
node --input-type=module -e "
import fs from 'node:fs';
import { renderLog } from './scripts/kaizen.mjs';
const file = 'ops/kaizen/INDEX.json';
const index = JSON.parse(fs.readFileSync(file, 'utf8'));
const entry = index.entries.find((e) => e.id === '2026-10-12-pulse');
entry.status = 'reverted';
entry.reason = 'one sentence: what it broke';
fs.writeFileSync(file, JSON.stringify(index, null, 2) + '\n');
fs.writeFileSync('ops/kaizen/LOG.md', renderLog(index));
"
node scripts/validate.mjs repo
git add -A ops scripts tests site-src README.md && git commit -m "revert kaizen 2026-10-12-pulse" && git push origin claude/sonnet-every-day
```

* **Quarantine.** Kaizens change what every later day runs on. When a day degrades, the next preflight lists the recent kaizen commits that touched `ops/workflows`, `scripts/`, `ops/templates` or `tests/` as suspects (run event "kaizen suspects", the premortem, the handoff). After **two degraded days in a row** it writes `state/kaizen-hold.md` and the kaizen round is skipped until you lift it; the page, the premortem and the handoff carry on, and the report names the file under "Follow-ups for the owner". Read the suspects (`git show --stat <sha>`), revert the harmful ones with "Revert one", then lift the hold: `rm state/kaizen-hold.md && node scripts/state.mjs sync -m "owner: lift the kaizen hold"`. The operator never reverts a kaizen by itself.
* **Pause it.** Set `"enabled": false` in the `kaizen` block of `config.json` and push (`node scripts/state.mjs sync -m "pause kaizen" --paths config.json`). The page, the premortem and the handoff carry on; only the round is skipped. Set it back to `true` to resume. (`config.json` is protected: a kaizen can never edit it.)
* **Raise or lower the caps** in the same `kaizen` block of `config.json`: `maxChangedLines` (120) and `maxFiles` (4) size one kaizen, `minTokensToStart` (60000) is the budget floor below which the round stops, `revertWindowDays` (7) is how long members may not undo each other without evidence, `docLineCaps` stops the playbook, contract, failure table and README from growing, and `members` is who takes part. `budget.reserveForKaizenTokens` (350000) is the share of each day's budget the earlier phases leave for the round. Edit, then push the same way.

## Run a build by hand (manual, genesis, rerun)

Fire the **manual** routine ("Sonnet Every Day: manual") with this text (the playbook reads it). It has its own session, so a manual run never queues behind or interrupts the 03:55 turn; without a manual routine, fire the primary one, but only while no primary turn is running:

```
ROLE_OVERRIDE=manual RUN_DATE=2026-10-09 TARGET_TIER=1
```

Ask Claude: "fire the Sonnet Every Day manual routine with the text `ROLE_OVERRIDE=manual RUN_DATE=2026-10-09 TARGET_TIER=1`" (it uses `fire_trigger`). `RUN_DATE` is the day to build (today or earlier), `TARGET_TIER` is 1 (full), 2 (compact), 3 (Ideas Day) or 4 (Postcard). A manual run ignores the clock, but it will not touch a day that is already published and it will not interrupt a session that is actively working (add `FORCE=1` only if you know the other session is dead). This is how the very first day is built.

## Rebuild the routines

Routines are just prompts plus a schedule, and the prompts live in the repo. Each role needs a session first and then a trigger that wakes it, so rebuilding is two calls per role, spelled out in [`prompts/README.md`](prompts/README.md): `create_session` (the repo as source, branch `claude/sonnet-every-day`, model `claude-sonnet-5-5`), then `create_trigger` with that session as `persistent_session_id` (never `create_new_session_on_fire`: that session would have no repo). Cron expressions are in `CRON_TZ=America/New_York`: `55 3 * * *` (primary), `32 5 * * *`, `47 6 * * *`, `47 8 * * *` and, for the closer backup, `37 9 * * *`; the manual routine has no schedule. The prompt text comes from `prompts/primary.md`, `watchdog-a.md`, `watchdog-b.md` and `closer.md` (used twice: the backup closer is the same prompt on a second schedule) with `{{BOOTSTRAP}}` replaced by the text of `prompts/_bootstrap.md`. An archived session comes back with `unarchive_session`; a deleted one is recreated, and the new ids go into `state/routines.json`. Asking Claude to "recreate the Sonnet Every Day sessions and routines from ops/prompts/README.md" works. `prompts/smoke.md` is a one-off plumbing test.

## Turn on GitHub Pages (once)

The site is the `docs/` folder of the work branch.

1. On GitHub open the repo, **Settings**, **Pages**.
2. Under **Build and deployment** choose **Deploy from a branch**.
3. Branch `claude/sonnet-every-day`, folder `/docs`, **Save**.

The address is the `siteUrl` in `config.json` (`https://ph05.github.io/sonnet-every-day/`). The first deploy takes a few minutes. If the operator reports "the site returns 404", this step is what is missing.

## Merge the branch to `main`

Everything runs on `claude/sonnet-every-day`, so nothing needs merging for the daily build to work. You merge when you want the repo's default branch to carry the code, and for one practical reason: **GitHub only runs scheduled workflows from the default branch**, so the model-free safety net (the deadman GitHub Action, `.github/workflows/deadman.yml`) stays dormant until its file is on `main`. Once it is, it wakes on its own schedule (13:40 and 14:40 UTC, which is 09:40 New York time) and publishes a fallback if the day is still unpublished once the grace window is over. That matters most when the subscription is exhausted, because then no Claude routine can start at all.

1. Open a pull request from `claude/sonnet-every-day` into `main` and merge it (read the workflow file first: it says which branch it publishes to and what permissions it needs).
2. The routines keep working on the work branch; nothing else changes. Merge again from time to time if you want `main` to follow along.
3. Only if you decide **`main` should become the work branch**: set `workBranch` to `main` in `config.json`, change the branch name in the first two steps of `ops/prompts/_bootstrap.md`, recreate the sessions with the new branch as their source and the routines with the new bootstrap text (`prompts/README.md`), and switch Pages to `main` and `/docs`. `state.mjs sync` and the heartbeat both follow `config.workBranch`.

## Remove a bad day

A day you want gone from the site (and from the "no repeats" memory):

```
node scripts/history.mjs remove --date 2026-10-09
rm -rf docs/d/2026-10-09-*
node scripts/build-site.mjs
node scripts/validate.mjs repo
node scripts/state.mjs sync -m "remove bad day 2026-10-09"
```

The gallery then lists that date as a missing day. To **rebuild** the same date as well, also remove its run record and staging, and then fire a manual run:

```
rm -f state/runs/2026-10-09.json state/ideas/2026-10-09.json
rm -rf work/2026-10-09
node scripts/state.mjs sync -m "reset 2026-10-09 for a rerun"
```

(A published run is never touched by a new run, which is why the run file has to go.) If that bad day had saved a carry-over idea, `state/carryover.json` keeps it; that is fine, or reset it to `{"schema":1,"idea":null,"savedOn":null,"carriedCount":0}`.

## What the cloud can reach (network access)

The sessions run in an environment with a limited network policy. Verified on 2026-10-09: `registry.npmjs.org` and the git remote work; `en.wikipedia.org`, `www.reddit.com`, `news.ycombinator.com`, `api-web.nhle.com` and `ph05.github.io` do not (curl answers 000, WebFetch fails with `ENOTFOUND`), and WebSearch works. What follows from it:

* **Research is WebSearch-based.** The scouts work from search results (title, URL, date, snippet) and cannot open most pages. Evergreen lenses use the cheap `standard` search mode; only time-sensitive lenses use `extended`, which costs several times more (and `standard` returns stale snapshots for "today" questions). A source counts as verified only when two results agree or a page really opens; an unverified claim never appears in a published page as fact. Ideas are a little thinner than they would be with page access: that is the price of the restriction, not a fault.
* **`verify-live` cannot reach the site.** `live:null, reason:"unreachable"` is the normal answer from the cloud. The operator writes it in the report and moves on; it is never alarming, never a reason to notify you, and says nothing about GitHub Pages. To check a day, open the site yourself.
* **To widen access**, change the cloud environment's settings (the environment menu in the session's title bar, then Edit, then Network access; steps at <https://code.claude.com/docs/en/cloud-environments#network-access>): either add the hosts under **Allowed domains** (`en.wikipedia.org`, `www.reddit.com`, `news.ycombinator.com`, `api-web.nhle.com`, `ph05.github.io`; leave "Allow package managers" ticked) or choose a broader level such as **Full**. Persistent sessions keep running in their container, so if a role does not pick the change up, recreate its session (`prompts/README.md`). Nothing in the repo needs changing: the research workflow probes each likely host with one WebFetch a day and files the failures in `work/<date>/ideas/network.json`, so a host you allow starts being used the next morning.

## Prove the heartbeat branch (once, in the live environment)

Every run starts with a canary push to the heartbeat branch, and a refused push puts that turn into a slower fallback (liveness on the work branch every 20 minutes, 3 extra pushes an hour; FM-111). To see it work before relying on it, ask Claude in any of the role sessions: "run `node scripts/heartbeat.mjs --role manual --session owner-test --phase preflight --wait 0` and then `git ls-remote --heads origin claude/sonnet-every-day-heartbeat`". The first prints `ok:true, pushed:true`; the second lists the branch. If the push is refused, the platform does not allow a second branch for these sessions: tell Claude, and expect the fallback until `heartbeatBranch` in `config.json` names a branch it accepts. The run report says "heartbeat branch push failed" on any day it happened.

## Costs and limits

<!-- protected:begin -->
* Everything stays inside your Claude subscription. The system never buys extra usage: if a tool ever mentions overage, extra usage or purchases, the operator stops agent work and publishes a fallback instead.
<!-- protected:end -->
* A normal day at the default level uses up to about 3 million output tokens across the team (eight Sonnet agents plus cheap Haiku helpers). Watchdogs that find a healthy primary cost almost nothing; the closer's turn is capped at 500k by the playbook. The kaizen round keeps its own share (350k tokens) and skips itself when less than 60k are left, so it never eats into the build.
* Hitting a limit never ends in a blank day: the level steps down, the day finishes at a lower tier, and a Postcard or Ideas Day goes up. Five clean days in a row step the level back up.
* Heavy use elsewhere in your account (and manual builds) draws from the same limits. If days keep falling back, run `node scripts/state.mjs throttle get` and read the `log` in `state/throttle.json` to see what the system did and why.

## When something looks wrong

Start with `node scripts/state.mjs status` and read `nextAction`. Then look the symptom up in [`FAILURE_MODES.md`](FAILURE_MODES.md): each row says how to recognize it, what already happened automatically, and what (if anything) you should do. The most common reasons for a fallback day are a rate or usage limit, a build that failed validation or QA late in the morning, and GitHub Pages not being enabled.
