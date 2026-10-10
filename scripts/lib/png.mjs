// Pure-Node PNG encoder and a small software rasterizer. Exists so thumbnails can be produced when
// Chromium is missing (CONTRACT 6.8): zlib deflate + CRC32 for the container, an anti-aliased canvas
// (circles, strokes, polygons, gradients, glows) and a scalable 5x7 bitmap font for the pixels.
import zlib from 'node:zlib';

// ---------------------------------------------------------------------------------------------
// PNG container
// ---------------------------------------------------------------------------------------------

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Applies PNG row filters. Adaptive mode picks, per row, the filter with the smallest sum of absolute residuals. */
function filterRows(px, stride, height, bpp, adaptive) {
  const out = Buffer.alloc((stride + 1) * height);
  if (!adaptive) {
    for (let y = 0; y < height; y++) px.copy(out, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    return out;
  }
  const zero = Buffer.alloc(stride);
  const cand = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));
  for (let y = 0; y < height; y++) {
    const row = px.subarray(y * stride, (y + 1) * stride);
    const prev = y ? px.subarray((y - 1) * stride, y * stride) : zero;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      const v = row[i];
      cand[0][i] = v;
      cand[1][i] = (v - a) & 255;
      cand[2][i] = (v - b) & 255;
      cand[3][i] = (v - ((a + b) >> 1)) & 255;
      cand[4][i] = (v - paeth(a, b, c)) & 255;
    }
    let best = 0;
    let bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      let sum = 0;
      const r = cand[f];
      for (let i = 0; i < stride; i++) sum += r[i] < 128 ? r[i] : 256 - r[i];
      if (sum < bestSum) {
        bestSum = sum;
        best = f;
      }
    }
    const o = y * (stride + 1);
    out[o] = best;
    cand[best].copy(out, o + 1);
  }
  return out;
}

function deflate(raw) {
  const a = zlib.deflateSync(raw, { level: 9, memLevel: 9 });
  const b = zlib.deflateSync(raw, { level: 9, memLevel: 9, strategy: zlib.constants.Z_FILTERED });
  return b.length < a.length ? b : a;
}

function assemble(width, height, colorType, idat, plte) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const parts = [SIGNATURE, chunk('IHDR', ihdr)];
  if (plte) parts.push(chunk('PLTE', plte));
  parts.push(chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function checkDims(width, height, rgba) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384) {
    throw new RangeError(`encodePng: bad dimensions ${width}x${height}`);
  }
  if (!rgba || rgba.length !== width * height * 4) {
    throw new RangeError(`encodePng: expected ${width * height * 4} RGBA bytes, got ${rgba ? rgba.length : 'none'}`);
  }
}

function encodeTruecolor(width, height, rgba) {
  let opaque = true;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) {
      opaque = false;
      break;
    }
  }
  if (!opaque) {
    const px = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.length);
    return assemble(width, height, 6, deflate(filterRows(px, width * 4, height, 4, true)));
  }
  const px = Buffer.alloc(width * height * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    px[j] = rgba[i];
    px[j + 1] = rgba[i + 1];
    px[j + 2] = rgba[i + 2];
  }
  return assemble(width, height, 2, deflate(filterRows(px, width * 3, height, 3, true)));
}

/**
 * Median-cut quantizer over 5-bit-per-channel buckets. Returns { palette: Uint8Array(n*3), indices: Uint8Array }.
 * Alpha is ignored: callers quantize opaque art.
 */
