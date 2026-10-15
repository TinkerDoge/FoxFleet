// The user side of a bot agent: dedupe, sessions, isolation between accounts, limits, and the routes a bot never has.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { bootBot, member, addBot, sseReader } from './bot-helpers.js';

const send = (b, text, extra = {}, token) => b.h.call('/api/agents/helper/messages', { token, data: { messages: [{ role: 'user', content: text }], ...extra } });
const news = (c) => c.texts.filter((x) => x.t === 'message.new');

test('dedupe: the same client_id and text again is a 200 duplicate with the same ids (the bot hears once); other text is client_id_conflict', async (t) => {
  const b = await bootBot(t), c = await b.connect(); await c.next((x) => x.t === 'hello');
  const first = await send(b, 'hello there', { client_id: 'client-abcd1234' }); assert.equal(first.status, 202); const one = await first.json();
  const second = await send(b, 'hello there', { client_id: 'client-abcd1234' }); assert.equal(second.status, 200); const two = await second.json();
  assert.equal(two.duplicate, true); assert.deepEqual([two.message.id, two.session_id, two.message.created], [one.message.id, one.session_id, one.message.created]);
  const clash = await send(b, 'something else', { client_id: 'client-abcd1234', session_id: one.session_id }); assert.equal(clash.status, 409); assert.equal((await clash.json()).code, 'client_id_conflict');
  await new Promise((r) => setTimeout(r, 60)); assert.equal(news(c).length, 1);
  const stored = JSON.parse(await readFile(path.join(b.h.dir, 'bot', `${b.botId}.json`), 'utf8')); assert.equal(stored.events.length, 1);
  await b.h.restart();
  const afterRestart = await send(b, 'hello there', { client_id: 'client-abcd1234' }); assert.equal(afterRestart.status, 200); assert.equal((await afterRestart.json()).message.id, one.message.id);
});

