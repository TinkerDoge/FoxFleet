// The 0.4.0 routes and live v2 payloads checked against contract/openapi.json (the shared run.mjs scenario stays as is; these
// routes are hub-side, so they are checked here against the real hub). Also: every new error code is documented in the spec.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validate } from '../../contract/validate.mjs';
import { hub, hermes, sse, login, PASS } from './live2-helpers.js';

const spec = JSON.parse(readFileSync(new URL('../../contract/openapi.json', import.meta.url), 'utf8'));
const schemaOf = (p, method, status) => { const r = spec.paths[p][method].responses[String(status)]; return r.content?.['application/json']?.schema ?? spec.components.responses.Error.content['application/json'].schema; };
const check = (schema, value, what) => { const errs = validate(schema, value, spec); assert.deepEqual(errs, [], `${what}: ${errs.join('; ')}`); };
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });

test('contract: chats, read, live events, history numbering and notify reply match openapi.json; routes are marked implemented', async (t) => {
  for (const [p, item] of Object.entries(spec.paths)) for (const op of Object.values(item)) if (op['x-foxfleet-status']) assert.equal(op['x-foxfleet-status'], 'implemented (0.4.0-alpha)', p);
  for (const f of ['live2', 'chats', 'readReceipts', 'notifyReply']) assert.ok(JSON.stringify(spec).includes(`"${f}"`), f);
  const { mock } = await hermes(t, { messages: [{ id: 1, role: 'user', content: 'q' }, { id: 2, role: 'assistant', content: 'a' }], sessions: [] });
  const x = await hub(t, { password: PASS }), a = await login(x.base), h = { headers: a.h };
  await x.call('/api/connections', { ...mock.connection, name: 'atlas' }, h);
  const list = await x.call('/api/chats', undefined, h); check(schemaOf('/api/chats', 'get', 200), list.body, 'listChats');
  const s = sse(t, `${x.base}/api/live/stream?v=2&since=${list.body.cursor}`, a.h); await s.wait((f) => f.event === 'foxfleet.ready');
  const hist = await x.call('/api/agents/atlas/sessions/sess-1/messages', undefined, h); check(schemaOf('/api/agents/{name}/sessions/{id}/messages', 'get', 200), hist.body, 'history'); assert.equal(hist.body.messages[1].n, 2);
  const reply = await x.call('/api/notify/reply', { agent: 'atlas', chat: 'sess-1', text: 'go', idempotency_key: 'contract-1' }, h); assert.equal(reply.status, 202); check(schemaOf('/api/notify/reply', 'post', 202), reply.body, 'notifyReply 202');
  const dup = await x.call('/api/notify/reply', { agent: 'atlas', chat: 'sess-1', text: 'go', idempotency_key: 'contract-1' }, h); check(schemaOf('/api/notify/reply', 'post', 200), dup.body, 'notifyReply 200');
  const conflict = await x.call('/api/notify/reply', { agent: 'atlas', chat: 'sess-1', text: 'stop', idempotency_key: 'contract-1' }, h); check(schemaOf('/api/notify/reply', 'post', 409), conflict.body, 'notifyReply 409');
  await s.wait((f) => f.event === 'run.finished');
  check(schemaOf('/api/chats/{agent}', 'get', 200), (await x.call('/api/chats/atlas', undefined, h)).body, 'getChat');
  check(schemaOf('/api/chats/{agent}/archive', 'put', 200), (await x.call('/api/chats/atlas/archive', { archived: true }, { ...h, method: 'PUT' })).body, 'archiveChat');
  check(schemaOf('/api/chats/{agent}/unread', 'put', 200), (await x.call('/api/chats/atlas/unread', { unread: true }, { ...h, method: 'PUT' })).body, 'markChatUnread');
  check(schemaOf('/api/chats/{agent}/read', 'post', 200), (await x.call('/api/chats/atlas/read', { chat: 'sess-1', up_to: 1 }, h)).body, 'markChatRead');
  check(schemaOf('/api/notify/read', 'post', 200), (await x.call('/api/notify/read', { agent: 'atlas', chat: 'sess-1' }, h)).body, 'notifyRead');
  const pulled = await x.call(`/api/live/events?since=${list.body.cursor}`, undefined, h); check(schemaOf('/api/live/events', 'get', 200), pulled.body, 'liveEvents');
  const types = new Set(pulled.body.events.map((e) => e.type)); for (const ty of ['message.new', 'message.status', 'read', 'chat.updated', 'run.started', 'run.finished']) assert.ok(types.has(ty), ty);
  for (const e of pulled.body.events) check(ref('LiveEvent'), e, `event ${e.type}`);
  for (const f of s.frames.filter((y) => y.event === 'typing')) check(ref('TypingEvent'), f.data, 'typing');
  for (const f of s.events()) check(ref('LiveEvent'), f.data, `stream ${f.event}`);
  const gone = await x.call('/api/live/events?since=nope0000:1', undefined, h); assert.equal(gone.status, 410); check(schemaOf('/api/live/events', 'get', 410), gone.body, '410');
  const codes = spec.components.schemas.Error.properties.code.description;
  for (const c of ['unsupported_version', 'invalid_cursor', 'cursor_expired', 'too_many_streams', 'chat_not_found', 'invalid_read_position', 'invalid_idempotency_key', 'idempotency_conflict', 'reply_token_invalid', 'text_too_long', 'rate_limited']) assert.ok(codes.includes(c), c);
});
