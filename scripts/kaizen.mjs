#!/usr/bin/env node
// The kaizen gate and ledger (CONTRACT 12). Each roster member makes ONE minor change per day after publish;
// this script is what makes that safe to run unattended. It is the only writer of ops/kaizen/LOG.md and
// ops/kaizen/INDEX.json, and it is itself protected from kaizens.
//
//   begin   --agent A [--date D]                      clean-tree assertion, baseline test counts, digest, notes, scan
//   scan    --agent A [--date D]                      one seeded-random file to study when there are no notes
//   digest  [--days N] [--limit N] [--date D]         recent ledger entries, for building on (not repeating) them
//   check   [--agent A] [--evidence TEXT]             working tree vs HEAD against every rule; read-only
//   commit  --agent A --title T --observation O --category C [--question Q] [--evidence E] [--date D]
//   propose --agent A --title T --body-file F [--observation O] [--category C] [--date D]
//   status  [--date D]                                tree state, ledger counts, who is still to go today, verification state
//   queue   [--skip a,b] [--clear a,b]                members skipped by a budget stop (they go first tomorrow)
//   verify  [--if-needed] [--date D]                  every suite at HEAD: the round's one full run after selective gates
//
// The selective gate (GATE_MAP, ops/kaizen/README.md): `commit` runs validate plus only the suites that read what the diff touches
// when every path is a doc path (roles, rubrics, CULTURE, PLAYBOOK, FAILURE_MODES, OPERATING, README, templates, proposals,
// workflows); scripts/, tests/, site-src/ and anything else run every suite. A cold `begin` (a new HEAD) always runs every suite, and
// `verify` runs them once more at the end of a round that used selective gates; a red full run names the commits that skipped suites.
//
// Design rules: git runs through execFile with argument arrays (never a shell) and literal pathspecs; the
// rules come from the COMMITTED config.json so an agent cannot loosen them by editing the working copy;
// nothing is pushed, reset or force-anything: on failure only the touched files are restored; ledger writes
// are atomic and keyed by (date, agent). Exit codes: 0 ok, 1 checked and failed, 2 usage.
//
// Flaky suites: a suite that fails on its own (not a timeout) is run ONCE more before it counts. A pass on the re-run is accepted
// with a note ("flaky-suspect", in the output and the ledger entry) and the tests that flipped are appended to the capped,
// advisory state/flaky-suspects.json (left for the orchestrator's sync, like state/kaizen-queue.json). A failure that repeats
// is refused exactly as before. The re-run runs in a fresh empty temp directory, so state the first run left in the shared one cannot
// make a cold-start failure look like a flake.
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  repoRoot, rp, readJson, writeJsonAtomic, parseArgs, resolveNow, localParts, addDays, hashStr, mulberry32, print,
} from './lib/common.mjs';

