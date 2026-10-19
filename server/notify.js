// Notifications, hub side (phase 1): a bounded, persistent per-account event log, per-agent / per-chat mute, and a resumable SSE stream.
// The log carries NO message text: only what is needed to show "X replied / needs approval / failed" and to open the right chat.
// Events are logged even when muted (unread dots and catch-up use `GET /api/notify/events`); a muted event is flagged `muted`
// and is simply not pushed on the stream. Persistence follows the other stores: one JSON file per account, tmp + rename, mode 0600.
import { readFile, writeFile, rename } from 'node:fs/promises';
import { fault } from './config.js';

export const NOTIFY_TYPES = ['reply_finished', 'approval', 'error', 'test', 'conversation'];
export const NOTIFY_CONTRACT = 'foxfleet.notify/1';
const PRIORITY = { reply_finished: 'normal', approval: 'high', error: 'high', test: 'normal', conversation: 'normal' };
const MAX_EVENTS = 500, MAX_MUTES = 200, MAX_STREAMS = 8, RETRY_MS = 3000, HEARTBEAT_MS = 15_000;
const RETRY_BASE_MS = 1000, MAX_RETRIES = 5, RETRY_CAP_MS = 30_000, SAVE_MS = 250, MAX_BACKLOG = 1024 * 1024, DEFAULT_LIMIT = 100, EVENTS_PER_MIN = 60, TESTS_PER_MIN = 10, MINUTE = 60_000,  MAX_FOR_MS = 366 * 24 * 3600 * 1000;
const chatKey = (agent, chat) => `${agent}\n${chat}`;
const word = (v, max = 160) => (typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v) ? v : null);

/** Open streams by device, so a revoked / expired device's streams can be closed at once (see attachNotifyStream `device`). */
const byDevice = new Map();
export function closeDeviceStreams(deviceId, reason = 'signed_out') { let n = 0; for (const close of [...(byDevice.get(deviceId) ?? [])]) { close(reason); n++; } return n; }

