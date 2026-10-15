/* Postcard scene generator: one deterministic composition per date.
 *
 * A single source of truth for three renderers: the animated canvas2d page (browser), the static SVG
 * (no-JS and reduced-motion fallback) and the software-rasterized thumbnail (scripts/lib/png.mjs, Node).
 * It is a plain classic script (no imports, no DOM) so Node can evaluate it in a vm context and the page
 * can load it with an ordinary <script src>. Everything here is a pure function of the date string.
 *
 * Scene items live in a 1200x630 space:
 *   {k:'bg',   stops:[[t,hex],...], ang}                  full-canvas linear gradient (ang in degrees)
 *   {k:'glow', x,y,r,c,a,sy,m}                            soft light blob, smooth falloff to 0 at r
 *   {k:'circle', x,y,r,f,fa,s,sw,sa,m}                    fill and/or stroke
 *   {k:'path', p:[x,y,...],w,c,a,closed,m}                stroked polyline, round caps and joins
 *   {k:'segs', p:[x1,y1,x2,y2,...],w,c,a,m}               independent stroked segments
 *   {k:'poly', p:[x,y,...],c,a,m,s,sw,sa}                 filled polygon, optional outline
 *   {k:'rect', x,y,w,h,r,c,a,m}                           (rounded) rect
 * Blend modes m: 'add' | 'screen' | 'multiply' (omitted = normal).
 */
