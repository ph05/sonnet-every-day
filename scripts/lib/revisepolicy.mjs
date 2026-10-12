// Revise policy (PLAYBOOK 8.6 and 8.7): whether the revise phase runs, how many loops it gets, how deep it fixes, and what the
// operator records when it does not. `decideRevise` is the pure decision (the matrix tier x defect counts x level x minutes left
// is tested against it); `planRevise` gathers its inputs from the repo (QA report, run file, throttle with the owner override,
// clock) and is what `state.mjs revise plan` prints.
//
// The policy (config.revisePolicy, config.budget.levels.<level>.reviseLoopsTier2):
//   * A full build (tier 1) behaves as it always did: revise runs for any S1 or S2 (or queued extra defect), with levelConfig.reviseLoops.
//   * A compact day (tier 2) revises when the QA report has a defect at or above revisePolicy.tier2MinSeverity (default S2), or when its
//     S3 count reaches revisePolicy.tier2S3Threshold (default 4), with min(reviseLoopsTier2 of the effective level, maxLoopsHardCap) loops.
//     The loops fix in severity order (S1, then S2, then S3 when the S3 count triggered it).
//   * Revise is skipped only when nothing triggers it, or the planner says it does not fit (minutes), or the level has no loops for it.
//   * The S1 rescue is the floor and is never worse than before: an S1 (or a queued extra defect, which counts as S1) always gets at
//     least one loop that fixes S1 defects, at any level, as long as the planner of Appendix A4 says it fits. A build with an S1 that
//     could not be revised is not shippable (PLAYBOOK 8.6: Tier 3), `blocksShipping` says so.
import fs from 'node:fs';
import os from 'node:os';
import { rp, loadConfig, localParts } from './common.mjs';
import * as rs from './runstate.mjs';
import * as th from './throttle.mjs';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);

/** The severities a revise loop can be asked to fix (S4 nits are never worth a loop, ops/rubrics/quality.md). */
export const FIX_SEVERITIES = ['S1', 'S2', 'S3'];
const RANK = { S1: 0, S2: 1, S3: 2 };

/** The defaults of config.revisePolicy: a config without the block (or with a damaged entry) gets exactly these. */
export const DEFAULT_REVISE_POLICY = Object.freeze({
  tier2MinSeverity: 'S2',
  tier2S3Threshold: 4,
  minMinutesLeftForRevise: 25,
  maxLoopsHardCap: 3,
});

/** The most loops anything may run, whatever the config says: ops/workflows/revise.js clamps to the same number. */
export const MAX_LOOPS = 3;
/** One revise loop in minutes: ops/workflows/revise.js MINUTES.loop (tests/revise-policy.test.mjs keeps the two equal). */
export const LOOP_MINUTES = 14;

/**
 * The arithmetic of the planner in PLAYBOOK Appendix A4, for the revise phase. A4 stays the planner of every other phase; its
 * numbers are copied here (tests/revise-policy.test.mjs runs the snippet from the playbook and compares them).
 *
 * Agent slots: the harness runs min(16, CPUs - 2) agents at once (2 on the 4-CPU cloud container). A4's wide timetable was planned
 * for 8 slots; below 6 ("narrow") it uses the timetable two real days measured on 2 slots, with a smaller reserve (the planned
 * finish moves from about 08:40 to about 08:50, still inside the 09:30 grace window). `plannerFor(slots)` gives the matching
 * numbers; without a slot count the machine is measured, exactly as A4 does.
 */
