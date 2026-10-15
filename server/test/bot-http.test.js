// Real isolated hub tests of the non-displacing bot request transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bootBot, bootHub, addBot, member, sseReader } from './bot-helpers.js';

const user = (text, extra = {}) => ({ messages: [{ role: 'user', content: text }], ...extra });
const rpc = (b, frame, options = {}) => b.h.call('/api/bot/rpc', { data: frame, headers: { Authorization: `Bot ${b.token}` }, ...options });
const rawRpc = (b, { path = '/api/bot/rpc', headers = {}, body = '{}', method = 'POST' } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: b.h.port, path, method, headers: { Authorization: `Bot ${b.token}`, 'Content-Type': 'application/json', ...headers } }, (res) => {
    let text = ''; res.on('data', (c) => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
  }); req.on('error', reject); req.end(body);
});
const chat = async (b, text = 'hello') => (await (await b.h.call(`/api/agents/${b.name}/messages`, { data: user(text) })).json()).session_id;
const transcript = async (b, id) => (await (await b.h.call(`/api/agents/${b.name}/sessions/${id}/messages`)).json()).messages;

test('HTTP standalone send writes the app transcript without marking the bot online', async (t) => {
  const b = await bootBot(t), id = await chat(b);
  const res = await rpc(b, { t: 'message.send', id: 's1', chat_id: id, text: 'cron reply', final: true });
  assert.equal(res.status, 200);
  const out = await res.json(); assert.equal(out.t, 'res'); assert.equal(out.id, 's1'); assert.equal(out.ok, true); assert.equal(out.result.chat_id, id);
  assert.deepEqual((await transcript(b, id)).map((m) => m.content), ['hello', 'cron reply']);
  const probe = await (await b.h.call('/api/agents/helper')).json();
  assert.equal(probe.agent.online, false);
});

test('HTTP refuses socket-only, reserved and unknown operations in bounded res envelopes', async (t) => {
  const b = await bootBot(t);
  for (const [type, code] of [['ack', 'unsupported'], ['ping', 'unsupported'], ['pong', 'unsupported'], ['commands.set', 'unsupported'], ['media.upload', 'unsupported'], ['invented', 'unknown_type']]) {
    const res = await rpc(b, { t: type, id: 'protocol', event_id: 0, commands: [] });
    assert.equal(res.status, 200);
    const body = await res.json(); assert.deepEqual(body, { t: 'res', id: 'protocol', ok: false, error: { code, message: body.error?.message } });
  }
  for (const frame of [null, [], {}, { t: 3 }, { t: 'ping' }, { t: 'message.send', id: 'bad id' }, { t: 'message.send', id: 'x'.repeat(100000) }]) {
    const res = await rpc(b, frame); assert.equal(res.status, 200);
    const body = await res.json(); assert.equal(body.t, 'res'); assert.equal(body.id, null); assert.equal(body.ok, false); assert.ok(JSON.stringify(body).length < 512);
  }
  const noReflection = await (await rpc(b, { t: 'message.send', id: 'safe', ['ffb_' + 's'.repeat(43)]: 1 })).text();
  assert.ok(!noReflection.includes('ffb_'), 'untrusted field names are not reflected');
});

test('HTTP admission refuses query strings, foreign origin/host, wrong auth and non-POST; flag off is 404', async (t) => {
  const b = await bootBot(t), frame = { t: 'chat.action', id: 'a', chat_id: 'fc_AAAAAAAAAAAAAAAA', action: 'typing' };
  for (const suffix of ['?token=secret']) {
    const res = await b.h.call('/api/bot/rpc' + suffix, { data: frame, headers: { Authorization: `Bot ${b.token}` } });
    assert.equal(res.status, 400); assert.ok(!(await res.text()).includes('secret'));
  }
  const emptyQuery = await rawRpc(b, { path: '/api/bot/rpc?' });
  assert.equal(emptyQuery.status, 400, 'raw HTTP preserves the empty query marker (fetch strips it)');
  for (const headers of [{ Origin: 'https://evil.example' }, { Host: 'evil.example', 'X-Forwarded-Proto': 'https' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await rawRpc(b, { body: JSON.stringify(frame), headers })).status, 403, JSON.stringify(headers));
  }
  for (const Authorization of ['', `Bearer ${b.token}`, `Bot ffb_${'A'.repeat(43)}`, `Bot ${b.owner}`]) assert.equal((await rpc(b, frame, { headers: { Authorization } })).status, 401);
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) assert.equal((await rpc(b, undefined, { method })).status, 404);
  const published = await bootBot(t, { hubOptions: { trustedOrigins: ['http://hub.example', 'https://hub.example'] } });
  assert.equal((await rawRpc(published, { body: JSON.stringify(frame), headers: { Host: 'hub.example' } })).status, 403);
  assert.equal((await rawRpc(published, { body: JSON.stringify(frame), headers: { Host: 'hub.example', 'X-Forwarded-Proto': 'https', Origin: 'https://hub.example' } })).status, 200);
  const off = await bootHub(t, { botApi: false });
  assert.equal((await off.call('/api/bot/rpc', { token: '', data: frame })).status, 404);
});

