// The text loop: user -> hub -> bot, bot -> hub -> user, and the reply stream (flag on).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { bootBot } from './bot-helpers.js';

export const storeFile = (b) => path.join(b.h.dir, 'bot', `${b.botId}.json`);
export const readStore = async (b) => JSON.parse(await readFile(storeFile(b), 'utf8'));
const userMessage = (text, extra = {}) => ({ messages: [{ role: 'user', content: text }], ...extra });

test('a user message is written to disk with its event before the 202, then delivered to the connected bot', async (t) => {
  const b = await bootBot(t), c = await b.connect(); await c.next((x) => x.t === 'hello');
  const r = await b.h.call('/api/agents/helper/messages', { data: userMessage('hi', { client_id: 'client-0001' }) });
  assert.equal(r.status, 202);
  const onDisk = await readStore(b);
  const body = await r.json();
  assert.match(body.session_id, /^fc_[A-Za-z0-9_-]{16}$/);
  assert.match(body.message.id, /^fm_[A-Za-z0-9_-]{16}$/);
  assert.deepEqual({ ...body.message, id: undefined, created: undefined }, { id: undefined, state: 'queued', mode: 'queue', ack: 'queued', text: 'hi', created: undefined, session_id: body.session_id });
  assert.ok(Number.isInteger(body.message.created)); assert.deepEqual(body.bot, { online: true });
  assert.equal(onDisk.events.length, 1, 'the event was already on disk');
  assert.equal(onDisk.messages[body.session_id][0].text, 'hi'); assert.equal(onDisk.events[0].message_id, body.message.id);
  const ev = await c.next((x) => x.t === 'message.new');
  const me = (await (await b.h.call('/api/auth')).json()).user;
  assert.deepEqual(ev, { t: 'message.new', event_id: 1, chat_id: body.session_id, chat_type: 'dm', message_id: body.message.id, user: { id: me.id, name: me.username }, text: 'hi', date: body.message.created });
});

test('bot message.send answers with ids, and the chat shows up in sessions and its transcript', async (t) => {
  const b = await bootBot(t), c = await b.connect(); await c.next((x) => x.t === 'hello');
  const sent = await (await b.h.call('/api/agents/helper/messages', { data: userMessage('hi') })).json();
  const ev = await c.next((x) => x.t === 'message.new');
  const res = await c.request({ t: 'message.send', id: 'r1', chat_id: ev.chat_id, text: 'hello **there**' });
  assert.equal(res.ok, true); assert.match(res.result.message_id, /^fm_[A-Za-z0-9_-]{16}$/); assert.equal(res.result.chat_id, sent.session_id); assert.ok(Number.isInteger(res.result.date));
  const list = await (await b.h.call('/api/agents/helper/sessions')).json();
  assert.equal(list.total, 1); assert.equal(list.sessions[0].id, sent.session_id); assert.equal(list.sessions[0].messages, 2); assert.equal(list.sessions[0].preview, 'hello **there**');
  const page = await (await b.h.call(`/api/agents/helper/sessions/${sent.session_id}/messages`)).json();
  assert.deepEqual(page.messages.map((x) => [x.role, x.content]), [['user', 'hi'], ['assistant', 'hello **there**']]);
  assert.equal(page.messages[0].id, sent.message.id); assert.equal(page.messages[1].id, res.result.message_id); assert.ok(page.messages.every((x) => Number.isInteger(x.ts)));
  assert.equal(page.has_more, false);
  const q = await (await b.h.call('/api/agents/helper/sessions?q=THERE')).json(); assert.equal(q.total, 1);
  assert.equal((await (await b.h.call('/api/agents/helper/sessions?q=nothing')).json()).total, 0);
});

