/* register-ui: renders every [data-record] from the register. Inert records show label + "pending" only. */
UX.deriveHandle = function (url) {
  try {
    var u = new URL(url);
    var seg = u.pathname.split('/').filter(Boolean);
    if (!seg.length) return null;
    return u.hostname.replace(/^www\./, '') === 'github.com' ? seg.join('/') : '@' + seg[0].replace(/^@/, '');
  } catch (e) { return null; }
};

UX.bindRecords = function () {
  UX.$$('[data-record]').forEach(function (el) {
    var id = el.getAttribute('data-record');
    var r = UX.rec(id);
    el.setAttribute('data-state', r.state);
    if (id === 'ca' && el.id === 'ca-bar') return UX.renderCA(el, r);
    if (el.hasAttribute('data-link')) return UX.renderSocial(el, r, id);
    if (id === 'market') return;
    var lab = UX.$('[data-slot="label"]', el), val = UX.$('[data-slot="value"]', el);
    if (lab) lab.textContent = r.label;
    if (val) val.textContent = r.state === 'stated' ? (r.value || r.name || '') : (id === 'x' ? 'pending' : 'pending');
    if (id === 'x' && r.state === 'stated' && val) { var h = UX.deriveHandle(r.url); if (h) val.textContent = h; }
  });
};

UX.renderSocial = function (el, r, id) {
  var next;
  if (r.state === 'stated' && r.url) {
    next = document.createElement('a');
    next.href = r.url; next.target = '_blank'; next.rel = 'noopener noreferrer';
    var h = UX.deriveHandle(r.url);
    next.setAttribute('aria-label', r.label + (h ? ' ' + h : ''));
  } else {
    next = document.createElement('span');
    next.setAttribute('aria-disabled', 'true');
    next.setAttribute('aria-label', r.label + ', pending');
    next.setAttribute('role', 'img');
  }
  next.className = 'soc';
  next.setAttribute('data-record', id); next.setAttribute('data-link', id); next.setAttribute('data-state', r.state);
  while (el.firstChild) next.appendChild(el.firstChild);
  el.parentNode.replaceChild(next, el);
};

UX.renderCA = function (bar, r) {
  var slot = UX.$('[data-slot="ca"]', bar);
  slot.textContent = '';
  if (r.state === 'stated' && r.value) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'ca-copy';
    b.setAttribute('aria-label', 'Clip token mint');
    var a = document.createElement('span'); a.className = 'ca-addr'; a.textContent = r.value;
    var hint = document.createElement('span'); hint.className = 'ca-hint'; hint.textContent = 'Clip';
    b.appendChild(a); b.appendChild(hint);
    var live = UX.$('#ca-live'), timer;
    b.addEventListener('click', function () {
      UX.copy(r.value).then(function (ok) {
        hint.textContent = ok ? 'Clipped' : 'Press Ctrl+C';
        b.classList.toggle('done', !!ok);
        if (live) live.textContent = ok ? 'Mint clipped' : 'Clip failed';
        UX.toast(ok ? 'Clipped' : 'Browser refused the clip');
        clearTimeout(timer);
        timer = setTimeout(function () { hint.textContent = 'Clip'; b.classList.remove('done'); if (live) live.textContent = ''; }, 1800);
      });
    });
    slot.appendChild(b);
  } else {
    var p = document.createElement('span'); p.className = 'ca-pending'; p.textContent = 'pending';
    slot.appendChild(p);
  }
};
