// Frame vocabulary and validation of the bot protocol (contract/bot-api.md), shared by the hub and the contract test.
export const PROTOCOL = 'foxfleet.bot/1';
export const SUBPROTOCOL = 'foxfleet.bot.v1';
export const LIMITS = { max_frame_bytes: 1048576, max_text_bytes: 65536, window: 100, max_unacked: 1000 };
export const CLOSE = { normal: 1000, going_away: 1001, protocol: 1002, unsupported: 1003, bad_utf8: 1007, bad_frame: 1008, too_big: 1009, internal: 1011, slow: 1013, token_revoked: 4001, gone: 4003, replaced: 4009 };
export const ERROR_CODES = ['invalid_request', 'unsupported', 'unknown_type', 'bad_frame', 'not_found', 'forbidden', 'too_large', 'rate_limited', 'idempotency_conflict', 'ack_out_of_range', 'internal'];
export const BOT_REQUESTS = ['message.send', 'message.edit', 'message.delete', 'chat.action', 'commands.set', 'ack', 'ping', 'pong'];
export const RESERVED = ['message.edited', 'message.deleted', 'callback', 'reaction', 'replay.gap', 'chat.member', 'message.react', 'callback.answer', 'media.upload', 'card.send', 'chat.get', 'chat.cancel'];

export const REQUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const validId = (id) => typeof id === 'string' && REQUEST_ID.test(id);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Text of one WebSocket message -> its frame, or the fatal `bad_frame` verdict (not JSON, not an object, or no string `t`). */
export function parseBotFrame(text) {
  let frame; try { frame = JSON.parse(text); } catch { return { ok: false, fatal: true, code: 'bad_frame' }; }
  if (!isObject(frame) || typeof frame.t !== 'string') return { ok: false, fatal: true, code: 'bad_frame' };
  return { ok: true, frame };
}

export const HTTP_REQUESTS = ['message.send', 'message.edit', 'message.delete', 'chat.action'];

/** HTTP always returns a bounded res envelope; null id means there was no valid correlation id. */
export function validateHttpRequest(frame) {
  const id = isObject(frame) && validId(frame.id) ? frame.id : null;
  if (!isObject(frame) || typeof frame.t !== 'string') return { ok: false, id, code: 'bad_frame', message: 'Frames are JSON objects with a string t' };
  if (id === null) return { ok: false, id, code: 'invalid_request', message: 'Requests carry a valid id' };
  if (!HTTP_REQUESTS.includes(frame.t)) return { ok: false, id, code: BOT_REQUESTS.includes(frame.t) || RESERVED.includes(frame.t) ? 'unsupported' : 'unknown_type', message: 'Operation is not available over HTTP' };
  const verdict = validateRequest(frame);
  // Field names are client-controlled and can contain secrets or be almost 1 MiB long.
  if (!verdict.ok) return { ...verdict, id, message: 'Invalid request fields' };
  return verdict;
}

export const CHAT_ID = /^fc_[A-Za-z0-9_-]{16}$/;
export const MESSAGE_ID = /^fm_[A-Za-z0-9_-]{16}$/;
const KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const COMMAND_NAME = /^[a-z0-9_]{1,32}$/;
const RESERVED_FIELDS = ['media', 'buttons', 'keyboard', 'card', 'thread_id', 'group_id', 'parse_mode', 'silent', 'reactions'];
const FIELDS = {
  'message.send': ['chat_id', 'text', 'format', 'reply_to', 'final', 'idempotency_key'],
  'message.edit': ['chat_id', 'message_id', 'text', 'format', 'final', 'idempotency_key'],
  'message.delete': ['chat_id', 'message_id', 'idempotency_key'],
  'chat.action': ['chat_id', 'action'],
  'commands.set': ['commands'],
  ack: ['event_id'],
  ping: [], pong: [],
};
const fail = (code, message) => ({ code, message });

function text(v) {
  if (typeof v !== 'string' || v.length === 0 || v.includes('\0')) return fail('invalid_request', 'text must be a non-empty string without NUL');
  if (Buffer.byteLength(v) > LIMITS.max_text_bytes) return fail('too_large', `text is over ${LIMITS.max_text_bytes} bytes`);
  return null;
}
function ref(v, pattern, name) {
  if (typeof v !== 'string') return fail('invalid_request', `${name} must be a string`);
  return pattern.test(v) ? null : fail('not_found', `Unknown ${name}`);
}