export class KaizenError extends Error {
  constructor(message, code = 1, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}
const usage = (msg) => new KaizenError(msg, 2);

// ---------------------------------------------------------------------------------------------- constants

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LEDGER_INDEX = 'ops/kaizen/INDEX.json';
const LEDGER_LOG = 'ops/kaizen/LOG.md';
const LEDGER_FILES = [LEDGER_LOG, LEDGER_INDEX];
const PROPOSALS_DIR = 'ops/kaizen/proposals';
const QUEUE_FILE = 'state/kaizen-queue.json';
const STATUSES = ['applied', 'rejected', 'proposed', 'reverted'];
const MAX_FILE_BYTES = 256 * 1024;
const CONTENT_SCAN_MAX_FILES = 60;
const MAX_VIOLATIONS = 60;
const MAX_TITLE = 100;
const MAX_TEXT = 600;
const MAX_QUESTION = 300;
const MAX_PROPOSAL_LINES = 200;
const MAX_PROPOSAL_BYTES = 20_000;
const DEFAULT_DIGEST_DAYS = 14;
const SUITE_TAIL_CHARS = 1500;
const LOCK_STALE_MS = 90 * 60 * 1000;
const FALLBACK_IDENTITY = { name: 'Claude', email: 'noreply@anthropic.com' };
// Tests whose first run failed and whose automatic re-run passed. Advisory, capped, written only by this script.
const FLAKY_FILE = 'state/flaky-suspects.json';
const MAX_FLAKY_SUSPECTS = 40;
const MAX_FLAKY_NAMES = 12;
const MAX_FLAKY_NAME = 200;

const SECRET_PATTERNS = [
  ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g],
  ['GitHub fine-grained token', /\bgithub_pat_[A-Za-z0-9_]{20,}/g],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{10,}/g],
  ['OpenAI-style key', /\bsk-[A-Za-z0-9]{32,}/g],
  ['AWS access key id', /\b(?:AKIA|ASIA)[0-9A-Z]{12,}/g],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{30,}/g],
  ['private key block', /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE|PGP PRIVATE)/g],
  ['credential assignment', /\b(?:api[_-]?key|secret|passw(?:or)?d|auth[_-]?token|access[_-]?token)\b["']?\s*[:=]\s*["'][^"'\s]{12,}["']/gi],
];
// Text that tries to steer a model. A kaizen adding any of it is suspect: it may have been copied from web content.
const INJECTION_PATTERNS = [
  ['override-instructions phrase', /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+|the\s+|your\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions?|prompts?|rules?|messages?)/gi],
  ['chat-template token', /<\|(?:im_start|im_end|system|assistant|user)\|>/gi],
  ['new-instructions header', /\bnew\s+(?:system\s+)?instructions?\s*:/gi],
  ['prompt exfiltration', /\b(?:reveal|print|repeat|show)\s+(?:your|the)\s+(?:system\s+)?prompt\b/gi],
  ['concealment', /\bdo\s+not\s+(?:tell|inform|alert|mention\s+(?:this\s+)?to)\s+(?:the\s+)?(?:user|owner|human|operator)/gi],
  ['instruction to bypass safeguards', /\byou\s+(?:must|should|are\s+(?:now\s+)?(?:allowed|permitted)\s+to)\s+(?:now\s+)?(?:override|bypass|disable|ignore)\s+(?:the\s+|all\s+|any\s+)?(?:safety|guardrails?|protected|validation|rules)\b/gi],
];
const TEST_FILE_RE = /^(?:tests\/.+\.(?:mjs|js|cjs)|ops\/workflows\/_selfcheck\.mjs)$/;
const TEST_SUITE_RE = /^tests\/[^/]+\.test\.mjs$/;
const TEST_SUPPORT_RE = /^tests\/(?:helpers|fixtures)\//;
const CODE_FILE_RE = /^(?:scripts\/|ops\/workflows\/(?!_selfcheck\.mjs$))/;
// Matched on the lexed source (comments removed, string contents blanked), see lexSource().
const TEST_DECL_RE = /^[ \t]*(?:await\s+)?(?:test|it|describe|suite)(?:\.\w+)?\s*\(/gm;
const TEST_SKIP_RE = /\.(?:skip|todo|only)\b|\b(?:xit|xtest|xdescribe)\s*\(|\b(?:skip|todo)\s*:(?!\s*false\b)/g;
const ASSERT_RE = /\b(?:assert|expect)(?:\.\w+)*\s*\(/g;
// A test body that returns at once, a dead branch, an early exit, or an assertion that cannot fail.
const DISABLED_RE = /(?:=>|\bfunction\b[^{};]*)\s*\{\s*return\s*[;}]|\bif\s*\(\s*(?:false|0|null|undefined)\s*\)|\bprocess\.exit\s*\(/g;
const TAUTOLOGY_RE = /\bassert(?:\.ok)?\s*\(\s*(?:true|1|!0|""|``)\s*[,)]|\bassert\.(?:equal|strictEqual|deepEqual|deepStrictEqual)\s*\(\s*([\w.$]+)\s*,\s*\1\s*[,)]/g;
// An assertion or test declaration that now lives in a comment.
const COMMENTED_CALL_RE = /\b(?:assert|expect)(?:\.\w+)*\(|\b(?:test|it|describe)(?:\.\w+)?\(\s*['"`]/g;
// Files every agent reads every day: they may not grow past a byte cap (a few long lines can burn the token budget).
const PROMPT_FILE_RE = /^(?:ops\/(?:roles|rubrics)\/[^/]+\.md|ops\/CULTURE\.md)$/;
const MAX_PROMPT_BYTES = 12 * 1024;
// Written by the orchestrator while members run; a kaizen never touches them and the gate never restores them.
const RUNTIME_AREAS = ['state/', 'docs/', 'work/'];
// Always protected, whatever the committed config says: the gate itself, the ledger, and the scripts that guard the deadline,
// the throttle and the usage limits (never overage), the stalled-phase watch, the revise policy, the fallbacks, the published
// site and the browser safety net.
const CORE_PROTECTED = [
  'config.json', 'scripts/kaizen.mjs', 'ops/kaizen/LOG.md', 'ops/kaizen/INDEX.json',
  'scripts/deadman.mjs', 'scripts/heartbeat.mjs', 'scripts/lib/throttle.mjs', 'scripts/lib/usage.mjs', 'scripts/lib/phasewatch.mjs', 'scripts/lib/revisepolicy.mjs',
  'scripts/fallback.mjs', 'scripts/build-site.mjs', 'scripts/qa/browser-check.mjs',
];
const REVERT_RATIO = 0.5;
const MIN_MEANINGFUL_LINE = 4;
const UNTRUSTED_OPEN = (source) => `<untrusted-data source="${source}">`;
const UNTRUSTED_CLOSE = '</untrusted-data>';
const BINARY_EXT_RE = /\.(?:png|jpe?g|gif|webp|ico|bmp|woff2?|ttf|otf|eot|zip|gz|tgz|pdf|mp3|mp4|wav|ogg|webm|wasm)$/i;

// ---------------------------------------------------------------------------------------------- git

function createGit(cwd) {
  const base = [
    '-c', 'core.fileMode=true', '-c', 'core.autocrlf=false', '-c', 'core.quotepath=off',
    '-c', 'core.symlinks=true', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${os.devNull}`,
  ];
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: 'true',
    GIT_LITERAL_PATHSPECS: '1',
    LC_ALL: 'C',
    LANG: 'C',
  };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR']) delete env[k];

  function run(args, { input, timeoutMs = 120_000, extraEnv } = {}) {
    try {
      const stdout = execFileSync('git', [...base, ...args], {
        cwd,
        env: extraEnv ? { ...env, ...extraEnv } : env,
        input,
        maxBuffer: 512 * 1024 * 1024,
        timeout: timeoutMs,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { ok: true, code: 0, stdout, stderr: '' };
    } catch (err) {
      return {
        ok: false,
        code: typeof err.status === 'number' ? err.status : -1,
        stdout: err.stdout ?? Buffer.alloc(0),
        stderr: String(err.stderr ?? err.message ?? '').trim(),
      };
    }
  }
  function text(args, opts) {
    const r = run(args, opts);
    if (!r.ok) throw new KaizenError(`git ${args[0]} failed: ${firstLine(r.stderr)}`, 1);
    return r.stdout.toString('utf8');
  }
  return { cwd, run, text };
}

const firstLine = (s) => String(s).split('\n').map((l) => l.trim()).find(Boolean) ?? 'no output';

function openRepo() {
  const root = repoRoot();
  if (!fs.existsSync(root)) throw new KaizenError(`repo root does not exist: ${root}`, 1);
  const g = createGit(root);
  const top = g.run(['rev-parse', '--show-toplevel']);
  if (!top.ok) throw new KaizenError(`${root} is not a git repository`, 1);
  if (fs.realpathSync(top.stdout.toString('utf8').trim()) !== fs.realpathSync(root)) {
    throw new KaizenError(`${root} is inside another repository (${top.stdout.toString('utf8').trim()}); kaizen needs the repo root`, 1);
  }
  const head = g.run(['rev-parse', '--verify', '-q', 'HEAD']);
  if (!head.ok) throw new KaizenError('the repository has no commits yet', 1);
  return { root, g, head: head.stdout.toString('utf8').trim() };
}

const headBlob = (g, rel) => {
  const r = g.run(['cat-file', 'blob', `HEAD:${rel}`]);
  return r.ok ? r.stdout : null;
};

// ---------------------------------------------------------------------------------------------- config

/** Rules come from the committed config.json: an agent editing the working copy cannot loosen them. */
function loadConfig(g) {
  let cfg = null;
  const committed = g.run(['show', 'HEAD:config.json']);
  if (committed.ok) {
    try {
      cfg = JSON.parse(committed.stdout.toString('utf8'));
    } catch {
      cfg = null;
    }
  }
  if (!cfg) cfg = readJson(rp('config.json'), null);
  if (!cfg || typeof cfg !== 'object') throw new KaizenError('config.json is missing or unreadable', 1);
  const k = cfg.kaizen;
  if (!k || typeof k !== 'object') throw new KaizenError('config.kaizen is missing (committed config.json)', 1);
  const strArr = (name, min = 0) => {
    const v = k[name];
    if (!Array.isArray(v) || v.length < min || v.some((x) => typeof x !== 'string' || !x)) {
      throw new KaizenError(`config.kaizen.${name} must be an array of non-empty strings`, 1);
    }
    return v;
  };
  const posInt = (name) => {
    if (!Number.isInteger(k[name]) || k[name] < 1) throw new KaizenError(`config.kaizen.${name} must be a positive integer`, 1);
    return k[name];
  };
  const caps = k.docLineCaps ?? {};
  if (typeof caps !== 'object' || Object.values(caps).some((n) => !Number.isInteger(n) || n < 1)) {
    throw new KaizenError('config.kaizen.docLineCaps must map paths to positive integers', 1);
  }
  return {
    timezone: cfg.timezone ?? 'America/New_York',
    kaizen: {
      enabled: k.enabled !== false,
      members: strArr('members', 1),
      allowedPaths: strArr('allowedPaths', 1),
      protectedPaths: [...new Set([...strArr('protectedPaths'), ...CORE_PROTECTED])],
      maxChangedLines: posInt('maxChangedLines'),
      maxFiles: posInt('maxFiles'),
      revertWindowDays: Number.isInteger(k.revertWindowDays) ? k.revertWindowDays : 7,
      docLineCaps: caps,
    },
  };
}

/** SED_NOW (the repo-wide test clock) or SED_KAIZEN_ALLOW_DATE lets --date/--now steer the dates; in production the real clock rules. */
const testClock = () => Boolean(process.env.SED_NOW || process.env.SED_KAIZEN_ALLOW_DATE);

function realToday(tz) {
  try {
    return localParts(new Date(), tz).date;
  } catch (err) {
    throw usage(err.message);
  }
}

function parseDateFlag(flags) {
  const d = String(flags.date);
  if (!DATE_RE.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) throw usage(`bad --date: ${flags.date}`);
  return d;
}

/** Read-only commands (digest, scan, status): --date and --now are honoured. */
function resolveDate(flags, tz) {
  if (flags.date !== undefined) return parseDateFlag(flags);
  try {
    return localParts(resolveNow(flags), tz).date;
  } catch (err) {
    throw usage(err.message);
  }
}

/**
 * Commands that decide anything (begin, commit, propose, check) run on the real clock: a member cannot move the
 * one-per-day cap or the revert window by passing another --date. A --date that is not today is a usage error.
 */
function resolveToday(flags, tz, { lenient = false } = {}) {
  if (testClock()) return resolveDate(flags, tz);
  const real = realToday(tz);
  if (flags.date !== undefined && !lenient && parseDateFlag(flags) !== real) {
    throw usage(`--date ${flags.date} is not today (${real} in ${tz}); a kaizen is always dated by the real clock (drop --date)`);
  }
  return real;
}

function requireAgent(flags, kz) {
  const agent = flags.agent;
  if (!agent || agent === true) throw usage('missing --agent');
  if (!kz.members.includes(agent)) throw usage(`unknown agent "${agent}" (members: ${kz.members.join(', ')})`);
  return agent;
}

// ---------------------------------------------------------------------------------------------- text helpers

const ZERO_WIDTH_RE = /[​-‏⁠﻿­]/g;

/** Canonical form for comparing paths: Unicode compatibility folding, case, zero-width characters, trailing dots/spaces. */
export function fold(p) {
  return String(p)
    .normalize('NFKC')
    .replace(ZERO_WIDTH_RE, '')
    .toLowerCase()
    .split('/')
    .map((seg) => seg.replace(/[. ]+$/, ''))
    .join('/');
}

export function badPathReason(p) {
  if (!p) return 'empty path';
  if (p.startsWith('/')) return 'absolute path';
  if (p.includes('\0') || /[\u0000-\u001f\u007f]/.test(p)) return 'control characters in path';
  if (p.includes('\\')) return 'backslash in path';
  if (p.length > 240) return 'path too long';
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return 'path contains an empty, "." or ".." segment';
    if (fold(seg) === '.git') return 'path inside .git';
  }
  return null;
}

export function isProtected(p, protectedPaths) {
  const f = fold(p);
  return protectedPaths.some((pr) => {
    const pf = fold(pr.replace(/\/+$/, ''));
    return f === pf || f.startsWith(`${pf}/`);
  });
}

export function isAllowed(p, allowedPaths) {
  return allowedPaths.some((a) => (a.endsWith('/') ? p.startsWith(a) : p === a));
}

const countLines = (buf) => {
  if (!buf || buf.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
  return buf[buf.length - 1] === 10 ? n : n + 1;
};
const isBinary = (buf) => buf.subarray(0, 8000).includes(0);
const countMatches = (text, re) => (text.match(re) ?? []).length;

function clean(s, max) {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Free text from an agent goes into the ledger, a commit message, the digest every later member reads and the public diary:
 * a leaked credential or a sentence that tries to steer a model must never get that far.
 */
function scrub(s) {
  const noSecrets = SECRET_PATTERNS.reduce((text, [, re]) => text.replace(re, '[redacted]'), s);
  return INJECTION_PATTERNS.reduce((text, [, re]) => text.replace(re, '[removed]'), noSecrets).replace(/<\/?untrusted-data\b[^>]*>?/gi, '[removed]');
}

/** Violations for steering or credential text in the free-text fields of a commit or proposal. */
function textViolations(fields) {
  const out = [];
  for (const [name, value] of Object.entries(fields)) {
    if (!value) continue;
    for (const [label, re] of SECRET_PATTERNS) {
      if (countMatches(value, re) > 0) out.push({ rule: 'secret', path: null, detail: `the ${name} looks like a ${label}` });
    }
    for (const [label, re] of INJECTION_PATTERNS) {
      if (countMatches(value, re) > 0) out.push({ rule: 'injection-phrase', path: null, detail: `the ${name} contains a ${label}; web text is data, never instructions` });
    }
  }
  return out;
}

/** Text written by other agents (some of which read the web) is data: fenced, with steering phrases blanked. */
const fenceUntrusted = (source, text) => (text ? `${UNTRUSTED_OPEN(source)}\n${scrub(text)}\n${UNTRUSTED_CLOSE}` : '');

// ---------------------------------------------------------------------------------------------- lexing (tests)

const REGEX_PREV = '(,=:[!&|?{};+-*%<>~^';

/**
 * Splits JS source into `code` (comments removed, the contents of strings, templates and regex literals blanked)
 * and `comments`. Heuristic, but symmetric: the same lexer judges HEAD and the working tree, so a mistake in one
 * place cancels out. It stops a commented-out or quoted assertion from counting as an assertion.
 */
export function lexSource(text) {
  const code = [];
  const comments = [];
  const n = text.length;
  let i = 0;
  let prev = '';
  const skipString = (q) => {
    i++;
    while (i < n && text[i] !== q && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1;
    if (text[i] === q) i++;
  };
  const skipRegex = () => {
    let inClass = false;
    i++;
    while (i < n && text[i] !== '\n') {
      if (text[i] === '\\') i++;
      else if (text[i] === '[') inClass = true;
      else if (text[i] === ']') inClass = false;
      else if (text[i] === '/' && !inClass) { i++; return; }
      i++;
    }
  };
  function template() {
    i++;
    while (i < n) {
      if (text[i] === '\\') i += 2;
      else if (text[i] === '`') { i++; return; }
      else if (text[i] === '$' && text[i + 1] === '{') { i += 2; run(true); }
      else i++;
    }
  }
  function run(untilBrace) {
    let depth = 0;
    while (i < n) {
      const c = text[i];
      const d = text[i + 1];
      if (c === '/' && d === '/') {
        let e = text.indexOf('\n', i);
        if (e === -1) e = n;
        comments.push(text.slice(i, e));
        i = e;
      } else if (c === '/' && d === '*') {
        let e = text.indexOf('*/', i + 2);
        e = e === -1 ? n : e + 2;
        comments.push(text.slice(i, e));
        code.push('\n'.repeat((text.slice(i, e).match(/\n/g) ?? []).length));
        i = e;
      } else if (c === '"' || c === "'") { skipString(c); code.push('""'); prev = '"'; }
      else if (c === '`') { template(); code.push('``'); prev = '`'; }
      else if (c === '/' && (prev === '' || REGEX_PREV.includes(prev))) { skipRegex(); code.push('/r/'); prev = '/'; }
      else {
        if (untilBrace) {
          if (c === '{') depth++;
          else if (c === '}') {
            if (depth === 0) { i++; return; }
            depth--;
          }
        }
        code.push(c);
        if (!/\s/.test(c)) prev = c;
        i++;
      }
    }
  }
  run(false);
  return { code: code.join(''), comments: comments.join('\n') };
}

/** What a test file's text adds up to: declarations, assertions and the signs of a hollowed-out test. */
export function testMetrics(text) {
  const { code, comments } = lexSource(text ?? '');
  return {
    decl: countMatches(code, TEST_DECL_RE),
    asserts: countMatches(code, ASSERT_RE),
    skips: countMatches(code, TEST_SKIP_RE),
    disabled: countMatches(code, DISABLED_RE),
    tautologies: countMatches(code, TAUTOLOGY_RE),
    commented: countMatches(comments, COMMENTED_CALL_RE),
  };
}

// ---------------------------------------------------------------------------------------------- protected blocks

const BEGIN_RE = /^\s*(?:<!--\s*protected:begin\b.*?-->|\/\/\s*protected:begin\b.*)\s*$/;
const END_RE = /^\s*(?:<!--\s*protected:end\b.*?-->|\/\/\s*protected:end\b.*)\s*$/;

/** Blocks are whole lines from a begin marker to its end marker, markers included. */
export function parseProtected(text) {
  const blocks = [];
  const errors = [];
  const lines = text.split('\n');
  let offset = 0;
  let open = null;
  lines.forEach((line, i) => {
    if (BEGIN_RE.test(line)) {
      if (open) errors.push(`nested protected:begin at line ${i + 1}`);
      else open = { startLine: i + 1, startOffset: offset, from: i };
    } else if (END_RE.test(line)) {
      if (!open) errors.push(`protected:end without begin at line ${i + 1}`);
      else {
        blocks.push({ startLine: open.startLine, startOffset: open.startOffset, text: lines.slice(open.from, i + 1).join('\n') });
        open = null;
      }
    }
    offset += line.length + 1;
  });
  if (open) errors.push(`protected:begin at line ${open.startLine} is never closed`);
  return { blocks, errors };
}

/** Lexical context at `offset` of JS source: comment, string, template, and nesting depth. Heuristic but conservative. */
export function jsContextAt(text, offset) {
  const end = Math.min(offset, text.length);
  const frames = [];
  let mode = 'code';
  let depth = 0;
  let i = 0;
  let prev = '';
  const regexOk = () => prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev) || /(?:return|typeof|case|delete|void|throw|new|else|do|in|of)$/.test(text.slice(Math.max(0, i - 8), i).trimEnd());
  while (i < end) {
    const c = text[i];
    const n = text[i + 1];
    if (mode === 'tpl') {
      if (c === '\\') i += 2;
      else if (c === '`') { mode = 'code'; prev = '`'; i++; }
      else if (c === '$' && n === '{') { frames.push(depth); depth = 0; mode = 'code'; prev = '{'; i += 2; }
      else i++;
      continue;
    }
    if (c === '/' && n === '/') {
      const nl = text.indexOf('\n', i);
      if (nl === -1 || nl >= end) return 'line-comment';
      i = nl + 1;
    } else if (c === '/' && n === '*') {
      const e = text.indexOf('*/', i + 2);
      if (e === -1 || e + 2 > end) return 'block-comment';
      i = e + 2;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      if (j >= end) return 'string';
      i = j + 1;
      prev = c;
    } else if (c === '`') {
      mode = 'tpl';
      i++;
    } else if (c === '/' && regexOk()) {
      let j = i + 1;
      let inClass = false;
      while (j < text.length && text[j] !== '\n') {
        if (text[j] === '\\') j++;
        else if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        else if (text[j] === '/' && !inClass) break;
        j++;
      }
      if (text[j] === '/') { i = j + 1; prev = '/'; } else { i++; prev = '/'; }
    } else {
      if ('({['.includes(c)) depth++;
      else if (')}]'.includes(c)) {
        if (c === '}' && depth === 0 && frames.length) { depth = frames.pop(); mode = 'tpl'; i++; continue; }
        depth--;
      }
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  }
  return `${mode}:${frames.length}:${depth}`;
}

const isJs = (p) => /\.(?:mjs|cjs|js|ts)$/.test(p);

/** Context of a block's first line: inside an HTML comment (docs) or the JS lexical context (code). */
function blockContext(rel, text, offset) {
  if (isJs(rel)) return jsContextAt(text, offset);
  const prefix = text.slice(0, offset);
  return prefix.lastIndexOf('<!--') > prefix.lastIndexOf('-->') ? 'html-comment' : 'plain';
}

export function checkProtectedBlocks(rel, headText, workText) {
  const found = [];
  const add = (rule, detail) => found.push({ rule, path: rel, detail });
  const head = parseProtected(headText ?? '');
  const headLoose = countMatches(headText ?? '', /protected:begin/g) + countMatches(headText ?? '', /protected:end/g);
  if (workText === null) {
    if (head.blocks.length > 0 || headLoose > 0) add('protected-block-removed', 'a file containing protected blocks was deleted (or renamed away)');
    return found;
  }
  const work = parseProtected(workText);
  for (const e of work.errors) add('protected-markers-unbalanced', e);
  let from = 0;
  head.blocks.forEach((hb, idx) => {
    let hit = -1;
    for (let j = from; j < work.blocks.length; j++) {
      if (work.blocks[j].text === hb.text) { hit = j; break; }
    }
    if (hit === -1) {
      const sameSlot = work.blocks.some((wb) => wb.text.split('\n')[0] === hb.text.split('\n')[0]);
      add(sameSlot ? 'protected-block-changed' : 'protected-block-removed',
        `protected block #${idx + 1} (line ${hb.startLine}) is ${sameSlot ? 'not byte-identical any more' : 'missing'}`);
      return;
    }
    from = hit + 1;
    const before = blockContext(rel, headText, hb.startOffset);
    const after = blockContext(rel, workText, work.blocks[hit].startOffset);
    if (before !== after) {
      add('protected-block-neutralized', `protected block #${idx + 1} is now in a different context (${before} -> ${after}): commented out, quoted or nested`);
    }
  });
  if (found.length === 0) {
    const workLoose = countMatches(workText, /protected:begin/g) + countMatches(workText, /protected:end/g);
    if (workLoose < headLoose) add('protected-marker-count', `protected markers decreased from ${headLoose} to ${workLoose}`);
  }
  return found;
}

// ---------------------------------------------------------------------------------------------- change collection

/** Files hidden from `git diff` with assume-unchanged / skip-worktree could be edited invisibly. */
function hiddenFromGit(g) {
  return g.text(['ls-files', '-v', '-z']).split('\0').filter((l) => /^[a-zS] /.test(l)).map((l) => l.slice(2));
}

/** Everything that differs from HEAD: tracked edits (staged or not), deletions, and untracked files. */
function collectChanges(g, root) {
  const map = new Map();
  const raw = g.text(['diff', 'HEAD', '--raw', '-z', '--no-renames', '--no-ext-diff', '--no-textconv']).split('\0');
  for (let i = 0; i < raw.length; i++) {
    const header = raw[i];
    if (!header.startsWith(':')) continue;
    const [oldMode, newMode, , , status] = header.slice(1).split(/\s+/);
    const rel = raw[++i];
    map.set(rel, { path: rel, status: status[0], oldMode, newMode, added: 0, removed: 0, binary: false, tracked: true });
  }
  const num = g.text(['diff', 'HEAD', '--numstat', '-z', '--no-renames', '--no-ext-diff', '--no-textconv']).split('\0');
  for (const rec of num) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(rec);
    if (!m) continue;
    const e = map.get(m[3]);
    if (!e) continue;
    if (m[1] === '-') e.binary = true;
    else {
      e.added = Number(m[1]);
      e.removed = Number(m[2]);
    }
  }
  for (const rel of g.text(['ls-files', '--others', '--exclude-standard', '-z']).split('\0')) {
    if (!rel) continue;
    map.set(rel, { path: rel, status: '?', oldMode: null, newMode: null, added: 0, removed: 0, binary: false, tracked: false, nested: rel.endsWith('/') });
  }
  // The gate's own advisory list (recordFlaky) is not a member's edit and not foreign dirt: it waits for the orchestrator's next sync.
  map.delete(FLAKY_FILE);
  for (const e of map.values()) {
    const abs = path.join(root, e.path);
    let st = null;
    try {
      st = fs.lstatSync(abs);
    } catch {
      st = null;
    }
    e.exists = st !== null;
    e.isSymlink = st?.isSymbolicLink() ?? false;
    e.isDir = st?.isDirectory() ?? false;
    e.size = st?.isFile() ? st.size : 0;
    e.execBit = st?.isFile() ? (st.mode & 0o111) !== 0 : false;
    if (!e.tracked && st?.isFile()) {
      if (st.size > MAX_FILE_BYTES) {
        e.binary = BINARY_EXT_RE.test(e.path);
        e.added = 0;
      } else {
        const buf = fs.readFileSync(abs);
        e.binary = isBinary(buf);
        e.added = e.binary ? 0 : countLines(buf);
      }
    }
  }
  return map;
}

const workText = (root, e) => {
  if (!e.exists || e.isSymlink || e.isDir) return null;
  const buf = fs.readFileSync(path.join(root, e.path));
  return isBinary(buf) ? null : buf.toString('utf8');
};

// ---------------------------------------------------------------------------------------------- ledger

function readIndex() {
  const file = rp(LEDGER_INDEX);
  if (!fs.existsSync(file)) return { schema: 1, entries: [] };
  const idx = readJson(file);
  if (!idx || typeof idx !== 'object' || !Array.isArray(idx.entries)) {
    throw new KaizenError(`${LEDGER_INDEX}: expected {schema, entries[]}; refusing to overwrite it`, 1);
  }
  return idx;
}

const LOG_HEADER = [
  '# Kaizen log',
  '',
  'Newest first. One entry per member per day. Written only by `scripts/kaizen.mjs` (direct edits are rejected); the machine-readable twin is `INDEX.json`.',
  '',
].join('\n');

export function renderLog(index) {
  const entries = index.entries.map((e, i) => ({ e, i }));
  entries.sort((a, b) => (a.e.date === b.e.date ? b.i - a.i : a.e.date < b.e.date ? 1 : -1));
  if (entries.length === 0) return `${LOG_HEADER}\n_No entries yet. The first member to commit a kaizen starts the log._\n`;
  const blocks = entries.map(({ e }) => {
    const out = [`## ${e.date} · ${e.agent} · ${e.status} · ${e.title}`, ''];
    out.push(`- observation: ${e.observation}`);
    out.push(`- category: ${e.category} · lines changed: ${e.linesChanged}${e.files.length ? ` · files: ${e.files.join(', ')}` : ''}`);
    if (e.sha) out.push(`- commit: ${e.sha.slice(0, 10)}`);
    if (e.question) out.push(`- question: ${e.question}`);
    if (e.reason) out.push(`- ${e.status === 'rejected' ? 'rejected because' : 'note'}: ${e.reason}`);
    return out.join('\n');
  });
  return `${LOG_HEADER}\n${blocks.join('\n\n')}\n`;
}

function atomicWriteText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function saveLedger(index) {
  index.schema = 1;
  writeJsonAtomic(rp(LEDGER_INDEX), index);
  atomicWriteText(rp(LEDGER_LOG), renderLog(index));
}

const entryId = (date, agent) => `${date}-${agent}`;
const findEntry = (index, date, agent) => index.entries.find((e) => e.id === entryId(date, agent)) ?? null;

/** Upsert by (date, agent). Rejected attempts are replaced by later ones; applied/proposed ones are final. */
function upsertEntry(index, entry) {
  const prior = findEntry(index, entry.date, entry.agent);
  if (prior && prior.status !== 'rejected') {
    throw new KaizenError(`${entry.agent} already has a ${prior.status} kaizen for ${entry.date} (${prior.title}); one per member per day`, 1, { id: prior.id });
  }
  if (prior) {
    const note = `earlier attempt rejected: ${prior.reason ?? 'no reason recorded'}`;
    entry.reason = clean(entry.reason ? `${entry.reason}; ${note}` : note, MAX_TEXT);
    index.entries[index.entries.indexOf(prior)] = entry;
  } else {
    index.entries.push(entry);
  }
  return entry;
}

function makeEntry({ date, agent, title, observation, category, question, files, linesChanged, status, reason, sha = null }) {
  return {
    id: entryId(date, agent),
    date,
    agent,
    title: scrub(clean(title, MAX_TITLE)),
    observation: scrub(clean(observation, MAX_TEXT)),
    category,
    files,
    sha,
    status,
    linesChanged,
    question: question ? scrub(clean(question, MAX_QUESTION)) : null,
    reason: reason ? scrub(clean(reason, MAX_TEXT)) : null,
  };
}

function cleanCategory(raw) {
  const c = String(raw ?? '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  if (c.length < 2) throw usage('--category must be a short word such as prevention, clarity, speed, tests, docs, tooling, simplification');
  return c;
}

function requireText(flags, name, max) {
  const v = flags[name];
  if (!v || v === true || !clean(v, max)) throw usage(`missing --${name}`);
  return String(v);
}

// ---------------------------------------------------------------------------------------------- tmp state (baselines, locks)

function stateDir(root) {
  const id = crypto.createHash('sha1').update(fs.realpathSync(root)).digest('hex').slice(0, 12);
  const dir = path.join(os.tmpdir(), `sed-kaizen-${id}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const agentBaselineFile = (root, agent) => path.join(stateDir(root), `baseline-${agent}.json`);
const headBaselineFile = (root, sha) => path.join(stateDir(root), `head-${sha}.json`);
const readJsonSafe = (file) => readJson(file, null);

async function withLock(root, name, fn) {
  const dir = path.join(stateDir(root), `${name}.lock`);
  const take = () => {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'pid'), String(process.pid));
      return true;
    } catch (err) {
      if (err.code === 'EEXIST') return false;
      throw err;
    }
  };
  if (!take()) {
    let stale = false;
    try {
      const age = Date.now() - fs.statSync(dir).mtimeMs;
      const pid = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8'));
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch (err) {
        alive = err.code === 'EPERM';
      }
      stale = age > LOCK_STALE_MS || !alive;
    } catch {
      stale = true;
    }
    if (!stale) throw new KaizenError('another kaizen operation is running in this repository', 1);
    fs.rmSync(dir, { recursive: true, force: true });
    if (!take()) throw new KaizenError('could not take the kaizen lock', 1);
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------- suites and the selective gate

// Three suites, as before: validate (scripts/validate.mjs repo), selfcheck (ops/workflows/_selfcheck.mjs) and tests (tests/*.test.mjs).
// selfcheck and every test file now run as separate `node --test` processes in one pool of gateJobs() workers (what `npm test` does
// with one invocation), longest first, so a file's counts, time, timeout and re-run are its own; `tests` reports their sum.
const VALIDATE_SUITE = { name: 'validate', args: ['scripts/validate.mjs', 'repo'], timeoutMs: 180_000, counts: false };
const SELFCHECK_FILE = 'ops/workflows/_selfcheck.mjs';
const SELFCHECK_TIMEOUT_MS = 600_000;
const TEST_FILE_TIMEOUT_MS = 1_800_000;
const E2E_FILE = 'tests/e2e.test.mjs';
/**
 * The e2e scenarios that read a live doc or the copy of one in their sandbox: the doc lint and its cousins (m, m2..m6: every command,
 * field and cross-reference the docs name), the kaizen days (kz1..kz7: members append lines to role and rubric files under their caps,
 * kz1 reads the PLAYBOOK 6.1 push budget, kz7 the OPERATING.md revert recipe) and the bootstrap scenarios (bs1: the PLAYBOOK 14 final
 * check, bs2: the PLAYBOOK 3.3 session line). Found by grep of the test bodies (n and n2 replay OPERATING.md recipes from their own copy
 * and read no doc); tests/kaizen.test.mjs re-greps them.
 */
export const E2E_DOCS_PATTERN = '^\\((?:m\\d?|kz\\d|bs\\d)\\) ';
const E2E_DOCS = 'e2e:docs';
/**
 * The selective gate (ops/kaizen/README.md "What the gate runs"). A diff whose every path matches a row runs validate plus the union of
 * those rows' suites; any other path (scripts/, tests/, site-src/, ops/lenses.json, which scripts read in every sandbox, or a path not
 * listed) runs everything. A row lists each suite that reads the path (the live file, or the copy a scenario's sandbox carries), found
 * by grep and re-checked by tests/kaizen.test.mjs. `e2e:docs` is tests/e2e.test.mjs limited to E2E_DOCS_PATTERN. What a selective gate
 * leaves out runs once per round in the full verification (`verify`, or the next cold `begin`), which names the partial-gated commits.
 */
export const GATE_MAP = [
  { paths: ['ops/PLAYBOOK.md'], selfcheck: true, files: ['tests/playbook.test.mjs', 'tests/revise-policy.test.mjs', E2E_DOCS] },
  { paths: ['ops/roles/', 'ops/rubrics/', 'ops/CULTURE.md'], selfcheck: true, files: ['tests/playbook.test.mjs', E2E_DOCS] },
  { paths: ['ops/FAILURE_MODES.md', 'ops/OPERATING.md', 'README.md', 'ops/kaizen/proposals/'], selfcheck: false, files: ['tests/playbook.test.mjs', E2E_DOCS] },
  { paths: ['ops/templates/'], selfcheck: true, files: ['tests/playbook.test.mjs', 'tests/qa.test.mjs', E2E_DOCS] },
  { paths: ['ops/workflows/'], selfcheck: true, files: ['tests/playbook.test.mjs', 'tests/revise-policy.test.mjs', E2E_DOCS] },
];
const FULL_PLAN = Object.freeze({ tier: 'full', selfcheck: true, files: null, why: 'every suite' });

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, '')).replace(/(^|[\s;{}(),])\/\/.*$/gm, '$1');

/**
 * Test files of `dir` (e2e aside: its doc scenarios are the subset) whose code, comments removed, names a changed path in a string: the
 * file name (`'lab.md'`, `'PLAYBOOK.md'`), or its directory as a path segment (`'ops/roles'`, `'roles'`). On top of GATE_MAP, so a
 * suite the map does not know (a new one, or a sandbox's own stub) still runs when it reads what changed.
 */
function readersIn(dir, paths) {
  const needles = [];
  for (const p of paths) {
    const parts = p.split('/');
    needles.push(new RegExp(`['"\`](?:[^'"\`\\n]*/)?${escRe(parts.at(-1))}['"\`]`));
    if (parts.length > 2) needles.push(new RegExp(`['"\`](?:[^'"\`\\n]*/)?${escRe(parts.at(-2))}(?:/[^'"\`\\n]*)?['"\`]`));
  }
  return testFiles(dir).filter((f) => {
    if (f === E2E_FILE) return false;
    try {
      const code = stripComments(fs.readFileSync(path.join(dir, f), 'utf8'));
      return needles.some((re) => re.test(code));
    } catch {
      return true; // unreadable: run it
    }
  });
}

/**
 * What the gate runs for the changed `paths`: {tier: full|docs|workflows, selfcheck, files (null = every test file), why}. With `dir`,
 * the test files that name a changed path are added to the GATE_MAP rows (readersIn).
 */
export function gatePlan(paths, dir = null) {
  const files = new Set();
  let selfcheck = false;
  if (!paths.length) return { ...FULL_PLAN };
  for (const p of paths) {
    const row = GATE_MAP.find((r) => r.paths.some((a) => (a.endsWith('/') ? p.startsWith(a) : p === a)));
    if (!row) return { ...FULL_PLAN, why: `${p} is outside the doc paths of the selective gate: every suite runs` };
    selfcheck ||= row.selfcheck;
    for (const f of row.files) files.add(f);
  }
  if (dir) for (const f of readersIn(dir, paths)) files.add(f);
  if (files.has(E2E_FILE)) files.delete(E2E_DOCS);
  const tier = paths.some((p) => p.startsWith('ops/workflows/')) ? 'workflows' : 'docs';
  return { tier, selfcheck, files: [...files].sort(), why: `only doc paths changed: validate${selfcheck ? ', selfcheck' : ''} and ${[...files].sort().join(', ')}` };
}

function suiteTimeout(suite) {
  const override = Number(process.env.SED_KAIZEN_SUITE_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : suite.timeoutMs;
}

/** Test files at once: SED_KAIZEN_JOBS, else what `node --test` uses (one per CPU, less one, at least one). */
function gateJobs() {
  const n = Number(process.env.SED_KAIZEN_JOBS);
  if (Number.isInteger(n) && n >= 1) return Math.min(n, 16);
  const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, cpus - 1);
}

/** tests/*.test.mjs of `dir`, what the shell glob of `npm test` expands to. */
function testFiles(dir) {
  try {
    return fs.readdirSync(path.join(dir, 'tests')).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => `tests/${f}`);
  } catch {
    return [];
  }
}

/** The runnable units of a plan: selfcheck and one job per test file (the repo's, so a sandbox without a mapped suite skips it). */
function planJobs(dir, plan, only) {
  const jobs = [];
  const want = (suite) => !only || only.includes(suite);
  if (want('selfcheck') && plan.selfcheck && fs.existsSync(path.join(dir, SELFCHECK_FILE))) {
    jobs.push({ suite: 'selfcheck', name: 'selfcheck', key: SELFCHECK_FILE, args: ['--test-reporter=tap', SELFCHECK_FILE], timeoutMs: SELFCHECK_TIMEOUT_MS, counts: true, pattern: null });
  }
  if (!want('tests')) return jobs;
  const all = testFiles(dir);
  for (const f of plan.files ?? all) {
    const docs = f === E2E_DOCS;
    const file = docs ? E2E_FILE : f;
    if (!all.includes(file)) continue;
    const key = docs ? `${E2E_FILE}#docs` : file;
    jobs.push({
      suite: 'tests', name: key, key, timeoutMs: TEST_FILE_TIMEOUT_MS, counts: true, pattern: docs ? E2E_DOCS_PATTERN : null,
      args: ['--test', '--test-reporter=tap', ...(docs ? [`--test-name-pattern=${E2E_DOCS_PATTERN}`] : []), file],
    });
  }
  return jobs;
}

function parseCounts(out) {
  const get = (key) => {
    const m = [...out.matchAll(new RegExp(`^# ${key} (\\d+)\\s*$`, 'gm'))].pop();
    return m ? Number(m[1]) : null;
  };
  const counts = { tests: get('tests'), pass: get('pass'), fail: get('fail'), cancelled: get('cancelled'), skipped: get('skipped'), todo: get('todo') };
  return counts.tests === null || counts.pass === null ? null : counts;
}

function runProcess(cwd, args, { timeoutMs, env }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let timedOut = false;
    const keep = (d) => {
      out += d;
      if (out.length > 4_000_000) out = out.slice(-2_000_000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, out: `${out}\nspawn error: ${err.message}`, timedOut, ms: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out, timedOut, ms: Date.now() - started });
    });
  });
}

