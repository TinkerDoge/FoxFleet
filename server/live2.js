// Live events v2 (0.4.0-alpha, docs/LIVE-EVENTS.md "v2"): a persistent, per-account event log with an account-wide sequence number,
// so an app can keep a local cache exactly in sync and resume after a drop or a hub restart without losing or repeating anything.
//  - Every persisted event gets `seq` (strictly increasing, never reused, survives restarts). Its SSE id is `<store>:<seq>`; `store`
//    names this data directory and changes only when the hub's data is reset (a cursor from another store is a `reset` gap).
//  - Kept: the newest FOXFLEET_LIVE_RETAIN_EVENTS events (default 5000), at most FOXFLEET_LIVE_RETAIN_DAYS days (default 7), and at
//    most 32 MiB of event JSON. Anything dropped raises `floor`: a cursor below it is an `expired` gap.
//  - Storage: `<base>.jsonl` (one event per line, appended in small batches, compacted when it grows) and `<base>.json` (store id,
//    floor, and a reserved seq block: after a crash the counter resumes above anything that may have been handed out). Mode 0600.
//  - Typing is ephemeral: pushed to open streams only, never stored, no id.
import { readFile, writeFile, appendFile, rename } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fault } from './config.js';

export const LIVE2_CONTRACT = 'foxfleet.live/2';
export const LIVE2_TYPES = ['message.new', 'message.edited', 'message.deleted', 'message.status', 'read', 'chat.updated', 'chat.removed', 'run.started', 'run.finished', 'approval'];
export const RETAIN_EVENTS = 5000, RETAIN_DAYS = 7, RETAIN_BYTES = 32 * 1024 * 1024, PULL_MAX = 500, PULL_DEFAULT = 200;
const BLOCK = 1000, RETRY_MS = 2000, HEARTBEAT_MS = 15_000, MAX_BACKLOG = 1024 * 1024, MAX_STREAMS = 8, FLUSH_MS = 25, DAY = 86_400_000;
const CURSOR = /^([A-Za-z0-9_-]{1,32}):(\d{1,16})$/;

/** Retention from the environment, clamped to sane bounds (junk means the default). */
export function retentionFromEnv(env = { FOXFLEET_LIVE_RETAIN_EVENTS: process.env.FOXFLEET_LIVE_RETAIN_EVENTS, FOXFLEET_LIVE_RETAIN_DAYS: process.env.FOXFLEET_LIVE_RETAIN_DAYS }) {
  const int = (v, lo, hi, d) => { const n = Number(v); return v !== undefined && v !== '' && Number.isInteger(n) && n >= lo && n <= hi ? n : d; };
  return { retainEvents: int(env.FOXFLEET_LIVE_RETAIN_EVENTS, 100, 100_000, RETAIN_EVENTS), retainDays: int(env.FOXFLEET_LIVE_RETAIN_DAYS, 1, 90, RETAIN_DAYS) };
}

