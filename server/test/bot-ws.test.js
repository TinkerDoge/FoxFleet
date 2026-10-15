// The safe RFC 6455 receiver for the bot socket (bot-ws.js), driven with raw bytes over loopback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptBotSocket, checkHandshake } from '../bot-ws.js';
import { wsFixture, wsFrame, textFrame, closeFrame, acceptKey } from './bot-helpers.js';

const fixture = (t, opts, extra) => wsFixture(t, acceptBotSocket, { checkHandshake, opts, ...extra });

test('handshake: 101 echoes the subprotocol and the accept key; bytes that arrive with the upgrade are processed after hello', async (t) => {
  const fx = await fixture(t, {}, { hello: { t: 'hello', n: 1 } });
  const c = await fx.connect({ extra: textFrame({ t: 'ping', id: 'early' }) });
  assert.equal(c.headers['sec-websocket-protocol'], 'foxfleet.bot.v1'); assert.equal(c.headers['sec-websocket-accept'], acceptKey(c.key));
  await c.until(() => c.texts.length >= 1); assert.deepEqual(c.texts[0], { t: 'hello', n: 1 }, 'hello is the first frame');
  await fx.until(() => fx.messages.length === 1); assert.deepEqual(JSON.parse(fx.messages[0]), { t: 'ping', id: 'early' });
});

const protocolErrors = {
  'unmasked frame': () => wsFrame(1, '{"t":"ping"}', { mask: false }),
  'RSV bit set': () => wsFrame(1, '{"t":"ping"}', { rsv: 0x40 }),
  'reserved opcode 3': () => wsFrame(3, 'x'),
  'reserved opcode 11': () => wsFrame(11, 'x'),
  'control frame over 125 bytes': () => wsFrame(9, Buffer.alloc(126, 1)),
  'fragmented control frame': () => wsFrame(9, 'x', { fin: false }),
  'continuation without a start': () => wsFrame(0, 'x'),
  'new data frame inside a fragmented message': () => Buffer.concat([wsFrame(1, '{"t":', { fin: false }), wsFrame(1, '"ping"}')]),
  'close frame with a 1-byte payload': () => wsFrame(8, Buffer.from([3])),
  'close frame with a forbidden code': () => closeFrame(1005),
};
for (const [name, bytes] of Object.entries(protocolErrors)) {
  test(`framing error closes with 1002: ${name}`, async (t) => {
    const fx = await fixture(t, {}, { hello: null }), c = await fx.connect();
    c.sendRaw(bytes());
    assert.equal((await c.waitClose()).code, 1002);
    await fx.until(() => fx.closes.length === 1); assert.equal(fx.closes[0][0], 1002); assert.equal(fx.messages.length, 0);
    await new Promise((r) => setTimeout(r, 30)); assert.equal(fx.closes.length, 1, 'onClose fires once');
  });
}

const MIB = 1024 * 1024;
const dataErrors = {
  'declared 64-bit length over 1 MiB (body never sent)': [1009, () => wsFrame(1, '', { declare: MIB + 1 })],
  'declared 64-bit length with the high bit set': [1009, () => { const f = wsFrame(1, '', { declare: 70000 }); f.writeBigUInt64BE(2n ** 63n, 2); return f; }],
  'fragments adding up to more than 1 MiB': [1009, () => Buffer.concat([0, 1, 2].map((i) => wsFrame(i === 0 ? 1 : 0, Buffer.alloc(400 * 1024, 0x61), { fin: false })))],
  'binary message': [1003, () => wsFrame(2, Buffer.from([1, 2, 3]))],
  'invalid UTF-8 text': [1007, () => wsFrame(1, Buffer.from([0x7b, 0xff, 0xfe, 0x7d]))],
  'invalid UTF-8 split across fragments': [1007, () => Buffer.concat([wsFrame(1, Buffer.from([0xc3]), { fin: false }), wsFrame(0, Buffer.from([0x28]))])],
  'close frame with invalid UTF-8 reason': [1007, () => wsFrame(8, Buffer.concat([Buffer.from([0x03, 0xe8]), Buffer.from([0xff])]))],
};
for (const [name, [code, bytes]] of Object.entries(dataErrors)) {
  test(`size and type limits close with ${code}: ${name}`, async (t) => {
    const fx = await fixture(t, {}, { hello: null }), c = await fx.connect();
    c.sendRaw(bytes());
    assert.equal((await c.waitClose()).code, code);
    await fx.until(() => fx.closes.length === 1); assert.equal(fx.closes[0][0], code); assert.equal(fx.messages.length, 0);
  });
}

