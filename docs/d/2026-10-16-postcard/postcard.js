/* Postcard page: animates the date's scene on a canvas, over the static SVG that is already in the page.
 * Everything is optional: without JavaScript, or after any error, the SVG stays. */
(function () {
  'use strict';

  var root = document.getElementById('postcard');
  var stage = document.getElementById('stage');
  var API = window.SEDPostcard;
  if (!root || !stage || !API) return;
  var svg = stage.querySelector('svg');
  var date = root.getAttribute('data-date');

  var scene;
  try {
    scene = API.buildScene(date);
  } catch (e) {
    return;
  }
  var W = scene.W;
  var H = scene.H;

  var controls = document.getElementById('controls');
  var playBtn = document.getElementById('play');
  var speedInput = document.getElementById('speed');
  var saveBtn = document.getElementById('save');
  var statusEl = document.getElementById('status');
  var keysEl = document.getElementById('keys');

  var reduceQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  var canvas = null;
  var ctx = null;
  var clock = scene.stillT;
  var speed = 1;
  var playing = !(reduceQuery && reduceQuery.matches);
  var visible = true;
  var shown = false;
  var last = 0;
  var raf = 0;
  var failed = false;

  var BLEND = { add: 'lighter', screen: 'screen', multiply: 'multiply' };
  var FALLOFF = [[0, 1], [0.25, 0.79], [0.5, 0.32], [0.75, 0.05], [1, 0]];

  function rgba(hex, a) {
    return 'rgba(' + parseInt(hex.slice(1, 3), 16) + ',' + parseInt(hex.slice(3, 5), 16) + ',' + parseInt(hex.slice(5, 7), 16) + ',' + a + ')';
  }

  function draw(c, items, k) {
    c.setTransform(k, 0, 0, k, 0, 0);
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    for (var n = 0; n < items.length; n++) {
      var it = items[n];
      c.globalCompositeOperation = BLEND[it.m] || 'source-over';
      switch (it.k) {
        case 'bg': {
          var a = (it.ang || 0) * Math.PI / 180;
          var dx = Math.cos(a);
          var dy = Math.sin(a);
          var half = (Math.abs(W * dx) + Math.abs(H * dy)) / 2;
          var g = c.createLinearGradient(W / 2 - dx * half, H / 2 - dy * half, W / 2 + dx * half, H / 2 + dy * half);
          for (var s = 0; s < it.stops.length; s++) g.addColorStop(it.stops[s][0], it.stops[s][1]);
          c.globalAlpha = 1;
          c.fillStyle = g;
          c.fillRect(0, 0, W, H);
          break;
        }
        case 'glow': {
          c.save();
          c.translate(it.x, it.y);
          c.scale(1, it.sy || 1);
          var rg = c.createRadialGradient(0, 0, 0, 0, 0, it.r);
          for (var f = 0; f < FALLOFF.length; f++) rg.addColorStop(FALLOFF[f][0], rgba(it.c, it.a * FALLOFF[f][1]));
          c.fillStyle = rg;
          c.fillRect(-it.r, -it.r, it.r * 2, it.r * 2);
          c.restore();
          c.globalCompositeOperation = BLEND[it.m] || 'source-over';
          break;
        }
        case 'circle':
          c.beginPath();
          c.arc(it.x, it.y, it.r, 0, Math.PI * 2);
          if (it.f) {
            c.globalAlpha = it.fa === undefined ? 1 : it.fa;
            c.fillStyle = it.f;
            c.fill();
          }
          if (it.s) {
            c.globalAlpha = it.sa === undefined ? 1 : it.sa;
            c.strokeStyle = it.s;
            c.lineWidth = it.sw || 1;
            c.stroke();
          }
          break;
        case 'path':
        case 'poly': {
          var p = it.p;
          c.beginPath();
          c.moveTo(p[0], p[1]);
          for (var i = 2; i < p.length; i += 2) c.lineTo(p[i], p[i + 1]);
          if (it.k === 'poly' || it.closed) c.closePath();
          if (it.k === 'poly') {
            c.globalAlpha = it.a === undefined ? 1 : it.a;
            c.fillStyle = it.c;
            c.fill();
            if (it.s) {
              c.globalAlpha = it.sa === undefined ? 1 : it.sa;
              c.strokeStyle = it.s;
              c.lineWidth = it.sw || 1;
              c.stroke();
            }
          } else {
            c.globalAlpha = it.a === undefined ? 1 : it.a;
            c.strokeStyle = it.c;
            c.lineWidth = it.w;
            c.stroke();
          }
          break;
        }
        case 'segs': {
          var q = it.p;
          c.beginPath();
          for (var j = 0; j + 3 < q.length; j += 4) {
            c.moveTo(q[j], q[j + 1]);
            c.lineTo(q[j + 2], q[j + 3]);
          }
          c.globalAlpha = it.a === undefined ? 1 : it.a;
          c.strokeStyle = it.c;
          c.lineWidth = it.w;
          c.stroke();
          break;
        }
        case 'rect':
          c.globalAlpha = it.a === undefined ? 1 : it.a;
          c.fillStyle = it.c;
          if (it.r && c.roundRect) {
            c.beginPath();
            c.roundRect(it.x, it.y, it.w, it.h, it.r);
            c.fill();
          } else {
            c.fillRect(it.x, it.y, it.w, it.h);
          }
          break;
        default:
      }
    }
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
  }

  function fail() {
    failed = true;
    playing = false;
    cancelAnimationFrame(raf);
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
    if (svg) svg.style.visibility = 'visible';
    if (controls) controls.hidden = true;
    if (keysEl) keysEl.hidden = true;
  }

  function resize() {
    if (!canvas) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.max(1, Math.round(stage.clientWidth * dpr));
    var h = Math.max(1, Math.round((stage.clientWidth * H / W) * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  function render() {
    if (!canvas || failed) return;
    try {
      resize();
      draw(ctx, scene.frame(clock), canvas.width / W);
      if (!shown) {
        shown = true;
        canvas.style.visibility = 'visible';
        if (svg) svg.style.visibility = 'hidden';
      }
    } catch (e) {
      fail();
    }
  }

  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (!playing || !visible || document.hidden) {
      last = now;
      return;
    }
    if (now - last < 32) return;
    var dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    clock += dt * speed;
    render();
  }

  function setPlaying(next) {
    playing = next;
    if (playBtn) {
      playBtn.textContent = playing ? 'Pause' : 'Play';
      playBtn.setAttribute('aria-pressed', playing ? 'true' : 'false');
    }
    if (playing && !canvas) start();
    else if (canvas && !shown) render();
  }

  function say(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function saveFrame() {
    try {
      var off = document.createElement('canvas');
      off.width = W;
      off.height = H;
      draw(off.getContext('2d'), scene.frame(clock), 1);
      off.toBlob(function (blob) {
        if (!blob) {
          say('This browser could not export the frame.');
          return;
        }
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'postcard-' + date + '.png';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
        say('Saved postcard-' + date + '.png');
      }, 'image/png');
    } catch (e) {
      say('This browser could not export the frame.');
    }
  }

  function start() {
    if (canvas || failed) return;
    try {
      canvas = document.createElement('canvas');
      canvas.setAttribute('aria-hidden', 'true');
      canvas.style.visibility = 'hidden';
      ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      stage.appendChild(canvas);
      render();
      last = performance.now();
      raf = requestAnimationFrame(tick);
    } catch (e) {
      fail();
    }
  }

  if (controls) controls.hidden = false;
  if (keysEl) keysEl.hidden = false;
  if (playBtn) {
    playBtn.textContent = playing ? 'Pause' : 'Play animation';
    playBtn.setAttribute('aria-pressed', playing ? 'true' : 'false');
    playBtn.addEventListener('click', function () { setPlaying(!playing); });
  }
  if (speedInput) {
    speedInput.addEventListener('input', function () {
      var v = parseFloat(speedInput.value);
      if (v > 0) speed = v;
    });
  }
  if (saveBtn) saveBtn.addEventListener('click', saveFrame);

  document.addEventListener('keydown', function (ev) {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    var tag = ev.target && ev.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (ev.key === ' ' && tag !== 'BUTTON' && tag !== 'SUMMARY') {
      ev.preventDefault();
      setPlaying(!playing);
    } else if (ev.key === 's' || ev.key === 'S') {
      saveFrame();
    }
  });

  if (reduceQuery && reduceQuery.addEventListener) {
    reduceQuery.addEventListener('change', function () { if (reduceQuery.matches && playing) setPlaying(false); });
  }
  if (window.IntersectionObserver) {
    new IntersectionObserver(function (entries) { visible = entries[entries.length - 1].isIntersecting; }).observe(stage);
  }
  window.addEventListener('resize', function () { if (canvas && !playing) render(); });

  if (playing) start();
})();