export const WIDE_SLOTS = 8;
/** min(8, CPUs - 2), the harness's concurrent agent() cap; SED_AGENT_SLOTS=<n> overrides it (the tests pin 8). */
export function slotsOnThisMachine() {
  const forced = process.env.SED_AGENT_SLOTS;
  if (forced && /^[1-9]\d*$/.test(forced)) return Number(forced);
  const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.min(8, Math.max(1, cpus - 2));
}
const WIDE = Object.freeze({
  TYPICAL: Object.freeze({
    1: Object.freeze({ revise: 30, package: 15, publish: 5 }),
    2: Object.freeze({ revise: 15, package: 12, publish: 5 }),
  }),
  CAP_REVISE: 40, // A4 CAP.revise: the phase hard cap
  RESERVE: 35, // planned finish = MTD - 35 (about 08:40)
  SLACK: 10, // the typical numbers are deliberately conservative
  MTD_OFFSET: 15, // MTD = minutesToGraceUntil - 15
});
const NARROW = Object.freeze({
  TYPICAL: Object.freeze({
    1: Object.freeze({ revise: 30, package: 15, publish: 5 }),
    2: Object.freeze({ revise: 20, package: 10, publish: 5 }),
  }),
  CAP_REVISE: 40,
  RESERVE: 10, // planned finish = MTD - 10 (about 09:05) for the phases before qa
  // From qa on a built site exists and PLAYBOOK 13 never cuts a healthy run before the grace window ends (09:30): the late phases
  // (qa, revise, package, publish) are measured against that window, five minutes short of it: available = MTD + 10.
  LATE_GRACE: 10,
  SLACK: 10,
  MTD_OFFSET: 15,
});
export function plannerFor(slots) {
  const n = Number.isInteger(slots) && slots >= 1 ? slots : slotsOnThisMachine();
  return Object.freeze({ ...(n < 6 ? NARROW : WIDE), slots: n, narrow: n < 6 });
}
/** The wide timetable (8 slots): what Appendix A4 prints with SLOTS=8. */
export const PLANNER = plannerFor(WIDE_SLOTS);

// ---------------------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------------------

function policyFieldProblems(raw) {
  const out = [];
  if (raw.tier2MinSeverity !== undefined && !FIX_SEVERITIES.includes(raw.tier2MinSeverity)) {
    out.push(`revisePolicy.tier2MinSeverity must be one of ${FIX_SEVERITIES.join(', ')} (got ${JSON.stringify(raw.tier2MinSeverity)})`);
  }
  if (raw.tier2S3Threshold !== undefined && !(Number.isInteger(raw.tier2S3Threshold) && raw.tier2S3Threshold >= 0)) {
    out.push(`revisePolicy.tier2S3Threshold must be a whole number of S3 defects, 0 to switch the trigger off (got ${JSON.stringify(raw.tier2S3Threshold)})`);
  }
  if (raw.minMinutesLeftForRevise !== undefined && !(typeof raw.minMinutesLeftForRevise === 'number' && Number.isFinite(raw.minMinutesLeftForRevise) && raw.minMinutesLeftForRevise >= 0 && raw.minMinutesLeftForRevise <= 600)) {
    out.push(`revisePolicy.minMinutesLeftForRevise must be a number of minutes from 0 to 600 (got ${JSON.stringify(raw.minMinutesLeftForRevise)})`);
  }
  if (raw.maxLoopsHardCap !== undefined && !(Number.isInteger(raw.maxLoopsHardCap) && raw.maxLoopsHardCap >= 1 && raw.maxLoopsHardCap <= MAX_LOOPS)) {
    out.push(`revisePolicy.maxLoopsHardCap must be a whole number from 1 to ${MAX_LOOPS} (got ${JSON.stringify(raw.maxLoopsHardCap)})`);
  }
  return out;
}

/**
 * What is wrong with the revise keys of a config: { errors, warnings }. Both empty for a config that has none of them (a config
 * written before this policy keeps the old behaviour). Shared with the repo validator.
 */
export function revisePolicyProblems(config) {
  const errors = [];
  const warnings = [];
  const raw = config?.revisePolicy;
  const present = raw !== undefined && raw !== null;
  if (present) {
    if (!isObj(raw)) {
      errors.push('revisePolicy must be an object {tier2MinSeverity, tier2S3Threshold, minMinutesLeftForRevise, maxLoopsHardCap}');
    } else {
      for (const key of Object.keys(raw)) {
        if (!Object.hasOwn(DEFAULT_REVISE_POLICY, key)) errors.push(`revisePolicy.${key} is not a known key (${Object.keys(DEFAULT_REVISE_POLICY).join(', ')})`);
      }
      errors.push(...policyFieldProblems(raw));
    }
  }
  const cap = isObj(raw) && Number.isInteger(raw.maxLoopsHardCap) && raw.maxLoopsHardCap >= 1 && raw.maxLoopsHardCap <= MAX_LOOPS ? raw.maxLoopsHardCap : DEFAULT_REVISE_POLICY.maxLoopsHardCap;
  const levels = config?.budget?.levels;
  if (isObj(levels)) {
    for (const [name, lv] of Object.entries(levels)) {
      if (!isObj(lv)) continue;
      const v = lv.reviseLoopsTier2;
      if (v === undefined) {
        if (present) warnings.push(`budget.levels.${name}.reviseLoopsTier2 is missing: a compact day at level ${name} keeps the old rule (no routine revise, only the S1 rescue loop)`);
      } else if (!(Number.isInteger(v) && v >= 0 && v <= MAX_LOOPS)) {
        errors.push(`budget.levels.${name}.reviseLoopsTier2 must be a whole number from 0 to ${MAX_LOOPS} (got ${JSON.stringify(v)})`);
      } else if (v > cap) {
        errors.push(`budget.levels.${name}.reviseLoopsTier2 ${v} is above revisePolicy.maxLoopsHardCap ${cap}`);
      }
    }
  }
  return { errors, warnings };
}