export async function notifyStore(file, { now = () => Date.now(), maxEvents = MAX_EVENTS, saveMs = SAVE_MS, eventsPerMin = EVENTS_PER_MIN, testsPerMin = TESTS_PER_MIN, retryMs = RETRY_BASE_MS, maxRetries = MAX_RETRIES, onError } = {}) {
  let db = { seq: 0, events: [], prefs: { enabled: true, agents: {}, chats: {}, rooms: {} } };
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')), p = raw.prefs ?? {};
    const mutes = (o) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).filter(([, m]) => m && (m.until === null || Number.isFinite(m.until))).slice(0, MAX_MUTES).map(([k, m]) => [k, { until: m.until }]));
    db = { seq: Number.isInteger(raw.seq) && raw.seq >= 0 ? raw.seq : 0, events: Array.isArray(raw.events) ? raw.events.filter((e) => e && Number.isInteger(e.id) && NOTIFY_TYPES.includes(e.type)).slice(-maxEvents) : [], prefs: { enabled: p.enabled !== false, agents: mutes(p.agents), chats: mutes(p.chats), rooms: mutes(p.rooms) } };
    for (const e of db.events) db.seq = Math.max(db.seq, e.id); // ids never go backwards, even if the counter was lost
  } catch { /* first run, or unreadable: start empty */ }
  // Saves are coalesced: many changes inside `saveMs` cost ONE write, and the snapshot is taken when the write runs (never queued per change).
  // Mute changes are written at once (and awaited); event bursts are debounced. A failed write is kept in `health` and logged, never thrown into a request.
  let writing = Promise.resolve(), timer = null, retryTimer = null, retries = 0, closed = false, writes = 0, health = { ok: true, error: null, at: null }, lastLogged = 0;
  const write = () => { writing = writing.then(async () => {
    if (closed) return;
    const snap = JSON.stringify(db), tmp = file + '.tmp'; writes++;
    try { await writeFile(tmp, snap, { mode: 0o600 }); await rename(tmp, file); health = { ok: true, error: null, at: health.at }; retries = 0; }
    catch (e) { fail(e); retry(); }
  }); return writing; };
  // A failed write is retried by itself: 1 s, 2 s, 4 s ... (capped at 30 s), at most `maxRetries` times in a row, one timer at a time; a success or a fresh change starts over.
  const retry = () => { if (closed || retryTimer || retries >= maxRetries) return; retryTimer = setTimeout(() => { retryTimer = null; void write(); }, Math.min(RETRY_CAP_MS, retryMs * 2 ** retries++)); retryTimer.unref?.(); };
  const fail = (e) => {
    const code = String(e?.code ?? e?.name ?? 'error').slice(0, 40), t = now(); health = { ok: false, error: code, at: t };
    if (onError) { try { onError(e); } catch { /* ignore */ } } else if (t - lastLogged > MINUTE) { lastLogged = t; console.error(JSON.stringify({ t: new Date(t).toISOString(), event: 'notify.save_failed', code })); } // no path, no content
  };
  const save = () => { if (closed) return; retries = 0; if (!timer) { timer = setTimeout(() => { timer = null; void write(); }, saveMs); timer.unref?.(); } };
  const saveNow = () => { if (timer) { clearTimeout(timer); timer = null; } return write(); };
  const allow = { events: [], tests: [] }, within = (list, limit, t) => { while (list.length && list[0] <= t - MINUTE) list.shift(); if (list.length >= limit) return false; list.push(t); return true; };
  let dropped = 0;
  const subs = new Set();
  const active = (m, t) => m && (m.until === null || m.until > t);
  const prune = (t) => { for (const group of [db.prefs.agents, db.prefs.chats, db.prefs.rooms]) for (const [k, m] of Object.entries(group)) if (!active(m, t)) delete group[k]; };
  const roomId = (v) => (typeof v === 'string' && /^fc_[A-Za-z0-9_-]{16}$/.test(v) ? v : null);

  const store = {
    /** Should an event of this type for this agent/chat/room be pushed? An approval ignores a chat mute. */
    muted(type, agent, chat, t = now(), conversation = null) {
      if (!db.prefs.enabled) return true;
      if (conversation && active(db.prefs.rooms[conversation], t)) return true;
      if (agent && active(db.prefs.agents[agent], t)) return true;
      if (agent && chat && type !== 'approval' && active(db.prefs.chats[chatKey(agent, chat)], t)) return true;
      return false;
    },
    /** Log an event and push it to open streams. `extra` is limited to short ids (never message text). */
    emit({ type, agent = null, chat = null, ...extra }) {
      if (!NOTIFY_TYPES.includes(type)) throw new Error(`unknown notification type ${type}`);
      const conversation = roomId(extra.conversation_id);
      if (conversation) extra.conversation_id = conversation; else if ('conversation_id' in extra) delete extra.conversation_id;
      const t = now();
      if (type !== 'approval' && type !== 'test' && !within(allow.events, eventsPerMin, t)) { dropped++; return null; } // a burst of replies / errors cannot flush the log; approvals are never dropped
      const e = { id: ++db.seq, v: 1, type, agent: word(agent, 100), chat: word(chat), priority: PRIORITY[type], at: t, muted: store.muted(type, word(agent, 100), word(chat), t, conversation), ...extra };
      db.events.push(e); if (db.events.length > maxEvents) db.events.splice(0, db.events.length - maxEvents);
      if (!e.muted) for (const fn of subs) { try { fn(e); } catch { /* one dead stream must not stop the others */ } }
      save(); return e;
    },
    /** Events after cursor `after` (oldest first), and the oldest id still kept: a client resuming from before it missed some. */
    since(after = 0, limit = DEFAULT_LIMIT) {
      const first = db.events[0]?.id ?? db.seq + 1, n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_EVENTS) : DEFAULT_LIMIT; // 0, negatives and junk mean the default
      // gap: some events after `after` are gone (older than `first`), or `after` is from the future (hub data was reset). The client should resync from `cursor`.
      return { events: db.events.filter((e) => e.id > after).slice(0, n), first, cursor: db.seq, gap: after > db.seq || (after > 0 && after + 1 < first) };
    },
    /** Test button: at most `testsPerMin` per minute. */
    allowTest() { return within(allow.tests, testsPerMin, now()); },
    get dropped() { return dropped; },
    get health() { return health; },
    get writes() { return writes; },
    get cursor() { return db.seq; },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    get streams() { return subs.size; },
    prefs(t = now()) {
      prune(t);
      const rooms = Object.entries(db.prefs.rooms).map(([conversation_id, m]) => ({ conversation_id, until: m.until }));
      return { enabled: db.prefs.enabled, storage: health.ok ? { ok: true } : { ok: false, error: health.error }, dropped, agents: Object.entries(db.prefs.agents).map(([agent, m]) => ({ agent, until: m.until })),
        chats: Object.entries(db.prefs.chats).map(([k, m]) => { const [agent, chat] = k.split('\n'); return { agent, chat, until: m.until }; }),
        ...(rooms.length ? { rooms } : {}) };
    },
    /** The active mute of a whole agent ({ until }, null = forever), or null. The chat list shows it. */
    muteOf(agent, t = now()) { const m = db.prefs.agents[agent]; return active(m, t) ? { until: m.until } : null; },
    /** The active mute of one room, shared by every client of the account. */
    roomMuteOf(conversationId, t = now()) { const m = db.prefs.rooms[conversationId]; return active(m, t) ? { until: m.until } : null; },
    /** Mute/unmute one room. Room notifications are one event per room, never one per member. */
    async setRoomMute({ conversationId, muted, forMs }) {
      const id = roomId(conversationId);
      if (!id) throw fault(400, 'conversation_id must be a room id');
      if (typeof muted !== 'boolean') throw fault(400, 'muted must be true or false');
      if (forMs !== undefined && forMs !== null && !(Number.isFinite(forMs) && forMs >= 1000 && forMs <= MAX_FOR_MS)) throw fault(400, 'for_ms must be between 1000 and 31622400000');
      const t = now(); prune(t);
      if (!muted) delete db.prefs.rooms[id];
      else {
        if (!db.prefs.rooms[id] && Object.keys(db.prefs.rooms).length >= MAX_MUTES) throw fault(400, 'Too many mutes; unmute some first');
        db.prefs.rooms[id] = { until: forMs ? t + Math.floor(forMs) : null };
      }
      await saveNow(); return store.prefs(t);
    },
    async setEnabled(enabled) { if (typeof enabled !== 'boolean') throw fault(400, 'enabled must be true or false'); db.prefs.enabled = enabled; await saveNow(); return store.prefs(); },
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
      await saveNow(); return store.prefs(t);
    },
    /** A finished chat run (any agent kind): done -> reply_finished, error -> error. A stopped run is the user's own doing: no notification. */
    fromRun(r, state) {
      if (state === 'done') return store.emit({ type: 'reply_finished', agent: r.agent, chat: r.session, run_id: r.id });
      if (state === 'error') return store.emit({ type: 'error', agent: r.agent, chat: r.session, run_id: r.id, message: 'The agent turn failed' });
      return null;
    },
    flush: () => { if (timer) return saveNow(); return writing; },
    /** Stop for good: cancels pending and retry timers. `{ flush: true }` writes what is pending first (clean shutdown); without it nothing more is written (test teardown, data dir about to go). */
    async close({ flush = false } = {}) { if (flush) await store.flush(); closed = true; clearTimeout(timer); clearTimeout(retryTimer); timer = retryTimer = null; await writing; },
  };
  return store;
}

