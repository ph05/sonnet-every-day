// Contrast Ratio Checker: the WCAG 2.2 contrast ratio between two sRGB colours, computed locally.
// window.__sedSelfTest runs known-answer vectors against the same functions the page uses (browser-check runs it).
(function () {
  'use strict';

  const AA_NORMAL = 4.5;
  const AA_LARGE = 3;
  const AAA_NORMAL = 7;
  const AAA_LARGE = 4.5;
  const UI_COMPONENTS = 3;

  /** "#rgb" or "#rrggbb" (the # is optional, case does not matter) to [r, g, b] in 0..255, or null. */
  function parseHex(input) {
    const s = String(input).trim().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(s)) return s.split('').map((c) => parseInt(c + c, 16));
    if (/^[0-9a-f]{6}$/i.test(s)) return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
    return null;
  }

  function toHex(rgb) {
    return '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
  }

  /** WCAG 2.2 relative luminance of an sRGB colour (0 for black, 1 for white). */
  function luminance(rgb) {
    const lin = rgb.map((v) => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  }

  /** (L1 + 0.05) / (L2 + 0.05) with L1 the lighter colour: from 1 (same colour) to 21 (black on white). */
  function contrastRatio(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  /** Two decimals, never rounded up: 4.478 shows as 4.47, so a shown pass is always a real pass. */
  function shown(ratio) {
    return (Math.floor(ratio * 100) / 100).toFixed(2);
  }

  function verdicts(ratio) {
    return [
      { id: 'aa-normal', label: 'Normal text, level AA', need: AA_NORMAL, pass: ratio >= AA_NORMAL },
      { id: 'aa-large', label: 'Large text, level AA', need: AA_LARGE, pass: ratio >= AA_LARGE },
      { id: 'aaa-normal', label: 'Normal text, level AAA', need: AAA_NORMAL, pass: ratio >= AAA_NORMAL },
      { id: 'aaa-large', label: 'Large text, level AAA', need: AAA_LARGE, pass: ratio >= AAA_LARGE },
      { id: 'ui', label: 'Icons and input borders', need: UI_COMPONENTS, pass: ratio >= UI_COMPONENTS },
    ];
  }

  /* ---------- the page ---------- */

  const $ = (id) => document.getElementById(id);
  const fields = {
    fg: { text: $('fg-text'), pick: $('fg-pick'), error: $('fg-error') },
    bg: { text: $('bg-text'), pick: $('bg-pick'), error: $('bg-error') },
  };
  const state = { fg: parseHex(fields.fg.text.value) || [89, 89, 89], bg: parseHex(fields.bg.text.value) || [255, 255, 255] };

  function render() {
    const ratio = contrastRatio(state.fg, state.bg);
    $('ratio').textContent = shown(ratio);
    const sample = $('sample');
    sample.style.color = toHex(state.fg);
    sample.style.backgroundColor = toHex(state.bg);
    const list = $('verdicts');
    list.textContent = '';
    for (const v of verdicts(ratio)) {
      const li = document.createElement('li');
      li.className = v.pass ? 'is-pass' : 'is-fail';
      const mark = document.createElement('strong');
      mark.textContent = v.pass ? 'Pass' : 'Fail';
      li.append(mark, ' ' + v.label + ' (needs ' + v.need + ':1)');
      list.append(li);
    }
  }

  function setColour(which, rgb, from) {
    state[which] = rgb;
    const f = fields[which];
    if (from !== 'text') f.text.value = toHex(rgb);
    if (from !== 'pick') f.pick.value = toHex(rgb);
    f.error.textContent = '';
    f.text.removeAttribute('aria-invalid');
    render();
  }

  for (const which of ['fg', 'bg']) {
    const f = fields[which];
    f.text.addEventListener('input', () => {
      const rgb = parseHex(f.text.value);
      if (rgb) setColour(which, rgb, 'text');
      else {
        f.text.setAttribute('aria-invalid', 'true');
        f.error.textContent = 'Type a hex colour such as #1a73e8 or #fff.';
      }
    });
    f.pick.addEventListener('input', () => setColour(which, parseHex(f.pick.value), 'pick'));
  }

  $('swap').addEventListener('click', () => {
    const fg = state.fg;
    setColour('fg', state.bg);
    setColour('bg', fg);
  });

  $('copy').addEventListener('click', async () => {
    const line = toHex(state.fg) + ' on ' + toHex(state.bg) + ': ' + shown(contrastRatio(state.fg, state.bg)) + ':1';
    try {
      await navigator.clipboard.writeText(line);
      $('copied').textContent = 'Copied: ' + line;
    } catch (e) {
      $('copied').textContent = line;
    }
  });

  render();

  /* ---------- known-answer self-test (browser-check runs it; the sources are in the explainer) ---------- */

  const VECTORS = [
    { name: 'black on white is the maximum, 21:1 (WCAG 2.2 definition)', fg: '#000000', bg: '#ffffff', ratio: 21 },
    { name: 'a colour on itself is the minimum, 1:1 (WCAG 2.2 definition)', fg: '#ffffff', bg: '#ffffff', ratio: 1 },
    { name: '#777777 on white is 4.48:1 and fails AA for normal text (WebAIM)', fg: '#777777', bg: '#ffffff', ratio: 4.4781, aaNormal: false },
    { name: '#767676 on white is 4.54:1, the lightest grey that passes AA (WebAIM)', fg: '#767676', bg: '#ffffff', ratio: 4.5422, aaNormal: true },
    { name: '#595959 on white is 7.00:1 and passes AAA (WebAIM)', fg: '#595959', bg: '#ffffff', ratio: 7.0047, aaaNormal: true },
    { name: 'pure red on white is 3.998:1, just below 4:1 (WebAIM)', fg: '#ff0000', bg: '#ffffff', ratio: 3.9985, aaNormal: false },
    { name: 'pure blue on white is 8.59:1 (WebAIM)', fg: '#0000ff', bg: '#ffffff', ratio: 8.5925 },
    { name: 'pure green on black is 15.30:1 (WebAIM)', fg: '#00ff00', bg: '#000000', ratio: 15.304 },
    { name: 'yellow on black is 19.56:1 (WebAIM)', fg: '#ffff00', bg: '#000000', ratio: 19.556 },
    { name: 'the order of the two colours does not matter', fg: '#1a73e8', bg: '#ffffff', swap: true },
    { name: 'three-digit hex expands each digit', parse: '#fa0', rgb: [255, 170, 0] },
    { name: 'text that is not a colour is rejected', parse: 'zzz', rgb: null },
  ];

  function runCase(v) {
    if (v.parse !== undefined) {
      const got = parseHex(v.parse);
      return { name: v.name, ok: JSON.stringify(got) === JSON.stringify(v.rgb), detail: 'parsed ' + JSON.stringify(got) };
    }
    const a = parseHex(v.fg);
    const b = parseHex(v.bg);
    const r = contrastRatio(a, b);
    if (v.swap) return { name: v.name, ok: Math.abs(r - contrastRatio(b, a)) < 1e-12, detail: 'ratio ' + r };
    let ok = Math.abs(r - v.ratio) < 0.0005;
    const levels = verdicts(r);
    if (v.aaNormal !== undefined) ok = ok && levels[0].pass === v.aaNormal;
    if (v.aaaNormal !== undefined) ok = ok && levels[2].pass === v.aaaNormal;
    return { name: v.name, ok: ok, detail: 'ratio ' + r.toFixed(4) };
  }

  window.__sedSelfTest = function () {
    const cases = VECTORS.map(runCase);
    const passed = cases.filter((c) => c.ok).length;
    return { ok: passed === cases.length, total: cases.length, passed: passed, cases: cases };
  };
})();
