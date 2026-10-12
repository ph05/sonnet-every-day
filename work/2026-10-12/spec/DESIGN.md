# Between Periods: DESIGN (artisan's brief; SPEC.md section 4 is the contract)

**Feel**: a cozy, dry-witted rink-crew night shift. Calm paper-ice colours, one warm accent (the machine), crisp line work. The ice stays light in both colour schemes ("ice under arena lights"); only the page chrome and the apron flip.

## Tokens (`project.json` "palette" = light bg `#e9f1f5`, accent `#0b6e82`, machine `#f2a900`, ink `#12212b`, dark bg `#0b1820`, dark accent `#5fd3e8`, red line `#c8412f`, blue line `#2b5fb4`)
| token | light | dark |
|---|---|---|
| `--bg` | `#e9f1f5` | `#0b1820` |
| `--surface` | `#ffffff` | `#12252f` |
| `--fg` | `#12212b` | `#e8f2f6` |
| `--muted` | `#4a5d69` | `#9db3bf` |
| `--border` | `#c3d3dc` | `#24404d` |
| `--accent` (links, primary buttons) / `--accent-fg` | `#0b6e82` / `#ffffff` | `#5fd3e8` / `#06222b` |
| `--ring` | `#1f6feb` | `#79b8ff` |
| `--rk-ice` / `--rk-dull` | `#f4fafc` / `#c9d8e0` | `#cfe3ec` / `#9fb6c2` |
| `--rk-gleam` (highlight) / glow | `#ffffff` / `#bfeeff` | same |
| `--rk-scar` (all scar types, darker than ice) | `#4d6678` | `#2f4658` |
| `--rk-red` / `--rk-blue` (rink lines) | `#c8412f` / `#2b5fb4` | same |
| `--rk-machine` (mustard) / charcoal `--rk-ink` | `#f2a900` / `#2a2f33` | same |
| `--rk-water` / `--rk-apron` | `#3fb6d1` / `#cfdde5` | `#3fb6d1` / `#0f2230` |

Type: system stack from the shell; scale 12, 14, 16, 20, 28 px and an h1 of `clamp(1.5rem, 1rem + 2vw, 2.6rem)`; HUD numerals in `--font-mono`, 600, tabular. Spacing 4, 8, 12, 16, 24, 32. Shape: radii echo the rink corners (cards 14, buttons 10, chips 999); 2 px borders; focus ring 3 px `--ring`. Scars differ by shape as well as luminance: grooves are thin curved lines, divots dotted discs, snow ridges hatched ovals, hats little hat glyphs.

## Components
Primary and quiet buttons (44 px min, toggle state through `aria-pressed` plus an icon change); HUD chips (label over value); tank gauge (vertical in the portrait stage, horizontal otherwise; ticks at 25, 50, 75; low = diagonal stripes plus amber outline, dry = empty with a drop-slash icon, never colour alone); clock; gleam meter; coach line; toast stack; challenge banner; seed group; "Demo lap" chip; pause veil; result dialog (rubber-stamp grade letter, stats list, postcard, share buttons); About panel from the shell.

## Layout (the rink, tank, clock and primary button always share one viewport)
* **360 to 767**: portrait stage as a three-column grid, tank gauge | rink (drawn rotated, long axis vertical, fills the remaining height) | readouts (clock, gleam, laps, distance). Coach line, then a 44 px control bar that changes with `data-phase` (ready: Start, Practice, Watch; playing: Pause, Slow, Sound, Call it). The tagline hides when the viewport is under 700 px tall. Seed group and rink info sit below the bar.
* **768 to 1279**: one column; chip row, landscape rink (box 200:85, height capped at `100dvh - 230px`), control bar with the coach line on the left.
* **1280 and up**: same, content width up to 1400 px, bigger type; seed group and best result to the right of the control bar.

