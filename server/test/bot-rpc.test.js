// Bot -> hub requests: pure validation (contract section 6) and, on a real hub, ownership, idempotency, rate limit and commands.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { validateRequest, parseBotFrame } from '../bot-protocol.js';
import { bootBot, member, addBot } from './bot-helpers.js';

const CHAT = 'fc_AAAAAAAAAAAAAAAA', MSG = 'fm_BBBBBBBBBBBBBBBB';
const check = (frame) => validateRequest(frame);
const bad = (frame, code, id = frame.id) => { const v = check(frame); assert.equal(v.ok, false, JSON.stringify(frame)); assert.equal(v.code, code, JSON.stringify(frame) + ' -> ' + v.code); assert.equal(v.id, id === null ? undefined : id); };

test('validation: message.send normalises fields and enforces the allow-list, patterns and text rules', () => {
  const ok = check({ t: 'message.send', id: 'r1', chat_id: CHAT, text: 'hi' });
  assert.equal(ok.ok, true); assert.deepEqual(ok.req, { chat_id: CHAT, text: 'hi', format: 'markdown', final: false });
  const full = check({ t: 'message.send', id: 'r1', chat_id: CHAT, text: 'héllo', format: 'text', reply_to: MSG, final: true, idempotency_key: 'k:1._-' });
  assert.deepEqual(full.req, { chat_id: CHAT, text: 'héllo', format: 'text', reply_to: MSG, final: true, idempotency_key: 'k:1._-' });
  for (const field of ['media', 'buttons', 'keyboard', 'card', 'thread_id', 'group_id', 'parse_mode', 'silent', 'reactions']) bad({ t: 'message.send', id: 'r1', chat_id: CHAT, text: 'x', [field]: 1 }, 'unsupported');
  bad({ t: 'message.send', id: 'r1', chat_id: CHAT, text: 'x', surprise: 1 }, 'invalid_request');
  bad({ t: 'message.send', id: 'r1', chat_id: CHAT, text: 'x', event_id: 3 }, 'invalid_request');
  bad({ t: 'message.send', id: 'r1', text: 'x' }, 'invalid_request');
  bad({ t: 'message.send', id: 'r1', chat_id: 5, text: 'x' }, 'invalid_request');
  bad({ t: 'message.send', id: 'r1', chat_id: 'fc_short', text: 'x' }, 'not_found');
  bad({ t: 'message.send', id: 'r1', chat_id: 'fm_AAAAAAAAAAAAAAAA', text: 'x' }, 'not_found');
  bad({ t: 'message.send', id: 'r1', chat_id: CHAT, text: 'x', reply_to: 'nope' }, 'not_found');
  bad({ t: 'message.send', id: 'r1', chat_id: CHAT }, 'invalid_request');
  bad({ t: 'message.send', id: 'r1', chat_id: CHAT, text: '' }, 'invalid_request');
  bad({ t: 'message.send', id: 'r1', chat_id: CHAT, text: 7 }, 'invalid_request');
  bad({ t: 'message.send', id: 'r1', chat_id: CHAT, text: 'a\0b' }, 'invalid_request');
  bad({ t: 'message.send', id: 'r1', chat_id: CHAT, text: 'x', format: 'html' }, 'invalid_request');
  bad({ t: 'message.send', id: 'r1', chat_id: CHAT, text: 'x', final: 'yes' }, 'invalid_request');
  bad({ t: 'message.send', id: 'r1', chat_id: CHAT, text: 'x', idempotency_key: 'bad key' }, 'invalid_request');
  bad({ t: 'message.send', id: 'r1', chat_id: CHAT, text: 'x', idempotency_key: 'k'.repeat(129) }, 'invalid_request');
  assert.equal(check({ t: 'message.send', id: 'r1', chat_id: CHAT, text: 'k'.repeat(65536) }).ok, true, 'exactly 64 KiB');
  assert.equal(check({ t: 'message.send', id: 'r1', chat_id: CHAT, text: '€'.repeat(21845) }).ok, true, '65535 bytes');
  bad({ t: 'message.send', id: 'r1', chat_id: CHAT, text: 'k'.repeat(65537) }, 'too_large');
  bad({ t: 'message.send', id: 'r1', chat_id: CHAT, text: '€'.repeat(21846) }, 'too_large');
});

