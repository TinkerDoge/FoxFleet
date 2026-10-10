#!/usr/bin/env node
// Runs the hub tests and fails when too few ran, any was cancelled/skipped-by-crash, or any failed.
// Guards against a hung or crashed test file silently dropping tests (a file that dies reports 1 failure at most).
// Raise MIN_TESTS in scripts/hub-tests.min whenever tests are added (npm run test:count prints the current total).
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const min = Number(readFileSync(path.join(root, 'scripts', 'hub-tests.min'), 'utf8').trim());
const files = readdirSync(path.join(root, 'server', 'test')).filter((f) => f.endsWith('.test.js')).map((f) => path.join('server', 'test', f));
// No --test-force-exit: every file must end by itself (open handles are bugs); --test-timeout still kills a hung test.
const p = spawn(process.execPath, ['--test', '--test-timeout=120000', ...files], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
let out = '';
p.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
p.on('exit', (code) => {
  const n = (k) => Number((out.match(new RegExp(`^(?:# |ℹ ) ?${k} (\\d+)`, 'm')) ?? [])[1] ?? NaN);
  const tests = n('tests'), pass = n('pass'), fail = n('fail'), cancelled = n('cancelled');
  console.log(`\nhub tests: ${tests} ran, ${pass} passed, ${fail} failed, ${cancelled} cancelled (minimum ${min})`);
  const bad = [];
  if (!(tests >= min)) bad.push(`only ${tests} tests ran, expected at least ${min}`);
  if (cancelled > 0) bad.push(`${cancelled} cancelled`);
  if (fail > 0 || code !== 0) bad.push(`failures (exit ${code})`);
  if (pass !== tests - (n('skipped') || 0) - (n('todo') || 0)) bad.push('pass count does not add up');
  if (bad.length) { console.error('FAIL: ' + bad.join('; ')); process.exit(1); }
});
