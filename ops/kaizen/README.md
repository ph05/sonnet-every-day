# Kaizen: the gate and the ledger

Each day, after `publish`, every roster member makes ONE minor change that leaves the collective a little better (CONTRACT §12, charter in `ops/CULTURE.md`, judged by `ops/rubrics/kaizen.md`). This directory holds the record; `scripts/kaizen.mjs` is the only thing that writes it and the only thing that decides whether a change may land.

| File | What |
|---|---|
| `LOG.md` | Human-readable ledger, newest first. Generated from `INDEX.json`. Never edit by hand (the gate rejects it). |
| `INDEX.json` | `{schema:1, entries:[{id, date, agent, title, observation, category, files, sha, status, linesChanged, question, reason}]}`. One entry per (date, agent). `status`: `applied`, `rejected`, `proposed`, `reverted`. `reason` is why it was rejected, or the evidence of harm for a revert. `sha` is the kaizen commit (stamped by a tiny ledger-only commit right after it). |
| `proposals/` | `<date>-<agent>.md`: good ideas that need a protected path. For the owner; never applied automatically. |

## Member flow (one member at a time, in the shared working tree)

```
node scripts/kaizen.mjs begin  --agent pulse            # clean tree, baseline, digest, your notes (or a scan)
# ...make ONE small edit...
node scripts/kaizen.mjs check  --agent pulse            # optional dry run: violations + stats, read-only
node scripts/kaizen.mjs commit --agent pulse --title "…" --observation "what you saw" --category prevention [--question "…"]
node scripts/kaizen.mjs propose --agent pulse --title "…" --body-file notes.md   # instead, when a protected path is needed
```

Also: `digest [--days N] [--limit N]`, `scan --agent A`, `status`, `queue [--skip a,b] [--clear a,b]`. Every command prints one JSON document; exit `0` ok, `1` checked and failed, `2` usage error. `begin`, `commit`, `propose` and `check` run on the **real clock** (today in `config.timezone`): a `--date` that is not today is a usage error (exit 2; `check` just ignores it) and `--now` is ignored, so the one-per-day cap, the revert window and the digest cannot be steered. Only the read-only `digest`, `scan` and `status` honour `--date`/`--now`. Tests set `SED_NOW` or `SED_KAIZEN_ALLOW_DATE=1` to lift this; the orchestrator never does (a manual rerun of a past date therefore needs `SED_KAIZEN_ALLOW_DATE=1` on the kaizen commands). `SED_ROOT` redirects the repo.

## What `commit` enforces (all mechanical)

Rules come from the **committed** `config.json` (editing the working copy loosens nothing). Any violation rejects the whole kaizen: the member's touched files are restored to HEAD (and the restore is verified: `restored.remaining` lists anything still dirty, with a warning), a `rejected` entry with the reason is logged and committed (ledger only), exit 1. `state/`, `docs/` and `work/` belong to the orchestrator and are never restored: if any of them is dirty when `commit` starts, it stops at once with `foreign-dirty` (exit 1, nothing restored, logged or committed) so a half-finished orchestrator write is not silently reverted. Nothing is pushed, nothing is reset.

