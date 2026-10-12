#!/usr/bin/env node
// Last line of defense before unreviewed content goes live.
//   validate.mjs project <dir> [--tier T] [--now ISO] [--contract]
//   validate.mjs repo [--no-projects]   (project contents are checked by default)
// --contract applies the page contract (purpose, intro, explainer: DESIGN 7.3) whatever config.pageContract.requiredFrom says.
// Static analysis only: nothing under test is ever executed (JS is parsed with vm.Script / node --check).
// Strategy: parse HTML the way browsers do (spec tokenizer, first attribute wins, entity-decoded URLs),
// lex CSS and JS properly (comments, strings, escapes, templates) and judge sinks by their arguments.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFile, execFileSync } from 'node:child_process';
import { pathToFileURL, domainToASCII } from 'node:url';
import {
  repoRoot, rp, loadConfig, loadTaxonomy, parseArgs, resolveNow, localParts, dayNumber, print, die,
} from './lib/common.mjs';
import { PHASES } from './lib/runstate.mjs';
import { ownerOverrideProblems } from './lib/throttle.mjs';
import { revisePolicyProblems } from './lib/revisepolicy.mjs';

/* ------------------------------------------------------------------------------------------------
 * Reporting
 * ---------------------------------------------------------------------------------------------- */

class Report {
  constructor(waived = new Set()) {
    this.errors = [];
    this.warnings = [];
    this.seen = new Set();
    this.waived = waived;
  }

  add(list, code, msg, file, line) {
    const where = file ? ` [${file}${line ? `:${line}` : ''}]` : '';
    const text = `${code}: ${msg}${where}`;
    if (this.seen.has(text)) return;
    this.seen.add(text);
    list.push(text);
  }

  error(code, msg, file, line) {
    // A waiver (ops/waivers.json, written by a human operator) downgrades a few judgement-call findings.
    if (this.waived.has(code)) this.add(this.warnings, code, `${msg} (waived by ops/waivers.json)`, file, line);
    else this.add(this.errors, code, msg, file, line);
  }

  warn(code, msg, file, line) {
    this.add(this.warnings, code, msg, file, line);
  }
}

function makeLineIndex(text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/* ------------------------------------------------------------------------------------------------
 * Entities and URLs
 * ---------------------------------------------------------------------------------------------- */

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", colon: ':', sol: '/', bsol: '\\', period: '.', comma: ',',
  semi: ';', num: '#', excl: '!', quest: '?', commat: '@', lpar: '(', rpar: ')', lsqb: '[', rsqb: ']',
  lbrack: '[', rbrack: ']', lcub: '{', rcub: '}', lbrace: '{', rbrace: '}', equals: '=', plus: '+',
  percnt: '%', dollar: '$', ast: '*', midast: '*', hyphen: '-', dash: '-', lowbar: '_', UnderBar: '_',
  grave: '`', DiacriticalGrave: '`', verbar: '|', vert: '|', VerticalLine: '|', Hat: '^', Tab: '\t',
  NewLine: '\n', nbsp: '\u00a0',
};
const LEGACY_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'nbsp']);

export function decodeEntities(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(?:#([0-9]+);?|#[xX]([0-9a-fA-F]+);?|([A-Za-z][A-Za-z0-9]*)(;?))/g, (m, dec, hex, name, semi) => {
    if (dec !== undefined || hex !== undefined) {
      const cp = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16);
      if (!Number.isFinite(cp) || cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\ufffd';
      return String.fromCodePoint(cp);
    }
    if (Object.hasOwn(NAMED_ENTITIES, name)) {
      if (semi || LEGACY_ENTITIES.has(name)) return NAMED_ENTITIES[name];
    }
    return m;
  });
}

/** What a browser would resolve before interpreting the scheme: entities, stray whitespace, backslashes. */
function normalizeUrl(raw) {
  return decodeEntities(String(raw))
    .replace(/^[\u0000- ]+|[\u0000- ]+$/g, '')
    .replace(/[\t\n\r]/g, '')
    .replace(/\\/g, '/');
}

function hostOf(rest) {
  let h = rest.replace(/^\/+/, '');
  const end = h.search(/[/?#]/);
  if (end !== -1) h = h.slice(0, end);
  const at = h.lastIndexOf('@');
  if (at !== -1) h = h.slice(at + 1);
  if (!h.startsWith('[')) h = h.replace(/:\d*$/, '');
  try {
    h = decodeURIComponent(h);
  } catch { /* keep raw */ }
  h = h.toLowerCase().replace(/\.+$/, '');
  return domainToASCII(h) || h;
}

const EXTERNAL_SCHEMES = new Set(['http', 'https', 'ws', 'wss', 'ftp', 'ftps', 'file']);
const SCRIPT_SCHEMES = new Set(['javascript', 'vbscript', 'livescript']);

/** @returns {{kind:string, host?:string, value:string}} kind: empty|fragment|relative|external|data|blob|javascript|other */
export function classifyUrl(raw) {
  const value = normalizeUrl(raw);
  if (value === '') return { kind: 'empty', value };
  if (value.startsWith('#')) return { kind: 'fragment', value };
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value);
  if (scheme) {
    const sc = scheme[1].toLowerCase();
    if (EXTERNAL_SCHEMES.has(sc)) return { kind: 'external', host: hostOf(value.slice(scheme[0].length)), scheme: sc, value };
    if (SCRIPT_SCHEMES.has(sc)) return { kind: 'javascript', value };
    if (sc === 'data') return { kind: 'data', value };
    if (sc === 'blob') return { kind: 'blob', value };
    return { kind: 'other', scheme: sc, value };
  }
  if (/^\/\//.test(value)) return { kind: 'external', host: hostOf(value), scheme: '', value };
  return { kind: 'relative', value };
}

function normHost(h) {
  const s = String(h).trim().toLowerCase().replace(/\.+$/, '');
  return domainToASCII(s) || s;
}

/** Resolve a relative URL against a project-relative directory. Returns null for non-file targets. */
function resolveInProject(dir, url) {
  let p = url.replace(/[?#].*$/, '');
  if (p === '' || p.endsWith('/')) return null;
  try {
    p = decodeURIComponent(p);
  } catch { /* keep raw */ }
  if (p.startsWith('/')) return { rootAbsolute: true, path: p };
  const joined = path.posix.normalize(path.posix.join(dir || '.', p));
  if (joined === '..' || joined.startsWith('../')) return { escapes: true, path: joined };
  return { path: joined };
}

/* ------------------------------------------------------------------------------------------------
 * HTML tokenizer (follows the WHATWG tokenizer closely enough that we see what a browser sees)
 * ---------------------------------------------------------------------------------------------- */

const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);
// Raw text to a scripting-enabled browser, ordinary markup to one with scripting off (or to an older parser).
// Both views are scanned: the body is skipped by the main loop and then re-scanned as markup.
const RAW_MARKUP = new Set(['noscript', 'iframe', 'noembed', 'noframes', 'xmp']);
const isWs = (c) => c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f';
const isAlpha = (c) => c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'));

function parseTag(src, i, isEnd) {
  const n = src.length;
  let p = i + (isEnd ? 2 : 1);
  const ns = p;
  while (p < n && !isWs(src[p]) && src[p] !== '/' && src[p] !== '>') p++;
  const name = src.slice(ns, p).toLowerCase();
  const attrs = [];
  let selfClosing = false;
  let eof = false;
  for (;;) {
    while (p < n && (isWs(src[p]) || src[p] === '/')) p++;
    if (p >= n) {
      eof = true;
      break;
    }
    if (src[p] === '>') {
      selfClosing = src[p - 1] === '/';
      p++;
      break;
    }
    const as = p;
    p++;
    while (p < n && !isWs(src[p]) && src[p] !== '/' && src[p] !== '>' && src[p] !== '=') p++;
    const aname = src.slice(as, p).toLowerCase();
    let q = p;
    while (q < n && isWs(src[q])) q++;
    let value = '';
    let valueStart = q;
    if (src[q] === '=') {
      q++;
      while (q < n && isWs(src[q])) q++;
      const quote = src[q];
      if (quote === '"' || quote === "'") {
        const close = src.indexOf(quote, q + 1);
        valueStart = q + 1;
        if (close === -1) {
          value = src.slice(q + 1);
          p = n;
          eof = true;
        } else {
          value = src.slice(q + 1, close);
          p = close + 1;
        }
      } else {
        valueStart = q;
        while (q < n && !isWs(src[q]) && src[q] !== '>') q++;
        value = src.slice(valueStart, q);
        p = q;
      }
    } else {
      p = q;
    }
    attrs.push({ name: aname, value, start: as, valueStart });
  }
  return { name, attrs, selfClosing, end: p, eof };
}

export function tokenizeHtml(src) {
  const tokens = [];
  const n = src.length;
  let i = 0;
  // Inside <svg> and <math> the tree builder switches to foreign-content rules: <title>, <textarea> and friends
  // are ordinary elements whose children are real markup. Only script and style keep a raw body here, and the
  // scanner re-reads those bodies as markup too (tok.foreign).
  let foreign = 0;
  while (i < n) {
    const j = src.indexOf('<', i);
    if (j === -1) {
      tokens.push({ t: 'text', start: i, end: n });
      break;
    }
    if (j > i) tokens.push({ t: 'text', start: i, end: j });
    i = j;
    const c1 = src[i + 1];
    if (c1 === '!') {
      if (src.startsWith('--', i + 2)) {
        let end;
        let unterminated = false;
        const k = i + 4;
        if (src[k] === '>') end = k + 1;
        else if (src.startsWith('->', k)) end = k + 2;
        else {
          const a = src.indexOf('-->', k);
          const b = src.indexOf('--!>', k);
          if (a === -1 && b === -1) {
            end = n;
            unterminated = true;
          } else if (b === -1 || (a !== -1 && a < b)) end = a + 3;
          else end = b + 4;
        }
        tokens.push({ t: 'comment', start: i, end, unterminated });
        i = end;
        continue;
      }
      const gt = src.indexOf('>', i + 2);
      const end = gt === -1 ? n : gt + 1;
      tokens.push({ t: /^<!doctype/i.test(src.slice(i, i + 9)) ? 'doctype' : 'comment', start: i, end });
      i = end;
      continue;
    }
    if (c1 === '?') {
      const gt = src.indexOf('>', i + 2);
      const end = gt === -1 ? n : gt + 1;
      tokens.push({ t: 'comment', start: i, end });
      i = end;
      continue;
    }
    if (c1 === '/') {
      if (isAlpha(src[i + 2])) {
        const tag = parseTag(src, i, true);
        tokens.push({ t: 'end', name: tag.name, start: i, end: tag.end });
        if (tag.name === 'svg' || tag.name === 'math') foreign = Math.max(0, foreign - 1);
        i = tag.end;
        continue;
      }
      if (src[i + 2] === '>') {
        i += 3;
        continue;
      }
      if (i + 2 >= n) {
        tokens.push({ t: 'text', start: i, end: n });
        break;
      }
      const gt = src.indexOf('>', i + 2);
      const end = gt === -1 ? n : gt + 1;
      tokens.push({ t: 'comment', start: i, end });
      i = end;
      continue;
    }
    if (isAlpha(c1)) {
      const tag = parseTag(src, i, false);
      const tok = { t: 'start', name: tag.name, attrs: tag.attrs, selfClosing: tag.selfClosing, start: i, end: tag.end, eof: tag.eof };
      tokens.push(tok);
      i = tag.end;
      if ((tag.name === 'svg' || tag.name === 'math') && !tag.selfClosing) foreign++;
      const raw = foreign > 0 ? tag.name === 'script' || tag.name === 'style' : RAW_TEXT.has(tag.name) || RAW_MARKUP.has(tag.name);
      if (foreign > 0 && raw) tok.foreign = true;
      if (raw && !tag.eof) {
        const re = new RegExp(`</${tag.name}(?=[\\s/>]|$)`, 'ig');
        re.lastIndex = i;
        const m = re.exec(src);
        tok.bodyStart = i;
        tok.bodyEnd = m ? m.index : n;
        i = tok.bodyEnd;
      }
      continue;
    }
    tokens.push({ t: 'text', start: i, end: i + 1 });
    i++;
  }
  return tokens;
}

/* ------------------------------------------------------------------------------------------------
 * CSS lexing and scanning
 * ---------------------------------------------------------------------------------------------- */

/** Strip comments and decode escapes (u\72l( is url( to a browser). Returns text plus an offset map. */
function normalizeCss(src) {
  const n = src.length;
  const out = [];
  const map = new Uint32Array(n + 1);
  const comments = [];
  let o = 0;
  const push = (ch, at) => {
    out.push(ch);
    map[o++] = at;
  };
  let i = 0;
  let quote = '';
  while (i < n) {
    const c = src[i];
    if (!quote && c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      comments.push([i, stop]);
      push(' ', i);
      i = stop;
      continue;
    }
    if (c === '\\') {
      const m = /^\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?/.exec(src.slice(i, i + 9));
      if (m) {
        const cp = Number.parseInt(m[1], 16);
        push(cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? '\ufffd' : String.fromCodePoint(cp), i);
        i += m[0].length;
        continue;
      }
      if (i + 1 < n) {
        if (src[i + 1] === '\n') {
          i += 2;
          continue;
        }
        push(src[i + 1], i);
        i += 2;
        continue;
      }
    }
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    push(c, i);
    i++;
  }
  return { text: out.join(''), map, comments };
}

const CSS_FETCH_FN = /\burl\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s][^)]*?))\s*\)/gi;

function scanCss(src, S, { base = 0, dir } = {}) {
  const { text, map, comments } = normalizeCss(src);
  const lineAt = (idx) => S.lineOf(S.base + base + (map[idx] ?? 0));
  const flat = text.replace(/@namespace[^;{}]*;/gi, (m) => ' '.repeat(m.length));

  const judge = (arg, idx, code, role) => {
    const url = classifyUrl(arg);
    const line = lineAt(idx);
    S.url(url, { code, role, line, dir, resource: true, what: `CSS ${code === 'external-css-import' ? '@import' : 'url()'}` });
  };

  for (const m of flat.matchAll(/@import\s*(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s][^)]*?))\s*\)|"([^"]*)"|'([^']*)')/gi)) {
    judge(m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? '', m.index, 'external-css-import', 'code');
  }
  for (const m of flat.matchAll(CSS_FETCH_FN)) {
    judge(m[1] ?? m[2] ?? m[3] ?? '', m.index, 'external-css-url', 'resource');
  }
  for (const m of flat.matchAll(/(?:-webkit-)?image-set\(([^)]*)\)|\bsrc\(\s*("[^"]*"|'[^']*')/gi)) {
    for (const s of (m[1] ?? m[2] ?? '').matchAll(/"([^"]*)"|'([^']*)'/g)) judge(s[1] ?? s[2] ?? '', m.index, 'external-css-url', 'resource');
  }
  const bad = /\bexpression\s*\(|-moz-binding\s*:|\bbehavior\s*:\s*url/i.exec(flat);
  if (bad) S.report.warn('css-legacy-script', `legacy scriptable CSS construct (${bad[0].trim()})`, S.rel, lineAt(bad.index));
  return { comments, text: flat, map };
}

/* ------------------------------------------------------------------------------------------------
 * JS lexing
 * ---------------------------------------------------------------------------------------------- */

const REGEX_AFTER_KEYWORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const OPERATORS = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '&&', '||', '??', '?.', '++', '--', '**', '<<', '>>'];
const isIdStartCode = (c) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 36 || c > 127;
const isIdPartCode = (c) => isIdStartCode(c) || (c >= 48 && c <= 57);

// Punctuation tokens carry no position and are shared, which keeps the allocation count of a 3 MB bundle low.
const PUNC = new Map();
function punc(value) {
  let t = PUNC.get(value);
  if (!t) {
    t = { type: 'punc', value };
    PUNC.set(value, t);
  }
  return t;
}
const OPS_BY_FIRST = new Map();
for (const op of OPERATORS) {
  const k = op.charCodeAt(0);
  if (!OPS_BY_FIRST.has(k)) OPS_BY_FIRST.set(k, []);
  OPS_BY_FIRST.get(k).push(op);
}

function decodeJsEscapes(raw) {
  if (!raw.includes('\\')) return raw;
  return raw.replace(/\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([0-7]{1,3})|(\r\n|[\n\r\u2028\u2029])|([\s\S]))/g, (m, ub, u4, x2, oct, nl, ch) => {
    if (ub !== undefined) {
      const cp = Number.parseInt(ub, 16);
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    }
    if (u4 !== undefined) return String.fromCharCode(Number.parseInt(u4, 16));
    if (x2 !== undefined) return String.fromCharCode(Number.parseInt(x2, 16));
    if (oct !== undefined) return String.fromCharCode(Number.parseInt(oct, 8));
    if (nl !== undefined) return '';
    const map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v' };
    return map[ch] ?? ch;
  });
}

function lexJs(src, start = 0, inTemplate = false) {
  const n = src.length;
  const tokens = [];
  const comments = [];
  let i = start;
  let prev = null;
  let depth = 0;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 32 || c === 10 || c === 9 || c === 13 || c === 12 || c === 11 || c === 0xa0 || c === 0x2028 || c === 0x2029 || c === 0xfeff) {
      i++;
      continue;
    }
    if (c === 47) {
      const d = src.charCodeAt(i + 1);
      if (d === 47) {
        let e = i + 2;
        while (e < n) {
          const x = src.charCodeAt(e);
          if (x === 10 || x === 13 || x === 0x2028 || x === 0x2029) break;
          e++;
        }
        comments.push([i, e]);
        i = e;
        continue;
      }
      if (d === 42) {
        const e = src.indexOf('*/', i + 2);
        const stop = e === -1 ? n : e + 2;
        comments.push([i, stop]);
        i = stop;
        continue;
      }
      const regexAllowed = prev === null
        || (prev.type === 'punc' && prev.value !== ')' && prev.value !== ']')
        || (prev.type === 'id' && REGEX_AFTER_KEYWORD.has(prev.value));
      if (regexAllowed) {
        let e = i + 1;
        let inClass = false;
        let ok = false;
        while (e < n) {
          const x = src.charCodeAt(e);
          if (x === 10) break;
          if (x === 92) e++;
          else if (x === 91) inClass = true;
          else if (x === 93) inClass = false;
          else if (x === 47 && !inClass) {
            ok = true;
            break;
          }
          e++;
        }
        if (ok) {
          e++;
          while (e < n && isIdPartCode(src.charCodeAt(e))) e++;
          prev = { type: 'regex', start: i, end: e };
          tokens.push(prev);
          i = e;
          continue;
        }
      }
    } else if (c === 34 || c === 39) {
      let e = i + 1;
      while (e < n) {
        const x = src.charCodeAt(e);
        if (x === c || x === 10) break;
        if (x === 92) e++;
        e++;
      }
      const end = Math.min(e + 1, n);
      prev = { type: 'str', value: decodeJsEscapes(src.slice(i + 1, Math.min(e, n))), start: i, end };
      tokens.push(prev);
      i = end;
      continue;
    } else if (c === 96) {
      const quasis = [];
      const exprs = [];
      let e = i + 1;
      let seg = e;
      while (e < n && src.charCodeAt(e) !== 96) {
        const x = src.charCodeAt(e);
        if (x === 92) {
          e += 2;
          continue;
        }
        if (x === 36 && src.charCodeAt(e + 1) === 123) {
          quasis.push(decodeJsEscapes(src.slice(seg, e)));
          const inner = lexJs(src, e + 2, true);
          exprs.push(inner.tokens);
          for (const cm of inner.comments) comments.push(cm);
          e = inner.end + 1;
          seg = e;
          continue;
        }
        e++;
      }
      quasis.push(decodeJsEscapes(src.slice(seg, Math.min(e, n))));
      const end = Math.min(e + 1, n);
      prev = { type: 'tpl', value: quasis[0], quasis, exprs, start: i, end };
      tokens.push(prev);
      i = end;
      continue;
    } else if (isIdStartCode(c) || c === 35 || (c === 92 && src.charCodeAt(i + 1) === 117)) {
      let e = c === 92 ? i : i + 1;
      let escaped = c === 92;
      for (;;) {
        const x = src.charCodeAt(e);
        if (isIdPartCode(x)) e++;
        else if (x === 92 && src.charCodeAt(e + 1) === 117) {
          const m = /^\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})/.exec(src.slice(e, e + 12));
          e += m ? m[0].length : 2;
          escaped = true;
        } else break;
      }
      const raw = src.slice(i, e);
      prev = { type: 'id', value: escaped ? decodeJsEscapes(raw) : raw, start: i, end: e };
      tokens.push(prev);
      i = e;
      continue;
    } else if ((c >= 48 && c <= 57) || (c === 46 && src.charCodeAt(i + 1) >= 48 && src.charCodeAt(i + 1) <= 57)) {
      let e = i + 1;
      const hex = c === 48 && (src.charCodeAt(i + 1) | 32) === 120;
      while (e < n) {
        const x = src.charCodeAt(e);
        if (isIdPartCode(x) || x === 46) e++;
        else if ((x === 43 || x === 45) && !hex && (src.charCodeAt(e - 1) | 32) === 101) e++;
        else break;
      }
      prev = { type: 'num', start: i, end: e };
      tokens.push(prev);
      i = e;
      continue;
    } else if (c === 125 && inTemplate && depth === 0) {
      return { tokens, comments, end: i };
    }
    if (c === 123) depth++;
    else if (c === 125) depth--;
    let op = src[i];
    const cands = OPS_BY_FIRST.get(c);
    if (cands) {
      for (const cand of cands) {
        if (src.startsWith(cand, i)) {
          op = cand;
          break;
        }
      }
    }
    prev = punc(op);
    tokens.push(prev);
    i += op.length;
  }
  return { tokens, comments, end: n };
}