test('HTTP preserves the active socket before/after sends and shares edit/delete/action run events', async (t) => {
  const b = await bootBot(t), c = await b.connect(); await c.next((x) => x.t === 'hello');
  const id = await chat(b, 'before'); await c.next((x) => x.t === 'message.new' && x.text === 'before');
  const runs = (await (await b.h.call('/api/agents/helper/runs')).json()).runs;
  const stream = sseReader(await b.h.call(`/api/agents/helper/runs/${runs[0].id}/events`)); t.after(() => stream.cancel());
  const out = await (await rpc(b, { t: 'message.send', id: 's', chat_id: id, text: 'part', final: false })).json(); assert.equal(out.ok, true);
  await stream.next((e) => e.data?.choices?.[0]?.delta?.content === 'part'); assert.equal(stream.ended, false);
  assert.equal((await (await rpc(b, { t: 'chat.action', id: 'a', chat_id: id, action: 'typing' })).json()).ok, true);
  await stream.next((e) => e.data?.action === 'typing');
  assert.equal((await (await rpc(b, { t: 'message.edit', id: 'e', chat_id: id, message_id: out.result.message_id, text: 'replacement', final: false })).json()).ok, true);
  await stream.next((e) => e.event === 'foxfleet.replace' && e.data.text === 'replacement');
  assert.equal((await (await rpc(b, { t: 'message.delete', id: 'd', chat_id: id, message_id: out.result.message_id })).json()).ok, true);
  await stream.next((e) => e.event === 'foxfleet.replace' && e.data.text === '');
  assert.equal((await (await rpc(b, { t: 'message.send', id: 'last', chat_id: id, text: 'finished', final: true })).json()).ok, true); await stream.finished();
  assert.equal((await b.h.call('/api/agents/helper/messages', { data: user('after', { session_id: id }) })).status, 202);
  await c.next((x) => x.t === 'message.new' && x.text === 'after'); assert.equal(c.close, null);
  assert.equal(c.texts.filter((x) => x.t === 'hello').length, 1);
  const probe = (await (await b.h.call('/api/agents/helper')).json()).agent; assert.equal(probe.online, true); assert.equal(probe.chatReady, true); assert.equal(probe.last_message_preview, 'after');
  assert.deepEqual((await transcript(b, id)).map((m) => m.content), ['before', 'finished', 'after']);
});

test('HTTP and WebSocket share idempotency in both directions and after restart', async (t) => {
  const b = await bootBot(t), c = await b.connect(), id = await chat(b);
  const frame = { t: 'message.send', id: 'h1', chat_id: id, text: 'once', idempotency_key: 'shared', final: true };
  const first = await (await rpc(b, frame)).json(); assert.equal(first.ok, true);
  assert.deepEqual(await c.request({ ...frame, id: 'w1' }), { ...first, id: 'w1', replayed: true });
  const edit = { t: 'message.edit', id: 'w2', chat_id: id, message_id: first.result.message_id, text: 'edited', idempotency_key: 'edit', final: true };
  const changed = await c.request(edit); assert.equal(changed.ok, true);
  assert.deepEqual(await (await rpc(b, { ...edit, id: 'h2' })).json(), { ...changed, id: 'h2', replayed: true });
  assert.equal((await (await rpc(b, { ...frame, id: 'clash', text: 'different' })).json()).error.code, 'idempotency_conflict');
  await b.h.restart();
  assert.deepEqual(await (await rpc(b, { ...frame, id: 'restart' })).json(), { ...first, id: 'restart', replayed: true });
  assert.deepEqual((await transcript(b, id)).map((m) => m.content), ['hello', 'edited']);
});

test('HTTP and socket use one bot rate bucket; IP auth throttle is shared too', async (t) => {
  const b = await bootBot(t, { botOptions: { rate: { burst: 2, perSec: 0.001 } } }), c = await b.connect(), id = await chat(b);
  assert.equal((await c.request({ t: 'message.send', id: 'w', chat_id: id, text: 'ws' })).ok, true);
  assert.equal((await (await rpc(b, { t: 'message.send', id: 'h', chat_id: id, text: 'http' })).json()).ok, true);
  const limited = await (await rpc(b, { t: 'message.send', id: 'over', chat_id: id, text: 'no' })).json();
  assert.equal(limited.error.code, 'rate_limited'); assert.ok(limited.error.retry_after_ms > 1000);
  assert.equal((await c.request({ t: 'message.send', id: 'over-w', chat_id: id, text: 'no' })).error.code, 'rate_limited');
  assert.deepEqual((await transcript(b, id)).map((m) => m.content), ['hello', 'ws', 'http']);
  for (let i = 0; i < 58; i++) await rpc(b, { t: 'ping', id: 'unsupported' });
  assert.equal((await rpc(b, { t: 'ping', id: 'throttled' })).status, 429);
});

