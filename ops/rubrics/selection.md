# Selection rubric (judges, aggregator, critic)

Used by `ops/workflows/select.js`. Nine judges each score ALL shortlisted ideas on ONE criterion, 0 to 10 (one decimal allowed), with a one-line concrete reason per idea. Every judge first reads `ops/OWNER.md`: what the owner said outranks any other taste signal. The script (not an agent) computes the weighted total, adds the purpose bonus, applies the gates, ranks, and picks the winner and at most one carry-over. A critic then makes a last adversarial check of the winner and may veto once.

**Below 6 agent slots** (`args.maxAgents`) four judges hold two or three criteria each, so the panel takes two waves on two slots instead of five (2026-10-11: four waves used 25 of the 30 minutes and the critic check was skipped for time): architect `feasibility` + `sophistication`, critic `safety` + `clarity`, lab `distinctness` + `interestFit` + `timeliness`, artisan `polishPotential` + `delight`. Every criterion keeps its own anchors, reasons and weight; a judge that fails loses all of its criteria. On a wide machine each criterion has its own judge; cards judges `clarity` as well as `interestFit`.

## Machine-readable settings

`ops/workflows/select.js` carries the same weights and gates; `ops/workflows/_selfcheck.mjs` fails if they ever differ. Change both together. `purposeBonus` documents `config.json` `mix.purposes.wantedBonus`, which select reads from the purpose plan (`args.mix.purposes.bonus`); the selfcheck fails if the two differ.

```json weights
{
  "weights": {
    "sophistication": 1.2,
    "delight": 1.6,
    "distinctness": 2.0,
    "feasibility": 1.8,
    "timeliness": 0.6,
    "interestFit": 0.7,
    "polishPotential": 1.0,
    "safety": 1.0,
    "clarity": 1.8
  },
  "gates": {
    "minFeasibility": 5,
    "minSafety": 5,
    "minClarity": 5,
    "carryMinTotal": 58,
    "carryMinFeasibility": 5,
    "carryMinSafety": 6,
    "tieEpsilon": 0.05
  },
  "purposeBonus": 5
}
```

`baseTotal` = weighted mean of the criteria that were scored, times 10, so it lives on 0 to 100. A criterion whose judge failed is left out and the remaining weights renormalize. `total` = `baseTotal` plus the purpose bonus, at most 100. `total` ranks.

Why these weights: variety and finishability decide whether the project is worth having at all (distinctness 2.0, feasibility 1.8). Clarity weighs as much as feasibility (1.8): the owner could not tell what day 2 was and found day 1 too complex. Delight is what the owner wants to feel (1.6). Sophistication rewards depth a visitor can discover, never depth a newcomer must climb (1.2). Polish and safety are floors that matter at the margin. Interest fit is deliberately light because variety is paramount, and timeliness is light because an evergreen idea is as good as a topical one.

## Purpose bonus (today's plan)

`node scripts/novelty.mjs mix` prints the purpose plan: `wanted` (one or two purposes), `avoid` and `bonus`. An idea whose `fingerprint.purpose` is wanted gets `purposeBonus` points on top of its `baseTotal`. An idea whose purpose is avoided cannot win (reason `purpose-avoid`). An idea without a purpose, or a day without a plan, gets no bonus and no penalty; the log says "purpose missing" or "no purpose plan". The carry-over floor and the rejected notes use `baseTotal`, never the bonus. `ranking[]` records `baseTotal`, `purposeBonus` and `purpose` for every idea.

## Gates, ranking, tie-breaks

* An idea is **ineligible** to win when feasibility < `minFeasibility`, safety < `minSafety`, clarity < `minClarity`, any judge raised a `blocker` flag on it, the novelty gate flags a conflict with history, its purpose is avoided today (`purpose-avoid`), or it is political while the 14-day politics cap is used up (`politicsAllowed` false). An idea the clarity judge did not score is not gated (one the safety or feasibility judge did not score is, see below). Ineligible ideas stay in the ranking, below all eligible ones.
* If nothing is eligible the best total is taken anyway and the notes say so loudly.
* Ties (totals within `tieEpsilon`): higher distinctness wins, then higher feasibility, then the lower id.
* Winner = rank 1. Runner-up = the best other eligible idea.

## Carry-over (at most one, CONTRACT 5.4)

The best non-winner that is `durable: true`, has not been carried before (its `origin.agent` is not `carryover`), was not vetoed, is eligible, and has `baseTotal` >= `carryMinTotal`, feasibility >= `carryMinFeasibility` and safety >= `carryMinSafety`. If none qualifies, nothing is carried and any previously saved idea is released. News-bound ideas are never carried.

## Critic's final check

Question: "Why would this embarrass us the moment it goes live?" By purpose: would a tool give a wrong answer, would a lesson teach a wrong thing, would the paywall claim embarrass us, could a stranger say what this is after ten seconds? The critic returns `approve` or `veto`. A veto counts only when it names a concrete blocker that scope-cutting in the spec cannot fix (a false core premise, a guardrail violation, a build that cannot work offline or in a day, or a premise so opaque that no plain title and intro would let a stranger say what it is) AND an eligible runner-up exists. A vague veto is overruled and its risks go to the spec as `mustFixInSpec`. One veto per day; the new winner gets a risk pass but no second veto.