/* ------------------------------------------------------------------------------------------------
 * JS scanning
 * ---------------------------------------------------------------------------------------------- */

const GLOBAL_OBJECTS = new Set(['window', 'self', 'globalThis', 'top', 'parent', 'frames']);
const HTTP_METHODS = /^(?:GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH|CONNECT|TRACE)$/i;
const STRONG_OBFUSCATION = new Set(['atob', 'fromCharCode', 'fromCodePoint', 'unescape']);
const HTML_SINKS = new Set(['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'createContextualFragment', 'srcdoc', 'parseFromString']);
const TRACKER_APIS = new Set(['gtag', 'fbq', '_gaq', 'dataLayer', 'mixpanel', 'amplitude', 'posthog', 'hj', 'Sentry', 'ym', '_paq', 'plausible', 'clarity']);
const URL_LIKE = /^\s*(?:(?:https?|wss?|ftp):)?\/\/[a-z0-9[]/i;
// WebRTC reaches STUN/TURN hosts outside the CSP (and outside Playwright's request routing); the hostname, username
// and credential are a covert channel. Nothing on a static page needs it.
const RTC_NAME = /^(?:webkit|moz|ms)?RTC(?:PeerConnection|DataChannel|SessionDescription|IceCandidate|IceTransport|DtlsTransport|SctpTransport|RtpSender|RtpReceiver|RtpTransceiver)$/;
const RTC_FRAGMENT = /rtcpeerconnection|peerconnection|rtcdatachannel|rtcsessiondescription|rtcicecandidate|createdatachannel/i;
const SAME_ORIGIN_LOCATION = /^(?:pathname|search|hash|origin|href)$/;
const IDENTIFIER_GENERATORS = new Set(['randomUUID', 'getRandomValues', 'uuid', 'uuidv4', 'uuidv1', 'nanoid', 'cuid']);
const IDENTIFIER_KEY = /(?:^|[^a-z])(?:uid|uuid|user[-_]?id|visitor|client[-_]?id|device[-_]?id|session[-_]?id|install[-_]?id|distinct[-_]?id|fingerprint|tracking|anon\w*)(?:[^a-z]|$)/i;

const isP = (t, v) => t !== undefined && t.type === 'punc' && t.value === v;
const isI = (t, v) => t !== undefined && t.type === 'id' && t.value === v;

/** Split a call's arguments. `open` is the index of "(". */
function callArgs(tokens, open) {
  const args = [[]];
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'punc') {
      if (t.value === '(' || t.value === '[' || t.value === '{') {
        depth++;
        if (depth === 1) continue;
      } else if (t.value === ')' || t.value === ']' || t.value === '}') {
        depth--;
        if (depth === 0) return { args, close: i };
      } else if (t.value === ',' && depth === 1) {
        args.push([]);
        continue;
      }
    }
    args[args.length - 1].push(t);
  }
  return { args, close: tokens.length - 1 };
}

function flattenIds(tokens, out = []) {
  for (const t of tokens) {
    if (t.type === 'id') out.push(t.value);
    else if (t.type === 'tpl') for (const e of t.exprs) flattenIds(e, out);
  }
  return out;
}

/** Leading literal text of an expression ("a" + "b" + x => prefix "ab", complete:false). */
function literalPrefix(arg) {
  let prefix = '';
  let i = 0;
  let complete = false;
  for (;;) {
    const t = arg[i];
    if (!t) break;
    if (t.type === 'str') prefix += t.value;
    else if (t.type === 'tpl') {
      prefix += t.quasis[0];
      if (t.exprs.length) break;
    } else break;
    i++;
    if (i >= arg.length) {
      complete = true;
      break;
    }
    if (!isP(arg[i], '+')) break;
    i++;
  }
  return { prefix, complete, consumed: i };
}

function collectAssignments(tokens) {
  const map = new Map();
  for (let i = 1; i < tokens.length - 1; i++) {
    const t = tokens[i];
    if (t.type !== 'id' || !isP(tokens[i + 1], '=') || isP(tokens[i - 1], '.')) continue;
    const rhs = [];
    let depth = 0;
    for (let j = i + 2; j < tokens.length && rhs.length < 80; j++) {
      const u = tokens[j];
      if (u.type === 'punc') {
        if ('([{'.includes(u.value)) depth++;
        else if (')]}'.includes(u.value)) {
          if (depth === 0) break;
          depth--;
        } else if ((u.value === ';' || u.value === ',') && depth === 0) break;
      } else if (u.type === 'id' && depth === 0 && /^(?:const|let|var|function|return|if|for|while|class)$/.test(u.value)) break;
      rhs.push(u);
    }
    if (rhs.length) {
      if (!map.has(t.value)) map.set(t.value, []);
      map.get(t.value).push(rhs);
    }
  }
  return map;
}

function scanJs(src, S, { base = 0, dir } = {}) {
  const { tokens, comments } = lexJs(src);
  const sc = { ...S, base: S.base + base };
  const state = { htmlSink: false, scriptLiterals: [], dir, src };
  scanTokens(tokens, sc, state);
  if (state.scriptLiterals.length) {
    const line = state.scriptLiterals[0];
    if (state.htmlSink) S.report.error('innerhtml-script', 'a string containing <script is used with an HTML-injecting API', S.rel, line);
    else S.report.warn('script-in-string', 'string literal contains <script', S.rel, line);
  }
  return { tokens, comments };
}

function resolveArg(arg, assign, seen = new Set()) {
  const findings = [];
  if (seen.size > 8) return findings;
  const ids = flattenIds(arg);
  const strong = ids.find((v) => STRONG_OBFUSCATION.has(v));
  if (strong) findings.push({ kind: 'obfuscated', strong: true, via: strong });
  else if (ids.includes('reverse') || arg.some((t, k) => isI(t, 'join') && isP(arg[k + 1], '(') && arg[k + 2]?.type === 'str' && arg[k + 2].value === '')) {
    findings.push({ kind: 'obfuscated', strong: false, via: 'reverse/join' });
  }
  if (isI(arg[0], 'new') && isI(arg[1], 'URL') && isP(arg[2], '(')) {
    return [...findings, ...resolveArg(callArgs(arg, 2).args[0], assign, seen)];
  }
  const lit = literalPrefix(arg);
  if (lit.prefix) findings.push({ kind: lit.complete ? 'literal' : 'prefix', value: lit.prefix });
  const head = arg[0];
  if (!lit.prefix && head?.type === 'id' && assign && !seen.has(head.value) && !isP(arg[1], '.') && !isP(arg[1], '(')) {
    seen.add(head.value);
    for (const rhs of assign.get(head.value) ?? []) {
      for (const f of resolveArg(rhs, assign, seen)) {
        findings.push(arg.length > 1 && f.kind === 'literal' ? { ...f, kind: 'prefix' } : f);
      }
    }
  }
  return findings;
}

const NOT_A_VALUE = new Set(['return', 'typeof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await', 'instanceof', 'if', 'for', 'while']);

/** a['fe' + 'tch'](...) is a.fetch(...): fold constant string subscripts into member accesses. */
function foldSubscripts(tokens, S) {
  let out = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'punc' && t.value === '[' && i > 0) {
      const p = tokens[i - 1];
      const valueBefore = (p.type === 'id' && !NOT_A_VALUE.has(p.value)) || isP(p, ')') || isP(p, ']');
      if (valueBefore) {
        let j = i + 1;
        let name = '';
        let constant = true;
        let sawStr = false;
        let depth = 1;
        for (; j < tokens.length; j++) {
          const u = tokens[j];
          if (u.type === 'punc') {
            if (u.value === '[') depth++;
            else if (u.value === ']' && --depth === 0) break;
          }
          if (u.type === 'str' && (j === i + 1 || isP(tokens[j - 1], '+'))) {
            name += u.value;
            sawStr = true;
          } else if (!isP(u, '+') || j === i + 1) constant = false;
        }
        const closed = j < tokens.length;
        if (closed && constant && sawStr && /^[A-Za-z_$][\w$]*$/.test(name)) {
          out ??= tokens.slice(0, i);
          out.push(punc('.'), { type: 'id', value: name, start: tokens[i + 1].start, end: tokens[j].start });
          i = j;
          continue;
        }
        if (closed && !constant) {
          const hit = flattenIds(tokens.slice(i + 1, j)).find((v) => STRONG_OBFUSCATION.has(v));
          if (hit && /^(?:window|self|globalThis|top|parent|document|navigator|location|Reflect)$/.test(p.value ?? '')) {
            S.report.error('obfuscated-api', `member name computed with ${hit}()`, S.rel, S.lineOf(S.base + (tokens[i + 1].start ?? p.start)));
          }
        }
      }
    }
    if (out) out.push(t);
  }
  return out ?? tokens;
}

/** String pieces that only form their final text when joined: 'a' + 'b', ['a', 'b'].join(''). */
function joinedStrings(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'str' && isP(tokens[i + 1], '+') && tokens[i + 2]?.type === 'str') {
      let text = t.value;
      let j = i;
      while (isP(tokens[j + 1], '+') && tokens[j + 2]?.type === 'str') {
        text += tokens[j + 2].value;
        j += 2;
      }
      out.push({ tok: t, text });
      i = j;
    } else if (isP(t, '[') && tokens[i + 1]?.type === 'str') {
      const parts = [];
      let j = i + 1;
      while (tokens[j]?.type === 'str') {
        parts.push(tokens[j].value);
        j++;
        if (isP(tokens[j], ',')) j++;
        else break;
      }
      if (isP(tokens[j], ']') && isP(tokens[j + 1], '.') && isI(tokens[j + 2], 'join') && isP(tokens[j + 3], '(')) {
        const sep = tokens[j + 4]?.type === 'str' ? tokens[j + 4].value : isP(tokens[j + 4], ')') ? ',' : null;
        if (sep !== null) out.push({ tok: tokens[i + 1], text: parts.join(sep) });
      }
    }
  }
  return out;
}

/** True when a navigation target cannot leave this site: nothing, a relative literal, or built on location.* itself. */
function ownNavigationTarget(arg, findings) {
  if (arg.length === 0) return true;
  if (findings.some((f) => f.kind === 'literal' || f.kind === 'prefix')) return true;
  let k = 0;
  while (arg[k]?.type === 'id' && (GLOBAL_OBJECTS.has(arg[k].value) || arg[k].value === 'document') && isP(arg[k + 1], '.')) k += 2;
  return isI(arg[k], 'location') && isP(arg[k + 1], '.') && SAME_ORIGIN_LOCATION.test(arg[k + 2]?.value ?? '')
    && !arg.some((x) => x.type === 'str' && !['relative', 'fragment', 'empty'].includes(classifyUrl(x.value).kind));
}