test('only the newest user message is used; images, empty text and oversized text are refused', async (t) => {
  const b = await bootBot(t), post = (data) => b.h.call('/api/agents/helper/messages', { data });
  const r = await post({ messages: [{ role: 'user', content: 'old question' }, { role: 'assistant', content: 'old answer' }, { role: 'user', content: [{ type: 'text', text: 'new ' }, { type: 'text', text: 'question' }] }, { role: 'assistant', content: 'ignored' }] });
  assert.equal(r.status, 202); assert.equal((await r.json()).message.text, 'new question');
  const image = await post({ messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }] });
  assert.equal(image.status, 400); assert.equal((await image.json()).code, 'unsupported');
  const file = await post({ messages: [{ role: 'user', content: [{ type: 'file', file: { filename: 'x.txt' } }] }] }); assert.equal(file.status, 400);
  assert.equal((await post({ messages: [{ role: 'user', content: '   ' }] })).status, 400);
  assert.equal((await post({ messages: [{ role: 'assistant', content: 'no user here' }] })).status, 400);
  assert.equal((await post({ messages: 'nope' })).status, 400);
  assert.equal((await post({ messages: [{ role: 'user', content: 'x' }], client_id: 'short' })).status, 400, 'client_id pattern');
  const big = await post({ messages: [{ role: 'user', content: 'x'.repeat(65537) }] }); assert.equal(big.status, 413); assert.equal((await big.json()).code, 'too_large');
  assert.equal((await post({ messages: [{ role: 'user', content: '€'.repeat(21846) }] })).status, 413, 'counted in bytes');
  assert.equal((await post({ messages: [{ role: 'user', content: 'k'.repeat(65536) }] })).status, 202, 'exactly 64 KiB is fine');
  const onDisk = await readStore(b); assert.equal(onDisk.events.length, 2, 'refused messages wrote nothing');
});

import { sseReader } from './bot-helpers.js';
const chat = (b, text = 'hi', extra = {}, token) => b.h.call('/api/agents/helper/chat', { token, data: userMessage(text, extra) });
async function chatStream(t, b, text, extra) {
  const res = await chat(b, text, extra); assert.equal(res.status, 200);
  const s = sseReader(res); t.after(() => s.cancel());
  return { res, s, chatId: res.headers.get('x-hermes-session-id'), runId: res.headers.get('x-foxfleet-run') };
}

test('/chat streams the reply of a connected bot: delta per message, [DONE] after final, then the run replays', async (t) => {
  const b = await bootBot(t), c = await b.connect(); await c.next((x) => x.t === 'hello');
  const { res, s, chatId, runId } = await chatStream(t, b, 'hi');
  assert.match(res.headers.get('content-type'), /text\/event-stream/); assert.match(chatId, /^fc_/); assert.ok(runId);
  const ev = await c.next((x) => x.t === 'message.new'); assert.equal(ev.chat_id, chatId); assert.equal(ev.text, 'hi');
  assert.equal((await c.request({ t: 'message.send', id: 'a', chat_id: chatId, text: 'Hello' })).ok, true);
  await s.until(() => s.deltas().length >= 1); assert.deepEqual(s.deltas(), ['Hello']);
  assert.equal((await c.request({ t: 'message.send', id: 'b', chat_id: chatId, text: 'second', final: true })).ok, true);
  await s.finished(); assert.deepEqual(s.deltas(), ['Hello', '\n\nsecond']); assert.equal(s.events.at(-1).raw_data, '[DONE]');
  const runs = await (await b.h.call(`/api/agents/helper/runs?session_id=${chatId}`)).json();
  assert.equal(runs.runs.length, 1); assert.equal(runs.runs[0].id, runId); assert.equal(runs.runs[0].state, 'done');
  const replay = sseReader(await b.h.call(`/api/agents/helper/runs/${runId}/events`)); t.after(() => replay.cancel()); await replay.finished();
  assert.deepEqual(replay.deltas(), ['Hello', '\n\nsecond']);
});

