# Operating Sonnet Every Day

A short guide for the owner. Every morning a team of Claude agents builds one new web toy and puts it on the site by 08:00 America/New_York. You do not have to do anything for that to happen. This page is for the moments when you want to steer: pause it, change how much it spends, run a build by hand, turn on the site, or clean up a day you do not like.

The operator's own runbook is [`PLAYBOOK.md`](PLAYBOOK.md) and the list of everything that can go wrong (with what the system already does about it) is [`FAILURE_MODES.md`](FAILURE_MODES.md). You rarely need either.

## What runs, and when

Five scheduled routines, all in America/New_York time. Each one is a fresh Claude session that reads the playbook and does one job.

| Time | Routine | Job |
|---|---|---|
| 03:55 | primary | Does the whole build: ideas, pick one, spec, build, QA, package, publish. |
| 05:32 | watchdog A | Checks the primary. Healthy: does nothing. Dead or stuck: takes over. |
| 06:47 | watchdog B | Same, with less time left: nudges a slow primary to scale down, or takes over. |
| 07:27 | closer | Guarantees something is live by 08:00 (publishes a fallback if needed). |
| 07:42 | closer backup | The same prompt and job as the closer, fifteen minutes later. If the day is already published it checks and stops; if the closer's session died halfway it finishes the job. |

What lands on the site, best to worst: **Tier 1** a full build, **Tier 2** a compact build, **Tier 3** "Ideas Day" (the ten researched ideas, shown as the day's page, clearly marked as a fallback), **Tier 4** "Postcard" (a small generative page that says today's build did not complete). A fallback counts as a day but does not use up a category, and a late-recovering build can still replace a fallback until 23:59.

## Check on it

From a checkout of the repo (or ask Claude to run it for you):

```
node scripts/state.mjs status
node scripts/state.mjs status --date 2026-10-09
```

Read `status` (`in_progress`, `published`, `failed`), `phase`, `tier`, `lease.alive`, `spend` and the plain-English `nextAction`. For the story of a day read `state/reports/<date>.md` (one file per day, written by the operator). The raw state is in `state/runs/<date>.json`; the gallery's own data is `docs/archive.json`. A push notification arrives when a day publishes (and when it falls back or fails), if the notification tool is available to the routines.

## Pause and resume

Pause **all five** routines (the closer backup too). If you only pause the primary, the watchdogs notice there is no run and start the day themselves, which is the point of them.

* Ask Claude: "disable the five Sonnet Every Day routines" (it uses `update_trigger` with `enabled:false` on each of them; `list_triggers` shows their names). Resume with `enabled:true`.
* Or use the routines list in Claude Code on the web and switch each one off and on.
* A session that is already running finishes its day; to stop it now, interrupt that session from the sessions list.
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

Two things to know. The routine prompts carry a hard ceiling (`+3M` at the top of the primary and watchdog prompts, `+500k` for the closer): a level above `balanced` only helps if you raise that line in `ops/prompts/*.md` and in the routines too. And the system also moves the level by itself: any rate-limit, usage-limit or budget signal lowers it one notch (never below `minimal`), and five fully clean days in a row raise it one notch (never above `autoThrottle.ceiling`, which is `balanced`; raise it in `config.json` if you want automatic climbs to `all-in`).

## Run a build by hand (manual, genesis, rerun)

Fire the **primary** routine with this text (the playbook reads it):

```
ROLE_OVERRIDE=manual RUN_DATE=2026-10-09 TARGET_TIER=1
```

Ask Claude: "fire the Sonnet Every Day primary routine with the text `ROLE_OVERRIDE=manual RUN_DATE=2026-10-09 TARGET_TIER=1`" (it uses `fire_trigger`). `RUN_DATE` is the day to build (today or earlier), `TARGET_TIER` is 1 (full), 2 (compact), 3 (Ideas Day) or 4 (Postcard). A manual run ignores the clock, but it will not touch a day that is already published and it will not interrupt a session that is actively working (add `FORCE=1` only if you know the other session is dead). This is how the very first day is built.

## Rebuild the routines

Routines are just prompts plus a schedule, and the prompts live in the repo. If they are ever lost, recreate them from [`prompts/README.md`](prompts/README.md): five routines (`create_trigger` with `create_new_session_on_fire: true`), cron expressions in `CRON_TZ=America/New_York` (`55 3 * * *`, `32 5 * * *`, `47 6 * * *`, `27 7 * * *` and, for the closer backup, `42 7 * * *`), the prompt text from `prompts/primary.md`, `watchdog-a.md`, `watchdog-b.md` and `closer.md` (used twice: the backup closer is the same prompt on a second schedule) with `{{BOOTSTRAP}}` replaced by the text of `prompts/_bootstrap.md`, and the model set to `claude-sonnet-5-5` (with `update_trigger`). Asking Claude to "recreate the five Sonnet Every Day routines from ops/prompts/README.md" works. `prompts/smoke.md` is a one-off plumbing test.

## Turn on GitHub Pages (once)

The site is the `docs/` folder of the work branch.

1. On GitHub open the repo, **Settings**, **Pages**.
2. Under **Build and deployment** choose **Deploy from a branch**.
3. Branch `claude/sonnet-every-day`, folder `/docs`, **Save**.

The address is the `siteUrl` in `config.json` (`https://ph05.github.io/sonnet-every-day/`). The first deploy takes a few minutes. If the operator reports "the site returns 404", this step is what is missing.

## Merge the branch to `main`

Everything runs on `claude/sonnet-every-day`, so nothing needs merging for the daily build to work. You merge when you want the repo's default branch to carry the code, and for one practical reason: **GitHub only runs scheduled workflows from the default branch**, so the model-free safety net (the deadman GitHub Action, `.github/workflows/deadman.yml`) stays dormant until its file is on `main`. Once it is, it wakes on its own schedule and publishes a fallback if the day is still unpublished at 07:30. That matters most when the subscription is exhausted, because then no Claude routine can start at all.

1. Open a pull request from `claude/sonnet-every-day` into `main` and merge it (read the workflow file first: it says which branch it publishes to and what permissions it needs).
2. The routines keep working on the work branch; nothing else changes. Merge again from time to time if you want `main` to follow along.
3. Only if you decide **`main` should become the work branch**: set `workBranch` to `main` in `config.json`, change the branch name in the first two steps of `ops/prompts/_bootstrap.md`, update the five routines so they carry the new bootstrap text, and switch Pages to `main` and `/docs`. `state.mjs sync` and the heartbeat both follow `config.workBranch`.

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

## Costs and limits

* Everything stays inside your Claude subscription. The system never buys extra usage: if a tool ever mentions overage, extra usage or purchases, the operator stops agent work and publishes a fallback instead.
* A normal day at the default level uses up to about 3 million output tokens across the team (eight Sonnet agents plus cheap Haiku helpers). Watchdogs that find a healthy primary cost almost nothing; the closer is capped at 500k.
* Hitting a limit never ends in a blank day: the level steps down, the day finishes at a lower tier, and a Postcard or Ideas Day goes up. Five clean days in a row step the level back up.
* Heavy use elsewhere in your account (and manual builds) draws from the same limits. If days keep falling back, run `node scripts/state.mjs throttle get` and read the `log` in `state/throttle.json` to see what the system did and why.

## When something looks wrong

Start with `node scripts/state.mjs status` and read `nextAction`. Then look the symptom up in [`FAILURE_MODES.md`](FAILURE_MODES.md): each row says how to recognize it, what already happened automatically, and what (if anything) you should do. The most common reasons for a fallback day are a rate or usage limit, a build that failed validation or QA late in the morning, and GitHub Pages not being enabled.