function scanTokens(rawTokens, S, st) {
  const { report, rel } = S;
  const line = (tok) => S.lineOf(S.base + tok.start);
  const tokens = foldSubscripts(rawTokens, S);
  const assign = collectAssignments(tokens);
  // A page's own `function open()` or `const open = ...` is not window.open.
  const declaresOpen = tokens.some((x, k) => isI(x, 'open') && k > 0 && tokens[k - 1].type === 'id' && /^(?:function|const|let|var)$/.test(tokens[k - 1].value));

  const sink = (code, role, argTokens, at, what) => {
    const found = resolveArg(argTokens, assign);
    if (code === 'navigation-external' && !ownNavigationTarget(argTokens, found)) {
      report.error('navigation-dynamic', `${what} target is computed at runtime, so it cannot be shown to stay on this site`, rel, line(at));
    }
    for (const f of found) {
      if (f.kind === 'obfuscated') {
        if (f.strong) report.error('obfuscated-url', `${what} argument is built with ${f.via}`, rel, line(at));
        else report.warn('obfuscated-url', `${what} argument is assembled with ${f.via}`, rel, line(at));
        continue;
      }
      const value = f.value;
      const probe = classifyUrl(value);
      if (f.kind === 'prefix') {
        const lower = value.replace(/\s+/g, '').toLowerCase();
        const partialScheme = lower.length >= 2 && !lower.includes(':') && ['https://', 'http://', 'wss://', 'ws://', 'ftp://'].some((s) => s.startsWith(lower));
        if (partialScheme || /^(?:https?|wss?|ftp):?\/{0,2}$/i.test(lower)) {
          report.error('assembled-url', `${what} URL is assembled from fragments ("${value}" + ...)`, rel, line(at));
          continue;
        }
        if (code === 'navigation-external' && /^\s*[\\/]\s*$/.test(value)) {
          report.error('navigation-dynamic', `${what} target starts with a bare slash and may become a protocol-relative URL`, rel, line(at));
          continue;
        }
        if (probe.kind === 'relative' && !/^\/\//.test(value.replace(/\\/g, '/'))) continue;
      }
      S.url(probe, { code, role, line: line(at), dir: st.dir, what, fromCode: true });
    }
  };

  const importSpec = (tok, spec) => {
    const probe = classifyUrl(spec);
    if (probe.kind === 'external') S.url(probe, { code: 'external-import', role: 'code', line: line(tok), what: 'module import' });
    else if (probe.kind === 'data') report.error('data-url-code', 'module imported from a data: URL', rel, line(tok));
    else if (probe.kind === 'javascript') report.error('javascript-url', 'javascript: module specifier', rel, line(tok));
    else if (probe.kind === 'relative') {
      if (!/^(?:\.{0,2}\/)/.test(spec)) {
        report.warn('bare-import', `bare module specifier "${spec}" cannot be resolved by a browser`, rel, line(tok));
        return;
      }
      const r = resolveInProject(st.dir, probe.value);
      if (!r) return;
      if (r.escapes) report.error('escapes-project', `import "${spec}" leaves the project directory`, rel, line(tok));
      else if (r.rootAbsolute) report.error('root-absolute-path', `import "${spec}" is root-absolute and will not resolve on a project page`, rel, line(tok));
      else if (S.files && !S.files.has(r.path)) report.error('missing-module', `import "${spec}" does not exist in the project`, rel, line(tok));
    }
  };

  for (const j of joinedStrings(tokens)) literalChecks(j.tok, j.text, S, st);

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const prev = tokens[i - 1];
    const next = tokens[i + 1];

    if (t.type === 'tpl') {
      for (const e of t.exprs) scanTokens(e, S, st);
      literalChecks(t, t.quasis.join(' '), S, st);
      continue;
    }
    if (t.type === 'str') {
      literalChecks(t, t.value, S, st);
      continue;
    }
    if (t.type !== 'id') continue;

    const dotted = isP(prev, '.') || isP(prev, '?.');
    const global = dotted && prev && GLOBAL_OBJECTS.has(tokens[i - 2]?.value);
    const bare = !dotted || global;
    const call = isP(next, '(');
    const v = t.value;

    if (HTML_SINKS.has(v)) st.htmlSink = true;
    if ((v === 'fetch' || v === 'XMLHttpRequest' || v === 'WebSocket' || v === 'EventSource' || v === 'importScripts') && bare && !call
      && !isI(prev, 'new') && !isI(prev, 'typeof') && !isI(prev, 'function') && !isP(next, ':') && !isP(next, '=')
      && (!isP(next, '.') || /^(?:call|apply|bind)$/.test(tokens[i + 2]?.value ?? ''))) {
      report.warn('network-alias', `${v} is passed around as a value, so its calls cannot be checked`, rel, line(t));
    }

    const isMethodDef = () => isP(tokens[callArgs(tokens, i + 1).close + 1], '{');
    if (v === 'eval' && bare && !isP(next, ':') && !isI(prev, 'function') && !(call && isMethodDef())) {
      const sev = S.vendor ? 'warn' : 'error';
      report[sev]('eval', 'eval is unusable under the page CSP (no unsafe-eval) and executes arbitrary text', rel, line(t));
    } else if (v === 'Function' && bare && call && !isMethodDef()) {
      const sev = S.vendor ? 'warn' : 'error';
      report[sev]('new-function', 'the Function constructor evaluates strings (blocked by the CSP)', rel, line(t));
    } else if ((v === 'setTimeout' || v === 'setInterval') && bare && call) {
      const { args } = callArgs(tokens, i + 1);
      const first = args[0][0];
      if (first && (first.type === 'str' || first.type === 'tpl')) report.error('string-timer', `${v} with a string argument evaluates code`, rel, line(t));
    } else if (v === 'document' && isP(next, '.') && (isI(tokens[i + 2], 'write') || isI(tokens[i + 2], 'writeln'))) {
      report.error('document-write', 'document.write is not allowed', rel, line(t));
    } else if (v === 'document' && isP(next, '[') && tokens[i + 2]?.type === 'str' && /^write(?:ln)?$/.test(tokens[i + 2].value)) {
      report.error('document-write', 'document.write is not allowed', rel, line(t));
    } else if (v === 'serviceWorker' && ((isP(next, '.') && isI(tokens[i + 2], 'register')) || (isP(next, '[') && tokens[i + 2]?.value === 'register'))) {
      report.error('service-worker', 'service workers are not allowed', rel, line(t));
    } else if (v === 'constructor' && dotted && isI(tokens[i - 2], 'constructor')) {
      report.error('new-function', 'constructor.constructor builds a Function from a string (blocked by the CSP)', rel, line(t));
    } else if ((v === 'cookie' && dotted && isI(tokens[i - 2], 'document') && (isP(next, '=') || isP(next, '+='))) || (v === 'cookieStore' && isP(next, '.'))) {
      report.error('document-cookie', 'cookies are not allowed; only localStorage conveniences are', rel, line(t));
    } else if (RTC_NAME.test(v) || (v === 'createDataChannel' && dotted)) {
      report.error('webrtc', `${v}: WebRTC can contact third-party STUN/TURN servers outside the CSP`, rel, line(t));
    } else if (/^(?:getUserMedia|getDisplayMedia|geolocation|getCurrentPosition|watchPosition)$/.test(v) && dotted) {
      report.error('privacy-api', `${v} requests camera, microphone, screen or location data (needs an ops waiver)`, rel, line(t));
    } else if (TRACKER_APIS.has(v) && next && (isP(next, '(') || isP(next, '.') || isP(next, '='))) {
      if (!dotted || v === 'Sentry') report.warn('tracker-api', `${v} looks like an analytics or tracking API`, rel, line(t));
    }

    if (v === 'setItem' && dotted && call && tokens[i - 2]?.type === 'id' && /^(?:localStorage|sessionStorage)$/.test(tokens[i - 2].value)) {
      const { args } = callArgs(tokens, i + 1);
      const key = literalPrefix(args[0] ?? []).prefix;
      const valueIds = flattenIds(args[1] ?? []);
      const randomish = valueIds.some((x) => /^(?:random|now|getTime|getRandomValues)$/.test(x));
      if (valueIds.some((x) => IDENTIFIER_GENERATORS.has(x)) || IDENTIFIER_KEY.test(key) || (randomish && /(?:^|[^a-z])(?:id|token)$/i.test(key))) {
        report.error('persistent-identifier', `${tokens[i - 2].value}.setItem stores a generated or identifying value; no persistent identifiers`, rel, line(t));
      }
      const slug = S.slug ?? '';
      if (key && slug && !key.toLowerCase().includes(slug) && !key.toLowerCase().includes(slug.replace(/-/g, ''))) {
        report.warn('storage-key-unprefixed', `storage key "${key.slice(0, 40)}" does not contain the project slug "${slug}"; every day shares one origin, so keys collide`, rel, line(t));
      }
    }

    if ((v === 'src' || v === 'srcset' || v === 'poster') && isP(next, ':') && tokens[i + 2]?.type === 'str' && !dotted) {
      const nearby = tokens.slice(Math.max(0, i - 14), i);
      const script = nearby.some((x) => x.type === 'str' && x.value.toLowerCase() === 'script');
      sink(script ? 'external-script' : 'external-resource', script ? 'code' : 'resource', [tokens[i + 2]], t, `{ ${v}: ... } property`);
    }
    if (v === 'fetch' && bare && call) {
      sink('external-fetch', 'data', callArgs(tokens, i + 1).args[0], t, 'fetch()');
    } else if (v === 'sendBeacon' && call) {
      sink('external-beacon', 'data', callArgs(tokens, i + 1).args[0], t, 'sendBeacon()');
      report.warn('beacon', 'sendBeacon is a tracking pattern and has no purpose on a static site', rel, line(t));
    } else if (v === 'open' && dotted && call) {
      const { args } = callArgs(tokens, i + 1);
      if (args[0].length === 1 && args[0][0].type === 'str' && HTTP_METHODS.test(args[0][0].value) && args[1]) {
        sink('external-xhr', 'data', args[1], t, 'XMLHttpRequest.open()');
      } else if (global) {
        sink('navigation-external', 'nav', args[0], t, 'window.open()');
      }
    } else if (v === 'open' && !dotted && call && !isI(prev, 'function') && !isI(prev, 'new') && !isMethodDef() && !declaresOpen) {
      sink('navigation-external', 'nav', callArgs(tokens, i + 1).args[0], t, 'open()');
    } else if ((isI(prev, 'new') || (global && isI(tokens[i - 3], 'new'))) && call) {
      const { args } = callArgs(tokens, i + 1);
      const specs = {
        WebSocket: ['external-websocket', 'data'],
        EventSource: ['external-eventsource', 'data'],
        WebTransport: ['external-websocket', 'data'],
        Request: ['external-fetch', 'data'],
        Worker: ['external-worker', 'code'],
        SharedWorker: ['external-worker', 'code'],
        Audio: ['external-resource', 'resource'],
      };
      if (specs[v]) sink(specs[v][0], specs[v][1], args[0], t, `new ${v}()`);
    } else if (v === 'importScripts' && bare && call) {
      for (const a of callArgs(tokens, i + 1).args) sink('external-importscripts', 'code', a, t, 'importScripts()');
    } else if (v === 'import' && !dotted) {
      if (call) {
        sink('external-import', 'code', callArgs(tokens, i + 1).args[0], t, 'import()');
      } else if (next?.type === 'str') {
        importSpec(next, next.value);
      } else if (next && !isP(next, '.')) {
        for (let j = i + 1; j < Math.min(tokens.length, i + 400); j++) {
          if (isP(tokens[j], ';') || isI(tokens[j], 'import')) break;
          if (isI(tokens[j], 'from') && tokens[j + 1]?.type === 'str') {
            importSpec(tokens[j + 1], tokens[j + 1].value);
            break;
          }
        }
      }
    } else if (v === 'export' && !dotted) {
      for (let j = i + 1; j < Math.min(tokens.length, i + 80); j++) {
        const u = tokens[j];
        if (isP(u, ';') || (u.type === 'id' && /^(?:function|class|const|let|var|default|async)$/.test(u.value))) break;
        if (isI(u, 'from') && tokens[j + 1]?.type === 'str') {
          importSpec(tokens[j + 1], tokens[j + 1].value);
          break;
        }
      }
    } else if ((v === 'assign' || v === 'replace') && dotted && call && isI(tokens[i - 2], 'location')) {
      sink('navigation-external', 'nav', callArgs(tokens, i + 1).args[0], t, `location.${v}()`);
    } else if ((v === 'setAttribute' || v === 'setAttributeNS') && dotted && call) {
      const { args } = callArgs(tokens, i + 1);
      const shift = v === 'setAttributeNS' ? 1 : 0;
      const nameTok = args[shift]?.length === 1 ? args[shift][0] : null;
      const valueArg = args[shift + 1];
      if (nameTok?.type === 'str' && valueArg) {
        const attr = nameTok.value.toLowerCase();
        const recv = tokens[i - 2];
        if (/^(?:src|srcset|poster|data|xlink:href)$/.test(attr) || (attr === 'href' && /link|style|sheet|css/i.test(recv?.value ?? ''))) {
          const code = recv && (/script/i.test(recv.value ?? '') || (assign.get(recv.value) ?? []).some((rhs) => rhs.some((x) => isI(x, 'createElement')) && rhs.some((x) => x.type === 'str' && x.value.toLowerCase() === 'script'))) ? 'external-script' : 'external-resource';
          sink(code, code === 'external-script' ? 'code' : 'resource', valueArg, t, `setAttribute("${attr}")`);
        } else if (/^(?:action|formaction)$/.test(attr)) {
          sink('external-form', 'code', valueArg, t, `setAttribute("${attr}")`);
        }
      }
    } else if (isP(next, '=') && (dotted || v === 'location')) {
      const arg = [];
      let depth = 0;
      for (let j = i + 2; j < tokens.length && arg.length < 60; j++) {
        const u = tokens[j];
        if (u.type === 'punc') {
          if ('([{'.includes(u.value)) depth++;
          else if (')]}'.includes(u.value)) {
            if (depth === 0) break;
            depth--;
          } else if ((u.value === ';' || u.value === ',') && depth === 0) break;
        }
        arg.push(u);
      }
      const recv = prev && dotted ? tokens[i - 2] : null;
      const recvName = recv?.value ?? '';
      const madeBy = (tag) => (assign.get(recvName) ?? []).some((rhs) => rhs.some((x) => isI(x, 'createElement')) && rhs.some((x) => x.type === 'str' && x.value.toLowerCase() === tag));
      const chainedScript = dotted && isP(tokens[i - 2], ')') && tokens.slice(Math.max(0, i - 8), i).some((x) => x.type === 'str' && x.value.toLowerCase() === 'script');
      if (v === 'location' && (!dotted || GLOBAL_OBJECTS.has(recvName) || recvName === 'document')) sink('navigation-external', 'nav', arg, t, 'location assignment');
      else if (/^(?:host|hostname|port|protocol)$/.test(v) && recvName === 'location') report.error('navigation-external', `location.${v} is assigned, which moves the page to another origin`, rel, line(t));
      else if (v === 'src' || v === 'srcset' || v === 'poster') {
        const isScript = chainedScript || /script/i.test(recvName) || madeBy('script');
        sink(isScript ? 'external-script' : 'external-resource', isScript ? 'code' : 'resource', arg, t, `.${v} assignment`);
      } else if (v === 'data' && /object|embed/i.test(recvName)) sink('external-frame', 'code', arg, t, '.data assignment');
      else if (v === 'action' || v === 'formAction') sink('external-form', 'code', arg, t, `.${v} assignment`);
      else if (v === 'href') {
        if (/^(?:location|document|window|self|top|parent)$/i.test(recvName) || (isI(tokens[i - 2], 'location'))) {
          sink('navigation-external', 'nav', arg, t, 'location.href assignment');
        } else if (/link|style|sheet|css/i.test(recvName) || madeBy('link')) {
          sink('external-stylesheet', 'code', arg, t, 'link.href assignment');
        }
      }
    }

    if (v === 'atob' && call) {
      const { args } = callArgs(tokens, i + 1);
      if (args[0].length === 1 && args[0][0].type === 'str') {
        const dec = Buffer.from(args[0][0].value, 'base64').toString('latin1');
        if (URL_LIKE.test(dec)) report.error('encoded-url', 'atob() decodes to a URL', rel, line(t));
      }
    } else if ((v === 'fromCharCode' || v === 'fromCodePoint') && call) {
      const { args } = callArgs(tokens, i + 1);
      if (args.length >= 6 && args.every((a) => a.length === 1 && a[0].type === 'num')) {
        let s = '';
        try {
          s = String.fromCodePoint(...args.map((a) => Number(st.src.slice(a[0].start, a[0].end))));
        } catch { /* invalid code point */ }
        if (/^\s*(?:(?:https?|wss?|ftp):)?\/\//i.test(s)) report.error('encoded-url', `${v}() builds a URL`, rel, line(t));
      }
    }
  }
}

function literalChecks(tok, text, S, st) {
  const { report, rel } = S;
  const line = S.lineOf(S.base + tok.start);
  if (/^[\u0000- ]*(?:javascript|vbscript):/i.test(text)) report.error('javascript-url', 'javascript: URL in a string', rel, line);
  if (/<\s*script\b/i.test(text)) st.scriptLiterals.push(line);
  if (text.length >= 12 && text.length < 2000 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) {
    const dec = Buffer.from(text, 'base64').toString('latin1');
    if (/^(?:https?|wss?):\/\/[\w.-]+/i.test(dec)) report.error('encoded-url', 'base64 string decodes to a URL', rel, line);
    if (RTC_FRAGMENT.test(dec)) report.error('webrtc', 'base64 string decodes to a WebRTC API name', rel, line);
  }
  if (text.length < 200 && (RTC_FRAGMENT.test(text) || RTC_FRAGMENT.test([...text].reverse().join('')))) {
    report.error('webrtc', 'string names a WebRTC API (STUN/TURN traffic bypasses the CSP)', rel, line);
  }
  if (/\/\/:(?:sptth|ptth|ssw|sw)/i.test(text)) {
    report.error('reversed-url', 'string looks like a reversed URL', rel, line);
  }
  if (text.length < 100000 && (/\burl\s*\(/i.test(text) || /@import\b/i.test(text))) {
    scanCss(text, { ...S, base: S.base + tok.start + 1 }, { dir: st.dir });
  }
  if (text.includes('<') && /<[a-zA-Z]/.test(text) && text.length < 100000) {
    scanMarkup(text, { ...S, base: S.base + tok.start + 1, fragment: true, isEntry: false }, { dir: st.dir });
  }
}

/* ------------------------------------------------------------------------------------------------
 * Content-Security-Policy
 * ---------------------------------------------------------------------------------------------- */

const FETCH_DIRECTIVES = new Set(['default-src', 'script-src', 'script-src-elem', 'script-src-attr', 'style-src', 'style-src-elem', 'style-src-attr', 'img-src', 'media-src', 'font-src', 'connect-src', 'worker-src', 'child-src', 'frame-src', 'object-src', 'manifest-src', 'prefetch-src']);

function parseCsp(content) {
  const directives = new Map();
  for (const part of content.split(';')) {
    const toks = part.trim().split(/\s+/).filter(Boolean);
    if (!toks.length) continue;
    const name = toks[0].toLowerCase();
    if (!directives.has(name)) directives.set(name, toks.slice(1));
  }
  return directives;
}

/** @returns {{errors:Array<[string,string]>, warnings:Array<[string,string]>}} as [code, message] pairs */
export function checkCsp(content, declared) {
  const errors = [];
  const warnings = [];
  const d = parseCsp(content);
  if (!d.has('default-src')) errors.push(['csp-no-default-src', 'CSP has no default-src']);
  const effective = (name) => d.get(name) ?? d.get('default-src') ?? [];
  for (const [name, toks] of d) {
    if (name === 'report-uri' || name === 'report-to') errors.push(['csp-report', `${name} would send violation reports to a third party`]);
    for (const tok of toks) {
      const lower = tok.toLowerCase();
      if (lower === "'unsafe-eval'") errors.push(['csp-unsafe-eval', `${name} allows 'unsafe-eval'`]);
      if (!FETCH_DIRECTIVES.has(name)) continue;
      if (lower.startsWith("'")) continue;
      if (lower.includes('*')) errors.push(['csp-wildcard', `${name} contains a wildcard source (${tok})`]);
      else if (/^(?:https?|wss?|ftp):$/.test(lower)) errors.push(['csp-scheme-source', `${name} allows every ${tok} URL`]);
      else if (/^[a-z][a-z0-9+.-]*:$/.test(lower)) {
        if (lower !== 'data:' && lower !== 'blob:') errors.push(['csp-scheme-source', `${name} allows the ${tok} scheme`]);
      } else {
        const host = hostOf(lower.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''));
        if (!declared.has(host)) errors.push(['csp-external-host', `${name} allows ${tok}, which is not a declared network host`]);
      }
    }
  }
  for (const name of ['script-src', 'script-src-elem', 'object-src']) {
    for (const tok of d.get(name) ?? []) {
      if (/^(?:data:|blob:|filesystem:)$/i.test(tok)) errors.push(['csp-weak-script-src', `${name} allows ${tok}`]);
    }
  }
  for (const tok of effective('script-src')) {
    if (/^(?:data:|blob:|filesystem:)$/i.test(tok) && !d.has('script-src')) errors.push(['csp-weak-script-src', `default-src allows ${tok} for scripts`]);
  }
  if (!d.has('connect-src') && !d.has('default-src')) errors.push(['csp-no-connect-src', 'CSP restricts neither connect-src nor default-src']);
  const connect = effective('connect-src').map((x) => x.toLowerCase());
  for (const h of declared) {
    if (!connect.some((x) => !x.startsWith("'") && hostOf(x.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')) === h)) {
      warnings.push(['csp-missing-network-host', `declared network host ${h} is not allowed by connect-src, so the browser will block it`]);
    }
  }
  if (!d.has('base-uri')) warnings.push(['csp-no-base-uri', "CSP has no base-uri directive (use base-uri 'none')"]);
  if (!d.has('form-action')) warnings.push(['csp-no-form-action', "CSP has no form-action directive (use form-action 'none')"]);
  return { errors, warnings };
}

/* ------------------------------------------------------------------------------------------------
 * HTML analysis
 * ---------------------------------------------------------------------------------------------- */

const LOADING_RELS_CODE = new Set(['stylesheet', 'modulepreload', 'import']);
const LOADING_RELS_HINT = new Set(['preload', 'prefetch', 'prerender', 'dns-prefetch', 'preconnect']);
const LOADING_RELS_ICON = new Set(['icon', 'apple-touch-icon', 'apple-touch-icon-precomposed', 'mask-icon', 'manifest', 'shortcut']);
const BANNED_ELEMENTS = new Set(['applet', 'frameset', 'frame', 'isindex']);
const HEAD_OK = new Set(['html', 'head', 'title', 'meta', 'link', 'style', 'script', 'base', 'noscript', 'template', 'basefont', 'bgsound']);
const JS_TYPES = new Set(['', 'module', 'text/javascript', 'application/javascript', 'application/x-javascript', 'text/ecmascript', 'application/ecmascript', 'text/jscript', 'text/livescript', 'text/x-javascript']);
const META_HTTP_EQUIV_OK = new Set(['content-type', 'x-ua-compatible', 'content-language']);
// Attributes that hold prose, never a CSS value.
const TEXT_ATTRS = /^(?:content|alt|title|placeholder|label|value|aria-[a-z]+)$/;
const DATA_SCRIPT_TYPES = new Set(['application/json', 'application/ld+json', 'importmap', 'speculationrules']);

function scanMarkup(src, S, extra = {}) {
  const { report, rel } = S;
  const tokens = tokenizeHtml(src);
  const lineOf = (off) => S.lineOf(S.base + off);
  const dir = extra.dir ?? S.dir;
  const result = {
    commentRanges: [], inlineModules: [], title: null, lang: null, viewport: false, backLink: false, csp: [], earlyLoader: null, tokens,
  };
  let headOpen = true;
  let noscript = 0;
  let template = 0;

  const attrs = (tok) => {
    const m = new Map();
    for (const a of tok.attrs) if (!m.has(a.name)) m.set(a.name, a);
    return m;
  };

  for (let ti = 0; ti < tokens.length; ti++) {
    const tok = tokens[ti];
    if (tok.t === 'comment') {
      result.commentRanges.push([tok.start, tok.end]);
      if (tok.unterminated && !S.fragment) report.warn('unterminated-comment', 'HTML comment is never closed; the rest of the file is ignored by browsers', rel, lineOf(tok.start));
      continue;
    }
    if (tok.t === 'text') {
      const chunk = src.slice(tok.start, tok.end);
      if (headOpen && noscript === 0 && /[^\s]/.test(chunk)) headOpen = false;
      if (S.acc && !S.fragment) S.acc.text.push(decodeEntities(chunk));
      continue;
    }
    if (tok.t === 'end') {
      if (tok.name === 'noscript') noscript = Math.max(0, noscript - 1);
      else if (tok.name === 'template') template = Math.max(0, template - 1);
      continue;
    }
    if (tok.t !== 'start') continue;

    const name = tok.name;
    const A = attrs(tok);
    const line = lineOf(tok.start);
    // Browsers resolve character references in every attribute value before comparing it, so token comparisons
    // (rel, type, http-equiv, name ...) use val(); URL-ish values go through classifyUrl/srcsetCheck, which decode
    // themselves, so they read rawVal() (decoding twice would be wrong).
    const rawVal = (k) => (A.has(k) ? A.get(k).value : undefined);
    const val = (k) => (A.has(k) ? decodeEntities(A.get(k).value) : undefined);
    if (tok.eof && !S.fragment) report.warn('malformed-html', `tag <${name}> is never closed (end of file inside a tag)`, rel, line);

    if (name === 'noscript') noscript++;
    else if (name === 'template') template++;
    if (noscript === 0 && template === 0 && headOpen && !HEAD_OK.has(name)) headOpen = false;
    if (name === 'body') headOpen = false;

    const url = (attrName, spec) => {
      const a = A.get(attrName);
      if (!a) return;
      const u = classifyUrl(a.value);
      if (u.kind === 'relative' && !S.fragment && /&[A-Za-z0-9]+;/.test(decodeEntities(a.value))) {
        report.warn('unresolved-entity', `unrecognised character reference in ${attrName} URL`, rel, line);
      }
      S.url(u, { ...spec, resource: spec.resource && !S.fragment, line, dir, what: `<${name} ${attrName}>` });
    };

    // generic per-attribute checks
    for (const a of tok.attrs) {
      if (a.name.length > 2 && a.name.startsWith('on')) {
        scanJs(decodeEntities(a.value), S, { base: a.valueStart, dir });
      } else if (a.value.includes('(') && !TEXT_ATTRS.test(a.name)) {
        // style="...", and SVG presentation attributes (fill, mask, clip-path, filter, marker-*, cursor ...) take CSS
        // url() values and fetch them like a stylesheet would.
        scanCss(decodeEntities(a.value), S, { base: a.valueStart, dir });
      }
      if (S.acc && !S.fragment) {
        if (a.name === 'data-sed-placeholder') S.acc.placeholders.push(`${rel}:${line}`);
        else if (/^(?:alt|title|aria-label|placeholder)$/.test(a.name) && a.value) S.acc.text.push(decodeEntities(a.value));
      }
    }
    if (tok.bodyStart !== undefined && (RAW_MARKUP.has(name) || tok.foreign)) {
      scanMarkup(src.slice(tok.bodyStart, tok.bodyEnd), { ...S, base: S.base + tok.bodyStart, fragment: true, isEntry: false }, { dir });
    }

    const loadsBeforeCsp = () => {
      if (!S.fragment && !result.csp.length && !result.earlyLoader) result.earlyLoader = { name, line };
    };

    switch (name) {
      case 'html': {
        const lang = val('lang');
        if (lang !== undefined && result.lang === null) result.lang = lang.trim();
        break;
      }
      case 'meta': {
        const he = (val('http-equiv') ?? '').trim().toLowerCase();
        const content = val('content') ?? '';
        if (he === 'content-security-policy') {
          if (noscript === 0 && template === 0) result.csp.push({ content, line, inHead: headOpen });
        } else if (he === 'refresh') {
          // Navigation is not governed by the CSP and a delayed refresh outlives the QA dwell time, so no refresh at all.
          const m = /^\s*[\d.]*\s*[;,]?\s*(?:url\s*=\s*)?(['"]?)(.*?)\1\s*$/i.exec(content);
          const target = m?.[2] ?? '';
          const u = target ? classifyUrl(target) : null;
          const where = u ? (u.kind === 'external' ? u.host : u.kind) : 'this page';
          report.error('meta-refresh', `meta refresh redirects to ${where}; page refreshes and redirects are not allowed`, rel, line);
        } else if (he !== '' && !META_HTTP_EQUIV_OK.has(he)) {
          report.error('meta-http-equiv', `<meta http-equiv="${he.slice(0, 40)}"> is not allowed (only content-security-policy and content-type style hints)`, rel, line);
        }
        if ((val('name') ?? '').trim().toLowerCase() === 'viewport' && /width\s*=\s*device-width/i.test(val('content') ?? '')) result.viewport = true;
        if ((val('name') ?? '').trim().toLowerCase() === 'description') result.description = content.trim();
        break;
      }
      case 'base':
        if (A.has('href')) report.error('base-href', '<base href> rewrites every relative URL; not allowed', rel, line);
        break;
      case 'title':
        if (result.title === null && tok.bodyStart !== undefined) {
          result.title = decodeEntities(src.slice(tok.bodyStart, tok.bodyEnd)).replace(/\s+/g, ' ').trim();
          if (S.acc && !S.fragment) S.acc.text.push(result.title);
        }
        break;
      case 'script': {
        loadsBeforeCsp();
        const type = (val('type') ?? '').trim().toLowerCase();
        const body = tok.bodyStart !== undefined ? src.slice(tok.bodyStart, tok.bodyEnd) : '';
        if (A.has('src')) url('src', { code: 'external-script', role: 'code', resource: true });
        if (A.has('href')) url('href', { code: 'external-script', role: 'code', resource: true });
        if (JS_TYPES.has(type)) {
          if (body.trim() && !S.fragment) {
            const { comments } = scanJs(body, S, { base: tok.bodyStart, dir });
            for (const [a, b] of comments) result.commentRanges.push([tok.bodyStart + a, tok.bodyStart + b]);
            if (type === 'module') result.inlineModules.push({ code: body, line: lineOf(tok.bodyStart) });
            else {
              try {
                new vm.Script(body, { filename: rel });
              } catch (err) {
                report.error('js-syntax', `inline script: ${String(err.message).split('\n')[0]}`, rel, lineOf(tok.bodyStart));
              }
            }
          } else if (body.trim()) {
            scanJs(body, S, { base: tok.bodyStart, dir });
          }
        } else if (DATA_SCRIPT_TYPES.has(type)) {
          let parsed;
          try {
            parsed = JSON.parse(body);
          } catch (err) {
            report.warn('bad-json-script', `<script type="${type}"> is not valid JSON: ${err.message}`, rel, lineOf(tok.bodyStart ?? tok.start));
          }
          if (parsed !== undefined && (type === 'importmap' || type === 'speculationrules')) {
            const walk = (x) => {
              if (typeof x === 'string') {
                const u = classifyUrl(x);
                if (u.kind === 'external') S.url(u, { code: type === 'importmap' ? 'external-import' : 'external-resource', role: 'code', line, dir, what: `<script type="${type}">` });
                else if (u.kind === 'javascript' || u.kind === 'data') report.error(u.kind === 'data' ? 'data-url-code' : 'javascript-url', `${u.kind}: URL in ${type}`, rel, line);
              } else if (x && typeof x === 'object') Object.values(x).forEach(walk);
            };
            walk(parsed);
          }
        } else if (/html|template|x-/.test(type) && body.includes('<')) {
          scanMarkup(body, { ...S, base: S.base + tok.bodyStart, fragment: true }, { dir });
        }
        break;
      }
      case 'style': {
        if (tok.bodyStart !== undefined) {
          const body = src.slice(tok.bodyStart, tok.bodyEnd);
          const { comments, text } = scanCss(body, S, { base: tok.bodyStart, dir });
          for (const [a, b] of comments) result.commentRanges.push([tok.bodyStart + a, tok.bodyStart + b]);
          if (text.includes('<') && /<[a-zA-Z]/.test(text)) scanMarkup(text, { ...S, base: S.base + tok.bodyStart, fragment: true }, { dir });
        }
        break;
      }
      case 'link': {
        const rels = (val('rel') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
        const isCode = rels.some((r) => LOADING_RELS_CODE.has(r));
        const isHint = rels.some((r) => LOADING_RELS_HINT.has(r));
        const isIcon = rels.some((r) => LOADING_RELS_ICON.has(r));
        if (isCode || isHint || isIcon) loadsBeforeCsp();
        if (isCode) url('href', { code: rels.includes('stylesheet') ? 'external-stylesheet' : 'external-modulepreload', role: 'code', resource: true });
        else if (isHint) url('href', { code: 'external-link-hint', role: 'code', resource: true });
        else if (isIcon) url('href', { code: 'external-resource', role: 'resource', resource: true });
        else if (A.has('href')) url('href', { role: 'nav' });
        if (A.has('imagesrcset')) srcsetCheck(rawVal('imagesrcset'), name, line, S, dir);
        break;
      }
      case 'a':
      case 'area': {
        if (A.has('xlink:href')) url('xlink:href', { role: 'nav' });
        if (A.has('href')) {
          url('href', { role: 'nav' });
          const u = classifyUrl(A.get('href').value);
          if (u.kind === 'relative' && /^\.\.\/\.\.\/(?:index\.html)?(?:[?#].*)?$/.test(u.value)) result.backLink = true;
          if (u.kind === 'external' && S.acc) S.acc.links.push({ host: u.host, scheme: u.scheme, target: (val('target') ?? '').toLowerCase(), rel: (val('rel') ?? '').toLowerCase(), file: rel, line });
        }
        if (A.has('ping')) url('ping', { code: 'external-ping', role: 'code' });
        break;
      }
      case 'img':
      case 'image':
        loadsBeforeCsp();
        for (const k of ['src', 'lowsrc', 'dynsrc', 'href', 'xlink:href']) url(k, { code: 'external-resource', role: 'resource', resource: true });
        if (A.has('srcset')) srcsetCheck(rawVal('srcset'), name, line, S, dir);
        break;
      case 'source':
      case 'track':
      case 'video':
      case 'audio':
      case 'bgsound':
        loadsBeforeCsp();
        for (const k of ['src', 'poster']) url(k, { code: 'external-resource', role: 'resource', resource: true });
        if (A.has('srcset')) srcsetCheck(rawVal('srcset'), name, line, S, dir);
        break;
      case 'input':
        if (A.has('src')) {
          loadsBeforeCsp();
          url('src', { code: 'external-resource', role: 'resource', resource: true });
        }
        if (A.has('formaction')) url('formaction', { code: 'external-form', role: 'code' });
        credentialCheck(A, rel, line, S);
        break;
      case 'textarea':
      case 'select':
        credentialCheck(A, rel, line, S);
        break;
      case 'button':
        if (A.has('formaction')) url('formaction', { code: 'external-form', role: 'code' });
        break;
      case 'form':
        if (A.has('action')) url('action', { code: 'external-form', role: 'code' });
        break;
      case 'iframe': {
        loadsBeforeCsp();
        if (A.has('src')) {
          url('src', { code: 'external-frame', role: 'code', resource: true });
          if (classifyUrl(A.get('src').value).kind === 'relative') report.warn('iframe-local', '<iframe> embeds another page; prefer building it into the page', rel, line);
        }
        if (A.has('srcdoc')) {
          const doc = val('srcdoc');
          report.warn('iframe-srcdoc', '<iframe srcdoc> embeds an inline document (scanned, but discouraged)', rel, line);
          scanMarkup(doc, { ...S, base: S.base + A.get('srcdoc').valueStart, fragment: true }, { dir });
        }
        if (!A.has('src') && !A.has('srcdoc')) report.warn('iframe', '<iframe> without src', rel, line);
        break;
      }
      case 'object':
      case 'embed':
        loadsBeforeCsp();
        for (const k of ['data', 'src', 'codebase', 'archive']) url(k, { code: 'external-frame', role: 'code', resource: true });
        break;
      case 'use':
      case 'feimage':
      case 'tref':
        for (const k of ['href', 'xlink:href']) url(k, { code: name === 'use' ? 'external-svg-use' : 'external-resource', role: name === 'use' ? 'code' : 'resource', resource: true });
        break;
      case 'animate':
      case 'set':
      case 'animatetransform':
      case 'animatemotion': {
        const an = (val('attributename') ?? '').toLowerCase();
        if (an === 'href' || an === 'xlink:href') {
          for (const k of ['to', 'from', 'by', 'values']) {
            for (const piece of (rawVal(k) ?? '').split(';')) {
              const u = classifyUrl(piece);
              if (u.kind === 'external' || u.kind === 'javascript' || u.kind === 'data') {
                report.error(u.kind === 'javascript' ? 'javascript-url' : 'external-svg-use', `SVG animation rewrites href to a ${u.kind} URL`, rel, line);
              }
            }
          }
        }
        break;
      }
      default:
        if (BANNED_ELEMENTS.has(name)) report.error('banned-element', `<${name}> is not allowed`, rel, line);
        for (const k of ['src', 'data', 'poster', 'background', 'srcset', 'href', 'xlink:href']) {
          if (!A.has(k)) continue;
          if (name === 'script' || name === 'a') continue;
          const u = classifyUrl(A.get(k).value);
          if (k === 'srcset') srcsetCheck(A.get(k).value, name, line, S, dir);
          else if (u.kind === 'external') {
            const loads = ['body', 'table', 'tr', 'td', 'th'].includes(name) && k === 'background';
            if (loads) S.url(u, { code: 'external-resource', role: 'resource', line, dir, what: `<${name} ${k}>`, resource: true });
            else if (['src', 'data', 'poster', 'href', 'xlink:href'].includes(k)) report.warn('external-url-attr', `<${name} ${k}> points at ${u.host}`, rel, line);
          } else if (u.kind === 'javascript') report.error('javascript-url', `<${name} ${k}> is a javascript: URL`, rel, line);
        }
        break;
    }
  }
  return result;
}

const SENSITIVE_FIELD = /(?:^|[^a-z])(?:card[-_ ]?(?:number|num|no)|cardnumber|cc[-_ ]?(?:number|num|csc|cvc|cvv|exp)|cvv2?|cvc2?|csc|ssn|social[-_ ]?security|iban|routing[-_ ]?(?:number|no)|account[-_ ]?(?:number|no)|sort[-_ ]?code|credit[-_ ]?card|debit[-_ ]?card|security[-_ ]?code)(?:[^a-z]|$)/i;

function credentialCheck(A, rel, line, S) {
  const get = (k) => decodeEntities(A.get(k)?.value ?? '');
  const type = get('type').trim().toLowerCase();
  const ac = get('autocomplete').toLowerCase();
  if (type === 'password' || /\b(?:cc-number|cc-csc|cc-exp|cc-name|current-password|new-password)\b/.test(ac)) {
    S.report.error('credential-form', 'password and payment inputs are not allowed', rel, line);
    return;
  }
  for (const k of ['name', 'id', 'placeholder', 'aria-label', 'title']) {
    if (SENSITIVE_FIELD.test(get(k))) {
      S.report.error('credential-form', `a field asks for sensitive data (${k}="${get(k).slice(0, 40)}"); pages never collect card, bank, identity or password data`, rel, line);
      return;
    }
  }
}

function srcsetCheck(value, tag, line, S, dir) {
  const text = decodeEntities(value);
  let i = 0;
  while (i < text.length) {
    while (i < text.length && (isWs(text[i]) || text[i] === ',')) i++;
    let j = i;
    while (j < text.length && !isWs(text[j])) j++;
    const candidate = text.slice(i, j).replace(/,+$/, '');
    if (candidate) S.url(classifyUrl(candidate), { code: 'external-resource', role: 'resource', line, dir, what: `<${tag} srcset>`, resource: !S.fragment });
    i = j;
    while (i < text.length && text[i] !== ',') {
      if (text[i] === '(') {
        const close = text.indexOf(')', i);
        i = close === -1 ? text.length : close + 1;
      } else i++;
    }
  }
}

/* ------------------------------------------------------------------------------------------------
 * Page contract (DESIGN 7.3): purpose, intro paragraph and explainer section, read from the STATIC entry HTML
 * ---------------------------------------------------------------------------------------------- */

/** Canonical purpose order (ops/taxonomy.json `purposes` key order); the taxonomy is authoritative when it has the block. */
export const PURPOSES = ['tool', 'lesson', 'explorer', 'studio', 'play'];
const PAGE_CONTRACT_DEFAULTS = {
  intro: { minWords: 35, maxWords: 70, firstSentenceMaxWords: 30 },
  explainer: {
    minWords: { tool: 250, lesson: 700, explorer: 350, studio: 200, play: 150 },
    minHeadings: { tool: 2, lesson: 4, explorer: 3, studio: 2, play: 1 },
  },
  lessonMinChecks: 2,
  toolMinSelfTests: 8,
  introMaxBottomPx: { desktop: 420, mobile: 560 },
  firstScreenControls: { warn: 8, error: 14 },
};

const posNum = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const isDay = (v) => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === v;
};
const plainObj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** The purposes in canonical order: ops/taxonomy.json `purposes` keys when the block exists, else PURPOSES. */
export function purposesOf(taxonomy) {
  const keys = Object.keys(plainObj(taxonomy?.purposes));
  return keys.length ? keys : PURPOSES;
}

/**
 * config.pageContract laid over the defaults. A missing block (or a damaged number) means the default number; only
 * `requiredFrom` has no default: null (or anything that is not a real YYYY-MM-DD) means nothing is required.
 */
export function pageContractOf(cfg) {
  const raw = plainObj(cfg?.pageContract);
  const D = PAGE_CONTRACT_DEFAULTS;
  const num = (v, d) => (posNum(v) ? v : d);
  const perPurpose = (v, d) => Object.fromEntries(Object.keys(d).map((p) => [p, num(plainObj(v)[p], d[p])]));
  const intro = plainObj(raw.intro);
  const explainer = plainObj(raw.explainer);
  return {
    present: Object.keys(raw).length > 0,
    requiredFrom: isDay(raw.requiredFrom) ? raw.requiredFrom : null,
    intro: { minWords: num(intro.minWords, D.intro.minWords), maxWords: num(intro.maxWords, D.intro.maxWords), firstSentenceMaxWords: num(intro.firstSentenceMaxWords, D.intro.firstSentenceMaxWords) },
    explainer: { minWords: perPurpose(explainer.minWords, D.explainer.minWords), minHeadings: perPurpose(explainer.minHeadings, D.explainer.minHeadings) },
    lessonMinChecks: num(raw.lessonMinChecks, D.lessonMinChecks),
    toolMinSelfTests: num(raw.toolMinSelfTests, D.toolMinSelfTests),
    introMaxBottomPx: { desktop: num(plainObj(raw.introMaxBottomPx).desktop, D.introMaxBottomPx.desktop), mobile: num(plainObj(raw.introMaxBottomPx).mobile, D.introMaxBottomPx.mobile) },
    firstScreenControls: { warn: num(plainObj(raw.firstScreenControls).warn, D.firstScreenControls.warn), error: num(plainObj(raw.firstScreenControls).error, D.firstScreenControls.error) },
  };
}

/**
 * Does the page contract apply? Never on tiers 3 and 4 (generated fallbacks, exempt); then `force` (the --contract
 * flag) or a set `requiredFrom` with the project date on or after it. Every date gate of the page contract reads this.
 */
export function contractRequired({ contract, date, tier, force = false }) {
  if (tier === 3 || tier === 4) return false;
  if (force) return true;
  return Boolean(contract.requiredFrom && typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= contract.requiredFrom);
}

/** Words as a reader counts them: whitespace-separated runs (U+00A0 included) that hold a letter or a digit. */
export function countWords(text) {
  let n = 0;
  for (const w of String(text).split(/\s+/)) if (/[\p{L}\p{N}]/u.test(w)) n++;
  return n;
}

/** The first sentence: up to the first . ! or ? that ends a word (followed by whitespace or the end). */
export function firstSentence(text) {
  const s = String(text).replace(/\s+/g, ' ').trim();
  const m = /^.*?[.!?](?=\s|$)/.exec(s);
  return m ? m[0] : s;
}

const collapseWs = (s) => String(s).replace(/\s+/g, ' ').trim();
const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const CLOSES_P = new Set(['address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul']);
// "p in button scope", and the special elements that end the search for an open li / dd / dt (address, div and p do not).
const P_SCOPE_STOP = new Set(['button', 'table', 'td', 'th', 'caption', 'template', 'object', 'marquee', 'applet', 'html', 'svg', 'math']);
const ITEM_STOP = new Set(['ul', 'ol', 'menu', 'dl', 'table', 'td', 'th', 'caption', 'button', 'template', 'object', 'section', 'article', 'aside', 'nav', 'main', 'header', 'footer', 'blockquote', 'details', 'summary', 'figure', 'fieldset', 'form', 'body', 'html', 'svg', 'math']);
const PROSE_ANCESTORS = new Set(['p', 'li', 'blockquote', 'figcaption', 'dd']);
const NON_PROSE_ANCESTORS = new Set(['button', 'label', 'select', 'textarea', 'svg', 'canvas', 'script', 'style', 'template']);
// Phrasing elements that do not break a word where they start or end; every other element is a word boundary.
const INLINE_ELEMENTS = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'i', 'ins', 'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr']);
const INTRO_INLINE = new Set(['a', 'abbr', 'b', 'code', 'em', 'i', 'kbd', 'span', 'strong', 'sub', 'sup']);
const INTRO_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'nbsp']);

/**
 * An open-element-stack tree of a page, built from tokenizeHtml the way a browser's tree builder would for the parts
 * the contract reads: void elements are never pushed, a block start closes an open p, li / dd / dt close an open
 * sibling, an end tag closes everything above its element and marks it explicitly closed. Raw-text bodies (script,
 * style, textarea, title, noscript, iframe ...) are not tokenized, so a noscript copy of the intro never appears here.
 */
function contractTree(src, tokens) {
  const root = { name: '#document', attrs: new Map(), kids: [], explicitEnd: true, foreign: false };
  const stack = [root];
  const findOpen = (names, stops) => {
    for (let k = stack.length - 1; k > 0; k--) {
      const n = stack[k].name;
      if (names.includes(n)) return k;
      if (stops && stops.has(n)) return -1;
    }
    return -1;
  };
  for (const tok of tokens) {
    const top = stack[stack.length - 1];
    if (tok.t === 'text') {
      top.kids.push({ text: src.slice(tok.start, tok.end) });
      continue;
    }
    if (tok.t === 'end') {
      if (tok.name === 'br') {
        top.kids.push({ name: 'br', attrs: new Map(), kids: [], explicitEnd: true });
        continue;
      }
      const k = findOpen([tok.name]);
      if (k > 0) {
        stack[k].explicitEnd = true;
        stack.length = k;
      }
      continue;
    }
    if (tok.t !== 'start') continue;
    const name = tok.name;
    if (!top.foreign) {
      if (CLOSES_P.has(name)) {
        const k = findOpen(['p'], P_SCOPE_STOP);
        if (k > 0) stack.length = k;
      }
      if (name === 'li' || name === 'dd' || name === 'dt') {
        const k = findOpen(name === 'li' ? ['li'] : ['dd', 'dt'], ITEM_STOP);
        if (k > 0) stack.length = k;
      }
    }
    const parent = stack[stack.length - 1];
    const attrs = new Map();
    for (const a of tok.attrs) if (!attrs.has(a.name)) attrs.set(a.name, a.value);
    const node = { name, attrs, kids: [], explicitEnd: false, foreign: parent.foreign || name === 'svg' || name === 'math' };
    parent.kids.push(node);
    if ((VOID_ELEMENTS.has(name) && !parent.foreign) || (node.foreign && tok.selfClosing)) {
      node.explicitEnd = true;
      continue;
    }
    stack.push(node);
  }
  return root;
}

/**
 * What the contract needs from the entry page: the intro candidates, the explainer sections with their prose words
 * and headings, and the data-sed-check elements. Content under <template>, a [hidden] element, or a closed <details>
 * that is NOT inside the explainer is excluded. A text token counts once when it has an ancestor in {p, li, blockquote,
 * figcaption, dd} and none in {button, label, select, textarea, svg, canvas, script, style, template}; <br> is a space.
 */
export function analyzeContract(src, tokens = tokenizeHtml(src)) {
  const root = contractTree(src, tokens);
  const intros = [];
  const explainers = [];
  let checks = 0;
  const walk = (node, ctx) => {
    for (const kid of node.kids) {
      if (kid.text !== undefined) {
        if (ctx.explainer && !ctx.excluded && ctx.prose && !ctx.nonProse) ctx.explainer.words.push(decodeEntities(kid.text));
        continue;
      }
      const name = kid.name;
      if (name === 'br') {
        if (ctx.explainer) ctx.explainer.words.push(' ');
        continue;
      }
      const a = kid.attrs;
      const c = { ...ctx };
      if (name === 'main') c.inMain = true;
      if (name === 'template') c.template = c.excluded = true;
      if (a.has('hidden')) c.hidden = c.excluded = true;
      if (name === 'details') {
        c.inDetails = true;
        if (!a.has('open') && !ctx.explainer) c.excluded = true;
      }
      if (PROSE_ANCESTORS.has(name)) c.prose = true;
      if (NON_PROSE_ANCESTORS.has(name)) c.nonProse = true;
      if (name === 'section' && a.has('data-sed-explainer')) {
        const ex = { words: [], headings: 0, inMain: c.inMain, template: c.template, excludedBy: c.template ? '<template>' : c.hidden ? 'a [hidden] element' : c.excluded ? 'a closed <details>' : null };
        explainers.push(ex);
        c.explainer = ex;
      }
      if (name === 'p' && a.has('data-sed-intro')) intros.push({ node: kid, inMain: c.inMain, inDetails: c.inDetails, hidden: c.hidden, template: c.template });
      if (a.has('data-sed-check') && !c.excluded) checks++;
      if ((name === 'h2' || name === 'h3') && c.explainer && !c.template && !c.hidden) c.explainer.headings++;
      const boundary = c.explainer && !INLINE_ELEMENTS.has(name);
      if (boundary) c.explainer.words.push(' ');
      walk(kid, c);
      if (boundary) c.explainer.words.push(' ');
    }
  };
  walk(root, { inMain: false, inDetails: false, hidden: false, template: false, excluded: false, prose: false, nonProse: false, explainer: null });
  for (const ex of explainers) {
    ex.wordCount = countWords(ex.words.join(''));
    delete ex.words;
  }
  return { intros, explainers, checks };
}

/** The intro element's text (entities decoded, every whitespace run collapsed) and what is wrong with its markup. */
function introContent(node) {
  const parts = [];
  const badElements = new Set();
  const badEntities = new Set();
  const visit = (n) => {
    for (const kid of n.kids) {
      if (kid.text !== undefined) {
        for (const m of kid.text.matchAll(/&([A-Za-z][A-Za-z0-9]*);/g)) if (!INTRO_ENTITIES.has(m[1])) badEntities.add(`&${m[1]};`);
        parts.push(decodeEntities(kid.text));
        continue;
      }
      if (!INTRO_INLINE.has(kid.name)) badElements.add(`<${kid.name}>`);
      if (kid.name === 'br') parts.push(' ');
      visit(kid);
    }
  };
  visit(node);
  return { text: collapseWs(parts.join('')), badElements: [...badElements], badEntities: [...badEntities] };
}

/**
 * The project rules of the page contract (DESIGN 7.3), tiers 1 and 2 only. `req`: the contract is required for this
 * page (date gate or --contract). A present purpose, concepts list, intro or intro element is validated either way.
 */
function checkPageContract({ report, pj, contract, req, entrySrc, entryTokens, entryRel, purposes }) {
  const where = 'project.json';
  const fp = plainObj(pj?.fingerprint);
  const purposeList = purposes.join(', ');
  const since = contract.requiredFrom ? `pages dated from ${contract.requiredFrom} (pageContract.requiredFrom) need` : 'the page contract (--contract) needs';
  let purpose = null;
  if (fp.purpose !== undefined) {
    if (typeof fp.purpose === 'string' && purposes.includes(fp.purpose)) purpose = fp.purpose;
    else report.error('purpose', `fingerprint.purpose ${JSON.stringify(fp.purpose)} is not one of ${purposeList}`, where);
  } else if (req) {
    report.error('purpose', `fingerprint.purpose is missing: ${since} one of ${purposeList}`, where);
  }

  if (pj?.concepts !== undefined) {
    const c = pj.concepts;
    if (!Array.isArray(c) || c.length < 1 || c.length > 6 || c.some((x) => typeof x !== 'string' || x.trim().length < 2 || x.trim().length > 40)) {
      report.error('project-json', 'concepts must be an array of 1 to 6 strings of 2 to 40 characters', where);
    }
  }

  if (pj?.intro !== undefined && typeof pj.intro !== 'string') report.error('project-json', 'intro must be a string of plain text', where);
  const introText = typeof pj?.intro === 'string' ? collapseWs(pj.intro) : null;
  const scan = entrySrc === null ? null : analyzeContract(entrySrc, entryTokens ?? undefined);
  const introEls = scan ? scan.intros : [];

  if (introText === null && pj?.intro === undefined) {
    if (req) report.error('intro-missing', `project.json has no "intro": ${since} ${contract.intro.minWords} to ${contract.intro.maxWords} words of plain text, also shown as the page's p.sed-intro[data-sed-intro]`, where);
    else if (introEls.length) report.error('intro-missing', 'the page has a p[data-sed-intro] but project.json has no "intro"; copy the paragraph\'s text into project.json', entryRel);
  }
  if (introText !== null) {
    const { minWords, maxWords, firstSentenceMaxWords } = contract.intro;
    const n = countWords(introText);
    if (n < minWords || n > maxWords) report.error('intro-length', `project.json intro has ${n} words; pageContract.intro allows ${minWords} to ${maxWords}`, where);
    const first = countWords(firstSentence(introText));
    if (first > firstSentenceMaxWords) report.warn('intro-first-sentence', `the first sentence of the intro has ${first} words (pageContract.intro.firstSentenceMaxWords is ${firstSentenceMaxWords}); say what the thing literally is in fewer words`, where);
  }
  if (scan && (req || introText !== null || introEls.length)) {
    const ok = introEls.filter((x) => x.inMain && !x.inDetails && !x.hidden && !x.template);
    if (ok.length !== 1) {
      const why = [...new Set(introEls.filter((x) => !ok.includes(x)).map((x) => (x.template ? 'inside <template>' : x.hidden ? 'inside a [hidden] element' : x.inDetails ? 'inside <details>' : 'outside <main>')))];
      if (ok.length === 0) {
        report.error(introEls.length ? 'intro-placement' : 'intro-missing', `no p[data-sed-intro] inside <main> outside <details>, [hidden], <noscript> and <template>${introEls.length ? ` (${introEls.length} elsewhere: ${why.join(', ')})` : ''}; put the intro paragraph right under the tagline as static markup`, entryRel);
      } else {
        report.error('intro-placement', `${ok.length} p[data-sed-intro] elements inside <main>; exactly one is allowed`, entryRel);
      }
    } else {
      const el = ok[0].node;
      const content = introContent(el);
      if (!el.explicitEnd) report.error('intro-unclosed', 'the intro p[data-sed-intro] has no explicit </p>, so the browser ends it wherever the next block starts; close it right after the intro text', entryRel);
      if (content.badElements.length) report.error('intro-markup', `the intro holds ${content.badElements.join(', ')}; only text and the inline elements a, abbr, b, code, em, i, kbd, span, strong, sub, sup are allowed`, entryRel);
      if (content.badEntities.length) report.error('intro-entity', `the intro uses ${content.badEntities.join(', ')}; type the character instead (only &amp; &lt; &gt; &quot; &#39; &nbsp; and numeric references are allowed)`, entryRel);
      if (introText !== null && content.text !== introText) {
        let i = 0;
        while (i < content.text.length && content.text[i] === introText[i]) i++;
        const show = (s) => JSON.stringify(s.slice(Math.max(0, i - 20), i + 30));
        report.error('intro-mismatch', `the page's intro text differs from project.json "intro" at character ${i + 1}: page ${show(content.text)}, project.json ${show(introText)}`, entryRel);
      }
    }
  }

  if (!req || !scan) return;
  const ex = scan.explainers.filter((x) => x.inMain && !x.template);
  if (ex.length !== 1) {
    const outside = scan.explainers.length - ex.length;
    if (ex.length === 0) report.error('explainer-missing', `no section[data-sed-explainer] inside <main>${outside ? ` (${outside} outside <main> or inside <template>)` : ''}; ${since} the explainer section of the page shell, as static markup`, entryRel);
    else report.error('explainer-placement', `${ex.length} section[data-sed-explainer] elements inside <main>; exactly one is allowed`, entryRel);
    return;
  }
  if (!purpose) return; // the thresholds are per purpose; the purpose error above already says what is missing
  const e = ex[0];
  const minWords = contract.explainer.minWords[purpose];
  const minHeadings = contract.explainer.minHeadings[purpose];
  if (e.wordCount < minWords) {
    report.error('explainer-words', `the explainer has ${e.wordCount} words of prose; a ${purpose} needs at least ${minWords} (pageContract.explainer.minWords.${purpose}). Only text in p, li, blockquote, figcaption or dd counts, never text in controls, svg, canvas, [hidden], <template> or <noscript>${e.excludedBy ? `; this section sits inside ${e.excludedBy}, so none of it counts` : ''}`, entryRel);
  }
  if (e.headings < minHeadings) {
    report.error('explainer-headings', `the explainer has ${e.headings} h2/h3 heading${e.headings === 1 ? '' : 's'}; a ${purpose} needs at least ${minHeadings} (pageContract.explainer.minHeadings.${purpose}, the section's own h2 included)`, entryRel);
  }
  if (purpose === 'lesson' && scan.checks < contract.lessonMinChecks) {
    report.error('explainer-checks', `the page has ${scan.checks} element${scan.checks === 1 ? '' : 's'} with data-sed-check; a lesson needs at least ${contract.lessonMinChecks} exercises (pageContract.lessonMinChecks), each static markup`, entryRel);
  }
}

/* ------------------------------------------------------------------------------------------------
 * Project validation
 * ---------------------------------------------------------------------------------------------- */

const TEXT_EXT = new Set(['.html', '.htm', '.xhtml', '.svg', '.xml', '.css', '.js', '.mjs', '.cjs', '.json', '.webmanifest', '.geojson', '.topojson', '.txt', '.md', '.csv', '.tsv', '.glsl', '.frag', '.vert', '.wgsl', '.map', '.ts', '.jsx', '.tsx', '.yml', '.yaml', '.ini', '.toml', '.log', '.vtt', '.srt', '.ics', '.rss', '.atom', '.mid']);
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.bmp', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.ogg', '.oga', '.wav', '.flac', '.m4a', '.opus', '.mp4', '.webm', '.mov', '.ogv', '.wasm', '.bin', '.pdf', '.zip', '.gz', '.mid', '.midi', '.sf2', '.dat', '.glb', '.gltf']);
const HTML_EXT = new Set(['.html', '.htm', '.xhtml', '.svg', '.xml']);
const NATIVE_EXT = new Set(['.exe', '.dll', '.so', '.dylib', '.msi', '.dmg', '.apk', '.jar', '.com', '.scr', '.bat', '.cmd', '.ps1', '.vbs', '.php', '.pkg', '.deb', '.rpm']);
const SCRIPT_EXT = new Set(['.sh', '.bash', '.py', '.rb', '.pl']);
const FORBIDDEN_NAME = /^(?:\.env(?:\..*)?|\.git(?:ignore|attributes|modules|hub|lab)?|node_modules|\.npmrc|\.ssh|id_rsa|id_ed25519|\.htpasswd|\.aws)$/i;

const SECRET_PATTERNS = [
  [/\bghp_[A-Za-z0-9]{20,}/, 'GitHub personal access token'],
  [/\bgho_[A-Za-z0-9]{20,}|\bghs_[A-Za-z0-9]{20,}|\bghu_[A-Za-z0-9]{20,}/, 'GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/, 'GitHub fine-grained token'],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/, 'Anthropic API key'],
  [/\bsk-[A-Za-z0-9]{32,}/, 'API secret key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
  [/-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE|PGP|OPENSSH)[A-Z ]*-----|-----BEGIN /, 'PEM block'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google API key'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/, 'GitLab token'],
  [/\bnpm_[A-Za-z0-9]{36}\b/, 'npm token'],
  [/\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/, 'payment secret key'],
];

// Kept deliberately small and stored rot13 so the repo does not carry plaintext slurs. Warn-only.
const GUARDRAIL_TERMS = ['avttre', 'snttbg', 'xvxr', 'puvax', 'fcvp', 'genaal'].map((s) => s.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97)));
const GUARDRAIL_RE = new RegExp(`\\b(?:${GUARDRAIL_TERMS.join('|')})\\b`, 'i');
// Gambling is only a problem with real money attached; "no real money" and "not real cash" must not trip it.
const REAL_MONEY = String.raw`(?<!\b(?:no|not|never|without|zero|non|fake)[- ])\breal[- ](?:money|cash)\b`;
const GAMBLING_WORDS = String.raw`(?:bets?|betting|wagers?|gambl\w*|casino|poker|slots?|blackjack|roulette|lottery)`;
const GAMBLING_RE = new RegExp([
  `${REAL_MONEY}[^.\\n]{0,40}\\b${GAMBLING_WORDS}\\b`,
  `\\b${GAMBLING_WORDS}\\b[^.\\n]{0,40}${REAL_MONEY}`,
  String.raw`\b(?:deposit|withdraw|cash[- ]?out)\b[^.\n]{0,60}(?:\breal[- ](?:money|cash)\b|\busd\b|\bbtc\b|\bcrypto\w*|\$\s?\d|€\s?\d|£\s?\d)`,
  String.raw`\bsports ?books?\b`,
  String.raw`\bcash(?:ing)? out (?:your |the )?(?:real )?winnings\b`,
  String.raw`\bplace (?:a |your |real )?(?:bets?|wagers?)\b[^.\n]{0,40}\b(?:odds|money|cash|winnings|payout)\b`,
].join('|'), 'i');

const PHISHING_RES = [
  /\b(?:sign|log)[ -]?in (?:to|with|using) (?:your|the|my) [\w ]{0,30}?account\b/i,
  /\bverify your (?:account|identity|email address|payment|card|bank)\b/i,
  /\b(?:enter|confirm|provide|type in) your (?:password|card number|credit card|cvv|ssn|social security|bank (?:details|account)|account number)\b/i,
  /\bupdate your (?:payment|billing|card|bank)\b/i,
  /\byour account (?:has been|is|will be) (?:suspended|locked|compromised|closed|restricted)\b/i,
  /\b(?:claim|win) (?:your )?(?:free )?(?:gift card|prize|reward|bonus) (?:now|today)\b/i,
];
const BRANDS_STRICT = ['pokerstars', 'partypoker', '888poker', 'ggpoker', 'draftkings', 'fanduel', 'bet365', 'betmgm', 'bovada', 'paypal', 'venmo', 'zelle', 'coinbase', 'binance', 'metamask', 'robinhood', 'wells fargo', 'bank of america', 'citibank', 'mastercard', 'american express', 'apple id', 'icloud', 'facebook', 'instagram', 'tiktok', 'netflix', 'gmail'];
const BRANDS_IMPERSONATION_ONLY = ['google', 'microsoft', 'amazon', 'apple', 'discord', 'twitter', 'steam'];
const POLITICAL_TERMS = /\b(?:elections?|electoral|ballots?|senators?|congress(?:man|men|woman|women|ional)?|democrats|republicans|gop|trump|biden|obama|putin|parliament|prime minister|referendum|impeach\w*|white house|supreme court|partisan)\b/gi;
const ADVICE_RE = /\byou should (?:invest|buy|sell|stop taking|take)\b|\bdiagnos(?:e|es|is|ing)\b|\bdosages?\b|\bguaranteed (?:returns?|profits?)\b|\bfinancial advice\b|\bmedical advice\b|\blegal advice\b/i;
const NOT_ADVICE_RE = /\b(?:not|isn't|no)\b[^.\n]{0,40}\b(?:medical|financial|legal|investment)?\s*advice\b|\bfor entertainment\b/i;
const SHORTENERS = new Set(['bit.ly', 't.co', 'tinyurl.com', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly', 'rebrand.ly', 'cutt.ly', 'shorturl.at', 'tiny.cc', 'rb.gy', 'lnkd.in']);
const MEDIA_EXT = new Set(['.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.ogg', '.oga', '.wav', '.flac', '.m4a', '.opus', '.mid', '.midi', '.sf2', '.mp4', '.webm', '.mov', '.ogv', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.bmp']);
// Values copied verbatim from ops/templates: a build that still carries them was never filled in.
const TEMPLATE_TEXT = {
  tagline: 'One line that makes someone want to try it',
  description: 'One to three sentences on what the page is',
  makingOf: 'A short paragraph: how it works',
  sourceTitle: 'Name of a page that was actually consulted',
  pageTitle: 'Project Title',
  pageDescription: 'One or two sentences about what this page does.',
  intro: 'An example project that shows the shape of a page',
};
const WAIVABLE = new Set(['privacy-api', 'guardrail-gambling', 'politics-undeclared', 'brand-impersonation']);

function loadWaivers(dirName) {
  try {
    const all = JSON.parse(fs.readFileSync(rp('ops', 'waivers.json'), 'utf8'));
    const list = all?.[dirName];
    return new Set(Array.isArray(list) ? list.filter((c) => WAIVABLE.has(c)) : []);
  } catch {
    return new Set();
  }
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function checkPng(buf, report, file, limits) {
  if (buf.length > limits.thumbMaxBytes) report.error('thumb-too-large', `${file} is ${buf.length} bytes (max ${limits.thumbMaxBytes})`, file);
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    report.error('thumb-not-png', `${file} is not a PNG file`, file);
    return;
  }
  const len = buf.readUInt32BE(8);
  if (len !== 13 || buf.toString('latin1', 12, 16) !== 'IHDR') {
    report.error('thumb-corrupt', `${file}: first chunk is not a valid IHDR`, file);
    return;
  }
  if (crc32(buf.subarray(12, 29)) !== buf.readUInt32BE(29)) report.error('thumb-corrupt', `${file}: IHDR checksum mismatch`, file);
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (w !== 1200 || h !== 630) report.error('thumb-size', `${file} is ${w}x${h}, expected 1200x630`, file);
  if (buf.toString('latin1', buf.length - 8, buf.length - 4) !== 'IEND') report.error('thumb-corrupt', `${file} is truncated (no IEND chunk)`, file);
}

function validateFingerprint(fp, taxonomy, report, strict) {
  const where = 'project.json';
  if (!fp || typeof fp !== 'object' || Array.isArray(fp)) {
    report.error('fingerprint', 'fingerprint must be an object', where);
    return;
  }
  if (!Object.hasOwn(taxonomy.categories, fp.category)) report.error('fingerprint', `unknown category ${JSON.stringify(fp.category)}`, where);
  if (!taxonomy.mechanics.includes(fp.mechanic)) report.error('fingerprint', `unknown mechanic ${JSON.stringify(fp.mechanic)}`, where);
  if (!Array.isArray(fp.tone) || !fp.tone.length || fp.tone.some((t) => !taxonomy.tones.includes(t))) report.error('fingerprint', 'tone must be a non-empty subset of the taxonomy tones', where);
  if (!['interest', 'currentEvents', 'humor', 'wildcard'].includes(fp.slot)) report.error('fingerprint', `unknown slot ${JSON.stringify(fp.slot)}`, where);
  if (fp.political !== undefined && typeof fp.political !== 'boolean') report.error('fingerprint', 'political must be a boolean', where);
  if (!Array.isArray(fp.tech)) report.warn('fingerprint', 'tech should be an array', where);
  for (const key of ['tags', 'keywords']) {
    const arr = fp[key];
    const soft = strict ? report.error.bind(report) : report.warn.bind(report);
    if (!Array.isArray(arr)) {
      soft('fingerprint', `${key} must be an array`, where);
      continue;
    }
    if (arr.length < 3 || arr.length > 12) soft('fingerprint', `${key} must hold 3 to 12 entries (has ${arr.length})`, where);
    if (arr.some((x) => typeof x !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(x))) soft('fingerprint', `${key} must be lowercase kebab-case strings`, where);
  }
}

function nodeCheck(file) {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--check', file], { timeout: 20000, maxBuffer: 1 << 20 }, (err, _out, stderr) => {
      if (!err) resolve(null);
      else {
        const first = String(stderr || err.message).split('\n').find((l) => /Error/.test(l)) ?? String(err.message).split('\n')[0];
        resolve(first.trim());
      }
    });
  });
}

function hasModuleSyntax(tokens) {
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'punc') {
      if (t.value === '{' || t.value === '(' || t.value === '[') depth++;
      else if (t.value === '}' || t.value === ')' || t.value === ']') depth--;
    } else if (t.type === 'id' && depth === 0 && !isP(tokens[i - 1], '.')) {
      if (t.value === 'export') return true;
      if (t.value === 'import') {
        const n = tokens[i + 1];
        if (n && !isP(n, '(') && !isP(n, '.')) return true;
      }
    }
  }
  return false;
}

function countLoc(text, ranges) {
  const sorted = ranges.filter(Boolean).sort((a, b) => a[0] - b[0]);
  let loc = 0;
  let ri = 0;
  let ls = 0;
  const n = text.length;
  while (ls <= n) {
    let le = text.indexOf('\n', ls);
    if (le === -1) le = n;
    if (le - ls <= 400) {
      let counted = false;
      for (let p = ls; p < le && !counted; p++) {
        const c = text.charCodeAt(p);
        if (c === 32 || c === 9 || c === 13 || c === 12) continue;
        while (ri < sorted.length && sorted[ri][1] <= p) ri++;
        if (ri < sorted.length && sorted[ri][0] <= p) {
          p = sorted[ri][1] - 1;
          continue;
        }
        counted = true;
      }
      if (counted) loc++;
    }
    ls = le + 1;
  }
  return loc;
}

function walkProject(root, report) {
  const files = [];
  const stack = [''];
  while (stack.length) {
    const relDir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, relDir), { withFileTypes: true });
    } catch (err) {
      report.error('unreadable', `cannot read directory ${relDir || '.'}: ${err.message}`, relDir || '.');
      continue;
    }
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (FORBIDDEN_NAME.test(e.name)) {
        report.error('forbidden-name', `${rel} must not be published`, rel);
        continue;
      }
      if (e.name === '.DS_Store' || e.name === 'Thumbs.db') {
        report.warn('junk-file', `${rel} is an OS artifact`, rel);
        continue;
      }
      if (e.isSymbolicLink()) {
        report.error('symlink', `${rel} is a symbolic link`, rel);
        continue;
      }
      if (e.isDirectory()) stack.push(rel);
      else if (e.isFile()) files.push(rel);
    }
  }
  return files.sort();
}

