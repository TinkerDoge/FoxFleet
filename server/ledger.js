// Chat ledger (0.4.0-alpha, docs/LIVE-EVENTS.md): the per-account index behind the chat list, unread counts, read receipts and
// message numbering. It holds no transcript: per chat (agent session) it keeps the numbering (`n`, 1, 2, 3 ... gap-free, never
// reused), the agent's own message ids once known, and for the newest messages a short plain-text preview, the role, the time and
// the delivery status of the user's own messages. Message text only travels on the live log (live2.js), never in this file.
//  - Numbering starts from the agent's transcript the first time the hub sees a chat (silently: old history is not "unread"), or
//    from the first message of a chat the hub itself started. Messages the hub sends or receives are numbered at once; messages
//    written elsewhere are found when the hub reads the chat again (`reconcile`) and arrive as `message.new` with source `external`.
//  - hub_id is derived from (agent, chat, n): stable, unique per account, nothing to store.
//  - Read positions only move forward. Unread = agent messages after the read position, hidden ("delete for me") ones excluded.
//  - Idempotency records for notification replies (24 h) live here too.
// One JSON file per account, tmp + rename, mode 0600, debounced like the other stores.
import { readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { previewOf } from './activity.js';

export const PREVIEW_MAX = 160, TEXT_MAX_BYTES = 64 * 1024, IDEM_TTL_MS = 24 * 3600_000;
const MAX_ENTRIES = 300, MAX_IDS = 20_000, MAX_SESSIONS = 100, IDEM_MAX = 30 * 60 * 24, SAVE_MS = 250, RESYNC_MS = 30_000;
const RANK = { sent: 0, delivered: 1, read: 2 };

export const hubIdOf = (agent, chat, n) => 'h' + createHash('sha256').update(`${agent}\0${chat}`).digest('base64url').slice(0, 12) + '.' + n;
/** At most 64 KB of UTF-8, cut on a character boundary. */
export function clipText(text) {
  const t = typeof text === 'string' ? text : '';
  if (Buffer.byteLength(t) <= TEXT_MAX_BYTES) return { text: t, truncated: false };
  return { text: Buffer.from(t).subarray(0, TEXT_MAX_BYTES).toString('utf8').replace(/\uFFFD+$/, ''), truncated: true };
}

// Idempotency keys are kept 24 h. The default cap is a full day at the reply rate limit (30 a minute), so no key is evicted early.
export async function chatLedger(file, { now = () => Date.now(), hooks = {}, idemMax = IDEM_MAX } = {}) {
  let db = { v: 1, agents: {}, idem: {} };
  try { const raw = JSON.parse(await readFile(file, 'utf8')); if (raw && typeof raw === 'object' && raw.agents && typeof raw.agents === 'object') db = { v: 1, agents: raw.agents, idem: raw.idem && typeof raw.idem === 'object' ? raw.idem : {} }; } catch { /* first run */ }
  let writing = Promise.resolve(), timer = null, closed = false;
  const write = () => (writing = writing.then(async () => { if (closed) return; const tmp = file + '.tmp'; await writeFile(tmp, JSON.stringify(db), { mode: 0o600 }); await rename(tmp, file); }).catch(() => {}));
  const save = () => { if (!timer && !closed) { timer = setTimeout(() => { timer = null; void write(); }, SAVE_MS); timer.unref?.(); } };
  const event = (type, fields) => { try { hooks.event?.(type, fields); } catch { /* the log never breaks the ledger */ } };
  const changed = (agent) => { try { hooks.changed?.(agent); } catch { /* ignore */ } };
  const muted = (agent) => { try { return Boolean(hooks.muted?.(agent)); } catch { return false; } };
  const known = (agent) => { try { return hooks.known ? hooks.known(agent) : true; } catch { return true; } };
  const resynced = new Map();

  const agentOf = (agent, create = true) => {
    let a = db.agents[agent];
    if (!a && create) a = db.agents[agent] = { archived: false, manual: false, since: now(), updated: now(), sessions: {} };
    return a ?? null;
  };
  const sessOf = (agent, chat) => db.agents[agent]?.sessions?.[chat] ?? null;
  const newSession = (agent, chat) => {
    const a = agentOf(agent), s = a.sessions[chat] = { last: 0, read: 0, at: now(), ids: {}, msgs: [] };
    const keys = Object.keys(a.sessions);
    if (keys.length > MAX_SESSIONS) { keys.sort((x, y) => (a.sessions[x].at ?? 0) - (a.sessions[y].at ?? 0)); for (const k of keys.slice(0, keys.length - MAX_SESSIONS)) if (k !== chat) delete a.sessions[k]; }
    return s;
  };
  const touch = (agent) => { const a = agentOf(agent); a.updated = now(); };
  const bindId = (s, u, n) => { s.ids[u] = n; const k = Object.keys(s.ids); if (k.length > MAX_IDS) for (const x of k.slice(0, k.length - MAX_IDS)) delete s.ids[x]; };
  const pushEntry = (s, e) => { s.msgs.push(e); if (s.msgs.length > MAX_ENTRIES) s.msgs.splice(0, s.msgs.length - MAX_ENTRIES); };
  const entryOf = (s, n) => s.msgs.find((e) => e.n === n) ?? null;
  const unreadIn = (s) => (s ? s.msgs.filter((e) => e.r === 'assistant' && e.n > s.read && !e.hid).length : 0);
  const agentUnread = (agent) => Object.values(db.agents[agent]?.sessions ?? {}).reduce((t, s) => t + unreadIn(s), 0);
  function totals() {
    let badge = 0, all = 0;
    for (const [name, a] of Object.entries(db.agents)) { if (!known(name)) continue; const u = agentUnread(name); all += u; if (!a.archived && !muted(name)) badge += u; }
    return { total_unread: badge, total_unread_all: all };
  }
  const view = (agent, chat, e, text) => {
    const body = clipText(text ?? '');
    return { hub_id: hubIdOf(agent, chat, e.n), upstream_id: e.u ?? null, n: e.n, role: e.r, text: body.text, ...(body.truncated ? { truncated: true } : {}), at: e.at, source: e.src ?? 'external',
      ...(e.r === 'user' && e.st ? { status: e.st } : {}), ...(e.err ? { error: e.err } : {}), reply_to: e.rt ?? null, edited_at: e.ed ?? null, run_id: e.run ?? null };
  };
  function readState(agent, chat) {
    const s = sessOf(agent, chat);
    return { chat, read_up_to: s?.read ?? 0, unread_count: unreadIn(s), agent_unread: agentUnread(agent), total_unread: totals().total_unread };
  }
  /** Add a message the hub saw (sent through it, or a finished reply). Returns the Message object (as on the wire). */
  function add(agent, chat, { role, text, at, source, status, upstreamId, runId, replyTo, cid, error }) {
    const s = sessOf(agent, chat) ?? newSession(agent, chat), n = ++s.last, t = Number.isFinite(at) ? at : now();
    const e = { n, r: role, at: t, p: previewOf(text ?? '', PREVIEW_MAX), src: source || 'external' };
    if (upstreamId) { e.u = String(upstreamId); bindId(s, e.u, n); }
    if (role === 'user' && status) { e.st = status; if (status === 'delivered') e.dt = t; }
    if (runId) e.run = runId; if (replyTo) e.rt = replyTo; if (cid) e.cid = cid; if (error) e.err = String(error).slice(0, 300);
    pushEntry(s, e); s.at = Math.max(s.at ?? 0, t);
    const readMoved = role === 'user' && s.read < n; if (readMoved) s.read = n; // sending in a chat reads it up to your own message
    const a = agentOf(agent); if (role === 'user') a.manual = false;
    if (role === 'assistant' && a.archived && !muted(agent)) a.archived = false; // a new message brings an unmuted archived chat back
    touch(agent); save();
    const msg = view(agent, chat, e, text);
    event('message.new', { agent, chat, message: msg });
    if (readMoved) { const st = readState(agent, chat); event('read', { agent, chat, read_up_to: st.read_up_to, unread_count: st.unread_count, agent_unread: st.agent_unread, total_unread: st.total_unread }); }
    changed(agent);
    return msg;
  }
  /** Move the status of the user's own messages forward (sent -> delivered -> read; failed from sent or delivered). */
  function setStatus(agent, chat, pred, status, extra = {}) {
    const s = sessOf(agent, chat); if (!s) return [];
    const moved = [];
    for (const e of s.msgs) {
      if (e.r !== 'user' || !pred(e)) continue;
      const cur = e.st ?? 'sent';
      if (cur === 'failed' || cur === 'read') continue;
      if (status !== 'failed' && RANK[status] <= RANK[cur]) continue;
      e.st = status; if (status === 'failed' && extra.error) e.err = String(extra.error).slice(0, 300);
      if (status === 'delivered') { e.dt = now(); if (extra.runId) e.run = extra.runId; }
      moved.push(e.n);
    }
    if (moved.length) { save(); event('message.status', { agent, chat, hub_ids: moved.map((n) => hubIdOf(agent, chat, n)), status }); changed(agent); }
    return moved;
  }
  /** Bring the index in line with the agent's transcript (normalized messages, oldest first). See the header for the rules. */
  function reconcile(agent, chat, msgs, { unreadNew = false } = {}) {
    let s = sessOf(agent, chat); const list = (Array.isArray(msgs) ? msgs : []).filter((m) => m && (m.role === 'user' || m.role === 'assistant'));
    resynced.set(`${agent}\0${chat}`, now());
    if (!s) {
      s = newSession(agent, chat);
      for (const m of list) {
        const n = ++s.last; if (m.id != null) bindId(s, String(m.id), n);
        pushEntry(s, { n, r: m.role, at: Number.isFinite(m.ts) ? m.ts : now(), p: previewOf(m.content ?? '', PREVIEW_MAX), src: 'external', ...(m.id != null ? { u: String(m.id) } : {}) });
        if (unreadNew) event('message.new', { agent, chat, message: view(agent, chat, s.msgs.at(-1), m.content) });
      }
      s.read = unreadNew ? 0 : s.last; s.at = Math.max(s.at, ...list.map((m) => (Number.isFinite(m.ts) ? m.ts : 0)));
      touch(agent); save(); changed(agent); return { added: unreadNew ? list.length : 0, bound: 0 };
    }
    const withId = list.filter((m) => m.id != null);
    let lastKnown = -1; withId.forEach((m, i) => { if (s.ids[String(m.id)]) lastKnown = i; });
    let anchor = lastKnown >= 0 ? s.ids[String(withId[lastKnown].id)] : 0, added = 0, bound = 0;
    for (const m of withId.slice(lastKnown + 1)) {
      const u = String(m.id), p = previewOf(m.content ?? '', PREVIEW_MAX);
      const open = s.msgs.filter((e) => !e.u && e.r === m.role && e.n > anchor);
      const e = open.find((x) => x.p === p) ?? open[0];
      if (e) { e.u = u; bindId(s, u, e.n); anchor = e.n; bound++; event('message.edited', { agent, chat, message: view(agent, chat, e, m.content) }); continue; }
      const n = ++s.last, at = Number.isFinite(m.ts) ? m.ts : now(), ne = { n, r: m.role, at, p, src: 'external', u };
      bindId(s, u, n); pushEntry(s, ne); s.at = Math.max(s.at, at); anchor = n; added++;
      const a = agentOf(agent); if (m.role === 'assistant' && a.archived && !muted(agent)) a.archived = false;
      event('message.new', { agent, chat, message: view(agent, chat, ne, m.content) });
    }
    if (added || bound) { touch(agent); save(); changed(agent); }
    return { added, bound };
  }
  return {
    hubIdOf, totals, readState, agentUnread, add, setStatus, reconcile,
    has: (agent, chat) => Boolean(sessOf(agent, chat)),
    ensureAgent: (agent) => { if (!db.agents[agent]) { agentOf(agent); save(); } return db.agents[agent]; },
    agent: (agent) => db.agents[agent] ?? null,
    /** Should the history of this chat be read again (some ids unknown)? At most once per 30 s per chat. */
    mayResync: (agent, chat) => now() - (resynced.get(`${agent}\0${chat}`) ?? 0) > RESYNC_MS,
    /** Adds hub_id, n and status to history messages the ledger knows. Returns how many messages with an id were unknown. */
    annotate(agent, chat, msgs) {
      const s = sessOf(agent, chat); let missing = 0;
      for (const m of msgs) {
        if (m?.id == null) continue;
        const n = s?.ids[String(m.id)]; if (!n) { missing++; continue; }
        m.hub_id = hubIdOf(agent, chat, n); m.n = n; const e = entryOf(s, n); if (e?.r === 'user' && e.st) m.status = e.st;
      }
      return missing;
    },
    entryByCid: (agent, chat, cid) => (cid ? sessOf(agent, chat)?.msgs.find((e) => e.cid === cid) ?? null : null),
    setCid(agent, chat, n, cid) { const e = sessOf(agent, chat) && entryOf(sessOf(agent, chat), n); if (e && cid) { e.cid = cid; save(); } },
    /** The user's newest messages that the agent accepted get "read" once the agent starts answering (this run, or a run that started after they arrived). */
    readByAgent(agent, chat, run) { return setStatus(agent, chat, (e) => e.st === 'delivered' && (e.run === run.id || (!e.run && (e.dt ?? 0) <= run.started)), 'read'); },
    /** Mark read up to n (clamped, monotonic). Returns { changed, state }. */
    read(agent, chat, upTo) {
      const s = sessOf(agent, chat), a = agentOf(agent); if (!s) return { changed: false, state: readState(agent, chat) };
      const to = Math.min(Math.max(0, Math.floor(upTo)), s.last); let moved = false;
      if (to > s.read) { s.read = to; moved = true; }
      const unflag = a.manual; a.manual = false;
      if (moved || unflag) { touch(agent); save(); }
      const state = readState(agent, chat);
      if (moved) event('read', { agent, chat, read_up_to: state.read_up_to, unread_count: state.unread_count, agent_unread: state.agent_unread, total_unread: state.total_unread });
      if (moved || unflag) changed(agent);
      return { changed: moved || unflag, state };
    },
    lastN: (agent, chat) => sessOf(agent, chat)?.last ?? 0,
    readUpTo: (agent, chat) => sessOf(agent, chat)?.read ?? 0,
    sessionAt: (agent, chat) => sessOf(agent, chat)?.at ?? 0,
    /** The current wire view of message n (status as of now), with the given text. */
    messageAt(agent, chat, n, text) { const s = sessOf(agent, chat), e = s && entryOf(s, n); return e ? view(agent, chat, e, text) : null; },
    sessions: (agent) => Object.keys(db.agents[agent]?.sessions ?? {}),
    /** The chat the app opens: the session with the newest message. */
    latest(agent) { const ss = db.agents[agent]?.sessions ?? {}; let best = null; for (const [k, s] of Object.entries(ss)) if (!best || (s.at ?? 0) > (ss[best].at ?? 0)) best = k; return best; },
    lastMessage(agent) {
      const ss = db.agents[agent]?.sessions ?? {}; let best = null;
      for (const [chat, s] of Object.entries(ss)) for (const e of s.msgs) if (!e.hid && (!best || e.at > best.e.at || (e.at === best.e.at && chat === best.chat && e.n > best.e.n))) best = { chat, e };
      return best;
    },
    setArchived(agent, on) { const a = agentOf(agent); if (a.archived !== on) { a.archived = on; touch(agent); save(); changed(agent); } return a; },
    setManualUnread(agent, on) { const a = agentOf(agent); if (a.manual !== on) { a.manual = on; touch(agent); save(); changed(agent); } return a; },
    /** "Delete for me" on an upstream message id: message.deleted (or message.edited when shown again, with its text). */
    hide(agent, chat, upstreamId, present, text) {
      const s = sessOf(agent, chat), n = s?.ids[String(upstreamId)]; if (!n) return false;
      const e = entryOf(s, n); if (e) { if (Boolean(e.hid) === present) return false; if (present) e.hid = 1; else delete e.hid; }
      touch(agent); save();
      if (present) event('message.deleted', { agent, chat, hub_ids: [hubIdOf(agent, chat, n)], scope: 'me' });
      else event('message.edited', { agent, chat, message: view(agent, chat, e ?? { n, r: 'assistant', at: now(), u: String(upstreamId) }, text) });
      changed(agent); return true;
    },
    removeSession(agent, chat) { const a = db.agents[agent]; if (a?.sessions?.[chat]) { delete a.sessions[chat]; touch(agent); save(); changed(agent); } },
    removeAgent(agent) { if (db.agents[agent]) { delete db.agents[agent]; save(); } event('chat.removed', { agent }); },
    idem: {
      get(key) { const r = db.idem[key]; if (!r || now() - r.at > IDEM_TTL_MS) return null; return r; },
      put(key, hash, result) {
        const t = now(); for (const [k, r] of Object.entries(db.idem)) if (t - r.at > IDEM_TTL_MS) delete db.idem[k];
        db.idem[key] = { h: hash, at: t, result }; const keys = Object.keys(db.idem); if (keys.length > idemMax) for (const k of keys.slice(0, keys.length - idemMax)) delete db.idem[k];
        save();
      },
    },
    flush: async () => { if (timer) { clearTimeout(timer); timer = null; await write(); } return writing; },
    async close() { if (timer) { clearTimeout(timer); timer = null; await write(); } await writing; closed = true; },
  };
}