test('send-then-edit streaming: an edit that extends the text streams only the suffix, any other edit replaces the whole reply', async (t) => {
  const b = await bootBot(t), c = await b.connect(); await c.next((x) => x.t === 'hello');
  const { s, chatId } = await chatStream(t, b, 'hi'); await c.next((x) => x.t === 'message.new');
  const sent = await c.request({ t: 'message.send', id: 's1', chat_id: chatId, text: 'Hel▉' });
  await s.until(() => s.deltas().length === 1);
  const messageId = sent.result.message_id;
  const grow = await c.request({ t: 'message.edit', id: 'e1', chat_id: chatId, message_id: messageId, text: 'Hel▉lo' });
  assert.deepEqual(grow.result, { message_id: messageId, chat_id: chatId, edited: true });
  await s.until(() => s.deltas().length === 2); assert.deepEqual(s.deltas(), ['Hel▉', 'lo']);
  await c.request({ t: 'message.edit', id: 'e2', chat_id: chatId, message_id: messageId, text: 'Hello' });
  const replace = await s.next((e) => e.event === 'foxfleet.replace'); assert.deepEqual(replace.data, { text: 'Hello' });
  const second = await c.request({ t: 'message.send', id: 's2', chat_id: chatId, text: 'more' });
  await s.until(() => s.deltas().at(-1) === '\n\nmore');
  await c.request({ t: 'message.edit', id: 'e3', chat_id: chatId, message_id: second.result.message_id, text: 'more!', final: true });
  await s.finished(); assert.deepEqual(s.deltas().slice(2), ['\n\nmore', '!']); assert.equal(s.events.at(-1).raw_data, '[DONE]');
  await c.request({ t: 'message.edit', id: 'e4', chat_id: chatId, message_id: messageId, text: 'Hello', final: false });
  const page = await (await b.h.call(`/api/agents/helper/sessions/${chatId}/messages`)).json();
  assert.deepEqual(page.messages.map((x) => [x.role, x.content, Boolean(x.edited)]), [['user', 'hi', false], ['assistant', 'Hello', true], ['assistant', 'more!', true]]);
});

test('deleting a reply message replaces the streamed reply; a deleted message is gone from the transcript', async (t) => {
  const b = await bootBot(t), c = await b.connect(); await c.next((x) => x.t === 'hello');
  const { s, chatId } = await chatStream(t, b, 'hi'); await c.next((x) => x.t === 'message.new');
  const one = await c.request({ t: 'message.send', id: 's1', chat_id: chatId, text: 'one' }), two = await c.request({ t: 'message.send', id: 's2', chat_id: chatId, text: 'two' });
  await s.until(() => s.deltas().length === 2);
  const del = await c.request({ t: 'message.delete', id: 'd1', chat_id: chatId, message_id: one.result.message_id });
  assert.deepEqual(del.result, { message_id: one.result.message_id, chat_id: chatId, deleted: true });
  assert.deepEqual((await s.next((e) => e.event === 'foxfleet.replace')).data, { text: 'two' });
  const page = await (await b.h.call(`/api/agents/helper/sessions/${chatId}/messages`)).json(); assert.deepEqual(page.messages.map((x) => x.content), ['hi', 'two']);
  const again = await c.request({ t: 'message.edit', id: 'e1', chat_id: chatId, message_id: one.result.message_id, text: 'x' }); assert.equal(again.error.code, 'not_found');
  assert.equal(two.ok, true);
});

test('chat.action typing reaches the stream as foxfleet.bot', async (t) => {
  const b = await bootBot(t), c = await b.connect(); await c.next((x) => x.t === 'hello');
  const { s, chatId } = await chatStream(t, b, 'hi'); await c.next((x) => x.t === 'message.new');
  const res = await c.request({ t: 'chat.action', id: 'a1', chat_id: chatId, action: 'typing' }); assert.deepEqual(res, { t: 'res', id: 'a1', ok: true, result: {} });
  assert.deepEqual((await s.next((e) => e.event === 'foxfleet.bot' && e.data.action)).data, { action: 'typing' });
  assert.deepEqual((await s.next((e) => e.event === 'foxfleet.bot' && e.data.bot)).data, { bot: 'online' });
  const stored = JSON.parse(await readFile(storeFile(b), 'utf8')); assert.equal(stored.messages[chatId].length, 1, 'typing is transient');
});

