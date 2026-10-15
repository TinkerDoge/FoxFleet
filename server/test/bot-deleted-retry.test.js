import test from 'node:test';
import assert from 'node:assert/strict';
import { bootBot } from './bot-helpers.js';

for (const endpoint of ['messages', 'chat']) test(`retry after chat deletion: /${endpoint} refuses retained client_id without a phantom run`, async (t) => {
  const b = await bootBot(t), body = { messages: [{ role: 'user', content: 'once' }], client_id: 'delete-retry-1' };
  const first = await (await b.h.call('/api/agents/helper/messages', { data: body })).json();
  assert.equal((await b.h.call(`/api/agents/helper/sessions/${first.session_id}`, { method: 'DELETE' })).status, 200);
  const runs = async () => (await (await b.h.call('/api/agents/helper/runs')).json()).runs;
  const before = await runs();
  const res = await b.h.call(`/api/agents/helper/${endpoint}`, { data: body });
  const status = res.status; await res.body.cancel();
  assert.equal(status, 404);
  assert.deepEqual(await runs(), before, 'no phantom run opened');
  assert.deepEqual((await (await b.h.call('/api/agents/helper/sessions')).json()).sessions, []);
});
