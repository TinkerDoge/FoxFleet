import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { HTTP_REQUESTS, validateHttpRequest } from '../bot-protocol.js';
import { bootBot } from './bot-helpers.js';
import { validate } from '../../contract/validate.mjs';
const root = new URL('../../contract/', import.meta.url);

test('HTTP machine contract vectors classify frames and exercise the real endpoint', async (t) => {
  const text = await readFile(new URL('bot-http.vectors.json', root), 'utf8').catch(() => null);
  assert.ok(text, 'the HTTP transport needs its machine-readable contract vectors');
  const vectors = JSON.parse(text); assert.equal(vectors.path, '/api/bot/rpc'); assert.equal(vectors.method, 'POST');
  assert.deepEqual(vectors.allowed, HTTP_REQUESTS);
  const spec = JSON.parse(await readFile(new URL('openapi.json', root), 'utf8'));
  const op = spec.paths[vectors.path]?.post; assert.ok(op, 'new endpoint is declared in OpenAPI too');
  assert.deepEqual(op.security, [{ botToken: [] }]);
  for (const status of Object.values(vectors.statuses)) assert.ok(op.responses[String(status)], 'declared status ' + status);
  const b = await bootBot(t), chat = (await (await b.h.call('/api/agents/helper/messages', { data: { messages: [{ role: 'user', content: 'contract' }] } })).json()).session_id;
  let message = 'fm_BBBBBBBBBBBBBBBB';
  for (const { name, frame, code, ok, response_id } of vectors.frames) {
    const v = validateHttpRequest(frame); assert.equal(v.ok, ok, name); assert.equal(v.id, response_id, name); if (!ok) assert.equal(v.code, code, name);
    const actual = JSON.parse(JSON.stringify(frame).replaceAll('fc_AAAAAAAAAAAAAAAA', chat).replaceAll('fm_BBBBBBBBBBBBBBBB', message));
    const res = await b.h.call(vectors.path, { data: actual, headers: { Authorization: `Bot ${b.token}` } });
    assert.equal(res.status, 200, name); assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json(); assert.deepEqual(validate(op.responses['200'].content['application/json'].schema, body, spec), [], name);
    assert.equal(body.t, 'res', name); assert.equal(body.id, response_id, name); assert.equal(body.ok, ok, name);
    if (!ok) assert.equal(body.error.code, code, name); else if (frame.t === 'message.send') message = body.result.message_id;
  }
  const doc = await readFile(new URL('bot-api.md', root), 'utf8');
  for (const term of [vectors.path, 'bot-http.vectors.json', 'id: null', '413', '415', 'non-displacing']) assert.ok(doc.includes(term), term + ' is documented');
});