/** The policy in force: config.revisePolicy over the defaults, a damaged entry falling back to its default (with a warning). */
export function revisePolicyOf(config) {
  const raw = config?.revisePolicy;
  const warnings = [];
  const policy = { ...DEFAULT_REVISE_POLICY };
  if (raw === undefined || raw === null) return { policy, configured: false, warnings };
  if (!isObj(raw)) return { policy, configured: false, warnings: ['revisePolicy is not an object: the defaults apply'] };
  const bad = new Set(policyFieldProblems(raw).map((p) => /^revisePolicy\.(\w+)/.exec(p)?.[1]));
  for (const key of Object.keys(DEFAULT_REVISE_POLICY)) {
    if (raw[key] === undefined) continue;
    if (bad.has(key)) warnings.push(`revisePolicy.${key} is damaged (${JSON.stringify(raw[key])}): the default ${JSON.stringify(DEFAULT_REVISE_POLICY[key])} applies`);
    else policy[key] = raw[key];
  }
  return { policy, configured: true, warnings };
}

// ---------------------------------------------------------------------------------------
// the decision (pure)
// ---------------------------------------------------------------------------------------

const SEV_LABEL = ['S1', 'S1/S2', 'S1/S2/S3'];

/** One line for the operator: what to do with this plan (fixed words, no data from the QA report). */
function nextStep({ decision, code, blocksShipping }) {
  if (decision === 'run') return 'phase-start revise, arm the watch and launch the revise Workflow with `workflow` (PLAYBOOK 8.7)';
  if (decision === 'hold') return 'rerun qa (PLAYBOOK 8.6 row 1), then plan again; revise is not recorded';
  if (code === 'tier') return 'follow the fallback path of the target tier (PLAYBOOK 9)';
  if (blocksShipping) return 'Tier 3: an S1 build that cannot be revised is not shippable (PLAYBOOK 9.1)';
  return 'package (PLAYBOOK 10.2); list the open S2 and S3 defects as known issues in the report';
}

/**
 * input: {
 *   tier: 1 | 2 | 3 | 4         the run's target tier (3 and 4 have no revise phase)
 *   compact?: boolean            a compact day (default: tier === 2)
 *   counts: { S1, S2, S3, S4 }   the QA report's open defects, a missing-review marker excluded
 *   extraDefects?: number        queued extra defects (validator errors): counted as S1
 *   unreviewed?: boolean         the critic never reviewed the page: no decision can be taken (PLAYBOOK 8.6 row 1)
 *   levelConfig: { level?, reviseLoops, reviseLoopsTier2?, forceTier? }   of the EFFECTIVE level (owner override included)
 *   policy?: revisePolicy        default: the defaults
 *   minutesToGraceUntil?: number | null   the clock; null: no planner (manual runs take the time the phases need)
 *   phaseCapMinutes?: number     config.phaseBudgetMinutes.revise: the owner's cap on the revise phase (never above the planner's 40)
 *   overCap?, shipNow?, usageStop?, attemptsExhausted?: boolean
 * }
 * Returns the plan: { ok, decision: 'run' | 'skip' | 'hold', run, code, reason, note, tier, compact, loops, fixSeverity, rescue,
 * blocksShipping, trigger, minutes, phaseBudgetMinutes, workflow?, ... }.
 */
