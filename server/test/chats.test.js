// Chat list, unread / badge math, archive, mark unread, read receipts, message numbering and statuses, typing, external
// messages, delete-for-me, resume across a hub restart, the pull endpoint, and v1 compatibility (0.4.0, docs/LIVE-EVENTS.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hub, hermes, sse, until, sleep } from './live2-helpers.js';

const send = (call, agent, text, session = 'sess-1') => call(`/api/agents/${agent}/messages`, { messages: [{ role: 'user', content: text }], ...(session ? { session_id: session } : {}) });
/** A Hermes chat stream that thinks, runs a tool, writes, then waits for `release()` before it ends. */
function gatedChat() {
  let release; const gate = new Promise((r) => { release = r; }); const sessions = [];
  const apiRoute = async (req, res, route) => {
    if (route !== '/v1/chat/completions') return false;
    req.resume(); await new Promise((r) => req.on('end', r)); const sid = req.headers['x-hermes-session-id'] || 'sess-1'; sessions.push(sid);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Hermes-Session-Id': sid });
    res.write('data: {"choices":[{"delta":{"reasoning_content":"let me think"}}]}\n\n'); await sleep(30);
    res.write('event: hermes.tool.progress\ndata: {"tool":"web_search"}\n\n'); await sleep(30);
    res.write('data: {"choices":[{"delta":{"content":"hello "}}]}\n\n'); await gate;
    res.write('data: {"choices":[{"delta":{"content":"world"}}]}\n\n'); res.end('data: [DONE]\n\n'); return true;
  };
  return { apiRoute, release: () => release(), sessions };
}

