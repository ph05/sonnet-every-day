# Premortem 2026-10-14

The critic's three ways today could go wrong, each with one cheap thing to do about it.

- ops/workflows/qa.js passed the vm selfcheck yet the runtime refused it on 10-13, and guard tests cover only four known constructs. Mitigation: launch qa as a Workflow first; on any named refusal, go straight to no-Workflow mode.
- Ideate used 662k tokens on 10-13 and 110 minutes against 75 on 10-11, so qa (472k) plus a 350k revise loop will not fit in 2.4M. Mitigation: cap scout candidates and run QA compact, skipping the expert review.
- Hand-set capTokens caused the 0-spend budget-exhausted ideate launch on 10-12, and a typed carryover null slip followed. Mitigation: before launching, read status plus the get_session total and copy args from the previous run file.
