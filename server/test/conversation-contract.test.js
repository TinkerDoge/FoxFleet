// The frozen foxfleet.bot/1.2 room contract: one schema, one vector set, one set of documented names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validateRequest } from '../bot-protocol.js';

const root = new URL('../../contract/', import.meta.url);
const read = (name) => readFile(new URL(name, root), 'utf8').catch(() => null);
const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };

const [vectorsText, schemaText, doc, openapiText, live, errors] = await Promise.all([
  read('bot-frames.vectors.json'), read('rooms-frames.schema.json'), read('bot-api.md'),
  read('openapi.json'), read('../docs/LIVE-EVENTS.md'), read('../docs/API-ERRORS.md'),
]);
const vectors = parse(vectorsText);
const schema = parse(schemaText);
const spec = parse(openapiText);

const V12 = 'foxfleet.bot/1.2';
const SUB12 = 'foxfleet.bot.v1.2';
const FEATURES = ['stop', 'cards', 'media', 'groups'];
const ERROR_CODES = ['invalid_request', 'not_found', 'forbidden', 'unsupported', 'too_large'];
const LIMITS = {
  max_frame_bytes: 1048576, max_text_bytes: 65536, window: 100, max_unacked: 1000,
  max_mentions: 64, max_actor_name_chars: 256, max_conversation_title_chars: 256,
  max_room_members: 100, max_handoff_dispatches_per_root: 4, handoff_chain_ttl_ms: 300000, max_rooms: 500,
};
// The 1.0/1.1 byte-for-byte legacy contract. Only the additive `rooms` block may change.
const LEGACY_HASH = '33f9cd256161676b995f65e64646ac093be6b079c79d1894a39c2db06a6f269a';
const legacyHash = (v) => createHash('sha256').update(JSON.stringify({ valid: v.valid, invalid: v.invalid, hub_frames: v.hub_frames })).digest('hex');

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const CHAT_ID = /^fc_[A-Za-z0-9_-]{16}$/;
const THREAD_ID = /^fcr_[A-Za-z0-9_-]{16}$/;
const MESSAGE_ID = /^fm_[A-Za-z0-9_-]{16}$/;
const DISPATCH_ID = /^fd_[A-Za-z0-9_-]{16}$/;
const STOP_ID = /^fs_[A-Za-z0-9_-]{16}$/;
const CARD_CALLBACK_ID = /^fcb_[A-Za-z0-9_-]{16}$/;
const AGENT_REF = /^agent:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// A small JSON-Schema (2020-12 subset) reader: the same schema file the hub, plugin, web and Android consume.
function schemaErrors(defs, node, value, at = '$') {
  const errors = [];
  const walk = (s, v, p) => {
    if (!s || s === true) return;
    if (s.$ref) return walk(defs[s.$ref.split('/').pop()], v, p);
    if (s.oneOf || s.anyOf) {
      const alts = s.oneOf ?? s.anyOf;
      if (!alts.some((a) => schemaErrors(defs, a, v, p).length === 0)) errors.push(`${p}: matches none of the alternatives`);
      return;
    }
    if (s.type) {
      const types = [].concat(s.type);
      const t = v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v;
      if (!types.some((x) => x === t || (x === 'number' && t === 'integer'))) { errors.push(`${p}: expected ${types.join('|')}, got ${t}`); return; }
    }
    if (s.enum && !s.enum.includes(v)) errors.push(`${p}: ${JSON.stringify(v)} not in ${JSON.stringify(s.enum)}`);
    if (typeof v === 'string') {
      if (s.minLength !== undefined && v.length < s.minLength) errors.push(`${p}: shorter than ${s.minLength}`);
      if (s.maxLength !== undefined && v.length > s.maxLength) errors.push(`${p}: longer than ${s.maxLength}`);
      if (s.pattern && !new RegExp(s.pattern).test(v)) errors.push(`${p}: does not match ${s.pattern}`);
    }
    if (typeof v === 'number') {
      if (s.minimum !== undefined && v < s.minimum) errors.push(`${p}: below ${s.minimum}`);
      if (s.maximum !== undefined && v > s.maximum) errors.push(`${p}: above ${s.maximum}`);
    }
    if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < s.minItems) errors.push(`${p}: fewer than ${s.minItems} items`);
      if (s.maxItems !== undefined && v.length > s.maxItems) errors.push(`${p}: more than ${s.maxItems} items`);
      if (s.uniqueItems && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) errors.push(`${p}: items are not unique`);
      if (s.items) v.forEach((x, i) => walk(s.items, x, `${p}[${i}]`));
      if (s.contains && !v.some((x) => schemaErrors(defs, s.contains, x, p).length === 0)) errors.push(`${p}: no item matches contains`);
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const k of s.required ?? []) if (!(k in v)) errors.push(`${p}: missing required "${k}"`);
      for (const [k, sub] of Object.entries(s.properties ?? {})) if (k in v) walk(sub, v[k], `${p}.${k}`);
      if (s.additionalProperties === false) for (const k of Object.keys(v)) if (!(k in (s.properties ?? {}))) errors.push(`${p}: unexpected field "${k}"`);
      if (s.additionalProperties && typeof s.additionalProperties === 'object') for (const [k, x] of Object.entries(v)) if (!(k in (s.properties ?? {}))) walk(s.additionalProperties, x, `${p}.${k}`);
    }
  };
  walk(node, value, at);
  return errors;
}