export function decideRevise(input = {}) {
  const policy = { ...DEFAULT_REVISE_POLICY, ...(isObj(input.policy) ? input.policy : {}) };
  const lc = isObj(input.levelConfig) ? input.levelConfig : {};
  const c = isObj(input.counts) ? input.counts : {};
  const counts = { S1: count(c.S1), S2: count(c.S2), S3: count(c.S3), S4: count(c.S4) };
  const extra = count(input.extraDefects);
  const s1 = counts.S1 + extra;
  const tierIn = Number.isInteger(input.tier) ? input.tier : 1;
  const compact = tierIn <= 2 && (typeof input.compact === 'boolean' ? input.compact : tierIn === 2);
  const tier = compact ? 2 : 1;
  const hardCap = Math.min(MAX_LOOPS, policy.maxLoopsHardCap);

  // --- what triggers a revise
  const minRank = RANK[policy.tier2MinSeverity] ?? RANK.S2;
  const severityHits = compact
    ? s1 + (minRank >= 1 ? counts.S2 : 0) + (minRank >= 2 ? counts.S3 : 0)
    : s1 + counts.S2;
  const thresholdHit = compact && policy.tier2S3Threshold >= 1 && counts.S3 >= policy.tier2S3Threshold;
  const triggered = severityHits > 0 || thresholdHit;
  const rescue = s1 > 0;
  const trigger = {
    by: rescue ? 's1' : severityHits > 0 ? 'severity' : thresholdHit ? 's3-threshold' : null,
    severityHits,
    s3Threshold: compact ? policy.tier2S3Threshold : null,
    s3ThresholdHit: thresholdHit,
    minSeverity: compact ? policy.tier2MinSeverity : 'S2',
  };

  // --- how many loops
  const legacy = compact && !Number.isInteger(lc.reviseLoopsTier2); // a level written before the policy: S1 rescue only
  const levelLoops = compact ? (legacy ? 0 : lc.reviseLoopsTier2) : lc.reviseLoops;
  const policyLoops = Math.max(0, Math.min(hardCap, Number.isFinite(Number(levelLoops)) ? Math.floor(Number(levelLoops)) : 0));
  const loops = triggered ? Math.max(policyLoops, rescue ? 1 : 0) : 0;
  const floorOnly = loops > 0 && policyLoops === 0; // the S1 rescue is the only reason this level revises at all
  const fixRank = !compact ? RANK.S2 : floorOnly ? RANK.S1 : Math.max(minRank, thresholdHit ? RANK.S3 : RANK.S1);
  const fixSeverity = FIX_SEVERITIES[fixRank];

  // --- minutes (PLAYBOOK Appendix A4 with REVISE=1, for one revise loop; the timetable follows the machine's agent slots)
  const P = plannerFor(input.slots);
  const clock = Number.isFinite(input.minutesToGraceUntil);
  const typical = P.TYPICAL[tier];
  const tail = typical.package + typical.publish;
  const need = typical.revise + tail;
  const mtd = clock ? input.minutesToGraceUntil - P.MTD_OFFSET : null;
  // revise is a late phase: on a narrow machine it is measured against the grace window (see NARROW.LATE_GRACE)
  const available = clock ? (P.narrow ? mtd + P.LATE_GRACE : mtd - P.RESERVE) : null;
  const feasible = clock ? need <= available + P.SLACK : true;
  // A started revise always gets one loop's worth of time (the typical figures carry a slack of 10 minutes for exactly this edge).
  const cap = typeof input.phaseCapMinutes === 'number' && input.phaseCapMinutes > 0 ? Math.min(P.CAP_REVISE, input.phaseCapMinutes) : P.CAP_REVISE;
  const budget = clock ? Math.max(LOOP_MINUTES, Math.min(cap, Math.round(available - tail))) : null;
  const minutes = clock
    ? { toGraceUntil: input.minutesToGraceUntil, mtd, available, tail, need, slack: P.SLACK, feasible, min: policy.minMinutesLeftForRevise, cap, budget, slots: P.slots, narrow: P.narrow }
    : null;

  const level = typeof lc.level === 'string' ? lc.level : null;
  const withNext = (p) => ({ ...p, next: nextStep(p) });
  const plan = (decision, code, reason, note, extraFields = {}) => withNext({
    ok: true,
    decision,
    run: decision === 'run',
    code,
    reason,
    note: decision === 'skip' ? `skipped: ${note}` : null,
    tier: tierIn >= 3 ? tierIn : tier,
    compact,
    level,
    counts,
    extraDefects: extra,
    trigger,
    rescue,
    floorOnly,
    legacy,
    policyLoops,
    hardCap,
    loops: decision === 'run' ? loops : 0,
    fixSeverity: decision === 'run' ? fixSeverity : null,
    minutes,
    phaseBudgetMinutes: decision === 'run' ? budget : null,
    blocksShipping: decision !== 'run' && decision !== 'hold' && s1 > 0,
    ...extraFields,
  });

  if (tierIn >= 3) return plan('skip', 'tier', `tier ${tierIn} has no revise phase: the day is on the fallback path (a ship-now directive or a degrade raised the target tier)`, `tier ${tierIn} has no revise phase`, { blocksShipping: false });
  if (input.unreviewed) {
    return plan('hold', 'unreviewed', 'the QA report was never reviewed by the critic (unreviewed): rerun qa first (PLAYBOOK 8.6 row 1); this is not a skip, so do not mark revise done', null);
  }
  if (!triggered) {
    const sev = SEV_LABEL[compact ? minRank : RANK.S2];
    const why = compact && policy.tier2S3Threshold >= 1
      ? `no ${sev} defects and the S3 count ${counts.S3} is below ${policy.tier2S3Threshold}`
      : `no ${sev} defects`;
    return plan('skip', 'no-trigger', `${why}: nothing to revise, the QA'd build ships as it is`, why);
  }
  if (input.shipNow) return plan('skip', 'ship-now', 'a ship-now directive is pending: no more agent work', 'ship-now directive pending');
  if (input.usageStop) return plan('skip', 'usage-stop', 'a usage stop is in force: no agent work may start', 'usage stop in force');
  if (input.attemptsExhausted) return plan('skip', 'attempts', 'phase-start already refused another revise attempt (overLimit, maxAttemptsPerPhase; PLAYBOOK 6.7 two failures): ship the pre-revise build', 'revise attempts used up, pre-revise build ships');
  if (loops === 0) {
    const key = compact ? 'reviseLoopsTier2' : 'reviseLoops';
    return plan('skip', 'level', `level ${level ?? '?'} allows no ${compact ? 'tier 2 ' : ''}revise loop (${legacy ? `${key} is not set, the old rule applies` : `${key} ${policyLoops}`}) and there is no S1 to rescue`, legacy ? `level ${level ?? '?'} has no ${key}, old rule` : `level ${level ?? '?'} has ${key} ${policyLoops}`);
  }
  if (input.overCap) return plan('skip', 'over-cap', 'spend is over the cap: start no new agent work (PLAYBOOK 6.5)', 'spend over the cap');
  if (clock && !feasible) {
    return plan('skip', 'no-time', `the planner says revise does not fit: ${need} min needed for revise, package and publish, ${Math.max(0, available)} min left before the planned finish (+${P.SLACK} slack)`, `planner: ${Math.max(0, available)} min left, ${need} needed for revise and package`);
  }
  if (clock && !rescue && available < policy.minMinutesLeftForRevise) {
    return plan('skip', 'no-time', `only ${Math.max(0, available)} min are left before the planned finish, revisePolicy.minMinutesLeftForRevise is ${policy.minMinutesLeftForRevise}`, `${Math.max(0, available)} min left, minimum ${policy.minMinutesLeftForRevise}`);
  }
  const fixText = ['S1 only', 'S1 and S2', 'S1, S2 and S3'][fixRank];
  const loopText = `${loops} loop${loops === 1 ? '' : 's'}`;
  const why = rescue
    ? `${s1} S1 defect${s1 === 1 ? '' : 's'}${extra ? ` (${extra} of them queued)` : ''}: ${floorOnly ? 'the rescue loop, the floor at every level' : `${loopText}, fixing ${fixText}`}`
    : severityHits > 0
      ? `${severityHits} defect${severityHits === 1 ? '' : 's'} at or above ${trigger.minSeverity}${thresholdHit ? ` and ${counts.S3} S3 (threshold ${policy.tier2S3Threshold})` : ''}: ${loopText}, fixing ${fixText}`
      : `S3 count ${counts.S3} reached the threshold ${policy.tier2S3Threshold}: ${loopText}, fixing ${fixText}`;
  return plan('run', 'run', why, null, {
    workflow: {
      reviseLoops: loops,
      compact,
      tier,
      fixSeverity,
      seconds: compact ? 10 : 20,
      phaseBudgetMinutes: budget,
    },
  });
}