test('send -> message.new (user: sent, delivered, read) -> typing -> reply as message.new -> unread -> read receipt; history gets n / hub_id / status', async (t) => {
  const g = gatedChat(); t.after(() => g.release());
  const { mock, opts } = await hermes(t, { apiRoute: g.apiRoute, messages: [{ id: 1, role: 'user', content: 'old question' }, { id: 2, role: 'assistant', content: 'old answer' }] });
  const { call, base } = await hub(t);
  assert.equal((await call('/api/connections', { ...mock.connection, name: 'atlas', label: 'Atlas' })).status, 201);
  const snap = await call('/api/chats'); assert.equal(snap.status, 200); assert.match(snap.body.cursor, /^[A-Za-z0-9_-]+:\d+$/);
  assert.equal(snap.body.chats.length, 1); assert.equal(snap.body.chats[0].agent, 'atlas'); assert.equal(snap.body.total_unread, 0);
  const s = sse(t, `${base}/api/live/stream?v=2&since=${encodeURIComponent(snap.body.cursor)}`); await s.wait((f) => f.event === 'foxfleet.ready');

  const r = await send(call, 'atlas', 'hi there'); assert.equal(r.status, 202, JSON.stringify(r.body));
  const mine = await s.wait((f) => f.event === 'message.new' && f.data.message.role === 'user');
  assert.equal(mine.data.agent, 'atlas'); assert.equal(mine.data.chat, 'sess-1');
  assert.deepEqual({ ...mine.data.message, at: 0, hub_id: 0 }, { hub_id: 0, upstream_id: null, n: 3, role: 'user', text: 'hi there', at: 0, source: 'web', status: 'sent', reply_to: null, edited_at: null, run_id: null }, 'numbered after the two messages already in the chat');
  assert.match(mine.data.message.hub_id, /^h[A-Za-z0-9_-]{12}\.3$/);
  const delivered = await s.wait((f) => f.event === 'message.status' && f.data.status === 'delivered'); assert.deepEqual(delivered.data.hub_ids, [mine.data.message.hub_id]);
  const started = await s.wait((f) => f.event === 'run.started'); assert.equal(started.data.chat, 'sess-1');
  await s.wait((f) => f.event === 'typing' && f.data.state === 'thinking');
  const tool = await s.wait((f) => f.event === 'typing' && f.data.state === 'tool'); assert.equal(tool.data.tool, 'web_search'); assert.equal(tool.data.ttl_ms, 6000); assert.equal(tool.id, null);
  await s.wait((f) => f.event === 'typing' && f.data.state === 'typing');
  const read = await s.wait((f) => f.event === 'message.status' && f.data.status === 'read'); assert.deepEqual(read.data.hub_ids, [mine.data.message.hub_id], 'the agent started answering: read');
  g.release();
  const reply = await s.wait((f) => f.event === 'message.new' && f.data.message.role === 'assistant');
  assert.equal(reply.data.message.text, 'hello world'); assert.equal(reply.data.message.n, 4); assert.equal(reply.data.message.source, 'agent'); assert.equal(reply.data.message.run_id, started.data.run_id);
  const fin = await s.wait((f) => f.event === 'run.finished'); assert.equal(fin.data.state, 'done'); assert.ok(reply.data.seq < fin.data.seq, 'the reply is in the cache before run.finished');
  await s.wait((f) => f.event === 'typing' && f.data.state === 'idle');
  const row = await s.wait((f) => f.event === 'chat.updated' && f.data.row.unread_count === 1);
  assert.equal(row.data.row.last_message.preview, 'hello world'); assert.equal(row.data.row.last_message.sender, 'Atlas'); assert.equal(row.data.row.working, false);
  const seqs = s.events().map((f) => f.data.seq); assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b)); assert.equal(new Set(seqs).size, seqs.length, 'no duplicate seq');

  const list = await call('/api/chats'); const r0 = list.body.chats[0];
  assert.equal(r0.unread_count, 1); assert.equal(list.body.total_unread, 1); assert.equal(list.body.total_unread_all, 1); assert.equal(r0.chat, 'sess-1'); assert.equal(r0.read_up_to, 3, 'sending read the chat up to my message');
  assert.equal(r0.last_message.hub_id, reply.data.message.hub_id); assert.equal(r0.archived, false); assert.equal(r0.muted, null); assert.equal(r0.manual_unread, false);
  assert.deepEqual((await call('/api/chats/atlas')).body, r0);

  opts.messages = [...opts.messages, { id: 3, role: 'user', content: 'hi there' }, { id: 4, role: 'assistant', content: 'hello world' }];
  const h = await call('/api/agents/atlas/sessions/sess-1/messages?limit=50'); assert.equal(h.status, 200);
  assert.deepEqual(h.body.messages.map((m) => [m.id, m.n, m.status ?? null]), [['1', 1, null], ['2', 2, null], ['3', 3, 'read'], ['4', 4, null]]);
  assert.equal(h.body.messages[3].hub_id, reply.data.message.hub_id, 'hub_id is stable between the stream and history');
  const bound = await s.wait((f) => f.event === 'message.edited' && f.data.message.n === 4); assert.equal(bound.data.message.upstream_id, '4');
  const after = await call('/api/agents/atlas/sessions/sess-1/messages?after_n=2&limit=1'); assert.deepEqual(after.body.messages.map((m) => m.n), [3]); assert.equal(after.body.has_more, true);
  assert.equal((await call('/api/agents/atlas/sessions/sess-1/messages?after_n=x')).status, 400);

  const rr = await call('/api/chats/atlas/read', { chat: 'sess-1', up_to: 99 });
  assert.deepEqual(rr.body, { chat: 'sess-1', read_up_to: 4, unread_count: 0, agent_unread: 0, total_unread: 0 }, 'clamped to the last message');
  const ev = await s.wait((f) => f.event === 'read' && f.data.read_up_to === 4); assert.equal(ev.data.total_unread, 0);
  const n = s.events('read').length; const back = await call('/api/chats/atlas/read', { chat: 'sess-1', up_to: 2 }); assert.equal(back.body.read_up_to, 4, 'never moves back');
  await sleep(50); assert.equal(s.events('read').length, n, 'no event when nothing moved');
  for (const bad of [{ chat: 'sess-1', up_to: 0 }, { chat: 'sess-1', up_to: 1.5 }, { chat: 'sess-1' }, {}]) { const x = await call('/api/chats/atlas/read', bad); assert.equal(x.status, 400); assert.equal(x.body.code, 'invalid_read_position'); }
  const nf = await call('/api/chats/nobody/read', { chat: 'sess-1', up_to: 1 }); assert.equal(nf.status, 404); assert.equal(nf.body.code, 'chat_not_found');
  assert.equal((await call('/api/chats/nobody')).body.code, 'chat_not_found');
});

