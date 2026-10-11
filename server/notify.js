// Notifications, hub side (phase 1): a bounded, persistent per-account event log, per-agent / per-chat mute, and a resumable SSE stream.
// The log carries NO message text: only what is needed to show "X replied / needs approval / failed" and to open the right chat.
// Events are logged even when muted (unread dots and catch-up use `GET /api/notify/events`); a muted event is flagged `muted`
// and is simply not pushed on the stream. Persistence follows the other stores: one JSON file per account, tmp + rename, mode 0600.
import { readFile, writeFile, rename } from 'node:fs/promises';
import { fault } from './config.js';

export const NOTIFY_TYPES = ['reply_finished', 'approval', 'error', 'test'];
export const NOTIFY_CONTRACT = 'foxfleet.notify/1';
const PRIORITY = { reply_finished: 'normal', approval: 'high', error: 'high', test: 'normal' };
const MAX_EVENTS = 500, MAX_MUTES = 200, MAX_STREAMS = 8, RETRY_MS = 3000, HEARTBEAT_MS = 15_000;
const MAX_BACKLOG = 1024 * 1024, MAX_FOR_MS = 366 * 24 * 3600 * 1000;
const chatKey = (agent, chat) => `${agent}\n${chat}`;
const word = (v, max = 160) => (typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v) ? v : null);

export async function notifyStore(file, { now = () => Date.now(), maxEvents = MAX_EVENTS } = {}) {
  let db = { seq: 0, events: [], prefs: { enabled: true, agents: {}, chats: {} } };
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')), p = raw.prefs ?? {};
    const mutes = (o) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).filter(([, m]) => m && (m.until === null || Number.isFinite(m.until))).slice(0, MAX_MUTES).map(([k, m]) => [k, { until: m.until }]));
    db = { seq: Number.isInteger(raw.seq) && raw.seq >= 0 ? raw.seq : 0, events: Array.isArray(raw.events) ? raw.events.filter((e) => e && Number.isInteger(e.id) && NOTIFY_TYPES.includes(e.type)).slice(-maxEvents) : [], prefs: { enabled: p.enabled !== false, agents: mutes(p.agents), chats: mutes(p.chats) } };
    for (const e of db.events) db.seq = Math.max(db.seq, e.id); // ids never go backwards, even if the counter was lost
  } catch { /* first run, or unreadable: start empty */ }
  let writing = Promise.resolve();
  const save = () => { const snap = JSON.stringify(db), tmp = file + '.tmp'; writing = writing.then(() => writeFile(tmp, snap, { mode: 0o600 }).then(() => rename(tmp, file))).catch(() => {}); return writing; };
  const subs = new Set();
  const active = (m, t) => m && (m.until === null || m.until > t);
  const prune = (t) => { for (const group of [db.prefs.agents, db.prefs.chats]) for (const [k, m] of Object.entries(group)) if (!active(m, t)) delete group[k]; };

  const store = {
    /** Should an event of this type for this agent/chat be pushed? Approvals ignore a chat mute (not an agent mute or the master switch). */
    muted(type, agent, chat, t = now()) {
      if (!db.prefs.enabled) return true;
      if (agent && active(db.prefs.agents[agent], t)) return true;
      if (agent && chat && type !== 'approval' && active(db.prefs.chats[chatKey(agent, chat)], t)) return true;
      return false;
    },
    /** Log an event and push it to open streams. `extra` is limited to short ids (never message text). */
    emit({ type, agent = null, chat = null, ...extra }) {
      if (!NOTIFY_TYPES.includes(type)) throw new Error(`unknown notification type ${type}`);
      const t = now(), e = { id: ++db.seq, v: 1, type, agent: word(agent, 100), chat: word(chat), priority: PRIORITY[type], at: t, muted: store.muted(type, word(agent, 100), word(chat), t), ...extra };
      db.events.push(e); if (db.events.length > maxEvents) db.events.splice(0, db.events.length - maxEvents);
      if (!e.muted) for (const fn of subs) { try { fn(e); } catch { /* one dead stream must not stop the others */ } }
      void save(); return e;
    },
    /** Events after cursor `after` (oldest first), and the oldest id still kept: a client resuming from before it missed some. */
    since(after = 0, limit = MAX_EVENTS) {
      const first = db.events[0]?.id ?? db.seq + 1, list = db.events.filter((e) => e.id > after);
      return { events: list.slice(0, Math.max(1, Math.min(MAX_EVENTS, limit | 0 || MAX_EVENTS))), first, cursor: db.seq };
    },
    get cursor() { return db.seq; },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    get streams() { return subs.size; },
    prefs(t = now()) {
      prune(t);
      return { enabled: db.prefs.enabled, agents: Object.entries(db.prefs.agents).map(([agent, m]) => ({ agent, until: m.until })),
        chats: Object.entries(db.prefs.chats).map(([k, m]) => { const [agent, chat] = k.split('\n'); return { agent, chat, until: m.until }; }) };
    },
    async setEnabled(enabled) { if (typeof enabled !== 'boolean') throw fault(400, 'enabled must be true or false'); db.prefs.enabled = enabled; await save(); return store.prefs(); },
    /** Mute (`muted: true`, optionally for `forMs`; no duration = until unmuted) or unmute one agent, or one chat of it. */
    async setMute({ agent, chat, muted, forMs }) {
      const a = word(agent, 100); if (!a) throw fault(400, 'agent is required');
      if (chat !== undefined && chat !== null && !word(chat)) throw fault(400, 'Invalid chat');
      if (typeof muted !== 'boolean') throw fault(400, 'muted must be true or false');
      if (forMs !== undefined && forMs !== null && !(Number.isFinite(forMs) && forMs >= 1000 && forMs <= MAX_FOR_MS)) throw fault(400, 'for_ms must be between 1000 and 31622400000');
      const t = now(); prune(t);
      const group = chat ? db.prefs.chats : db.prefs.agents, k = chat ? chatKey(a, chat) : a;
      if (!muted) delete group[k];
      else { if (!group[k] && Object.keys(group).length >= MAX_MUTES) throw fault(400, 'Too many mutes; unmute some first'); group[k] = { until: forMs ? t + Math.floor(forMs) : null }; }
      await save(); return store.prefs(t);
    },
    /** A finished chat run (any agent kind): done -> reply_finished, error -> error. A stopped run is the user's own doing: no notification. */
    fromRun(r, state) {
      if (state === 'done') return store.emit({ type: 'reply_finished', agent: r.agent, chat: r.session, run_id: r.id });
      if (state === 'error') return store.emit({ type: 'error', agent: r.agent, chat: r.session, run_id: r.id, message: 'The agent turn failed' });
      return null;
    },
    flush: () => writing,
  };
  return store;
}