export async function validateProject(dir, { tier, now, contract: forceContract = false } = {}) {
  const report = new Report();
  const stats = { files: 0, bytes: 0, ownLoc: 0 };
  const done = () => ({ ok: report.errors.length === 0, errors: report.errors, warnings: report.warnings, stats });

  let cfg;
  let taxonomy;
  try {
    cfg = loadConfig();
    taxonomy = loadTaxonomy();
  } catch (err) {
    report.error('config', `cannot load config/taxonomy: ${err.message}`);
    return done();
  }
  const limits = cfg.limits;
  const contract = pageContractOf(cfg);
  const purposes = purposesOf(taxonomy);

  let root = path.resolve(String(dir));
  if (!fs.existsSync(root) && !path.isAbsolute(String(dir)) && fs.existsSync(rp(String(dir)))) root = rp(String(dir));
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    report.error('no-such-dir', `${dir} is not a directory`);
    return done();
  }
  const dirName = path.basename(root);
  report.waived = loadWaivers(dirName);
  const dm = /^(\d{4}-\d{2}-\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(dirName);
  if (!dm) report.error('dir-name', `directory name "${dirName}" must be <YYYY-MM-DD>-<slug>`);

  const relFiles = walkProject(root, report);
  const fileSet = new Set(relFiles);
  stats.files = relFiles.length;

  // project.json
  let pj = null;
  if (!fileSet.has('project.json')) report.error('project-json', 'project.json is missing', 'project.json');
  else {
    try {
      pj = JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8').replace(/^\ufeff/, ''));
    } catch (err) {
      report.error('project-json', `project.json does not parse: ${err.message}`, 'project.json');
    }
  }
  const reqTier = tier === undefined || tier === null ? undefined : Number(tier);
  const effTier = reqTier ?? (Number.isInteger(pj?.tier) ? pj.tier : 1);
  // Content-policy findings gate the real builds (tiers 1 and 2); the generated fallback tiers only report them.
  const guard = (code, msg, file, line) => (effTier <= 2 ? report.error : report.warn).call(report, code, msg, file, line);
  const declared = new Set();
  let entryRel = 'index.html';
  let thumbRel = 'thumb.png';

  if (pj && typeof pj === 'object') {
    const need = (k, ok, msg) => {
      if (!ok(pj[k])) report.error('project-json', msg ?? `"${k}" is missing or invalid`, 'project.json');
    };
    const str = (v) => typeof v === 'string' && v.trim().length > 0;
    need('schema', (v) => v === 1, '"schema" must be 1');
    need('date', (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v));
    need('slug', (v) => typeof v === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v));
    need('title', str);
    need('tagline', str);
    need('description', str);
    need('tier', (v) => [1, 2, 3, 4].includes(v), '"tier" must be 1, 2, 3 or 4');
    if (dm && pj.date && pj.slug && `${pj.date}-${pj.slug}` !== dirName) {
      report.error('dir-name', `directory ${dirName} does not match project.json (${pj.date}-${pj.slug})`, 'project.json');
    }
    if (typeof pj.tagline === 'string' && pj.tagline.length > 120) report.error('project-json', `tagline is ${pj.tagline.length} chars (max 120)`, 'project.json');
    if (typeof pj.description === 'string' && pj.description.length > 800) report.warn('project-json', 'description is long (1 to 3 sentences expected)', 'project.json');
    if (reqTier !== undefined && pj.tier !== undefined && pj.tier !== reqTier) report.error('tier-mismatch', `project.json says tier ${pj.tier} but tier ${reqTier} was requested`, 'project.json');
    validateFingerprint(pj.fingerprint, taxonomy, report, effTier <= 2);
    if (pj.palette !== undefined) {
      if (!Array.isArray(pj.palette) || pj.palette.length < 2 || pj.palette.length > 8 || pj.palette.some((c) => typeof c !== 'string' || !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(c))) {
        report.error('project-json', 'palette must hold 2 to 8 hex colors like "#0b1020"', 'project.json');
      }
    } else report.warn('project-json', 'palette is missing', 'project.json');
    if (pj.entry !== undefined) {
      if (typeof pj.entry === 'string' && !pj.entry.startsWith('/') && !pj.entry.includes('..')) entryRel = pj.entry;
      else report.error('project-json', '"entry" must be a relative file path', 'project.json');
    }
    if (pj.thumb !== undefined) {
      if (typeof pj.thumb === 'string' && !pj.thumb.startsWith('/') && !pj.thumb.includes('..')) thumbRel = pj.thumb;
      else report.error('project-json', '"thumb" must be a relative file path', 'project.json');
    }
    if (pj.network === undefined) report.warn('project-json', '"network" is missing (treated as an empty list)', 'project.json');
    else if (!Array.isArray(pj.network)) report.error('project-json', '"network" must be an array of hostnames', 'project.json');
    else {
      for (const h of pj.network) {
        if (typeof h !== 'string' || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]*[a-z0-9]$/i.test(h) || /^\d+(?:\.\d+){3}$/.test(h)) {
          report.error('project-json', `network entry ${JSON.stringify(h)} must be a bare DNS hostname (no scheme, port, path or wildcard)`, 'project.json');
        } else declared.add(normHost(h));
      }
    }
    if (pj.sources !== undefined) {
      if (!Array.isArray(pj.sources) || pj.sources.some((s) => !s || typeof s.title !== 'string' || !/^https?:\/\//i.test(String(s.url ?? '')))) {
        report.error('project-json', 'sources must be [{title, url: http(s)://...}]', 'project.json');
      } else {
        if (!pj.sources.length && effTier <= 2) report.warn('project-json', 'no sources listed', 'project.json');
        for (const src of pj.sources) {
          const u = classifyUrl(src.url);
          const host = u.host ?? '';
          if (/(?:^|\.)example\.(?:com|org|net)$|(?:^|\.)(?:example|invalid|test|localhost)$/.test(host)) {
            if (effTier <= 2) report.error('placeholder-source', `source "${src.title.slice(0, 40)}" points at ${host}, a placeholder host`, 'project.json');
          } else if (SHORTENERS.has(host)) report.warn('source-shortener', `source ${host} is a link shortener; cite the real page`, 'project.json');
          else if (/^\d+(?:\.\d+){3}$|^\[/.test(host)) report.warn('source-ip', `source ${host} is an IP address, not a named site`, 'project.json');
          else if (u.scheme === 'http') report.warn('source-insecure', `source ${host} is linked over plain http`, 'project.json');
          if (effTier <= 2 && src.title.startsWith(TEMPLATE_TEXT.sourceTitle)) report.error('placeholder-text', 'a source still carries the template title', 'project.json');
        }
      }
    } else if (effTier <= 2) report.warn('project-json', 'sources is missing', 'project.json');
    if (typeof pj.makingOf !== 'string' || !pj.makingOf.trim()) {
      report.warn('project-json', 'makingOf is missing', 'project.json');
    }
    // Template leftovers matter for the builder-made tiers; tiers 3 and 4 are generated by scripts, never from the templates.
    if (effTier <= 2) {
      for (const [k, marker] of [['tagline', TEMPLATE_TEXT.tagline], ['description', TEMPLATE_TEXT.description], ['makingOf', TEMPLATE_TEXT.makingOf], ['intro', TEMPLATE_TEXT.intro]]) {
        if (typeof pj[k] === 'string' && pj[k].includes(marker)) report.error('placeholder-text', `${k} is still the text from project.json.example`, 'project.json');
      }
      if (pj.title === 'Example Project' || pj.slug === 'example-project') report.error('placeholder-text', 'title or slug is still the example value', 'project.json');
      if (Array.isArray(pj.fingerprint?.tags) && pj.fingerprint.tags.length && pj.fingerprint.tags.every((t) => ['example', 'template', 'starter'].includes(t))) {
        report.error('placeholder-text', 'fingerprint tags are still the template tags', 'project.json');
      }
    }
    if (now !== undefined && typeof pj.date === 'string') {
      try {
        const today = localParts(now instanceof Date ? now : new Date(now), cfg.timezone).date;
        if (pj.date > today) report.warn('project-date', `project date ${pj.date} is in the future (today is ${today})`, 'project.json');
      } catch { /* ignore a bad now */ }
    }
  }

  // entry and thumb
  if (!fileSet.has(entryRel)) report.error('missing-entry', `entry file ${entryRel} does not exist`, entryRel);
  if (!fileSet.has(thumbRel)) report.error('missing-thumb', `thumbnail ${thumbRel} does not exist`, thumbRel);
  else checkPng(fs.readFileSync(path.join(root, thumbRel)), report, thumbRel, limits);

  // sizes and file census
  let totalBytes = 0;
  const textFiles = [];
  const mediaAssets = [];
  for (const rel of relFiles) {
    const abs = path.join(root, rel);
    const st = fs.statSync(abs);
    totalBytes += st.size;
    const ext = path.extname(rel).toLowerCase();
    if (st.size > limits.singleFileMaxBytes) report.error('file-too-large', `${rel} is ${st.size} bytes (max ${limits.singleFileMaxBytes})`, rel);
    if (NATIVE_EXT.has(ext)) report.error('forbidden-file', `${rel}: executable and server-side file types are not allowed`, rel);
    else if (SCRIPT_EXT.has(ext)) report.warn('forbidden-file', `${rel}: script files have no place on a static site`, rel);
    if (MEDIA_EXT.has(ext) && rel !== thumbRel) mediaAssets.push(rel);
    if (BINARY_EXT.has(ext) || NATIVE_EXT.has(ext)) {
      if (st.size >= 4) {
        const fd = fs.openSync(abs, 'r');
        const head = Buffer.alloc(4);
        fs.readSync(fd, head, 0, 4, 0);
        fs.closeSync(fd);
        if (head.toString('latin1') === '\x7fELF' || head.toString('latin1', 0, 2) === 'MZ') report.error('native-binary', `${rel} is a native executable`, rel);
      }
      continue;
    }
    if (TEXT_EXT.has(ext)) textFiles.push(rel);
    else {
      const fd = fs.openSync(abs, 'r');
      const head = Buffer.alloc(Math.min(8192, st.size));
      fs.readSync(fd, head, 0, head.length, 0);
      fs.closeSync(fd);
      if (!head.includes(0)) textFiles.push(rel);
    }
  }
  stats.bytes = totalBytes;
  if (relFiles.length > limits.projectMaxFiles) report.error('too-many-files', `${relFiles.length} files (max ${limits.projectMaxFiles})`);
  if (totalBytes > limits.projectMaxBytes) report.error('project-too-large', `${totalBytes} bytes (max ${limits.projectMaxBytes})`);

  // per-file scanning
  const pendingChecks = [];
  let tmpDir = null;
  let nextTmp = 0;
  const tmpFile = (content) => {
    tmpDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'sed-validate-'));
    const file = path.join(tmpDir, `${nextTmp++}.mjs`);
    fs.writeFileSync(file, content);
    return file;
  };
  let ownLoc = 0;
  const acc = { text: [], script: [], links: [], placeholders: [] };
  let entryInfo = null;
  let entrySrc = null;
  const pageInfos = [];

  for (const rel of textFiles) {
    const abs = path.join(root, rel);
    const ext = path.extname(rel).toLowerCase();
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8').replace(/^\ufeff/, '');
    } catch (err) {
      report.error('unreadable', `${rel}: ${err.message}`, rel);
      continue;
    }
    const lineOf = makeLineIndex(text);
    const fileDir = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
    const vendor = /vendor/i.test(rel);

    for (const [re, label] of SECRET_PATTERNS) {
      const m = re.exec(text);
      if (m) {
        report.error('secret', `${rel} contains what looks like a ${label}`, rel, lineOf(m.index));
        break;
      }
    }
    if (GUARDRAIL_RE.test(text)) report.warn('guardrail-language', `${rel} contains language that needs a human look`, rel);
    if (GAMBLING_RE.test(text)) guard('guardrail-gambling', `${rel} mentions real-money gambling mechanics`, rel);
    if ((ext === '.js' || ext === '.mjs' || ext === '.cjs') && !vendor) acc.script.push(text);

    let commentRanges = [];
    try {
      const S = {
        report,
        rel,
        lineOf,
        base: 0,
        vendor,
        declared,
        files: fileSet,
        acc,
        slug: dm?.[2] ?? (typeof pj?.slug === 'string' ? pj.slug : ''),
        fragment: false,
        dir: fileDir,
        url: null,
      };
      S.url = makeUrlJudge(S);

      if (HTML_EXT.has(ext)) {
        const isEntry = rel === entryRel;
        const info = scanMarkup(text, S, { dir: fileDir });
        commentRanges = info.commentRanges;
        pageInfos.push({ rel, info, isEntry });
        if (isEntry) {
          entryInfo = info;
          entrySrc = text;
        }
        for (const m of info.inlineModules) pendingChecks.push({ rel, line: m.line, file: tmpFile(m.code) });
      } else if (ext === '.css') {
        commentRanges = scanCss(text, S, { dir: fileDir }).comments;
      } else if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
        const { tokens, comments } = scanJs(text, S, { dir: fileDir });
        commentRanges = comments;
        const isModule = ext === '.mjs' || hasModuleSyntax(tokens);
        if (isModule) {
          pendingChecks.push({ rel, file: ext === '.mjs' ? abs : tmpFile(text) });
        } else {
          try {
            new vm.Script(text, { filename: rel });
          } catch (err) {
            pendingChecks.push({ rel, file: tmpFile(text), fallbackMessage: String(err.message).split('\n')[0] });
          }
        }
      } else if (ext === '.json' || ext === '.webmanifest' || ext === '.geojson' || ext === '.topojson') {
        try {
          JSON.parse(text);
        } catch (err) {
          report.error('json-parse', `${rel} is not valid JSON: ${err.message}`, rel);
        }
      }
    } catch (err) {
      // Unscanned content must not ship, so a scanner failure is an error, never a silent pass.
      report.error('scan-failed', `could not analyse ${rel}: ${err.message}`, rel);
      continue;
    }
    if ((ext === '.html' || ext === '.htm' || ext === '.xhtml' || ext === '.css' || ext === '.js' || ext === '.mjs') && !(`/${rel}`.includes('/data/') || rel.includes('vendor'))) {
      ownLoc += countLoc(text, commentRanges);
    }
  }
  stats.ownLoc = ownLoc;

  // structure of the entry page and CSP
  for (const { rel, info, isEntry } of pageInfos) {
    const csps = info.csp;
    let cspGood = false;
    for (const c of csps) {
      const res = checkCsp(c.content, declared);
      if (!c.inHead) res.errors.push(['csp-not-in-head', 'the CSP <meta> must be a child of <head> (before <body> and any visible content)']);
      for (const [code, msg] of res.errors) report.error(code, msg, rel, c.line);
      for (const [code, msg] of res.warnings) report.warn(code, msg, rel, c.line);
      if (!res.errors.length) cspGood = true;
    }
    if (!csps.length) {
      if (isEntry) report.error('csp-missing', 'no <meta http-equiv="Content-Security-Policy"> (start from ops/templates/page-shell.html)', rel);
      else if (rel.endsWith('.html') || rel.endsWith('.htm')) report.warn('csp-missing', 'page has no Content-Security-Policy meta', rel);
    } else if (info.earlyLoader && cspGood) {
      report.error('csp-late', `<${info.earlyLoader.name}> appears before the CSP <meta>, so it is not covered by the policy`, rel, info.earlyLoader.line);
    }
    if (!isEntry) continue;
    if (!info.lang) report.error('html-lang', '<html> needs a lang attribute', rel);
    if (!info.title) report.error('html-title', 'page needs a non-empty <title>', rel);
    if (!info.viewport) report.error('html-viewport', 'missing <meta name="viewport" content="width=device-width, ...">', rel);
    if (!info.backLink) report.error('gallery-link', 'missing a relative link back to the gallery (href="../../")', rel);
  }
  if (fileSet.has(entryRel) && !entryInfo && !HTML_EXT.has(path.extname(entryRel).toLowerCase())) {
    report.error('entry-type', `entry ${entryRel} is not an HTML file`, entryRel);
  }

  // template leftovers: only browser-check used to notice these, and QA may be skipped (no browser, timeout)
  if (effTier <= 2 && acc.placeholders.length) {
    report.error('shell-placeholder', `${acc.placeholders.length} element(s) still carry data-sed-placeholder (first: ${acc.placeholders[0]}); replace or delete the shell's placeholder content`);
  }
  if (effTier <= 2 && entryInfo?.title === TEMPLATE_TEXT.pageTitle) report.error('placeholder-text', `<title> is still "${TEMPLATE_TEXT.pageTitle}"`, entryRel);
  if (effTier <= 2 && entryInfo?.description === TEMPLATE_TEXT.pageDescription) report.error('placeholder-text', 'meta description is still the page-shell text', entryRel);

  // the page contract (DESIGN 7.3): purpose, intro, explainer; tiers 1 and 2 only, required from pageContract.requiredFrom or with --contract
  if (effTier <= 2 && pj && typeof pj === 'object' && !Array.isArray(pj)) {
    const req = contractRequired({ contract, date: pj.date, tier: effTier, force: forceContract === true });
    checkPageContract({ report, pj, contract, req, entrySrc: entryInfo ? entrySrc : null, entryTokens: entryInfo?.tokens, entryRel, purposes });
  }

  // content guardrails (config.guardrails.forbidden), cheap and mechanical; a human still reads the tier-1 pages
  const sourceHosts = new Set([...declared, ...(Array.isArray(pj?.sources) ? pj.sources.map((x) => classifyUrl(String(x?.url ?? '')).host).filter(Boolean) : [])]);
  const extraHosts = Array.isArray(cfg.guardrails?.linkAllowlist) ? cfg.guardrails.linkAllowlist.map(normHost) : [];
  const linkHostOk = (h) => [...sourceHosts, ...extraHosts].some((a) => h === a || h.endsWith(`.${a}`) || a.endsWith(`.${h}`));
  const seenLinkHosts = new Set();
  let blankNoRel = null;
  for (const l of acc.links) {
    if (!seenLinkHosts.has(l.host)) {
      seenLinkHosts.add(l.host);
      if (!linkHostOk(l.host)) guard('external-link-undeclared', `link to ${l.host || '(empty host)'} is not one of the project's sources (list it in project.json "sources" or remove the link)`, l.file, l.line);
    }
    if (l.target === '_blank' && !/\bno(?:opener|referrer)\b/.test(l.rel)) blankNoRel ??= l;
  }
  if (blankNoRel) report.warn('external-link-rel', 'links opening a new tab should carry rel="noopener noreferrer"', blankNoRel.file, blankNoRel.line);

  const prose = [...acc.text, ...acc.script, ...['title', 'tagline', 'description', 'makingOf'].map((k) => (typeof pj?.[k] === 'string' ? pj[k] : ''))].join('\n');
  if (PHISHING_RES.some((re) => re.test(prose))) guard('phishing-language', 'page text asks visitors to sign in, verify an account or hand over payment or identity details', entryRel);
  const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const extraBrands = Array.isArray(cfg.guardrails?.brandDenylist) ? cfg.guardrails.brandDenylist.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().toLowerCase()) : [];
  const strictBrands = [...BRANDS_STRICT, ...extraBrands];
  const brandRe = (list) => `\\b(?:${list.map(escapeRe).join('|')})\\b`;
  const claim = '(?:official|authori[sz]ed|certified|verified|endorsed|sponsored by|partner(?:ed)? (?:with|of))';
  const allBrands = brandRe([...strictBrands, ...BRANDS_IMPERSONATION_ONLY]);
  if (new RegExp(`${claim}\\b[^.\\n]{0,30}${allBrands}|${allBrands}[^.\\n]{0,30}\\b${claim}`, 'i').test(prose)) {
    guard('brand-impersonation', 'page presents itself as official or endorsed by a real brand; parody must be obviously labeled and use no real branding', entryRel);
  }
  const named = [...new Set([...prose.matchAll(new RegExp(brandRe(strictBrands), 'gi'))].map((m) => m[0].toLowerCase()))];
  if (named.length) report.warn('brand-name', `page text names real brands (${named.slice(0, 5).join(', ')}); the guardrails ask for no real branding`, entryRel);
  if (ADVICE_RE.test(prose) && !NOT_ADVICE_RE.test(prose)) report.warn('advice-claim', 'page text sounds like medical, legal or financial advice without a "not advice" disclaimer', entryRel);
  if (pj?.fingerprint && pj.fingerprint.political !== true && effTier <= 2) {
    const terms = new Set([...prose.matchAll(POLITICAL_TERMS)].map((m) => m[0].toLowerCase()));
    if (terms.size >= 2) report.error('politics-undeclared', `page text is about politics (${[...terms].slice(0, 4).join(', ')}) but fingerprint.political is not true, so the politics cap cannot see it`, 'project.json');
    else if (terms.size === 1) report.warn('politics-undeclared', `page text mentions "${[...terms][0]}" while fingerprint.political is not true`, 'project.json');
  }
  if (mediaAssets.length) {
    const licensed = new Set(Array.isArray(pj?.licenses) ? pj.licenses.map((x) => String(x?.file ?? '')) : []);
    const missing = mediaAssets.filter((f) => !licensed.has(f));
    if (missing.length) {
      report.warn('unlicensed-asset', `${missing.length} bundled font/audio/image file(s) have no project.json "licenses" entry (${missing.slice(0, 4).join(', ')}); guardrails allow only freely licensed or self-made media`, missing[0]);
    }
  }

  // syntax checks (parallel, bounded)
  let nextIdx = 0;
  const worker = async () => {
    while (nextIdx < pendingChecks.length) {
      const job = pendingChecks[nextIdx++];
      const msg = await nodeCheck(job.file);
      if (msg) report.error('js-syntax', job.fallbackMessage ?? msg.replace(job.file, job.rel), job.rel, job.line);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(6, pendingChecks.length) }, worker));
  } finally {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // own lines of code
  if (effTier <= 2) {
    const min = effTier === 1 ? limits.minOwnLinesOfCodeTier1 : limits.minOwnLinesOfCodeTier2;
    if (ownLoc < min) {
      const msg = `only ${ownLoc} own lines of code (tier ${effTier} needs ${min})`;
      if (ownLoc >= min * 0.7) report.warn('own-loc', msg);
      else report.error('own-loc', msg);
    }
  }
  return done();
}

