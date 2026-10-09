# Selection rubric (judges, aggregator, critic)

Used by `ops/workflows/select.js`. Eight judges each score ALL shortlisted ideas on ONE criterion, 0 to 10 (one decimal allowed), with a one-line concrete reason per idea. The script (not an agent) computes the weighted total, applies the gates, ranks, and picks the winner and at most one carry-over. A critic then makes a last adversarial check of the winner and may veto once.

## Machine-readable settings

`ops/workflows/select.js` carries the same numbers; `ops/workflows/_selfcheck.mjs` fails if they ever differ. Change both together.

```json weights
{
  "weights": {
    "sophistication": 1.6,
    "delight": 1.6,
    "distinctness": 2.0,
    "feasibility": 1.8,
    "timeliness": 0.6,
    "interestFit": 0.7,
    "polishPotential": 1.0,
    "safety": 1.0
  },
  "gates": {
    "minFeasibility": 5,
    "minSafety": 5,
    "carryMinTotal": 58,
    "carryMinFeasibility": 5,
    "carryMinSafety": 6,
    "tieEpsilon": 0.05
  }
}
```

`total` = weighted mean of the criteria that were scored, times 10, so it lives on 0 to 100. A criterion whose judge failed is left out and the remaining weights renormalize.

Why these weights: variety and finishability decide whether the project is worth having at all (distinctness 2.0, feasibility 1.8). Depth and delight are what the owner actually wants to see (1.6 each). Polish and safety are floors that matter at the margin. Interest fit is deliberately light because variety is paramount, and timeliness is light because an evergreen idea is as good as a topical one.

## Gates, ranking, tie-breaks

* An idea is **ineligible** to win when feasibility < `minFeasibility`, safety < `minSafety`, any judge raised a `blocker` flag on it, the novelty gate flags a conflict with history, or it is political while the 14-day politics cap is used up (`politicsAllowed` false). Ineligible ideas stay in the ranking, below all eligible ones.
* If nothing is eligible the best total is taken anyway and the notes say so loudly.
* Ties (totals within `tieEpsilon`): higher distinctness wins, then higher feasibility, then the lower id.
* Winner = rank 1. Runner-up = the best other eligible idea.

## Carry-over (at most one, CONTRACT 5.4)

The best non-winner that is `durable: true`, has not been carried before (its `origin.agent` is not `carryover`), was not vetoed, and has total >= `carryMinTotal`, feasibility >= `carryMinFeasibility` and safety >= `carryMinSafety`. If none qualifies, nothing is carried and any previously saved idea is released. News-bound ideas are never carried.

## Critic's final check

Question: "Why would this embarrass us at 8am?" The critic returns `approve` or `veto`. A veto counts only when it names a concrete blocker that scope-cutting in the spec cannot fix (a false core premise, a guardrail violation, a build that cannot work offline or in a day) AND an eligible runner-up exists. A vague veto is overruled and its risks go to the spec as `mustFixInSpec`. One veto per day; the new winner gets a risk pass but no second veto.

**Mandatory judges.** `safety` and `feasibility` open eligibility gates, so a gap in either is never read as a pass. An idea that one of these judges skipped is ineligible ("unscored"). If a whole judge produced nothing after its retry, the critic challenge becomes mandatory (the budget and time guards do not apply), is told it is the only review of that criterion, and covers the winner and, after a veto, the runner-up; if it cannot run, or finds blockers with no alternative, the selection fails closed (`reason:"mandatory-judge-missing"`, nothing recorded) and the playbook retries or lowers the tier. A day that went through the stand-in is recorded in `winnerNotes.unscoredMandatory`.

## Scoring anchors (every judge uses these)

Calibration: use the whole scale, at most 3 ideas share a score, an honest 3 beats a polite 6. Judge the idea as researched, not the pitch prose. Cite something concrete from the dossier.

### sophistication (depth of mechanic)
* 2: a toy or a facts page; one trick; nothing to discover after a minute.
* 5: a solid interactive with one good idea; real logic but shallow.
* 8: systemic depth (simulation, solver, scoring engine, generative system) with several interacting parts; minute ten still reveals things.
* 10: an indie-grade tool or game; the engine itself is the delight; you can see how it could reach 700+ honest lines.

### delight (joy and shareability)
* 2: dry, reads like homework.
* 5: pleasant, competent, forgettable.
* 8: a clear hook in ten seconds and at least one moment worth a screenshot.
* 10: instantly quotable and shareable; voice, surprise and replay value; the owner grins.

### distinctness (and variety)
* 2: a near-repeat of a past build, or a twin of another idea in today's pool.
* 5: a fresh angle on a familiar shape.
* 8: clearly different in subject and mechanic from the last ~14 days, and from its siblings today; helps fill an owed slot.
* 10: nothing like it has shipped or is in the pool; widens what the site is.

### feasibility (one day, team of 8, offline)
* 2: would not finish, or depends on data/tech we cannot bundle.
* 5: doable only with ruthless cuts; real risk of a thin result.
* 8: clearly doable to the CONTRACT 11 bar with margin; data bundled or generated.
* 10: obviously doable, well understood, parallelizes across the whole team.

### timeliness (freshness)
* 2: stale, dated or the hook is thin or unverified.
* 5: neutral; neither topical nor especially timeless.
* 8: a verified current hook, or a clearly evergreen premise with charm.
* 10: perfectly timed today, or timeless in a way that rewards a visit next year.

### interestFit (the owner's loves, weighed lightly)
Owner loves: poker ranges and GTO, Balatro and mods, hockey, Reddit-born ideas. Variety still wins.
* 2: clashes with the owner's taste.
* 5: neutral (the right score for any great idea unrelated to the interests).
* 8: a real, specific connection that also stands on its own.
* 10: a perfect match that is also excellent.

### polishPotential (craft that can show)
* 2: visually inert; nothing to animate, light up or sound.
* 5: a decent canvas.
* 8: rich visual identity, motion and micro-interaction opportunities; a thumbnail that stops a scroll.
* 10: begs to be gorgeous; a strong 8am first impression is almost guaranteed.

### safety (guardrails and honesty)
Read `ops/rubrics/safety.md`. Raise a `blocker` flag for anything that must not be built as pitched.
* 2: breaches a guardrail (real-money gambling, targeting a private person, impersonation, partisan advocacy, copyrighted media, personal data).
* 5: acceptable but needs explicit care in the spec (satire framing, labelled fiction, data provenance).
* 8: clean; every factual claim is sourced and dated.
* 10: clean and unusually well evidenced.
