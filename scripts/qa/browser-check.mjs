#!/usr/bin/env node
// Headless-browser QA for one project directory (CONTRACT 6.9).
//   browser-check.mjs <projectDir> --out <dir> [--thumb] [--seconds N] [--no-monkey]
//                     [--seed N] [--timeout S] [--page-timeout MS] [--settle MS]
//                     [--thumb-settle MS] [--thumb-ready-timeout MS] [--no-keyboard]
//                     [--meta FILE] [--purpose P] [--contract]
// --meta FILE: a project.json-shaped file read when <projectDir>/project.json is absent (spec/PROJECT.json while building).
// --purpose P: the page's purpose for a manual run. --contract: check the page contract whatever the date (DESIGN 7.4).
// Serves the directory over a loopback HTTP server, drives Chromium through Playwright at desktop and mobile
// sizes in light and dark, audits the page (console, requests, overflow, accessibility basics), unleashes a
// seeded random "monkey", and optionally writes <projectDir>/thumb.png (1200x630, under the size cap).
// Prints ONE JSON document {ok, errors, warnings, metrics, shots}; also written to <out>/report.json.
// Never hangs: every browser call has its own timeout and the whole run has a hard deadline.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseArgs, print, die, readJson, rp, writeJsonAtomic, hashStr, mulberry32 } from '../lib/common.mjs';
import { startServer } from './serve.mjs';
import { fitPng, readPngSize } from './png-optimize.mjs';
import { purposesOf, pageContractOf, contractRequired } from '../validate.mjs';

export { readPngSize };

const DEFAULTS = {
  seconds: 12,
  timeoutS: 180,
  pageTimeoutMs: 15000,
  settleMs: 600,
  thumbSettleMs: 800,
  thumbReadyTimeoutMs: 8000,
  thumbMaxBytes: 307200,
};
const SELFTEST_MS = 10000;
const THUMB_W = 1200;
const THUMB_H = 630;
const MAX_PER_CODE = 12; // distinct messages kept per issue code; the rest are only counted

const PASS_SPECS = {
  'desktop-light': { viewport: { width: 1280, height: 800 }, colorScheme: 'light' },
  'desktop-dark': { viewport: { width: 1280, height: 800 }, colorScheme: 'dark' },
  'mobile-light': { viewport: { width: 390, height: 844 }, colorScheme: 'light', mobile: true },
  'mobile-dark': { viewport: { width: 390, height: 844 }, colorScheme: 'dark', mobile: true },
  'mobile-320': { viewport: { width: 320, height: 640 }, colorScheme: 'light', mobile: true },
  'reduced-motion': { viewport: { width: 1280, height: 800 }, colorScheme: 'light', reducedMotion: 'reduce' },
  'monkey-desktop': { viewport: { width: 1280, height: 800 }, colorScheme: 'light' },
  'monkey-mobile': { viewport: { width: 390, height: 844 }, colorScheme: 'light', mobile: true },
  thumb: { viewport: { width: THUMB_W, height: THUMB_H }, colorScheme: 'light' },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Await `promise` for at most `ms`. Never rejects: {ok:true,value} | {ok:false,timedOut,error}. */
async function settle(promise, ms) {
  let timer;
  const timeout = new Promise((r) => {
    timer = setTimeout(() => r({ ok: false, timedOut: true, error: `timed out after ${ms}ms` }), ms);
  });
  const work = Promise.resolve(promise).then(
    (value) => ({ ok: true, value }),
    (err) => ({ ok: false, timedOut: false, error: String(err?.message ?? err).split('\n')[0] }),
  );
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Is `req` (a Playwright Request, as seen by a route handler) a top-level navigation? request.frame() THROWS for a request
 * without a frame: the first navigation of a popup (a target=_blank link, window.open) is issued before its frame exists,
 * and service-worker requests never have one. An exception inside a route handler is uncaught and ends the whole run with
 * no report, so the lookup is guarded. A navigation with no frame yet is a new window's own first navigation, i.e.
 * top-level (the monkey follows cited-source links on purpose); any other frameless request is not.
 */
export function isTopLevelNavigation(req) {
  let nav = false;
  try {
    nav = req.isNavigationRequest();
    return Boolean(nav && !req.frame().parentFrame());
  } catch {
    return Boolean(nav); // no frame yet (popup) or never (worker)
  }
}

/* ------------------------------------------------------------------------------------------------
 * Playwright and Chromium discovery
 * ---------------------------------------------------------------------------------------------- */

function pickChromium(mod) {
  return mod?.chromium ?? mod?.default?.chromium ?? null;
}

async function loadPlaywright() {
  // Playwright reads PLAYWRIGHT_BROWSERS_PATH when it is first imported, so settle it before importing.
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH) process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';
  const notes = [];
  try {
    const chromium = pickChromium(await import('playwright'));
    if (chromium) return { chromium };
  } catch (err) {
    notes.push(`import('playwright'): ${String(err.message).split('\n')[0]}`);
  }
  const roots = [];
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (root) roots.push(root);
  } catch (err) {
    notes.push(`npm root -g: ${String(err.message).split('\n')[0]}`);
  }
  roots.push(path.join(path.dirname(path.dirname(process.execPath)), 'lib', 'node_modules'));
  for (const root of roots) {
    for (const entry of ['index.mjs', 'index.js']) {
      const file = path.join(root, 'playwright', entry);
      if (!fs.existsSync(file)) continue;
      try {
        const chromium = pickChromium(await import(pathToFileURL(file).href));
        if (chromium) return { chromium };
      } catch (err) {
        notes.push(`${file}: ${String(err.message).split('\n')[0]}`);
      }
    }
  }
  return { error: `playwright is not installed (${notes.join('; ') || 'not found'})` };
}

/** Chromium binaries under PLAYWRIGHT_BROWSERS_PATH, best first, for when the default lookup fails. */
function chromiumCandidates() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const found = [];
  let entries = [];
  try {
    entries = fs.readdirSync(base);
  } catch {
    return found;
  }
  const add = (p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) found.push(p);
    } catch { /* not usable */ }
  };
  add(path.join(base, 'chromium'));
  for (const e of entries.sort().reverse()) {
    if (/^chromium-\d+$/.test(e)) {
      add(path.join(base, e, 'chrome-linux', 'chrome'));
      add(path.join(base, e, 'chrome-linux64', 'chrome'));
    }
  }
  for (const e of entries.sort().reverse()) {
    if (/^chromium_headless_shell-\d+$/.test(e)) {
      add(path.join(base, e, 'chrome-linux', 'headless_shell'));
      add(path.join(base, e, 'chrome-headless-shell-linux64', 'chrome-headless-shell'));
    }
  }
  return [...new Set(found)];
}

