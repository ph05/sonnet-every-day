// The wool renderer.
// #map is the yarn layer: linen cloth, knit stitches, night shade, coastlines. It is repainted from a private snapshot of
// the coverage grid at most ~15 times a second. #overlay holds the cheap per-frame things: card bands, ghost track,
// trails and needles. Both views sample the same 360 x 180 grid through a pixel-to-cell lookup table.
import { LAND, CITIES } from './geodata.js';

const GRID_W = 360;
const GRID_H = 180;
const CELLS = GRID_W * GRID_H;
const RAD = Math.PI / 180;
const FRESH_DAYS = 0.25; // a fresh stitch glows for a quarter of a simulated day
const GLOW_LEVELS = 4;
const ROWS_PER_OWNER = 3 + GLOW_LEVELS; // three pass-count tones, then the glow steps
const OUT_ROW = 1 + 3 * ROWS_PER_OWNER; // palette row for pixels outside the polar disc
const PAL_ROWS = OUT_ROW + 1;
const MAX_TRAIL = 1200; // floats: 600 [lon, lat] pairs
const MAX_PREVIEW = 1440;
const MIN_YARN_MS = 66;
const PULSE_MS = 1200;
const TWILIGHT = Math.sin(6 * RAD); // sun elevation band that counts as dawn or dusk
const NEUTRAL = [128, 128, 128, 1];
const SHAPES = ['circle', 'square', 'diamond'];
const LETTERS = ['A', 'B', 'C'];

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function parseColor(raw) {
  const s = String(raw || '').trim();
  let m = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.replace(/./g, (c) => c + c);
    if (h.length === 6 || h.length === 8) {
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
    }
    return null;
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/i.exec(s);
  if (!m) return null;
  let a = m[4] === undefined ? 1 : Number(m[4]);
  if (m[5]) a /= 100;
  return [clamp(Number(m[1]), 0, 255), clamp(Number(m[2]), 0, 255), clamp(Number(m[3]), 0, 255), clamp(a, 0, 1)];
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function scale(c, k) {
  return [c[0] * k, c[1] * k, c[2] * k];
}

function css(c, a) {
  return 'rgba(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ',' + (a === undefined ? (c[3] === undefined ? 1 : c[3]) : a) + ')';
}

function smooth(t) {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

// Copies up to `limit` numbers (whole [lon, lat] pairs) from a typed array or a plain one; returns how many.
function copyPairs(dst, src, limit) {
  if (!src || !src.length) return 0;
  const n = Math.min(src.length, limit) & ~1;
  for (let i = 0; i < n; i++) dst[i] = src[i];
  return n;
}

function wrapLon(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

// Small integer hash so the stitch jitter depends only on the stitch's position and the seed.
function hash2(a, b, seed) {
  let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(seed, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

// One knit stitch: two slanted legs forming a V, as a periodic tile of brightness 0 (gap) to 255 (crest of the yarn).
function makeTile(sw, sh) {
  const tile = new Uint8Array(sw * sh);
  const r = sw * 0.29;
  const legs = [
    [sw * 0.15, -sh * 0.04, sw * 0.5, sh * 0.94],
    [sw * 0.85, -sh * 0.04, sw * 0.5, sh * 0.94],
  ];
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const px = x + 0.5;
      let best = 0;
      for (let k = -1; k <= 1; k++) {
        const py = y + 0.5 + k * sh;
        for (let i = 0; i < 2; i++) {
          const [ax, ay, bx, by] = legs[i];
          const dx = bx - ax;
          const dy = by - ay;
          const t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy), 0, 1);
          const d = Math.hypot(px - (ax + dx * t), py - (ay + dy * t)) / r;
          if (d >= 1) continue;
          const v = (1 - d * d) * (0.88 + 0.12 * Math.sin(t * Math.PI * 3));
          if (v > best) best = v;
        }
      }
      tile[y * sw + x] = Math.round(255 * clamp(best, 0, 1));
    }
  }
  return tile;
}

