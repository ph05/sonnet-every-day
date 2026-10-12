# Quality rubric (QA critic, revise loops, builders' self-check)

The bar is CONTRACT section 11. A tier-1 project feels like something a person would bookmark or send to a friend. This file says how QA measures that and how defects are ranked. Nothing here is advisory for builders: build to it.

## Hard minimums (a miss is a defect)

* Tier 1: at least 700 lines of the project's own logic/CSS/HTML (tier 2: 350). Data files, vendor code and generated assets do not count. Padding (comments, blank-line stretching, dead code) does not count.
* Real depth for the page's purpose (`fingerprint.purpose`): a tool correct and complete for its job, a lesson that changes how the visitor sees one concept, an explorer that answers real questions on sourced data, a studio whose output is worth keeping, a game with a clear core loop. Not a lorem-ipsum toy.
* Zero console errors and zero page errors in `browser-check.mjs`, desktop and mobile, light and dark, including the monkey run. No failed requests, no non-local requests, no horizontal overflow at 390px (and 320px).
* Works offline from a static server. The CSP meta from the page shell is intact. No external resources.
* Keyboard and touch support for every action; visible focus; sensible tab order; `Escape`/`Enter`/`Space` behave as users expect.
* Responsive down to 360px; follows `prefers-color-scheme`; honors `prefers-reduced-motion`.
* Check one short desktop window too, 1280x650 (a laptop with browser toolbars): no control overlaps text or another control, and the primary button is on screen. The browser-check shots are only 1280x800 and 390x844, and on 2026-10-12 a button-over-text S2 shipped on windows 1280 px wide and under about 720 px tall.
* At 1366x768 and 390x844 the main output stays in view while its controls are used, and the result of the main action appears without scrolling. No inner scroller crops the output: a wheel over it scrolls the page unless it zooms on purpose. The intro sits above the app; "without scrolling" is measured from the app's first control. `browser-check.mjs` shots are static and its monkey wheels assert nothing, so builders and QA test both with a Playwright script (scroll each control into view and compare element rects; `mouse.wheel` over the output and compare `scrollY`).
* Deterministic where it should be (seeded randomness; same seed, same result). Shareable state in the URL hash where it makes sense, and the hash is validated defensively.
* Empty, loading and error states exist and read well. Nothing says "TODO", "lorem", "placeholder", "example.com", "Project Title".
* An "About & making of" panel with the day's research sources (only `verified:true` ones: an opened page, two independent agreeing results or the primary source's own page), honest about what is simulated or unverified. A fact whose source is unverified appears as "as of <date>, per <source>" or not at all, never as plain fact.
* A great first frame that shows a result, not only inputs. The element that shows the sample result or the running demo carries `data-sed-result`, its top within 560 px at 1280x800 and its first line inside the 390x844 phone screen (browser-check warns `first-frame-unmarked` or `first-frame-late`), so the thumbnail (1200x630 desktop-light, taken at packaging) shows the product, not the intro. `window.__sedThumbReady` is used when the first frame needs time.
* Copy has voice. Labels are specific. Numbers carry units and dates. No typos.
* **The intro.** A `p.sed-intro[data-sed-intro]` right under the tagline: 35 to 70 words of plain text saying what this is, who it is for and what to do first. Its first sentence names the literal thing and what it does in the visitor's own terms ("A calculator that ...", "A lesson on ..."); at most two jargon terms, each glossed in parentheses. The tagline names the literal thing as its hook or payoff in plain words, never as a metaphor or a repeat of that first sentence. An intro that does not describe the page is S2 "intro inaccurate".
* **The explainer.** A `section.sed-explainer[data-sed-explainer]` written for a curious non-expert, with the words and headings `config.json` `pageContract.explainer` sets for the purpose, every word teaching (no restated intro, no filler). Every term is defined where it first appears, on the first screen with a plain gloss, never a button; worked examples are computed by a script; no figure is unsourced. The intro, the explainer and a lesson's `data-sed-check` exercises are static markup in `index.html`.
* **The clarity bar** (`ops/OWNER.md`). A stranger says what it is after ten seconds and reaches a first success within thirty without reading anything, with at most two new concepts before it. The first frame shows the thing working: a demo running, or a sample input filled in with its result. At most 8 controls are visible in the first viewport at 1280x800 (every visible button, input, select, slider, tab, toggle, summary, button-styled link and element made focusable with `tabindex`; `browser-check.mjs` warns above 8, an S2, and fails above 14); the rest sit behind a "More" toggle. QA's stranger cold read (a curious adult who never worked in the subject) enforces it: the first screen is opaque (S2) when the stranger's answer does not match the idea's plain sentence or is vague, they would not take the first step, their confidence is 2 of 5 or less, or three or more terms were not understood.
* **Per purpose.** A tool passes at least 8 known-answer cases in `window.__sedSelfTest` (`selftest.js`), each expected value copied from a named source or computed by a script and labelled, never edited to make a case pass; it shows the same result after any sequence of inputs as on a fresh load, validates its input, copies or exports its result and prints its limits. A lesson has at least 2 exercises that apply its rules to new cases, and every demo the text describes shows what the text says. An explorer's data points match their sources.

## Dimensions (the critic scores each 0 to 10 and writes one line of evidence)

Anchors: 2 = clearly deficient, 5 = acceptable but unremarkable, 8 = strong, 10 = exceptional.

