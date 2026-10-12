# Engineer, revise loop 1 (2026-10-12)

Assigned: d03 [S3] js/game.js, "Bot lap can claim you beat the challenge". Fixed. Nothing blocked, nothing left over.
Touched: js/game.js, test/selftest.mjs. share.js, sim.js, bot.js and main.js are unchanged.

## Root cause
finishRun() decided who answers a challenge by exclusion (`runMode !== 'practice'`), so the `auto` mode of a bot lap
(Watch a lap, or the `#a=` hook) was scored against the link's bar and the dialog said "You beat the challenge." or
"Not this time...". It now decides by inclusion (`runMode === 'timed'`), the same rule `lastTimed` and `recordBest`
already use. Bot and practice results keep `beat: null` (SPEC 4.3), and ui.js already hides `#res-challenge` when
`beat` is not a boolean. The challenge stays loaded, so the player's own timed lap afterwards is still compared.

## Share text (the second half of the record)
share.js is unchanged on purpose. The artisan's d04 fix in ui.js (`shareTextNow()`) already appends " · Bot lap" to
line 1 of the share text, for the textarea and for Copy result, and hides Copy link and Save card on a bot card. The
link inside a bot result's text carries no `c=`, because game.js only offers a bar for timed results. A `Bot lap · `
prefix in share.js, as the record suggested, would print the marker twice and widen the SPEC 4.8 format. If ui.js
ever drops its patch, the one place to add the marker is shareText() (prefix line 2 when `r.mode === 'auto'`), and the
ui.js patch has to go in the same change.

## Test (test/selftest.mjs, new group T5, about 0.1 s)
game.js had no Node test because it needs a page. T5 lends it a stand-in `document`, `window` and canvas, then plays
real laps through `boot()` and the actions:
- the `#a=` lap (hidden tab, so boot() plays the bot lap to its end) and Watch a lap (visible tab, bot at 2x on
  pumped frames), each on a `D-99999` and an `S-1` link: result mode `auto`, `beat` null, `app:finish` carries the
  same result, the challenge is still loaded, the shared link has no `c=`;
- then a timed lap on the same link: `beat` true for `D-99999`, false for `S-1`; a practice lap: null.
Negative control: the same test file against the original game.js fails four checks (beat true or false on bot laps)
and passes with the fix.

## Checks run
- `node --input-type=module --check` on game.js and selftest.mjs: ok.
- `node test/selftest.mjs`: ok, T1 to T5 in 9.9 s, exit 0.
- Chromium replay of the record's evidence on this working copy (1366x768, light): `#s=qa1&c=D-99999&a=mow` and
  `#s=qa1&c=S-1&a=mow` now show `#res-challenge` hidden, meta "Rink qa1 · Called it · Bot lap", share text line 1
  "Between Periods · rink qa1 · Bot lap". Watch a lap on a challenge link (63 s at 2x): same. A human timed lap still
  gets "You beat the challenge." and "Not this time: grade S in 1 ft is the bar.". No console errors, page errors or
  non-local requests. The same replay on build/site (read only) reproduces the original bug.
- `node scripts/qa/browser-check.mjs ... --no-monkey` on the working copy: ok, 0 errors, 0 warnings.
- `node scripts/validate.mjs project` finds the same 11 staging-copy errors before and after (no project.json,
  thumb.png or dated directory name in a revise copy, plus the source links that need project.json); none in my files.

## Premortem
None of today's three risks sits in this task's lane: the engineer item was about running the selfcheck before ideate,
and the layout item belongs to the builder. Nothing done.

## Seen outside my lane (no defect filed)
ui.js: the `app:finish` live-region line and the coach line in the done phase still read the grade stamp ("Nobody can
tell you were here.") for a bot lap. It is accurate about the grade and harmless; the artisan may want the bot wording
there too.

## Injection
No INJECTION ATTEMPT in the files I read (QA report, SPEC, DESIGN, premortem, rubrics).