test('HTTP ownership refuses another bot/account/chat and user-authored mutations without authority fields', async (t) => {
  const b = await bootBot(t), mine = await chat(b), other = await addBot(t, b.h, 'sibling');
  const siblingChat = (await (await b.h.call('/api/agents/sibling/messages', { data: user('sibling') })).json()).session_id;
  const alice = await member(b.h), theirs = await addBot(t, b.h, 'theirs', { token: alice.token });
  const theirChat = (await (await b.h.call('/api/agents/theirs/messages', { token: alice.token, data: user('theirs') })).json()).session_id;
  const first = (await transcript(b, mine))[0];
  for (const id of [siblingChat, theirChat, 'fc_AAAAAAAAAAAAAAAA']) {
    for (const frame of [{ t: 'message.send', text: 'no' }, { t: 'chat.action', action: 'typing' }]) assert.equal((await (await rpc(b, { ...frame, id: 'own', chat_id: id })).json()).error.code, 'not_found');
  }
  for (const type of ['message.edit', 'message.delete']) assert.equal((await (await rpc(b, { t: type, id: 'user', chat_id: mine, message_id: first.id, ...(type === 'message.edit' ? { text: 'no' } : {}) })).json()).error.code, 'forbidden');
  for (const field of ['bot_id', 'bot', 'account_id', 'agent']) assert.equal((await (await rpc(b, { t: 'message.send', id: 'authority', chat_id: mine, text: 'no', [field]: other.botId })).json()).error.code, 'invalid_request');
  assert.deepEqual((await transcript(b, mine)).map((m) => m.content), ['hello']);
});

test('HTTP malformed authorization is refused before reading an unavailable token index', async (t) => {
  const b = await bootBot(t);
  // SYNTHETIC CORRUPTION FIXTURE in this isolated hub only, never a live token file.
  const file = path.join(b.h.dir, 'bot', 'tokens.json'); await writeFile(file, '{broken'); await b.h.restart();
  assert.equal((await rawRpc(b, { headers: { Authorization: 'Bot invalid' } })).status, 401);
  assert.equal((await rawRpc(b)).status, 503);
  assert.equal(await readFile(file, 'utf8'), '{broken');
});

test('HTTP bounds text, encoded bodies and outputs; malformed JSON/UTF-8 and non-JSON MIME are refused', async (t) => {
  const b = await bootBot(t, { botOptions: { maxMessagesPerChat: 2 } }), id = await chat(b);
  const frame = { t: 'message.send', id: 'size', chat_id: id, text: 'x'.repeat(65536), final: true };
  assert.equal((await (await rpc(b, frame)).json()).ok, true);
  const tooLong = await (await rpc(b, { ...frame, text: '€'.repeat(21846) })).json(); assert.equal(tooLong.error.code, 'too_large');
  assert.equal((await rawRpc(b, { body: '{bad' })).status, 400);
  assert.equal((await rawRpc(b, { body: '' })).status, 400);
  assert.equal((await rawRpc(b, { body: Buffer.from([0xff]) })).status, 400);
  assert.equal((await rawRpc(b, { body: '{}', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  const huge = JSON.stringify({ ...frame, text: 'x'.repeat(1048576) });
  assert.equal((await rawRpc(b, { body: huge, headers: { 'Content-Length': Buffer.byteLength(huge) } })).status, 413);
  assert.equal((await rawRpc(b, { body: huge, headers: { 'Transfer-Encoding': 'chunked' } })).status, 413);
  const secretField = await rawRpc(b, { body: JSON.stringify({ ...frame, ['f'.repeat(900000)]: true }) });
  assert.equal(secretField.status, 200); assert.ok(secretField.text.length < 512);
  assert.equal((await (await rpc(b, { ...frame, id: 'next', text: 'last' })).json()).ok, true);
  assert.deepEqual((await transcript(b, id)).map((m) => m.content), [frame.text, 'last'], 'same shared store retention cap');
});

test('HTTP unreadable bot store returns 503 and never rewrites the file', async (t) => {
  const b = await bootBot(t), file = path.join(b.h.dir, 'bot', `${b.botId}.json`);
  await writeFile(file, '{broken'); await b.h.restart();
  assert.equal((await rpc(b, { t: 'message.send', id: 'store', chat_id: 'fc_AAAAAAAAAAAAAAAA', text: 'no' })).status, 503);
  assert.equal(await readFile(file, 'utf8'), '{broken');
});