test('a message exactly at the limit and a valid multi-byte fragmented message are delivered', async (t) => {
  const fx = await fixture(t, { maxMessageBytes: 70000 }, { hello: null }), c = await fx.connect();
  const word = Buffer.from('héllo wörld ✓'), cut = word.indexOf(0xc3) + 1;
  c.sendRaw(Buffer.concat([wsFrame(1, word.subarray(0, cut), { fin: false }), wsFrame(0, word.subarray(cut))]));
  c.sendRaw(wsFrame(1, 'x'.repeat(70000)));
  await fx.until(() => fx.messages.length === 2); assert.equal(fx.messages[0], 'héllo wörld ✓'); assert.equal(fx.messages[1].length, 70000);
  c.sendRaw(wsFrame(1, 'x'.repeat(70001))); assert.equal((await c.waitClose()).code, 1009, 'one byte over the (small) limit');
});

test('a valid close is echoed once; onClose fires exactly once even if close() is also called', async (t) => {
  const fx = await fixture(t, {}, { hello: null }), c = await fx.connect();
  c.sendRaw(closeFrame(1000, 'bye'));
  assert.equal((await c.waitClose()).code, 1000);
  await fx.until(() => fx.closes.length === 1); fx.conn.close(4001, 'late'); fx.conn.close(1000);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(fx.closes.map((x) => x[0]), [1000]);
  assert.equal(c.frames.filter((f) => f.opcode === 8).length, 1, 'exactly one close frame went out');
});

test('server initiated close sends its code once; a peer that never answers is dropped after about a second', async (t) => {
  const fx = await fixture(t, {}, { hello: null }), c = await fx.connect({ echoClose: false });
  await fx.until(() => fx.conn); fx.conn.close(4009, 'replaced'); fx.conn.close(4001);
  const closed = await c.waitClose(); assert.deepEqual([closed.code, closed.reason], [4009, 'replaced']);
  assert.deepEqual(fx.closes, [[4009, 'replaced']]); assert.equal(c.frames.filter((f) => f.opcode === 8).length, 1);
  fx.conn.send({ t: 'late' }); await new Promise((r) => setTimeout(r, 20)); assert.ok(!c.texts.some((x) => x.t === 'late'), 'nothing is sent after close');
  assert.equal(fx.socket.destroyed, false, 'given a moment to answer'); await fx.until(() => fx.socket.destroyed, 2500);
});

test('ping is answered with a pong carrying the same payload; a pong is ignored', async (t) => {
  const fx = await fixture(t, {}, { hello: null }), c = await fx.connect();
  c.sendRaw(Buffer.concat([wsFrame(9, 'are you there'), wsFrame(10, 'unsolicited')]));
  await c.until(() => c.frames.find((f) => f.opcode === 10));
  assert.equal(c.frames.find((f) => f.opcode === 10).data.toString(), 'are you there');
  assert.equal(c.frames.filter((f) => f.opcode === 10).length, 1); assert.equal(fx.closes.length, 0);
});

test('heartbeat: the hub pings; a silent peer is closed with 1001 after three intervals; a ponging peer stays', async (t) => {
  const fx = await fixture(t, { heartbeatMs: 40 }, { hello: null }), quiet = await fx.connect({ pong: false });
  const started = Date.now(); const closed = await quiet.waitClose(2000);
  assert.equal(closed.code, 1001); assert.ok(quiet.frames.some((f) => f.opcode === 9), 'pings were sent'); assert.ok(Date.now() - started >= 100, 'not before three intervals');
  const fx2 = await fixture(t, { heartbeatMs: 40 }, { hello: null }), live = await fx2.connect();
  await new Promise((r) => setTimeout(r, 400)); assert.equal(live.close, null, 'answering pings keeps the socket open'); assert.equal(fx2.closes.length, 0);
});

