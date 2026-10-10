// Tier 4 "Postcard": a deterministic generative page seeded by the date (CONTRACT 6.8).
// The compositions live in site-src/fallback/postcard-scene.js, a classic script shared with the browser;
// this module evaluates it in a vm context, rasterizes it into the 1200x630 thumbnail without a browser,
// and assembles the page files.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { Canvas, measureText, parseColor, mixColors, toHex } from './png.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Page templates and browser scripts ship with the code, not with SED_ROOT, so sandboxes find them too. */
export const FALLBACK_ASSET_DIR = path.resolve(HERE, '..', '..', 'site-src', 'fallback');

export const THUMB_WIDTH = 1200;
export const THUMB_HEIGHT = 630;

export function readAsset(name) {
  return fs.readFileSync(path.join(FALLBACK_ASSET_DIR, name), 'utf8');
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/** JSON that is safe inside <script type="application/json">: no way to close the tag or start a comment. */
export function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Fills `{{NAME}}` (HTML-escaped) and `{{&NAME}}` (raw, for markup this code generated itself) placeholders.
 * An unknown placeholder is a bug in the template, so it throws instead of shipping literal braces.
 */
export function fillTemplate(template, values) {
  return template.replace(/\{\{(&?)([A-Z0-9_]+)\}\}/g, (_, raw, name) => {
    if (!Object.hasOwn(values, name)) throw new Error(`template placeholder {{${raw}${name}}} has no value`);
    return raw ? String(values[name]) : escapeHtml(values[name]);
  });
}

let cachedApi = null;
let cachedSource = null;

/** Evaluates the shared scene script once. The sandbox has no I/O: it can only compute. */
export function sceneApi() {
  if (!cachedApi) {
    cachedSource = readAsset('postcard-scene.js');
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(cachedSource, sandbox, { filename: 'postcard-scene.js', timeout: 5000 });
    cachedApi = sandbox.SEDPostcard;
    if (!cachedApi) throw new Error('postcard-scene.js did not define SEDPostcard');
  }
  return cachedApi;
}

export function buildScene(date) {
  return sceneApi().buildScene(date);
}

/** Draws scene items (see postcard-scene.js) onto a png.mjs Canvas. */
export function drawItems(cv, items) {
  for (const it of items) {
    const mode = it.m ?? 'normal';
    const alpha = (v) => (v === undefined ? 1 : v);
    switch (it.k) {
      case 'bg': {
        const ang = ((it.ang ?? 0) * Math.PI) / 180;
        const dx = Math.cos(ang);
        const dy = Math.sin(ang);
        const half = (Math.abs(cv.width * dx) + Math.abs(cv.height * dy)) / 2;
        const cx = cv.width / 2;
        const cy = cv.height / 2;
        cv.fillLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half, it.stops);
        break;
      }
      case 'glow':
        cv.glow(it.x, it.y, it.r, it.c, it.a, { mode, scaleY: it.sy ?? 1 });
        break;
      case 'circle':
        if (it.f) cv.fillCircle(it.x, it.y, it.r, it.f, alpha(it.fa), mode);
        if (it.s) cv.strokeCircle(it.x, it.y, it.r, it.sw ?? 1, it.s, alpha(it.sa), mode);
        break;
      case 'path':
        cv.strokePath(it.p, it.w, it.c, alpha(it.a), { closed: !!it.closed, mode });
        break;
      case 'segs':
        cv.strokeSegments(it.p, it.w, it.c, alpha(it.a), mode);
        break;
      case 'poly':
        cv.fillPolygon(it.p, it.c, alpha(it.a), mode);
        if (it.s) cv.strokePath(it.p, it.sw ?? 1, it.s, alpha(it.sa), { closed: true, mode });
        break;
      case 'rect':
        if (it.r) cv.fillRoundRect(it.x, it.y, it.w, it.h, it.r, it.c, alpha(it.a), mode);
        else cv.fillRect(it.x, it.y, it.w, it.h, it.c, alpha(it.a), mode);
        break;
      default:
        throw new Error(`unknown scene item kind ${JSON.stringify(it.k)}`);
    }
  }
}

/** The day's picture rendered at the scene's "still" moment. */
export function renderSceneCanvas(scene, width = THUMB_WIDTH, height = THUMB_HEIGHT) {
  if (width !== scene.W || height !== scene.H) throw new RangeError(`scene is ${scene.W}x${scene.H}`);
  const cv = new Canvas(width, height, scene.palette.bg[0]);
  drawItems(cv, scene.frame(scene.stillT));
  return cv;
}

