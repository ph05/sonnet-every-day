# Handoff from the 2026-10-12 owner-feedback pass (written by the lead, before the 2026-10-13 run)

## What changed (read ops/OWNER.md first)
- The owner said the pages were all games or gimmicks and asked for a mix: a useful tool that is paywalled elsewhere, an interactive lesson on a niche concept, broader subjects, more explaining, an intro paragraph. Day 3 (Between Periods) was the only page liked; day 1 was too complex and day 2 had no clear meaning.
- Every page now has a purpose (tool, lesson, explorer, studio or play). `node scripts/novelty.mjs mix` prints the plan: one or two wanted purposes with a bonus of 5 points (only for an idea with clarity 7 or more), avoided purposes cannot win. Expected for 2026-10-13: wanted tool and lesson, play paused until 2026-10-18. Then roughly tool, lesson, explorer, studio, with a game at most twice a week.
- The page contract is armed from 2026-10-13 (`config.json` `pageContract.requiredFrom`): a plain intro paragraph (35 to 70 words), a visible explainer sized by purpose, a first frame that shows a result, at most 8 controls on the first screen, tools carry 8 or more self-tests, lessons carry 2 or more answerable checks. Validator and browser-check codes are in CONTRACT 6.2 and 6.9; QA adds a stranger cold read, an expert review (only when the token budget allows) and an intro accuracy check.
- Selection weighs clarity as much as feasibility (1.8) and gates on clarity 5. The lens pool was audited against the web: three weak tool lenses dropped, false claims fixed, niche lessons added (ops/lenses.json).
- The three live pages got an intro, an explainer and plain taglines. Days 1 and 2 still warn controls-many (14 and 11 first-screen controls, mostly game cards); do not rebuild them, a future Ideas Day could slim them.

## Watch tomorrow
- The routines still hold their OLD prompt text (nobody can change it from outside). PLAYBOOK 3.4 says the playbook wins; the owner must refresh all six routines from `ops/prompts/` using the recipe in `ops/prompts/README.md`. Until then trust the playbook, not the routine text.
- The first run under the new contract is unattended: expect extra QA agents (cold read, expert). Watch the qa and spec minutes and `spend.workflowCapTokens` before qa and revise; revise may now spend the publish reserve for an open S1.
- A PURPOSE=<tool|lesson|explorer|studio|play> manual run forces that kind. Watchdogs and the closer still act on a manual run for today.
- Tool pages must say honestly what is and is not paywalled elsewhere; the scouts verify the premise by search and print the real remaining gap (research.md, safety.md clean-room rules).
- If a day ships without the contract (validator errors), see PLAYBOOK 10.1 triage and FM-137 to FM-143 before degrading.

## Open questions
- `budget.spent()` is the session's cumulative output (see the 2026-10-12 note in PLAYBOOK 6.5): keep passing `capTokens` = session total + the day's cap.
- The 665k-token gate for the QA expert is an estimate; check whether the expert ever runs on a balanced day and move the gate if QA starves revise.
- Proposal waiting for the owner: ops/kaizen/proposals/2026-10-10-architect.md.
