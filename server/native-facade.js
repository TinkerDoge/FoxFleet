// Makes a native-capable Hermes agent look like every other agent to the existing clients: POST /chat and /messages start or feed a native
// session, GET /queue reports what Hermes holds, and the reply is followed through the usual resumable run (/runs/{id}/events, /stop).
// The run is a view of the native session: it is created when a turn starts (also for turns Hermes schedules itself) and it ends with the turn.
// Native-only data rides on extra SSE events: foxfleet.request / foxfleet.request_closed (approvals, questions) and foxfleet.ack.
import { fault } from './config.js';

const enc = new TextEncoder();
const frame = (obj, event) => enc.encode(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(obj)}\n\n`);
const MODE_IN = { queue: 'queue', steer: 'steer', interrupt: 'interrupt', auto: 'auto' };

export function toFrames(e) {
  switch (e.type) {
    case 'message.delta': return [frame({ choices: [{ delta: { content: e.text } }] })];
    case 'reasoning': return [frame({ choices: [{ delta: { reasoning_content: e.text } }] })];
    case 'tool.start': case 'tool.progress': return [frame({ tool: e.name }, 'hermes.tool.progress')];
    case 'request.open': return [frame(e, 'foxfleet.request')];
    case 'request.cancel': return [frame({ request_id: e.request_id, reason: e.reason || 'cancelled' }, 'foxfleet.request_closed')];
    case 'request.answered': return [frame({ request_id: e.request_id, reason: 'answered' }, 'foxfleet.request_closed')];
    case 'ack': return [frame({ message_id: e.message_id, ack: e.ack }, 'foxfleet.ack')];
    default: return [];
  }
}

export function nativeFacade({ runs }) {
  const active = new Map(); // `${scope}\0${agent}\0${stored}` -> run
  const meta = new Map();   // nat session key -> { m, scope }
  const akey = (scope, agent, stored) => `${scope}\0${agent}\0${stored}`;

  const starting = new Map(), began = new Map(); // began: how many runs were opened per session, so a turn that started and ended while a send was in flight is not opened twice
  function startRun(nat, { scope, m, stored, from }) {
    const k = akey(scope, m.name, stored), cur = active.get(k); if (cur && !cur.done) return Promise.resolve(cur); if (starting.has(k)) return starting.get(k);
    began.set(k, (began.get(k) ?? 0) + 1);
    const link = { runId: 'native', sessionId: stored, stop: async () => { await nat.interrupt(scope, m.machineId, m.profile, stored); } };
    let unsub = () => {}, closed = false;
    const open = async () => {
      let ctl; const body = new ReadableStream({ start(c) { ctl = c; }, cancel() { unsub(); } });
      const end = (state, error) => { if (closed) return; closed = true; link.terminal = state; if (error) link.error = error; ctl.enqueue(frame({ state, ...(error ? { error } : {}) }, 'foxfleet.upstream')); ctl.enqueue(enc.encode('data: [DONE]\n\n')); ctl.close(); unsub(); };
      const handle = (e) => {
        if (closed) return;
        if (e.type === 'turn.end') { return end(e.status === 'interrupted' ? 'stopped' : e.status === 'failed' ? 'failed' : 'completed', e.status === 'failed' ? 'The agent turn failed' : undefined); }
        if (e.type === 'owner.down') return end('failed', 'The Hermes process on the machine stopped');
        for (const f of toFrames(e)) ctl.enqueue(f);
      };
      const f = nat.follow(scope, m.machineId, m.profile, stored, from, handle); unsub = f.unsubscribe; for (const e of f.events) handle(e);
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream', 'X-Hermes-Session-Id': stored } });
    };
    const p = runs.start({ scope, agent: m.name, session: stored, open, timeoutMs: 30_000, link, check: () => ({ 'X-Hermes-Session-Id': stored }) }).then((r) => { active.set(k, r); return r; }).finally(() => starting.delete(k)); starting.set(k, p); return p;
  }
  const activeRun = (scope, agent, stored) => { const r = active.get(akey(scope, agent, stored)); return r && !r.done ? r : null; };

  return {
    attachHooks(nat) { // turns Hermes starts by itself (its own queue) still get a run clients can follow
      nat.onTurnStart((s, e) => { const mm = meta.get(s.k); if (mm && !activeRun(mm.scope, mm.m.name, s.stored)) void startRun(nat, { scope: mm.scope, m: mm.m, stored: s.stored, from: e.seq - 1 }).catch(() => {}); });
    },
    remember(nat, scope, m, stored) { meta.set(`${m.machineId}\0${m.profile}\0${stored}`, { m, scope }); },
    async session(nat, scope, m, wanted) {
      const stored = /^[\w.:-]{1,120}$/.test(wanted ?? '') ? wanted : (await nat.create(scope, m.machineId, m.profile)).session_id;
      this.remember(nat, scope, m, stored); return stored;
    },
    /** Send; if this started a turn, follow it as a run. */
    async send(nat, { scope, m, session, text, mode, clientId, idleOnly }) {
      const stored = await this.session(nat, scope, m, session), m0 = MODE_IN[mode] ?? 'auto';
      if (!nat.isRunning(m.machineId, m.profile, stored) && session) await nat.attach(scope, m.machineId, m.profile, stored); // learn the real state of a session we have not seen yet
      if (idleOnly && nat.isRunning(m.machineId, m.profile, stored)) throw fault(409, 'The agent is already replying; send with /messages to queue, steer or interrupt');
      const bk = akey(scope, m.name, stored), b0 = began.get(bk) ?? 0, from = nat.cursor(m.machineId, m.profile, stored), r = await nat.send(scope, m.machineId, m.profile, stored, { text, mode: m0, clientId });
      let run = activeRun(scope, m.name, stored);
      if (!run && starting.has(akey(scope, m.name, stored))) run = await starting.get(akey(scope, m.name, stored));
      if (!run && (began.get(bk) ?? 0) > b0) run = active.get(bk) ?? null; // the turn began and already ended while the ack was on its way: that run is the answer
      if (!run && r.message.ack === 'streaming') run = await startRun(nat, { scope, m, stored, from });
      return { ...r, stored, run };
    },
    async queue(nat, { scope, m, session }) {
      if (!/^[\w.:-]{1,120}$/.test(session ?? '')) return { items: [], recent: [], halted: false, active_run: null, modes: ['queue', 'steer', 'interrupt'], open_requests: [] };
      this.remember(nat, scope, m, session);
      const p = await nat.pending(scope, m.machineId, m.profile, session); let run = activeRun(scope, m.name, session);
      if (!run && p.running) run = await startRun(nat, { scope, m, stored: session, from: nat.cursor(m.machineId, m.profile, session) }).catch(() => null); // a turn already in flight: follow it from now
      return { items: p.items.map(viewOf), recent: [], halted: false, active_run: run?.id ?? null, modes: ['queue', 'steer', 'interrupt'], open_requests: p.open_requests, can_cancel: false };
    },
    activeRun,
  };
}
// The journal's own states, shown to clients as the queue states they already render, with Hermes's acknowledgement attached.
export const viewOf = (m) => ({ id: m.id, state: m.state === 'sending' ? 'sending' : m.state === 'uncertain' ? 'uncertain' : m.state === 'rejected' ? 'rejected' : m.state === 'failed' ? 'failed' : m.mode === 'steer' || m.ack === 'steered' || m.ack === 'redirected' ? 'guidance_accepted' : 'queued', mode: m.mode === 'auto' ? 'queue' : m.mode, text: m.text, created: m.created, ack: m.ack ?? null, session_id: m.session_id ?? m.session, ...(m.note ? { note: m.note } : {}), ...(m.error ? { error: m.error } : {}) });