const ID_FIELDS = [
  ['chat_id', CHAT_ID, 'not_found'], ['thread_id', THREAD_ID, 'not_found'],
  ['message_id', MESSAGE_ID, 'not_found'], ['source_message_id', MESSAGE_ID, 'not_found'],
  ['reply_to', MESSAGE_ID, 'not_found'], ['dispatch_id', DISPATCH_ID, 'not_found'],
  ['target_agent_id', AGENT_REF, 'not_found'], ['stop_id', STOP_ID, 'invalid_request'],
  ['callback_id', new RegExp(`${STOP_ID.source.slice(1, -1)}|${CARD_CALLBACK_ID.source.slice(1, -1)}`), 'invalid_request'],
];

function actorErrors(actor, name) {
  const out = [];
  if (!actor || typeof actor !== 'object') return out;
  if (actor.kind === 'agent') {
    if (actor.is_bot !== true) out.push({ code: 'forbidden', message: `${name}: an agent actor is a bot sender` });
    if (typeof actor.id !== 'string' || !AGENT_REF.test(actor.id)) out.push({ code: 'forbidden', message: `${name}: an agent actor id is agent:<id>` });
  }
  if (actor.kind === 'human') {
    if (actor.is_bot !== false) out.push({ code: 'forbidden', message: `${name}: a human actor is not a bot sender` });
    if (typeof actor.id === 'string' && actor.id.startsWith('agent:')) out.push({ code: 'forbidden', message: `${name}: a human actor id is not an agent ref` });
  }
  return out;
}