/** Validates the fields of one request (allow-list first), returning the normalised request or `{ code, message }`. */
function fields(t, f) {
  const allowed = FIELDS[t];
  if (RESERVED_FIELDS.some((k) => k in f)) return fail('unsupported', `${RESERVED_FIELDS.find((k) => k in f)} is not supported in protocol ${PROTOCOL}`);
  const extra = Object.keys(f).find((k) => k !== 't' && k !== 'id' && !allowed.includes(k));
  if (extra !== undefined) return fail('invalid_request', `Unknown field ${extra}`);
  const out = {}; let e;
  const key = () => { if (f.idempotency_key !== undefined) { if (typeof f.idempotency_key !== 'string' || !KEY.test(f.idempotency_key)) return fail('invalid_request', 'Invalid idempotency_key'); out.idempotency_key = f.idempotency_key; } return null; };
  const format = () => { if (f.format !== undefined && f.format !== 'markdown' && f.format !== 'text') return fail('invalid_request', 'format is markdown or text'); out.format = f.format ?? 'markdown'; return null; };
  const final = () => { if (f.final !== undefined && typeof f.final !== 'boolean') return fail('invalid_request', 'final must be a boolean'); out.final = f.final ?? false; return null; };
  switch (t) {
    case 'message.send':
      if ((e = ref(f.chat_id, CHAT_ID, 'chat_id'))) return e; out.chat_id = f.chat_id;
      if ((e = text(f.text))) return e; out.text = f.text;
      if ((e = format()) || (e = final())) return e;
      if (f.reply_to !== undefined) { if ((e = ref(f.reply_to, MESSAGE_ID, 'reply_to'))) return e; out.reply_to = f.reply_to; }
      if ((e = key())) return e; return out;
    case 'message.edit':
      if ((e = ref(f.chat_id, CHAT_ID, 'chat_id')) || (e = ref(f.message_id, MESSAGE_ID, 'message_id'))) return e; out.chat_id = f.chat_id; out.message_id = f.message_id;
      if ((e = text(f.text))) return e; out.text = f.text;
      if ((e = format()) || (e = final()) || (e = key())) return e; return out;
    case 'message.delete':
      if ((e = ref(f.chat_id, CHAT_ID, 'chat_id')) || (e = ref(f.message_id, MESSAGE_ID, 'message_id'))) return e; out.chat_id = f.chat_id; out.message_id = f.message_id;
      if ((e = key())) return e; return out;
    case 'chat.action':
      if ((e = ref(f.chat_id, CHAT_ID, 'chat_id'))) return e; out.chat_id = f.chat_id;
      if (typeof f.action !== 'string') return fail('invalid_request', 'action is required');
      if (f.action !== 'typing') return fail('unsupported', 'Only the typing action is supported');
      out.action = 'typing'; return out;
    case 'ack':
      if (!Number.isSafeInteger(f.event_id) || f.event_id < 0) return fail('invalid_request', 'event_id must be a non-negative integer');
      out.event_id = f.event_id; return out;
    case 'commands.set': {
      if (!Array.isArray(f.commands) || f.commands.length > 100) return fail('invalid_request', 'commands is a list of at most 100 entries');
      const seen = new Set(); out.commands = [];
      for (const c of f.commands) {
        if (!isObject(c) || Object.keys(c).some((k) => k !== 'name' && k !== 'description')) return fail('invalid_request', 'Each command has a name and a description');
        if (typeof c.name !== 'string' || !COMMAND_NAME.test(c.name) || seen.has(c.name)) return fail('invalid_request', 'Command names are unique, lowercase letters, digits or _, 1 to 32 characters');
        if (typeof c.description !== 'string' || c.description.length < 1 || c.description.length > 256 || /[\x00-\x1f\x7f]/.test(c.description)) return fail('invalid_request', 'Command descriptions are 1 to 256 characters without control characters');
        seen.add(c.name); out.commands.push({ name: c.name, description: c.description });
      }
      return out;
    }
    default: return out;
  }
}

/**
 * Classifies a parsed frame: `{ ok: true, t, id?, req }` for a request the hub implements (`req` holds the normalised fields), otherwise
 * `{ ok: false, code, message, id? }` (`id` only when the frame carried a valid request id: the hub answers with a `res` then, and with a
 * bare `error` frame otherwise).
 */
export function validateRequest(frame) {
  const id = validId(frame.id) ? frame.id : undefined;
  if (RESERVED.includes(frame.t)) return { ok: false, code: 'unsupported', message: `${frame.t} is not supported in protocol ${PROTOCOL}`, id };
  if (!BOT_REQUESTS.includes(frame.t)) return { ok: false, code: 'unknown_type', message: 'Unknown frame type' };
  if (frame.id !== undefined && id === undefined) return { ok: false, code: 'invalid_request', message: 'Invalid request id' };
  const optionalId = frame.t === 'ack' || frame.t === 'ping' || frame.t === 'pong';
  if (id === undefined && !optionalId) return { ok: false, code: 'invalid_request', message: 'Requests carry an id' };
  const req = fields(frame.t, frame);
  if (req.code) return { ok: false, code: req.code, message: req.message, id };
  return { ok: true, t: frame.t, id, req };
}
