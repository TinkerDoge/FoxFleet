// Frame vocabulary and validation of the bot protocol (contract/bot-api.md), shared by the hub and the contract test.
export const PROTOCOL = 'foxfleet.bot/1';
export const PROTOCOL_V11 = 'foxfleet.bot/1.1';
export const SUBPROTOCOL = 'foxfleet.bot.v1';
export const SUBPROTOCOL_V11 = 'foxfleet.bot.v1.1';
/** Stop answers. `stopped` and `idle` are the only outcomes that end the viewer's run. */
export const STOP_OUTCOMES = ['stopped', 'idle', 'refused', 'expired'];
export const STOP_ID = /^fs_[A-Za-z0-9_-]{16}$/;
/** Cards. The hub mints both ids. A client-supplied id is never an authority. */
export const CARD_KINDS = ['approval', 'confirm', 'clarify'];
export const CARD_ID = /^frq_[A-Za-z0-9_-]{16}$/;
export const CARD_CALLBACK_ID = /^fcb_[A-Za-z0-9_-]{16}$/;
export const CARD_OUTCOMES = ['resolved', 'expired', 'refused'];
export const CARD_TTL_DEFAULT = 600_000;
export const CARD_TTL_MIN = 5_000;
export const CARD_TTL_MAX = 1_800_000;

/** Highest mutually supported subprotocol, or null. A client that only offers v1 still connects. */
export function selectSubprotocol(header) {
  const offered = String(header ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (offered.includes(SUBPROTOCOL_V11)) return SUBPROTOCOL_V11;
  if (offered.includes(SUBPROTOCOL)) return SUBPROTOCOL;
  return null;
}
export const protocolForSubprotocol = (sub) => (sub === SUBPROTOCOL_V11 ? PROTOCOL_V11 : PROTOCOL);
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
/**
 * `callback.answer` for a transient `chat.stop`. v1 `validateRequest` still refuses the name (it stays reserved
 * there). Only a 1.1 session calls this, and only a matching outstanding stop id is accepted by the hub.
 */
export function validateStopAnswer(frame) {
  const id = validId(frame.id) ? frame.id : undefined;
  if (frame.t !== 'callback.answer') return { ok: false, code: 'unknown_type', message: 'Unknown frame type', id };
  if (frame.id !== undefined && id === undefined) return { ok: false, code: 'invalid_request', message: 'Invalid request id', id };
  if (id === undefined) return { ok: false, code: 'invalid_request', message: 'Requests carry an id' };
  if (RESERVED_FIELDS.some((k) => k in frame)) return { ok: false, code: 'unsupported', message: `${RESERVED_FIELDS.find((k) => k in frame)} is not supported in protocol ${PROTOCOL_V11}`, id };
  const extra = Object.keys(frame).find((k) => k !== 't' && k !== 'id' && k !== 'callback_id' && k !== 'outcome');
  if (extra !== undefined) return { ok: false, code: 'invalid_request', message: `Unknown field ${extra}`, id };
  if (typeof frame.callback_id !== 'string' || !STOP_ID.test(frame.callback_id)) return { ok: false, code: 'invalid_request', message: 'Invalid callback_id', id };
  if (!STOP_OUTCOMES.includes(frame.outcome)) return { ok: false, code: 'invalid_request', message: 'Invalid outcome', id };
  return { ok: true, t: 'callback.answer', id, req: { callback_id: frame.callback_id, outcome: frame.outcome } };
}

const INSTANCE = /^[A-Za-z0-9._:-]{1,128}$/;
const QID = /^[A-Za-z0-9._:-]{1,64}$/;
const plain = (v, name, max = 2000) => {
  if (typeof v !== 'string' || v.length === 0 || v.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)) return fail('invalid_request', `${name} must be 1 to ${max} characters without control characters`);
  return null;
};

/**
 * `card.send` / `card.close` on a 1.1 socket. v1 `validateRequest` still refuses both names.
 * The hub mints `request_id`. Nothing in the frame authorises a user, a chat, or a later tap.
 */
