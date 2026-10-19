// exercises.js: kind, instant checking for the static exercises of exercises.html (SPEC section 8).
//   import { initExercises } from './exercises.js'; initExercises(document);
// Answers live in data-answer on an input, a select, or a fieldset of radio buttons ("a|b" accepts either).
// Right: a warm word. Wrong: which parts are right, and a hint for the first wrong one; after two wrong tries, a
// pointer to the answer below. It also fills each answer's "computed by this page" line from the widgets' own exact
// maths (ladder.js) and marks each exercise data-qw-verified="true" when that agrees with the static answer.
import { math } from './ladder.js';

const { Q, modField, decodePoints, judge, clockPartner, gfMul } = math;

const clean = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!]+$/, '');
const asNumber = (s) => {
  const t = clean(s).replace(/^(point|pt\.?|p)\s*/, '').replace(/^\((\d+),\s*(\d+)\)$/, '$2');
  return /^[-−]?\d+$/.test(t) ? Number(t.replace('−', '-')) : null;
};
const valueOf = (field) => {
  if (field.tagName === 'FIELDSET') { const r = field.querySelector('input[type="radio"]:checked'); return r ? r.value : ''; }
  return field.value;
};

/** null when empty, true when right, false when wrong. data-answer may list several, separated by |. */
export function grade(field) {
  const raw = valueOf(field);
  if (clean(raw) === '') return null;
  const wants = field.dataset.answer.split('|').map(clean);
  const v = clean(raw), n = asNumber(raw);
  return wants.some((w) => w === v || (n !== null && /^-?\d+$/.test(w) && Number(w) === n));
}

function partName(field) {
  if (field.dataset.name) return field.dataset.name;
  const label = field.closest('label');
  const span = label && label.querySelector('span');
  const m = span && span.textContent.match(/^\(([a-z])\)/);
  if (m) return `(${m[1]})`;
  return 'this one';
}

const RIGHT = ['Yes!', 'Lovely.', 'That is it.', 'Spot on.', 'Exactly.'];

export function initExercises(root = document) {
  const blocks = [...root.querySelectorAll('.qw-ex[data-sed-check]')];
  blocks.forEach((ex, idx) => {
    const fields = [...ex.querySelectorAll('[data-answer]')];
    const btn = ex.querySelector('.qw-ex-check');
    const fb = ex.querySelector('.qw-ex-feedback');
    if (!btn || !fb || !fields.length) return;
    let tries = 0;
    const check = () => {
      const results = fields.map(grade);
      fields.forEach((f, i) => {
        f.classList.toggle('is-right', results[i] === true);
        f.classList.toggle('is-wrong', results[i] === false);
        if (results[i] === false) f.setAttribute('aria-invalid', 'true'); else f.removeAttribute('aria-invalid');
      });
      const filled = results.filter((r) => r !== null).length;
      const right = results.filter((r) => r === true).length;
      fb.classList.remove('is-right', 'is-wrong', 'is-nudge');
      if (filled === 0) {
        fb.textContent = fields.length > 1 ? 'Have a go at any of the boxes first, then press Check.' : 'Choose an answer first, then press Check.';
        fb.classList.add('is-nudge');
        return;
      }
      if (right === fields.length) {
        fb.textContent = `${RIGHT[idx % RIGHT.length]} ${fb.dataset.right || ''}`.trim();
        fb.classList.add('is-right');
        ex.classList.add('is-solved');
        return;
      }
      const wrongAt = results.findIndex((r) => r === false);
      if (wrongAt === -1) {
        fb.textContent = `So far so good: ${right === 1 ? 'that one is' : `those ${right} are`} right. Now the rest.`;
        fb.classList.add('is-nudge');
        return;
      }
      tries++;
      const bad = fields[wrongAt];
      const okNames = fields.filter((_, i) => results[i] === true).map(partName);
      const leadRaw = okNames.length ? `${okNames.join(' and ')} ${okNames.length === 1 ? 'is' : 'are'} right. ` : '';
      const lead = leadRaw.charAt(0).toUpperCase() + leadRaw.slice(1);
      const hintText = bad.dataset.hint ? `Hint${fields.length > 1 ? ` for ${partName(bad)}` : ''}: ${bad.dataset.hint}` : `Have another look at ${partName(bad)}.`;
      fb.textContent = `${tries === 1 ? 'Not quite yet. ' : 'Close. '}${lead}${hintText}${tries >= 2 ? ' The full answer is just below if you want it.' : ''}`;
      fb.classList.add('is-wrong');
    };
    btn.addEventListener('click', check);
    fields.forEach((f) => {
      const reset = () => { f.classList.remove('is-right', 'is-wrong'); f.removeAttribute('aria-invalid'); };
      if (f.tagName === 'FIELDSET') { f.addEventListener('change', reset); return; }
      f.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); check(); } });
      f.addEventListener(f.tagName === 'SELECT' ? 'change' : 'input', reset);
    });
  });
  fillComputed(root);
}

