// Size-focused PNG encoding for the QA thumbnail (Node stdlib only).
// Chromium's own PNG encoder does not filter adaptively or use palettes, so a busy 1200x630 screenshot can
// exceed the 300 KB cap even when posterized. Here we take raw RGBA pixels (decoded by Chromium) and produce
// the smallest acceptable file: optimized truecolor first, then median-cut palettes, then coarser resampling.
import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}

function ihdr(width, height, bitDepth, colorType) {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(width, 0);
  d.writeUInt32BE(height, 4);
  d[8] = bitDepth;
  d[9] = colorType;
  return chunk('IHDR', d);
}

/** Width/height from a PNG buffer, or null when it is not one. */
export function readPngSize(buf) {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIGNATURE) || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Apply the PNG filter that minimises the sum of absolute residuals, per row. `bpp` = bytes per pixel (min 1). */
function filterRows(raw, stride, height, bpp) {
  const out = Buffer.alloc((stride + 1) * height);
  const cand = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));
  const zero = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const row = raw.subarray(y * stride, (y + 1) * stride);
    const prev = y ? raw.subarray((y - 1) * stride, y * stride) : zero;
    const sums = [0, 0, 0, 0, 0];
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? row[i - bpp] : 0;
      const up = prev[i];
      const upLeft = i >= bpp ? prev[i - bpp] : 0;
      const v = row[i];
      cand[0][i] = v;
      cand[1][i] = (v - left) & 255;
      cand[2][i] = (v - up) & 255;
      cand[3][i] = (v - ((left + up) >> 1)) & 255;
      cand[4][i] = (v - paeth(left, up, upLeft)) & 255;
      for (let f = 0; f < 5; f++) {
        const r = cand[f][i];
        sums[f] += r < 128 ? r : 256 - r;
      }
    }
    let best = 0;
    for (let f = 1; f < 5; f++) if (sums[f] < sums[best]) best = f;
    const base = y * (stride + 1);
    out[base] = best;
    cand[best].copy(out, base + 1);
  }
  return out;
}

function deflate(data) {
  return zlib.deflateSync(data, { level: 9, memLevel: 9 });
}