test('sessions: create with a title, rename, delete; sending to an unknown or deleted session is 404 and the bot loses the chat', async (t) => {
  const b = await bootBot(t), c = await b.connect(); await c.next((x) => x.t === 'hello');
  const A = '/api/agents/helper/sessions';
  const made = await b.h.call(A, { data: { title: 'Plans' } }); assert.equal(made.status, 201); const s = await made.json();
  assert.match(s.id, /^fc_[A-Za-z0-9_-]{16}$/); assert.equal(s.session_id, s.id); assert.equal(s.title, 'Plans');
  assert.equal((await (await b.h.call(A)).json()).sessions[0].title, 'Plans');
  assert.equal((await b.h.call(A, { data: {} })).status, 201, 'title is optional');
  assert.equal((await b.h.call(A, { data: { title: 'x'.repeat(201) } })).status, 400);
  const posted = await send(b, 'into the new chat', { session_id: s.id }); assert.equal(posted.status, 202); assert.equal((await posted.json()).session_id, s.id);
  assert.equal((await c.next((x) => x.t === 'message.new')).chat_id, s.id);
  const renamed = await b.h.call(`${A}/${s.id}`, { method: 'PATCH', data: { title: ' Better title ' } }); assert.equal(renamed.status, 200); assert.deepEqual(await renamed.json(), { id: s.id, title: 'Better title' });
  assert.equal((await b.h.call(`${A}/${s.id}`, { method: 'PATCH', data: { title: '   ' } })).status, 400);
  assert.equal((await b.h.call(`${A}/fc_AAAAAAAAAAAAAAAA`, { method: 'PATCH', data: { title: 'x' } })).status, 404);
  assert.equal((await send(b, 'nowhere', { session_id: 'fc_AAAAAAAAAAAAAAAA' })).status, 404);
  assert.equal((await send(b, 'nowhere', { session_id: 'not-a-chat' })).status, 404);
  assert.equal((await b.h.call('/api/agents/helper/chat', { data: { messages: [{ role: 'user', content: 'x' }], session_id: 'fc_AAAAAAAAAAAAAAAA' } })).status, 404);
  assert.equal((await b.h.call(`${A}/fc_AAAAAAAAAAAAAAAA/messages`)).status, 404);
  assert.equal((await b.h.call(`${A}/${s.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await b.h.call(`${A}/${s.id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await b.h.call(`${A}/${s.id}/messages`)).status, 404);
  const gone = await c.request({ t: 'message.send', id: 'g1', chat_id: s.id, text: 'hello?' }); assert.equal(gone.error.code, 'not_found');
  assert.equal((await send(b, 'late', { session_id: s.id })).status, 404);
});

test('accounts: a member cannot list, read, post to or stop the owner bot (404) and the owner cannot reach the member bot', async (t) => {
  const b = await bootBot(t), alice = await member(b.h), theirs = await addBot(t, b.h, 'helper', { token: alice.token });
  const mine = await (await send(b, 'owner chat')).json();
  assert.deepEqual((await (await b.h.call('/api/agents/helper/sessions', { token: alice.token })).json()).sessions, [], "alice's own bot of the same name has no chats");
  assert.equal((await b.h.call(`/api/agents/helper/sessions/${mine.session_id}/messages`, { token: alice.token })).status, 404, "the owner's chat id means nothing in alice's bot");
  assert.equal((await send(b, 'hello alice', { session_id: mine.session_id }, alice.token)).status, 404);
  const aliceChat = await (await send(b, 'alice chat', {}, alice.token)).json();
  assert.equal((await b.h.call(`/api/agents/helper/sessions/${aliceChat.session_id}/messages`)).status, 404, "alice's chat id means nothing in the owner's bot");
  const only = await b.h.call('/api/agents/helper/messages', { token: alice.token, data: { messages: [{ role: 'user', content: 'x' }] } }); assert.equal(only.status, 202);
  const ghost = await addBot(t, b.h, 'onlyalice', { token: alice.token });
  for (const route of ['sessions', 'runs', 'queue', 'commands']) assert.equal((await b.h.call(`/api/agents/onlyalice/${route}`)).status, 404, `owner -> alice's bot ${route}`);
  assert.equal((await b.h.call('/api/agents/onlyalice/messages', { data: { messages: [{ role: 'user', content: 'x' }] } })).status, 404);
  assert.equal((await b.h.call('/api/agents/onlyalice/bot-token', { data: {} })).status, 404);
  assert.equal((await b.h.call('/api/agents/onlyalice/runs/xyz/events')).status, 404);
  assert.ok(theirs.token && ghost.token);
});

test('queue: the fixed shape, active_run is the live reply run of the asked session', async (t) => {
  const b = await bootBot(t);
  assert.deepEqual(await (await b.h.call('/api/agents/helper/queue')).json(), { items: [], recent: [], halted: false, active_run: null, modes: ['queue'], open_requests: [], can_cancel: false });
  const sent = await (await send(b, 'hi')).json(); assert.ok(sent.run_id);
  const q = await (await b.h.call(`/api/agents/helper/queue?session_id=${sent.session_id}`)).json(); assert.equal(q.active_run, sent.run_id);
  assert.equal((await (await b.h.call('/api/agents/helper/queue?session_id=fc_AAAAAAAAAAAAAAAA')).json()).active_run, null);
  assert.equal((await b.h.call('/api/agents/helper/queue/resume', { data: {} })).status, 404);
  assert.equal((await b.h.call('/api/agents/helper/queue/abc', { method: 'DELETE' })).status, 404);
});

test('routes a bot does not have are 404 and never reach an upstream; the agent view carries exactly the bot capability set', async (t) => {
  const b = await bootBot(t), sent = await (await send(b, 'hi')).json();
  for (const [route, data] of [['files', {}], ['screen/status'], ['screen/observe', {}], ['skills'], ['skills/toggle', { name: 'x', enabled: true }], ['native'], ['native/sessions', {}], ['config'], ['cron'], ['logs'], ['usage'], ['profiles'], ['artifacts'], ['transcribe', {}], ['media', { ref: 'x' }],
    [`sessions/${sent.session_id}/reactions`], [`sessions/${sent.session_id}/hidden`], [`sessions/${sent.session_id}/search`], ['sessions/search']]) {
    assert.equal((await b.h.call(`/api/agents/helper/${route}`, { data })).status, 404, route);
  }
  const view = (await (await b.h.call('/api/agents/helper')).json()).agent;
  assert.deepEqual({ ...view.capabilities, media: undefined }, { chat: true, images: false, files: false, screen: false, voice: false, skills: false, sessions: true, bot: true, reactions: false, agentReactions: false, busy: ['queue'], nativeUi: false, nativeRuns: false, media: undefined });
  assert.equal(view.status, 'offline'); assert.equal(view.hasBotToken, true); assert.equal(view.checks.media.ok, true); assert.match(view.checks.media.message, /Bot media via hub/);
  assert.equal(view.managementReady, false); assert.equal(view.kind, 'hermes');
  assert.equal((await b.h.call('/api/agents/helper/pin', { method: 'PUT', data: { pinned: true } })).status, 200, 'pin is the shared hub-side handler');
  const direct = await b.h.call('/api/connections', { data: { name: 'desk', host: '127.0.0.1', dashboardPort: 9, apiServerPort: 9 } }); assert.equal(direct.status, 201);
  const d = (await (await b.h.call('/api/agents/desk')).json()).agent;
  assert.deepEqual({ chat: d.capabilities.chat, images: d.capabilities.images, files: d.capabilities.files, screen: d.capabilities.screen, voice: d.capabilities.voice, skills: d.capabilities.skills, sessions: d.capabilities.sessions, reactions: d.capabilities.reactions, agentReactions: d.capabilities.agentReactions, bot: d.capabilities.bot },
    { chat: true, images: true, files: true, screen: true, voice: true, skills: true, sessions: true, reactions: true, agentReactions: true, bot: undefined });
});

test('limits: maxChats refuses a new chat with 409 bot_chat_limit; maxMessagesPerChat keeps the newest messages', async (t) => {
  const b = await bootBot(t, { botOptions: { maxChats: 2, maxMessagesPerChat: 3 } }), c = await b.connect(); await c.next((x) => x.t === 'hello');
  const one = await (await send(b, 'chat one')).json(); await (await send(b, 'chat two')).json();
  const third = await send(b, 'chat three'); assert.equal(third.status, 409); assert.equal((await third.json()).code, 'bot_chat_limit');
  assert.equal((await b.h.call('/api/agents/helper/sessions', { data: {} })).status, 409);
  const chatRes = await b.h.call('/api/agents/helper/chat', { data: { messages: [{ role: 'user', content: 'x' }] } }); assert.equal(chatRes.status, 409); await chatRes.body?.cancel();
  assert.equal((await send(b, 'more in one', { session_id: one.session_id })).status, 202, 'existing chats still work');
  for (const text of ['r1', 'r2']) await c.request({ t: 'message.send', id: text, chat_id: one.session_id, text });
  const page = await (await b.h.call(`/api/agents/helper/sessions/${one.session_id}/messages`)).json(); assert.deepEqual(page.messages.map((m) => m.content), ['more in one', 'r1', 'r2'], 'oldest messages are pruned');
  assert.equal((await b.h.call(`/api/agents/helper/sessions/${one.session_id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await send(b, 'chat three')).status, 202, 'room again after a delete');
  const paged = await (await b.h.call(`/api/agents/helper/sessions/${(await (await b.h.call('/api/agents/helper/sessions')).json()).sessions[0].id}/messages?limit=1`)).json(); assert.equal(paged.messages.length, 1);
});