// ---------------------------------------------------------------------------------------
// the inputs from the repo
// ---------------------------------------------------------------------------------------

function tally(defects) {
  const out = { S1: 0, S2: 0, S3: 0, S4: 0 };
  for (const d of defects) if (Object.hasOwn(out, d.severity)) out[d.severity]++;
  return out;
}

/** work/<date>/qa/report.json as the policy reads it: { found, error?, revision, verdict, counts, rawCounts, unreviewed }. */
export function readQaReport(date) {
  const file = rp('work', date, 'qa', 'report.json');
  if (!fs.existsSync(file)) return { found: false };
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { found: true, error: `work/${date}/qa/report.json is unreadable (${err.message})` };
  }
  if (!isObj(doc)) return { found: true, error: `work/${date}/qa/report.json is not a JSON object` };
  const defects = Array.isArray(doc.defects) ? doc.defects.filter(isObj) : [];
  // The missing-review marker is an S2 in the report's own counts but no fix agent can repair it (revise.js carries it over): it
  // must not trigger a revise. Counts come from the defect records when there are any, else from the report's counts.
  const real = defects.filter((d) => d.kind !== 'no-critic-review');
  const raw = isObj(doc.counts) ? { S1: count(doc.counts.S1), S2: count(doc.counts.S2), S3: count(doc.counts.S3), S4: count(doc.counts.S4) } : tally(defects);
  return {
    found: true,
    revision: Number.isInteger(doc.revision) ? doc.revision : 0,
    verdict: typeof doc.verdict === 'string' ? doc.verdict : null,
    counts: defects.length ? tally(real) : raw,
    rawCounts: raw,
    unreviewed: doc.unreviewed === true || defects.some((d) => d.kind === 'no-critic-review'),
  };
}

