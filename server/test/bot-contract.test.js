// contract/bot-frames.vectors.json and contract/bot-api.md against the code: validator verdicts, the frames a real hub emits, and the documented names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PROTOCOL, SUBPROTOCOL, RESERVED, BOT_REQUESTS, ERROR_CODES, CLOSE, validateRequest } from '../bot-protocol.js';
import { bootBot } from './bot-helpers.js';

const root = new URL('../../contract/', import.meta.url);
const vectors = JSON.parse(await readFile(new URL('bot-frames.vectors.json', root), 'utf8'));
const doc = await readFile(new URL('bot-api.md', root), 'utf8');

test('vectors: protocol names match the code', () => { assert.equal(vectors.protocol, PROTOCOL); assert.equal(vectors.subprotocol, SUBPROTOCOL); });

test('vectors: every valid frame is accepted by validateRequest and carries its own type', () => {
  assert.ok(vectors.valid.length >= BOT_REQUESTS.length);
  for (const { name, frame } of vectors.valid) { const v = validateRequest(frame); assert.equal(v.ok, true, name); assert.equal(v.t, frame.t, name); }
  for (const t of BOT_REQUESTS) assert.ok(vectors.valid.some((x) => x.frame.t === t), `a valid vector for ${t}`);
});

test('vectors: every invalid frame is refused with exactly its documented code', () => {
  for (const { name, frame, code } of vectors.invalid) { const v = validateRequest(frame); assert.equal(v.ok, false, name); assert.equal(v.code, code, name); assert.ok(ERROR_CODES.includes(code), name); }
  for (const t of RESERVED) assert.ok(vectors.invalid.some((x) => x.frame.t === t && x.code === 'unsupported'), `a reserved vector for ${t}`);
  for (const code of ['unsupported', 'unknown_type', 'invalid_request', 'too_large', 'not_found']) assert.ok(vectors.invalid.some((x) => x.code === code), `an invalid vector for ${code}`);
  assert.ok(vectors.invalid.some((x) => x.frame.id === undefined && x.frame.t === 'message.send'), 'missing id is covered');
});

test('vectors: models.set provider and model count limits', () => {
  const frame = (providers) => ({ t: 'models.set', id: 'm', providers });
  assert.equal(validateRequest(frame(Array.from({ length: 60 }, (_, i) => ({ slug: `p${i}` })))).ok, true);
  const overP = validateRequest(frame(Array.from({ length: 61 }, (_, i) => ({ slug: `p${i}` }))));
  assert.equal(overP.ok, false); assert.equal(overP.code, 'invalid_request');
  assert.equal(validateRequest(frame([{ slug: 'x', models: Array.from({ length: 300 }, (_, i) => `m${i}`) }])).ok, true);
  const overM = validateRequest(frame([{ slug: 'x', models: Array.from({ length: 301 }, (_, i) => `m${i}`) }]));
  assert.equal(overM.ok, false); assert.equal(overM.code, 'invalid_request');
});

const shape = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, k === 'result' ? 'result' : shape(v[k])])) : typeof v);
const example = (name) => vectors.hub_frames.find((x) => x.name === name)?.frame;

test('hub frames: the examples have exactly the field set a real hub emits', async (t) => {
  const b = await bootBot(t), c = await b.connect(), real = {};
  real.hello = await c.next((x) => x.t === 'hello');
  const user = await (await b.h.call('/api/agents/helper/messages', { data: { messages: [{ role: 'user', content: 'hello' }] } })).json();
  real['message.new'] = await c.next((x) => x.t === 'message.new');
  const send = { t: 'message.send', id: 'r1', chat_id: user.session_id, text: 'hi', idempotency_key: 'k1' };
  real['res ok (message.send)'] = await c.request(send);
  real['res ok replayed'] = await c.request({ ...send, id: 'r2' });
  real['res error'] = await c.request({ t: 'message.send', id: 'r3', chat_id: 'fc_AAAAAAAAAAAAAAAA', text: 'x' });
  c.send({ t: 'nope' }); real.error = await c.next((x) => x.t === 'error');
  c.send({ t: 'ping', id: 'p1' }); real['pong with id'] = await c.next((x) => x.t === 'pong' && x.id === 'p1');
  c.send({ t: 'ping' }); real['pong without id'] = await c.until(() => c.texts.find((x) => x.t === 'pong' && !('id' in x)));
  const limited = await bootBot(t, { botOptions: { rate: { burst: 1, perSec: 0.001 } } }), lc = await limited.connect(); await lc.next((x) => x.t === 'hello');
  const chat = (await (await limited.h.call('/api/agents/helper/messages', { data: { messages: [{ role: 'user', content: 'x' }] } })).json()).session_id;
  await lc.request({ t: 'message.send', id: 'a', chat_id: chat, text: '1' }); real['res error rate_limited'] = await lc.request({ t: 'message.send', id: 'b', chat_id: chat, text: '2' });
  for (const { name } of vectors.hub_frames) { assert.ok(real[name], `a real frame was captured for "${name}"`); assert.deepEqual(shape(example(name)), shape(real[name]), name); }
  assert.equal(real.hello.protocol, PROTOCOL); assert.deepEqual(Object.keys(real.hello.limits).sort(), Object.keys(example('hello').limits).sort());
});

test('documentation: every reserved name, request type, error code and close code appears in contract/bot-api.md', () => {
  for (const name of [...RESERVED, ...BOT_REQUESTS, ...ERROR_CODES]) assert.ok(doc.includes(name), `${name} is documented`);
  for (const [label, code] of Object.entries(CLOSE)) assert.match(doc, new RegExp(`\\b${code}\\b`), `close code ${code} (${label}) is documented`);
  for (const word of [PROTOCOL, SUBPROTOCOL, 'bot-frames.vectors.json']) assert.ok(doc.includes(word), word);
});
