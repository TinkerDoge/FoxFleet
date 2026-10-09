// Static web app serving: SPA fallback, CSP, cache headers, traversal and missing-build behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function hubWithWeb(t, withBuild = true) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-web-'));
  const web = path.join(dir, 'dist');
  if (withBuild) {
    await mkdir(path.join(web, 'assets'), { recursive: true });
    await writeFile(path.join(web, 'index.html'), '<!doctype html><title>shell</title>');
    await writeFile(path.join(web, 'assets', 'index-AbCd1234.js'), 'console.log(1)');
    await writeFile(path.join(web, 'manifest.webmanifest'), '{}');
  }
  process.env.FOXFLEET_WEB_DIR = web;
  const { createHub } = await import(`../index.js?web=${Math.random()}`);
  const server = await createHub({ configPath: path.join(dir, 'config.json'), singleUser: true });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { delete process.env.FOXFLEET_WEB_DIR; server.closeAllConnections(); await new Promise((r) => server.close(r)); await rm(dir, { recursive: true, force: true }); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('shell: CSP, no-cache, SPA fallback for client routes', async (t) => {
  const base = await hubWithWeb(t);
  for (const route of ['/', '/agents', '/chat/some-id']) {
    const r = await fetch(base + route); assert.equal(r.status, 200, route); assert.match(await r.text(), /shell/);
    assert.equal(r.headers.get('cache-control'), 'no-cache');
    const csp = r.headers.get('content-security-policy'); assert.match(csp, /script-src 'self'(;|$)/); assert.match(csp, /frame-ancestors 'none'/); assert.ok(!/unsafe-inline'?\s*;?\s*(?=.*script)/.test(csp.split(';').find((d) => d.trim().startsWith('script-src'))));
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff'); assert.equal(r.headers.get('x-frame-options'), 'DENY');
  }
});

test('assets: hashed files are immutable, manifest revalidates, missing files and traversal are refused', async (t) => {
  const base = await hubWithWeb(t);
  const a = await fetch(base + '/assets/index-AbCd1234.js'); assert.equal(a.status, 200); assert.match(a.headers.get('cache-control'), /immutable/); assert.match(a.headers.get('content-type'), /javascript/);
  assert.equal((await fetch(base + '/manifest.webmanifest')).headers.get('cache-control'), 'no-cache');
  assert.equal((await fetch(base + '/assets/missing.js')).status, 404);
  assert.equal((await fetch(base + '/nope.png')).status, 404);
  assert.equal((await fetch(base + '/..%2f..%2fetc%2fpasswd')).status, 403);
  assert.match((await fetch(base + '/api/agents')).headers.get('content-type'), /json/, 'API routes are never shadowed by the SPA fallback'); assert.equal((await fetch(base + '/api/nope')).status, 404);
  assert.equal((await fetch(base + '/health')).status, 200);
});

test('without a build the hub explains instead of failing', async (t) => {
  const base = await hubWithWeb(t, false);
  const r = await fetch(base + '/'); assert.equal(r.status, 503); assert.match(await r.text(), /not built/);
  assert.equal((await fetch(base + '/health')).status, 200);
});