export function validateCardRequest(frame) {
  const id = validId(frame.id) ? frame.id : undefined;
  if (frame.t !== 'card.send' && frame.t !== 'card.close') return { ok: false, code: 'unknown_type', message: 'Unknown frame type', id };
  if (frame.id !== undefined && id === undefined) return { ok: false, code: 'invalid_request', message: 'Invalid request id', id };
  if (id === undefined) return { ok: false, code: 'invalid_request', message: 'Requests carry an id', id };
  if (RESERVED_FIELDS.some((k) => k in frame)) return { ok: false, code: 'unsupported', message: `${RESERVED_FIELDS.find((k) => k in frame)} is not supported in protocol ${PROTOCOL_V11}`, id };
  if (frame.t === 'card.close') {
    const allowed = ['request_id', 'all_except_instance', 'reason'];
    const extra = Object.keys(frame).find((k) => k !== 't' && k !== 'id' && !allowed.includes(k));
    if (extra !== undefined) return { ok: false, code: 'invalid_request', message: `Unknown field ${extra}`, id };
    const hasId = frame.request_id !== undefined, hasAll = frame.all_except_instance !== undefined;
    if (hasId === hasAll) return { ok: false, code: 'invalid_request', message: 'card.close takes request_id or all_except_instance, not both', id };
    const out = {};
    if (hasId) { if (typeof frame.request_id !== 'string' || !CARD_ID.test(frame.request_id)) return { ok: false, code: 'not_found', message: 'Unknown request_id', id }; out.request_id = frame.request_id; }
    else { if (typeof frame.all_except_instance !== 'string' || !INSTANCE.test(frame.all_except_instance)) return { ok: false, code: 'invalid_request', message: 'Invalid all_except_instance', id }; out.all_except_instance = frame.all_except_instance; }
    if (frame.reason !== undefined) { const e = plain(frame.reason, 'reason', 64); if (e) return { ok: false, ...e, id }; out.reason = frame.reason; }
    return { ok: true, t: 'card.close', id, req: out };
  }
  const allowed = ['chat_id', 'kind', 'instance', 'card_key', 'ttl_ms', 'idempotency_key', 'command', 'description', 'questions'];
  const extra = Object.keys(frame).find((k) => k !== 't' && k !== 'id' && !allowed.includes(k));
  if (extra !== undefined) return { ok: false, code: 'invalid_request', message: `Unknown field ${extra}`, id };
  if (typeof frame.chat_id !== 'string' || !CHAT_ID.test(frame.chat_id)) return { ok: false, code: 'not_found', message: 'Unknown chat_id', id };
  if (!CARD_KINDS.includes(frame.kind)) return { ok: false, code: 'invalid_request', message: 'kind is approval, confirm or clarify', id };
  if (typeof frame.instance !== 'string' || !INSTANCE.test(frame.instance)) return { ok: false, code: 'invalid_request', message: 'Invalid instance', id };
  const out = { chat_id: frame.chat_id, kind: frame.kind, instance: frame.instance, ttl_ms: CARD_TTL_DEFAULT };
  if (frame.card_key !== undefined) { if (typeof frame.card_key !== 'string' || !INSTANCE.test(frame.card_key)) return { ok: false, code: 'invalid_request', message: 'Invalid card_key', id }; out.card_key = frame.card_key; }
  if (frame.ttl_ms !== undefined) { if (!Number.isSafeInteger(frame.ttl_ms) || frame.ttl_ms < CARD_TTL_MIN || frame.ttl_ms > CARD_TTL_MAX) return { ok: false, code: 'invalid_request', message: 'Invalid ttl_ms', id }; out.ttl_ms = frame.ttl_ms; }
  if (frame.idempotency_key !== undefined) { if (typeof frame.idempotency_key !== 'string' || !KEY.test(frame.idempotency_key)) return { ok: false, code: 'invalid_request', message: 'Invalid idempotency_key', id }; out.idempotency_key = frame.idempotency_key; }
  if (frame.kind === 'clarify') {
    if (frame.command !== undefined || frame.description !== undefined) return { ok: false, code: 'invalid_request', message: 'A clarify card has questions, not a command', id };
    if (!Array.isArray(frame.questions) || frame.questions.length < 1 || frame.questions.length > 6) return { ok: false, code: 'invalid_request', message: 'questions is 1 to 6 entries', id };
    const seen = new Set(); out.questions = [];
    for (const q of frame.questions) {
      if (!isObject(q) || Object.keys(q).some((k) => !['id', 'question', 'choices', 'multi_select'].includes(k))) return { ok: false, code: 'invalid_request', message: 'Invalid question', id };
      if (typeof q.id !== 'string' || !QID.test(q.id) || seen.has(q.id)) return { ok: false, code: 'invalid_request', message: 'Invalid question id', id };
      const badQ = plain(q.question, 'question'); if (badQ) return { ok: false, ...badQ, id };
      let choices = [];
      if (q.choices !== undefined) {
        if (!Array.isArray(q.choices) || q.choices.length > 50 || q.choices.some((c) => typeof c !== 'string' || c.length < 1 || c.length > 200 || c.includes('\0'))) return { ok: false, code: 'invalid_request', message: 'Invalid choices', id };
        choices = q.choices.map(String);
      }
      if (q.multi_select !== undefined && typeof q.multi_select !== 'boolean') return { ok: false, code: 'invalid_request', message: 'multi_select must be a boolean', id };
      seen.add(q.id); out.questions.push({ id: q.id, question: q.question, choices, multi_select: q.multi_select === true });
    }
  } else {
    if (frame.questions !== undefined) return { ok: false, code: 'invalid_request', message: 'An approval card has no questions', id };
    if (frame.command === undefined && frame.description === undefined) return { ok: false, code: 'invalid_request', message: 'An approval card needs a command or a description', id };
    if (frame.command !== undefined) { const e = plain(frame.command, 'command'); if (e) return { ok: false, ...e, id }; out.command = frame.command; }
    if (frame.description !== undefined) { const e = plain(frame.description, 'description'); if (e) return { ok: false, ...e, id }; out.description = frame.description; }
  }
  return { ok: true, t: 'card.send', id, req: out };
}