async function launchBrowser(chromium) {
  const args = ['--disable-dev-shm-usage', '--force-color-profile=srgb', '--mute-audio', '--enable-unsafe-swiftshader', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'];
  const failures = [];
  const attempt = async (executablePath) => {
    const r = await settle(chromium.launch({ headless: true, args, timeout: 30000, ...(executablePath ? { executablePath } : {}) }), 40000);
    if (r.ok) return r.value;
    failures.push(`${executablePath ?? 'default'}: ${r.error}`);
    return null;
  };
  const first = await attempt(null);
  if (first) return { browser: first };
  for (const exe of chromiumCandidates()) {
    const b = await attempt(exe);
    if (b) return { browser: b };
  }
  return { error: `no usable Chromium under ${process.env.PLAYWRIGHT_BROWSERS_PATH} (${failures.join('; ')})` };
}

/* ------------------------------------------------------------------------------------------------
 * Code that runs inside the page (serialised by Playwright: must be self-contained)
 * ---------------------------------------------------------------------------------------------- */

const INIT_SCRIPT = `(() => {
  try {
    const q = (window.__sedQa = { long: [], csp: [] });
    document.addEventListener('securitypolicyviolation', (e) => {
      const rec = { directive: e.effectiveDirective || e.violatedDirective, blocked: e.blockedURI, source: e.sourceFile, line: e.lineNumber };
      q.csp.push(rec);
      try { window.__sedQaCsp(JSON.stringify(rec)); } catch (_) {}
    }, true);
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) q.long.push({ start: e.startTime, dur: e.duration });
    }).observe({ type: 'longtask', buffered: true });
    // WebRTC reaches STUN/TURN hosts outside the CSP and outside request routing, so QA cannot watch it on the wire:
    // poison the constructors instead and report any touch as a violation.
    for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection']) {
      Object.defineProperty(window, name, {
        configurable: true,
        value: function () {
          const rec = { directive: 'webrtc', blocked: name, source: '', line: 0 };
          q.csp.push(rec);
          try { window.__sedQaCsp(JSON.stringify(rec)); } catch (_) {}
          throw new DOMException(name + ' is disabled on Sonnet Every Day pages', 'NotAllowedError');
        },
      });
    }
  } catch (_) {}
})();`;

/* eslint-disable no-undef -- runs in the browser */
function auditInPage(opts) {
  const cssPath = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    else if (typeof el.className === 'string' && el.className.trim()) s += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
    return s;
  };
  const snippet = (el) => {
    const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30);
    return cssPath(el) + (t ? ` "${t}"` : '');
  };
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    return el.getClientRects().length > 0;
  };
  const hiddenFromAt = (el) => !!el.closest('[aria-hidden="true"], [inert], [hidden]');
  const text = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
  const idsText = (attr) =>
    attr
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .filter(Boolean)
      .map(text)
      .join(' ')
      .trim();
  const nameOf = (el) => {
    const al = el.getAttribute('aria-label');
    if (al && al.trim()) return al.trim();
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = idsText(lb);
      if (t) return t;
    }
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'image') return (el.getAttribute('alt') || '').trim();
      if (['button', 'submit', 'reset'].includes(type)) return (el.value || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '')).trim();
    }
    if (tag === 'img') return (el.getAttribute('alt') || '').trim();
    if (tag === 'svg') {
      const t = el.querySelector(':scope > title');
      if (t && text(t)) return text(t);
    }
    const own = text(el);
    if (own) return own;
    for (const img of el.querySelectorAll('img[alt]')) if (img.getAttribute('alt').trim()) return img.getAttribute('alt').trim();
    for (const t of el.querySelectorAll('svg title')) if (text(t)) return text(t);
    for (const n of el.querySelectorAll('[aria-label]')) if (n.getAttribute('aria-label').trim()) return n.getAttribute('aria-label').trim();
    return (el.getAttribute('title') || '').trim();
  };
  const list = (nodes, keep, cap = 8) => {
    const arr = [];
    for (const el of nodes) {
      if (arr.length >= cap) break;
      if (keep(el)) arr.push(snippet(el));
    }
    return arr;
  };
  const countAll = (nodes, keep) => {
    let n = 0;
    for (const el of nodes) if (keep(el)) n++;
    return n;
  };
  const doc = document;
  const out = {};

  out.lang = (doc.documentElement.getAttribute('lang') || '').trim();
  out.title = (doc.title || '').trim();
  out.viewportMeta = !!doc.querySelector('meta[name="viewport"]');
  out.placeholders = doc.querySelectorAll('[data-sed-placeholder]').length;
  out.dom = doc.getElementsByTagName('*').length;

  const headings = doc.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]');
  out.headings = { total: headings.length, h1: doc.querySelectorAll('h1,[role="heading"][aria-level="1"]').length };

  const audible = (el) => !hiddenFromAt(el);
  const imgs = [...doc.querySelectorAll('img, input[type="image"], area[href]')];
  const imgBad = (el) => audible(el) && !el.hasAttribute('alt') && !['presentation', 'none'].includes(el.getAttribute('role') || '') && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby');
  out.imgNoAlt = { count: countAll(imgs, imgBad), samples: list(imgs, imgBad) };

  const svgs = [...doc.querySelectorAll('svg[role="img"]')];
  const svgBad = (el) => audible(el) && !nameOf(el);
  out.svgNoName = { count: countAll(svgs, svgBad), samples: list(svgs, svgBad) };

  const buttons = [...doc.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"]')];
  const btnBad = (el) => audible(el) && visible(el) && !nameOf(el);
  out.unnamedButtons = { count: countAll(buttons, btnBad), samples: list(buttons, btnBad) };

  const links = [...doc.querySelectorAll('a[href], [role="link"]')];
  const linkBad = (el) => audible(el) && visible(el) && !nameOf(el);
  out.unnamedLinks = { count: countAll(links, linkBad), samples: list(links, linkBad) };

  const fields = [
    ...doc.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea, ' +
        '[role="textbox"], [role="slider"], [role="checkbox"], [role="switch"], [role="combobox"], [role="spinbutton"], [role="radio"], [role="searchbox"]',
    ),
  ];
  const labelled = (el) => {
    if (el.labels && [...el.labels].some((l) => text(l))) return true;
    if (nameOf(el)) return true;
    return false;
  };
  const fieldInScope = (el) => audible(el) && visible(el);
  const fieldBad = (el) => fieldInScope(el) && !labelled(el) && !el.getAttribute('placeholder');
  const fieldPlaceholderOnly = (el) => fieldInScope(el) && !labelled(el) && !!el.getAttribute('placeholder');
  out.unlabeledFields = { count: countAll(fields, fieldBad), samples: list(fields, fieldBad) };
  out.placeholderOnlyFields = { count: countAll(fields, fieldPlaceholderOnly), samples: list(fields, fieldPlaceholderOnly) };

  const focusables = [
    ...doc.querySelectorAll(
      'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex], [contenteditable=""], [contenteditable="true"], audio[controls], video[controls]',
    ),
  ];
  out.focusable = countAll(
    focusables,
    (el) => !el.disabled && el.getAttribute('tabindex') !== '-1' && !el.closest('[inert]') && visible(el),
  );

  const body = doc.body;
  const bodyText = body ? (body.innerText || '').trim() : '';
  const media = body ? body.querySelectorAll('canvas, svg, img, video, iframe, embed, object, picture').length : 0;
  out.content = { textChars: bodyText.length, media };

  // horizontal overflow against the width we asked Chromium for
  const de = doc.documentElement;
  const vw = opts.viewportWidth;
  const scrollW = Math.max(de.scrollWidth, body ? body.scrollWidth : 0);
  const offenders = [];
  const all = doc.getElementsByTagName('*');
  const clipped = (el) => {
    for (let p = el.parentElement; p && p !== body && p !== de; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === 'hidden' || ox === 'auto' || ox === 'scroll' || ox === 'clip') return true;
    }
    return false;
  };
  for (let i = 0; i < all.length && i < 6000 && offenders.length < 6; i++) {
    const el = all[i];
    if (['SCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'TITLE', 'NOSCRIPT', 'TEMPLATE'].includes(el.tagName)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right > vw + 1) {
      if (clipped(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      offenders.push(`${cssPath(el)} (${Math.round(r.left)}..${Math.round(r.right)}px)`);
    }
  }
  out.overflow = { viewport: vw, scrollWidth: scrollW, px: Math.max(0, scrollW - vw), offenders };

  if (opts.contrast) {
    const cv = doc.createElement('canvas');
    cv.width = cv.height = 1;
    const g = cv.getContext('2d', { willReadFrequently: true });
    const cache = new Map();
    const parse = (str) => {
      if (cache.has(str)) return cache.get(str);
      g.clearRect(0, 0, 1, 1);
      g.fillStyle = '#000';
      g.fillStyle = str;
      g.fillRect(0, 0, 1, 1);
      const d = g.getImageData(0, 0, 1, 1).data;
      const c = { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
      cache.set(str, c);
      return c;
    };
    const over = (top, bottom) => {
      const a = top.a + bottom.a * (1 - top.a);
      if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
      const mix = (t, b) => (t * top.a + b * bottom.a * (1 - top.a)) / a;
      return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
    };
    const lum = (c) => {
      const f = (v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
    const scheme = getComputedStyle(de).colorScheme || 'normal';
    const dark = matchMedia('(prefers-color-scheme: dark)').matches && /dark/.test(scheme);
    const canvasBase = dark ? { r: 18, g: 18, b: 18, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
    const backdrop = (el) => {
      const layers = [];
      let opaque = false;
      for (let a = el; a; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (cs.backgroundImage !== 'none') return null;
        const c = parse(cs.backgroundColor);
        if (c.a > 0) layers.push(c);
        if (c.a >= 0.999) {
          opaque = true;
          break;
        }
      }
      let res = opaque ? layers.pop() : canvasBase;
      for (let i = layers.length - 1; i >= 0; i--) res = over(layers[i], res);
      return res;
    };

    const skipTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'OPTION']);
    const holders = [];
    const seen = new Set();
    const walker = doc.createTreeWalker(body || de, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const p = n.parentElement;
      if (!p || seen.has(p) || skipTags.has(p.tagName) || !/\S/.test(n.nodeValue)) continue;
      seen.add(p);
      holders.push(p);
    }
    const sampleCap = opts.maxContrast || 60;
    const stride = Math.max(1, Math.ceil(holders.length / sampleCap));
    let sampled = 0;
    let skipped = 0;
    let min = Infinity;
    const failing = [];
    for (let i = 0; i < holders.length && sampled < sampleCap; i += stride) {
      const el = holders[i];
      if (!visible(el) || hiddenFromAt(el) || el.closest('[disabled], [aria-disabled="true"]')) continue;
      const cs = getComputedStyle(el);
      if (cs.webkitTextFillColor === 'rgba(0, 0, 0, 0)' || (cs.backgroundClip || '').includes('text') || (cs.webkitBackgroundClip || '').includes('text')) {
        skipped++;
        continue;
      }
      let opacity = 1;
      for (let a = el; a; a = a.parentElement) opacity *= Number(getComputedStyle(a).opacity);
      if (opacity < 0.05) continue;
      const r = el.getBoundingClientRect();
      const cx = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1);
      const cy = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
      const stack = doc.elementsFromPoint(cx, cy);
      const above = stack.indexOf(el) === -1 ? stack.length : stack.indexOf(el);
      const behind = stack.slice(above + 1).some((s) => ['CANVAS', 'VIDEO', 'IMG', 'PICTURE'].includes(s.tagName) || (s.tagName === 'svg' && !el.closest('svg')));
      const bg = backdrop(el);
      if (!bg || behind) {
        skipped++;
        continue;
      }
      let fg = parse(cs.color);
      fg = over({ ...fg, a: fg.a * opacity }, bg);
      const l1 = lum(fg);
      const l2 = lum(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const size = parseFloat(cs.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
      sampled++;
      min = Math.min(min, ratio);
      if (ratio < (large ? 3 : 4.5)) failing.push({ el: snippet(el), ratio: Math.round(ratio * 100) / 100, fg: hex(fg), bg: hex(bg), large });
    }
    failing.sort((a, b) => a.ratio - b.ratio);
    out.contrast = { sampled, skipped, failing: failing.slice(0, 6), failingCount: failing.length, min: Number.isFinite(min) ? Math.round(min * 100) / 100 : null };
  }
  return out;
}

/** Runs inside the page: describe the focused element and the focus-indicator signature of an earlier one. */
function focusProbeInPage(prevId) {
  const props = [
    'outlineStyle', 'outlineWidth', 'outlineColor', 'outlineOffset', 'boxShadow', 'borderTopColor', 'borderTopWidth',
    'backgroundColor', 'color', 'textDecorationLine', 'transform', 'filter', 'opacity',
  ];
  const sig = (el) => {
    const cs = getComputedStyle(el);
    return props.map((p) => cs[p]).join('|');
  };
  const store = (window.__sedKb = window.__sedKb || { n: 0, els: new Map() });
  const out = { prevSigNow: null, cur: null };
  if (prevId) {
    const prev = store.els.get(prevId);
    if (prev && prev.isConnected) out.prevSigNow = sig(prev);
  }
  const a = document.activeElement;
  if (a && a !== document.body && a !== document.documentElement) {
    if (!a.__sedKbId) {
      a.__sedKbId = ++store.n;
      store.els.set(a.__sedKbId, a);
    }
    const r = a.getBoundingClientRect();
    const label = a.tagName.toLowerCase() + (a.id ? '#' + a.id : '') + ((a.innerText || a.getAttribute('aria-label') || '').trim() ? ` "${(a.innerText || a.getAttribute('aria-label')).trim().slice(0, 24)}"` : '');
    out.cur = { id: a.__sedKbId, label, sig: sig(a), size: r.width * r.height, focusVisible: a.matches(':focus-visible') };
  }
  return out;
}

function reducedMotionProbeInPage() {
  const running = document
    .getAnimations()
    .filter((a) => {
      if (a.playState !== 'running') return false;
      const t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
      return t && t.iterations === Infinity && t.duration > 0;
    })
    .map((a) => a.animationName || a.transitionProperty || a.id || 'unnamed');
  return { matches: matchMedia('(prefers-reduced-motion: reduce)').matches, infinite: running.length, names: [...new Set(running)].slice(0, 6) };
}

function perfProbeInPage() {
  const nav = performance.getEntriesByType('navigation')[0];
  const fcp = performance.getEntriesByName('first-contentful-paint')[0];
  const long = (window.__sedQa && window.__sedQa.long) || [];
  const heap = performance.memory ? performance.memory.usedJSHeapSize : null;
  return {
    domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
    loadMs: nav ? Math.round(nav.loadEventEnd) : null,
    fcpMs: fcp ? Math.round(fcp.startTime) : null,
    longTasks: { count: long.length, totalMs: Math.round(long.reduce((s, t) => s + t.dur, 0)), maxMs: Math.round(long.reduce((m, t) => Math.max(m, t.dur), 0)) },
    heapMB: heap === null ? null : Math.round(heap / 1048576),
    resources: performance.getEntriesByType('resource').length,
  };
}

async function thumbReadyInPage(ms) {
  const v = window.__sedThumbReady;
  if (v === undefined) return 'absent';
  let timer;
  const timeout = new Promise((r) => {
    timer = setTimeout(() => r('timeout'), ms);
  });
  try {
    const p = typeof v === 'function' ? v() : v;
    return await Promise.race([Promise.resolve(p).then(() => 'ready'), timeout]);
  } catch (err) {
    return 'rejected: ' + (err && err.message ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

/** Decode PNG bytes to raw RGBA with Chromium's own decoder; returns base64 of the RGBA buffer. */
async function decodeInPage({ b64, w, h }) {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;
  let bin = '';
  for (let i = 0; i < px.length; i += 32768) bin += String.fromCharCode.apply(null, px.subarray(i, i + 32768));
  return btoa(bin);
}
/**
 * Runs inside the page: the page-contract view of the first screen. The intro and the explainer (rendered or not, the
 * intro's bottom edge in document pixels) and the visible interactive controls in the first viewport.
 */
function contractProbeInPage() {
  const rendered = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    if (el.closest('[hidden]')) return false;
    // the content of a closed <details> keeps its boxes in Chromium (content-visibility), but nobody sees it
    for (let d = el.parentElement && el.parentElement.closest('details:not([open])'); d; d = d.parentElement && d.parentElement.closest('details:not([open])')) {
      const summary = d.querySelector(':scope > summary');
      if (!summary || !summary.contains(el)) return false;
    }
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    let opacity = 1;
    for (let a = el; a; a = a.parentElement) opacity *= Number(getComputedStyle(a).opacity);
    if (opacity < 0.05) return false;
    const r = el.getBoundingClientRect();
    return el.getClientRects().length > 0 && r.width >= 2 && r.height >= 2;
  };
  const sx = window.scrollX;
  const sy = window.scrollY;
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top + sy), bottom: Math.round(r.bottom + sy), left: Math.round(r.left + sx), right: Math.round(r.right + sx) };
  };
  const out = {};
  const intros = [...document.querySelectorAll('[data-sed-intro]')];
  const intro = intros.find(rendered) || intros[0];
  out.intro = { count: intros.length, rendered: !!intro && rendered(intro), box: intro ? box(intro) : null };
  const explainers = [...document.querySelectorAll('[data-sed-explainer]')];
  const explainer = explainers.find(rendered) || explainers[0];
  out.explainer = { count: explainers.length, rendered: !!explainer && rendered(explainer), box: explainer ? box(explainer) : null };
  const sel = 'button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="slider"], [role="tab"], [role="switch"], a.sed-btn';
  const seen = new Set();
  const samples = [];
  let count = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (seen.has(el) || !rendered(el)) continue;
    seen.add(el);
    const b = box(el);
    if (b.bottom <= 0 || b.top >= innerHeight || b.right <= 0 || b.left >= innerWidth) continue;
    count++;
    if (samples.length < 20) {
      const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 24);
      samples.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (label ? ` "${label}"` : ''));
    }
  }
  out.controls = { count, samples };
  return out;
}

/** Runs inside the page: window.__sedSelfTest (sync or async) once, within `ms`. Never throws. */
async function selfTestInPage(ms) {
  const fn = window.__sedSelfTest;
  if (fn === undefined) return { present: false };
  if (typeof fn !== 'function') return { present: true, error: 'window.__sedSelfTest is not a function' };
  let timer;
  const timeout = new Promise((r) => {
    timer = setTimeout(() => r({ present: true, timedOut: true }), ms);
  });
  const run = Promise.resolve()
    .then(() => fn())
    .then(
      (value) => {
        if (!value || typeof value !== 'object' || !Array.isArray(value.cases)) return { present: true, error: 'returned no {cases: [...]} result' };
        const cases = value.cases.map((c, i) => ({
          name: String((c && c.name) || `case ${i + 1}`).slice(0, 160),
          ok: !!c && c.ok === true,
          detail: c && c.detail !== undefined ? String(c.detail).slice(0, 200) : undefined,
        }));
        return { present: true, cases };
      },
      (err) => ({ present: true, error: 'threw: ' + String((err && err.message) || err).split('\n')[0].slice(0, 200) }),
    );
  try {
    return await Promise.race([run, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
/* eslint-enable no-undef */

/* ------------------------------------------------------------------------------------------------
 * Small pure helpers
 * ---------------------------------------------------------------------------------------------- */

const KEYS = [
  'Enter', ' ', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Shift+Tab', 'Backspace', 'Delete',
  'PageDown', 'PageUp', 'Home', 'End', 'Control+z', 'Control+a', '+', '-', '=', '?', '/',
  ...'abcdefghijklmnopqrstuvwxyz0123456789'.split(''),
];
const WORDS = ['hello', 'Zürich', '42', '🎲', 'a'.repeat(40), '<b>x</b>', "'; --", '-1', '1e9', ' '];

function firstLine(s) {
  return String(s ?? '').split('\n')[0].slice(0, 300);
}

/* ------------------------------------------------------------------------------------------------
 * The run
 * ---------------------------------------------------------------------------------------------- */

export async function runBrowserCheck(options) {
  const startedAt = Date.now();
  const o = { ...DEFAULTS, thumb: false, monkey: true, keyboard: true, ...options };
  const deadline = startedAt + o.timeoutS * 1000;
  const remaining = () => deadline - Date.now();
  const projectDir = path.resolve(o.projectDir);
  const outDir = path.resolve(o.outDir);
  const shotsDir = path.join(outDir, 'shots');
  const seed = Number.isFinite(Number(o.seed)) ? Number(o.seed) >>> 0 : hashStr(path.basename(projectDir));
  const cfg = readJson(rp('config.json'), {}) ?? {};
  const cfgLimits = cfg.limits ?? {};
  const thumbCap = Number(cfgLimits.thumbMaxBytes) || o.thumbMaxBytes;

  const issues = new Map(); // key -> {level, code, detail, passes:Set}
  const perCode = new Map();
  const shots = [];
  const metrics = {
    seed,
    passes: {},
    server: { requests: 0, bytes: 0, notFound: [] },
    nonLocalRequests: [],
    cspViolations: [],
    consoleErrors: 0,
    pageErrors: 0,
    skipped: [],
  };
  let aborted = false;

  const add = (level, code, detail, pass) => {
    const key = `${level}|${code}|${detail}`;
    const hit = issues.get(key);
    if (hit) {
      hit.passes.add(pass);
      return;
    }
    const n = (perCode.get(`${level}|${code}`) ?? 0) + 1;
    perCode.set(`${level}|${code}`, n);
    if (n > MAX_PER_CODE) return;
    issues.set(key, { level, code, detail: detail.slice(0, 400), passes: new Set([pass]) });
  };
  const error = (code, detail, pass = 'run') => add('error', code, detail, pass);
  const warn = (code, detail, pass = 'run') => add('warning', code, detail, pass);

  const finish = (extra = {}) => {
    const fmt = (level) =>
      [...issues.values()]
        .filter((i) => i.level === level)
        .map((i) => {
          const tag = i.passes.size === 1 && [...i.passes][0] === 'run' ? '' : i.passes.size >= 5 ? '' : ` [${[...i.passes].join(', ')}]`;
          return `${i.code}: ${i.detail}${tag}`;
        });
    for (const [key, n] of perCode) {
      if (n > MAX_PER_CODE) {
        const [level, code] = key.split('|');
        issues.set(`${key}|more`, { level, code, detail: `${n - MAX_PER_CODE} more distinct ${code} messages not shown`, passes: new Set(['run']) });
      }
    }
    const errors = fmt('error');
    const warnings = fmt('warning');
    metrics.durationMs = Date.now() - startedAt;
    const report = { ok: errors.length === 0 && !extra.error, errors, warnings, metrics, shots, ...extra };
    try {
      writeJsonAtomic(path.join(outDir, 'report.json'), report);
    } catch { /* the stdout document still carries everything */ }
    return report;
  };

  fs.mkdirSync(shotsDir, { recursive: true });

  // project and entry; --meta stands in for project.json while the page is still being built (spec/PROJECT.json)
  let pj = null;
  try {
    pj = readJson(path.join(projectDir, 'project.json'), null);
  } catch { /* optional */ }
  if (!pj && typeof o.meta === 'string' && o.meta) pj = readJson(path.resolve(o.meta), null);
  if (!pj || typeof pj !== 'object' || Array.isArray(pj)) pj = null;

  // the page contract (DESIGN 7.4): purpose checks need a known purpose, the intro and explainer checks the date gate
  const contract = pageContractOf(cfg);
  const purposes = purposesOf(readJson(rp('ops', 'taxonomy.json'), null));
  const metaPurpose = typeof pj?.fingerprint?.purpose === 'string' && purposes.includes(pj.fingerprint.purpose) ? pj.fingerprint.purpose : null;
  const purpose = typeof o.purpose === 'string' && purposes.includes(o.purpose) ? o.purpose : metaPurpose;
  const tier = Number.isInteger(pj?.tier) ? pj.tier : null;
  const exempt = tier === 3 || tier === 4;
  const gate = contractRequired({ contract, date: pj?.date, tier, force: o.contract === true });
  const budget = !exempt && (gate || purpose !== null);
  if (purpose !== null || gate) metrics.contract = { purpose, gate, tier, requiredFrom: contract.requiredFrom, forced: o.contract === true };
  let entryRel = 'index.html';
  if (typeof pj?.entry === 'string' && pj.entry && !pj.entry.startsWith('/') && !pj.entry.includes('..')) entryRel = pj.entry;
  if (!fs.existsSync(path.join(projectDir, entryRel))) {
    error('missing-entry', `${entryRel} does not exist in ${projectDir}`);
    return finish();
  }
  const declared = new Set((Array.isArray(pj?.network) ? pj.network : []).map((h) => String(h).toLowerCase()));

  const pw = await loadPlaywright();
  if (pw.error) {
    error('no-browser', pw.error);
    return finish({ error: 'no-browser' });
  }
  const launched = await launchBrowser(pw.chromium);
  if (launched.error) {
    error('no-browser', launched.error);
    return finish({ error: 'no-browser' });
  }
  const { browser } = launched;
  metrics.browser = browser.version();

  const server = await startServer(projectDir, {
    onRequest: (r) => {
      metrics.server.requests++;
      metrics.server.bytes += r.bytes;
      if (r.status === 404 && r.path !== '/favicon.ico' && metrics.server.notFound.length < 20) metrics.server.notFound.push(r.path);
    },
  });
  const origin = new URL(server.url).origin;
  const entryUrl = new URL(entryRel.split('/').map(encodeURIComponent).join('/'), server.url).href;
  const sameEntry = (u) => {
    try {
      const a = new URL(u);
      const strip = (p) => p.replace(/\/index\.html$/, '/');
      return a.origin === origin && strip(a.pathname) === strip(new URL(entryUrl).pathname);
    } catch {
      return false;
    }
  };

  /** local | declared | violation */
  const classify = (raw) => {
    let u;
    try {
      u = new URL(raw);
    } catch {
      return { kind: 'violation', host: raw };
    }
    if (['data:', 'blob:', 'about:'].includes(u.protocol)) return { kind: 'local' };
    if (['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) {
      const hostname = u.hostname.toLowerCase();
      if ((hostname === '127.0.0.1' || hostname === 'localhost') && u.port === String(server.port)) return { kind: 'local' };
      return { kind: declared.has(hostname) ? 'declared' : 'violation', host: hostname };
    }
    return { kind: 'violation', host: `${u.protocol}//${u.hostname}` };
  };

  const state = { hung: false };

  const openPass = async (name) => {
    const spec = PASS_SPECS[name];
    const ctx = await browser.newContext({
      viewport: spec.viewport,
      deviceScaleFactor: spec.mobile ? 2 : 1,
      isMobile: !!spec.mobile,
      hasTouch: !!spec.mobile,
      colorScheme: spec.colorScheme,
      reducedMotion: spec.reducedMotion ?? 'no-preference',
      serviceWorkers: 'block',
      locale: 'en-US',
    });
    ctx.setDefaultTimeout(8000);
    const seenReq = new Set();
    const recordRequest = (url, method, resourceType, topNavigation = false) => {
      const c = classify(url);
      if (c.kind === 'local') return c;
      // A visitor following a link to a cited source is legitimate and the monkey clicks links at random.
      // In every other pass a top-level navigation off the origin is the page redirecting by itself.
      if (topNavigation && name.startsWith('monkey')) return { ...c, kind: 'navigation' };
      const key = `${method} ${url}`;
      if (!seenReq.has(key)) {
        seenReq.add(key);
        const entry = { url: url.slice(0, 300), method, type: resourceType, host: c.host, declared: c.kind === 'declared', pass: name };
        if (metrics.nonLocalRequests.length < 40) metrics.nonLocalRequests.push(entry);
        if (c.kind === 'violation') error('non-local-request', `${method} ${url.slice(0, 200)} (${resourceType})`, name);
        else warn('declared-network-blocked', `${method} ${url.slice(0, 160)} was blocked during QA (host is declared in project.json "network"; the page must still work offline)`, name);
      }
      return c;
    };
    await ctx.route('**/*', (route) => {
      const req = route.request();
      const top = isTopLevelNavigation(req);
      const c = recordRequest(req.url(), req.method(), req.resourceType(), top);
      if (c.kind === 'local') route.continue().catch(() => {});
      else route.abort('blockedbyclient').catch(() => {});
    });
    await ctx.exposeFunction('__sedQaCsp', (json) => {
      let rec;
      try {
        rec = JSON.parse(json);
      } catch {
        return;
      }
      if (metrics.cspViolations.length < 40) metrics.cspViolations.push({ ...rec, pass: name });
      const blocked = rec.blocked && rec.blocked !== 'inline' && rec.blocked !== 'eval' ? ` ${String(rec.blocked).slice(0, 160)}` : ` ${rec.blocked || ''}`;
      error('csp-violation', `${rec.directive} blocked${blocked}${rec.source ? ` (from ${String(rec.source).slice(0, 80)}:${rec.line})` : ''}`, name);
      if (rec.blocked && /^(https?|wss?):/i.test(rec.blocked) && classify(rec.blocked).kind === 'violation') {
        recordRequest(rec.blocked, 'GET', 'csp-blocked');
      }
    });
    await ctx.addInitScript(INIT_SCRIPT);
    const page = await ctx.newPage();
    page.setDefaultTimeout(8000);
    const flags = { crashed: false, offOrigin: false, dialogs: 0, popups: 0 };

    page.on('console', (m) => {
      const type = m.type();
      const msg = firstLine(m.text());
      if (type !== 'error' && type !== 'warning') return;
      if (/^Refused to |Content Security Policy|^Failed to load resource/.test(msg)) return; // CSP events and response handlers own these
      if (/GL Driver Message|GroupMarkerNotSet|WebGL-0x/.test(msg)) return; // software-GL noise from the QA browser, not the page
      const loc = m.location()?.url;
      if (loc && classify(loc).kind !== 'local') return;
      if (type === 'error') {
        metrics.consoleErrors++;
        error('console-error', msg, name);
      } else {
        warn('console-warning', msg, name);
      }
    });
    page.on('pageerror', (e) => {
      metrics.pageErrors++;
      error('page-error', firstLine(e.message), name);
    });
    page.on('crash', () => {
      flags.crashed = true;
      error('page-crash', 'the renderer crashed', name);
    });
    page.on('dialog', (d) => {
      flags.dialogs++;
      if (flags.dialogs === 1) warn('dialog', `the page opened a native ${d.type()}() dialog; QA dismissed it (${firstLine(d.message()).slice(0, 80)})`, name);
      d.dismiss().catch(() => {});
    });
    page.on('popup', (p) => {
      flags.popups++;
      if (flags.popups === 1) warn('popup', 'the page opened a new window; QA closed it', name);
      p.close().catch(() => {});
    });
    page.on('response', (r) => {
      const status = r.status();
      if (status < 400) return;
      const u = r.url();
      if (classify(u).kind !== 'local') return;
      if (new URL(u).pathname === '/favicon.ico') return;
      error('http-error', `${status} for ${u.startsWith(origin) ? u.slice(origin.length) : u.slice(0, 120)}`, name);
    });
    page.on('requestfailed', (r) => {
      const why = r.failure()?.errorText ?? '';
      if (/ERR_ABORTED|ERR_BLOCKED_BY_CLIENT/.test(why)) return;
      if (classify(r.url()).kind !== 'local') return;
      warn('request-failed', `${r.url().slice(0, 140)}: ${why}`, name);
    });
    page.on('websocket', (ws) => {
      const c = classify(ws.url());
      if (c.kind === 'violation') error('non-local-request', `WebSocket ${ws.url().slice(0, 200)}`, name);
    });
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame()) flags.offOrigin = !f.url().startsWith(origin) && !/^(about:blank|data:)/.test(f.url());
    });

    const close = async () => {
      await settle(ctx.close(), 6000);
    };
    return { name, spec, ctx, page, flags, close };
  };

  const ev = (page, fn, arg, ms = 5000) => settle(page.evaluate(fn, arg), ms);

  /** Load the entry page and let it settle. Returns false (and flags the run) when the page hangs. */
  const loadPage = async (p, settleMs = o.settleMs) => {
    const nav = await settle(p.page.goto(entryUrl, { waitUntil: 'load', timeout: o.pageTimeoutMs }), o.pageTimeoutMs + 3000);
    if (!nav.ok) {
      const alive = await ev(p.page, () => 1, undefined, 1500);
      if (!alive.ok) {
        state.hung = true;
        error('page-timeout', `the page did not finish loading within ${o.pageTimeoutMs}ms and its main thread is unresponsive (infinite loop or blocking script?)`, p.name);
      } else {
        error('page-load', `navigation failed: ${nav.error}`, p.name);
      }
      return false;
    }
    const status = nav.value?.status?.() ?? 200;
    if (status >= 400) {
      error('http-error', `entry page returned ${status}`, p.name);
      return false;
    }
    await sleep(settleMs);
    const hb = await ev(p.page, () => 1, undefined, 3000);
    if (!hb.ok) {
      state.hung = true;
      error('unresponsive', 'the page stopped responding after it loaded (main thread blocked)', p.name);
      return false;
    }
    return true;
  };

  const runAudit = async (p, { contrast }) => {
    const r = await ev(p.page, auditInPage, { viewportWidth: p.spec.viewport.width, contrast, maxContrast: 60 }, 15000);
    if (!r.ok) {
      warn('audit-failed', `page audit could not run: ${r.error}`, p.name);
      return null;
    }
    const a = r.value;
    const m = (metrics.passes[p.name] ??= {});
    m.domNodes = a.dom;
    m.focusable = a.focusable;
    m.headings = a.headings;
    m.overflowPx = a.overflow.px;
    m.contrast = a.contrast ? { sampled: a.contrast.sampled, skipped: a.contrast.skipped, failing: a.contrast.failingCount, min: a.contrast.min } : undefined;

    if (!a.lang) error('missing-lang', 'the <html> element has no lang attribute', p.name);
    if (!a.title) error('missing-title', 'the page has no <title>', p.name);
    if (!a.viewportMeta) error('missing-viewport', 'no <meta name="viewport"> (mobile layout will be wrong)', p.name);
    if (a.placeholders) error('shell-placeholder', `${a.placeholders} element(s) with data-sed-placeholder are still on the page (fill or remove the page-shell placeholders)`, p.name);
    if (a.imgNoAlt.count) error('img-missing-alt', `${a.imgNoAlt.count} image(s) without an alt attribute: ${a.imgNoAlt.samples.join(', ')}`, p.name);
    if (a.svgNoName.count) error('svg-missing-name', `${a.svgNoName.count} svg[role=img] without an accessible name: ${a.svgNoName.samples.join(', ')}`, p.name);
    if (a.unnamedButtons.count) error('button-missing-name', `${a.unnamedButtons.count} button(s) without an accessible name: ${a.unnamedButtons.samples.join(', ')}`, p.name);
    if (a.unnamedLinks.count) error('link-missing-name', `${a.unnamedLinks.count} link(s) without an accessible name: ${a.unnamedLinks.samples.join(', ')}`, p.name);
    if (a.unlabeledFields.count) error('field-missing-label', `${a.unlabeledFields.count} form control(s) without a label: ${a.unlabeledFields.samples.join(', ')}`, p.name);
    if (a.placeholderOnlyFields.count) warn('field-placeholder-only', `${a.placeholderOnlyFields.count} form control(s) labelled only by a placeholder: ${a.placeholderOnlyFields.samples.join(', ')}`, p.name);
    if (!a.headings.total) warn('no-heading', 'the page has no headings', p.name);
    else if (!a.headings.h1) warn('no-h1', 'the page has no <h1>', p.name);
    if (!a.content.textChars && !a.content.media) error('blank-page', 'the page renders no text and no canvas, svg or image', p.name);
    if (a.overflow.px > 1) {
      const level = p.name === 'mobile-320' ? warn : error;
      level('horizontal-overflow', `content is ${a.overflow.px}px wider than the ${a.overflow.viewport}px viewport (scrollWidth ${a.overflow.scrollWidth})${a.overflow.offenders.length ? `; wide elements: ${a.overflow.offenders.join(', ')}` : ''}`, p.name);
    } else if (a.overflow.offenders.length) {
      warn('offscreen-content', `content extends past the ${a.overflow.viewport}px viewport but is clipped: ${a.overflow.offenders.join(', ')}`, p.name);
    }
    if (a.contrast?.failingCount) {
      const worst = a.contrast.failing.slice(0, 3).map((f) => `${f.el} ${f.ratio}:1 (${f.fg} on ${f.bg})`).join('; ');
      warn('low-contrast', `${a.contrast.failingCount} of ${a.contrast.sampled} sampled text elements are below WCAG AA; worst: ${worst}`, p.name);
    }
    if (a.dom > 6000) warn('large-dom', `${a.dom} DOM nodes (heavy for a static page)`, p.name);
    return a;
  };

  const collectPerf = async (p) => {
    const r = await ev(p.page, perfProbeInPage, undefined, 5000);
    if (!r.ok) return null;
    const m = (metrics.passes[p.name] ??= {});
    Object.assign(m, r.value);
    if (r.value.longTasks.maxMs > 1000) warn('long-task', `a ${r.value.longTasks.maxMs}ms main-thread task blocked the page (${r.value.longTasks.count} long tasks, ${r.value.longTasks.totalMs}ms total)`, p.name);
    else if (r.value.longTasks.totalMs > 3000) warn('long-task', `${r.value.longTasks.count} long tasks totalling ${r.value.longTasks.totalMs}ms while loading`, p.name);
    if (r.value.loadMs && r.value.loadMs > 5000) warn('slow-load', `load event took ${r.value.loadMs}ms`, p.name);
    return r.value;
  };

  const shot = async (p, file = p.name) => {
    const target = path.join(shotsDir, `${file}.png`);
    const r = await settle(p.page.screenshot({ path: target, type: 'png', timeout: 8000, animations: 'allow', caret: 'hide' }), 12000);
    if (r.ok) shots.push(target);
    else warn('screenshot-failed', `${file}: ${r.error}`, p.name);
    return r.ok;
  };

  /** The first screen against the page contract: the control budget, and (gate only) the intro and the explainer. */
  const contractChecks = async (p) => {
    const desktop = p.name === 'desktop-light';
    const r = await ev(p.page, contractProbeInPage, undefined, 5000);
    if (!r.ok) {
      if (gate || (desktop && budget)) warn('contract-probe-failed', `the page-contract probe could not run: ${r.error}`, p.name);
      return;
    }
    const v = r.value;
    const { width: W, height: H } = p.spec.viewport;
    if (desktop) {
      metrics.firstScreenControls = v.controls.count;
      if (budget) {
        const { warn: warnAt, error: errorAt } = contract.firstScreenControls;
        const msg = `${v.controls.count} interactive controls are visible in the first ${W}x${H} screen; the budget is ${warnAt} (a warning above ${warnAt}, an error above ${errorAt}: pageContract.firstScreenControls). Move advanced controls behind a "More" toggle or further down: ${v.controls.samples.slice(0, 12).join(', ')}`;
        if (v.controls.count > errorAt) error('controls-excess', msg, p.name);
        else if (v.controls.count > warnAt) warn('controls-many', msg, p.name);
      }
    }
    if (!gate) return;
    const label = desktop ? 'desktop' : 'mobile';
    const limit = contract.introMaxBottomPx[label];
    (metrics.passes[p.name] ??= {}).contract = { introBottomPx: v.intro.box?.bottom ?? null, introLimitPx: limit, introRendered: v.intro.rendered, explainerRendered: v.explainer.rendered };
    if (!v.intro.count) error('intro-missing', 'the page has no p[data-sed-intro]: the intro paragraph of the page shell belongs right under the tagline', p.name);
    else if (!v.intro.rendered) error('intro-hidden', 'the intro p[data-sed-intro] is not rendered (display:none, visibility:hidden, [hidden], zero size or transparent)', p.name);
    else if (v.intro.box.bottom > limit) error('intro-too-tall', `the intro ends ${v.intro.box.bottom}px from the top of the page; at ${W}x${H} it must end by ${limit}px (pageContract.introMaxBottomPx.${label}): shorten the intro or what sits above it`, p.name);
    if (!v.explainer.count) error('explainer-missing', 'the page has no section[data-sed-explainer]: the explainer section of the page shell', p.name);
    else if (!v.explainer.rendered) error('explainer-hidden', 'the explainer section[data-sed-explainer] is not rendered (display:none, visibility:hidden, [hidden], a closed <details>, zero size or transparent)', p.name);
  };

  /** window.__sedSelfTest, once (desktop-light): any failure is an error; a tool must have one with enough cases. */
  const selfTest = async (p) => {
    const t0 = Date.now();
    const r = await ev(p.page, selfTestInPage, SELFTEST_MS, SELFTEST_MS + 3000);
    const res = r.ok ? r.value : { present: true, timedOut: true };
    const required = purpose === 'tool' && !exempt;
    if (!res.present) {
      if (required) {
        metrics.selfTest = { present: false, total: 0, passed: 0, ok: false };
        error('selftest-missing', `a tool page must define window.__sedSelfTest in selftest.js with at least ${contract.toolMinSelfTests} known-answer cases (pageContract.toolMinSelfTests)`, p.name);
      }
      return;
    }
    const st = { present: true, ms: Date.now() - t0 };
    metrics.selfTest = st;
    if (res.timedOut) {
      st.ok = false;
      st.timedOut = true;
      error('selftest-timeout', `window.__sedSelfTest (selftest.js) did not finish within ${SELFTEST_MS / 1000} s`, p.name);
      const hb = await ev(p.page, () => 1, undefined, 2500);
      if (!hb.ok) state.hung = true;
      return;
    }
    if (res.error) {
      st.ok = false;
      st.error = res.error;
      error('selftest-failed', `window.__sedSelfTest (selftest.js) ${res.error}`, p.name);
      return;
    }
    const failing = res.cases.filter((c) => !c.ok);
    st.total = res.cases.length;
    st.passed = st.total - failing.length;
    st.ok = failing.length === 0;
    if (failing.length) {
      st.failing = failing.slice(0, 12).map((c) => c.name);
      error('selftest-failed', `window.__sedSelfTest (selftest.js): ${failing.length} of ${st.total} cases fail: ${failing.slice(0, 5).map((c) => c.name + (c.detail ? ` (${c.detail})` : '')).join('; ')}`, p.name);
    }
    if (required && st.total < contract.toolMinSelfTests) {
      error('selftest-few', `window.__sedSelfTest (selftest.js) has ${st.total} case${st.total === 1 ? '' : 's'}; a tool needs at least ${contract.toolMinSelfTests} known-answer cases (pageContract.toolMinSelfTests)`, p.name);
    }
  };

  const keyboardSmoke = async (p) => {
    await ev(p.page, () => {
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      window.scrollTo(0, 0);
    });
    const stops = new Map(); // id -> label
    const missing = [];
    let prev = null;
    let same = 0;
    let empty = 0;
    let trapped = false;
    let steps = 0;
    for (; steps < 40; steps++) {
      const pressed = await settle(p.page.keyboard.press('Tab'), 3000);
      if (!pressed.ok) {
        state.hung = true;
        error('unresponsive', 'keyboard input is not processed (main thread blocked)', p.name);
        return;
      }
      const r = await ev(p.page, focusProbeInPage, prev ? prev.id : 0, 4000);
      if (!r.ok) break;
      const { cur, prevSigNow } = r.value;
      if (prev && prevSigNow !== null && prevSigNow === prev.sig && prev.size > 0 && !missing.includes(prev.label)) missing.push(prev.label);
      if (!cur) {
        if (++empty >= 2) break;
        prev = null;
        continue;
      }
      empty = 0;
      if (stops.has(cur.id) && !prev) break;
      if (prev && cur.id === prev.id) {
        if (++same >= 3) {
          trapped = true;
          break;
        }
      } else {
        same = 0;
        if (stops.has(cur.id) && stops.size > 1) break; // wrapped around
      }
      stops.set(cur.id, cur.label);
      prev = cur;
    }
    const m = (metrics.passes[p.name] ??= {});
    m.keyboard = { tabStops: stops.size, missingIndicator: missing.length, trapped };
    if (missing.length) warn('no-focus-indicator', `${missing.length} focusable element(s) show no visible change when focused: ${missing.slice(0, 5).join(', ')}`, p.name);
    if (trapped) warn('keyboard-trap', `Tab stays on ${prev?.label} (possible keyboard trap)`, p.name);
    if (!stops.size && m.focusable > 0) warn('no-tab-stops', `${m.focusable} focusable element(s) exist but Tab reaches none of them`, p.name);
  };

  const reducedMotionCheck = async (p) => {
    const r = await ev(p.page, reducedMotionProbeInPage, undefined, 4000);
    if (!r.ok) return;
    const m = (metrics.passes[p.name] ??= {});
    m.reducedMotion = r.value;
    if (!r.value.matches) warn('reduced-motion-emulation', 'prefers-reduced-motion did not match in the emulated context', p.name);
    if (r.value.infinite) warn('reduced-motion', `${r.value.infinite} animation(s) still loop forever under prefers-reduced-motion: reduce (${r.value.names.join(', ')})`, p.name);
  };

  /* -- the random monkey ------------------------------------------------------------------------ */
  const monkey = async (p, ms, monkeySeed, touch) => {
    const rng = mulberry32(monkeySeed);
    const pick = (arr) => arr[Math.floor(rng() * arr.length)];
    const end = Date.now() + ms;
    const stats = { seed: monkeySeed, durationMs: 0, actions: 0, byKind: {}, timeouts: 0, navigatedAway: 0, resizes: 0, log: [] };
    let vp = { ...p.spec.viewport };
    let targets = [];
    let hbFail = 0;
    const startPerf = await ev(p.page, () => ({ nodes: document.getElementsByTagName('*').length, heap: performance.memory ? performance.memory.usedJSHeapSize : 0 }), undefined, 3000);

    const refreshTargets = async () => {
      const r = await ev(
        p.page,
        () =>
          [...document.querySelectorAll('button, a, input, select, textarea, summary, canvas, label, [role], [tabindex], [onclick]')]
            .slice(0, 300)
            .map((el) => {
              const b = el.getBoundingClientRect();
              return { x: b.left, y: b.top, w: b.width, h: b.height };
            })
            .filter((b) => b.w > 2 && b.h > 2 && b.x < innerWidth && b.y < innerHeight && b.x + b.w > 0 && b.y + b.h > 0),
        undefined,
        2500,
      );
      targets = r.ok ? r.value : [];
    };
    const point = () => {
      if (targets.length && rng() < 0.65) {
        const t = pick(targets);
        return { x: Math.round(Math.max(1, Math.min(vp.width - 1, t.x + rng() * t.w))), y: Math.round(Math.max(1, Math.min(vp.height - 1, t.y + rng() * t.h))) };
      }
      return { x: Math.round(1 + rng() * (vp.width - 2)), y: Math.round(1 + rng() * (vp.height - 2)) };
    };
    const kinds = touch
      ? [['tap', 34], ['key', 14], ['type', 4], ['drag', 22], ['wheel', 10], ['click', 6], ['resize', 4], ['hover', 6]]
      : [['click', 32], ['key', 22], ['type', 4], ['drag', 13], ['wheel', 8], ['hover', 6], ['resize', 5], ['dblclick', 5], ['rightclick', 2]];
    const total = kinds.reduce((s, k) => s + k[1], 0);
    const pickKind = () => {
      let r = rng() * total;
      for (const [k, w] of kinds) if ((r -= w) < 0) return k;
      return kinds[0][0];
    };

    const act = async (kind) => {
      const pg = p.page;
      switch (kind) {
        case 'click': {
          const q = point();
          stats.log.push(`click ${q.x},${q.y}`);
          return pg.mouse.click(q.x, q.y, { delay: rng() < 0.2 ? 40 : 0 });
        }
        case 'dblclick': {
          const q = point();
          stats.log.push(`dblclick ${q.x},${q.y}`);
          return pg.mouse.dblclick(q.x, q.y);
        }
        case 'rightclick': {
          const q = point();
          stats.log.push(`rightclick ${q.x},${q.y}`);
          return pg.mouse.click(q.x, q.y, { button: 'right' });
        }
        case 'tap': {
          const q = point();
          stats.log.push(`tap ${q.x},${q.y}`);
          return pg.touchscreen.tap(q.x, q.y);
        }
        case 'hover': {
          const q = point();
          stats.log.push(`hover ${q.x},${q.y}`);
          return pg.mouse.move(q.x, q.y, { steps: 1 + Math.floor(rng() * 4) });
        }
        case 'key': {
          const k = pick(KEYS);
          stats.log.push(`key ${k}`);
          return pg.keyboard.press(k);
        }
        case 'type': {
          const w = pick(WORDS);
          stats.log.push(`type ${JSON.stringify(w)}`);
          return pg.keyboard.type(w, { delay: 0 });
        }
        case 'drag': {
          const a = point();
          const b = point();
          const n = 3 + Math.floor(rng() * 6);
          stats.log.push(`drag ${a.x},${a.y}->${b.x},${b.y}`);
          await pg.mouse.move(a.x, a.y);
          await pg.mouse.down();
          for (let i = 1; i <= n; i++) await pg.mouse.move(a.x + ((b.x - a.x) * i) / n, a.y + ((b.y - a.y) * i) / n);
          return pg.mouse.up();
        }
        case 'wheel': {
          const q = point();
          const dx = Math.round((rng() - 0.5) * 400);
          const dy = Math.round((rng() - 0.5) * 1200);
          stats.log.push(`wheel ${q.x},${q.y} ${dx},${dy}`);
          await pg.mouse.move(q.x, q.y);
          return pg.mouse.wheel(dx, dy);
        }
        case 'resize': {
          vp = { width: 320 + Math.floor(rng() * 1280), height: 400 + Math.floor(rng() * 600) };
          if (rng() < 0.2) vp = { ...p.spec.viewport };
          stats.resizes++;
          stats.log.push(`resize ${vp.width}x${vp.height}`);
          return pg.setViewportSize(vp);
        }
        default:
          return undefined;
      }
    };

    await refreshTargets();
    while (Date.now() < end && !aborted && !p.flags.crashed && !state.hung) {
      const kind = pickKind();
      stats.byKind[kind] = (stats.byKind[kind] ?? 0) + 1;
      const r = await settle(act(kind), 4000);
      stats.actions++;
      if (!r.ok) {
        stats.timeouts += r.timedOut ? 1 : 0;
        if (!/Target (page|closed)|has been closed|crashed/i.test(r.error)) stats.log.push(`  ! ${kind}: ${r.error.slice(0, 80)}`);
      }
      if (p.flags.offOrigin || !p.page.url().startsWith(origin)) {
        stats.navigatedAway++;
        p.flags.offOrigin = false;
        stats.log.push('  ! navigated away; restoring the entry page');
        await settle(p.page.goto(entryUrl, { waitUntil: 'load', timeout: 8000 }), 11000);
        await refreshTargets();
      }
      if (!r.ok || stats.actions % 8 === 0) {
        const hb = await ev(p.page, () => 1, undefined, 2500);
        hbFail = hb.ok ? 0 : hbFail + 1;
        if (hbFail >= 2) {
          state.hung = true;
          error('monkey-hang', `the page became unresponsive during random input (seed ${monkeySeed}, after ${stats.actions} actions; last: ${stats.log.slice(-3).join(' | ')})`, p.name);
          break;
        }
      }
      if (stats.actions % 15 === 0) await refreshTargets();
      await sleep(4 + Math.floor(rng() * 36));
    }
    stats.durationMs = ms - Math.max(0, end - Date.now());
    if (p.flags.crashed) error('monkey-crash', `the page crashed during random input (seed ${monkeySeed}, after ${stats.actions} actions; last: ${stats.log.slice(-3).join(' | ')})`, p.name);
    if (!state.hung && !p.flags.crashed) {
      const endPerf = await ev(p.page, () => ({ nodes: document.getElementsByTagName('*').length, heap: performance.memory ? performance.memory.usedJSHeapSize : 0, text: (document.body ? document.body.innerText : '').trim().length, media: document.body ? document.body.querySelectorAll('canvas, svg, img, video').length : 0 }), undefined, 4000);
      if (endPerf.ok && startPerf.ok) {
        stats.domNodes = { start: startPerf.value.nodes, end: endPerf.value.nodes };
        stats.heapMB = { start: Math.round(startPerf.value.heap / 1048576), end: Math.round(endPerf.value.heap / 1048576) };
        if (!endPerf.value.text && !endPerf.value.media) error('blank-after-monkey', `the page is blank after random input (seed ${monkeySeed})`, p.name);
        if (endPerf.value.nodes > 20000 && endPerf.value.nodes > startPerf.value.nodes * 5) warn('dom-growth', `DOM grew from ${startPerf.value.nodes} to ${endPerf.value.nodes} nodes during random input (leak?)`, p.name);
        if (stats.heapMB.end > 400 && stats.heapMB.end > stats.heapMB.start * 3) warn('memory-growth', `JS heap grew from ${stats.heapMB.start}MB to ${stats.heapMB.end}MB during random input`, p.name);
      }
      await shot(p, `${p.name}-end`);
    }
    return stats;
  };

  /* -- thumbnail -------------------------------------------------------------------------------- */
  const reduceThumb = async (png) => {
    const ctx = await browser.newContext({ viewport: { width: 400, height: 300 }, serviceWorkers: 'block' });
    try {
      const page = await ctx.newPage();
      const decoded = await settle(page.evaluate(decodeInPage, { b64: png.toString('base64'), w: THUMB_W, h: THUMB_H }), 20000);
      if (!decoded.ok) return { buf: null, smallest: null, error: decoded.error };
      const rgba = Buffer.from(decoded.value, 'base64');
      if (rgba.length !== THUMB_W * THUMB_H * 4) return { buf: null, smallest: null, error: `decoded ${rgba.length} bytes of pixels` };
      const fit = fitPng(rgba, THUMB_W, THUMB_H, thumbCap, { isExpired: () => remaining() < 4000 });
      if (!fit.buf) return fit;
      const { scale, colors } = fit.step;
      return { buf: fit.buf, strategy: `${colors ? `${colors}-color palette` : 'optimized truecolor'}${scale < 1 ? ` at ${scale}x detail` : ''}` };
    } finally {
      await settle(ctx.close(), 6000);
    }
  };

  const makeThumb = async () => {
    const info = { path: null, bytes: null, strategy: null, settleMs: o.thumbSettleMs, ready: 'absent', rawBytes: null };
    metrics.thumb = info;
    const p = await openPass('thumb');
    try {
      if (!(await loadPage(p, 0))) {
        error('thumb-failed', 'the page did not load, so no thumbnail was written', 'thumb');
        return;
      }
      const ready = await ev(p.page, thumbReadyInPage, o.thumbReadyTimeoutMs, o.thumbReadyTimeoutMs + 3000);
      info.ready = ready.ok ? ready.value : `error: ${ready.error}`;
      if (info.ready === 'timeout') warn('thumb-ready-timeout', `window.__sedThumbReady did not settle within ${o.thumbReadyTimeoutMs}ms; the thumbnail was taken anyway`, 'thumb');
      else if (String(info.ready).startsWith('rejected')) warn('thumb-ready-rejected', `window.__sedThumbReady ${info.ready}`, 'thumb');
      await sleep(o.thumbSettleMs);
      const a = await ev(p.page, auditInPage, { viewportWidth: THUMB_W, contrast: false }, 8000);
      if (a.ok && !a.value.content.textChars && !a.value.content.media) {
        error('thumb-failed', 'the page is blank, so no thumbnail was written', 'thumb');
        return;
      }
      const s = await settle(p.page.screenshot({ type: 'png', timeout: 10000, animations: 'allow', caret: 'hide' }), 14000);
      if (!s.ok) {
        error('thumb-failed', `screenshot failed: ${s.error}`, 'thumb');
        return;
      }
      let png = s.value;
      info.rawBytes = png.length;
      info.strategy = 'screenshot';
      const size = readPngSize(png);
      if (!size || size.width !== THUMB_W || size.height !== THUMB_H) {
        error('thumb-failed', `screenshot is ${size ? `${size.width}x${size.height}` : 'not a PNG'}, expected ${THUMB_W}x${THUMB_H}`, 'thumb');
        return;
      }
      if (png.length > thumbCap) {
        const red = await reduceThumb(png);
        if (!red.buf) {
          error('thumb-too-large', `could not get the thumbnail under ${thumbCap} bytes (raw ${png.length}, best ${red.smallest ?? 'n/a'}${red.error ? `, ${red.error}` : ''})`, 'thumb');
          return;
        }
        png = red.buf;
        info.strategy = red.strategy;
        warn('thumb-reduced', `the raw screenshot was ${info.rawBytes} bytes; re-encoded with ${red.strategy} to ${png.length} bytes`, 'thumb');
      }
      const finalSize = readPngSize(png);
      if (!finalSize || finalSize.width !== THUMB_W || finalSize.height !== THUMB_H || png.length > thumbCap) {
        error('thumb-failed', 'the re-encoded thumbnail failed its own size check', 'thumb');
        return;
      }
      const thumbRel = typeof pj?.thumb === 'string' && pj.thumb && !pj.thumb.startsWith('/') && !pj.thumb.includes('..') ? pj.thumb : 'thumb.png';
      const dest = path.join(projectDir, thumbRel);
      const tmp = `${dest}.${process.pid}.tmp`;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(tmp, png);
      fs.renameSync(tmp, dest);
      info.path = dest;
      info.bytes = png.length;
      shots.push(dest);
    } finally {
      await p.close();
    }
  };

  /* -- orchestration ---------------------------------------------------------------------------- */
  const skipIf = (name, needMs) => {
    if (state.hung) {
      metrics.skipped.push(name);
      return true;
    }
    if (remaining() < Math.min(needMs, o.timeoutS * 300)) {
      metrics.skipped.push(name);
      warn('skipped-time', `pass ${name} skipped: the ${o.timeoutS}s overall budget is nearly spent`);
      return true;
    }
    return false;
  };

  const log = (msg) => process.stderr.write(`[qa] ${msg}\n`);

  const work = async () => {
    for (const name of ['desktop-light', 'desktop-dark', 'mobile-light', 'mobile-dark', 'mobile-320', 'reduced-motion']) {
      if (aborted || skipIf(name, 20000)) continue;
      const p = await openPass(name);
      try {
        const t0 = Date.now();
        if (await loadPage(p)) {
          await collectPerf(p);
          await runAudit(p, { contrast: name !== 'mobile-320' && name !== 'reduced-motion' });
          if (name === 'desktop-light' || name === 'mobile-light') await contractChecks(p);
          if (name === 'reduced-motion') await reducedMotionCheck(p);
          await shot(p);
          if (name === 'desktop-light' && !state.hung) await selfTest(p);
          if (name === 'desktop-light' && o.keyboard && !state.hung) await keyboardSmoke(p);
        }
        (metrics.passes[name] ??= {}).ms = Date.now() - t0;
        log(`${name}: ${Date.now() - t0}ms`);
      } finally {
        await p.close();
      }
    }
    if (o.monkey && o.seconds > 0) {
      const desktopMs = o.seconds >= 4 ? Math.round(o.seconds * 600) : Math.round(o.seconds * 1000);
      const plan = [['monkey-desktop', desktopMs, seed, false]];
      if (o.seconds >= 4) plan.push(['monkey-mobile', Math.round(o.seconds * 1000) - desktopMs, (seed ^ 0x9e3779b9) >>> 0, true]);
      for (const [name, ms, s, touch] of plan) {
        if (aborted || skipIf(name, 15000)) continue;
        const p = await openPass(name);
        try {
          if (await loadPage(p)) {
            const run = Math.min(ms, remaining() - 12000);
            if (run >= 1000) {
              (metrics.monkey ??= {})[name] = await monkey(p, run, s, touch);
              log(`${name}: ${metrics.monkey[name].actions} random actions in ${metrics.monkey[name].durationMs}ms (seed ${s})`);
            }
            else metrics.skipped.push(name);
          }
        } finally {
          await p.close();
        }
      }
    } else {
      metrics.skipped.push('monkey');
    }
    if (o.thumb && !aborted) {
      if (state.hung) {
        error('thumb-failed', 'the page hung during QA, so no thumbnail was written');
      } else if (remaining() < 12000) {
        error('thumb-failed', 'no time left for the thumbnail');
      } else {
        await makeThumb();
        log(`thumb: ${metrics.thumb?.bytes ?? 'failed'} bytes (${metrics.thumb?.strategy ?? 'n/a'})`);
      }
    }
  };

  let timedOut = false;
  try {
    const timer = new Promise((r) => setTimeout(() => r('timeout'), Math.max(1000, remaining())));
    const running = work().catch((err) => {
      if (!aborted) error('qa-crash', firstLine(err?.stack ?? err));
    });
    const winner = await Promise.race([running.then(() => 'done'), timer]);
    if (winner === 'timeout') {
      timedOut = true;
      aborted = true;
      error('overall-timeout', `QA did not finish within the ${o.timeoutS}s hard limit; results are partial`);
    }
  } finally {
    aborted = true;
    await settle(browser.close(), 10000);
    await settle(server.close(), 3000);
  }
  if (metrics.skipped.length === 0) delete metrics.skipped;
  const monkeyLog = metrics.monkey;
  const report = finish({ timedOut });
  if (monkeyLog) {
    // the full action logs live in report.json only; keep stdout small
    const slim = JSON.parse(JSON.stringify(report));
    for (const k of Object.keys(slim.metrics.monkey)) slim.metrics.monkey[k].log = slim.metrics.monkey[k].log.slice(-12);
    return slim;
  }
  return report;
}

/* ------------------------------------------------------------------------------------------------
 * CLI
 * ---------------------------------------------------------------------------------------------- */

function number(flags, key, fallback, { min = 0 } = {}) {
  if (flags[key] === undefined) return fallback;
  const n = Number(flags[key]);
  if (!Number.isFinite(n) || n < min) die(`bad --${key} value: ${flags[key]}`, 2);
  return n;
}

async function main() {
  const flags = parseArgs();
  // a bare boolean flag placed before the directory would swallow it as its value
  for (const k of ['thumb', 'no-monkey', 'no-keyboard', 'contract']) {
    if (typeof flags[k] === 'string') {
      flags._.unshift(flags[k]);
      flags[k] = true;
    }
  }
  const dir = flags._[0];
  const usage = 'usage: browser-check.mjs <projectDir> --out <dir> [--thumb] [--seconds N] [--no-monkey] [--meta FILE] [--purpose P] [--contract]';
  if (!dir || !flags.out || flags.out === true) die(usage, 2);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) die(`not a directory: ${dir}`, 2);
  if (flags.meta === true) die(`--meta needs a file (${usage})`, 2);
  if (flags.purpose !== undefined) {
    const purposes = purposesOf(readJson(rp('ops', 'taxonomy.json'), null));
    if (flags.purpose === true || !purposes.includes(flags.purpose)) die(`--purpose must be one of ${purposes.join(', ')} (${usage})`, 2);
  }
  const report = await runBrowserCheck({
    projectDir: dir,
    outDir: flags.out,
    thumb: !!flags.thumb,
    monkey: !flags['no-monkey'],
    keyboard: !flags['no-keyboard'],
    seconds: number(flags, 'seconds', DEFAULTS.seconds),
    seed: flags.seed,
    timeoutS: number(flags, 'timeout', DEFAULTS.timeoutS, { min: 5 }),
    pageTimeoutMs: number(flags, 'page-timeout', DEFAULTS.pageTimeoutMs, { min: 500 }),
    settleMs: number(flags, 'settle', DEFAULTS.settleMs),
    thumbSettleMs: number(flags, 'thumb-settle', DEFAULTS.thumbSettleMs),
    thumbReadyTimeoutMs: number(flags, 'thumb-ready-timeout', DEFAULTS.thumbReadyTimeoutMs),
    meta: typeof flags.meta === 'string' ? flags.meta : undefined,
    purpose: typeof flags.purpose === 'string' ? flags.purpose : undefined,
    contract: flags.contract === true,
  });
  print(report);
  process.exit(report.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => die(err.stack || String(err)));
}
