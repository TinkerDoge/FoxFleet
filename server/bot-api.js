// FoxFleet bot API (contract/bot-api.md): token routes, the bot socket, and the agent routes of bot agents.
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fault } from './config.js';
import { tokenIndex, botStore, botLimits, freshChatId, BotError, httpFault } from './bot-store.js';
import { acceptBotSocket, checkHandshake } from './bot-ws.js';
import { PROTOCOL_V11, LIMITS, CHAT_ID, CARD_ID, parseBotFrame, validateRequest, validateHttpRequest, validateStopAnswer, validateCardRequest, validateCardCallback, cardView, selectSubprotocol, protocolForSubprotocol } from './bot-protocol.js';
import { flattenContent } from './transcript.js';

export const BOT_DISABLED = 'The bot API is disabled on this hub';

const botCheck = (ok, message) => ({ bot: { ok, message } });
const STATUS_TEXT = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests', 503: 'Service Unavailable' };

/** What a bot agent looks like to the agent list while the bot API is off: offline, never routed anywhere. */
export const disabledBotProbe = (m) => ({ name: m.name, kind: 'hermes', label: m.label, online: false, chatReady: false, managementReady: false, checks: botCheck(false, BOT_DISABLED) });
export const botDisabled = () => fault(503, BOT_DISABLED, 'bot_disabled');

const loopbackAddress = (a) => { const v = String(a ?? '').replace(/^::ffff:/, ''); return v === '::1' || /^127\.\d+\.\d+\.\d+$/.test(v); };
const loopbackHost = (host) => ['localhost', '127.0.0.1', '::1'].includes(String(host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, ''));

/**
 * Transport security for a token-bearing upgrade: plain HTTP from the network is refused so a token never crosses it in clear.
 * Allowed: a loopback peer with a loopback Host or an `X-Forwarded-Proto: https` proxy; or `https` forwarded for a trusted HTTPS origin.
 */
export function secureBotRequest({ remoteAddress, host, xfp, trusted }) {
  const https = xfp === 'https';
  if (loopbackAddress(remoteAddress) && (loopbackHost(host) || https)) return true;
  return https && Boolean(trusted?.has?.(`https://${host}`));
}

/**
 * `scopeReg(scope)` resolves the account's registry ({ dir, store, ... }); `ownerOf(scope)` the account ({ id, disabled? }) or undefined.
 * `trusted` is the hub's set of trusted origins. Nothing here runs unless the hub was created with the bot API on.
 */