/** The thumbnail: the day's art with a small label panel and the site name. Opaque PNG under the size cap. */
export function renderPostcardThumb({ date, day, maxBytes = 300_000 }) {
  const api = sceneApi();
  const scene = api.buildScene(date);
  const cv = renderSceneCanvas(scene);
  const pal = scene.palette;
  const ink = pal.light ? '#1b1712' : '#ffffff';
  const sub = pal.light ? '#3b3128' : '#e8e8f0';
  const panelFill = pal.light ? '#fbf7ef' : '#05060c';

  const title = 'POSTCARD';
  const dateLine = api.dateLabel(date).toUpperCase();
  const note = `DAY ${day}  -  ${scene.familyName.toUpperCase()}`;
  const tScale = 9;
  const dScale = 3;
  const nScale = 3;
  const padX = 34;
  const wide = Math.max(measureText(title, tScale), measureText(dateLine, dScale), measureText(note, nScale));
  const panelW = wide + padX * 2;
  const panelH = 7 * tScale + 7 * dScale + 7 * nScale + 34 * 2 + 28;
  const px = 52;
  const py = THUMB_HEIGHT - panelH - 52;
  cv.fillRoundRect(px, py, panelW, panelH, 22, panelFill, pal.light ? 0.82 : 0.66);
  cv.fillRect(px + padX, py + 30, 7 * tScale * 0.9, 4, pal.accent, 1);
  cv.text(title, px + padX, py + 46, { scale: tScale, color: ink });
  cv.text(dateLine, px + padX, py + 46 + 7 * tScale + 18, { scale: dScale, color: sub });
  cv.text(note, px + padX, py + 46 + 7 * tScale + 18 + 7 * dScale + 14, { scale: nScale, color: pal.accent });
  cv.text('SONNET EVERY DAY', THUMB_WIDTH - 52, THUMB_HEIGHT - 52 - 7 * 3, {
    scale: 3, color: ink, align: 'right', shadow: { dx: 2, dy: 2, color: pal.light ? '#ffffff' : '#000000', alpha: 0.5 },
  });
  return cv.toPng({ maxBytes });
}

function countLines(text) {
  return text.split('\n').filter((l) => l.trim()).length;
}

/** Palette for project.json: a dark first color is what the gallery uses for ink. */
function projectPalette(pal) {
  const first = pal.light ? toHex(mixColors(pal.ink[0], '#000000', 0.62)) : pal.bg[0];
  return [first, pal.ink[0], pal.accent];
}

/**
 * Everything that goes into docs/d/<date>-postcard/ except project.json's stats (the caller fills those in).
 * @returns {{files: Record<string, Buffer|string>, project: object, scene: object}}
 */
export function renderPostcard({ date, day, siteName = 'Sonnet Every Day', maxThumbBytes }) {
  const api = sceneApi();
  const scene = api.buildScene(date);
  const pal = scene.palette;
  const note = api.buildNote(scene);
  const dateLabel = api.dateLabel(date);
  const svg = api.toSvg(scene);
  const seedHex = scene.seed.toString(16).padStart(8, '0');
  const swatches = [pal.bg[1], ...pal.ink, pal.accent]
    .map((c) => `<li style="--sw:${escapeHtml(c)}"><span class="sr">${escapeHtml(c)}</span></li>`)
    .join('');
  const [r, g, b] = parseColor(pal.bg[pal.light ? 1 : 0]);
  const html = fillTemplate(readAsset('postcard.template.html'), {
    TITLE: `Postcard: ${scene.familyName}`,
    DATE: date,
    DATE_LABEL: dateLabel,
    DAY: String(day),
    NOTE: note,
    FAMILY: scene.familyName,
    BLURB: scene.blurb,
    HUE: String(pal.hue),
    ACCENT: pal.accent,
    ART_BG: toHex([r, g, b]),
    SEED_HEX: seedHex,
    SITE_NAME: siteName,
    SWATCHES: swatches,
    SVG: svg,
  });
  const files = {
    'index.html': html,
    'postcard.css': readAsset('postcard.css'),
    'postcard-scene.js': cachedSource,
    'postcard.js': readAsset('postcard.js'),
    'thumb.png': renderPostcardThumb({ date, day, maxBytes: maxThumbBytes }),
  };
  const tagline = `No full build today, so here is a postcard: ${scene.blurb}.`;
  const project = {
    schema: 1,
    date,
    slug: 'postcard',
    title: `Postcard: ${scene.familyName}`,
    tagline: tagline.length > 120 ? `${tagline.slice(0, 117).trimEnd()}...` : tagline,
    description: `Today's full build did not finish, so this page is a generative postcard instead: ${scene.familyName.toLowerCase()}, drawn from the date alone, animated, with a still SVG for reduced-motion and no-script visitors. Full builds resume tomorrow.`,
    tier: 4,
    fingerprint: {
      category: 'generative-art',
      mechanic: 'generator',
      tone: ['serene', 'playful'],
      tech: ['canvas2d', 'svg'],
      tags: ['postcard', 'generative-art', 'fallback-day', scene.family],
      keywords: ['seeded-by-date', 'procedural', 'animation'],
      slot: 'wildcard',
      political: false,
    },
    palette: projectPalette(pal),
    entry: 'index.html',
    thumb: 'thumb.png',
    network: [],
    sources: [],
    makingOf: `A safety-net page. The composition (${scene.familyName}) and its palette (${pal.scheme}, hue ${pal.hue}) are chosen from the date ${date} alone (seed ${seedHex}), so the same day always draws the same picture. One scene description feeds the animated canvas, the static SVG and the thumbnail. No research and no network.`,
    stats: { files: 0, bytes: 0, ownLoc: 0 },
    credits: `Built by the ${siteName} team`,
  };
  project.stats.ownLoc = ['index.html', 'postcard.css', 'postcard.js'].reduce((n, f) => n + countLines(files[f]), 0) + countLines(files['postcard-scene.js']);
  return { files, project, scene };
}
