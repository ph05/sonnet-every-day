// selfcheck.js: known-answer checks of the page's own encoder, decoder and renderer. window.__sedSelfTest runs
// them and returns {cases: [{name, ok, detail}]}; "Check the decoder" in More shows them.
// Expected values: published examples (the HELLO WORLD 1-M worked example and the standard's mask-0 format strings)
// and numbers computed by the lead's independent Python reference encoder, which equals zxing-cpp's encoder module
// for module on 260 of 260 symbols (W/proto/tables.out). Never edit an expected value to make a case pass.
import * as QR from './qr.js';
import * as R from './render.js';
import { ghostStroke, applyStrokes } from './strokes.js';

const T = 'SCRATCHED BUT STILL READABLE';
const eq = (a, b) => a.length === b.length && Array.from(a).every((v, i) => v === b[i]);

// The standard's own worked example (ISO/IEC 18004 Annex I, "01234567" at 1-M, as quoted in ZXing's Reed-Solomon tests).
const ANNEX_DATA = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11];
const ANNEX_EC = [0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55];
// A widely used tutorial example: HELLO WORLD at version 1-M (data and check codewords).
const HW_DATA = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
const HW_EC = [196, 35, 39, 119, 235, 215, 231, 226, 93, 23];
// The standard's masked format strings for mask 0.
const FMT0 = { L: 0x77c4, M: 0x5412, Q: 0x355f, H: 0x1689 };
// Computed by the lead's reference encoder (W/proto/tables.out).
const T_PENALTIES = [1493, 1350, 1448, 1304, 1340, 1386, 1407, 1301];
const T_STREAM = [32, 63, 228, 122, 248, 179, 153, 52, 52, 231, 149, 156, 133, 215, 166, 126, 212, 0, 27, 236, 79, 17,
  104, 236, 75, 17, 42, 127, 146, 102, 243, 110, 210, 32, 155, 29, 223, 227, 68, 194, 122, 244, 113, 170, 203, 74, 148,
  209, 169, 167, 111, 81, 122, 140, 107, 37, 114, 253, 214, 218, 64, 134, 242, 123, 9, 44, 120, 42, 249, 61];
// All 841 squares of the sample code (row by row, 1 = dark, as hex), from the lead's independent reference encoder,
// which equals zxing-cpp's encoder module for module (W/proto/xcheck_zxing.py, W/proto/hero_grid.hex).
const T_GRID = 'fe89a3fc14df906e944ebb753d05dbad39aec16a4507faaaafe0052f00121569dfe66f9383fa7ce32b22bfda3f667d2e2a6e18c9bc5f1538e77dabb55eb1273bbfa2d12f7669b5f7a9f68bf9004d2467f98b2a70447315ba1fdfadd42093ee82e0ab04f1e83fe62f800';
// The standard's error correction table for versions 1 to 6: [check bytes per block, blocks, data per block, ...].
const TABLE = {
  1: { L: [7, 1, 19], M: [10, 1, 16], Q: [13, 1, 13], H: [17, 1, 9] },
  2: { L: [10, 1, 34], M: [16, 1, 28], Q: [22, 1, 22], H: [28, 1, 16] },
  3: { L: [15, 1, 55], M: [26, 1, 44], Q: [18, 2, 17], H: [22, 2, 13] },
  4: { L: [20, 1, 80], M: [18, 2, 32], Q: [26, 2, 24], H: [16, 4, 9] },
  5: { L: [26, 1, 108], M: [24, 2, 43], Q: [18, 2, 15, 2, 16], H: [22, 2, 11, 2, 12] },
  6: { L: [18, 2, 68], M: [16, 4, 27], Q: [24, 4, 19], H: [28, 4, 15] },
};
const RESERVE = { '1L': 3, '1M': 2, '1Q': 1, '1H': 1, '2L': 2, '3L': 1 };

// a tiny deterministic generator for the Reed-Solomon trials
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
function pick(n, k, r) {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}

function picture(sym, strokes) {
  const c = document.createElement('canvas');
  const state = applyStrokes(sym, strokes);
  const out = R.draw(c, sym, { modules: state.modules, strokes }, { modulePx: 10, dpr: 1, setSize: false });
  const img = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  const mods = QR.readPixels(img.data, c.width, c.height, { originX: out.geo.originX, originY: out.geo.originY, modulePx: out.geo.modulePx, size: sym.size });
  return { mods, state, geo: out.geo };
}

