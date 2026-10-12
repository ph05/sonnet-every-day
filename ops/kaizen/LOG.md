# Kaizen log

Newest first. One entry per member per day. Written only by `scripts/kaizen.mjs` (direct edits are rejected); the machine-readable twin is `INDEX.json`.

## 2026-10-12 · pulse · applied · FM-04: budget is re-read from status and get_session, not remembered as restarting every turn

- observation: FAILURE_MODES.md FM-04 line 22 still said budget.spent() restarts every turn and the budget needs nothing remembered. The 2026-10-12 report and run events show the opposite: spent() was 3.93M in the persistent session, so the first ideate returned budget-exhausted with 0 spend. Jester fixed PLAYBOOK 6.5 today but the recovery row an operator reads after a context loss kept the false claim. Now it says re-read spend from status plus the get_session total. Two lines, no test touched.
- category: prevention · lines changed: 2 · files: ops/FAILURE_MODES.md
- commit: f78463978a
- question: Should FM-47 get a row for budget-exhausted with 0 spend at launch, so the symptom is findable by grep?

## 2026-10-12 · clerk · applied · clerk.md: put the network-down line in notes, where the probe and link-check schemas read it

- observation: Clerk notes 2026-10-12: all 9 links answered 000 to curl and the proofread reported each one as unreachable-link with no network-down line. clerk.md said put one line first, but the network probe schema in ideate.js asks for notes as one line, qa.js line 809 says say so once in notes, and only notes reaches the report (qa.js line 993). Changed the clerk.md sentence to name the notes field. Two lines changed, no test touched.
- category: prevention · lines changed: 2 · files: ops/roles/clerk.md
- commit: 3723fd190b
- question: Should the network probe and the qa link check share one named field for the network-down line, so a later role edit cannot split them again?

## 2026-10-12 · critic · applied · research.md: take a game date and record from the recap, not the publish date; keep W-L-OTL format

- observation: work/2026-10-12/ideate/cand/engineer-1.json dated a game by the story publish date and mixed a streak with a record (Flyers 0-7 vs 0-5-2); the verifier corrected game date 10-11 to 10-10 and the record in ideate/verified/engineer-1.json. research.md facts paragraph said only to name the event date. Critic notes 2026-10-12 ask for the same. Added one clause to that sentence.
- category: prevention · lines changed: 2 · files: ops/rubrics/research.md
- commit: f199377cb4
- question: Should the dossier fact object get an eventDate field apart from asOf so sports claims cannot confuse them?

## 2026-10-12 · cards · applied · research.md: with no okHosts and 5+ DNS failures, stop trying new hosts and search

- observation: Cards notes 2026-10-12: WebFetch failed on 3 of 3 new hosts (DNS), burning the one-try rule each time. work/DATE/ideas/network.json has okHosts empty on 10-10, 10-11 and 10-12 with 22, 27 and 22 failedHosts, 21 to 26 of them ENOTFOUND each day, yet research.md only said try each host once. Added one sentence to the once-per-host bullet: empty okHosts plus 5 or more ENOTFOUND means no outbound web today, so search instead of probing.
- category: prevention · lines changed: 2 · files: ops/rubrics/research.md
- commit: 4136f3df2a
- question: Should the ideate probe seed network.json with a no-outbound-web flag after the first 5 DNS failures so scouts read one field instead of counting?

## 2026-10-12 · engineer · applied · architect.md: every geometry field in a spec schema states unit, axis and anchor (15 ft offset shipp

- observation: Engineer notes 2026-10-12: the SPEC data schema left a rectangle anchor open (zone x,y corner or centre); the two builders read it differently and only a screenshot of the joined page showed a 15 ft offset, found late in integrate. architect.md Deliverable standards said no TBD but not what an open geometry field looks like. Added one sentence naming unit, axis direction, anchor and angle zero.
- category: prevention · lines changed: 2 · files: ops/roles/architect.md
- commit: 52eea619f7
- question: Should the spec phase get a check that every x,y,w,h in SPEC.md schema blocks sits beside an anchor word?

## 2026-10-12 · artisan · applied · artisan.md: builders resize to 1280x650 and 390x844 before handoff (button-over-text S2 shipped)

