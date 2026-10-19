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
import { fault, ROOM_LIMITS, roomTitle, roomActorName } from './config.js';

const ID_RE = /^fc_[A-Za-z0-9_-]{16}$/;
const MESSAGE_RE = /^fm_[A-Za-z0-9_-]{16}$/;
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
    members: [], messages: [], outbox: [], reads: [], preferences: [], hidden: [], dispatches: [],
  };
}

function recordValid(v, id) {
  return v && v.v === 1 && v.schema_version === 1 && v.id === id && ID_RE.test(v.id) && v.kind === 'group'
    && typeof v.owner_id === 'string' && typeof v.owner_name === 'string' && typeof v.title === 'string'
    && Number.isSafeInteger(v.next_seq) && v.next_seq >= 1 && Number.isSafeInteger(v.epoch) && v.epoch >= 1
    && typeof v.paused === 'boolean' && v.policy && typeof v.policy === 'object' && !Array.isArray(v.policy)
    && (v.client_key === null || typeof v.client_key === 'string') && (v.client_fp === null || typeof v.client_fp === 'string')
    && ['members', 'messages', 'outbox', 'reads', 'preferences', 'hidden'].every((k) => Array.isArray(v[k]))
    && (v.dispatches === undefined || Array.isArray(v.dispatches));
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
  return {
    id: m.id, conversation_id: d.id, sender: senderOf(d, m), text: m.body, created_at: m.created_at,
    reply_to: m.reply_to ?? null, mentions: m.mentions ?? [], seq: m.seq,
    root_id: m.root_id ?? null, dispatch_id: m.dispatch_id ?? null, delivery_state: m.delivery_state ?? null,
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
export function conversationStore(dir) {
  let loaded = null;
  const rooms = new Map();

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
      return view(room.state, device);
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
      return view(room.state, device);
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
      return view(room.state, device);
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
      return view(room.state, device);
    },

    async send(id, { actor, text, format = 'text', mentions, reply_to, client_id, admit } = {}) {
      if (!actor || !['human', 'agent'].includes(actor.kind)) throw fault(400, 'Invalid actor');
      if (actor.kind === 'human' ? !HUMAN_ID.test(actor.id ?? '') : !AGENT_REF.test(actor.id ?? '')) throw fault(400, 'Invalid actor');
      if (admit !== undefined && typeof admit !== 'function') throw new TypeError('admit must be a function');
      const authorName = roomActorName(actor.name);
      if (!validText(text)) throw fault(400, 'Invalid message text');
      if (!FORMATS.has(format)) throw fault(400, 'Invalid format');
      if (!validClientId(client_id)) throw fault(400, 'Invalid client_id');
      const parsed = normalizeMentions(mentions, text);
      const room = await use(id);
      const state = room.state;
      // Actor authority sits below HTTP: a human writes only as the room owner, and an agent only while it
      // is an active member. Filesystem/account isolation is not an authority check.
      if (actor.kind === 'human' && state.owner_id !== actor.id) throw notOwner();
      if (actor.kind === 'agent' && !activeAgent(state, actor.id)) throw actorForbidden();
      const fingerprint = sha256(JSON.stringify([text, format, parsed, reply_to ?? null, client_id ?? null]));
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
        const members = new Set(activeMembers(d).map((m) => m.actor_id));
        for (const mention of parsed) if (!members.has(mention.id)) throw unknownMention();
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
        d.messages.push(message);
        const admitted = callAdmit(d, message, false);
        // Generous local cap; Task 11 owns the real retention policy. next_seq stays monotonic.
        while (d.messages.length > MAX_MESSAGES) d.messages.shift();
        d.updated_at = at;
        d.outbox.push({ type: 'message.new', message_id: message.id, seq, at });
        if (d.outbox.length > MAX_OUTBOX) d.outbox.splice(0, d.outbox.length - MAX_OUTBOX);
        result = { message: messageView(d, message), duplicate: false, ...(admitted === undefined ? {} : { admitted }) };
      });
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
      });
      return view(room.state, device);
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
      await room.mutate((d) => {
        const message = d.messages.find((m) => m.id === messageId);
        if (!message) throw messageNotFound();
        if (message.deleted_at) return;
        const at = Date.now();
        message.deleted_at = at; message.body = ''; message.revision += 1;
        d.updated_at = at;
        d.outbox.push({ type: 'message.deleted', message_id: message.id, at });
        if (d.outbox.length > MAX_OUTBOX) d.outbox.splice(0, d.outbox.length - MAX_OUTBOX);
      });
    },

    findMessage,
  };
}