(function (root) {
  'use strict';

  var W = 1200;
  var H = 630;
  var TAU = Math.PI * 2;
  var VERSION = 1;

  // ---- small utilities ---------------------------------------------------------------------

  // Same algorithms as scripts/lib/common.mjs (FNV-1a and mulberry32); tests assert they stay in sync.
  function hashStr(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function range(rng, a, b) { return a + (b - a) * rng(); }
  function pick(rng, arr) { return arr[Math.floor(rng() * arr.length) % arr.length]; }
  function shuffle(rng, arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function hex2(n) { n = clamp(Math.round(n), 0, 255); return (n < 16 ? '0' : '') + n.toString(16); }
  function rgbHex(r, g, b) { return '#' + hex2(r) + hex2(g) + hex2(b); }
  function hexRgb(h) {
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }
  function mix(a, b, t) {
    var p = hexRgb(a);
    var q = hexRgb(b);
    return rgbHex(lerp(p[0], q[0], t), lerp(p[1], q[1], t), lerp(p[2], q[2], t));
  }
  function hsl(h, s, l) {
    var hh = (((h % 360) + 360) % 360) / 360;
    function f(n) {
      var k = (n + hh * 12) % 12;
      return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    }
    return rgbHex(f(0) * 255, f(8) * 255, f(4) * 255);
  }
  function luminance(hex) {
    var c = hexRgb(hex).map(function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  // Smooth 3D value noise, seeded.
  function makeNoise(rng) {
    var perm = shuffle(rng, Array.from({ length: 256 }, function (_, i) { return i; }));
    var P = new Uint8Array(512);
    var V = new Float32Array(256);
    for (var i = 0; i < 512; i++) P[i] = perm[i & 255];
    for (var j = 0; j < 256; j++) V[j] = rng();
    function lat(x, y, z) { return V[P[P[P[x & 255] + (y & 255)] + (z & 255)]]; }
    function fade(t) { return t * t * (3 - 2 * t); }
    function n3(x, y, z) {
      var xi = Math.floor(x); var yi = Math.floor(y); var zi = Math.floor(z);
      var u = fade(x - xi); var v = fade(y - yi); var w = fade(z - zi);
      var a = lerp(lat(xi, yi, zi), lat(xi + 1, yi, zi), u);
      var b = lerp(lat(xi, yi + 1, zi), lat(xi + 1, yi + 1, zi), u);
      var c = lerp(lat(xi, yi, zi + 1), lat(xi + 1, yi, zi + 1), u);
      var d = lerp(lat(xi, yi + 1, zi + 1), lat(xi + 1, yi + 1, zi + 1), u);
      return lerp(lerp(a, b, v), lerp(c, d, v), w);
    }
    function fbm(x, y, z, oct) {
      var sum = 0; var amp = 0.5; var norm = 0;
      for (var o = 0; o < oct; o++) {
        sum += amp * n3(x, y, z);
        norm += amp;
        x *= 2; y *= 2; z *= 2; amp *= 0.5;
      }
      return sum / norm;
    }
    return { n3: n3, fbm: fbm };
  }

  function arcPoints(cx, cy, r, a0, a1, n) {
    var out = [];
    for (var i = 0; i <= n; i++) {
      var a = lerp(a0, a1, i / n);
      out.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    return out;
  }

  function roundRectPoints(cx, cy, w, h, r, angle, segs) {
    var hw = w / 2; var hh = h / 2;
    var corners = [
      [hw - r, -hh + r, -Math.PI / 2], [hw - r, hh - r, 0], [-hw + r, hh - r, Math.PI / 2], [-hw + r, -hh + r, Math.PI],
    ];
    var cos = Math.cos(angle); var sin = Math.sin(angle);
    var pts = [];
    corners.forEach(function (c) {
      for (var i = 0; i <= segs; i++) {
        var a = c[2] + (i / segs) * (Math.PI / 2);
        var x = c[0] + Math.cos(a) * r;
        var y = c[1] + Math.sin(a) * r;
        pts.push(cx + x * cos - y * sin, cy + x * sin + y * cos);
      }
    });
    return pts;
  }

  // ---- palette -----------------------------------------------------------------------------

  var SCHEMES = [
    ['analogous', [0, 26, 52, -26, -52]],
    ['complementary', [0, 14, 180, 194, -14]],
    ['triad', [0, 120, 240, 22, 142]],
    ['split', [0, 150, 210, 30, -30]],
    ['tetrad', [0, 90, 180, 270, 45]],
  ];

  function makePalette(rng, light) {
    var h0 = rng() * 360;
    var sc = pick(rng, SCHEMES);
    var o = sc[1];
    var sat = 0.62 + rng() * 0.28;
    var ink = [];
    for (var i = 0; i < 5; i++) {
      ink.push(light ? hsl(h0 + o[i], sat, 0.34 + (i % 3) * 0.07) : hsl(h0 + o[i], sat, 0.56 + (i % 2) * 0.09));
    }
    var accent = light ? hsl(h0 + o[1], 0.85, 0.44) : hsl(h0 + o[1] + 8, 0.95, 0.66);
    var bg0; var bg1;
    if (light) {
      bg0 = hsl(h0, 0.38, 0.95);
      bg1 = hsl(h0 + o[1], 0.34, 0.86);
    } else {
      bg0 = hsl(h0 + o[2], 0.5, 0.04 + rng() * 0.03);
      bg1 = hsl(h0, 0.55, 0.1 + rng() * 0.06);
    }
    return { scheme: sc[0], hue: Math.round(h0), light: !!light, bg: [bg0, bg1], ink: ink, accent: accent };
  }

  // ---- families ----------------------------------------------------------------------------

  var FAMILIES = [];

  // 1. Aurora ribbons
  FAMILIES.push({
    id: 'aurora',
    name: 'Aurora Ribbons',
    blurb: 'curtains of light over a quiet ridge',
    still: 7,
    setup: function (rng, pal, noise) {
      var n = 4 + Math.floor(rng() * 3);
      var ribbons = [];
      for (var i = 0; i < n; i++) {
        ribbons.push({
          base: H * (0.2 + 0.36 * (i / (n - 1))) + range(rng, -18, 18),
          a1: range(rng, 26, 58), f1: range(rng, 0.004, 0.009), p1: rng() * TAU, s1: range(rng, 0.15, 0.4),
          a2: range(rng, 10, 26), f2: range(rng, 0.011, 0.02), p2: rng() * TAU, s2: range(rng, 0.2, 0.6),
          a3: range(rng, 4, 12), f3: range(rng, 0.03, 0.05), p3: rng() * TAU, s3: range(rng, 0.4, 0.9),
          th: range(rng, 80, 150), fth: range(rng, 0.004, 0.01), pth: rng() * TAU, sth: range(rng, 0.1, 0.3),
          c: pal.ink[i % pal.ink.length],
        });
      }
      var stars = [];
      for (var s = 0; s < 150; s++) {
        stars.push({ x: rng() * W, y: rng() * H * 0.72, r: 0.5 + rng() * 1.2, p: rng() * TAU, sp: 0.6 + rng() * 1.8, a: 0.3 + rng() * 0.55 });
      }
      var moon = rng() < 0.65 ? { x: range(rng, 140, W - 140), y: range(rng, 60, 170), r: range(rng, 18, 34) } : null;
      var ridgeSeeds = [rng() * 100, rng() * 100];
      return { ribbons: ribbons, stars: stars, moon: moon, ridgeSeeds: ridgeSeeds, noise: noise };
    },
    frame: function (st, t, pal) {
      var items = [{ k: 'bg', stops: [[0, pal.bg[0]], [1, pal.bg[1]]], ang: 90 }];
      var starCol = mix(pal.ink[0], '#ffffff', 0.7);
      st.stars.forEach(function (s) {
        items.push({ k: 'circle', x: s.x, y: s.y, r: s.r, f: starCol, fa: s.a * (0.55 + 0.45 * Math.sin(t * s.sp + s.p)) });
      });
      if (st.moon) {
        items.push({ k: 'glow', x: st.moon.x, y: st.moon.y, r: st.moon.r * 7, c: mix(pal.ink[0], '#ffffff', 0.6), a: 0.28, m: 'add' });
        items.push({ k: 'circle', x: st.moon.x, y: st.moon.y, r: st.moon.r, f: mix(pal.ink[0], '#ffffff', 0.85), fa: 0.95 });
      }
      st.ribbons.forEach(function (r) {
        var top = []; var bot = []; var core = [];
        for (var x = -24; x <= W + 24; x += 12) {
          var y = r.base + r.a1 * Math.sin(x * r.f1 + r.p1 + t * r.s1) + r.a2 * Math.sin(x * r.f2 + r.p2 + t * r.s2) + r.a3 * Math.sin(x * r.f3 + r.p3 + t * r.s3);
          var th = r.th * (0.62 + 0.38 * Math.sin(x * r.fth + r.pth + t * r.sth));
          top.push([x, y - th * 0.5]);
          bot.push([x, y + th * 0.5]);
          core.push(x, y);
        }
        for (var L = 0; L < 6; L++) {
          var k = 1 - L * 0.17;
          var pts = [];
          for (var i = 0; i < top.length; i++) {
            var mid = (top[i][1] + bot[i][1]) / 2;
            var half = ((bot[i][1] - top[i][1]) / 2) * k;
            pts.push(top[i][0], mid - half);
          }
          for (var j = top.length - 1; j >= 0; j--) {
            var mid2 = (top[j][1] + bot[j][1]) / 2;
            var half2 = ((bot[j][1] - top[j][1]) / 2) * k;
            pts.push(bot[j][0], mid2 + half2);
          }
          items.push({ k: 'poly', p: pts, c: r.c, a: 0.05 + L * 0.014, m: 'add' });
        }
        items.push({ k: 'path', p: core, w: 2.2, c: mix(r.c, '#ffffff', 0.45), a: 0.4, m: 'add' });
      });
      var ridge = function (seed, base, amp, scale, col, a) {
        var pts = [];
        for (var x = 0; x <= W; x += 10) {
          pts.push(x, base + (st.noise.fbm(x * scale + seed, seed, 0, 4) - 0.5) * amp);
        }
        pts.push(W, H, 0, H);
        return { k: 'poly', p: pts, c: col, a: a };
      };
      items.push(ridge(st.ridgeSeeds[0], H * 0.8, 120, 0.004, mix(pal.bg[0], pal.ink[2], 0.1), 1));
      items.push(ridge(st.ridgeSeeds[1], H * 0.9, 70, 0.006, mix(pal.bg[0], '#000000', 0.35), 1));
      return items;
    },
  });

  // 2. Constellation graph
  FAMILIES.push({
    id: 'constellation',
    name: 'Constellation Graph',
    blurb: 'sixty-odd points, drifting, wired by distance',
    still: 9,
    setup: function (rng, pal) {
      var nodes = [];
      for (var i = 0; i < 68; i++) {
        var big = rng() > 0.9;
        nodes.push({
          cx: range(rng, 60, W - 60), cy: range(rng, 50, H - 50), rx: range(rng, 14, 64), ry: range(rng, 14, 52),
          w1: range(rng, 0.08, 0.3), w2: range(rng, 0.08, 0.3), p: rng() * TAU, q: rng() * TAU,
          size: big ? range(rng, 4.5, 7) : range(rng, 1.4, 3.4), c: pal.ink[Math.floor(rng() * pal.ink.length)], big: big,
        });
      }
      var dust = [];
      for (var d = 0; d < 110; d++) dust.push({ x: rng() * W, y: rng() * H, r: 0.4 + rng() * 0.9, a: 0.1 + rng() * 0.3 });
      var nebula = [
        { x: range(rng, 200, 500), y: range(rng, 150, 480), r: range(rng, 260, 380), c: pal.ink[3], a: 0.2 },
        { x: range(rng, 700, 1000), y: range(rng, 120, 480), r: range(rng, 240, 360), c: pal.ink[1], a: 0.17 },
      ];
      return { nodes: nodes, dust: dust, nebula: nebula };
    },
    frame: function (st, t, pal) {
      var items = [{ k: 'bg', stops: [[0, pal.bg[0]], [1, pal.bg[1]]], ang: 60 }];
      st.nebula.forEach(function (n) { items.push({ k: 'glow', x: n.x, y: n.y, r: n.r, c: n.c, a: n.a, m: 'add' }); });
      var dustCol = mix(pal.ink[0], '#ffffff', 0.6);
      st.dust.forEach(function (d) { items.push({ k: 'circle', x: d.x, y: d.y, r: d.r, f: dustCol, fa: d.a }); });
      var pos = st.nodes.map(function (n) {
        return [n.cx + n.rx * Math.sin(t * n.w1 + n.p), n.cy + n.ry * Math.cos(t * n.w2 + n.q)];
      });
      var R = 178;
      var buckets = [[], [], []];
      for (var i = 0; i < pos.length; i++) {
        for (var j = i + 1; j < pos.length; j++) {
          var dx = pos[i][0] - pos[j][0]; var dy = pos[i][1] - pos[j][1];
          var d2 = dx * dx + dy * dy;
          if (d2 < R * R) {
            var b = Math.min(2, Math.floor((1 - Math.sqrt(d2) / R) * 3));
            buckets[b].push(pos[i][0], pos[i][1], pos[j][0], pos[j][1]);
          }
        }
      }
      var widths = [0.9, 1.2, 1.7]; var alphas = [0.16, 0.3, 0.5];
      for (var k = 0; k < 3; k++) {
        if (buckets[k].length) items.push({ k: 'segs', p: buckets[k], w: widths[k], c: mix(pal.ink[0], pal.accent, 0.35), a: alphas[k], m: 'add' });
      }
      st.nodes.forEach(function (n, idx) {
        var p = pos[idx];
        items.push({ k: 'glow', x: p[0], y: p[1], r: n.size * (n.big ? 9 : 6), c: n.c, a: n.big ? 0.55 : 0.4, m: 'add' });
        items.push({ k: 'circle', x: p[0], y: p[1], r: n.size, f: mix(n.c, '#ffffff', 0.55), fa: 1 });
        if (n.big) items.push({ k: 'circle', x: p[0], y: p[1], r: n.size + 5 + 1.5 * Math.sin(t * 1.3 + idx), s: n.c, sw: 1, sa: 0.55 });
      });
      return items;
    },
  });

  // 3. Isoline terrain (marching squares)
  var MS_EDGES = {
    1: [[3, 2]], 2: [[2, 1]], 3: [[3, 1]], 4: [[0, 1]], 5: [[0, 1], [3, 2]], 6: [[0, 2]], 7: [[0, 3]],
    8: [[0, 3]], 9: [[0, 2]], 10: [[0, 3], [1, 2]], 11: [[0, 1]], 12: [[3, 1]], 13: [[1, 2]], 14: [[3, 2]],
  };
  FAMILIES.push({
    id: 'isolines',
    name: 'Isoline Terrain',
    blurb: 'a map of a landscape that does not exist',
    still: 12,
    setup: function (rng, pal, noise) {
      return {
        noise: noise, ox: rng() * 50, oy: rng() * 50, sc: range(rng, 2.2, 3.6),
        hill: { x: range(rng, 0.25, 0.75), y: range(rng, 0.3, 0.7), r: range(rng, 0.25, 0.4) },
        levels: 15, gx: 72, gy: 38, glowAt: [rng(), rng()],
      };
    },
    frame: function (st, t, pal) {
      var items = [{ k: 'bg', stops: [[0, pal.bg[0]], [1, pal.bg[1]]], ang: 120 }];
      items.push({ k: 'glow', x: W * st.hill.x, y: H * st.hill.y, r: 380, c: pal.ink[2], a: 0.16, m: 'add' });
      var gx = st.gx; var gy = st.gy;
      var cw = W / gx; var ch = H / gy;
      var field = new Float32Array((gx + 1) * (gy + 1));
      for (var j = 0; j <= gy; j++) {
        for (var i = 0; i <= gx; i++) {
          var u = i / gx; var v = j / gy;
          var n = st.noise.fbm(u * st.sc + st.ox, v * st.sc * 0.6 + st.oy, t * 0.05, 4);
          var hdx = (u - st.hill.x) * 1.7; var hdy = v - st.hill.y;
          var hill = Math.exp(-(hdx * hdx + hdy * hdy) / (st.hill.r * st.hill.r));
          field[j * (gx + 1) + i] = n * 0.78 + hill * 0.34;
        }
      }
      var lo = Infinity; var hi = -Infinity;
      for (var q = 0; q < field.length; q++) { if (field[q] < lo) lo = field[q]; if (field[q] > hi) hi = field[q]; }
      for (var L = 1; L <= st.levels; L++) {
        var level = lerp(lo, hi, L / (st.levels + 1));
        var segs = [];
        for (var cy = 0; cy < gy; cy++) {
          for (var cx = 0; cx < gx; cx++) {
            var a = field[cy * (gx + 1) + cx]; var b = field[cy * (gx + 1) + cx + 1];
            var c = field[(cy + 1) * (gx + 1) + cx + 1]; var d = field[(cy + 1) * (gx + 1) + cx];
            var idx = (a > level ? 8 : 0) | (b > level ? 4 : 0) | (c > level ? 2 : 0) | (d > level ? 1 : 0);
            var pairs = MS_EDGES[idx];
            if (!pairs) continue;
            var x0 = cx * cw; var y0 = cy * ch;
            var edge = function (e) {
              if (e === 0) return [x0 + cw * ((level - a) / (b - a)), y0];
              if (e === 1) return [x0 + cw, y0 + ch * ((level - b) / (c - b))];
              if (e === 2) return [x0 + cw * ((level - d) / (c - d)), y0 + ch];
              return [x0, y0 + ch * ((level - a) / (d - a))];
            };
            for (var pi = 0; pi < pairs.length; pi++) {
              var p0 = edge(pairs[pi][0]); var p1 = edge(pairs[pi][1]);
              segs.push(Math.round(p0[0]), Math.round(p0[1]), Math.round(p1[0]), Math.round(p1[1]));
            }
          }
        }
        if (!segs.length) continue;
        var f = L / (st.levels + 1);
        var col = f < 0.5 ? mix(pal.ink[0], pal.ink[1], f * 2) : mix(pal.ink[1], pal.ink[3], (f - 0.5) * 2);
        var major = L % 4 === 0;
        items.push({ k: 'segs', p: segs, w: major ? 2.6 : 1.3, c: col, a: major ? 0.95 : 0.6, m: major ? undefined : 'add' });
      }
      return items;
    },
  });

  // 4. Rink-line geometry
  FAMILIES.push({
    id: 'rink',
    name: 'Rink Lines',
    blurb: 'the ice, drawn as neon, with a few restless pucks',
    still: 5,
    setup: function (rng, pal) {
      var pucks = [];
      for (var i = 0; i < 5; i++) {
        pucks.push({
          ax: range(rng, 70, 96), ay: range(rng, 20, 38), a: range(rng, 0.28, 0.72), b: range(rng, 0.31, 0.83),
          p: rng() * TAU, q: rng() * TAU, c: pal.ink[i % pal.ink.length],
        });
      }
      var marks = [];
      for (var m = 0; m < 22; m++) {
        var cx = range(rng, 140, W - 140); var cy = range(rng, 120, H - 120); var r = range(rng, 60, 240);
        var a0 = rng() * TAU;
        marks.push(arcPoints(cx, cy, r, a0, a0 + range(rng, 0.4, 1.3), 18));
      }
      return { pucks: pucks, marks: marks, tilt: range(rng, -0.14, 0.14), ph: rng() * TAU, mirror: rng() < 0.5 };
    },
    frame: function (st, t, pal) {
      var items = [{ k: 'bg', stops: [[0, pal.bg[0]], [1, pal.bg[1]]], ang: 100 }];
      st.marks.forEach(function (m) { items.push({ k: 'path', p: m, w: 1.6, c: pal.ink[4], a: 0.09 }); });
      var s = 4.8 + 0.12 * Math.sin(t * 0.35 + st.ph);
      var th = st.tilt + 0.05 * Math.sin(t * 0.22 + st.ph);
      var cx = W / 2; var cy = H / 2 + 8 * Math.sin(t * 0.3);
      var cos = Math.cos(th); var sin = Math.sin(th);
      var T = function (x, y) { return [cx + s * (x * cos - y * sin), cy + s * (x * sin + y * cos)]; };
      var flat = function (pts) {
        var out = [];
        for (var i = 0; i < pts.length; i += 2) { var p = T(pts[i], pts[i + 1]); out.push(p[0], p[1]); }
        return out;
      };
      var rinkPts = [];
      var corner = function (ccx, ccy, a0) { for (var i = 0; i <= 12; i++) { var a = a0 + (i / 12) * (Math.PI / 2); rinkPts.push(ccx + Math.cos(a) * 28, ccy + Math.sin(a) * 28); } };
      corner(72, -14.5, -Math.PI / 2); corner(72, 14.5, 0); corner(-72, 14.5, Math.PI / 2); corner(-72, -14.5, Math.PI);
      var outline = flat(rinkPts);
      items.push({ k: 'poly', p: outline, c: mix(pal.bg[1], pal.ink[0], 0.08), a: 1 });
      items.push({ k: 'glow', x: cx, y: cy, r: 560, c: pal.ink[0], a: 0.1, sy: 0.55, m: 'add' });
      // sheen bands drift across the ice
      for (var b = 0; b < 3; b++) {
        var off = ((t * 18 + b * 340) % 1500) - 300;
        var band = flat([off - 60, -50, off + 10, -50, off + 110, 50, off + 40, 50]);
        items.push({ k: 'poly', p: band, c: '#ffffff', a: 0.025, m: 'add' });
      }
      var glowLine = function (pts, w, col, a, closed) {
        items.push({ k: 'path', p: pts, w: w * 3.2, c: col, a: a * 0.16, closed: closed, m: 'add' });
        items.push({ k: 'path', p: pts, w: w, c: col, a: a, closed: closed });
      };
      glowLine(outline, 4.5, pal.ink[0], 0.95, true);
      var ln = function (x1, y1, x2, y2, w, col, a) { glowLine(flat([x1, y1, x2, y2]), w, col, a, false); };
      ln(0, -42.5, 0, 42.5, 5.5, pal.accent, 0.95);
      ln(-25, -42.5, -25, 42.5, 5.5, pal.ink[1], 0.95);
      ln(25, -42.5, 25, 42.5, 5.5, pal.ink[1], 0.95);
      ln(-89, -36.7, -89, 36.7, 2.2, pal.accent, 0.8);
      ln(89, -36.7, 89, 36.7, 2.2, pal.accent, 0.8);
      glowLine(flat(arcPoints(0, 0, 15, 0, TAU, 48)), 2.8, pal.ink[2], 0.85, true);
      var centerDot = T(0, 0);
      items.push({ k: 'circle', x: centerDot[0], y: centerDot[1], r: 0.7 * s, f: pal.ink[2], fa: 0.95 });
      [[-69, -22], [-69, 22], [69, -22], [69, 22]].forEach(function (c) {
        glowLine(flat(arcPoints(c[0], c[1], 15, 0, TAU, 40)), 2.6, pal.accent, 0.75, true);
        var d = T(c[0], c[1]);
        items.push({ k: 'circle', x: d[0], y: d[1], r: 1.1 * s, f: pal.accent, fa: 0.95 });
      });
      [[-20, -22], [-20, 22], [20, -22], [20, 22]].forEach(function (c) {
        var d = T(c[0], c[1]);
        items.push({ k: 'circle', x: d[0], y: d[1], r: 0.9 * s, f: pal.ink[3], fa: 0.9 });
      });
      [[-89, Math.PI / 2], [89, -Math.PI / 2]].forEach(function (g) {
        var arc = flat(arcPoints(g[0], 0, 6, g[1], g[1] + Math.PI, 18));
        items.push({ k: 'poly', p: arc, c: pal.ink[3], a: 0.22 });
        glowLine(arc, 2.4, pal.ink[3], 0.8, false);
        var sgn = g[0] < 0 ? -1 : 1;
        glowLine(flat([g[0], -3, g[0] + sgn * 3.5, -3, g[0] + sgn * 3.5, 3, g[0], 3]), 2.4, pal.ink[4], 0.85, false);
      });
      st.pucks.forEach(function (p) {
        var at = function (tt) { return T(p.ax * Math.sin(p.a * tt + p.p), p.ay * Math.sin(p.b * tt + p.q)); };
        var trail = [];
        var chunks = 6; var per = 7;
        for (var c = 0; c < chunks; c++) {
          var pts = [];
          for (var i = 0; i <= per; i++) {
            var q = at(t - (c * per + i) * 0.05);
            pts.push(q[0], q[1]);
          }
          trail.push(pts);
        }
        trail.forEach(function (pts, idx) {
          items.push({ k: 'path', p: pts, w: 3.4 - idx * 0.35, c: p.c, a: 0.75 * (1 - idx / chunks), m: 'add' });
        });
        var head = at(t);
        items.push({ k: 'glow', x: head[0], y: head[1], r: 26, c: p.c, a: 0.85, m: 'add' });
        items.push({ k: 'circle', x: head[0], y: head[1], r: 6.4, f: '#ffffff', fa: 0.95, s: p.c, sw: 2, sa: 1 });
      });
      return items;
    },
  });

  // 5. Card-fan fractal
  FAMILIES.push({
    id: 'cardfan',
    name: 'Card-Fan Fractal',
    blurb: 'a hand of cards, dealt recursively',
    still: 4,
    setup: function (rng, pal) {
      var roots = [];
      var n = rng() < 0.5 ? 1 : 2;
      for (var i = 0; i < n; i++) {
        roots.push({ x: n === 1 ? W / 2 + range(rng, -60, 60) : (i ? W * 0.7 : W * 0.3) + range(rng, -30, 30), size: n === 1 ? range(rng, 270, 310) : range(rng, 220, 250), spread: range(rng, 1.15, 1.5), cards: 7 });
      }
      return { roots: roots, depth: 2, sway: range(rng, 0.3, 0.7), ph: rng() * TAU, order: shuffle(rng, [0, 1, 2, 3, 4]) };
    },
    frame: function (st, t, pal) {
      var items = [{ k: 'bg', stops: [[0, pal.bg[0]], [1, pal.bg[1]]], ang: 90 }];
      items.push({ k: 'glow', x: W / 2, y: H * 0.7, r: 520, c: pal.ink[st.order[0]], a: 0.14, m: 'add' });
      var layers = [[], [], []];
      var fan = function (x, y, base, size, depth, cards, spread, rootIdx) {
        var level = st.depth - depth;
        var sp = spread * (1 + 0.09 * Math.sin(t * st.sway + st.ph + level * 1.3 + rootIdx));
        for (var i = 0; i < cards; i++) {
          var f = cards === 1 ? 0 : i / (cards - 1) - 0.5;
          var ang = base + f * sp;
          var cw = size * 0.6; var chh = size;
          // the card's pivot is its bottom center; its center sits half a card away along the angle
          var ccx = x + Math.sin(ang) * chh / 2; var ccy = y - Math.cos(ang) * chh / 2;
          var col = pal.ink[st.order[(i + level) % 5]];
          var pts = roundRectPoints(ccx, ccy, cw, chh, size * 0.07, ang, 4);
          layers[level].push({ k: 'poly', p: pts, c: mix(col, pal.bg[0], 0.72), a: 0.92, s: col, sw: Math.max(1.4, 3.2 - level * 0.8), sa: 0.95 });
          var pip = size * 0.1;
          layers[level].push({ k: 'circle', x: ccx, y: ccy, r: pip, f: col, fa: 0.85 });
          var lx = -cw * 0.3; var ly = -chh * 0.32;
          layers[level].push({ k: 'circle', x: ccx + lx * Math.cos(ang) - ly * Math.sin(ang), y: ccy + lx * Math.sin(ang) + ly * Math.cos(ang), r: pip * 0.36, f: col, fa: 0.8 });
          if (depth > 0) {
            var tipx = x + Math.sin(ang) * chh; var tipy = y - Math.cos(ang) * chh;
            fan(tipx, tipy, ang, size * 0.44, depth - 1, 3, spread * 0.55, rootIdx);
          }
        }
      };
      st.roots.forEach(function (r, i) { fan(r.x, H + 14, 0, r.size, st.depth, r.cards, r.spread, i); });
      layers.forEach(function (l) { for (var i = 0; i < l.length; i++) items.push(l[i]); });
      return items;
    },
  });

  // 6. Glitch sunrise
  function glitchLevel(t) { return clamp((Math.sin(t * 1.1) * Math.sin(t * 0.37 + 1) - 0.32) * 2.4, 0, 1); }
  FAMILIES.push({
    id: 'sunrise',
    name: 'Glitch Sunrise',
    blurb: 'a sun on a bad cable, over a grid that never ends',
    still: (function () { var bt = 0; var gap = 9; for (var t = 0; t < 40; t += 0.25) { var d = Math.abs(glitchLevel(t) - 0.55); if (d < gap) { gap = d; bt = t; } } return bt; })(),
    setup: function (rng, pal) {
      var slices = 24; var hashes = [];
      for (var i = 0; i < slices; i++) hashes.push([rng(), rng()]);
      var buildings = []; var x = 0;
      while (x < W) { var w = range(rng, 18, 54); buildings.push({ x: x, w: w, h: range(rng, 8, 70) }); x += w + range(rng, 0, 6); }
      var stars = [];
      for (var s = 0; s < 90; s++) stars.push({ x: rng() * W, y: rng() * H * 0.45, r: 0.5 + rng() * 1.1, a: 0.25 + rng() * 0.5, p: rng() * TAU });
      return { slices: slices, hashes: hashes, buildings: buildings, stars: stars, sunX: W * range(rng, 0.34, 0.66), sunR: range(rng, 150, 200), horizon: H * range(rng, 0.58, 0.64), vp: W * range(rng, 0.4, 0.6) };
    },
    frame: function (st, t, pal) {
      var g = glitchLevel(t);
      var hz = st.horizon; var cy = hz - st.sunR * 0.12; var top = cy - st.sunR;
      var items = [{ k: 'bg', stops: [[0, pal.bg[0]], [0.62, mix(pal.bg[1], pal.ink[1], 0.18)], [1, mix(pal.bg[1], pal.accent, 0.28)]], ang: 90 }];
      var starCol = mix(pal.ink[0], '#ffffff', 0.7);
      st.stars.forEach(function (s) { items.push({ k: 'circle', x: s.x, y: s.y, r: s.r, f: starCol, fa: s.a * (0.6 + 0.4 * Math.sin(t * 1.4 + s.p)) }); });
      items.push({ k: 'glow', x: st.sunX, y: cy, r: st.sunR * 2.4, c: pal.accent, a: 0.38, m: 'add' });
      var sliceH = (st.sunR * 1.12) / st.slices;
      var drawSlices = function (dx, col0, col1, a, m, jitter) {
        for (var i = 0; i < st.slices; i++) {
          var f = i / (st.slices - 1);
          var gap = Math.max(0, f - 0.4) * 0.95;
          var y0 = top + i * (st.sunR * 2 * 0.99 / st.slices);
          var h = sliceH * (1 - gap);
          var yc = y0 + h / 2; var dy = yc - cy;
          if (Math.abs(dy) >= st.sunR - 1 || y0 + h > hz) continue;
          var hw = Math.sqrt(st.sunR * st.sunR - dy * dy);
          var off = jitter && st.hashes[i][1] > 0.62 ? g * (st.hashes[i][0] - 0.5) * 80 : 0;
          items.push({ k: 'rect', x: st.sunX - hw + dx + off, y: y0, w: hw * 2, h: Math.max(1.5, h), c: mix(col0, col1, f), a: a, m: m });
        }
      };
      if (g > 0.05) {
        drawSlices(-(5 + 16 * g), pal.ink[2], pal.ink[3], 0.38, 'add', true);
        drawSlices(5 + 16 * g, pal.ink[3], pal.ink[4], 0.38, 'add', true);
      }
      drawSlices(0, pal.accent, pal.ink[0], 1, undefined, true);
      st.buildings.forEach(function (b) { items.push({ k: 'rect', x: b.x, y: hz - b.h, w: b.w, h: b.h + 1, c: mix(pal.bg[0], '#000000', 0.3), a: 1 }); });
      items.push({ k: 'rect', x: 0, y: hz, w: W, h: H - hz, c: mix(pal.bg[0], pal.bg[1], 0.35), a: 1 });
      items.push({ k: 'glow', x: st.sunX, y: hz, r: 420, c: pal.accent, a: 0.3, sy: 0.18, m: 'add' });
      var hl = []; var vl = [];
      var N = 14;
      for (var k = 0; k < N; k++) {
        var z = ((k + t * 0.4) % N) / N;
        var y = hz + (H - hz) * z * z;
        hl.push(0, y, W, y);
      }
      for (var i = -14; i <= 14; i++) vl.push(st.vp + i * 12, hz, st.vp + i * 150, H);
      items.push({ k: 'segs', p: hl, w: 1.8, c: pal.ink[1], a: 0.75, m: 'add' });
      items.push({ k: 'segs', p: vl, w: 1.3, c: pal.ink[1], a: 0.5, m: 'add' });
      items.push({ k: 'rect', x: 0, y: hz - 1, w: W, h: 2.5, c: mix(pal.accent, '#ffffff', 0.4), a: 0.9, m: 'add' });
      if (g > 0.05) {
        var bursts = Math.floor(t * 9);
        var r2 = mulberry32(bursts * 7919 + 13);
        var n = 3 + Math.floor(g * 5);
        for (var b = 0; b < n; b++) {
          var bw = W * (0.18 + r2() * 0.35); items.push({ k: 'rect', x: r2() * (W - bw), y: r2() * H, w: bw, h: 2 + r2() * 9 * g, c: pick(r2, pal.ink), a: 0.14 + 0.16 * g, m: 'add' });
        }
      }
      var scan = [];
      for (var y2 = 0; y2 < H; y2 += 5) scan.push(0, y2 + 0.5, W, y2 + 0.5);
      items.push({ k: 'segs', p: scan, w: 1, c: '#000000', a: 0.1 });
      return items;
    },
  });

  // 7. Ink bloom (light paper)
  FAMILIES.push({
    id: 'inkbloom',
    name: 'Ink Bloom',
    blurb: 'drops of colored ink finding their own edges',
    light: true,
    still: 8,
    setup: function (rng, pal, noise) {
      var blooms = [];
      var n = 6 + Math.floor(rng() * 4);
      for (var i = 0; i < n; i++) {
        blooms.push({ x: range(rng, 120, W - 120), y: range(rng, 90, H - 90), R: range(rng, 70, 190), c: pal.ink[i % pal.ink.length], o: rng() * 40, p: rng() * TAU, k: range(rng, 0.9, 1.7) });
      }
      var drops = [];
      for (var d = 0; d < 40; d++) { var b = blooms[Math.floor(rng() * blooms.length)]; drops.push({ b: b, a: rng() * TAU, dist: range(rng, 1.15, 1.9), r: range(rng, 1, 5.5) }); }
      return { blooms: blooms, drops: drops, noise: noise };
    },
    frame: function (st, t, pal) {
      var items = [{ k: 'bg', stops: [[0, pal.bg[0]], [1, pal.bg[1]]], ang: 45 }];
      var paperDots = [];
      for (var y = 14; y < H; y += 26) for (var x = (y / 26) % 2 ? 14 : 27; x < W; x += 26) paperDots.push(x, y, x + 0.01, y);
      items.push({ k: 'segs', p: paperDots, w: 1.4, c: pal.ink[0], a: 0.09 });
      var radius = function (b, th, i, tt) {
        var nz = st.noise.fbm(Math.cos(th) * b.k + b.o + i * 0.31, Math.sin(th) * b.k + b.o, tt * 0.12 + i * 0.2, 3);
        return (0.72 + 0.56 * nz);
      };
      st.blooms.forEach(function (b, bi) {
        var R = b.R * (0.9 + 0.1 * Math.sin(t * 0.4 + b.p));
        for (var L = 0; L < 9; L++) {
          var pts = [];
          var scale = 1 - L * 0.095;
          for (var s = 0; s < 72; s++) {
            var th = (s / 72) * TAU;
            var rr = R * scale * radius(b, th, L, t);
            pts.push(b.x + Math.cos(th) * rr, b.y + Math.sin(th) * rr);
          }
          items.push({ k: 'poly', p: pts, c: b.c, a: 0.1 + L * 0.012, m: 'multiply' });
          if (L === 0) items.push({ k: 'path', p: pts, w: 1.2, c: b.c, a: 0.55, closed: true });
        }
        var veins = [];
        for (var v = 0; v < 26; v++) {
          var tv = (v / 26) * TAU + bi;
          var r0 = R * 0.62 * radius(b, tv, 0, t);
          var r1 = R * (1.0 + 0.2 * st.noise.n3(v * 0.7, bi * 1.9, t * 0.1)) * radius(b, tv, 0, t);
          veins.push(b.x + Math.cos(tv) * r0, b.y + Math.sin(tv) * r0, b.x + Math.cos(tv) * r1, b.y + Math.sin(tv) * r1);
        }
        items.push({ k: 'segs', p: veins, w: 0.9, c: b.c, a: 0.3 });
      });
      st.drops.forEach(function (d) {
        var R = d.b.R * (0.9 + 0.1 * Math.sin(t * 0.4 + d.b.p)) * d.dist;
        items.push({ k: 'circle', x: d.b.x + Math.cos(d.a) * R, y: d.b.y + Math.sin(d.a) * R, r: d.r, f: d.b.c, fa: 0.55 });
      });
      return items;
    },
  });

  // 8. Harmonograph
  FAMILIES.push({
    id: 'harmonograph',
    name: 'Harmonograph',
    blurb: 'four slowly dying pendulums holding a pen',
    still: 3,
    setup: function (rng, pal) {
      var ratios = [2, 3, 1.5, 2.5, 4, 5 / 3];
      var comp = [];
      for (var i = 0; i < 4; i++) {
        comp.push({ A: range(rng, i < 2 ? 150 : 70, i < 2 ? 250 : 150), f: pick(rng, ratios) + range(rng, -0.012, 0.012), p: rng() * TAU, d: range(rng, 0.004, 0.011), drift: range(rng, 0.01, 0.045) });
      }
      var ticks = [];
      for (var k = 0; k < 72; k++) { var a = (k / 72) * TAU; var r0 = k % 6 === 0 ? 292 : 300; ticks.push(a, r0); }
      return { comp: comp, ticks: ticks, T: range(rng, 85, 125) };
    },
    frame: function (st, t, pal) {
      var items = [{ k: 'bg', stops: [[0, pal.bg[1]], [1, pal.bg[0]]], ang: 90 }];
      var cx = W / 2; var cy = H / 2;
      items.push({ k: 'glow', x: cx, y: cy, r: 400, c: pal.ink[2], a: 0.2, m: 'add' });
      [150, 220, 292].forEach(function (r, i) { items.push({ k: 'circle', x: cx, y: cy, r: r, s: pal.ink[i], sw: 1, sa: 0.18 }); });
      var tickSegs = [];
      for (var i = 0; i < st.ticks.length; i += 2) {
        var a = st.ticks[i]; var r0 = st.ticks[i + 1];
        tickSegs.push(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0 * 1.0, cx + Math.cos(a) * 306, cy + Math.sin(a) * 306);
      }
      items.push({ k: 'segs', p: tickSegs, w: 1.2, c: pal.ink[4], a: 0.3 });
      var N = 3200; var chunks = 10; var per = N / chunks;
      var pt = function (u) {
        var T = u * st.T;
        var c = st.comp;
        var ph = function (k) { return c[k].p + t * c[k].drift; };
        var x = c[0].A * Math.sin(T * c[0].f + ph(0)) * Math.exp(-c[0].d * T) + c[1].A * Math.sin(T * c[1].f + ph(1)) * Math.exp(-c[1].d * T);
        var y = c[2].A * Math.sin(T * c[2].f + ph(2)) * Math.exp(-c[2].d * T) + c[3].A * Math.sin(T * c[3].f + ph(3)) * Math.exp(-c[3].d * T);
        return [cx + x * 0.98, cy + y * 0.98];
      };
      for (var ch = 0; ch < chunks; ch++) {
        var pts = [];
        for (var s = 0; s <= per; s++) { var p = pt((ch * per + s) / N); pts.push(p[0], p[1]); }
        var f = ch / (chunks - 1);
        var col = f < 0.5 ? mix(pal.ink[0], pal.ink[1], f * 2) : mix(pal.ink[1], pal.ink[3], (f - 0.5) * 2);
        items.push({ k: 'path', p: pts, w: 1.25, c: col, a: 0.78 - f * 0.28, m: 'add' });
      }
      var tip = pt(1);
      items.push({ k: 'glow', x: tip[0], y: tip[1], r: 20, c: pal.accent, a: 0.9, m: 'add' });
      return items;
    },
  });

  // ---- family selection and scene --------------------------------------------------------------

  function daysSinceEpoch(date) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date));
    if (!m) throw new Error('postcard: bad date ' + date);
    return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000);
  }

  // Each run of 8 consecutive days shows every family once, in an order the date seeds, and a family
  // never appears on two consecutive days (cycle boundaries are repaired).
  function rawOrder(cycle) {
    return shuffle(mulberry32(hashStr('postcard-cycle-' + cycle)), FAMILIES.map(function (_, i) { return i; }));
  }
  function cycleOrder(cycle) {
    var order = rawOrder(cycle);
    if (cycle > 0) {
      // keep the previous cycle's last family out of the first two slots (positions 2+ and 7 are never
      // touched, so its raw last entry is its real last entry)
      var idx = order.indexOf(rawOrder(cycle - 1)[FAMILIES.length - 1]);
      if (idx < 2) { var t = order[idx]; order[idx] = order[idx + 2]; order[idx + 2] = t; }
    }
    return order;
  }
  function familyIndex(date) {
    var day = daysSinceEpoch(date);
    var n = FAMILIES.length;
    return cycleOrder(Math.floor(day / n))[((day % n) + n) % n];
  }

  function buildScene(date) {
    var seed = hashStr('postcard:' + date);
    var fam = FAMILIES[familyIndex(date)];
    var rng = mulberry32(seed);
    var pal = makePalette(rng, !!fam.light);
    var noise = makeNoise(rng);
    var state = fam.setup(rng, pal, noise);
    return {
      version: VERSION, date: date, seed: seed, W: W, H: H,
      family: fam.id, familyName: fam.name, blurb: fam.blurb, palette: pal, stillT: fam.still,
      frame: function (t) { return fam.frame(state, t, pal); },
    };
  }

  // ---- static SVG ------------------------------------------------------------------------------

  var FALLOFF = [[0, 1], [0.25, 0.79], [0.5, 0.32], [0.75, 0.05], [1, 0]];

  function n1(v) { return String(Math.round(v * 10) / 10); }
  function n0(v) { return String(Math.round(v)); }
  function blendClass(m) { return m === 'add' || m === 'screen' ? ' class="ad"' : m === 'multiply' ? ' class="mu"' : ''; }
  function pathData(p, fmt, closed) {
    var d = '';
    for (var i = 0; i < p.length; i += 2) d += (i ? 'L' : 'M') + fmt(p[i]) + ' ' + fmt(p[i + 1]);
    return closed ? d + 'Z' : d;
  }

  function toSvg(scene, t, opts) {
    opts = opts || {};
    var items = scene.frame(t === undefined ? scene.stillT : t);
    var defs = [];
    var body = [];
    var glowIds = {};
    var gid = 0;
    items.forEach(function (it) {
      var cls = blendClass(it.m);
      switch (it.k) {
        case 'bg': {
          var a = (it.ang || 0) * Math.PI / 180;
          var dx = Math.cos(a); var dy = Math.sin(a);
          var half = (Math.abs(W * dx) + Math.abs(H * dy)) / 2;
          defs.push('<linearGradient id="bg" gradientUnits="userSpaceOnUse" x1="' + n1(W / 2 - dx * half) + '" y1="' + n1(H / 2 - dy * half) + '" x2="' + n1(W / 2 + dx * half) + '" y2="' + n1(H / 2 + dy * half) + '">' +
            it.stops.map(function (s) { return '<stop offset="' + s[0] + '" stop-color="' + s[1] + '"/>'; }).join('') + '</linearGradient>');
          body.push('<rect width="' + W + '" height="' + H + '" fill="url(#bg)"/>');
          break;
        }
        case 'glow': {
          var key = it.c + '|' + it.a;
          if (!glowIds[key]) {
            glowIds[key] = 'g' + (gid++);
            defs.push('<radialGradient id="' + glowIds[key] + '">' + FALLOFF.map(function (s) {
              return '<stop offset="' + s[0] + '" stop-color="' + it.c + '" stop-opacity="' + (Math.round(it.a * s[1] * 1000) / 1000) + '"/>';
            }).join('') + '</radialGradient>');
          }
          body.push('<ellipse cx="' + n1(it.x) + '" cy="' + n1(it.y) + '" rx="' + n1(it.r) + '" ry="' + n1(it.r * (it.sy || 1)) + '" fill="url(#' + glowIds[key] + ')"' + cls + '/>');
          break;
        }
        case 'circle': {
          var at = '';
          if (it.f) at += ' fill="' + it.f + '"' + (it.fa !== undefined && it.fa < 1 ? ' fill-opacity="' + (Math.round(it.fa * 100) / 100) + '"' : '');
          else at += ' fill="none"';
          if (it.s) at += ' stroke="' + it.s + '" stroke-width="' + n1(it.sw || 1) + '"' + (it.sa !== undefined && it.sa < 1 ? ' stroke-opacity="' + (Math.round(it.sa * 100) / 100) + '"' : '');
          body.push('<circle cx="' + n1(it.x) + '" cy="' + n1(it.y) + '" r="' + n1(it.r) + '"' + at + cls + '/>');
          break;
        }
        case 'path':
          body.push('<path d="' + pathData(it.p, n1, it.closed) + '" fill="none" stroke="' + it.c + '" stroke-width="' + n1(it.w) + '" stroke-opacity="' + (Math.round((it.a === undefined ? 1 : it.a) * 100) / 100) + '" stroke-linecap="round" stroke-linejoin="round"' + cls + '/>');
          break;
        case 'segs': {
          var d = '';
          for (var i = 0; i + 3 < it.p.length; i += 4) d += 'M' + n0(it.p[i]) + ' ' + n0(it.p[i + 1]) + 'L' + n0(it.p[i + 2]) + ' ' + n0(it.p[i + 3]);
          body.push('<path d="' + d + '" fill="none" stroke="' + it.c + '" stroke-width="' + n1(it.w) + '" stroke-opacity="' + (Math.round((it.a === undefined ? 1 : it.a) * 100) / 100) + '" stroke-linecap="round"' + cls + '/>');
          break;
        }
        case 'poly': {
          var pa = ' fill="' + it.c + '"' + (it.a !== undefined && it.a < 1 ? ' fill-opacity="' + (Math.round(it.a * 1000) / 1000) + '"' : '');
          if (it.s) pa += ' stroke="' + it.s + '" stroke-width="' + n1(it.sw || 1) + '" stroke-opacity="' + (Math.round((it.sa === undefined ? 1 : it.sa) * 100) / 100) + '" stroke-linejoin="round"';
          body.push('<path d="' + pathData(it.p, n1, true) + '"' + pa + cls + '/>');
          break;
        }
        case 'rect':
          body.push('<rect x="' + n1(it.x) + '" y="' + n1(it.y) + '" width="' + n1(it.w) + '" height="' + n1(it.h) + '"' + (it.r ? ' rx="' + n1(it.r) + '"' : '') + ' fill="' + it.c + '"' + (it.a !== undefined && it.a < 1 ? ' fill-opacity="' + (Math.round(it.a * 100) / 100) + '"' : '') + cls + '/>');
          break;
        default:
      }
    });
    var label = opts.label || (scene.familyName + ', generative art seeded by ' + scene.date);
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid slice" role="img" aria-label="' + label.replace(/[&<>"]/g, '') + '">' +
      '<style>.ad{mix-blend-mode:screen}.mu{mix-blend-mode:multiply}</style><defs>' + defs.join('') + '</defs>' + body.join('') + '</svg>';
  }

  // ---- the honest note -------------------------------------------------------------------------

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  function dateLabel(date) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date));
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return WEEKDAYS[d.getUTCDay()] + ' ' + (+m[3]) + ' ' + MONTHS[+m[2] - 1] + ' ' + m[1];
  }

  var OPENERS = [
    "Today's build didn't finish, so you're getting a postcard instead.",
    "The big build for today didn't make it to the finish line.",
    "Nothing sophisticated shipped today: the build didn't complete.",
    "Today's build ran out of road before it was ready.",
    "I wanted to show you something clever today. The build didn't finish, so here's a picture.",
    "Something went sideways with today's build and it never got done.",
    "Today's build did not complete. This is the honest substitute.",
    "The team's build for today came up short.",
  ];
  var QUIPS = {
    aurora: ['The ribbons are made of sine waves; no actual solar wind was involved.', 'It is the northern lights, minus the cold and the long drive.', 'Best viewed in a dark room, with tea.'],
    constellation: ['Sixty-eight points of light, each connected to whoever is nearby. Networking, but pretty.', 'Nobody had to name these stars.', 'The lines get brighter the closer two points drift. Relatable.'],
    isolines: ['It is a map of a place that does not exist, which is the only kind of place I can reliably deliver today.', 'Every line is a height; none of them is a hill you can walk up.', 'Contour lines, for people who like their terrain unambiguous.'],
    rink: ['The pucks are doing laps with no referee and no opinions.', 'Blue lines, red line, zero penalties.', 'Not a single icing call, which feels wrong.'],
    cardfan: ['Each card deals a smaller hand, which deals a smaller hand. Nobody wins; everybody has a nice fan.', 'No real money, no real odds, just geometry holding cards.', 'A fractal poker hand: all pairs, all the time.'],
    sunrise: ['The sun has a bad cable. The grid does not care.', 'The glitches are on purpose, which is the nicest thing I can say about them.', 'Rendered with the confidence of a screensaver.'],
    inkbloom: ['No ink was spilled; it only looks that way.', 'The ink finds its own edges. I just provide the paper.', 'Blotter paper not included.'],
    harmonograph: ['Four pendulums, one pen, no friction complaints.', 'The pen slowly runs out of energy, which I find relatable by 8am.', 'Same date, same swirl, every time you load it.'],
  };
  var GENERIC_QUIPS = [
    'A tiny script that only knows today\'s date drew this.',
    'It is generated from the date alone: same day, same picture, every time.',
    'It will not do your taxes, but it is nice to look at.',
  ];
  var CLOSERS = [
    'Wish you were here. The full builds resume tomorrow.',
    'Full builds resume tomorrow, with the usual amount of ambition.',
    'Back to the full-size thing tomorrow; this one is just to say hello.',
    'Tomorrow the proper build returns. Until then, enjoy the view.',
    'See you tomorrow, when the full builds resume.',
    'Normal service (full builds, real mechanics) resumes tomorrow.',
  ];

  function buildNote(scene) {
    var rng = mulberry32(scene.seed ^ 0x9e3779b9);
    var quips = (QUIPS[scene.family] || []).concat(GENERIC_QUIPS);
    return pick(rng, OPENERS) + ' ' + pick(rng, quips) + ' ' + pick(rng, CLOSERS);
  }

  root.SEDPostcard = {
    VERSION: VERSION, W: W, H: H, FAMILIES: FAMILIES.map(function (f) { return { id: f.id, name: f.name, light: !!f.light }; }),
    hashStr: hashStr, mulberry32: mulberry32, familyIndex: familyIndex, buildScene: buildScene, toSvg: toSvg,
    buildNote: buildNote, dateLabel: dateLabel, luminance: luminance, glitchLevel: glitchLevel,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
