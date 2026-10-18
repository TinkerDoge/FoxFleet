// Durable private JSON stores for the bot API: the token index and (later) one store per bot.
import { readFile, writeFile, rename, mkdir, rm, open } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { fault } from './config.js';
import { mediaText } from './bot-media.js';
import { cardView, validateCardAnswer } from './bot-protocol.js';

const sha256 = (v) => createHash('sha256').update(v).digest('hex');
const HASH_RE = /^[0-9a-f]{64}$/;
export const TOKEN_RE = /^ffb_[A-Za-z0-9_-]{43}$/;
export const unavailable = () => fault(503, 'The bot store is unavailable', 'bot_store_unavailable');

/**
 * One JSON file, private (0600), written atomically (temp, fsync, rename) with every write serialized.
 * `load()` treats a missing file as fresh and anything unreadable or malformed as `unavailable`: such a file is never repaired or replaced.
 * `mutate(fn)` edits a clone; the in-memory state only changes after the rename succeeded.
 */
export function jsonFile(file, { fresh, valid }) {
  let state = null, pending = Promise.resolve(), removed = false;
  const api = {
    get state() { return state; },
    get loaded() { return state !== null; },
    async load() {
      if (state) return state;
      if (removed) throw unavailable();
      let value;
      try { value = JSON.parse(await readFile(file, 'utf8')); }
      catch (e) { if (e.code !== 'ENOENT') throw unavailable(); value = fresh(); }
      if (removed || !valid(value)) throw unavailable();
      return (state ??= value);
    },
    mutate(fn) {
      const work = pending.then(async () => {
        if (removed || !state) throw unavailable();
        const draft = structuredClone(state), result = await fn(draft);
        const temp = `${file}.${randomUUID()}.tmp`;
        try {
          await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
          const fd = await open(temp, 'wx', 0o600);
          try { await fd.writeFile(JSON.stringify(draft) + '\n'); await fd.sync(); } finally { await fd.close(); }
          await rename(temp, file);
        } catch { await rm(temp, { force: true }).catch(() => {}); throw unavailable(); }
        state = draft;
        if (process.platform !== 'win32') {
          try { const dh = await open(path.dirname(file), 'r'); try { await dh.sync(); } finally { await dh.close(); } } catch { /* the rename is committed; not every filesystem can fsync a directory */ }
        }
        return result;
      });
      pending = work.catch(() => {});
      return work;
    },
    /** Resolves once every write queued so far has finished. */
    idle: () => pending,
    async remove() { await pending; removed = true; state = null; await rm(file, { force: true }); },
  };
  return api;
}

const tokenShape = (v) => v && v.v === 1 && Array.isArray(v.tokens) && v.tokens.every((x) => x && typeof x.hash === 'string' && typeof x.scope === 'string' && typeof x.bot_id === 'string' && Number.isSafeInteger(x.created));

/** `<data>/bot/tokens.json`: only sha256 hashes of bot tokens, each bound to (scope, botId). */
export function tokenIndex(file) {
  const store = jsonFile(file, { fresh: () => ({ v: 1, tokens: [] }), valid: tokenShape });
  const byBot = () => new Map((store.state?.tokens ?? []).map((x) => [x.bot_id, x]));
  return {
    /** Loads the file; a failure is not remembered, so the next call tries again. */
    ready: () => store.load().then(() => undefined),
    idle: () => store.idle(),
    has: (botId) => byBot().has(botId),
    async mint(scope, botId) {
      await store.load();
      const token = 'ffb_' + randomBytes(32).toString('base64url'), created = Date.now();
      await store.mutate((d) => { d.tokens = d.tokens.filter((x) => x.bot_id !== botId); d.tokens.push({ hash: sha256(token), scope, bot_id: botId, created }); });
      return { token, created };
    },
    /** `{ scope, botId }` for a well-formed, known token; null otherwise. */
    verify(token) {
      if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
      const digest = createHash('sha256').update(token).digest();
      let found = null;
      for (const row of store.state?.tokens ?? []) if (HASH_RE.test(row.hash) && timingSafeEqual(Buffer.from(row.hash, 'hex'), digest) && !found) found = row;
      return found ? { scope: found.scope, botId: found.bot_id } : null;
    },
    async revokeScope(scope) {
      await store.load();
      if (store.state.tokens.some((x) => x.scope === scope)) await store.mutate((d) => { d.tokens = d.tokens.filter((x) => x.scope !== scope); });
    },
    async revoke(botId) {
      await store.load();
      if (byBot().has(botId)) await store.mutate((d) => { d.tokens = d.tokens.filter((x) => x.bot_id !== botId); });
    },
  };
}

