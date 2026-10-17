// Live chat events (0.3.14): a per-account, in-memory, bounded event bus and a resumable SSE stream, so an open app sees
// "a run started / finished in this chat", "an approval is waiting" the moment it happens instead of on the next poll or a
// manual reload. Events carry NO message text: the client reacts by fetching the newest page of the chat (catch-up).
// Ids increase per process; a client whose cursor is older than the buffer, or from an earlier process (hub restarted),
// gets `event: foxfleet.gap` and must do a full catch-up. A heartbeat comment every 15 s keeps Cloudflare (100 s idle
// cut) and other proxies from dropping the stream and lets the client detect a dead link by read timeout.
import { randomBytes } from 'node:crypto';
import { fault } from './config.js';

export const LIVE_CONTRACT = 'foxfleet.live/1';
export const LIVE_TYPES = ['run_started', 'run_finished', 'approval'];
const MAX_EVENTS = 500, MAX_STREAMS = 8, RETRY_MS = 2000, HEARTBEAT_MS = 15_000, MAX_BACKLOG = 512 * 1024;
const word = (v, max = 200) => (typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v) ? v : null);

export function liveBus({ maxEvents = MAX_EVENTS, now = () => Date.now(), epoch = randomBytes(6).toString('base64url') } = {}) {
  let seq = 0; const events = [], subs = new Set(); let streams = 0;
  const bus = {
    epoch,
    get cursor() { return seq; },
    get streams() { return streams; },
    set streams(n) { streams = n; },
    /** Adds an event. Unknown types or a missing agent are ignored (returns null); listeners never throw into the caller. */
    emit(e) {
      if (!e || !LIVE_TYPES.includes(e.type) || !word(e.agent)) return null;
      const ev = { id: ++seq, type: e.type, agent: e.agent, chat: word(e.chat), at: now() };
      for (const k of ['run_id', 'state', 'request_id', 'kind']) { const v = word(e[k], 120); if (v) ev[k] = v; }
      events.push(ev); while (events.length > maxEvents) events.shift();
      for (const fn of [...subs]) { try { fn(ev); } catch { /* a broken viewer never breaks the emitter */ } }
      return ev;
    },
    since(after) { const first = events[0]?.id ?? seq + 1; return { events: events.filter((e) => e.id > after), first, cursor: seq }; },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    fromRunStart: (r) => bus.emit({ type: 'run_started', agent: r.agent, chat: r.session, run_id: r.id }),
    fromRunFinish: (r, state) => bus.emit({ type: 'run_finished', agent: r.agent, chat: r.session, run_id: r.id, state }),
  };
  return bus;
}

/** `after` is "<epoch>:<id>". A bare id (no epoch: it cannot be checked against a restart), another epoch (hub restarted), a future id or one older than the buffer is a gap. */
export function parseLiveCursor(v, bus) {
  if (typeof v !== 'string' || !v) return { after: 0, gap: false, fresh: true };
  const m = /^(?:([A-Za-z0-9_-]{1,32}):)?(\d{1,15})$/.exec(v); if (!m) return { after: 0, gap: false, fresh: true };
  const id = Number(m[2]);
  if (!m[1] || m[1] !== bus.epoch || id > bus.cursor) return { after: 0, gap: true, fresh: false };
  return { after: id, gap: false, fresh: false };
}

export function attachLiveStream(req, res, bus, { cursor = '', keepAliveMs = HEARTBEAT_MS, alive = () => true } = {}) {
  if (bus.streams >= MAX_STREAMS) throw fault(429, 'Too many live streams open for this account', 'too_many_streams');
  const c = parseLiveCursor(cursor, bus);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
  res.write(`retry: ${RETRY_MS}\n\n`);
  bus.streams++;
  const { events, first } = bus.since(c.after);
  let gap = c.gap || (!c.fresh && c.after + 1 < first);
  if (gap) res.write(`event: foxfleet.gap\ndata: ${JSON.stringify({ cursor: `${bus.epoch}:${bus.cursor}` })}\n\n`);
  let last = gap ? bus.cursor : c.after, closed = false, ka, unsub = () => {};
  const send = (e) => { if (closed || e.id <= last) return; last = e.id; res.write(`id: ${bus.epoch}:${e.id}\nevent: live\ndata: ${JSON.stringify(e)}\n\n`); if (res.writableLength > MAX_BACKLOG) end(true); };
  const end = (destroy = false, reason = null) => {
    if (closed) return; closed = true; bus.streams--; clearInterval(ka); unsub();
    if (reason && !res.destroyed) { res.write(`event: foxfleet.auth\ndata: ${JSON.stringify({ reason })}\n\n`); res.end(); } else if (destroy) res.destroy(); else res.end();
  };
  if (!c.fresh && !gap) for (const e of events) send(e); // a fresh client starts at "now": it loads the chat itself
  if (c.fresh) last = bus.cursor;
  res.write(`event: foxfleet.ready\ndata: ${JSON.stringify({ contract: LIVE_CONTRACT, cursor: `${bus.epoch}:${bus.cursor}`, heartbeat_ms: keepAliveMs })}\n\n`);
  unsub = bus.subscribe(send);
  ka = setInterval(() => { if (closed) return; if (!alive()) return end(false, 'signed_out'); res.write(': keep-alive\n\n'); }, keepAliveMs); ka.unref?.();
  res.once('close', () => end(false)); req.once('aborted', () => end(true));
  return { close: () => end(false) };
}
