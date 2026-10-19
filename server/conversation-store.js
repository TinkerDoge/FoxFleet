// Room storage, Task 2: one JSON file per conversation in one account's directory.
//
// Layout:
//   <account dir>/conversations/<fc_id>.json   one room: members, messages, outbox intents, reads, preferences
// There is no separate list file: the list index is rebuilt by scanning this directory on first use, so it can
// never disagree with the room files. Every method that changes a room is one atomic jsonFile mutation, so a
// message, its outbox intent and any membership change commit together or not at all. A failed rename leaves the
// in-memory state untouched (bot-store.jsonFile writes a temp file, fsyncs and renames).
//
// History trim: a room keeps its newest MAX_MESSAGES messages. This is deliberately generous (5000) and local;
// the real retention policy is Task 11. Trimming drops the oldest rows, leaves next_seq monotonic and never
// touches reads/preferences.
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { jsonFile, unavailable } from './bot-store.js';
import { validateCardAnswer } from './bot-protocol.js';
import { fault, ROOM_LIMITS, roomTitle, roomActorName } from './config.js';
import { attachGrantedMedia, revokeMessageMedia, roomMediaView, ROOM_MEDIA_LIMIT } from './conversation-media.js';
import { MEDIA_ID } from './bot-media.js';

const ID_RE = /^fc_[A-Za-z0-9_-]{16}$/;
const MESSAGE_RE = /^fm_[A-Za-z0-9_-]{16}$/;
const CARD_RE = /^frq_[A-Za-z0-9_-]{16}$/;
const CALLBACK_RE = /^fcb_[A-Za-z0-9_-]{16}$/;
const AGENT_REF = /^agent:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HUMAN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CLIENT_ID = /^[^\u0000-\u001f\u007f]{1,128}$/;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_MESSAGES = 5000;
const MAX_OUTBOX = 1000;
const NOTIFY = new Set(['all', 'mentions', 'none']);
const FORMATS = new Set(['text', 'markdown']);
const sha256 = (v) => createHash('sha256').update(v).digest('hex');

const notFound = () => fault(404, 'Conversation not found', 'conversation_not_found');
const messageNotFound = () => fault(404, 'Message not found', 'message_not_found');
const replyNotFound = () => fault(404, 'Unknown reply target', 'reply_not_found');
const crossRoomReply = () => fault(404, 'Unknown reply target', 'cross_room_reply');
const invalidMentions = () => fault(400, 'Invalid mentions', 'mentions_invalid');
const unknownMention = () => fault(404, 'Unknown room member in mentions', 'unknown_mention');
/** Exact actor_id, else a unique case-insensitive display name (`agent:Sumi` → `agent:sumi-native`). */
function resolveMentionId(id, rows) {
  if (rows.some((m) => m.actor_id === id)) return id;
  const suffix = typeof id === 'string' && id.startsWith('agent:') ? id.slice(6) : '';
  if (!suffix) return null;
  const want = suffix.toLowerCase();
  const hits = rows.filter((m) => m.actor_kind === 'agent' && typeof m.name === 'string' && m.name.toLowerCase() === want);
  return hits.length === 1 ? hits[0].actor_id : null;
}
const actorForbidden = () => fault(403, 'Agent is not an active member of this room', 'actor_forbidden');
const notOwner = () => fault(403, 'Only the conversation owner may post to this room', 'not_conversation_owner');

const validId = (id) => typeof id === 'string' && ID_RE.test(id);
const validDevice = (value) => value === '' || (typeof value === 'string' && DEVICE_ID.test(value));
const newId = (prefix) => prefix + randomBytes(12).toString('base64url');

function blank(id) {
  return {
    v: 1, schema_version: 1, id, kind: 'group', owner_id: '', owner_name: '', title: '',
    created_at: 0, updated_at: 0, next_seq: 1, epoch: 1, paused: false,
    policy: { routing: 'mention_reply' }, client_key: null, client_fp: null,
    members: [], messages: [], outbox: [], reads: [], preferences: [], hidden: [], dispatches: [], cards: [], media: [],
  };
}

function recordValid(v, id) {
  return v && v.v === 1 && v.schema_version === 1 && v.id === id && ID_RE.test(v.id) && v.kind === 'group'
    && typeof v.owner_id === 'string' && typeof v.owner_name === 'string' && typeof v.title === 'string'
    && Number.isSafeInteger(v.next_seq) && v.next_seq >= 1 && Number.isSafeInteger(v.epoch) && v.epoch >= 1
    && typeof v.paused === 'boolean' && v.policy && typeof v.policy === 'object' && !Array.isArray(v.policy)
    && (v.client_key === null || typeof v.client_key === 'string') && (v.client_fp === null || typeof v.client_fp === 'string')
    && ['members', 'messages', 'outbox', 'reads', 'preferences', 'hidden'].every((k) => Array.isArray(v[k]))
    && (v.dispatches === undefined || Array.isArray(v.dispatches))
    && (v.cards === undefined || Array.isArray(v.cards))
    && (v.media === undefined || Array.isArray(v.media));
}

const activeMembers = (d) => d.members.filter((m) => m.role === 'member' && m.removed_at === null);
const activeAgent = (d, id) => d.members.find((m) => m.actor_kind === 'agent' && m.actor_id === id && m.role === 'member' && m.removed_at === null) ?? null;
const ownerRow = (d) => d.members.find((m) => m.role === 'owner') ?? null;
const readRow = (d, device) => d.reads.find((r) => r.device_id === device) ?? null;
const prefRow = (d, device) => d.preferences.find((p) => p.device_id === device) ?? null;
const hiddenFor = (d, device) => new Set(d.hidden.filter((h) => h.device_id === device).map((h) => h.message_id));

