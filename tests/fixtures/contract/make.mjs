// Regenerates index.html and project.json of the two conforming page-contract fixtures from ops/templates/page-shell.html:
// a tool (2026-10-20-contrast-checker) and a lesson (2026-10-21-parity-bit-lesson). Their app.js / app.css and
// thumb.png are hand-made and kept as they are. Usage: node tests/fixtures/contract/make.mjs
// The tests derive one broken variant per contract rule from these pages (tests/validate.test.mjs, tests/qa.test.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHELL = fs.readFileSync(path.join(HERE, '..', '..', '..', 'ops', 'templates', 'page-shell.html'), 'utf8');

function fill(shell, spec) {
  let html = shell.replace(/^<!doctype html>\n<!--[\s\S]*?-->\n/, '<!doctype html>\n');
  const swap = (from, to) => {
    if (!html.includes(from)) throw new Error(`shell slot not found: ${from.slice(0, 60)}`);
    html = html.replace(from, () => to);
  };
  swap('<title>Project Title</title>', `<title>${spec.title}</title>`);
  swap('content="One or two sentences about what this page does."', `content="${spec.metaDescription}"`);
  swap('  /* SLOT: your project\'s CSS may go here, or in a style.css next to index.html */\n</style>', '</style>\n<link rel="stylesheet" href="app.css">');
  swap('<p class="sed-day">Day 0 &middot; 0000-00-00</p>', `<p class="sed-day">Day ${spec.n} &middot; ${spec.date}</p>`);
  swap('<h1 class="sed-title">Project Title</h1>', `<h1 class="sed-title">${spec.title}</h1>`);
  swap('<p class="sed-tagline">One line that makes someone want to try it.</p>', `<p class="sed-tagline">${spec.tagline}</p>`);
  swap('<span data-sed-placeholder>35 to 70 words: what this is, who it is for, what to do first.</span>', spec.intro);
  swap('  <div class="sed-placeholder" data-sed-placeholder>The project goes here.</div>\n', `${spec.app}\n`);
  swap('    <p data-sed-placeholder>The explanation goes here.</p>\n    <!-- lessons: at least two exercises, each an element with data-sed-check, e.g. <div class="sed-check" data-sed-check>...</div> -->\n', `${spec.explainer}\n`);
  swap('<p class="sed-making-of" data-sed-placeholder>How this was made: what it does, what was researched, what the interesting design choices were.</p>', `<p class="sed-making-of">${spec.makingOf}</p>`);
  swap('        <li data-sed-placeholder><a href="https://example.com/source">Source title</a>: what it established.</li>', spec.sources.map((s) => `        <li><a href="${s.url}">${s.title}</a>: ${s.what}</li>`).join('\n'));
  swap('  <!-- Add scripts with a relative path, e.g. <script type="module" src="app.js"></script>.\n       Keep them at the end of <main> or use "defer"/type="module" so the markup exists first. -->\n', '  <script src="app.js" defer></script>\n');
  return html.replace(/\n *<!-- SLOT[^\n]*-->/g, '');
}