test('inbound back-pressure: messages are handled strictly in order, one at a time; more than 64 waiting pauses the socket until drained', async (t) => {
  let release, running = 0, overlap = 0; const gate = new Promise((r) => { release = r; }), handled = [];
  const fx = await fixture(t, { onMessage: async (text) => { running++; overlap = Math.max(overlap, running); if (handled.length === 0) await gate; else await new Promise((r) => setImmediate(r)); handled.push(JSON.parse(text).n); running--; } }, { hello: null });
  const c = await fx.connect();
  c.sendRaw(Buffer.concat(Array.from({ length: 100 }, (_, n) => textFrame({ t: 'ping', n }))));
  await fx.until(() => fx.conn.paused); assert.equal(fx.socket.isPaused(), true); assert.equal(handled.length, 0, 'the first message is still being handled');
  release(); await fx.until(() => handled.length === 100);
  assert.deepEqual(handled, Array.from({ length: 100 }, (_, n) => n)); assert.equal(overlap, 1); assert.equal(fx.conn.paused, false); assert.equal(fx.socket.isPaused(), false);
  assert.equal(fx.closes.length, 0);
});

test('a handler that throws closes the connection with 1011', async (t) => {
  const fx = await fixture(t, { onMessage: async () => { throw new Error('boom'); } }, { hello: null }), c = await fx.connect();
  c.send({ t: 'ping' }); assert.equal((await c.waitClose()).code, 1011);
});

test('outbound back-pressure: more than maxBufferedBytes waiting for a peer that does not read closes with 1013', async (t) => {
  const fx = await fixture(t, { maxBufferedBytes: 64 * 1024 }, { hello: null }), c = await fx.connect();
  c.socket.pause();
  const chunk = { t: 'blob', pad: 'x'.repeat(256 * 1024) };
  for (let i = 0; i < 400 && fx.closes.length === 0; i++) { fx.conn.send(chunk); if (i % 10 === 0) await new Promise((r) => setImmediate(r)); }
  assert.equal(fx.closes[0]?.[0], 1013);
  c.socket.resume(); assert.equal((await c.waitClose(5000)).code, 1013);
});

const goodHeaders = () => ({ upgrade: 'websocket', connection: 'keep-alive, Upgrade', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-protocol': 'chat, foxfleet.bot.v1' });
test('checkHandshake accepts a good request and refuses (400) a missing/bad key, wrong version, missing subprotocol, bad upgrade tokens or method', () => {
  assert.equal(checkHandshake({ method: 'GET', headers: goodHeaders() }), null);
  const bad = (change, method = 'GET') => checkHandshake({ method, headers: { ...goodHeaders(), ...change } });
  assert.equal(bad({ 'sec-websocket-key': undefined }), 400);
  assert.equal(bad({ 'sec-websocket-key': 'short' }), 400);
  assert.equal(bad({ 'sec-websocket-key': Buffer.alloc(15).toString('base64') }), 400, 'key must decode to 16 bytes');
  assert.equal(bad({ 'sec-websocket-version': '8' }), 400);
  assert.equal(bad({ 'sec-websocket-version': undefined }), 400);
  assert.equal(bad({ 'sec-websocket-protocol': undefined }), 400);
  assert.equal(bad({ 'sec-websocket-protocol': 'foxfleet.bot.v2, other' }), 400);
  assert.equal(bad({ upgrade: 'h2c' }), 400);
  assert.equal(bad({ connection: 'keep-alive' }), 400);
  assert.equal(bad({}, 'POST'), 400);
});

test('a peer that half-closes the TCP connection without a close frame ends the connection at once (1006, socket destroyed)', async (t) => {
  const fx = await fixture(t, {}, { hello: null }), c = await fx.connect(); await fx.until(() => fx.conn);
  c.socket.end();
  await fx.until(() => fx.closes.length === 1, 1000); assert.equal(fx.closes[0][0], 1006);
  await fx.until(() => fx.socket.destroyed, 1000);
  await new Promise((r) => setTimeout(r, 30)); assert.equal(fx.closes.length, 1);
});
