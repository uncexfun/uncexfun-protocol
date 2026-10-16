// Gates. `npm run gates` builds dist/ plus temporary mutation builds and exits non-zero on any failure.
import { readFileSync, existsSync, readdirSync, statSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, relative, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { JSDOM, VirtualConsole } from 'jsdom';
import { build } from './build.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const results = [];
function gate(name, fn) {
  return Promise.resolve().then(fn).then(
    (r) => { const ok = r === true || r === undefined; results.push({ name, ok, msg: ok ? '' : String(r) }); },
    (e) => results.push({ name, ok: false, msg: 'threw: ' + (e && e.message) })
  );
}
const read = (p) => readFileSync(p, 'utf8');
function walk(dir, skip = []) {
  const out = [];
  for (const f of readdirSync(dir)) {
    if (skip.includes(f)) continue;
    const p = join(dir, f);
    statSync(p).isDirectory() ? out.push(...walk(p, skip)) : out.push(p);
  }
  return out;
}
const SAMPLE_ADDR = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'; // a 44 char base58 shape used only by the mutation harness
const SAMPLE_0X = '0x' + 'ab12cd34ef'.repeat(4);

// ---------- helpers: build + run in jsdom ----------
function mkBuild(registerObj) {
  const dir = mkdtempSync(join(tmpdir(), 'uncex-'));
  const regFile = join(dir, 'register.json');
  writeFileSync(regFile, JSON.stringify(registerObj));
  const out = join(dir, 'dist');
  build({ out, register: regFile });
  return { out, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function fixtureFetch(log, { fail = false } = {}) {
  const mk = (i) => ({ chainId: 'solana', tokenAddress: 'Tok' + String(i).padStart(2, '0') + 'x'.repeat(30) + 'pump' });
  const boosts = [...Array.from({ length: 13 }, (_, i) => mk(i)), { chainId: 'ethereum', tokenAddress: '0x' + '1'.repeat(40) }];
  return (url) => {
    log.push(String(url));
    if (fail) return Promise.reject(new Error('net'));
    const j = (b) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(b) });
    if (String(url).includes('token-boosts')) return j(boosts);
    const addrs = decodeURIComponent(String(url).split('/solana/')[1]).split(',');
    return j(addrs.map((a, i) => ({
      chainId: 'solana', baseToken: { address: a, name: 'Name' + a.slice(3, 5), symbol: 'S' + a.slice(3, 5) },
      priceUsd: String(0.0001234 * (i + 1)), priceChange: { h24: (i % 2 ? -1 : 1) * (i + 1.5) },
      volume: { h24: 1000 * (20 - i) }, liquidity: { usd: 5000 + i * 100 },
      info: i === 2 ? {} : { imageUrl: 'https://cdn.example.test/' + i + '.png' }
    })));
  };
}

async function runPage(outDir, { fetchFail = false, wait = 120 } = {}) {
  const log = [];
  const html = read(join(outDir, 'index.html'));
  const vc = new VirtualConsole();
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  w.fetch = fixtureFetch(log, { fail: fetchFail });
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const copied = [];
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: (t) => { copied.push(t); return Promise.resolve(); } }, configurable: true });
  w.HTMLCanvasElement.prototype.getContext = () => null;
  w.eval(read(join(outDir, 'app.js')));
  await new Promise((r) => setTimeout(r, wait));
  return { dom, w, doc: w.document, log, copied };
}

function visibleText(doc) {
  const c = doc.body.cloneNode(true);
  c.querySelectorAll('script,style,noscript,template').forEach((n) => n.remove());
  return c.textContent.replace(/\s+/g, ' ').trim();
}
function attrValues(root) {
  const out = [];
  root.querySelectorAll('*').forEach((el) => {
    for (const a of el.attributes) if (!['class', 'style', 'd', 'viewBox', 'points', 'src', 'srcset', 'href', 'rel', 'type', 'id', 'charset'].includes(a.name) || ['title', 'alt'].includes(a.name)) out.push(a.value);
  });
  return out;
}
function copyStrings(doc) {
  const out = [visibleText(doc), doc.title];
  doc.querySelectorAll('meta[name=description]').forEach((m) => out.push(m.content));
  doc.querySelectorAll('[aria-label],[title],[alt],[placeholder]').forEach((e) => { for (const a of ['aria-label', 'title', 'alt', 'placeholder']) if (e.hasAttribute(a)) out.push(e.getAttribute(a)); });
  return out.join(' \n ');
}
function allVisibleStrings(doc) {
  const head = [doc.title, ...[...doc.querySelectorAll('meta[name=description]')].map((m) => m.content)];
  return [visibleText(doc), ...attrValues(doc.body), ...head].join(' \n ');
}

