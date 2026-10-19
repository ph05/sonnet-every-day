// Entry point: the hero first (the first frame must paint fast), then the figures, the exercises and the self-check.
import { initHero, thumbReady } from './hero.js';
import { selfTest } from './selftest.js';

window.__sedThumbReady = thumbReady;

async function runChecks(out) {
  if (out) out.textContent = 'Checking...';
  const { cases } = await selfTest();
  const failed = cases.filter((c) => !c.ok);
  for (const c of failed) console.error(`Self-check failed: ${c.name} (${c.detail})`);
  if (out) {
    out.replaceChildren();
    const head = document.createElement('p');
    head.className = failed.length ? 'fail' : 'pass';
    head.textContent = failed.length ? `${failed.length} of ${cases.length} checks failed.` : `${cases.length} of ${cases.length} checks passed.`;
    const ul = document.createElement('ul');
    for (const c of cases) {
      const li = document.createElement('li');
      li.className = c.ok ? 'pass' : 'fail';
      li.textContent = `${c.ok ? 'Passed' : 'Failed'}: ${c.name}. Got ${c.detail}.`;
      ul.append(li);
    }
    out.append(head, ul);
  }
  return cases;
}

initHero({ runChecks });

const later = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 1500 }) : setTimeout(fn, 300));
later(async () => {
  try {
    const { initExercises } = await import('./exercises.js');
    initExercises();
  } catch (err) { console.error(err); }
  try {
    const { initFigures } = await import('./figures.js');
    initFigures();
  } catch (err) { console.error(err); }
  later(() => runChecks(null));
});