/** The only answers the web card can send. Anything else, including a body user id, is refused. */
export function validateCardAnswer(card, result) {
  if (!isObject(result) || Object.keys(result).length !== 1) return fail('invalid_request', 'Invalid answer');
  if (card.kind === 'clarify') {
    const answers = result.answers;
    if (!isObject(answers)) return fail('invalid_request', 'Invalid answer');
    const ids = (card.questions ?? []).map((q) => q.id);
    const keys = Object.keys(answers);
    if (keys.length !== ids.length || ids.some((k) => !keys.includes(k))) return fail('invalid_request', 'Invalid answer');
    const value = {};
    for (const k of ids) {
      const v = answers[k];
      if (typeof v !== 'string' || v.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)) return fail('invalid_request', 'Invalid answer');
      value[k] = v;
    }
    return { ok: true, value: { answers: value } };
  }
  if (result.choice !== 'once' && result.choice !== 'deny') return fail('invalid_request', 'Invalid answer');
  return { ok: true, value: { choice: result.choice } };
}

/** What the web already renders. Confirm is an approval card there; the bot still hears `confirm`. */
export function cardView(r) {
  if (r.kind === 'clarify') return { request_id: r.id, kind: 'clarify', questions: r.questions ?? [] };
  return { request_id: r.id, kind: 'approval', ...(r.command ? { command: r.command } : {}), ...(r.description ? { description: r.description } : {}) };
}

/** `callback.answer` for a card, not a stop. A stop id never reaches this. */
export function validateCardCallback(frame) {
  const id = validId(frame.id) ? frame.id : undefined;
  if (frame.t !== 'callback.answer') return { ok: false, code: 'unknown_type', message: 'Unknown frame type', id };
  if (frame.id !== undefined && id === undefined) return { ok: false, code: 'invalid_request', message: 'Invalid request id', id };
  if (id === undefined) return { ok: false, code: 'invalid_request', message: 'Requests carry an id' };
  if (RESERVED_FIELDS.some((k) => k in frame)) return { ok: false, code: 'unsupported', message: `${RESERVED_FIELDS.find((k) => k in frame)} is not supported in protocol ${PROTOCOL_V11}`, id };
  const extra = Object.keys(frame).find((k) => k !== 't' && k !== 'id' && k !== 'callback_id' && k !== 'outcome');
  if (extra !== undefined) return { ok: false, code: 'invalid_request', message: `Unknown field ${extra}`, id };
  if (typeof frame.callback_id !== 'string' || !CARD_CALLBACK_ID.test(frame.callback_id)) return { ok: false, code: 'invalid_request', message: 'Invalid callback_id', id };
  if (!CARD_OUTCOMES.includes(frame.outcome)) return { ok: false, code: 'invalid_request', message: 'Invalid outcome', id };
  return { ok: true, t: 'callback.answer', id, req: { callback_id: frame.callback_id, outcome: frame.outcome } };
}

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

// Only the 1.1 socket selects this validator. HTTP RPC and 1.0 retain v1 fields.
export function validateMediaRequest(frame) {
  if (frame.t !== 'message.send' || !('media' in frame)) return validateRequest(frame);
  const { media, ...rest } = frame;
  const id = validId(frame.id) ? frame.id : undefined;
  if (!Array.isArray(media) || media.length < 1 || media.length > 10 || !media.every((x) => typeof x === 'string' && /^fbm_[A-Za-z0-9_-]{24}$/.test(x))) return { ok: false, id, code: 'invalid_request', message: 'media must contain 1–10 upload ids' };
  const empty = rest.text === '';
  const v = validateRequest({ ...rest, ...(empty ? { text: ' ' } : {}) });
  if (v.ok) { v.req.media = media; if (empty) v.req.text = ''; }
  return v;
}