1. **Core loop and depth.** 2: one trick, nothing to learn. 5: works, shallow. 8: several interacting systems; minute ten still teaches. 10: the engine itself delights. Read it through the purpose: a tool's depth is completeness and correctness against the paid equivalents (edge cases, units, locales, big inputs); a lesson's is how far the visitor's mental model moves (a ladder of demos, worked examples); an explorer's is the questions it answers; a studio's is output worth keeping. Depth is discoverable, never required before the first success.
2. **Correctness and robustness.** 2: wrong results or states that break (a tool's wrong output or a lesson's wrong statement is a 2). 5: correct on the happy path. 8: edge cases handled, invalid input and bad URL hashes degrade gracefully. 10: it is hard to find any wrong state even with the monkey.
3. **Visual design.** 2: default-browser look. 5: tidy and consistent. 8: a distinct identity, rhythm, hierarchy, tasteful use of the tokens. 10: memorable; screenshots well.
4. **Interaction and feel.** 2: static, silent, laggy. 5: responsive controls. 8: feedback on every action, thoughtful micro-interactions, motion with purpose, optional sound that starts muted. 10: tactile; you want to keep poking at it.
5. **Responsiveness and accessibility.** 2: breaks at 390px, unreadable contrast, keyboard trap. 5: usable everywhere. 8: designed for mobile and desktop separately, contrast AA, landmarks, labels, focus order, reduced motion handled. 10: genuinely inclusive; screen-reader text for dynamic changes.
6. **Copy, voice and honesty.** 2: generic or wrong. 5: clear. 8: distinct voice, microcopy that helps, sources dated and accurate. 10: you quote it to a friend.
7. **Performance and offline integrity.** 2: janky, heavy, or reaches the network. 5: fine. 8: smooth at 60fps on a mid phone, small payload, no long tasks. 10: effortless.
8. **First impression and shareability.** 2: blank or confusing first screen, or a metaphor that hides what it is. 5: clear purpose. 8: a stranger says what it is in 10 seconds, share/URL-state works, thumbnail sells it. 10: you send it to someone immediately.

## Severity

* **S1 (blocker).** The page is not shippable. The page does not load or render; any console or page error on load; a crash or hang in the monkey run; a CSP violation or any non-local request; an unplayable or wrong core loop; unusable at 390px (horizontal scroll, controls out of reach); a keyboard or touch path that makes an action impossible; a `validate.mjs` error; a missing About panel; placeholder copy; a guardrail or safety breach (`ops/rubrics/safety.md`); a fabricated or unverified claim presented as fact in the headline content; a wrong output a tool shows; a self-test vector changed or dropped from SPEC.md.
* **S2 (major).** The page ships worse without the fix. A flawed core loop (it works but is confusing, unbalanced or shallow in a visible way); a broken control or keyboard path; a visible layout bug; a serious accessibility failure (contrast, no visible focus, unlabelled controls, motion that ignores reduced-motion); a factual error or unsourced claim shown as fact; a dead or wrong source link; an intro or explainer that is missing (the validator makes it an S1 once the contract applies) or an intro that does not describe the page ("intro inaccurate"); an opaque first screen (the stranger cold read); more than 8 controls on the first screen (browser-check `controls-many`; above 14 it is the S1 `controls-excess`); a first frame with no result or running demo; a result that differs from a fresh load of the same inputs; a demo that does not show what the text says; a wrong statement or an unsourced figure in the explainer; sluggish input (over 100 ms); a missing required feature from SPEC; a tier minimum for lines of code missed.
* **S3 (minor polish).** Spacing, easing, a missing hover state, small copy tightening, an extra easter egg; a term used before it is defined (three or more on the first screen make the S2 opaque first screen); a check question whose answer is stated beside it.
* **S4 (nit).** Cosmetic trivia not worth a loop; also used for unverifiable items such as a source link that timed out from our network.

Rank by what a visitor feels in the first minute, not by how easy the fix is. When two things are equally bad, the one the visitor meets first is the higher severity. Revise loops work on S1 and S2 first, and on a compact day with four or more S3 on those too, after the rest; S4 is never worth a loop. A loop only reaches the page when it leaves the page strictly better.

## Defect record

Each defect: `{id, severity, owner, file, title, detail, evidence, suggestedFix}`.
* `id` is `d01`, `d02`, ... (the QA workflow renumbers after merging all sources).
* `owner` is whoever owns `file` in `spec/OWNERSHIP.json` (one of artisan, engineer, pulse, cards, lab, jester, architect). A defect about wiring between files belongs to `architect`.
* `file` is the path relative to the site directory (`work/<date>/build/site/`); the root cause, not the symptom.
* `title` is under ten words; `detail` says what is wrong and why it matters.
* `evidence` is exact: viewport, scheme, steps, observed vs expected. If you could not reproduce twice, say so and lower the severity.
* `suggestedFix` is concrete enough that the owner can act without asking.
* Every `browser-check` error is a defect (S1) unless it is demonstrably a false positive, in which case say why.

## Verdict

* `ship`: no S1, no S2.
* `revise`: any S1 or S2 that the owners can fix within the revise loops. This is the normal verdict when there is work to do.
* `block`: rare. The page is fundamentally broken (does not load, core loop absent or unfixably wrong, or an unfixable guardrail breach) such that the revise loops cannot save it. A block needs at least one S1 and a sentence on why fixing is hopeless.

Be adversarial and fair. Praise what is genuinely great (it feeds the making-of), and do not invent defects to look thorough.
