# Routine prompts

The scheduled routines (created with the claude-code-remote `create_trigger` tool, one fresh session per firing) use these prompt files with `{{BOOTSTRAP}}` replaced by the contents of `_bootstrap.md`. They are deliberately thin: all behavior lives in `ops/PLAYBOOK.md`, so changing the system never requires editing a routine.

| Routine name | Cron (CRON_TZ=America/New_York) | Model | File |
|---|---|---|---|
| Sonnet Every Day: primary | `55 3 * * *` | claude-sonnet-5-5 | `primary.md` |
| Sonnet Every Day: watchdog A | `32 5 * * *` | claude-sonnet-5-5 | `watchdog-a.md` |
| Sonnet Every Day: watchdog B | `47 6 * * *` | claude-sonnet-5-5 | `watchdog-b.md` |
| Sonnet Every Day: closer | `27 7 * * *` | claude-sonnet-5-5 | `closer.md` |
| Sonnet Every Day: closer backup | `42 7 * * *` | claude-sonnet-5-5 | `closer.md` (same prompt as the closer; it exits quietly when the day is published and covers a closer whose session died, see PLAYBOOK §5.4) |

If routines are ever lost, recreate them from this table and these files (`create_trigger` with `create_new_session_on_fire: true`, then `update_trigger` to set the model). Manual/genesis run: `fire_trigger` the primary with text `ROLE_OVERRIDE=manual RUN_DATE=YYYY-MM-DD TARGET_TIER=1`.