function spanErrors(text, mentions) {
  const out = [];
  if (!Array.isArray(mentions)) return out;
  if (mentions.length > 64) out.push({ code: 'invalid_request', message: 'more than 64 mentions' });
  const spans = [];
  for (const m of mentions) {
    if (!m || typeof m.offset !== 'number' || typeof m.length !== 'number') continue;
    if (m.offset < 0 || m.length < 1 || m.offset + m.length > text.length) { out.push({ code: 'invalid_request', message: 'mention span is out of range' }); continue; }
    const start = text.charCodeAt(m.offset), end = text.charCodeAt(m.offset + m.length - 1);
    if ((start >= 0xdc00 && start <= 0xdfff) || (end >= 0xd800 && end <= 0xdbff)) out.push({ code: 'invalid_request', message: 'mention span splits a surrogate pair' });
    spans.push([m.offset, m.offset + m.length]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i += 1) if (spans[i][0] < spans[i - 1][1]) out.push({ code: 'invalid_request', message: 'mention spans overlap' });
  return out;
}

// Schema plus the cross-field rules JSON Schema cannot express (actor kind, UTF-16 spans, same-room replies, negotiation).
function checkRoomFrame(frame, context = {}) {
  const out = [];
  if (context.subprotocol && context.subprotocol !== SUB12) out.push({ code: 'unsupported', message: 'group frames need ' + SUB12 });
  if (!frame || typeof frame !== 'object') return out;
  const name = context.schema ?? frame.t;
  if (schema?.frames?.[name]) {
    for (const e of schemaErrors(schema.definitions ?? {}, schema.frames[name], frame)) out.push({ code: 'invalid_request', message: e });
  } else out.push({ code: 'invalid_request', message: `no schema for ${name}` });

  for (const [field, re, code] of ID_FIELDS) if (field in frame && typeof frame[field] === 'string' && !re.test(frame[field])) out.push({ code, message: `invalid ${field}` });
  if (typeof frame.text === 'string' && Buffer.byteLength(frame.text) > LIMITS.max_text_bytes) out.push({ code: 'too_large', message: 'text is over max_text_bytes' });
  if ((frame.t === 'message.send' || frame.t === 'message.edit') && ('group_id' in frame || 'thread_id' in frame)) out.push({ code: 'unsupported', message: 'group_id/thread_id stay reserved on message send/edit' });
  for (const k of ['owner_id', 'owner', 'is_owner', 'ownerId']) if (k in frame) out.push({ code: 'forbidden', message: `${k} is never client-supplied` });

  out.push(...actorErrors(frame.actor, 'actor'), ...actorErrors(frame.member, 'member'));
  if (frame.t === 'chat.member' && frame.actor?.kind !== 'human') out.push({ code: 'forbidden', message: 'chat.member is performed by the human owner' });
  if (frame.t === 'chat.member' && frame.member?.kind !== 'agent') out.push({ code: 'forbidden', message: 'room members are agents' });
  if (frame.t === 'chat.stop' && frame.actor?.kind !== 'human') out.push({ code: 'forbidden', message: 'stop is owner-only' });
  if (frame.t === 'callback' && frame.actor?.kind !== 'human') out.push({ code: 'forbidden', message: 'a card tap is human' });
  if ((frame.t === 'card.send' || frame.t === 'card.close') && frame.actor_kind !== 'agent') out.push({ code: 'forbidden', message: 'cards are authored by an agent' });

  if (frame.t === 'callback.answer') {
    if (typeof frame.callback_id === 'string' && frame.callback_id.startsWith('fs_') && !['stopped', 'idle', 'refused', 'expired'].includes(frame.outcome)) out.push({ code: 'invalid_request', message: 'a stop answer uses a stop outcome' });
    if (typeof frame.callback_id === 'string' && frame.callback_id.startsWith('fcb_') && !['resolved', 'expired', 'refused'].includes(frame.outcome)) out.push({ code: 'invalid_request', message: 'a card answer uses a card outcome' });
  }
  if (frame.t === 'hello' && (!Array.isArray(frame.features) || !frame.features.includes('groups'))) out.push({ code: 'invalid_request', message: 'a 1.2 hello advertises groups' });

  out.push(...spanErrors(typeof frame.text === 'string' ? frame.text : '', frame.mentions));
  for (const m of frame.mentions ?? []) {
    if (typeof m?.id === 'string' && !AGENT_REF.test(m.id)) out.push({ code: 'not_found', message: 'unknown mention id' });
    if (Array.isArray(context.members) && m?.id && !context.members.includes(m.id)) out.push({ code: 'not_found', message: `${m.id} is not a room member` });
  }
  if (frame.reply_to && context.reply_chat_id && context.reply_chat_id !== frame.chat_id) out.push({ code: 'not_found', message: 'reply_to is not in this room' });
  return out;
}

test('rooms contract: 1.2 schema is present, versioned and distinct from v1/1.1', () => {
  assert.ok(schema, 'contract/rooms-frames.schema.json is the shared room contract');
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.protocol, V12);
  assert.equal(schema.subprotocol, SUB12);
  assert.notEqual(schema.protocol, 'foxfleet.bot/1');
  assert.notEqual(schema.protocol, 'foxfleet.bot/1.1');
  assert.deepEqual(schema.features, FEATURES);
  assert.deepEqual(schema.negotiation.client_offers, ['foxfleet.bot.v1.2', 'foxfleet.bot.v1.1', 'foxfleet.bot.v1']);
  assert.deepEqual(schema.negotiation.hub_preference, ['foxfleet.bot.v1.2', 'foxfleet.bot.v1.1', 'foxfleet.bot.v1']);
  for (const [k, v] of Object.entries(LIMITS)) assert.equal(schema.limits[k], v, `limit ${k}`);
});

