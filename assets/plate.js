/* Build plate: a laser powder bed fusion build of the MT monogram.
   Each layer is hatched in a meander, contoured, then recoated with
   powder. Hatch angle rotates 67° per layer, as on a real machine.
   After the last layer the part cools, the powder clears and the camera
   tilts from the top-down view into an isometric view of the finished,
   extruded part. The final frame is static.

   Performance notes
   - Hatch vectors are computed analytically (line/polygon intersection),
     once per layer. No per-pixel hit testing.
   - The 3D view is an orthographic projection drawn with plain 2D canvas
     paths. Each face of the extrusion is a plane, so the scanned layer is
     mapped onto the top face with a single affine transform.
   - Device pixel ratio is capped at 2. Rendering pauses when the plate is
     off screen or the tab is hidden, and stops for good once the build is
     finished.
   - prefers-reduced-motion shows the finished isometric part straight away. */
(function () {
  'use strict';

  var plate = document.querySelector('[data-plate]');
  if (!plate) return;
  var canvas = plate.querySelector('canvas');
  var ctx = canvas && canvas.getContext && canvas.getContext('2d');
  if (!ctx) return;

  var slots = {
    tr: plate.querySelector('[data-slot="tr"]'),
    bl: plate.querySelector('[data-slot="bl"]'),
    br: plate.querySelector('[data-slot="br"]')
  };

  var reduceMotion = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  var conn = navigator.connection || {};
  var lowPower = (navigator.hardwareConcurrency || 4) <= 2 || conn.saveData === true;

  /* ---------- Palette (the chamber is always dark) ---------- */
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
  var EXTRUDE = 30;         // part height in grid units (exaggerated for legibility)
  var LAYER_UM = 30;        // nominal layer thickness shown in the readout

  /* ---------- Timing ---------- */
  var LAYERS = 3;           // layers printed before the build completes
  var SCAN_MS = 2200;       // marking time per layer
  var JUMP = 8;             // galvo jumps are this many times faster than marking
  var PAUSE_MS = 340;
  var RECOAT_MS = 850;
  var INTRO_MS = 700;
  var COOL_MS = 900;
  var REVEAL_MS = 2600;     // top-down to isometric camera move
  var SHINE_MS = 1400;
  var HEAT_FADE_MS = 260;   // time constant for the melt track cooling

  /* Isometric camera: rotate 45° about the build axis, then tilt so the
     plate's axes sit at 30° on screen. */
  var ISO_AZ = -Math.PI / 4;
  var ISO_TILT = Math.atan(Math.SQRT2);   // 54.74°

  /* ---------- State ---------- */
  var W = 0, H = 0, dpr = 1;
  var plan = { s: 1, ox: 0, oy: 0 };   // grid -> CSS px for the top-down view
  var polys = [];           // part polygons in CSS px (top-down)
  var walls = [];           // extrusion side faces in grid units
  var finalView = null;
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

  function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeInOut(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function smooth(a, b, t) { t = clamp01((t - a) / (b - a)); return t * t * (3 - 2 * t); }

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
    plan = { s: s, ox: (W - 240 * s) / 2, oy: (H - 120 * s) / 2 };
    polys = GLYPHS.map(function (poly) {
      return poly.map(function (p) { return [plan.ox + p[0] * s, plan.oy + p[1] * s]; });
    });
    hatch = Math.max(2.4, Math.min(4, s * 3.1));
    finalView = fitFinalView();
  }

  /* Side faces of the extrusion, with outward normals in grid space. */
  function buildWalls() {
    walls = [];
    GLYPHS.forEach(function (poly) {
      var area = 0;
      for (var i = 0; i < poly.length; i++) {
        var p = poly[i], q = poly[(i + 1) % poly.length];
        area += p[0] * q[1] - q[0] * p[1];
      }
      var sign = area > 0 ? 1 : -1;
      for (var j = 0; j < poly.length; j++) {
        var a = poly[j], b = poly[(j + 1) % poly.length];
        var dx = b[0] - a[0], dy = b[1] - a[1];
        var len = Math.hypot(dx, dy);
        walls.push({ a: a, b: b, nx: sign * dy / len, ny: -sign * dx / len });
      }
    });
  }

  /* ---------- Orthographic camera ---------- */
  function makeView(az, tilt, s, cx, cy) {
    return { ca: Math.cos(az), sa: Math.sin(az), cb: Math.cos(tilt), sb: Math.sin(tilt), s: s, cx: cx, cy: cy };
  }

  // Grid point (x, y, z) -> CSS px. Also returns depth toward the viewer.
  function project(v, x, y, z) {
    var px = x - 120, py = y - 60;
    var rx = px * v.ca - py * v.sa;
    var ry = px * v.sa + py * v.ca;
    return [v.cx + v.s * rx, v.cy + v.s * (ry * v.cb - z * v.sb), ry];
  }

  // Affine transform that maps the plane at height z onto the screen.
  function setPlane(v, z) {
    var a = v.s * v.ca, c = -v.s * v.sa;
    var b = v.s * v.sa * v.cb, d = v.s * v.ca * v.cb;
    var e = v.cx - 120 * a - 60 * c;
    var f = v.cy - 120 * b - 60 * d - v.s * z * v.sb;
    ctx.setTransform(dpr * a, dpr * b, dpr * c, dpr * d, dpr * e, dpr * f);
  }

  function fitFinalView() {
    var probe = makeView(ISO_AZ, ISO_TILT, 1, 0, 0);
    var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    GLYPHS.forEach(function (poly) {
      poly.forEach(function (p) {
        [0, EXTRUDE].forEach(function (z) {
          var q = project(probe, p[0], p[1], z);
          if (q[0] < x0) x0 = q[0];
          if (q[0] > x1) x1 = q[0];
          if (q[1] < y0) y0 = q[1];
          if (q[1] > y1) y1 = q[1];
        });
      });
    });
    var s = Math.min((W * 0.66) / (x1 - x0), (H * 0.6) / (y1 - y0));
    return { s: s, cx: W / 2 - s * (x0 + x1) / 2, cy: H / 2 - s * (y0 + y1) / 2 + H * 0.02 };
  }

  function viewAt(t) {
    var e = easeInOut(clamp01(t));
    return makeView(
      lerp(0, ISO_AZ, e),
      lerp(0, ISO_TILT, e),
      lerp(plan.s, finalView.s, e),
      lerp(W / 2, finalView.cx, e),
      lerp(H / 2, finalView.cy, e)
    );
  }

  /* ---------- Build planning ---------- */

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

  /* ---------- Readout ---------- */
  function setSlot(key, label, value) {
    var el = slots[key];
    if (!el) return;
    el.firstChild.nodeValue = label + ' ';
    el.querySelector('b').textContent = value;
  }

  function zText(n) { return (n * LAYER_UM / 1000).toFixed(3); }

  function beginLayer(n) {
    var p = planLayer(n);
    moves = p.moves;
    mi = 0; mp = 0;
    setSlot('tr', 'Layer', String(n).padStart(3, '0'));
    setSlot('bl', 'z', zText(n));
    setSlot('br', 'Hatch', p.deg + '°');
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

  function buryLayer(x0, x1) {
    var s = layers.solid.x;
    s.globalCompositeOperation = 'destination-out';
    s.fillStyle = 'rgba(0,0,0,0.62)';
    s.fillRect(x0, 0, Math.max(0, x1 - x0), H);
    s.globalCompositeOperation = 'source-over';
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

  function enterComplete() {
    setSlot('tr', 'Build', 'Complete');
    setSlot('bl', 'z', zText(LAYERS));
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
      } else if (layer >= LAYERS) {
        phase = 'cool'; phaseT = 0;
        enterComplete();
      } else {
        phase = 'pause'; phaseT = 0;
      }
    } else if (phase === 'pause') {
      if (phaseT >= PAUSE_MS) { phase = 'recoat'; phaseT = 0; bladeX = -8; }
    } else if (phase === 'recoat') {
      var p = Math.min(1, phaseT / RECOAT_MS);
      var nx = -8 + (W + 16) * easeInOut(p);
      // Fresh powder buries the previous layer, which stays faintly visible
      buryLayer(bladeX, nx);
      bladeX = nx;
      if (p >= 1) {
        layer++;
        beginLayer(layer);
        phase = 'scan'; phaseT = 0;
      }
    } else if (phase === 'cool') {
      if (phaseT >= COOL_MS) {
        phase = 'reveal'; phaseT = 0;
        setSlot('br', 'View', 'Iso');
      }
    } else if (phase === 'reveal') {
      if (phaseT >= REVEAL_MS) { phase = 'shine'; phaseT = 0; }
    } else if (phase === 'shine') {
      if (phaseT >= SHINE_MS) { phase = 'done'; phaseT = 0; }
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

  /* ---------- Composite: top-down build ---------- */
  function renderBuild() {
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

  /* ---------- Composite: finished part ---------- */
  function partPath() {
    ctx.beginPath();
    GLYPHS.forEach(function (poly) {
      ctx.moveTo(poly[0][0], poly[0][1]);
      for (var i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
      ctx.closePath();
    });
  }

  function renderPart(t, shine) {
    var v = viewAt(t);
    var depowder = smooth(0, 0.7, t);
    var metal = smooth(0.12, 0.65, t);

    // Chamber, with the loose powder clearing away
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.drawImage(layers.bg.c, 0, 0);
    ctx.fillStyle = 'rgba(8,10,12,' + (0.5 * depowder).toFixed(3) + ')';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Build plate grid
    if (depowder > 0) {
      setPlane(v, 0);
      ctx.lineWidth = 1 / v.s;
      ctx.strokeStyle = 'rgba(233,236,238,' + (0.07 * depowder).toFixed(3) + ')';
      ctx.beginPath();
      for (var gx = -60; gx <= 300; gx += 20) { ctx.moveTo(gx, -60); ctx.lineTo(gx, 180); }
      for (var gy = -60; gy <= 180; gy += 20) { ctx.moveTo(-60, gy); ctx.lineTo(300, gy); }
      ctx.stroke();

      // Contact shadow on the plate
      ctx.save();
      ctx.translate(7, 10);
      partPath();
      ctx.fillStyle = 'rgba(0,0,0,' + (0.45 * depowder).toFixed(3) + ')';
      ctx.fill();
      ctx.restore();
    }

    // Side walls, far to near, only those facing the camera
    if (v.sb > 0.001) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var vis = [];
      walls.forEach(function (w) {
        var facing = w.nx * v.sa + w.ny * v.ca;
        if (facing <= 0.001) return;
        var p0 = project(v, w.a[0], w.a[1], 0), p1 = project(v, w.b[0], w.b[1], 0);
        vis.push({ w: w, p0: p0, p1: p1, depth: (p0[2] + p1[2]) / 2, side: w.nx * v.ca - w.ny * v.sa });
      });
      vis.sort(function (m, n) { return m.depth - n.depth; });

      vis.forEach(function (o) {
        var w = o.w;
        var p2 = project(v, w.b[0], w.b[1], EXTRUDE), p3 = project(v, w.a[0], w.a[1], EXTRUDE);
        // Light from the upper left: left-facing walls bright, right-facing dark
        var k = clamp01(0.5 - 0.5 * o.side);
        var r = Math.round(lerp(44, 122, k)), g = Math.round(lerp(50, 132, k)), b = Math.round(lerp(57, 142, k));
        ctx.beginPath();
        ctx.moveTo(o.p0[0], o.p0[1]); ctx.lineTo(o.p1[0], o.p1[1]);
        ctx.lineTo(p2[0], p2[1]); ctx.lineTo(p3[0], p3[1]);
        ctx.closePath();
        ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
        ctx.fill();

        // Layer lines, the signature of an additively built wall
        ctx.lineWidth = 0.6;
        ctx.strokeStyle = 'rgba(0,0,0,0.12)';
        ctx.beginPath();
        for (var n = 1; n < LAYERS; n++) {
          var z = EXTRUDE * n / LAYERS;
          var q0 = project(v, w.a[0], w.a[1], z), q1 = project(v, w.b[0], w.b[1], z);
          ctx.moveTo(q0[0], q0[1]); ctx.lineTo(q1[0], q1[1]);
        }
        ctx.stroke();
      });
    }

    // Top face: polished metal with the last scanned layer on it
    setPlane(v, EXTRUDE);
    ctx.save();
    partPath();
    ctx.clip();
    if (metal > 0) {
      var grd = ctx.createLinearGradient(0, 0, 240, 120);
      grd.addColorStop(0, '#E4E8EC');
      grd.addColorStop(1, '#A9B2BA');
      ctx.globalAlpha = metal;
      ctx.fillStyle = grd;
      ctx.fillRect(-10, -10, 260, 140);
    }
    ctx.globalAlpha = lerp(1, 0.4, metal);
    ctx.transform(1 / (dpr * plan.s), 0, 0, 1 / (dpr * plan.s), -plan.ox / plan.s, -plan.oy / plan.s);
    ctx.drawImage(layers.solid.c, 0, 0);
    ctx.restore();
    ctx.globalAlpha = 1;

    // Specular sweep across the top face, once
    if (shine > 0 && shine < 1) {
      setPlane(v, EXTRUDE);
      ctx.save();
      partPath();
      ctx.clip();
      var u = lerp(-80, 330, easeInOut(shine));
      var sg = ctx.createLinearGradient(u - 50, -30, u + 50, 30);
      sg.addColorStop(0, 'rgba(255,255,255,0)');
      sg.addColorStop(0.5, 'rgba(255,255,255,0.32)');
      sg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = sg;
      ctx.fillRect(-10, -10, 260, 140);
      ctx.restore();
    }

    // Crisp top edge
    if (metal > 0) {
      setPlane(v, EXTRUDE);
      partPath();
      ctx.lineWidth = 1.1 / v.s;
      ctx.strokeStyle = 'rgba(240,243,246,' + (0.6 * metal).toFixed(3) + ')';
      ctx.stroke();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  function render() {
    if (phase === 'reveal') renderPart(phaseT / REVEAL_MS, 0);
    else if (phase === 'shine') renderPart(1, phaseT / SHINE_MS);
    else if (phase === 'done') renderPart(1, 0);
    else renderBuild();
  }

  /* ---------- Loop control ---------- */
  function frame(now) {
    if (!running) return;
    var dt = last ? Math.min(50, now - last) : 16;
    last = now;
    step(dt);
    render();
    if (phase === 'done') { running = false; return; }
    raf = requestAnimationFrame(frame);
  }

  function shouldRun() {
    return visible && !document.hidden && !reduceMotion.matches && W > 0 && phase !== 'done';
  }

  function sync() {
    if (shouldRun()) {
      if (!running) { running = true; last = 0; raf = requestAnimationFrame(frame); }
    } else if (running) {
      running = false;
      cancelAnimationFrame(raf);
    }
  }

  /* Jump straight to the finished part: last three layers fused, iso view. */
  function finishNow() {
    for (var n = Math.max(1, LAYERS - 2); n <= LAYERS; n++) {
      if (n > 1) buryLayer(0, W);
      beginLayer(n);
      moves.forEach(function (m) { if (m.mark) markSegment(m, 0, 1); });
    }
    layers.heat.x.clearRect(0, 0, W, H);
    laser = null; sparks = [];
    layer = LAYERS;
    phase = 'done'; phaseT = 0;
    enterComplete();
    setSlot('br', 'View', 'Iso');
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

    var finished = phase === 'cool' || phase === 'reveal' || phase === 'shine' || phase === 'done';
    if (reduceMotion.matches || finished) {
      finishNow();
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

  buildWalls();
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
