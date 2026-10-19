// Durable room dispatch (Task 3).
//
// A dispatch is one agent turn in one room. Its record lives in the room JSON (fd_ ids) and moves through
// queued -> offered -> accepted -> running -> completed, with waiting_approval, cancelled, failed and
// uncertain as the other durable states. Decisions are written before anything is acknowledged:
//   - a human request stores its message first, then the routing decision reserves one dispatch per target;
//   - a structured handoff creates its child message and child dispatch in one room mutation;
//   - execution is claimed (offered) and re-admitted inside the room mutation, then the agent is called
//     outside every room write lock.
//
// One agent turn per room: offered/accepted/running/waiting_approval block the room's queue. Queued turns
// drain in stable agent-id order. The root budget (4 dispatches, 5 minutes) is reserved atomically inside
// the same room mutation that creates a dispatch; refusals are durable failed rows plus a visible hub
// status message, never silence.
//
// Delivery is deliberately an interface, not a socket: `engine.register(agentId, target)` where target is
// `{ online?, offer?(ctx), run?(ctx) }`. Task 4 supplies the real bot-socket implementation. If the process
// dies while a turn is offered/accepted/running, recover() marks it uncertain and only an explicit human
// retry() re-executes it.
import { randomBytes } from 'node:crypto';
import { fault } from './config.js';
import { routeRoomMessage } from './conversation-routing.js';

export const DISPATCH_LIMITS = Object.freeze({
  max_handoff_dispatches_per_root: 4,
  handoff_chain_ttl_ms: 300_000,
});

const AGENT_REF = /^agent:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HUMAN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACTIVE_STATES = new Set(['offered', 'accepted', 'running', 'waiting_approval']);
const TERMINAL_STATES = new Set(['completed', 'cancelled', 'failed', 'uncertain']);
const MAX_MESSAGES = 5000, MAX_OUTBOX = 1000;
const newId = (prefix) => prefix + randomBytes(12).toString('base64url');

const notFound = () => fault(404, 'Handoff source is not a current agent message in this room', 'handoff_not_found');
const forbidden = () => fault(403, 'Agent is not an active member of this room', 'actor_forbidden');
const selfHandoff = () => fault(409, 'An agent cannot hand off to itself', 'handoff_self');

const agentRef = (value) => {
  if (typeof value !== 'string') return null;
  const id = value.startsWith('agent:') ? value : 'agent:' + value;
  return AGENT_REF.test(id) ? id : null;
};
const activeAgent = (d, id) => d.members.find((m) => m.actor_kind === 'agent' && m.actor_id === id && m.role === 'member' && m.removed_at === null) ?? null;
const ensure = (d) => { if (!Array.isArray(d.dispatches)) d.dispatches = []; };
const clone = (value) => structuredClone(value);
const byQueue = (a, b) => (a.target_agent_id < b.target_agent_id ? -1 : a.target_agent_id > b.target_agent_id ? 1 : (a.created_at - b.created_at) || (a.id < b.id ? -1 : 1));

function pushOutbox(d, entry) {
  d.outbox.push(entry);
  if (d.outbox.length > MAX_OUTBOX) d.outbox.splice(0, d.outbox.length - MAX_OUTBOX);
}
function trimMessages(d) {
  while (d.messages.length > MAX_MESSAGES) d.messages.shift();
}

/**
 * A hub delivery notice: visible in the room, marked `system` so routing/answer counts ignore it. It keeps
 * the frozen sender shape (kind human|agent), so it is attributed to the target agent it concerns.
 */
function addNotice(d, dispatch, text, at, code) {
  const prior = d.messages.find((m) => m.system && m.dispatch_id === dispatch?.id);
  if (prior) return prior;
  const target = dispatch?.target_agent_id ?? null;
  const member = target ? (activeAgent(d, target) ?? [...d.members].reverse().find((m) => m.actor_kind === 'agent' && m.actor_id === target)) : null;
  const seq = d.next_seq++;
  const message = {
    id: newId('fm_'), seq, author_kind: target ? 'agent' : 'human', author_id: target ?? d.owner_id,
    author_name: member?.name ?? (target ?? d.owner_name),
    body: text, format: 'text', mentions: [], reply_to: null, created_at: at, revision: 1, deleted_at: null,
    root_id: dispatch?.root_id ?? null, dispatch_id: dispatch?.id ?? null, delivery_state: 'failed',
    system: true, code: code ?? null, client_id: null, client_fp: null,
  };
  d.messages.push(message); trimMessages(d);
  d.updated_at = at;
  pushOutbox(d, { type: 'message.new', message_id: message.id, seq, at });
  return message;
}