export function quantize(width, height, rgba, maxColors = 256) {
  const buckets = new Map();
  for (let i = 0; i < rgba.length; i += 4) {
    const key = ((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3);
    let b = buckets.get(key);
    if (!b) {
      b = { key, n: 0, r: 0, g: 0, b: 0 };
      buckets.set(key, b);
    }
    b.n++;
    b.r += rgba[i];
    b.g += rgba[i + 1];
    b.b += rgba[i + 2];
  }
  const items = [...buckets.values()].map((b) => ({ key: b.key, n: b.n, r: b.r / b.n, g: b.g / b.n, b: b.b / b.n, sr: b.r, sg: b.g, sb: b.b }));
  let boxes = [items];
  const channels = ['r', 'g', 'b'];
  const range = (box) => {
    const lo = [255, 255, 255];
    const hi = [0, 0, 0];
    for (const it of box) {
      channels.forEach((c, k) => {
        if (it[c] < lo[k]) lo[k] = it[c];
        if (it[c] > hi[k]) hi[k] = it[c];
      });
    }
    return hi.map((h, k) => h - lo[k]);
  };
  const weight = (box) => {
    let n = 0;
    for (const it of box) n += it.n;
    return n;
  };
  while (boxes.length < maxColors) {
    let target = -1;
    let targetScore = 0;
    boxes.forEach((box, idx) => {
      if (box.length < 2) return;
      const score = Math.max(...range(box)) * Math.sqrt(weight(box));
      if (score > targetScore) {
        targetScore = score;
        target = idx;
      }
    });
    if (target < 0) break;
    const box = boxes[target];
    const r = range(box);
    const ch = channels[r.indexOf(Math.max(...r))];
    box.sort((p, q) => p[ch] - q[ch]);
    const half = weight(box) / 2;
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < box.length - 1; i++) {
      acc += box[i].n;
      cut = i + 1;
      if (acc >= half) break;
    }
    boxes.splice(target, 1, box.slice(0, cut), box.slice(cut));
  }
  const palette = new Uint8Array(boxes.length * 3);
  boxes.forEach((box, i) => {
    let n = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    for (const it of box) {
      n += it.n;
      r += it.sr;
      g += it.sg;
      b += it.sb;
    }
    palette[i * 3] = Math.round(r / n);
    palette[i * 3 + 1] = Math.round(g / n);
    palette[i * 3 + 2] = Math.round(b / n);
  });
  // Every bucket maps to its nearest palette entry (computed once per bucket, not per pixel).
  const lookup = new Int16Array(32768).fill(-1);
  const nearest = (r, g, b) => {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < palette.length; i += 3) {
      const dr = r - palette[i];
      const dg = g - palette[i + 1];
      const db = b - palette[i + 2];
      const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
      if (d < bestD) {
        bestD = d;
        best = i / 3;
      }
    }
    return best;
  };
  for (const it of items) lookup[it.key] = nearest(it.r, it.g, it.b);
  const indices = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    indices[p] = lookup[((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3)];
  }
  return { palette, indices };
}

function encodeIndexed(width, height, indices, palette) {
  const px = Buffer.from(indices.buffer, indices.byteOffset, indices.length);
  return assemble(width, height, 3, deflate(filterRows(px, width, height, 1, false)), Buffer.from(palette));
}

/**
 * Encodes straight-alpha RGBA bytes as a PNG. Opaque images become 24-bit RGB with adaptive row filters.
 * With `maxBytes`, it falls back to coarser variants until the file fits: dropping 1, 2 and 3 low bits per
 * channel (gradients turn into long runs the row filters collapse), then 256 down to 32 palette colors.
 * It returns the smallest candidate if none fits.
 */
