// Shared helpers for the gate tests: SED_ROOT sandboxes, a valid PNG encoder, and a project builder.
// Import-safe: nothing runs on import.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REAL_ROOT = path.resolve(HERE, '..', '..');

export const DEFAULT_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; base-uri 'none'; form-action 'none'";

export const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Gate Test',
  GIT_AUTHOR_EMAIL: 'gate@example.invalid',
  GIT_COMMITTER_NAME: 'Gate Test',
  GIT_COMMITTER_EMAIL: 'gate@example.invalid',
};

/** A temp repo root with the read-only inputs the gate scripts need; points SED_ROOT at it. */
export function makeSandbox({ config } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sed-gate-'));
  fs.mkdirSync(path.join(root, 'ops'), { recursive: true });
  fs.mkdirSync(path.join(root, 'state', 'ideas'), { recursive: true });
  fs.mkdirSync(path.join(root, 'state', 'runs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs', 'd'), { recursive: true });
  const cfg = { ...JSON.parse(fs.readFileSync(path.join(REAL_ROOT, 'config.json'), 'utf8')), startDate: '2026-10-09' }; // frozen: fixtures count days from 2026-10-09
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config ? config(cfg) ?? cfg : cfg, null, 2));
  fs.copyFileSync(path.join(REAL_ROOT, 'ops', 'taxonomy.json'), path.join(root, 'ops', 'taxonomy.json'));
  fs.copyFileSync(path.join(REAL_ROOT, 'ops', 'lenses.json'), path.join(root, 'ops', 'lenses.json'));
  fs.writeFileSync(path.join(root, 'state', 'history.json'), JSON.stringify({ schema: 1, startDate: cfg.startDate, entries: [] }, null, 2));
  fs.writeFileSync(path.join(root, 'state', 'carryover.json'), JSON.stringify({ schema: 1, idea: null, savedOn: null, carriedCount: 0 }, null, 2));
  fs.mkdirSync(path.join(root, 'ops', 'kaizen'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ops', 'kaizen', 'INDEX.json'), JSON.stringify({ schema: 1, entries: [] }, null, 2));
  fs.writeFileSync(path.join(root, 'ops', 'kaizen', 'LOG.md'), '# Kaizen log\n\n_No entries yet._\n');
  fs.writeFileSync(path.join(root, 'state', 'kaizen-queue.json'), JSON.stringify({ schema: 1, skipped: [] }, null, 2));
  fs.writeFileSync(path.join(root, 'state', 'throttle.json'), JSON.stringify({ schema: 1, level: 'balanced', cleanDays: 0, lastChange: null, log: [] }, null, 2));
  const prior = process.env.SED_ROOT;
  process.env.SED_ROOT = root;
  return {
    root,
    cfg,
    write(rel, content) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, typeof content === 'string' || Buffer.isBuffer(content) ? content : `${JSON.stringify(content, null, 2)}\n`);
      return abs;
    },
    readJson(rel) {
      return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
    },
    cleanup() {
      if (prior === undefined) delete process.env.SED_ROOT;
      else process.env.SED_ROOT = prior;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Valid 8-bit RGB PNG with a horizontal gradient. */
export function makePng(width = 1200, height = 630) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) {
    row[1 + x * 3] = 11;
    row[2 + x * 3] = 16 + (x % 40);
    row[3 + x * 3] = 32;
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function fingerprint(over = {}) {
  return {
    category: 'math-puzzle', mechanic: 'toy', tone: ['playful'], tech: ['canvas2d'],
    tags: ['automaton', 'cells', 'palette'], keywords: ['grid', 'rules', 'seed'], slot: 'wildcard', political: false, ...over,
  };
}

export function projectJson({ date = '2026-10-09', slug = 'probe', tier = 3, network = [], ...over } = {}) {
  return {
    schema: 1, date, slug, title: 'Probe', tagline: 'A probe page used by the validator tests.',
    description: 'Exists only to be validated.', tier, fingerprint: fingerprint(),
    palette: ['#0b1020', '#ff3d6e', '#ffd166'], entry: 'index.html', thumb: 'thumb.png', network,
    sources: [{ title: 'Hockey', url: 'https://en.wikipedia.org/wiki/Ice_hockey' }], makingOf: 'Test fixture.',
    stats: { files: 0, bytes: 0, ownLoc: 0 }, credits: 'Built by the Sonnet Every Day team', ...over,
  };
}

/** The standard page shell with slots for head and body content. */
export function shellHtml({ head = '', body = '', csp = DEFAULT_CSP, lang = 'en', title = 'Probe', beforeCsp = '', backLink = true, viewport = true } = {}) {
  return `<!doctype html>
<html${lang ? ` lang="${lang}"` : ''}>
<head>
<meta charset="utf-8">
${beforeCsp}${csp === null ? '' : `<meta http-equiv="Content-Security-Policy" content="${csp}">\n`}${viewport ? '<meta name="viewport" content="width=device-width, initial-scale=1">\n' : ''}${title === null ? '' : `<title>${title}</title>\n`}${head}
</head>
<body>
${backLink ? '<a class="sed-back" href="../../">&larr; Sonnet Every Day</a>\n' : ''}${body}
</body>
</html>
`;
}

/**
 * Write a probe project under `parent` and return its directory.
 * `page` replaces index.html wholesale; `files` adds extra files (string | Buffer).
 * `js` / `mjs` / `css` / `inlineJs` are shortcuts that also wire the file into the page.
 */
export function buildProject(parent, opts = {}) {
  const {
    date = '2026-10-09', slug = 'probe', tier = 3, network = [], page, head = '', body = '', csp, files = {}, pj = {}, thumb = makePng(),
    js, mjs, css, inlineJs, shell = {},
  } = opts;
  const dir = path.join(parent, `${date}-${slug}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  let extraHead = head;
  let extraBody = body;
  const all = { ...files };
  if (css !== undefined) {
    all['app.css'] = css;
    extraHead += '<link rel="stylesheet" href="app.css">\n';
  }
  if (js !== undefined) {
    all['app.js'] = js;
    extraBody += '\n<script src="app.js"></script>';
  }
  if (mjs !== undefined) {
    all['app.mjs'] = mjs;
    extraBody += '\n<script type="module" src="app.mjs"></script>';
  }
  if (inlineJs !== undefined) extraBody += `\n<script>\n${inlineJs}\n</script>`;
  const html = page ?? shellHtml({ head: extraHead, body: extraBody, ...(csp !== undefined ? { csp } : {}), ...shell });
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  fs.writeFileSync(path.join(dir, 'project.json'), `${JSON.stringify(projectJson({ date, slug, tier, network, ...pj }), null, 2)}\n`);
  if (thumb !== null) fs.writeFileSync(path.join(dir, 'thumb.png'), thumb);
  for (const [rel, content] of Object.entries(all)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

export function codesOf(list) {
  return list.map((e) => /^([a-z0-9+-]+):/.exec(e)?.[1] ?? e);
}
