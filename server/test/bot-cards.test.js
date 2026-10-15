// Approval / clarify cards. A tap resolves only that request, chat and account. Stale, forged and replayed choices are refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootBot, sseReader, member, addBot } from './bot-helpers.js';

const V11 = { headers: { 'Sec-WebSocket-Protocol': 'foxfleet.bot.v1.1, foxfleet.bot.v1' } };
const userMessage = (text) => ({ messages: [{ role: 'user', content: text }] });

async function openRun(t, b, c) {
  const res = await b.h.call('/api/agents/helper/chat', { data: userMessage('hi') });
  assert.equal(res.status, 200);
  const s = sseReader(res);
  t.after(() => s.cancel());
  const ev = await c.next((x) => x.t === 'message.new');
  return { s, ev, chatId: ev.chat_id };
}

const approval = (chatId, extra = {}) => ({ t: 'card.send', id: 'c1', chat_id: chatId, kind: 'approval', instance: 'inst-1', command: 'rm -rf build', description: 'Remove the old build', ...extra });

test('a 1.0 socket still refuses card.send, and a 1.1 hello advertises cards', async (t) => {
  const b = await bootBot(t);
  const old = await b.connect();
  await old.next((x) => x.t === 'hello');
  const refused = await old.request({ t: 'card.send', id: 'r2', chat_id: 'fc_' + 'a'.repeat(16), kind: 'approval', instance: 'i', command: 'x' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'unsupported');
  const c = await b.connect(V11);
  const hello = await c.next((x) => x.t === 'hello');
  assert.deepEqual(hello.features, ['stop', 'cards', 'media']);
});

test('a tap resolves only that card, chat and account; forged, replayed and foreign taps do not', async (t) => {
  const b = await bootBot(t), c = await b.connect(V11);
  await c.next((x) => x.t === 'hello');
  const me = (await (await b.h.call('/api/auth')).json()).user;
  const { s, chatId } = await openRun(t, b, c);
  const sent = await c.request(approval(chatId));
  assert.equal(sent.ok, true);
  assert.match(sent.result.request_id, /^frq_[A-Za-z0-9_-]{16}$/);
  const card = await s.next((e) => e.event === 'foxfleet.request');
  assert.equal(card.data.kind, 'approval');
  assert.equal(card.data.request_id, sent.result.request_id);
  assert.equal(card.data.command, 'rm -rf build');
  const queued = await (await b.h.call(`/api/agents/helper/queue?session_id=${chatId}`)).json();
  assert.equal(queued.open_requests.length, 1);
  assert.equal(queued.open_requests[0].request_id, sent.result.request_id);

  const again = await c.request({ ...approval(chatId), id: 'c2', idempotency_key: 'same-card' });
  const replay = await c.request({ ...approval(chatId), id: 'c3', idempotency_key: 'same-card' });
  assert.equal(replay.replayed, true);
  assert.equal(replay.result.request_id, again.result.request_id);
  assert.equal(s.events.filter((e) => e.event === 'foxfleet.request' && e.data.request_id === again.result.request_id).length, 1);

  const forged = await b.h.call(`/api/agents/helper/native/sessions/${chatId}/requests/${sent.result.request_id}`, { data: { result: { choice: 'always' }, user: { id: 'forged', name: 'nope' } } });
  assert.equal(forged.status, 400);
  assert.equal(c.texts.some((x) => x.t === 'callback'), false, 'a forged choice sends no callback');
  const wrongChat = await b.h.call(`/api/agents/helper/native/sessions/${'fc_' + 'b'.repeat(16)}/requests/${sent.result.request_id}`, { data: { result: { choice: 'once' } } });
  assert.equal(wrongChat.status, 404);
  const alice = await member(b.h, 'alice');
  const other = await b.h.call(`/api/agents/helper/native/sessions/${chatId}/requests/${sent.result.request_id}`, { token: alice.token, data: { result: { choice: 'once' } } });
  assert.equal(other.status, 404);
  const otherBot = await addBot(t, b.h, 'other');
  const cross = await b.h.call(`/api/agents/other/native/sessions/${chatId}/requests/${sent.result.request_id}`, { data: { result: { choice: 'once' } } });
  assert.equal(cross.status, 404);
  assert.equal(otherBot.botId !== b.botId, true);

  const ok = await b.h.call(`/api/agents/helper/native/sessions/${chatId}/requests/${sent.result.request_id}`, { data: { result: { choice: 'once' }, user: { id: 'forged', name: 'nope' } } });
  assert.equal(ok.status, 200);
  const cb = await c.next((x) => x.t === 'callback');
  assert.equal('event_id' in cb, false);
  assert.equal(cb.request_id, sent.result.request_id);
  assert.equal(cb.kind, 'approval');
  assert.deepEqual(cb.value, { choice: 'once' });
  assert.deepEqual(cb.user, { id: me.id, name: me.username });
  assert.match(cb.callback_id, /^fcb_[A-Za-z0-9_-]{16}$/);
  const closed = await s.next((e) => e.event === 'foxfleet.request_closed');
  assert.equal(closed.data.request_id, sent.result.request_id);
  const second = await b.h.call(`/api/agents/helper/native/sessions/${chatId}/requests/${sent.result.request_id}`, { data: { result: { choice: 'deny' } } });
  assert.equal(second.status, 404);
  assert.equal(c.texts.filter((x) => x.t === 'callback').length, 1);

  const late = await c.request({ t: 'callback.answer', id: 'a1', callback_id: cb.callback_id, outcome: 'resolved' });
  assert.equal(late.ok, true);
  const reconnect = await b.connect(V11);
  await reconnect.next((x) => x.t === 'hello');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(reconnect.texts.some((x) => x.t === 'callback'), false, 'an answered callback is not replayed');
});

test('an unanswered callback is replayed on reconnect, and a stop id cannot answer it', async (t) => {
  const b = await bootBot(t), c = await b.connect(V11);
  await c.next((x) => x.t === 'hello');
  const { chatId } = await openRun(t, b, c);
  const sent = await c.request(approval(chatId, { id: 'hold' }));
  await b.h.call(`/api/agents/helper/native/sessions/${chatId}/requests/${sent.result.request_id}`, { data: { result: { choice: 'deny' } } });
  const cb = await c.next((x) => x.t === 'callback');
  c.socket.end();
  const again = await b.connect(V11);
  const replayed = await again.next((x) => x.t === 'callback');
  assert.equal(replayed.callback_id, cb.callback_id);
  const stolen = await again.request({ t: 'callback.answer', id: 'no', callback_id: 'fs_' + 'a'.repeat(16), outcome: 'stopped' });
  assert.equal(stolen.ok, false);
  assert.equal(stolen.error.code, 'not_found');
  const done = await again.request({ t: 'callback.answer', id: 'yes', callback_id: cb.callback_id, outcome: 'resolved' });
  assert.equal(done.ok, true);
});

test('confirm is an approval card on the wire to the web, and clarify only accepts its own answers', async (t) => {
  const b = await bootBot(t), c = await b.connect(V11);
  await c.next((x) => x.t === 'hello');
  const { s, chatId } = await openRun(t, b, c);
  const confirm = await c.request({ t: 'card.send', id: 'cf', chat_id: chatId, kind: 'confirm', instance: 'inst-1', description: 'Reload the servers?' });
  const shown = await s.next((e) => e.event === 'foxfleet.request' && e.data.request_id === confirm.result.request_id);
  assert.equal(shown.data.kind, 'approval');
  await b.h.call(`/api/agents/helper/native/sessions/${chatId}/requests/${confirm.result.request_id}`, { data: { result: { choice: 'deny' } } });
  const cb = await c.next((x) => x.t === 'callback' && x.request_id === confirm.result.request_id);
  assert.equal(cb.kind, 'confirm');
  assert.deepEqual(cb.value, { choice: 'deny' });

  const clarify = await c.request({ t: 'card.send', id: 'q', chat_id: chatId, kind: 'clarify', instance: 'inst-1', questions: [{ id: 'q0', question: 'Which environment?', choices: ['staging', 'production'], multi_select: false }] });
  const bad = await b.h.call(`/api/agents/helper/native/sessions/${chatId}/requests/${clarify.result.request_id}`, { data: { result: { choice: 'once' } } });
  assert.equal(bad.status, 400);
  const good = await b.h.call(`/api/agents/helper/native/sessions/${chatId}/requests/${clarify.result.request_id}`, { data: { result: { answers: { q0: 'staging' } } } });
  assert.equal(good.status, 200);
  const answered = await c.next((x) => x.t === 'callback' && x.request_id === clarify.result.request_id);
  assert.equal(answered.kind, 'clarify');
  assert.deepEqual(answered.value, { answers: { q0: 'staging' } });
});

test('a closed or expired card cannot be answered, and an open card holds the reply run open', async (t) => {
  const b = await bootBot(t, { botOptions: { replyIdleMs: 250 } }), c = await b.connect(V11);
  await c.next((x) => x.t === 'hello');
  const { s, chatId } = await openRun(t, b, c);
  const sent = await c.request(approval(chatId, { id: 'stay', ttl_ms: 5000 }));
  await c.request({ t: 'message.send', id: 'm1', chat_id: chatId, text: 'working' });
  await s.next((e) => e.event === 'foxfleet.request');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(s.ended, false, 'the run must not idle out under an open card');
  const closed = await c.request({ t: 'card.close', id: 'x', request_id: sent.result.request_id, reason: 'superseded' });
  assert.equal(closed.ok, true);
  assert.equal(closed.result.closed, 1);
  const gone = await b.h.call(`/api/agents/helper/native/sessions/${chatId}/requests/${sent.result.request_id}`, { data: { result: { choice: 'once' } } });
  assert.equal(gone.status, 404);
  await s.finished(1500);
  assert.equal(s.ended, true);

  const { chatId: chat2 } = await openRun(t, b, c);
  const short = await c.request(approval(chat2, { id: 'exp', ttl_ms: 5000 }));
  await new Promise((r) => setTimeout(r, 5200));
  const late = await b.h.call(`/api/agents/helper/native/sessions/${chat2}/requests/${short.result.request_id}`, { data: { result: { choice: 'once' } } });
  assert.equal(late.status, 404);
  assert.equal(c.texts.filter((x) => x.t === 'callback' && x.request_id === short.result.request_id).length, 0);
});
