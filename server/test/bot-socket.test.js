// Bot socket admission and session rules on a real hub (flag on).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { bootBot, bootHub, member, botSocket, upgradeStatus, wsFrame } from './bot-helpers.js';
import { secureBotRequest } from '../bot-api.js';

test('a valid token upgrades (101, subprotocol echoed) and the first frame is hello', async (t) => {
  const b = await bootBot(t), c = await b.connect();
  assert.equal(c.headers['sec-websocket-protocol'], 'foxfleet.bot.v1');
  const hello = await c.next((x) => x.t === 'hello');
  assert.deepEqual(hello, { t: 'hello', protocol: 'foxfleet.bot/1', bot: b.botId, resume_from: 0, latest_event_id: 0, heartbeat_ms: 25000,
    limits: { max_frame_bytes: 1048576, max_text_bytes: 65536, window: 100, max_unacked: 1000 } });
  assert.equal(c.texts[0].t, 'hello', 'hello comes first');
  const view = (await (await b.h.call('/api/agents/helper')).json()).agent;
  assert.equal(view.status, 'ready'); assert.equal(view.online, true); assert.equal(view.chatReady, true); assert.equal(view.checks.bot.ok, true);
});

test('admission refuses with a plain HTTP status: auth 401, query string 400, handshake 400, foreign origin or host 403', async (t) => {
  const b = await bootBot(t), p = b.h.port, fake = 'ffb_' + 'A'.repeat(43);
  const status = (options) => upgradeStatus(p, options);
  assert.equal(await status({ token: b.token }), 101, 'control: the good request is admitted');
  assert.equal(await status({}), 401, 'no Authorization');
  assert.equal(await status({ headers: { Authorization: 'Bot ffb_short' } }), 401, 'malformed token');
  assert.equal(await status({ headers: { Authorization: `Bot ${fake}` } }), 401, 'unknown token');
  assert.equal(await status({ headers: { Authorization: `Bearer ${b.token}` } }), 401, 'Bearer scheme');
  assert.equal(await status({ headers: { Authorization: `bot ${b.token}` } }), 401, 'scheme is case sensitive');
  assert.equal(await status({ token: b.token, path: `/api/bot/ws?token=${b.token}` }), 400, 'token in the query string');
  assert.equal(await status({ token: b.token, path: '/api/bot/ws?' }), 400, 'any query string');
  assert.equal(await status({ token: b.token, headers: { 'Sec-WebSocket-Protocol': undefined } }), 400, 'no subprotocol');
  assert.equal(await status({ token: b.token, headers: { 'Sec-WebSocket-Protocol': 'other' } }), 400, 'wrong subprotocol');
  assert.equal(await status({ token: b.token, headers: { 'Sec-WebSocket-Version': '12' } }), 400, 'wrong version');
  assert.equal(await status({ token: b.token, headers: { 'Sec-WebSocket-Key': 'nope' } }), 400, 'bad key');
  assert.equal(await status({ token: b.token, headers: { Origin: 'https://evil.example' } }), 403, 'foreign Origin');
  assert.equal(await status({ token: b.token, headers: { Host: 'evil.example' } }), 403, 'untrusted Host');
  assert.equal(await status({ token: b.token, path: '/api/bot/ws/extra' }), 404, 'only the exact path');
});

test('transport security: loopback peers with a loopback host or https proxy, or https for a trusted origin; never plain http from the network', () => {
  const trusted = new Set(['https://hub.example.com']);
  const ok = (o) => secureBotRequest({ trusted, ...o });
  assert.equal(ok({ remoteAddress: '127.0.0.1', host: '127.0.0.1:3080' }), true, 'loopback peer, loopback host');
  assert.equal(ok({ remoteAddress: '::1', host: '[::1]:3080' }), true);
  assert.equal(ok({ remoteAddress: '::ffff:127.0.0.1', host: 'localhost:3080' }), true);
  assert.equal(ok({ remoteAddress: '127.0.0.1', host: 'hub.example.com', xfp: 'https' }), true, 'local reverse proxy terminating TLS');
  assert.equal(ok({ remoteAddress: '127.0.0.1', host: 'hub.example.com' }), false, 'local proxy without https');
  assert.equal(ok({ remoteAddress: '192.168.1.20', host: '192.168.1.5:3080' }), false, 'network, plain http');
  assert.equal(ok({ remoteAddress: '192.168.1.20', host: '127.0.0.1:3080' }), false, 'network peer claiming a loopback host');
  assert.equal(ok({ remoteAddress: '203.0.113.9', host: 'hub.example.com', xfp: 'https' }), true, 'https forwarded for a trusted origin');
  assert.equal(ok({ remoteAddress: '203.0.113.9', host: 'other.example.com', xfp: 'https' }), false, 'https forwarded from the network without a trusted origin');
  assert.equal(ok({ remoteAddress: '203.0.113.9', host: 'hub.example.com', xfp: 'http' }), false);
  assert.equal(secureBotRequest({ remoteAddress: '10.0.0.2', host: 'hub.example.com', xfp: 'https' }), false, 'no trusted origins configured');
});