/**
 * The tests that failed in a TAP report, as "tests/x.test.mjs > suite > test" (leaf failures only: a suite that merely holds a
 * failing test is not listed, and a `# TODO`/`# SKIP` line is not a failure). The file comes from the failure's `location:`.
 * The YAML block under each result is read by its exact indentation, so text inside an `error: |-` block (a nested test run's
 * own output, say) is never taken for a result. Capped; never throws.
 */
export function failedTests(tap, dir = null) {
  let real = dir;
  try {
    real = dir ? fs.realpathSync(dir) : null;
  } catch {
    real = dir;
  }
  const rel = (p) => {
    for (const base of [dir, real]) if (base && p.startsWith(`${base}/`)) return p.slice(base.length + 1);
    return p;
  };
  const unquote = (v) => v.replace(/^'|'$/g, '');
  const stack = [];
  const names = [];
  let pending = null; // the failed result whose YAML block is being read
  let yamlPad = null; // indentation of the open YAML block, `---` to `...`
  const flush = () => {
    if (pending && pending.type !== 'subtestsFailed') {
      const own = rel(pending.name);
      const above = stack.slice(0, pending.depth).filter(Boolean).map(rel).filter((n) => n !== pending.file); // a runner that wraps each file names it in the stack
      const parts = [...(pending.file && pending.file !== own ? [pending.file] : []), ...above, own];
      const name = clean(parts.join(' > '), MAX_FLAKY_NAME);
      if (name && !names.includes(name) && names.length < MAX_FLAKY_NAMES) names.push(name);
    }
    pending = null;
  };
  for (const raw of String(tap ?? '').split('\n')) {
    const line = raw.trimEnd();
    if (yamlPad !== null) {
      if (line === `${yamlPad}...`) {
        yamlPad = null;
        flush();
      } else if (pending && line.startsWith(yamlPad) && line[yamlPad.length] !== ' ') {
        const kv = /^(\w+): (.*)$/.exec(line.slice(yamlPad.length));
        if (kv?.[1] === 'failureType') pending.type = unquote(kv[2]);
        else if (kv?.[1] === 'location') pending.file = rel(unquote(kv[2]).replace(/:\d+:\d+$/, ''));
      }
      continue;
    }
    const open = /^( *)---$/.exec(line);
    if (open) {
      yamlPad = open[1];
      continue;
    }
    flush();
    const sub = /^( *)# Subtest: (.*)$/.exec(line);
    if (sub) {
      const depth = Math.floor(sub[1].length / 4);
      stack.length = depth;
      stack[depth] = sub[2];
      continue;
    }
    const bad = /^( *)not ok \d+ - (.*)$/.exec(line);
    if (bad && !/\s#\s*(?:TODO|SKIP)\b/i.test(bad[2])) pending = { name: bad[2], depth: Math.floor(bad[1].length / 4), type: '', file: '' };
  }
  flush();
  return names;
}

/** One run of one suite. `failed` names the failing tests of a run that failed on its own (not a timeout). */
async function runSuiteOnce(dir, suite, env) {
  const r = await runProcess(dir, suite.args, { timeoutMs: suiteTimeout(suite), env });
  const counts = suite.counts ? parseCounts(r.out) : null;
  const res = {
    ok: r.code === 0 && !r.timedOut,
    code: r.code,
    timedOut: r.timedOut,
    ms: r.ms,
    counts,
    tail: r.out.slice(-SUITE_TAIL_CHARS).trim(),
    failed: [],
  };
  if (res.ok && suite.counts && !counts) {
    res.ok = false;
    res.tail = `could not read the test summary (# tests / # pass) from ${suite.name}\n${res.tail}`;
  }
  if (!res.ok && !res.timedOut) res.failed = failedTests(r.out, dir);
  return res;
}

/**
 * The ONE automatic re-run of a suite that failed on its own, in a fresh empty temp directory (TMPDIR). The second run decides; `retry`
 * keeps what the first one said and `flipped`, the tests that behaved differently in the two runs (the flaky suspects). A second pass
 * names every failure of the first; a second failure names only the tests that differ, so a failure that repeats exactly flips nothing.
 */
async function rerunSuite(dir, suite, env, first) {
  // The re-run gets a fresh, empty temp directory: a cache, lock or fixture that the first run left in the shared one must not be able to
  // cure a failure that the next fresh container would hit again (a cold start, state that only an earlier run created).
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'sed-kaizen-rerun-'));
  let second;
  try {
    second = await runSuiteOnce(dir, suite, { ...env, TMPDIR: fresh, TEMP: fresh, TMP: fresh });
  } finally {
    fs.rmSync(fresh, { recursive: true, force: true });
  }
  let flipped = [];
  if (second.ok) flipped = first.failed.length ? first.failed : [`${suite.name}: unnamed failure`];
  else if (first.counts && second.counts && !second.timedOut) {
    // both runs produced a report: whatever failed in only one of them flipped (a crash or a hang decides nothing)
    flipped = [...first.failed.filter((n) => !second.failed.includes(n)), ...second.failed.filter((n) => !first.failed.includes(n))];
  }
  second.retry = { firstCode: first.code, firstMs: first.ms, firstFailed: first.failed, flipped: flipped.slice(0, MAX_FLAKY_NAMES) };
  return second;
}

