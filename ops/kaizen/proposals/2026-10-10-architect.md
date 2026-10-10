Status: applied in round 4 (scripts/qa/browser-check.mjs isTopLevelNavigation(); a frameless navigation counts as top-level, not false; tests in tests/qa.test.mjs)

# Proposal: QA: guard req.frame() in the browser-check route handler so a frameless request cannot kill the run

- from: architect
- date: 2026-10-10
- category: proposal
- status: proposed for the owner; never auto-applied

# Proposal: guard the request frame lookup in the QA route handler

## What
In scripts/qa/browser-check.mjs (protected path), the context-wide route handler computes
`const top = req.isNavigationRequest() && !req.frame().parentFrame();` (line 720).
Replace it with a guarded lookup that treats a request with no resolvable frame as a non-top-level request:

    let top = false;
    try { top = req.isNavigationRequest() && !req.frame().parentFrame(); } catch { /* no frame yet (popup, worker): not a top-level navigation of the page under test */ }

## Why
The handler is registered with ctx.route('**/*', ...) so it sees every request of every page, including popups
and workers. Playwright documents that request.frame() can throw when a request has no associated frame (for example
service worker requests). An exception thrown inside a route handler is not caught by the handler's own .catch() calls
(those only wrap route.continue and route.abort), so one such request can end the whole check with no report.
A friction note of the QA lane on 2026-10-10 reports exactly this for a monkey click on a target=_blank link
(one seed died, two did not), which is the nondeterminism a QA gate must not have. I could verify the line is unguarded
(grep -n "req.frame()" scripts/qa/browser-check.mjs shows only line 720); I could not reproduce the crash myself, so the
failing seed is a claim from the note, not something I ran.

## Evidence
- scripts/qa/browser-check.mjs:720 unguarded call.
- Friction note (data, from an earlier agent): seed 222 died, seeds 11 and 3333 did not.

## Safety
Only widens what is tolerated for an unresolvable frame; the origin classification (recordRequest/classify) is unchanged,
so a non-local request is still aborted and reported. Add a unit test only if a fake request object that throws from frame() can be passed to the handler.