test('archive: an unmuted archived chat comes back on a new agent message, a muted one stays; badge leaves out muted and archived; mark unread', async (t) => {
  const { mock } = await hermes(t, { messages: [] }); const { call, base } = await hub(t);
  await call('/api/connections', { ...mock.connection, name: 'atlas' }); await call('/api/connections', { ...mock.connection, name: 'bea' });
  const s = sse(t, `${base}/api/live/stream?v=2`); await s.wait((f) => f.event === 'foxfleet.ready');
  const finished = async (k) => until(() => s.events('run.finished').length >= k);
  const put = (p, b) => call(p, b, { method: 'PUT' });
  let a = await put('/api/chats/atlas/archive', { archived: true }); assert.equal(a.status, 200); assert.equal(a.body.archived, true);
  assert.deepEqual((await call('/api/chats')).body.chats.map((r) => r.agent), ['bea']); assert.deepEqual((await call('/api/chats?archived=1')).body.chats.map((r) => r.agent), ['atlas']);
  assert.equal((await put('/api/chats/atlas/archive', { archived: 'yes' })).status, 400);
  assert.equal((await send(call, 'atlas', 'one')).status, 202); await finished(1);
  let row = (await call('/api/chats/atlas')).body; assert.equal(row.archived, false, 'unmuted: back in the list'); assert.equal(row.unread_count, 1);
  let list = (await call('/api/chats')).body; assert.equal(list.total_unread, 1); assert.equal(list.chats[0].agent, 'atlas', 'newest message first');
  const mute = await put('/api/notify/mute', { agent: 'atlas', muted: true }); assert.equal(mute.status, 200);
  await s.wait((f) => f.event === 'chat.updated' && f.data.row.muted !== null);
  list = (await call('/api/chats')).body; assert.deepEqual(list.chats.find((r) => r.agent === 'atlas').muted, { until: null }); assert.equal(list.total_unread, 0, 'muted: not in the badge'); assert.equal(list.total_unread_all, 1);
  await put('/api/chats/atlas/archive', { archived: true });
  assert.equal((await send(call, 'atlas', 'two')).status, 202); await finished(2);
  row = (await call('/api/chats/atlas')).body; assert.equal(row.archived, true, 'muted: stays archived'); assert.equal(row.unread_count, 1, 'sending read the first reply, the second is unread');
  await put('/api/notify/mute', { agent: 'atlas', muted: false });
  list = (await call('/api/chats')).body; assert.equal(list.total_unread, 0, 'archived: not in the badge'); assert.equal(list.total_unread_all, 1);
  await put('/api/chats/atlas/archive', { archived: false }); assert.equal((await call('/api/chats')).body.total_unread, 1);
  const u = await put('/api/chats/bea/unread', { unread: true }); assert.equal(u.body.manual_unread, true); assert.equal(u.body.unread_count, 0);
  assert.equal((await put('/api/chats/bea/unread', {})).status, 400);
  const all = await call('/api/chats/bea/read', { all: true }); assert.equal(all.status, 200); assert.equal((await call('/api/chats/bea')).body.manual_unread, false, 'any read clears mark-unread');
  const ra = await call('/api/chats/atlas/read', { all: true }); assert.equal(ra.body.agent_unread, 0); assert.equal(ra.body.total_unread, 0);
  await call('/api/agents/atlas/pin', { pinned: true }, { method: 'PUT' }); await s.wait((f) => f.event === 'chat.updated' && f.data.row.pinned);
  assert.deepEqual((await call('/api/chats')).body.chats.map((r) => [r.agent, r.pin_order]), [['atlas', 0], ['bea', null]]);
  const del = await call('/api/connections/bea', undefined, { method: 'DELETE' }); assert.equal(del.status, 200);
  const gone = await s.wait((f) => f.event === 'chat.removed'); assert.equal(gone.data.agent, 'bea');
});