test('one connection per bot: a second connection with the same token replaces the first (4009)', async (t) => {
  const b = await bootBot(t), first = await b.connect(); await first.next((x) => x.t === 'hello');
  const second = await b.connect(); await second.next((x) => x.t === 'hello');
  const closed = await first.waitClose(); assert.equal(closed.code, 4009);
  second.send({ t: 'ping', id: 'p1' }); await second.next((x) => x.t === 'pong' && x.id === 'p1');
  assert.equal(second.close, null, 'the newer connection stays open');
});

test('rotating the token closes the live socket with 4001; the old token is refused, also after a hub restart', async (t) => {
  const b = await bootBot(t), live = await b.connect(); await live.next((x) => x.t === 'hello');
  const fresh = await b.remint();
  assert.equal((await live.waitClose()).code, 4001);
  assert.equal(await upgradeStatus(b.h.port, { token: b.token }), 401, 'old token');
  assert.equal(await upgradeStatus(b.h.port, { token: fresh }), 101, 'new token');
  await b.h.restart();
  assert.equal(await upgradeStatus(b.h.port, { token: b.token }), 401, 'old token after restart');
  await assert.rejects(b.connect(), { status: 401 });
  const c = await botSocket(t, b.h.port, fresh); await c.next((x) => x.t === 'hello');
});

test('revoking the token closes the socket with 4001 and the token then gets 401', async (t) => {
  const b = await bootBot(t), live = await b.connect(); await live.next((x) => x.t === 'hello');
  assert.equal((await b.h.call('/api/agents/helper/bot-token', { method: 'DELETE' })).status, 200);
  assert.equal((await live.waitClose()).code, 4001);
  assert.equal(await upgradeStatus(b.h.port, { token: b.token }), 401);
});

const exists = (file) => access(file).then(() => true, () => false);
const storeShape = (extra) => ({ v: 1, next_event_id: 1, acked: 0, events: [], chats: {}, messages: {}, idem: {}, clients: {}, commands: [], ...extra });

test('hello carries the persisted ack and latest event id of the bot store', async (t) => {
  const b = await bootBot(t); await mkdir(path.join(b.h.dir, 'bot'), { recursive: true });
  await writeFile(path.join(b.h.dir, 'bot', `${b.botId}.json`), JSON.stringify(storeShape({ next_event_id: 8, acked: 5 })));
  const c = await b.connect(); const hello = await c.next((x) => x.t === 'hello');
  assert.equal(hello.resume_from, 5); assert.equal(hello.latest_event_id, 7);
});

test('deleting the agent closes the socket with 4003, deletes its store file and refuses the token', async (t) => {
  const b = await bootBot(t), file = path.join(b.h.dir, 'bot', `${b.botId}.json`);
  await writeFile(file, JSON.stringify(storeShape()));
  const live = await b.connect(); await live.next((x) => x.t === 'hello');
  assert.equal((await b.h.call('/api/connections/helper', { method: 'DELETE' })).status, 200);
  assert.equal((await live.waitClose()).code, 4003);
  assert.equal(await exists(file), false, 'store file is gone');
  assert.equal(JSON.parse(await readFile(path.join(b.h.dir, 'bot', 'tokens.json'), 'utf8')).tokens.length, 0, 'token revoked');
  assert.equal(await upgradeStatus(b.h.port, { token: b.token }), 401);
});