export async function liveLog(base, { now = () => Date.now(), retainEvents = RETAIN_EVENTS, retainDays = RETAIN_DAYS, maxBytes = RETAIN_BYTES, onError } = {}) {
  const metaFile = base + '.json', logFile = base + '.jsonl';
  let store = null, seq = 0, floor = 0, reserved = 0, events = [], bytes = 0, diskLines = 0;
  try {
    const meta = JSON.parse(await readFile(metaFile, 'utf8'));
    if (typeof meta?.store === 'string' && /^[A-Za-z0-9_-]{8,32}$/.test(meta.store)) {
      store = meta.store; floor = Number.isInteger(meta.floor) && meta.floor >= 0 ? meta.floor : 0;
      let raw = ''; try { raw = await readFile(logFile, 'utf8'); } catch { /* no events yet */ }
      let last = floor;
      for (const line of raw.split('\n')) {
        if (!line) continue; diskLines++;
        let e; try { e = JSON.parse(line); } catch { continue; } // a torn last line after a crash
        if (!e || !Number.isInteger(e.seq) || e.seq <= last || !LIVE2_TYPES.includes(e.type)) continue;
        last = e.seq; events.push({ seq: e.seq, type: e.type, at: Number(e.at) || 0, line }); bytes += line.length;
      }
      const counted = meta.clean === true && Number.isInteger(meta.seq) ? meta.seq : Number.isInteger(meta.reserved) ? meta.reserved : 0;
      seq = Math.max(last, counted, floor);
    }
  } catch { /* first run or unreadable meta: a new store (clients get a `reset` gap) */ }
  if (!store) { store = randomBytes(9).toString('base64url'); events = []; bytes = 0; seq = 0; floor = 0; diskLines = 0; }

  let chain = Promise.resolve(), pending = [], timer = null, closed = false, health = { ok: true, error: null }, lastLogged = 0, metaDirty = false;
  const fail = (e) => {
    health = { ok: false, error: String(e?.code ?? 'error').slice(0, 40) };
    if (onError) { try { onError(e); } catch { /* ignore */ } } else if (now() - lastLogged > 60_000) { lastLogged = now(); console.error(JSON.stringify({ t: new Date().toISOString(), event: 'live2.save_failed', code: health.error })); }
  };
  const atomic = async (file, text) => { const tmp = file + '.tmp'; await writeFile(tmp, text, { mode: 0o600 }); await rename(tmp, file); };
  const writeMeta = (clean = false) => atomic(metaFile, JSON.stringify({ v: 1, store, floor, seq, reserved: clean ? seq : reserved, clean }));
  const prune = (t = now()) => {
    let dropped = false;
    while (events.length && (events.length > retainEvents || bytes > maxBytes || events[0].at < t - retainDays * DAY)) { const e = events.shift(); bytes -= e.line.length; floor = Math.max(floor, e.seq); dropped = true; }
    if (dropped) metaDirty = true;
  };
  const flush = () => { if (timer) { clearTimeout(timer); timer = null; } chain = chain.then(async () => {
    if (closed && !pending.length && !metaDirty) return;
    const lines = pending; pending = [];
    try {
      if (diskLines + lines.length > retainEvents * 2 + 1000) { await atomic(logFile, events.map((e) => e.line + '\n').join('')); diskLines = events.length; } // compaction
      else if (lines.length) { await appendFile(logFile, lines.map((l) => l + '\n').join(''), { mode: 0o600 }); diskLines += lines.length; }
      if (metaDirty) { metaDirty = false; await writeMeta(); }
      health = { ok: true, error: null };
    } catch (e) { fail(e); }
  }); return chain; };
  const later = () => { if (!timer && !closed) { timer = setTimeout(flush, FLUSH_MS); timer.unref?.(); } };

  prune(); reserved = seq + BLOCK;
  try { await writeMeta(); await atomic(logFile, events.map((e) => e.line + '\n').join('')); diskLines = events.length; } catch (e) { fail(e); }

  const subs = new Set(); let streams = 0;
  const log = {
    get store() { return store; },
    get seq() { return seq; },
    get floor() { return floor; },
    get cursor() { return `${store}:${seq}`; },
    get health() { return health; },
    get size() { return events.length; },
    get streams() { return streams; },
    set streams(n) { streams = n; },
    /** Append one event: { seq, type, at, ...fields }. Returns it. Never throws into the caller for storage trouble. */
    emit(type, fields = {}) {
      if (!LIVE2_TYPES.includes(type)) throw new Error(`unknown live event ${type}`);
      const t = now(), ev = { seq: ++seq, type, at: t };
      for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && !(k in ev)) ev[k] = v;
      if (seq > reserved) { reserved = seq + BLOCK; metaDirty = true; }
      const line = JSON.stringify(ev), entry = { seq: ev.seq, type, at: t, line };
      events.push(entry); bytes += line.length; prune(t); pending.push(line); later();
      for (const fn of [...subs]) { try { fn(entry); } catch { /* a broken viewer never breaks the emitter */ } }
      return ev;
    },
    /** Ephemeral typing frame to every open stream (not stored, no seq). */
    typing(data) { const line = JSON.stringify(data); for (const fn of [...subs]) { try { fn({ typing: true, line }); } catch { /* ignore */ } } },
    /** Parse a client cursor: none | invalid | reset | expired | ok (with seq). */
    parse(v) {
      if (v === undefined || v === null || v === '') return { kind: 'none' };
      const m = CURSOR.exec(String(v)); if (!m) return { kind: 'invalid' };
      const n = Number(m[2]);
      if (m[1] !== store || n > seq) return { kind: 'reset' };
      if (n < floor) return { kind: 'expired' };
      return { kind: 'ok', seq: n };
    },
    /** Events after `after` (oldest first), at most `limit`. */
    since(after, limit = PULL_MAX) {
      prune(); let i = 0; while (i < events.length && events[i].seq <= after) i++;
      const out = events.slice(i, i + limit);
      return { entries: out, hasMore: i + limit < events.length };
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    flush,
    /** Clean shutdown: write what is pending and record the exact counter (no reserved-block jump on the next start). */
    async close() { await flush(); closed = true; clearTimeout(timer); timer = null; await chain; try { await writeMeta(true); } catch (e) { fail(e); } },
  };
  return log;
}

