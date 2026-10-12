// End-to-end scenarios, part "closers": closer, grace and babysit, the deadman, double fires, late upgrades, DST, corrupt runs, carry-over
// over three days (see tests/e2e.test.mjs).
globalThis.__sedE2ePart = 'closers';
await import('./e2e.test.mjs');
