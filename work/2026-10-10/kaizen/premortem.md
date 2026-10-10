# Premortem 2026-10-10

The critic's three ways today could go wrong, each with one cheap thing to do about it.

- Ideate may return only 7 to 9 verified ideas (FM-82), because WebFetch fails in the cloud and the novelty gate has no past projects to compare against. Mitigation: scouts search for each claim twice and record a second independent result at once, so verified:true survives and shortlist.json reach...
- Tier 1 spec scope could outgrow the day's budget, and spec would quietly drop to a compact Tier 2 mini-spec (FM-83) that build and QA then mismatch. Mitigation: the architect states a line-count target and cuts scope at spec time, and the operator reads compact/tier from spec/DONE.json before lau...
- Nothing is on main yet, so the 09:40 deadman Action is dormant (FM-75) and today's first sync push to claude/sonnet-every-day has no tested history. Mitigation: the first lane to finish runs sync early and reports ok:false immediately, so push or lease trouble is found hours before 08:00.