export function encodePng(width, height, rgba, { maxBytes } = {}) {
  checkDims(width, height, rgba);
  let best = encodeTruecolor(width, height, rgba);
  if (!maxBytes || best.length <= maxBytes) return best;
  const keep = (candidate) => {
    if (candidate.length < best.length) best = candidate;
    return best.length <= maxBytes;
  };
  for (const mask of [0xfe, 0xfc, 0xf8]) {
    const reduced = new Uint8ClampedArray(rgba.length);
    for (let i = 0; i < rgba.length; i++) reduced[i] = i % 4 === 3 ? rgba[i] : rgba[i] & mask;
    if (keep(encodeTruecolor(width, height, reduced))) return best;
  }
  for (const colors of [256, 128, 64, 32]) {
    const { palette, indices } = quantize(width, height, rgba, colors);
    if (keep(encodeIndexed(width, height, indices, palette))) break;
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------------------------

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** '#rgb' | '#rrggbb' | [r,g,b] | [r,g,b,a(0..1)] => [r,g,b,a]. */
export function parseColor(c) {
  if (Array.isArray(c)) return [c[0], c[1], c[2], c.length > 3 ? c[3] : 1];
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(c));
  if (!m) throw new TypeError(`bad color: ${JSON.stringify(c)}`);
  let h = m[1];
  if (h.length === 3) h = [...h].map((x) => x + x).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
}

export function toHex(c) {
  const [r, g, b] = parseColor(c);
  return `#${[r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('')}`;
}

export function mixColors(a, b, t) {
  const p = parseColor(a);
  const q = parseColor(b);
  return [0, 1, 2, 3].map((i) => p[i] + (q[i] - p[i]) * t);
}

/** h in degrees, s and l in 0..1 => [r,g,b] 0..255. */
export function hslToRgb(h, s, l) {
  const hh = (((h % 360) + 360) % 360) / 360;
  const f = (n) => {
    const k = (n + hh * 12) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** Gradient stops: [[t, color], ...] with t ascending in 0..1. Returns a 1024-entry lookup of [r,g,b,a]. */
function stopLut(stops) {
  const parsed = stops.map(([t, c]) => [t, parseColor(c)]);
  const lut = new Float32Array(1024 * 4);
  for (let i = 0; i < 1024; i++) {
    const t = i / 1023;
    let k = 0;
    while (k < parsed.length - 2 && t > parsed[k + 1][0]) k++;
    const [t0, c0] = parsed[k];
    const [t1, c1] = parsed[Math.min(k + 1, parsed.length - 1)];
    const u = t1 === t0 ? 0 : clamp((t - t0) / (t1 - t0), 0, 1);
    for (let j = 0; j < 4; j++) lut[i * 4 + j] = c0[j] + (c1[j] - c0[j]) * u;
  }
  return lut;
}

// ---------------------------------------------------------------------------------------------
// 5x7 bitmap font (upper case; lower case is drawn as upper case)
// ---------------------------------------------------------------------------------------------

const GLYPH_SRC = {
  ' ': '...../...../...../...../...../...../.....',
  '!': '..#../..#../..#../..#../..#../...../..#..',
  '"': '.#.#./.#.#./...../...../...../...../.....',
  '#': '.#.#./.#.#./#####/.#.#./#####/.#.#./.#.#.',
  $: '..#../.####/#.#../.###./..#.#/####./..#..',
  '%': '##..#/##..#/...#./..#../.#.../#..##/#..##',
  '&': '.##../#..#./#.#../.#.../#.#.#/#..#./.##.#',
  "'": '..#../..#../.#.../...../...../...../.....',
  '(': '...#./..#../.#.../.#.../.#.../..#../...#.',
  ')': '.#.../..#../...#./...#./...#./..#../.#...',
  '*': '...../..#../#.#.#/.###./#.#.#/..#../.....',
  '+': '...../..#../..#../#####/..#../..#../.....',
  ',': '...../...../...../...../..##./...#./..#..',
  '-': '...../...../...../#####/...../...../.....',
  '.': '...../...../...../...../...../.##../.##..',
  '/': '....#/....#/...#./..#../.#.../#..../#....',
  0: '.###./#...#/#..##/#.#.#/##..#/#...#/.###.',
  1: '..#../.##../..#../..#../..#../..#../.###.',
  2: '.###./#...#/....#/...#./..#../.#.../#####',
  3: '#####/...#./..#../...#./....#/#...#/.###.',
  4: '...#./..##./.#.#./#..#./#####/...#./...#.',
  5: '#####/#..../####./....#/....#/#...#/.###.',
  6: '..##./.#.../#..../####./#...#/#...#/.###.',
  7: '#####/....#/...#./..#../.#.../.#.../.#...',
  8: '.###./#...#/#...#/.###./#...#/#...#/.###.',
  9: '.###./#...#/#...#/.####/....#/...#./.##..',
  ':': '...../.##../.##../...../.##../.##../.....',
  ';': '...../.##../.##../...../.##../..#../.#...',
  '<': '...#./..#../.#.../#..../.#.../..#../...#.',
  '=': '...../...../#####/...../#####/...../.....',
  '>': '.#.../..#../...#./....#/...#./..#../.#...',
  '?': '.###./#...#/....#/...#./..#../...../..#..',
  '@': '.###./#...#/#.###/#.#.#/#.###/#..../.###.',
  A: '.###./#...#/#...#/#####/#...#/#...#/#...#',
  B: '####./#...#/#...#/####./#...#/#...#/####.',
  C: '.###./#...#/#..../#..../#..../#...#/.###.',
  D: '####./#...#/#...#/#...#/#...#/#...#/####.',
  E: '#####/#..../#..../####./#..../#..../#####',
  F: '#####/#..../#..../####./#..../#..../#....',
  G: '.###./#...#/#..../#.###/#...#/#...#/.###.',
  H: '#...#/#...#/#...#/#####/#...#/#...#/#...#',
  I: '.###./..#../..#../..#../..#../..#../.###.',
  J: '..###/...#./...#./...#./...#./#..#./.##..',
  K: '#...#/#..#./#.#../##.../#.#../#..#./#...#',
  L: '#..../#..../#..../#..../#..../#..../#####',
  M: '#...#/##.##/#.#.#/#.#.#/#...#/#...#/#...#',
  N: '#...#/##..#/#.#.#/#..##/#...#/#...#/#...#',
  O: '.###./#...#/#...#/#...#/#...#/#...#/.###.',
  P: '####./#...#/#...#/####./#..../#..../#....',
  Q: '.###./#...#/#...#/#...#/#.#.#/#..#./.##.#',
  R: '####./#...#/#...#/####./#.#../#..#./#...#',
  S: '.####/#..../#..../.###./....#/....#/####.',
  T: '#####/..#../..#../..#../..#../..#../..#..',
  U: '#...#/#...#/#...#/#...#/#...#/#...#/.###.',
  V: '#...#/#...#/#...#/#...#/#...#/.#.#./..#..',
  W: '#...#/#...#/#...#/#.#.#/#.#.#/##.##/#...#',
  X: '#...#/#...#/.#.#./..#../.#.#./#...#/#...#',
  Y: '#...#/#...#/.#.#./..#../..#../..#../..#..',
  Z: '#####/....#/...#./..#../.#.../#..../#####',
  '[': '.###./.#.../.#.../.#.../.#.../.#.../.###.',
  '\\': '#..../#..../.#.../..#../...#./....#/....#',
  ']': '.###./...#./...#./...#./...#./...#./.###.',
  '^': '..#../.#.#./#...#/...../...../...../.....',
  _: '...../...../...../...../...../...../#####',
  '`': '.#.../..#../...../...../...../...../.....',
  '{': '..##./..#../..#../.#.../..#../..#../..##.',
  '|': '..#../..#../..#../..#../..#../..#../..#..',
  '}': '.##../..#../..#../...#./..#../..#../.##..',
  '~': '...../...../.#.../#.#.#/...#./...../.....',
  '?box': '#####/#...#/#...#/#...#/#...#/#...#/#####',
};

const GLYPHS = new Map(Object.entries(GLYPH_SRC).map(([ch, src]) => [ch, src.split('/').map((row) => [...row].map((c) => c === '#'))]));

const TRANSLITERATE = new Map([
  ['‘', "'"], ['’', "'"], ['“', '"'], ['”', '"'], ['–', '-'], ['—', '-'], ['−', '-'],
  ['·', '.'], ['•', '.'], ['…', '.'], ['→', '>'], ['←', '<'], ['×', 'X'], [' ', ' '],
]);

function glyphFor(ch) {
  let c = TRANSLITERATE.get(ch) ?? ch;
  if (!GLYPHS.has(c)) {
    const base = c.normalize('NFKD').replace(/[̀-ͯ]/g, '');
    c = base.length === 1 ? base : c;
  }
  c = c.toUpperCase();
  return GLYPHS.get(c) ?? GLYPHS.get('?box');
}

/** Width in pixels of `str` at integer `scale` with `spacing` empty glyph-pixels between letters. */
export function measureText(str, scale = 1, spacing = 1) {
  const n = [...String(str)].length;
  return n ? (n * (5 + spacing) - spacing) * scale : 0;
}

/** Text height in pixels at `scale`. */
export const textHeight = (scale = 1) => 7 * scale;

// ---------------------------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------------------------

function blend(d, i, r, g, b, a, mode) {
  if (a <= 0) return;
  switch (mode) {
    case 'add':
      d[i] += r * a;
      d[i + 1] += g * a;
      d[i + 2] += b * a;
      break;
    case 'screen':
      d[i] += (255 - d[i]) * ((r * a) / 255);
      d[i + 1] += (255 - d[i + 1]) * ((g * a) / 255);
      d[i + 2] += (255 - d[i + 2]) * ((b * a) / 255);
      break;
    case 'multiply':
      d[i] *= 1 - a + (a * r) / 255;
      d[i + 1] *= 1 - a + (a * g) / 255;
      d[i + 2] *= 1 - a + (a * b) / 255;
      break;
    default:
      d[i] += (r - d[i]) * a;
      d[i + 1] += (g - d[i + 1]) * a;
      d[i + 2] += (b - d[i + 2]) * a;
  }
}

/** An opaque RGBA surface with anti-aliased drawing primitives. Coordinates are pixels (floats allowed). */
export class Canvas {
  constructor(width, height, background = [0, 0, 0]) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new RangeError('Canvas: bad size');
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
    const [r, g, b] = parseColor(background);
    for (let i = 0; i < this.data.length; i += 4) {
      this.data[i] = r;
      this.data[i + 1] = g;
      this.data[i + 2] = b;
      this.data[i + 3] = 255;
    }
  }

  toPng(opts) {
    return encodePng(this.width, this.height, this.data, opts);
  }

  pixel(x, y) {
    const i = (y * this.width + x) * 4;
    return [this.data[i], this.data[i + 1], this.data[i + 2]];
  }

  #src(color, alpha) {
    const [r, g, b, a] = parseColor(color);
    return [r, g, b, a * alpha];
  }

  /** Per-pixel coverage callback over a clipped integer box. */
  #paint(x0, y0, x1, y1, color, alpha, mode, coverage) {
    const [r, g, b, a] = this.#src(color, alpha);
    const { width, height, data } = this;
    const ax = Math.max(0, Math.floor(x0));
    const ay = Math.max(0, Math.floor(y0));
    const bx = Math.min(width, Math.ceil(x1));
    const by = Math.min(height, Math.ceil(y1));
    for (let y = ay; y < by; y++) {
      for (let x = ax; x < bx; x++) {
        const cov = coverage(x + 0.5, y + 0.5);
        if (cov > 0) blend(data, (y * width + x) * 4, r, g, b, a * cov, mode);
      }
    }
  }

  fillRect(x, y, w, h, color, alpha = 1, mode = 'normal') {
    this.#paint(x, y, x + w, y + h, color, alpha, mode, (px, py) => {
      const cx = Math.min(px + 0.5, x + w) - Math.max(px - 0.5, x);
      const cy = Math.min(py + 0.5, y + h) - Math.max(py - 0.5, y);
      return clamp(cx, 0, 1) * clamp(cy, 0, 1);
    });
  }

  fillRoundRect(x, y, w, h, radius, color, alpha = 1, mode = 'normal') {
    const r = Math.min(radius, w / 2, h / 2);
    const cx = x + w / 2;
    const cy = y + h / 2;
    const hx = w / 2 - r;
    const hy = h / 2 - r;
    this.#paint(x - 1, y - 1, x + w + 1, y + h + 1, color, alpha, mode, (px, py) => {
      const qx = Math.abs(px - cx) - hx;
      const qy = Math.abs(py - cy) - hy;
      const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
      return clamp(0.5 - d, 0, 1);
    });
  }

  fillCircle(cx, cy, r, color, alpha = 1, mode = 'normal') {
    this.#paint(cx - r - 1, cy - r - 1, cx + r + 1, cy + r + 1, color, alpha, mode, (px, py) => clamp(0.5 - (Math.hypot(px - cx, py - cy) - r), 0, 1));
  }

  strokeCircle(cx, cy, r, width, color, alpha = 1, mode = 'normal') {
    const hw = width / 2;
    this.#paint(cx - r - hw - 1, cy - r - hw - 1, cx + r + hw + 1, cy + r + hw + 1, color, alpha, mode, (px, py) => clamp(0.5 - (Math.abs(Math.hypot(px - cx, py - cy) - r) - hw), 0, 1));
  }

  /**
   * Strokes a polyline [x0,y0,x1,y1,...] with round caps and joins. Coverage is merged with max() and
   * composited once, so translucent strokes do not darken where segments overlap.
   */
  strokePath(pts, width, color, alpha = 1, { closed = false, mode = 'normal' } = {}) {
    const n = pts.length / 2;
    if (n < 1) return;
    const segs = [];
    for (let i = 0; i + 1 < n; i++) segs.push([pts[i * 2], pts[i * 2 + 1], pts[i * 2 + 2], pts[i * 2 + 3]]);
    if (closed && n > 2) segs.push([pts[n * 2 - 2], pts[n * 2 - 1], pts[0], pts[1]]);
    if (n === 1) segs.push([pts[0], pts[1], pts[0], pts[1]]);
    this.#strokeSegments(segs, width, color, alpha, mode);
  }

  /** Independent segments [x1,y1,x2,y2, ...] sharing one style. */
  strokeSegments(pts, width, color, alpha = 1, mode = 'normal') {
    const segs = [];
    for (let i = 0; i + 3 < pts.length; i += 4) segs.push([pts[i], pts[i + 1], pts[i + 2], pts[i + 3]]);
    this.#strokeSegments(segs, width, color, alpha, mode);
  }

  line(x1, y1, x2, y2, width, color, alpha = 1, mode = 'normal') {
    this.#strokeSegments([[x1, y1, x2, y2]], width, color, alpha, mode);
  }

  #strokeSegments(segs, width, color, alpha, mode) {
    if (!segs.length) return;
    const hw = Math.max(width, 0.1) / 2;
    const pad = hw + 1;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x1, y1, x2, y2] of segs) {
      minX = Math.min(minX, x1, x2);
      maxX = Math.max(maxX, x1, x2);
      minY = Math.min(minY, y1, y2);
      maxY = Math.max(maxY, y1, y2);
    }
    const bx0 = Math.max(0, Math.floor(minX - pad));
    const by0 = Math.max(0, Math.floor(minY - pad));
    const bx1 = Math.min(this.width, Math.ceil(maxX + pad));
    const by1 = Math.min(this.height, Math.ceil(maxY + pad));
    const bw = bx1 - bx0;
    const bh = by1 - by0;
    if (bw <= 0 || bh <= 0) return;
    const mask = new Float32Array(bw * bh);
    for (const [x1, y1, x2, y2] of segs) {
      const sx0 = Math.max(bx0, Math.floor(Math.min(x1, x2) - pad));
      const sy0 = Math.max(by0, Math.floor(Math.min(y1, y2) - pad));
      const sx1 = Math.min(bx1, Math.ceil(Math.max(x1, x2) + pad));
      const sy1 = Math.min(by1, Math.ceil(Math.max(y1, y2) + pad));
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len2 = dx * dx + dy * dy;
      for (let y = sy0; y < sy1; y++) {
        for (let x = sx0; x < sx1; x++) {
          const px = x + 0.5 - x1;
          const py = y + 0.5 - y1;
          const t = len2 ? clamp((px * dx + py * dy) / len2, 0, 1) : 0;
          const d = Math.hypot(px - dx * t, py - dy * t);
          const cov = clamp(hw - d + 0.5, 0, 1);
          const m = (y - by0) * bw + (x - bx0);
          if (cov > mask[m]) mask[m] = cov;
        }
      }
    }
    this.#compositeMask(bx0, by0, bw, bh, mask, color, alpha, mode);
  }

  #compositeMask(x0, y0, w, h, mask, color, alpha, mode) {
    const [r, g, b, a] = this.#src(color, alpha);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const cov = mask[y * w + x];
        if (cov > 0) blend(this.data, ((y0 + y) * this.width + x0 + x) * 4, r, g, b, a * cov, mode);
      }
    }
  }

  /** Scanline polygon fill (nonzero winding) with 6 sub-scanlines and exact horizontal coverage. */
  fillPolygon(pts, color, alpha = 1, mode = 'normal') {
    const n = pts.length / 2;
    if (n < 3) return;
    const SUB = 6;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 1; i < pts.length; i += 2) {
      minY = Math.min(minY, pts[i]);
      maxY = Math.max(maxY, pts[i]);
    }
    const { width } = this;
    const yStart = Math.max(0, Math.floor(minY));
    const yEnd = Math.min(this.height, Math.ceil(maxY));
    const cov = new Float32Array(width);
    const [r, g, b, a] = this.#src(color, alpha);
    for (let y = yStart; y < yEnd; y++) {
      cov.fill(0);
      let touched = false;
      for (let s = 0; s < SUB; s++) {
        const ys = y + (s + 0.5) / SUB;
        const xs = [];
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          const y1 = pts[i * 2 + 1];
          const y2 = pts[j * 2 + 1];
          if ((y1 <= ys && y2 > ys) || (y2 <= ys && y1 > ys)) {
            const x1 = pts[i * 2];
            xs.push([x1 + ((ys - y1) * (pts[j * 2] - x1)) / (y2 - y1), y2 > y1 ? 1 : -1]);
          }
        }
        xs.sort((p, q) => p[0] - q[0]);
        let wind = 0;
        for (let k = 0; k < xs.length - 1; k++) {
          wind += xs[k][1];
          if (wind === 0) continue;
          const xa = clamp(xs[k][0], 0, width);
          const xb = clamp(xs[k + 1][0], 0, width);
          if (xb <= xa) continue;
          touched = true;
          const ia = Math.floor(xa);
          const ib = Math.floor(xb);
          if (ia === ib) cov[ia] += (xb - xa) / SUB;
          else {
            cov[ia] += (ia + 1 - xa) / SUB;
            for (let x = ia + 1; x < ib; x++) cov[x] += 1 / SUB;
            if (ib < width) cov[ib] += (xb - ib) / SUB;
          }
        }
      }
      if (!touched) continue;
      for (let x = 0; x < width; x++) {
        if (cov[x] > 0) blend(this.data, (y * width + x) * 4, r, g, b, a * Math.min(cov[x], 1), mode);
      }
    }
  }

  /** Linear gradient over the whole canvas (or a rect), from (x0,y0) to (x1,y1). Stops: [[t, color], ...]. */
  fillLinearGradient(x0, y0, x1, y1, stops, { rect, alpha = 1, mode = 'normal' } = {}) {
    const lut = stopLut(stops);
    const [rx, ry, rw, rh] = rect ?? [0, 0, this.width, this.height];
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len2 = dx * dx + dy * dy || 1;
    const { width, height, data } = this;
    for (let y = Math.max(0, Math.floor(ry)); y < Math.min(height, Math.ceil(ry + rh)); y++) {
      for (let x = Math.max(0, Math.floor(rx)); x < Math.min(width, Math.ceil(rx + rw)); x++) {
        const t = clamp(((x + 0.5 - x0) * dx + (y + 0.5 - y0) * dy) / len2, 0, 1);
        const k = Math.round(t * 1023) * 4;
        blend(data, (y * width + x) * 4, lut[k], lut[k + 1], lut[k + 2], lut[k + 3] * alpha, mode);
      }
    }
  }

  /** Radial gradient: stops are over d/r, nothing is drawn beyond r. */
  fillRadialGradient(cx, cy, r, stops, { alpha = 1, mode = 'normal', scaleY = 1 } = {}) {
    const lut = stopLut(stops);
    const { width, height, data } = this;
    for (let y = Math.max(0, Math.floor(cy - r * scaleY)); y < Math.min(height, Math.ceil(cy + r * scaleY)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(width, Math.ceil(cx + r)); x++) {
        const d = Math.hypot(x + 0.5 - cx, (y + 0.5 - cy) / scaleY) / r;
        if (d > 1) continue;
        const k = Math.round(d * 1023) * 4;
        blend(data, (y * width + x) * 4, lut[k], lut[k + 1], lut[k + 2], lut[k + 3] * alpha, mode);
      }
    }
  }

  /** Soft blob of light: smooth falloff to zero at radius r. Additive by default. */
  glow(cx, cy, r, color, alpha = 1, { mode = 'add', power = 2, scaleY = 1 } = {}) {
    const [cr, cg, cb, ca] = this.#src(color, alpha);
    const { width, height, data } = this;
    for (let y = Math.max(0, Math.floor(cy - r * scaleY)); y < Math.min(height, Math.ceil(cy + r * scaleY)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(width, Math.ceil(cx + r)); x++) {
        const t = Math.hypot(x + 0.5 - cx, (y + 0.5 - cy) / scaleY) / r;
        if (t >= 1) continue;
        blend(data, (y * width + x) * 4, cr, cg, cb, ca * Math.pow(1 - t * t, power), mode);
      }
    }
  }

  /** Darkens the corners. */
  vignette(strength = 0.5, color = [0, 0, 0]) {
    const [r, g, b] = parseColor(color);
    const { width, height, data } = this;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const nx = (x + 0.5) / width - 0.5;
        const ny = (y + 0.5) / height - 0.5;
        const d = Math.hypot(nx * 1.15, ny * 1.3);
        blend(data, (y * width + x) * 4, r, g, b, strength * smoothstep(0.35, 0.85, d), 'normal');
      }
    }
  }

  /**
   * Bitmap text. `y` is the top of the glyph box. align: left | center | right (relative to x).
   * `shadow: {dx, dy, color, alpha}` draws a hard drop shadow first.
   */
  text(str, x, y, { scale = 2, color = '#ffffff', alpha = 1, align = 'left', spacing = 1, mode = 'normal', shadow } = {}) {
    const s = Math.max(1, Math.round(scale));
    const total = measureText(str, s, spacing);
    let x0 = Math.round(x);
    if (align === 'center') x0 -= Math.round(total / 2);
    else if (align === 'right') x0 -= total;
    const draw = (ox, oy, col, al) => {
      let cx = x0 + ox;
      for (const ch of String(str)) {
        const rows = glyphFor(ch);
        for (let ry = 0; ry < 7; ry++) {
          for (let rx = 0; rx < 5; rx++) {
            if (rows[ry][rx]) this.fillRect(cx + rx * s, Math.round(y) + oy + ry * s, s, s, col, al, mode);
          }
        }
        cx += (5 + spacing) * s;
      }
    };
    if (shadow) draw(shadow.dx ?? s, shadow.dy ?? s, shadow.color ?? '#000000', shadow.alpha ?? 0.5);
    draw(0, 0, color, alpha);
  }
}