async function memberBot(t) {
  const h = await bootHub(t), alice = await member(h);
  assert.equal((await h.call('/api/connections', { token: alice.token, data: { kind: 'hermes', connection: 'bot', name: 'mine' } })).status, 201);
  const minted = await (await h.call('/api/agents/mine/bot-token', { token: alice.token, data: {} })).json();
  return { h, alice, token: minted.token, botId: minted.bot_id };
}

test('owner disables a member: its bot socket closes with 4003 and cannot reconnect until the member is enabled again', async (t) => {
  const m = await memberBot(t), live = await botSocket(t, m.h.port, m.token); await live.next((x) => x.t === 'hello');
  assert.equal((await m.h.call(`/api/admin/users/${m.alice.id}`, { method: 'PATCH', data: { disabled: true } })).status, 200);
  assert.equal((await live.waitClose()).code, 4003);
  assert.equal(await upgradeStatus(m.h.port, { token: m.token }), 401);
  assert.equal((await m.h.call(`/api/admin/users/${m.alice.id}`, { method: 'PATCH', data: { disabled: false } })).status, 200);
  const back = await botSocket(t, m.h.port, m.token); await back.next((x) => x.t === 'hello');
});

test('removing the member revokes its tokens and closes its bot sockets', async (t) => {
  const m = await memberBot(t), live = await botSocket(t, m.h.port, m.token); await live.next((x) => x.t === 'hello');
  assert.equal((await m.h.call(`/api/admin/users/${m.alice.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await live.waitClose()).code, 4003);
  assert.equal(JSON.parse(await readFile(path.join(m.h.dir, 'bot', 'tokens.json'), 'utf8')).tokens.length, 0);
  assert.equal(await upgradeStatus(m.h.port, { token: m.token }), 401);
});

test('frame shapes: not an object with a string t is bad_frame then 1008; unknown and reserved types answer and keep the socket open', async (t) => {
  const b = await bootBot(t);
  for (const bad of ['not json', '[1,2]', '"text"', '{"id":"x"}', '{"t":7}', 'null']) {
    const c = await b.connect(); await c.next((x) => x.t === 'hello');
    c.sendRaw(wsFrame(1, bad));
    const err = await c.next((x) => x.t === 'error'); assert.equal(err.code, 'bad_frame', bad);
    assert.equal((await c.waitClose()).code, 1008, bad);
  }
  const c = await b.connect(); await c.next((x) => x.t === 'hello');
  c.send({ t: 'no.such.thing', id: 'u1' }); assert.equal((await c.next((x) => x.t === 'error')).code, 'unknown_type');
  c.send({ t: 'media.upload', id: 'r1' }); assert.deepEqual((await c.next((x) => x.t === 'res' && x.id === 'r1')).error.code, 'unsupported');
  const res = await c.request({ t: 'card.send', id: 'r2', card: {} }); assert.equal(res.ok, false); assert.equal(res.error.code, 'unsupported');
  c.send({ t: 'message.react' }); assert.equal((await c.until(() => c.texts.filter((x) => x.t === 'error').at(-1)?.code === 'unsupported' && c.texts.at(-1))).t, 'error', 'reserved without an id is a bare error');
  c.send({ t: 'ping', id: 'p1' }); assert.deepEqual(await c.next((x) => x.t === 'pong'), { t: 'pong', id: 'p1' });
  c.send({ t: 'ping' }); await c.until(() => c.texts.some((x) => x.t === 'pong' && !('id' in x)));
  c.send({ t: 'pong' }); c.send({ t: 'ping', id: 'p2' }); await c.next((x) => x.t === 'pong' && x.id === 'p2');
  c.send({ t: 'ping', id: 'bad id!' }); assert.equal((await c.next((x) => x.t === 'error' && x.code === 'invalid_request')).t, 'error');
  assert.equal(c.close, null, 'still open');
});

test('when the bot closes its TCP connection without a close frame the agent is offline right away', async (t) => {
  const b = await bootBot(t), c = await b.connect(); await c.next((x) => x.t === 'hello');
  const online = async () => (await (await b.h.call('/api/agents/helper')).json()).agent.online;
  assert.equal(await online(), true);
  c.socket.end();
  const end = Date.now() + 1500; let now = true;
  while (now && Date.now() < end) { now = await online(); if (now) await new Promise((r) => setTimeout(r, 10)); }
  assert.equal(now, false);
});
