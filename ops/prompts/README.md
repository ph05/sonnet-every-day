# Routine prompts

The scheduled routines (cron triggers made with the claude-code-remote `create_trigger` tool) each wake ONE persistent session with `persistent_session_id`; every firing is a new turn appended to that long-lived conversation. They use these prompt files with `{{BOOTSTRAP}}` replaced by the contents of `_bootstrap.md`. The prompts are deliberately thin: all behavior lives in `ops/PLAYBOOK.md`, so changing the system never requires editing a routine. A routine holds a copy of its prompt text, though: an edit to these files reaches it only when the owner or the orchestrator runs `update_trigger` with the new `prompt` (never an operator); "Refresh the routines after editing a prompt" below prints that text, file plus `{{BOOTSTRAP}}` expansion, with one command. `smoke.md` takes steps 1 and 2 of `_bootstrap.md` in place of `{{BOOTSTRAP_STEPS_1_TO_2_ONLY}}`. Earlier turns are not state; only the repo is.

Why persistent sessions: a routine that starts a fresh session per firing gets no repo, no credentials and no claude-code-remote tools in this organization (`git clone` fails and `add_repo` is absent), and the `connectors` option is not available. A session created with the repo as its source has `/home/user/sonnet-every-day` checked out on `claude/sonnet-every-day` and can push to it.

| Role | Routine name and session title (one text for the five scheduled roles) | Cron (CRON_TZ=America/New_York) | Prompt file |
|---|---|---|---|
| primary | Sonnet Every Day: primary (03:55 ET) | `55 3 * * *` | `primary.md` |
| wdA | Sonnet Every Day: watchdog A (05:32 ET) | `32 5 * * *` | `watchdog-a.md` |
| wdB | Sonnet Every Day: watchdog B (06:47 ET) | `47 6 * * *` | `watchdog-b.md` |
| closer | Sonnet Every Day: closer (08:47 ET) | `47 8 * * *` | `closer.md` |
| closerBackup | Sonnet Every Day: closer backup (09:37 ET) | `37 9 * * *` | `closer.md` (same prompt as the closer; it exits quietly when the day is published and covers a closer whose session died, see PLAYBOOK §5.4) |
| manual | routine Sonnet Every Day: manual run (button), session Sonnet Every Day: manual operator (ad hoc runs, demo) | none (poke-only, fired by hand) | `manual.md` (`ROLE=manual`; the fire text carries `RUN_DATE`, `TARGET_TIER`, `FORCE`; `primary.md` with `ROLE_OVERRIDE=manual` in the fire text works the same) |

`state/routines.json` is the registry of the session ids and trigger ids; the orchestrator writes it, operators never do. Ids are not secrets. The registry holds the `session_...` form of a session id; inside the session `$CLAUDE_CODE_REMOTE_SESSION_ID` (and with it the lease and the heartbeat files, and `last_run.session_id` in `get_trigger`) is the same id with the prefix `cse_`. `list_triggers` also shows routines that are not among the six: one-off ones from the first days (`DEMO run, Day 1` and `RESUME demo, Day 1`, no schedule, they fire into the manual session) and the phase-watch timers `sed-watch-<date>-<phase>-a<attempt>` that the sessions create. Leave them alone.

## Recreate a role

Do each step once per role in the table (the owner or the orchestrator does this; operators never touch sessions or routines, PLAYBOOK §1 rule 7).

1. Session: `create_session` with `title` = the session title from the table, `source_url` = `https://github.com/ph05/sonnet-every-day`, `source_revision` = `claude/sonnet-every-day`, `outcome_branch` = `claude/sonnet-every-day`, `model` = `claude-sonnet-5-5`, `permission_mode` = `auto`, no `prompt` (the first firing is its first turn). It inherits the calling session's environment unless `environment_id` is given.
2. Routine: `create_trigger` with `name` = the routine name from the table, `persistent_session_id` = the id from step 1, `prompt` = the prompt file with `{{BOOTSTRAP}}` replaced by the text of `_bootstrap.md` (the recipe under "Refresh the routines" prints it), and `cron_expression` = `CRON_TZ=America/New_York ` plus the cron from the table (omit it for the manual role). Never pass `create_new_session_on_fire` (it conflicts with `persistent_session_id` and would give a session without the repo) and never `connectors`.
3. Model: `update_trigger` with `model` = `claude-sonnet-5-5` only if `get_trigger` shows another model. A persistent turn runs on its session's model, so step 1 is what really sets it.
4. Record the session id and the trigger id in `state/routines.json` and push it as an ordinary commit.

An archived session comes back with `unarchive_session` (it gets a fresh container; the playbook's `add_repo` fallback re-attaches the repo). `update_trigger` cannot move a routine to another session, so replacing a deleted session means deleting the old trigger and creating a new one.

## Refresh the routines after editing a prompt

A routine keeps its own copy of the prompt it was created with. Editing `_bootstrap.md` or a prompt file therefore changes nothing live until each routine is updated, and nothing warns about the difference: the manual routine, created before the last edit of `_bootstrap.md`, was found still carrying the older wording of step 2. After every edit of a file in this folder the owner or the orchestrator refreshes all six routines (operators never do, PLAYBOOK §1 rule 7). The prompt of a routine is its prompt file with `{{BOOTSTRAP}}` replaced by the text of `_bootstrap.md`, both without their trailing newline, and nothing else added. The two commands below do exactly that from the repo root:

1. List the six routines: role, trigger id (from `state/routines.json`), prompt file. The closer file serves two routines (closer and closer backup).

```
node --input-type=module -e "import fs from 'node:fs'; const reg = JSON.parse(fs.readFileSync('state/routines.json', 'utf8')); const file = { primary: 'primary.md', wdA: 'watchdog-a.md', wdB: 'watchdog-b.md', closer: 'closer.md', closerBackup: 'closer.md', manualButton: 'manual.md' }; for (const [role, f] of Object.entries(file)) console.log(role.padEnd(13), reg.triggers[role], f);"
```

2. For each line print the text of its prompt file (put that file where `primary.md` stands), then call `update_trigger` with that line's `trigger_id` and `prompt` = the printed text, unchanged. Id, schedule, session and run history stay as they are; do not delete and recreate a routine for this.

```
node --input-type=module -e "import fs from 'node:fs'; const t = (f) => fs.readFileSync('ops/prompts/' + f, 'utf8').trimEnd(); process.stdout.write(t(process.argv[1]).split('{{BOOTSTRAP}}').join(t('_bootstrap.md')));" primary.md
```

3. `get_trigger` on each trigger and compare `derived_state.prompt` with the printed text. A difference means the update did not take.

Manual/genesis run: `fire_trigger` the manual routine with text `ROLE_OVERRIDE=manual RUN_DATE=YYYY-MM-DD TARGET_TIER=1` (the playbook reads the override from that fire only).