const botShape = (v) => v && v.v === 1 && Number.isSafeInteger(v.next_event_id) && v.next_event_id >= 1 && Number.isSafeInteger(v.acked) && v.acked >= 0
  && Array.isArray(v.events) && Array.isArray(v.commands) && ['chats', 'messages', 'idem', 'clients'].every((k) => v[k] && typeof v[k] === 'object' && !Array.isArray(v[k]));

/** A protocol-level failure (`code` is one of the contract's error codes); the bot gets it in a `res`, a user gets an HTTP status. */
export class BotError extends Error {
  constructor(code, message, extra = {}) { super(message); this.botCode = code; Object.assign(this, extra); }
}
const HTTP = { not_found: 404, forbidden: 403, invalid_request: 400, idempotency_conflict: 409 };
/** The HTTP fault for a store error raised on behalf of a user request. */
export const httpFault = (e) => (e instanceof BotError ? fault(HTTP[e.botCode] ?? 500, e.message, e.botCode) : e);
class Duplicate { constructor(result) { this.result = result; } }

const DAY = 24 * 60 * 60 * 1000;
export const LIMIT_DEFAULTS = { maxUnacked: 1000, maxChats: 500, maxMessagesPerChat: 2000, idemKeep: 5000, idemMs: DAY };
/** The effective caps: an omitted (undefined) key takes its default, anything else must be a positive safe integer. */
export function botLimits(options = {}) {
  const out = {};
  for (const [k, def] of Object.entries(LIMIT_DEFAULTS)) {
    const v = options[k];
    if (v === undefined) out[k] = def;
    else if (Number.isSafeInteger(v) && v > 0) out[k] = v;
    else throw new TypeError(`Invalid bot limit ${k}: ${String(v)}`);
  }
  return out;
}
const id = (prefix) => prefix + randomBytes(12).toString('base64url');
export const freshChatId = () => id('fc_');
const fingerprint = (op, req) => { const { idempotency_key, ...rest } = req; return sha256(JSON.stringify([op, Object.fromEntries(Object.entries(rest).sort(([a], [b]) => (a < b ? -1 : 1)))])); };

function prune(d, now, limits) {
  for (const book of [d.idem, d.clients]) {
    const keys = Object.keys(book);
    for (const k of keys) if (now - book[k].at > limits.idemMs) delete book[k];
    const rest = Object.keys(book);
    for (const k of rest.slice(0, Math.max(0, rest.length - limits.idemKeep))) delete book[k];
  }
}

