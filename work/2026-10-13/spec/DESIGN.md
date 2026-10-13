# DESIGN: Historical Date Converter

**Look.** A tear-off wall-calendar leaf on warm paper. Sepia ink is the old (Julian) calendar, teal ink is today's (Gregorian) calendar, red is what was torn out. System fonts and inline SVG only; the month grid is the one hero picture.

## Tokens

On `:root` in style.css, flipped under `prefers-color-scheme: dark`. Starred names are the shell's; keep them.

| token | light | dark | use |
|---|---|---|---|
| --bg* | #f4eee1 | #15120d | page paper |
| --surface* | #fffcf5 | #1f1b14 | cards, fields, leaf |
| --fg* | #211c15 | #f1eadb | text |
| --muted* | #5d5444 | #b6ac98 | hints, captions |
| --border* | #d9cfba | #3a3326 | hairlines |
| --accent* | #0c6b66 | #62cfc4 | today's calendar, buttons, links |
| --accent-fg* | #ffffff | #0d1a18 | text on accent |
| --ring* | #1f6feb | #79b8ff | focus ring, 3px |
| --julian | #8f4f0f | #e3a95b | old-calendar ink |
| --julian-bg | #f6e6cc | #3a2b14 | old-calendar wash |
| --gap | #b3261e | #ff8f82 | dropped days, tear |
| --gap-bg | #fbe3df | #3d1f1b | skipped-result wash |
| --greg-bg | #dcefec | #12302d | real-day wash |

Computed contrast: at least 5.2:1 in light and 6.5:1 in dark for every text pair. Palette for project.json: #f4eee1, #0c6b66, #8f4f0f, #b3261e, #211c15, #fffcf5, #15120d.

## Type, space, shape

`--font` from the shell; `--font-serif: ui-serif, Georgia, "Iowan Old Style", "Palatino Linotype", serif` for the result headline and grid title. Body 1rem/1.6; labels 0.875rem 600; hints 0.8125rem muted; headline clamp(1.25rem, 1.05rem + 1vw, 1.75rem) serif 600; grid numerals 1rem tabular; formulas mono 0.875rem. Spacing 4, 8, 12, 16, 24, 32, 48. Radius 14 cards, 10 fields and buttons, 8 grid cells; 1px borders; shadow on the result card only; 44px tap targets.

## Components

Form card; More panel; custom-switch box (inset, dashed); result card with a top toolbar (badge, Sample tag, Copy result, Show the steps), headline, detail lines, two reading rows (sepia and teal dots), year box, caption; calendar leaf (title, weekday header, 7-column cells, two punched holes in SVG); gap treatment (zig-zag torn edges on the cells either side, red label, struck-through ghost chips for the dropped days with the typed one filled red); steps panel (numbered, mono formulas); About table; inline copy status.

## Layout

* 1280 and up: container 1200; a 300px form card and a fluid result card holding a text column and a 340px leaf column. Everything above the app ends by 330px, so at 1280x650 and 1366x768 the fields, the toolbar and the first two headline lines are on screen.
* 768: one column; the form card is a wrapped row; the result card keeps two columns (text, 300px leaf).
* 360 to 480: one column; Day 64px, Month fluid, Year 84px in one row; Place, Famous and More full width; toolbar buttons side by side; leaf full width with cells about 44px. Intro ends by 560px, the card starts above 844px, no horizontal scroll down to 320px.

## Motion

Result change: 140ms ease-out fade with a 6px rise. Month change: leaf flip (rotateX -70deg to 0, origin top, 260ms cubic-bezier(.2,.7,.2,1)), optional. Gap edges draw in over 280ms after 80ms. Focus cell pulse 1, 1.08, 1 over 120ms. Panels 180ms ease-out. Reduced motion: no transforms or delays, instant swaps. The first render does not animate, so the thumbnail is final.

## Icons and sound

Inline SVG, 20px, stroke 1.75, `currentColor`, `aria-hidden`: copy, list, chevron, punched holes. No sound.

## Voice and microcopy

Warm, plain, past tense for history, second person for actions. Labels: Day, Month, Year (as written), Place, Try a famous date..., Copy result, Show the steps / Hide the steps, More options / Fewer options, Read my date as, Count the days to another date, Copy link to this date, Check this tool against known answers. Badges: Never existed there, A real day, Check the date; tag Sample. Status: Copied. / Link copied. / Could not copy. Select the text and copy it yourself. / Not run yet. / All 29 checks passed. Limits note: One switch day per place. Not genealogical or legal proof. Read the limits. Error and result sentences: SPEC.md 4.6 and 7, word for word. Share text: the copy text of 4.6.

## First frame and thumbnail

Before any input: Day 13, October, 1582, Rome and most of Italy; a red-washed card "13 October 1582 never happened in Rome." with the jump sentence, two reading rows and the dated caption; beside it the October 1582 leaf: 1 to 4, a torn red gap, 15 to 31 with the weekdays running through, ghost chips 5 to 14 with the 13 filled red. The 1200x630 thumbnail (desktop, light, scrolled so the app fills the frame) shows exactly this, with no intro text.
