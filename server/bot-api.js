// FoxFleet bot API (contract/bot-api.md): token routes, the bot socket, and the agent routes of bot agents.
import path from 'node:path';
import { createHmac, createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { botMedia, MEDIA_MAX, sniffBotMedia } from './bot-media.js';
import { conversationMedia, revokeMessageMedia } from './conversation-media.js';
import { fault } from './config.js';
import { tokenIndex, botStore, botLimits, freshChatId, BotError, httpFault } from './bot-store.js';
import { acceptBotSocket, checkHandshake } from './bot-ws.js';
import { PROTOCOL, PROTOCOL_V11, PROTOCOL_V12, ROOM_FEATURES, ROOM_LIMITS, LIMITS, CHAT_ID, CARD_ID, parseBotFrame, validateRequest, validateRequestV12, validateHttpRequest, validateMediaRequest, validateStopAnswer, validateCardRequest, validateCardCallback, cardView, selectSubprotocol, protocolForSubprotocol } from './bot-protocol.js';
import { createDispatchEngine } from './conversation-dispatch.js';
import { flattenContent } from './transcript.js';
import { takeReact } from './media-tags.js';
import { agentReactions, reactionView, replyReaction } from './reactions.js';

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
export async function createBotApi({ dataDir, scopeReg, ownerOf, runs, trusted = new Set(), appCommands = [], options = {}, log = () => {}, media }) {
  const opt = { heartbeatMs: 25000, maxBufferedBytes: 8 * 1024 * 1024, window: LIMITS.window, replyIdleMs: 30_000, replyWaitMs: 300_000, ...options, rate: { burst: 60, perSec: 20, ...options.rate } };
  const limits = botLimits({ maxUnacked: options.maxUnacked, maxChats: options.maxChats, maxMessagesPerChat: options.maxMessagesPerChat });
  const tokens = tokenIndex(path.join(dataDir, 'bot', 'tokens.json'));
  await tokens.ready().catch(() => {});
  const blobs = botMedia({ maxBytes: options.maxMediaBytes, quotaBytes: options.mediaQuotaBytes ?? options.maxMediaQuotaBytes });
  const roomMedia = conversationMedia({ maxBytes: options.maxMediaBytes, quotaBytes: options.mediaQuotaBytes ?? options.maxMediaQuotaBytes });
  const mediaSecret = randomBytes(32);
  const mediaSign = (p) => createHmac('sha256', mediaSecret).update(p).digest('base64url');
  const sessions = new Map(), stores = new Map(), gone = new Set(), requests = new Set(), stops = new Map();
  const STOP_MS = Number.isInteger(options.stopMs) && options.stopMs > 0 ? options.stopMs : 10_000;

  // ---- rooms (foxfleet.bot/1.2) ------------------------------------------------------------------
  // One durable dispatch engine per account, reusing conversation-store and conversation-dispatch. Human room
  // HTTP sends enter through engine.submit (the store's own send is wrapped once per account), so routing,
  // serial turns and the handoff budget are the policy that already exists. Bot I/O is a socket transport:
  // dispatch offers/runs are transient frames; room message.new is the frozen contract event.
  const roomHubs = new Map(), roomRuns = new Map(), staleRuns = new Set(), roomStops = new Map(), stoppedRooms = new Set();
  const roomThread = (chatId) => 'fcr_' + String(chatId).slice(3);
  const attemptKey = (botId, dispatchId, runToken) => `${botId}\0${dispatchId}\0${runToken}`;
  const rememberStale = (key) => {
    if (!key) return;
    staleRuns.add(key);
    if (staleRuns.size > 2000) staleRuns.delete(staleRuns.values().next().value);
  };
  /** Drop one live binding. The pending run() settles as failed so an overlapping pump never completes it. */
  function staleRoomRun(run, code = 'dispatch_stale', reason = 'superseded by a newer attempt') {
    if (!run) return;
    if (roomRuns.get(run.key) === run) roomRuns.delete(run.key);
    rememberStale(run.key);
    if (code === 'room_stopped') stoppedRooms.add(`${run.botId}\0${run.roomId}`);
    run.stale = true;
    const resolve = run.resolve;
    run.resolve = null;
    resolve?.({ failed: true, code, reason });
  }
  const stopOutcome = (outcome) => (outcome === 'stopped' || outcome === 'idle' || outcome === 'refused' ? outcome
    : outcome === 'expired' || outcome === 'timeout' ? 'timeout' : 'uncertain');
  function settleRoomStop(entry, outcome) {
    if (!entry || entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timer);
    roomStops.delete(entry.stop_id);
    const state = stopOutcome(outcome);
    staleRoomRun(entry.run, 'room_stopped', `room stop ${state}`);
    entry.resolve({ state, code: state });
  }
  /** Ask one live room attempt to cancel through the owner-only chat.stop path and wait for its answer. */
  function requestRoomCancel(target, { roomId, attempt, actor }) {
    return new Promise((resolve) => {
      const session = target.session;
      const found = roomRuns.get(attemptKey(target.botId, attempt.dispatch_id, attempt.token));
      if (!target.online || !session?.conn || session.protocol !== PROTOCOL_V12) {
        stoppedRooms.add(`${target.botId}\0${roomId}`);
        if (found) staleRoomRun(found, 'room_stopped', 'room stop while the agent was offline');
        resolve({ state: 'uncertain', code: 'agent_offline' });
        return;
      }
      if (!found || found.session !== session || found.stale) {
        stoppedRooms.add(`${target.botId}\0${roomId}`);
        if (found) staleRoomRun(found, 'room_stopped', 'room stop after the attempt was replaced');
        resolve({ state: 'uncertain', code: 'dispatch_not_running' });
        return;
      }
      const run = found;
      const stop_id = 'fs_' + randomBytes(12).toString('base64url');
      const nowMs = Date.now(), expires = nowMs + STOP_MS;
      const entry = { stop_id, session, roomId, run, resolve, settled: false, timer: null, expires };
      roomStops.set(stop_id, entry);
      const timer = setTimeout(() => settleRoomStop(entry, 'timeout'), Math.max(0, expires - nowMs));
      timer.unref?.();
      entry.timer = timer;
      try {
        session.conn.send({
          t: 'chat.stop', stop_id, chat_id: roomId, chat_type: 'group', thread_id: roomThread(roomId),
          actor: { kind: 'human', id: actor.id, name: actor.name, is_bot: false },
          date: nowMs, expires_at: expires,
        });
      } catch {
        settleRoomStop(entry, 'uncertain');
      }
    });
  }
  const roomActor = (m) => (m.author_kind === 'agent'
    ? { kind: 'agent', id: m.author_id, name: m.author_name, is_bot: true }
    : { kind: 'human', id: m.author_id, name: m.author_name, is_bot: false });
  const roomBotError = (e) => (e instanceof BotError ? e : new BotError(e?.code ?? 'internal', e?.message ?? 'Room request failed', e?.status ? { status: e.status } : {}));

  function roomHubFor(reg, scope) {
    if (!reg?.conversations) return null;
    let hub = roomHubs.get(scope);
    if (hub) return hub;
    const store = reg.conversations;
    const engine = createDispatchEngine({ store });
    hub = { scope, reg, store, engine, targets: new Map() };
    roomHubs.set(scope, hub);
    const originalSend = store.send.bind(store);
    // Owner HTTP room sends route exactly once; the engine's own write passes `admit` and goes straight through.
    store.send = (id, opts = {}) => (opts?.actor?.kind === 'human' && typeof opts.admit !== 'function'
      ? engine.submit(id, opts) : originalSend(id, opts));
    if (typeof store.addMember === 'function') {
      const originalAdd = store.addMember.bind(store);
      store.addMember = async (id, opts = {}) => {
        const out = await originalAdd(id, opts);
        await notifyRoomMember(hub, id, 'join', opts?.agent?.actor_id).catch(() => {});
        return out;
      };
    }
    if (typeof store.removeMember === 'function') {
      const originalRemove = store.removeMember.bind(store);
      store.removeMember = async (id, opts = {}) => {
        const out = await originalRemove(id, opts);
        await notifyRoomMember(hub, id, 'leave', opts?.agentId).catch(() => {});
        return out;
      };
    }
    return hub;
  }

  const roomMemberRef = (memberId) => {
    const value = String(memberId ?? '');
    return value.startsWith('agent:') ? value : 'agent:' + value;
  };
  function roomMemberFrame(snap, action, row, eventId, date) {
    return {
      t: 'chat.member', event_id: Math.max(1, eventId), chat_id: snap.id, chat_type: 'group',
      thread_id: roomThread(snap.id), action,
      actor: { kind: 'human', id: snap.owner_id, name: snap.owner_name, is_bot: false },
      member: { kind: 'agent', id: row.actor_id, name: row.name, is_bot: true },
      date,
    };
  }
  /** A durable membership change is live for every 1.2 member; a removed agent still gets its own leave. */
  async function notifyRoomMember(hub, roomId, action, memberId) {
    const snap = await roomSnapshot(hub, roomId);
    if (!snap) return;
    const ref = roomMemberRef(memberId);
    const row = snap.members.find((m) => m.actor_kind === 'agent' && m.actor_id === ref);
    if (!row) return;
    const prior = [...snap.outbox].reverse().find((e) => e.type === 'chat.member'
      && e.action === action && e.member_id === ref);
    const at = prior?.at ?? Date.now();
    const frame = roomMemberFrame(snap, action, row, at, at);
    for (const session of sessions.values()) {
      if (session.protocol !== PROTOCOL_V12 || !session.conn || session.reg !== hub.reg) continue;
      const agent = agentOf(session.reg, session.botId);
      if (!agent) continue;
      const self = 'agent:' + agent.name;
      const member = snap.members.some((m) => m.actor_kind === 'agent' && m.actor_id === self && m.removed_at === null);
      if (!member && !(action === 'leave' && self === ref)) continue;
      try { session.conn.send(frame); } catch { /* a closed socket gets the snapshot on reconnect */ }
    }
  }
  /** Connect-time truth: every active agent member of every room this bot is in appears as a join. */
  async function replayRoomMembers(session, hub) {
    if (session.protocol !== PROTOCOL_V12 || !session.conn) return;
    const agent = agentOf(session.reg, session.botId);
    if (!agent) return;
    const self = 'agent:' + agent.name;
    const rooms = await hub.store.roomIds();
    for (const roomId of rooms) {
      if (!session.conn || session.protocol !== PROTOCOL_V12) return;
      const snap = await roomSnapshot(hub, roomId);
      if (!snap) continue;
      if (!snap.members.some((m) => m.actor_kind === 'agent' && m.actor_id === self && m.removed_at === null)) continue;
      for (const row of snap.members) {
        if (row.actor_kind !== 'agent' || row.removed_at !== null) continue;
        const at = row.joined_at ?? snap.created_at ?? 1;
        try { session.conn.send(roomMemberFrame(snap, 'join', row, at, at)); } catch { return; }
      }
    }
  }

  function roomTarget(hub, agentId) {
    let target = hub.targets.get(agentId);
    if (target) return target;
    target = {
      online: false, session: null, botId: null, agentId,
      offer: async ({ roomId, dispatch }) => {
        if (!target.online || !target.session?.conn) return { accepted: false, code: 'agent_offline', reason: 'the agent is offline' };
        target.session.conn.send({
          t: 'dispatch.offer', dispatch_id: dispatch.id, chat_id: roomId, thread_id: roomThread(roomId),
          target_agent_id: agentId, root_id: dispatch.root_id, deadline_at: dispatch.root_deadline,
        });
        return { accepted: true };
      },
      run: (ctx) => runRoomTurn(hub, target, ctx),
      cancel: (request) => requestRoomCancel(target, request),
    };
    hub.engine.register(agentId, target);
    return target;
  }

  async function roomSnapshot(hub, roomId) {
    try { return await hub.store.snapshot(roomId); }
    catch (e) { if (e?.code === 'conversation_not_found') return null; throw e; }
  }

  async function runRoomTurn(hub, target, ctx) {
    const session = target.session;
    if (!target.online || !session?.conn || session.protocol !== PROTOCOL_V12) {
      return { failed: true, code: 'agent_offline', reason: 'the agent is offline' };
    }
    const snap = await roomSnapshot(hub, ctx.roomId);
    if (!snap) return { failed: true, code: 'not_found', reason: 'the room no longer exists' };
    // Stop may have committed while this turn was being offered/accepted. The durable row is the fence:
    // never hand a stopped, replaced or paused attempt to the bot just because the Promise survived.
    const current = (snap.dispatches ?? []).find((d) => d.id === ctx.dispatch.id);
    if (!current || current.state !== 'running' || current.run_token !== ctx.attempt.token
      || snap.epoch !== ctx.dispatch.epoch || snap.paused) {
      return { failed: true, code: 'dispatch_stale', reason: 'the attempt was stopped or replaced before it started' };
    }
    const message = snap.messages.find((m) => m.id === ctx.dispatch.request_message_id && !m.deleted_at);
    if (!message) return { failed: true, code: 'not_found', reason: 'the dispatch message was not found' };
    const threadId = roomThread(snap.id);
    const actor = roomActor(message);
    const media = (snap.media ?? []).filter((g) => g.message_id === message.id && !g.revoked_at)
      .map(({ id, kind, mime, name, size }) => ({ id, kind, mime, name, size }));
    const frame = {
      t: 'dispatch.run', dispatch_id: ctx.dispatch.id, run_token: ctx.attempt.token,
      chat_id: snap.id, thread_id: threadId, message_id: message.id, actor,
      target_agent_id: target.agentId, owner_id: snap.owner_id,
      mentions: message.mentions ?? [], text: message.body, date: message.created_at,
      ...(media.length ? { media } : {}),
      ...(message.reply_to ? { reply_to: message.reply_to } : {}),
      root_id: ctx.dispatch.root_id, deadline_at: ctx.dispatch.root_deadline,
    };
    const key = attemptKey(target.botId, ctx.dispatch.id, ctx.attempt.token);
    // A newer attempt owns this room slot; the old Promise must settle so an overlapping pump can never
    // complete the newer dispatch through the old binding.
    for (const prior of [...roomRuns.values()]) {
      if (prior.botId === target.botId && prior.roomId === snap.id) staleRoomRun(prior);
    }
    stoppedRooms.delete(`${target.botId}\0${snap.id}`);
    const run = {
      key, session, target, botId: target.botId, roomId: snap.id, chatId: snap.id, threadId,
      ctx, dispatchId: ctx.dispatch.id, runToken: ctx.attempt.token, frame,
      resolve: null, handoff: null, parts: [],
    };
    roomRuns.set(key, run);
    // Frozen contract event first (the durable message), then the transport binding for this turn.
    const event = {
      t: 'message.new', event_id: message.seq, chat_id: snap.id, chat_type: 'group', thread_id: threadId,
      message_id: message.id, actor, mentions: message.mentions ?? [], text: message.body, date: message.created_at,
      ...(message.reply_to ? { reply_to: message.reply_to } : {}),
    };
    try {
      session.conn.send(event);
      session.conn.send(frame);
    } catch {
      roomRuns.delete(key);
      return { failed: true, code: 'agent_offline', reason: 'the agent socket closed before the turn' };
    }
    return new Promise((resolve) => { run.resolve = resolve; });
  }

  function roomReceipt(session, run, state, code = null) {
    if (!session?.conn) return;
    const text = code ? `Dispatch ${run.dispatchId} is ${state} (${code}).` : `Dispatch ${run.dispatchId} is ${state}.`;
    try {
      session.conn.send({ t: 'dispatch.status', chat_id: run.chatId, thread_id: run.threadId,
        dispatch_id: run.dispatchId, state, ...(code ? { code } : {}), text, date: Date.now() });
    } catch { /* a closed socket replays the durable state on reconnect */ }
  }

  /** Re-send the live turn binding to a reconnected 1.2 socket. The plugin dedupes by (dispatch_id, run_token). */
  function resumeRoomRuns(session) {
    if (session.protocol !== PROTOCOL_V12) return;
    for (const run of roomRuns.values()) {
      if (run.botId !== session.botId) continue;
      if (run.session !== session) {
        run.session = session;
        run.target.session = session;
      }
      try {
        session.conn.send(run.frame);
        roomReceipt(session, run, 'running', 'reconnected');
      } catch { /* the close path marks it */ }
    }
  }

  /** Unanswered owner taps are durable room records; replay them on reconnect until the bot acknowledges. */
  async function pushRoomCallbacks(session, hub) {
    if (session.protocol !== PROTOCOL_V12 || !session.conn) return;
    const agent = agentOf(session.reg, session.botId);
    if (!agent) return;
    const target = 'agent:' + agent.name;
    const pending = await hub.store.pendingRoomCallbacks({ targetAgentId: target });
    for (const callback of pending) {
      if (!session.conn) return;
      try { session.conn.send(callback); } catch { return; }
    }
  }

  async function roomCardClose(session, v, hub) {
    const agent = agentOf(session.reg, session.botId);
    if (!agent) throw new BotError('forbidden', 'This bot is not an active agent');
    const out = await hub.store.closeRoomCards({
      targetAgentId: 'agent:' + agent.name,
      request_id: v.req.request_id,
      all_except_instance: v.req.all_except_instance,
      reason: v.req.reason,
    });
    return { result: { closed: out.closed } };
  }

  async function roomRequest(session, v, hub) {
    const snap = await roomSnapshot(hub, v.req.chat_id);
    if (!snap) return null; // not a room: the DM path keeps its byte-compatible behaviour
    const agent = agentOf(session.reg, session.botId);
    if (!agent) throw new BotError('forbidden', 'This bot is not an active agent');
    const actorId = 'agent:' + agent.name;
    const member = snap.members.find((m) => m.actor_kind === 'agent' && m.actor_id === actorId && m.role === 'member' && m.removed_at === null);
    if (!member) throw new BotError('forbidden', 'Agent is not an active member of this room');
    const requestedDispatch = v.req.dispatch_id;
    const requestedToken = v.req.run_token;
    const hasAttempt = requestedDispatch !== undefined || requestedToken !== undefined;
    const both = typeof requestedDispatch === 'string' && typeof requestedToken === 'string';
    const exactKey = both ? attemptKey(session.botId, requestedDispatch, requestedToken) : null;
    const exact = exactKey ? roomRuns.get(exactKey) : null;
    const attemptRow = both ? (snap.dispatches ?? []).find((d) => d.id === requestedDispatch) : null;
    const epochAdvanced = Boolean(attemptRow && attemptRow.epoch !== snap.epoch);
    const active = exact && exact.roomId === snap.id && exact.session === session && !exact.stale
      && exact.ctx?.dispatch?.epoch === snap.epoch ? exact : null;
    const live = [...roomRuns.values()].find((r) => r.botId === session.botId && r.roomId === snap.id && !r.stale) ?? null;
    const sameDispatch = both
      ? [...roomRuns.values()].find((r) => r.botId === session.botId && r.dispatchId === requestedDispatch && !r.stale)
      : null;
    const stoppedRoom = stoppedRooms.has(`${session.botId}\0${snap.id}`);
    // The in-memory Stop marker is only a cache. The durable paused flag (and an advanced epoch on the
    // named attempt) is the fence, so a hub restart or a fresh engine still refuses late chatter.
    const paused = Boolean(snap.paused);
    const stale = epochAdvanced
      || (both && (Boolean(exact) || Boolean(sameDispatch) || staleRuns.has(exactKey)))
      || (!both && (stoppedRoom || paused));
    const refusal = stale
      ? new BotError('dispatch_stale', 'That dispatch was replaced')
      : new BotError('dispatch_not_running', 'That dispatch is no longer running');
    // Never infer the current (bot, room) turn: an output frame binds only by its exact attempt pair.
    // After a Stop the room keeps a stale marker until a new run starts, so an unbound late completion
    // cannot be mistaken for a fresh plain room message.
    const stopped = stoppedRoom || paused;
    const needsBinding = v.t === 'handoff.request'
      || (v.t === 'message.send' && (hasAttempt || Boolean(live) || stopped))
      || (v.t === 'message.edit' && (hasAttempt || Boolean(live) || stopped));
    if (!active && needsBinding) throw refusal;
    const actor = { kind: 'agent', id: actorId, name: member.name };

    async function completeRoomTurn(run, message) {
      let handoff = null;
      if (run.handoff) {
        try {
          handoff = await run.ctx.handoff({ source_message_id: message?.id, ...run.handoff });
          roomReceipt(session, run, 'handoff', null);
        } catch (e) {
          const code = e?.code ?? 'handoff_failed';
          roomReceipt(session, run, 'handoff_failed', code);
          log('bot.room.handoff_failed', { bot: session.botId, room: snap.id, code });
        }
      }
      if (roomRuns.get(run.key) === run) {
        roomRuns.delete(run.key);
        rememberStale(run.key);
        const resolve = run.resolve;
        run.resolve = null;
        resolve?.({});
      }
      return handoff;
    }

    switch (v.t) {
      case 'handoff.request': {
        if (!active) throw refusal;
        if (v.req.source_message_id) {
          const source = snap.messages.find((m) => m.id === v.req.source_message_id && !m.deleted_at);
          if (source && source.author_kind === 'agent' && source.author_id !== actorId) {
            throw new BotError('forbidden', 'The handoff source is not this agent');
          }
        }
        if (active.handoff && (active.handoff.target_agent_id !== v.req.target_agent_id || active.handoff.text !== v.req.text)) {
          throw new BotError('idempotency_conflict', 'A different handoff is already pending for this turn');
        }
        active.handoff ??= { target_agent_id: v.req.target_agent_id, text: v.req.text, idempotency_key: v.req.idempotency_key };
        roomReceipt(session, active, 'handoff_pending');
        return { result: { pending: true, chat_id: snap.id, thread_id: roomThread(snap.id), target_agent_id: v.req.target_agent_id, deadline_at: active.ctx.dispatch.root_deadline } };
      }
      case 'chat.get': {
        return { result: {
          chat_id: snap.id, thread_id: roomThread(snap.id), chat_type: 'group', title: snap.title,
          members: snap.members.filter((m) => m.removed_at === null).map((m) => ({ kind: m.actor_kind, id: m.actor_id, name: m.name, is_bot: m.actor_kind === 'agent' })),
          latest_seq: snap.next_seq - 1,
        } };
      }
      case 'card.send': {
        const live = [...roomRuns.values()].find((r) => r.botId === session.botId && r.roomId === snap.id && !r.stale) ?? null;
        if (!live) throw new BotError('not_found', 'No live room turn for this card');
        const { actor_kind: _cardActor, ...cardReq } = v.req;
        const base = validateCardRequest({ ...cardReq, t: 'card.send', id: v.id ?? 'r' });
        if (!base.ok) throw new BotError(base.code, base.message);
        let card;
        try {
          card = await hub.store.openRoomCard(snap.id, {
            targetAgentId: actorId, dispatchId: live.dispatchId, runToken: live.runToken,
            epoch: live.ctx.dispatch.epoch, req: base.req,
          });
        } catch (e) { throw roomBotError(e); }
        return { result: { request_id: card.request_id, expires_at: card.expires_at, ...(card.duplicate ? { duplicate: true } : {}) } };
      }
      case 'chat.cancel': {
        const row = (snap.dispatches ?? []).find((d) => d.id === v.req.dispatch_id);
        if (!row || row.target_agent_id !== actorId) throw new BotError('not_found', 'Unknown dispatch');
        if (row.state !== 'queued') throw new BotError('dispatch_not_running', 'That dispatch is no longer queued');
        const cancelled = await hub.store.transact(snap.id, (d) => {
          const current = (d.dispatches ?? []).find((x) => x.id === v.req.dispatch_id);
          if (!current || current.target_agent_id !== actorId || current.state !== 'queued') return false;
          current.state = 'cancelled'; current.code = 'agent_cancelled';
          current.error = 'Cancelled by the agent before it started.';
          current.finished_at = Date.now(); current.updated_at = current.finished_at; current.run_token = null;
          return true;
        });
        if (!cancelled) throw new BotError('dispatch_not_running', 'That dispatch is no longer queued');
        return { result: { cancelled: true, dispatch_id: v.req.dispatch_id } };
      }
      case 'chat.action':
        hub.reg.live2?.ephemeral('conversation.typing', { conversation_id: snap.id, agent: actorId, state: 'typing', at: Date.now() });
        return { result: {} };
      case 'message.send': {
        if (active && v.req.final === true) {
          let message;
          try { message = await active.ctx.finalize(v.req.text, { media: v.req.media }); }
          catch (e) { throw roomBotError(e); }
          const handoff = await completeRoomTurn(active, message);
          return { result: { message_id: message.id, chat_id: snap.id, date: message.created_at },
            ...(handoff?.dispatch ? { handoff: { dispatch_id: handoff.dispatch.id, target_agent_id: handoff.dispatch.target_agent_id } } : {}) };
        }
        if (active) {
          let message;
          try { message = await active.ctx.say(v.req.text, { media: v.req.media }); }
          catch (e) { throw roomBotError(e); }
          active.parts.push(message.id);
          return { result: { message_id: message.id, chat_id: snap.id, date: message.created_at } };
        }
        break;
      }
      case 'message.edit': {
        if (active && v.req.final === true) {
          let message;
          try { message = await active.ctx.finalizeMessage(v.req.message_id, v.req.text, { media: v.req.media }); }
          catch (e) { throw roomBotError(e); }
          const handoff = await completeRoomTurn(active, message);
          return { result: { message_id: message.id, chat_id: snap.id, edited: true },
            ...(handoff?.dispatch ? { handoff: { dispatch_id: handoff.dispatch.id, target_agent_id: handoff.dispatch.target_agent_id } } : {}) };
        }
        let edited = null;
        await hub.store.transact(snap.id, (d) => {
          if (d.paused) throw new BotError('dispatch_stale', 'The room is stopped; a late edit cannot be stored as plain agent chatter');
          const m = d.messages.find((x) => x.id === v.req.message_id && !x.deleted_at);
          if (!m) throw new BotError('not_found', 'Unknown message');
          if (m.author_kind !== 'agent' || m.author_id !== actorId) throw new BotError('forbidden', 'Only this agent may edit its message');
          m.body = v.req.text; m.format = v.req.format ?? m.format ?? 'text';
          m.revision = (m.revision ?? 1) + 1;
          d.updated_at = Date.now();
          d.outbox.push({ type: 'message.edited', message_id: m.id, seq: m.seq, at: d.updated_at });
          if (d.outbox.length > 1000) d.outbox.splice(0, d.outbox.length - 1000);
          edited = structuredClone(m);
        });
        if (edited) hub.store.announce?.('conversation.message.edited', snap.id, edited);
        return { result: { message_id: v.req.message_id, chat_id: snap.id, edited: true } };
      }
      case 'message.delete': {
        let revoked = [];
        await hub.store.transact(snap.id, (d) => {
          const m = d.messages.find((x) => x.id === v.req.message_id && !x.deleted_at);
          if (!m) throw new BotError('not_found', 'Unknown message');
          if (m.author_kind !== 'agent' || m.author_id !== actorId) throw new BotError('forbidden', 'Only this agent may delete its message');
          revoked = revokeMessageMedia(d, m.id, Date.now());
          m.deleted_at = Date.now(); m.body = ''; m.revision = (m.revision ?? 1) + 1;
          d.updated_at = m.deleted_at;
          d.outbox.push({ type: 'message.deleted', message_id: m.id, at: d.updated_at });
          if (d.outbox.length > 1000) d.outbox.splice(0, d.outbox.length - 1000);
        });
        for (const id of revoked) await roomMedia.remove(session.reg, snap.id, id);
        hub.store.announce?.('conversation.message.deleted', snap.id, { id: v.req.message_id });
        return { result: { message_id: v.req.message_id, chat_id: snap.id, deleted: true } };
      }
      case 'ack': return { result: { acked: v.req.event_id } };
      default: break;
    }
    // A plain agent-origin room message (not bound to a running dispatch) is stored as the authenticated agent.
    if (v.t === 'message.send') {
      const sent = await hub.store.send(snap.id, {
        actor, text: v.req.text, format: v.req.format ?? 'markdown', mentions: v.req.mentions,
        reply_to: v.req.reply_to, media: v.req.media,
        // The snapshot above may predate a Stop that commits while this send is in flight. The same
        // mutation re-checks the durable pause, so an unbound late completion can never land as chatter.
        admit: (d) => {
          if (d.paused) throw new BotError('dispatch_stale', 'The room is stopped; a late completion cannot be stored as plain agent chatter');
        },
      });
      return { result: { message_id: sent.message.id, chat_id: snap.id, date: sent.message.created_at } };
    }
    throw new BotError('unsupported', `${v.t} is not supported in a room`);
  }

  const storeFor = (scope, reg, botId) => { if (gone.has(botId)) throw fault(404, 'Not found'); let e = stores.get(botId); if (!e) stores.set(botId, e = { scope, store: botStore(path.join(reg.dir, 'bot', `${botId}.json`), limits) }); return e.store; };
  // Per-agent rollout gate (FOXFLEET_BOT_AGENTS): a bot agent whose name is not allowed is treated as no bot at all,
  // so its token authenticates nowhere (socket, /rpc, /media: 401) and it cannot mint one. null = every bot agent.
  const allowAgent = typeof options.allowAgent === 'function' ? options.allowAgent : () => true;
  const agentOf = (reg, botId) => reg.store.all().find((a) => a.connection === 'bot' && a.botId === botId && allowAgent(a.name));

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
    return { name: m.name, kind: 'hermes', label: m.label, online: connected, chatReady: connected, managementReady: false, hasBotToken: has, media: [PROTOCOL_V11, PROTOCOL_V12].includes(sessions.get(m.botId)?.protocol),
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
  // 0.4.2: what a bot reply's REACT: line does — the same normalisation and reaction-only rule as
  // every other agent (reactions.js replyReaction). The line is removed from the stored text
  // whenever something else remains; a reply that is nothing else keeps the emoji as its text so
  // the run still ends. The emoji is applied once, on the final frame, to the message being answered.
  function botReactOf(text, final) {
    const t = typeof text === 'string' ? text : '';
    const { react: emoji, only } = replyReaction(t);
    if (!emoji) return { text: t, react: null };          // no REACT: line (or not an emoji): untouched
    if (only) return { text: final ? emoji : t, react: final ? emoji : null };
    return { text: takeReact(t).text, react: final ? emoji : null };
  }
  async function applyBotReact(session, m, chatId, emoji, answered) {
    const target = answered ?? session.store.lastUserMessage(chatId);
    if (!target) return;
    const actor = { id: 'agent:' + m.name, name: m.label || m.name, kind: 'agent' };
    try {
      if (await session.reg.reactions.set(m.name, chatId, [target], emoji, actor, true)) {
        const groups = session.reg.reactions.list(m.name, chatId)[target] ?? [];
        session.reg.live2.emit('message.reaction', { agent: m.name, chat: chatId, hub_id: target, upstream_id: target, reactions: groups, change: { emoji, present: true, actor } });
      }
    } catch { /* a full store keeps the reply; the reaction is still derived from the transcript */ }
  }
  async function dispatch(session, v) {
    const { store } = session;
    if (session.protocol === PROTOCOL_V12) {
      const hub = roomHubFor(session.reg, session.scope);
      if (hub) {
        if (v.t === 'card.close') return roomCardClose(session, v, hub);
        if (['handoff.request', 'chat.get', 'chat.cancel', 'card.send'].includes(v.t)) return roomRequest(session, v, hub);
        if (['message.send', 'message.edit', 'message.delete', 'chat.action'].includes(v.t)) {
          const room = await roomRequest(session, v, hub);
          if (room) return room;
        }
      }
    }
    switch (v.t) {
      case 'message.send': {
        const reactOf = botReactOf(v.req.text, v.req.final === true);
        if (reactOf.text !== v.req.text) v.req = { ...v.req, text: reactOf.text };
        const out = await store.send(v.req, guard(session));
        if (!out.replayed) {
          const m = agentOf(session.reg, session.botId);
          const answered = liveRun(session.botId, v.req.chat_id)?.userMsgId ?? null; // the message this turn answers
          session.reg.activity.touch(agentName(session), { role: 'assistant', text: v.req.text, session: v.req.chat_id });
          await botActivity(session, v.req.chat_id, { kind: 'send', id: out.result.message_id, text: store.messageText(v.req.chat_id, out.result.message_id), final: v.req.final, reasoning: v.req.reasoning });
          if (reactOf.react && m) await applyBotReact(session, m, v.req.chat_id, reactOf.react, answered);
        }
        return out;
      }
      case 'message.edit': {
        const reactOf = botReactOf(v.req.text, v.req.final === true);
        if (reactOf.text !== v.req.text) v.req = { ...v.req, text: reactOf.text };
        const out = await store.edit(v.req, guard(session));
        if (!out.replayed) {
          const m = agentOf(session.reg, session.botId);
          const answered = liveRun(session.botId, v.req.chat_id)?.userMsgId ?? null;
          session.reg.activity.touch(agentName(session), { role: 'assistant', text: v.req.text, session: v.req.chat_id });
          await botActivity(session, v.req.chat_id, { kind: 'edit', id: v.req.message_id, text: store.messageText(v.req.chat_id, v.req.message_id), final: v.req.final, reasoning: v.req.reasoning });
          if (reactOf.react && m) await applyBotReact(session, m, v.req.chat_id, reactOf.react, answered);
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
      case 'models.set': return { result: await store.setModels(v.req.providers, guard(session)) };
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
    const v = session.protocol === PROTOCOL_V12 ? validateRequestV12(parsed.frame)
      : session.protocol === PROTOCOL_V11 && (parsed.frame.t === 'card.send' || parsed.frame.t === 'card.close') ? validateCardRequest(parsed.frame)
        : session.protocol === PROTOCOL_V11 ? validateMediaRequest(parsed.frame) : validateRequest(parsed.frame);
    if (!v.ok) {
      // Invalid frames cost a token like valid ones, so a socket cannot flood the hub with rejected work for free.
      try { takeToken(session.botId); } catch (e) { if (!(e instanceof BotError)) throw e; return conn.send(v.id ? { t: 'res', id: v.id, ok: false, error: { code: e.botCode, message: e.message, retry_after_ms: e.retry_after_ms } } : { t: 'error', code: e.botCode, message: e.message }); }
      return conn.send(v.id ? { t: 'res', id: v.id, ok: false, error: { code: v.code, message: v.message } } : { t: 'error', code: v.code, message: v.message });
    }
    if (v.t === 'ping') return conn.send({ t: 'pong', ...(v.id ? { id: v.id } : {}) });
    if (v.t === 'pong') return;
    if (session.protocol === PROTOCOL_V12 && v.t === 'callback.answer') return answerRoomCallback(session, v);
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
  function answerRoomCallback(session, v) {
    const answer = (res) => { if (v.id) session.conn.send({ t: 'res', id: v.id, ...res }); else if (!res.ok) session.conn.send({ t: 'error', code: res.error.code, message: res.error.message }); };
    try { takeToken(session.botId); }
    catch (e) {
      if (!(e instanceof BotError)) throw e;
      return answer({ ok: false, error: { code: e.botCode, message: e.message, ...(e.retry_after_ms ? { retry_after_ms: e.retry_after_ms } : {}) } });
    }
    if (!current(session)) return answer({ ok: false, error: { code: 'forbidden', message: 'This connection is no longer authorised' } });
    const cid = v.req.callback_id, roomId = v.req.chat_id;
    if (cid.startsWith('fs_')) {
      const entry = roomStops.get(cid);
      if (!entry || entry.session !== session || entry.roomId !== roomId || v.req.thread_id !== roomThread(roomId)) {
        return answer({ ok: false, error: { code: 'not_found', message: 'Unknown callback' } });
      }
      if (Date.now() > entry.expires) {
        settleRoomStop(entry, 'timeout');
        return answer({ ok: false, error: { code: 'not_found', message: 'That stop has expired' } });
      }
      settleRoomStop(entry, v.req.outcome);
      return answer({ ok: true, result: {} });
    }
    const agent = agentOf(session.reg, session.botId);
    const hub = roomHubFor(session.reg, session.scope);
    if (!agent || !hub || v.req.thread_id !== roomThread(roomId)) {
      return answer({ ok: false, error: { code: 'not_found', message: 'Unknown callback' } });
    }
    hub.store.ackRoomCallback({ callbackId: cid, targetAgentId: 'agent:' + agent.name, roomId }).then(
      () => answer({ ok: true, result: {} }),
      (e) => answer({ ok: false, error: { code: e?.code ?? 'not_found', message: 'Unknown callback' } }),
    );
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
  function startRun(scope, m, chatId, userMsgId) {
    const key = `${m.botId}\0${chatId}`, cur = live.get(key); if (cur) return Promise.resolve(cur);
    if (starting.has(key)) return starting.get(key);
    const st = { key, botId: m.botId, chatId, userMsgId: userMsgId ?? null, parts: [], ended: false, wrote: false, timer: null, ctl: null, run: null, link: null, reasoning: '' };
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
    if (typeof change.reasoning === 'string' && change.reasoning !== (st.reasoning ?? '')) {
      // A full snapshot, not a delta: the app replaces its block with it, so a reconnect replay, a
      // shortened/cleared revision and a repeated frame all converge on the same text.
      st.reasoning = change.reasoning;
      emit(st, sse({ text: change.reasoning }, 'foxfleet.reasoning'));
    }
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
    for (const e of session.store.eventsAfter(session.delivered, room)) {
      const frame = eventFrame(e);
      if (e.media?.length) {
        if (session.protocol !== PROTOCOL) frame.media = e.media.map(({ id, kind, mime, name, size }) => ({ id, kind, mime, name, size }));
        else frame.text = [e.text, ...e.media.map((m) => `[Attachment: ${m.name} — this bot cannot receive files]`)].filter(Boolean).join('\n');
      }
      session.conn.send(frame); session.delivered = e.id;
    }
  }
  const pushTo = (botId) => { const s = sessions.get(botId); if (s) pushEvents(s); };

  const chatBody = (data, botId) => {
    if (!Array.isArray(data.messages) || data.messages.length < 1 || data.messages.length > 2000 || !data.messages.every((x) => x && typeof x === 'object' && ['user', 'assistant', 'system', 'tool', 'function'].includes(x.role) && (typeof x.content === 'string' || Array.isArray(x.content) || x.content === null))) throw fault(400, 'Invalid chat messages');
    if (data.session_id !== undefined && (typeof data.session_id !== 'string' || !CHAT_ID.test(data.session_id))) throw fault(404, 'Unknown session');
    if (data.client_id !== undefined && !/^[\w.:-]{8,100}$/.test(String(data.client_id))) throw fault(400, 'Invalid client_id');
    const last = [...data.messages].reverse().find((x) => x.role === 'user'); if (!last) throw fault(400, 'No user message');
    const images = [];
    if (Array.isArray(last.content)) for (const p of last.content) {
      if (typeof p === 'string' || (p && typeof p.text === 'string' && [undefined, 'text', 'input_text'].includes(p.type))) continue;
      const u = p?.type === 'image_url' ? (typeof p.image_url === 'string' ? p.image_url : p.image_url?.url) : null;
      if (![PROTOCOL_V11, PROTOCOL_V12].includes(sessions.get(botId)?.protocol) || typeof u !== 'string' || !/^data:image\/(?:png|jpe?g|gif|webp|bmp|heic|heif|avif);base64,[A-Za-z0-9+/=]+$/i.test(u) || images.length >= 4) throw fault(400, 'Unsupported image input', 'unsupported');
      const encoded = u.slice(u.indexOf(',') + 1), bytes = Buffer.from(encoded, 'base64');
      if (bytes.toString('base64') !== encoded) throw fault(400, 'Invalid image data');
      if (!sniffBotMedia(bytes).mime.startsWith('image/')) throw fault(415, 'Expected an image');
      images.push(bytes);
    }
    const text = flattenContent(last.content).text.trim();
    if ((!text && !images.length) || text.includes('\0')) throw fault(400, 'Empty message');
    if (Buffer.byteLength(text) > LIMITS.max_text_bytes) throw fault(413, 'Message too large', 'too_large');
    return { text, images, dedupText: images.length ? JSON.stringify([text, ...images.map((b) => createHash('sha256').update(b).digest('hex'))]) : text, sessionId: data.session_id, clientId: data.client_id };
  };

  async function accept(c, { text, images = [], dedupText = text, sessionId, clientId }, newChatId) {
    const { m } = c, store = storeFor(c.scope, c.reg, m.botId);
    try { await store.load(); } catch (e) { throw fault(503, 'The bot store is unavailable', 'bot_store_unavailable'); }
    const duplicate = clientId && store.clientMatch({ clientId, chatId: sessionId, text, dedupText });
    if (duplicate) return duplicate;
    const media = [];
    let created = false;
    try {
      if (images.length) {
        if (sessionId && !store.hasChat(sessionId)) throw fault(404, 'Unknown session');
        if (!sessionId) { await store.createChat(undefined, newChatId); created = true; }
        for (const bytes of images) {
          const row = await blobs.fromBytes({ reg: c.reg, botId: m.botId, store, chatId: sessionId ?? newChatId, name: 'image', source: 'user', guard: () => { c.current(m); if (!ownerOf(c.scope) || ownerOf(c.scope).disabled || gone.has(m.botId)) throw fault(404, 'Not found'); } }, bytes);
          media.push(row);
        }
      }
    } catch (e) { for (const row of media) await blobs.discard(c.reg, m.botId, store, row.id); if (created) { await store.deleteChat(newChatId); await blobs.removeChat(c.reg, m.botId, store, newChatId); } throw e; }
    let result;
    try { result = await store.acceptUser({ media, user: { id: c.user.id, name: c.user.username }, chatId: sessionId, newChatId, text, dedupText, clientId }); }
    catch (e) { for (const row of media) await blobs.discard(c.reg, m.botId, store, row.id); if (created) await store.deleteChat(newChatId); throw e; }
    if (result.duplicate) { for (const row of media) await blobs.discard(c.reg, m.botId, store, row.id); if (created && result.chat_id !== newChatId) await store.deleteChat(newChatId); }
    if (!result.duplicate) { c.reg.activity.touch(m.name, { role: 'user', text, session: result.chat_id }); pushTo(m.botId); }
    return result;
  }
  const messageView = (result, text, sessionId) => ({ id: result.message.id, state: 'queued', mode: 'queue', ack: 'queued', text, created: result.message.created, session_id: sessionId });

  async function postMessages(c) {
    const input = chatBody(await c.readJson(c.req), c.m.botId), result = await accept(c, input, input.sessionId ? undefined : freshChatId());
    let runId = liveRun(c.m.botId, result.chat_id)?.run.id;
    if (!runId && !result.duplicate) { try { runId = (await startRun(c.scope, c.m, result.chat_id, result.message.id)).run.id; } catch { /* too many live runs: the message is stored, there is just nothing to follow */ } }
    c.sendJson(c.res, result.duplicate ? 200 : 202, { message: messageView(result, input.text, result.chat_id), session_id: result.chat_id, ...(runId ? { run_id: runId } : {}), bot: { online: sessions.has(c.m.botId) }, ...(result.duplicate ? { duplicate: true } : {}) });
  }
  async function postChat(c) {
    const input = chatBody(await c.readJson(c.req), c.m.botId), store = await readyStore(c);
    const dup = input.clientId ? store.clientMatch({ clientId: input.clientId, chatId: input.sessionId, text: input.text, dedupText: input.dedupText }) : null;
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
    if (parts.length > 4 && !CHAT_ID.test(parts[4])) throw fault(404, 'Unknown session');
    if (parts.length === 4 && req.method === 'GET') {
      // 0.4.2 "delete for me": hidden messages never match `q` and never become the preview
      return c.sendJson(res, 200, store.chats({
        q: (url.searchParams.get('q') || '').slice(0, 200), limit: page(url.searchParams.get('limit'), 1, 100, 30),
        offset: page(url.searchParams.get('offset'), 0, 100000, 0),
        hiddenOf: (chatId) => new Set(c.reg.reactions.hidden(c.m.name, chatId)),
      }));
    }
    if (parts.length === 6 && parts[5] === 'messages' && req.method === 'GET') {
      // hidden rows are removed before paging: offset and has_more describe the visible conversation
      return c.sendJson(res, 200, store.transcript(parts[4], {
        limit: page(url.searchParams.get('limit'), 1, 200, 80), offset: page(url.searchParams.get('offset'), 0, 100000, 0),
        hidden: new Set(c.reg.reactions.hidden(c.m.name, parts[4])),
      }));
    }
    // 0.4.2: reactions and "delete for me" for bot agents, on the bot store's own message ids.
    // No ledger: an fm_ id is both ids, so the snapshot mirrors `messages` into `by_hub_id` and
    // live events carry it in both fields. REACT: lines still in old stored replies are derived.
    if (parts.length === 6 && (parts[5] === 'reactions' || parts[5] === 'hidden')) {
      const sid = parts[4], m = c.m, reg = c.reg;
      const messages = store.transcript(sid, { limit: 1_000_000, offset: 0 }).messages;
      const actor = { id: 'user:' + c.scope, name: c.user?.username || 'You', kind: 'human' };
      let changed, change = null, target = null;
      if (req.method === 'PUT' || req.method === 'DELETE') {
        const b = await c.readJson(req, 2048);
        if (typeof b.message_id !== 'string' || !b.message_id || b.message_id.length > 200) throw fault(400, 'Invalid message ID', 'invalid_message_id');
        if (!messages.some((x) => String(x.id) === b.message_id)) throw fault(404, 'Message not found', 'message_not_found');
        target = b.message_id;
        if (parts[5] === 'hidden') await reg.reactions.hide(m.name, sid, [b.message_id], req.method === 'PUT');
        else { changed = await reg.reactions.set(m.name, sid, [b.message_id], b.emoji, actor, req.method === 'PUT'); if (changed) change = { emoji: b.emoji, present: req.method === 'PUT', actor }; }
      } else if (req.method !== 'GET') throw fault(405, 'Method not allowed');
      const view = reactionView({ rows: reg.reactions.list(m.name, sid), derived: agentReactions(messages, { id: 'agent:' + m.name, name: m.label || m.name, kind: 'agent' }), resolve: () => null, transcriptIds: new Set(messages.map((x) => String(x.id))) });
      for (const [k, v] of Object.entries(view.messages)) view.by_hub_id[k] = v; // an fm_ id is both ids here
      if (change && target) reg.live2.emit('message.reaction', { agent: m.name, chat: sid, hub_id: target, upstream_id: target, reactions: view.by_hub_id[target] ?? [], change });
      if (target) view.by_hub_id[target] ??= []; // the targeted message is always in the answer, [] when it has none left
      const hiddenIds = reg.reactions.hidden(m.name, sid).filter((id) => messages.some((x) => String(x.id) === id));
      return c.sendJson(res, 200, { actor, messages: view.messages, by_hub_id: view.by_hub_id, hidden: hiddenIds, hidden_hub_ids: hiddenIds, ...(changed === undefined ? {} : { changed }) });
    }
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
      await store.deleteChat(parts[4]); await c.reg.reactions.remove(c.m.name, parts[4]);
      await blobs.removeChat(c.reg, c.m.botId, store, parts[4]); const st = liveRun(c.m.botId, parts[4]); if (st) end(st, 'stopped');
      return c.sendJson(res, 200, { ok: true });
    }
    throw fault(404, 'Not found');
  }

  /** One active agent member of a room, or null. The same check runs at upload and every download. */
  async function roomMember(reg, roomId, agentName) {
    if (!reg?.conversations) return null;
    let snap;
    try { snap = await reg.conversations.snapshot(roomId); } catch (e) { if (e?.code === 'conversation_not_found') return null; throw e; }
    return snap.members.find((m) => m.actor_kind === 'agent' && m.actor_id === 'agent:' + agentName && m.role === 'member' && m.removed_at === null) ?? null;
  }

  async function serveRoomMedia({ reg, session, id, req, res }) {
    if (!reg?.conversations) throw fault(404, 'Not found');
    const found = await reg.conversations.findMedia(id);
    if (!found) throw fault(404, 'Not found');
    const agent = agentOf(reg, session.botId);
    if (!agent || !(await roomMember(reg, found.conversation_id, agent.name))) throw fault(404, 'Not found');
    const socket = sessions.get(session.botId);
    if (socket && socket.protocol !== PROTOCOL_V12) throw fault(404, 'Not found');
    const readable = await reg.conversations.readableMedia(found.conversation_id, id);
    if (!readable) throw fault(404, 'Not found');
    return roomMedia.serve({ reg, roomId: found.conversation_id, grant: readable.grant, req, res });
  }

  async function mediaHttp(req, res, { sendJson, throttle }) {
    const upload = req.method === 'POST' && req.url === '/api/bot/media';
    const match = req.method === 'GET' && /^\/api\/bot\/media\/(fbm_[A-Za-z0-9_-]{24})$/.exec(req.url);
    if (!upload && !match) throw fault(404, 'Not found');
    if (closing) throw fault(503, 'Unavailable');
    if (!secureBotRequest({ remoteAddress: req.socket.remoteAddress, host: req.headers.host, xfp: req.headers['x-forwarded-proto'], trusted })) throw fault(403, 'Forbidden');
    throttle.check(); await tokens.ready();
    const token = /^Bot (ffb_[A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '')?.[1];
    const id = tokens.verify(token), owner = id && ownerOf(id.scope);
    if (!id || !owner || owner.disabled || gone.has(id.botId)) { throttle.fail(); throw fault(401, 'Unauthorized'); }
    try { takeToken(id.botId); } catch { throw fault(429, 'Too many requests'); }
    const session = { ...id, fenced: false, authorized: () => !closing && !gone.has(id.botId) && tokens.verify(token)?.botId === id.botId && Boolean(agentOf(session.reg, id.botId)) };
    requests.add(session);
    try {
      const reg = session.reg = await scopeReg(id.scope), store = session.store = storeFor(id.scope, reg, id.botId);
      await store.load(); guard(session)();
      if (match) {
        // A DM id stays in the bot's own store. A room id is resolved only through that room's explicit
        // grant and an active membership check made now, not when the upload happened.
        if (store.mediaRows().some((m) => m.id === match[1])) return await blobs.serve({ reg, botId: id.botId, store, id: match[1], req, res });
        return await serveRoomMedia({ reg, session, id: match[1], req, res });
      }
      const chatId = req.headers['x-foxfleet-chat'] ?? req.headers['x-foxfleet-chat-id'];
      const group = String(req.headers['x-foxfleet-chat-type'] ?? '').toLowerCase() === 'group';
      if (!group) {
        const row = await blobs.upload({ reg, botId: id.botId, store, body: req, length: Number(req.headers['content-length']), name: req.headers['x-foxfleet-name'], chatId, guard: guard(session) });
        return sendJson(res, 201, { ...row, media_id: row.id, expires_at: row.created + 3600_000 });
      }
      const agent = agentOf(reg, id.botId), socket = sessions.get(id.botId);
      if (!agent || socket?.protocol !== PROTOCOL_V12 || !(await roomMember(reg, chatId, agent.name))) throw fault(404, 'Not found');
      const roomSnap = await reg.conversations.snapshot(chatId);
      await roomMedia.sweep(reg, chatId, roomSnap.media ?? []);
      const row = await roomMedia.upload({ reg, roomId: chatId, actor: { kind: 'agent', id: 'agent:' + agent.name }, body: req, length: Number(req.headers['content-length']), name: req.headers['x-foxfleet-name'], guard: guard(session) });
      try { await reg.conversations.grantMedia(chatId, row); }
      catch (e) { await roomMedia.remove(reg, chatId, row.id); throw e; }
      return sendJson(res, 201, { ...row, media_id: row.id, expires_at: row.expires_at });
    } finally { requests.delete(session); req.resume(); }
  }
  async function serveMediaToken({ token, scope, req, res }) {
    const [, payload, sig, extra] = token.split('.');
    if (!payload || !sig || extra || Buffer.byteLength(sig) !== 43 || !timingSafeEqual(Buffer.from(mediaSign(payload)), Buffer.from(sig))) throw fault(404, 'Not found');
    let v; try { v = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { throw fault(404, 'Not found'); }
    if (v.scope !== scope || v.expires <= Date.now() || gone.has(v.botId)) throw fault(404, 'Not found');
    const reg = await scopeReg(scope), m = agentOf(reg, v.botId);
    if (!m) throw fault(404, 'Not found');
    const store = storeFor(scope, reg, v.botId); await store.load();
    const row = store.mediaRows().find((m) => m.id === v.id);
    if (!row || !store.mediaForRef(`/bot-media/${row.id}/${row.name}`)) throw fault(404, 'Not found');
    return blobs.serve({ reg, botId: v.botId, store, id: v.id, req, res });
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

  // Per-bot WebSocket connect bucket (authenticated upgrades only): a capped token bucket so a
  // bot in a tight reconnect loop is slowed without touching the per-IP login budget.
  const connects = new Map(), CONNECT_BURST = options.connectBurst ?? 20, CONNECT_PER_MIN = options.connectPerMin ?? 20;
  function connectBucket(botId, now = Date.now()) {
    const b = connects.get(botId) ?? { tokens: CONNECT_BURST, at: now };
    b.tokens = Math.min(CONNECT_BURST, b.tokens + ((now - b.at) / 60000) * CONNECT_PER_MIN); b.at = now;
    if (b.tokens < 1) { connects.set(botId, b); return false; }
    b.tokens -= 1; connects.set(botId, b); if (connects.size > 5000) connects.clear(); return true;
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
      // Auth budget: an IP already locked out is refused without spending; only a FAILED
      // credential spends the shared per-IP login budget. A valid token's reconnects use the
      // per-bot connect bucket instead, so a reconnecting bot cannot lock humans out of login.
      throttle.check();
      const bad = () => { try { throttle.fail(); } catch { return refuse(429); } return refuse(401); };
      const token = /^Bot (ffb_[A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '')?.[1];
      if (!token) return bad();
      await tokens.ready();
      const id = tokens.verify(token); if (!id) return bad();
      if (!connectBucket(id.botId)) return refuse(429);
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
          if (session.protocol === PROTOCOL_V11) { hello.features = ['stop', 'cards', 'media']; hello.limits.max_media_bytes = options.maxMediaBytes ?? MEDIA_MAX; }
          if (session.protocol === PROTOCOL_V12) { hello.features = [...ROOM_FEATURES]; hello.limits = { ...ROOM_LIMITS, max_unacked: limits.maxUnacked }; }
          conn.send(hello);
          pushEvents(session); pushCallbacks(session); announce(id.botId, true);
          if (session.protocol === PROTOCOL_V12) {
            const hub = roomHubFor(found.reg, id.scope);
            if (hub) {
              const target = roomTarget(hub, 'agent:' + found.agent.name);
              target.online = true; target.session = session; target.botId = id.botId;
              session.roomTarget = target;
            }
            resumeRoomRuns(session);
            if (hub) void replayRoomMembers(session, hub).catch(() => {});
            if (hub) void pushRoomCallbacks(session, hub).catch(() => {});
          }
          log('bot.connected', { bot: id.botId });
        },
        onMessage: (text) => handle(session, text),
        onClose: (code) => {
          failStops(session, 'disconnected');
          for (const entry of [...roomStops.values()]) if (entry.session === session) settleRoomStop(entry, 'uncertain');
          if (session.roomTarget?.session === session) { session.roomTarget.online = false; session.roomTarget.session = null; }
          if (sessions.get(id.botId) === session) { sessions.delete(id.botId); announce(id.botId, false); }
          log('bot.closed', { bot: id.botId, code });
        },
      });
    } catch (error) { refuse(error.status === 429 ? 429 : error.status === 503 ? 503 : error.safe ? error.status : 503); }
  }

  const closeScope = (scope, code = 4003, reason = 'account disabled or removed') => {
    for (const s of requests) if (s.scope === scope) fence(s, code, reason);
    for (const s of [...sessions.values()]) if (s.scope === scope) fence(s, code, reason);
    roomHubs.get(scope)?.engine.close();
    roomHubs.delete(scope);
    return Promise.all([...stores.values()].filter((e) => e.scope === scope).map((e) => e.store.idle()));
  };
  const mediaSweep = setInterval(() => {
    for (const [botId, entry] of stores) if (!gone.has(botId)) {
      void scopeReg(entry.scope).then((reg) => blobs.sweep(reg, botId, entry.store)).catch(() => {});
    }
  }, 60_000);
  mediaSweep.unref();
  let closing = false;
  async function close() {
    closing = true;
    clearInterval(mediaSweep);
    for (const hub of roomHubs.values()) hub.engine.close();
    roomHubs.clear();
    const open = [...sessions.values()];
    for (const s of open) s.conn.close(1001, 'hub shutting down');
    for (const st of [...live.values()]) end(st, 'stopped');
    await Promise.all(open.map((s) => s.conn.done));
    await blobs.idle();
    await Promise.allSettled([tokens.idle(), ...[...stores.values()].map((e) => e.store.idle())]);
  }

  return {
    hasToken: (botId) => tokens.has(botId),
    sizes: () => ({ sessions: sessions.size, stores: stores.size, buckets: buckets.size, live: live.size, starting: starting.size, gone: gone.size, stops: stops.size }),
    probe,
    rpc,
    mediaHttp,
    serveMediaToken,
    upgrade,
    close,
    closeScope,
    /** The account is gone: its tokens die with it and its bots are disconnected. */
    async revokeScope(scope) {
      await closeScope(scope);
      await tokens.ready();
      const reg = await scopeReg(scope);
      for (const m of reg.store.all().filter((m) => m.connection === 'bot')) await blobs.remove(reg, m.botId);
      await tokens.revokeScope(scope);
      for (const [botId, e] of [...stores]) if (e.scope === scope) { await e.store.idle(); stores.delete(botId); buckets.delete(botId); }
    },
    /** Owner room control plane: dispatch-engine Stop/Resume, never a bot request. */
    async roomStop(scope, roomId, actor) {
      const reg = await scopeReg(scope);
      const hub = roomHubFor(reg, scope);
      if (!hub) throw fault(404, 'Conversation not found', 'conversation_not_found');
      return hub.engine.stop(roomId, { actor });
    },
    async roomResume(scope, roomId, actor) {
      const reg = await scopeReg(scope);
      const hub = roomHubFor(reg, scope);
      if (!hub) throw fault(404, 'Conversation not found', 'conversation_not_found');
      return hub.engine.resume(roomId, { actor });
    },
    /** The agent record is being deleted: revoke its token, disconnect it and delete its store file. */
    async removeAgent(m, reg) {
      gone.add(m.botId);
      const old = sessions.get(m.botId); if (old) fence(old, 4003, 'agent deleted');
      endRunsOf(m.botId, 'stopped');
      try { await tokens.ready(); await tokens.revoke(m.botId); } catch { /* an unreadable token file is left for the operator; the deleted agent can no longer be admitted anyway */ }
      await (stores.get(m.botId)?.store ?? botStore(path.join(reg.dir, 'bot', `${m.botId}.json`), limits)).remove(); stores.delete(m.botId); buckets.delete(m.botId);
      await blobs.remove(reg, m.botId);
      log('bot.removed', { bot: m.botId });
    },
    /** Every /api/agents/:name/... request for a bot agent (except pin) lands here. */
    async route(c) {
      const { req, res, parts, m } = c;
      if (parts[3] === 'bot-token' && parts.length === 4 && req.method === 'POST') {
        await c.readJson(req, 4096); c.current(m);
        if (!allowAgent(m.name)) throw fault(403, 'The bot API is not enabled for this agent (FOXFLEET_BOT_AGENTS)');
        return c.sendJson(res, 201, await mint(c.scope, m));
      }
      if (parts[3] === 'bot-token' && parts.length === 4 && req.method === 'DELETE') {
        await c.readJson(req, 4096); c.current(m);
        await revoke(m);
        return c.sendJson(res, 200, { ok: true });
      }
      if (parts[3] === 'media' && parts.length === 4 && req.method === 'POST') {
        const { ref } = await c.readJson(req, 8192), store = await readyStore(c);
        const row = typeof ref === 'string' && store.mediaForRef(ref);
        if (!row) throw fault(404, 'Not found');
        const expires = Date.now() + 15 * 60_000;
        const payload = Buffer.from(JSON.stringify({ scope: c.scope, botId: m.botId, id: row.id, expires })).toString('base64url');
        return c.sendJson(res, 200, { url: `/api/media/bot.${payload}.${mediaSign(payload)}`, kind: row.kind, name: row.name, expires });
      }
      if (parts[3] === 'media' && parts.length === 4 && req.method === 'DELETE') { // "delete for everyone": drop the bot blob and tombstone the offer
        const b = await c.readJson(req, 8192), ref = typeof b?.ref === 'string' ? b.ref.trim() : '';
        if (!ref || ref.length > 2000) throw fault(400, 'Invalid ref');
        const store = await readyStore(c);
        const row = store.mediaForRef(ref);
        const already = !row && media && media.revoked(c.scope, m.name, ref) !== null;
        if (row) await blobs.discard(c.reg, m.botId, store, row.id);
        if (media) await media.revoke({ scope: c.scope, agent: m.name, ref });
        if (row) return c.sendJson(res, 200, { ok: true, deleted: true });
        if (already) return c.sendJson(res, 200, { ok: true, deleted: false });
        throw fault(404, 'Not found');
      }
      if (parts[3] === 'messages'  && parts.length === 4 && req.method === 'POST') return await postMessages(c);
      if (parts[3] === 'queue' && parts.length === 4 && req.method === 'GET') {
        const session = c.url.searchParams.get('session_id') || '';
        const store = await readyStore(c);
        const expired = await store.expireCards();
        for (const row of expired) noteClosed(m.botId, row.chat_id, row.id, 'expired');
        // A room id is not a bot-store chat: its cards live in the account's conversation store. Only the
        // room owner sees them, and only the cards addressed to this agent; anything else is empty, never
        // another account's or another agent's card.
        let openRequests = CHAT_ID.test(session) ? store.openRequests(session) : [];
        if (CHAT_ID.test(session) && c.user?.id && c.reg?.conversations) {
          try {
            const room = await c.reg.conversations.snapshot(session);
            if (room) {
              if (room.owner_id === String(c.user.id) && !room.paused) {
                const target = 'agent:' + m.name, now = Date.now();
                openRequests = (room.cards ?? []).filter((card) => card.state === 'open' && card.expires_at > now && card.target_agent_id === target).map(cardView);
              } else openRequests = [];
            }
          } catch { /* not a room on this account: keep this bot's own DM cards */ }
        }
        return c.sendJson(res, 200, { items: [], recent: [], halted: false, active_run: liveRun(m.botId, session)?.run.id ?? null, modes: ['queue'], open_requests: openRequests, can_cancel: false });
      }
      if (parts[3] === 'commands' && parts.length === 4 && req.method === 'GET') {
        const store = await readyStore(c), mine = store.commands().map((x) => ({ name: x.name, aliases: [], description: x.description, category: 'Bot', args: '', subcommands: [], availability: 'chat', handler: 'chat', busy: 'queue', executable: true, verified: false }));
        return c.sendJson(res, 200, { source: 'bot', busy: ['queue'], commands: [...mine, ...appCommands] });
      }
      if (parts[3] === 'models' && parts.length === 4 && req.method === 'GET') {
        const store = await readyStore(c);
        return c.sendJson(res, 200, { mode: 'bot', providers: store.models() });
      }
      if (parts[3] === 'chat' && parts.length === 4 && req.method === 'POST') return await postChat(c);
      if (parts[3] === 'runs') return await runRoutes(c);
      if (parts[3] === 'native' && parts.length === 8 && parts[4] === 'sessions' && parts[6] === 'requests' && req.method === 'POST') {
        const body = await c.readJson(req);
        const chatId = parts[5], requestId = parts[7];
        if (!CHAT_ID.test(chatId) || !CARD_ID.test(requestId)) throw fault(404, 'That question is no longer open');
        const hub = roomHubFor(c.reg, c.scope);
        const room = hub ? await roomSnapshot(hub, chatId) : null;
        if (room) {
          const user = { id: String(c.user?.id ?? ''), name: String(c.user?.username ?? '').replaceAll('\0', '').slice(0, 256) };
          const out = await hub.store.answerRoomCard(chatId, {
            requestId, ownerId: user.id, targetAgentId: 'agent:' + m.name, result: body?.result, user,
          });
          const live = sessions.get(m.botId);
          // A callback is a 1.2 room frame. A live 1.1/1.0 socket is not a delivery target: the tap stays
          // durable and is replayed by pushRoomCallbacks when this bot speaks 1.2 again.
          if (live?.protocol === PROTOCOL_V12 && live.conn) { try { live.conn.send(out.callback); } catch { /* replayed on the next hello */ } }
          return c.sendJson(res, 200, { ok: true });
        }
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
