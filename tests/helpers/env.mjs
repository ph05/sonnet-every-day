// Importing this module isolates git from the machine it runs on (signing programs, identity, hooks,
// system config) for the whole test process, and offers fixed-instant helpers for America/New_York.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { localParts } from '../../scripts/lib/common.mjs';

// Every temp dir a test process makes is removed when that process exits (set SED_KEEP_TMP=1 to keep them for debugging),
// so repeated suite runs (the kaizen gate runs the suite on every attempt) cannot fill the disk (FM-05).
const created = new Set();
process.once('exit', () => {
  if (process.env.SED_KEEP_TMP) return;
  for (const d of created) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sed-test-gitcfg-'));
created.add(dir);
export const GIT_GLOBAL_CONFIG = path.join(dir, 'gitconfig');
fs.writeFileSync(
  GIT_GLOBAL_CONFIG,
  '[user]\n\tname = SED Test\n\temail = sed-test@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[advice]\n\tdetachedHead = false\n',
);
process.env.GIT_CONFIG_GLOBAL = GIT_GLOBAL_CONFIG;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_TERMINAL_PROMPT = '0';
process.env.GIT_AUTHOR_NAME = 'SED Test';
process.env.GIT_AUTHOR_EMAIL = 'sed-test@example.invalid';
process.env.GIT_COMMITTER_NAME = 'SED Test';
process.env.GIT_COMMITTER_EMAIL = 'sed-test@example.invalid';
delete process.env.SED_ROOT;
delete process.env.SED_NOW;
delete process.env.SED_NO_SLEEP;
delete process.env.SED_HB_DIR;

export const TZ = 'America/New_York';

/** The real instant at which it is `hhmm` local time on `date` in America/New_York (DST aware). */
export function etInstant(date, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  for (const offsetHours of [4, 5]) {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCHours(h + offsetHours, m, 0, 0);
    const lp = localParts(d, TZ);
    if (lp.date === date && lp.time === hhmm) return d;
  }
  throw new Error(`no such local time ${date} ${hhmm}`);
}
export const etIso = (date, hhmm) => etInstant(date, hhmm).toISOString();

/** `minutes` after the instant `iso`. */
export const plusMinutes = (iso, minutes) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();

export function tmpDir(prefix = 'sed-test-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.add(d);
  return d;
}