export function runChecks() {
  const cases = [];
  const add = (name, fn) => {
    try {
      const r = fn();
      cases.push({ name, ok: !!r.ok, detail: r.detail || '' });
    } catch (e) {
      cases.push({ name, ok: false, detail: 'threw: ' + (e && e.message) });
    }
  };
  add('The standard\u2019s worked example (Annex I, 01234567 at 1-M) gives its 10 check bytes', () => {
    const ec = QR.rsEncode(ANNEX_DATA, 10);
    let data = null;
    try { data = QR.encode('01234567', { level: 'M', version: 1, mode: 'numeric' }).data; } catch (e) { data = null; }
    const dataOk = data === null || eq(data, ANNEX_DATA);
    return { ok: eq(ec, ANNEX_EC) && dataOk, detail: 'check bytes ' + Array.from(ec, (v) => v.toString(16).padStart(2, '0')).join(' ') + (data ? ', data from the encoder matches' : '') };
  });
  add('HELLO WORLD at 1-M (a widely used tutorial example) gives its data and check codewords', () => {
    const s = QR.encode('HELLO WORLD', { level: 'M', version: 1 });
    return { ok: eq(s.data, HW_DATA) && eq(s.blocks[0].ec, HW_EC), detail: 'check bytes ' + Array.from(s.blocks[0].ec).join(' ') };
  });
  add('Format strings for L, M, Q, H with mask 0 match the standard', () => {
    const got = ['L', 'M', 'Q', 'H'].map((l) => QR.formatBits(l, 0));
    return { ok: got.every((v, i) => v === FMT0['LMQH'[i]]), detail: got.map((v) => '0x' + v.toString(16)).join(', ') };
  });
  add('The sample message at 3-H: mask 7, the eight mask penalties and all 70 codewords', () => {
    const s = QR.encode(T, { level: 'H' });
    return { ok: s.version === 3 && s.mask === 7 && eq(s.penalties, T_PENALTIES) && eq(s.stream, T_STREAM), detail: 'version ' + s.version + ', mask ' + s.mask };
  });
  add('All 841 squares of the sample code equal the independent reference encoder\u2019s', () => {
    const s = QR.encode(T, { level: 'H' });
    let bits = '';
    for (let i = 0; i < T_GRID.length; i++) bits += parseInt(T_GRID[i], 16).toString(2).padStart(4, '0');
    let diff = 0;
    for (let i = 0; i < s.modules.length; i++) if (String(s.modules[i]) !== bits[i]) diff++;
    return { ok: s.size === 29 && diff === 0, detail: diff + ' squares differ' };
  });
  add('Block structure of all 24 versions and levels matches the standard', () => {
    let bad = [];
    for (let v = 1; v <= 6; v++) {
      for (const l of ['L', 'M', 'Q', 'H']) {
        const t = TABLE[v][l];
        const lay = QR.blockLayout(v, l);
        const groups = lay.groups.map((g) => [g.count, g.dataPerBlock]).flat();
        if (lay.ecPerBlock !== t[0] || !eq(groups, t.slice(1)) || lay.reserve !== (RESERVE[v + l] || 0)) bad.push(v + '-' + l);
      }
    }
    return { ok: bad.length === 0, detail: bad.length ? 'differs: ' + bad.join(', ') : '24 of 24' };
  });
  add('Every level round-trips the sample message', () => {
    const res = ['L', 'M', 'Q', 'H'].map((l) => {
      const s = QR.encode(T, { level: l });
      const r = QR.decodeModules(s.modules, s.size);
      return r.ok && r.text === T && r.blocks.every((b) => b.errors === 0);
    });
    return { ok: res.every(Boolean), detail: res.map((x, i) => 'LMQH'[i] + (x ? ' ok' : ' FAIL')).join(', ') };
  });
  add('The picture decodes: pixels read back from the drawn clean code', () => {
    const s = QR.encode(T, { level: 'H' });
    const p = picture(s, []);
    const r = QR.decodeModules(p.mods, s.size);
    return { ok: eq(p.mods, s.modules) && r.ok && r.text === T, detail: 'read back ' + (r.ok ? r.text : r.reason) };
  });
  add('The first frame decodes from its pixels: 9 broken bytes, 4 + 5, all fixed', () => {
    const s = QR.encode(T, { level: 'H' });
    const p = picture(s, [ghostStroke()]);
    const r = QR.decodeModules(p.mods, s.size, { reference: s });
    const per = r.graded ? r.graded.trueBroken : [];
    return { ok: eq(p.mods, p.state.modules) && r.ok && r.text === T && eq(per, [4, 5]) && r.graded.allFound, detail: 'broken per block ' + per.join(' + ') };
  });
  add('Reed-Solomon: 11 errors in a 35-byte block are fixed, 12 are refused', () => {
    const s = QR.encode(T, { level: 'H' });
    const b = s.blocks[0];
    const clean = Uint8Array.from([...b.data, ...b.ec]);
    const r = rng(20261020);
    let fixed = 0;
    let refused = 0;
    let wrong = 0;
    for (let trial = 0; trial < 20; trial++) {
      for (const k of [11, 12]) {
        const w = clean.slice();
        for (const i of pick(35, k, r)) w[i] ^= 1 + Math.floor(r() * 255);
        const d = QR.rsDecode(w, 22);
        if (d.ok && !eq(d.corrected, clean)) wrong++;
        else if (k === 11 && d.ok) fixed++;
        else if (k === 12 && !d.ok) refused++;
      }
    }
    return { ok: fixed === 20 && refused === 20 && wrong === 0, detail: fixed + '/20 fixed at 11, ' + refused + '/20 refused at 12' };
  });
  add('Erasures: 22 known gaps in a 35-byte block are filled, 23 are refused', () => {
    const s = QR.encode(T, { level: 'H' });
    const b = s.blocks[1];
    const clean = Uint8Array.from([...b.data, ...b.ec]);
    const r = rng(7);
    const ok22 = (() => {
      const pos = pick(35, 22, r);
      const w = clean.slice();
      for (const i of pos) w[i] = 0;
      const d = QR.rsDecode(w, 22, pos);
      return d.ok && eq(d.corrected, clean);
    })();
    const no23 = (() => {
      const pos = pick(35, 23, r);
      const w = clean.slice();
      for (const i of pos) w[i] = 0;
      return !QR.rsDecode(w, 22, pos).ok;
    })();
    return { ok: ok22 && no23, detail: (ok22 ? '22 filled' : '22 FAILED') + ', ' + (no23 ? '23 refused' : '23 ACCEPTED') };
  });
  add('Reserve bytes: 5 errors at 1-M read with half the check bytes, refused by the standard’s promise', () => {
    const s = QR.encode('HELLO WORLD', { level: 'M', version: 1 });
    const mods = Uint8Array.from(s.modules);
    const cwm = QR.codewordModules(s);
    for (const c of [1, 5, 9, 14, 20]) for (const i of cwm[c]) mods[i] ^= 1;
    const half = QR.decodeModules(mods, s.size, { limit: 'half' });
    const strict = QR.decodeModules(mods, s.size, { limit: 'reserve' });
    return { ok: half.ok && half.text === 'HELLO WORLD' && !strict.ok, detail: 'half: ' + (half.ok ? 'reads' : 'fails') + ', reserve: ' + (strict.ok ? 'reads' : 'refuses') };
  });
  add('The table in step 6 agrees with the engine for all 24 versions and levels', () => {
    const table = typeof document !== 'undefined' ? document.getElementById('qr-table') : null;
    if (!table) return { ok: true, detail: 'no table on this page' };
    const rows = table.tBodies[0].rows;
    const bad = [];
    for (let v = 1; v <= 6; v++) {
      ['L', 'M', 'Q', 'H'].forEach((l, j) => {
        const lay = QR.blockLayout(v, l);
        const sizes = [...new Set(lay.groups.map((g) => g.dataPerBlock + lay.ecPerBlock))];
        const cell = rows[v - 1].cells[j + 1].textContent.replace(/\s+/g, ' ').trim();
        const want = lay.blockCount + ' ' + (lay.blockCount === 1 ? 'block' : 'blocks') + ' ' + lay.maxTry + ' of ' + sizes.join(' or ') + (lay.blockCount > 1 ? ' each' : '') + (lay.budget < lay.maxTry ? '*' : '');
        if (cell !== want) bad.push(v + '-' + l + ': "' + cell + '" vs "' + want + '"');
      });
    }
    return { ok: bad.length === 0, detail: bad.length ? bad.slice(0, 2).join('; ') : '24 of 24 cells' };
  });
  return { cases };
}

export function installSelfTest() {
  window.__sedSelfTest = () => runChecks();
}
