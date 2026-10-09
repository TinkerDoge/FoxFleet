// A hung test must fail fast in CI instead of holding the job for hours (server job hung ~18 min on Node 22).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = new URL('../../', import.meta.url);
test('npm test has a per-test timeout and force-exits after the last test', () => {
  const script = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).scripts.test;
  assert.match(script, /--test-timeout=\d+/); assert.match(script, /--test-force-exit/);
});
test('the server workflow job has a timeout', () => {
  assert.match(readFileSync(new URL('.github/workflows/server.yml', root), 'utf8'), /timeout-minutes:\s*\d+/);
});