test('rooms vectors: the additive block carries valid and invalid 1.2 frames', () => {
  assert.ok(vectors?.rooms, 'bot-frames.vectors.json carries a rooms block');
  assert.equal(vectors.rooms.protocol, V12);
  assert.equal(vectors.rooms.subprotocol, SUB12);
  assert.deepEqual(vectors.rooms.features, FEATURES);
  assert.ok(vectors.rooms.valid.length >= 15, `only ${vectors.rooms.valid?.length} valid room vectors`);
  assert.ok(vectors.rooms.invalid.length >= 25, `only ${vectors.rooms.invalid?.length} invalid room vectors`);
});

test('rooms vectors: every accepted frame matches the shared schema and its cross-field rules', () => {
  for (const { name, frame, context } of vectors.rooms.valid) {
    const errors = checkRoomFrame(frame, context);
    assert.deepEqual(errors, [], `${name}: ${JSON.stringify(errors)}`);
    assert.equal(frame.t, context?.schema ?? frame.t, name);
  }
  for (const t of Object.keys(schema.frames)) assert.ok(vectors.rooms.valid.some((x) => (x.context?.schema ?? x.frame.t) === t), `a valid vector for ${t}`);
});

test('rooms vectors: every rejected frame is refused with its documented code', () => {
  for (const { name, frame, code, context } of vectors.rooms.invalid) {
    const found = checkRoomFrame(frame, context);
    assert.ok(found.length > 0, `${name} was accepted`);
    assert.ok(found.some((e) => e.code === code), `${name}: expected ${code}, got ${JSON.stringify(found.map((e) => e.code))}`);
    assert.ok(ERROR_CODES.includes(code), `${name}: ${code} is a documented 1.2 error code`);
  }
  for (const code of ERROR_CODES) assert.ok(vectors.rooms.invalid.some((x) => x.code === code), `an invalid room vector for ${code}`);
  for (const rule of ['actor_mismatch', 'forged_owner', 'mention_span', 'mention_surrogate', 'mention_overlap', 'mention_member', 'cross_room_reply', 'negotiation', 'reserved_field']) {
    assert.ok(vectors.rooms.invalid.some((x) => x.context?.rule === rule), `an invalid room vector for ${rule}`);
  }
});

test('rooms vectors: mention spans are UTF-16 code units, including a surrogate-pair spoiler', () => {
  const valid = vectors.rooms.valid.find((x) => x.name.includes('surrogate'));
  assert.ok(valid, 'a valid surrogate-pair mention vector');
  const [mention] = valid.frame.mentions;
  const span = valid.frame.text.slice(mention.offset, mention.offset + mention.length);
  assert.equal(span, valid.context.mention_text);
  assert.ok(span.length > [...span].length, 'the span contains a surrogate pair');
  assert.ok(valid.frame.text.slice(0, mention.offset).length >= 2, 'the offset counts UTF-16 code units before the span');
  const bad = vectors.rooms.invalid.filter((x) => x.context?.rule === 'mention_surrogate');
  assert.ok(bad.length >= 1, 'a span that splits a surrogate pair is rejected');
  for (const { frame } of bad) {
    const m = frame.mentions[0];
    assert.equal(m.offset + m.length, m.offset + 1, 'the fixture ends inside a pair');
    assert.ok(frame.text.charCodeAt(m.offset) >= 0xdc00, 'the fixture starts on a low surrogate');
  }
});

