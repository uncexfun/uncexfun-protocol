/* motion: scroll progress, spring reveal, parallax, spotlight, scrollspy, ascii waves, slider */
UX.initProgress = function () {
  var bar = UX.$('#progress'); if (!bar) return;
  var ticking = false;
  function upd() {
    var h = document.documentElement.scrollHeight - window.innerHeight;
    var p = h > 0 ? Math.min(1, Math.max(0, window.scrollY / h)) : 0;
    bar.style.transform = 'scaleX(' + p.toFixed(4) + ')';
    ticking = false;
  }
  window.addEventListener('scroll', function () { if (!ticking) { ticking = true; requestAnimationFrame(upd); } }, { passive: true });
  window.addEventListener('resize', upd); upd();
};

UX.initReveal = function () {
  var els = UX.$$('.reveal');
  function show(el, idx) {
    if (UX.reduced) { el.classList.add('in'); return; }
    var Y = 28, S = 0.02;
    UX.spring({ k: 170, c: 15, delay: idx * 70 }, function (p) {
      el.style.opacity = Math.max(0, Math.min(1, p * 1.4));
      el.style.transform = 'translateY(' + ((1 - p) * Y).toFixed(2) + 'px) scale(' + (1 - (1 - p) * S).toFixed(4) + ')';
    }, function () { el.style.opacity = ''; el.style.transform = ''; el.classList.add('in'); });
  }
  if (UX.reduced || !('IntersectionObserver' in window)) { els.forEach(function (e) { e.classList.add('in'); }); return; }
  var batch = 0, timer = null;
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (!en.isIntersecting) {
        if (en.boundingClientRect.top < 0) { io.unobserve(en.target); en.target.classList.add('in'); }
        return;
      }
      io.unobserve(en.target);
      show(en.target, batch++);
    });
    clearTimeout(timer); timer = setTimeout(function () { batch = 0; }, 120);
  }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
  els.forEach(function (e) { io.observe(e); });
  /* anything the reader jumps clean past (anchor links, fast scroll) lands instantly instead of waiting */
  var sweeping = false;
  window.addEventListener('scroll', function () {
    if (sweeping) return; sweeping = true;
    requestAnimationFrame(function () {
      sweeping = false;
      els.forEach(function (e) {
        if (!e.classList.contains('in') && !e.style.opacity && e.getBoundingClientRect().bottom < 0) { io.unobserve(e); e.classList.add('in'); }
      });
    });
  }, { passive: true });
};

UX.initParallax = function () {
  var stage = UX.$('#stage'); if (!stage || UX.reduced) return;
  var layers = UX.$$('[data-depth]', stage).map(function (el) { return { el: el, d: parseFloat(el.getAttribute('data-depth')) || 0 }; });
  var tx = 0, ty = 0, cx = 0, cy = 0, running = false, visible = true;
  stage.addEventListener('pointermove', function (e) {
    var r = stage.getBoundingClientRect();
    tx = ((e.clientX - r.left) / r.width - 0.5) * 2; ty = ((e.clientY - r.top) / r.height - 0.5) * 2; kick();
  });
  stage.addEventListener('pointerleave', function () { tx = 0; ty = 0; kick(); });
  window.addEventListener('scroll', kick, { passive: true });
  if ('IntersectionObserver' in window) new IntersectionObserver(function (es) { visible = es[0].isIntersecting; if (visible) kick(); }).observe(stage);
  function kick() { if (!running && visible) { running = true; requestAnimationFrame(tick); } }
  function tick() {
    cx += (tx - cx) * 0.12; cy += (ty - cy) * 0.12;
    var sy = Math.min(window.scrollY, 900);
    layers.forEach(function (l) {
      l.el.style.transform = 'translate3d(' + (cx * l.d * 14).toFixed(2) + 'px,' + (cy * l.d * 14 - sy * l.d * 0.06).toFixed(2) + 'px,0)';
    });
    if (Math.abs(tx - cx) > 0.002 || Math.abs(ty - cy) > 0.002) requestAnimationFrame(tick); else running = false;
  }
  kick();
};

