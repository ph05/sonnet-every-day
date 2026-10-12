#!/usr/bin/env node
// Run state, lease, decision table, throttle and git sync CLI (CONTRACT 6.1).
// Every command prints exactly one JSON document on stdout; logs go to stderr.
// Exit codes: 0 ok, 1 checked-and-failed (ok:false), 2 usage error.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs, resolveNow, loadConfig, localParts, dayNumber, readJson, rp, print } from './lib/common.mjs';
import * as rs from './lib/runstate.mjs';
import * as th from './lib/throttle.mjs';
import * as pw from './lib/phasewatch.mjs';
import * as usage from './lib/usage.mjs';
import * as rv from './lib/revisepolicy.mjs';
import { sync, freshenRun, fetchRemoteHeartbeat } from './lib/gitsync.mjs';

const COMMANDS = [
  'today', 'begin', 'beat', 'phase-start', 'phase-done', 'skip-phase', 'directive', 'ack-directive', 'event',
  'spend', 'choose', 'finish', 'fail', 'status', 'throttle', 'usage', 'watch', 'revise', 'sync',
];
const USAGE = `usage: state.mjs <${COMMANDS.join('|')}> [options]
  today [--date D] [--now ISO]
  begin --role <primary|wdA|wdB|closer|manual> --session ID [--target-tier T] [--force]
                  (prints heartbeatAvailable: false when the heartbeat branch could not be read; a silent lease is then not declared dead before
                  phaseStuckMinutes, or before the holder's live phase watch is 15 min overdue; a begin that writes nothing leaves the run file as it was)
  beat --role R --session S [--phase P] [--note N]
  phase-start --phase P [--session S]      phase-done --phase P [--note N] [--session S] [--role R]
  skip-phase --phase P --reason R [--session S] [--role R]      (kaizen stays pending after finish until phase-done or skip-phase)
  directive --kind scope-cut|ship-now --tier T --by R      ack-directive [--kind K] [--tier T]
  event --kind note|error|takeover|degrade|rate-limit|budget --msg M --by R [--code planned-compact]
  spend --tokens N --calls M --phase P     choose --idea-id I --slug S --title T
  finish --status published --tier T --url U      fail --reason R
  status [--date D]
  throttle get|down|up|set|day-clean [--reason R] [--level L] [--force]
  usage observe [--info '<json>' | --file F | stdin] [--session S] [--phase P]      (rate_limit_info, external_metadata or the whole get_session result;
                  action ok|warn|down|stop|unknown, blind:true when it saw nothing; a stop is latched on the day's run and degrades it to a tier that needs no model tokens;
                  a limit that resets within 15 minutes also prints wait)
  usage clear --reason "<why this limit stop is wrong>" [--session S]      (the owner's way out of a LIMIT stop; never an overage one)
  watch arm --phase P --session S [--role R] [--minutes M]      watch bind --trigger-id T [--workflow-task ID] [--attempt N] [--phase P] [--session S]
  watch check --phase P --session S [--attempt N] [--role R]    watch disarm [--phase P] [--session S] [--workflow-task ID]      watch status
                  (phase watchdog, PLAYBOOK "Launching any Workflow": arm prints the send_later fields; check answers stale|early|overdue; M = the phaseBudgetMinutes the Workflow gets)
  revise plan [--apply --session S --role R] [--mtd M] [--tier T] [--slots N]
                  (revise policy, PLAYBOOK 8.6: reads the QA report, the effective level, the run and the clock; decision run|skip|hold, loops, workflow args;
                  --apply records a skip as phase-done --phase revise --note "skipped: ..."; --mtd = minutesToGraceUntil - 15 when you already hold it;
                  --slots = the agent slots the timetable is for, default this machine's min(8, CPUs - 2): below 6 the narrow timetable of A4 applies)
  sync -m "<message>" [--paths a,b,c] [--branch B] [--no-sleep]      (default paths: state,docs,work; config.json only when --paths names it)
common: --date YYYY-MM-DD, --now <ISO instant> (or env SED_NOW), env SED_ROOT redirects the repo root,
        --no-fetch (or env SED_NO_FETCH=1) skips the bounded git fetches that run-state commands do to see other containers
        (the work branch, and the heartbeat branch for the lease holder's liveness)`;

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

