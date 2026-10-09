// Shared, dependency-free helpers for every Sonnet Every Day script.
// Node 22 stdlib only. Keep this file tiny and stable: other components import it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Repo root. Tests point SED_ROOT at a temp dir to run scripts against a sandbox. */
export function repoRoot() {
  return process.env.SED_ROOT ? path.resolve(process.env.SED_ROOT) : path.resolve(HERE, '..', '..');
}
export function rp(...parts) {
  return path.join(repoRoot(), ...parts);
}

export function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (fallback !== undefined) return fallback;
    throw new Error(`readJson(${file}): ${err.message}`);
  }
}

/** Atomic write: temp file in the same dir, then rename. 2-space indent, trailing newline. */
export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function loadConfig() {
  return readJson(rp('config.json'));
}
export function loadTaxonomy() {
  return readJson(rp('ops', 'taxonomy.json'));
}

/** Minimal argv parser: positional args in `_`, `--flag value`, `--flag=value`, bare `--flag` => true. */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          out[key] = next;
          i++;
        } else {
          out[key] = true;
        }
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

/** Current instant. `--now <ISO>` (or SED_NOW env) overrides it so every time-dependent script is testable. */
export function resolveNow(flags = {}) {
  const raw = flags.now || process.env.SED_NOW;
  if (!raw) return new Date();
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new Error(`bad --now value: ${raw}`);
  return d;
}

/** Local calendar parts of an instant in an IANA timezone. */
export function localParts(instant, tz) {
  const d = instant instanceof Date ? instant : new Date(instant);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', weekday: 'short',
  });
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  const hh = Number(p.hour);
  const mm = Number(p.minute);
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`,
    minutes: hh * 60 + mm,
    weekday: p.weekday,
  };
}

/** "HH:MM" => minutes after local midnight. */
export function hm(str) {
  const [h, m] = String(str).split(':').map(Number);
  return h * 60 + m;
}

/** Day number of `date` counting startDate as day 1. */
export function dayNumber(date, startDate) {
  const a = Date.parse(`${startDate}T00:00:00Z`);
  const b = Date.parse(`${date}T00:00:00Z`);
  return Math.round((b - a) / 86400000) + 1;
}

export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function slugify(s, max = 40) {
  return String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, max)
    .replace(/^-|-$/g, '');
}

/** FNV-1a 32-bit string hash. */
export function hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic PRNG: seed a uint32, get () => [0,1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function print(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

export function die(msg, code = 1, extra = {}) {
  process.stdout.write(JSON.stringify({ ok: false, error: msg, ...extra }, null, 2) + '\n');
  process.exit(code);
}