test('rooms contract: legacy 1.0/1.1 vectors are byte-identical and still validate', () => {
  assert.equal(vectors.protocol, 'foxfleet.bot/1');
  assert.equal(vectors.subprotocol, 'foxfleet.bot.v1');
  assert.equal(legacyHash(vectors), LEGACY_HASH, 'the v1/1.1 vectors must not be edited');
  for (const { name, frame } of vectors.valid) { const v = validateRequest(frame); assert.equal(v.ok, true, name); assert.equal(v.t, frame.t, name); }
  for (const { name, frame, code } of vectors.invalid) { const v = validateRequest(frame); assert.equal(v.ok, false, name); assert.equal(v.code, code, name); }
  assert.ok(vectors.rooms.valid.every((x) => !vectors.valid.some((y) => y.frame === x.frame)), 'room frames live only in the rooms block');
  for (const { frame } of vectors.rooms.valid) assert.notEqual(frame.chat_type, 'dm', 'room vectors never claim a DM');
});

test('rooms contract: chat.member, chat.get and chat.cancel stay reserved under v1 validateRequest', () => {
  const sample = { chat_id: 'fc_AAAAAAAAAAAAAAAA', thread_id: 'fcr_BBBBBBBBBBBBBBBB', dispatch_id: 'fd_CCCCCCCCCCCCCCCC', target_agent_id: 'agent:helper' };
  for (const t of ['chat.member', 'chat.get', 'chat.cancel']) {
    const v = validateRequest({ t, id: 'r1', ...sample });
    assert.equal(v.ok, false, t);
    assert.equal(v.code, 'unsupported', t);
  }
  for (const t of ['handoff.request']) { const v = validateRequest({ t, id: 'r1', ...sample }); assert.equal(v.ok, false, t); assert.equal(v.code, 'unknown_type', t); }
  const group = vectors.rooms.valid.find((x) => x.frame.t === 'message.new').frame;
  assert.equal(validateRequest({ ...group, t: 'message.new' }).ok, false, 'v1 does not admit room events');
});

test('rooms documentation: every frame, id, feature, actor kind, field and limit is in bot-api.md', () => {
  assert.ok(doc, 'contract/bot-api.md exists');
  const terms = [
    V12, SUB12, 'rooms-frames.schema.json', 'Groups (foxfleet.bot/1.2)', ...FEATURES,
    ...Object.keys(schema?.frames ?? {}), 'chat.member', 'chat.stop', 'handoff.request', 'chat.get', 'chat.cancel',
    'callback.answer', 'message.new', 'message.send', 'message.edit', 'message.delete', 'chat.action', 'card.send', 'card.close',
    'actor', 'actor_kind', 'kind', 'is_bot', 'mentions', 'offset', 'length', 'reply_to',
    'human', 'agent:', 'fc_', 'fcr_', 'fm_', 'fd_', 'fs_', 'frq_', 'fcb_',
    'UTF-16 code unit', 'max_mentions', 'max_actor_name_chars', 'max_conversation_title_chars',
    'max_room_members', 'max_handoff_dispatches_per_root', 'handoff_chain_ttl_ms', 'max_rooms',
    '4 dispatches', '5-minute', 'Serial agent turns', 'owner',
  ];
  for (const term of terms) assert.ok(doc.includes(term), `${term} is documented`);
  for (const n of Object.values(LIMITS)) assert.ok(doc.includes(String(n)), `limit ${n} appears in the limits table`);
});

