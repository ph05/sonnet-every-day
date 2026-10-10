# Artisan notes (2026-10-10)

Assumptions
- `.hand[data-hand]` is 1-based (hand number); `data-status` mirrors `deal[].status`.
- `share.hash` may or may not start with `#`; ui.js strips it and rebuilds the URL from `location.href` without its hash.
- Copy link copies share text plus URL once the round is finished, only the URL before that.
- Slots use `aria-disabled` (not `disabled`) after the last hand so keyboard focus is never lost; Play/Undo/Hint use `disabled`.
- Tab "Last hand" is selected after any state with a trace, "If you play now" after a swap or undo.
- Extra exports from art.js (`JOKER_NAME`, `CHALLENGE_NAME`, `COUPLING`, `cardName`) and `busy()` on the ring are artisan-internal.

Deviations
- Right column is not sticky (scope, result and card together are taller than a 800px viewport).
- Sandbox section sits after the card on phones; the Sandbox tab itself deals a new seed at once.

Verified with a headless Chromium pass against the real engine: 320/360/1280, light/dark, no overflow, no console output, keyboard grab/swap/undo/play, drag, touch tap-swap, reduced motion, sandbox deal, copy, hash replays for gold locks.
