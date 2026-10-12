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

Also: `digest [--days N] [--limit N]`, `scan --agent A`, `status`, `queue [--skip a,b] [--clear a,b]`, `verify [--if-needed]`. Every command prints one JSON document; exit `0` ok, `1` checked and failed, `2` usage error. `begin`, `commit`, `propose` and `check` run on the **real clock** (today in `config.timezone`): a `--date` that is not today is a usage error (exit 2; `check` just ignores it) and `--now` is ignored, so the one-per-day cap, the revert window and the digest cannot be steered. Only the read-only `digest`, `scan` and `status` honour `--date`/`--now`. Tests set `SED_NOW` or `SED_KAIZEN_ALLOW_DATE=1` to lift this; the orchestrator never does (a manual rerun of a past date therefore needs `SED_KAIZEN_ALLOW_DATE=1` on the kaizen commands). `SED_ROOT` redirects the repo.

## What `commit` enforces (all mechanical)

Rules come from the **committed** `config.json` (editing the working copy loosens nothing). Any violation rejects the whole kaizen: the member's touched files are restored to HEAD (and the restore is verified: `restored.remaining` lists anything still dirty, with a warning), a `rejected` entry with the reason is logged and committed (ledger only), exit 1. `state/`, `docs/` and `work/` belong to the orchestrator and are never restored: if any of them is dirty when `commit` starts, it stops at once with `foreign-dirty` (exit 1, nothing restored, logged or committed) so a half-finished orchestrator write is not silently reverted. Nothing is pushed, nothing is reset.