const ZERO_COUNTS = Object.freeze({ tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
const sumCounts = (list) => list.reduce((acc, c) => Object.fromEntries(Object.keys(ZERO_COUNTS).map((k) => [k, acc[k] + (c?.[k] ?? 0)])), { ...ZERO_COUNTS });

/** Runs `jobs` with at most `limit` at once, longest first (`hints`: ms per key from an earlier run; else e2e, then selfcheck). */
async function runPool(dir, jobs, env, limit, hints = {}) {
  const guess = (j) => hints[j.key] ?? (j.key === E2E_FILE ? 3e6 : j.pattern ? 2e6 : j.suite === 'selfcheck' ? 1e6 : 0);
  const queue = [...jobs].sort((a, b) => guess(b) - guess(a) || (a.key < b.key ? -1 : 1));
  const out = new Map();
  const worker = async () => {
    while (queue.length) {
      const job = queue.shift();
      out.set(job, await runSuiteOnce(dir, job, env));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, jobs.length)) }, worker));
  return out;
}

/** The `tests` suite of a run: the sum of its files, with each file's own verdict, time and counts under `files`. */
function combineTests(entries, wallMs, partial) {
  const files = {};
  for (const [job, r] of entries) {
    files[job.key] = { ok: r.ok, ms: r.ms, ...(r.counts ? { counts: r.counts } : {}), ...(job.pattern ? { pattern: job.pattern } : {}), ...(r.timedOut ? { timedOut: true } : {}) };
  }
  const bad = entries.filter(([, r]) => !r.ok);
  const worst = bad.find(([, r]) => r.timedOut) ?? bad[0] ?? null;
  const retried = entries.filter(([, r]) => r.retry);
  return {
    ok: bad.length === 0,
    code: worst ? worst[1].code : 0,
    timedOut: bad.some(([, r]) => r.timedOut),
    ms: wallMs,
    counts: sumCounts(entries.map(([, r]) => r.counts)),
    tail: worst ? `${worst[0].key}: ${worst[1].tail}` : (entries.at(-1)?.[1].tail ?? ''),
    failed: bad.flatMap(([, r]) => r.failed ?? []).slice(0, MAX_FLAKY_NAMES),
    files,
    ...(partial ? { partial: true } : {}),
    ...(retried.length ? {
      retry: {
        firstCode: retried[0][1].retry.firstCode,
        firstMs: retried.reduce((n, [, r]) => n + (r.retry.firstMs ?? 0), 0),
        firstFailed: retried.flatMap(([, r]) => r.retry.firstFailed).slice(0, MAX_FLAKY_NAMES),
        flipped: retried.flatMap(([, r]) => r.retry.flipped).slice(0, MAX_FLAKY_NAMES),
      },
    } : {}),
  };
}

/**
 * Runs the suites of `plan` (default: every suite) in `dir`: validate first (it stops the run when it fails, unless `all`), then
 * selfcheck and the test files together in a pool of gateJobs() workers. A file that fails on its own is run ONCE more, alone, after
 * the pool, in a fresh empty temp directory (`retry: false` switches that off): alone, because a failure that only the pool's load
 * provoked must get a quiet second chance. A timeout is never repeated: a hang is not a flake the phase budget can pay for twice.
 */
export async function runSuites(dir, { all = false, only = null, retry = true, plan = FULL_PLAN, hints = {} } = {}) {
  const env = { ...process.env, SED_ROOT: dir, GIT_TERMINAL_PROMPT: '0' };
  delete env.NODE_TEST_CONTEXT; // a nested `node --test` inside a test run would otherwise emit the child protocol, not TAP
  delete env.SED_NOW;
  const results = {};
  if (!only || only.includes('validate')) {
    let res = await runSuiteOnce(dir, VALIDATE_SUITE, env);
    if (!res.ok && retry && !res.timedOut) res = await rerunSuite(dir, VALIDATE_SUITE, env, res);
    results.validate = res;
    if (!res.ok && !all) return results;
  }
  const jobs = planJobs(dir, plan, only);
  if (!jobs.length) return results;
  const started = Date.now();
  const done = await runPool(dir, jobs, env, gateJobs(), hints);
  for (const job of jobs) {
    const first = done.get(job);
    if (!first.ok && retry && !first.timedOut) done.set(job, await rerunSuite(dir, job, env, first));
  }
  const wallMs = Date.now() - started;
  const self = jobs.find((j) => j.suite === 'selfcheck');
  if (self) results.selfcheck = done.get(self);
  const tests = jobs.filter((j) => j.suite === 'tests').map((j) => [j, done.get(j)]);
  if (tests.length) results.tests = combineTests(tests, wallMs, plan.files !== null);
  return results;
}

const suiteFailure = (results) => {
  for (const [name, r] of Object.entries(results)) {
    if (r.ok) continue;
    const tail = clean(r.tail.split('\n').slice(-6).join(' | '), 400);
    if (r.timedOut) return `${name} timed out after ${Math.round(r.ms / 1000)}s: ${tail}`;
    const failing = r.failed?.length ? ` [${r.failed.slice(0, 3).map((n) => n.slice(0, 120)).join('; ')}${r.failed.length > 3 ? `; +${r.failed.length - 3} more` : ''}]` : '';
    return `${name} failed (exit ${r.code})${r.retry ? ', and failed again on the automatic re-run' : ''}${failing}: ${tail}`;
  }
  return null;
};

/**
 * Passing tests must not drop; nothing may start failing, being skipped or turning into a todo. A full run is judged on the sums, a
 * selective (partial) one file by file against the same file in the baseline (a file the baseline has not seen only has to pass).
 */
export function compareCounts(before, after) {
  const problems = [];
  const judge = (name, b, a) => {
    if (!a) return;
    if (a.fail > 0 || a.cancelled > 0) problems.push(`${name}: ${a.fail} failing, ${a.cancelled} cancelled`);
    if (!b) return;
    if (a.pass < b.pass) problems.push(`${name}: passing tests dropped from ${b.pass} to ${a.pass}`);
    if (a.skipped > b.skipped) problems.push(`${name}: skipped tests rose from ${b.skipped} to ${a.skipped}`);
    if (a.todo > b.todo) problems.push(`${name}: todo tests rose from ${b.todo} to ${a.todo}`);
  };
  judge('selfcheck', before?.selfcheck?.counts, after?.selfcheck?.counts);
  const t = after?.tests;
  if (t?.partial && t.files) {
    for (const [key, f] of Object.entries(t.files)) judge(`tests (${key})`, before?.tests?.files?.[key]?.counts, f.counts);
  } else judge('tests', before?.tests?.counts, t?.counts);
  return problems;
}

/**
 * The baseline after a selective run: the files that ran replace their entries, every other file keeps the result it had (the gate
 * map says the diff cannot reach it), and `tests.counts` is summed again over the whole files (a name-filtered run is kept apart).
 */
export function mergeSuites(prev, next) {
  const out = { ...(prev ?? {}), ...next };
  if (next.tests?.partial) {
    const pt = prev?.tests;
    const files = { ...(pt?.files ?? {}), ...next.tests.files };
    const whole = Object.values(files).filter((f) => !f.pattern);
    const { partial, ...rest } = next.tests;
    out.tests = { ...rest, ok: whole.every((f) => f.ok) && rest.ok, files, counts: pt?.files ? sumCounts(whole.map((f) => f.counts)) : pt?.counts ?? rest.counts };
  }
  return out;
}

/**
 * Baseline = suite results for the clean HEAD, cached per HEAD sha (the previous member's passing run is this HEAD's run). A record
 * marked `partial` was carried forward through selective gates; `unverified` lists those commits until a full run (`verify`, or a
 * cold `begin` on a new HEAD) has covered them.
 */