/** Builds the URL judge shared by HTML, CSS and JS scanners; applies the declared-network rules. */
function makeUrlJudge(S) {
  const { report, rel, declared } = S;
  return function judge(u, { code, role, line, dir, what, resource }) {
    const where = what ?? 'URL';
    switch (u.kind) {
      case 'javascript':
        report.error('javascript-url', `${where} is a ${u.value.split(':')[0].toLowerCase()}: URL`, rel, line);
        return;
      case 'external': {
        const host = u.host || '(empty host)';
        if (role === 'nav') {
          if (code === 'navigation-external') report.error('navigation-external', `${where} navigates to ${host}; pages must not send visitors elsewhere on their own (use a plain link)`, rel, line);
          return;
        }
        if (role === 'code') {
          report.error(code ?? 'external-code', `${where} loads code or markup from ${host}; remote code is never allowed`, rel, line);
          return;
        }
        if (role === 'data') {
          if (!declared.has(host)) report.error(code ?? 'external-fetch', `${where} contacts ${host}, which is not listed in project.json "network"`, rel, line);
          return;
        }
        if (!declared.has(host)) report.error(code ?? 'external-resource', `${where} loads ${host}, which is not listed in project.json "network"`, rel, line);
        else report.warn('declared-resource-blocked', `${where} loads declared host ${host} but the CSP only allows it for connect-src`, rel, line);
        return;
      }
      case 'data':
        if (role === 'code') report.error('data-url-code', `${where} uses a data: URL for code or a document`, rel, line);
        return;
      case 'other':
        if (role !== 'nav' && resource) report.warn('odd-scheme', `${where} uses the ${u.scheme}: scheme`, rel, line);
        return;
      case 'relative': {
        if (!resource) return;
        const r = resolveInProject(dir ?? S.dir, u.value);
        if (!r) return;
        const critical = role === 'code';
        if (r.escapes) {
          report.error('escapes-project', `${where} "${u.value}" leaves the project directory`, rel, line);
        } else if (r.rootAbsolute) {
          (critical ? report.error : report.warn).call(report, 'root-absolute-path', `${where} "${u.value}" is root-absolute and will not resolve on a project page`, rel, line);
        } else if (S.files && !S.files.has(r.path)) {
          (critical ? report.error : report.warn).call(report, 'missing-resource', `${where} "${u.value}" does not exist in the project`, rel, line);
        }
        return;
      }
      default:
    }
  };
}

