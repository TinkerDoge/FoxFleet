// Hub adapter for Hermes's native UI gateway (reached through the machine connector, see ../design/notes/hermes-ui-gateway.md).
// Hermes owns turn scheduling for these sessions: the hub does NOT keep a queue for them. The hub's job is
//  - ownership: a stored session belongs to the first account that created/attached it; another account is refused before any attach;
//  - admission journal: every message gets a hub id and is written down (state `sending`) BEFORE it is sent upstream, then the
//    upstream acknowledgement is recorded as received (`streaming|queued|steered|redirected|rejected`), never predicted;
//  - reconcile: after a lost ack, a gateway restart or a reconnect, uncertain messages are checked against the snapshot and left visible
//    as `uncertain` when that proves nothing. They are never resent automatically (no exactly-once promise);
//  - one versioned event stream (`foxfleet.native/1`) per session with distinct session / turn / message / tool / request ids, a bounded
//    replay log with a hub cursor, and any number of viewers: a viewer leaving never cancels anything.
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { fault } from './config.js';

export const CONTRACT = 'foxfleet.native/1';
const LOG_MAX = 500, MAX_VIEWERS = 32, KEEP_JOURNAL = 500;
const id = (p) => `${p}_${randomBytes(9).toString('base64url')}`;
export const MODES = ['auto', 'queue', 'steer', 'interrupt'];

// Upstream event -> versioned FoxFleet event (or null to drop). `s` is the session state (turn id, tool names).
export function normalise(up, s) {
  const p = up.payload ?? {}, base = { v: 1, session_id: s.stored };
  switch (up.type) {
    case 'message.start': s.turn = id('t'); s.running = true; s.partial = ''; return { ...base, type: 'turn.start', turn_id: s.turn };
    case 'message.delta': s.partial += String(p.text ?? ''); return { ...base, type: 'message.delta', turn_id: s.turn, text: String(p.text ?? '') };
    case 'thinking.delta': case 'reasoning.available': return String(p.text ?? '').trim() && up.type === 'reasoning.available' ? { ...base, type: 'reasoning', turn_id: s.turn, text: String(p.text).slice(0, 20_000) } : null;
    case 'message.complete': { s.running = false; const status = String(p.status ?? 'complete'); return { ...base, type: 'turn.end', turn_id: s.turn, status: /interrupt/.test(status) ? 'interrupted' : /error|fail/.test(status) ? 'failed' : 'complete', text: String(p.text ?? s.partial) }; }
    case 'tool.generating': return { ...base, type: 'tool.progress', turn_id: s.turn, name: String(p.name ?? 'tool').slice(0, 80) };
    case 'tool.start': return { ...base, type: 'tool.start', turn_id: s.turn, tool_id: String(p.tool_id ?? ''), name: String(p.name ?? 'tool').slice(0, 80) };
    case 'tool.progress': return { ...base, type: 'tool.progress', turn_id: s.turn, tool_id: String(p.tool_id ?? ''), name: String(p.name ?? 'tool').slice(0, 80) };
    case 'tool.complete': return { ...base, type: 'tool.end', turn_id: s.turn, tool_id: String(p.tool_id ?? ''), name: String(p.name ?? 'tool').slice(0, 80), ...(typeof p.duration_s === 'number' ? { duration_s: p.duration_s } : {}) };
    case 'request.cancel': return { ...base, type: 'request.cancel', request_id: String(p.id ?? ''), reason: String(p.reason ?? '') };
    case 'status.update': return p.text ? { ...base, type: 'status', level: String(p.kind ?? 'info'), text: String(p.text).slice(0, 300) } : null;
    case 'session.title': return p.title ? { ...base, type: 'session.title', title: String(p.title).slice(0, 300) } : null;
    default: return null;
  }
}
const requestView = (r) => ({ request_id: r.id, kind: r.method, ...(r.method === 'clarify' ? { questions: (r.params?.questions ?? []).map((q) => ({ id: q.qid ?? q.id, question: String(q.question ?? '').slice(0, 2000), choices: Array.isArray(q.choices) ? q.choices.map(String).slice(0, 50) : [], multi_select: q.multi_select === true })) } : { command: String(r.params?.command ?? '').slice(0, 2000), description: String(r.params?.description ?? '').slice(0, 2000) }) });

