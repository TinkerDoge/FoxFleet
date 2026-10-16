// GET /api/agents must not wait for a hung agent on every poll: probe results are cached ~10 s, probes are shared, a probe gives
// up after ~2.5 s, and once an agent has a result the list waits at most ~1.5 s, then answers with it marked stale.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mockHermes } from './fixtures.js';
import { createHub } from '../index.js';

async function fleet(t, hubOptions = {}) {
  const gate = { slow: false };
  const fast = await mockHermes(t), hung = await mockHermes(t, { beforeDashboardResponse: (req, u) => (gate.slow && u.pathname === '/api/sessions' ? new Promise((r) => setTimeout(r, 6000)) : null) });
  fast.connection.name = fast.connection.label = 'fast'; hung.connection.name = hung.connection.label = 'hung';
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-probe-')), configPath = path.join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ machines: [fast.connection, hung.connection] }));
  const server = await createHub({ configPath, singleUser: true, ...hubOptions }); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); });
  const list = async () => { const t0 = performance.now(), r = await fetch(`http://127.0.0.1:${server.address().port}/api/agents`); assert.equal(r.status, 200); const agents = (await r.json()).agents; return { ms: performance.now() - t0, agents, by: (n) => agents.find((a) => a.name === n) }; };
  const calls = () => hung.requests.filter((q) => q.path === '/api/sessions' && q.query.get('limit') === '1' && !q.query.has('order')).length; // the probe's management check (not the activity seed)
  return { gate, list, calls };
}

test('agent list: shared probes; a slow agent is answered from its last result within ~1.5 s, marked stale', { timeout: 30_000 }, async (t) => {
  const { gate, list, calls } = await fleet(t, { probeTtlMs: 0 });
  const first = await list(); assert.deepEqual(first.agents.map((a) => a.name).sort(), ['fast', 'hung']);
  assert.equal(first.by('hung').managementReady, true); assert.equal(first.by('hung').stale, false); assert.ok(Number.isInteger(first.by('hung').checked_at));
  gate.slow = true; const before = calls();
  const [a, b] = await Promise.all([list(), list()]);
  assert.ok(a.ms < 3000 && b.ms < 3000, `capped wait (${a.ms.toFixed(0)} / ${b.ms.toFixed(0)} ms)`);
  assert.equal(a.by('hung').managementReady, true, 'last known result'); assert.equal(a.by('hung').stale, true); assert.equal(a.by('hung').checked_at, first.by('hung').checked_at);
  assert.equal(a.by('fast').stale, false);
  assert.equal(calls() - before, 1, 'two concurrent lists share one probe');
});

test('agent list: a probe gives up after ~2.5 s (was 5 s)', { timeout: 30_000 }, async (t) => {
  const { gate, list } = await fleet(t, { probeTtlMs: 0 }); gate.slow = true;
  const r = await list();
  assert.ok(r.ms > 2000 && r.ms < 4000, `probe timeout (${r.ms.toFixed(0)} ms)`); assert.equal(r.by('hung').managementReady, false); assert.equal(r.by('hung').stale, false);
});

test('agent list: results younger than ~10 s are reused without probing again', { timeout: 30_000 }, async (t) => {
  const { list, calls } = await fleet(t);
  const first = await list(), before = calls(), again = await list();
  assert.equal(calls(), before, 'no new probe inside the cache window');
  assert.equal(again.by('hung').checked_at, first.by('hung').checked_at); assert.equal(again.by('hung').stale, false);
});