function write(spec) {
  const dir = path.join(HERE, `${spec.date}-${spec.slug}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), fill(SHELL, spec));
  fs.writeFileSync(path.join(dir, 'project.json'), `${JSON.stringify(spec.project, null, 2)}\n`);
}

const TOOL_INTRO = 'A calculator that measures the contrast ratio between a text colour and a background colour, the number the Web Content Accessibility Guidelines use to judge readable text. It is for designers and developers checking a palette. Type or pick two colours; the ratio and the pass or fail verdicts update at once. Everything runs in your browser.';
const TOOL_SOURCES = [
  { title: 'Web Content Accessibility Guidelines (WCAG) 2.2', url: 'https://www.w3.org/TR/WCAG22/', what: 'the definitions of relative luminance and contrast ratio, and the 4.5:1, 3:1 and 7:1 thresholds' },
  { title: 'Understanding Success Criterion 1.4.3: Contrast (Minimum)', url: 'https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html', what: 'what counts as large text, and that a ratio is never rounded up' },
  { title: 'WebAIM: Contrast Checker', url: 'https://webaim.org/resources/contrastchecker/', what: 'reference values for the known-answer tests, such as 4.48:1 for #777777 on white' },
];

write({
  date: '2026-10-20',
  slug: 'contrast-checker',
  n: 12,
  title: 'Contrast Ratio Checker',
  metaDescription: 'A calculator for the WCAG contrast ratio between a text colour and a background colour, with pass or fail for each level.',
  tagline: 'A calculator for the contrast ratio between two colours, with the WCAG pass or fail for text.',
  intro: TOOL_INTRO,
  app: `  <section class="cc" aria-label="Contrast checker">
    <div class="cc-pickers">
      <div class="cc-field">
        <label for="fg-text">Text colour</label>
        <div class="cc-row"><input id="fg-text" type="text" value="#595959" maxlength="7" spellcheck="false" autocomplete="off"><input id="fg-pick" type="color" value="#595959" aria-label="Pick the text colour"></div>
        <p class="cc-error" id="fg-error" aria-live="polite"></p>
      </div>
      <div class="cc-field">
        <label for="bg-text">Background colour</label>
        <div class="cc-row"><input id="bg-text" type="text" value="#ffffff" maxlength="7" spellcheck="false" autocomplete="off"><input id="bg-pick" type="color" value="#ffffff" aria-label="Pick the background colour"></div>
        <p class="cc-error" id="bg-error" aria-live="polite"></p>
      </div>
      <div class="cc-actions">
        <button type="button" class="sed-btn is-quiet" id="swap">Swap colours</button>
        <button type="button" class="sed-btn is-quiet" id="copy">Copy result</button>
      </div>
      <p class="cc-copied" id="copied" aria-live="polite"></p>
    </div>
    <div class="cc-result" aria-live="polite">
      <p class="cc-ratio"><span id="ratio">7.00</span><small>:1 contrast</small></p>
      <ul class="cc-verdicts" id="verdicts"></ul>
      <p class="cc-sample" id="sample">Sample text in the two colours: the quick brown fox jumps over the lazy dog.</p>
    </div>
  </section>`,
  explainer: `    <h3>What the ratio measures</h3>
    <p>The contrast ratio compares how much light two colours send to your eye. It runs from 1:1, a colour against itself, to 21:1, black against white. The Web Content Accessibility Guidelines, WCAG for short, use it as the test for readable text, because people with low vision or a dim screen lose the difference between two colours long before you do.</p>
    <h3>How it is computed</h3>
    <p>Each colour first becomes a relative luminance: a number from 0 for black to 1 for white. The red, green and blue channels are turned from screen values back into light (the sRGB curve), then weighted by how bright each looks to the eye: green counts for about 72 percent, red for 21 and blue for 7. That is why pure blue text feels dark and pure green feels bright.</p>
    <p>The ratio is then the lighter luminance plus 0.05, divided by the darker luminance plus 0.05. The 0.05 stands for a little glare on any real screen, and it is the reason the scale stops at 21 instead of going on forever.</p>
    <h3>What passes</h3>
    <ul>
      <li>Normal text needs 4.5:1 for level AA and 7:1 for level AAA.</li>
      <li>Large text (about 24 pixels, or 19 pixels in bold) needs 3:1 for AA and 4.5:1 for AAA.</li>
      <li>Icons and the borders of inputs need 3:1.</li>
    </ul>
    <p>The ratio is shown with two decimals and is never rounded up: grey #777777 on white is 4.478:1, so it shows as 4.47 and fails AA, even though it looks close enough.</p>
    <h3>Limits</h3>
    <p>This tool checks solid sRGB colours given as hex codes. It cannot judge text on a photo or a gradient, transparent colours, thin fonts or colour blindness, and it uses the WCAG 2 formula, not newer proposals such as APCA. Treat a pass as a minimum, not a guarantee that everyone can read your text. Nothing you type leaves this page.</p>`,
  makingOf: 'The formulas come straight from the WCAG 2.2 definitions; twelve known-answer tests from WCAG and WebAIM run in the page and in QA (window.__sedSelfTest).',
  sources: TOOL_SOURCES,
  project: {
    schema: 1,
    date: '2026-10-20',
    slug: 'contrast-checker',
    title: 'Contrast Ratio Checker',
    tagline: 'A calculator for the contrast ratio between two colours, with the WCAG pass or fail for text.',
    description: 'Type or pick a text colour and a background colour; the page shows their WCAG 2.2 contrast ratio and whether it passes each level. Everything runs locally.',
    intro: TOOL_INTRO,
    concepts: ['contrast ratio', 'relative luminance', 'WCAG levels'],
    tier: 2,
    fingerprint: {
      purpose: 'tool', category: 'design-craft', mechanic: 'checker', tone: ['analytical'], tech: ['dom-ui'],
      tags: ['contrast', 'accessibility', 'colour', 'wcag'], keywords: ['luminance', 'ratio', 'readability'], slot: 'wildcard', political: false,
    },
    palette: ['#f6f5f1', '#4b32d6', '#595959', '#1d7a3a'],
    entry: 'index.html',
    thumb: 'thumb.png',
    network: [],
    sources: TOOL_SOURCES.map(({ title, url }) => ({ title, url })),
    makingOf: 'The formulas come straight from the WCAG 2.2 definitions; twelve known-answer tests from WCAG and WebAIM run in the page and in QA.',
    stats: { files: 5, bytes: 0, ownLoc: 0 },
    credits: 'Built by the Sonnet Every Day team',
  },
});

const LESSON_INTRO = 'A lesson on the parity bit, the simplest way a computer notices that data was damaged on the way. It is for anyone curious about error detection; no maths beyond counting is needed. Flip the bits in the demo below and watch the check react, then try the two exercises at the end.';
const LESSON_SOURCES = [
  { title: 'Parity bit (Wikipedia)', url: 'https://en.wikipedia.org/wiki/Parity_bit', what: 'even and odd parity, and that a parity bit detects any odd number of flipped bits but no even number' },
  { title: 'Error detection and correction (Wikipedia)', url: 'https://en.wikipedia.org/wiki/Error_detection_and_correction', what: 'the difference between detecting an error and correcting it' },
];

write({
  date: '2026-10-21',
  slug: 'parity-bit-lesson',
  n: 13,
  title: 'Parity Bit Lesson',
  metaDescription: 'An interactive lesson on the parity bit: how one extra bit tells a receiver that a message was damaged, and what it cannot tell.',
  tagline: 'A short lesson on the parity bit: one extra bit that tells you a message was damaged.',
  intro: LESSON_INTRO,
  app: `  <section class="pb" aria-labelledby="pb-title">
    <h2 id="pb-title" class="pb-title">Try it: four data bits and one parity bit</h2>
    <div class="pb-bits" id="bits" role="group" aria-label="The message, bit by bit"></div>
    <p class="pb-status" id="status" aria-live="polite"></p>
    <div class="pb-actions">
      <button type="button" class="sed-btn" id="noise">Send it through a noisy wire</button>
      <button type="button" class="sed-btn is-quiet" id="fresh">New message</button>
    </div>
  </section>`,
  explainer: `    <p>Every time data moves, from a disk to memory or from one computer to another, a bit can flip: a 0 arrives as a 1, or a 1 as a 0. Cosmic rays, electrical noise and worn-out storage all do it. Most of the time nothing goes wrong, but when something does, the receiver has to notice. The parity bit is the oldest and simplest trick for noticing.</p>
    <h3>Counting the ones</h3>
    <p>Take a message of four bits, say 1011. Count its ones: there are three. With even parity, the sender adds one extra bit, the parity bit, chosen so that the total number of ones becomes even. Three ones need one more, so the parity bit is 1 and the sender transmits 10111. A message with two ones, such as 1001, would get a parity bit of 0, because two is already even.</p>
    <p>The receiver does the same count on all five bits. If the number of ones is even, the check passes. If it is odd, at least one bit must have flipped on the way, so the receiver throws the message away or asks for it again. That is the whole idea: one extra bit, one count.</p>
    <h3>A worked example</h3>
    <p>Follow one message all the way. The sender wants to send 1011 and adds the parity bit 1, so 10111 leaves. On the wire, the second bit flips and 11111 arrives. The receiver counts five ones. Five is odd, so it rejects the message and asks for it again. The second time nothing flips, 10111 arrives, the count is four, four is even, and the receiver keeps the four data bits 1011 and drops the parity bit, which has done its job.</p>
    <p>Notice what the receiver never needed: it did not know the original message, and it did not compare anything with the sender. Everything it needs travels inside the message itself. That is what makes a parity bit so cheap. The price is one extra bit for every four data bits here, or one for every seven or eight in real systems.</p>
    <h3>Why one flip is always caught</h3>
    <p>Flipping a single bit changes the number of ones by exactly one, up or down. An even count plus or minus one is always odd. So whichever bit flips, even the parity bit itself, the receiver sees an odd count and knows the message is damaged. In the demo above, click any one bit and the check fails at once.</p>
    <h3>Why two flips slip through</h3>
    <p>Here is the common misconception: that a parity bit catches every error. It does not. Flip two bits and the count changes by two, or by zero if one flip removes a one and the other adds one. Either way an even count stays even, and the check passes on a damaged message. In general a parity bit catches any odd number of flipped bits and misses any even number. Try it in the demo: flip two bits and watch the check pass.</p>
    <h3>Detecting is not correcting</h3>
    <p>A failed parity check says that something flipped, not which bit. The receiver cannot repair the message, because flipping any of the five bits would make the count even again. Codes that correct errors, such as Hamming codes, add several parity bits, each covering a different group of positions, so that the pattern of failed checks points at the broken bit. They cost more bits for the same message, which is the price of knowing where the damage is.</p>
    <h3>Where you meet it</h3>
    <p>Parity is cheap, so it shows up where errors are rare and a resend is easy: old serial links between computers sent seven data bits and a parity bit per character, and some memory chips keep a parity bit for every byte. Where errors come in bursts, as on a scratched disc or a radio link, stronger checks such as checksums and cyclic redundancy checks take over, because a burst often flips two bits at once.</p>
    <div class="sed-check" data-sed-check>
      <h3>Exercise 1</h3>
      <p>The four data bits are 0110 and the sender uses even parity. What parity bit does the sender add?</p>
      <details><summary>Show the answer</summary><p>0. The data already has two ones, an even number, so the parity bit stays 0 and the sender transmits 01100.</p></details>
    </div>
    <div class="sed-check" data-sed-check>
      <h3>Exercise 2</h3>
      <p>The receiver gets 11010 with even parity. Was the message damaged, and can the receiver tell which bit flipped?</p>
      <details><summary>Show the answer</summary><p>Yes. 11010 has three ones, an odd number, so at least one bit flipped. The receiver cannot tell which one: flipping any of the five bits would make the count even again, so it asks for the message again.</p></details>
    </div>`,
  makingOf: 'The demo counts ones exactly as the explainer does; the two exercises were checked by hand and by the page self-test.',
  sources: LESSON_SOURCES,
  project: {
    schema: 1,
    date: '2026-10-21',
    slug: 'parity-bit-lesson',
    title: 'Parity Bit Lesson',
    tagline: 'A short lesson on the parity bit: one extra bit that tells you a message was damaged.',
    description: 'An interactive lesson: flip bits in a five-bit message and see why a parity bit catches one flipped bit but never two.',
    intro: LESSON_INTRO,
    concepts: ['parity bit', 'even parity', 'error detection'],
    tier: 2,
    fingerprint: {
      purpose: 'lesson', category: 'algorithms-cs', mechanic: 'lesson', tone: ['nerdy', 'cozy'], tech: ['dom-ui'],
      tags: ['parity', 'bits', 'errors', 'lesson'], keywords: ['error-detection', 'binary', 'checksum'], slot: 'wildcard', political: false,
    },
    palette: ['#0e1016', '#a99cff', '#4b32d6', '#f6f5f1'],
    entry: 'index.html',
    thumb: 'thumb.png',
    network: [],
    sources: LESSON_SOURCES.map(({ title, url }) => ({ title, url })),
    makingOf: 'The demo counts ones exactly as the explainer does; the two exercises were checked by hand and by the page self-test.',
    stats: { files: 5, bytes: 0, ownLoc: 0 },
    credits: 'Built by the Sonnet Every Day team',
  },
});
console.log('wrote the contract fixtures');