test('validation: request ids are required (except ack and ping) and must match the pattern', () => {
  bad({ t: 'message.send', chat_id: CHAT, text: 'x' }, 'invalid_request', null);
  bad({ t: 'message.send', id: 'has space', chat_id: CHAT, text: 'x' }, 'invalid_request', null);
  bad({ t: 'message.send', id: 'x'.repeat(65), chat_id: CHAT, text: 'x' }, 'invalid_request', null);
  bad({ t: 'message.send', id: 7, chat_id: CHAT, text: 'x' }, 'invalid_request', null);
  assert.equal(check({ t: 'message.send', id: 'a.b_c:d-1', chat_id: CHAT, text: 'x' }).ok, true);
  assert.equal(check({ t: 'ack', event_id: 1 }).ok, true); assert.equal(check({ t: 'ping' }).ok, true); assert.equal(check({ t: 'pong' }).ok, true);
});

test('validation: message.edit, message.delete, chat.action, ack and commands.set', () => {
  assert.deepEqual(check({ t: 'message.edit', id: 'e', chat_id: CHAT, message_id: MSG, text: 'new' }).req, { chat_id: CHAT, message_id: MSG, text: 'new', format: 'markdown', final: false });
  bad({ t: 'message.edit', id: 'e', chat_id: CHAT, text: 'new' }, 'invalid_request');
  bad({ t: 'message.edit', id: 'e', chat_id: CHAT, message_id: 'fm_x', text: 'new' }, 'not_found');
  bad({ t: 'message.edit', id: 'e', chat_id: CHAT, message_id: MSG, text: 'new', reply_to: MSG }, 'invalid_request');
  bad({ t: 'message.edit', id: 'e', chat_id: CHAT, message_id: MSG, text: 'new', buttons: [] }, 'unsupported');
  assert.deepEqual(check({ t: 'message.delete', id: 'd', chat_id: CHAT, message_id: MSG, idempotency_key: 'k' }).req, { chat_id: CHAT, message_id: MSG, idempotency_key: 'k' });
  bad({ t: 'message.delete', id: 'd', chat_id: CHAT, message_id: MSG, text: 'x' }, 'invalid_request');
  assert.deepEqual(check({ t: 'chat.action', id: 'a', chat_id: CHAT, action: 'typing' }).req, { chat_id: CHAT, action: 'typing' });
  bad({ t: 'chat.action', id: 'a', chat_id: CHAT, action: 'upload_photo' }, 'unsupported');
  bad({ t: 'chat.action', id: 'a', chat_id: CHAT, action: 5 }, 'invalid_request');
  bad({ t: 'chat.action', id: 'a', chat_id: CHAT }, 'invalid_request');
  assert.deepEqual(check({ t: 'ack', event_id: 0 }).req, { event_id: 0 });
  assert.deepEqual(check({ t: 'ack', id: 'k1', event_id: 7 }).req, { event_id: 7 }); assert.equal(check({ t: 'ack', id: 'k1', event_id: 7 }).id, 'k1');
  for (const event_id of [-1, 1.5, '3', null, undefined, Number.MAX_SAFE_INTEGER + 2, NaN]) bad({ t: 'ack', id: 'k', event_id }, 'invalid_request');
  bad({ t: 'ack', id: 'k', event_id: 1, extra: 1 }, 'invalid_request');
  const list = [{ name: 'help', description: 'Show help' }, { name: 'a_1', description: 'x'.repeat(256) }];
  assert.deepEqual(check({ t: 'commands.set', id: 'c', commands: list }).req, { commands: list });
  assert.deepEqual(check({ t: 'commands.set', id: 'c', commands: [] }).req, { commands: [] });
  for (const commands of ['x', [{ name: 'Bad', description: 'x' }], [{ name: 'a-b', description: 'x' }], [{ name: '', description: 'x' }], [{ name: 'n'.repeat(33), description: 'x' }],
    [{ name: 'a', description: '' }], [{ name: 'a', description: 'x'.repeat(257) }], [{ name: 'a', description: 'line\nbreak' }], [{ name: 'a', description: 'x', extra: 1 }], [{ name: 'a' }],
    [{ name: 'a', description: 'x' }, { name: 'a', description: 'y' }], Array.from({ length: 101 }, (_, i) => ({ name: `c${i}`, description: 'd' })), [null], [5]]) bad({ t: 'commands.set', id: 'c', commands }, 'invalid_request');
  assert.equal(check({ t: 'commands.set', id: 'c', commands: Array.from({ length: 100 }, (_, i) => ({ name: `c${i}`, description: 'd' })) }).ok, true);
  bad({ t: 'commands.set', id: 'c' }, 'invalid_request');
});