test('openapi: the user-side conversation routes and schemas are frozen for clients', () => {
  assert.ok(spec, 'contract/openapi.json exists');
  const routes = [
    ['get', '/api/conversations', 'listConversations', 200],
    ['post', '/api/conversations', 'createConversation', 201],
    ['get', '/api/conversations/{id}', 'getConversation', 200],
    ['patch', '/api/conversations/{id}', 'updateConversation', 200],
    ['put', '/api/conversations/{id}/members/{agentId}', 'addConversationMember', 200],
    ['delete', '/api/conversations/{id}/members/{agentId}', 'removeConversationMember', 200],
    ['get', '/api/conversations/{id}/messages', 'listConversationMessages', 200],
    ['post', '/api/conversations/{id}/messages', 'sendConversationMessage', 202],
    ['get', '/api/conversations/{id}/messages/{messageId}', 'getConversationMessage', 200],
    ['post', '/api/conversations/{id}/stop', 'stopConversation', 200],
    ['post', '/api/conversations/{id}/resume', 'resumeConversation', 200],
    ['post', '/api/conversations/{id}/read', 'markConversationRead', 200],
    ['put', '/api/conversations/{id}/preferences', 'putConversationPreferences', 200],
  ];
  for (const [method, path, operationId, status] of routes) {
    const op = spec.paths?.[path]?.[method];
    assert.ok(op, `${method.toUpperCase()} ${path}`);
    assert.equal(op.operationId, operationId);
    assert.deepEqual(op.security, [{ session: [] }]);
    assert.ok(op.responses?.[String(status)], `${operationId} declares ${status}`);
    assert.ok(op.responses['401'], `${operationId} declares 401`);
    const bodyless = path.endsWith('/members/{agentId}') || path.endsWith('/stop') || path.endsWith('/resume');
    if (['post', 'patch', 'put'].includes(method) && !bodyless) assert.ok(op.requestBody?.content?.['application/json']?.schema, `${operationId} declares a JSON body`);
    const params = (op.parameters ?? []).map((p) => p.name);
    if (path.includes('{id}')) assert.ok(params.includes('id') || path.endsWith('{id}'), `${operationId} declares id`);
    if (path.includes('{agentId}')) assert.ok(params.includes('agentId'), `${operationId} declares agentId`);
    if (path.includes('{messageId}')) assert.ok(params.includes('messageId'), `${operationId} declares messageId`);
  }
  for (const name of ['Conversation', 'ConversationMember', 'ConversationMessage', 'ConversationList', 'ConversationPreferences', 'ConversationMessageRequest', 'ConversationReadRequest', 'ConversationStopResult']) {
    assert.ok(spec.components?.schemas?.[name], `schema ${name}`);
  }
  const created = {
    id: 'fc_AAAAAAAAAAAAAAAA', thread_id: 'fcr_BBBBBBBBBBBBBBBB', chat_type: 'group', title: 'Research',
    owner: { id: 'a1b2c3d4e5f60718', name: 'owner', kind: 'human', is_bot: false },
    members: [{ id: 'agent:helper', name: 'Helper', kind: 'agent', is_bot: true }],
    created_at: 1760000000000, updated_at: 1760000000000,
  };
  assert.deepEqual(schemaErrors(spec.components.schemas, { $ref: '#/components/schemas/Conversation' }, created), []);
  const message = {
    id: 'fm_BBBBBBBBBBBBBBBB', conversation_id: 'fc_AAAAAAAAAAAAAAAA', sender: { id: 'agent:helper', name: 'Helper', kind: 'agent', is_bot: true },
    text: 'hello', created_at: 1760000000000, reply_to: null,
  };
  assert.deepEqual(schemaErrors(spec.components.schemas, { $ref: '#/components/schemas/ConversationMessage' }, message), []);
});

test('documentation: room live events are capability-gated and the new error codes are listed', () => {
  assert.ok(live, 'docs/LIVE-EVENTS.md exists');
  assert.ok(errors, 'docs/API-ERRORS.md exists');
  for (const term of ['groups', 'conversation.created', 'conversation.updated', 'conversation.member.joined', 'conversation.member.left', 'conversation.message.new', 'conversation.message.edited', 'conversation.message.deleted', 'conversation.read', 'conversation.typing', 'conversation.handoff']) {
    assert.ok(live.includes(term), `LIVE-EVENTS documents ${term}`);
  }
  for (const term of ['capability', 'foxfleet.bot/1.2']) assert.ok(live.includes(term), `LIVE-EVENTS documents ${term}`);
  for (const code of ['conversation_not_found', 'conversation_exists', 'not_conversation_owner', 'agent_not_in_account', 'member_exists', 'member_not_found', 'invalid_title', 'too_many_members', 'mentions_invalid', 'unknown_mention', 'cross_room_reply', 'reply_not_found', 'handoff_limit', 'handoff_expired', 'handoff_not_found', 'group_not_available', 'owner_only', 'actor_forbidden']) {
    assert.ok(errors.includes(code), `API-ERRORS documents ${code}`);
  }
});
