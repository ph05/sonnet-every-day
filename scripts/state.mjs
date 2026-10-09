#!/usr/bin/env node
// Run state, lease, decision table, throttle and git sync CLI (CONTRACT 6.1).
// Every command prints exactly one JSON document on stdout; logs go to stderr.
// Exit codes: 0 ok, 1 checked-and-failed (ok:false), 2 usage error.
import { pathToFileURL } from 'node:url';
import { parseArgs, resolveNow, loadConfig, localParts, dayNumber, hm, readJson, rp, print } from './lib/common.mjs';
import * as rs from './lib/runstate.mjs';
import * as th from './lib/throttle.mjs';
import { sync, freshenRun, readRemoteHeartbeat } from './lib/gitsync.mjs';

const COMMANDS = [
  'today', 'begin', 'beat', 'phase-start', 'phase-done', 'directive', 'ack-directive', 'event',
  'spend', 'choose', 'finish', 'fail', 'status', 'throttle', 'sync',
];
const USAGE = `usage: state.mjs <${COMMANDS.join('|')}> [options]
  today [--date D] [--now ISO]
  begin --role <primary|wdA|wdB|closer|manual> --session ID [--target-tier T] [--force]
  beat --role R --session S [--phase P] [--note N]
  phase-start --phase P [--session S]      phase-done --phase P [--note N] [--session S] [--role R]
  directive --kind scope-cut|ship-now --tier T --by R      ack-directive [--kind K] [--tier T]
  event --kind note|error|takeover|degrade|rate-limit|budget --msg M --by R
  spend --tokens N --calls M --phase P     choose --idea-id I --slug S --title T
  finish --status published --tier T --url U      fail --reason R
  status [--date D]
  throttle get|down|up|set|day-clean [--reason R] [--level L] [--force]
  sync -m "<message>" [--paths a,b,c] [--branch B] [--no-sleep] [--allow-config]
common: --date YYYY-MM-DD, --now <ISO instant> (or env SED_NOW), env SED_ROOT redirects the repo root,
        --no-fetch (or env SED_NO_FETCH=1) skips the bounded git fetch that run-state commands do to see other containers`;

const { UsageError } = rs;

function req(flags, name) {
  const v = flags[name];
  if (v === undefined || v === true || v === '') throw new UsageError(`--${name} is required`);
  return String(v);
}
function opt(flags, name) {
  const v = flags[name];
  if (v === undefined) return undefined;
  if (v === true) throw new UsageError(`--${name} needs a value`);
  return String(v);
}

function context(flags) {
  const config = loadConfig();
  let now;
  try {
    now = resolveNow(flags);
  } catch (err) {
    throw new UsageError(err.message);
  }
  const dateFlag = opt(flags, 'date');
  const date = dateFlag === undefined ? localParts(now, config.timezone).date : rs.assertDate(dateFlag);
  return { config, now, date };
}

const envOn = (v) => v !== undefined && v !== '' && v !== '0' && v !== 'false';

/**
 * Every run-state command first looks at what other containers pushed (a bounded, fail-soft `git fetch` plus a
 * semantic merge of the remote run file into the local one), because the local file alone can neither show a lost
 * lease nor a watchdog's directive. `adopt` replaces a displaced local run with the remote one.
 */
function remoteView(flags, date, { adopt = false } = {}) {
  if (flags['no-fetch'] || envOn(process.env.SED_NO_FETCH)) return null;
  return freshenRun({ date, adoptOnDisplaced: adopt });
}

/** The remote lease that displaced the local holder `session` (or the local holder when no session is given), else null. */
function displacingLease(view, date, session) {
  if (!view?.displaced) return null;
  const mine = rs.loadRun(date)?.lease?.session;
  if (session !== undefined && session !== mine) return null; // not the local holder: the ordinary holder check explains it
  return view.remoteLease;
}

function assertNotDisplaced(view, date, session) {
  const lease = displacingLease(view, date, session);
  if (!lease) return;
  throw new rs.StateError(
    `lease is held by ${lease.holder}/${lease.session}, not ${session ?? rs.loadRun(date)?.lease?.session}: another container took over (displaced); stop writing (leaseHeld:false)`,
    { leaseHeld: false, displaced: true, holder: lease.holder, holderSession: lease.session },
  );
}

const remoteSummary = (view) => (view ? { fetched: view.fetched, adopted: view.adopted, displaced: view.displaced, ...(view.reason ? { reason: view.reason } : {}) } : null);

function historyTail(limit = 5) {
  const h = readJson(rp('state', 'history.json'), { entries: [] });
  const entries = Array.isArray(h.entries) ? h.entries : [];
  return entries.slice(-limit).map((e) => ({ n: e.n, date: e.date, slug: e.slug, title: e.title, tier: e.tier }));
}

