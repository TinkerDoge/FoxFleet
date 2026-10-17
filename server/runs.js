// Chat runs: the upstream agent stream is decoupled from the client connection.
// A run keeps reading from the agent even if the phone or browser goes away, buffers the events in a bounded log, and
// lets a reconnecting client resume from a cursor (Last-Event-ID / ?after=N). Only an explicit stop cancels the agent.
import { normaliseSse } from './reasoning.js';
import { randomBytes } from 'node:crypto';
import { fault } from './config.js';
import { clip, TOOL_NAME_MAX, TOOL_PREVIEW_MAX, MSG_TOOLS_MAX } from './steps.js';

/** Reconnect hint sent at the start of every event stream. */
export const RETRY_MS = 3000;
const SSE_HEADERS = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no' };

export function runRegistry({ ttlMs = 10 * 60_000, maxBytes = 2 * 1024 * 1024, maxRunMs = 30 * 60_000, maxActive = 8, keepAliveMs = 15_000, now = () => Date.now() } = {}) {
  const runs = new Map(); // id -> run
  const finishListeners = [], startListeners = [], eventListeners = [];
  // What the agent is doing right now, from one upstream SSE event: writing ('typing'), reasoning ('thinking') or running a tool ('tool'),
  // plus the step detail live v2 shows (typing label / tool_id, run.step). kind is null when the event only carries a label or a step.
  const dataOf = (text) => { try { return JSON.parse(/^data: ?(.*)$/m.exec(text)?.[1] ?? '{}') ?? {}; } catch { return {}; } };
  const activityOf = (text, r) => {
    const ev = /^event: (\S+)$/m.exec(text)?.[1];
    if (ev === 'hermes.tool.progress') {
      const d = dataOf(text), tool = String(d?.tool ?? '') || 'tool', label = typeof d?.label === 'string' && d.label.trim() ? clip(d.label.replace(/\s+/g, ' ').trim(), TOOL_PREVIEW_MAX) : null;
      // chat completions (no native link) only send this frame, once per tool start; the native and /v1/runs paths also send foxfleet.tool, which carries the step
      const cc = !r.link;
      return { kind: 'tool', tool, label, ...(cc ? { step: { kind: 'tool.start', name: clip(tool, TOOL_NAME_MAX), ...(label ? { preview: label } : {}) }, cc: true } : {}) };
    }
    if (ev === 'foxfleet.tool') {
      const d = dataOf(text), name = clip(String(d?.name ?? 'tool'), TOOL_NAME_MAX), tool_id = typeof d?.tool_id === 'string' && d.tool_id ? d.tool_id.slice(0, 120) : undefined;
      if (d?.type === 'tool.start') return { kind: 'tool', tool: name, toolId: tool_id, label: d.preview || null, step: { kind: 'tool.start', ...(tool_id ? { tool_id } : {}), name, ...(d.preview ? { preview: d.preview } : {}) }, lifecycle: d };
      if (d?.type === 'tool.end') return { kind: null, step: { kind: 'tool.end', ...(tool_id ? { tool_id } : {}), name, ...(typeof d.ok === 'boolean' ? { ok: d.ok } : {}), ...(Number.isFinite(d.duration_ms) ? { duration_ms: d.duration_ms } : {}), ...(d.result_preview ? { preview: d.result_preview } : {}) }, lifecycle: d };
      return { kind: 'tool', tool: name, toolId: tool_id, label: null };
    }
    if (ev === 'foxfleet.step') {
      const d = dataOf(text), t = typeof d?.text === 'string' ? d.text : '';
      return t ? { kind: null, label: clip(t, TOOL_PREVIEW_MAX), step: { kind: d.kind === 'commentary' ? 'commentary' : 'status', text: t } } : null;
    }
    if (ev) return null;
    let kind = null;
    for (const line of text.split('\n')) if (line.startsWith('data:') && line.length > 8) { try { const d = JSON.parse(line.slice(5))?.choices?.[0]?.delta; if (typeof d?.content === 'string' && d.content) return { kind: 'typing', tool: null }; if (typeof d?.reasoning_content === 'string' && d.reasoning_content) kind = 'thinking'; } catch { /* not json */ } }
    return kind ? { kind, tool: null } : null;
  };
  // What the finished reply carries on live v2 message.new: its reasoning and the tools it ran (same shape as history, clipped there).
  const REASONING_KEEP = 64 * 1024 + 4;
  const collect = (r, text, a) => {
    for (const line of text.split('\n')) if (line.startsWith('data:') && line.length > 8) { try { const rc = JSON.parse(line.slice(5))?.choices?.[0]?.delta?.reasoning_content; if (typeof rc === 'string' && r.reasoning.length < REASONING_KEEP) r.reasoning += rc; } catch { /* not json */ } }
    if (!a) return;
    if (a.lifecycle) {
      r.lifecycle = true; const d = a.lifecycle;
      if (d.type === 'tool.start' && r.tools.length < MSG_TOOLS_MAX) r.tools.push({ id: a.step.tool_id, name: a.step.name, ...(d.preview ? { args: d.preview } : {}) });
      else if (d.type === 'tool.end') { const t = r.tools.find((x) => x.id && x.id === a.step.tool_id && x.ok === undefined) ?? r.tools.find((x) => x.name === a.step.name && x.ok === undefined); if (t) { if (typeof d.ok === 'boolean') t.ok = d.ok; if (d.result_preview) t.result = d.result_preview; } }
    } else if (a.cc && r.tools.length < MSG_TOOLS_MAX) r.tools.push({ name: a.step.name, ...(a.step.preview ? { args: a.step.preview } : {}) });
  };
  /** Reasoning and tools of a run, for message.new (see collect). */
  const extrasOf = (r) => ({ reasoning: r.reasoning, tools: r.tools.map(({ id, ...t }) => t) });

  function sweep() { const t = now(); for (const [id, r] of runs) if (r.done && t - r.finished > ttlMs) runs.delete(id); }
  const push = (r, text) => {
    for (const line of text.split('\n')) if (line.startsWith('data:') && line.length > 8) { try { const c = JSON.parse(line.slice(5))?.choices?.[0]?.delta?.content; if (typeof c === 'string' && r.text.length < 1_000_000) r.text += c; } catch { /* not json */ } }
    const a = activityOf(text, r); collect(r, text, a);
    const index = r.next++; r.log.push({ index, text }); r.bytes += text.length;
    while (r.bytes > maxBytes && r.log.length > 1) r.bytes -= r.log.shift().text.length;
    for (const fn of r.subs) fn();
    if (eventListeners.length && a) for (const f of eventListeners) { try { f(r, a.kind, a.tool ?? null, { label: a.label ?? null, toolId: a.toolId ?? null, step: a.step ?? null }); } catch { /* listeners are best effort */ } }
  };
  const finish = (r, state) => { if (r.done) return; r.done = true; r.state = state; r.finished = now(); clearTimeout(r.timer); try { r.onFinish?.(r, state); } catch { /* history is best effort */ } for (const f of finishListeners) { try { f(r, state); } catch { /* listeners are best effort */ } } if (state !== 'done') push(r, `event: foxfleet.run\ndata: ${JSON.stringify({ state })}`); for (const fn of r.subs) fn(); };

  async function pump(r, body) {
    const reader = body.getReader(), dec = new TextDecoder(); let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let m; while ((m = /\r?\n\r?\n/.exec(buf))) { const ev = buf.slice(0, m.index); buf = buf.slice(m.index + m[0].length); if (ev.trim()) push(r, ev.replace(/\r\n/g, '\n')); }
      }
      if (buf.trim()) push(r, buf.replace(/\r\n/g, '\n'));
      finish(r, r.link?.terminal === 'stopped' ? 'stopped' : r.link?.terminal === 'failed' ? 'error' : 'done');
    } catch { finish(r, r.abort.signal.aborted && r.stopped ? 'stopped' : 'error'); }
  }

  return {
    /** Opens the upstream stream (errors before any byte is sent propagate as normal HTTP errors) and returns the run. */
    async start({ scope, agent, session, open, timeoutMs, check, onFinish, link }) {
      sweep();
      if ([...runs.values()].filter((r) => r.scope === scope && !r.done).length >= maxActive) throw fault(429, 'Too many chats running at once; wait for one to finish or stop it');
      const abort = new AbortController(), opener = setTimeout(() => abort.abort(), timeoutMs); opener.unref?.();
      let up;
      try { up = await open(abort.signal); } finally { clearTimeout(opener); }
      if (!up.ok || !up.body) { await up.body?.cancel(); throw fault([403, 404, 405, 409, 413, 416].includes(up.status) ? up.status : 502, 'Agent request failed'); }
      const headers = check(up);
      const r = { id: randomBytes(9).toString('base64url'), scope, agent, session: session || headers['X-Hermes-Session-Id'] || null, headers, abort, state: 'running', link: link || null, stopping: false, done: false, stopped: false, started: now(), finished: 0, log: [], text: '', reasoning: '', tools: [], lifecycle: false, onFinish, next: 1, bytes: 0, subs: new Set() };
      r.timer = setTimeout(() => { abort.abort(); }, maxRunMs); r.timer.unref?.();
      runs.set(r.id, r); for (const f of startListeners) { try { f(r); } catch { /* listeners are best effort */ } } void pump(r, link || !/text\/event-stream/.test(up.headers?.get?.('content-type') ?? '') ? up.body : normaliseSse(up.body)); return r;
    },
    /** Called for every run that ends (any agent, any user): the agent list's last-activity line uses it. */
    onFinish(fn) { finishListeners.push(fn); },
    /** Called for every upstream event that shows what the agent is doing: fn(run, 'typing' | 'thinking' | 'tool' | null, toolName | null, { label, toolId, step }). */
    onEvent(fn) { eventListeners.push(fn); },
    /** The reasoning and tools a run produced so far: { reasoning, tools: [{ name, args?, result?, ok? }] } (unclipped; ledger clips). */
    extras: extrasOf,
    /** Called for every run that starts (after the agent accepted it): live chat events use it. */
    onStart(fn) { startListeners.push(fn); },
    /** Is a reply running for this user and agent right now? */
    working(scope, agent) { for (const r of runs.values()) if (r.scope === scope && r.agent === agent && !r.done) return true; return false; },
    /** Reply text of this user's runs for an agent (running or just finished): lets the media hub know about a tag the moment it is written. */
    texts(scope, agent) { sweep(); return [...runs.values()].filter((r) => r.scope === scope && r.agent === agent).map((r) => r.text).filter(Boolean); },
    get(scope, agent, id) { sweep(); const r = runs.get(id); if (!r || r.scope !== scope || r.agent !== agent) throw fault(404, 'That run is gone (finished runs are kept for a few minutes)'); return r; },
    list(scope, agent, session) { sweep(); return [...runs.values()].filter((r) => r.scope === scope && r.agent === agent && (!session || r.session === session)).map((r) => this.view(r)); },
    view: (r) => ({ id: r.id, session_id: r.session, state: r.done ? r.state : r.stopping ? 'stopping' : 'running', started: r.started, events: r.next - 1, ...(r.link?.runId ? { native: true } : {}) }),
    stop(r) { if (!r.done) { r.stopped = true; r.abort.abort(); } },
    /**
     * Explicit Stop that reports the truth: resolves true only once the run has really ended.
     * Native runs ask the agent to stop (link.stop) and wait for its terminal event ("stopping" meanwhile); other runs abort the
     * transport. A failed or unconfirmed stop returns false and the run keeps going: callers must not start a second writer.
     */
    async stopAndWait(r, waitMs = 15_000) {
      if (r.done) return true;
      const wait = () => new Promise((res) => { const t = setTimeout(() => { r.subs.delete(check); res(); }, waitMs); const check = () => { if (r.done) { clearTimeout(t); r.subs.delete(check); res(); } }; r.subs.add(check); check(); });
      if (r.link?.stop) {
        r.stopping = true;
        try { await r.link.stop(); } catch { r.stopping = false; return false; }
        await wait(); if (!r.done) r.stopping = false; return r.done;
      }
      r.stopping = true; r.stopped = true; r.abort.abort(); await wait(); if (!r.done) { r.stopping = false; r.stopped = false; } return r.done;
    },
    /** Streams the run's events after cursor `after` to the client and follows it live. Client disconnect only detaches. */
    attach(req, res, r, after = 0) {
      res.writeHead(200, { ...SSE_HEADERS, ...r.headers, 'X-Foxfleet-Run': r.id });
      res.write(`retry: ${RETRY_MS}\n\n`); // clients that reconnect on their own wait this long (ms); the first byte also defeats proxy buffering
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
