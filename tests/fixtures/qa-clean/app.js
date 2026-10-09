const out = document.getElementById('count');
let n = 0;
document.getElementById('inc').addEventListener('click', () => { out.textContent = String(++n); });
document.getElementById('reset').addEventListener('click', () => { n = 0; out.textContent = '0'; });
const cv = document.getElementById('stage');
const g = cv.getContext('2d');
let t = 0;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
function frame() {
  g.fillStyle = '#10131c';
  g.fillRect(0, 0, cv.width, cv.height);
  for (let i = 0; i < 12; i++) {
    g.fillStyle = `hsl(${(i * 30 + t) % 360} 80% 60%)`;
    g.beginPath();
    g.arc(30 + i * 28, 80 + Math.sin(t / 20 + i) * 40, 9, 0, 7);
    g.fill();
  }
  t += reduced ? 0 : 1;
  requestAnimationFrame(frame);
}
frame();