function addAgentMessage(d, dispatch, body, deliveryState, at) {
  const member = activeAgent(d, dispatch.target_agent_id);
  if (!member) throw forbidden();
  const seq = d.next_seq++;
  const message = {
    id: newId('fm_'), seq, author_kind: 'agent', author_id: member.actor_id, author_name: member.name,
    body, format: 'text', mentions: [], reply_to: null, created_at: at, revision: 1, deleted_at: null,
    root_id: dispatch.root_id, dispatch_id: dispatch.id, delivery_state: deliveryState,
    client_id: null, client_fp: null,
  };
  d.messages.push(message); trimMessages(d);
  d.updated_at = at;
  pushOutbox(d, { type: 'message.new', message_id: message.id, seq, at });
  return message;
}

function admissionReason(d, row, nowMs) {
  if (row.state !== 'queued') return null;
  if (nowMs >= row.root_deadline) return { code: 'handoff_expired', text: 'The handoff chain deadline passed before this turn could start.' };
  const member = activeAgent(d, row.target_agent_id);
  if (!member) return { code: 'actor_forbidden', text: 'The agent is no longer an active member of this room.' };
  if (member.generation !== row.membership_generation) return { code: 'membership_changed', text: 'The agent left and rejoined this room; the reservation is no longer valid.' };
  if (d.epoch !== row.epoch) return { code: 'epoch_changed', text: 'The room changed; the reservation is no longer valid.' };
  return null;
}

function markFailed(d, row, code, text, at) {
  row.state = 'failed'; row.code = code ?? null; row.error = text ?? null; row.updated_at = at; row.finished_at = at;
  addNotice(d, row, text, at, code);
  return row;
}
function markUncertain(d, row, at) {
  row.state = 'uncertain'; row.code = 'uncertain_after_restart'; row.updated_at = at;
  addNotice(d, row, `Delivery to ${row.target_agent_id} is uncertain after an interruption. A human must retry; it will not run automatically.`, at, row.code);
  return row;
}

function statusText(code, target, reason) {
  if (code === 'handoff_limit') return `Handoff refused: this conversation chain has used its ${DISPATCH_LIMITS.max_handoff_dispatches_per_root} dispatches. Send a new message to continue.`;
  if (code === 'handoff_expired') return `Dispatch expired: the ${DISPATCH_LIMITS.handoff_chain_ttl_ms / 60_000}-minute handoff chain deadline passed. Send a new message to continue.`;
  if (code === 'agent_offline') return `Could not deliver to ${target}: the agent is offline.`;
  return `Could not deliver to ${target}: ${reason ?? 'the agent could not take the turn'}.`;
}

function newDispatch(d, { state, rootId, requestMessageId, sourceDispatchId, parentMessageId, target, deadline, nowMs, dedupeKey, idempotencyKey, counts }) {
  return {
    id: newId('fd_'), state, root_id: rootId, request_message_id: requestMessageId ?? null,
    source_dispatch_id: sourceDispatchId ?? null, parent_message_id: parentMessageId ?? null,
    target_agent_id: target, epoch: d.epoch, membership_generation: null, context_through_seq: d.next_seq - 1,
    root_deadline: deadline, created_at: nowMs, updated_at: nowMs, attempts: 0,
    dedupe_key: dedupeKey ?? null, idempotency_key: idempotencyKey ?? null,
    counts_toward_budget: counts !== false, code: null, error: null,
    ...(sourceDispatchId ? { handoff: true } : {}),
  };
}

