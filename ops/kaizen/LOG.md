# Kaizen log

Newest first. One entry per member per day. Written only by `scripts/kaizen.mjs` (direct edits are rejected); the machine-readable twin is `INDEX.json`.

## 2026-10-11 · pulse · applied · ideate: tell scouts the 12-source cap so facts do not cite sources the sanitizer cuts

- observation: 2026-10-11: 7 of 16 scout dossiers recorded 13 to 19 sources but sanitizeDossier keeps 12 (ideate.js line 1120), so 11 of 98 facts point past the end of their sources (5 files in ideate/cand, 4 reached shortlist.json). The cap was in no prompt, rubric or test. I measured the digest idea of keeping cited sources first: scouts cite every source they record (cards-1 16 of 16), so it fixes 0 of 11. Now the scout prompt and research.md say at most 12 beside the 3-source minimum, and a selfcheck test (fails without it) pins 12 to the real sanitizer.
- category: prevention · lines changed: 14 · files: ops/rubrics/research.md, ops/workflows/_selfcheck.mjs, ops/workflows/ideate.js
- question: Tomorrow count dossiers with more than 12 sources in work/DATE/ideas: if scouts still exceed it, should the sanitizer keep each fact primary source first (measured today: orphan facts 11 to 0, but 19 alsoIn pointers lost)?

## 2026-10-11 · clerk · applied · clerk: say when every network probe fails the same way, so the network is named not the sites

- observation: Clerk notes 2026-10-11: all 7 source links answered 000 from the sandbox and were reported as 7 unreachable links. clerk.md network-probe bullet only covered one host at a time, so nothing said the network itself looked down. Added one sentence: if every host fails the same way, put one line first saying the network looks down, then still list each host. Single line changed in clerk.md, no test touched.
- category: prevention · lines changed: 2 · files: ops/roles/clerk.md
- commit: 493f5f151d

## 2026-10-11 · critic · applied · quality.md: keep the main output in view with its controls (S2 shipped two days running)

- observation: Same S2 kind two days running; revise was skipped both days so both shipped. 2026-10-10 d01: scoring cascade 318 px below Play (1,025 px on a phone). 2026-10-11 qa/report.json: d02 map and sliders never on screen together at 390x844, d03 sticky column scroller crops the map under a wheel at 1366x768 and 1280x800, d04 card goal about 1,600 px above the card list. quality.md hard minimums named only horizontal overflow; browser-check.mjs shots are viewport-only and its monkey wheels assert nothing. Added one hard-minimum bullet with both probes and a selfcheck test pinning it.
- category: prevention · lines changed: 7 · files: ops/rubrics/quality.md, ops/workflows/_selfcheck.mjs
- commit: 80ebbdbfe3
- question: Proposal for protected browser-check.mjs: assert a wheel over the output moves scrollY and the first control shares 390x844 with it? Also 7 of 16 raw scout dossiers passed the 12-source cap and 11 of 98 facts lost their source: keep cited sources first?

## 2026-10-10 · engineer · applied · selfcheck: run the real checkWritten to prove a decoded escape passes in .json and fails in program

- observation: 2026-10-10 report: ideate lost both normalize rounds because checkWritten rejected a clerk-decoded escape in .mjs text by 20 bytes. Lab added a source-line lint, but nothing ran checkWritten itself; selfcheck only compares the prelude text across scripts. New selfcheck test loads the real prelude functions in a vm and asserts: decoded escape in .json passes, in .mjs fails, unreported file fails. Passes today (12 lines).
- category: tests · lines changed: 12 · files: ops/workflows/_selfcheck.mjs
- commit: 7acc6545a3
- question: Should checkWritten name the byte difference and the likely cause in its size mismatch message? It lives in the prelude copied into 7 workflows, so it exceeds the 4 file cap for one kaizen.

## 2026-10-10 · artisan · applied · research rubric: a blended search summary cannot count as two independent sources for verified:true

- observation: Eight friction notes today (architect x2, critic x4, jester x2, plus the lab and cards notes) say WebSearch summaries blend results so a scout cannot tell which link said what, which makes verified:true (two independent results, research.md line 20) a guess. Added one sentence to line 20: count two sources only when two separate result entries with their own URL carry the claim, else verified:false with a blended-summary note.
- category: prevention · lines changed: 2 · files: ops/rubrics/research.md
- commit: 37b545ddd3
- question: Should the dossier source object get a field recording which search string surfaced it, as the critic and verifier notes ask, or is the note text enough?

## 2026-10-10 · architect · proposed · QA: guard req.frame() in the browser-check route handler so a frameless request cannot kill the run

- observation: # Proposal: guard the request frame lookup in the QA route handler
- category: proposal · lines changed: 34 · files: ops/kaizen/proposals/2026-10-10-architect.md
- commit: c782368498

## 2026-10-10 · jester · applied · PLAYBOOK 6.7: say what to do when a workflow never returns after an interrupted agent

- observation: 2026-10-10 report: spec stalled after the architect was interrupted (SPEC.md and DESIGN.md written, OWNERSHIP.json and PROJECT.json missing) and the run was finished by hand. grep of PLAYBOOK.md for stall and interrupted found nothing, and 6.7 only covered workflows that return. Added one row: stop waiting, run the 7.3 check, write only the missing files with one fresh agent, log an error event.
- category: prevention · lines changed: 1 · files: ops/PLAYBOOK.md
- commit: 1c20ee88e1
- question: Could a stalled workflow be detected from the run file alone, for example a phase-start older than phaseBudgetMinutes with a fresh heartbeat, and surfaced by state.mjs status instead of by a human noticing?

## 2026-10-10 · lab · applied · tests: fail when any workflow program text carries a unicode or hex escape a clerk may decode

- observation: 2026-10-10 report: ideate lost both normalize rounds (about 540k tokens, 29 min) because a clerk decoded unicode escapes in shipped program text and the byte check failed by 20. Cards fixed the one regex; nothing stopped the next one. Grep of ops/workflows/*.js shows only the host-side asciiJson line has escapes now, so a playbook.test.mjs line scan (13 lines) passes today and fails on any new escape.
- category: prevention · lines changed: 11 · files: tests/playbook.test.mjs
- commit: c62f6046bb
- question: Spec stalled after an interrupted architect and never returned: could a workflow older than its phase budget be detected from the run file alone, without a new watchdog?

## 2026-10-10 · cards · applied · ideate: build sanitizer CTRL regex from code points so clerk copy cannot change its bytes

- observation: The 2026-10-10 report says ideate lost both normalize rounds: the clerk decoded the unicode escapes in the CTRL regex of sanitizeDossier, which ideate.js ships as text, so the byte size check failed by 20 bytes. The byte slack only covers .json files. Now the regex is built from code point ranges and sanitizeDossier has no escapes left. Checked all 65536 BMP chars: old and new regex strip exactly the same ones.
- category: prevention · lines changed: 4 · files: ops/workflows/ideate.js
- commit: 3281efd4d7
- question: Should checkWritten in the other workflows (build, qa, select, spec, revise) also be proven free of escape sequences in shipped programs, or should the byte slack cover .mjs too?