| Rule id | Meaning |
|---|---|
| `too-many-lines`, `too-many-files`, `file-too-large` | `maxChangedLines` (added+removed), `maxFiles`, 256 KiB per file |
| `path-not-allowed`, `protected-path`, `ledger-edit`, `bad-path` | outside `allowedPaths`; inside `protectedPaths` (config.json's list plus a built-in floor: the gate, the ledger, `deadman.mjs`, `heartbeat.mjs`, `lib/throttle.mjs`, `lib/usage.mjs`, `lib/phasewatch.mjs`, `lib/revisepolicy.mjs`, `fallback.mjs`, `build-site.mjs`, `qa/browser-check.mjs`) (edit, create, delete or rename-away; case, Unicode, zero-width and trailing-dot look-alikes count); `LOG.md`/`INDEX.json` edited by hand; `..`, `.git`, backslashes, control characters |
| `symlink`, `submodule`, `type-change`, `exec-bit`, `binary-file` | no symlinks, nested repos, mode changes, new executables, or binary files |
| `protected-block-changed`, `-removed`, `-neutralized`, `protected-markers-unbalanced`, `protected-marker-count` | `<!-- protected:begin/end -->` and `// protected:begin/end` blocks must stay byte-identical, present, and in the same lexical context (not commented out, quoted or wrapped). New blocks may be added; none may shrink. |
| `test-file-deleted`, `test-removed`, `test-skipped` | no test file deleted or renamed away, no test declaration dropped, no `.skip`/`.todo`/`.only`/`skip:`/`todo:` added |
| `test-weakened`, `test-commented-out`, `test-disabled`, `test-tautology` | assertion calls are counted on the code only (comments removed, string contents blanked): fewer than at HEAD is a violation, so commenting out, quoting or deleting an assertion fails. Also refused: a comment holding an `assert(...)`/`test('…'` call that was not there before, an early `return;`/`if (false)`/`process.exit(` in a test, and assertions that cannot fail (`assert.ok(true)`, `assert.equal(x, x)`) |
| `test-support-change`, `assertion-edited-with-code` | `tests/helpers/**` and `tests/fixtures/**` change only together with a new test in `tests/*.test.mjs`; an existing assertion line is never edited in the same commit as a change to `scripts/` or `ops/workflows/` |
| `secret`, `injection-phrase` | credential-shaped strings, and text that tries to steer a model, newly added to a file or present in the title/observation/question (and the proposal body). Ledger text is scrubbed on write (secrets redacted, steering phrases replaced by `[removed]`); the digest, the notes and the scan excerpt handed to a member are scrubbed again and fenced in `<untrusted-data>` |
| `doc-line-cap`, `prompt-file-too-large` | `docLineCaps` for PLAYBOOK, CONTRACT, FAILURE_MODES, README, CULTURE and every role and rubric; role, rubric and CULTURE files also have a 12 KiB byte cap, which stops one very long line (a file already over a cap may shrink) |
| `head-moved` | someone ran `git commit` after `begin`; the gate will not reset commits |
| `revert-of-recent-kaizen` | in any one file of an applied kaizen inside `revertWindowDays`, more than half of the lines it added are removed again or more than half of the lines it removed are put back (judged per hunk: an extra line, or reverting only some files, does not hide it). `--evidence` must be 20+ characters and name a run date (`YYYY-MM-DD`) that has a record in `state/runs/` or `state/reports/` at HEAD |

Then the suites run with timeouts (`validate repo` first, then `ops/workflows/_selfcheck.mjs` and each `tests/*.test.mjs` file as its own `node --test` process in a pool of CPUs − 1 workers, longest first; a hung file is killed with its whole process group) and are compared with the baseline taken at `begin`: nothing may fail, the passing count may not drop, skipped and todo counts may not rise, the suites may not leave files behind, and `validate repo` must also pass with the new ledger entry in place. Only then is the change (plus `LOG.md` and `INDEX.json`) committed as `kaizen(<agent>): <title>` with `Kaizen-*` trailers (`Kaizen-Gate:` says which suites ran).

### What the gate runs (the selective gate)

Every suite at every commit cost about 10 minutes on the 4-CPU machine (validate 1 s, selfcheck 112 s, tests about 480 s, measured 2026-10-12 under load), so a round of 9 never fit its 75 minutes. Now a diff whose every path is in this table runs `validate` plus the union of its rows; anything else (`scripts/`, `tests/`, `site-src/`, `ops/lenses.json`, which scripts read in every sandbox) runs every suite. `GATE_MAP` in `scripts/kaizen.mjs` is the table; each row lists the suites that read the path (the live file, or the copy a test sandbox carries), found by grep, and `tests/kaizen.test.mjs` re-greps every suite so a new reader cannot be missed.

| Paths | Suites (besides `validate`) |
|---|---|
| `ops/PLAYBOOK.md` | selfcheck, `playbook`, `revise-policy`, e2e doc subset |
| `ops/roles/`, `ops/rubrics/`, `ops/CULTURE.md` | selfcheck, `playbook`, e2e doc subset |
| `ops/FAILURE_MODES.md`, `ops/OPERATING.md`, `README.md`, `ops/kaizen/proposals/` | `playbook`, e2e doc subset |
| `ops/templates/` | selfcheck, `playbook`, `qa`, e2e doc subset |
| `ops/workflows/` | selfcheck, `playbook`, `revise-policy`, e2e doc subset |

The e2e doc subset is `tests/e2e.test.mjs` run with `--test-name-pattern` `E2E_DOCS_PATTERN`: (m)…(m6) (every command, field and cross-reference the docs name), (kz1)…(kz7) (members append to role and rubric files under their caps; kz1 reads the PLAYBOOK 6.1 push budget) and (bs1), (bs2) (PLAYBOOK 14 and 3.3): 15 of 54 scenarios, about 82 s of e2e's 449 s in a full run under load. On top of the table, any test file whose code (comments aside) names a changed file or its directory in a string runs too (`'lab.md'`, `'ops/roles'`, `'roles'`): a suite the table does not know yet, or a sandbox's own stub, is never skipped (today that adds `kaizen`, `validate`, `sitegen` or `heartbeat` fixtures). A doc change thus costs about 2 minutes instead of 10; a selective run is judged file by file against the baseline, and the files it did not run keep their baseline result.

**Nothing slips.** A cold `begin` (every new HEAD, so the first `begin` of every round) runs every suite. A round that used selective gates ends with `kaizen.mjs verify --if-needed` (the workflow runs it when 10 minutes of the budget are left; `--if-needed` returns at once when HEAD already has a full green run): every suite at HEAD. Green turns the baseline full. Red marks HEAD red, so the next `begin` refuses at once, and names the **suspects**: the commits a selective gate let through since the last full run (from the baseline record, else from the `Kaizen-Gate:` trailers of the last `revertWindowDays`); PLAYBOOK §10.6 says what to do. `status` shows `verification: {state: none|full|partial|red, unverified}`.

**One automatic re-run.** A suite file that fails on its own (not a timeout: a hang is never repeated) is run once more, alone after the pool and in a fresh empty temp directory, in `begin`'s baseline, `commit` and `verify`, before it counts as failed. Alone, because a failure that only the pool's load provoked deserves a quiet second chance, and only that file, because re-running every file recreates the same load and costs a whole suite run. If the re-run passes, the gate goes on and says so: `flaky-suspect: <suite> failed once and passed on the automatic re-run: <test>` in the output (`flaky`, `warnings`, `baseline.notes`) and as the note of the ledger entry, and the tests that flipped are appended to `state/flaky-suspects.json` (newest first, 40 entries, atomic write, `count` per test). A failure that repeats is refused exactly as before, with `failed again on the automatic re-run` and the failing test names in the reason; if the two runs failed on different tests, those are recorded as suspects too. `begin` shows the top of the list (`flakySuspects`): making one of those tests deterministic (never loosening it) is a good kaizen.

`propose --body-file` must point to a regular file (no symlink, at most 20 KB) that really lives under `<repo>/work/<date>/tmp/` (the scratch path the workflow gives members); anything else is a usage error and nothing is read.

Baselines live in `os.tmpdir()/sed-kaizen-<repo hash>/` keyed by HEAD sha and agent: the previous member's passing run is the next member's baseline (so is a rejection's: its restored tree is the baselined tree plus a ledger entry; and a proposal's: one Markdown file and a ledger entry), so a round costs one full run at its first `begin`, a selective run per doc kaizen, a full run per code kaizen, and at most one `verify`. `begin` refuses a red tree (a kaizen cannot start on failing suites). `commit` without any baseline exits 2 and touches nothing.

## For the orchestrator

* `begin` refuses a dirty tree: `state.mjs sync` (commit and push `state docs work`) before the kaizen phase, and do not write to the tree while members run (no `state.mjs event/spend`, no notes appended) until the phase ends. Run `sync` after it: `kaizen.mjs` never pushes.
* Members run one at a time. A crash mid-`commit` can leave the tree dirty (an interrupted ledger write); the next `begin` will say which paths. Restore them with `git checkout -- <paths>` (and delete untracked ones), then continue.
* When the budget stop skips members, record them with `kaizen.mjs queue --skip a,b` after the phase and `queue --clear` for those that ran; `status` shows `queue` and who is still `pending` today.
* `SED_KAIZEN_SUITE_TIMEOUT_MS` overrides every timeout (defaults: validate 3 min, selfcheck 10 min, each test file 30 min); `SED_KAIZEN_JOBS` sets the pool width (default CPUs − 1). A re-run after a failure costs one more run of the failing file only.
* `verify` (the round's full run) needs a clean tree and takes about 8 to 10 minutes; `verify --if-needed` is free when nothing was gated selectively.
* `state/flaky-suspects.json` is written by the gate and left uncommitted, like `state/kaizen-queue.json`: it does not count as a dirty tree for the gate, and the `sync` after the round commits it.
* Shallow clones and a missing `origin` are fine: nothing here fetches or pushes.

## Known limits

The injection and secret checks are pattern based, not proof. `tests/` and `ops/workflows/` are editable by design, so the gate cannot judge whether a changed assertion is weaker; it enforces that tests are not removed, skipped, disabled, commented out or fewer, and that no assertion is edited together with the code it pins. A determined agent can still pad a test with assertions that look meaningful; the owner reviews the ledger, and the safety-critical scripts are protected outright. The test-weakening heuristics read the source with a small lexer (comments, strings, template and regex literals), not a parser. Ignored files (`.gitignore`) are invisible to git and so to the gate.