const noFetch = (flags) => Boolean(flags['no-fetch']) || envOn(process.env.SED_NO_FETCH);

/**
 * Every run-state command first looks at what other containers pushed (a bounded, fail-soft `git fetch` plus a
 * semantic merge of the remote run file into the local one), because the local file alone can neither show a lost
 * lease nor a watchdog's directive. `adopt` replaces a displaced local run with the remote one.
 */
function remoteView(flags, date, { adopt = false } = {}) {
  if (noFetch(flags)) return null;
  return freshenRun({ date, adoptOnDisplaced: adopt });
}

/** The run file's text, or null when there is none. */
function runFileText(date) {
  try {
    return fs.readFileSync(rs.runPath(date), 'utf8');
  } catch {
    return null;
  }
}

/**
 * A command that wrote nothing of its own (`status`, a `begin` that exits quietly) leaves the run file as it found it. Its
 * remoteView merged the remote run into the working tree so that it could decide; kept, that merge is an uncommitted change in a
 * persistent clone that never syncs (a watchdog's quiet exit) and the next fire's bootstrap checkout refuses to move the branch
 * (FM-110). Undoes exactly that write (`view.wrote`: the text freshenRun replaced and the text it wrote, both read under the
 * per-date lock): puts the old text back, or removes a file it adopted where there was none, and only when nobody wrote the
 * file since (another process's begin or beat stands). Every command that writes freshens again first, so nothing it needs is
 * lost. Returns true when it restored.
 */
function keepRunFileAsFound(date, view) {
  const wrote = view?.wrote;
  if (!wrote || wrote.after === wrote.before) return false;
  const { before } = wrote;
  return rs.withLock(rs.runLockPath(date), () => {
    if (runFileText(date) !== wrote.after) return false;
    const file = rs.runPath(date);
    if (before === null) {
      fs.rmSync(file, { force: true });
    } else {
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, before);
      fs.renameSync(tmp, file);
    }
    return true;
  });
}

/**
 * The lease holder's liveness record from the heartbeat branch (CONTRACT 14), fetched after remoteView so the
 * holder is the one the freshest run file names. Null when fetching is off or the run has no lease.
 */
function remoteBeat(flags, date, config) {
  if (noFetch(flags)) return null;
  const session = rs.loadRun(date)?.lease?.session;
  return session ? fetchRemoteHeartbeat({ date, session, config }) : null;
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

/** Could the heartbeat branch be read? null when it was not looked at (--no-fetch, no lease, no origin): "unknown" is reported as false. */
const heartbeatAvailable = (beatView) => (!beatView || (!beatView.fetched && !beatView.unknown) ? null : beatView.fetched);

// `restored`: the command only looked, so the remote run it merged in to decide was taken out of the working tree again (FM-110)
const remoteSummary = (view, beatView, restored = false) =>
  view
    ? {
        fetched: view.fetched,
        adopted: view.adopted,
        displaced: view.displaced,
        ...(restored ? { restored: true } : {}),
        ...(view.reason ? { reason: view.reason } : {}),
        ...(beatView ? { heartbeat: { fetched: beatView.fetched, unknown: beatView.unknown === true, found: beatView.heartbeat !== null, ...(beatView.branch ? { branch: beatView.branch } : {}), ...(beatView.reason ? { reason: beatView.reason } : {}) } } : {}),
      }
    : null;

function historyTail(limit = 5) {
  const h = readJson(rp('state', 'history.json'), { entries: [] });
  const entries = Array.isArray(h.entries) ? h.entries : [];
  return entries.slice(-limit).map((e) => ({ n: e.n, date: e.date, slug: e.slug, title: e.title, tier: e.tier }));
}

// level is the EFFECTIVE one (the owner override's while it is active, then storedLevel is what applies afterwards)
const throttleView = ({ level, cleanDays, lastChange, floor, ceiling, upAfterCleanDays, override, storedLevel }) => ({
  level, cleanDays, lastChange, floor, ceiling, upAfterCleanDays, ...(override ? { override, ...(storedLevel ? { storedLevel } : {}) } : {}),
});
/** The override keys of begin, status and today: nothing at all unless config.budget.ownerOverride exists (an ignored one adds warnings). */
const overrideFields = (throttle) => (throttle.override ? { override: throttle.override, ...(throttle.warnings?.length ? { warnings: throttle.warnings } : {}) } : {});

function eventKindForReason(reason) {
  if (/rate|usage/i.test(reason)) return 'rate-limit';
  if (/budget|overage/i.test(reason)) return 'budget';
  return 'note';
}

/** Puts a limit signal that changed no level (the owner override absorbed it) on today's run, once: a silent no-op would leave the report blind. */
function noteSignalOnRun({ date, now, config, kind, msg }) {
  const run = rs.loadRun(date);
  if (!run || run.status !== 'in_progress') return { updated: false };
  if (run.events.slice(-30).some((e) => e.kind === kind && e.msg === msg)) return { updated: false, repeat: true };
  rs.eventRun({ kind, msg, by: 'throttle', date, now, config });
  return { updated: true, event: kind };
}

/**
 * Piped stdin, or undefined when there is none: an interactive terminal has none, and an inherited pipe that never closes
 * (a tool shell) must not hang the guard, so a silent stdin is given up after a moment. `wait` (--info - / --file -) reads to the end.
 */
function readStdin({ wait = false } = {}) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (stdin.isTTY) return resolve(undefined);
    let data = '';
    let timer;
    const finish = () => {
      clearTimeout(timer);
      stdin.removeAllListeners('data');
      stdin.removeAllListeners('end');
      stdin.removeAllListeners('close');
      stdin.removeAllListeners('error');
      stdin.pause();
      resolve(data);
    };
    timer = setTimeout(finish, wait ? 15_000 : 750);
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => {
      data += chunk;
      clearTimeout(timer);
      timer = setTimeout(finish, 5_000);
    });
    stdin.on('end', finish);
    stdin.on('close', finish);
    stdin.on('error', finish);
    stdin.resume();
  });
}