**Mandatory judges.** `safety` and `feasibility` open eligibility gates, so a gap in either is never read as a pass. An idea that one of these judges skipped is ineligible ("unscored"). If a whole judge produced nothing after its retry, the critic challenge becomes mandatory (the budget and time guards do not apply), is told it is the only review of that criterion, and covers the winner and, after a veto, the runner-up; if it cannot run, or finds blockers with no alternative, the selection fails closed (`reason:"mandatory-judge-missing"`, nothing recorded) and the playbook retries or lowers the tier. A day that went through the stand-in is recorded in `winnerNotes.unscoredMandatory`.

## Scoring anchors (every judge uses these)

Calibration: use the whole scale, at most 3 ideas share a score, an honest 3 beats a polite 6. Judge the idea as researched, not the pitch prose. Cite something concrete from the dossier. Judge each idea for its own purpose (`fingerprint.purpose`): a tool, a lesson and a game earn the same score in different ways.

### sophistication (depth that can be discovered)
Depth is discoverable, never required: depth a newcomer must climb before the first success earns nothing. For a tool, depth is correctness and completeness against the paid equivalents (edge cases, units, locales, big inputs); for a lesson, how far the visitor's mental model changes (a ladder of demos, worked examples).
* 2: a toy or a facts page; one trick; nothing to discover after a minute; or depth a newcomer must master before anything works.
* 5: a solid interactive with one good idea; real logic but shallow.
* 8: systemic depth (simulation, solver, exact algorithm, scoring engine, generative system) that unfolds step by step; minute one already works and minute ten still reveals things.
* 10: an indie-grade tool, lesson or game; the engine itself is the delight; every layer is optional; you can see how it could reach 700+ honest lines.

### delight (joy and shareability)
For a tool: it saves a real hour and gets bookmarked. For a lesson: the aha moment.
* 2: dry, reads like homework.
* 5: pleasant, competent, forgettable.
* 8: a clear hook in ten seconds and at least one moment worth a screenshot (a tool: the moment it saves you real time; a lesson: the aha).
* 10: instantly quotable and shareable, or bookmarked on first use; voice, surprise and replay value; the owner grins.

### distinctness (and variety)
The purpose is part of variety: compare it with the purposes in the history digest and the mix summary.
* 2: a near-repeat of a past build, or a twin of another idea in today's pool.
* 5: a fresh angle on a familiar shape.
* 8: clearly different in subject, purpose and mechanic from the last ~14 days, and from its siblings today; helps fill an owed slot or a wanted purpose.
* 10: nothing like it has shipped or is in the pool; widens what the site is.

### feasibility (one day, team of 8, offline)
* 2: would not finish, or depends on data/tech we cannot bundle.
* 5: doable only with ruthless cuts; real risk of a thin result.
* 8: clearly doable to the CONTRACT 11 bar with margin; data bundled or generated.
* 10: obviously doable, well understood, parallelizes across the whole team.

### timeliness (freshness)
"Verified" is defined in `ops/rubrics/research.md`: a page really opened, or two independent search results that agree (WebFetch mostly fails in the cloud, so search-only evidence counts). Judge the dates and the `verification.evidence` field, not the label alone.
* 2: stale, dated or the hook is thin or unverified.
* 5: neutral; neither topical nor especially timeless.
* 8: a verified current hook, or a clearly evergreen premise with charm.
* 10: perfectly timed today, or timeless in a way that rewards a visit next year.

### interestFit (the owner's loves, weighed lightly)
Owner loves: poker ranges and GTO, Balatro and mods, hockey, Reddit-born ideas. The owner also loves useful tools and well-explained niche concepts: a faithful free version of a gated tool, a lesson on a niche concept, and a simple game with a familiar hook like day 3 are all perfect matches. Variety still wins.
* 2: clashes with the owner's taste.
* 5: neutral (the right score for any great idea unrelated to the interests).
* 8: a real, specific connection that also stands on its own.
* 10: a perfect match that is also excellent.

### polishPotential (craft that can show)
* 2: visually inert; nothing to animate, light up or sound.
* 5: a decent canvas.
* 8: rich visual identity, motion and micro-interaction opportunities; a thumbnail that stops a scroll.
* 10: begs to be gorgeous; a strong first impression is almost guaranteed.

### safety (guardrails and honesty)
Read `ops/rubrics/safety.md`, including its clean-room rules for tools (an original implementation; no vendor names, logos, UI or proprietary data on the page; no claim of parity; "estimates, not advice" for money, health and legal maths; never a form that takes a real password, card, bank or identity number). Raise a `blocker` flag for anything that must not be built as pitched.
* 2: breaches a guardrail (real-money gambling, targeting a private person, impersonation, partisan advocacy, copyrighted media, personal data, a copy of a vendor's tool, a form that takes real credentials).
* 5: acceptable but needs explicit care in the spec (satire framing, labelled fiction, data provenance, the limits of a tool).
* 8: clean; every factual claim is sourced and dated.
* 10: clean and unusually well evidenced.

### clarity (can a stranger get it in ten seconds)
Judge `plainSentence`, `firstMinute` and `conceptsToLearn`, with the title and the pitch. A tool: the title and plain sentence say exactly what you will be able to do. A lesson: they say what you will understand.
* 2: the premise needs a paragraph; a metaphor or jargon hides what it is; 3 or more concepts before a first success.
* 5: clear after reading the pitch; one or two new concepts.
* 8: one plain sentence says it; a first success within 30 seconds without reading anything; at most one new concept.
* 10: a stranger states what it is after five seconds and does the right first thing unprompted.