| Rule id | Meaning |
|---|---|
| `too-many-lines`, `too-many-files`, `file-too-large` | `maxChangedLines` (added+removed), `maxFiles`, 256 KiB per file |
| `path-not-allowed`, `protected-path`, `ledger-edit`, `bad-path` | outside `allowedPaths`; inside `protectedPaths` (config.json's list plus a built-in floor: the gate, the ledger, `deadman.mjs`, `heartbeat.mjs`, `lib/throttle.mjs`, `fallback.mjs`, `build-site.mjs`, `qa/browser-check.mjs`) (edit, create, delete or rename-away; case, Unicode, zero-width and trailing-dot look-alikes count); `LOG.md`/`INDEX.json` edited by hand; `..`, `.git`, backslashes, control characters |
| `symlink`, `submodule`, `type-change`, `exec-bit`, `binary-file` | no symlinks, nested repos, mode changes, new executables, or binary files |
| `protected-block-changed`, `-removed`, `-neutralized`, `protected-markers-unbalanced`, `protected-marker-count` | `<!-- protected:begin/end -->` and `// protected:begin/end` blocks must stay byte-identical, present, and in the same lexical context (not commented out, quoted or wrapped). New blocks may be added; none may shrink. |
| `test-file-deleted`, `test-removed`, `test-skipped` | no test file deleted or renamed away, no test declaration dropped, no `.skip`/`.todo`/`.only`/`skip:`/`todo:` added |
| `test-weakened`, `test-commented-out`, `test-disabled`, `test-tautology` | assertion calls are counted on the code only (comments removed, string contents blanked): fewer than at HEAD is a violation, so commenting out, quoting or deleting an assertion fails. Also refused: a comment holding an `assert(...)`/`test('…'` call that was not there before, an early `return;`/`if (false)`/`process.exit(` in a test, and assertions that cannot fail (`assert.ok(true)`, `assert.equal(x, x)`) |
| `test-support-change`, `assertion-edited-with-code` | `tests/helpers/**` and `tests/fixtures/**` change only together with a new test in `tests/*.test.mjs`; an existing assertion line is never edited in the same commit as a change to `scripts/` or `ops/workflows/` |
| `secret`, `injection-phrase` | credential-shaped strings, and text that tries to steer a model, newly added to a file or present in the title/observation/question (and the proposal body). Ledger text is scrubbed on write (secrets redacted, steering phrases replaced by `[removed]`); the digest, the notes and the scan excerpt handed to a member are scrubbed again and fenced in `<untrusted-data>` |
| `doc-line-cap`, `prompt-file-too-large` | `docLineCaps` for PLAYBOOK, CONTRACT, FAILURE_MODES, README, CULTURE and every role and rubric; role, rubric and CULTURE files also have a 12 KiB byte cap, which stops one very long line (a file already over a cap may shrink) |
| `head-moved` | someone ran `git commit` after `begin`; the gate will not reset commits |
| `revert-of-recent-kaizen` | in any one file of an applied kaizen inside `revertWindowDays`, more than half of the lines it added are removed again or more than half of the lines it removed are put back (judged per hunk: an extra line, or reverting only some files, does not hide it). `--evidence` must be 20+ characters and name a run date (`YYYY-MM-DD`) that has a record in `state/runs/` or `state/reports/` at HEAD |

Then the three suites run with timeouts (`validate repo`, `ops/workflows/_selfcheck.mjs`, `tests/*.test.mjs`; a hung suite is killed with its whole process group) and are compared with the baseline taken at `begin`: nothing may fail, the passing count may not drop, skipped and todo counts may not rise, the suites may not leave files behind, and `validate repo` must also pass with the new ledger entry in place. Only then is the change (plus `LOG.md` and `INDEX.json`) committed as `kaizen(<agent>): <title>` with `Kaizen-*` trailers.

`propose --body-file` must point to a regular file (no symlink, at most 20 KB) that really lives under `<repo>/work/<date>/tmp/` (the scratch path the workflow gives members); anything else is a usage error and nothing is read.

Baselines live in `os.tmpdir()/sed-kaizen-<repo hash>/` keyed by HEAD sha and agent: the previous member's passing run is the next member's baseline (so is a rejection's: its restored tree is the baselined tree plus a ledger entry), so a day costs about one full suite run per member. `begin` refuses a red tree (a kaizen cannot start on failing suites). `commit` without any baseline exits 2 and touches nothing.

## For the orchestrator

* `begin` refuses a dirty tree: `state.mjs sync` (commit and push `state docs work`) before the kaizen phase, and do not write to the tree while members run (no `state.mjs event/spend`, no notes appended) until the phase ends. Run `sync` after it: `kaizen.mjs` never pushes.
* Members run one at a time. A crash mid-`commit` can leave the tree dirty (an interrupted ledger write); the next `begin` will say which paths. Restore them with `git checkout -- <paths>` (and delete untracked ones), then continue.
* When the budget stop skips members, record them with `kaizen.mjs queue --skip a,b` after the phase and `queue --clear` for those that ran; `status` shows `queue` and who is still `pending` today.
* `SED_KAIZEN_SUITE_TIMEOUT_MS` overrides every suite timeout (defaults: validate 3 min, selfcheck 10 min, tests 30 min).
* Shallow clones and a missing `origin` are fine: nothing here fetches or pushes.

## Known limits

The injection and secret checks are pattern based, not proof. `tests/` and `ops/workflows/` are editable by design, so the gate cannot judge whether a changed assertion is weaker; it enforces that tests are not removed, skipped, disabled, commented out or fewer, and that no assertion is edited together with the code it pins. A determined agent can still pad a test with assertions that look meaningful; the owner reviews the ledger, and the safety-critical scripts are protected outright. The test-weakening heuristics read the source with a small lexer (comments, strings, template and regex literals), not a parser. Ignored files (`.gitignore`) are invisible to git and so to the gate.
