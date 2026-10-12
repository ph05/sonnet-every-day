# Routine prompts

The scheduled routines (cron triggers made with the claude-code-remote `create_trigger` tool) each wake ONE persistent session with `persistent_session_id`; every firing is a new turn appended to that long-lived conversation. They use these prompt files with `{{BOOTSTRAP}}` replaced by the contents of `_bootstrap.md`. The prompts are deliberately thin: all behavior lives in `ops/PLAYBOOK.md`, so changing the system never requires editing a routine. A routine holds a copy of its prompt text, though: an edit to these files reaches it only when the owner or the orchestrator runs `update_trigger` with the new `prompt`, assembled as in step 2 below (never an operator). `smoke.md` takes steps 1 and 2 of `_bootstrap.md` in place of `{{BOOTSTRAP_STEPS_1_TO_2_ONLY}}`. Earlier turns are not state; only the repo is.

Why persistent sessions: a routine that starts a fresh session per firing gets no repo, no credentials and no claude-code-remote tools in this organization (`git clone` fails and `add_repo` is absent), and the `connectors` option is not available. A session created with the repo as its source has `/home/user/sonnet-every-day` checked out on `claude/sonnet-every-day` and can push to it.

| Role | Session title (the routine has the same name) | Cron (CRON_TZ=America/New_York) | Prompt file |
|---|---|---|---|
| primary | Sonnet Every Day: primary | `55 3 * * *` | `primary.md` |
| wdA | Sonnet Every Day: watchdog A | `32 5 * * *` | `watchdog-a.md` |
| wdB | Sonnet Every Day: watchdog B | `47 6 * * *` | `watchdog-b.md` |
| closer | Sonnet Every Day: closer | `47 8 * * *` | `closer.md` |
| closerBackup | Sonnet Every Day: closer backup | `37 9 * * *` | `closer.md` (same prompt as the closer; it exits quietly when the day is published and covers a closer whose session died, see PLAYBOOK §5.4) |
| manual | Sonnet Every Day: manual | none (poke-only, fired by hand) | `manual.md` (`ROLE=manual`; the fire text carries `RUN_DATE`, `TARGET_TIER`, `FORCE`; `primary.md` with `ROLE_OVERRIDE=manual` in the fire text works the same) |

`state/routines.json` is the registry of the session ids and trigger ids; the orchestrator writes it, operators never do. Ids are not secrets.

## Recreate a role

Do each step once per role in the table (the owner or the orchestrator does this; operators never touch sessions or routines, PLAYBOOK §1 rule 7).

1. Session: `create_session` with `title` = the session title, `source_url` = `https://github.com/ph05/sonnet-every-day`, `source_revision` = `claude/sonnet-every-day`, `outcome_branch` = `claude/sonnet-every-day`, `model` = `claude-sonnet-5-5`, `permission_mode` = `auto`, no `prompt` (the first firing is its first turn). It inherits the calling session's environment unless `environment_id` is given.
2. Routine: `create_trigger` with `name` = the same title, `persistent_session_id` = the id from step 1, `prompt` = the prompt file with `{{BOOTSTRAP}}` replaced by the text of `_bootstrap.md`, and `cron_expression` = `CRON_TZ=America/New_York ` plus the cron from the table (omit it for the manual role). Never pass `create_new_session_on_fire` (it conflicts with `persistent_session_id` and would give a session without the repo) and never `connectors`.
3. Model: `update_trigger` with `model` = `claude-sonnet-5-5` only if `get_trigger` shows another model. A persistent turn runs on its session's model, so step 1 is what really sets it.
4. Record the session id and the trigger id in `state/routines.json` and push it as an ordinary commit.

An archived session comes back with `unarchive_session` (it gets a fresh container; the playbook's `add_repo` fallback re-attaches the repo). `update_trigger` cannot move a routine to another session, so replacing a deleted session means deleting the old trigger and creating a new one.

Manual/genesis run: `fire_trigger` the manual routine with text `ROLE_OVERRIDE=manual RUN_DATE=YYYY-MM-DD TARGET_TIER=1` (the playbook reads the override from that fire only).