test('the reply run ends replyIdleMs after the bot last wrote', async (t) => {
  const b = await bootBot(t, { botOptions: { replyIdleMs: 100 } }), c = await b.connect(); await c.next((x) => x.t === 'hello');
  const { s, chatId } = await chatStream(t, b, 'hello?'); await c.next((x) => x.t === 'message.new');
  await c.request({ t: 'message.send', id: 's1', chat_id: chatId, text: 'yes' });
  await s.finished(5000); assert.equal(s.events.at(-1).raw_data, '[DONE]'); assert.deepEqual(s.deltas(), ['yes']);
});

test('a reply run in which the bot never writes ends after replyWaitMs', async (t) => {
  const b = await bootBot(t, { botOptions: { replyWaitMs: 600 } }), started = Date.now();
  const { s } = await chatStream(t, b, 'anyone?');
  await s.finished(5000); assert.ok(Date.now() - started >= 600, 'not before replyWaitMs'); assert.deepEqual(s.deltas(), []); assert.equal(s.events.at(-1).raw_data, '[DONE]');
});

test('a bot message to a chat without a live run opens a new run that GET /runs lists', async (t) => {
  const b = await bootBot(t), c = await b.connect(); await c.next((x) => x.t === 'hello');
  const sent = await (await b.h.call('/api/agents/helper/messages', { data: userMessage('hi') })).json();
  const ev = await c.next((x) => x.t === 'message.new');
  await c.request({ t: 'message.send', id: 's1', chat_id: ev.chat_id, text: 'one', final: true });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await (await b.h.call(`/api/agents/helper/runs?session_id=${sent.session_id}`)).json()).runs.length, 1);
  await c.request({ t: 'message.send', id: 's2', chat_id: ev.chat_id, text: 'proactive' });
  const runs = (await (await b.h.call(`/api/agents/helper/runs?session_id=${sent.session_id}`)).json()).runs;
  assert.equal(runs.length, 2); assert.deepEqual(runs.map((r) => r.state).sort(), ['done', 'running']);
  const live = runs.find((r) => r.state === 'running'); const s = sseReader(await b.h.call(`/api/agents/helper/runs/${live.id}/events`)); t.after(() => s.cancel());
  await s.until(() => s.deltas().includes('proactive'));
  assert.equal((await b.h.call(`/api/agents/helper/runs/${live.id}/stop`, { data: {} })).status, 200);
  await s.finished(); assert.equal((await (await b.h.call(`/api/agents/helper/runs?session_id=${sent.session_id}`)).json()).runs.every((r) => r.state !== 'running'), true);
});

test('with 8 live runs the 9th /chat is 429 and writes nothing; /messages still stores the message, just without a run', async (t) => {
  const b = await bootBot(t); const open = [];
  for (let i = 0; i < 8; i++) { const r = await chat(b, `chat ${i}`); assert.equal(r.status, 200); const s = sseReader(r); t.after(() => s.cancel()); open.push(s); }
  const before = (await (await b.h.call('/api/agents/helper/sessions')).json()).total; assert.equal(before, 8);
  const refused = await chat(b, 'one too many'); assert.equal(refused.status, 429); await refused.body?.cancel();
  const stored = await readStore(b); assert.equal(Object.keys(stored.chats).length, 8, 'no chat created'); assert.equal(stored.events.length, 8, 'no event written');
  const msg = await send(b, 'but this one is kept'); assert.equal(msg.status, 202); const body = await msg.json(); assert.equal(body.run_id, undefined);
  assert.equal((await readStore(b)).events.length, 9);
});
const send = (b, text, extra = {}) => b.h.call('/api/agents/helper/messages', { data: userMessage(text, extra) });

