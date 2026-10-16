/* core: helpers, register access, spring solver */
var UX = { reduced: false };
UX.$ = function (s, r) { return (r || document).querySelector(s); };
UX.$$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
UX.reduced = (function () {
  try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; }
})();

UX.register = (function () {
  var el = document.getElementById('register');
  try { return JSON.parse(el.textContent).records; } catch (e) { return {}; }
})();
UX.rec = function (id) { return UX.register[id] || { state: 'absent', label: id }; };
UX.stated = function (id) { return UX.rec(id).state === 'stated'; };

UX.toast = function (msg) {
  var t = UX.$('#toast'); if (!t) return;
  t.textContent = msg; t.classList.add('on');
  clearTimeout(UX.toast._t);
  UX.toast._t = setTimeout(function () { t.classList.remove('on'); }, 1600);
};

UX.copy = function (text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return UX.copyFallback(text); });
  }
  return Promise.resolve(UX.copyFallback(text));
};
UX.copyFallback = function (text) {
  try {
    var ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    var ok = document.execCommand && document.execCommand('copy');
    document.body.removeChild(ta);
    return !!ok;
  } catch (e) { return false; }
};

/* damped spring, semi-implicit Euler on a fixed 1/240s step; settles when both velocity and offset are tiny */
UX.spring = function (opts, onUpdate, onDone) {
  var k = opts.k || 170, c = opts.c || 18, m = opts.m || 1;
  var x = 0, v = 0, target = 1, acc = 0, last = null, STEP = 1 / 240, stopped = false;
  var delay = opts.delay || 0, started = null;
  function frame(ts) {
    if (stopped) return;
    if (started === null) started = ts;
    if (ts - started < delay) { requestAnimationFrame(frame); return; }
    if (last === null) last = ts;
    acc += Math.min(0.05, (ts - last) / 1000); last = ts;
    while (acc >= STEP) { var a = (-k * (x - target) - c * v) / m; v += a * STEP; x += v * STEP; acc -= STEP; }
    onUpdate(x);
    if (Math.abs(v) < 0.002 && Math.abs(x - target) < 0.001) { onUpdate(1); if (onDone) onDone(); return; }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  return function () { stopped = true; };
};