async function baselineFor(ctx) {
  const cached = readJsonSafe(headBaselineFile(ctx.root, ctx.head));
  if (cached?.head === ctx.head && cached.suites) {
    return { suites: cached.suites, cached: true, partial: Boolean(cached.partial), unverified: Array.isArray(cached.unverified) ? cached.unverified : [], red: typeof cached.red === 'string' ? cached.red : null };
  }
  return { suites: await runSuites(ctx.root, { all: true }), cached: false, partial: false, unverified: [], red: null };
}

/**
 * Commits that a selective gate let through and no full run has covered: the baseline's list, else (a new HEAD, a lost temp dir) the
 * kaizen commits of the last revertWindowDays whose Kaizen-Gate trailer is not `full`. Newest first; these are what `verify` or a red
 * cold `begin` names as suspects.
 */
function gateSuspects(ctx, kz, unverified) {
  if (unverified?.length) return [...unverified].reverse().slice(0, 20);
  const r = ctx.g.run(['log', `--since=${kz.revertWindowDays} days ago`, '--grep=^Kaizen-Gate: ', '--format=%H%x1f%B%x1e']);
  if (!r.ok) return [];
  const out = [];
  for (const rec of r.stdout.toString('utf8').split('\x1e')) {
    const [sha, body = ''] = rec.trim().split('\x1f');
    const trailer = (key) => new RegExp(`^${key}: (.*)$`, 'm').exec(body)?.[1]?.trim() ?? null;
    const tier = trailer('Kaizen-Gate');
    if (!sha || !tier || tier === 'full') continue;
    out.push({ sha, agent: trailer('Kaizen-Agent'), date: trailer('Kaizen-Date'), tier, files: (trailer('Kaizen-Files') ?? '').split(', ').filter(Boolean) });
  }
  return out.slice(0, 20);
}

/** What a baseline keeps of a run: counts and verdicts. A re-run's details were recorded when it happened and must not be re-reported by the next member. */
const withoutRetries = (suites) =>
  Object.fromEntries(Object.entries(suites).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).filter(([key]) => key !== 'retry' && key !== 'failed'))]));

function storeBaseline(ctx, agent, head, suites, { partial = false, unverified = [] } = {}) {
  const rec = { schema: 2, head, at: new Date().toISOString(), suites: withoutRetries(suites), partial, unverified: unverified.slice(-40) };
  writeJsonAtomic(headBaselineFile(ctx.root, head), rec);
  if (agent) writeJsonAtomic(agentBaselineFile(ctx.root, agent), { ...rec, agent });
}

/** Per-file ms of a baseline, so the next pool starts the longest file first. */
const timeHints = (suites) => ({
  ...Object.fromEntries(Object.entries(suites?.tests?.files ?? {}).map(([k, f]) => [k, f.ms])),
  ...(suites?.selfcheck?.ms ? { [SELFCHECK_FILE]: suites.selfcheck.ms } : {}),
});

const summarizeSuites = (suites) =>
  Object.fromEntries(Object.entries(suites).map(([k, v]) => [k, {
    ok: v.ok,
    ms: v.ms,
    ...(v.counts ? { pass: v.counts.pass, skipped: v.counts.skipped } : {}),
    ...(v.partial ? { partial: true, files: Object.keys(v.files ?? {}) } : {}),
    ...(v.retry ? { retried: true, ...(v.retry.flipped.length ? { flaky: v.retry.flipped } : {}) } : {}),
  }]));

// ---------------------------------------------------------------------------------------------- flaky suspects

/** state/flaky-suspects.json, sanitized: whatever is on disk, the caller gets a well-formed, capped list. */
function readFlaky() {
  const raw = readJson(rp(FLAKY_FILE), null);
  const suspects = [];
  for (const s of Array.isArray(raw?.suspects) ? raw.suspects : []) {
    if (!s || typeof s.test !== 'string' || !clean(s.test, MAX_FLAKY_NAME)) continue;
    suspects.push({
      test: scrub(clean(s.test, MAX_FLAKY_NAME)),
      suite: typeof s.suite === 'string' && clean(s.suite, 20) ? clean(s.suite, 20) : 'tests',
      count: Number.isInteger(s.count) && s.count > 0 ? Math.min(s.count, 9999) : 1,
      firstSeen: DATE_RE.test(String(s.firstSeen)) ? s.firstSeen : null,
      lastSeen: DATE_RE.test(String(s.lastSeen)) ? s.lastSeen : null,
      lastBy: typeof s.lastBy === 'string' && clean(s.lastBy, 20) ? clean(s.lastBy, 20) : null,
    });
  }
  return { suspects: suspects.slice(0, MAX_FLAKY_SUSPECTS) };
}

/** Suites that were re-run and whose two runs disagreed about at least one test: [{suite, rescued, tests[]}]. */
function flakyIncidents(suites) {
  return Object.entries(suites ?? {})
    .filter(([, r]) => r?.retry?.flipped?.length)
    .map(([suite, r]) => ({ suite, rescued: r.ok === true, tests: r.retry.flipped }));
}

const flakyNotes = (incidents) =>
  incidents.map((i) => `flaky-suspect: ${i.suite} ${i.rescued ? 'failed once and passed on the automatic re-run' : 'failed, and its automatic re-run failed differently'}: ${i.tests.slice(0, 3).join('; ')}${i.tests.length > 3 ? ` (+${i.tests.length - 3} more)` : ''}`);

/**
 * Appends the incidents to state/flaky-suspects.json (newest first, capped, atomic write). The file is advisory and written while the
 * ledger lock is held; it stays uncommitted like state/kaizen-queue.json, and the orchestrator's `sync` carries it. A failed write
 * is only logged: it must never turn a good kaizen into a rejected one.
 */
function recordFlaky(incidents, { date, agent }) {
  if (incidents.length === 0) return;
  try {
    const { suspects } = readFlaky();
    for (const inc of incidents) {
      for (const test of inc.tests) {
        let s = suspects.find((x) => x.test === test);
        if (!s) suspects.push((s = { test, suite: inc.suite, count: 0, firstSeen: date, lastSeen: date, lastBy: agent }));
        s.count = Math.min(9999, s.count + 1);
        s.suite = inc.suite;
        s.lastSeen = date;
        s.lastBy = agent;
      }
    }
    suspects.sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? '') || b.count - a.count || a.test.localeCompare(b.test));
    writeJsonAtomic(rp(FLAKY_FILE), {
      schema: 1,
      note: 'Advisory. Tests whose first run failed and whose automatic re-run passed (scripts/kaizen.mjs re-runs a failing suite once). Written only by the gate; newest first, capped.',
      suspects: suspects.slice(0, MAX_FLAKY_SUSPECTS),
    });
  } catch (err) {
    process.stderr.write(`kaizen: could not record flaky suspects: ${err.message}\n`);
  }
}

/** Records and returns the flaky incidents of one batch of suite results. */
function noteFlaky(suites, meta) {
  const incidents = flakyIncidents(suites);
  recordFlaky(incidents, meta);
  return incidents;
}

function flakySummary() {
  const { suspects } = readFlaky();
  return {
    file: FLAKY_FILE,
    count: suspects.length,
    top: suspects.slice(0, 8).map((s) => ({ test: scrub(s.test), suite: s.suite, count: s.count, lastSeen: s.lastSeen })),
    ...(suspects.length ? { hint: 'These tests failed once and passed on the automatic re-run. Making one deterministic (a fixed clock, a unique temp dir, waiting on a condition) is a welcome kaizen; never loosen its assertion.' } : {}),
  };
}

// ---------------------------------------------------------------------------------------------- the check