test('messages written elsewhere: a new session found on a chat-list read arrives as message.new (external) and is unread; history finds later ones', async (t) => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  const { mock, opts } = await hermes(t, { sessions: [{ id: 'ext-1', title: 'cli chat', started_at: future, last_active: future }], messages: [{ id: 'e1', role: 'user', content: 'from the terminal' }, { id: 'e2', role: 'assistant', content: 'terminal answer' }] });
  const { call, base } = await hub(t); await call('/api/connections', { ...mock.connection, name: 'atlas' });
  const s = sse(t, `${base}/api/live/stream?v=2`); await s.wait((f) => f.event === 'foxfleet.ready');
  await call('/api/chats');
  const got = await s.wait((f) => f.event === 'message.new' && f.data.message.role === 'assistant');
  assert.equal(got.data.chat, 'ext-1'); assert.equal(got.data.message.source, 'external'); assert.equal(got.data.message.upstream_id, 'e2'); assert.equal(got.data.message.text, 'terminal answer');
  await until(async () => (await call('/api/chats/atlas')).body.unread_count === 1);
  assert.equal((await call('/api/chats')).body.chats[0].chat, 'ext-1');
  opts.messages = [...opts.messages, { id: 'e3', role: 'user', content: 'and?' }, { id: 'e4', role: 'assistant', content: 'one more thing' }];
  const h = await call('/api/agents/atlas/sessions/ext-1/messages'); assert.deepEqual(h.body.messages.map((m) => m.n), [1, 2, 3, 4], JSON.stringify(h.body));
  const more = await s.wait((f) => f.event === 'message.new' && f.data.message.upstream_id === 'e4'); assert.equal(more.data.message.n, 4); assert.equal(more.data.message.source, 'external');
  assert.equal((await call('/api/chats/atlas')).body.unread_count, 2);
  // a chat opened for the first time is numbered silently: old history is not unread
  opts.messages = [{ id: 'o1', role: 'assistant', content: 'old' }];
  const old = await call('/api/agents/atlas/sessions/old-1/messages'); assert.equal(old.body.messages[0].n, 1); assert.equal((await call('/api/chats/atlas')).body.unread_count, 2);
});

test('delete for me: message.deleted (scope me), shown again: message.edited; hidden messages do not count as unread', async (t) => {
  const { mock, opts } = await hermes(t, { messages: [{ id: 'u1', role: 'user', content: 'q' }] }); const { call, base } = await hub(t);
  await call('/api/connections', { ...mock.connection, name: 'atlas' });
  await call('/api/agents/atlas/sessions/sess-1/messages'); // numbered silently
  const s = sse(t, `${base}/api/live/stream?v=2`); await s.wait((f) => f.event === 'foxfleet.ready');
  opts.messages = [...opts.messages, { id: 'a1', role: 'assistant', content: 'the answer' }];
  await call('/api/agents/atlas/sessions/sess-1/messages'); assert.equal((await call('/api/chats/atlas')).body.unread_count, 1);
  const hide = await call('/api/agents/atlas/sessions/sess-1/hidden', { message_id: 'a1' }, { method: 'PUT' }); assert.equal(hide.status, 200);
  const del = await s.wait((f) => f.event === 'message.deleted'); assert.equal(del.data.scope, 'me'); assert.equal(del.data.hub_ids.length, 1); assert.match(del.data.hub_ids[0], /\.2$/);
  assert.equal((await call('/api/chats/atlas')).body.unread_count, 0);
  await call('/api/agents/atlas/sessions/sess-1/hidden', { message_id: 'a1' }, { method: 'DELETE' });
  const back = await s.wait((f) => f.event === 'message.edited' && f.data.message.n === 2); assert.equal(back.data.message.text, 'the answer');
});

