// Verifies the built site: every internal href/src (pages, assets, anchors) resolves, under the /FoxFleet/ base.
// External links are listed (not fetched) so the check works offline. Usage: node .vitepress/check-links.mjs
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = resolve(dirname(fileURLToPath(import.meta.url)), 'dist'), base = '/FoxFleet/';
const files = []; (function walk(d) { for (const e of readdirSync(d)) { const f = join(d, e); statSync(f).isDirectory() ? walk(f) : f.endsWith('.html') && files.push(f); } })(dist);
const ids = new Map(); const idsOf = (f) => ids.get(f) ?? ids.set(f, new Set([...readFileSync(f, 'utf8').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))).get(f);
const bad = [], ext = new Set(); let checked = 0;
for (const file of files) {
  const html = readFileSync(file, 'utf8');
  for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    let u = m[1].replace(/&amp;/g, '&');
    if (/^(mailto:|data:|javascript:)/.test(u)) continue;
    if (/^https?:\/\//.test(u)) { ext.add(u); continue; }
    const hash = u.includes('#') ? u.slice(u.indexOf('#') + 1) : '', p = u.split('#')[0].split('?')[0];
    let target = p ? (p.startsWith('/') ? p : join(dirname(file).slice(dist.length) || '/', p)) : file.slice(dist.length);
    if (p && p.startsWith('/') && !p.startsWith(base)) { bad.push(`${file.slice(dist.length)}: ${u} (outside base)`); continue; }
    if (target.startsWith(base)) target = '/' + target.slice(base.length);
    let f = join(dist, target); checked++;
    if (!existsSync(f) || statSync(f).isDirectory()) f = existsSync(f + '.html') ? f + '.html' : join(f, 'index.html');
    if (!existsSync(f)) { bad.push(`${file.slice(dist.length)}: ${u} -> missing`); continue; }
    if (hash && f.endsWith('.html') && !idsOf(f).has(decodeURIComponent(hash))) bad.push(`${file.slice(dist.length)}: ${u} -> missing anchor #${hash}`);
  }
}
// No third-party requests: no external script/link/img/iframe/source or CSS url() in the output.
for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(/<(script|link|img|iframe|source|video|audio)\b[^>]*\s(?:src|href)="(https?:\/\/[^"]+)"[^>]*>/g)) if (m[1] !== 'a') bad.push(`${f.slice(dist.length)}: external <${m[1]}> ${m[2]}`);
(function css(d) { for (const e of readdirSync(d)) { const f = join(d, e); if (statSync(f).isDirectory()) css(f); else if (/\.(css|js)$/.test(e) && /url\((['"]?)https?:\/\//.test(readFileSync(f, 'utf8'))) bad.push(`${f.slice(dist.length)}: external url()`); } })(dist);
console.log(`pages: ${files.length}, internal references checked: ${checked}, external (not fetched): ${ext.size}`);
if (process.env.LIST_EXTERNAL) console.log([...ext].sort().join('\n'));
if (bad.length) { console.log(bad.join('\n')); process.exit(1); }
console.log('no broken internal links');