- observation: 2026-10-12 report: revise left one S2 (buttons overlap text on windows 1280 px wide and under about 720 px tall) and an S3 (share text box cuts its own text on phones), both shipped. Architect put the 1280x650 check in quality.md line 13 for QA, but the builder standards in artisan.md only named 320px scroll, so the person who writes the layout was never told to look. Added one sentence to Deliverable standards: resize to 1280x650 and 390x844, no control over text, primary button and output together on screen, no text box cutting its text.
- category: prevention · lines changed: 2 · files: ops/roles/artisan.md
- commit: ea0d2117e8
- question: Should browser-check.mjs (protected) shoot 1280x650 so the builder check is also a machine check?

## 2026-10-12 · architect · applied · quality.md: add a short 1280x650 window to the hard minimums (button-over-text S2 shipped)

- observation: 2026-10-12 report: revise left one S2, buttons overlap text on windows 1280 px wide or more and under about 720 px tall, and it shipped. quality.md named 1366x768 and 390x844 only and browser-check shoots 1280x800 and 390x844, so no step looked at a short desktop window. My integrate note says the same: a Start button 15 to 35 px below the fold at short heights passes clean. Added one hard-minimum bullet naming 1280x650: no control over text, primary button on screen.
- category: prevention · lines changed: 1 · files: ops/rubrics/quality.md
- commit: 74c3d3b274
- question: Proposal for protected browser-check.mjs: add a 1280x650 desktop shot and assert the primary button rect fits the viewport and no two visible controls overlap?

## 2026-10-12 · jester · applied · PLAYBOOK 6.5: budget.spent() is session-cumulative in a persistent session, rebase capTokens before

- observation: 2026-10-12 run events 07:59: first ideate returned budget-exhausted with 0 spend because budget.spent() was 3.93M (get_session) against capTokens 2.4M; the attempt was lost and the report asks for this fix. PLAYBOOK 6.5 line 321 said spent() restarts at 0 every turn, which was false here. Now it says it may not restart and tells the primary to compare the cap with the get_session output total before the first launch and add it when near or above.
- category: prevention · lines changed: 2 · files: ops/PLAYBOOK.md
- commit: 8bc48c9b1a
- question: Should state.mjs spend print the capTokens already rebased on a session total passed in, so the primary does not do the sum by hand?

## 2026-10-11 · lab · applied · ideate: name verification skipped for time and list it under skipped, not verifier unavailable

- observation: 2026-10-11 ideate on 2 slots (args maxAgents 2, phaseBudgetMinutes 75): 8 scouts at 2 candidates each finished about 105 min in (dossier mtimes 08:23 to 09:43), so timeFor(4) was false and every verify call returned null. All 10 shortlisted ideas are unverified, yet the shortlist note, run phase note and report all say verifier unavailable, and skipStage was never called for verify. Now it is listed as verify r0 with minutes used, notes and log say phase budget spent; a real outage keeps the old wording. New selfcheck test fails without the fix.
- category: prevention · lines changed: 20 · files: ops/workflows/_selfcheck.mjs, ops/workflows/ideate.js
- commit: 8fd8a73222
- question: On 2 slots the 8 scouts at 2 candidates took about 105 of 75 min and 7 of 17 survivors were surplus: should the second candidate need ceil(8 / slots) waves of MINUTES.twoCandidates (so 1 candidate when they cannot fit) while the refill stays allowed, so verification still runs?

## 2026-10-11 · pulse · applied · ideate: tell scouts the 12-source cap so facts do not cite sources the sanitizer cuts

- observation: 2026-10-11: 7 of 16 scout dossiers recorded 13 to 19 sources but sanitizeDossier keeps 12 (ideate.js line 1120), so 11 of 98 facts point past the end of their sources (5 files in ideate/cand, 4 reached shortlist.json). The cap was in no prompt, rubric or test. I measured the digest idea of keeping cited sources first: scouts cite every source they record (cards-1 16 of 16), so it fixes 0 of 11. Now the scout prompt and research.md say at most 12 beside the 3-source minimum, and a selfcheck test (fails without it) pins 12 to the real sanitizer.
- category: prevention · lines changed: 14 · files: ops/rubrics/research.md, ops/workflows/_selfcheck.mjs, ops/workflows/ideate.js
- commit: 77d6aedf2b
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