export async function nativeHub({ connectors, file, now = () => Date.now() }) {
  let journal = { messages: [], owners: {} };
  try { const raw = JSON.parse(await readFile(file, 'utf8')); journal = { messages: Array.isArray(raw.messages) ? raw.messages : [], owners: raw.owners && typeof raw.owners === 'object' ? raw.owners : {} }; } catch { /* first run */ }
  for (const m of journal.messages) if (m.state === 'sending') m.state = 'uncertain'; // the hub restarted between "write down" and "acknowledged"
  let writing = Promise.resolve();
  const save = () => { journal.messages = journal.messages.slice(-KEEP_JOURNAL); const snap = JSON.stringify(journal), tmp = file + '.tmp'; writing = writing.then(() => writeFile(tmp, snap, { mode: 0o600 }).then(() => rename(tmp, file))).catch(() => {}); return writing; };
  const hooks = [];
  const sessions = new Map(), subscribed = new WeakSet(), byMachine = new Map(); // key -> state; machine -> Set(keys)
  const key = (machineId, agent, stored) => `${machineId}\0${agent}\0${stored}`;

  function st(machineId, agent, stored, scope) {
    const k = key(machineId, agent, stored); let s = sessions.get(k);
    if (!s) { s = { k, machineId, agent, stored, scope, runtime: null, epoch: null, running: false, partial: '', turn: null, up: 0, log: [], next: 1, viewers: new Set(), requests: new Map(), queued: [] }; sessions.set(k, s); (byMachine.get(machineId) ?? byMachine.set(machineId, new Set()).get(machineId)).add(k); }
    return s;
  }
  function publish(s, ev) { const e = { ...ev, seq: s.next++, at: now() }; s.log.push(e); if (s.log.length > LOG_MAX) s.log.splice(0, s.log.length - LOG_MAX); for (const v of s.viewers) { try { v(e); } catch { /* a dead viewer must not stop the others */ } } if (e.type === 'turn.start') for (const h of hooks) { try { h(s, e); } catch { /* hooks are best effort */ } } return e; }
  function onUpstream(machineId, agent, up) {
    const set = byMachine.get(machineId) ?? new Set();
    if (up.kind === 'link.down') { for (const k of set) { const s = sessions.get(k); if (s) publish(s, { v: 1, session_id: s.stored, type: 'link', state: 'down' }); } return; }
    if (up.kind === 'gateway.down') { for (const k of set) { const s = sessions.get(k); if (!s || s.agent !== agent) continue; s.running = false; s.runtime = null; s.requests.clear(); for (const m of journal.messages) if (m.session === s.stored && m.agent === agent && ['sending', 'acked'].includes(m.state) && !m.settled) { m.state = 'uncertain'; m.note = 'The Hermes process on the machine stopped; check the transcript before resending'; } publish(s, { v: 1, session_id: s.stored, type: 'owner.down', code: up.code ?? null }); } void save(); return; }
    if (up.kind === 'gateway.ready') { for (const k of set) { const s = sessions.get(k); if (s && s.agent === agent) { s.epoch = up.epoch ?? null; s.up = 0; } } return; }
    if (up.kind === 'request') { const s = [...set].map((k) => sessions.get(k)).find((x) => x && x.agent === agent && x.runtime && x.runtime === up.params?.session_id); if (!s) return; s.requests.set(up.id, up); publish(s, { v: 1, session_id: s.stored, type: 'request.open', ...requestView(up) }); return; }
    if (up.kind !== 'event' || !up.session_id) return;
    const s = [...set].map((k) => sessions.get(k)).find((x) => x && x.agent === agent && x.runtime === up.session_id); if (!s) return;
    if (Number.isInteger(up.seq)) { if (up.seq <= s.up) return; s.up = up.seq; } // duplicate (live + backfill)
    if (up.type === 'request.cancel') s.requests.delete(up.payload?.id);
    const e = normalise(up, s); if (!e) return;
    if (e.type === 'turn.end') { for (const m of journal.messages) if (m.session === s.stored && m.agent === agent && m.state === 'acked' && !m.settled && (m.ack === 'streaming' || m.ack === 'steered' || m.ack === 'redirected' || (m.mode === 'steer' && m.ack === 'queued'))) m.settled = true; void save(); }
    publish(s, e);
  }
  function ensureSub(machineId) {
    const ui = connectors.ui(machineId); if (!ui) throw fault(503, 'The machine is offline');
    if (!subscribed.has(ui)) { subscribed.add(ui); ui.subscribe((agent, ev) => onUpstream(machineId, agent, ev)); }
    return ui;
  }
  const own = (scope, stored) => { const o = journal.owners[stored]; if (o && o !== scope) throw fault(404, 'Session not found'); };
  const snapshotView = (s, r) => ({ v: 1, contract: CONTRACT, session_id: s.stored, running: Boolean(r?.running), turn_id: s.turn, inflight: r?.inflight ? { user: String(r.inflight.user ?? ''), assistant: String(r.inflight.assistant ?? ''), streaming: r.inflight.streaming !== false, corrections: (r.inflight.corrections ?? []).map(String) } : null, queued: [r?.queued?.user, ...(r?.queued_prompts ?? []).map((x) => x?.user ?? x)].filter(Boolean).map(String), open_requests: (r?.open_requests ?? []).map(requestView), messages: (r?.messages ?? []).slice(-200), cursor: s.next - 1, epoch: s.epoch });

  // Reconcile uncertain/unacked messages of one session against what Hermes reports.
  function reconcile(s, snap) {
    const seen = new Set([snap?.inflight?.user, snap?.queued?.user, ...(snap?.queued_prompts ?? []).map((x) => x?.user ?? x), ...(snap?.messages ?? []).filter((m) => m?.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : m.text))].filter(Boolean));
    for (const m of journal.messages) if (m.session === s.stored && m.agent === s.agent && ['sending', 'uncertain'].includes(m.state)) { if (seen.has(m.text)) { m.state = 'acked'; m.ack = m.ack || 'reconciled'; delete m.note; } else m.note = m.note || 'Not found in the transcript; it may not have been delivered. Send it again if you still want it'; }
  }

  return {
    CONTRACT,
    onTurnStart: (fn) => { hooks.push(fn); },
    cursor: (machineId, agent, stored) => (sessions.get(key(machineId, agent, stored))?.next ?? 1) - 1,
    isRunning: (machineId, agent, stored) => Boolean(sessions.get(key(machineId, agent, stored))?.running),
    // What the queue panel shows: journal items Hermes still holds, from the live snapshot (Hermes schedules them; the hub never drains).
    async pending(scope, machineId, agent, stored) {
      const snap = await this.attach(scope, machineId, agent, stored); let changed = false;
      // Hermes reports only the head of its queue and pops it first-in-first-out: everything admitted before the head has been delivered;
      // with no head the whole queue is empty. A head we do not recognise settles nothing (it may be edited text).
      const held = journal.messages.filter((m) => m.session === stored && m.agent === agent && m.state === 'acked' && m.ack === 'queued' && m.mode !== 'steer' && !m.settled);
      const head = snap.queued[0], at = head === undefined ? held.length : held.findIndex((m) => m.text === head);
      if (at > 0) for (const m of held.slice(0, at)) { m.settled = true; changed = true; }
      if (changed) await save();
      const items = journal.messages.filter((m) => m.scope === scope && m.agent === agent && m.session === stored && !m.settled && ['sending', 'acked', 'uncertain', 'rejected', 'failed'].includes(m.state) && !(m.state === 'acked' && m.ack === 'streaming') && !(['rejected', 'failed'].includes(m.state) && now() - m.created > 300_000)).slice(-30).map(msgView);
      return { items, open_requests: snap.open_requests, running: snap.running, snapshot: snap };
    },
    async busy(scope, machineId, agent, mode) { const ui = ensureSub(machineId); const r = await ui.call(agent, 'busy', { mode }); return { mode: String(r.value ?? '') }; },
    available: (machineId, agent) => Boolean(machineId && connectors.ui(machineId)?.caps(agent)?.native),
    capabilities: (machineId, agent) => { const c = connectors.ui(machineId)?.caps(agent); return c?.native ? { native: true, protocol: c.protocol, modes: ['auto', 'queue', 'steer', 'interrupt'], contract: CONTRACT } : { native: false }; },
    async create(scope, machineId, agent) { const ui = ensureSub(machineId); const r = await ui.call(agent, 'create', {}); const s = st(machineId, agent, r.stored_session_id, scope); s.runtime = r.session_id; journal.owners[r.stored_session_id] = scope; await save(); return { session_id: r.stored_session_id, cursor: s.next - 1 }; },
    // Attach (never starts another agent): reuse the live owner, restore partial answer + queue + open requests from the snapshot, backfill missed events.
    async attach(scope, machineId, agent, stored) {
      own(scope, stored); const ui = ensureSub(machineId), s = st(machineId, agent, stored, scope);
      const r = await ui.call(agent, 'attach', { stored_session_id: stored });
      journal.owners[stored] ??= scope; const hadRuntime = s.runtime === r.session_id; s.runtime = r.session_id; s.running = Boolean(r.running);
      s.requests = new Map((r.open_requests ?? []).map((q) => [q.id, q]));
      if (hadRuntime && s.up > 0) { try { const since = await ui.call(agent, 'events.since', { session_id: r.session_id, last_seen: s.up }); if (since.epoch && s.epoch && since.epoch !== s.epoch) s.up = 0; for (const e of since.events ?? []) onUpstream(machineId, agent, { kind: 'event', ...e }); s.epoch = since.epoch ?? s.epoch; } catch { /* snapshot below is authoritative */ } }
      else { try { const since = await ui.call(agent, 'events.since', { session_id: r.session_id, last_seen: 0 }); s.up = Math.max(s.up, since.latest_seq ?? 0); s.epoch = since.epoch ?? s.epoch; } catch { /* optional */ } }
      reconcile(s, r); await save(); return snapshotView(s, r);
    },
    // Admission: journal first, then upstream, then record what Hermes actually said.
    async send(scope, machineId, agent, stored, { text, mode = 'auto', clientId }) {
      own(scope, stored); if (!MODES.includes(mode)) throw fault(400, 'That send mode is not available for this agent');
      if (typeof text !== 'string' || !text.trim()) throw fault(400, 'Empty message'); if (text.length > 100_000) throw fault(413, 'Message too long');
      const dup = clientId && journal.messages.find((m) => m.client === clientId && m.agent === agent && m.session === stored); if (dup) return { message: msgView(dup), duplicate: true };
      const ui = ensureSub(machineId), s = st(machineId, agent, stored, scope); if (!s.runtime) await this.attach(scope, machineId, agent, stored);
      const m = { id: id('m'), agent, session: stored, scope, text, mode, state: 'sending', ack: null, created: now(), ...(clientId ? { client: clientId } : {}) }; journal.messages.push(m); await save();
      const rt = s.runtime; let r;
      try {
        if (mode === 'queue') r = await ui.call(agent, 'submit', { session_id: rt, text, queued: true });
        else if (mode === 'steer') { r = await ui.call(agent, 'steer', { session_id: rt, text }); if (r.status === 'rejected') r = await ui.call(agent, 'submit', { session_id: rt, text }); } // idle: Hermes says rejected so the client sends it as a normal turn
        else if (mode === 'interrupt') { r = await ui.call(agent, 'redirect', { session_id: rt, text }); if (r.status === 'rejected') { m.state = 'rejected'; m.ack = 'rejected'; m.note = 'This agent cannot redirect the running turn right now. Use Queue, Steer, or Stop and send again'; await save(); return { message: msgView(m) }; } }
        else r = await ui.call(agent, 'submit', { session_id: rt, text });
      } catch (e) { m.state = e.code === 'timeout' || e.code === 'disconnected' || e.code === 'gateway_down' ? 'uncertain' : 'failed'; m.error = e.safe ? e.message : String(e.message).slice(0, 200); m.note = m.state === 'uncertain' ? 'The answer from Hermes did not arrive. Check the transcript before resending' : undefined; await save(); throw e.code === 'upstream' ? fault(502, 'Hermes refused the message') : e; }
      m.ack = String(r.status ?? 'streaming'); m.state = m.ack === 'rejected' ? 'rejected' : 'acked';
      if (m.state === 'acked' && s.runtime !== rt) { m.state = 'uncertain'; m.note = 'The Hermes process on the machine restarted while this was being delivered; check the transcript before resending'; } // a late answer from a gateway that has since gone down: Hermes did answer, but the turn may be lost. Never resent. if (r.user_row_id !== undefined) m.upstream = { user_row_id: r.user_row_id };
      await save(); publish(s, { v: 1, session_id: stored, type: 'ack', message_id: m.id, ack: m.ack });
      return { message: msgView(m) };
    },
    async interrupt(scope, machineId, agent, stored) { own(scope, stored); const ui = ensureSub(machineId), s = st(machineId, agent, stored, scope); if (!s.runtime) await this.attach(scope, machineId, agent, stored); return ui.call(agent, 'interrupt', { session_id: s.runtime }); },
    async setModel(scope, machineId, agent, stored, value) { own(scope, stored); const ui = ensureSub(machineId), s = st(machineId, agent, stored, scope); if (!s.runtime) await this.attach(scope, machineId, agent, stored); const r = await ui.call(agent, 'setmodel', { value, session_id: s.runtime }); return { model: String(r.value ?? value), scope: r.scope ?? 'session', ...(r.warning ? { warning: String(r.warning).slice(0, 300) } : {}), ...(r.confirm_required ? { confirm_required: true, confirm_message: String(r.confirm_message ?? '').slice(0, 300) } : {}) }; },
    // Answer a server request once, by id, for a session the account owns.
    async respond(scope, machineId, agent, stored, requestId, { result, error }) {
      own(scope, stored); const s = st(machineId, agent, stored, scope), q = s.requests.get(requestId); if (!q) throw fault(404, 'That question is no longer open');
      s.requests.delete(requestId); const ui = ensureSub(machineId);
      try { await ui.call(agent, 'respond', { id: requestId, ...(error ? { error: String(error).slice(0, 200) } : { result: result && typeof result === 'object' ? result : {} }) }); } catch (e) { if (e.code === 'gone') throw fault(404, 'That question is no longer open'); s.requests.set(requestId, q); throw e; }
      publish(s, { v: 1, session_id: stored, type: 'request.answered', request_id: requestId }); return { ok: true };
    },
    ui: (machineId) => ensureSub(machineId),
    /** Runtime session id for a stored chat, when this hub has attached it. Empty until then. */
    runtimeOf: (machineId, agent, stored) => sessions.get(key(machineId, agent, stored))?.runtime || '',
    // Follow the session: replay from a hub cursor, then live. Returns { events, truncated, unsubscribe }.
    follow(scope, machineId, agent, stored, after, push) {
      own(scope, stored); const s = st(machineId, agent, stored, scope); if (s.viewers.size >= MAX_VIEWERS) throw fault(429, 'Too many viewers');
      const first = s.log[0]?.seq ?? s.next, truncated = after > 0 && after + 1 < first, missed = s.log.filter((e) => e.seq > after);
      s.viewers.add(push); return { events: missed, truncated, cursor: s.next - 1, unsubscribe: () => s.viewers.delete(push) };
    },
    list: (scope, agent, stored) => journal.messages.filter((m) => m.scope === scope && m.agent === agent && m.session === stored).slice(-50).map(msgView),
    reconcileFor: (scope, agent, stored, snapshot) => { own(scope, stored); const s = [...sessions.values()].find((x) => x.agent === agent && x.stored === stored); if (s) reconcile(s, snapshot); },
    async flush() { await save(); await writing; },
    _journal: () => journal,
  };
}
const msgView = (m) => ({ id: m.id, session_id: m.session, mode: m.mode, state: m.state, ack: m.ack, text: m.text, created: m.created, ...(m.note ? { note: m.note } : {}), ...(m.error ? { error: m.error } : {}) });