/* ------------------------------------------------------------------------------------------------
 * Repo validation
 * ---------------------------------------------------------------------------------------------- */

function tryParse(file, report, code, { required = true } = {}) {
  if (!fs.existsSync(file)) {
    if (required) report.error(code, `${path.relative(repoRoot(), file)} is missing`, path.relative(repoRoot(), file));
    return undefined;
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\ufeff/, ''));
  } catch (err) {
    report.error(code, `${path.relative(repoRoot(), file)} does not parse: ${err.message}`, path.relative(repoRoot(), file));
    return undefined;
  }
}

function walkAll(root, onFile) {
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) onFile(p);
    }
  }
}

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/* ------------------------------------------------------------------------------------------------
 * Culture layer (CONTRACT 12.11): kaizen config, ledger, queue, protected-block markers, doc caps
 * ---------------------------------------------------------------------------------------------- */

const KAIZEN_STATUSES = new Set(['applied', 'rejected', 'proposed', 'reverted']);
const KAIZEN_REQUIRED_PROTECTED = ['config.json', '.github/', 'ops/prompts/', 'scripts/validate.mjs', 'scripts/kaizen.mjs'];
// Same line grammar as scripts/kaizen.mjs: a marker is a whole line, so prose that mentions one inline is not a marker.
const MARKER_BEGIN = /^\s*(?:<!--\s*protected:begin\b.*?-->|\/\/\s*protected:begin\b.*)\s*$/;
const MARKER_END = /^\s*(?:<!--\s*protected:end\b.*?-->|\/\/\s*protected:end\b.*)\s*$/;
const MARKER_EXT = new Set(['.md', '.js', '.mjs', '.cjs', '.html', '.htm', '.css', '.json', '.yml', '.yaml', '.txt']);
const MARKER_SKIP_TOP = new Set(['docs', 'work', 'state']);
const MARKER_MAX_BYTES = 2 * 1024 * 1024;