/** Each exercise's answers, recomputed with the page's own maths. */
export function solveAll() {
  const F7 = modField(7);
  const out = {};
  out.clock7 = { a: F7.add(5, 4), b: F7.mul(3, 4), c: F7.inv(4) };
  {
    const xs = [1, 2, 3, 4], got = [5, 7, 10, 11];
    const dec = decodePoints(Q, xs, got, 2);
    out.liar = { kind: dec.kind, point: dec.liars.map((i) => xs[i]), should: dec.liars.map((i) => Q.str(dec.winner.vals[i])) };
  }
  {
    const n = 28;
    let a = 0, b = 0;
    for (let e = 0; 2 * e <= n; e++) a = e;
    for (let e = 0; 2 * e + 6 <= n; e++) b = e;
    out.budget = { a, b };
  }
  {
    const blocks = 2, cap = 11;
    const shares = (start, len) => { const c = new Array(blocks).fill(0); for (let j = 0; j < len; j++) c[(start + j) % blocks]++; return c; };
    const split = shares(0, 14);
    out.interleave = { a: split, b: split.every((x) => x <= cap) ? 'yes' : 'no', c: 14 <= cap ? 'yes' : 'no' };
  }
  {
    let none = 0; for (let v = 1; v < 256; v++) if (clockPartner(v, 256) === null) none++;
    out.trap = { zero: (2 * 128) % 256, none, gf: gfMul(2, 142) };
  }
  {
    const xs = [1, 2, 3, 4], sent = [2, 4, 6, 8], got = [2, 4, 5, 6];
    const dec = decodePoints(Q, xs, got, 2);
    out.fooled = { message: dec.winner ? dec.winner.vals.slice(0, 2).map(Q.str) : null, verdict: judge(Q, dec, sent), fixedPoint: dec.liars.map((i) => xs[i]) };
  }
  {
    const full = [10, 11, 15].filter((p) => { for (let v = 1; v < p; v++) if (clockPartner(v, p) === null) return false; return true; });
    const zeros = []; for (let m = 1; m < 256; m++) if ((4 * m) % 256 === 0) zeros.push(m);
    out.divide = { a: full, b: zeros };
  }
  out.xor = { a: 7 ^ 7, b: 12 ^ 10 };
  return out;
}

function fillComputed(root) {
  let S;
  try { S = solveAll(); } catch { return; }
  const ex = (key) => root.querySelector(`.qw-ex[data-qw-ex="${key}"]`);
  const ans = (key) => [...(ex(key)?.querySelectorAll('[data-answer]') || [])].map((f) => f.dataset.answer);
  const put = (key, text, ok) => {
    const p = root.querySelector(`.qw-ex-calc[data-qw-calc="${key}"]`);
    if (p) p.textContent = `Computed by this page just now: ${text}`;
    if (ex(key)) ex(key).dataset.qwVerified = String(!!ok);
  };
  const c = S.clock7, A1 = ans('clock7');
  put('clock7', `on a 7-hour clock 5 + 4 = ${c.a}, 3 × 4 = ${c.b}, and 4 × ${c.c} = ${4 * c.c}, which lands on ${(4 * c.c) % 7}.`,
    [c.a, c.b, c.c].every((v, i) => String(v) === A1[i]));
  const l = S.liar, A2 = ans('liar');
  put('liar', `the only line through three of (1, 5), (2, 7), (3, 10), (4, 11) leaves out point ${l.point.join(', ')}, which should be ${l.should.join(', ')}.`,
    l.kind === 'fixed' && String(l.point[0]) === A2[0] && l.should[0] === A2[1]);
  const b = S.budget, A3 = ans('budget');
  put('budget', `with 28 check bytes, ${b.a} unknown errors (2 × ${b.a} = ${2 * b.a}); with 6 known gaps, ${b.b} more (2 × ${b.b} + 6 = ${2 * b.b + 6}).`,
    String(b.a) === A3[0] && String(b.b) === A3[1]);
  const it = S.interleave, A4 = ans('interleave');
  put('interleave', `14 bytes in a row dealt to 2 blocks give ${it.a.join(' and ')}; each block fixes 11, so it reads: ${it.b}; 14 in one block reads: ${it.c}.`,
    it.a.every((x) => String(x) === A4[0]) && it.b === A4[1] && it.c === A4[2]);
  const t = S.trap, A5 = ans('trap');
  put('trap', `on a 256-hour clock 2 × 128 lands on ${t.zero}, and ${t.none} of the 255 non-zero numbers have no partner; in QR's own system 2 × 142 = ${t.gf}.`,
    t.zero === 0 && t.none === 127 && t.gf === 1 && A5[0] === 'b');
  const f = S.fooled, AX1 = ans('fooled');
  put('fooled', `the decoder finds a line through three points, changes point ${f.fixedPoint.join(', ')}, and reports ${f.message.join(', ')} (${f.verdict === 'fooled' ? 'a wrong message' : f.verdict}).`,
    f.verdict === 'fooled' && f.message[0] === AX1[0] && f.message[1] === AX1[1]);
  const d = S.divide, AX2 = ans('divide');
  put('divide', `of the 10-, 11- and 15-hour clocks, only the ${d.a.join(', ')}-hour clock has a partner for every number but 0; on a 256-hour clock 4 × m lands on 0 for m = ${d.b.join(', ')}.`,
    d.a.length === 1 && String(d.a[0]) === AX2[0] && d.b.join('|') === AX2[1]);
  const x = S.xor, AX3 = ans('xor');
  put('xor', `7 XOR 7 = ${x.a} and 12 XOR 10 = ${x.b}.`, String(x.a) === AX3[0] && String(x.b) === AX3[1]);
}
