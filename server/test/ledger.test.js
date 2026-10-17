// Chat ledger unit tests (0.4.0): numbering, unread and badge math, monotonic read and status, reconcile rules, idempotency TTL, persistence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chatLedger, hubIdOf, clipText } from '../ledger.js';

async function make(t, extra = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-ledger-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const events = [], mutes = new Set(), file = path.join(dir, 'chats.json');
  const L = await chatLedger(file, { hooks: { event: (type, f) => events.push({ type, ...f }), muted: (a) => mutes.has(a), known: (a) => a !== 'ghost' }, ...extra });
  t.after(() => L.close()); return { L, events, mutes, file };
}

test('ledger: unread counts agent messages after the read position; badge leaves out muted, archived and unknown agents', async (t) => {
  const { L, mutes } = await make(t);
  for (const a of ['a', 'b', 'c', 'ghost']) { L.reconcile(a, 's1', []); L.add(a, 's1', { role: 'assistant', text: 'one', source: 'agent' }); L.add(a, 's1', { role: 'assistant', text: 'two', source: 'agent' }); }
  L.reconcile('a', 's2', []); L.add('a', 's2', { role: 'assistant', text: 'other chat', source: 'agent' });
  assert.equal(L.agentUnread('a'), 3); assert.deepEqual(L.totals(), { total_unread: 7, total_unread_all: 7 }, 'ghost (removed agent) never counts');
  mutes.add('b'); L.setArchived('c', true); assert.deepEqual(L.totals(), { total_unread: 3, total_unread_all: 7 });
  const r = L.read('a', 's1', 1); assert.deepEqual(r.state, { chat: 's1', read_up_to: 1, unread_count: 1, agent_unread: 2, total_unread: 2 });
  assert.equal(L.read('a', 's1', 0).changed, false); assert.equal(L.readUpTo('a', 's1'), 1, 'never back');
  L.add('a', 's1', { role: 'user', text: 'mine', source: 'app', status: 'sent' }); assert.equal(L.readUpTo('a', 's1'), 3, 'sending reads up to my message'); assert.equal(L.agentUnread('a'), 1);
  L.add('c', 's1', { role: 'assistant', text: 'new', source: 'agent' }); assert.equal(L.agent('c').archived, false, 'unmuted archived chat comes back');
  L.setArchived('b', true); L.add('b', 's1', { role: 'assistant', text: 'new', source: 'agent' }); assert.equal(L.agent('b').archived, true, 'muted stays archived');
});

test('ledger: statuses only move forward; failed is final; readByAgent picks this run or messages delivered before it', async (t) => {
  const { L, events } = await make(t); L.reconcile('a', 's', []);
  const m1 = L.add('a', 's', { role: 'user', text: 'one', status: 'sent' }), m2 = L.add('a', 's', { role: 'user', text: 'two', status: 'sent' });
  L.setStatus('a', 's', (e) => e.n === m1.n, 'delivered', { runId: 'r1' }); L.setStatus('a', 's', (e) => e.n === m1.n, 'sent');
  assert.equal(L.messageAt('a', 's', m1.n, 'one').status, 'delivered');
  L.setStatus('a', 's', (e) => e.n === m2.n, 'failed', { error: 'nope' }); L.setStatus('a', 's', (e) => e.n === m2.n, 'read');
  assert.deepEqual([L.messageAt('a', 's', m2.n).status, L.messageAt('a', 's', m2.n).error], ['failed', 'nope']);
  assert.deepEqual(L.readByAgent('a', 's', { id: 'r2', started: 0 }), [], 'delivered for another run, after this one started');
  assert.deepEqual(L.readByAgent('a', 's', { id: 'r1', started: 0 }), [m1.n]);
  assert.deepEqual(events.filter((e) => e.type === 'message.status').map((e) => e.status), ['delivered', 'failed', 'read']);
});

test('ledger: reconcile numbers a new chat silently, binds hub messages to the agent ids, appends later ones as external, skips old unknowns', async (t) => {
  const { L, events } = await make(t);
  L.reconcile('a', 's', [{ id: '1', role: 'user', content: 'q' }, { id: '2', role: 'assistant', content: 'a' }]);
  assert.equal(events.filter((e) => e.type === 'message.new').length, 0); assert.equal(L.readUpTo('a', 's'), 2);
  const mine = L.add('a', 's', { role: 'user', text: 'hello there', source: 'app', status: 'sent' }), reply = L.add('a', 's', { role: 'assistant', text: 'hi!', source: 'agent' });
  events.length = 0;
  const r = L.reconcile('a', 's', [{ id: '0', role: 'user', content: 'older, unknown' }, { id: '1', role: 'user', content: 'q' }, { id: '2', role: 'assistant', content: 'a' }, { id: '3', role: 'user', content: 'hello there' }, { id: '4', role: 'assistant', content: 'hi! (edited)' }, { id: '5', role: 'user', content: 'from cli' }]);
  assert.deepEqual(r, { added: 1, bound: 2 });
  assert.deepEqual(events.map((e) => [e.type, e.message.n, e.message.upstream_id, e.message.source]), [['message.edited', mine.n, '3', 'app'], ['message.edited', reply.n, '4', 'agent'], ['message.new', 5, '5', 'external']]);
  const msgs = [{ id: '0' }, { id: '4' }, { id: '5' }]; assert.equal(L.annotate('a', 's', msgs), 1); assert.deepEqual(msgs.map((m) => m.n), [undefined, 4, 5]); assert.equal(msgs[1].hub_id, hubIdOf('a', 's', 4));
});

test('ledger: idempotency records expire after 24 h; state persists without message text; clipText cuts at 64 KB on a character boundary', async (t) => {
  let now = 1_000_000; const { L, file } = await make(t, { now: () => now });
  L.reconcile('a', 's', []); L.add('a', 's', { role: 'assistant', text: 'top secret reply text', source: 'agent' });
  L.idem.put('key-1', 'h', { ok: 1 }); assert.equal(L.idem.get('key-1').h, 'h'); now += 24 * 3600_000 + 1; assert.equal(L.idem.get('key-1'), null);
  await L.flush(); const raw = await readFile(file, 'utf8'); assert.ok(!raw.includes('top secret reply text') || raw.includes('"p":"top secret reply text"'), 'only the short preview is stored');
  const L2 = await chatLedger(file); t.after(() => L2.close()); assert.equal(L2.agentUnread('a'), 1); assert.equal(L2.lastN('a', 's'), 1);
  const big = 'é'.repeat(40_000), c = clipText(big); assert.equal(c.truncated, true); assert.ok(Buffer.byteLength(c.text) <= 65536); assert.ok(!c.text.endsWith('\uFFFD'));
  assert.deepEqual(clipText('short'), { text: 'short', truncated: false });
});