/** Stream: replay after `after`, then live. Heartbeat comment keeps proxies open; a viewer that cannot keep up is dropped (it resumes by id). */
export function attachNotifyStream(req, res, store, { after = 0, keepAliveMs = HEARTBEAT_MS } = {}) {
  if (store.streams >= MAX_STREAMS) throw fault(429, 'Too many notification streams open for this account');
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
  res.write(`retry: ${RETRY_MS}\n\n`);
  const cursor = store.cursor, from = after > cursor ? cursor : after; // a cursor from the future (hub data was reset): do not replay, tell the client
  const { events, first } = store.since(from, MAX_EVENTS);
  if (after > cursor || (from > 0 && from + 1 < first)) res.write(`event: foxfleet.gap\ndata: ${JSON.stringify({ first: Math.min(first, cursor + 1), cursor })}\n\n`); // gap: ids between the client's cursor and `first` are gone
  let last = from, closed = false, ka, unsub = () => {};
  const send = (e) => { if (closed || e.id <= last) return; last = e.id; if (e.muted) return; res.write(`id: ${e.id}\nevent: notify\ndata: ${JSON.stringify(e)}\n\n`); if (res.writableLength > MAX_BACKLOG) end(true); }; // a viewer that stops reading is dropped (it resumes by id); the replay itself is bounded by the log size
  const end = (destroy = false) => { if (closed) return; closed = true; clearInterval(ka); unsub(); if (destroy) res.destroy(); else res.end(); };
  for (const e of events) send(e);
  res.write(`event: foxfleet.ready\ndata: ${JSON.stringify({ contract: NOTIFY_CONTRACT, cursor: store.cursor })}\n\n`); // no id: it must not move Last-Event-ID
  unsub = store.subscribe(send);
  ka = setInterval(() => { if (!closed) res.write(': keep-alive\n\n'); }, keepAliveMs); ka.unref?.();
  res.once('close', () => end(false)); req.once('aborted', () => end(true));
  return { close: () => end(false) };
}