/** Reserve a child message + dispatch for a structured handoff inside an existing room mutation. */
function handoffInDraft(d, { actor, sourceMessageId, targetAgentId, text, idempotencyKey, nowMs }) {
  ensure(d);
  const target = agentRef(targetAgentId);
  const actorRow = activeAgent(d, actor.id);
  if (!actorRow) throw forbidden();
  if (typeof text !== 'string' || !text.length || Buffer.byteLength(text, 'utf8') > 65536) throw fault(400, 'Invalid handoff text', 'invalid_request');
  if (target === actor.id) throw selfHandoff();

  const key = typeof idempotencyKey === 'string' && idempotencyKey ? `handoff:${idempotencyKey}` : null;
  if (key) {
    const prior = d.dispatches.find((x) => x.dedupe_key === key);
    if (prior) return { dispatch: clone(prior), message: prior.request_message_id ? clone(d.messages.find((m) => m.id === prior.request_message_id) ?? null) : null, duplicate: true };
  }
  if (!target) throw notFound();
  const targetRow = activeAgent(d, target);
  if (!targetRow) throw notFound();

  const source = d.messages.find((m) => m.id === sourceMessageId && !m.deleted_at);
  if (!source || source.system || source.author_kind !== 'agent' || source.author_id !== actor.id) throw notFound();
  const parent = d.dispatches.find((x) => x.id === source.dispatch_id);
  if (!parent || parent.target_agent_id !== actor.id || !['accepted', 'running'].includes(parent.state)) throw notFound();

  // The same turn asking the same target for the same text is one handoff, even without an explicit key.
  if (!key) {
    const prior = d.dispatches.find((x) => x.handoff && x.source_dispatch_id === parent.id && x.parent_message_id === source.id
      && x.target_agent_id === target && x.counts_toward_budget !== false
      && d.messages.find((m) => m.id === x.request_message_id)?.body === text);
    if (prior) return { dispatch: clone(prior), message: clone(d.messages.find((m) => m.id === prior.request_message_id) ?? null), duplicate: true };
  }

  const rootId = parent.root_id, deadline = parent.root_deadline;
  const counted = d.dispatches.filter((x) => x.root_id === rootId && x.counts_toward_budget !== false).length;
  const refusal = nowMs >= deadline ? 'handoff_expired' : counted >= DISPATCH_LIMITS.max_handoff_dispatches_per_root ? 'handoff_limit' : null;
  if (refusal) {
    const row = newDispatch(d, {
      state: 'failed', rootId, sourceDispatchId: parent.id, parentMessageId: source.id, target, deadline, nowMs,
      dedupeKey: key, idempotencyKey: idempotencyKey ?? null, counts: false,
    });
    row.code = refusal; row.error = statusText(refusal, target);
    d.dispatches.push(row);
    const notice = addNotice(d, row, statusText(refusal, target), nowMs, refusal);
    return { dispatch: clone(row), message: clone(notice), refused: true, code: refusal };
  }

  const childId = newId('fd_');
  const seq = d.next_seq++;
  const message = {
    id: newId('fm_'), seq, author_kind: 'agent', author_id: actor.id, author_name: actorRow.name,
    body: text, format: 'text', mentions: [], reply_to: source.id, created_at: nowMs, revision: 1,
    deleted_at: null, root_id: rootId, dispatch_id: childId, delivery_state: 'queued',
    client_id: null, client_fp: null,
  };
  d.messages.push(message); trimMessages(d);
  pushOutbox(d, { type: 'message.new', message_id: message.id, seq, at: nowMs });

  const row = newDispatch(d, {
    state: 'queued', rootId, requestMessageId: message.id, sourceDispatchId: parent.id, parentMessageId: source.id,
    target, deadline, nowMs, dedupeKey: key, idempotencyKey: idempotencyKey ?? null, counts: true,
  });
  row.id = childId; row.membership_generation = targetRow.generation;
  d.dispatches.push(row);
  d.updated_at = nowMs;
  return { dispatch: clone(row), message: clone(message), duplicate: false, refused: false };
}