function memberView(m) {
  return { id: m.actor_id, name: m.name, kind: m.actor_kind, is_bot: m.actor_kind === 'agent', joined_at: m.joined_at };
}
function ownerView(d) {
  const row = ownerRow(d);
  return { id: d.owner_id, name: d.owner_name, kind: 'human', is_bot: false, joined_at: row?.joined_at ?? d.created_at };
}
function prefsView(row) {
  const r = row ?? {};
  return { muted: r.muted ?? false, notify: r.notify ?? 'all', archived: r.archived ?? false, ...(r.pinned === undefined ? {} : { pinned: r.pinned }) };
}
function senderOf(d, m) {
  const rows = d.members.filter((x) => x.actor_id === m.author_id && x.actor_kind === m.author_kind);
  const row = rows.at(-1);
  if (row) return memberView(row);
  return { id: m.author_id, name: m.author_name, kind: m.author_kind, is_bot: m.author_kind === 'agent', joined_at: m.created_at };
}
function messageView(d, m) {
  const media = (d.media ?? []).filter((g) => g.message_id === m.id && !g.revoked_at).map(roomMediaView);
  return {
    id: m.id, conversation_id: d.id, sender: senderOf(d, m), text: m.body, created_at: m.created_at,
    reply_to: m.reply_to ?? null, mentions: m.mentions ?? [], seq: m.seq,
    root_id: m.root_id ?? null, dispatch_id: m.dispatch_id ?? null, delivery_state: m.delivery_state ?? null,
    ...(media.length ? { media } : {}),
    ...(m.system ? { system: true } : {}), ...(m.code ? { code: m.code } : {}),
    ...(m.revision > 1 ? { edited: true } : {}), ...(m.deleted_at ? { deleted: true } : {}),
  };
}
function view(d, device) {
  const read = readRow(d, device), upTo = read?.up_to ?? 0;
  const last = d.messages.filter((m) => !m.deleted_at).at(-1) ?? null;
  const unread = d.messages.filter((m) => !m.deleted_at && m.seq > upTo && !(m.author_kind === 'human' && m.author_id === d.owner_id)).length;
  return {
    id: d.id, thread_id: 'fcr_' + d.id.slice(3), chat_type: 'group', title: d.title,
    owner: ownerView(d), members: activeMembers(d).map(memberView), created_at: d.created_at, updated_at: d.updated_at,
    archived: prefsView(prefRow(d, device)).archived, unread_count: unread, last_message_at: last ? last.created_at : null,
    paused: d.paused, epoch: d.epoch,
  };
}

function normalizeMentions(mentions, text) {
  if (mentions === undefined || mentions === null) return [];
  if (!Array.isArray(mentions) || mentions.length > ROOM_LIMITS.max_mentions) throw invalidMentions();
  const out = [], spans = [];
  for (const m of mentions) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) throw invalidMentions();
    if (Object.keys(m).some((k) => !['kind', 'id', 'offset', 'length'].includes(k))) throw invalidMentions();
    if (m.kind !== 'agent' || typeof m.id !== 'string' || !AGENT_REF.test(m.id)) throw invalidMentions();
    if (!Number.isInteger(m.offset) || !Number.isInteger(m.length) || m.offset < 0 || m.length < 1 || m.length > 256) throw invalidMentions();
    if (m.offset + m.length > text.length) throw invalidMentions();
    const start = text.charCodeAt(m.offset), end = text.charCodeAt(m.offset + m.length - 1);
    if ((start >= 0xdc00 && start <= 0xdfff) || (end >= 0xd800 && end <= 0xdbff)) throw invalidMentions();
    spans.push([m.offset, m.offset + m.length]);
    out.push({ kind: 'agent', id: m.id, offset: m.offset, length: m.length });
  }
  spans.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) if (spans[i][0] < spans[i - 1][1]) throw invalidMentions();
  return out;
}

function validText(text) {
  return typeof text === 'string' && text.length >= 1 && text.length <= ROOM_LIMITS.max_text_bytes && Buffer.byteLength(text, 'utf8') <= ROOM_LIMITS.max_text_bytes;
}
function validClientId(value) {
  return value === undefined || value === null || (typeof value === 'string' && CLIENT_ID.test(value));
}
function agentRef(value) {
  if (typeof value !== 'string') return null;
  const id = value.startsWith('agent:') ? value : 'agent:' + value;
  return AGENT_REF.test(id) ? id : null;
}
function pageInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!Number.isSafeInteger(value) || value < 0) throw fault(400, 'Invalid page');
  return Math.min(value, max);
}

/**
 * One account's rooms. Callers pass the authenticated account's id/name on create and compare ownership on
 * mutations; the directory itself is the account boundary, so another account can never see or address a room.
 */
