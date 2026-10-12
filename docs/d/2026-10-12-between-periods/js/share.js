// Between Periods: the URL-hash grammar, the challenge comparison and the share text.
// Pure: no browser globals, no clock. todaySeed takes the instant from its caller.

export const SEED_RE = /^[A-Za-z0-9_-]{1,24}$/;

const HASH_RE = /^[A-Za-z0-9_=&.-]{0,512}$/;
const CHALLENGE_RE = /^([SABCD])-([0-9]{1,5})$/;
const AUTO_NAMES = ['mow', 'spiral', 'race'];
const GRADE_ORDER = 'DCBAS';
const MS_PER_DAY = 86400000;
const MAX_FEET = 99999;

export function isValidSeed(x) {
  return typeof x === 'string' && SEED_RE.test(x);
}

// Days since 1970-01-01 to a proleptic Gregorian [year, month, day] (integer arithmetic only).
function civilFromDays(z) {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return [yoe + era * 400 + (month <= 2 ? 1 : 0), month, day];
}

const pad = (n, w) => String(n).padStart(w, '0');

// The daily seed is the UTC calendar date, so everyone shares one rink.
export function todaySeed(nowMs) {
  let t = Number(nowMs);
  if (!Number.isFinite(t)) t = 0;
  t = Math.max(-8.64e15, Math.min(8.64e15, t));
  const [y, m, d] = civilFromDays(Math.floor(t / MS_PER_DAY));
  return pad(y, 4) + '-' + pad(m, 2) + '-' + pad(d, 2);
}

export function gradeRank(g) {
  return typeof g === 'string' && g.length === 1 ? GRADE_ORDER.indexOf(g) : -1;
}

// A result beats a challenge with a higher grade, or the same grade in fewer feet.
export function beats(r, c) {
  if (!r || !c) return false;
  const a = gradeRank(r.grade), b = gradeRank(c.grade);
  if (a < 0 || b < 0) return false;
  return a > b || (a === b && Number(r.feet) < Number(c.feet));
}

const clampFeet = (n) => Math.min(MAX_FEET, Math.max(0, Math.round(Number(n)) || 0));

// Always returns a safe state: a bad part of the hash falls back to its default and sets `note`.
export function parseHash(hash, nowMs) {
  const out = { seed: todaySeed(nowMs), challenge: null, auto: null, note: '' };
  if (hash === undefined || hash === null) return out;
  if (typeof hash !== 'string') {
    out.note = 'bad-hash';
    return out;
  }
  let h = hash;
  if (h.charCodeAt(0) === 35) h = h.slice(1);
  if (h === '') return out;
  if (!HASH_RE.test(h)) {
    out.note = 'bad-hash';
    return out;
  }
  const seen = { s: false, c: false, a: false };
  let seed = null, challenge = null, auto = null, badSeed = false, badOther = false;
  const parts = h.split('&');
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === '') continue;
    const eq = part.indexOf('=');
    const key = eq < 0 ? part : part.slice(0, eq);
    const val = eq < 0 ? '' : part.slice(eq + 1);
    if (key !== 's' && key !== 'c' && key !== 'a') continue;
    if (seen[key]) continue;
    seen[key] = true;
    if (key === 's') {
      if (isValidSeed(val)) seed = val;
      else badSeed = true;
    } else if (key === 'c') {
      const mt = CHALLENGE_RE.exec(val);
      if (mt) challenge = { grade: mt[1], feet: clampFeet(mt[2]) };
      else badOther = true;
    } else if (AUTO_NAMES.indexOf(val) >= 0) {
      auto = val;
    } else {
      badOther = true;
    }
  }
  if (seed !== null) out.seed = seed;
  // A challenge belongs to a rink; when the seed was unusable the rink changed, so the bar goes too.
  out.challenge = badSeed ? null : challenge;
  out.auto = auto;
  out.note = badOther ? 'bad-hash' : badSeed ? 'bad-seed' : '';
  return out;
}

// The canonical hash (no leading '#'): the seed always, the challenge when there is one.
export function buildHash(state) {
  const s = state && state.seed;
  if (!isValidSeed(s)) return '';
  let out = 's=' + s;
  const c = state.challenge;
  if (c && gradeRank(c.grade) >= 0 && Number.isFinite(Number(c.feet))) out += '&c=' + c.grade + '-' + clampFeet(c.feet);
  return out;
}

const withCommas = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// Four lines, no names and no free text: the rink, the grade line, a ten-glyph strip and the link.
export function shareText(result, url) {
  const r = result || {};
  const seed = isValidSeed(r.seed) ? r.seed : 'unknown';
  const grade = gradeRank(r.grade) >= 0 ? r.grade : 'D';
  const points = Math.min(1000, Math.max(0, Math.round(Number(r.points)) || 0));
  const feet = clampFeet(r.feet);
  const laps = Math.max(0, Math.round(Number(r.cleanLaps)) || 0);
  const filled = Math.min(10, Math.max(0, Math.round((Number(r.gleamPct) || 0) / 10)));
  const line2 = (r.mode === 'practice' ? 'Practice · ' : '') +
    'Gleam ' + grade + ' (' + points + ' pts) · ' + withCommas(feet) + ' ft · ' + laps + (laps === 1 ? ' clean lap' : ' clean laps');
  return [
    'Between Periods · rink ' + seed,
    line2,
    '🟦'.repeat(filled) + '⬜'.repeat(10 - filled),
    typeof url === 'string' ? url : '',
  ].join('\n');
}