/**
 * The validator errors the build's trial stage queued (PLAYBOOK 8.5): work/<date>/build/extra-defects.json, plus the older location
 * work/<date>/qa/extra-defects.json. The queue lives under build/ because a qa retry or a takeover at qa wipes work/<date>/qa, and
 * the defects belong to the build anyway (a build retry wipes them with it). Returns { count, warning? }.
 */
export function readExtraDefects(date) {
  let count = 0;
  const warnings = [];
  for (const dir of ['build', 'qa']) {
    const file = rp('work', date, dir, 'extra-defects.json');
    if (!fs.existsSync(file)) continue;
    try {
      const list = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(list)) warnings.push(`work/<date>/${dir}/extra-defects.json is not an array: ignored`);
      else count += list.filter((d) => isObj(d) && ((typeof d.title === 'string' && d.title.trim()) || (typeof d.detail === 'string' && d.detail.trim()))).length;
    } catch (err) {
      warnings.push(`work/<date>/${dir}/extra-defects.json is unreadable (${err.message}): ignored`);
    }
  }
  return warnings.length ? { count, warning: warnings.join('; ') } : { count };
}

/**
 * The plan for `date` as of `now`: reads the run, the QA report, the queued extra defects, the effective throttle level (the owner's
 * override while it lasts) and the clock, then decides. `opts`: { date, now, config, mtd (minutes to the planner's MTD, overrides
 * the clock), tier (overrides the run's target tier), slots (agent slots for the timetable; default: this machine's), apply, session, role }. With `apply` a skip is recorded: `phase-done --phase
 * revise --note "skipped: <reason>"` (the playbook's own way), so revise is never forgotten in phasesDone. A run is never changed otherwise.
 */