export function conversationStore(dir, { onEvent } = {}) {
  if (onEvent !== undefined && typeof onEvent !== 'function') throw new TypeError('onEvent must be a function');
  let loaded = null;
  const rooms = new Map();
  const emit = (type, fields) => { if (!onEvent) return; try { onEvent(type, fields); } catch { /* live transport trouble never fails a room write */ } };

  async function scan() {
    try { await mkdir(dir, { recursive: true, mode: 0o700 }); }
    catch { throw unavailable(); }
    let names;
    try { names = await readdir(dir); }
    catch { throw unavailable(); }
    for (const name of names) {
      const match = /^(fc_[A-Za-z0-9_-]{16})\.json$/.exec(name);
      if (!match) continue;
      const id = match[1];
      const room = jsonFile(path.join(dir, name), { fresh: () => blank(id), valid: (v) => recordValid(v, id) });
      try { await room.load(); } catch { throw unavailable(); }
      rooms.set(id, room);
    }
  }
  function ready() {
    if (!loaded) loaded = scan().catch((e) => { loaded = null; throw e; });
    return loaded;
  }
  async function use(id) {
    if (!validId(id)) throw notFound();
    await ready();
    const room = rooms.get(id);
    if (!room) throw notFound();
    await room.load();
    return room;
  }
  async function findMessage(messageId) {
    if (typeof messageId !== 'string' || !MESSAGE_RE.test(messageId)) return null;
    await ready();
    for (const room of rooms.values()) {
      const message = room.state.messages.find((m) => m.id === messageId && !m.deleted_at);
      if (message) return { conversation_id: room.state.id, message };
    }
    return null;
  }
  function clientMatch(title, agents, clientId) {
    if (clientId === undefined || clientId === null) return null;
    const fp = sha256(JSON.stringify([title, agents.map((a) => a.actor_id).sort()]));
    for (const room of rooms.values()) {
      if (room.state.client_key !== clientId) continue;
      if (room.state.client_fp !== fp) throw fault(409, 'That client_id was used for a different room', 'conversation_exists');
      return room;
    }
    return null;
  }

  return {
    ready,
    async idle() { if (!loaded) return; await Promise.all([...rooms.values()].map((r) => r.idle())); },
    limits: { ...ROOM_LIMITS },
    /** A point-in-time copy of the room record, for routing/queue decisions that must not see a draft. */
    async snapshot(id) { const room = await use(id); return structuredClone(room.state); },
    /** One atomic room mutation; the callback must be synchronous so no room write lock spans an await. */
    async transact(id, fn) { const room = await use(id); return room.mutate(fn); },
    async roomIds() { await ready(); return [...rooms.keys()]; },

    async create({ owner, title, agents = [], client_id, device = '' } = {}) {
      if (!owner || typeof owner.id !== 'string' || !HUMAN_ID.test(owner.id)) throw fault(400, 'Invalid owner');
      const safeTitle = roomTitle(title), ownerName = roomActorName(owner.name);
      if (!Array.isArray(agents)) throw fault(400, 'Invalid members');
      if (!validClientId(client_id)) throw fault(400, 'Invalid client_id');
      if (agents.length > ROOM_LIMITS.max_room_members) throw fault(409, 'Too many members', 'too_many_members');
      if (!validDevice(device)) throw fault(400, 'Invalid device');
      const clean = [];
      for (const agent of agents) {
        if (!agent || typeof agent.actor_id !== 'string' || !AGENT_REF.test(agent.actor_id)) throw fault(400, 'Invalid member');
        if (!clean.some((a) => a.actor_id === agent.actor_id)) clean.push({ actor_id: agent.actor_id, name: roomActorName(agent.name) });
      }
      await ready();
      if (client_id !== undefined && client_id !== null) {
        const prior = clientMatch(safeTitle, clean, client_id);
        if (prior) return view(prior.state, device);
      }
      if (rooms.size >= ROOM_LIMITS.max_rooms) throw fault(409, 'This account has too many rooms');
      let id; do { id = newId('fc_'); } while (rooms.has(id));
      const room = jsonFile(path.join(dir, `${id}.json`), { fresh: () => blank(id), valid: (v) => recordValid(v, id) });
      await room.load();
      const at = Date.now();
      await room.mutate((d) => {
        d.owner_id = owner.id; d.owner_name = ownerName; d.title = safeTitle;
        d.created_at = at; d.updated_at = at; d.client_key = client_id ?? null;
        d.client_fp = client_id === undefined || client_id === null ? null : sha256(JSON.stringify([safeTitle, clean.map((a) => a.actor_id).sort()]));
        d.members = [{ actor_kind: 'human', actor_id: owner.id, name: ownerName, role: 'owner', joined_at: at, removed_at: null, generation: 1 },
          ...clean.map((a) => ({ actor_kind: 'agent', actor_id: a.actor_id, name: a.name, role: 'member', joined_at: at, removed_at: null, generation: 1 }))];
      });
      rooms.set(id, room);
      const created = view(room.state, device);
      emit('conversation.created', { conversation: created });
      return created;
    },

    async list({ device = '', limit = 30, offset = 0 } = {}) {
      if (!validDevice(device)) throw fault(400, 'Invalid device');
      const take = pageInt(limit, 30, 500), skip = pageInt(offset, 0);
      await ready();
      const rows = [...rooms.values()].map((r) => r.state)
        .sort((a, b) => (b.updated_at - a.updated_at) || (b.created_at - a.created_at) || (a.id < b.id ? 1 : -1));
      return { conversations: rows.slice(skip, skip + take).map((d) => view(d, device)), total: rows.length };
    },

    async get(id, { device = '' } = {}) {
      if (!validDevice(device)) throw fault(400, 'Invalid device');
      const room = await use(id);
      return view(room.state, device);
    },

    async rename(id, { ownerId, title, device = '' } = {}) {
      const safeTitle = roomTitle(title);
      const room = await use(id);
      await room.mutate((d) => {
        if (d.owner_id !== ownerId) throw fault(403, 'Only the conversation owner may change it', 'not_conversation_owner');
        d.title = safeTitle; d.updated_at = Date.now();
      });
      const updated = view(room.state, device);
      emit('conversation.updated', { conversation: updated });
      return updated;
    },

    async addMember(id, { ownerId, agent, device = '' } = {}) {
      if (!agent || typeof agent.actor_id !== 'string' || !AGENT_REF.test(agent.actor_id)) throw fault(400, 'Invalid member');
      const name = roomActorName(agent.name);
      const room = await use(id);
      await room.mutate((d) => {
        if (d.owner_id !== ownerId) throw fault(403, 'Only the conversation owner may change it', 'not_conversation_owner');
        const prior = d.members.filter((m) => m.actor_id === agent.actor_id);
        if (prior.some((m) => m.removed_at === null)) throw fault(409, 'That agent is already a member', 'member_exists');
        if (activeMembers(d).length >= ROOM_LIMITS.max_room_members) throw fault(409, 'Too many members', 'too_many_members');
        const at = Date.now(), generation = prior.reduce((n, m) => Math.max(n, m.generation), 0) + 1;
        d.members.push({ actor_kind: 'agent', actor_id: agent.actor_id, name, role: 'member', joined_at: at, removed_at: null, generation });
        d.updated_at = at;
        d.outbox.push({ type: 'chat.member', action: 'join', actor_id: d.owner_id, member_id: agent.actor_id, generation, at });
        if (d.outbox.length > MAX_OUTBOX) d.outbox.splice(0, d.outbox.length - MAX_OUTBOX);
      });
      const updated = view(room.state, device);
      emit('conversation.updated', { conversation: updated });
      emit('conversation.member.joined', {
        conversation_id: room.state.id,
        member: updated.members.find((m) => m.id === agent.actor_id) ?? { id: agent.actor_id, name, kind: 'agent', is_bot: true },
        actor: updated.owner,
      });
      return updated;
    },

    async removeMember(id, { ownerId, agentId, device = '' } = {}) {
      const ref = agentRef(agentId);
      if (!ref) throw fault(404, 'Unknown member', 'member_not_found');
      const room = await use(id);
      await room.mutate((d) => {
        if (d.owner_id !== ownerId) throw fault(403, 'Only the conversation owner may change it', 'not_conversation_owner');
        const row = d.members.find((m) => m.actor_id === ref && m.removed_at === null);
        if (!row) throw fault(404, 'Unknown member', 'member_not_found');
        const at = Date.now();
        row.removed_at = at; d.updated_at = at;
        d.outbox.push({ type: 'chat.member', action: 'leave', actor_id: d.owner_id, member_id: ref, generation: row.generation, at });
        if (d.outbox.length > MAX_OUTBOX) d.outbox.splice(0, d.outbox.length - MAX_OUTBOX);
      });
      const updated = view(room.state, device);
      emit('conversation.updated', { conversation: updated });
      emit('conversation.member.left', {
        conversation_id: room.state.id,
        member: { id: ref, name: roomActorName(agentId), kind: 'agent', is_bot: true },
        actor: updated.owner,
      });
      return updated;
    },

    /**
     * Room Stop is one atomic durable mutation: a new epoch fences every earlier attempt, the queue is
     * paused, queued turns and waiting approvals are cancelled, live turns become uncertain (their remote
     * side effects may still run), visible partials are marked interrupted and open room cards are closed.
     * A cancellation request is the engine's job; this method never claims a remote turn was stopped.
     */
    async stop(id, { ownerId, at = Date.now() } = {}) {
      const room = await use(id);
      let out;
      await room.mutate((d) => {
        if (d.owner_id !== ownerId) throw fault(403, 'Only the conversation owner may stop it', 'not_conversation_owner');
        if (!Array.isArray(d.dispatches)) d.dispatches = [];
        if (!Array.isArray(d.cards)) d.cards = [];
        d.epoch += 1; d.paused = true; d.updated_at = at;
        const active = [], cancelled = [];
        for (const row of d.dispatches) {
          if (row.state === 'queued' || row.state === 'waiting_approval') {
            const kind = row.state === 'waiting_approval' ? 'approval' : 'queued';
            row.state = 'cancelled'; row.code = 'room_stopped';
            row.error = 'Room Stop cancelled this turn before it ran.';
            row.run_token = null; row.updated_at = at; row.finished_at = at;
            cancelled.push({ id: row.id, target_agent_id: row.target_agent_id, kind });
          } else if (['offered', 'accepted', 'running'].includes(row.state)) {
            active.push({
              id: row.id, target_agent_id: row.target_agent_id, run_token: row.run_token,
              attempt: row.attempt, state: row.state,
            });
            row.state = 'uncertain'; row.code = 'room_stopped';
            row.error = 'Room Stop requested cancellation; the remote turn may still be running.';
            row.run_token = null; row.updated_at = at;
          }
        }
        const live = new Set(active.map((row) => row.id));
        for (const message of d.messages) {
          if (!live.has(message.dispatch_id) || message.system || message.final === true) continue;
          if (message.author_kind === 'agent' && message.delivery_state === 'running') message.delivery_state = 'interrupted';
        }
        let cardsClosed = 0;
        for (const card of d.cards) {
          if (card.state !== 'open') continue;
          card.state = 'closed'; card.reason = 'room_stopped'; card.closed_at = at;
          cardsClosed += 1;
        }
        out = { epoch: d.epoch, paused: true, active, cancelled, cards_closed: cardsClosed };
      });
      return out;
    },

    async resume(id, { ownerId, at = Date.now() } = {}) {
      const room = await use(id);
      let out;
      await room.mutate((d) => {
        if (d.owner_id !== ownerId) throw fault(403, 'Only the conversation owner may resume it', 'not_conversation_owner');
        d.paused = false; d.updated_at = at;
        out = { epoch: d.epoch, paused: false };
      });
      return out;
    },

    /** Mint one room card bound to the owner, room, target agent and live dispatch. */
    async openRoomCard(id, { targetAgentId, dispatchId = null, runToken = null, epoch = null, req, now = Date.now() } = {}) {
      if (!req || typeof req !== 'object') throw fault(400, 'Invalid card');
      const room = await use(id);
      let out;
      await room.mutate((d) => {
        // Cards exist only inside one live attempt. Stop pauses the room and nulls every attempt token
        // before it cancels remotely, so this check closes the window where a bot could mint a fresh
        // card while Stop is still settling.
        if (d.paused) throw fault(409, 'The room is stopped; no card can be minted', 'room_paused');
        if (!activeAgent(d, targetAgentId)) throw actorForbidden();
        if (typeof dispatchId !== 'string' || typeof runToken !== 'string' || !dispatchId || !runToken) {
          throw fault(409, 'A card requires a live room attempt', 'dispatch_not_running');
        }
        const dispatch = (d.dispatches ?? []).find((row) => row.id === dispatchId && row.target_agent_id === targetAgentId);
        if (!dispatch) throw fault(409, 'A card requires a live room attempt', 'dispatch_not_running');
        if (dispatch.epoch !== d.epoch || (epoch !== null && dispatch.epoch !== epoch)) {
          throw fault(409, 'That dispatch was replaced', 'dispatch_stale');
        }
        if (dispatch.state !== 'running') throw fault(409, 'That dispatch is no longer running', 'dispatch_not_running');
        if (dispatch.run_token !== runToken) throw fault(409, 'That dispatch was replaced', 'dispatch_stale');
        if (!Array.isArray(d.cards)) d.cards = [];
        for (const card of d.cards) {
          if (card.state === 'open' && card.expires_at <= now) { card.state = 'closed'; card.reason = 'expired'; card.closed_at = now; }
        }
        const fp = sha256(JSON.stringify([req.kind, req.instance, req.command ?? null, req.description ?? null, req.questions ?? null]));
        const key = typeof req.idempotency_key === 'string' && req.idempotency_key
          ? `card:${targetAgentId}:${req.instance}:${req.idempotency_key}` : null;
        if (key) {
          const prior = d.cards.find((card) => card.dedupe_key === key);
          if (prior) {
            if (prior.dedupe_fingerprint !== fp) throw fault(409, 'That idempotency key was used for a different card', 'idempotency_conflict');
            out = { request_id: prior.id, expires_at: prior.expires_at, duplicate: true };
            return;
          }
        }
        const open = d.cards.filter((card) => card.state === 'open' && card.expires_at > now);
        if (open.length >= 8) throw fault(409, 'Too many open cards in this room', 'too_many_cards');
        const ttl = Number.isSafeInteger(req.ttl_ms) && req.ttl_ms > 0 ? req.ttl_ms : 300_000;
        const requestId = newId('frq_'), expiresAt = now + ttl;
        d.cards.push({
          id: requestId, owner_id: d.owner_id, room_id: d.id, target_agent_id: targetAgentId,
          dispatch_id: dispatchId, run_token: runToken, kind: req.kind, instance: req.instance,
          ...(req.card_key ? { card_key: req.card_key } : {}),
          ...(req.command ? { command: req.command } : {}),
          ...(req.description ? { description: req.description } : {}),
          ...(req.questions ? { questions: req.questions } : {}),
          ...(key ? { dedupe_key: key, dedupe_fingerprint: fp } : {}),
          created_at: now, expires_at: expiresAt, state: 'open',
        });
        out = { request_id: requestId, expires_at: expiresAt, duplicate: false };
      });
      return out;
    },

    /** Close this agent's own open room cards, by exact id or by instance. */
    async closeRoomCards({ targetAgentId, request_id, all_except_instance, reason = 'closed', now = Date.now() } = {}) {
      await ready();
      let closed = 0; const ids = [];
      for (const room of rooms.values()) {
        const has = (room.state.cards ?? []).some((card) => card.target_agent_id === targetAgentId && card.state === 'open'
          && (request_id !== undefined ? card.id === request_id : card.instance !== all_except_instance));
        if (!has) continue;
        await room.mutate((d) => {
          d.cards ??= [];
          for (const card of d.cards) {
            if (card.target_agent_id !== targetAgentId || card.state !== 'open') continue;
            if (request_id !== undefined ? card.id !== request_id : card.instance === all_except_instance) continue;
            card.state = 'closed'; card.reason = String(reason).slice(0, 64); card.closed_at = now;
            closed += 1; ids.push({ id: card.id, chat_id: d.id });
          }
        });
      }
      return { closed, ids };
    },

    /** The owner answers one exact room card. Never looks up an older request. */
    async answerRoomCard(id, { requestId, ownerId, targetAgentId, result, user, now = Date.now() } = {}) {
      if (typeof requestId !== 'string' || !CARD_RE.test(requestId)) throw fault(404, 'That question is no longer open', 'not_found');
      const room = await use(id);
      let out;
      await room.mutate((d) => {
        if (d.owner_id !== ownerId) throw fault(403, 'Only the conversation owner may answer it', 'not_conversation_owner');
        d.cards ??= [];
        const card = d.cards.find((row) => row.id === requestId && row.target_agent_id === targetAgentId);
        if (!card || card.state !== 'open' || card.expires_at <= now) {
          if (card && card.state === 'open') { card.state = 'closed'; card.reason = 'expired'; card.closed_at = now; }
          throw fault(404, 'That question is no longer open', 'not_found');
        }
        const verdict = validateCardAnswer(card, result);
        if (!verdict.ok) throw fault(400, verdict.message, verdict.code ?? 'invalid_request');
        const callbackId = newId('fcb_');
        card.state = 'answered'; card.answered_at = now; card.answer = verdict.value;
        card.callback_id = callbackId; card.user = { id: user.id, name: user.name };
        card.callback = {
          t: 'callback', callback_id: callbackId, request_id: card.id, chat_id: d.id, chat_type: 'group',
          thread_id: 'fcr_' + d.id.slice(3),
          actor: { kind: 'human', id: user.id, name: user.name, is_bot: false },
          kind: card.kind, value: verdict.value,
        };
        card.callback_delivered = false;
        d.updated_at = now;
        out = { request_id: card.id, callback: structuredClone(card.callback) };
      });
      return out;
    },

    /** Every unanswered room callback for one target agent, across this account's rooms. */
    async pendingRoomCallbacks({ targetAgentId } = {}) {
      await ready();
      const out = [];
      for (const room of rooms.values()) {
        for (const card of room.state.cards ?? []) {
          if (card.target_agent_id !== targetAgentId) continue;
          if (!card.callback || card.callback_delivered || !CALLBACK_RE.test(card.callback.callback_id)) continue;
          out.push(structuredClone(card.callback));
        }
      }
      return out;
    },

    async markRoomCallbackDelivered({ callbackId, targetAgentId } = {}) {
      if (typeof callbackId !== 'string' || !CALLBACK_RE.test(callbackId)) return false;
      await ready();
      for (const room of rooms.values()) {
        const card = (room.state.cards ?? []).find((row) => row.target_agent_id === targetAgentId
          && row.callback?.callback_id === callbackId);
        if (!card) continue;
        if (!card.callback_delivered) await room.mutate((d) => {
          const row = (d.cards ?? []).find((x) => x.callback?.callback_id === callbackId);
          if (row) row.callback_delivered = true;
        });
        return true;
      }
      return false;
    },

    /** The bot acknowledges the owner's tap for exactly its own card callback. */
    async ackRoomCallback({ callbackId, targetAgentId, roomId, now = Date.now() } = {}) {
      if (typeof callbackId !== 'string' || !CALLBACK_RE.test(callbackId)) throw fault(404, 'Unknown callback', 'not_found');
      await ready();
      for (const room of rooms.values()) {
        const card = (room.state.cards ?? []).find((row) => row.target_agent_id === targetAgentId
          && row.room_id === room.state.id && row.callback?.callback_id === callbackId
          && (roomId === undefined || room.state.id === roomId));
        if (!card) continue;
        await room.mutate((d) => {
          const row = (d.cards ?? []).find((x) => x.callback?.callback_id === callbackId);
          if (row) { row.callback_delivered = true; row.callback_answered_at = now; }
        });
        return true;
      }
      throw fault(404, 'Unknown callback', 'not_found');
    },


    async send(id, { actor, text, format = 'text', mentions, reply_to, client_id, media, admit } = {}) {
      if (!actor || !['human', 'agent'].includes(actor.kind)) throw fault(400, 'Invalid actor');
      if (actor.kind === 'human' ? !HUMAN_ID.test(actor.id ?? '') : !AGENT_REF.test(actor.id ?? '')) throw fault(400, 'Invalid actor');
      if (admit !== undefined && typeof admit !== 'function') throw new TypeError('admit must be a function');
      const authorName = roomActorName(actor.name);
      if (!validText(text)) throw fault(400, 'Invalid message text');
      if (!FORMATS.has(format)) throw fault(400, 'Invalid format');
      if (!validClientId(client_id)) throw fault(400, 'Invalid client_id');
      if (media !== undefined && media !== null && (!Array.isArray(media) || media.length > ROOM_MEDIA_LIMIT)) throw fault(400, 'Invalid attachment list', 'invalid_media');
      const uploads = media === undefined || media === null || media.length === 0 ? null : media;
      const parsed = normalizeMentions(mentions, text);
      const room = await use(id);
      const state = room.state;
      // Actor authority sits below HTTP: a human writes only as the room owner, and an agent only while it
      // is an active member. Filesystem/account isolation is not an authority check.
      if (actor.kind === 'human' && state.owner_id !== actor.id) throw notOwner();
      if (actor.kind === 'agent' && !activeAgent(state, actor.id)) throw actorForbidden();
      const fingerprint = sha256(JSON.stringify([text, format, parsed, reply_to ?? null, client_id ?? null, uploads]));
      if (reply_to !== undefined && reply_to !== null) {
        if (typeof reply_to !== 'string' || !MESSAGE_RE.test(reply_to)) throw replyNotFound();
        if (!state.messages.some((m) => m.id === reply_to && !m.deleted_at)) {
          if (await findMessage(reply_to)) throw crossRoomReply();
          throw replyNotFound();
        }
      }
      const callAdmit = (d, message, duplicate) => {
        if (!admit) return undefined;
        const admitted = admit(d, message, duplicate);
        if (admitted && typeof admitted.then === 'function') throw new TypeError('admit must be synchronous');
        return admitted;
      };
      let result;
      await room.mutate((d) => {
        if (actor.kind === 'human' && d.owner_id !== actor.id) throw notOwner();
        if (actor.kind === 'agent' && !activeAgent(d, actor.id)) throw actorForbidden();
        if (client_id !== undefined && client_id !== null) {
          const prior = d.messages.find((m) => m.client_id === client_id);
          if (prior) {
            if (prior.client_fp !== fingerprint) throw fault(409, 'That client_id was used for a different message', 'idempotency_conflict');
            const admitted = callAdmit(d, prior, true);
            result = { message: messageView(d, prior), duplicate: true, ...(admitted === undefined ? {} : { admitted }) };
            return;
          }
        }
        const active = activeMembers(d);
        for (const mention of parsed) {
          const resolved = resolveMentionId(mention.id, active);
          if (!resolved) throw unknownMention();
          mention.id = resolved;
        }
        let target = null;
        if (reply_to !== undefined && reply_to !== null) {
          target = d.messages.find((m) => m.id === reply_to && !m.deleted_at);
          if (!target) throw replyNotFound();
        }
        const at = Date.now(), seq = d.next_seq++;
        const message = {
          id: newId('fm_'), seq, author_kind: actor.kind, author_id: actor.id, author_name: authorName,
          body: text, format, mentions: parsed, reply_to: reply_to ?? null, created_at: at, revision: 1,
          deleted_at: null, root_id: target ? (target.root_id ?? target.id) : null, dispatch_id: null, delivery_state: 'queued',
          client_id: client_id ?? null, client_fp: fingerprint,
        };
        attachGrantedMedia(d, uploads, actor, message, at);
        d.messages.push(message);
        const admitted = callAdmit(d, message, false);
        // Generous local cap; Task 11 owns the real retention policy. next_seq stays monotonic.
        while (d.messages.length > MAX_MESSAGES) d.messages.shift();
        d.updated_at = at;
        d.outbox.push({ type: 'message.new', message_id: message.id, seq, at });
        if (d.outbox.length > MAX_OUTBOX) d.outbox.splice(0, d.outbox.length - MAX_OUTBOX);
        result = { message: messageView(d, message), duplicate: false, ...(admitted === undefined ? {} : { admitted }) };
      });
      if (!result.duplicate) emit('conversation.message.new', { conversation_id: result.message.conversation_id, message: result.message });
      return result;
    },

    async messages(id, { device = '', limit = 50, offset = 0, before } = {}) {
      if (!validDevice(device)) throw fault(400, 'Invalid device');
      const take = pageInt(limit, 50, 500), skip = pageInt(offset, 0);
      const cursor = before === undefined || before === null || before === '' ? null : pageInt(before, 0);
      if (cursor !== null && cursor < 1) throw fault(400, 'Invalid cursor');
      const room = await use(id);
      const d = room.state, hidden = hiddenFor(d, device);
      // Deleting (for everyone) and hiding (per device) are applied BEFORE offset/limit, so has_more and the
      // cursor describe the list this caller can actually see.
      let visible = d.messages.filter((m) => !m.deleted_at && !hidden.has(m.id));
      if (cursor !== null) visible = visible.filter((m) => m.seq < cursor);
      const end = Math.max(0, visible.length - skip), start = Math.max(0, end - take), page = visible.slice(start, end);
      return { messages: page.map((m) => messageView(d, m)), has_more: start > 0, next_cursor: page.length ? page[0].seq : null, limit: take, offset: skip, total: visible.length };
    },

    async message(id, messageId, { device = '' } = {}) {
      if (!validDevice(device)) throw fault(400, 'Invalid device');
      const room = await use(id);
      if (typeof messageId !== 'string' || !MESSAGE_RE.test(messageId)) throw messageNotFound();
      const d = room.state, message = d.messages.find((m) => m.id === messageId);
      if (!message || message.deleted_at || hiddenFor(d, device).has(messageId)) throw messageNotFound();
      return messageView(d, message);
    },

    async read(id, { device = '', up_to } = {}) {
      if (!validDevice(device)) throw fault(400, 'Invalid device');
      const room = await use(id);
      let readUpTo = 0;
      await room.mutate((d) => {
        const latest = Math.max(0, d.next_seq - 1);
        let target = latest;
        if (up_to !== undefined && up_to !== null) {
          if (!Number.isSafeInteger(up_to) || up_to < 0) throw fault(400, 'Invalid read position');
          target = Math.min(up_to, latest);
        }
        const row = d.reads.find((r) => r.device_id === device);
        if (row) { row.up_to = target; row.at = Date.now(); }
        else d.reads.push({ device_id: device, up_to: target, at: Date.now() });
        readUpTo = target;
      });
      const updated = view(room.state, device);
      emit('conversation.read', { conversation_id: room.state.id, actor: updated.owner, read_up_to: readUpTo, device });
      return updated;
    },

    async preferences(id, { device = '' } = {}) {
      if (!validDevice(device)) throw fault(400, 'Invalid device');
      const room = await use(id);
      return prefsView(prefRow(room.state, device));
    },

    async setPreferences(id, { device = '', preferences } = {}) {
      if (!validDevice(device)) throw fault(400, 'Invalid device');
      if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) throw fault(400, 'Invalid preferences');
      const patch = {};
      for (const [key, value] of Object.entries(preferences)) {
        if (key === 'muted' || key === 'archived' || key === 'pinned') { if (typeof value !== 'boolean') throw fault(400, `Invalid ${key}`); patch[key] = value; }
        else if (key === 'notify') { if (!NOTIFY.has(value)) throw fault(400, 'Invalid notify'); patch.notify = value; }
        else throw fault(400, `Unknown preference ${key}`);
      }
      const room = await use(id);
      await room.mutate((d) => {
        const row = d.preferences.find((p) => p.device_id === device);
        if (row) Object.assign(row, patch);
        else d.preferences.push({ device_id: device, ...patch });
      });
      const updated = view(room.state, device);
      emit('conversation.updated', { conversation: updated });
      return prefsView(prefRow(room.state, device));
    },

    async hideMessage(id, { device = '', messageId, hidden = true } = {}) {
      if (!validDevice(device)) throw fault(400, 'Invalid device');
      if (typeof messageId !== 'string' || !MESSAGE_RE.test(messageId)) throw messageNotFound();
      const room = await use(id);
      await room.mutate((d) => {
        if (!d.messages.some((m) => m.id === messageId)) throw messageNotFound();
        const at = d.hidden.findIndex((h) => h.device_id === device && h.message_id === messageId);
        if (hidden && at < 0) d.hidden.push({ device_id: device, message_id: messageId });
        if (!hidden && at >= 0) d.hidden.splice(at, 1);
      });
    },

    async deleteMessage(id, { messageId } = {}) {
      if (typeof messageId !== 'string' || !MESSAGE_RE.test(messageId)) throw messageNotFound();
      const room = await use(id);
      const revoked = [];
      await room.mutate((d) => {
        const message = d.messages.find((m) => m.id === messageId);
        if (!message) throw messageNotFound();
        if (message.deleted_at) return;
        const at = Date.now();
        revoked.push(...revokeMessageMedia(d, message.id, at));
        message.deleted_at = at; message.body = ''; message.revision += 1;
        d.updated_at = at;
        d.outbox.push({ type: 'message.deleted', message_id: message.id, at });
        if (d.outbox.length > MAX_OUTBOX) d.outbox.splice(0, d.outbox.length - MAX_OUTBOX);
      });
      if (revoked.length) {
        emit('conversation.message.deleted', { conversation_id: room.state.id, message_id: messageId });
        emit('conversation.updated', { conversation: view(room.state, '') });
      }
      return revoked;
    },

    /** Register one uploaded blob as an unattached grant. The bytes were written before this call. */
    async grantMedia(id, row) {
      if (!row || !MEDIA_ID.test(row.id ?? '')) throw fault(400, 'Invalid attachment');
      const room = await use(id);
      await room.mutate((d) => {
        d.media ??= [];
        if (d.media.some((g) => g.id === row.id)) throw fault(409, 'Attachment already exists', 'media_exists');
        d.media.push(row);
        // Bound the grant list by discarding revoked rows only; an attached grant is history and must not
        // vanish from under a retained message.
        if (d.media.length > 10_000) {
          d.media = d.media.filter((g) => !g.revoked_at);
          if (d.media.length > 20_000) d.media.splice(0, d.media.length - 20_000);
        }
      });
      return row;
    },

    /** The grant row for one media id in this room (attached or not); null when unknown. */
    async mediaGrant(id, mediaId) {
      if (typeof mediaId !== 'string' || !MEDIA_ID.test(mediaId)) return null;
      const room = await use(id);
      return (room.state.media ?? []).find((g) => g.id === mediaId) ?? null;
    },

    /** Find which of this account's rooms grants a media id (bot HTTP download path). */
    async findMedia(mediaId) {
      if (typeof mediaId !== 'string' || !MEDIA_ID.test(mediaId)) return null;
      await ready();
      for (const room of rooms.values()) {
        const grant = (room.state.media ?? []).find((g) => g.id === mediaId);
        if (grant) return { conversation_id: room.state.id, grant, state: room.state };
      }
      return null;
    },

    /** Owner revocation: deny every later download. The caller removes the bytes afterwards. */
    async revokeMedia(id, { ownerId, mediaId, at = Date.now() } = {}) {
      if (typeof mediaId !== 'string' || !MEDIA_ID.test(mediaId)) throw fault(404, 'Not found');
      const room = await use(id);
      let grant = null;
      await room.mutate((d) => {
        if (d.owner_id !== ownerId) throw fault(403, 'Only the conversation owner may revoke it', 'not_conversation_owner');
        grant = (d.media ?? []).find((g) => g.id === mediaId) ?? null;
        if (!grant) throw fault(404, 'Not found');
        if (!grant.revoked_at) grant.revoked_at = at;
        d.updated_at = at;
      });
      const message = grant.message_id ? room.state.messages.find((m) => m.id === grant.message_id && !m.deleted_at) : null;
      if (message) emit('conversation.message.edited', { conversation_id: room.state.id, message: messageView(room.state, message) });
      return grant;
    },

    /** A download decision: grant is attached, not revoked/expired, and its message is still retained. */
    async readableMedia(id, mediaId, { now = Date.now() } = {}) {
      if (typeof mediaId !== 'string' || !MEDIA_ID.test(mediaId)) return null;
      const room = await use(id);
      const grant = (room.state.media ?? []).find((g) => g.id === mediaId);
      if (!grant || grant.revoked_at || !grant.message_id) return null;
      if (Number.isSafeInteger(grant.expires_at) && grant.expires_at <= now && !grant.attached_at) return null;
      const message = room.state.messages.find((m) => m.id === grant.message_id && !m.deleted_at);
      return message ? { grant, message, state: room.state } : null;
    },

    /** Emit a conversation event for a message written by the dispatch engine. */
    announce(type, id, message) {
      const room = rooms.get(id);
      if (!room) return;
      const fields = type === 'conversation.message.deleted'
        ? { conversation_id: id, message_id: message.id }
        : { conversation_id: id, message: messageView(room.state, message) };
      emit(type, fields);
    },

    findMessage,
  };
}