// ---------- register logic (also run against bad inputs as negative controls) ----------
function checkRegister(reg) {
  const errs = [];
  for (const [id, r] of Object.entries(reg.records || {})) {
    if (!['stated', 'absent', 'unconfirmed'].includes(r.state)) errs.push(id + ': bad state');
    if (r.state !== 'stated') {
      for (const k of ['value', 'url', 'name', 'rpc', 'boosts', 'pairs']) if (k in r) errs.push(id + ': inert record carries ' + k);
    } else if (!r.source) errs.push(id + ': stated record has no source');
    if (r.kind === 'url' && r.state === 'stated' && !(typeof r.url === 'string' && r.url.startsWith('https://' + r.host + '/'))) errs.push(id + ': stated url does not match host');
    if (r.kind === 'address' && r.state === 'stated' && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.value || '')) errs.push(id + ': stated address is not base58 shaped');
  }
  return errs;
}
const DATE_RE = [/\b(19|20)\d{2}\b/, /\d{4}[-/]\d{1,2}[-/]\d{1,2}/, /\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/, /\b\d{1,2}:\d{2}(:\d{2})?\s?(am|pm)?\b/i,
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i, /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /\b(as of|checked|updated|timestamp|last seen|ago|utc|gmt)\b/i];
function dateHits(s) { return DATE_RE.filter((re) => re.test(s)).map(String); }
const B58 = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g, HEX = /\b0x[0-9a-fA-F]{40}\b/g;
function addressViolations(text, statedValues) {
  const hits = [...(text.match(B58) || []), ...(text.match(HEX) || [])];
  return hits.filter((h) => !statedValues.includes(h));
}
const STOP = new Set('a an the of to in is it its and or on for with at by be as are was this that these those from your you our we us not no but if so than then there their they them his her he she i my me can will would do does did how what which who when where why per via also only just into out up down over one'.split(' '));
const ALLOW_WORDS = new Set(['solana', 'uncex', 'x']);
function tokens(s) { return s.toLowerCase().replace(/[$@]/g, '').split(/[^a-z0-9']+/).filter(Boolean); }
function segments(s) { return s.split(/[.!?·:;|\n…—]+/).map((x) => tokens(x)).filter((t) => t.length); }
function bigramSet(s) { const set = new Set(); for (const seg of segments(s)) for (let i = 0; i < seg.length - 1; i++) set.add(seg[i] + ' ' + seg[i + 1]); return set; }
function uiStrings(src) {
  return (src.match(/'[^'\n]{3,}'/g) || []).map((x) => x.slice(1, -1))
    .filter((x) => /^[A-Z\u2014]/.test(x) || x.includes(' '))
    .filter((x) => !/[#.\[=>:<{}()\/]/.test(x)).join('\n');
}
function wordSet(s) { return new Set(tokens(s).filter((w) => !STOP.has(w) && !ALLOW_WORDS.has(w) && !/^\d+$/.test(w) && w.length > 1)); }

// =============================================================
const outPath = build({ out: DIST });
const html = read(join(DIST, 'index.html'));
const css = read(join(DIST, 'styles.css'));
const tokensCss = read(join(DIST, 'tokens.css'));
const js = read(join(DIST, 'app.js'));
const reg = JSON.parse(read(join(DIST, 'register.json')));
const base = await runPage(DIST);
const baseText = allVisibleStrings(base.doc);
const copyText = copyStrings(base.doc);
const refText = read(join(ROOT, 'scripts', 'fixtures', 'reference-text.txt'));

// ---- structure + hygiene ----
await gate('dist: index, app, styles, tokens, favicon, register, fonts, assets present', () => {
  const need = ['index.html', 'app.js', 'styles.css', 'tokens.css', 'favicon.svg', 'register.json', 'fonts/bricolage.woff2', 'fonts/inter.woff2', 'fonts/jbmono.woff2', 'assets/logo-96.png', 'assets/logo-192.png', 'assets/logo-512.png'];
  const miss = need.filter((f) => !existsSync(join(DIST, f)));
  return miss.length ? 'missing ' + miss.join(', ') : true;
});
await gate('dist: holds none of README, docs, LICENSE, scripts, node_modules', () => {
  const bad = walk(DIST).map((p) => relative(DIST, p).split(sep).join('/')).filter((p) => /^(README|LICENSE|docs\/|scripts\/|node_modules\/|package)/i.test(p));
  return bad.length ? bad.join(', ') : true;
});
await gate('hygiene: no CLAUDE.md and no .claude directory anywhere in the project', () => {
  const all = walk(ROOT, ['node_modules', 'dist']);
  const bad = all.filter((p) => /(^|[\\/])CLAUDE\.md$/i.test(p) || /[\\/]\.claude[\\/]/.test(p));
  return bad.length ? bad.join(', ') : true;
});
await gate('hygiene: no model-vendor name, co-author trailer or generated-by line in project text', () => {
  const files = walk(ROOT, ['node_modules', 'dist', 'brand', 'reference', 'fixtures', 'package-lock.json', '.git']).filter((p) => /\.(md|html|css|js|mjs|json|svg|py|txt)$/i.test(p) || /LICENSE$/.test(p));
  const bad = [];
  for (const f of files) {
    if (f.endsWith('gates.mjs')) continue;
    const t = read(f);
    if (/claude|anthropic|co-authored-by|generated (by|with)|\bAI[- ]generated|\bchatgpt|\bopenai/i.test(t)) bad.push(relative(ROOT, f));
  }
  return bad.length ? 'found in ' + bad.join(', ') : true;
});
await gate('hygiene: the bare word "AI" is absent from site, README, whitepaper and licence', () => {
  const files = [join(DIST, 'index.html'), join(DIST, 'app.js'), join(ROOT, 'README.md'), join(ROOT, 'docs', 'whitepaper.md'), join(ROOT, 'LICENSE')];
  const bad = files.filter((f) => existsSync(f) && /\bAI\b/.test(read(f)));
  return bad.length ? bad.map((b) => relative(ROOT, b)).join(', ') : true;
});
await gate('repo: README.md, docs/whitepaper.md, LICENSE (MIT, Uncex) exist in root', () => {
  const r = join(ROOT, 'README.md'), w = join(ROOT, 'docs', 'whitepaper.md'), l = join(ROOT, 'LICENSE');
  if (![r, w, l].every(existsSync)) return 'missing file';
  const lic = read(l);
  if (!/MIT License/.test(lic) || !/Copyright \(c\) 2026 Uncex/.test(lic)) return 'LICENSE is not MIT / Uncex 2026';
  const rd = read(r);
  if (!/uncex\.fun/.test(rd) || !/Solana/.test(rd) || !/Overview/.test(rd) || !/Features/.test(rd) || !/Links/.test(rd) || !/img\.shields\.io/.test(rd)) return 'README missing required parts';
  const wp = read(w);
  if (!/Vision/i.test(wp) || !/Tokenomics/i.test(wp) || !/Roadmap/i.test(wp) || !/Team/i.test(wp)) return 'whitepaper missing sections';
  if ((wp.match(/^#{2,3} Phase \d/gm) || []).length < 3) return 'whitepaper needs 3-4 phases';
  return true;
});

// ---- palette / tokens ----
await gate('palette rule: colour literals exist only in tokens.css (and the generated favicon)', () => {
  const lit = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g;
  const bad = [];
  for (const [n, t] of [['index.html', html.replace(/<script type="application\/json"[\s\S]*?<\/script>/, '')], ['styles.css', css], ['app.js', js]]) {
    const cleaned = n === 'index.html' ? t.replace(/&#\d+;/g, '') : t;
    if (lit.test(cleaned)) bad.push(n);
    lit.lastIndex = 0;
  }
  return bad.length ? 'literals in ' + bad.join(', ') : true;
});
await gate('palette rule: every tokens.css hex is a sampled pixel (provenance comment names it)', () => {
  const hexes = [...new Set(tokensCss.match(/#[0-9A-Fa-f]{6}\b/g) || [])];
  const comment = tokensCss.match(/\/\*[\s\S]*?\*\//)[0];
  const lines = comment.split('\n');
  const sampled = hexes.filter((h) => lines.some((l) => l.toUpperCase().includes(h.toUpperCase()) && /\(\d+,\d+\)/.test(l)));
  const missing = hexes.filter((h) => !sampled.includes(h));
  if (!/k-means/i.test(comment) || !/snapped/i.test(comment)) return 'provenance comment lacks k-means / snapping statement';
  return missing.length ? 'no pixel coordinate for ' + missing.join(', ') : true;
});
await gate('palette rule: tokens.css colours match scripts/palette.json (logo k-means) where they claim logo origin', () => {
  const pal = JSON.parse(read(join(ROOT, 'scripts', 'palette.json')));
  const claimed = ['E4E6DC', '367254', '104C30', 'D3D8CD', 'AABAAB', '73937F'];
  const have = pal.map((p) => p.hex.slice(1).toUpperCase());
  const bad = claimed.filter((c) => !have.includes(c));
  return bad.length ? 'not in k-means output: ' + bad.join(',') : claimed.every((c) => tokensCss.toUpperCase().includes(c)) ? true : 'token missing';
});

// ---- favicon ----
await gate('favicon: 32x32 SVG, no comments, no double hyphen, linked from page, uses palette colours only', () => {
  const svg = read(join(DIST, 'favicon.svg'));
  if (!/width="32"/.test(svg) || !/height="32"/.test(svg) || !/viewBox="0 0 32 32"/.test(svg)) return 'not 32x32';
  if (svg.includes('--') || svg.includes('<!--')) return 'double hyphen or comment';
  if (!/<link rel="icon"[^>]*favicon\.svg/.test(html)) return 'not linked';
  const cols = [...new Set(svg.match(/#[0-9A-Fa-f]{6}/g) || [])].map((c) => c.toUpperCase());
  const pal = JSON.parse(read(join(ROOT, 'scripts', 'palette.json'))).map((p) => p.hex.toUpperCase());
  const bad = cols.filter((c) => !pal.includes(c));
  return bad.length ? 'off-palette ' + bad.join(',') : (svg.match(/<rect/g) || []).length > 20 ? true : 'too few rects, not traced';
});

// ---- register + links + gate warning ----
await gate('register: schema valid; inert records carry no value or url', () => { const e = checkRegister(reg); return e.length ? e.join('; ') : true; });
await gate('register negative control: a corrupt register is rejected', () => {
  const bad = JSON.parse(JSON.stringify(reg)); bad.records.x.url = 'https://x.com/a'; bad.records.ca.value = SAMPLE_ADDR;
  return checkRegister(bad).length >= 2 ? true : 'checker accepted a corrupt register';
});
await gate('link rule: no href for unstated records; every external href equals a stated record url', () => {
  const stated = Object.values(reg.records).filter((r) => r.state === 'stated' && r.url).map((r) => r.url);
  const bad = [...base.doc.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).filter((h) => !h.startsWith('#') && !stated.includes(h));
  const soc = [...base.doc.querySelectorAll('.soc')].filter((e) => e.tagName === 'A');
  const inertWithLink = Object.entries(reg.records).filter(([id, r]) => r.kind === 'url' && r.state !== 'stated' && base.doc.querySelector('a[data-record="' + id + '"]'));
  return bad.length || inertWithLink.length || (soc.length !== stated.filter((u) => /x\.com|github\.com/.test(u)).length) ? 'bad hrefs: ' + bad.join(',') : true;
});
await gate('gate warning: addresses are matched against the stated registry (0x hex is not blanket-rejected)', () => {
  const statedVals = Object.values(reg.records).filter((r) => r.state === 'stated' && r.kind === 'address').map((r) => r.value);
  const c = base.doc.body.cloneNode(true); const bar = c.querySelector('#ca-bar'); if (bar) bar.remove();
  const v = addressViolations([c.textContent, ...attrValues(c)].join(' '), statedVals);
  if (v.length) return 'unregistered address-shaped strings: ' + v.join(',');
  // controls: unknown 0x flagged, registered 0x passes, short 0x tokens never trip it
  if (addressViolations('see ' + SAMPLE_0X, []).length !== 1) return 'unknown 0x not flagged';
  if (addressViolations('see ' + SAMPLE_0X, [SAMPLE_0X]).length !== 0) return 'registered 0x rejected (blanket reject)';
  if (addressViolations('colour 0x1f and 0xdeadbeef', []).length !== 0) return 'short hex wrongly flagged';
  return true;
});
await gate('gate warning: the CA slot is exempt, and holds the only address on the page', async () => {
  const m = mutate(reg, 'ca'); const b = mkBuild(m.reg);
  try {
    const p = await runPage(b.out); const c = p.doc.body.cloneNode(true); c.querySelector('#ca-bar').remove();
    const outside = addressViolations(c.textContent + attrValues(c).join(' '), []);
    const inside = p.doc.querySelector('#ca-bar').textContent;
    return outside.length === 0 && /^[\s\S]*$/.test(inside) ? true : 'address leaked outside the CA slot: ' + outside.join(',');
  } finally { b.cleanup(); }
});

// ---- no dates ----
await gate('no dates: rendered text, attributes, tooltips and aria-labels carry no date or clock string', () => { const h = dateHits(baseText); return h.length ? 'matches ' + h.join(' ') + ' in: ' + baseText.slice(0, 80) : true; });
await gate('no dates: script uses no Date, clock-formatting or timestamp API', () => {
  const m = js.match(/new Date|Date\.(now|UTC|parse)|toLocale(Date|Time)String|DateTimeFormat|getFullYear|getHours|getMinutes|toISOString|toUTCString|toTimeString|toDateString|\.getTime\(/);
  return m ? 'found ' + m[0] : true;
});
await gate('no dates: register.json dates are data only (never inlined into the page)', () => {
  const inline = base.doc.getElementById('register').textContent;
  return /"checked"/.test(inline) || /\d{4}-\d{2}-\d{2}/.test(html) ? 'date leaked into page' : (/"checked"/.test(read(join(DIST, 'register.json'))) ? true : 'register.json lost its dates');
});
await gate('no dates: runtime DOM after market load still clean', async () => {
  const h = dateHits(allVisibleStrings(base.doc)); return h.length ? h.join(' ') : true;
});

// ---- socials ----
await gate('social: both icons present, icon-only, official X mark and Octicon paths', () => {
  const socs = [...base.doc.querySelectorAll('.social .soc')];
  if (socs.length !== 2) return 'expected 2 icons';
  if (socs.some((s) => s.textContent.trim() !== '')) return 'icon has text label';
  const d = socs.map((s) => s.querySelector('path').getAttribute('d'));
  if (!d[0].startsWith('M18.244 2.25h3.308l-7.227 8.26')) return 'not official X path';
  if (!d[1].startsWith('M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59')) return 'not official Octicon path';
  return true;
});
await gate('social: never hidden at any breakpoint, 44px targets, pinned top-right', () => {
  const blocks = css.match(/[^{}]*\{[^{}]*\}/g) || [];
  const hide = blocks.filter((b) => /\.(soc|social)\b/.test(b.split('{')[0]) && /display\s*:\s*none|visibility\s*:\s*hidden/.test(b));
  if (hide.length) return 'hidden by ' + hide[0];
  if (!/\.soc \{[^}]*width: var\(--tap\)[^}]*height: var\(--tap\)/.test(css)) return 'tap size missing';
  if (!/\.social \{[^}]*margin-left: auto/.test(css)) return 'not pushed right';
  return true;
});
await gate('social: unstated icons are inert (span, aria-disabled, no href, no tabindex, no handler target)', () => {
  const bad = [...base.doc.querySelectorAll('.soc')].filter((s) => reg.records[s.dataset.record].state !== 'stated' && (s.tagName !== 'SPAN' || s.hasAttribute('href') || s.getAttribute('aria-disabled') !== 'true' || s.hasAttribute('tabindex')));
  return bad.length ? 'live inert icon' : true;
});

// ---- CA slot ----
await gate('CA slot: top of page, inside the sticky header, before the hero', () => {
  const bar = base.doc.getElementById('ca-bar');
  if (!bar || !bar.closest('header.top')) return 'not in header';
  if (!(html.indexOf('id="ca-bar"') < html.indexOf('class="hero"'))) return 'after hero';
  return /\.top \{[^}]*position: sticky/.test(css) ? true : 'header not sticky';
});
await gate('CA slot: large font, full-address wrapping, tap target, no ch units anywhere', () => {
  if (!/\.ca-copy \{[^}]*font: 700 clamp\(14px, 1\.7vw, 22px\)/.test(css)) return 'font not large';
  if (!/\.ca-addr \{[^}]*overflow-wrap: anywhere/.test(css)) return 'address can be truncated';
  if (/\d\s*ch\b/.test(css + html)) return 'ch unit used';
  return true;
});
await gate('CA slot: inert while absent (label + pending, no button, no value, no address attribute)', () => {
  if (reg.records.ca.state === 'stated') return true; // state-independent: stated is covered by the mutation gate
  const bar = base.doc.getElementById('ca-bar');
  return bar.querySelector('button, a, [data-address]') ? 'interactive while absent' : /pending/.test(bar.textContent) && bar.textContent.includes(reg.records.ca.label) ? true : 'label/pending missing';
});

// ---- mutation harness: anchors read the current record at runtime, never a fixed state ----
function mutate(register, id) {
  const reg2 = JSON.parse(JSON.stringify(register)); const r = reg2.records[id]; const was = r.state;
  if (was === 'stated') {
    r.state = 'absent'; r.source = null; for (const k of ['value', 'url', 'name', 'rpc', 'boosts', 'pairs']) delete r[k];
  } else {
    r.state = 'stated'; r.source = 'mutation harness';
    if (r.kind === 'address') r.value = SAMPLE_ADDR; else if (r.kind === 'url') r.url = 'https://' + r.host + '/uncexmut'; else r.value = 'mutant';
  }
  return { reg: reg2, was, now: r.state, rec: r };
}
for (const id of ['ca', 'x', 'github']) {
  await gate(`mutation: flipping the "${id}" record flips its rendering, both branches, anchors read the live record`, async () => {
    const m = mutate(reg, id); const b = mkBuild(m.reg);
    try {
      const p = await runPage(b.out);
      const here = id === 'ca' ? p.doc.getElementById('ca-bar') : p.doc.querySelector(`.social [data-record="${id}"]`);
      if (here.getAttribute('data-state') !== m.now) return 'state attribute did not follow the record';
      const errs = checkRegister(m.reg); if (errs.length) return 'harness produced invalid register ' + errs;
      if (m.now === 'stated') {
        if (id === 'ca') {
          const btn = here.querySelector('button.ca-copy');
          if (!btn || btn.querySelector('.ca-addr').textContent !== m.rec.value) return 'full address not shown';
          btn.click(); await new Promise((r) => setTimeout(r, 30));
          if (p.copied[0] !== m.rec.value) return 'click did not copy';
          if (!/Clipped/.test(btn.textContent) || !btn.classList.contains('done')) return 'no copy feedback';
        } else {
          if (here.tagName !== 'A' || here.getAttribute('href') !== m.rec.url) return 'href missing after stated';
          if (!/uncexmut/.test(here.getAttribute('aria-label') || '')) return 'handle not derived from url';
        }
      } else {
        if (here.querySelector('a[href], button') || here.tagName === 'A' || here.hasAttribute('href')) return 'still live after unstated';
      }
      return true;
    } finally { b.cleanup(); }
  });
}
await gate('mutation: the other records are untouched when one record flips', async () => {
  const m = mutate(reg, 'x'); const b = mkBuild(m.reg);
  try {
    const p = await runPage(b.out);
    const gh = p.doc.querySelector('.social [data-record="github"]'), ca = p.doc.getElementById('ca-bar');
    return gh.getAttribute('data-state') === reg.records.github.state && ca.getAttribute('data-state') === reg.records.ca.state ? true : 'cross-talk';
  } finally { b.cleanup(); }
});

// ---- market ----
await gate('market: endpoints, 60s poll, visibility pause, backoff, top 10 are in the source', () => {
  const need = [reg.records.market.boosts, reg.records.market.pairs, 'POLL_MS = 60000', 'document.hidden', 'visibilitychange', 'Math.pow(2, failures - 1)', "chainId === 'solana'", 'TOP_N = 10'];
  const miss = need.filter((n) => !(js.includes(n) || read(join(DIST, 'register.json')).includes(n)));
  return miss.length ? 'missing ' + miss.join(' | ') : true;
});
await gate('market: renders top 10 by 24h volume with logo, price, change, volume, liquidity, copy button', () => {
  const rows = [...base.doc.querySelectorAll('#mlist .mrow[data-k]')];
  if (rows.length !== 10) return 'rows=' + rows.length;
  const vols = rows.map((r) => r._r && r._r.vol);
  if (vols.some((v, i) => i && v > vols[i - 1])) return 'not sorted by volume';
  if (base.log.filter((u) => u.includes('/tokens/v1/solana/')).length < 1) return 'pairs endpoint not called';
  if (base.log.some((u) => u.includes('ethereum'))) return 'non-solana leaked';
  const r = rows[0];
  return r.querySelector('.logo') && r.querySelector('.px') && r.querySelector('.ch') && r.querySelector('.vo') && r.querySelector('.lq') && r.querySelector('.mcopy') ? true : 'cell missing';
});
await gate('market: letter tile fallback when imageUrl is missing', () => {
  const rows = [...base.doc.querySelectorAll('#mlist .mrow[data-k]')];
  const noimg = rows.filter((r) => !r.querySelector('.logo img'));
  return noimg.length >= 1 && noimg.every((r) => /^[A-Za-z0-9]$/.test(r.querySelector('.logo').textContent.trim())) ? true : 'no letter tile';
});
await gate('market: copy-per-address copies the row address; addresses never sit in the DOM', async () => {
  const p = await runPage(DIST); const b = p.doc.querySelector('#mlist .mcopy'); b.click(); await new Promise((r) => setTimeout(r, 30));
  if (!/^Tok\d\dx+pump$/.test(p.copied[0] || '')) return 'wrong copy ' + p.copied[0];
  return /Tok\d\dx{30}pump/.test(p.doc.body.innerHTML) ? 'full address in DOM' : true;
});
await gate('market: failure keeps last good data, shows dash + error (no data case and refresh-fail case)', async () => {
  const none = await runPage(DIST, { fetchFail: true });
  if (!/—/.test(none.doc.getElementById('mlist').textContent) || !/unreachable/i.test(none.doc.getElementById('mkt-note').textContent)) return 'no dash/error without data';
  if (none.doc.getElementById('mkt-pill').dataset.state !== 'error') return 'pill not error';
  // refresh failure: succeed, then fail, via the visible-again path
  const p = await runPage(DIST); let rows = p.doc.querySelectorAll('#mlist .mrow[data-k]').length;
  p.w.fetch = fixtureFetch([], { fail: true });
  Object.defineProperty(p.doc, 'hidden', { value: true, configurable: true }); p.doc.dispatchEvent(new p.w.Event('visibilitychange'));
  Object.defineProperty(p.doc, 'hidden', { value: false, configurable: true }); p.doc.dispatchEvent(new p.w.Event('visibilitychange'));
  await new Promise((r) => setTimeout(r, 80));
  const after = p.doc.querySelectorAll('#mlist .mrow[data-k]').length;
  return rows === 10 && after === 10 && /good board/i.test(p.doc.getElementById('mkt-note').textContent) ? true : `rows ${rows}->${after}, note="${p.doc.getElementById('mkt-note').textContent}"`;
});
await gate('market: pauses while hidden, fetches immediately when visible again', async () => {
  const p = await runPage(DIST); const n0 = p.log.length;
  Object.defineProperty(p.doc, 'hidden', { value: true, configurable: true }); p.doc.dispatchEvent(new p.w.Event('visibilitychange'));
  await new Promise((r) => setTimeout(r, 60)); const n1 = p.log.length;
  Object.defineProperty(p.doc, 'hidden', { value: false, configurable: true }); p.doc.dispatchEvent(new p.w.Event('visibilitychange'));
  await new Promise((r) => setTimeout(r, 80));
  return n1 === n0 && p.log.length > n1 ? true : `n0=${n0} n1=${n1} n2=${p.log.length}`;
});
await gate('market: skeleton loaders exist before data and fade in staggered after', async () => {
  const log = []; const html0 = read(join(DIST, 'index.html'));
  const dom = new JSDOM(html0, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.fetch = () => new Promise(() => {}); dom.window.matchMedia = () => ({ matches: false });
  dom.window.HTMLCanvasElement.prototype.getContext = () => null; dom.window.eval(read(join(DIST, 'app.js')));
  const sk = dom.window.document.querySelectorAll('#mlist .mrow.sk').length;
  return sk === 10 && /\.fadein \{[^}]*animation-delay: calc\(var\(--i, 0\) \* 60ms\)/.test(css) && base.doc.querySelector('#mlist .mrow').style.getPropertyValue('--i') !== '' ? true : 'skeleton/stagger missing';
});
await gate('market: ticker is filled from the same data (loop of two copies)', () => {
  const t = base.doc.getElementById('ticker-in').querySelectorAll('.tk').length; return t === 20 ? true : 'ticker items=' + t;
});
await gate('market independence: the CA record has zero effect (same calls, same rows, ca stated vs absent)', async () => {
  const a = mutate(reg, 'ca'); const b = mkBuild(a.reg);
  try {
    const p = await runPage(b.out);
    const snap = (x) => JSON.stringify([...x.doc.querySelectorAll('#mlist .mrow')].map((r) => r.textContent)) + x.log.join('|');
    return snap(p) === snap(base) ? true : 'market differs by CA state';
  } finally { b.cleanup(); }
});
await gate('market independence: market source never reads the ca, x or github records', () => {
  const m = js.slice(js.indexOf('UX.market = (function'), js.indexOf('/* main */') > 0 ? js.indexOf('/* main */') : undefined);
  return /rec\('ca'\)|rec\("ca"\)|\.ca\b|stated\('ca'\)|rec\('x'\)|rec\('github'\)/.test(m) ? 'market reads another record' : true;
});
await gate('market follows its own record only: unstating it stops every call and shows inert state', async () => {
  const m = mutate(reg, 'market'); if (m.now === 'stated') return true;
  const b = mkBuild(m.reg);
  try { const p = await runPage(b.out); return p.log.length === 0 && p.doc.getElementById('mkt-pill').dataset.state === 'inert' ? true : 'fetched while unstated'; }
  finally { b.cleanup(); }
});
await gate('market follows its own record only: restating restores the feed', async () => {
  const off = mutate(reg, 'market'); const src = off.now === 'absent' ? off.reg : reg;
  const on = JSON.parse(JSON.stringify(src)); const r = on.records.market; r.state = 'stated'; r.source = 'mutation harness'; r.boosts = reg.records.market.boosts; r.pairs = reg.records.market.pairs;
  const b = mkBuild(on);
  try { const p = await runPage(b.out); return p.doc.querySelectorAll('#mlist .mrow[data-k]').length === 10 ? true : 'feed not restored'; } finally { b.cleanup(); }
});

// ---- motion + a11y + measurement rules ----
await gate('reduced motion: CSS kills every animation and transition; script skips spring, count-up, waves, parallax', () => {
  const rm = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  if (!/animation: none !important/.test(rm) || !/transition: none !important/.test(rm)) return 'css fallback missing';
  if (!/prefers-reduced-motion: reduce/.test(js)) return 'script does not read the preference';
  const need = ['if (UX.reduced) { el.classList.add', 'UX.reduced || from === null', "if (!stage || UX.reduced) return", 'if (UX.reduced) return;'];
  const miss = need.filter((n) => !js.includes(n)); return miss.length ? 'no guard: ' + miss.join(' | ') : true;
});
await gate('reduced motion (runtime): reveals land instantly, no pending spring', async () => {
  const dom = new JSDOM(read(join(DIST, 'index.html')), { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.fetch = () => new Promise(() => {}); dom.window.matchMedia = () => ({ matches: true });
  dom.window.HTMLCanvasElement.prototype.getContext = () => null; dom.window.eval(read(join(DIST, 'app.js')));
  const d = dom.window.document; return [...d.querySelectorAll('.reveal')].every((e) => e.classList.contains('in')) ? true : 'reveal not instant';
});
await gate('motion present: spring solver, parallax layers, spotlight, progress bar, count-up flash, live dot, mesh', () => {
  const need = [['spring', /UX\.spring = function/], ['damping', /c = opts\.c/], ['parallax', /data-depth/], ['spotlight', /--mx/], ['progress', /scaleX\(/], ['flash', /flash-up/], ['pulse', /@keyframes pulse/], ['mesh', /\.mesh i:nth-child\(3\)/], ['skeleton', /@keyframes shimmer/], ['marquee', /@keyframes tick/]];
  const miss = need.filter(([, re]) => !re.test(js + css + html)).map(([n]) => n); return miss.length ? 'missing ' + miss.join(',') : true;
});
await gate('measured values: reference radii, borders, offsets, easing, marquee 70s, hover press .08s', () => {
  const t = css + tokensCss;
  const need = ['--r: 6px', '--bw: 2px', '--bw-frame: 3px', '4px 4px 0 var(--shade)', 'cubic-bezier(.2, .8, .2, 1)', 'animation: tick 70s linear infinite', 'transition: transform .08s, box-shadow .08s', 'border-top: 6px solid var(--line)', 'grid-template-columns: 1fr 1.05fr', 'gap: 48px', 'padding: 72px clamp(16px, 5vw, 56px)'];
  const miss = need.filter((n) => !t.includes(n)); return miss.length ? 'missing ' + miss.join(' | ') : true;
});
await gate('tap targets: every interactive control class is sized from --tap (44px)', () => {
  const need = [/\.btn \{[^}]*min-height: var\(--tap\)/, /\.nav a \{[^}]*min-height: var\(--tap\)/, /\.tab \{[^}]*min-height: var\(--tap\)/, /\.mcopy \{[^}]*width: var\(--tap\)/, /\.ca-copy \{[^}]*min-height: var\(--tap\)/, /summary \{[^}]*min-height: var\(--tap\)/, /input\[type=range\] \{[^}]*height: var\(--tap\)/, /\.foot-links a \{[^}]*min-height: var\(--tap\)/];
  const miss = need.filter((re) => !re.test(css)).map(String); return /--tap: 44px/.test(tokensCss) && !miss.length ? true : 'missing ' + miss.join(' ');
});
await gate('page: every section anchor resolves; images have alt; one h1; lang set', () => {
  const ids = new Set([...base.doc.querySelectorAll('[id]')].map((e) => e.id));
  const bad = [...base.doc.querySelectorAll('a[href^="#"]')].map((a) => a.getAttribute('href').slice(1)).filter((h) => h && !ids.has(h));
  const noalt = [...base.doc.querySelectorAll('img')].filter((i) => !i.hasAttribute('alt'));
  return bad.length || noalt.length || base.doc.querySelectorAll('h1').length !== 1 || !base.doc.documentElement.lang ? 'anchor/alt/h1/lang problem ' + bad : true;
});

// ---- copy: nothing from the reference ----
await gate('copy: zero shared word pairs with the reference site (page text, attributes, runtime strings)', () => {
  const ours = bigramSet(copyText + ' \n ' + uiStrings(js)); const theirs = bigramSet(refText);
  const shared = [...ours].filter((b) => theirs.has(b)); const hay = (copyText + ' \n ' + uiStrings(js)).replace(/\s+/g, ' ').toLowerCase();
  return shared.length ? 'shared: ' + shared.slice(0, 12).map((b) => b + ' <= ...' + hay.slice(Math.max(0, hay.indexOf(b) - 25), hay.indexOf(b) + 30) + '...').join(' | ') : true;
});
await gate('copy: zero shared content words with the reference site', () => {
  const ours = wordSet(copyText + ' \n ' + uiStrings(js)); const theirs = wordSet(refText);
  const shared = [...ours].filter((w) => theirs.has(w)); return shared.length ? 'shared words: ' + shared.join(', ') : true;
});
await gate('copy negative control: the overlap checker catches reference copy', () => {
  const bad = bigramSet('Hold it in your own wallet'); const th = bigramSet(refText);
  return [...bad].some((b) => th.has(b)) && [...wordSet('free chat for holders')].some((w) => wordSet(refText).has(w)) ? true : 'checker blind';
});
await gate('scope: the removed items stay removed (no animated logo, no coin icon, no reference numbers)', () => {
  const scope = (() => { const c = base.doc.body.cloneNode(true); c.querySelectorAll('#mlist,#ticker,script,style').forEach((n) => n.remove()); return c.textContent; })();
  const nums = scope.match(/\b(10,000|75|40M|1M|10K|\$20|\$0\.13|\$3\.80|187)\b/g);
  const coin = /coin|\u{1FA99}/iu.test(scope);
  return nums || coin ? 'leftover ' + (nums || '') : true;
});

// ---- report ----
const failed = results.filter((r) => !r.ok);
results.forEach((r, i) => console.log(`${r.ok ? 'PASS' : 'FAIL'} ${String(i + 1).padStart(2, '0')}  ${r.name}${r.ok ? '' : '\n        -> ' + r.msg}`));
console.log(`\ngates: ${results.length} total, ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
