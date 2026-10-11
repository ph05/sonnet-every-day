# Orbital Knitwear: DESIGN

Idea: a satellite is a knitting needle, Earth is the fabric. Look: cozy craft table meets chart room. Linen cloth, wool ribbons, embroidered coastlines, running-stitch (dashed) borders. Owner of everything visual and all copy: artisan.

## Palette tokens (light / dark; the first colours become project.json "palette")
| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | #f3ede2 | #17151c | page |
| `--surface` | #fffaf0 | #221f2a | panels |
| `--fg` | #2a2631 | #efe9f7 | text (12.7:1 / 15:1) |
| `--muted` | #5f5868 | #b3aabf | secondary text (5.9:1 / 8:1) |
| `--border` | #d8cdb9 | #38334a | lines |
| `--accent` / `--accent-fg` | #a8321f / #fffaf0 | #ff8a6b / #1b1318 | primary buttons, links (5.7:1 / 7.8:1) |
| `--ring` | #1f6feb | #8ab4ff | focus |
| `--cloth` / `--cloth-hole` | #efe6d4 / #d9ccb3 | #262230 / #1d1a25 | bare fabric, unknit holes |
| `--land` / `--city` | #7a6a55 / #2a2631 | #9a8fb0 / #efe9f7 | embroidered outline, city dots |
| `--night` / `--grid` / `--glow` | rgb(30 24 60 / .28) / #c9bda6 / #fff3c4 | rgb(0 0 0 / .35) / #3a3548 / #ffe9a8 | night shading, graticule, fresh stitch |
| `--yarn-0` / `-1` / `-2` | #c9482f / #2a7b82 / #a87408 | #ff7a5c / #5cc6cc / #f2c14e | needles A, B, C (3:1 or better on cloth) |
Colour is never the only signal: needles also differ by marker shape (circle, square, diamond) and a letter A/B/C.

## Type, space, shape
System fonts only. `--font-display`: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif (h1, h2, card titles). Scale (rem): 0.75, 0.875, 1, 1.125, 1.375, 1.75, h1 clamp(1.9, 1.3 + 2.6vw, 3). Numerals tabular. Spacing 4 px base: 4, 8, 12, 16, 24, 32, 48. Radius 14 (panels), 10 (buttons), 999 (chips). Borders 1 px solid `--border`; cards, empty states and the preview use `2px dashed` running-stitch borders. Targets at least 44 px.

## Components
Stage (map, overlay, HUD chips "Planet 61% · Map 74%"), playback bar, needle chips, slider row (label, live value, lock icon, tick marks on Height), action buttons, readout list (`dl`), twin meters (planet bar over map bar so the gap reads as the lie), card list items (title, blurb, best badge), goal panel with progress, toast, About, loading skeleton, fatal panel.

## Layout
* **360:** one column: stage (2:1), HUD chips, playback bar, then a tab bar Orbit / Cards / Score (`role=tablist`, one panel at a time). No horizontal scroll down to 320.
* **768:** stage full width; below it two columns: Orbit panel left; Cards and Score right (all visible, no tabs).
* **1280:** two columns, stage and playback and readouts left (fluid), a 400 px right rail with needles, sliders, actions, cards, score. Page max width 1360. Polar view is square (1:1), so the stage grows taller.

## Motion
Durations 120 ms (hover), 200 ms (state change), 360 ms (panel), 600 ms ("Bound off" ribbon). Easing `cubic-bezier(.2,.8,.2,1)`. Fresh stitches glow with `--glow` and fade over a quarter of a simulated day; needle markers pulse a ring every 1.2 s; never more than 3 flashes per second. **Reduced motion:** no glow fade, no pulse, no ribbon animation (a static banner), transitions near zero, preview track static, autoplay off.

## Icons and sound
Inline SVG sprite (`<symbol>`, 24 px viewBox, stroke 1.75, round caps, `currentColor`, shown at 20 px); icon-only buttons carry `aria-label` and `title`. **No sound.**

## Voice and microcopy
Cozy, dry, second person; knitting words for actions (cast on, bind off, dropped stitch, Frog it), plain words and units for numbers; never claims real satellite data. No emoji.
* Labels: sliders Height (perigee), Tilt, Stretch, Start longitude, Perigee turn, Swath width, Sun date; needles "Needle A/B/C"; buttons Play, Pause, +1 day, Frog it, Tune sun-sync, Snap to a repeat height, Surprise me, Copy link, Peek at par, Free knit, Add needle, Remove needle, Flat map, Polar view, Night shading. Readouts: Orbit time, Highest point, Node drift, Local time at node, Orbits per day, Track shift per orbit, Repeat, Farthest latitude, Sun-synchronous. Score: Planet covered, Map looks covered, Overlap waste, Mean revisit, Local-time drift. Units always shown ("700 km", "98.19 degrees"). Slider `aria-valuetext` repeats value and unit.
* `#sc-lie`: "The flat map looks {map}% covered; the planet is {planet}%." When within 1 point: "The map and the planet agree for once: {planet}%."
* States: loading "Casting on..."; empty "Press play, or nudge a slider, to start knitting."; fatal "The yarn snapped: {message}. Reload to cast on again."; success "Bound off! {Badge}: {score} points (par {par})." with badges Swatch, Sweater, Heirloom; miss "{short} points short of a pass." plus the card hint.
* Map label: "World map being knitted: day {d}, planet {planet}% covered, flat map {map}% covered."
* **Toast keys (closed list; copy):** `shareCopied` "Link copied. Anyone who opens it gets your exact needles." · `shareManual` "Couldn't reach the clipboard. The link is in the box below." · `badLink` "Part of that link didn't make sense, so I used safe defaults." · `storageOff` "Can't save your best badges in this browser. Everything else works." · `locked` "{param} is fixed by this card." · `tooLow` "Height raised to 200 km, the lowest this toy allows." · `tooHigh` "Orbit shortened: apogee is capped at 60,000 km (the model has no Moon)." · `ssoNone` "No sun-synchronous tilt exists at this height and shape." · `tuned` "Tilted to {inc} degrees: the orbit now turns with the sun." · `snapped` "Snapped to {alt} km: {k} orbits in {m} days, tracks {spacing} km apart." · `noRepeat` "No repeat height within 16 days near here." · `peeked` "Par setup loaded. Peeking means no badge this round." · `cardPassed` "Bound off! {badge}, {score} points." · `cardMissed` "{short} points short of a pass. Pull a loose thread and try again." · `newBest` "New personal best on this card." · `runReset` "Unravelled. Casting on again." · `maxSats` "Three needles is the most this frame holds." · `minSats` "A knitter needs at least one needle." · `randomized` "Shuffled. A fresh set of needles."

## Thumbnail composition (1200x630 from desktop-light 1280x800)
Title "Orbital Knitwear" and tagline top-left; the stage fills the frame below: cream linen with about four days of madder-red and teal ribbons crossing the continents, embroidered coastlines, night shading on the right third, needle markers with pulse rings, HUD chips top-left over the map. No toast, no focus ring, About closed. `__sedThumbReady` resolves after the pre-rolled first frame.