test('validation: parseBotFrame keeps the phase A verdicts', () => {
  assert.deepEqual(parseBotFrame('{"t":"ping"}'), { ok: true, frame: { t: 'ping' } });
  assert.equal(parseBotFrame('[]').fatal, true);
});

const post = (b, text, extra = {}, name = 'helper', token) => b.h.call(`/api/agents/${name}/messages`, { token, data: { messages: [{ role: 'user', content: text }], ...extra } });
const storeText = (h, bot) => readFile(path.join(h.dir, 'bot', `${bot.botId ?? bot}.json`), 'utf8').catch(() => '');
const news = (c) => c.texts.filter((x) => x.t === 'message.new');
async function chatsOf(b, c, texts) {
  const out = [];
  for (const text of texts) { const r = await (await post(b, text)).json(); out.push(r.session_id); }
  await c.until(() => news(c).length === texts.length); return out;
}

test('ownership: chats of one bot are separate; user messages cannot be edited or deleted by the bot', async (t) => {
  const b = await bootBot(t), c = await b.connect(); await c.next((x) => x.t === 'hello');
  const [a, other] = await chatsOf(b, c, ['first chat', 'second chat']);
  const sent = await c.request({ t: 'message.send', id: 's1', chat_id: a, text: 'only in A' });
  const tr = async (id) => (await (await b.h.call(`/api/agents/helper/sessions/${id}/messages`)).json()).messages.map((m) => m.content);
  assert.deepEqual(await tr(a), ['first chat', 'only in A']); assert.deepEqual(await tr(other), ['second chat']);
  const userMsg = news(c).find((e) => e.chat_id === a).message_id;
  const before = await storeText(b.h, b);
  for (const t of ['message.edit', 'message.delete']) { const r = await c.request({ t, id: `u-${t}`, chat_id: a, message_id: userMsg, text: 'hijack' }); assert.equal(r.error.code, t === 'message.edit' ? 'forbidden' : 'invalid_request'); }
  const del = await c.request({ t: 'message.delete', id: 'u-del', chat_id: a, message_id: userMsg }); assert.equal(del.error.code, 'forbidden');
  const cross = await c.request({ t: 'message.edit', id: 'x1', chat_id: other, message_id: sent.result.message_id, text: 'wrong chat' }); assert.equal(cross.error.code, 'not_found');
  const reply = await c.request({ t: 'message.send', id: 'rp1', chat_id: other, text: 'reply', reply_to: sent.result.message_id }); assert.equal(reply.error.code, 'not_found', 'reply_to must be in the same chat');
  const okReply = await c.request({ t: 'message.send', id: 'rp2', chat_id: a, text: 'threaded', reply_to: userMsg }); assert.equal(okReply.ok, true);
  assert.deepEqual(await tr(a), ['first chat', 'only in A', 'threaded']);
  assert.notEqual(await storeText(b.h, b), before);
});

test('ownership: ids of another bot, another account or made up are not_found and change nothing; malformed ids are rejected', async (t) => {
  const b = await bootBot(t), c = await b.connect(); await c.next((x) => x.t === 'hello');
  const sibling = await addBot(t, b.h, 'sibling'), sc = await sibling.connect(); await sc.next((x) => x.t === 'hello');
  const alice = await member(b.h), theirs = await addBot(t, b.h, 'theirs', { token: alice.token }), tc = await theirs.connect(); await tc.next((x) => x.t === 'hello');
  const [mineChat] = await chatsOf(b, c, ['mine']);
  const sibChat = (await (await post(b, 'for sibling', {}, 'sibling')).json()).session_id; await sc.until(() => news(sc).length === 1);
  const theirChat = (await (await post(b, 'for theirs', {}, 'theirs', alice.token)).json()).session_id; await tc.until(() => news(tc).length === 1);
  const sibMsg = news(sc)[0].message_id, theirMsg = news(tc)[0].message_id;
  const files = async () => [await storeText(b.h, b), await storeText(b.h, sibling), await readFile(path.join(b.h.dir, 'users', alice.id, 'bot', `${theirs.botId}.json`), 'utf8')];
  const before = await files();
  for (const [name, frame] of [
    ['another bot of the same owner', { t: 'message.send', chat_id: sibChat, text: 'x' }],
    ["another account's bot", { t: 'message.send', chat_id: theirChat, text: 'x' }],
    ['made up chat', { t: 'message.send', chat_id: 'fc_AAAAAAAAAAAAAAAA', text: 'x' }],
    ['malformed chat id', { t: 'message.send', chat_id: '../../etc/passwd', text: 'x' }],
    ['chat id of the wrong kind', { t: 'message.send', chat_id: sibMsg, text: 'x' }],
    ["edit another bot's message", { t: 'message.edit', chat_id: sibChat, message_id: sibMsg, text: 'x' }],
    ["edit with my chat, their message", { t: 'message.edit', chat_id: mineChat, message_id: theirMsg, text: 'x' }],
    ["delete another account's message", { t: 'message.delete', chat_id: theirChat, message_id: theirMsg }],
    ['typing in another chat', { t: 'chat.action', chat_id: sibChat, action: 'typing' }],
    ['reply_to of another bot', { t: 'message.send', chat_id: mineChat, text: 'x', reply_to: sibMsg }],
  ]) { const r = await c.request({ id: `own-${name.length}`, ...frame }); assert.equal(r.ok, false, name); assert.equal(r.error.code, 'not_found', name); }
  assert.deepEqual(await files(), before, 'no store changed');
  const bad = await c.request({ t: 'message.send', id: 'bad', chat_id: 5, text: 'x' }); assert.equal(bad.error.code, 'invalid_request');
});

