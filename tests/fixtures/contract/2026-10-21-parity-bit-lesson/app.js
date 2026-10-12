// Parity Bit Lesson: a five-bit message (four data bits and an even-parity bit) the visitor can damage bit by bit.
// The count is the same one the explainer describes; window.__sedSelfTest checks it against the worked examples.
(function () {
  'use strict';

  const DATA_BITS = 4;
  const START = [1, 0, 1, 1];

  /** Number of ones in a list of bits. */
  function ones(bits) {
    return bits.reduce((n, b) => n + (b ? 1 : 0), 0);
  }

  /** The even-parity bit for some data bits: 1 when the data has an odd number of ones. */
  function parityBit(data) {
    return ones(data) % 2;
  }

  /** The check the receiver runs on all bits (data plus parity): passes when the count of ones is even. */
  function checkPasses(bits) {
    return ones(bits) % 2 === 0;
  }

  function encode(data) {
    return [...data, parityBit(data)];
  }

  /** Deterministic little generator so a "new message" is reproducible in tests and screenshots. */
  function makeRandom(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------- the page ---------- */

  const $ = (id) => document.getElementById(id);
  const random = makeRandom(20261021);
  const state = { sent: encode(START), bits: encode(START), flips: 0 };

  function describe() {
    const n = ones(state.bits);
    const pass = checkPasses(state.bits);
    let text = 'The receiver counts ' + n + (n === 1 ? ' one' : ' ones') + ': ' + (pass ? 'even, so the check passes.' : 'odd, so the check fails and the message is rejected.');
    if (state.flips === 0) text += ' Nothing has flipped yet. Click a bit to flip it.';
    else if (pass) text += ' But ' + state.flips + ' bits flipped on the way: the damage went unnoticed.';
    else text += ' ' + state.flips + (state.flips === 1 ? ' bit' : ' bits') + ' flipped, and parity caught it.';
    return { text: text, pass: pass };
  }

  function render() {
    const box = $('bits');
    box.textContent = '';
    state.bits.forEach((bit, i) => {
      const isParity = i === DATA_BITS;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pb-bit' + (isParity ? ' is-parity' : '') + (bit !== state.sent[i] ? ' is-flipped' : '');
      btn.textContent = String(bit);
      btn.setAttribute('aria-label', (isParity ? 'Parity bit' : 'Data bit ' + (i + 1)) + ', ' + bit + (bit !== state.sent[i] ? ', flipped' : '') + '. Click to flip it.');
      btn.dataset.index = String(i);
      box.append(btn);
    });
    const d = describe();
    const status = $('status');
    status.textContent = d.text;
    status.className = 'pb-status ' + (d.pass ? 'is-pass' : 'is-fail');
  }

  function flip(i) {
    state.bits[i] = state.bits[i] ? 0 : 1;
    state.flips = state.bits.reduce((n, b, k) => n + (b !== state.sent[k] ? 1 : 0), 0);
    render();
  }

  $('bits').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-index]');
    if (btn) flip(Number(btn.dataset.index));
  });

  $('noise').addEventListener('click', () => {
    flip(Math.floor(random() * state.bits.length));
  });

  $('fresh').addEventListener('click', () => {
    const data = Array.from({ length: DATA_BITS }, () => (random() < 0.5 ? 0 : 1));
    state.sent = encode(data);
    state.bits = state.sent.slice();
    state.flips = 0;
    render();
  });

  render();

  /* ---------- self-test: the worked examples of the explainer and the exercises ---------- */

  const CASES = [
    { name: '1011 has three ones, so its even-parity bit is 1 (explainer)', run: () => parityBit([1, 0, 1, 1]) === 1 },
    { name: '1001 has two ones, so its even-parity bit is 0 (explainer)', run: () => parityBit([1, 0, 0, 1]) === 0 },
    { name: 'exercise 1: 0110 gets parity bit 0', run: () => parityBit([0, 1, 1, 0]) === 0 },
    { name: 'exercise 2: 11010 fails the check', run: () => checkPasses([1, 1, 0, 1, 0]) === false },
    { name: 'any single flip of 10111 fails the check', run: () => [0, 1, 2, 3, 4].every((i) => { const b = [1, 0, 1, 1, 1]; b[i] ^= 1; return !checkPasses(b); }) },
    { name: 'two flips of 10111 pass the check unnoticed', run: () => { const b = [1, 0, 1, 1, 1]; b[0] ^= 1; b[3] ^= 1; return checkPasses(b); } },
  ];

  window.__sedSelfTest = function () {
    const cases = CASES.map((c) => {
      let ok = false;
      try {
        ok = c.run() === true;
      } catch (e) {
        ok = false;
      }
      return { name: c.name, ok: ok };
    });
    const passed = cases.filter((c) => c.ok).length;
    return { ok: passed === cases.length, total: cases.length, passed: passed, cases: cases };
  };
})();
