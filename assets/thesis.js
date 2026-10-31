/* Thesis page demos: alloy collapse, multi-output GP, confidence map.
   All data is synthetic, generated from a fixed seed, and the Gaussian
   processes are solved exactly with a small Cholesky factorisation. */
(function () {
  'use strict';

  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  var C = {
    ink: '#E8EBED', steel: '#9BA5AE', dim: '#5E6870', rule: '#2A3138',
    chamber: '#0A0C0E', melt: '#F2A93B', cool: '#8EC1E6'
  };
  var MONO = '500 10px "IBM Plex Mono", ui-monospace, monospace';

  /* ---------- Small maths ---------- */

  function rng(seed) {
    return function () { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  }
  function gauss(r) {
    var u = r() || 1e-9, v = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  function sig(z) { return 1 / (1 + Math.exp(-z)); }
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function ease(t) { return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function normCdf(z) {
    var t = 1 / (1 + .2316419 * Math.abs(z));
    var d = .3989423 * Math.exp(-z * z / 2);
    var p = d * t * (.3193815 + t * (-.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - p : p;
  }

  /* Exact GP posterior: obs are arbitrary objects, kf(a, b) is the prior
     covariance, noise is added on the diagonal, mean is a constant. */
  function gpFit(obs, kf, noise, mean) {
    var n = obs.length, K = new Float64Array(n * n), i, j, k, s;
    for (i = 0; i < n; i++) for (j = 0; j <= i; j++) {
      K[i * n + j] = K[j * n + i] = kf(obs[i], obs[j]) + (i === j ? noise : 0);
    }
    var L = new Float64Array(n * n);
    for (i = 0; i < n; i++) for (j = 0; j <= i; j++) {
      s = K[i * n + j];
      for (k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      L[i * n + j] = i === j ? Math.sqrt(Math.max(s, 1e-12)) : s / L[j * n + j];
    }
    var r = new Float64Array(n);
    for (i = 0; i < n; i++) r[i] = obs[i].y - mean;
    var a = back(L, n, fwd(L, n, r));
    return { obs: obs, L: L, alpha: a, n: n, kf: kf, mean: mean };
  }
  function fwd(L, n, b) {
    var x = new Float64Array(n);
    for (var i = 0; i < n; i++) {
      var s = b[i];
      for (var k = 0; k < i; k++) s -= L[i * n + k] * x[k];
      x[i] = s / L[i * n + i];
    }
    return x;
  }
  function back(L, n, b) {
    var x = new Float64Array(n);
    for (var i = n - 1; i >= 0; i--) {
      var s = b[i];
      for (var k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
      x[i] = s / L[i * n + i];
    }
    return x;
  }
  function gpPredict(fit, q, prior) {
    var n = fit.n, ks = new Float64Array(n), mu = fit.mean, i;
    for (i = 0; i < n; i++) { ks[i] = fit.kf(q, fit.obs[i]); mu += ks[i] * fit.alpha[i]; }
    var v = fwd(fit.L, n, ks), vv = 0;
    for (i = 0; i < n; i++) vv += v[i] * v[i];
    return { mu: mu, sd: Math.sqrt(Math.max(prior - vv, 1e-10)) };
  }

  /* Synthetic property response: lack of fusion -> dense -> keyhole. */
  function density1(x) { return sig((x - .34) / .05) - 2.2 * Math.pow(Math.max(0, x - .8), 2); }

  /* ---------- Canvas plumbing ---------- */

  function surface(canvas, onSize) {
    var ctx = canvas.getContext('2d');
    var st = { ctx: ctx, w: 0, h: 0, dpr: 1 };
    function fit() {
      var r = canvas.getBoundingClientRect();
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      var w = Math.round(r.width), h = Math.round(r.height);
      if (!w || !h || (w === st.w && h === st.h && dpr === st.dpr)) return;
      st.w = w; st.h = h; st.dpr = dpr;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      onSize();
    }
    // First fit runs after the caller has stored the returned state.
    if ('ResizeObserver' in window) new ResizeObserver(fit).observe(canvas);
    else { window.addEventListener('resize', fit); setTimeout(fit, 0); }
    return st;
  }

  function tween(ms, step) {
    var id = 0, stopped = false;
    if (reduce) { step(1); return { stop: function () {} }; }
    var t0 = performance.now();
    function frame(now) {
      if (stopped) return;
      var t = Math.min(1, (now - t0) / ms);
      step(ease(t));
      if (t < 1) id = requestAnimationFrame(frame);
    }
    id = requestAnimationFrame(frame);
    return { stop: function () { stopped = true; cancelAnimationFrame(id); } };
  }

  function setPressed(buttons, mode) {
    buttons.forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-mode') === mode)); });
  }

  function label(ctx, text, x, y, align, color) {
    ctx.font = MONO;
    ctx.fillStyle = color || C.steel;
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(text.toUpperCase(), x, y);
  }

  /* ---------- 03: two alloys collapse onto one curve ---------- */

  function collapseDemo(fig) {
    var canvas = fig.querySelector('canvas');
    var buttons = fig.querySelectorAll('[data-mode]');
    var axis = fig.querySelector('[data-axis]');
    var r = rng(11), pts = [], maxRaw = 0;

    /* Each cube has a true Π_H*. In P/v terms the alloys sit at different
       scales, and hatch, layer and spot changes add scatter P/v can't see. */
    [{ a: 0, k: .52 }, { a: 1, k: 1 }].forEach(function (al) {
      for (var i = 0; i < 24; i++) {
        var pi = .05 + .93 * (i / 23) + (r() - .5) * .035;
        var raw = pi * al.k * (.8 + .4 * r());
        maxRaw = Math.max(maxRaw, raw);
        pts.push({ a: al.a, pi: pi, raw: raw, y: density1(pi) + gauss(r) * .022 });
      }
    });
    pts.forEach(function (p) { p.raw = p.raw / (maxRaw * 1.03); });

    var t = 0, anim = null, mode = 'raw', played = false;
    var st = surface(canvas, draw);

    function draw() {
      var ctx = st.ctx, w = st.w, h = st.h;
      if (!w) return;
      var L = 14, R = 14, T = 30, B = 16;
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = C.rule;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(L, h - B + .5); ctx.lineTo(w - R, h - B + .5);
      ctx.stroke();
      label(ctx, 'Relative density ↑', L, 12);

      function X(v) { return L + v * (w - L - R); }
      function Y(v) { return T + (1 - (v + .05) / 1.12) * (h - T - B); }

      pts.forEach(function (p) {
        var x = X(lerp(p.raw, p.pi, t)), y = Y(p.y);
        if (p.a === 0) {
          ctx.fillStyle = C.melt;
          ctx.beginPath(); ctx.arc(x, y, 3.6, 0, Math.PI * 2); ctx.fill();
        } else {
          ctx.fillStyle = C.cool;
          ctx.fillRect(x - 3.2, y - 3.2, 6.4, 6.4);
        }
      });
    }

    function go(next) {
      if (next === mode) return;
      mode = next;
      setPressed(buttons, mode);
      axis.innerHTML = mode === 'dim'
        ? 'Normalised enthalpy, Π<sub>H</sub><sup>*</sup> →'
        : 'Energy per unit length, P/v →';
      var from = t, to = mode === 'dim' ? 1 : 0;
      if (anim) anim.stop();
      anim = tween(1100, function (k) { t = lerp(from, to, k); draw(); });
    }

    buttons.forEach(function (b) {
      b.addEventListener('click', function () { played = true; go(b.getAttribute('data-mode')); });
    });

    /* Play the collapse once, the first time the figure is in view. */
    if (!reduce && 'IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (es) {
        es.forEach(function (e) {
          if (e.isIntersecting && e.intersectionRatio >= .6) {
            io.disconnect();
            setTimeout(function () { if (!played) { played = true; go('dim'); } }, 900);
          }
        });
      }, { threshold: [.6] });
      io.observe(canvas);
    }
  }

  /* ---------- 04: multi-output GP ---------- */

  function mogpDemo(fig) {
    var canvas = fig.querySelector('canvas');
    var link = fig.querySelector('[data-link]');
    var status = fig.querySelector('[data-status]');
    var NAMES = ['Relative density', 'Hardness'];
    var truth = [
      density1,
      function (x) { return .8 * density1(x) + .1 + .07 * Math.sin(5 * x); }
    ];
    var ELL = .1, SF2 = .16, SN2 = .0009, MEAN = .55, RHO = .92, G = 140, MAX_OBS = 24;
    var START = [[.08, .3, .64, .9], [.08, .9]];
    var r, obs, cur, anim = null, fresh = null;

    function kf(a, b) {
      var c = a.o === b.o ? 1 : (link.checked ? RHO : 0);
      if (!c) return 0;
      var d = a.x - b.x;
      return SF2 * c * Math.exp(-d * d / (2 * ELL * ELL));
    }
    function measure(o, x) {
      return { o: o, x: x, y: truth[o](x) + gauss(r) * .03 };
    }
    function reset() {
      r = rng(5);
      obs = [];
      START.forEach(function (xs, o) { xs.forEach(function (x) { obs.push(measure(o, x)); }); });
      fresh = null;
    }
    function solve() {
      var fit = gpFit(obs, kf, SN2, MEAN);
      var out = [0, 1].map(function () { return { mu: new Float64Array(G), sd: new Float64Array(G) }; });
      for (var g = 0; g < G; g++) {
        var x = g / (G - 1);
        for (var o = 0; o < 2; o++) {
          var p = gpPredict(fit, { o: o, x: x }, SF2);
          out[o].mu[g] = p.mu; out[o].sd[g] = p.sd;
        }
      }
      return out;
    }
    function sdAt(field, o, x) {
      var g = x * (G - 1), i = Math.floor(g), f = g - i;
      var a = field[o].sd[i], b = field[o].sd[Math.min(G - 1, i + 1)];
      return lerp(a, b, f);
    }

    var st = surface(canvas, function () { draw(cur, 1); });

    function layout() {
      var w = st.w, h = st.h, gap = 14, T = 8, B = 10;
      var ph = (h - T - B - gap) / 2;
      return [0, 1].map(function (o) { return { x: 12, y: T + o * (ph + gap), w: w - 24, h: ph }; });
    }

    function draw(field, pulse) {
      var ctx = st.ctx;
      if (!st.w || !field) return;
      ctx.clearRect(0, 0, st.w, st.h);
      var panels = layout();
      panels.forEach(function (P, o) {
        var X = function (v) { return P.x + v * P.w; };
        var Y = function (v) { return P.y + 22 + (1 - (v + .2) / 1.45) * (P.h - 26); };
        var f = field[o], g;

        ctx.save();
        ctx.beginPath(); ctx.rect(P.x, P.y + 18, P.w, P.h - 18); ctx.clip();

        ctx.fillStyle = 'rgba(242,169,59,.2)';
        ctx.beginPath();
        for (g = 0; g < G; g++) ctx.lineTo(X(g / (G - 1)), Y(f.mu[g] + 1.96 * f.sd[g]));
        for (g = G - 1; g >= 0; g--) ctx.lineTo(X(g / (G - 1)), Y(f.mu[g] - 1.96 * f.sd[g]));
        ctx.closePath(); ctx.fill();

        ctx.setLineDash([1.5, 3]);
        ctx.strokeStyle = C.steel; ctx.lineWidth = 1.2;
        ctx.beginPath();
        for (g = 0; g < G; g++) ctx.lineTo(X(g / (G - 1)), Y(truth[o](g / (G - 1))));
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.strokeStyle = C.melt; ctx.lineWidth = 2;
        ctx.beginPath();
        for (g = 0; g < G; g++) ctx.lineTo(X(g / (G - 1)), Y(f.mu[g]));
        ctx.stroke();

        obs.forEach(function (p) {
          if (p.o !== o) return;
          var x = X(p.x), y = Y(p.y);
          if (p === fresh && pulse < 1) {
            ctx.strokeStyle = 'rgba(242,169,59,' + (1 - pulse) + ')';
            ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.arc(x, y, 4 + 14 * pulse, 0, Math.PI * 2); ctx.stroke();
          }
          ctx.fillStyle = C.chamber;
          ctx.beginPath(); ctx.arc(x, y, 4.6, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = p === fresh ? C.melt : C.ink;
          ctx.beginPath(); ctx.arc(x, y, 3.4, 0, Math.PI * 2); ctx.fill();
        });
        ctx.restore();

        ctx.strokeStyle = C.rule; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(P.x, P.y + P.h + .5); ctx.lineTo(P.x + P.w, P.y + P.h + .5); ctx.stroke();
        label(ctx, NAMES[o], P.x, P.y + 2, 'left', C.ink);
        var n = obs.filter(function (p) { return p.o === o; }).length;
        label(ctx, n + (n === 1 ? ' test' : ' tests'), P.x + P.w, P.y + 2, 'right');
      });
    }

    function update(message) {
      var from = cur, to = solve();
      cur = to;
      if (message) status.textContent = message;
      if (anim) anim.stop();
      if (!from) { draw(to, 1); return; }
      var mix = [0, 1].map(function () { return { mu: new Float64Array(G), sd: new Float64Array(G) }; });
      anim = tween(650, function (k) {
        for (var o = 0; o < 2; o++) for (var g = 0; g < G; g++) {
          mix[o].mu[g] = lerp(from[o].mu[g], to[o].mu[g], k);
          mix[o].sd[g] = lerp(from[o].sd[g], to[o].sd[g], k);
        }
        draw(mix, k);
      });
    }

    function addTest(o, x, suggested) {
      if (obs.length >= MAX_OBS) {
        status.textContent = 'That’s enough tests for this demo. Press Reset to start again.';
        return;
      }
      var other = 1 - o, before = sdAt(cur, other, x);
      fresh = measure(o, x);
      obs.push(fresh);
      var after = solve();
      var drop = Math.round((1 - sdAt(after, other, x) / before) * 100);
      var lead = suggested
        ? 'Suggested test: ' + NAMES[o].toLowerCase() + ', where the band is widest. '
        : NAMES[o] + ' test added. ';
      var tail = link.checked
        ? (drop >= 3
            ? NAMES[other] + ' uncertainty at that setting fell by ' + drop + '%, because the properties are linked.'
            : NAMES[other] + ' was already well known there, so it barely changed.')
        : NAMES[other] + ' is modelled on its own, so its band did not change.';
      update(lead + tail);
    }

    canvas.parentNode.addEventListener('click', function (e) {
      var rect = canvas.getBoundingClientRect();
      var px = e.clientX - rect.left, py = e.clientY - rect.top;
      var panels = layout(), o = py < (panels[0].y + panels[0].h + panels[1].y) / 2 ? 0 : 1;
      var x = clamp((px - panels[o].x) / panels[o].w, .01, .99);
      addTest(o, x, false);
    });

    fig.querySelector('[data-next]').addEventListener('click', function () {
      var best = { o: 0, g: 0, sd: -1 };
      for (var o = 0; o < 2; o++) for (var g = 2; g < G - 2; g++) {
        if (cur[o].sd[g] > best.sd) best = { o: o, g: g, sd: cur[o].sd[g] };
      }
      addTest(best.o, best.g / (G - 1), true);
    });

    fig.querySelector('[data-reset]').addEventListener('click', function () {
      reset();
      update('Back to the starting tests. Tap a chart to test that property at that setting.');
    });

    link.addEventListener('change', function () {
      fresh = null;
      update(link.checked
        ? 'Properties linked: each test informs both.'
        : 'Properties independent: each one learns only from its own tests. Note the wider hardness band.');
    });

    reset();
    update();
  }

  /* ---------- 05: map with confidence ---------- */

  function mapDemo(fig) {
    var canvas = fig.querySelector('canvas');
    var buttons = fig.querySelectorAll('[data-mode]');
    var ramp = fig.querySelector('[data-ramp]');
    var rampLabels = fig.querySelector('[data-ramp-labels]');
    var caption = fig.querySelector('[data-map-caption]');
    var GX = 96, GY = 64, SPEC = .8, SF2 = .15, SN2 = .0009, MEAN = .5, LX = .16, LY = .45;

    /* x: normalised enthalpy, y: track overlap. Less overlap needs more energy. */
    function truth(x, y) {
      var x0 = .26 + .22 * (1 - y);
      return sig((x - x0) / .045) - 9 * Math.pow(Math.max(0, x - (.72 + .1 * y)), 2);
    }
    var r = rng(23), obs = [];
    [[.12, .2], [.32, .2], [.5, .2], [.68, .2], [.9, .2],
     [.2, .5], [.38, .5], [.55, .5], [.75, .5],
     [.12, .82], [.3, .82], [.46, .82], [.95, .55]].forEach(function (p) {
      // y0 is the overlap coordinate; y is the measured value gpFit reads.
      obs.push({ x: p[0], y0: p[1], y: truth(p[0], p[1]) + gauss(r) * .02 });
    });

    function kf(a, b) {
      var dx = a.x - b.x, dy = a.y0 - b.y0;
      return SF2 * Math.exp(-dx * dx / (2 * LX * LX) - dy * dy / (2 * LY * LY));
    }
    var fit = gpFit(obs, kf, SN2, MEAN);
    var mu = new Float32Array(GX * GY), pr = new Float32Array(GX * GY);
    for (var j = 0; j < GY; j++) for (var i = 0; i < GX; i++) {
      var q = { x: i / (GX - 1), y0: 1 - j / (GY - 1) };
      var p = gpPredict(fit, q, SF2);
      mu[j * GX + i] = p.mu;
      pr[j * GX + i] = normCdf((p.mu - SPEC) / p.sd);
    }

    function hex(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
    function rampOf(stops) {
      stops = stops.map(function (s) { return [s[0], hex(s[1])]; });
      return function (v) {
        v = clamp(v, 0, 1);
        for (var k = 1; k < stops.length; k++) if (v <= stops[k][0]) {
          var a = stops[k - 1], b = stops[k], t = (v - a[0]) / (b[0] - a[0]);
          return [lerp(a[1][0], b[1][0], t), lerp(a[1][1], b[1][1], t), lerp(a[1][2], b[1][2], t)];
        }
        return stops[stops.length - 1][1];
      };
    }
    function image(field, colour, map) {
      var off = document.createElement('canvas');
      off.width = GX; off.height = GY;
      var c = off.getContext('2d'), img = c.createImageData(GX, GY);
      for (var k = 0; k < GX * GY; k++) {
        var rgb = colour(map(field[k]));
        img.data[k * 4] = rgb[0]; img.data[k * 4 + 1] = rgb[1]; img.data[k * 4 + 2] = rgb[2]; img.data[k * 4 + 3] = 255;
      }
      c.putImageData(img, 0, 0);
      return off;
    }
    var imgPred = image(mu, rampOf([[0, '#15191D'], [.6, '#6B5634'], [1, '#F2A93B']]), function (v) { return (v - .1) / .9; });
    var imgConf = image(pr, rampOf([[0, '#121518'], [.5, '#59626B'], [1, '#F2A93B']]), function (v) { return v; });

    function contour(ctx, field, level, X, Y) {
      ctx.beginPath();
      for (var j = 0; j < GY - 1; j++) for (var i = 0; i < GX - 1; i++) {
        var a = field[j * GX + i] - level, b = field[j * GX + i + 1] - level;
        var c = field[(j + 1) * GX + i + 1] - level, d = field[(j + 1) * GX + i] - level;
        var code = (a > 0 ? 8 : 0) | (b > 0 ? 4 : 0) | (c > 0 ? 2 : 0) | (d > 0 ? 1 : 0);
        if (code === 0 || code === 15) continue;
        var top = [i + a / (a - b), j], right = [i + 1, j + b / (b - c)];
        var bottom = [i + d / (d - c), j + 1], left = [i, j + a / (a - d)];
        var segs = {
          1: [left, bottom], 2: [bottom, right], 3: [left, right], 4: [top, right],
          5: [top, left, bottom, right], 6: [top, bottom], 7: [top, left], 8: [top, left],
          9: [top, bottom], 10: [top, right, left, bottom], 11: [top, right], 12: [left, right],
          13: [bottom, right], 14: [left, bottom]
        }[code];
        for (var s = 0; s < segs.length; s += 2) {
          ctx.moveTo(X(segs[s][0]), Y(segs[s][1]));
          ctx.lineTo(X(segs[s + 1][0]), Y(segs[s + 1][1]));
        }
      }
      ctx.stroke();
    }

    var t = 0, anim = null, mode = 'pred';
    var st = surface(canvas, draw);

    function draw() {
      var ctx = st.ctx, w = st.w, h = st.h;
      if (!w) return;
      var cw = w / (GX - 1), ch = h / (GY - 1);
      function X(i) { return i * cw; }
      function Y(j) { return j * ch; }
      ctx.clearRect(0, 0, w, h);
      ctx.imageSmoothingEnabled = true;
      ctx.globalAlpha = 1;
      ctx.drawImage(imgPred, -cw / 2, -ch / 2, w + cw, h + ch);
      if (t > 0) {
        ctx.globalAlpha = t;
        ctx.drawImage(imgConf, -cw / 2, -ch / 2, w + cw, h + ch);
      }

      ctx.lineWidth = 1.5;
      ctx.lineCap = 'round';
      if (t < 1) {
        ctx.globalAlpha = 1 - t;
        ctx.strokeStyle = C.ink;
        contour(ctx, mu, SPEC, X, Y);
      }
      if (t > 0) {
        ctx.globalAlpha = t;
        ctx.strokeStyle = C.ink;
        contour(ctx, pr, .95, X, Y);
      }
      ctx.globalAlpha = 1;

      obs.forEach(function (o) {
        var x = o.x * w, y = (1 - o.y0) * h;
        ctx.fillStyle = C.chamber;
        ctx.beginPath(); ctx.arc(x, y, 4.8, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = C.ink; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(x, y, 3.4, 0, Math.PI * 2); ctx.stroke();
      });
    }

    function go(next) {
      if (next === mode) return;
      mode = next;
      setPressed(buttons, mode);
      var conf = mode === 'conf';
      ramp.classList.toggle('is-conf', conf);
      rampLabels.innerHTML = conf
        ? '<span>Fails</span><span>Unsure</span><span>Meets spec</span>'
        : '<span>Porous</span><span>Dense</span>';
      caption.textContent = conf
        ? 'Probability that a part meets the density specification. Amber regions are confidently inside the window, dark regions confidently outside, and grey regions need more tests. The solid line encloses 95% confidence. Rings mark tests.'
        : 'Predicted density across two of the four groups. The line marks the predicted edge of the window: too little energy on the left, keyholing on the right. Switch to Confidence to see how sure the model is.';
      var from = t, to = conf ? 1 : 0;
      if (anim) anim.stop();
      anim = tween(700, function (k) { t = lerp(from, to, k); draw(); });
    }
    buttons.forEach(function (b) {
      b.addEventListener('click', function () { go(b.getAttribute('data-mode')); });
    });
  }

  var demos = { collapse: collapseDemo, mogp: mogpDemo, map: mapDemo };
  document.querySelectorAll('[data-demo]').forEach(function (fig) {
    var fn = demos[fig.getAttribute('data-demo')];
    if (!fn) return;
    try { fn(fig); } catch (err) { fig.classList.add('is-broken'); }
  });
})();