/** Optimised 8-bit RGB PNG (alpha is dropped: screenshots are opaque). */
export function encodeRgbPng(rgba, width, height) {
  const stride = width * 3;
  const raw = Buffer.alloc(stride * height);
  for (let i = 0, j = 0; i < width * height * 4; i += 4, j += 3) {
    raw[j] = rgba[i];
    raw[j + 1] = rgba[i + 1];
    raw[j + 2] = rgba[i + 2];
  }
  const idat = deflate(filterRows(raw, stride, height, 3));
  return Buffer.concat([SIGNATURE, ihdr(width, height, 8, 2), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Median-cut quantisation on a 5-bit-per-channel histogram.
 * Returns {palette: Uint8Array(n*3), indices: Uint8Array(width*height)}.
 */
export function quantize(rgba, width, height, maxColors) {
  const hist = new Uint32Array(32768);
  const sr = new Float64Array(32768);
  const sg = new Float64Array(32768);
  const sb = new Float64Array(32768);
  const total = width * height;
  for (let i = 0; i < total * 4; i += 4) {
    const k = ((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3);
    hist[k]++;
    sr[k] += rgba[i];
    sg[k] += rgba[i + 1];
    sb[k] += rgba[i + 2];
  }
  const keys = [];
  for (let k = 0; k < 32768; k++) if (hist[k]) keys.push(k);
  const chan = (k, c) => (c === 0 ? k >> 10 : c === 1 ? (k >> 5) & 31 : k & 31);
  const makeBox = (list) => {
    const lo = [31, 31, 31];
    const hi = [0, 0, 0];
    let count = 0;
    for (const k of list) {
      count += hist[k];
      for (let c = 0; c < 3; c++) {
        const v = chan(k, c);
        if (v < lo[c]) lo[c] = v;
        if (v > hi[c]) hi[c] = v;
      }
    }
    const ranges = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    const axis = ranges[1] >= ranges[0] && ranges[1] >= ranges[2] ? 1 : ranges[0] >= ranges[2] ? 0 : 2;
    return { list, count, axis, range: ranges[axis] };
  };
  const boxes = [makeBox(keys)];
  while (boxes.length < maxColors) {
    let bi = -1;
    let score = 0;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.list.length < 2) continue;
      const s = b.count * (b.range + 1);
      if (s > score) {
        score = s;
        bi = i;
      }
    }
    if (bi < 0) break;
    const b = boxes[bi];
    const sorted = [...b.list].sort((x, y) => chan(x, b.axis) - chan(y, b.axis));
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < sorted.length - 1; i++) {
      acc += hist[sorted[i]];
      cut = i + 1;
      if (acc * 2 >= b.count) break;
    }
    boxes.splice(bi, 1, makeBox(sorted.slice(0, cut)), makeBox(sorted.slice(cut)));
  }
  const palette = new Uint8Array(boxes.length * 3);
  boxes.forEach((b, i) => {
    let r = 0;
    let g = 0;
    let bl = 0;
    let n = 0;
    for (const k of b.list) {
      r += sr[k];
      g += sg[k];
      bl += sb[k];
      n += hist[k];
    }
    palette[i * 3] = Math.round(r / n);
    palette[i * 3 + 1] = Math.round(g / n);
    palette[i * 3 + 2] = Math.round(bl / n);
  });
  // nearest palette entry per histogram bin (by the bin's own mean colour), computed lazily
  const lookup = new Int16Array(32768).fill(-1);
  const nearest = (k) => {
    const r = sr[k] / hist[k];
    const g = sg[k] / hist[k];
    const b = sb[k] / hist[k];
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < palette.length; i += 3) {
      const dr = palette[i] - r;
      const dg = palette[i + 1] - g;
      const db = palette[i + 2] - b;
      const d = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11;
      if (d < bestD) {
        bestD = d;
        best = i / 3;
      }
    }
    return best;
  };
  const indices = new Uint8Array(total);
  for (let p = 0, i = 0; p < total; p++, i += 4) {
    const k = ((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3);
    if (lookup[k] < 0) lookup[k] = nearest(k);
    indices[p] = lookup[k];
  }
  return { palette, indices };
}

/** Indexed-color PNG using the smallest legal bit depth for the palette. */
export function encodeIndexedPng(indices, palette, width, height) {
  const n = palette.length / 3;
  const depth = n <= 2 ? 1 : n <= 4 ? 2 : n <= 16 ? 4 : 8;
  const perByte = 8 / depth;
  const stride = Math.ceil(width / perByte);
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = indices[y * width + x];
      if (depth === 8) raw[y * stride + x] = v;
      else raw[y * stride + Math.floor(x / perByte)] |= v << (8 - depth * ((x % perByte) + 1));
    }
  }
  const idat = deflate(filterRows(raw, stride, height, 1));
  return Buffer.concat([
    SIGNATURE,
    ihdr(width, height, depth, 3),
    chunk('PLTE', Buffer.from(palette)),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Average the image down to `scale` of its size, then blow it back up with nearest-neighbour so the output
 * keeps the original dimensions but carries a fraction of the detail (and compresses accordingly).
 */
export function resampleBlocky(rgba, width, height, scale) {
  const sw = Math.max(1, Math.round(width * scale));
  const sh = Math.max(1, Math.round(height * scale));
  const cells = new Float64Array(sw * sh * 3);
  const counts = new Uint32Array(sw * sh);
  for (let y = 0; y < height; y++) {
    const cy = Math.min(sh - 1, Math.floor((y * sh) / height));
    for (let x = 0; x < width; x++) {
      const cx = Math.min(sw - 1, Math.floor((x * sw) / width));
      const c = cy * sw + cx;
      const i = (y * width + x) * 4;
      cells[c * 3] += rgba[i];
      cells[c * 3 + 1] += rgba[i + 1];
      cells[c * 3 + 2] += rgba[i + 2];
      counts[c]++;
    }
  }
  const out = Buffer.alloc(width * height * 4, 255);
  for (let y = 0; y < height; y++) {
    const cy = Math.min(sh - 1, Math.floor((y * sh) / height));
    for (let x = 0; x < width; x++) {
      const cx = Math.min(sw - 1, Math.floor((x * sw) / width));
      const c = cy * sw + cx;
      const i = (y * width + x) * 4;
      out[i] = Math.round(cells[c * 3] / counts[c]);
      out[i + 1] = Math.round(cells[c * 3 + 1] / counts[c]);
      out[i + 2] = Math.round(cells[c * 3 + 2] / counts[c]);
    }
  }
  return out;
}

/** Candidate encodings from highest to lowest fidelity. Each step is {scale, colors} (colors 0 = truecolor). */
export function reductionLadder() {
  const ladder = [{ scale: 1, colors: 0 }];
  for (const colors of [256, 128, 64, 32, 16]) ladder.push({ scale: 1, colors });
  for (const [scale, list] of [[0.75, [256, 64, 16]], [0.5, [256, 64, 16]], [0.35, [64, 16]], [0.25, [64, 16, 4]]]) {
    for (const colors of list) ladder.push({ scale, colors });
  }
  return ladder;
}

/** Encode one ladder step. */
export function encodeStep(rgba, width, height, step) {
  const px = step.scale < 1 ? resampleBlocky(rgba, width, height, step.scale) : rgba;
  if (!step.colors) return encodeRgbPng(px, width, height);
  const { palette, indices } = quantize(px, width, height, step.colors);
  return encodeIndexedPng(indices, palette, width, height);
}

/**
 * Smallest-loss PNG of the RGBA image that fits in `maxBytes`: the first ladder step that fits wins.
 * Returns {buf, step} or {buf:null, smallest} when even the coarsest step is too big.
 */
export function fitPng(rgba, width, height, maxBytes, { isExpired = () => false } = {}) {
  let smallest = null;
  for (const step of reductionLadder()) {
    if (isExpired()) break;
    const buf = encodeStep(rgba, width, height, step);
    if (smallest === null || buf.length < smallest) smallest = buf.length;
    if (buf.length <= maxBytes) return { buf, step };
  }
  return { buf: null, smallest };
}
