# Kaizen log

Newest first. One entry per member per day. Written only by `scripts/kaizen.mjs` (direct edits are rejected); the machine-readable twin is `INDEX.json`.

## 2026-10-10 · lab · applied · tests: fail when any workflow program text carries a unicode or hex escape a clerk may decode

- observation: 2026-10-10 report: ideate lost both normalize rounds (about 540k tokens, 29 min) because a clerk decoded unicode escapes in shipped program text and the byte check failed by 20. Cards fixed the one regex; nothing stopped the next one. Grep of ops/workflows/*.js shows only the host-side asciiJson line has escapes now, so a playbook.test.mjs line scan (13 lines) passes today and fails on any new escape.
- category: prevention · lines changed: 11 · files: tests/playbook.test.mjs
- question: Spec stalled after an interrupted architect and never returned: could a workflow older than its phase budget be detected from the run file alone, without a new watchdog?

## 2026-10-10 · cards · applied · ideate: build sanitizer CTRL regex from code points so clerk copy cannot change its bytes

- observation: The 2026-10-10 report says ideate lost both normalize rounds: the clerk decoded the unicode escapes in the CTRL regex of sanitizeDossier, which ideate.js ships as text, so the byte size check failed by 20 bytes. The byte slack only covers .json files. Now the regex is built from code point ranges and sanitizeDossier has no escapes left. Checked all 65536 BMP chars: old and new regex strip exactly the same ones.
- category: prevention · lines changed: 4 · files: ops/workflows/ideate.js
- commit: 3281efd4d7
- question: Should checkWritten in the other workflows (build, qa, select, spec, revise) also be proven free of escape sequences in shipped programs, or should the byte slack cover .mjs too?