/** The v2 SSE stream. `counter` holds the account's stream count shared with v1 (8 in total). */
export function attachLive2Stream(req, res, log, { cursor = '', keepAliveMs = HEARTBEAT_MS, alive = () => true, counter = log, maxStreams = MAX_STREAMS } = {}) {
  if (counter.streams >= maxStreams) throw fault(429, 'Too many live streams open for this account', 'too_many_streams');
  const c = log.parse(cursor);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
  res.write(`retry: ${RETRY_MS}\n\n`);
  counter.streams++;
  let last = log.seq, closed = false, ka, unsub = () => {};
  const end = (destroy = false, reason = null) => {
    if (closed) return; closed = true; counter.streams--; clearInterval(ka); unsub();
    if (reason && !res.destroyed) { res.write(`event: foxfleet.auth\ndata: ${JSON.stringify({ reason })}\n\n`); res.end(); } else if (destroy) res.destroy(); else res.end();
  };
  const send = (entry) => {
    if (closed) return;
    if (entry.typing) res.write(`event: typing\ndata: ${entry.line}\n\n`);
    else { if (entry.seq <= last) return; last = entry.seq; res.write(`id: ${log.store}:${entry.seq}\nevent: ${entry.type}\ndata: ${entry.line}\n\n`); }
    if (res.writableLength > MAX_BACKLOG) end(true); // a viewer that stops reading is dropped; it resumes by id
  };
  if (c.kind === 'invalid' || c.kind === 'reset' || c.kind === 'expired') res.write(`event: foxfleet.gap\ndata: ${JSON.stringify({ reason: c.kind, cursor: log.cursor })}\n\n`);
  else if (c.kind === 'ok') { last = c.seq; let after = c.seq; for (;;) { const { entries, hasMore } = log.since(after, PULL_MAX); for (const e of entries) send(e); if (!hasMore || !entries.length || closed) break; after = entries.at(-1).seq; } }
  if (closed) return { close: () => {} };
  res.write(`event: foxfleet.ready\ndata: ${JSON.stringify({ contract: LIVE2_CONTRACT, cursor: `${log.store}:${last}`, store: log.store, heartbeat_ms: keepAliveMs })}\n\n`);
  unsub = log.subscribe(send);
  ka = setInterval(() => { if (closed) return; if (!alive()) return end(false, 'signed_out'); res.write(': keep-alive\n\n'); }, keepAliveMs); ka.unref?.();
  res.once('close', () => end(false)); req.once('aborted', () => end(true));
  return { close: () => end(false) };
}
