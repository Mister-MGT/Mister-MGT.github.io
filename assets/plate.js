/* Build plate: a laser powder bed fusion build of the MT monogram.
   Each layer is hatched in a meander, contoured, then recoated with
   powder. Hatch angle rotates 67° per layer, as on a real machine.

   Performance notes
   - Hatch vectors are computed analytically (line/polygon intersection),
     once per layer. No per-pixel hit testing.
   - Three offscreen canvases (powder, solidified metal, heat) are
     composited per frame: four drawImage calls plus a glow sprite.
   - Device pixel ratio is capped at 2. Rendering stops when the plate is
     off screen or the tab is hidden.
   - prefers-reduced-motion renders a finished, static build. */
(function () {
  'use strict';

  var plate = document.querySelector('[data-plate]');
  if (!plate) return;
  var canvas = plate.querySelector('canvas');
  var ctx = canvas && canvas.getContext && canvas.getContext('2d');
  if (!ctx) return;

  var hudLayer = plate.querySelector('[data-layer]');
  var hudZ = plate.querySelector('[data-z]');
  var hudAngle = plate.querySelector('[data-angle]');

  var reduceMotion = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  var conn = navigator.connection || {};
  var lowPower = (navigator.hardwareConcurrency || 4) <= 2 || conn.saveData === true;

  /* ---------- Palette (chamber is dark in both themes) ---------- */
  var C = {
    chamber: '#111518',
    powder: [70, 78, 86],
    solid: 'rgba(150, 162, 173, 0.85)',
    contour: 'rgba(196, 205, 213, 0.95)',
    heat: 'rgba(255, 168, 64, 1)',
    blade: 'rgba(233, 236, 238, 0.9)'
  };

  /* ---------- Part geometry: MT monogram on a 240 x 120 grid ---------- */
  var GLYPHS = [
    [[0,120],[0,0],[30,0],[65,58],[100,0],[130,0],[130,120],[104,120],[104,46],[73,98],[57,98],[26,46],[26,120]],
    [[146,0],[240,0],[240,26],[206,26],[206,120],[180,120],[180,26],[146,26]]
  ];

  /* ---------- Timing ---------- */
  var SCAN_MS = 2600;       // marking time per layer
  var JUMP = 8;             // galvo jumps are this many times faster than marking
  var PAUSE_MS = 380;
  var RECOAT_MS = 950;
  var INTRO_MS = 700;
  var HEAT_FADE_MS = 260;   // time constant for the melt track cooling

  /* ---------- State ---------- */
  var W = 0, H = 0, dpr = 1;
  var polys = [];           // part polygons in CSS px
  var hatch = 3;
  var layers = { bg: null, solid: null, heat: null, glow: null };
  var moves = [], mi = 0, mp = 0, speed = 1;
  var phase = 'intro', phaseT = 0, layer = 1, bladeX = 0;
  var laser = null;         // {x, y} while marking
  var sparks = [];
  var running = false, visible = true, raf = 0, last = 0;

  function makeLayer() {
    var c = document.createElement('canvas');
    c.width = Math.round(W * dpr);
    c.height = Math.round(H * dpr);
    var x = c.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { c: c, x: x };
  }

  function seeded(seed) {
    return function () {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
  }

  function paintPowder() {
    var g = layers.bg.x;
    g.fillStyle = C.chamber;
    g.fillRect(0, 0, W, H);

    // Powder bed: fine speckle, deterministic so resizes look identical
    var rnd = seeded(7);
    var n = Math.round(W * H / (lowPower ? 22 : 11));
    for (var i = 0; i < n; i++) {
      var a = 0.08 + rnd() * 0.22;
      var r = 0.35 + rnd() * 0.75;
      g.fillStyle = 'rgba(' + C.powder[0] + ',' + C.powder[1] + ',' + C.powder[2] + ',' + a.toFixed(3) + ')';
      g.fillRect(rnd() * W, rnd() * H, r, r);
    }

    // Chamber lighting
    var v = g.createRadialGradient(W * 0.5, H * 0.42, Math.min(W, H) * 0.15, W * 0.5, H * 0.5, Math.max(W, H) * 0.75);
    v.addColorStop(0, 'rgba(255,255,255,0.035)');
    v.addColorStop(1, 'rgba(0,0,0,0.5)');
    g.fillStyle = v;
    g.fillRect(0, 0, W, H);
  }

  function paintGlow() {
    var s = 64;
    var c = document.createElement('canvas');
    c.width = c.height = s;
    var g = c.getContext('2d');
    var grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, 'rgba(255,250,236,1)');
    grd.addColorStop(0.12, 'rgba(255,214,140,0.95)');
    grd.addColorStop(0.35, 'rgba(242,140,30,0.38)');
    grd.addColorStop(1, 'rgba(242,120,20,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
    layers.glow = c;
  }

  function layoutPart() {
    var s = Math.min((W * 0.6) / 240, (H * 0.52) / 120);
    var ox = (W - 240 * s) / 2;
    var oy = (H - 120 * s) / 2;
    polys = GLYPHS.map(function (poly) {
      return poly.map(function (p) { return [ox + p[0] * s, oy + p[1] * s]; });
    });
    hatch = Math.max(2.4, Math.min(4, s * 3.1));
  }

  /* Hatch vectors for a layer: meander scan, clipped to the part. */
  function planLayer(n) {
    var deg = ((n - 1) * 67) % 360;
    var th = deg * Math.PI / 180;
    var dx = Math.cos(th), dy = Math.sin(th);
    var nx = -dy, ny = dx;

    var lo = Infinity, hi = -Infinity;
    polys.forEach(function (poly) {
      poly.forEach(function (p) {
        var o = p[0] * nx + p[1] * ny;
        if (o < lo) lo = o;
        if (o > hi) hi = o;
      });
    });

    var out = [];
    var flip = false;
    var prev = null;
    for (var o = lo + hatch / 2; o < hi; o += hatch) {
      var ts = [];
      polys.forEach(function (poly) {
        for (var i = 0; i < poly.length; i++) {
          var a = poly[i], b = poly[(i + 1) % poly.length];
          var sa = a[0] * nx + a[1] * ny - o;
          var sb = b[0] * nx + b[1] * ny - o;
          if ((sa <= 0 && sb > 0) || (sb <= 0 && sa > 0)) {
            var k = sa / (sa - sb);
            var x = a[0] + (b[0] - a[0]) * k;
            var y = a[1] + (b[1] - a[1]) * k;
            ts.push(x * dx + y * dy);
          }
        }
      });
      if (ts.length < 2) continue;
      ts.sort(function (p, q) { return p - q; });

      var segs = [];
      for (var j = 0; j + 1 < ts.length; j += 2) {
        if (ts[j + 1] - ts[j] > 0.4) segs.push([ts[j], ts[j + 1]]);
      }
      if (flip) { segs.reverse(); segs = segs.map(function (sg) { return [sg[1], sg[0]]; }); }
      flip = !flip;

      segs.forEach(function (sg) {
        var ax = o * nx + sg[0] * dx, ay = o * ny + sg[0] * dy;
        var bx = o * nx + sg[1] * dx, by = o * ny + sg[1] * dy;
        if (prev) pushMove(out, prev[0], prev[1], ax, ay, false);
        pushMove(out, ax, ay, bx, by, true, 'hatch');
        prev = [bx, by];
      });
    }

    // Contour pass
    polys.forEach(function (poly) {
      var first = poly[0];
      if (prev) pushMove(out, prev[0], prev[1], first[0], first[1], false);
      for (var i = 0; i < poly.length; i++) {
        var a = poly[i], b = poly[(i + 1) % poly.length];
        pushMove(out, a[0], a[1], b[0], b[1], true, 'contour');
      }
      prev = first;
    });

    var marked = 0;
    out.forEach(function (m) { if (m.mark) marked += m.len; });
    var jumped = 0;
    out.forEach(function (m) { if (!m.mark) jumped += m.len / JUMP; });
    speed = (marked + jumped) / SCAN_MS;

    return { moves: out, deg: deg };
  }

  function pushMove(list, ax, ay, bx, by, mark, kind) {
    var len = Math.hypot(bx - ax, by - ay);
    if (len < 0.01) return;
    list.push({ ax: ax, ay: ay, bx: bx, by: by, len: len, mark: mark, kind: kind });
  }

  function setHud(n, deg) {
    if (hudLayer) hudLayer.textContent = String(n).padStart(3, '0');
    if (hudZ) hudZ.textContent = (n * 0.03).toFixed(3);
    if (hudAngle) hudAngle.textContent = deg + '°';
  }

  function beginLayer(n) {
    var plan = planLayer(n);
    moves = plan.moves;
    mi = 0; mp = 0;
    setHud(n, plan.deg);
  }

  function markSegment(m, t0, t1) {
    var x0 = m.ax + (m.bx - m.ax) * t0, y0 = m.ay + (m.by - m.ay) * t0;
    var x1 = m.ax + (m.bx - m.ax) * t1, y1 = m.ay + (m.by - m.ay) * t1;

    var s = layers.solid.x;
    s.strokeStyle = m.kind === 'contour' ? C.contour : C.solid;
    s.lineWidth = m.kind === 'contour' ? 1.1 : Math.max(1, hatch * 0.42);
    s.beginPath(); s.moveTo(x0, y0); s.lineTo(x1, y1); s.stroke();

    var h = layers.heat.x;
    h.strokeStyle = C.heat;
    h.lineWidth = Math.max(1.4, hatch * 0.6);
    h.beginPath(); h.moveTo(x0, y0); h.lineTo(x1, y1); h.stroke();
  }

  function spawnSparks(x, y, dt) {
    if (sparks.length > (lowPower ? 14 : 36)) return;
    var count = dt * (lowPower ? 0.012 : 0.03);
    while (count > 0) {
      if (Math.random() < count) {
        sparks.push({
          x: x, y: y,
          vx: (Math.random() - 0.5) * 0.28,
          vy: -0.04 - Math.random() * 0.22,
          life: 0, max: 220 + Math.random() * 420
        });
      }
      count -= 1;
    }
  }

  /* ---------- Simulation step ---------- */
  function step(dt) {
    phaseT += dt;
    laser = null;

    // Melt track cools
    var h = layers.heat.x;
    h.globalCompositeOperation = 'destination-out';
    h.fillStyle = 'rgba(0,0,0,' + (1 - Math.exp(-dt / HEAT_FADE_MS)).toFixed(4) + ')';
    h.fillRect(0, 0, W, H);
    h.globalCompositeOperation = 'source-over';

    if (phase === 'intro') {
      if (phaseT >= INTRO_MS) { phase = 'scan'; phaseT = 0; }
    } else if (phase === 'scan') {
      var budget = speed * dt;
      while (budget > 0 && mi < moves.length) {
        var m = moves[mi];
        var f = m.mark ? 1 : JUMP;
        var adv = Math.min(budget * f, m.len - mp);
        if (m.mark) markSegment(m, mp / m.len, (mp + adv) / m.len);
        mp += adv;
        budget -= adv / f;
        if (mp >= m.len - 1e-6) { mi++; mp = 0; }
      }
      if (mi < moves.length) {
        var cm = moves[mi];
        if (cm.mark) {
          var t = mp / cm.len;
          laser = { x: cm.ax + (cm.bx - cm.ax) * t, y: cm.ay + (cm.by - cm.ay) * t };
          spawnSparks(laser.x, laser.y, dt);
        }
      } else {
        phase = 'pause'; phaseT = 0;
      }
    } else if (phase === 'pause') {
      if (phaseT >= PAUSE_MS) { phase = 'recoat'; phaseT = 0; bladeX = -8; }
    } else if (phase === 'recoat') {
      var p = Math.min(1, phaseT / RECOAT_MS);
      var e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      var nx = -8 + (W + 16) * e;
      // Fresh powder buries the previous layer, which stays faintly visible
      var s = layers.solid.x;
      s.globalCompositeOperation = 'destination-out';
      s.fillStyle = 'rgba(0,0,0,0.62)';
      s.fillRect(bladeX, 0, Math.max(0, nx - bladeX), H);
      s.globalCompositeOperation = 'source-over';
      bladeX = nx;
      if (p >= 1) {
        layer++;
        beginLayer(layer);
        phase = 'scan'; phaseT = 0;
      }
    }

    for (var i = sparks.length - 1; i >= 0; i--) {
      var sp = sparks[i];
      sp.life += dt;
      if (sp.life >= sp.max) { sparks.splice(i, 1); continue; }
      sp.vy += 0.0009 * dt;
      sp.x += sp.vx * dt;
      sp.y += sp.vy * dt;
    }
  }

  /* ---------- Composite ---------- */
  function render() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(layers.bg.c, 0, 0);
    ctx.drawImage(layers.solid.c, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(layers.heat.c, 0, 0);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (laser) {
      var r = 13 + Math.random() * 4;
      ctx.drawImage(layers.glow, laser.x - r, laser.y - r, r * 2, r * 2);
    }
    if (sparks.length) {
      ctx.lineWidth = 1;
      ctx.lineCap = 'round';
      for (var i = 0; i < sparks.length; i++) {
        var sp = sparks[i];
        var a = 1 - sp.life / sp.max;
        ctx.strokeStyle = 'rgba(255,190,100,' + a.toFixed(3) + ')';
        ctx.beginPath();
        ctx.moveTo(sp.x, sp.y);
        ctx.lineTo(sp.x - sp.vx * 14, sp.y - sp.vy * 14);
        ctx.stroke();
      }
    }
    ctx.globalCompositeOperation = 'source-over';

    if (phase === 'recoat') {
      var x = bladeX;
      var grd = ctx.createLinearGradient(x - 26, 0, x, 0);
      grd.addColorStop(0, 'rgba(233,236,238,0)');
      grd.addColorStop(1, 'rgba(233,236,238,0.10)');
      ctx.fillStyle = grd;
      ctx.fillRect(x - 26, 0, 26, H);
      ctx.fillStyle = C.blade;
      ctx.fillRect(x - 0.75, 0, 1.5, H);
    }
  }

  /* ---------- Loop control ---------- */
  function frame(now) {
    if (!running) return;
    var dt = last ? Math.min(50, now - last) : 16;
    last = now;
    step(dt);
    render();
    raf = requestAnimationFrame(frame);
  }

  function shouldRun() {
    return visible && !document.hidden && !reduceMotion.matches && W > 0;
  }

  function sync() {
    if (shouldRun()) {
      if (!running) { running = true; last = 0; raf = requestAnimationFrame(frame); }
    } else if (running) {
      running = false;
      cancelAnimationFrame(raf);
    }
  }

  /* Finished build for reduced motion: three layers, already fused. */
  function renderStatic() {
    var keep = layer;
    for (var n = Math.max(1, keep - 2); n <= keep; n++) {
      if (n > 1) {
        var s = layers.solid.x;
        s.globalCompositeOperation = 'destination-out';
        s.fillStyle = 'rgba(0,0,0,0.62)';
        s.fillRect(0, 0, W, H);
        s.globalCompositeOperation = 'source-over';
      }
      beginLayer(n);
      moves.forEach(function (m) { if (m.mark) markSegment(m, 0, 1); });
    }
    layers.heat.x.clearRect(0, 0, W, H);
    laser = null; sparks = [];
    render();
  }

  function setup() {
    var rect = canvas.getBoundingClientRect();
    var w = Math.round(rect.width), h = Math.round(rect.height);
    if (!w || !h) return;
    W = w; H = h;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    if (lowPower) dpr = Math.min(dpr, 1.5);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);

    layers.bg = makeLayer();
    layers.solid = makeLayer();
    layers.heat = makeLayer();
    if (!layers.glow) paintGlow();
    layers.solid.x.lineCap = 'round';
    layers.heat.x.lineCap = 'round';

    paintPowder();
    layoutPart();
    sparks = [];

    if (reduceMotion.matches) {
      layer = Math.max(layer, 3);
      renderStatic();
    } else {
      beginLayer(layer);
      if (phase !== 'intro') { phase = 'scan'; phaseT = 0; }
      render();
    }
    plate.classList.add('is-live');
  }

  var resizeTimer;
  function onResize() {
    var rect = canvas.getBoundingClientRect();
    if (Math.round(rect.width) === W && Math.round(rect.height) === H) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { setup(); sync(); }, 140);
  }

  setup();

  if ('ResizeObserver' in window) new ResizeObserver(onResize).observe(plate);
  else window.addEventListener('resize', onResize);

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
      sync();
    }, { threshold: 0.01 }).observe(plate);
  }

  document.addEventListener('visibilitychange', sync);
  var onMotionPref = function () { setup(); sync(); };
  if (reduceMotion.addEventListener) reduceMotion.addEventListener('change', onMotionPref);
  else if (reduceMotion.addListener) reduceMotion.addListener(onMotionPref);

  sync();
})();
