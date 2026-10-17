// Live v2 on a native (Hermes UI gateway) agent: a send through the facade is numbered and marked delivered from Hermes's
// acknowledgement, the turn shows as typing, the finished reply arrives as message.new and the user's message as read (0.4.0).
import test from 'node:test';
import assert from 'node:assert/strict';
import { waitFor } from './machine-helpers.js';
import { setup } from './ui-helpers.js';
import { sse } from './live2-helpers.js';

test('native agent: message.new (user, delivered), typing, reply as message.new, status read, unread on the chat row', async (t) => {
  const x = await setup(t);
  const api = async (route, data) => { const r = await fetch(x.base + route, { method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  await waitFor(async () => { const a = (await api('/api/agents')).body.agents ?? []; return a.length && a[0].capabilities?.nativeUi ? a : null; });
  const s = sse(t, `${x.base}/api/live/stream?v=2`); await s.wait((f) => f.event === 'foxfleet.ready');
  const r = await api('/api/agents/default/messages', { messages: [{ role: 'user', content: 'hello native' }] }); assert.equal(r.status, 202, JSON.stringify(r.body));
  const chat = r.body.session_id; assert.ok(chat);
  const mine = await s.wait((f) => f.event === 'message.new' && f.data.message.role === 'user', 15_000);
  assert.equal(mine.data.chat, chat); assert.equal(mine.data.message.n, 1); assert.equal(mine.data.message.text, 'hello native'); assert.equal(mine.data.message.status, 'delivered'); assert.equal(mine.data.message.source, 'web');
  await s.wait((f) => f.event === 'typing' && f.data.chat === chat && f.data.state === 'typing', 15_000);
  const reply = await s.wait((f) => f.event === 'message.new' && f.data.message.role === 'assistant', 15_000);
  assert.equal(reply.data.chat, chat); assert.equal(reply.data.message.n, 2); assert.ok(reply.data.message.text.length > 0); assert.equal(reply.data.message.source, 'agent');
  const read = await s.wait((f) => f.event === 'message.status' && f.data.status === 'read', 15_000); assert.deepEqual(read.data.hub_ids, [mine.data.message.hub_id]);
  await s.wait((f) => f.event === 'run.finished' && f.data.chat === chat, 15_000);
  const row = (await api('/api/chats/default')).body; assert.equal(row.chat, chat); assert.equal(row.unread_count, 1); assert.equal(row.last_message.hub_id, reply.data.message.hub_id);
});