export function planRevise(opts = {}) {
  const config = opts.config ?? loadConfig();
  const at = rs.toDate(opts.now);
  const date = rs.assertDate(opts.date ?? localParts(at, config.timezone).date);
  const run = rs.loadRun(date);
  if (!run) throw new rs.StateError(`no run file for ${date}; run \`state.mjs begin\` first`);
  const throttle = th.getThrottle(config, { now: at });
  const lc = { ...throttle.levelConfig, level: throttle.level };
  const { policy, configured, warnings } = revisePolicyOf(config);
  const warn = [...warnings];
  if (throttle.warnings?.length) warn.push(...throttle.warnings);

  const targetTier = opts.tier !== undefined ? rs.clampTier(opts.tier, '--tier') : run.targetTier;
  let slots;
  if (opts.slots !== undefined) {
    slots = Number(opts.slots);
    if (!Number.isInteger(slots) || slots < 1) throw new rs.UsageError(`--slots must be a whole number of agent slots, at least 1 (got ${JSON.stringify(opts.slots)})`);
  }
  const scopeCut = run.directives.some((d) => d.kind === 'scope-cut');
  const compact = targetTier === 2 || (targetTier === 1 && (lc.forceTier === 2 || scopeCut));
  const manual = run.lease?.holder === 'manual';
  // The clock: an explicit --mtd wins; a manual run has none (PLAYBOOK 5.5: it takes the time the phases need).
  let minutesToGraceUntil = null;
  if (opts.mtd !== undefined) {
    const mtd = Number(opts.mtd);
    if (!Number.isFinite(mtd)) throw new rs.UsageError(`--mtd must be a number of minutes (got ${JSON.stringify(opts.mtd)})`);
    minutesToGraceUntil = mtd + WIDE.MTD_OFFSET;
  } else if (!manual) {
    minutesToGraceUntil = rs.scheduleMinutes(config).graceUntil - rs.effectiveMinutes(config, at, date);
  }

  const qa = readQaReport(date);
  const extra = readExtraDefects(date);
  if (extra.warning) warn.push(extra.warning);
  const done = rs.doneNames(run);
  const spend = rs.spendSummary(config, run, { level: throttle.level });
  const attempts = run.attempts?.revise ?? 0;
  const view = {
    date,
    level: throttle.level,
    ...(throttle.override ? { override: throttle.override, ...(throttle.storedLevel ? { storedLevel: throttle.storedLevel } : {}) } : {}),
    manual,
    targetTier,
    qa: qa.found && !qa.error ? { revision: qa.revision, verdict: qa.verdict, counts: qa.counts, rawCounts: qa.rawCounts, unreviewed: qa.unreviewed } : null,
    policy: { ...policy, configured },
    levelConfig: { level: throttle.level, reviseLoops: lc.reviseLoops ?? null, reviseLoopsTier2: Number.isInteger(lc.reviseLoopsTier2) ? lc.reviseLoopsTier2 : null },
    ...(warn.length ? { warnings: warn } : {}),
  };

  // The plans that are settled before any counting: the same keys as decideRevise prints, so consumers read one shape.
  const settled = (decision, code, reason, note) => {
    const p = {
      ok: true, decision, run: false, code, reason, note: note ? `skipped: ${note}` : null, tier: compact ? 2 : 1, compact, level: throttle.level,
      counts: qa.counts ?? null, extraDefects: extra.count, trigger: null, rescue: false, floorOnly: false, legacy: false, policyLoops: 0,
      hardCap: Math.min(MAX_LOOPS, policy.maxLoopsHardCap), loops: 0, fixSeverity: null, minutes: null, phaseBudgetMinutes: null, blocksShipping: false,
    };
    return { ...p, next: nextStep(p) };
  };
  let plan;
  if (targetTier >= 3) {
    // tiers 3 and 4 have no revise phase, whatever the report says
    plan = decideRevise({ tier: targetTier, counts: qa.counts ?? {}, levelConfig: lc, policy });
  } else if (done.includes('revise') && run.phase !== 'revise') {
    plan = settled('skip', 'done', 'the revise phase is already recorded in phasesDone: go on to package', null);
  } else if (!qa.found) {
    plan = settled('skip', 'no-report', 'there is no QA report (QA was skipped or failed): nothing to revise, package validates the build', 'no QA report');
  } else if (qa.error) {
    plan = settled('hold', 'bad-report', `${qa.error}: rerun qa (PLAYBOOK 8.6) before deciding on revise; this is not a skip`, null);
  } else {
    plan = decideRevise({
      tier: targetTier,
      compact,
      counts: qa.counts,
      extraDefects: extra.count,
      unreviewed: qa.unreviewed,
      levelConfig: lc,
      policy,
      minutesToGraceUntil,
      slots,
      phaseCapMinutes: config.phaseBudgetMinutes?.revise,
      overCap: spend.overCap === true,
      shipNow: run.directives.some((d) => d.kind === 'ship-now' && d.ack !== true),
      usageStop: Boolean(rs.usageStopActive(run, at.getTime())),
      // phase-start counts an attempt before the Workflow runs (and still counts a refused one), so the retry that is about to be relaunched
      // has attempts === max: only a start beyond it (overLimit) means the phase has no attempts left
      attemptsExhausted: attempts > (config.maxAttemptsPerPhase ?? 2),
    });
  }

  const out = { ...plan, ...view };
  // a skip is recorded; a fallback tier (code "tier") has no revise phase to record and "done" is recorded already
  if (opts.apply && out.decision === 'skip' && out.note && out.code !== 'tier') {
    out.applied = rs.phaseDone({ phase: 'revise', note: out.note, role: opts.role, session: opts.session, date, now: at, config });
  }
  return out;
}
