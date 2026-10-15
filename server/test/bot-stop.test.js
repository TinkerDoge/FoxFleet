// User Stop on a native bot. foxfleet.bot/1 cannot interrupt; foxfleet.bot/1.1 sends one transient chat.stop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { bootBot, sseReader } from './bot-helpers.js';

const V11 = { headers: { 'Sec-WebSocket-Protocol': 'foxfleet.bot.v1.1, foxfleet.bot.v1' } };
const userMessage = (text) => ({ messages: [{ role: 'user', content: text }] });
const storeFile = (b) => path.join(b.h.dir, 'bot', `${b.botId}.json`);

async function openRun(t, b, c) {
  const res = await b.h.call('/api/agents/helper/chat', { data: userMessage('hi') });
  assert.equal(res.status, 200);
  const s = sseReader(res);
  t.after(() => s.cancel());
  const ev = await c.next((x) => x.t === 'message.new');
  return { s, ev, runId: res.headers.get('x-foxfleet-run'), chatId: ev.chat_id };
}

test('a 1.1 hello advertises stop and cards and the higher subprotocol is echoed', async (t) => {
  const b = await bootBot(t), c = await b.connect(V11);
  const hello = await c.next((x) => x.t === 'hello');
  assert.equal(c.headers['sec-websocket-protocol'], 'foxfleet.bot.v1.1');
  assert.equal(hello.protocol, 'foxfleet.bot/1.1');
  assert.deepEqual(hello.features, ['stop', 'cards']);
  assert.equal(hello.bot, b.botId);
  assert.equal('event_id' in hello, false);
});

test('a 1.0 stop does not end the run and sends no chat.stop', async (t) => {
  const b = await bootBot(t), c = await b.connect();
  await c.next((x) => x.t === 'hello');
  const { runId } = await openRun(t, b, c);
  const stop = await (await b.h.call(`/api/agents/helper/runs/${runId}/stop`, { data: {} })).json();
  assert.equal(stop.confirmed, false);
  assert.equal(stop.run.state, 'running');
  assert.equal(c.texts.some((x) => x.t === 'chat.stop'), false);
  const again = await b.connect(V11);
  const replay = await again.next((x) => x.t === 'hello');
  assert.equal(replay.protocol, 'foxfleet.bot/1.1');
  assert.equal(again.texts.some((x) => x.t === 'chat.stop'), false, 'a stop is never replayed');
});

test('stopped or idle ends the view; refused, expired, unknown and a late answer do not', async (t) => {
  const b = await bootBot(t, { botOptions: { stopMs: 400 } }), c = await b.connect(V11);
  await c.next((x) => x.t === 'hello');
  const me = (await (await b.h.call('/api/auth')).json()).user;
  const { s, ev, runId, chatId } = await openRun(t, b, c);
  const pending = b.h.call(`/api/agents/helper/runs/${runId}/stop`, { data: {} });
  const frame = await c.next((x) => x.t === 'chat.stop');
  assert.equal('event_id' in frame, false);
  assert.equal(frame.chat_id, chatId);
  assert.deepEqual(frame.user, { id: me.id, name: me.username });
  assert.match(frame.stop_id, /^fs_[A-Za-z0-9_-]{16}$/);
  assert.ok(frame.expires_at > frame.date);
  const stored = JSON.parse(await readFile(storeFile(b), 'utf8'));
  assert.equal(stored.events.some((e) => e.t === 'chat.stop'), false, 'chat.stop is not a stored event');

  const foreign = await c.request({ t: 'callback.answer', id: 'nope', callback_id: 'fs_' + 'a'.repeat(16), outcome: 'stopped' });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.error.code, 'not_found');
  assert.equal(c.texts.filter((x) => x.t === 'chat.stop').length, 1, 'a forged answer does not send another stop');

  const joined = b.h.call(`/api/agents/helper/runs/${runId}/stop`, { data: {} });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(c.texts.filter((x) => x.t === 'chat.stop').length, 1, 'a second tap joins the outstanding stop');

  const refused = await c.request({ t: 'callback.answer', id: 'r1', callback_id: frame.stop_id, outcome: 'refused' });
  assert.equal(refused.ok, true);
  const first = await (await pending).json();
  const second = await (await joined).json();
  assert.equal(first.confirmed, false);
  assert.equal(second.confirmed, false);
  assert.equal(first.run.state, 'running');
  const late = await c.request({ t: 'callback.answer', id: 'r2', callback_id: frame.stop_id, outcome: 'stopped' });
  assert.equal(late.ok, false);
  assert.equal(late.error.code, 'not_found');

  const again = b.h.call(`/api/agents/helper/runs/${runId}/stop`, { data: {} });
  const next = await c.next((x) => x.t === 'chat.stop' && x.stop_id !== frame.stop_id);
  await c.request({ t: 'callback.answer', id: 'r3', callback_id: next.stop_id, outcome: 'idle' });
  const idle = await (await again).json();
  assert.equal(idle.confirmed, true);
  assert.equal(idle.run.state, 'stopped');
  await s.finished(2000);
  assert.equal(s.events.at(-1).data.state, 'stopped');
  assert.equal(ev.chat_id, chatId);
});

test('a stop that is not answered expires and the run stays', async (t) => {
  const b = await bootBot(t, { botOptions: { stopMs: 200 } }), c = await b.connect(V11);
  await c.next((x) => x.t === 'hello');
  const { runId } = await openRun(t, b, c);
  const stop = await (await b.h.call(`/api/agents/helper/runs/${runId}/stop`, { data: {} })).json();
  assert.equal(stop.confirmed, false);
  assert.equal(stop.run.state, 'running');
});

test('a 1.0 socket still refuses callback.answer as reserved', async (t) => {
  const b = await bootBot(t), c = await b.connect();
  await c.next((x) => x.t === 'hello');
  const res = await c.request({ t: 'callback.answer', id: 'r1', callback_id: 'fs_' + 'a'.repeat(16), outcome: 'stopped' });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'unsupported');
});

test('dropping the socket while a stop is outstanding does not confirm it', async (t) => {
  const b = await bootBot(t), c = await b.connect(V11);
  await c.next((x) => x.t === 'hello');
  const { runId } = await openRun(t, b, c);
  const pending = b.h.call(`/api/agents/helper/runs/${runId}/stop`, { data: {} });
  await c.next((x) => x.t === 'chat.stop');
  c.end();
  const stop = await (await pending).json();
  assert.equal(stop.confirmed, false);
  assert.equal(stop.run.state, 'running');
});
