// Postcard for the result card: your lap pattern as a glowing stripe on a stylized rink. It always uses the dark-ice
// palette so the saved image looks the same in either colour scheme, and it never shows where the scars were.

const W = 1200;
const H = 630;
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const C = {
  bg0: '#0b1820', bg1: '#143040', ice0: '#21485a', ice1: '#183746', board: '#2a2f33', boardEdge: '#6f8795',
  red: '#c8412f', blue: '#4f84dd', cyan: '#5fd3e8', pale: '#e9fbff', mustard: '#f2a900', ink: '#2a2f33', text: '#e8f2f6', muted: '#9db3bf',
};
const GRADE_COLOR = { S: '#5fd3e8', A: '#8db4ff', B: '#f2a900', C: '#9db3bf', D: '#ff8a78' };
const FEET_W = 200;
const FEET_H = 85;
const CORNER = 28;
const SWATH = 8;

function commas(n) { return String(Math.round(+n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

function rrect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function mix(a, b, t) {
  const p = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const q = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return '#' + p.map((v, i) => Math.round(v + (q[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

function drawBackdrop(g) {
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, C.bg0);
  bg.addColorStop(1, C.bg1);
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(95, 211, 232, 0.06)';
  g.lineWidth = 2;
  g.beginPath();
  for (let x = -H; x < W; x += 46) { g.moveTo(x, H); g.lineTo(x + H, 0); }
  g.stroke();
}

function drawRink(g, x0, y0, s) {
  const w = FEET_W * s;
  const h = FEET_H * s;
  g.lineJoin = 'round';
  rrect(g, x0, y0, w, h, CORNER * s);
  g.fillStyle = C.board;
  g.lineWidth = 14;
  g.strokeStyle = C.board;
  g.stroke();
  g.lineWidth = 2;
  g.strokeStyle = C.boardEdge;
  rrect(g, x0 - 8, y0 - 8, w + 16, h + 16, CORNER * s + 8);
  g.stroke();
  rrect(g, x0, y0, w, h, CORNER * s);
  const ice = g.createLinearGradient(x0, y0, x0, y0 + h);
  ice.addColorStop(0, C.ice0);
  ice.addColorStop(1, C.ice1);
  g.fillStyle = ice;
  g.fill();
  g.save();
  g.clip();
  g.lineCap = 'butt';
  g.globalAlpha = 0.8;
  const line = (fx, color, width) => {
    g.strokeStyle = color;
    g.lineWidth = width * s;
    g.beginPath(); g.moveTo(x0 + fx * s, y0); g.lineTo(x0 + fx * s, y0 + h); g.stroke();
  };
  line(11, C.red, 0.4);
  line(189, C.red, 0.4);
  line(75, C.blue, 1);
  line(125, C.blue, 1);
  line(100, C.red, 1);
  g.lineWidth = 1.4 * s;
  g.strokeStyle = C.red;
  for (const [fx, fy] of [[31, 20.5], [31, 64.5], [169, 20.5], [169, 64.5]]) {
    g.beginPath(); g.arc(x0 + fx * s, y0 + fy * s, 15 * s, 0, 6.2832); g.stroke();
    g.fillStyle = C.red;
    g.beginPath(); g.arc(x0 + fx * s, y0 + fy * s, 1 * s, 0, 6.2832); g.fill();
  }
  g.strokeStyle = C.blue;
  g.beginPath(); g.arc(x0 + 100 * s, y0 + 42.5 * s, 15 * s, 0, 6.2832); g.stroke();
  g.fillStyle = C.blue;
  g.beginPath(); g.arc(x0 + 100 * s, y0 + 42.5 * s, 0.8 * s, 0, 6.2832); g.fill();
  g.globalAlpha = 1;
  g.restore();
}

function routePoints(result) {
  const r = result && result.route;
  if (!r || typeof r.length !== 'number') return null;
  const n = Math.min(3000, r.length >> 1);
  return n >= 2 ? { r, n } : null;
}

function drawRoute(g, pts, x0, y0, s) {
  const { r, n } = pts;
  const X = (i) => x0 + (r[i * 2] / 10) * s;
  const Y = (i) => y0 + (r[i * 2 + 1] / 10) * s;
  g.save();
  rrect(g, x0, y0, FEET_W * s, FEET_H * s, CORNER * s);
  g.clip();
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const chunks = 10;
  const per = Math.max(2, Math.ceil((n - 1) / chunks));
  g.shadowColor = 'rgba(95, 211, 232, 0.75)';
  g.shadowBlur = 26;
  for (let start = 0; start < n - 1; start += per) {
    const end = Math.min(n - 1, start + per);
    g.strokeStyle = mix(C.cyan, C.pale, Math.min(1, start / Math.max(1, n - 1)) * 0.75);
    g.lineWidth = SWATH * s;
    g.beginPath();
    g.moveTo(X(start), Y(start));
    for (let i = start + 1; i <= end; i++) g.lineTo(X(i), Y(i));
    g.stroke();
  }
  g.shadowBlur = 0;
  g.strokeStyle = 'rgba(255, 255, 255, 0.55)';
  g.lineWidth = SWATH * s * 0.2;
  g.beginPath();
  g.moveTo(X(0), Y(0));
  for (let i = 1; i < n; i++) g.lineTo(X(i), Y(i));
  g.stroke();
  g.restore();

  g.strokeStyle = C.mustard;
  g.lineWidth = 4;
  g.beginPath(); g.arc(X(0), Y(0), 11, 0, 6.2832); g.stroke();

  // The machine parks where the lap ended, facing the way it was going.
  let back = n - 2;
  while (back > 0 && Math.abs(X(n - 1) - X(back)) + Math.abs(Y(n - 1) - Y(back)) < 6) back--;
  const heading = Math.atan2(Y(n - 1) - Y(back), X(n - 1) - X(back));
  g.save();
  g.translate(X(n - 1), Y(n - 1));
  g.rotate(heading);
  g.fillStyle = C.mustard;
  g.strokeStyle = C.ink;
  g.lineWidth = 2.5;
  rrect(g, -4.4 * s, -3.1 * s, 8.8 * s, 6.2 * s, 1.6 * s);
  g.fill(); g.stroke();
  g.fillStyle = C.ink;
  rrect(g, 0, -2.2 * s, 3.2 * s, 4.4 * s, s);
  g.fill();
  g.restore();
}

function drawHeader(g, result) {
  g.textBaseline = 'alphabetic';
  g.fillStyle = C.text;
  g.font = `700 48px ${FONT}`;
  g.fillText('Between Periods', 60, 72);
  g.fillStyle = C.muted;
  g.font = `400 20px ${FONT}`;
  const seed = String((result && result.seed) || '').slice(0, 24);
  g.fillText(`Rink ${seed}${result && result.mode === 'practice' ? ' · Practice' : result && result.mode === 'auto' ? ' · Bot lap' : ''} · stylized, game scale`, 62, 104);

  const filled = Math.max(0, Math.min(10, Math.round((+result.gleamPct || 0) / 10)));
  for (let i = 0; i < 10; i++) {
    g.fillStyle = i < filled ? C.cyan : 'rgba(157, 179, 191, 0.28)';
    rrect(g, 700 + i * 31, 52, 24, 24, 6);
    g.fill();
  }
  g.fillStyle = C.muted;
  g.font = `600 14px ${FONT}`;
  g.fillText('GLEAM', 700, 98);

  const grade = GRADE_COLOR[result.grade] ? result.grade : 'D';
  g.strokeStyle = GRADE_COLOR[grade];
  g.lineWidth = 4;
  g.beginPath(); g.arc(1100, 68, 44, 0, 6.2832); g.stroke();
  g.lineWidth = 1.5;
  g.beginPath(); g.arc(1100, 68, 37, 0, 6.2832); g.stroke();
  g.fillStyle = GRADE_COLOR[grade];
  g.font = `800 52px ${FONT}`;
  g.textAlign = 'center';
  g.fillText(grade, 1100, 87);
  g.textAlign = 'left';
}

function drawFooter(g, result) {
  const items = [
    `${(+result.gleamPct || 0).toFixed(1)}% gleam`,
    `${commas(result.feet)} ft`,
    `${commas(result.cleanLaps)} clean laps`,
    `${commas(result.points)} pts`,
  ];
  g.font = `600 24px ${FONT}`;
  g.fillStyle = C.text;
  g.textAlign = 'center';
  g.fillText(items.join('   ·   '), W / 2, 612);
  g.textAlign = 'left';
}

export function drawPostcard(canvas, result) {
  if (!canvas || !result) return;
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');
  if (!g) return;
  const s = 5.2;
  const x0 = (W - FEET_W * s) / 2;
  const y0 = 124;
  drawBackdrop(g);
  drawRink(g, x0, y0, s);
  const pts = routePoints(result);
  if (pts) drawRoute(g, pts, x0, y0, s);
  drawHeader(g, result);
  drawFooter(g, result);
}