test('deleting the agent ends its live runs and later requests are 404', async (t) => {
  const b = await bootBot(t), c = await b.connect(); await c.next((x) => x.t === 'hello');
  const { s, chatId } = await chatStream(t, b, 'hi'); await c.next((x) => x.t === 'message.new');
  assert.equal((await b.h.call('/api/connections/helper', { method: 'DELETE' })).status, 200);
  await s.finished(2000); assert.ok(s.events.some((e) => e.raw_data === '[DONE]')); assert.deepEqual(s.events.at(-1).data, { state: 'stopped' });
  assert.equal((await c.waitClose()).code, 4003);
  for (const route of ['sessions', 'runs', 'messages', `sessions/${chatId}/messages`]) assert.equal((await b.h.call(`/api/agents/helper/${route}`, route === 'messages' ? { data: userMessage('x') } : {})).status, 404, route);
});

test('activity: the agent list shows the newest message of the chat, user or bot', async (t) => {
  const b = await bootBot(t), c = await b.connect(); await c.next((x) => x.t === 'hello');
  const agent = async () => (await (await b.h.call('/api/agents')).json()).agents.find((a) => a.name === 'helper');
  await send(b, 'what is the weather?'); const ev = await c.next((x) => x.t === 'message.new');
  let a = await agent(); assert.equal(a.last_message_preview, 'what is the weather?'); assert.equal(a.last_role, 'user'); assert.equal(a.last_session_title, null);
  await c.request({ t: 'message.send', id: 's1', chat_id: ev.chat_id, text: 'It is **sunny** today' });
  a = await agent(); assert.equal(a.last_message_preview, 'It is sunny today'); assert.equal(a.last_role, 'assistant'); assert.ok(a.last_activity_at > 0); assert.equal(a.working, true, 'the reply run is live');
  assert.equal(a.online, true); assert.equal(a.status, 'ready');
});

test('only a bot message.send opens a reply run: a late edit, delete or typing on an idle chat leaves no run behind', async (t) => {
  const b = await bootBot(t), c = await b.connect(); await c.next((x) => x.t === 'hello');
  const sent = await (await send(b, 'hi')).json(); const ev = await c.next((x) => x.t === 'message.new');
  const reply = await c.request({ t: 'message.send', id: 's1', chat_id: ev.chat_id, text: 'answer', final: true });
  await new Promise((r) => setTimeout(r, 30));
  const runs = async () => (await (await b.h.call(`/api/agents/helper/runs?session_id=${sent.session_id}`)).json()).runs;
  assert.deepEqual((await runs()).map((r) => r.state), ['done']);
  const edit = await c.request({ t: 'message.edit', id: 'e1', chat_id: ev.chat_id, message_id: reply.result.message_id, text: 'answer, corrected' }); assert.equal(edit.ok, true);
  const typing = await c.request({ t: 'chat.action', id: 'a1', chat_id: ev.chat_id, action: 'typing' }); assert.deepEqual(typing.result, {});
  const second = await c.request({ t: 'message.send', id: 's2', chat_id: ev.chat_id, text: 'extra', final: true });
  await new Promise((r) => setTimeout(r, 30));
  const del = await c.request({ t: 'message.delete', id: 'd1', chat_id: ev.chat_id, message_id: second.result.message_id }); assert.equal(del.ok, true);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual((await runs()).map((r) => r.state), ['done', 'done'], 'only the two sends opened runs');
  assert.equal((await (await b.h.call(`/api/agents/helper/queue?session_id=${sent.session_id}`)).json()).active_run, null);
  const page = await (await b.h.call(`/api/agents/helper/sessions/${sent.session_id}/messages`)).json(); assert.deepEqual(page.messages.map((m) => m.content), ['hi', 'answer, corrected'], 'the transcript was still updated');
  const idle = (await (await b.h.call('/api/agents/helper/sessions', { data: { title: 'idle' } })).json()).id;
  assert.equal((await c.request({ t: 'chat.action', id: 'a2', chat_id: idle, action: 'typing' })).ok, true);
  assert.deepEqual((await (await b.h.call(`/api/agents/helper/runs?session_id=${idle}`)).json()).runs, [], 'typing on an idle chat opens no run');
});