test('idempotency: the same key and payload replays the result (new res id, replayed:true), also after a restart; another payload conflicts', async (t) => {
  const b = await bootBot(t), c = await b.connect(); await c.next((x) => x.t === 'hello');
  const [chat] = await chatsOf(b, c, ['go']);
  const first = await c.request({ t: 'message.send', id: 'r1', chat_id: chat, text: 'once', idempotency_key: 'k-1' });
  assert.equal(first.ok, true); assert.equal(first.replayed, undefined);
  const again = await c.request({ t: 'message.send', id: 'r2', chat_id: chat, text: 'once', idempotency_key: 'k-1' });
  assert.deepEqual(again, { t: 'res', id: 'r2', ok: true, result: first.result, replayed: true });
  const transcript = async () => (await (await b.h.call(`/api/agents/helper/sessions/${chat}/messages`)).json()).messages.map((m) => m.content);
  assert.deepEqual(await transcript(), ['go', 'once'], 'one message only');
  const clash = await c.request({ t: 'message.send', id: 'r3', chat_id: chat, text: 'different', idempotency_key: 'k-1' }); assert.equal(clash.error.code, 'idempotency_conflict');
  const other = await c.request({ t: 'message.send', id: 'r4', chat_id: chat, text: 'different', idempotency_key: 'k-2' }); assert.equal(other.ok, true);
  const sameKeyOtherOp = await c.request({ t: 'message.edit', id: 'r5', chat_id: chat, message_id: first.result.message_id, text: 'edited', idempotency_key: 'k-1' }); assert.equal(sameKeyOtherOp.ok, true, 'keys are scoped per operation');
  const editAgain = await c.request({ t: 'message.edit', id: 'r6', chat_id: chat, message_id: first.result.message_id, text: 'edited', idempotency_key: 'k-1' }); assert.equal(editAgain.replayed, true);
  const del = await c.request({ t: 'message.delete', id: 'r7', chat_id: chat, message_id: other.result.message_id, idempotency_key: 'd-1' }); assert.equal(del.ok, true);
  assert.equal((await c.request({ t: 'message.delete', id: 'r8', chat_id: chat, message_id: other.result.message_id, idempotency_key: 'd-1' })).replayed, true, 'a replayed delete is not a not_found');
  assert.deepEqual(await transcript(), ['go', 'edited']);
  await b.h.restart();
  const c2 = await b.connect(); await c2.next((x) => x.t === 'hello');
  const afterRestart = await c2.request({ t: 'message.send', id: 'r9', chat_id: chat, text: 'once', idempotency_key: 'k-1' });
  assert.deepEqual(afterRestart, { t: 'res', id: 'r9', ok: true, result: first.result, replayed: true });
  assert.deepEqual(await transcript(), ['go', 'edited']);
  assert.equal((await c2.request({ t: 'message.send', id: 'r10', chat_id: chat, text: 'x', idempotency_key: 'k-1' })).error.code, 'idempotency_conflict');
});

