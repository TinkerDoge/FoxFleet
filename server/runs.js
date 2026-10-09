// Chat runs: the upstream agent stream is decoupled from the client connection.
// A run keeps reading from the agent even if the phone or browser goes away, buffers the events in a bounded log, and
// lets a reconnecting client resume from a cursor (Last-Event-ID / ?after=N). Only an explicit stop cancels the agent.
import { randomBytes } from 'node:crypto';
import { fault } from './config.js';

const SSE_HEADERS = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no' };

export function runRegistry({ ttlMs = 10 * 60_000, maxBytes = 2 * 1024 * 1024, maxRunMs = 30 * 60_000, maxActive = 8, keepAliveMs = 15_000, now = () => Date.now() } = {}) {
  const runs = new Map(); // id -> run

  function sweep() { const t = now(); for (const [id, r] of runs) if (r.done && t - r.finished > ttlMs) runs.delete(id); }
  const push = (r, text) => {
    for (const line of text.split('\n')) if (line.startsWith('data:') && line.length > 8) { try { const c = JSON.parse(line.slice(5))?.choices?.[0]?.delta?.content; if (typeof c === 'string' && r.text.length < 1_000_000) r.text += c; } catch { /* not json */ } }
    const index = r.next++; r.log.push({ index, text }); r.bytes += text.length;
    while (r.bytes > maxBytes && r.log.length > 1) r.bytes -= r.log.shift().text.length;
    for (const fn of r.subs) fn();
  };
  const finish = (r, state) => { if (r.done) return; r.done = true; r.state = state; r.finished = now(); clearTimeout(r.timer); try { r.onFinish?.(r, state); } catch { /* history is best effort */ } if (state !== 'done') push(r, `event: foxfleet.run\ndata: ${JSON.stringify({ state })}`); for (const fn of r.subs) fn(); };

  async function pump(r, body) {
    const reader = body.getReader(), dec = new TextDecoder(); let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let m; while ((m = /\r?\n\r?\n/.exec(buf))) { const ev = buf.slice(0, m.index); buf = buf.slice(m.index + m[0].length); if (ev.trim()) push(r, ev.replace(/\r\n/g, '\n')); }
      }
      if (buf.trim()) push(r, buf.replace(/\r\n/g, '\n'));
      finish(r, 'done');
    } catch { finish(r, r.abort.signal.aborted && r.stopped ? 'stopped' : 'error'); }
  }

  return {
    /** Opens the upstream stream (errors before any byte is sent propagate as normal HTTP errors) and returns the run. */
    async start({ scope, agent, session, open, timeoutMs, check, onFinish }) {
      sweep();
      if ([...runs.values()].filter((r) => r.scope === scope && !r.done).length >= maxActive) throw fault(429, 'Too many chats running at once; wait for one to finish or stop it');
      const abort = new AbortController(), opener = setTimeout(() => abort.abort(), timeoutMs); opener.unref?.();
      let up;
      try { up = await open(abort.signal); } finally { clearTimeout(opener); }
      if (!up.ok || !up.body) { await up.body?.cancel(); throw fault([403, 404, 405, 409, 413, 416].includes(up.status) ? up.status : 502, 'Agent request failed'); }
      const headers = check(up);
      const r = { id: randomBytes(9).toString('base64url'), scope, agent, session: session || headers['X-Hermes-Session-Id'] || null, headers, abort, state: 'running', done: false, stopped: false, started: now(), finished: 0, log: [], text: '', onFinish, next: 1, bytes: 0, subs: new Set() };
      r.timer = setTimeout(() => { abort.abort(); }, maxRunMs); r.timer.unref?.();
      runs.set(r.id, r); void pump(r, up.body); return r;
    },
    get(scope, agent, id) { sweep(); const r = runs.get(id); if (!r || r.scope !== scope || r.agent !== agent) throw fault(404, 'That run is gone (finished runs are kept for a few minutes)'); return r; },
    list(scope, agent, session) { sweep(); return [...runs.values()].filter((r) => r.scope === scope && r.agent === agent && (!session || r.session === session)).map((r) => this.view(r)); },
    view: (r) => ({ id: r.id, session_id: r.session, state: r.state, started: r.started, events: r.next - 1 }),
    stop(r) { if (!r.done) { r.stopped = true; r.abort.abort(); } },
    /** Streams the run's events after cursor `after` to the client and follows it live. Client disconnect only detaches. */
    attach(req, res, r, after = 0) {
      res.writeHead(200, { ...SSE_HEADERS, ...r.headers, 'X-Foxfleet-Run': r.id });
      let cursor = after, closed = false, ka;
      const pull = () => {
        if (closed) return;
        const first = r.log[0]?.index ?? r.next;
        if (cursor + 1 < first) { res.write(`event: foxfleet.gap\ndata: ${JSON.stringify({ first })}\n\n`); cursor = first - 1; }
        for (const e of r.log) if (e.index > cursor) { res.write(`id: ${e.index}\n${e.text}\n\n`); cursor = e.index; }
        if (r.done) { closed = true; clearInterval(ka); r.subs.delete(pull); res.end(); }
      };
      const detach = () => { closed = true; clearInterval(ka); r.subs.delete(pull); };
      res.once('close', detach); r.subs.add(pull);
      ka = setInterval(() => { if (!closed) res.write(': keep-alive\n\n'); }, keepAliveMs); ka.unref?.();
      pull();
    },
  };
}
