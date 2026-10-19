// The exercises: instant feedback on the answer buttons, and the page's own numbers inside each answer.
import * as E from './engine.js';
import { exerciseNumbers, exerciseChecks } from './selftest.js';

const f1 = (v) => v.toFixed(1);
const f2 = (v) => v.toFixed(2);
const pc = (v) => (100 * v).toFixed(1) + '%';
const tiny = (v) => (v === 0 ? '0' : v.toExponential(0));
const pts = (v) => Math.round(100 * v);

export function initExercises() {
  for (const ex of document.querySelectorAll('.ex')) {
    const fb = ex.querySelector('.ex-feedback');
    const choices = [...ex.querySelectorAll('.ex-choice')];
    for (const b of choices) {
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => {
        const right = b.dataset.right === 'yes';
        for (const o of choices) { o.setAttribute('aria-pressed', String(o === b)); o.classList.remove('is-right', 'is-wrong'); }
        b.classList.add(right ? 'is-right' : 'is-wrong');
        fb.textContent = right ? fb.dataset.right : fb.dataset.wrong;
        fb.className = 'ex-feedback ' + (right ? 'right' : 'wrong');
      });
    }
  }
  const X = exerciseNumbers();
  const sw = document.querySelectorAll('.ex-demo[data-ex="1"] .ex-sw');
  [...X.e1.sw.day, ...X.e1.sw.sodium].forEach((rgb, i) => { if (sw[i]) { sw[i].style.background = E.hex(rgb); sw[i].title = E.hex(rgb).toUpperCase(); } });
  const put = (n, text) => { const p = document.querySelector(`.ex-calc[data-ex="${n}"]`); if (p) p.textContent = text; };
  const six = (o) => `shop light ${f2(o.FL11)}, warm bulb ${f2(o.A)}, daylight ${f2(o.D65)}, warm LED ${f2(o['LED-B2'])}, sodium lamp ${f2(o.sodium)}, smooth glow of the shop light's color ${f2(o.P3999)}`;
  const hair = Object.values(X.e2hair);
  const e2 = `Computed by this page just now, 6 points above Fog: ${six(X.e2)}. Half a point above: ${f2(Math.min(...hair))} to ${f2(Math.max(...hair))}.`;
  put(1, `Computed by this page just now: P sends back ${pc(X.e1.atP)} and Q ${pc(X.e1.atQ)} at 589 nm; difference ${f1(X.e1.sodium)} under the street lamp and ${f1(X.e1.day)} in daylight.`);
  put(2, `${e2} Testing 2,000 random lamps...`);
  put(3, `Computed by this page just now: ${six(X.e3)}.`);
  put(4, 'Computing 200 random wiggles...');
  const s = X.e5.power;
  put(5, `Computed by this page just now: under the shop light the screen's three band strengths for Pebble and for Fog differ by ${tiny(X.e5.rel)} of their size (rounding error at most). Shares of the light's power: red ${pc(s[0])}, green ${pc(s[1])}, blue ${pc(s[2])}.`);
  exerciseChecks().then((C) => {
    put(2, `${e2} Smallest over 2,000 random lamps: ${f2(C.randomMin)}.`);
    put(4, `Computed by this page just now: 200 random wiggles hiding from the two-line lamp moved Fog's curve by up to ${pts(C.two.moved)} points, while its heights at 450 and 600 nm stayed at ${pc(C.two.fogAt[0])} and ${pc(C.two.fogAt[1])} (largest change ${tiny(C.two.atLines)}) and its color under that lamp changed by ${tiny(C.two.same)}. Under the warm bulb the same wiggles changed it by up to ${f1(C.two.warm)}. With four lines, at 450, 525, 600 and 650 nm, the heights at the lines moved by up to ${pts(C.four.atLines)} points while the color changed by ${tiny(C.four.same)}.`);
  }).catch((err) => console.error(err));
}