test('rate limit: a token bucket per bot; the request over the limit is rate_limited with retry_after_ms and has no effect', async (t) => {
  const b = await bootBot(t, { botOptions: { rate: { burst: 3, perSec: 0.001 } } }), c = await b.connect(); await c.next((x) => x.t === 'hello');
  const [chat] = await chatsOf(b, c, ['go']);
  for (let i = 0; i < 2; i++) assert.equal((await c.request({ t: 'message.send', id: `ok${i}`, chat_id: chat, text: `m${i}` })).ok, true);
  c.send({ t: 'ping', id: 'free' }); await c.next((x) => x.t === 'pong' && x.id === 'free');
  assert.equal((await c.request({ t: 'message.send', id: 'ok2', chat_id: chat, text: 'm2' })).ok, true);
  const limited = await c.request({ t: 'message.send', id: 'over', chat_id: chat, text: 'm3' });
  assert.equal(limited.ok, false); assert.equal(limited.error.code, 'rate_limited'); assert.ok(limited.error.retry_after_ms > 1000);
  const transcript = (await (await b.h.call(`/api/agents/helper/sessions/${chat}/messages`)).json()).messages.map((m) => m.content); assert.deepEqual(transcript, ['go', 'm0', 'm1', 'm2']);
  assert.equal((await b.h.call(`/api/agents/helper/sessions`)).status, 200, 'users are not affected');
  const second = await b.connect(); await second.next((x) => x.t === 'hello');
  assert.equal((await second.request({ t: 'message.send', id: 'again', chat_id: chat, text: 'x' })).error.code, 'rate_limited', 'the bucket belongs to the bot, not the connection');
});

test('commands.set replaces the bot list; /commands serves the bot commands plus the app commands, never the bundled Hermes list', async (t) => {
  const b = await bootBot(t), c = await b.connect(); await c.next((x) => x.t === 'hello');
  const get = async () => (await b.h.call('/api/agents/helper/commands')).json();
  const empty = await get(); assert.equal(empty.source, 'bot'); assert.deepEqual(empty.busy, ['queue']);
  const names = (r) => r.commands.map((x) => x.name);
  assert.ok(['new', 'history', 'retry', 'title'].every((n) => names(empty).includes(n)), 'app commands are there');
  for (const hermes of ['model', 'compress', 'queue', 'steer', 'busy', 'stop', 'start']) assert.ok(!names(empty).includes(hermes), `${hermes} is not offered for a bot`);
  for (const cmd of empty.commands) assert.ok(String(cmd.handler).startsWith('app:'), cmd.name);
  const set = await c.request({ t: 'commands.set', id: 'c1', commands: [{ name: 'weather', description: 'Weather report' }, { name: 'joke', description: 'Tell a joke' }] });
  assert.deepEqual(set.result, { count: 2 });
  const full = await get();
  const mine = full.commands.filter((x) => x.handler === 'chat'); assert.deepEqual(mine.map((x) => x.name), ['weather', 'joke']);
  assert.deepEqual(mine[0], { name: 'weather', aliases: [], description: 'Weather report', category: 'Bot', args: '', subcommands: [], availability: 'chat', handler: 'chat', busy: 'queue', executable: true, verified: false });
  assert.ok(names(full).includes('new'));
  for (const commands of [[{ name: 'Bad Name', description: 'x' }], [{ name: 'a', description: 'x' }, { name: 'a', description: 'y' }], Array.from({ length: 101 }, (_, i) => ({ name: `c${i}`, description: 'd' }))]) {
    const r = await c.request({ t: 'commands.set', id: 'bad', commands }); assert.equal(r.error.code, 'invalid_request');
  }
  assert.deepEqual((await get()).commands.filter((x) => x.handler === 'chat').map((x) => x.name), ['weather', 'joke'], 'the old list is kept');
  await b.h.restart(); assert.deepEqual((await get()).commands.filter((x) => x.handler === 'chat').map((x) => x.name), ['weather', 'joke'], 'persisted');
});

test('rate limit: acks (like pings) are not counted, so a bot can always acknowledge', async (t) => {
  const b = await bootBot(t, { botOptions: { rate: { burst: 1, perSec: 0.001 } } }), c = await b.connect(); await c.next((x) => x.t === 'hello');
  const [chat] = await chatsOf(b, c, ['go']);
  assert.equal((await c.request({ t: 'message.send', id: 's1', chat_id: chat, text: 'uses the only token' })).ok, true);
  assert.equal((await c.request({ t: 'message.send', id: 's2', chat_id: chat, text: 'refused' })).error.code, 'rate_limited');
  const ack = await c.request({ t: 'ack', id: 'k1', event_id: 1 }); assert.deepEqual(ack.result, { acked: 1 });
  assert.equal(JSON.parse(await storeText(b.h, b)).acked, 1, 'persisted');
  c.send({ t: 'ack', event_id: 1 }); c.send({ t: 'ping', id: 'p' }); await c.next((x) => x.t === 'pong');
  assert.ok(!c.texts.some((x) => x.t === 'error'), 'no error frames');
});
