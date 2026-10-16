/* market: follows the "market" register record only. The contract-address record is never read here. */
UX.market = (function () {
  var M = {};
  var POLL_MS = 60000, BASE_MS = 2000, CAP_MS = 60000, TOP_N = 10, CHUNK = 30;
  var rec = UX.rec('market');
  var rows = [], addrs = [], ids = {}, nextId = 1, sortKey = 'vol', failures = 0, timer = null, ctrl = null, busy = false, hasData = false;
  var els = {};
  var SUB = ['₀', '₁', '₂', '₃', '₄', '₅', '₆', '₇', '₈', '₉'];

  function num(v) { var n = Number(v); return isFinite(n) ? n : null; }
  function fmtPrice(p) {
    if (p === null) return '—';
    if (p >= 1000) return '$' + p.toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (p >= 1) return '$' + p.toFixed(2);
    if (p >= 0.01) return '$' + p.toFixed(4);
    if (p === 0) return '$0';
    var s = p.toFixed(20), m = s.match(/^0\.(0+)(\d{1,4})/);
    if (!m) return '$' + p.toPrecision(3);
    var z = m[1].length;
    return z >= 4 ? '$0.0' + SUB[Math.min(z, 9)] + m[2] : '$0.' + m[1] + m[2];
  }
  function fmtBig(v) {
    if (v === null) return '—';
    var a = Math.abs(v);
    if (a >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
    return '$' + v.toFixed(0);
  }
  function fmtChg(c) { return c === null ? '—' : (c > 0 ? '+' : '') + c.toFixed(2) + '%'; }
  function short(a) { return a.length > 10 ? a.slice(0, 4) + '…' + a.slice(-4) : a; }

  function fetchJSON(url, signal) {
    return fetch(url, { signal: signal, headers: { accept: 'application/json' } }).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    });
  }

  function load(signal) {
    return fetchJSON(rec.boosts, signal).then(function (list) {
      var seen = {}, mints = [];
      (Array.isArray(list) ? list : []).forEach(function (b) {
        if (b && b.chainId === 'solana' && b.tokenAddress && !seen[b.tokenAddress]) { seen[b.tokenAddress] = 1; mints.push(b.tokenAddress); }
      });
      if (!mints.length) throw new Error('empty');
      var chunks = [];
      for (var i = 0; i < mints.length; i += CHUNK) chunks.push(mints.slice(i, i + CHUNK));
      return Promise.all(chunks.map(function (c) { return fetchJSON(rec.pairs + c.join(','), signal); }));
    }).then(function (parts) {
      var best = {};
      parts.forEach(function (arr) {
        (Array.isArray(arr) ? arr : []).forEach(function (p) {
          if (!p || p.chainId !== 'solana' || !p.baseToken || !p.baseToken.address) return;
          var a = p.baseToken.address, liq = num(p.liquidity && p.liquidity.usd) || 0;
          if (!best[a] || liq > best[a]._liq) { best[a] = p; p._liq = liq; }
        });
      });
      var out = Object.keys(best).map(function (a) {
        var p = best[a];
        return {
          addr: a, name: p.baseToken.name || p.baseToken.symbol || short(a), sym: p.baseToken.symbol || '',
          img: (p.info && p.info.imageUrl) || '', price: num(p.priceUsd), chg: num(p.priceChange && p.priceChange.h24),
          vol: num(p.volume && p.volume.h24), liq: num(p.liquidity && p.liquidity.usd)
        };
      }).filter(function (r) { return r.vol !== null; });
      if (!out.length) throw new Error('no pairs');
      out.sort(function (a, b) { return b.vol - a.vol; });
      return out.slice(0, TOP_N);
    });
  }

  /* ---- rendering ---- */
  function skeleton() {
    els.list.textContent = '';
    for (var i = 0; i < TOP_N; i++) {
      var li = document.createElement('li');
      li.className = 'mrow sk';
      li.innerHTML = '<span class="rk"><i class="sk-bar" style="width:18px"></i></span><span class="mtok"><span class="sk-circle"></span><span class="nm"><i class="sk-bar w1"></i></span></span><span class="stats"><span class="r"><i class="sk-bar w2"></i></span><span class="r"><i class="sk-bar w2"></i></span><span class="r"><i class="sk-bar w2"></i></span><span class="r"><i class="sk-bar w2"></i></span></span><span></span>';
      els.list.appendChild(li);
    }
    els.list.setAttribute('aria-busy', 'true');
  }

  function tile(r) {
    var d = document.createElement('span'); d.className = 'logo';
    var letter = (r.sym || r.name || '?').trim().charAt(0) || '?';
    function fallback() { d.textContent = letter; }
    if (r.img && /^https:\/\//.test(r.img)) {
      var im = document.createElement('img'); im.alt = ''; im.loading = 'lazy'; im.decoding = 'async'; im.referrerPolicy = 'no-referrer';
      im.addEventListener('error', function () { d.textContent = ''; fallback(); });
      im.src = r.img; d.appendChild(im);
    } else fallback();
    return d;
  }

  var copyIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';

  function countTo(el, from, to, fmt, ms) {
    if (UX.reduced || from === null || from === to || to === null) { el.textContent = fmt(to); return; }
    var t0 = null;
    (function step(ts) {
      if (t0 === null) t0 = ts;
      var p = Math.min(1, (ts - t0) / ms), e = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(from + (to - from) * e);
      if (p < 1) requestAnimationFrame(step); else el.textContent = fmt(to);
    })(performance.now());
  }
  function flash(el, dir) {
    el.classList.remove('flash-up', 'flash-dn'); void el.offsetWidth;
    el.classList.add(dir > 0 ? 'flash-up' : 'flash-dn');
  }

  function sorted() {
    var a = rows.slice();
    if (sortKey === 'chg') a.sort(function (x, y) { return (y.chg === null ? -1e9 : y.chg) - (x.chg === null ? -1e9 : x.chg); });
    else if (sortKey === 'liq') a.sort(function (x, y) { return (y.liq || 0) - (x.liq || 0); });
    else a.sort(function (x, y) { return y.vol - x.vol; });
    return a;
  }

  function render(first) {
    var list = sorted(), old = {};
    UX.$$('.mrow[data-k]', els.list).forEach(function (n) { old[n.getAttribute('data-k')] = n; });
    if (first) els.list.textContent = '';
    addrs = list.map(function (r) { return r.addr; });
    var frag = document.createDocumentFragment();
    list.forEach(function (r, i) {
      var kid = ids[r.addr] || (ids[r.addr] = String(nextId++)), li = old[kid] || null;
      var prev = li ? li._r : null;
      if (!li) {
        li = document.createElement('li'); li.className = 'mrow fadein'; li.style.setProperty('--i', i);
        li.innerHTML = '<span class="rk"></span><span class="mtok"></span><span class="stats"><span class="r px"></span><span class="r ch"></span><span class="r vo"></span><span class="r lq"></span></span><button type="button" class="mcopy"></button>';
        var tk = UX.$('.mtok', li);
        tk.appendChild(tile(r));
        var nm = document.createElement('span'); nm.className = 'nm';
        var b = document.createElement('b'); b.textContent = r.name; var s = document.createElement('small'); s.textContent = (r.sym ? r.sym + ' · ' : '') + short(r.addr);
        nm.appendChild(b); nm.appendChild(s); tk.appendChild(nm);
        UX.$('.mcopy', li).innerHTML = copyIcon;
        ['px', 'ch', 'vo', 'lq'].forEach(function (c, ix) {
          var cell = UX.$('.' + c, li), lbl = document.createElement('span'); lbl.className = 'lbl';
          lbl.textContent = ['Price', '24h', 'Turnover', 'Liquidity'][ix]; cell.appendChild(lbl);
          var v = document.createElement('span'); v.className = 'v'; cell.appendChild(v);
        });
        li.addEventListener('animationend', function (e) { if (e.animationName === 'fadein') li.classList.remove('fadein'); });
      }
      UX.$('.rk', li).textContent = String(i + 1);
      var btn = UX.$('.mcopy', li);
      btn.setAttribute('aria-label', 'Clip mint for ' + (r.sym || r.name));
      btn.setAttribute('data-i', String(i));
      var cells = { px: [prev && prev.price, r.price, fmtPrice], vo: [prev && prev.vol, r.vol, fmtBig], lq: [prev && prev.liq, r.liq, fmtBig] };
      Object.keys(cells).forEach(function (c) {
        var cell = UX.$('.' + c + ' .v', li), f = cells[c];
        var cellRow = UX.$('.' + c, li);
        countTo(cell, prev ? f[0] : null, f[1], f[2], 700);
        if (prev && f[0] !== null && f[1] !== null && f[0] !== f[1]) flash(cellRow, f[1] > f[0] ? 1 : -1);
      });
      var ch = UX.$('.ch .v', li); ch.textContent = fmtChg(r.chg);
      ch.className = 'v ' + (r.chg === null ? '' : r.chg >= 0 ? 'up' : 'dn');
      if (prev && prev.chg !== r.chg && r.chg !== null && prev.chg !== null) flash(UX.$('.ch', li), r.chg > prev.chg ? 1 : -1);
      li._r = r; li.setAttribute('data-k', kid);
      frag.appendChild(li);
    });
    els.list.textContent = '';
    els.list.appendChild(frag);
    els.list.setAttribute('aria-busy', 'false');
    renderTicker();
  }

  function dashRows(msg) {
    els.list.textContent = '';
    for (var i = 0; i < TOP_N; i++) {
      var li = document.createElement('li'); li.className = 'mrow';
      li.innerHTML = '<span class="rk">' + (i + 1) + '</span><span class="mtok"><span class="logo">—</span><span class="nm"><b>—</b></span></span><span class="stats"><span class="r"><span class="lbl">Price</span> —</span><span class="r"><span class="lbl">24h</span> —</span><span class="r"><span class="lbl">Volume</span> —</span><span class="r"><span class="lbl">Liquidity</span> —</span></span><button type="button" class="mcopy" disabled aria-label="Copy address unavailable">' + copyIcon + '</button>';
      els.list.appendChild(li);
    }
    els.list.setAttribute('aria-busy', 'false');
    note(msg);
  }

  function renderTicker() {
    var inner = els.tick; if (!inner) return;
    var items = sorted();
    inner.textContent = '';
    var one = document.createDocumentFragment();
    items.forEach(function (r) {
      var cls = r.chg === null ? '' : r.chg >= 0 ? 'up' : 'dn', arrow = r.chg === null ? '' : r.chg >= 0 ? '▲ ' : '▼ ';
      var s = document.createElement('span'); s.className = 'tk';
      var a = document.createElement('b'); a.textContent = r.sym || r.name;
      var p = document.createElement('em'); p.textContent = fmtPrice(r.price);
      var c = document.createElement('span'); c.className = cls; c.textContent = arrow + fmtChg(r.chg);
      s.appendChild(a); s.appendChild(p); s.appendChild(c); one.appendChild(s);
    });
    inner.appendChild(one.cloneNode(true)); inner.appendChild(one);
    inner.setAttribute('aria-hidden', 'true');
  }

  function setPill(state, text) {
    var pill = els.pill; if (!pill) return;
    pill.setAttribute('data-state', state);
    var t = UX.$('[data-slot="pill-text"]', pill); if (t) t.textContent = text;
  }
  function note(msg) { if (els.note) els.note.textContent = msg || ''; }

  /* ---- polling ---- */
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(tick, ms); }
  function backoff() { var d = Math.min(CAP_MS, BASE_MS * Math.pow(2, failures - 1)); return d + Math.floor(Math.random() * 400); }

  function tick() {
    if (document.hidden || busy) return;
    busy = true; ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    load(ctrl ? ctrl.signal : undefined).then(function (data) {
      busy = false; failures = 0;
      var first = !hasData; rows = data; hasData = true;
      render(first);
      setPill('live', 'Streaming'); note('');
      schedule(POLL_MS);
    }).catch(function (err) {
      busy = false;
      if (err && err.name === 'AbortError') return;
      failures++;
      if (hasData) { setPill('error', 'Retrying'); note('— Feed unreachable. Showing the previous good board.'); }
      else { setPill('error', 'Offline'); dashRows('— Feed unreachable. Retrying with backoff.'); }
      schedule(backoff());
    });
  }

  M.init = function () {
    els.list = UX.$('#mlist'); els.tick = UX.$('#ticker-in'); els.pill = UX.$('#mkt-pill'); els.note = UX.$('#mkt-note');
    if (!els.list) return;
    if (rec.state !== 'stated' || !rec.boosts || !rec.pairs) {
      setPill('inert', 'Pending'); dashRows('Market feed pending.');
      if (els.tick) els.tick.textContent = '';
      return;
    }
    skeleton(); setPill('loading', 'Syncing');
    UX.$$('.tab').forEach(function (t) {
      t.addEventListener('click', function () {
        UX.$$('.tab').forEach(function (x) { x.classList.toggle('on', x === t); x.setAttribute('aria-selected', x === t ? 'true' : 'false'); });
        sortKey = t.getAttribute('data-sort');
        if (hasData) { render(false); }
      });
    });
    els.list.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.mcopy') : null;
      if (!b || b.disabled) return;
      var a = addrs[Number(b.getAttribute('data-i'))]; if (!a) return;
      UX.copy(a).then(function (ok) {
        b.classList.toggle('done', !!ok); UX.toast(ok ? 'Clipped' : 'Browser refused the clip');
        setTimeout(function () { b.classList.remove('done'); }, 1400);
      });
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { clearTimeout(timer); if (ctrl) ctrl.abort(); busy = false; }
      else { clearTimeout(timer); tick(); }
    });
    tick();
  };
  return M;
})();
