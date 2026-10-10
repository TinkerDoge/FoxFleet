// A hung test must fail fast in CI instead of holding the job for hours (server job hung ~18 min on Node 22).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = new URL('../../', import.meta.url);
test('npm test runs the count guard, which keeps a per-test timeout and no force-exit', () => {
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).scripts;
  assert.equal(pkg.test, 'node scripts/check-hub-tests.mjs');
  const guard = readFileSync(new URL('scripts/check-hub-tests.mjs', root), 'utf8');
  assert.match(guard, /--test-timeout=\d+/); assert.doesNotMatch(guard, /spawn\([^)]*--test-force-exit/);
  assert.match(pkg['test:raw'], /--test-timeout=\d+/);
  assert.ok(Number(readFileSync(new URL('scripts/hub-tests.min', root), 'utf8')) >= 280);
});
test('the server workflow job has a timeout', () => {
  assert.match(readFileSync(new URL('.github/workflows/server.yml', root), 'utf8'), /timeout-minutes:\s*\d+/);
});

// The roadmap's "released" version cannot go stale: it must equal the newest CHANGELOG entry not marked "(unreleased)", and a tag push must agree with package.json.
test('roadmap releasedVersion follows the CHANGELOG, and the release workflow gates on it', async () => {
  const { latestReleased } = await import('../../site/.vitepress/roadmap.mjs');
  assert.equal(latestReleased('## Unreleased\n\n## 0.4.0-alpha (unreleased, vc 13)\n## 0.3.3-alpha (vc 11)\n## 0.3.2-alpha\n'), '0.3.3-alpha');
  assert.equal(latestReleased('## 0.5.0 (not tagged)\n## 0.4.0\n'), '0.4.0');
  const html = readFileSync(new URL('docs/roadmap.html', root), 'utf8'), log = readFileSync(new URL('CHANGELOG.md', root), 'utf8');
  assert.equal(JSON.parse(html.match(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/)[1]).releasedVersion, latestReleased(log));
  assert.match(readFileSync(new URL('.github/workflows/release.yml', root), 'utf8'), /check-release\.mjs "\$GITHUB_REF_NAME"/);
});