export function createDispatchEngine({ store, now = () => Date.now(), targets = new Map() } = {}) {
  if (!store || typeof store.send !== 'function' || typeof store.transact !== 'function') throw new TypeError('A conversation store is required');
  const registry = targets instanceof Map ? targets : new Map(Object.entries(targets));
  const chains = new Map();
  let closed = false;

  const schedule = (roomId) => {
    if (closed) return Promise.resolve();
    const prior = chains.get(roomId) ?? Promise.resolve();
    const next = prior.then(() => pump(roomId)).catch(() => {});
    chains.set(roomId, next);
    return next;
  };

  async function reserveHumanMessage(roomId, message, recipients, nowMs) {
    return store.transact(roomId, (d) => {
      ensure(d);
      const out = [];
      for (const target of [...recipients].sort()) {
        const dedupeKey = `message:${message.id}:${target}`;
        const prior = d.dispatches.find((x) => x.dedupe_key === dedupeKey);
        if (prior) { out.push({ ...clone(prior), duplicate: true }); continue; }

        const rootId = message.id;
        const rootRow = d.dispatches.find((x) => x.root_id === rootId);
        const deadline = rootRow?.root_deadline ?? nowMs + DISPATCH_LIMITS.handoff_chain_ttl_ms;
        const counted = d.dispatches.filter((x) => x.root_id === rootId && x.counts_toward_budget !== false).length;
        const member = activeAgent(d, target);
        const refusal = nowMs >= deadline ? 'handoff_expired'
          : counted >= DISPATCH_LIMITS.max_handoff_dispatches_per_root ? 'handoff_limit'
            : !member ? 'actor_forbidden' : null;
        if (refusal) {
          const row = newDispatch(d, {
            state: 'failed', rootId, requestMessageId: message.id, target, deadline, nowMs,
            dedupeKey, counts: false,
          });
          row.code = refusal; row.error = statusText(refusal, target);
          d.dispatches.push(row);
          addNotice(d, row, statusText(refusal, target), nowMs, refusal);
          out.push({ ...clone(row), duplicate: false, refused: true });
          continue;
        }
        const row = newDispatch(d, {
          state: 'queued', rootId, requestMessageId: message.id, target, deadline, nowMs,
          dedupeKey, counts: true,
        });
        row.membership_generation = member.generation;
        row.context_through_seq = message.seq;
        d.dispatches.push(row);
        out.push({ ...clone(row), duplicate: false, refused: false });
      }
      return out;
    });
  }

  async function submit(roomId, { actor, text, format, mentions, reply_to, client_id } = {}) {
    if (!actor || actor.kind !== 'human' || !HUMAN_ID.test(actor.id ?? '')) throw fault(403, 'A human actor is required', 'actor_forbidden');
    const sent = await store.send(roomId, { actor, text, format, mentions, reply_to, client_id });
    const snap = await store.snapshot(roomId);
    const stored = snap.messages.find((m) => m.id === sent.message.id);
    const routed = routeRoomMessage({ message: stored, messages: snap.messages, members: snap.members });
    if (routed.rule === 'none') {
      return { message: sent.message, duplicate: sent.duplicate, rule: 'none', dispatches: [], dispatch_ids: [] };
    }
    const reserved = await reserveHumanMessage(roomId, sent.message, routed.recipients, now());
    await schedule(roomId);
    const final = await store.snapshot(roomId);
    const ids = new Set(reserved.map((d) => d.id));
    const rows = (final.dispatches ?? []).filter((d) => ids.has(d.id));
    return { message: sent.message, duplicate: sent.duplicate, rule: routed.rule, dispatches: rows, dispatch_ids: rows.map((d) => d.id) };
  }

  async function handoff(roomId, request = {}) {
    const actor = request.actor;
    if (!actor || actor.kind !== 'agent' || !AGENT_REF.test(actor.id ?? '')) throw forbidden();
    const result = await store.transact(roomId, (d) => handoffInDraft(d, {
      actor, sourceMessageId: request.source_message_id, targetAgentId: request.target_agent_id,
      text: request.text, idempotencyKey: request.idempotency_key, nowMs: now(),
    }));
    if (!result.refused && !result.duplicate) void schedule(roomId);
    return result;
  }

  function contextFor(roomId, dispatch) {
    return {
      roomId,
      dispatch: clone(dispatch),
      async say(text) {
        if (typeof text !== 'string' || !text.length) throw fault(400, 'Invalid message text', 'invalid_request');
        return store.transact(roomId, (d) => {
          ensure(d);
          const row = d.dispatches.find((x) => x.id === dispatch.id);
          if (!row || !['accepted', 'running'].includes(row.state)) throw fault(409, 'That dispatch is no longer running', 'dispatch_not_running');
          return clone(addAgentMessage(d, row, text, 'running', now()));
        });
      },
      async handoff(request = {}) {
        const snap = await store.snapshot(roomId);
        const member = snap.members.find((m) => m.actor_kind === 'agent' && m.actor_id === dispatch.target_agent_id && m.removed_at === null);
        if (!member) throw forbidden();
        const source = request.source_message_id ?? snap.messages.filter((m) => m.dispatch_id === dispatch.id && m.author_kind === 'agent' && !m.system && !m.deleted_at).at(-1)?.id;
        if (!source) throw notFound();
        return handoff(roomId, {
          actor: { kind: 'agent', id: dispatch.target_agent_id, name: member.name },
          source_message_id: source, target_agent_id: request.target_agent_id,
          text: request.text, idempotency_key: request.idempotency_key,
        });
      },
    };
  }

  async function settle(roomId, dispatchId, outcome) {
    return store.transact(roomId, (d) => {
      ensure(d);
      const row = d.dispatches.find((x) => x.id === dispatchId);
      if (!row || row.state !== 'running') return null;
      const at = now();
      if (outcome?.waiting_approval) {
        row.state = 'waiting_approval'; row.updated_at = at; row.approval_reason = outcome.reason ?? null;
        return clone(row);
      }
      if (outcome?.failed) {
        const text = statusText('agent_failed', row.target_agent_id, outcome.reason);
        return clone(markFailed(d, row, outcome.code ?? 'agent_failed', text, at));
      }
      if (typeof outcome?.text === 'string' && outcome.text.length) {
        addAgentMessage(d, row, outcome.text, 'completed', at);
      }
      if (outcome?.handoff) {
        const source = d.messages.filter((m) => m.dispatch_id === row.id && m.author_kind === 'agent' && !m.system && !m.deleted_at).at(-1);
        if (!source) throw notFound();
        handoffInDraft(d, {
          actor: { kind: 'agent', id: row.target_agent_id, name: activeAgent(d, row.target_agent_id)?.name ?? row.target_agent_id },
          sourceMessageId: source.id, targetAgentId: outcome.handoff.target_agent_id,
          text: outcome.handoff.text, idempotencyKey: outcome.handoff.idempotency_key, nowMs: at,
        });
      }
      row.state = 'completed'; row.code = null; row.error = null; row.updated_at = at; row.finished_at = at;
      return clone(row);
    });
  }

  async function fail(roomId, dispatchId, code, text) {
    return store.transact(roomId, (d) => {
      ensure(d);
      const row = d.dispatches.find((x) => x.id === dispatchId);
      if (!row || TERMINAL_STATES.has(row.state)) return row ? clone(row) : null;
      return clone(markFailed(d, row, code, text, now()));
    });
  }
  async function uncertain(roomId, dispatchId) {
    return store.transact(roomId, (d) => {
      ensure(d);
      const row = d.dispatches.find((x) => x.id === dispatchId);
      if (!row || TERMINAL_STATES.has(row.state)) return row ? clone(row) : null;
      return clone(markUncertain(d, row, now()));
    });
  }

  async function pump(roomId) {
    for (;;) {
      if (closed) return;
      const snap = await store.snapshot(roomId);
      const rows = snap.dispatches ?? [];
      // A waiting approval consumes wall clock: expiry needs a fresh human message.
      const stale = rows.find((row) => row.state === 'waiting_approval' && now() >= row.root_deadline);
      if (stale) { await fail(roomId, stale.id, 'handoff_expired', statusText('handoff_expired', stale.target_agent_id)); continue; }
      if (rows.some((row) => ACTIVE_STATES.has(row.state))) return;
      const next = rows.filter((row) => row.state === 'queued').sort(byQueue)[0];
      if (!next) return;
      const pre = admissionReason(snap, next, now());
      if (pre) { await fail(roomId, next.id, pre.code, pre.text); continue; }

      const claimed = await store.transact(roomId, (d) => {
        ensure(d);
        const row = d.dispatches.find((x) => x.id === next.id);
        if (!row || row.state !== 'queued') return null;
        const reason = admissionReason(d, row, now());
        if (reason) return { ok: false, row: clone(markFailed(d, row, reason.code, reason.text, now())) };
        row.state = 'offered'; row.offered_at = now(); row.updated_at = now();
        return { ok: true, row: clone(row) };
      });
      if (!claimed) continue;
      if (!claimed.ok) continue;

      const row = claimed.row;
      const target = registry.get(row.target_agent_id);
      if (!target || target.online === false) {
        await fail(roomId, row.id, 'agent_offline', statusText('agent_offline', row.target_agent_id));
        continue;
      }
      let offered;
      try {
        offered = target.offer ? await target.offer({ roomId, dispatch: clone(row) }) : { accepted: true };
      } catch {
        await uncertain(roomId, row.id);
        return;
      }
      if (offered?.accepted === false) {
        await fail(roomId, row.id, offered.code ?? 'agent_refused', statusText(offered.code ?? 'agent_refused', row.target_agent_id, offered.reason));
        continue;
      }
      const accepted = await store.transact(roomId, (d) => {
        ensure(d);
        const current = d.dispatches.find((x) => x.id === row.id);
        if (!current || current.state !== 'offered') return null;
        current.state = 'accepted'; current.accepted_at = now(); current.updated_at = now();
        return clone(current);
      });
      if (!accepted) continue;
      const running = await store.transact(roomId, (d) => {
        ensure(d);
        const current = d.dispatches.find((x) => x.id === row.id);
        if (!current || current.state !== 'accepted') return null;
        current.state = 'running'; current.started_at = now(); current.updated_at = now();
        return clone(current);
      });
      if (!running) continue;

      let outcome;
      try {
        outcome = target.run ? await target.run(contextFor(roomId, running)) : {};
      } catch {
        await uncertain(roomId, row.id);
        return;
      }
      try { await settle(roomId, row.id, outcome); }
      catch { await uncertain(roomId, row.id); return; }
    }
  }

  async function expireRoom(roomId) {
    return store.transact(roomId, (d) => {
      ensure(d);
      const t = now();
      let n = 0;
      for (const row of d.dispatches) {
        if (!['queued', 'waiting_approval'].includes(row.state) || t < row.root_deadline) continue;
        markFailed(d, row, 'handoff_expired', statusText('handoff_expired', row.target_agent_id), t);
        n += 1;
      }
      return n;
    });
  }

  return {
    targets: registry,
    register(agentId, target) {
      const id = agentRef(agentId);
      if (!id) throw new TypeError('Invalid agent id');
      registry.set(id, target);
      return this;
    },
    submit,
    handoff,
    drain: (roomId) => schedule(roomId),
    /** Mark every in-flight turn uncertain and expire queued/waiting turns past their deadline. Never runs an agent. */
    async recover() {
      const rooms = await store.roomIds();
      const marked = [];
      for (const roomId of rooms) {
        await store.transact(roomId, (d) => {
          ensure(d);
          const t = now();
          for (const row of d.dispatches) {
            if (['offered', 'accepted', 'running'].includes(row.state)) { markUncertain(d, row, t); marked.push(row.id); }
            else if (['queued', 'waiting_approval'].includes(row.state) && t >= row.root_deadline) {
              markFailed(d, row, 'handoff_expired', statusText('handoff_expired', row.target_agent_id), t); marked.push(row.id);
            }
          }
        });
      }
      return { rooms: rooms.length, marked };
    },
    async expire(roomId) {
      const rooms = roomId ? [roomId] : await store.roomIds();
      const counts = {};
      for (const id of rooms) counts[id] = await expireRoom(id);
      return counts;
    },
    /** Human-only retry of an uncertain/failed dispatch; never automatic. */
    async retry(dispatchId, { actor } = {}) {
      if (!actor || actor.kind !== 'human' || !HUMAN_ID.test(actor.id ?? '')) throw fault(403, 'A human actor is required', 'actor_forbidden');
      const rooms = await store.roomIds();
      let roomId = null, found = null;
      for (const id of rooms) {
        const snap = await store.snapshot(id);
        const row = (snap.dispatches ?? []).find((x) => x.id === dispatchId);
        if (row) { roomId = id; found = { row, owner: snap.owner_id }; break; }
      }
      if (!roomId) throw fault(404, 'Dispatch not found', 'dispatch_not_found');
      if (found.owner !== actor.id) throw fault(403, 'Only the conversation owner may retry', 'not_conversation_owner');
      const result = await store.transact(roomId, (d) => {
        ensure(d);
        const row = d.dispatches.find((x) => x.id === dispatchId);
        if (!row || !['uncertain', 'failed'].includes(row.state)) throw fault(409, 'That dispatch cannot be retried', 'dispatch_not_retryable');
        const t = now();
        if (t >= row.root_deadline) {
          markFailed(d, row, 'handoff_expired', statusText('handoff_expired', row.target_agent_id), t);
          return { expired: true, dispatch: clone(row) };
        }
        row.state = 'queued'; row.code = null; row.error = null; row.attempts = (row.attempts ?? 0) + 1; row.updated_at = t;
        return { expired: false, dispatch: clone(row) };
      });
      if (!result.expired) await schedule(roomId);
      const final = await store.snapshot(roomId);
      return { ...result, dispatch: clone((final.dispatches ?? []).find((x) => x.id === dispatchId) ?? result.dispatch) };
    },
    close() { closed = true; },
  };
}