const throttleView = ({ level, cleanDays, lastChange, floor, ceiling, upAfterCleanDays }) => ({ level, cleanDays, lastChange, floor, ceiling, upAfterCleanDays });

function eventKindForReason(reason) {
  if (/rate|usage/i.test(reason)) return 'rate-limit';
  if (/budget|overage/i.test(reason)) return 'budget';
  return 'note';
}

const handlers = {
  today({ flags }) {
    const { config, now, date } = context(flags);
    const lp = localParts(now, config.timezone);
    const minutes = rs.effectiveMinutes(config, now, date);
    return {
      ok: true,
      date,
      tz: config.timezone,
      time: lp.time,
      minutes: lp.minutes,
      minutesToDeadline: hm(config.schedule.deadline) - minutes,
      targetTierIfStartedNow: rs.tierByMinutes(config, minutes),
      dayNumber: dayNumber(date, config.startDate),
    };
  },

  begin({ flags }) {
    const { config, now, date } = context(flags);
    const role = req(flags, 'role');
    const session = req(flags, 'session');
    const targetFlag = opt(flags, 'target-tier');
    if (role !== 'manual' && (targetFlag !== undefined || flags.force)) {
      throw new UsageError('--target-tier and --force are only valid with --role manual');
    }
    const throttle = th.getThrottle(config);
    const view = remoteView(flags, date, { adopt: true });
    const leaseSession = rs.loadRun(date)?.lease?.session;
    const remoteBeat = view?.fetched && leaseSession ? readRemoteHeartbeat({ branch: view.branch, date, session: leaseSession }) : null;
    const r = rs.beginRun({
      role,
      session,
      date,
      now,
      config,
      heartbeat: remoteBeat,
      throttleLevel: throttle.level,
      flags: { targetTier: targetFlag === undefined ? undefined : rs.clampTier(targetFlag, '--target-tier'), force: Boolean(flags.force) },
    });
    return {
      ok: true,
      action: r.action,
      date: r.date,
      role: r.role,
      targetTier: r.targetTier,
      resumePhase: r.resumePhase,
      reason: r.reason,
      wrote: r.wrote,
      directiveAdded: r.directiveAdded,
      builtSiteAvailable: r.builtSiteAvailable,
      ...(r.publicationBacked === false ? { publicationBacked: false, publicationProblem: r.publicationProblem } : {}),
      remote: remoteSummary(view),
      run: r.run,
      lease: r.lease,
      recovered: r.recovered,
      cleaned: r.cleaned,
      corrupt: r.corrupt,
      levelConfig: throttle.levelConfig,
      throttle: throttleView(throttle),
    };
  },

  beat({ flags }) {
    const { config, now, date } = context(flags);
    const session = req(flags, 'session');
    const view = remoteView(flags, date);
    const lease = displacingLease(view, date, session);
    const r = rs.beatRun({
      role: req(flags, 'role'),
      session,
      phase: opt(flags, 'phase'),
      note: opt(flags, 'note'),
      date,
      now,
      config,
      displacedBy: lease && { ...lease, directives: view.remoteDirectives ?? [] },
    });
    return { ok: true, ...r, remote: remoteSummary(view) };
  },

  'phase-start'({ flags }) {
    const { config, now, date } = context(flags);
    const session = opt(flags, 'session');
    assertNotDisplaced(remoteView(flags, date), date, session);
    return { ok: true, ...rs.phaseStart({ phase: req(flags, 'phase'), session, date, now, config }) };
  },

  'phase-done'({ flags }) {
    const { config, now, date } = context(flags);
    const session = opt(flags, 'session');
    assertNotDisplaced(remoteView(flags, date), date, session);
    const r = rs.phaseDone({
      phase: req(flags, 'phase'),
      note: opt(flags, 'note'),
      role: opt(flags, 'role'),
      session,
      date,
      now,
      config,
    });
    return { ok: true, ...r };
  },

  directive({ flags }) {
    const { config, now, date } = context(flags);
    const tier = opt(flags, 'tier');
    remoteView(flags, date);
    return {
      ok: true,
      ...rs.directiveRun({ kind: req(flags, 'kind'), tier: tier === undefined ? undefined : rs.clampTier(tier, '--tier'), by: req(flags, 'by'), date, now, config }),
    };
  },

  'ack-directive'({ flags }) {
    const { config, now, date } = context(flags);
    const tier = opt(flags, 'tier');
    remoteView(flags, date);
    return { ok: true, ...rs.ackDirectives({ kind: opt(flags, 'kind'), tier: tier === undefined ? undefined : rs.clampTier(tier, '--tier'), date, now, config }) };
  },

  event({ flags }) {
    const { config, now, date } = context(flags);
    remoteView(flags, date);
    return { ok: true, ...rs.eventRun({ kind: req(flags, 'kind'), msg: req(flags, 'msg'), by: req(flags, 'by'), date, now, config }) };
  },

  spend({ flags }) {
    const { config, now, date } = context(flags);
    const session = opt(flags, 'session');
    assertNotDisplaced(remoteView(flags, date), date, session);
    return {
      ok: true,
      ...rs.spendRun({ tokens: opt(flags, 'tokens') ?? 0, calls: opt(flags, 'calls') ?? 0, phase: opt(flags, 'phase'), session, date, now, config }),
    };
  },

  choose({ flags }) {
    const { config, now, date } = context(flags);
    const session = opt(flags, 'session');
    assertNotDisplaced(remoteView(flags, date), date, session);
    return {
      ok: true,
      ...rs.chooseRun({ ideaId: req(flags, 'idea-id'), slug: req(flags, 'slug'), title: req(flags, 'title'), session, date, now, config }),
    };
  },

  finish({ flags }) {
    const { config, now, date } = context(flags);
    // A displaced late finisher may still upgrade a fallback (CONTRACT 7): it must first see what was published.
    remoteView(flags, date, { adopt: true });
    return rs.finishRun({
      status: opt(flags, 'status') ?? 'published',
      tier: req(flags, 'tier'),
      url: opt(flags, 'url'),
      by: opt(flags, 'by'),
      date,
      now,
      config,
    });
  },

  fail({ flags }) {
    const { config, now, date } = context(flags);
    const session = opt(flags, 'session');
    assertNotDisplaced(remoteView(flags, date), date, session);
    return rs.failRun({ reason: req(flags, 'reason'), by: opt(flags, 'by'), session, date, now, config });
  },

  status({ flags }) {
    const { config, now, date } = context(flags);
    const throttle = th.getThrottle(config);
    const view = remoteView(flags, date, { adopt: true });
    const summary = rs.statusSummary({ date, now, config, history: historyTail() });
    return { ok: true, dayNumber: dayNumber(date, config.startDate), ...summary, throttle: throttleView(throttle), levelConfig: throttle.levelConfig, remote: remoteSummary(view) };
  },

  throttle({ flags, positional }) {
    const { config, now, date } = context(flags);
    const sub = positional[1] ?? 'get';
    const reason = opt(flags, 'reason');
    let result;
    switch (sub) {
      case 'get':
        return { ok: true, ...th.getThrottle(config) };
      case 'down':
        result = th.throttleDown({ reason, now, config, date, force: Boolean(flags.force) });
        break;
      case 'up':
        result = th.throttleUp({ reason, now, config });
        break;
      case 'set':
        result = th.throttleSet({ level: req(flags, 'level'), reason, now, config });
        break;
      case 'day-clean':
        return { ok: true, ...th.throttleDayClean({ date, now, config }) };
      default:
        throw new UsageError(`unknown throttle subcommand "${sub}" (expected get|down|up|set|day-clean)`);
    }
    const run = result.changed
      ? rs.syncThrottleToRun({ date, now, level: result.to, reason: result.reason, kind: sub === 'down' ? eventKindForReason(result.reason) : 'note', config })
      : { updated: false };
    return { ok: true, ...result, run };
  },

  async sync({ flags }) {
    const message = opt(flags, 'message');
    if (!message || !message.trim()) throw new UsageError('sync needs -m "<message>"');
    const paths = opt(flags, 'paths');
    const result = await sync({
      message,
      paths: paths ? paths.split(',').map((p) => p.trim()).filter(Boolean) : undefined,
      branch: opt(flags, 'branch'),
      noSleep: flags['no-sleep'] ? true : undefined,
      allowConfig: Boolean(flags['allow-config']),
    });
    return result;
  },
};

/** Runs one CLI invocation; returns { code, body } without printing so tests can call it in-process. */
export async function main(argv) {
  const normalized = argv.map((a) => (a === '-m' ? '--message' : a));
  const flags = parseArgs(normalized);
  const command = flags._[0];
  try {
    if (!command || !handlers[command]) throw new UsageError(command ? `unknown command "${command}"` : 'no command given');
    const body = await handlers[command]({ flags, positional: flags._ });
    return { code: body.ok === false ? 1 : 0, body };
  } catch (err) {
    if (err instanceof UsageError) return { code: 2, body: { ok: false, error: err.message, usage: USAGE } };
    if (err instanceof rs.StateError) return { code: 1, body: { ok: false, error: err.message, ...err.extra } };
    process.stderr.write(`${err.stack ?? err}\n`);
    return { code: 1, body: { ok: false, error: `unexpected: ${err.message}` } };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { code, body } = await main(process.argv.slice(2));
  print(body);
  process.exitCode = code;
}
