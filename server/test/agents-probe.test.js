// GET /api/agents must not wait for a hung agent on every poll: probes are shared and, once an agent has a result, capped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mockHermes } from './fixtures.js';
import { createHub } from '../index.js';

test('agent list: a slow agent costs the full probe once, then at most ~1.5 s; probes are shared', { timeout: 30_000 }, async (t) => {
  let slow = false;
  const fast = await mockHermes(t), hung = await mockHermes(t, { beforeDashboardResponse: (req, u) => (slow && u.pathname === '/api/sessions' ? new Promise((r) => setTimeout(r, 6000)) : null) });
  fast.connection.name = fast.connection.label = 'fast'; hung.connection.name = hung.connection.label = 'hung';
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-probe-')), configPath = path.join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ machines: [fast.connection, hung.connection] }));
  const server = await createHub({ configPath, singleUser: true }); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); });
  const list = async () => { const t0 = performance.now(), r = await fetch(`http://127.0.0.1:${server.address().port}/api/agents`); assert.equal(r.status, 200); return { ms: performance.now() - t0, agents: (await r.json()).agents }; };
  const first = await list(); assert.deepEqual(first.agents.map((a) => a.name).sort(), ['fast', 'hung']); assert.equal(first.agents.find((a) => a.name === 'hung').managementReady, true);
  slow = true;
  const calls = () => hung.requests.filter((q) => q.path === '/api/sessions' && q.query.get('limit') === '1' && !q.query.has('order')).length, before = calls();
  const [a, b] = await Promise.all([list(), list()]);
  assert.ok(a.ms < 3000 && b.ms < 3000, `capped wait (${a.ms.toFixed(0)} / ${b.ms.toFixed(0)} ms)`);
  assert.equal(a.agents.find((x) => x.name === 'hung').managementReady, true, 'last known result while the probe is still running');
  assert.equal(calls() - before, 1, 'two concurrent lists share one probe');
});