test('resume across a hub restart: same store, replay without gap or duplicates, seq keeps growing; pull endpoint (paging, 400, 410)', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-live2-')); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
  const { mock } = await hermes(t, { messages: [], sessions: [] });
  const one = await hub(t, { dir }); await one.call('/api/connections', { ...mock.connection, name: 'atlas' });
  const cursor = (await one.call('/api/chats')).body.cursor, store = cursor.split(':')[0];
  for (const v of [true, false, true]) await one.call('/api/chats/atlas/archive', { archived: v }, { method: 'PUT' });
  await sleep(30); const before = (await one.call(`/api/live/events?since=${cursor}`)).body; assert.equal(before.events.length, 3); assert.equal(before.has_more, false);
  await one.close();
  const two = await hub(t, { dir });
  const s = sse(t, `${two.base}/api/live/stream?v=2`, { 'Last-Event-ID': cursor }); const ready = await s.wait((f) => f.event === 'foxfleet.ready');
  assert.ok(!s.frames.some((f) => f.event === 'foxfleet.gap')); assert.equal(ready.data.store, store);
  assert.deepEqual(s.events().map((f) => f.data.seq), before.events.map((e) => e.seq), 'the same events, once each');
  assert.deepEqual(s.events().map((f) => f.data.row.archived), [true, false, true]);
  await two.call('/api/chats/atlas/archive', { archived: false }, { method: 'PUT' });
  const next = await s.wait((f) => f.data?.row?.archived === false && f.data.seq > before.events.at(-1).seq); assert.equal(next.data.seq, before.events.at(-1).seq + 1, 'clean restart: the counter continues exactly');
  const page = await two.call(`/api/live/events?since=${cursor}&limit=2`); assert.equal(page.body.events.length, 2); assert.equal(page.body.has_more, true); assert.equal(page.body.cursor, `${store}:${page.body.events[1].seq}`);
  const rest = await two.call(`/api/live/events?since=${page.body.cursor}`); assert.equal(rest.body.events.length, 2); assert.equal(rest.body.has_more, false); assert.equal(rest.body.cursor, `${store}:${next.data.seq}`);
  for (const bad of ['', 'nope', '12']) { const x = await two.call(`/api/live/events?since=${bad}`); assert.equal(x.status, 400); assert.equal(x.body.code, 'invalid_cursor'); }
  const gone = await two.call('/api/live/events?since=otherstore1:3'); assert.equal(gone.status, 410); assert.equal(gone.body.code, 'cursor_expired'); assert.equal(gone.body.cursor, `${store}:${next.data.seq}`);
  assert.equal((await two.call(`/api/live/events?since=${store}:99999`)).status, 410);
});

test('v1 stays byte-compatible: no v2 types, same frames and ids; v=1 is v1; other versions are 400; features advertised', async (t) => {
  const { mock } = await hermes(t, { messages: [] }); const { call, base } = await hub(t);
  await call('/api/connections', { ...mock.connection, name: 'atlas' });
  const feats = (await call('/api/auth')).body.hub.features; for (const f of ['live', 'live2', 'chats', 'readReceipts', 'notifyReply']) assert.ok(feats.includes(f), f);
  const v1 = sse(t, `${base}/api/live/stream`), v1b = sse(t, `${base}/api/live/stream?v=1`);
  const ready = await v1.wait((f) => f.event === 'foxfleet.ready'); await v1b.wait((f) => f.event === 'foxfleet.ready');
  assert.deepEqual(Object.keys(ready.data), ['contract', 'cursor', 'heartbeat_ms']); assert.equal(ready.data.contract, 'foxfleet.live/1'); assert.match(ready.data.cursor, /^[A-Za-z0-9_-]{8}:0$/);
  await call('/api/chats/atlas/archive', { archived: true }, { method: 'PUT' });
  assert.equal((await send(call, 'atlas', 'hello')).status, 202);
  await v1.wait((f) => f.event === 'live' && f.data.type === 'run_finished'); await v1b.wait((f) => f.event === 'live' && f.data.type === 'run_finished');
  for (const s of [v1, v1b]) {
    const data = s.frames.filter((f) => f.id); assert.deepEqual(data.map((f) => f.data.type), ['run_started', 'run_finished'], 'only v1 types');
    for (const f of data) { assert.equal(f.event, 'live'); assert.match(f.id, /^[A-Za-z0-9_-]{8}:\d+$/); assert.match(f.raw, /^id: \S+\nevent: live\ndata: \{"id":\d+,"type":"run_(started|finished)","agent":"atlas","chat":"sess-1","at":\d+,"run_id":"[^"]+"(,"state":"done")?\}$/); }
    assert.ok(!s.frames.some((f) => f.event === 'typing' || f.raw.includes('message.new')));
  }
  for (const v of ['3', '', 'two']) { const x = await call(`/api/live/stream?v=${v}`); assert.equal(x.status, 400); assert.equal(x.body.code, 'unsupported_version'); }
});