const isStringList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim() !== '');
const isPositiveInt = (v) => Number.isInteger(v) && v > 0;

/** A configured repo-relative path: no absolute forms, backslashes, control characters or `..` segments. */
function badRepoPath(p) {
  if (/[\\\0-\x1f]/.test(p)) return 'contains a backslash or control character';
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.startsWith('~')) return 'is absolute';
  if (p.split('/').includes('..')) return 'contains ".."';
  return null;
}

function checkKaizenConfig(report, cfg) {
  const f = 'config.json';
  const k = cfg.kaizen;
  const bad = (msg) => report.error('config-kaizen', msg, f);
  if (!k || typeof k !== 'object' || Array.isArray(k)) {
    bad('kaizen must be an object');
    return null;
  }
  if (typeof k.enabled !== 'boolean') bad('kaizen.enabled must be a boolean');
  if (!isStringList(k.members) || k.members.length === 0) bad('kaizen.members must be a non-empty array of names');
  else {
    if (new Set(k.members).size !== k.members.length) bad('kaizen.members has duplicates');
    for (const m of k.members) if (cfg.roster && !Object.hasOwn(cfg.roster, m)) report.warn('config-kaizen', `kaizen member "${m}" is not in the roster`, f);
  }
  for (const key of ['maxChangedLines', 'maxFiles', 'minTokensToStart', 'revertWindowDays']) {
    if (!isPositiveInt(k[key])) bad(`kaizen.${key} must be a positive integer`);
  }
  for (const key of ['allowedPaths', 'protectedPaths']) {
    if (!isStringList(k[key]) || (key === 'allowedPaths' && k[key].length === 0)) {
      bad(`kaizen.${key} must be ${key === 'allowedPaths' ? 'a non-empty ' : 'an '}array of path strings`);
      continue;
    }
    for (const p of k[key]) {
      const why = badRepoPath(p);
      if (why) bad(`kaizen.${key} entry ${JSON.stringify(p)} ${why}`);
    }
  }
  if (isStringList(k.protectedPaths)) {
    for (const need of KAIZEN_REQUIRED_PROTECTED) {
      if (!k.protectedPaths.includes(need)) bad(`kaizen.protectedPaths must include ${need}`);
    }
  }
  if (isStringList(k.allowedPaths) && isStringList(k.protectedPaths)) {
    const covers = (outer, inner) => outer === inner || (outer.endsWith('/') && inner.startsWith(outer));
    for (const a of k.allowedPaths) {
      if (k.protectedPaths.some((p) => covers(p, a))) report.warn('config-kaizen', `kaizen.allowedPaths entry ${JSON.stringify(a)} lies inside a protected path and can never be used`, f);
    }
  }
  const caps = k.docLineCaps;
  if (caps === undefined) return k;
  if (!caps || typeof caps !== 'object' || Array.isArray(caps)) {
    bad('kaizen.docLineCaps must map file paths to positive integers');
    return k;
  }
  for (const [p, n] of Object.entries(caps)) {
    const why = badRepoPath(p);
    if (why) bad(`kaizen.docLineCaps key ${JSON.stringify(p)} ${why}`);
    if (!isPositiveInt(n)) bad(`kaizen.docLineCaps[${JSON.stringify(p)}] must be a positive integer`);
  }
  return k;
}

function checkDocLineCaps(report, k) {
  const caps = k?.docLineCaps;
  if (!caps || typeof caps !== 'object' || Array.isArray(caps)) return;
  for (const [rel, cap] of Object.entries(caps)) {
    if (!isPositiveInt(cap) || badRepoPath(rel)) continue;
    let buf;
    try {
      buf = fs.readFileSync(rp(...rel.split('/')));
    } catch {
      report.warn('doc-line-cap', `${rel} is capped at ${cap} lines but cannot be read`, rel);
      continue;
    }
    let lines = 0;
    for (const b of buf) if (b === 10) lines++;
    if (buf.length > 0 && buf[buf.length - 1] !== 10) lines++;
    if (lines > cap) report.error('doc-line-cap', `${rel} has ${lines} lines, over its ${cap}-line cap (condense it)`, rel);
  }
}

function checkKaizenLedger(report, members) {
  const idxRel = 'ops/kaizen/INDEX.json';
  const logRel = 'ops/kaizen/LOG.md';
  const index = tryParse(rp('ops', 'kaizen', 'INDEX.json'), report, 'kaizen-index');
  let log = null;
  try {
    log = fs.readFileSync(rp('ops', 'kaizen', 'LOG.md'), 'utf8');
  } catch {
    report.error('kaizen-log', `${logRel} is missing`, logRel);
  }
  if (!index) return;
  if (index.schema !== 1) report.error('kaizen-index', 'schema must be 1', idxRel);
  if (!Array.isArray(index.entries)) {
    report.error('kaizen-index', 'entries must be an array', idxRel);
    return;
  }
  const ids = new Set();
  index.entries.forEach((e, i) => {
    const bad = (msg) => report.error('kaizen-index', `entry ${i}${e && e.id ? ` (${e.id})` : ''}: ${msg}`, idxRel);
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      bad('is not an object');
      return;
    }
    if (typeof e.id !== 'string' || !e.id) bad('id must be a non-empty string');
    else if (ids.has(e.id)) bad('duplicate id');
    else ids.add(e.id);
    if (!DATE.test(String(e.date))) bad('date must be YYYY-MM-DD');
    if (typeof e.agent !== 'string' || !e.agent) bad('agent must be a non-empty string');
    else if (members && !members.includes(e.agent)) report.warn('kaizen-index', `entry ${e.id}: agent "${e.agent}" is not a current kaizen member`, idxRel);
    if (typeof e.id === 'string' && e.id && DATE.test(String(e.date)) && typeof e.agent === 'string' && e.id !== `${e.date}-${e.agent}`) {
      report.warn('kaizen-index', `entry ${e.id}: id should be ${e.date}-${e.agent}`, idxRel);
    }
    for (const key of ['title', 'observation', 'category']) if (typeof e[key] !== 'string' || !e[key].trim()) bad(`${key} must be a non-empty string`);
    if (!KAIZEN_STATUSES.has(e.status)) bad(`status must be one of ${[...KAIZEN_STATUSES].join('|')}`);
    if (!isStringList(e.files)) bad('files must be an array of paths');
    else for (const p of e.files) if (badRepoPath(p)) bad(`file ${JSON.stringify(p)} ${badRepoPath(p)}`);
    if (!Number.isInteger(e.linesChanged) || e.linesChanged < 0) bad('linesChanged must be a non-negative integer');
    if (e.sha !== null && e.sha !== undefined && !(typeof e.sha === 'string' && /^[0-9a-f]{7,64}$/i.test(e.sha))) bad('sha must be a commit hash or null');
    if (e.question !== null && e.question !== undefined && typeof e.question !== 'string') bad('question must be a string or null');
    if (e.reason !== null && e.reason !== undefined && typeof e.reason !== 'string') bad('reason must be a string or null');
    if (e.status === 'applied' && Array.isArray(e.files) && e.files.length === 0) report.warn('kaizen-index', `entry ${e.id}: applied but lists no files`, idxRel);
  });
  if (log === null) return;
  const headings = log.split('\n').filter((l) => l.startsWith('## '));
  for (const e of index.entries) {
    if (!e || e.status !== 'applied' || typeof e.title !== 'string') continue;
    if (!headings.some((h) => h.includes(String(e.date)) && h.includes(String(e.agent)) && h.includes(e.title))) {
      report.error('kaizen-log', `applied kaizen ${e.id} ("${e.title}") is missing from ${logRel}; the log is written only by scripts/kaizen.mjs`, logRel);
    }
  }
}

function checkKaizenQueue(report, members) {
  const rel = 'state/kaizen-queue.json';
  if (!fs.existsSync(rp('state', 'kaizen-queue.json'))) {
    report.warn('kaizen-queue', `${rel} is missing (it is created the first time a member is skipped)`, rel);
    return;
  }
  const q = tryParse(rp('state', 'kaizen-queue.json'), report, 'kaizen-queue');
  if (!q) return;
  if (q.schema !== 1) report.error('kaizen-queue', 'schema must be 1', rel);
  if (!isStringList(q.skipped)) {
    report.error('kaizen-queue', 'skipped must be an array of member names', rel);
    return;
  }
  if (new Set(q.skipped).size !== q.skipped.length) report.warn('kaizen-queue', 'skipped has duplicates', rel);
  if (members) for (const m of q.skipped) if (!members.includes(m)) report.warn('kaizen-queue', `skipped member "${m}" is not a current kaizen member`, rel);
}