/** Entries dated after `today` (a ledger written under a skewed clock) count as recent: they must never vanish from a digest or a revert check. */
function inWindow(entryDate, today, days) {
  const age = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${entryDate}T00:00:00Z`)) / 86_400_000;
  return age <= days;
}

const meaningful = (line) => line.trim().length >= MIN_MEANINGFUL_LINE;

/** {file: {added[], removed[]}} from a zero-context unified diff. */
function parseDiffLines(diffText) {
  const files = new Map();
  let cur = null;
  for (const line of diffText.split('\n')) {
    const head = /^diff --git a\/(.+) b\/\1$/.exec(line);
    if (head) {
      cur = { added: [], removed: [] };
      files.set(head[1], cur);
    } else if (cur && line.startsWith('+') && !line.startsWith('+++')) cur.added.push(line.slice(1));
    else if (cur && line.startsWith('-') && !line.startsWith('---')) cur.removed.push(line.slice(1));
  }
  return files;
}

const DIFF_FLAGS = ['-U0', '--no-renames', '--no-ext-diff', '--no-textconv'];

/** Lines the working tree adds to / removes from HEAD for one changed file (an untracked file is all additions). */
function workingDiffLines(ctx, change) {
  if (!change.tracked) {
    const text = workText(ctx.root, change);
    return { added: text === null ? [] : text.split('\n'), removed: [] };
  }
  const out = ctx.g.run(['diff', 'HEAD', ...DIFF_FLAGS, '--', change.path]);
  return parseDiffLines(out.stdout.toString('utf8')).get(change.path) ?? { added: [], removed: [] };
}

/** How many of `lines` are found (as a multiset, trimmed, trivial lines ignored) in `pool`. */
function overlap(lines, pool) {
  const bag = new Map();
  for (const l of pool) if (meaningful(l)) bag.set(l.trim(), (bag.get(l.trim()) ?? 0) + 1);
  let hit = 0;
  let total = 0;
  for (const l of lines) {
    if (!meaningful(l)) continue;
    total++;
    const k = l.trim();
    if (bag.get(k) > 0) {
      bag.set(k, bag.get(k) - 1);
      hit++;
    }
  }
  return { hit, total };
}

/**
 * A recent applied kaizen is "undone" when, in any one of its files, more than half of the lines it added are removed
 * again or more than half of the lines it removed are put back (a whole-file revert is the extreme case). Judged per
 * hunk, so adding a line to the pre-kaizen text or reverting only some files does not hide it.
 */
function detectReverts(ctx, kz, changes, today) {
  const hits = [];
  const index = readIndex();
  for (const e of index.entries) {
    if (e.status !== 'applied' || !e.sha || !Array.isArray(e.files) || e.files.length === 0) continue;
    if (!inWindow(e.date, today, kz.revertWindowDays)) continue;
    if (!e.files.some((f) => changes.has(f))) continue;
    if (!ctx.g.run(['rev-parse', '--verify', '-q', `${e.sha}^{commit}`]).ok || !ctx.g.run(['rev-parse', '--verify', '-q', `${e.sha}^`]).ok) continue;
    const kd = parseDiffLines(ctx.g.run(['diff', `${e.sha}^`, e.sha, ...DIFF_FLAGS, '--', ...e.files]).stdout.toString('utf8'));
    let worst = 0;
    for (const [file, k] of kd) {
      const change = changes.get(file);
      if (!change || change.isDir || change.isSymlink) continue;
      const w = workingDiffLines(ctx, change);
      const gone = overlap(k.added, w.removed);
      const back = overlap(k.removed, w.added);
      const total = gone.total + back.total;
      if (total > 0) worst = Math.max(worst, (gone.hit + back.hit) / total);
    }
    if (worst > REVERT_RATIO) hits.push({ ...e, share: worst });
  }
  return hits;
}

/** Evidence of harm must name a run that happened: a date for which state/runs/ or state/reports/ has a record at HEAD. */
function evidenceNamesARun(ctx, evidence) {
  if (!evidence || clean(evidence, 400).length < 20) return false;
  const known = new Set(
    ctx.g.text(['ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', 'state/runs', 'state/reports']).split('\0')
      .map((f) => /(\d{4}-\d{2}-\d{2})/.exec(f)?.[1]).filter(Boolean),
  );
  return (String(evidence).match(/\d{4}-\d{2}-\d{2}/g) ?? []).some((d) => known.has(d));
}

/**
 * Working tree vs HEAD against every rule of CONTRACT 12.4 that can be judged without running tests.
 * Returns { ok, violations[], warnings[], stats }. Read-only.
 */
export function runCheck(ctx, kz, { agent = null, evidence = null, today = null } = {}) {
  const violations = [];
  const warnings = [];
  let total = 0;
  const add = (rule, p, detail) => {
    total++;
    if (violations.length < MAX_VIOLATIONS) violations.push({ rule, path: p ?? null, detail });
  };
  const ledgerFold = LEDGER_FILES.map(fold);

  if (agent) {
    const base = readJsonSafe(agentBaselineFile(ctx.root, agent));
    if (base?.head && base.head !== ctx.head) {
      add('head-moved', null, `HEAD moved from ${base.head.slice(0, 10)} to ${ctx.head.slice(0, 10)} since begin; agents never run git commit. kaizen.mjs will not reset commits: ask the owner to review`);
    }
  }

  for (const p of hiddenFromGit(ctx.g)) add('index-flags', p, 'marked assume-unchanged or skip-worktree, which hides edits from the gate');

  const changes = collectChanges(ctx.g, ctx.root);
  const entries = [...changes.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  const detail = entries.length <= CONTENT_SCAN_MAX_FILES;
  let added = 0;
  let removed = 0;

  for (const e of entries) {
    const p = e.path;
    added += e.added;
    removed += e.removed;
    const bad = badPathReason(p.replace(/\/$/, ''));
    if (bad) {
      add('bad-path', p, bad);
      continue;
    }
    if (e.nested) {
      add('submodule', p, 'a nested git repository cannot be part of a kaizen');
      continue;
    }
    if (ledgerFold.includes(fold(p))) {
      add('ledger-edit', p, 'the ledger is written only by kaizen.mjs');
    } else if (isProtected(p, kz.protectedPaths)) {
      const how = e.status === 'D' ? 'deleting' : e.status === '?' || e.status === 'A' ? 'creating (or renaming onto)' : 'editing';
      add('protected-path', p, `${how} a protected path; write a proposal (kaizen.mjs propose) instead`);
    } else if (!isAllowed(p, kz.allowedPaths)) {
      const lookalike = kz.allowedPaths.some((a) => (a.endsWith('/') ? fold(p).startsWith(fold(a)) : fold(p) === fold(a)));
      add('path-not-allowed', p, lookalike ? 'differs from an allowed path only by case or look-alike characters' : 'outside config.kaizen.allowedPaths');
    }
    for (const mode of [e.oldMode, e.newMode]) {
      if (mode === '120000') add('symlink', p, 'symbolic links are not allowed in a kaizen');
      if (mode === '160000') add('submodule', p, 'submodule/gitlink changes are not allowed');
    }
    if (e.isSymlink && e.newMode !== '120000') add('symlink', p, 'symbolic links are not allowed in a kaizen');
    if (e.status === 'T') add('type-change', p, 'a file changed type (file/symlink/directory)');
    if (e.tracked && e.oldMode && e.newMode && e.status !== 'D' && e.status !== 'A' && ((parseInt(e.oldMode, 8) & 0o111) !== (parseInt(e.newMode, 8) & 0o111))) {
      add('exec-bit', p, `executable bit changed (${e.oldMode} -> ${e.newMode})`);
    }
    if ((e.status === '?' || e.status === 'A') && e.execBit) add('exec-bit', p, 'new files must not be executable');
    if (e.binary || (e.status === '?' && BINARY_EXT_RE.test(p))) add('binary-file', p, 'binary files are not allowed in a kaizen');
    if (e.size > MAX_FILE_BYTES) add('file-too-large', p, `${e.size} bytes exceeds ${MAX_FILE_BYTES}`);
    if (TEST_FILE_RE.test(p) && e.status === 'D') add('test-file-deleted', p, 'test files cannot be deleted (or renamed away)');
  }

  const changedLines = added + removed;
  if (entries.length > kz.maxFiles) add('too-many-files', null, `${entries.length} files changed; the cap is ${kz.maxFiles}`);
  if (changedLines > kz.maxChangedLines) add('too-many-lines', null, `${changedLines} lines changed (added+removed); the cap is ${kz.maxChangedLines}`);

  if (detail) {
    let testsGrew = false;
    const editedAssertions = [];
    for (const e of entries) {
      if (e.nested || e.isDir || e.isSymlink || e.binary) continue;
      const p = e.path;
      const headBuf = e.status === '?' || e.status === 'A' ? null : headBlob(ctx.g, p);
      const headTxt = headBuf && !isBinary(headBuf) ? headBuf.toString('utf8') : null;
      const workTxt = e.status === 'D' ? null : workText(ctx.root, e);

      if (headTxt !== null || e.status === 'D') {
        for (const f of checkProtectedBlocks(p, headTxt, workTxt)) add(f.rule, f.path, f.detail);
      } else if (workTxt !== null) {
        const parsed = parseProtected(workTxt);
        for (const err of parsed.errors) add('protected-markers-unbalanced', p, err);
      }
      if (workTxt === null) continue;
      const before = headTxt ?? '';

      for (const [label, re] of SECRET_PATTERNS) {
        if (countMatches(workTxt, re) > countMatches(before, re)) add('secret', p, `looks like a ${label}`);
      }
      for (const [label, re] of INJECTION_PATTERNS) {
        if (countMatches(workTxt, re) > countMatches(before, re)) add('injection-phrase', p, `adds a ${label}; web text is data, never instructions`);
      }
      const cap = kz.docLineCaps[p];
      if (cap) {
        const lines = countLines(Buffer.from(workTxt));
        if (lines > cap && lines > countLines(Buffer.from(before))) add('doc-line-cap', p, `${lines} lines exceeds the ${cap}-line cap`);
      }
      if (PROMPT_FILE_RE.test(p)) {
        const bytes = Buffer.byteLength(workTxt);
        if (bytes > MAX_PROMPT_BYTES && bytes > Buffer.byteLength(before)) {
          add('prompt-file-too-large', p, `${bytes} bytes exceeds the ${MAX_PROMPT_BYTES}-byte cap for files every agent reads daily (a file already over it may shrink)`);
        }
      }
      if (TEST_FILE_RE.test(p)) {
        const was = testMetrics(before);
        const now = testMetrics(workTxt);
        if (now.decl < was.decl) add('test-removed', p, `test declarations dropped from ${was.decl} to ${now.decl}`);
        if (now.decl > was.decl && TEST_SUITE_RE.test(p)) testsGrew = true;
        if (now.skips > was.skips) add('test-skipped', p, 'adds .skip/.todo/.only/skip:/todo: to a test');
        if (now.asserts < was.asserts) add('test-weakened', p, `assertion calls dropped from ${was.asserts} to ${now.asserts} (comments and strings do not count); add a test instead of loosening one`);
        if (now.commented > was.commented) add('test-commented-out', p, 'an assertion or test declaration was moved into a comment');
        if (now.disabled > was.disabled) add('test-disabled', p, 'adds an early return, a dead branch or an exit that can stop a test from running its assertions');
        if (now.tautologies > was.tautologies) add('test-tautology', p, 'adds an assertion that cannot fail (assert.ok(true), assert.equal(x, x))');
        if (e.status === 'M' && e.tracked) editedAssertions.push(p);
      }
    }
    if (entries.some((e) => TEST_SUPPORT_RE.test(e.path)) && !testsGrew) {
      for (const e of entries.filter((x) => TEST_SUPPORT_RE.test(x.path))) {
        add('test-support-change', e.path, 'test helpers and fixtures may only change together with a new test in tests/*.test.mjs (they can silently weaken every test that uses them)');
      }
    }
    if (editedAssertions.length > 0 && entries.some((e) => CODE_FILE_RE.test(e.path) && !TEST_FILE_RE.test(e.path))) {
      for (const p of editedAssertions) {
        const removedAsserts = (parseDiffLines(ctx.g.run(['diff', 'HEAD', ...DIFF_FLAGS, '--', p]).stdout.toString('utf8')).get(p)?.removed ?? [])
          .filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l) && countMatches(l, ASSERT_RE) > 0);
        if (removedAsserts.length > 0) add('assertion-edited-with-code', p, `${removedAsserts.length} existing assertion line(s) changed in the same commit as code: change the code and add a new test, or change the test, never both`);
      }
    }
    if (today) {
      for (const hit of detectReverts(ctx, kz, changes, today)) {
        const msg = `reverts ${hit.id} ("${hit.title}", ${Math.round(hit.share * 100)}% of its lines) inside the ${kz.revertWindowDays}-day window`;
        if (evidenceNamesARun(ctx, evidence)) warnings.push(`${msg}; evidence of harm supplied`);
        else add('revert-of-recent-kaizen', null, `${msg}; pass --evidence "<what broke, naming the run date (YYYY-MM-DD) from state/runs or state/reports>" if it did harm`);
      }
    }
  } else if (entries.length > kz.maxFiles) {
    warnings.push(`content checks skipped: ${entries.length} changed files is far beyond the cap`);
  }

  return {
    ok: violations.length === 0,
    violations,
    ...(total > violations.length ? { violationsTruncated: total - violations.length } : {}),
    warnings,
    stats: { files: entries.length, added, removed, changedLines, paths: entries.map((e) => e.path).slice(0, 200) },
  };
}

// ---------------------------------------------------------------------------------------------- restoring

function pruneEmptyDirs(root, rel) {
  let dir = path.dirname(path.join(root, rel));
  while (dir.startsWith(root + path.sep)) {
    try {
      fs.rmdirSync(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

/** An ancestor directory swapped for a symlink (or a file) hides the whole subtree from git: remove that one link, never follow it. */
function clearBlockedAncestors(root, rel) {
  const segs = rel.split('/').slice(0, -1);
  let cur = root;
  for (const seg of segs) {
    cur = path.join(cur, seg);
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch {
      return;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      fs.rmSync(cur, { force: true });
      return;
    }
  }
}

const inRuntimeArea = (p) => RUNTIME_AREAS.some((a) => fold(p).startsWith(a));

/**
 * Puts exactly `paths` back to HEAD: tracked ones are restored (index and worktree), new ones are removed.
 * Returns what was verified afterwards, not what was attempted: `remaining` lists paths that are still dirty.
 */
function restorePaths(ctx, paths) {
  const { g, root } = ctx;
  const inHead = new Set(g.text(['ls-tree', '-r', '--name-only', '-z', 'HEAD']).split('\0').filter(Boolean));
  const safe = [...new Set(paths.map((p) => p.replace(/\/$/, '')))].filter((p) => !badPathReason(p));
  const wanted = new Set(safe);
  let remaining = safe;
  for (let pass = 0; pass < 2 && remaining.length > 0; pass++) {
    const tracked = remaining.filter((p) => inHead.has(p));
    const fresh = remaining.filter((p) => !inHead.has(p));
    for (const p of remaining) clearBlockedAncestors(root, p);
    for (const p of tracked) {
      const abs = path.join(root, p);
      try {
        const st = fs.lstatSync(abs);
        if (st.isSymbolicLink() || st.isDirectory()) fs.rmSync(abs, { recursive: true, force: true });
      } catch {
        // missing: restore recreates it
      }
    }
    for (const p of fresh) {
      g.run(['rm', '--cached', '-f', '-q', '--ignore-unmatch', '--', p]);
      fs.rmSync(path.join(root, p), { recursive: true, force: true });
      pruneEmptyDirs(root, p);
    }
    for (let i = 0; i < tracked.length; i += 100) {
      const r = g.run(['restore', '--source=HEAD', '--staged', '--worktree', '--', ...tracked.slice(i, i + 100)]);
      if (!r.ok) throw new KaizenError(`could not restore files to HEAD: ${firstLine(r.stderr)}`, 1);
    }
    remaining = dirtyPaths(ctx).filter((p) => wanted.has(p.replace(/\/$/, '')));
  }
  const still = new Set(remaining);
  const left = safe.filter((p) => still.has(p));
  return {
    restored: safe.filter((p) => inHead.has(p) && !still.has(p)).length,
    removed: safe.filter((p) => !inHead.has(p) && !still.has(p)).length,
    remaining: left,
  };
}

// ---------------------------------------------------------------------------------------------- committing

function identityEnv(g) {
  const has = (key) => g.run(['config', '--get', key]).ok;
  const env = {};
  if (!has('user.name')) {
    env.GIT_AUTHOR_NAME = FALLBACK_IDENTITY.name;
    env.GIT_COMMITTER_NAME = FALLBACK_IDENTITY.name;
  }
  if (!has('user.email')) {
    env.GIT_AUTHOR_EMAIL = FALLBACK_IDENTITY.email;
    env.GIT_COMMITTER_EMAIL = FALLBACK_IDENTITY.email;
  }
  return env;
}

function gitCommit(ctx, message, pathspec = null) {
  const extraEnv = identityEnv(ctx.g);
  const args = ['commit', '-q', '-F', '-', ...(pathspec ? ['--only', '--', ...pathspec] : [])];
  let r = ctx.g.run(args, { input: message, extraEnv });
  if (!r.ok && /gpg|sign(ing)? (failed|error)|failed to sign|signing (key|program)/i.test(r.stderr)) {
    r = ctx.g.run(['-c', 'commit.gpgsign=false', ...args], { input: message, extraEnv });
  }
  if (!r.ok) throw new KaizenError(`git commit failed: ${firstLine(r.stderr)}`, 1);
  return ctx.g.text(['rev-parse', 'HEAD']).trim();
}

function commitMessage(entry, trailers) {
  const head = `kaizen(${entry.agent}): ${entry.status === 'applied' ? '' : `${entry.status}: `}${entry.title}`;
  return [
    head,
    '',
    `Observation: ${entry.observation}`,
    ...(entry.question ? [`Question: ${entry.question}`] : []),
    '',
    `Kaizen-Agent: ${entry.agent}`,
    `Kaizen-Date: ${entry.date}`,
    `Kaizen-Category: ${entry.category}`,
    `Kaizen-Status: ${entry.status}`,
    `Kaizen-Lines: ${entry.linesChanged}`,
    ...trailers,
    'Co-Authored-By: Claude <noreply@anthropic.com>',
    '',
  ].join('\n');
}

/** A second, ledger-only commit records the sha of the first (a commit cannot contain its own hash). Best effort. */
function stampSha(ctx, entry, sha) {
  try {
    const index = readIndex();
    const live = index.entries.find((e) => e.id === entry.id);
    if (!live) return null;
    live.sha = sha;
    saveLedger(index);
    const add = ctx.g.run(['add', '--', ...LEDGER_FILES]);
    if (!add.ok) return `stamp: ${firstLine(add.stderr)}`;
    gitCommit(ctx, `kaizen(${entry.agent}): record commit ${sha.slice(0, 10)} in the ledger\n\nKaizen-Agent: ${entry.agent}\nKaizen-Date: ${entry.date}\nCo-Authored-By: Claude <noreply@anthropic.com>\n`, LEDGER_FILES);
    return null;
  } catch (err) {
    return `stamp: ${err.message}`;
  }
}

function dirtyPaths(ctx) {
  return [...collectChanges(ctx.g, ctx.root).keys()];
}

/** Rejection: restore the member's touched files, log a `rejected` entry (a learning), commit only the ledger. */
function reject(ctx, base, reason, extra = {}) {
  const warnings = [];
  let restoreInfo = null;
  try {
    const dirty = dirtyPaths(ctx);
    // state/, docs/ and work/ belong to the orchestrator: a kaizen never restores (or reverts) them.
    const foreign = dirty.filter(inRuntimeArea);
    restoreInfo = restorePaths(ctx, dirty.filter((p) => !inRuntimeArea(p)));
    if (restoreInfo.remaining.length) warnings.push(`restore incomplete, still dirty: ${restoreInfo.remaining.slice(0, 6).join(', ')}; inspect with git status`);
    if (foreign.length) warnings.push(`left untouched (orchestrator areas): ${foreign.slice(0, 6).join(', ')}`);
  } catch (err) {
    warnings.push(`restore: ${err.message}`);
  }
  let sha = null;
  let entry = null;
  try {
    const index = readIndex();
    entry = makeEntry({ ...base, files: [], linesChanged: extra.linesChanged ?? 0, status: 'rejected', reason });
    upsertEntry(index, entry);
    saveLedger(index);
    const add = ctx.g.run(['add', '--', ...LEDGER_FILES]);
    if (!add.ok) throw new KaizenError(firstLine(add.stderr), 1);
    sha = gitCommit(ctx, commitMessage(entry, []), LEDGER_FILES);
    if (base.agent) {
      const prev = readJsonSafe(agentBaselineFile(ctx.root, base.agent));
      // The restored tree is the tree the baseline was taken on, plus a ledger entry that changes no test: its results are the new HEAD's
      // results too, so the next member's `begin` need not run every suite again (a rejection would otherwise cost a full cold run).
      if (prev?.suites && prev.head === ctx.head) storeBaseline(ctx, base.agent, sha, prev.suites, { partial: Boolean(prev.partial), unverified: prev.unverified ?? [] });
      else if (prev) writeJsonAtomic(agentBaselineFile(ctx.root, base.agent), { ...prev, head: sha });
    }
  } catch (err) {
    warnings.push(`ledger: ${err.message}`);
  }
  return {
    ok: false,
    status: 'rejected',
    id: entry?.id ?? entryId(base.date, base.agent),
    reason,
    ...(extra.violations ? { violations: extra.violations } : {}),
    ...(extra.suites ? { suites: summarizeSuites(extra.suites) } : {}),
    ...(extra.flaky?.length ? { flaky: extra.flaky } : {}),
    restored: restoreInfo,
    ledgerCommit: sha,
    ...(warnings.length ? { warnings } : {}),
  };
}

/**
 * state/, docs/ and work/ are written by the orchestrator, never by a kaizen. If they are dirty when a member commits,
 * the gate cannot tell whose edit it would be restoring, so it does nothing: no restore, no ledger entry, no commit.
 */
function refuseForeignDirt(ctx) {
  const foreign = dirtyPaths(ctx).filter(inRuntimeArea);
  if (foreign.length) {
    throw new KaizenError(
      `foreign-dirty: ${foreign.length} uncommitted path${foreign.length === 1 ? '' : 's'} in ${RUNTIME_AREAS.join(', ')} (${foreign.slice(0, 5).join(', ')}); these belong to the orchestrator, so nothing was restored, logged or committed. Sync or revert them, then run commit again`,
      1,
      { rule: 'foreign-dirty', dirty: foreign.slice(0, 50) },
    );
  }
}

async function cmdCommit(ctx, kz, flags, tz) {
  const agent = requireAgent(flags, kz);
  const date = resolveToday(flags, tz);
  const title = clean(requireText(flags, 'title', MAX_TITLE), MAX_TITLE);
  const observation = clean(requireText(flags, 'observation', MAX_TEXT), MAX_TEXT);
  const category = cleanCategory(requireText(flags, 'category', 40));
  const question = flags.question && flags.question !== true ? clean(flags.question, MAX_QUESTION) : null;
  const evidence = flags.evidence && flags.evidence !== true ? clean(flags.evidence, 400) : null;
  const base = { date, agent, title, observation, category, question };

  return withLock(ctx.root, 'ledger', async () => {
    const prior = findEntry(readIndex(), date, agent);
    if (prior && prior.status !== 'rejected') {
      throw new KaizenError(`${agent} already has a ${prior.status} kaizen for ${date} (${prior.title}); one per member per day`, 1, { id: prior.id });
    }
    const baseline = readJsonSafe(agentBaselineFile(ctx.root, agent)) ?? readJsonSafe(headBaselineFile(ctx.root, ctx.head));
    if (!baseline?.suites) {
      throw new KaizenError(`no baseline for ${agent}: run \`kaizen.mjs begin --agent ${agent}\` on a clean tree first`, 2);
    }

    refuseForeignDirt(ctx);
    const check = runCheck(ctx, kz, { agent, evidence, today: date });
    const violations = [...textViolations({ title, observation, question }), ...check.violations];
    if (check.stats.files === 0 && violations.length === 0) {
      return reject(ctx, base, 'empty diff: no files changed, so there is nothing to commit', { violations: [{ rule: 'empty-diff', path: null, detail: 'no changes against HEAD' }] });
    }
    if (violations.length > 0) {
      const summary = violations.slice(0, 4).map((v) => `${v.rule}${v.path ? ` ${v.path}` : ''}`).join('; ');
      return reject(ctx, base, `check failed: ${summary}${violations.length > 4 ? ` (+${violations.length - 4} more)` : ''}`, { violations, linesChanged: check.stats.changedLines });
    }

    const touched = dirtyPaths(ctx);
    // The selective gate: a diff of doc paths runs only the suites that read them (GATE_MAP); everything else runs every suite.
    // A baseline without per-file results (written before the gate was selective) cannot judge a selective run: run everything.
    const plan = baseline.suites.tests?.files || !baseline.suites.tests ? gatePlan(check.stats.paths, ctx.root) : { ...FULL_PLAN, why: 'the baseline has no per-file results' };
    const suites = await runSuites(ctx.root, { plan, hints: timeHints(baseline.suites) });
    const flaky = noteFlaky(suites, { date, agent });
    const failure = suiteFailure(suites);
    if (failure) return reject(ctx, base, failure, { suites, linesChanged: check.stats.changedLines, flaky });
    const drops = compareCounts(baseline.suites, suites);
    if (drops.length) return reject(ctx, base, drops.join('; '), { suites, linesChanged: check.stats.changedLines, flaky });
    const after = dirtyPaths(ctx);
    const strays = after.filter((p) => !touched.includes(p));
    if (strays.length) {
      return reject(ctx, base, `the suites left files behind: ${strays.slice(0, 4).join(', ')}`, { suites, linesChanged: check.stats.changedLines, flaky });
    }

    const files = check.stats.paths;
    const harm = evidence && check.warnings.some((w) => w.startsWith('reverts')) ? `evidence of harm: ${evidence}` : null;
    const index = readIndex();
    const entry = makeEntry({ ...base, files, linesChanged: check.stats.changedLines, status: 'applied', reason: [harm, ...flakyNotes(flaky)].filter(Boolean).join('; ') || null });
    upsertEntry(index, entry);
    saveLedger(index);
    const validated = await runSuites(ctx.root, { only: ['validate'] });
    flaky.push(...noteFlaky(validated, { date, agent }));
    if (!validated.validate?.ok) {
      return reject(ctx, base, `validate repo failed after the ledger entry was added: ${suiteFailure(validated)}`, { suites, linesChanged: check.stats.changedLines, flaky });
    }

    const stage = ctx.g.run(['add', '-A', '--', ...files, ...LEDGER_FILES]);
    if (!stage.ok) return reject(ctx, base, `git add failed: ${firstLine(stage.stderr)}`, { suites, linesChanged: check.stats.changedLines, flaky });
    const staged = ctx.g.text(['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean);
    const expected = new Set([...files, ...LEDGER_FILES]);
    const unexpected = staged.filter((p) => !expected.has(p));
    if (unexpected.length) return reject(ctx, base, `unexpected staged paths: ${unexpected.slice(0, 4).join(', ')}`, { suites, linesChanged: check.stats.changedLines, flaky });

    let sha;
    try {
      sha = gitCommit(ctx, commitMessage(entry, [`Kaizen-Files: ${files.join(', ')}`, `Kaizen-Gate: ${plan.tier}`]));
    } catch (err) {
      return reject(ctx, base, err.message, { suites, linesChanged: check.stats.changedLines, flaky });
    }
    const stampWarning = stampSha(ctx, entry, sha);
    const finalHead = ctx.g.text(['rev-parse', 'HEAD']).trim();
    if (plan.files === null) storeBaseline(ctx, agent, finalHead, suites);
    else {
      const unverified = [...(baseline.unverified ?? []), { sha, agent, date, tier: plan.tier, files }];
      storeBaseline(ctx, agent, finalHead, mergeSuites(baseline.suites, suites), { partial: true, unverified });
    }
    const leftover = dirtyPaths(ctx);
    return {
      ok: true,
      status: 'applied',
      id: entry.id,
      sha,
      files,
      linesChanged: check.stats.changedLines,
      gate: { tier: plan.tier, why: plan.why },
      suites: summarizeSuites(suites),
      ...(flaky.length ? { flaky } : {}),
      warnings: [...check.warnings, ...flakyNotes(flaky), ...(stampWarning ? [stampWarning] : []), ...(leftover.length ? [`working tree not clean after commit: ${leftover.slice(0, 4).join(', ')}`] : [])],
    };
  });
}

