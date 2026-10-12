// End-to-end scenarios, part "days": a primary that dies at every phase, the watchdogs and closers that take over (see tests/e2e.test.mjs).
globalThis.__sedE2ePart = 'days';
await import('./e2e.test.mjs');