export async function createBotApi({ dataDir, scopeReg, ownerOf, runs, trusted = new Set(), appCommands = [], options = {}, log = () => {} }) {
  const opt = { heartbeatMs: 25000, maxBufferedBytes: 8 * 1024 * 1024, window: LIMITS.window, replyIdleMs: 30_000, replyWaitMs: 300_000, ...options, rate: { burst: 60, perSec: 20, ...options.rate } };
  const limits = botLimits({ maxUnacked: options.maxUnacked, maxChats: options.maxChats, maxMessagesPerChat: options.maxMessagesPerChat });
  const tokens = tokenIndex(path.join(dataDir, 'bot', 'tokens.json'));
  await tokens.ready().catch(() => {});
  const sessions = new Map(), stores = new Map(), gone = new Set(), requests = new Set(), stops = new Map();
  const STOP_MS = Number.isInteger(options.stopMs) && options.stopMs > 0 ? options.stopMs : 10_000;

  const storeFor = (scope, reg, botId) => { if (gone.has(botId)) throw fault(404, 'Not found'); let e = stores.get(botId); if (!e) stores.set(botId, e = { scope, store: botStore(path.join(reg.dir, 'bot', `${botId}.json`), limits) }); return e.store; };
  const agentOf = (reg, botId) => reg.store.all().find((a) => a.connection === 'bot' && a.botId === botId);

  const fence = (s, code, reason) => { s.fenced = true; s.conn?.close(code, reason); };
  const current = (s) => !s.fenced && (s.authorized ? s.authorized() : sessions.get(s.botId) === s) && (() => { const o = ownerOf(s.scope); return Boolean(o && !o.disabled); })();
  const guard = (s) => () => { if (!current(s)) { if (s.authorized) throw fault(401, 'Unauthorized'); throw new BotError('forbidden', 'This connection is no longer authorised'); } };

  async function mint(scope, m) {
    await tokens.ready();
    const made = await tokens.mint(scope, m.botId);
    const old = sessions.get(m.botId); if (old) fence(old, 4001, 'token rotated');
    await stores.get(m.botId)?.store.idle();
    log('bot.token', { bot: m.botId, action: 'mint' });
    return { token: made.token, bot_id: m.botId, created: made.created };
  }
  async function revoke(m) {
    await tokens.ready();
    await tokens.revoke(m.botId);
    const old = sessions.get(m.botId); if (old) fence(old, 4001, 'token revoked');
    await stores.get(m.botId)?.store.idle();
    log('bot.token', { bot: m.botId, action: 'revoke' });
  }

  const probe = (m) => {
    const has = tokens.has(m.botId), connected = sessions.has(m.botId);
    return { name: m.name, kind: 'hermes', label: m.label, online: connected, chatReady: connected, managementReady: false, hasBotToken: has,
      checks: botCheck(connected, connected ? 'Connected' : has ? 'Waiting for the bot to connect (messages are queued)' : 'No bot token yet: create one to connect a bot') };
  };

  const buckets = new Map();
  /** One token per bot request (pings and acks are free); the bucket belongs to the bot, so reconnecting does not refill it. */
  function takeToken(botId) {
    const now = Date.now(), { burst, perSec } = opt.rate, b = buckets.get(botId) ?? { tokens: burst, at: now };
    b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * perSec); b.at = now; buckets.set(botId, b);
    if (b.tokens >= 1) { b.tokens -= 1; return; }
    throw new BotError('rate_limited', 'Too many requests', { retry_after_ms: Math.ceil(((1 - b.tokens) / perSec) * 1000) });
  }
  const agentName = (session) => agentOf(session.reg, session.botId)?.name;
  async function dispatch(session, v) {
    const { store } = session;
    switch (v.t) {
      case 'message.send': {
        const out = await store.send(v.req, guard(session));
        if (!out.replayed) {
          session.reg.activity.touch(agentName(session), { role: 'assistant', text: v.req.text, session: v.req.chat_id });
          await botActivity(session, v.req.chat_id, { kind: 'send', id: out.result.message_id, text: v.req.text, final: v.req.final });
        }
        return out;
      }
      case 'message.edit': {
        const out = await store.edit(v.req, guard(session));
        if (!out.replayed) {
          session.reg.activity.touch(agentName(session), { role: 'assistant', text: v.req.text, session: v.req.chat_id });
          await botActivity(session, v.req.chat_id, { kind: 'edit', id: v.req.message_id, text: v.req.text, final: v.req.final });
        }
        return out;
      }
      case 'message.delete': {
        const out = await store.delete(v.req, guard(session));
        if (!out.replayed) await botActivity(session, v.req.chat_id, { kind: 'delete', id: v.req.message_id });
        return out;
      }
      case 'chat.action':
        if (!store.hasChat(v.req.chat_id)) throw new BotError('not_found', 'Unknown chat');
        guard(session)();
        await botActivity(session, v.req.chat_id, { kind: 'action', action: v.req.action });
        return { result: {} };
      case 'ack': {
        const n = v.req.event_id;
        if (n > session.delivered) throw new BotError('ack_out_of_range', 'That event has not been delivered on this connection');
        await store.ack(n, guard(session));
        return { result: { acked: n } };
      }
      case 'commands.set': return { result: await store.setCommands(v.req.commands, guard(session)) };
      case 'card.send': {
        const out = await store.openCard(v.req, guard(session));
        if (!out.replayed) await showCard(session, v.req.chat_id, cardView({ id: out.result.request_id, ...v.req }));
        return out;
      }
      case 'card.close': {
        const out = await store.closeCards(v.req, guard(session));
        for (const row of out.ids) noteClosed(session.botId, row.chat_id, row.id, v.req.reason || 'closed');
        return { result: { closed: out.closed } };
      }
      default: throw new BotError('unsupported', `${v.t} is not supported yet`);
    }
  }

  async function handle(session, text) {
    const { conn } = session, parsed = parseBotFrame(text);
    if (!parsed.ok) { conn.send({ t: 'error', code: 'bad_frame', message: 'Frames are JSON objects with a string "t"' }); return conn.close(1008, 'bad frame'); }
    if (session.protocol === PROTOCOL_V11 && parsed.frame.t === 'callback.answer') {
      const cid = parsed.frame.callback_id;
      if (typeof cid === 'string' && cid.startsWith('fcb_')) return answerCardCallback(session, parsed.frame);
      return answerStop(session, parsed.frame);
    }
    const v = session.protocol === PROTOCOL_V11 && (parsed.frame.t === 'card.send' || parsed.frame.t === 'card.close') ? validateCardRequest(parsed.frame) : validateRequest(parsed.frame);
    if (!v.ok) {
      // Invalid frames cost a token like valid ones, so a socket cannot flood the hub with rejected work for free.
      try { takeToken(session.botId); } catch (e) { if (!(e instanceof BotError)) throw e; return conn.send(v.id ? { t: 'res', id: v.id, ok: false, error: { code: e.botCode, message: e.message, retry_after_ms: e.retry_after_ms } } : { t: 'error', code: e.botCode, message: e.message }); }
      return conn.send(v.id ? { t: 'res', id: v.id, ok: false, error: { code: v.code, message: v.message } } : { t: 'error', code: v.code, message: v.message });
    }
    if (v.t === 'ping') return conn.send({ t: 'pong', ...(v.id ? { id: v.id } : {}) });
    if (v.t === 'pong') return;
    const answer = (res) => { if (v.id) conn.send({ t: 'res', id: v.id, ...res }); else if (!res.ok) conn.send({ t: 'error', code: res.error.code, message: res.error.message }); };
    try {
      if (v.t !== 'ack') takeToken(session.botId);
      const out = await dispatch(session, v);
      answer({ ok: true, result: out.result, ...(out.replayed ? { replayed: true } : {}) });
      if (v.t === 'ack') pushEvents(session);
    } catch (e) {
      if (e instanceof BotError) return answer({ ok: false, error: { code: e.botCode, message: e.message, ...(e.retry_after_ms ? { retry_after_ms: e.retry_after_ms } : {}) } });
      log('bot.error', { bot: session.botId });
      answer({ ok: false, error: { code: 'internal', message: 'Internal error' } });
    }
  }

  // A user Stop is not a stored event. One outstanding stop per live run; a second tap joins it.
  // The frame is never replayed, so a reconnect cannot kill a later turn with a stale stop.
  function settle(entry, outcome) {
    if (entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timer);
    stops.delete(entry.stop_id);
    if (outcome === 'stopped' || outcome === 'idle') entry.resolve(outcome);
    else entry.reject(Object.assign(new Error(`stop ${outcome}`), { outcome }));
  }
  function failStops(session, reason) {
    for (const entry of [...stops.values()]) if (entry.session === session) settle(entry, reason);
  }
  function requestStop(session, st) {
    const actor = st.link.actor;
    if (!actor?.id) throw new Error('stop has no user');
    const existing = [...stops.values()].find((s) => s.key === st.key && s.session === session && !s.settled);
    if (existing) return existing.promise;
    const stop_id = 'fs_' + randomBytes(12).toString('base64url');
    const expires_at = Date.now() + STOP_MS;
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    const entry = { stop_id, key: st.key, session, expires_at, resolve, reject, promise, settled: false };
    stops.set(stop_id, entry);
    const timer = setTimeout(() => settle(entry, 'timeout'), Math.max(0, expires_at - Date.now()));
    timer.unref?.();
    entry.timer = timer;
    try {
      session.conn.send({ t: 'chat.stop', stop_id, chat_id: st.chatId, user: { id: actor.id, name: actor.name }, date: Date.now(), expires_at });
    } catch (e) {
      settle(entry, 'send_failed');
      throw e;
    }
    return promise;
  }
  async function interruptRun(st) {
    const session = sessions.get(st.botId);
    if (!session || session.protocol !== PROTOCOL_V11 || !session.conn) throw new Error('stop unavailable');
    const outcome = await requestStop(session, st);
    if (!st.ended && (outcome === 'stopped' || outcome === 'idle')) end(st, 'stopped');
  }
  function answerStop(session, frame) {
    const v = validateStopAnswer(frame);
    const answer = (res) => { if (v.id) session.conn.send({ t: 'res', id: v.id, ...res }); else if (!res.ok) session.conn.send({ t: 'error', code: res.error.code, message: res.error.message }); };
    try { takeToken(session.botId); }
    catch (e) {
      if (!(e instanceof BotError)) throw e;
      return answer({ ok: false, error: { code: e.botCode, message: e.message, ...(e.retry_after_ms ? { retry_after_ms: e.retry_after_ms } : {}) } });
    }
    if (!v.ok) return answer({ ok: false, error: { code: v.code, message: v.message } });
    if (!current(session)) return answer({ ok: false, error: { code: 'forbidden', message: 'This connection is no longer authorised' } });
    const entry = stops.get(v.req.callback_id);
    if (!entry || entry.session !== session || entry.settled) return answer({ ok: false, error: { code: 'not_found', message: 'Unknown callback' } });
    if (Date.now() > entry.expires_at) {
      settle(entry, 'expired');
      return answer({ ok: false, error: { code: 'not_found', message: 'That stop has expired' } });
    }
    settle(entry, v.req.outcome);
    return answer({ ok: true, result: {} });
  }
  function answerCardCallback(session, frame) {
    const v = validateCardCallback(frame);
    const answer = (res) => { if (v.id) session.conn.send({ t: 'res', id: v.id, ...res }); else if (!res.ok) session.conn.send({ t: 'error', code: res.error.code, message: res.error.message }); };
    try { takeToken(session.botId); }
    catch (e) {
      if (!(e instanceof BotError)) throw e;
      return answer({ ok: false, error: { code: e.botCode, message: e.message, ...(e.retry_after_ms ? { retry_after_ms: e.retry_after_ms } : {}) } });
    }
    if (!v.ok) return answer({ ok: false, error: { code: v.code, message: v.message } });
    if (!current(session)) return answer({ ok: false, error: { code: 'forbidden', message: 'This connection is no longer authorised' } });
    session.store.ackCallback(v.req.callback_id, guard(session)).then(() => answer({ ok: true, result: {} })).catch((e) => {
      if (e instanceof BotError) return answer({ ok: false, error: { code: e.botCode, message: e.message } });
      answer({ ok: false, error: { code: 'internal', message: 'Internal error' } });
    });
  }

  // ---- the reply run: a view of what the bot writes into one chat, in the shape the apps already follow (see runs.js) ----
  const enc = new TextEncoder(), live = new Map(), starting = new Map();
  const sse = (obj, event) => enc.encode(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(obj)}\n\n`);
  const delta = (text) => sse({ choices: [{ delta: { content: text } }] });
  const composed = (st) => st.parts.map((p) => p.text).join('\n\n');
  const emit = (st, chunk) => { if (!st.ended) { try { st.ctl.enqueue(chunk); } catch { /* the run is already closed */ } } };
  function arm(st) {
    clearTimeout(st.timer);
    const store = stores.get(st.botId)?.store;
    if (store?.loaded !== false && store?.openCardCount?.(st.chatId) > 0) return;
    st.timer = setTimeout(() => end(st, 'done'), st.wrote ? opt.replyIdleMs : opt.replyWaitMs); st.timer.unref?.();
  }
  function end(st, state) {
    if (st.ended) return; st.ended = true; clearTimeout(st.timer);
    if (state !== 'done') st.link.terminal = state;
    if (live.get(st.key) === st) live.delete(st.key);
    try { st.ctl.enqueue(enc.encode('data: [DONE]\n\n')); st.ctl.close(); } catch { /* already closed */ }
  }
  const liveRun = (botId, chatId) => live.get(`${botId}\0${chatId}`);
  function startRun(scope, m, chatId) {
    const key = `${m.botId}\0${chatId}`, cur = live.get(key); if (cur) return Promise.resolve(cur);
    if (starting.has(key)) return starting.get(key);
    const st = { key, botId: m.botId, chatId, parts: [], ended: false, wrote: false, timer: null, ctl: null, run: null, link: null };
    st.link = { runId: 'bot', stop: () => interruptRun(st) };
    const p = runs.start({ scope, agent: m.name, session: chatId, timeoutMs: 5000, link: st.link, check: () => ({ 'X-Hermes-Session-Id': chatId }), onFinish: (r) => { r.text = composed(st); },
      open: async () => new Response(new ReadableStream({ start(c) { st.ctl = c; } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }) })
      .then((run) => { st.run = run; live.set(key, st); emit(st, sse({ bot: sessions.has(m.botId) ? 'online' : 'offline' }, 'foxfleet.bot')); arm(st); return st; }).finally(() => starting.delete(key));
    starting.set(key, p); return p;
  }
  /** What the bot just did in a chat, folded into that chat's reply run. Only a send opens a new run (a refused run never blocks the write). */
  async function botActivity(session, chatId, change) {
    const m = agentOf(session.reg, session.botId); if (!m) return;
    let st = liveRun(session.botId, chatId); if (!st && change.kind !== 'send') return; if (!st) { try { st = await startRun(session.scope, m, chatId); } catch { return; } }
    if (st.ended) return;
    st.wrote = st.wrote || change.kind !== 'action'; arm(st);
    if (change.kind === 'send') { st.parts.push({ id: change.id, text: change.text }); emit(st, delta((st.parts.length > 1 ? '\n\n' : '') + change.text)); }
    else if (change.kind === 'edit') {
      const part = st.parts.find((x) => x.id === change.id); if (!part) return;
      const last = part === st.parts.at(-1), old = part.text; part.text = change.text;
      if (last && change.text.startsWith(old)) { if (change.text.length > old.length) emit(st, delta(change.text.slice(old.length))); }
      else emit(st, sse({ text: composed(st) }, 'foxfleet.replace'));
    } else if (change.kind === 'delete') { const before = st.parts.length; st.parts = st.parts.filter((x) => x.id !== change.id); if (st.parts.length !== before) emit(st, sse({ text: composed(st) }, 'foxfleet.replace')); }
    else if (change.kind === 'action') emit(st, sse({ action: change.action }, 'foxfleet.bot'));
    if (change.final) end(st, 'done');
  }
  const announce = (botId, online) => { for (const st of live.values()) if (st.botId === botId) emit(st, sse({ bot: online ? 'online' : 'offline' }, 'foxfleet.bot')); };
  const endRunsOf = (botId, state) => { for (const st of [...live.values()]) if (st.botId === botId) end(st, state); };
  function noteClosed(botId, chatId, requestId, reason) {
    const st = liveRun(botId, chatId);
    if (st) emit(st, sse({ request_id: requestId, reason }, 'foxfleet.request_closed'));
    if (st) arm(st);
  }
  function pushCallbacks(session) {
    if (!session.conn) return;
    for (const frame of session.store.pendingCallbacks()) { try { session.conn.send(frame); } catch { break; } }
  }
  async function showCard(session, chatId, view) {
    const m = agentOf(session.reg, session.botId); if (!m) return;
    let st = liveRun(session.botId, chatId);
    if (!st) { try { st = await startRun(session.scope, m, chatId); } catch { return; } }
    emit(st, sse(view, 'foxfleet.request'));
    arm(st);
  }

  const eventFrame = (e) => ({ t: 'message.new', event_id: e.id, chat_id: e.chat_id, chat_type: 'dm', message_id: e.message_id, user: e.user, text: e.text, date: e.date, ...(e.reply_to ? { reply_to: e.reply_to } : {}) });
  /** Hands the connected bot the next stored events that fit its window. Events are always persisted first. */
  function pushEvents(session) {
    if (!session.conn) return;
    const room = opt.window - session.store.outstanding(session.delivered);
    if (room <= 0) return;
    for (const e of session.store.eventsAfter(session.delivered, room)) { session.conn.send(eventFrame(e)); session.delivered = e.id; }
  }
  const pushTo = (botId) => { const s = sessions.get(botId); if (s) pushEvents(s); };

  const chatBody = (data) => {
    if (!Array.isArray(data.messages) || data.messages.length < 1 || data.messages.length > 2000 || !data.messages.every((x) => x && typeof x === 'object' && ['user', 'assistant', 'system', 'tool', 'function'].includes(x.role) && (typeof x.content === 'string' || Array.isArray(x.content) || x.content === null))) throw fault(400, 'Invalid chat messages');
    if (data.session_id !== undefined && (typeof data.session_id !== 'string' || !CHAT_ID.test(data.session_id))) throw fault(404, 'Unknown session');
    if (data.client_id !== undefined && !/^[\w.:-]{8,100}$/.test(String(data.client_id))) throw fault(400, 'Invalid client_id');
    const last = [...data.messages].reverse().find((x) => x.role === 'user'); if (!last) throw fault(400, 'No user message');
    if (Array.isArray(last.content) && !last.content.every((p) => typeof p === 'string' || (p && typeof p === 'object' && typeof p.text === 'string' && [undefined, 'text', 'input_text'].includes(p.type)))) throw fault(400, 'Only text messages are supported for bot agents', 'unsupported');
    const text = flattenContent(last.content).text.trim();
    if (!text || text.includes('\0')) throw fault(400, 'Empty message');
    if (Buffer.byteLength(text) > LIMITS.max_text_bytes) throw fault(413, 'Message too large', 'too_large');
    return { text, sessionId: data.session_id, clientId: data.client_id };
  };

  async function accept(c, { text, sessionId, clientId }, newChatId) {
    const { m } = c, store = storeFor(c.scope, c.reg, m.botId);
    try { await store.load(); } catch (e) { throw fault(503, 'The bot store is unavailable', 'bot_store_unavailable'); }
    const result = await store.acceptUser({ user: { id: c.user.id, name: c.user.username }, chatId: sessionId, newChatId, text, clientId });
    if (!result.duplicate) { c.reg.activity.touch(m.name, { role: 'user', text, session: result.chat_id }); pushTo(m.botId); }
    return result;
  }
  const messageView = (result, text, sessionId) => ({ id: result.message.id, state: 'queued', mode: 'queue', ack: 'queued', text, created: result.message.created, session_id: sessionId });

  async function postMessages(c) {
    const input = chatBody(await c.readJson(c.req)), result = await accept(c, input, input.sessionId ? undefined : freshChatId());
    let runId = liveRun(c.m.botId, result.chat_id)?.run.id;
    if (!runId && !result.duplicate) { try { runId = (await startRun(c.scope, c.m, result.chat_id)).run.id; } catch { /* too many live runs: the message is stored, there is just nothing to follow */ } }
    c.sendJson(c.res, result.duplicate ? 200 : 202, { message: messageView(result, input.text, result.chat_id), session_id: result.chat_id, ...(runId ? { run_id: runId } : {}), bot: { online: sessions.has(c.m.botId) }, ...(result.duplicate ? { duplicate: true } : {}) });
  }
  async function postChat(c) {
    const input = chatBody(await c.readJson(c.req)), store = await readyStore(c);
    const dup = input.clientId ? store.clientMatch({ clientId: input.clientId, chatId: input.sessionId, text: input.text }) : null;
    const fresh = input.sessionId || dup ? undefined : freshChatId(), chatId = dup?.chat_id ?? input.sessionId ?? fresh;
    if (!dup && input.sessionId && !store.hasChat(chatId)) throw fault(404, 'Unknown session');
    const existed = Boolean(liveRun(c.m.botId, chatId)); let st = await startRun(c.scope, c.m, chatId), result;
    try { result = await accept(c, input, fresh); } catch (e) { if (!existed) end(st, 'stopped'); throw e; }
    if (result.chat_id !== chatId) { if (!existed) end(st, 'stopped'); st = await startRun(c.scope, c.m, result.chat_id); }
    return runs.attach(c.req, c.res, st.run);
  }
  function runRoutes(c) {
    const { req, res, parts, url, scope, m } = c;
    if (parts.length === 4 && req.method === 'GET') return c.sendJson(res, 200, { runs: runs.list(scope, m.name, url.searchParams.get('session_id') || undefined) });
    if (parts.length === 6 && parts[5] === 'events' && req.method === 'GET') { const r = runs.get(scope, m.name, parts[4]), after = Number(url.searchParams.get('after') ?? req.headers['last-event-id'] ?? 0); return runs.attach(req, res, r, Number.isInteger(after) && after > 0 ? after : 0); }
    if (parts.length === 6 && parts[5] === 'stop' && req.method === 'POST') return (async () => {
      await c.readJson(req);
      const r = runs.get(scope, m.name, parts[4]);
      if (r.link) r.link.actor = { id: String(c.user?.id ?? ''), name: String(c.user?.username ?? '').replaceAll('\0', '').slice(0, 256) };
      const confirmed = await runs.stopAndWait(r);
      return c.sendJson(res, 200, { run: runs.view(r), confirmed });
    })();
    throw fault(404, 'Not found');
  }

  const page = (v, lo, hi, d) => { const n = Number(v ?? d); return Number.isInteger(n) ? Math.min(Math.max(n, lo), hi) : d; };
  async function readyStore(c) {
    const store = storeFor(c.scope, c.reg, c.m.botId);
    try { await store.load(); } catch { throw fault(503, 'The bot store is unavailable', 'bot_store_unavailable'); }
    return store;
  }
  async function sessionRoutes(c) {
    const { req, res, parts, url } = c, store = await readyStore(c);
    if (parts.length === 4 && req.method === 'GET') return c.sendJson(res, 200, store.chats({ q: (url.searchParams.get('q') || '').slice(0, 200), limit: page(url.searchParams.get('limit'), 1, 100, 30), offset: page(url.searchParams.get('offset'), 0, 100000, 0) }));
    if (parts.length === 6 && parts[5] === 'messages' && req.method === 'GET') return c.sendJson(res, 200, store.transcript(parts[4], { limit: page(url.searchParams.get('limit'), 1, 200, 80), offset: page(url.searchParams.get('offset'), 0, 100000, 0) }));
    if (parts.length === 4 && req.method === 'POST') {
      const b = await c.readJson(req, 4096), title = b.title === undefined || b.title === '' ? undefined : b.title;
      if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.length > 200 || /[\x00-\x1f]/.test(title))) throw fault(400, 'Invalid title');
      const made = await store.createChat(title?.trim()); return c.sendJson(res, 201, { id: made.id, session_id: made.id, title: made.title });
    }
    if (parts.length === 5 && req.method === 'PATCH') {
      const b = await c.readJson(req, 4096); if (typeof b.title !== 'string' || !b.title.trim() || b.title.length > 200) throw fault(400, 'Invalid title');
      return c.sendJson(res, 200, await store.renameChat(parts[4], b.title.trim()));
    }
    if (parts.length === 5 && req.method === 'DELETE') {
      await store.deleteChat(parts[4]); const st = liveRun(c.m.botId, parts[4]); if (st) end(st, 'stopped');
      return c.sendJson(res, 200, { ok: true });
    }
    throw fault(404, 'Not found');
  }

  /** One request context, never a socket session: HTTP must not acquire or replace the receive lease. */
  async function rpc(req, res, { sendJson, throttle }) {
    if (closing) throw fault(503, 'The bot API is shutting down');
    if (req.url !== '/api/bot/rpc') throw fault(400, 'Use the exact bot RPC path without a query string');
    if (!secureBotRequest({ remoteAddress: req.socket.remoteAddress, host: req.headers.host, xfp: req.headers['x-forwarded-proto'], trusted })) throw fault(403, 'Forbidden');
    const token = /^Bot (ffb_[A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '')?.[1];
    // Only failed authentication spends the shared per-IP login budget; authenticated requests are bounded by the bot's own bucket.
    const unauthorized = () => { throttle.fail(); return fault(401, 'Unauthorized'); };
    throttle.check();
    if (!token) throw unauthorized();
    await tokens.ready();
    const id = tokens.verify(token), owner = id && ownerOf(id.scope);
    if (!id || !owner || owner.disabled || gone.has(id.botId)) throw unauthorized();
    // Every authenticated request costs one bot rate token BEFORE any store load or body read, so invalid or
    // oversized bodies are bounded too. The frame is unread here, so the envelope carries id: null.
    try { takeToken(id.botId); }
    catch (e) {
      if (!(e instanceof BotError)) throw e;
      req.resume();
      return sendJson(res, 200, { t: 'res', id: null, ok: false, error: { code: e.botCode, message: e.message, retry_after_ms: e.retry_after_ms } });
    }
    const session = { ...id, fenced: false, authorized: () => !closing && !gone.has(id.botId) && Boolean(session.reg && agentOf(session.reg, id.botId)) && tokens.verify(token)?.botId === id.botId };
    requests.add(session);
    try {
      const reg = session.reg = await scopeReg(id.scope);
      guard(session)();
      const store = session.store = storeFor(id.scope, reg, id.botId); await store.load();
      guard(session)();
      if (Number(req.headers['content-length']) > LIMITS.max_frame_bytes) { req.resume(); throw fault(413, 'Request body too large'); }
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > LIMITS.max_frame_bytes) { req.resume(); throw fault(413, 'Request body too large'); } chunks.push(chunk); }
      let frame;
      try { frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { throw fault(400, 'Invalid JSON body'); }
      guard(session)();
      const v = validateHttpRequest(frame);
      const answer = (out) => sendJson(res, 200, { t: 'res', id: v.id, ...out });
      if (!v.ok) return answer({ ok: false, error: { code: v.code, message: v.message } });
      try {
        const out = await dispatch(session, v);
        return answer({ ok: true, result: out.result, ...(out.replayed ? { replayed: true } : {}) });
      } catch (e) {
        if (!(e instanceof BotError)) throw e;
        return answer({ ok: false, error: { code: e.botCode, message: e.message, ...(e.retry_after_ms ? { retry_after_ms: e.retry_after_ms } : {}) } });
      }
    } finally { requests.delete(session); }
  }

  async function upgrade(req, socket, head, { deny, throttle }) {
    const refuse = (status) => deny(status, STATUS_TEXT[status] ?? 'Error');
    try {
      if (closing) return refuse(503);
      if (req.url.includes('?')) return refuse(400);
      const origin = req.headers.origin;
      if (origin !== undefined && !(trusted.has(origin) || origin === `http://${req.headers.host}`)) return refuse(403);
      if (!secureBotRequest({ remoteAddress: req.socket.remoteAddress, host: req.headers.host, xfp: req.headers['x-forwarded-proto'], trusted })) return refuse(403);
      if (checkHandshake(req)) return refuse(400);
      throttle();
      const token = /^Bot (ffb_[A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '')?.[1];
      if (!token) return refuse(401);
      await tokens.ready();
      const id = tokens.verify(token); if (!id) return refuse(401);
      const admit = async () => { const owner = ownerOf(id.scope); if (!owner || owner.disabled) return null; const reg = await scopeReg(id.scope), agent = agentOf(reg, id.botId); return agent ? { reg, agent } : null; };
      const found = await admit(); if (!found || gone.has(id.botId)) return refuse(401);
      const store = storeFor(id.scope, found.reg, id.botId); await store.load();
      const again = tokens.verify(token), owner = ownerOf(id.scope);
      if (!again || again.botId !== id.botId || !owner || owner.disabled || !agentOf(found.reg, id.botId) || gone.has(id.botId)) return refuse(401);
      const session = { scope: id.scope, botId: id.botId, store, reg: found.reg, conn: null, delivered: store.acked(), fenced: false, protocol: protocolForSubprotocol(selectSubprotocol(req.headers['sec-websocket-protocol'])) };
      acceptBotSocket(req, socket, head, {
        heartbeatMs: opt.heartbeatMs, maxBufferedBytes: opt.maxBufferedBytes,
        onOpen: (conn) => {
          session.conn = conn; const old = sessions.get(id.botId); sessions.set(id.botId, session); if (old) fence(old, 4009, 'replaced by a newer connection');
          const hello = { t: 'hello', protocol: session.protocol, bot: id.botId, resume_from: store.acked(), latest_event_id: store.latestEventId(), heartbeat_ms: opt.heartbeatMs, limits: { ...LIMITS, max_unacked: limits.maxUnacked } };
          if (session.protocol === PROTOCOL_V11) hello.features = ['stop', 'cards'];
          conn.send(hello);
          pushEvents(session); pushCallbacks(session); announce(id.botId, true);
          log('bot.connected', { bot: id.botId });
        },
        onMessage: (text) => handle(session, text),
        onClose: (code) => { failStops(session, 'disconnected'); if (sessions.get(id.botId) === session) { sessions.delete(id.botId); announce(id.botId, false); } log('bot.closed', { bot: id.botId, code }); },
      });
    } catch (error) { refuse(error.status === 429 ? 429 : error.status === 503 ? 503 : error.safe ? error.status : 503); }
  }

  const closeScope = (scope, code = 4003, reason = 'account disabled or removed') => {
    for (const s of requests) if (s.scope === scope) fence(s, code, reason);
    for (const s of [...sessions.values()]) if (s.scope === scope) fence(s, code, reason);
    return Promise.all([...stores.values()].filter((e) => e.scope === scope).map((e) => e.store.idle()));
  };
  let closing = false;
  async function close() {
    closing = true;
    const open = [...sessions.values()];
    for (const s of open) s.conn.close(1001, 'hub shutting down');
    for (const st of [...live.values()]) end(st, 'stopped');
    await Promise.all(open.map((s) => s.conn.done));
    await Promise.allSettled([tokens.idle(), ...[...stores.values()].map((e) => e.store.idle())]);
  }

  return {
    hasToken: (botId) => tokens.has(botId),
    sizes: () => ({ sessions: sessions.size, stores: stores.size, buckets: buckets.size, live: live.size, starting: starting.size, gone: gone.size, stops: stops.size }),
    probe,
    rpc,
    upgrade,
    close,
    closeScope,
    /** The account is gone: its tokens die with it and its bots are disconnected. */
    async revokeScope(scope) {
      await closeScope(scope);
      await tokens.ready(); await tokens.revokeScope(scope);
      for (const [botId, e] of [...stores]) if (e.scope === scope) { await e.store.idle(); stores.delete(botId); buckets.delete(botId); }
    },
    /** The agent record is being deleted: revoke its token, disconnect it and delete its store file. */
    async removeAgent(m, reg) {
      gone.add(m.botId);
      const old = sessions.get(m.botId); if (old) fence(old, 4003, 'agent deleted');
      endRunsOf(m.botId, 'stopped');
      try { await tokens.ready(); await tokens.revoke(m.botId); } catch { /* an unreadable token file is left for the operator; the deleted agent can no longer be admitted anyway */ }
      await (stores.get(m.botId)?.store ?? botStore(path.join(reg.dir, 'bot', `${m.botId}.json`), limits)).remove(); stores.delete(m.botId); buckets.delete(m.botId);
      log('bot.removed', { bot: m.botId });
    },
    /** Every /api/agents/:name/... request for a bot agent (except pin) lands here. */
    async route(c) {
      const { req, res, parts, m } = c;
      if (parts[3] === 'bot-token' && parts.length === 4 && req.method === 'POST') {
        await c.readJson(req, 4096); c.current(m);
        return c.sendJson(res, 201, await mint(c.scope, m));
      }
      if (parts[3] === 'bot-token' && parts.length === 4 && req.method === 'DELETE') {
        await c.readJson(req, 4096); c.current(m);
        await revoke(m);
        return c.sendJson(res, 200, { ok: true });
      }
      if (parts[3] === 'messages' && parts.length === 4 && req.method === 'POST') return await postMessages(c);
      if (parts[3] === 'queue' && parts.length === 4 && req.method === 'GET') {
        const session = c.url.searchParams.get('session_id') || '';
        const store = await readyStore(c);
        const expired = await store.expireCards();
        for (const row of expired) noteClosed(m.botId, row.chat_id, row.id, 'expired');
        return c.sendJson(res, 200, { items: [], recent: [], halted: false, active_run: liveRun(m.botId, session)?.run.id ?? null, modes: ['queue'], open_requests: CHAT_ID.test(session) ? store.openRequests(session) : [], can_cancel: false });
      }
      if (parts[3] === 'commands' && parts.length === 4 && req.method === 'GET') {
        const store = await readyStore(c), mine = store.commands().map((x) => ({ name: x.name, aliases: [], description: x.description, category: 'Bot', args: '', subcommands: [], availability: 'chat', handler: 'chat', busy: 'queue', executable: true, verified: false }));
        return c.sendJson(res, 200, { source: 'bot', busy: ['queue'], commands: [...mine, ...appCommands] });
      }
      if (parts[3] === 'chat' && parts.length === 4 && req.method === 'POST') return await postChat(c);
      if (parts[3] === 'runs') return await runRoutes(c);
      if (parts[3] === 'native' && parts.length === 8 && parts[4] === 'sessions' && parts[6] === 'requests' && req.method === 'POST') {
        const body = await c.readJson(req);
        const chatId = parts[5], requestId = parts[7];
        if (!CHAT_ID.test(chatId) || !CARD_ID.test(requestId)) throw fault(404, 'That question is no longer open');
        const store = await readyStore(c);
        const user = { id: String(c.user?.id ?? ''), name: String(c.user?.username ?? '').replaceAll('\0', '').slice(0, 256) };
        try {
          const out = await store.answerCard({ requestId, chatId, user, result: body?.result });
          const live = sessions.get(m.botId);
          if (live?.conn) { try { live.conn.send(out.callback); } catch { /* replayed on the next hello */ } }
          noteClosed(m.botId, chatId, requestId, 'answered');
          return c.sendJson(res, 200, { ok: true });
        } catch (e) {
          if (e instanceof BotError && e.closed) for (const row of e.closed) noteClosed(m.botId, row.chat_id, row.id, 'expired');
          throw httpFault(e);
        }
      }
      if (parts[3] === 'sessions') return await sessionRoutes(c);
      throw fault(404, 'Not found');
    },
  };
}