## Motion
UI: 120 ms ease-out for hover and press; dialog 180 ms fade plus scale .98 to 1; toasts 160 ms in, 3.5 s hold (errors 6 s), 160 ms out; HUD numbers never animate. Canvas: sheen is a wet film on the last 48 path segments, alpha .8 to 0 over 2.2 s, handing over to the glossy cell; bump shake at most 5 px for 120 ms (`prefs.shake`); milestone sparkle 300 ms, at most one per second; final buff sweep 900 ms ease-in-out; confetti 1.4 s for S and A only; tank-low pulse is an outline at 1.2 s period (under 3 flashes per second, no full-screen flash anywhere). **Reduced motion**: no shake, sparkle or confetti, instant sheen and buff, attract frozen on its half-gleaming frame, instant toasts, static stripes for tank-low.

## Icons and sound
Icons are one inline SVG `<symbol>` sprite (24 px grid, 2 px round strokes, `currentColor`): play, pause, sound, mute, slow, door, copy, save, reset, eye, drop. Machine, hats and arcs are drawn in canvas code. The favicon is an inline SVG data URI. Sound is WebAudio only, master gain .15, muted by default behind a visible toggle: hum (triangle 58 Hz plus filtered noise, level follows speed), start blip (660 Hz, 80 ms), tank-low double blip (440 then 330 Hz), refill sweep (220 to 440 Hz, 400 ms), bump thud (90 Hz plus a noise tick), milestone bell (784 Hz), buzzer (110 Hz square, lowpassed, 600 ms) and the finish chime D5, A5, F#5 (587, 880, 740 Hz, 180 ms apart; never G-E-C).

## Voice and microcopy (artisan owns every string; events only carry codes)
Dry, short, second person, kind to the player, units on every number. Never "swath", "overlap waste", "true area", "first", "new", "ghost"; never the maker's name.
* Labels: Start intermission, Practice (no clock), Watch a lap, Pause, Resume, Slow, Sound on/off, Guides on/off, Shake on/off, Call it, Again, Today's rink, Load rink, Copy result, Copy link, Save card, Close; HUD: Time (Elapsed in practice), Water, Gleam, Clean laps, Distance.
* Coach: ready "Cover every scar before the buzzer. Steer with ← → or A D, or drag on the rink." Demo "Demo lap. Press Enter to take the wheel." First run "The machine only goes forward. Turns need room." Low "Water is low. The refill door is the gap in the boards." Dry "Tank dry: passes only shave now. Refill at the door." Practice "Practice lap. No clock, same rink." Paused "Paused."
* Toasts: "Refilling…", "Tank full.", "Boards. The machine does not enjoy that." (first bump, then every fifth), "A quarter gleams.", "Half the sheet shines.", "Three quarters. Nearly skate-ready.", "That link looked odd, so you got today's rink.", "Seeds are 1 to 24 letters, digits, - or _.", "Can't save settings here. Everything else works.", "Bot lap at fast forward. Press any key to take over.", "Challenge loaded: grade A in 1,384 ft or less."
* Grades: S Mirror "Skate-ready. Nobody can tell you were here." A Glass "Fast and clean. The crowd approves." B Sheen "Solid. A few scars survived." C Matte "Passable. The first period will leave marks." D Slush "The next period will be interesting." Challenge: "You beat the challenge." / "Not this time: grade A in 1,384 ft is the bar."
* Empty and error: best "None yet"; loading "Wheeling out the machine…"; fatal "The rink would not load (reason). Reload to try again."; frame error "Something slipped on the ice. Restart the lap."; no audio, title "Sound unavailable in this browser".
* Mishap line: "Mishap: leaky tank (invented)." (also hat-trick aftermath, slush patch, jammed gate with the refill door moved, puddle by the boards). Rink info: "Rink 2026-10-12. Daily rinks use the UTC date; type another seed for a different sheet."
* Share text: exactly SPEC 4.8.

## Thumbnail (1200x630, light scheme, first frame)
Header strip with the back link; "Between Periods" top left; chips "Time 1:52, Water 68%, Gleam 41%" and the "Demo lap" chip on one row; the rink at least 900 px wide, centred: half the sheet already glossy (white with a cyan glow), the other half still dark slate scars, red centre line, blue lines, faceoff circles; the mustard-and-charcoal machine around 40 percent along with a bright wet sheen trail behind it and the refill door visible in the near boards; nothing overlaps the rink.