export function createRenderer(stageEl, opts = {}) {
  const seed = Number.isFinite(opts.seed) ? opts.seed | 0 : 1011;
  let reduced = !!opts.reducedMotion;
  const mapCanvas = stageEl && stageEl.querySelector('#map');
  const overCanvas = stageEl && stageEl.querySelector('#overlay');
  if (!mapCanvas || !overCanvas) throw new Error('render: the stage needs canvas#map and canvas#overlay');
  const mapCtx = mapCanvas.getContext('2d');
  const overCtx = overCanvas.getContext('2d');
  if (!mapCtx || !overCtx) throw new Error('render: 2d canvas is not available');

  // ---- state -------------------------------------------------------------------------------------------------------
  let view = 'flat';
  let theme = null;
  let themeOk = false;
  let themeTries = 0;
  let fontFamily = 'sans-serif';
  let W = 0;
  let H = 0;
  let u = 1; // internal pixels per CSS pixel
  let cssW = 0;
  let builtView = '';
  let pxCx = 0;
  let pxCy = 0;
  let pxR = 0;
  let jumpSq = 0;
  let PX = 0;
  let PY = 0;
  let lut = null;
  let tex = null;
  let img = null;
  let img32 = null;
  let landPath = null;
  let gratPath = null;
  let equatorPath = null;
  let rimPath = null;
  let cityPts = [];
  let showLabels = false;
  const palette = new Uint32Array(PAL_ROWS * 256);
  const palRow = new Uint8Array(CELLS + 1);
  palRow[CELLS] = OUT_ROW;

  // snapshot of the last frame (the frame's own arrays are live and must not be kept)
  const hits = new Uint8Array(CELLS);
  const last = new Float32Array(CELLS);
  const owner = new Uint8Array(CELLS);
  let snapVersion = NaN;
  let snapDay = 0;
  let nightOn = false;
  let sunLat = 0;
  let sunLon = 0;
  let satCount = 0;
  const satLat = new Float64Array(3);
  const satLon = new Float64Array(3);
  const satColor = new Uint8Array(3);
  const satSel = new Uint8Array(3);
  const trailBuf = [new Float32Array(MAX_TRAIL), new Float32Array(MAX_TRAIL), new Float32Array(MAX_TRAIL)];
  const trailLen = new Int32Array(3);
  const previewBuf = new Float32Array(MAX_PREVIEW);
  let previewLen = 0;
  let previewYarn = 0;
  const focusBuf = new Float32Array(8);
  let focusCount = 0;
  let probeOn = false;
  let probeLat = 0;
  let probeLon = 0;

  // scheduling
  let yarnDirty = true;
  let overlayDirty = true;
  let lastYarnAt = 0;
  let lastOverlayAt = 0;
  let yarnInterval = MIN_YARN_MS;
  let anyGlow = false;
  let paintedDay = 0;
  let paintedShade = '';
  let rafId = 0;
  let rate = 0; // simulated days per wall-clock second, measured over windows of at least 300 ms
  let rateDay = NaN;
  let rateAt = 0;
  let frozenSun = false;
  let destroyed = false;

  // night shade lives in a small canvas that is scaled up with smoothing, so the dawn band stays soft
  const shadeCanvas = document.createElement('canvas');
  const shadeCtx = shadeCanvas.getContext('2d');
  let shadeImg = null;
  let shadeSinLat = null;
  let shadeCosLat = null;
  let shadeSinLon = null;
  let shadeCosLon = null;
  let shadeInside = null;

  // ---- theme -------------------------------------------------------------------------------------------------------
  function readTheme() {
    const cs = getComputedStyle(document.documentElement);
    let ok = true;
    const get = (name) => {
      const c = parseColor(cs.getPropertyValue(name));
      if (!c) {
        ok = false;
        return NEUTRAL;
      }
      return c;
    };
    theme = {
      cloth: get('--cloth'),
      hole: get('--cloth-hole'),
      land: get('--land'),
      city: get('--city'),
      night: get('--night'),
      grid: get('--grid'),
      glow: get('--glow'),
      fg: get('--fg'),
      surface: get('--surface'),
      accent: get('--accent'),
      yarn: [get('--yarn-0'), get('--yarn-1'), get('--yarn-2')],
    };
    themeOk = ok;
    fontFamily = cs.getPropertyValue('--font-display').trim() || 'serif';
    buildPalette();
    yarnDirty = true;
    overlayDirty = true;
    paintedShade = '';
  }

  // Row 0 is bare linen. Then, per needle: three tones for one, two and three or more passes, then the fresh-stitch glow.
  function buildPalette() {
    const bytes = new Uint8ClampedArray(palette.buffer);
    const put = (row, dark, light) => {
      for (let t = 0; t < 256; t++) {
        const c = mix(dark, light, smooth(t / 255));
        const i = (row * 256 + t) * 4;
        bytes[i] = c[0];
        bytes[i + 1] = c[1];
        bytes[i + 2] = c[2];
        bytes[i + 3] = 255;
      }
    };
    put(0, mix(theme.hole, theme.cloth, 0.55), theme.cloth);
    for (let o = 0; o < 3; o++) {
      const y = theme.yarn[o];
      const base = 1 + o * ROWS_PER_OWNER;
      const tones = [1, 0.84, 0.7];
      for (let k = 0; k < 3; k++) {
        const body = scale(y, tones[k]);
        put(base + k, scale(body, 0.5), mix(body, [255, 255, 255], 0.24));
      }
      for (let g = 0; g < GLOW_LEVELS; g++) {
        const a = ((g + 1) / (GLOW_LEVELS + 1)) * 0.6;
        put(base + 3 + g, mix(scale(y, 0.5), theme.glow, a), mix(mix(y, [255, 255, 255], 0.24), theme.glow, a));
      }
    }
    for (let t = 0; t < 256; t++) palette[OUT_ROW * 256 + t] = 0;
  }

  // ---- geometry ----------------------------------------------------------------------------------------------------
  function proj(lat, lon) {
    if (view === 'flat') {
      PX = ((lon + 180) / 360) * W;
      PY = ((90 - lat) / 180) * H;
    } else {
      const r = pxR * Math.sin(((90 - lat) * RAD) / 2);
      PX = pxCx + r * Math.sin(lon * RAD);
      PY = pxCy + r * Math.cos(lon * RAD);
    }
  }

  function radiusOf(lat) {
    return pxR * Math.sin(((90 - lat) * RAD) / 2);
  }

  function measure() {
    const rect = overCanvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const budget = rect.width < 600 ? 4e5 : 1.4e6;
    let nw;
    let nh;
    if (view === 'flat') {
      nw = Math.max(2, Math.round(rect.width * dpr));
      if ((nw * nw) / 2 > budget) nw = Math.floor(Math.sqrt(budget * 2));
      nw -= nw % 2;
      nh = nw / 2;
    } else {
      nw = Math.max(2, Math.min(Math.round(rect.width * dpr), 1024));
      if (nw * nw > budget) nw = Math.floor(Math.sqrt(budget));
      nh = nw;
    }
    const changed = nw !== W || nh !== H || view !== builtView;
    W = nw;
    H = nh;
    cssW = rect.width;
    u = W / rect.width;
    return changed;
  }

  function rebuild() {
    mapCanvas.width = W;
    mapCanvas.height = H;
    overCanvas.width = W;
    overCanvas.height = H;
    img = mapCtx.createImageData(W, H);
    img32 = new Uint32Array(img.data.buffer);
    builtView = view;
    showLabels = cssW >= 480;
    pxCx = W / 2;
    pxCy = H / 2;
    pxR = view === 'polar' ? W / 2 - (cssW >= 420 ? 17 : 4) * u : 0;
    jumpSq = Math.pow((view === 'polar' ? pxR : W) * 0.4, 2);
    buildLut();
    buildTexture();
    buildGeometry();
    buildShadeTables();
    yarnDirty = true;
    overlayDirty = true;
    paintedShade = '';
  }

  function buildLut() {
    lut = new Uint16Array(W * H);
    if (view === 'flat') {
      const colOf = new Uint16Array(W);
      for (let x = 0; x < W; x++) colOf[x] = Math.min(GRID_W - 1, Math.floor(((x + 0.5) * GRID_W) / W));
      for (let y = 0; y < H; y++) {
        const base = Math.min(GRID_H - 1, Math.floor(((y + 0.5) * GRID_H) / H)) * GRID_W;
        const o = y * W;
        for (let x = 0; x < W; x++) lut[o + x] = base + colOf[x];
      }
      return;
    }
    // inverse Lambert azimuthal equal-area: colatitude = 2 asin(r / R), longitude = atan2(dx, dy)
    const steps = 2048;
    const colatOf = new Float32Array(steps + 1);
    for (let i = 0; i <= steps; i++) colatOf[i] = (2 * Math.asin(i / steps)) / RAD;
    for (let y = 0; y < H; y++) {
      const dy = (y + 0.5 - pxCy) / pxR;
      for (let x = 0; x < W; x++) {
        const dx = (x + 0.5 - pxCx) / pxR;
        const r2 = dx * dx + dy * dy;
        if (r2 > 1) {
          lut[y * W + x] = CELLS;
          continue;
        }
        const row = Math.min(GRID_H - 1, Math.floor(colatOf[Math.round(Math.sqrt(r2) * steps)]));
        const col = Math.min(GRID_W - 1, Math.floor((Math.atan2(dx, dy) / RAD + 180) % 360));
        lut[y * W + x] = row * GRID_W + col;
      }
    }
  }

  function buildTexture() {
    const sw = Math.max(3, Math.round(3.4 * u));
    const sh = Math.max(4, Math.round(sw * 1.25));
    const tile = makeTile(sw, sh);
    tex = new Uint8Array(W * H);
    let noise = (seed ^ 305419896) | 1;
    const cols = Math.ceil(W / sw);
    const rows = Math.ceil(H / sh);
    for (let sy = 0; sy < rows; sy++) {
      for (let sx = 0; sx < cols; sx++) {
        const jitter = (hash2(sx, sy, seed) % 29) - 14;
        for (let ty = 0; ty < sh; ty++) {
          const y = sy * sh + ty;
          if (y >= H) break;
          for (let tx = 0; tx < sw; tx++) {
            const x = sx * sw + tx;
            if (x >= W) break;
            noise ^= noise << 13;
            noise ^= noise >>> 17;
            noise ^= noise << 5;
            tex[y * W + x] = clamp(tile[ty * sw + tx] + jitter + ((noise & 7) - 3), 0, 255);
          }
        }
      }
    }
  }

  function ringToPath(path, ring) {
    const n = ring.length;
    let prevLon = ring[0][0];
    let prevLat = ring[0][1];
    proj(prevLat, prevLon);
    path.moveTo(PX, PY);
    for (let i = 1; i <= n; i++) {
      const p = ring[i % n];
      if (view === 'polar') {
        // straight lon/lat edges bend in this projection, so cut long ones into short steps
        const steps = Math.ceil(Math.max(Math.abs(p[0] - prevLon), Math.abs(p[1] - prevLat)) / 2);
        for (let k = 1; k < steps; k++) {
          proj(prevLat + ((p[1] - prevLat) * k) / steps, prevLon + ((p[0] - prevLon) * k) / steps);
          path.lineTo(PX, PY);
        }
      }
      proj(p[1], p[0]);
      path.lineTo(PX, PY);
      prevLon = p[0];
      prevLat = p[1];
    }
    path.closePath();
  }

  function buildGeometry() {
    landPath = new Path2D();
    for (const land of LAND) for (const ring of land.rings) if (ring.length > 2) ringToPath(landPath, ring);
    gratPath = new Path2D();
    equatorPath = new Path2D();
    rimPath = new Path2D();
    if (view === 'flat') {
      for (let lon = -150; lon <= 150; lon += 30) {
        proj(90, lon);
        gratPath.moveTo(PX, 0);
        gratPath.lineTo(PX, H);
      }
      for (let lat = -60; lat <= 60; lat += 30) {
        proj(lat, 0);
        (lat === 0 ? equatorPath : gratPath).moveTo(0, PY);
        (lat === 0 ? equatorPath : gratPath).lineTo(W, PY);
      }
    } else {
      for (let lat = -60; lat <= 60; lat += 30) {
        const r = radiusOf(lat);
        const p = lat === 0 ? equatorPath : gratPath;
        p.moveTo(pxCx + r, pxCy);
        p.arc(pxCx, pxCy, r, 0, Math.PI * 2);
      }
      for (let lon = 0; lon < 360; lon += 30) {
        gratPath.moveTo(pxCx, pxCy);
        gratPath.lineTo(pxCx + pxR * Math.sin(lon * RAD), pxCy + pxR * Math.cos(lon * RAD));
      }
      rimPath.arc(pxCx, pxCy, pxR, 0, Math.PI * 2);
    }
    cityPts = CITIES.map((c) => {
      proj(c.lat, c.lon);
      return { name: c.name, x: PX, y: PY };
    });
  }

  function buildShadeTables() {
    const sw = view === 'flat' ? 180 : 128;
    const sh = view === 'flat' ? 90 : 128;
    shadeCanvas.width = sw;
    shadeCanvas.height = sh;
    shadeImg = shadeCtx.createImageData(sw, sh);
    const n = sw * sh;
    shadeSinLat = new Float32Array(n);
    shadeCosLat = new Float32Array(n);
    shadeSinLon = new Float32Array(n);
    shadeCosLon = new Float32Array(n);
    shadeInside = new Uint8Array(n);
    for (let j = 0; j < sh; j++) {
      for (let i = 0; i < sw; i++) {
        const k = j * sw + i;
        let lat;
        let lon;
        if (view === 'flat') {
          lat = 90 - ((j + 0.5) * 180) / sh;
          lon = -180 + ((i + 0.5) * 360) / sw;
          shadeInside[k] = 1;
        } else {
          const dx = (((i + 0.5) / sw) * W - pxCx) / pxR;
          const dy = (((j + 0.5) / sh) * H - pxCy) / pxR;
          const r2 = dx * dx + dy * dy;
          if (r2 > 1.04) continue;
          shadeInside[k] = 1;
          lat = 90 - (2 * Math.asin(Math.min(1, Math.sqrt(r2)))) / RAD;
          lon = Math.atan2(dx, dy) / RAD;
        }
        shadeSinLat[k] = Math.sin(lat * RAD);
        shadeCosLat[k] = Math.cos(lat * RAD);
        shadeSinLon[k] = Math.sin(lon * RAD);
        shadeCosLon[k] = Math.cos(lon * RAD);
      }
    }
  }

  function updateShade(lat, lon) {
    const sinD = Math.sin(lat * RAD);
    const cosD = Math.cos(lat * RAD);
    const sinS = Math.sin(lon * RAD);
    const cosS = Math.cos(lon * RAD);
    const data = shadeImg.data;
    const n = shadeInside.length;
    const nr = Math.round(theme.night[0]);
    const ng = Math.round(theme.night[1]);
    const nb = Math.round(theme.night[2]);
    const na = theme.night[3] * 255;
    for (let k = 0; k < n; k++) {
      const i = k * 4;
      if (!shadeInside[k]) {
        data[i + 3] = 0;
        continue;
      }
      const s = shadeSinLat[k] * sinD + shadeCosLat[k] * cosD * (shadeCosLon[k] * cosS + shadeSinLon[k] * sinS);
      data[i] = nr;
      data[i + 1] = ng;
      data[i + 2] = nb;
      data[i + 3] = na * smooth((TWILIGHT - s) / (2 * TWILIGHT));
    }
    shadeCtx.putImageData(shadeImg, 0, 0);
  }

  // ---- painting ----------------------------------------------------------------------------------------------------
  function paintYarn() {
    const t0 = performance.now();
    const day = snapDay;
    const glowOn = !reduced;
    let glowing = false;
    for (let c = 0; c < CELLS; c++) {
      const h = hits[c];
      if (h === 0) {
        palRow[c] = 0;
        continue;
      }
      let o = owner[c] - 1;
      o = o < 0 ? 0 : o > 2 ? 2 : o;
      const base = 1 + o * ROWS_PER_OWNER;
      if (glowOn) {
        const age = day - last[c];
        if (age < FRESH_DAYS) {
          const g = Math.min(GLOW_LEVELS - 1, Math.floor((1 - (age < 0 ? 0 : age) / FRESH_DAYS) * GLOW_LEVELS));
          palRow[c] = base + 3 + g;
          glowing = true;
          continue;
        }
      }
      palRow[c] = base + (h > 2 ? 2 : h - 1);
    }
    for (let p = 0, n = W * H; p < n; p++) img32[p] = palette[(palRow[lut[p]] << 8) | tex[p]];
    mapCtx.putImageData(img, 0, 0);

    if (nightOn) {
      const sl = frozenSun ? wrapLon(sunLon + 360 * (day - Math.floor(day))) : sunLon;
      updateShade(sunLat, sl);
      mapCtx.save();
      if (view === 'polar') {
        mapCtx.beginPath();
        mapCtx.arc(pxCx, pxCy, pxR, 0, Math.PI * 2);
        mapCtx.clip();
      }
      mapCtx.imageSmoothingEnabled = true;
      mapCtx.drawImage(shadeCanvas, 0, 0, W, H);
      mapCtx.restore();
      paintedShade = shadeKey();
    } else {
      paintedShade = '';
    }
    paintDecor();
    anyGlow = glowing;
    paintedDay = day;
    lastYarnAt = performance.now();
    yarnInterval = clamp((lastYarnAt - t0) * 5, MIN_YARN_MS, 250);
    yarnDirty = false;
  }

  // graticule, embroidered coastlines (a running stitch), city dots, labels
  function paintDecor() {
    const g = mapCtx;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.lineWidth = u;
    g.strokeStyle = css(theme.grid, 0.75);
    g.stroke(gratPath);
    g.setLineDash([6 * u, 4 * u]);
    g.strokeStyle = css(theme.grid, 1);
    g.stroke(equatorPath);
    g.setLineDash([]);
    g.fillStyle = css(theme.land, 0.13);
    g.fill(landPath, 'evenodd');
    // a pale thread under the dashes keeps the coast legible over dense wool
    g.lineWidth = 3.6 * u;
    g.strokeStyle = css(theme.cloth, 0.6);
    g.stroke(landPath);
    g.setLineDash([3.6 * u, 2.4 * u]);
    g.lineWidth = 1.8 * u;
    g.strokeStyle = css(theme.land, 1);
    g.stroke(landPath);
    g.setLineDash([]);
    if (view === 'polar') {
      g.lineWidth = 2 * u;
      g.strokeStyle = css(theme.land, 0.9);
      g.stroke(rimPath);
    }
    g.font = '600 ' + 10.5 * u + 'px ' + fontFamily;
    g.textBaseline = 'middle';
    for (const c of cityPts) {
      g.beginPath();
      g.arc(c.x, c.y, 2.3 * u, 0, Math.PI * 2);
      g.fillStyle = css(theme.city, 1);
      g.fill();
      g.lineWidth = u;
      g.strokeStyle = css(theme.cloth, 1);
      g.stroke();
      if (showLabels) {
        g.textAlign = 'left';
        g.lineWidth = 3 * u;
        g.strokeStyle = css(theme.cloth, 0.85);
        g.strokeText(c.name, c.x + 5 * u, c.y);
        g.fillStyle = css(theme.city, 1);
        g.fillText(c.name, c.x + 5 * u, c.y);
      }
    }
    if (showLabels) paintScale(g);
  }

  function paintScale(g) {
    g.font = '600 ' + 9.5 * u + 'px ' + fontFamily;
    g.fillStyle = css(theme.land, 1);
    g.strokeStyle = css(theme.cloth, 0.9);
    g.lineWidth = 3 * u;
    const tag = (text, x, y, align) => {
      g.textAlign = align;
      g.strokeText(text, x, y);
      g.fillText(text, x, y);
    };
    if (view === 'flat') {
      for (let lat = -60; lat <= 60; lat += 30) {
        proj(lat, -180);
        tag((lat > 0 ? lat + '° N' : lat < 0 ? -lat + '° S' : '0°'), 8 * u, PY - 6 * u, 'left');
      }
    } else {
      tag('0°', pxCx, H - 7 * u, 'center');
      tag('180°', pxCx, 8 * u, 'center');
      tag('90° E', W - 4 * u, pxCy, 'right');
      tag('90° W', 4 * u, pxCy, 'left');
    }
  }

  function tracePolyline(buf, from, to) {
    overCtx.beginPath();
    let started = false;
    let prevX = 0;
    let prevY = 0;
    let prevLon = 0;
    for (let i = from; i + 1 < to; i += 2) {
      const lon = buf[i];
      proj(buf[i + 1], lon);
      let jump = !started;
      if (started) {
        if (view === 'flat') jump = Math.abs(lon - prevLon) > 180;
        else jump = (PX - prevX) * (PX - prevX) + (PY - prevY) * (PY - prevY) > jumpSq;
      }
      if (jump) overCtx.moveTo(PX, PY);
      else overCtx.lineTo(PX, PY);
      started = true;
      prevX = PX;
      prevY = PY;
      prevLon = lon;
    }
  }

  function bandPath(latMin, latMax) {
    overCtx.beginPath();
    if (view === 'flat') {
      const y0 = ((90 - latMax) / 180) * H;
      const y1 = ((90 - latMin) / 180) * H;
      overCtx.rect(0, y0, W, y1 - y0);
    } else {
      overCtx.arc(pxCx, pxCy, radiusOf(latMin), 0, Math.PI * 2);
      if (latMax < 89.9) {
        overCtx.moveTo(pxCx + radiusOf(latMax), pxCy);
        overCtx.arc(pxCx, pxCy, radiusOf(latMax), 0, Math.PI * 2, true);
      }
    }
  }

  function markerShape(x, y, r, kind) {
    overCtx.beginPath();
    if (kind === 'circle') {
      overCtx.arc(x, y, r, 0, Math.PI * 2);
    } else if (kind === 'square') {
      overCtx.rect(x - r * 0.88, y - r * 0.88, r * 1.76, r * 1.76);
    } else {
      overCtx.moveTo(x, y - r * 1.2);
      overCtx.lineTo(x + r * 1.2, y);
      overCtx.lineTo(x, y + r * 1.2);
      overCtx.lineTo(x - r * 1.2, y);
      overCtx.closePath();
    }
  }

  function paintOverlay(now) {
    const g = overCtx;
    g.clearRect(0, 0, W, H);
    g.lineJoin = 'round';
    g.lineCap = 'round';

    for (let i = 0; i < focusCount; i++) {
      const lo = focusBuf[i * 2];
      const hi = focusBuf[i * 2 + 1];
      bandPath(lo, hi);
      g.fillStyle = css(theme.accent, 0.1);
      g.fill('evenodd');
      g.setLineDash([7 * u, 5 * u]);
      g.lineWidth = 1.6 * u;
      g.strokeStyle = css(theme.accent, 0.9);
      g.stroke();
      g.setLineDash([]);
    }

    if (previewLen > 3) {
      g.setLineDash([7 * u, 6 * u]);
      g.lineDashOffset = reduced ? 0 : -((now / 45) % 13) * u;
      g.lineWidth = 2 * u;
      g.strokeStyle = css(theme.yarn[previewYarn], 0.8);
      tracePolyline(previewBuf, 0, previewLen);
      g.stroke();
      g.setLineDash([]);
      g.lineDashOffset = 0;
    }

    for (let i = 0; i < satCount; i++) {
      const n = trailLen[i];
      if (n < 4) continue;
      const pairs = n >> 1;
      for (let k = 0; k < 5; k++) {
        const a = Math.max(0, Math.floor((pairs * k) / 5) - 1) * 2;
        const b = Math.floor((pairs * (k + 1)) / 5) * 2;
        g.lineWidth = (1.2 + k * 0.45) * u;
        g.globalAlpha = 0.16 + k * 0.2;
        g.strokeStyle = css(theme.yarn[satColor[i]], 1);
        tracePolyline(trailBuf[i], a, b);
        g.stroke();
      }
      g.globalAlpha = 1;
    }

    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < satCount; i++) {
        if ((satSel[i] === 1) !== (pass === 1)) continue;
        drawNeedle(i, now);
      }
    }

    if (probeOn) {
      proj(probeLat, probeLon);
      g.lineWidth = 1.6 * u;
      g.strokeStyle = css(theme.fg, 0.9);
      g.beginPath();
      g.arc(PX, PY, 6 * u, 0, Math.PI * 2);
      g.stroke();
      g.strokeStyle = css(theme.surface, 0.9);
      g.lineWidth = u;
      g.beginPath();
      g.arc(PX, PY, 7.6 * u, 0, Math.PI * 2);
      g.stroke();
    }
  }

  function drawNeedle(i, now) {
    const g = overCtx;
    proj(satLat[i], satLon[i]);
    const x = PX;
    const y = PY;
    const yarn = theme.yarn[satColor[i]];
    const sel = satSel[i] === 1;
    const r = (sel ? 7.5 : 6) * u;
    const kind = SHAPES[satColor[i]] || 'circle';
    const phase = reduced ? 0.4 : (now % PULSE_MS) / PULSE_MS;
    g.globalAlpha = reduced ? 0.55 : 0.75 * (1 - phase);
    g.lineWidth = 2 * u;
    g.strokeStyle = css(yarn, 1);
    g.beginPath();
    g.arc(x, y, r + (4 + phase * 14) * u, 0, Math.PI * 2);
    g.stroke();
    g.globalAlpha = 1;
    markerShape(x, y, r + 2.4 * u, kind);
    g.fillStyle = css(theme.surface, 0.92);
    g.fill();
    markerShape(x, y, r, kind);
    g.fillStyle = css(yarn, 1);
    g.fill();
    g.lineWidth = 1.5 * u;
    g.strokeStyle = css(theme.fg, 1);
    g.stroke();
    if (sel) {
      g.setLineDash([3 * u, 3 * u]);
      g.lineWidth = 1.2 * u;
      g.beginPath();
      g.arc(x, y, r + 5 * u, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
    }
    g.font = '700 ' + 11.5 * u + 'px ' + fontFamily;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.lineWidth = 3.2 * u;
    g.strokeStyle = css(theme.surface, 0.95);
    g.strokeText(LETTERS[satColor[i]] || '', x + r + 5 * u, y - r - 1 * u);
    g.fillStyle = css(theme.fg, 1);
    g.fillText(LETTERS[satColor[i]] || '', x + r + 5 * u, y - r - 1 * u);
  }

  function shadeKey() {
    const sl = frozenSun ? wrapLon(sunLon + 360 * (snapDay - Math.floor(snapDay))) : sunLon;
    return Math.round(sunLat * 4) + ',' + Math.round(sl * 4);
  }

  // ---- frames in ---------------------------------------------------------------------------------------------------
  // Frame times jitter, so the speed is read over a window instead of frame to frame.
  function trackRate(day, now) {
    if (!Number.isFinite(rateDay) || day < rateDay) {
      rate = 0;
      rateDay = day;
      rateAt = now;
    } else if (now - rateAt >= 300) {
      rate = (day - rateDay) / ((now - rateAt) / 1000);
      rateDay = day;
      rateAt = now;
    }
  }

  // The sun crosses the map once per simulated day. Faster than about 1.5 days per second that would strobe half the
  // screen, so the night shade then rests at its 12:00 UTC position (which only drifts with the season).
  function updateFrozen() {
    const next = frozenSun ? rate > 1.2 : rate > 1.6;
    if (next !== frozenSun) {
      frozenSun = next;
      yarnDirty = true;
    }
  }

  function ingest(frame, now) {
    const gr = frame.grid;
    if (gr && gr.hits && gr.hits.length === CELLS) {
      const ver = gr.version;
      if (!Number.isFinite(ver) || ver !== snapVersion) {
        hits.set(gr.hits);
        if (gr.owner && gr.owner.length === CELLS) owner.set(gr.owner);
        if (gr.last && gr.last.length === CELLS) last.set(gr.last);
        snapVersion = ver;
        yarnDirty = true;
      }
    }
    if (Number.isFinite(frame.day)) {
      snapDay = frame.day;
      trackRate(snapDay, now);
      updateFrozen();
    }
    const terminator = !!frame.terminator;
    if (terminator !== nightOn) yarnDirty = true;
    nightOn = terminator;
    if (frame.sun && Number.isFinite(frame.sun.lat) && Number.isFinite(frame.sun.lon)) {
      sunLat = frame.sun.lat;
      sunLon = frame.sun.lon;
      if (nightOn && shadeKey() !== paintedShade) yarnDirty = true;
    }
    if (anyGlow && Math.abs(snapDay - paintedDay) > 0.002) yarnDirty = true;

    const sats = Array.isArray(frame.sats) ? frame.sats : [];
    satCount = Math.min(3, sats.length);
    let selected = 0;
    for (let i = 0; i < satCount; i++) {
      const s = sats[i] || {};
      satLat[i] = Number.isFinite(s.lat) ? s.lat : 0;
      satLon[i] = Number.isFinite(s.lon) ? s.lon : 0;
      satColor[i] = s.color === 1 || s.color === 2 ? s.color : 0;
      satSel[i] = s.selected ? 1 : 0;
      if (s.selected) selected = satColor[i];
      trailLen[i] = copyPairs(trailBuf[i], s.trail, MAX_TRAIL);
    }
    previewLen = copyPairs(previewBuf, frame.preview, MAX_PREVIEW);
    previewYarn = selected;
    const fo = Array.isArray(frame.focus) ? frame.focus : null;
    focusCount = 0;
    if (fo) {
      for (let i = 0; i < fo.length && focusCount < 4; i++) {
        const band = fo[i];
        if (band && Number.isFinite(band[0]) && Number.isFinite(band[1])) {
          focusBuf[focusCount * 2] = Math.min(band[0], band[1]);
          focusBuf[focusCount * 2 + 1] = Math.max(band[0], band[1]);
          focusCount++;
        }
      }
    }
  }

  // ---- scheduling --------------------------------------------------------------------------------------------------
  function render(now) {
    if (destroyed || document.hidden || !W) return;
    if (!themeOk && themeTries++ < 20) readTheme();
    if (Number.isFinite(rateDay) && now - rateAt > 700) {
      rate = 0;
      rateDay = NaN;
      updateFrozen();
    }
    if (yarnDirty && now - lastYarnAt >= yarnInterval) paintYarn();
    const pulse = !reduced && satCount > 0 && now - lastOverlayAt >= 50;
    if (overlayDirty || pulse) {
      paintOverlay(now);
      overlayDirty = false;
      lastOverlayAt = now;
    }
  }

  function loop(ts) {
    rafId = 0;
    try {
      render(ts);
    } catch (err) {
      console.error('render: frame failed', err);
      return;
    }
    // While the speed window is open keep ticking until render() closes it, so a fast run that stops lets the night line go home.
    if (!destroyed && !document.hidden && (yarnDirty || overlayDirty || (!reduced && satCount > 0) || Number.isFinite(rateDay))) rafId = requestAnimationFrame(loop);
  }

  function schedule() {
    if (!rafId && !destroyed && !document.hidden) rafId = requestAnimationFrame(loop);
  }

  // ---- public ------------------------------------------------------------------------------------------------------
  function resize() {
    if (destroyed) return;
    if (measure()) rebuild();
    schedule();
  }

  function setView(v) {
    const next = v === 'polar' ? 'polar' : 'flat';
    if (next === view && builtView) return;
    view = next;
    resize();
  }

  function setTheme() {
    readTheme();
    schedule();
  }

  function draw(frame) {
    if (destroyed || !frame) return;
    if (frame.view && frame.view !== view) setView(frame.view);
    else if (!builtView) resize();
    const now = performance.now();
    ingest(frame, now);
    overlayDirty = true;
    render(now);
    schedule();
  }

  // Inverse of the projection in use; null off the map. `hits` is read from the snapshot, never from the live grid.
  function pick(clientX, clientY) {
    if (!W) return null;
    const rect = overCanvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    const x = ((clientX - rect.left) / rect.width) * W;
    const y = ((clientY - rect.top) / rect.height) * H;
    let lat;
    let lon;
    if (view === 'flat') {
      if (x < 0 || y < 0 || x >= W || y >= H) return null;
      lon = (x / W) * 360 - 180;
      lat = 90 - (y / H) * 180;
    } else {
      const dx = (x - pxCx) / pxR;
      const dy = (y - pxCy) / pxR;
      const r = Math.sqrt(dx * dx + dy * dy);
      if (r > 1) return null;
      lat = 90 - (2 * Math.asin(r)) / RAD;
      lon = Math.atan2(dx, dy) / RAD;
    }
    const row = clamp(Math.floor(90 - lat), 0, GRID_H - 1);
    const col = clamp(Math.floor(lon + 180), 0, GRID_W - 1);
    return { lat, lon, row, col, hits: hits[row * GRID_W + col] };
  }

  // A small ring on the stitch being inspected; null clears it.
  function probe(p) {
    const on = !!p;
    if (on) {
      probeLat = p.lat;
      probeLon = p.lon;
    }
    if (on || probeOn) {
      probeOn = on;
      overlayDirty = true;
      schedule();
    }
  }

  function destroy() {
    destroyed = true;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    if (ro) ro.disconnect();
    window.removeEventListener('resize', onWindowResize);
    document.removeEventListener('visibilitychange', onVisibility);
    if (schemeQuery) schemeQuery.removeEventListener('change', onScheme);
    if (motionQuery) motionQuery.removeEventListener('change', onMotion);
    clearTimeout(resizeTimer);
  }

  // ---- environment -------------------------------------------------------------------------------------------------
  let resizeTimer = 0;
  function onWindowResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 120);
  }
  function onVisibility() {
    if (!document.hidden) {
      yarnDirty = true;
      overlayDirty = true;
      rateAt = performance.now();
      schedule();
    }
  }
  function onScheme() {
    setTheme();
  }
  function onMotion(e) {
    reduced = e.matches;
    yarnDirty = true;
    overlayDirty = true;
    schedule();
  }

  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(onWindowResize);
    ro.observe(stageEl);
  } else {
    window.addEventListener('resize', onWindowResize);
  }
  document.addEventListener('visibilitychange', onVisibility);
  const schemeQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  const motionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  if (schemeQuery) schemeQuery.addEventListener('change', onScheme);
  if (motionQuery) motionQuery.addEventListener('change', onMotion);

  readTheme();
  resize();

  return {
    resize,
    setView,
    setTheme,
    draw,
    pick,
    probe,
    isSunFrozen: () => frozenSun && nightOn,
    destroy,
  };
}