UX.initSpotlight = function () {
  document.addEventListener('pointermove', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('.spot, .mrow') : null;
    if (!t) return;
    var r = t.getBoundingClientRect();
    t.style.setProperty('--mx', (e.clientX - r.left) + 'px');
    t.style.setProperty('--my', (e.clientY - r.top) + 'px');
  }, { passive: true });
};

UX.initSpy = function () {
  var links = UX.$$('.nav a[data-spy]');
  if (!('IntersectionObserver' in window)) return;
  var map = {};
  links.forEach(function (a) { var s = document.getElementById(a.getAttribute('data-spy')); if (s) map[s.id] = a; });
  var io = new IntersectionObserver(function (es) {
    es.forEach(function (e) {
      if (!e.isIntersecting) return;
      links.forEach(function (a) { a.classList.remove('on'); });
      if (map[e.target.id]) map[e.target.id].classList.add('on');
    });
  }, { rootMargin: '-30% 0px -60% 0px' });
  Object.keys(map).forEach(function (k) { io.observe(document.getElementById(k)); });
};

/* ascii wave field, colours are read from the stylesheet tokens */
UX.initWaves = function () {
  var cv = UX.$('#waves'); if (!cv || !cv.getContext) return;
  var ctx; try { ctx = cv.getContext('2d'); } catch (e) { return; }
  if (!ctx) return;
  var cs = getComputedStyle(document.documentElement);
  var hi = cs.getPropertyValue('--accent').trim(), lo = cs.getPropertyValue('--moss').trim();
  var chars = ' .,:-=+*#', CW = 9, CH = 14, W = 0, H = 0, cols = 0, rows = 0, raf = 0, t = 0, vis = true;
  function size() {
    var r = cv.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
    W = Math.max(1, Math.floor(r.width)); H = Math.max(1, Math.floor(r.height));
    cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.ceil(W / CW); rows = Math.ceil(H / CH);
    ctx.font = '600 12px ' + (cs.getPropertyValue('--mono') || 'monospace'); ctx.textBaseline = 'top';
  }
  function draw() {
    ctx.clearRect(0, 0, W, H);
    for (var y = 0; y < rows; y++) {
      for (var x = 0; x < cols; x++) {
        var wave = Math.sin(x * 0.11 + t * 0.9) * 0.5 + Math.sin(x * 0.047 - t * 0.5 + y * 0.2) * 0.5 + Math.sin(x * 0.2 + t * 1.3) * 0.18;
        var crest = rows * (0.5 + 0.28 * wave);
        var d = y - crest;
        if (d < 0) continue;
        var level = Math.max(0, Math.min(chars.length - 1, Math.floor(chars.length - 1 - d * 1.1)));
        if (level < 1) continue;
        ctx.fillStyle = d < 1.2 ? hi : lo;
        ctx.globalAlpha = Math.min(1, 0.2 + (rows - y) / rows * 0.0 + level / (chars.length - 1) * 0.8);
        ctx.fillText(chars.charAt(level), x * CW, y * CH);
      }
    }
    ctx.globalAlpha = 1;
  }
  function loop() { t += 0.016; draw(); raf = vis ? requestAnimationFrame(loop) : 0; }
  size(); draw();
  if (UX.reduced) return;
  window.addEventListener('resize', function () { size(); if (!raf) draw(); });
  if ('IntersectionObserver' in window) new IntersectionObserver(function (es) { vis = es[0].isIntersecting; if (vis && !raf) raf = requestAnimationFrame(loop); }).observe(cv);
  document.addEventListener('visibilitychange', function () { vis = !document.hidden; if (vis && !raf) raf = requestAnimationFrame(loop); });
  raf = requestAnimationFrame(loop);
};

/* slider: position as a share of supply on a log scale (an input scale only, not a stated figure) */
UX.initSlider = function () {
  var s = UX.$('#bag'), o = UX.$('#bag-out'); if (!s || !o) return;
  function upd() { var v = Math.pow(10, -2 + (s.value / 100) * 2); o.textContent = v.toFixed(2) + '% of supply'; }
  s.addEventListener('input', upd); upd();
};
