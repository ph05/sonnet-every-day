// Sample Toy: elementary cellular automaton explorer.
import { Grid } from './grid.js';
import { makePalette } from './palette.js';
import { ruleTable, nextRow } from './rules.js';

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const grid = new Grid(120, 120);
const palette = makePalette(['#0b1020', '#ff3d6e', '#ffd166']);
let rule = 110;
let timer = 0;

function draw() {
  const w = canvas.width / grid.cols;
  const h = canvas.height / grid.rows;
  for (let y = 0; y < grid.rows; y++) {
    for (let x = 0; x < grid.cols; x++) {
      ctx.fillStyle = palette[grid.get(x, y) ? 1 : 0];
      ctx.fillRect(x * w, y * h, w, h);
    }
  }
}

function step() {
  grid.scroll(nextRow(grid.lastRow(), ruleTable(rule)));
  draw();
}

document.getElementById('step').addEventListener('click', step);
document.getElementById('rule').addEventListener('input', (e) => { rule = Number(e.target.value) & 255; });
document.getElementById('reset').addEventListener('click', () => { grid.clear(); grid.seedCenter(); draw(); });
document.getElementById('play').addEventListener('click', (e) => {
  const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
  e.currentTarget.setAttribute('aria-pressed', String(on));
  if (on) timer = setInterval(step, 90); else clearInterval(timer);
});

fetch('data/levels.json').then((r) => r.json()).then((d) => { console.log('levels', d.levels.length); }).catch(() => {});
grid.seedCenter();
draw();