/** The proposal body is committed into a published repo: it may only come from the member's scratch dir (work/<date>/tmp/), never from elsewhere on the machine. */
function readBodyFile(ctx, bodyFile, date) {
  const scratch = path.join(fs.realpathSync(ctx.root), 'work', date, 'tmp');
  const abs = path.resolve(bodyFile);
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch (err) {
    throw usage(`cannot read --body-file: ${err.message}`);
  }
  if (st.isSymbolicLink() || !st.isFile()) throw usage('--body-file must be a regular file (not a symlink or directory)');
  const real = fs.realpathSync(abs);
  if (!real.startsWith(scratch + path.sep)) throw usage(`--body-file must live under work/${date}/tmp/ inside the repo (got ${bodyFile}); write the proposal there first`);
  if (st.size > MAX_PROPOSAL_BYTES) throw usage(`proposal body too long (max ${MAX_PROPOSAL_LINES} lines / ${MAX_PROPOSAL_BYTES} bytes): say less, link the evidence`);
  return fs.readFileSync(real, 'utf8');
}

async function cmdPropose(ctx, kz, flags, tz) {
  const agent = requireAgent(flags, kz);
  const date = resolveToday(flags, tz);
  const title = clean(requireText(flags, 'title', MAX_TITLE), MAX_TITLE);
  const category = cleanCategory(flags.category && flags.category !== true ? flags.category : 'proposal');
  const body = readBodyFile(ctx, requireText(flags, 'body-file', 4096), date);
  if (!body.trim()) throw usage('--body-file is empty');
  const observation = clean(flags.observation && flags.observation !== true ? flags.observation : body.split('\n').find((l) => l.trim()) ?? title, MAX_TEXT);
  const question = flags.question && flags.question !== true ? clean(flags.question, MAX_QUESTION) : null;
  const base = { date, agent, title, observation, category, question };
  const rel = `${PROPOSALS_DIR}/${date}-${agent}.md`;

  return withLock(ctx.root, 'ledger', async () => {
    const prior = findEntry(readIndex(), date, agent);
    if (prior && prior.status !== 'rejected') {
      throw new KaizenError(`${agent} already has a ${prior.status} kaizen for ${date} (${prior.title}); one per member per day`, 1, { id: prior.id });
    }
    const dirty = dirtyPaths(ctx);
    if (dirty.length) {
      throw new KaizenError(`working tree is not clean (${dirty.slice(0, 4).join(', ')}); run \`kaizen.mjs commit\` (it rejects and restores) or revert your edits first, then propose`, 1);
    }
    const lines = body.split('\n').length;
    if (lines > MAX_PROPOSAL_LINES || Buffer.byteLength(body) > MAX_PROPOSAL_BYTES) {
      throw usage(`proposal body too long (max ${MAX_PROPOSAL_LINES} lines / ${MAX_PROPOSAL_BYTES} bytes): say less, link the evidence`);
    }
    const doc = [
      `# Proposal: ${title}`,
      '',
      `- from: ${agent}`,
      `- date: ${date}`,
      `- category: ${category}`,
      '- status: proposed for the owner; never auto-applied',
      '',
      body.trimEnd(),
      '',
    ].join('\n');
    fs.mkdirSync(path.dirname(rp(rel)), { recursive: true });
    atomicWriteText(rp(rel), doc);

    const check = runCheck(ctx, kz, { agent, today: date });
    const violations = [...textViolations({ title, observation, question, body }), ...check.violations];
    if (violations.length > 0) {
      return reject(ctx, base, `proposal check failed: ${violations.slice(0, 3).map((v) => `${v.rule} ${v.path ?? ''}`.trim()).join('; ')}`, { violations });
    }
    const index = readIndex();
    const entry = makeEntry({ ...base, files: [rel], linesChanged: countLines(Buffer.from(doc)), status: 'proposed' });
    upsertEntry(index, entry);
    saveLedger(index);
    const validated = await runSuites(ctx.root, { only: ['validate'] });
    const flaky = noteFlaky(validated, { date, agent });
    if (!validated.validate?.ok) {
      return reject(ctx, base, `validate repo failed after the proposal was added: ${suiteFailure(validated)}`, { flaky });
    }
    const stage = ctx.g.run(['add', '--', rel, ...LEDGER_FILES]);
    if (!stage.ok) return reject(ctx, base, `git add failed: ${firstLine(stage.stderr)}`);
    let sha;
    try {
      sha = gitCommit(ctx, commitMessage(entry, [`Kaizen-Files: ${rel}`, 'Kaizen-Gate: proposal']));
    } catch (err) {
      return reject(ctx, base, err.message);
    }
    const stampWarning = stampSha(ctx, entry, sha);
    const newHead = ctx.g.text(['rev-parse', 'HEAD']).trim();
    const prev = readJsonSafe(agentBaselineFile(ctx.root, agent));
    // The proposal adds one Markdown file under ops/kaizen/proposals/ (validate ran on it) and a ledger entry: the baselined results
    // carry over to the new HEAD, so the next member's `begin` is not a cold run of every suite. The suites the gate map names for
    // proposals did not run, so the commit is listed for the round's full verification.
    if (prev?.suites && prev.head === ctx.head) {
      storeBaseline(ctx, agent, newHead, prev.suites, { partial: true, unverified: [...(prev.unverified ?? []), { sha, agent, date, tier: 'proposal', files: [rel] }] });
    } else if (prev) writeJsonAtomic(agentBaselineFile(ctx.root, agent), { ...prev, head: newHead });
    return { ok: true, status: 'proposed', id: entry.id, sha, file: rel, ...(flaky.length ? { flaky } : {}), ...(stampWarning || flaky.length ? { warnings: [...flakyNotes(flaky), ...(stampWarning ? [stampWarning] : [])] } : {}) };
  });
}

// ---------------------------------------------------------------------------------------------- scan, digest, status, queue

function allowedFiles(ctx, kz) {
  return ctx.g.text(['ls-files', '-z']).split('\0').filter((p) => {
    if (!p || badPathReason(p) || isProtected(p, kz.protectedPaths) || !isAllowed(p, kz.allowedPaths)) return false;
    if (BINARY_EXT_RE.test(p) || /\.min\.(?:js|css)$/.test(p) || /(?:^|\/)(?:package-lock\.json|\.gitkeep)$/.test(p)) return false;
    try {
      const st = fs.lstatSync(path.join(ctx.root, p));
      return st.isFile() && st.size > 0 && st.size <= MAX_FILE_BYTES;
    } catch {
      return false;
    }
  }).sort();
}

