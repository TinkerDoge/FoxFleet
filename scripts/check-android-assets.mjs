#!/usr/bin/env node
// Fails when the Android screen-takeover assets are missing: screen.html, screen.js and every file they import (the noVNC core).
//   node scripts/check-android-assets.mjs                  check android/app/src/main/assets
//   node scripts/check-android-assets.mjs --apk FILE.apk   also check the built APK (uses `unzip -l`)
// Background: a refactor once deleted these files unnoticed; the APK still built but screen takeover was dead.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'android/app/src/main/assets');
const problems = [];
const seen = new Set();
const IMPORT = /(?:import|export)\s*(?:[^'";]*?\sfrom\s*)?['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;

function visit(rel) {
  if (seen.has(rel)) return; seen.add(rel);
  const file = path.join(dir, rel);
  if (!fs.existsSync(file)) { problems.push(`missing asset: ${rel}`); return; }
  if (!/\.(m?js)$/.test(rel)) return;
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(IMPORT)) visit(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1] ?? m[2])));
}
visit('screen.html');
if (fs.existsSync(path.join(dir, 'screen.html'))) for (const m of fs.readFileSync(path.join(dir, 'screen.html'), 'utf8').matchAll(/(?:src|href)="([^":]+)"/g)) visit(m[1]);
visit('screen.js');
for (const need of ['novnc/core/rfb.js']) visit(need);
if (seen.size < 10) problems.push(`only ${seen.size} files reachable from screen.html/screen.js; the noVNC core is incomplete`);

const apkIdx = process.argv.indexOf('--apk');
if (apkIdx > 0) {
  const apk = process.argv[apkIdx + 1];
  const r = spawnSync('unzip', ['-Z1', apk], { encoding: 'utf8' });
  if (r.status !== 0) problems.push(`cannot list ${apk}: ${r.stderr.trim() || 'unzip failed'}`);
  else {
    const names = new Set(r.stdout.split('\n'));
    for (const rel of seen) if (!names.has(`assets/${rel}`)) problems.push(`not in the APK: assets/${rel}`);
    if (![...names].some((n) => n.startsWith('assets/novnc/'))) problems.push('APK has no assets/novnc/');
  }
}
if (problems.length) { console.error('Android asset check FAILED:\n  ' + problems.join('\n  ')); process.exit(1); }
console.log(`Android assets OK: ${seen.size} files reachable from screen.html/screen.js${apkIdx > 0 ? ' and all present in the APK' : ''}`);