/** Tracked (and not-yet-committed) files when `root` is a git work tree, else a plain walk. Runtime output dirs are excluded. */
function markerCandidates(root) {
  let rels = null;
  try {
    const run = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 20000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    if (fs.realpathSync(run('rev-parse', '--show-toplevel').trim()) === fs.realpathSync(root)) {
      rels = run('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean);
    }
  } catch { /* not a repo, or git is unavailable */ }
  if (!rels) {
    rels = [];
    walkAll(root, (p) => rels.push(path.relative(root, p).split(path.sep).join('/')));
  }
  return rels.filter((rel) => !MARKER_SKIP_TOP.has(rel.split('/')[0]) && MARKER_EXT.has(path.extname(rel).toLowerCase()));
}

function checkProtectedMarkers(report, root) {
  for (const rel of markerCandidates(root)) {
    let text;
    try {
      const abs = path.join(root, ...rel.split('/'));
      const st = fs.lstatSync(abs);
      if (!st.isFile() || st.size > MARKER_MAX_BYTES) continue;
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (!text.includes('protected:')) continue;
    let open = 0;
    text.split('\n').forEach((line, i) => {
      if (MARKER_BEGIN.test(line)) {
        if (open) report.error('protected-markers', 'nested protected:begin (blocks cannot nest)', rel, i + 1);
        else open = i + 1;
      } else if (MARKER_END.test(line)) {
        if (!open) report.error('protected-markers', 'protected:end without a matching protected:begin', rel, i + 1);
        else open = 0;
      }
    });
    if (open) report.error('protected-markers', 'protected:begin is never closed', rel, open);
  }
}

function checkCulture(report, cfg, root) {
  const k = cfg ? checkKaizenConfig(report, cfg) : null;
  const members = isStringList(k?.members) ? k.members : null;
  if (k?.enabled !== false) {
    checkKaizenLedger(report, members);
    checkKaizenQueue(report, members);
  }
  checkDocLineCaps(report, k);
  checkProtectedMarkers(report, root);
}

/** Run async jobs with a small concurrency cap; results keep input order. */
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * budget.ownerOverride (the owner lifting the budget until a time: the throttle ignores a malformed one, so say so here) and
 * phaseBudgetMinutes (minutes a phase may take, keyed by the fixed phase names). Both are optional.
 */
function checkBudgetKeys(report, cfg, f) {
  for (const problem of ownerOverrideProblems(cfg)) report.error('config', problem, f);
  const minutes = cfg.phaseBudgetMinutes;
  if (minutes === undefined) return;
  if (minutes === null || typeof minutes !== 'object' || Array.isArray(minutes)) {
    report.error('config', 'phaseBudgetMinutes must be an object of phase name -> positive number of minutes', f);
    return;
  }
  for (const [phase, value] of Object.entries(minutes)) {
    if (!PHASES.includes(phase)) report.error('config', `phaseBudgetMinutes.${phase} is not a phase (${PHASES.join(', ')})`, f);
    if (!(typeof value === 'number' && Number.isFinite(value) && value > 0)) report.error('config', `phaseBudgetMinutes.${phase} must be a positive number of minutes`, f);
  }
}

/**
 * config.revisePolicy and budget.levels.<level>.reviseLoopsTier2: the revise policy of a compact day (scripts/lib/revisepolicy.mjs,
 * PLAYBOOK 8.6). Both are optional (a config without them keeps the old rescue-only rule); a damaged value is an error because the
 * policy would silently fall back to its default.
 */
function checkReviseKeys(report, cfg, f) {
  const { errors, warnings } = revisePolicyProblems(cfg);
  for (const problem of errors) report.error('config', problem, f);
  for (const problem of warnings) report.warn('config', problem, f);
}

/**
 * The purpose mix and the page contract (DESIGN 2): config.mix.purposes, config.pageContract and taxonomy.purposes.
 * A missing block is a warning (readers treat it as "no plan" / "no requirement"); a damaged value is an error,
 * because the readers would silently fall back to a default.
 */
function checkPurposeKeys(report, cfg, taxonomy, f) {
  const tf = 'ops/taxonomy.json';
  const purposes = Object.keys(plainObj(taxonomy?.purposes));
  if (taxonomy && !purposes.length) report.warn('taxonomy', 'taxonomy.purposes is missing: no purpose vocabulary, so the purpose plan and the page contract cannot name a purpose', tf);
  else if (taxonomy && !purposes.includes('play')) report.error('taxonomy', 'taxonomy.purposes must contain "play" (a reserved key: the purpose plan special-cases it)', tf);
  const vocab = purposes.length ? purposes : PURPOSES;

  const mp = cfg.mix?.purposes;
  if (mp === undefined) report.warn('config', 'mix.purposes is missing: no purpose plan (old lens counts, no wanted or avoided purpose)', f);
  else if (!mp || typeof mp !== 'object' || Array.isArray(mp)) report.error('config', 'mix.purposes must be an object', f);
  else {
    for (const k of ['windowDays', 'cooldownDays', 'playCooldownDays', 'maxPlayPer7Days', 'wantedCount', 'wantedBonus', 'starvedDays']) {
      if (mp[k] !== undefined && !posNum(mp[k])) report.error('config', `mix.purposes.${k} must be a positive number`, f);
    }
    if (mp.wantedCount !== undefined && mp.wantedCount !== 1 && mp.wantedCount !== 2) report.error('config', 'mix.purposes.wantedCount must be 1 or 2', f);
    if (mp.quota !== undefined) {
      if (!mp.quota || typeof mp.quota !== 'object' || Array.isArray(mp.quota)) report.error('config', 'mix.purposes.quota must be an object of purpose: positive number', f);
      else for (const [p, q] of Object.entries(mp.quota)) if (!vocab.includes(p) || !posNum(q)) report.error('config', `mix.purposes.quota.${p} must be a positive number for a purpose (${vocab.join(', ')})`, f);
    }
    if (mp.legacyDefault !== undefined && !vocab.includes(mp.legacyDefault)) report.error('config', `mix.purposes.legacyDefault ${JSON.stringify(mp.legacyDefault)} is not a purpose (${vocab.join(', ')})`, f);
  }
  if (cfg.ideation?.shortlistMinWanted !== undefined && !(Number.isInteger(cfg.ideation.shortlistMinWanted) && cfg.ideation.shortlistMinWanted >= 0)) {
    report.error('config', 'ideation.shortlistMinWanted must be a non-negative integer', f);
  }

  const pc = cfg.pageContract;
  if (pc === undefined) {
    report.warn('config', 'pageContract is missing: no purpose, intro or explainer requirement anywhere', f);
    return;
  }
  if (!pc || typeof pc !== 'object' || Array.isArray(pc)) {
    report.error('config', 'pageContract must be an object', f);
    return;
  }
  if (pc.requiredFrom !== null && pc.requiredFrom !== undefined && !isDay(pc.requiredFrom)) report.error('config', `pageContract.requiredFrom must be null or a date YYYY-MM-DD (got ${JSON.stringify(pc.requiredFrom)})`, f);
  const positive = (pathName, v) => {
    if (v !== undefined && !posNum(v)) report.error('config', `pageContract.${pathName} must be a positive number`, f);
  };
  const intro = plainObj(pc.intro);
  for (const k of ['minWords', 'maxWords', 'firstSentenceMaxWords']) positive(`intro.${k}`, intro[k]);
  if (posNum(intro.minWords) && posNum(intro.maxWords) && intro.minWords > intro.maxWords) report.error('config', 'pageContract.intro.minWords is above maxWords', f);
  for (const key of ['minWords', 'minHeadings']) {
    const table = pc.explainer?.[key];
    if (table === undefined) continue;
    if (!table || typeof table !== 'object' || Array.isArray(table)) {
      report.error('config', `pageContract.explainer.${key} must map purposes to positive numbers`, f);
      continue;
    }
    for (const [p, v] of Object.entries(table)) {
      if (!vocab.includes(p)) report.error('config', `pageContract.explainer.${key}.${p}: "${p}" is not a purpose (${vocab.join(', ')})`, f);
      positive(`explainer.${key}.${p}`, v);
    }
    for (const p of vocab) if (!Object.hasOwn(table, p)) report.warn('config', `pageContract.explainer.${key} has no "${p}" (the validator uses its default)`, f);
  }
  positive('lessonMinChecks', pc.lessonMinChecks);
  positive('toolMinSelfTests', pc.toolMinSelfTests);
  for (const k of ['desktop', 'mobile']) positive(`introMaxBottomPx.${k}`, pc.introMaxBottomPx?.[k]);
  for (const k of ['warn', 'error']) positive(`firstScreenControls.${k}`, pc.firstScreenControls?.[k]);
  const fsc = plainObj(pc.firstScreenControls);
  if (posNum(fsc.warn) && posNum(fsc.error) && fsc.warn > fsc.error) report.error('config', 'pageContract.firstScreenControls.warn is above error', f);
}

// The lens kinds every day needs: scripts/lenses.mjs is the authority (its MAIN_KINDS literal); this list is the fallback.
const LENS_MAIN_KINDS = ['interest', 'current', 'humor', 'wildcard', 'useful', 'teach'];
const LENS_MIN_PER_KIND = 3;

function lensMainKinds(declared) {
  try {
    const src = fs.readFileSync(new URL('./lenses.mjs', import.meta.url), 'utf8');
    const m = /\bMAIN_KINDS\s*=\s*(?:Object\.freeze\(\s*)?\[([^\]]*)\]/.exec(src);
    const kinds = m ? [...m[1].matchAll(/'([\w-]+)'|"([\w-]+)"/g)].map((x) => x[1] ?? x[2]) : [];
    if (kinds.length) return kinds;
  } catch { /* fall back */ }
  return LENS_MAIN_KINDS.filter((k) => declared.includes(k));
}

/** ops/lenses.json must hold at least LENS_MIN_PER_KIND lenses of every main kind, or preflight's lens draw breaks. */
function checkLensPool(report) {
  const rel = 'ops/lenses.json';
  if (!fs.existsSync(rp('ops', 'lenses.json'))) {
    report.warn('lenses', `${rel} is missing`, rel);
    return;
  }
  const pool = tryParse(rp('ops', 'lenses.json'), report, 'lenses');
  if (pool === undefined) return;
  if (!Array.isArray(pool?.lenses)) {
    report.error('lenses', `${rel} must be {kinds, lenses: [...]}`, rel);
    return;
  }
  const counts = {};
  for (const l of pool.lenses) if (l && typeof l.kind === 'string') counts[l.kind] = (counts[l.kind] ?? 0) + 1;
  for (const k of lensMainKinds(Object.keys(plainObj(pool.kinds)))) {
    const n = counts[k] ?? 0;
    if (n < LENS_MIN_PER_KIND) report.error('lenses', `${rel} has ${n} lens${n === 1 ? '' : 'es'} of kind "${k}"; every main kind needs at least ${LENS_MIN_PER_KIND} (scripts/lenses.mjs draws each main kind every day)`, rel);
  }
}

// `projects` defaults to true: whatever sits under docs/d is served by Pages, so the repo gate must look inside it.
export async function validateRepo({ projects = true } = {}) {
  const report = new Report();
  const root = repoRoot();
  const out = () => ({ ok: report.errors.length === 0, errors: report.errors, warnings: report.warnings });

  // config
  const cfg = tryParse(rp('config.json'), report, 'config');
  let taxonomy;
  try {
    taxonomy = loadTaxonomy();
  } catch (err) {
    report.error('taxonomy', `ops/taxonomy.json: ${err.message}`, 'ops/taxonomy.json');
  }
  if (cfg) {
    const f = 'config.json';
    if (cfg.schema !== 1) report.error('config', 'schema must be 1', f);
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timezone });
    } catch {
      report.error('config', `timezone ${JSON.stringify(cfg.timezone)} is not a valid IANA zone`, f);
    }
    if (!DATE.test(String(cfg.startDate))) report.error('config', 'startDate must be YYYY-MM-DD', f);
    for (const [k, v] of Object.entries(cfg.schedule ?? {})) if (!HM.test(String(v))) report.error('config', `schedule.${k} must be HH:MM`, f);
    for (const k of ['t1Until', 't2Until', 't3Until']) if (!HM.test(String(cfg.tierCutoffs?.[k]))) report.error('config', `tierCutoffs.${k} must be HH:MM`, f);
    if (HM.test(String(cfg.tierCutoffs?.t1Until)) && HM.test(String(cfg.tierCutoffs?.t2Until)) && HM.test(String(cfg.tierCutoffs?.t3Until))) {
      const { t1Until, t2Until, t3Until } = cfg.tierCutoffs;
      if (!(t1Until < t2Until && t2Until < t3Until)) report.error('config', 'tierCutoffs must be ascending', f);
    }
    for (const k of ['projectMaxBytes', 'projectMaxFiles', 'singleFileMaxBytes', 'thumbMaxBytes', 'siteWarnBytes', 'minOwnLinesOfCodeTier1', 'minOwnLinesOfCodeTier2']) {
      if (!(Number.isFinite(cfg.limits?.[k]) && cfg.limits[k] > 0)) report.error('config', `limits.${k} must be a positive number`, f);
    }
    for (const k of ['categoryCooldownDays', 'maxPerCategoryIn7Days', 'mechanicCooldownDays', 'sameCategoryAndMechanicDays', 'tagJaccardMax', 'titleSimilarityMax']) {
      if (!Number.isFinite(cfg.novelty?.[k])) report.error('config', `novelty.${k} must be a number`, f);
    }
    if (!cfg.budget?.levels?.[cfg.budget?.level]) report.error('config', `budget.level ${JSON.stringify(cfg.budget?.level)} is not a defined level`, f);
    if (!Number.isInteger(cfg.mix?.windowDays) || !Number.isInteger(cfg.mix?.politicsMaxPer14Days)) report.error('config', 'mix.windowDays and mix.politicsMaxPer14Days must be integers', f);
    if (!cfg.workBranch || !cfg.siteUrl) report.error('config', 'workBranch and siteUrl are required', f);
    checkBudgetKeys(report, cfg, f);
    checkReviseKeys(report, cfg, f);
    checkPurposeKeys(report, cfg, taxonomy, f);
  }
  checkLensPool(report);

  // state files
  const throttle = tryParse(rp('state', 'throttle.json'), report, 'state-throttle');
  if (throttle && cfg?.budget?.levels && !cfg.budget.levels[throttle.level]) report.error('state-throttle', `throttle level ${JSON.stringify(throttle.level)} is not defined in config`, 'state/throttle.json');

  const carry = tryParse(rp('state', 'carryover.json'), report, 'state-carryover');
  if (carry) {
    const f = 'state/carryover.json';
    const maxCarries = cfg?.ideation?.carryover?.maxCarries ?? 1;
    if (Array.isArray(carry.idea)) report.error('state-carryover', 'carryover may hold at most one idea (found an array)', f);
    else if (carry.idea !== null && (typeof carry.idea !== 'object')) report.error('state-carryover', 'idea must be an object or null', f);
    if (!Number.isInteger(carry.carriedCount) || carry.carriedCount < 0) report.error('state-carryover', 'carriedCount must be a non-negative integer', f);
    else if (carry.carriedCount > maxCarries) report.error('state-carryover', `carriedCount ${carry.carriedCount} exceeds maxCarries ${maxCarries}`, f);
    if (carry.idea && typeof carry.idea === 'object' && !Array.isArray(carry.idea)) {
      if (carry.idea.durable !== true) report.error('state-carryover', 'only durable:true ideas may be carried over', f);
      if (!DATE.test(String(carry.savedOn))) report.error('state-carryover', 'savedOn must be a date when an idea is saved', f);
    } else if (carry.savedOn) report.warn('state-carryover', 'savedOn is set but no idea is saved', f);
  }

  const history = tryParse(rp('state', 'history.json'), report, 'state-history');
  const entries = Array.isArray(history?.entries) ? history.entries : null;
  if (history && !entries) report.error('state-history', 'entries must be an array', 'state/history.json');
  const docsD = rp('docs', 'd');
  if (entries) {
    const f = 'state/history.json';
    if (history.schema !== 1) report.error('state-history', 'schema must be 1', f);
    if (cfg && history.startDate !== cfg.startDate) report.warn('state-history', `startDate ${history.startDate} differs from config startDate ${cfg.startDate}`, f);
    const dates = new Set();
    const slugs = new Map();
    let lastDate = '';
    for (const e of entries) {
      const tag = `entry ${e?.date ?? '?'}`;
      if (!e || typeof e !== 'object') {
        report.error('state-history', 'entry is not an object', f);
        continue;
      }
      if (!DATE.test(String(e.date))) report.error('state-history', `${tag}: bad date`, f);
      if (dates.has(e.date)) report.error('state-history', `${tag}: duplicate date`, f);
      dates.add(e.date);
      if (e.date < lastDate) report.warn('state-history', `${tag}: entries are not sorted by date`, f);
      lastDate = e.date > lastDate ? e.date : lastDate;
      if (!Number.isInteger(e.n) || e.n < 1) report.error('state-history', `${tag}: n must be a positive integer`, f);
      else if (history.startDate && DATE.test(String(e.date)) && e.n !== dayNumber(e.date, history.startDate)) report.warn('state-history', `${tag}: n=${e.n} but the day number is ${dayNumber(e.date, history.startDate)}`, f);
      if (!e.slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(e.slug)) report.error('state-history', `${tag}: bad slug`, f);
      if (!e.title) report.error('state-history', `${tag}: missing title`, f);
      if (typeof e.tagline !== 'string' || e.tagline.length > 120) report.error('state-history', `${tag}: tagline must be a string of at most 120 chars`, f);
      if (![1, 2, 3, 4].includes(e.tier)) report.error('state-history', `${tag}: tier must be 1..4`, f);
      if (typeof e.countsForNovelty !== 'boolean') report.error('state-history', `${tag}: countsForNovelty must be a boolean`, f);
      else if (e.tier >= 3 && e.countsForNovelty) report.warn('state-history', `${tag}: fallback tiers should not count for novelty`, f);
      if (Number.isNaN(Date.parse(e.publishedAt))) report.error('state-history', `${tag}: publishedAt is not a timestamp`, f);
      if (!e.fingerprint || typeof e.fingerprint !== 'object') report.error('state-history', `${tag}: missing fingerprint`, f);
      else {
        if (taxonomy && !Object.hasOwn(taxonomy.categories, e.fingerprint.category)) report.error('state-history', `${tag}: unknown category ${JSON.stringify(e.fingerprint.category)}`, f);
        if (e.fingerprint.purpose !== undefined && !purposesOf(taxonomy).includes(e.fingerprint.purpose)) report.error('state-history', `${tag}: unknown purpose ${JSON.stringify(e.fingerprint.purpose)}`, f);
      }
      if (e.path !== `d/${e.date}-${e.slug}/`) report.error('state-history', `${tag}: path should be d/${e.date}-${e.slug}/`, f);
      if (e.slug) {
        const prior = slugs.get(e.slug);
        // Fallback pages use fixed slugs (ideas-day, postcard) and legitimately repeat.
        if (prior && !(prior.tier >= 3 && e.tier >= 3)) report.error('state-history', `${tag}: slug "${e.slug}" is also used on ${prior.date}`, f);
        slugs.set(e.slug, e);
      }
      if (typeof e.path === 'string' && !fs.existsSync(path.join(root, 'docs', e.path))) {
        report.error('history-no-dir', `history entry ${e.date} has no directory docs/${e.path}`, f);
      }
    }
  }
  let dirs = [];
  try {
    dirs = fs.readdirSync(docsD, { withFileTypes: true }).filter((x) => x.isDirectory() && !x.name.startsWith('.')).map((x) => x.name);
  } catch { /* no docs/d yet */ }
  const entryByDir = new Map((entries ?? []).filter((e) => e && typeof e === 'object').map((e) => [`${e.date}-${e.slug}`, e]));
  if (entries) {
    for (const name of dirs) {
      if (!entryByDir.has(name)) report.error('dir-no-history', `docs/d/${name} has no history entry but would be served by Pages`, `docs/d/${name}`);
    }
  }
  if (projects) {
    // Directories without a history entry are validated too: an unlisted directory is still published.
    const results = await mapPool(dirs, 4, async (name) => ({ name, res: await validateProject(path.join(docsD, name), { tier: entryByDir.get(name)?.tier }) }));
    for (const { name, res } of results) {
      const label = name.slice(0, 10);
      for (const x of res.errors) report.error('project', `${label}: ${x}`);
      for (const x of res.warnings) report.warn('project', `${label}: ${x}`);
    }
  }

  // run files, idea files
  const runStatus = new Set(['in_progress', 'published', 'failed']);
  const runsDir = rp('state', 'runs');
  if (fs.existsSync(runsDir)) {
    for (const name of fs.readdirSync(runsDir).filter((n) => n.endsWith('.json'))) {
      const run = tryParse(path.join(runsDir, name), report, 'state-run');
      if (!run) continue;
      const f = `state/runs/${name}`;
      if (run.date !== name.replace(/\.json$/, '')) report.error('state-run', `date ${run.date} does not match the file name`, f);
      if (!runStatus.has(run.status)) report.error('state-run', `unknown status ${JSON.stringify(run.status)}`, f);
    }
  }
  const ideasDir = rp('state', 'ideas');
  if (fs.existsSync(ideasDir)) {
    for (const name of fs.readdirSync(ideasDir).filter((n) => n.endsWith('.json'))) {
      try {
        JSON.parse(fs.readFileSync(path.join(ideasDir, name), 'utf8'));
      } catch (err) {
        report.warn('state-ideas', `state/ideas/${name} does not parse: ${err.message}`, `state/ideas/${name}`);
      }
    }
  }

  checkCulture(report, cfg, root);

  // docs/archive.json
  if (fs.existsSync(rp('docs', 'archive.json'))) tryParse(rp('docs', 'archive.json'), report, 'archive');

  // big files and site size
  let docsBytes = 0;
  const docsRoot = path.join(root, 'docs');
  walkAll(root, (p) => {
    let size = 0;
    try {
      size = fs.statSync(p).size;
    } catch { return; }
    if (size > 10 * 1024 * 1024) report.error('big-file', `${path.relative(root, p)} is ${size} bytes (limit 10 MB)`, path.relative(root, p));
    if (p.startsWith(docsRoot + path.sep)) docsBytes += size;
  });
  if (cfg?.limits?.siteWarnBytes && docsBytes > cfg.limits.siteWarnBytes) report.warn('site-size', `docs/ is ${docsBytes} bytes (warn at ${cfg.limits.siteWarnBytes}; GitHub Pages limit is 1 GB)`, 'docs');

  return out();
}

/* ------------------------------------------------------------------------------------------------
 * CLI
 * ---------------------------------------------------------------------------------------------- */

async function main() {
  const flags = parseArgs();
  const cmd = flags._[0];
  try {
    if (cmd === 'project') {
      // a bare --contract placed before the directory would swallow it as its value
      if (typeof flags.contract === 'string') {
        flags._.splice(1, 0, flags.contract);
        flags.contract = true;
      }
      const dir = flags._[1];
      if (!dir) die('usage: validate.mjs project <dir> [--tier T] [--contract]', 2);
      const tier = flags.tier !== undefined && flags.tier !== true ? Number(flags.tier) : undefined;
      if (tier !== undefined && ![1, 2, 3, 4].includes(tier)) die('--tier must be 1, 2, 3 or 4', 2);
      const res = await validateProject(dir, { tier, now: flags.now || process.env.SED_NOW ? resolveNow(flags) : undefined, contract: flags.contract === true });
      print(res);
      process.exitCode = res.ok ? 0 : 1;
    } else if (cmd === 'repo') {
      const res = await validateRepo({ projects: !flags['no-projects'] });
      print(res);
      process.exitCode = res.ok ? 0 : 1;
    } else {
      die('usage: validate.mjs project <dir> [--tier T] [--contract] | repo [--no-projects]', 2);
    }
  } catch (err) {
    die(`validator crashed: ${err.stack || err.message}`, 1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

export const __internals = { lexJs, tokenizeHtml, normalizeCss, classifyUrl, checkCsp, countLoc, decodeEntities };