/** The rate-limit JSON for `usage observe`: --info '<json>', --file F, or stdin (- or piped); nothing at all is a legal input (it reads as unknown). */
async function readUsageInput({ info, file }) {
  if (info !== undefined && file !== undefined) throw new UsageError('pass --info or --file, not both');
  if (info !== undefined) return info === '-' ? readStdin({ wait: true }) : info;
  if (file === undefined) return readStdin();
  if (file === '-') return readStdin({ wait: true });
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new UsageError(`--file ${file}: ${err.message}`);
  }
}

// Flags the usage subcommands take (the common ones --date, --now and --no-fetch included; --role is tolerated: the playbook's other commands carry it).
const USAGE_OBSERVE_FLAGS = ['info', 'file', 'session', 'phase', 'role', 'date', 'now', 'no-fetch'];
const USAGE_CLEAR_FLAGS = ['reason', 'session', 'role', 'date', 'now', 'no-fetch'];

const handlers = {
  today({ flags }) {
    const { config, now, date } = context(flags);
    const lp = localParts(now, config.timezone);
    const minutes = rs.effectiveMinutes(config, now, date);
    const sched = rs.scheduleMinutes(config);
    const run = rs.loadRun(date);
    const ov = th.ownerOverrideOf(config, now);
    return {
      ok: true,
      date,
      tz: config.timezone,
      time: lp.time,
      minutes: lp.minutes,
      minutesToDeadline: sched.deadline - minutes, // informational: 08:00 is a guideline (CONTRACT 13)
      minutesToGraceUntil: sched.graceUntil - minutes,
      minutesToHardStop: sched.hardStop - minutes,
      phaseIsLate: run ? rs.isLatePhase(run.phase) : false,
      targetTierIfStartedNow: rs.tierByMinutes(config, minutes),
      dayNumber: dayNumber(date, config.startDate),
      ...(ov ? { override: th.overrideView(ov), ...(ov.warnings.length ? { warnings: ov.warnings } : {}) } : {}),
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
    const throttle = th.getThrottle(config, { now });
    const view = remoteView(flags, date, { adopt: true });
    const beatView = remoteBeat(flags, date, config);
    const r = rs.beginRun({
      role,
      session,
      date,
      now,
      config,
      heartbeat: beatView?.heartbeat ?? null,
      hbUnknown: beatView?.unknown === true,
      hbMissing: beatView?.missing === true,
      throttleLevel: throttle.level,
      flags: { targetTier: targetFlag === undefined ? undefined : rs.clampTier(targetFlag, '--target-tier'), force: Boolean(flags.force) },
    });
    // a quiet exit (exit-alive, exit-published without a write) commits nothing, so it must not leave the merged remote run behind
    const restored = r.wrote ? false : keepRunFileAsFound(date, view);
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
      grace: r.grace,
      heartbeatAvailable: heartbeatAvailable(beatView),
      hbUnreadable: r.hbUnreadable,
      salvageSite: r.salvageSite,
      kept: r.kept,
      kaizenPending: r.kaizenPending,
      ...(r.run?.watch ? { watch: rs.watchSummary(r.run, now.getTime()) } : {}),
      ...(r.usageStop ? { usageStop: r.usageStop } : {}),
      spend: rs.spendSummary(config, r.run, { level: throttle.level }), // workflowCapTokens / kaizenCapTokens: the args.capTokens for a Workflow launched now
      ...(r.publicationBacked === false ? { publicationBacked: false, publicationProblem: r.publicationProblem } : {}),
      remote: remoteSummary(view, beatView, restored),
      run: r.run,
      lease: r.lease,
      recovered: r.recovered,
      cleaned: r.cleaned,
      corrupt: r.corrupt,
      levelConfig: throttle.levelConfig,
      throttle: throttleView(throttle),
      ...overrideFields(throttle),
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
      level: th.getThrottle(config, { now }).level, // the level in force right now (the owner override may have ended since `begin`)
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

  'skip-phase'({ flags }) {
    const { config, now, date } = context(flags);
    const session = opt(flags, 'session');
    const phase = req(flags, 'phase');
    const role = opt(flags, 'role');
    assertNotDisplaced(remoteView(flags, date), date, session);
    // The closer may close the kaizen of a dead owner; whether the owner is dead also depends on its heartbeat branch record.
    const beatView = phase === 'kaizen' && role === 'closer' ? remoteBeat(flags, date, config) : null;
    const r = rs.skipPhase({
      phase,
      reason: req(flags, 'reason'),
      role,
      session,
      date,
      now,
      config,
      heartbeat: beatView?.heartbeat ?? null,
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
    const code = opt(flags, 'code');
    if (code !== undefined && !rs.OPERATOR_EVENT_CODES.includes(code)) {
      throw new UsageError(`--code must be one of ${rs.OPERATOR_EVENT_CODES.join('|')} (got "${code}"): the other codes are written by the scripts themselves`);
    }
    remoteView(flags, date);
    return { ok: true, ...rs.eventRun({ kind: req(flags, 'kind'), msg: req(flags, 'msg'), by: req(flags, 'by'), date, now, config, code }) };
  },

  spend({ flags }) {
    const { config, now, date } = context(flags);
    const session = opt(flags, 'session');
    assertNotDisplaced(remoteView(flags, date), date, session);
    return {
      ok: true,
      ...rs.spendRun({ tokens: opt(flags, 'tokens') ?? 0, calls: opt(flags, 'calls') ?? 0, phase: opt(flags, 'phase'), session, date, now, level: th.getThrottle(config, { now }).level, config }),
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
    const throttle = th.getThrottle(config, { now });
    const view = remoteView(flags, date, { adopt: true });
    const beatView = remoteBeat(flags, date, config);
    const summary = rs.statusSummary({ date, now, config, history: historyTail(), heartbeat: beatView?.heartbeat ?? null, hbUnknown: beatView?.unknown === true, hbMissing: beatView?.missing === true, level: throttle.level });
    // status is read-only: it reports the merged view and leaves the working tree as it found it (FM-110)
    const restored = keepRunFileAsFound(date, view);
    return { ok: true, dayNumber: dayNumber(date, config.startDate), ...summary, heartbeatAvailable: heartbeatAvailable(beatView), throttle: throttleView(throttle), levelConfig: throttle.levelConfig, ...overrideFields(throttle), remote: remoteSummary(view, beatView, restored) };
  },

  throttle({ flags, positional }) {
    const { config, now, date } = context(flags);
    const sub = positional[1] ?? 'get';
    const reason = opt(flags, 'reason');
    let result;
    switch (sub) {
      case 'get':
        return { ok: true, ...th.getThrottle(config, { now }) };
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
    // under the owner override the effective level did not change, so today's run keeps the level it runs at; the signal itself still goes on record
    let run;
    if (result.changed && !result.overrideActive) {
      run = rs.syncThrottleToRun({ date, now, level: result.to, reason: result.reason, kind: sub === 'down' ? eventKindForReason(result.reason) : 'note', config });
    } else if (sub === 'down' && result.overrideActive && th.isLimitSignal(result.reason, config)) {
      run = noteSignalOnRun({ date, now, config, kind: eventKindForReason(result.reason), msg: `limit signal during the owner override (${result.changed ? 'stored level now ' + result.to : 'stored level ' + result.from + ' untouched'}): ${result.reason}` });
    } else {
      run = { updated: false };
    }
    return { ok: true, ...result, run };
  },

  async usage({ flags, positional }) {
    const sub = positional[1] ?? 'observe';
    if (!['observe', 'clear'].includes(sub)) throw new UsageError(`unknown usage subcommand "${sub}" (expected observe|clear)`);
    // A mistyped flag (--infos) must not turn a reading into "no input given": the guard refuses what it cannot place.
    const known = sub === 'observe' ? USAGE_OBSERVE_FLAGS : USAGE_CLEAR_FLAGS;
    const stray = Object.keys(flags).filter((k) => k !== '_' && !known.includes(k));
    if (stray.length) throw new UsageError(`usage ${sub} does not take ${stray.map((k) => `--${k}`).join(', ')} (it takes ${known.map((k) => `--${k}`).join(', ')})`);
    const { config, now, date } = context(flags);
    if (sub === 'clear') return usage.clear({ reason: opt(flags, 'reason'), session: opt(flags, 'session'), date, now, config });
    const input = await readUsageInput({ info: opt(flags, 'info'), file: opt(flags, 'file') });
    return usage.observe({ input, session: opt(flags, 'session'), phase: opt(flags, 'phase'), date, now, config });
  },

  /** The phase watchdog (scripts/lib/phasewatch.mjs): arm before a Workflow launch, bind its ids, check when the timer fires, disarm when it returns. */
  watch({ flags, positional }) {
    const sub = positional[1];
    if (!['arm', 'bind', 'check', 'disarm', 'status'].includes(sub)) {
      throw new UsageError(`unknown watch subcommand "${sub ?? ''}" (expected arm|bind|check|disarm|status)`);
    }
    const { config, now, date } = context(flags);
    const role = opt(flags, 'role');
    switch (sub) {
      case 'arm': {
        const session = req(flags, 'session');
        assertNotDisplaced(remoteView(flags, date), date, session);
        return pw.armWatch({ date, phase: req(flags, 'phase'), session, role, minutes: opt(flags, 'minutes'), now, config });
      }
      case 'bind':
        return pw.bindWatch({ date, phase: opt(flags, 'phase'), session: opt(flags, 'session'), triggerId: opt(flags, 'trigger-id'), workflowTask: opt(flags, 'workflow-task'), attempt: opt(flags, 'attempt'), now, config });
      case 'check': {
        const session = req(flags, 'session');
        const view = remoteView(flags, date);
        return pw.checkWatch({ date, phase: req(flags, 'phase'), session, attempt: opt(flags, 'attempt'), role, now, config, displacedBy: displacingLease(view, date, session) });
      }
      case 'disarm':
        return pw.disarmWatch({ date, phase: opt(flags, 'phase'), session: opt(flags, 'session'), workflowTask: opt(flags, 'workflow-task'), now, config });
      default:
        return pw.statusWatch({ date, now, config });
    }
  },

  /** The revise policy (scripts/lib/revisepolicy.mjs): `revise plan` decides whether revise runs, with how many loops and which Workflow args. */
  revise({ flags, positional }) {
    const sub = positional[1] ?? 'plan';
    if (sub !== 'plan') throw new UsageError(`unknown revise subcommand "${sub}" (expected plan)`);
    const { config, now, date } = context(flags);
    const session = opt(flags, 'session');
    const view = remoteView(flags, date); // a ship-now directive another container pushed must be seen before deciding
    if (flags.apply) assertNotDisplaced(view, date, session);
    return rv.planRevise({ date, now, config, apply: Boolean(flags.apply), session, role: opt(flags, 'role'), mtd: opt(flags, 'mtd'), tier: opt(flags, 'tier'), slots: opt(flags, 'slots') });
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
      now: opt(flags, 'now'), // the run date's clock: a leftover of an earlier, finished day is not a displacement (FM-110)
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