export function scanFile(ctx, kz, agent, date) {
  const files = allowedFiles(ctx, kz);
  if (files.length === 0) return { ok: true, agent, date, file: null, candidates: 0, hint: 'no eligible file' };
  const rng = mulberry32(hashStr(`${agent}|${date}`));
  const file = files[Math.floor(rng() * files.length)];
  const text = fs.readFileSync(path.join(ctx.root, file), 'utf8');
  const lines = text.split('\n');
  return {
    ok: true,
    agent,
    date,
    file,
    lines: lines.length,
    candidates: files.length,
    excerpt: fenceUntrusted('file-excerpt', lines.slice(0, 60).join('\n').slice(0, 4000)),
    hint: 'Read this file as if you had never seen it. Find ONE thing: an unclear sentence, a missing check, a stale rule, a duplicate, an untested edge, dead code. Prefer deleting or simplifying. If the fix needs a protected path, propose it.',
  };
}

export function digestOf(kz, { date, days = DEFAULT_DIGEST_DAYS, limit = 30 }) {
  const index = readIndex();
  const recent = index.entries
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => inWindow(e.date, date, days))
    .sort((a, b) => (a.e.date === b.e.date ? b.i - a.i : a.e.date < b.e.date ? 1 : -1))
    .slice(0, limit)
    .map(({ e }) => {
      const revertableUntil = addDays(e.date, kz.revertWindowDays);
      return {
        id: e.id, date: e.date, agent: e.agent, title: scrub(String(e.title ?? '')), status: e.status, category: e.category,
        files: e.files, linesChanged: e.linesChanged, observation: scrub(String(e.observation ?? '')), question: e.question ? scrub(String(e.question)) : e.question, reason: e.reason ? scrub(String(e.reason)) : null,
        inRevertWindow: e.status === 'applied' && date <= revertableUntil,
        revertableWithoutEvidenceFrom: e.status === 'applied' ? addDays(e.date, kz.revertWindowDays + 1) : null,
      };
    });
  const questions = recent.filter((e) => e.question).slice(0, 10).map((e) => ({ id: e.id, agent: e.agent, date: e.date, question: e.question }));
  const text = recent.length === 0
    ? '(no kaizens logged yet: you are first)'
    : fenceUntrusted('kaizen-ledger', recent.map((e) => `${e.date} | ${e.agent} | ${e.status}${e.inRevertWindow ? ' (protected from undo until ' + addDays(e.date, kz.revertWindowDays) + ')' : ''} | ${e.title} | ${e.category} | ${e.files.join(',') || '-'} | ${e.status === 'rejected' ? `why: ${e.reason ?? '?'}` : e.observation}`).join('\n'));
  return { count: recent.length, windowDays: days, revertWindowDays: kz.revertWindowDays, entries: recent, questions, text };
}

function notesFor(date, agent) {
  const rel = `work/${date}/kaizen/notes-${agent}.md`;
  const file = rp(rel);
  if (!fs.existsSync(file)) return { path: rel, exists: false, text: '' };
  const text = fs.readFileSync(file, 'utf8');
  return { path: rel, exists: true, untrusted: true, text: fenceUntrusted('friction-notes', text.length > 3000 ? text.slice(-3000) : text) };
}

function readQueue() {
  const q = readJson(rp(QUEUE_FILE), { schema: 1, skipped: [] });
  const skipped = Array.isArray(q.skipped) ? q.skipped.map((x) => (typeof x === 'string' ? x : x?.agent)).filter(Boolean) : [];
  return { schema: 1, skipped: [...new Set(skipped)] };
}

function cmdQueue(ctx, kz, flags) {
  const q = readQueue();
  const list = (v) => String(v).split(',').map((s) => s.trim()).filter(Boolean);
  const check = (names) => {
    for (const n of names) if (!kz.members.includes(n)) throw usage(`unknown agent "${n}"`);
  };
  let changed = false;
  if (flags.skip && flags.skip !== true) {
    const names = list(flags.skip);
    check(names);
    for (const n of names) if (!q.skipped.includes(n)) q.skipped.push(n);
    changed = true;
  }
  if (flags.clear && flags.clear !== true) {
    const names = list(flags.clear);
    check(names);
    q.skipped = q.skipped.filter((n) => !names.includes(n));
    changed = true;
  }
  if (changed) writeJsonAtomic(rp(QUEUE_FILE), q);
  return { ok: true, skipped: q.skipped, changed };
}

function cmdStatus(ctx, kz, flags, tz) {
  const date = resolveDate(flags, tz);
  const index = readIndex();
  const counts = Object.fromEntries(STATUSES.map((s) => [s, index.entries.filter((e) => e.status === s).length]));
  const today = index.entries.filter((e) => e.date === date);
  const done = today.filter((e) => e.status === 'applied' || e.status === 'proposed').map((e) => e.agent);
  const dirty = dirtyPaths(ctx);
  return {
    ok: true,
    date,
    head: ctx.head,
    clean: dirty.length === 0,
    dirty: dirty.slice(0, 20),
    entries: index.entries.length,
    counts,
    today: { done, rejected: today.filter((e) => e.status === 'rejected').map((e) => e.agent), pending: kz.members.filter((m) => !done.includes(m)) },
    queue: readQueue().skipped,
    flakySuspects: readFlaky().suspects.length,
    verification: verificationOf(ctx),
    last: index.entries.at(-1) ?? null,
    caps: { maxChangedLines: kz.maxChangedLines, maxFiles: kz.maxFiles },
    at: Date.now(),
  };
}

/** What the cached baseline of HEAD says: none, full, partial (with the commits a full run still has to cover) or red. Read-only. */
function verificationOf(ctx) {
  const rec = readJsonSafe(headBaselineFile(ctx.root, ctx.head));
  if (!rec?.suites || rec.head !== ctx.head) return { state: 'none', unverified: 0 };
  if (rec.red) return { state: 'red', unverified: rec.unverified?.length ?? 0 };
  return { state: rec.partial ? 'partial' : 'full', unverified: rec.unverified?.length ?? 0 };
}

/**
 * The round's full verification (PLAYBOOK 10.6): every suite at HEAD, on a clean tree. `--if-needed` returns at once when HEAD already
 * has a full green baseline. Green: the baseline becomes full and its unverified commits are covered. Red: nothing is reverted here;
 * the HEAD baseline is marked red so no member starts on it, and the output names the suspects (commits a selective gate let through).
 */
async function cmdVerify(ctx, kz, flags, tz) {
  const date = resolveDate(flags, tz);
  // state/, docs/ and work/ are the orchestrator's (the round's own queue write sits there until its sync); anything else is not HEAD
  const dirty = dirtyPaths(ctx).filter((p) => !inRuntimeArea(p));
  if (dirty.length) {
    throw new KaizenError(`working tree is not clean (${dirty.slice(0, 5).join(', ')}); verify judges HEAD as committed: sync or revert first`, 1, { dirty: dirty.slice(0, 50) });
  }
  return withLock(ctx.root, 'ledger', async () => {
    const rec = readJsonSafe(headBaselineFile(ctx.root, ctx.head));
    const known = rec?.head === ctx.head && rec.suites ? rec : null;
    if (flags['if-needed'] && known && !known.partial && !known.red && !suiteFailure(known.suites)) {
      return { ok: true, status: 'green', head: ctx.head, ran: false, note: 'HEAD already has a full green baseline', at: Date.now() };
    }
    const covered = Array.isArray(known?.unverified) ? known.unverified : [];
    const suites = await runSuites(ctx.root, { all: true, hints: timeHints(known?.suites) });
    const flaky = noteFlaky(suites, { date, agent: 'verify' });
    const failure = suiteFailure(suites) ?? (known?.suites ? compareCounts(known.suites, suites).join('; ') || null : null);
    if (failure) {
      const suspects = gateSuspects(ctx, kz, covered);
      // kept with the names of the failing tests, so the next `begin` refuses at once and says what is red
      const redSuites = Object.fromEntries(Object.entries(suites).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).filter(([key]) => key !== 'retry'))]));
      writeJsonAtomic(headBaselineFile(ctx.root, ctx.head), { schema: 2, head: ctx.head, at: new Date().toISOString(), suites: redSuites, partial: false, unverified: covered, red: clean(failure, 300) });
      return {
        ok: false, status: 'red', head: ctx.head, error: failure, suites: summarizeSuites(suites), suspects, ...(flaky.length ? { flaky } : {}), at: Date.now(),
        hint: 'Run verify once more (a fresh run). Still red: report it like a red tree with these suspects (PLAYBOOK 10.6); the owner reverts the harmful kaizen with "Revert one" of ops/OPERATING.md. The operator never reverts a kaizen by itself, and nobody edits a test to make it pass.',
      };
    }
    storeBaseline(ctx, null, ctx.head, suites);
    return { ok: true, status: 'green', head: ctx.head, ran: true, suites: summarizeSuites(suites), verified: covered.map((u) => u.sha), ...(flaky.length ? { flaky } : {}), at: Date.now() };
  });
}

async function cmdBegin(ctx, kz, flags, tz) {
  const agent = requireAgent(flags, kz);
  const date = resolveToday(flags, tz);
  const dirty = dirtyPaths(ctx);
  if (dirty.length) {
    throw new KaizenError(
      `working tree is not clean (${dirty.length} path${dirty.length === 1 ? '' : 's'}: ${dirty.slice(0, 5).join(', ')}); sync or revert first so this kaizen's diff is exactly one member's`,
      1,
      { dirty: dirty.slice(0, 50) },
    );
  }
  if (ctx.g.run(['diff', '--cached', '--quiet']).code === 1) throw new KaizenError('the index has staged changes; unstage them first', 1);
  const hidden = hiddenFromGit(ctx.g);
  if (hidden.length) throw new KaizenError(`files hidden from git (assume-unchanged/skip-worktree): ${hidden.slice(0, 5).join(', ')}`, 1);
  const prior = findEntry(readIndex(), date, agent);
  const baseline = await withLock(ctx.root, 'ledger', async () => {
    const b = await baselineFor(ctx);
    return { ...b, flaky: b.cached ? [] : noteFlaky(b.suites, { date, agent }) };
  });
  const failure = suiteFailure(baseline.suites) ?? (baseline.red ? `kaizen.mjs verify found HEAD red: ${baseline.red}` : null);
  if (failure) {
    const suspects = gateSuspects(ctx, kz, baseline.unverified);
    throw new KaizenError(`the suites already fail at HEAD (${failure}); a kaizen cannot start on a red tree. Fix it or report it in the handoff${suspects.length ? `; commits that skipped suites in a selective gate: ${suspects.slice(0, 4).map((s) => `${s.sha.slice(0, 10)} (${s.agent}, ${s.tier})`).join(', ')} (PLAYBOOK 10.6)` : ''}`, 1, { suites: summarizeSuites(baseline.suites), ...(suspects.length ? { suspects } : {}), ...(baseline.flaky.length ? { flaky: baseline.flaky } : {}) });
  }
  storeBaseline(ctx, agent, ctx.head, baseline.suites, { partial: baseline.partial, unverified: baseline.unverified });
  const notes = notesFor(date, agent);
  return {
    ok: true,
    agent,
    date,
    head: ctx.head,
    clean: true,
    alreadyDone: prior && prior.status !== 'rejected' ? { id: prior.id, status: prior.status, title: prior.title } : null,
    previousAttempt: prior?.status === 'rejected' ? { reason: prior.reason, title: prior.title } : null,
    baseline: { cached: baseline.cached, partial: baseline.partial, unverified: baseline.unverified.length, suites: summarizeSuites(baseline.suites), ...(baseline.flaky.length ? { flaky: baseline.flaky, notes: flakyNotes(baseline.flaky) } : {}) },
    flakySuspects: flakySummary(),
    rules: { maxChangedLines: kz.maxChangedLines, maxFiles: kz.maxFiles, allowedPaths: kz.allowedPaths, protectedPaths: kz.protectedPaths, docLineCaps: kz.docLineCaps },
    digest: digestOf(kz, { date }),
    notes,
    scan: notes.exists && notes.text.trim() ? null : scanFile(ctx, kz, agent, date),
  };
}

// ---------------------------------------------------------------------------------------------- main

async function main() {
  const flags = parseArgs();
  const cmd = flags._[0];
  const COMMANDS = ['begin', 'scan', 'digest', 'check', 'commit', 'propose', 'status', 'queue', 'verify'];
  try {
    if (!COMMANDS.includes(cmd)) throw usage(`usage: kaizen.mjs ${COMMANDS.join('|')} (see ops/kaizen/README.md)`);
    const ctx = openRepo();
    const { timezone, kaizen: kz } = loadConfig(ctx.g);
    if (!kz.enabled && ['begin', 'commit', 'propose'].includes(cmd)) throw new KaizenError('kaizen is disabled (config.kaizen.enabled is false)', 1);
    let out;
    if (cmd === 'begin') out = await cmdBegin(ctx, kz, flags, timezone);
    else if (cmd === 'scan') {
      const agent = requireAgent(flags, kz);
      out = scanFile(ctx, kz, agent, resolveDate(flags, timezone));
    } else if (cmd === 'digest') {
      const num = (v, d) => {
        if (v === undefined) return d;
        if (!Number.isInteger(Number(v)) || Number(v) < 1) throw usage(`bad number: ${v}`);
        return Number(v);
      };
      out = { ok: true, ...digestOf(kz, { date: resolveDate(flags, timezone), days: num(flags.days, DEFAULT_DIGEST_DAYS), limit: num(flags.limit, 30) }) };
    } else if (cmd === 'check') {
      const agent = flags.agent && flags.agent !== true ? requireAgent(flags, kz) : null;
      out = runCheck(ctx, kz, { agent, evidence: flags.evidence === true ? null : flags.evidence ?? null, today: resolveToday(flags, timezone, { lenient: true }) });
    } else if (cmd === 'commit') out = await cmdCommit(ctx, kz, flags, timezone);
    else if (cmd === 'propose') out = await cmdPropose(ctx, kz, flags, timezone);
    else if (cmd === 'status') out = cmdStatus(ctx, kz, flags, timezone);
    else if (cmd === 'verify') out = await cmdVerify(ctx, kz, flags, timezone);
    else out = cmdQueue(ctx, kz, flags);
    print(out);
    process.exitCode = out.ok === false ? 1 : 0;
  } catch (err) {
    const code = err instanceof KaizenError ? err.code : 1;
    print({ ok: false, error: err.message, ...(err instanceof KaizenError ? err.extra : {}) });
    process.exitCode = code;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
