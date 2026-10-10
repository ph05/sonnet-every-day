// The e2e suite starts every world from a repo as a FRESH CLONE would have it on day 1: code, config and
// pristine seeds, no runtime output. The live working tree is not that after the first real publish (state/history.json
// has entries, the ledger and handoff exist, docs/ lists projects), so seeding from it verbatim made every
// "day 1" scenario fail from day 2 on and turned the kaizen gate (which refuses a red tree) into a permanent no.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { renderLog } from '../../scripts/kaizen.mjs';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'tests']);
/** Directories whose content is runtime output (published projects, the diary, a day's work, run state). */
export const RUNTIME_DIRS = ['docs/d', 'docs/kaizen', 'work', 'state/runs', 'state/ideas', 'state/reports', 'state/smoke', 'state/heartbeats', 'ops/kaizen/proposals'];
/** Single mutable files that exist only after real days have run. */
const RUNTIME_FILES = ['state/handoff.md'];

/** cpSync filter for a working tree rooted at `root`. */
export function repoFilter(root) {
  return (src) => {
    const rel = path.relative(root, src).split(path.sep).join('/');
    if (!rel) return true;
    if (rel.split('/').some((seg) => SKIP_DIRS.has(seg))) return false;
    if (RUNTIME_FILES.includes(rel)) return false;
    return !RUNTIME_DIRS.some((dir) => rel.startsWith(`${dir}/`) && !rel.endsWith('.gitkeep'));
  };
}

const json = (v) => JSON.stringify(v, null, 2) + '\n';

/** The empty seeds of every mutable file that is tracked (config.startDate is the day-1 date). */
export function pristineFiles(config) {
  return {
    'state/history.json': json({ schema: 1, startDate: config.startDate, entries: [] }),
    'state/carryover.json': json({ schema: 1, idea: null, savedOn: null, carriedCount: 0 }),
    'state/throttle.json': json({ schema: 1, level: 'balanced', cleanDays: 0, lastChange: null, log: [] }),
    'state/kaizen-queue.json': json({ schema: 1, skipped: [] }),
    'ops/kaizen/INDEX.json': json({ schema: 1, entries: [] }),
    'ops/kaizen/LOG.md': renderLog({ entries: [] }),
  };
}

/**
 * Copies the repo at `root` into `dest` as a day-1 checkout: runtime output dropped, mutable state reset to its
 * seeds, and the generated site (docs/ except docs/d) rebuilt from that empty state so it cannot list projects
 * that no longer exist.
 */
export function copyPristine(root, dest, config) {
  fs.cpSync(root, dest, { recursive: true, filter: repoFilter(root) });
  for (const [rel, content] of Object.entries(pristineFiles(config))) {
    fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
    fs.writeFileSync(path.join(dest, rel), content);
  }
  fs.mkdirSync(path.join(dest, 'docs', 'd'), { recursive: true });
  execFileSync(process.execPath, [path.join(dest, 'scripts', 'build-site.mjs')], {
    cwd: dest,
    env: { ...process.env, SED_ROOT: dest, SED_NOW: undefined },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}