/** Stream: replay after `after`, then live. Heartbeat comment keeps proxies open; a viewer that cannot keep up is dropped (it resumes by id). */
export function attachNotifyStream(req, res, store, { after = 0, keepAliveMs = HEARTBEAT_MS, device = null, alive = () => true, decorate = null } = {}) {
  if (store.streams >= MAX_STREAMS) throw fault(429, 'Too many notification streams open for this account');
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
  res.write(`retry: ${RETRY_MS}\n\n`);
  const cursor = store.cursor, from = after > cursor ? cursor : after; // a cursor from the future (hub data was reset): do not replay, tell the client
  const { events, first } = store.since(from, MAX_EVENTS);
  if (after > cursor || (from > 0 && from + 1 < first)) res.write(`event: foxfleet.gap\ndata: ${JSON.stringify({ first: Math.min(first, cursor + 1), cursor })}\n\n`); // gap: ids between the client's cursor and `first` are gone
  let last = from, closed = false, ka, unsub = () => {};
  const send = (e) => { if (closed || e.id <= last) return; last = e.id; if (e.muted) return; let extra = null; if (decorate) { try { extra = decorate(e); } catch { extra = null; } } res.write(`id: ${e.id}\nevent: notify\ndata: ${JSON.stringify(extra ? { ...e, ...extra } : e)}\n\n`); if (res.writableLength > MAX_BACKLOG) end(true); }; // a viewer that stops reading is dropped (it resumes by id); the replay itself is bounded by the log size
  const end = (destroy = false, reason = null) => {
    if (closed) return; closed = true; clearInterval(ka); unsub();
    if (device) { const set = byDevice.get(device); set?.delete(close); if (set && !set.size) byDevice.delete(device); }
    if (reason && !res.destroyed) { res.write(`event: foxfleet.auth\ndata: ${JSON.stringify({ reason })}\n\n`); res.end(); } else if (destroy) res.destroy(); else res.end();
  };
  const close = (reason) => end(false, reason); // the session behind this stream ended: say so, then hang up
  if (device) (byDevice.get(device) ?? byDevice.set(device, new Set()).get(device)).add(close);
  for (const e of events) send(e);
  res.write(`event: foxfleet.ready\ndata: ${JSON.stringify({ contract: NOTIFY_CONTRACT, cursor: store.cursor, dropped: store.dropped })}\n\n`); // no id: it must not move Last-Event-ID
  unsub = store.subscribe(send);
  ka = setInterval(() => { if (closed) return; if (!alive()) return close('signed_out'); res.write(': keep-alive\n\n'); }, keepAliveMs); ka.unref?.(); // backstop: a session that expired by age never fires a revoke
  res.once('close', () => end(false)); req.once('aborted', () => end(true));
  return { close: () => end(false) };
}
