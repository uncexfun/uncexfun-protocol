// Build: src/ -> dist/. No dependencies. Usage: node scripts/build.mjs [--out dir] [--register file]
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function build({ out = join(ROOT, 'dist'), register = join(ROOT, 'src', 'register.json') } = {}) {
  const src = join(ROOT, 'src');
  mkdirSync(out, { recursive: true });
  // empty the folder instead of deleting it (a running static server may hold the directory open)
  for (const f of readdirSync(out)) rmSync(join(out, f), { recursive: true, force: true });
  for (const f of ['tokens.css', 'styles.css', 'favicon.svg']) cpSync(join(src, f), join(out, f));
  cpSync(join(src, 'fonts'), join(out, 'fonts'), { recursive: true });
  cpSync(join(src, 'assets'), join(out, 'assets'), { recursive: true });

  const reg = JSON.parse(readFileSync(register, 'utf8'));
  writeFileSync(join(out, 'register.json'), JSON.stringify(reg, null, 2) + '\n');
  // the page copy of the register carries no dates: they stay in register.json as data only
  const lean = JSON.parse(JSON.stringify(reg));
  for (const r of Object.values(lean.records)) delete r.checked;

  const js = readdirSync(join(src, 'js')).filter((f) => f.endsWith('.js')).sort()
    .map((f) => readFileSync(join(src, 'js', f), 'utf8')).join('\n');
  writeFileSync(join(out, 'app.js'), '(function () {\n"use strict";\n' + js + '\n})();\n');

  const safe = JSON.stringify(lean).replace(/</g, '\u003c');
  const html = readFileSync(join(src, 'index.html'), 'utf8').replace('/*REGISTER*/', () => safe);
  writeFileSync(join(out, 'index.html'), html);

  writeFileSync(join(out, '_headers'), [
    '/*', '  X-Content-Type-Options: nosniff', '  Referrer-Policy: strict-origin-when-cross-origin', '',
    '/fonts/*', '  Cache-Control: public, max-age=31536000, immutable', '',
    '/assets/*', '  Cache-Control: public, max-age=31536000, immutable', ''
  ].join('\n'));
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k) => (a.includes(k) ? resolve(a[a.indexOf(k) + 1]) : undefined);
  const out = build({ out: opt('--out'), register: opt('--register') });
  console.log('built ->', out, existsSync(join(out, 'index.html')) ? 'ok' : 'MISSING');
}