/** `<account dir>/bot/<botId>.json`: everything one bot has: its chats, messages, pending events and ack. Every operation is one atomic write. */
export function botStore(file, options = {}) {
  const limits = botLimits(options);
  const store = jsonFile(file, { fresh: () => ({ v: 1, next_event_id: 1, acked: 0, events: [], chats: {}, messages: {}, idem: {}, clients: {}, commands: [] }), valid: botShape });
  const st = () => store.state;
  const referenced = (d, id) => Object.values(d.messages).some((list) => list.some((m) => m.media?.some((a) => a.id === id))) || d.events.some((e) => d.chats[e.chat_id] && e.media?.some((a) => a.id === id));
  const chatOf = (d, chatId) => { const c = d.chats[chatId]; if (!c) throw new BotError('not_found', 'Unknown chat'); return c; };
  const messageOf = (d, chatId, messageId) => { chatOf(d, chatId); const m = d.messages[chatId].find((x) => x.id === messageId); if (!m) throw new BotError('not_found', 'Unknown message'); return m; };
  function newChat(d, title, now, chatId = id('fc_')) {
    if (Object.keys(d.chats).length >= limits.maxChats) throw fault(409, 'This bot has too many chats; delete one first', 'bot_chat_limit');
    d.chats[chatId] = { id: chatId, title: title ?? null, created: now, updated: now }; d.messages[chatId] = []; return chatId;
  }
  function addMessage(d, chatId, message) {
    const list = d.messages[chatId]; list.push(message);
    while (list.length > limits.maxMessagesPerChat) list.shift();
    d.chats[chatId].updated = message.ts;
  }
  /** Runs `effect` once per (operation, key): a repeat with the same payload returns the stored result, a different payload is a conflict. */
  function once(d, op, req, now, effect) {
    const key = req.idempotency_key, fp = fingerprint(op, req);
    if (key === undefined) return { result: effect() };
    const slot = `${op}\0${key}`, prev = d.idem[slot];
    if (prev) { if (prev.fp !== fp) throw new BotError('idempotency_conflict', 'That idempotency_key was used with a different request'); return { result: prev.result, replayed: true }; }
    const result = effect(); d.idem[slot] = { fp, result, at: now }; return { result };
  }
  const freshRec = (rec, now) => rec && now - rec.at <= limits.idemMs;
  function matchIn(d, { clientId, chatId, text, dedupText = text }, now) {
    const rec = d.clients[`c:${clientId}`]; if (!freshRec(rec, now)) return null;
    if (rec.text_hash !== sha256(dedupText)) throw fault(409, 'That client_id was already used for a different message', 'client_id_conflict');
    if (chatId !== undefined && chatId !== rec.chat_id) throw fault(409, 'That client_id was already used in a different session', 'client_id_conflict');
    // Retain the deduplication tombstone, but never acknowledge an orphan or recreate its deleted chat/run.
    if (!d.chats[rec.chat_id]) throw fault(404, 'Unknown session');
    return { duplicate: true, chat_id: rec.chat_id, message: { id: rec.message_id, text, created: rec.created }, event_id: rec.event_id };
  }
  const run = async (fn) => { try { return await store.mutate(fn); } catch (e) { if (e instanceof Duplicate) return e.result; throw e; } };

  return {
    mediaRows: () => Object.values(st().media ?? {}).map((m) => ({ ...m, attached: referenced(st(), m.id) })),
    expireMedia(id, now = Date.now()) { return run((d) => { const m = d.media?.[id]; if (!m || referenced(d, id) || m.created + 3600_000 > now) return false; delete d.media[id]; return true; }); },
    addMedia(row, guard) { return run((d) => { guard?.(); chatOf(d, row.chat_id); d.media ??= {}; d.media[row.id] = row; }); },
    dropMedia(id) { return run((d) => { if (d.media) delete d.media[id]; }); },
    mediaForRef(ref) { return Object.values(st().media ?? {}).find((m) => m.attached && `/bot-media/${m.id}/${m.name}` === ref && Object.values(st().messages).some((list) => list.some((x) => x.media?.some((a) => a.id === m.id)))) ?? null; },
    messageText(chatId, messageId) { const m = st().messages[chatId]?.find((x) => x.id === messageId); return m ? mediaText(m.text, m.media) : ''; },
    limits,
    load: () => store.load().then(() => undefined),
    idle: () => store.idle(),
    remove: () => store.remove(),
    /** The stored duplicate result for a live client_id, null when there is none; a mismatch throws a 409. */
    clientMatch: (req) => matchIn(st(), req, Date.now()),
    acked: () => st().acked,
    latestEventId: () => st().next_event_id - 1,
    pending: () => st().events.length,
    /** Events with an id above `n`, oldest first. */
    eventsAfter: (n, max = Infinity) => st().events.filter((e) => e.id > n).slice(0, max),
    /** Events handed out on this connection (up to id `delivered`) that are not acknowledged yet. */
    outstanding: (delivered) => st().events.filter((e) => e.id <= delivered).length,

    /** A user's message: chat (when new), message and event, in one write. */
    acceptUser({ user, chatId, newChatId, text, dedupText = text, clientId, title, media = [] }) {
      const hash = sha256(dedupText);
      if (clientId) { let dup; try { dup = matchIn(st(), { clientId, chatId, text, dedupText }, Date.now()); } catch (e) { return Promise.reject(e); } if (dup) return Promise.resolve(dup); }
      return run((d) => {
        const now = Date.now(); prune(d, now, limits);
        const dup = clientId && matchIn(d, { clientId, chatId, text, dedupText }, now); if (dup) throw new Duplicate(dup);
        const target = chatId ?? newChatId;
        if (!d.chats[target] && target !== newChatId) throw fault(404, 'Unknown session');
        if (d.events.length >= limits.maxUnacked) throw Object.assign(fault(503, 'The bot has too many unread messages; try again shortly', 'bot_backlog_full'), { retryAfter: 30 });
        if (!d.chats[target]) newChat(d, title, now, target);
        else if (title && !d.chats[target].title) d.chats[target].title = title;
        for (const m of media) { const row = d.media?.[m.id]; if (!row || row.chat_id !== target) throw new BotError('not_found', 'Unknown media'); row.attached = true; }
        const message = { id: id('fm_'), role: 'user', text, ...(media.length ? { media } : {}), ts: now, user: { id: user.id, name: user.name } };
        addMessage(d, target, message);
        const event = { id: d.next_event_id++, chat_id: target, message_id: message.id, user: message.user, text, ...(media.length ? { media } : {}), date: now };
        d.events.push(event);
        if (clientId) d.clients[`c:${clientId}`] = { chat_id: target, message_id: message.id, text_hash: hash, created: now, event_id: event.id, at: now };
        return { duplicate: false, chat_id: target, message: { id: message.id, text, created: now }, event_id: event.id, event };
      });
    },
    async ack(n, guard) {
      if (n <= st().acked) return false;
      await store.mutate((d) => { guard?.(); d.acked = n; d.events = d.events.filter((e) => e.id > n); });
      return true;
    },
    send(req, guard) {
      return run((d) => { guard?.(); const now = Date.now(); prune(d, now, limits); return once(d, 'message.send', req, now, () => {
        chatOf(d, req.chat_id);
        if (req.reply_to !== undefined) messageOf(d, req.chat_id, req.reply_to);
        const media = (req.media ?? []).map((id) => {
          const m = d.media?.[id];
          if (!m || m.source !== 'bot' || m.chat_id !== req.chat_id || (!referenced(d, id) && m.created + 3600_000 <= now)) throw new BotError('not_found', 'Unknown media');
          return { ...m };
        });
        for (const m of media) d.media[m.id].attached = true;
        const message = { ...(media.length ? { media } : {}), id: id('fm_'), role: 'assistant', text: req.text, ts: now, format: req.format, ...(req.reply_to ? { reply_to: req.reply_to } : {}) };
        addMessage(d, req.chat_id, message);
        return { message_id: message.id, chat_id: req.chat_id, date: now };
      }); });
    },
    edit(req, guard) {
      return run((d) => { guard?.(); const now = Date.now(); prune(d, now, limits); return once(d, 'message.edit', req, now, () => {
        const m = messageOf(d, req.chat_id, req.message_id);
        if (m.role !== 'assistant') throw new BotError('forbidden', 'Only messages written by the bot can be edited');
        m.text = req.text; m.format = req.format; m.edited = true; d.chats[req.chat_id].updated = now;
        return { message_id: m.id, chat_id: req.chat_id, edited: true };
      }); });
    },
    delete(req, guard) {
      return run((d) => { guard?.(); const now = Date.now(); prune(d, now, limits); return once(d, 'message.delete', req, now, () => {
        const m = messageOf(d, req.chat_id, req.message_id);
        if (m.role !== 'assistant') throw new BotError('forbidden', 'Only messages written by the bot can be deleted');
        d.messages[req.chat_id] = d.messages[req.chat_id].filter((x) => x.id !== m.id); d.chats[req.chat_id].updated = now;
        return { message_id: m.id, chat_id: req.chat_id, deleted: true };
      }); });
    },
    setCommands(list, guard) { return store.mutate((d) => { guard?.(); d.commands = list; return { count: list.length }; }); },
    commands: () => st().commands,

    createChat(title, requestedId) { return store.mutate((d) => { const chatId = newChat(d, title, Date.now(), requestedId); return { id: chatId, title: d.chats[chatId].title }; }); },
    renameChat(chatId, title) { return run((d) => { try { chatOf(d, chatId); } catch (e) { throw httpFault(e); } d.chats[chatId].title = title; return { id: chatId, title }; }); },
    deleteChat(chatId) { return run((d) => { try { chatOf(d, chatId); } catch (e) { throw httpFault(e); } delete d.chats[chatId]; delete d.messages[chatId]; }); },
    hasChat: (chatId) => Boolean(st().chats[chatId]),
    messageAuthor: (chatId, messageId) => st().messages[chatId]?.find((x) => x.id === messageId)?.role ?? null,
    /** The id of the newest user message in the chat (0.4.2: the target of an agent's REACT: line). */
    lastUserMessage: (chatId) => { const list = st().messages[chatId] ?? []; for (let i = list.length - 1; i >= 0; i--) if (list[i].role === 'user') return list[i].id; return null; },
    /** Chats, newest activity first; `q` matches the title or any message text. */
    chats({ q = '', limit = 30, offset = 0 } = {}) {
      const d = st(), needle = q.toLowerCase();
      const rows = Object.values(d.chats).filter((c) => !needle || (c.title ?? '').toLowerCase().includes(needle) || d.messages[c.id].some((m) => m.text.toLowerCase().includes(needle)))
        .sort((a, b) => b.updated - a.updated).map((c) => { const list = d.messages[c.id], last = list.at(-1); return { id: c.id, title: c.title, updated: c.updated, started: c.created, messages: list.length, preview: last ? last.text.replace(/\s+/g, ' ').trim().slice(0, 140) : '' }; });
      return { sessions: rows.slice(offset, offset + limit), total: rows.length, limit, offset };
    },
    /** One page of a chat's messages, counted from the end, oldest first. */
    transcript(chatId, { limit = 80, offset = 0 } = {}) {
      const d = st(); if (!d.chats[chatId]) throw fault(404, 'Unknown session');
      const list = d.messages[chatId], end = Math.max(0, list.length - offset), start = Math.max(0, end - limit);
      return { messages: list.slice(start, end).map((m) => ({ id: m.id, role: m.role, content: mediaText(m.text, m.media), ts: m.ts, ...(m.edited ? { edited: true } : {}) })), offset, limit, has_more: start > 0 };
    },

    /** Open cards for one chat, in the shape the web already renders. Expired rows are not listed. */
    openRequests(chatId, now = Date.now()) {
      return Object.values(st().requests ?? {}).filter((r) => r.chat_id === chatId && r.state === 'open' && r.expires_at > now).map(cardView);
    },
    openCardCount(chatId, now = Date.now()) {
      return Object.values(st().requests ?? {}).filter((r) => r.chat_id === chatId && r.state === 'open' && r.expires_at > now).length;
    },
    pendingCallbacks() {
      return (st().callbacks ?? []).filter((c) => !c.delivered).map((c) => ({ t: 'callback', callback_id: c.callback_id, request_id: c.request_id, chat_id: c.chat_id, user: c.user, kind: c.kind, value: c.value }));
    },

    openCard(req, guard) {
      return run((d) => {
        guard?.(); const now = Date.now(); prune(d, now, limits); d.requests ??= {};
        return once(d, 'card.send', req, now, () => {
          chatOf(d, req.chat_id);
          const open = Object.values(d.requests).filter((r) => r.chat_id === req.chat_id && r.state === 'open' && r.expires_at > now);
          if (open.length >= 8) throw new BotError('invalid_request', 'Too many open cards in this chat');
          const request_id = id('frq_');
          d.requests[request_id] = { id: request_id, chat_id: req.chat_id, kind: req.kind, instance: req.instance, ...(req.card_key ? { card_key: req.card_key } : {}), ...(req.command ? { command: req.command } : {}), ...(req.description ? { description: req.description } : {}), ...(req.questions ? { questions: req.questions } : {}), created: now, expires_at: now + req.ttl_ms, state: 'open' };
          return { request_id, expires_at: now + req.ttl_ms };
        });
      });
    },
    closeCards(req, guard) {
      return run((d) => {
        guard?.(); const now = Date.now(); d.requests ??= {};
        const rows = Object.values(d.requests).filter((r) => r.state === 'open' && (req.request_id ? r.id === req.request_id : r.instance !== req.all_except_instance));
        for (const r of rows) { r.state = 'closed'; r.reason = req.reason || 'closed'; r.closed_at = now; }
        return { closed: rows.length, ids: rows.map((r) => ({ id: r.id, chat_id: r.chat_id })) };
      });
    },
    /** Close cards whose ttl has passed. Returns the ids so the hub can drop them from the live view. A chat with nothing due does not rewrite the store. */
    expireCards(now = Date.now()) {
      const due = Object.values(st().requests ?? {}).some((r) => r.state === 'open' && r.expires_at <= now);
      if (!due) return Promise.resolve([]);
      return run((d) => {
        d.requests ??= {};
        const rows = Object.values(d.requests).filter((r) => r.state === 'open' && r.expires_at <= now);
        for (const r of rows) { r.state = 'closed'; r.reason = 'expired'; r.closed_at = now; }
        return rows.map((r) => ({ id: r.id, chat_id: r.chat_id }));
      });
    },
    /**
     * One answer, bound to this chat. A wrong chat, a second tap, an expired card, or a shape the web
     * cannot send is refused. The account user is recorded here; a user id in the body is ignored by the caller.
     */
    answerCard({ requestId, chatId, user, result, now = Date.now() }) {
      return run((d) => {
        d.requests ??= {}; d.callbacks ??= [];
        const r = d.requests[requestId];
        if (!r || r.chat_id !== chatId) throw new BotError('not_found', 'That question is no longer open');
        if (r.state !== 'open' || r.expires_at <= now) {
          const expired = r.state === 'open';
          if (expired) { r.state = 'closed'; r.reason = 'expired'; r.closed_at = now; }
          const err = new BotError('not_found', 'That question is no longer open'); if (expired) err.closed = [{ id: r.id, chat_id: r.chat_id }]; throw err;
        }
        const verdict = validateCardAnswer(r, result);
        if (!verdict.ok) throw new BotError(verdict.code, verdict.message);
        const callback_id = id('fcb_');
        r.state = 'answered'; r.answered_at = now; r.value = verdict.value; r.callback_id = callback_id; r.user = { id: user.id, name: user.name };
        const callback = { callback_id, request_id: r.id, chat_id: r.chat_id, user: r.user, kind: r.kind, value: verdict.value, delivered: false };
        d.callbacks.push(callback);
        if (d.callbacks.length > 100) d.callbacks.splice(0, d.callbacks.length - 100);
        return { request_id: r.id, chat_id: r.chat_id, callback: { t: 'callback', callback_id, request_id: r.id, chat_id: r.chat_id, user: r.user, kind: r.kind, value: verdict.value } };
      });
    },
    ackCallback(callbackId, guard) {
      return store.mutate((d) => {
        guard?.();
        const c = (d.callbacks ?? []).find((x) => x.callback_id === callbackId);
        if (!c) throw new BotError('not_found', 'Unknown callback');
        c.delivered = true;
        return { delivered: true };
      });
    },
  };
}
