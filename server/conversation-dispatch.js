// Durable room dispatch (Task 3).
//
// A dispatch is one agent turn in one room. Its record lives in the room JSON (fd_ ids) and moves through
// queued -> offered -> accepted -> running -> completed, with waiting_approval, cancelled, failed and
// uncertain as the other durable states. Decisions are written before anything is acknowledged:
//   - a human request appends its message and reserves one dispatch per target in ONE room mutation;
//   - a structured handoff creates its child message and child dispatch in one room mutation;
//   - execution is claimed (offered) and re-admitted inside the room mutation, then the agent is called
//     outside every room write lock.
//
// One agent turn per room: offered/accepted/running/waiting_approval block the room's queue. Queued turns
// drain oldest root first, then stable agent-id order within that root. The root budget (4 dispatches, 5
// minutes) is reserved atomically inside the same room mutation that creates a dispatch; refusals are
// durable failed rows plus a visible hub status message, never silence. A queued dispatch whose ancestor
// became uncertain/failed is blocked until the owner explicitly retries the ancestor.
//
// Agent output is two-tiered: ctx.say() appends a partial streaming row, while ctx.finalize() (or a settled
// outcome text) publishes the turn's committed public message. Only a final message can source a handoff, so
// partial text is never blessed as a delegation.
//
// Delivery is deliberately an interface, not a socket: `engine.register(agentId, target)` where target is
// `{ online?, offer?(ctx), run?(ctx) }`. Task 4 supplies the real bot-socket implementation. A transport that
// hands off after run() must call `engine.handoff(roomId, { actor, dispatch_id, run_token, source_message_id,
// target_agent_id, text, idempotency_key? })`; the dispatch id and attempt token are the ctx.attempt pair.
// There is no implicit "latest running source" lookup. If the process dies while a turn is
// offered/accepted/running, recover() marks it uncertain and only an explicit human retry() re-executes it.
// Offer/run callbacks are raced against the root deadline using an injectable `timers` scheduler
// ({ setTimeout, clearTimeout }), so tests can advance time deterministically.
import { randomBytes, createHash } from 'node:crypto';
import { fault, ROOM_LIMITS } from './config.js';
import { routeRoomMessage } from './conversation-routing.js';

export const DISPATCH_LIMITS = Object.freeze({
  max_handoff_dispatches_per_root: 4,
  handoff_chain_ttl_ms: 300_000,
  // Durable per-room dispatch rows are bounded instead of compacted: pruning a root would refund budget or
  // make an old idempotency key executable again. At the bound a new request fails closed.
  max_dispatches_per_room: 1000,
  // In-memory scheduling/failure tails are caches only; the durable queue is the source of truth.
  max_tracked_rooms: 500,
});

const AGENT_REF = /^agent:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HUMAN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACTIVE_STATES = new Set(['offered', 'accepted', 'running', 'waiting_approval']);
const TERMINAL_STATES = new Set(['completed', 'cancelled', 'failed', 'uncertain']);
const RETRYABLE_FAILED = new Set(['agent_offline', 'agent_failed']);
const MAX_MESSAGES = 5000, MAX_OUTBOX = 1000;
const MAX_TEXT = ROOM_LIMITS.max_text_bytes;
const MAX_CODE = 64;
const newId = (prefix) => prefix + randomBytes(12).toString('base64url');
const fingerprint = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

const notFound = () => fault(404, 'Handoff source is not a current agent message in this room', 'handoff_not_found');
const forbidden = () => fault(403, 'Agent is not an active member of this room', 'actor_forbidden');
const notOwner = () => fault(403, 'Only the conversation owner may post to this room', 'not_conversation_owner');
const selfHandoff = () => fault(409, 'An agent cannot hand off to itself', 'handoff_self');
const invalidText = () => fault(400, 'Invalid message text', 'invalid_request');
const idempotencyConflict = () => fault(409, 'That idempotency key was used for a different handoff', 'idempotency_conflict');
const handoffNotFinal = () => fault(409, 'Handoff source must be a final message from the current agent turn', 'handoff_not_final');
const notRetryable = (message = 'That dispatch cannot be retried') => fault(409, message, 'dispatch_not_retryable');

const agentRef = (value) => {
  if (typeof value !== 'string') return null;
  const id = value.startsWith('agent:') ? value : 'agent:' + value;
  return AGENT_REF.test(id) ? id : null;
};
const activeAgent = (d, id) => d.members.find((m) => m.actor_kind === 'agent' && m.actor_id === id && m.role === 'member' && m.removed_at === null) ?? null;
const ensure = (d) => { if (!Array.isArray(d.dispatches)) d.dispatches = []; };
const clone = (value) => structuredClone(value);
const validAgentText = (text) => typeof text === 'string' && text.length >= 1 && text.length <= MAX_TEXT
  && Buffer.byteLength(text, 'utf8') <= MAX_TEXT && !text.includes('\u0000');
const isFinalMessage = (m) => Boolean(m && !m.deleted_at && !m.system && m.author_kind === 'agent'
  && (m.final === true || m.delivery_state === 'completed'));

/** Truncate at a code-point boundary so a surrogate pair is never split; deterministic byte bound. */
function truncateUtf8(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let out = '', bytes = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (bytes + size > maxBytes) break;
    out += ch; bytes += size;
  }
  return out;
}
/** Untrusted status text: only strings, controls removed, bounded UTF-8, never an object/stack/Error. */
function safeText(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
  if (!cleaned) return fallback;
  return truncateUtf8(cleaned, MAX_TEXT) || fallback;
}
/** Durable code metadata is a short machine token, never arbitrary remote text. */
function safeCode(value, fallback = null) {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, MAX_CODE);
  return cleaned || fallback;
}
function statusReason(target, reason) {
  const detail = typeof reason === 'string' ? safeText(reason, '') : '';
  return detail ? `Could not deliver to ${target}: ${detail}.` : `Could not deliver to ${target}: the agent could not take the turn.`;
}
/** The transport-facing dispatch projection: attempt credentials stay out of every public result. */
function publicDispatch(row) {
  if (!row || typeof row !== 'object') return row;
  const { run_token, final_run_token, ...safe } = row;
  return clone(safe);
}
const capacityFault = () => fault(409, 'This room has reached its dispatch capacity; no new turn can be queued', 'dispatch_capacity');
const hasCapacity = (d) => !Array.isArray(d.dispatches) || d.dispatches.length < DISPATCH_LIMITS.max_dispatches_per_room;
const byQueue = (a, b) => ((a.root_seq ?? 0) - (b.root_seq ?? 0))
  || (a.created_at - b.created_at)
  || (a.target_agent_id < b.target_agent_id ? -1 : a.target_agent_id > b.target_agent_id ? 1 : 0)
  || (a.id < b.id ? -1 : 1);

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
  const safeCodeValue = safeCode(code, null);
  const prior = d.messages.find((m) => m.system && m.dispatch_id === dispatch?.id && m.code === safeCodeValue);
  if (prior) return prior;
  const target = dispatch?.target_agent_id ?? null;
  const member = target ? (activeAgent(d, target) ?? [...d.members].reverse().find((m) => m.actor_kind === 'agent' && m.actor_id === target)) : null;
  const seq = d.next_seq++;
  const message = {
    id: newId('fm_'), seq, author_kind: target ? 'agent' : 'human', author_id: target ?? d.owner_id,
    author_name: member?.name ?? (target ?? d.owner_name),
    body: safeText(text, 'The hub could not deliver this turn.'), format: 'text', mentions: [], reply_to: null,
    created_at: at, revision: 1, deleted_at: null,
    root_id: dispatch?.root_id ?? null, dispatch_id: dispatch?.id ?? null, delivery_state: 'failed',
    system: true, code: safeCodeValue, client_id: null, client_fp: null,
  };
  d.messages.push(message); trimMessages(d);
  d.updated_at = at;
  pushOutbox(d, { type: 'message.new', message_id: message.id, seq, at });
  return message;
}

function addAgentMessage(d, dispatch, body, deliveryState, at, final = false) {
  const member = activeAgent(d, dispatch.target_agent_id);
  if (!member) throw forbidden();
  const seq = d.next_seq++;
  const message = {
    id: newId('fm_'), seq, author_kind: 'agent', author_id: member.actor_id, author_name: member.name,
    body, format: 'text', mentions: [], reply_to: null, created_at: at, revision: 1, deleted_at: null,
    root_id: dispatch.root_id, dispatch_id: dispatch.id, delivery_state: deliveryState,
    ...(final ? { final: true } : {}),
    client_id: null, client_fp: null,
  };
  d.messages.push(message); trimMessages(d);
  d.updated_at = at;
  pushOutbox(d, { type: 'message.new', message_id: message.id, seq, at });
  return message;
}

/**
 * Durable execution preconditions, independent of the human who asked. A dispatch stays bound to the
 * membership generation and room epoch it was reserved under: leaving and rejoining never revives it, and
 * neither does a queue pause or a deadline that has passed.
 */
function reservationReason(d, row, nowMs) {
  if (d.epoch !== row.epoch) return { code: 'epoch_changed', text: 'The room changed; the reservation is no longer valid.' };
  if (nowMs >= row.root_deadline) return { code: 'handoff_expired', text: 'The handoff chain deadline passed before this turn could start.' };
  const member = activeAgent(d, row.target_agent_id);
  if (!member) return { code: 'actor_forbidden', text: 'The agent is no longer an active member of this room.' };
  if (member.generation !== row.membership_generation) return { code: 'membership_changed', text: 'The agent left and rejoined this room; the reservation is no longer valid.' };
  return null;
}
function executionReason(d, row, nowMs) {
  if (d.paused) return { code: 'room_paused', text: 'The room queue is paused.' };
  return reservationReason(d, row, nowMs);
}
/** Pause must drop the live attempt immediately. Throwing inside a mutate rolls the write back. */
function holdPausedTurn(row, at) {
  if (!['offered', 'accepted', 'running'].includes(row.state)) return;
  row.state = 'queued';
  row.run_token = null;
  row.updated_at = at;
}
function admissionReason(d, row, nowMs) {
  return row.state === 'queued' ? executionReason(d, row, nowMs) : null;
}
function blockedAncestor(d, row) {
  if (!row.handoff || !row.source_dispatch_id) return false;
  const seen = new Set();
  let child = row, id = row.source_dispatch_id;
  while (id && !seen.has(id)) {
    seen.add(id);
    const parent = d.dispatches.find((x) => x.id === id);
    if (!parent) return true;
    // Eligibility is causal, never sort-driven: a descendant may run only after its ancestor actually
    // completed. A queued/offered/running retry is not success, and a failed/uncertain attempt never is.
    if (parent.state !== 'completed') return true;
    // A descendant created from a superseded source is not revived by an unrelated later final message.
    if (parent.final_message_id && child.parent_message_id && child.parent_message_id !== parent.final_message_id) return true;
    if (!Number.isSafeInteger(child.source_attempt) || !Number.isSafeInteger(parent.completed_attempt)
      || child.source_attempt !== parent.completed_attempt) return true;
    child = parent; id = parent.source_dispatch_id;
  }
  return false;
}

function markFailed(d, row, code, text, at) {
  const safeCodeValue = safeCode(code, null);
  const body = safeText(text, 'The turn failed.');
  row.state = 'failed'; row.code = safeCodeValue; row.error = body; row.updated_at = at; row.finished_at = at;
  addNotice(d, row, body, at, safeCodeValue);
  return row;
}
function markUncertain(d, row, at, code = 'uncertain_after_restart', text = null) {
  const safeCodeValue = safeCode(code, 'uncertain_after_restart');
  const body = text ?? (safeCodeValue === 'uncertain_timeout'
    ? `Delivery to ${row.target_agent_id} is uncertain: it did not settle before the chain deadline and may still be running. A human must retry; it will not run automatically.`
    : `Delivery to ${row.target_agent_id} is uncertain after an interruption. A human must retry; it will not run automatically.`);
  row.state = 'uncertain'; row.code = safeCodeValue; row.updated_at = at;
  addNotice(d, row, body, at, safeCodeValue);
  return row;
}
function failSupersededChildren(d, parent, at) {
  for (const child of d.dispatches) {
    if (!child.handoff || child.source_dispatch_id !== parent.id || child.state !== 'queued') continue;
    if (child.source_attempt === parent.completed_attempt) continue;
    markFailed(d, child, 'handoff_superseded', 'This handoff was superseded by a newer attempt of its parent turn.', at);
  }
}

function statusText(code, target, reason) {
  if (code === 'handoff_limit') return `Handoff refused: this conversation chain has used its ${DISPATCH_LIMITS.max_handoff_dispatches_per_root} dispatches. Send a new message to continue.`;
  if (code === 'handoff_expired') return `Dispatch expired: the ${DISPATCH_LIMITS.handoff_chain_ttl_ms / 60_000}-minute handoff chain deadline passed. Send a new message to continue.`;
  if (code === 'agent_offline') return `Could not deliver to ${target}: the agent is offline.`;
  if (code === 'dispatch_capacity') return 'This room has reached its dispatch capacity; no new turn can be queued.';
  return statusReason(target, reason);
}

function newDispatch(d, { state, rootId, rootSeq, requestMessageId, sourceDispatchId, parentMessageId, target, deadline, nowMs, dedupeKey, dedupeFingerprint, idempotencyKey, counts }) {
  return {
    id: newId('fd_'), state, root_id: rootId, root_seq: rootSeq ?? null, request_message_id: requestMessageId ?? null,
    source_dispatch_id: sourceDispatchId ?? null, parent_message_id: parentMessageId ?? null,
    target_agent_id: target, epoch: d.epoch, membership_generation: null, context_through_seq: d.next_seq - 1,
    root_deadline: deadline, created_at: nowMs, updated_at: nowMs, attempts: 0, attempt: 0,
    run_token: null, final_message_id: null, final_run_token: null, completed_attempt: null,
    dedupe_key: dedupeKey ?? null, dedupe_fingerprint: dedupeFingerprint ?? null, idempotency_key: idempotencyKey ?? null,
    counts_toward_budget: counts !== false, code: null, error: null,
    ...(sourceDispatchId ? { handoff: true } : {}),
  };
}

/**
 * Reserve a child message + dispatch for a structured handoff inside an existing room mutation.
 * The source must be a FINAL message (say() leaves a partial row) authored by the caller for the dispatch
 * currently bound to that turn. Idempotency keys are scoped to (actor, parent dispatch), so one agent can
 * never observe or reuse another dispatch's key, and a conflicting payload is a conflict, not a lookup.
 */
function handoffInDraft(d, { actor, dispatchId, runToken, sourceMessageId, targetAgentId, text, idempotencyKey, nowMs }) {
  ensure(d);
  // Every entry point is authenticated to one concrete attempt. There is deliberately no "latest running
  // turn" fallback: a delayed public request must present the dispatch and the attempt token it belongs to.
  if (typeof dispatchId !== 'string' || !dispatchId || typeof runToken !== 'string' || !runToken) {
    throw fault(409, 'A dispatch id and current attempt token are required', 'dispatch_context_required');
  }
  const actorRow = activeAgent(d, actor.id);
  if (!actorRow) throw forbidden();
  if (!validAgentText(text)) throw invalidText();
  const target = agentRef(targetAgentId);
  if (!target) throw notFound();
  if (target === actor.id) throw selfHandoff();

  const parent = d.dispatches.find((x) => x.id === dispatchId);
  if (!parent || parent.target_agent_id !== actor.id) throw fault(404, 'Dispatch not found', 'dispatch_not_found');
  if (parent.run_token !== runToken) throw fault(409, 'That dispatch was replaced', 'dispatch_stale');
  if (parent.state !== 'running') throw fault(409, 'That dispatch is no longer running', 'dispatch_not_running');
  if (typeof sourceMessageId !== 'string' || !sourceMessageId) throw handoffNotFinal();
  const source = d.messages.find((m) => m.id === sourceMessageId && !m.deleted_at);
  if (!source || source.system || source.author_kind !== 'agent' || source.author_id !== actor.id) throw notFound();
  if (source.dispatch_id !== parent.id) throw notFound();
  // The source is only valid for the attempt that published the canonical final message. A retry keeps that
  // message slot (in-place revision) but revokes its old attempt binding until the new attempt finalizes.
  if (!isFinalMessage(source) || parent.final_message_id !== source.id || parent.final_run_token !== runToken) {
    throw handoffNotFinal();
  }
  const reason = executionReason(d, parent, nowMs);
  if (reason) throw fault(409, reason.text, reason.code);

  const explicitKey = typeof idempotencyKey === 'string' && idempotencyKey.length > 0;
  const key = explicitKey
    ? `handoff:${actor.id}:${parent.id}:${parent.attempt}:${fingerprint('idempotency', idempotencyKey)}`
    : `handoff-keyless:${actor.id}:${parent.id}:${parent.attempt}:${fingerprint(source.id, target, text)}`;
  const storedIdempotencyKey = explicitKey ? (truncateUtf8(safeText(idempotencyKey, ''), 256) || null) : null;
  const dedupeFingerprint = fingerprint(source.id, target, text);
  let prior = d.dispatches.find((x) => x.dedupe_key === key);
  if (!prior) {
    // A keyless repeat of an explicitly-keyed handoff is still the same turn asking for the same thing.
    prior = d.dispatches.find((x) => x.handoff && x.source_dispatch_id === parent.id
      && x.source_attempt === parent.attempt
      && x.parent_message_id === source.id && x.target_agent_id === target
      && x.dedupe_fingerprint === dedupeFingerprint);
  }
  if (prior) {
    if (prior.dedupe_key === key && prior.dedupe_fingerprint !== dedupeFingerprint) throw idempotencyConflict();
    const priorMessage = prior.request_message_id ? d.messages.find((m) => m.id === prior.request_message_id) ?? null : null;
    return {
      dispatch: publicDispatch(prior),
      message: priorMessage ? clone(priorMessage) : null,
      duplicate: true, refused: prior.state === 'failed',
      ...(prior.state === 'failed' && prior.code ? { code: prior.code } : {}),
    };
  }

  const targetRow = activeAgent(d, target);
  if (!targetRow) throw notFound();
  if (!hasCapacity(d)) throw capacityFault();

  const rootId = parent.root_id, rootSeq = parent.root_seq ?? parent.created_at, deadline = parent.root_deadline;
  const counted = d.dispatches.filter((x) => x.root_id === rootId && x.counts_toward_budget !== false).length;
  const refusal = nowMs >= deadline ? 'handoff_expired' : counted >= DISPATCH_LIMITS.max_handoff_dispatches_per_root ? 'handoff_limit' : null;
  if (refusal) {
    const row = newDispatch(d, {
      state: 'failed', rootId, rootSeq, sourceDispatchId: parent.id, parentMessageId: source.id, target, deadline, nowMs,
      dedupeKey: key, dedupeFingerprint, idempotencyKey: storedIdempotencyKey, counts: false,
    });
    row.source_attempt = parent.attempt;
    row.code = refusal; row.error = safeText(statusText(refusal, target));
    d.dispatches.push(row);
    const notice = addNotice(d, row, row.error, nowMs, refusal);
    return { dispatch: publicDispatch(row), message: clone(notice), refused: true, code: refusal };
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
    state: 'queued', rootId, rootSeq, requestMessageId: message.id, sourceDispatchId: parent.id, parentMessageId: source.id,
    target, deadline, nowMs, dedupeKey: key, dedupeFingerprint, idempotencyKey: storedIdempotencyKey, counts: true,
  });
  row.id = childId; row.membership_generation = targetRow.generation; row.source_attempt = parent.attempt;
  d.dispatches.push(row);
  d.updated_at = nowMs;
  return { dispatch: publicDispatch(row), message: clone(message), duplicate: false, refused: false };
}

/** Reserve every recipient of one human request inside the same room mutation that appended the message. */
function reserveHumanAdmission(d, message, recipients, nowMs) {
  ensure(d);
  if (recipients.length && !hasCapacity(d)) throw capacityFault();
  const out = [];
  for (const target of [...recipients].sort()) {
    const dedupeKey = `message:${message.id}:${target}`;
    const prior = d.dispatches.find((x) => x.dedupe_key === dedupeKey);
    if (prior) { out.push({ ...publicDispatch(prior), duplicate: true }); continue; }
    if (!hasCapacity(d)) throw capacityFault();

    const rootId = message.id;
    const rootRow = d.dispatches.find((x) => x.root_id === rootId);
    const rootSeq = rootRow?.root_seq ?? message.seq;
    const deadline = rootRow?.root_deadline ?? nowMs + DISPATCH_LIMITS.handoff_chain_ttl_ms;
    const counted = d.dispatches.filter((x) => x.root_id === rootId && x.counts_toward_budget !== false).length;
    const member = activeAgent(d, target);
    const refusal = nowMs >= deadline ? 'handoff_expired'
      : counted >= DISPATCH_LIMITS.max_handoff_dispatches_per_root ? 'handoff_limit'
        : !member ? 'actor_forbidden' : null;
    if (refusal) {
      const row = newDispatch(d, {
        state: 'failed', rootId, rootSeq, requestMessageId: message.id, target, deadline, nowMs,
        dedupeKey, counts: false,
      });
      row.code = refusal; row.error = safeText(statusText(refusal, target));
      d.dispatches.push(row);
      addNotice(d, row, row.error, nowMs, refusal);
      out.push({ ...publicDispatch(row), duplicate: false, refused: true });
      continue;
    }
    const row = newDispatch(d, {
      state: 'queued', rootId, rootSeq, requestMessageId: message.id, target, deadline, nowMs,
      dedupeKey, counts: true,
    });
    row.membership_generation = member.generation;
    row.context_through_seq = message.seq;
    d.dispatches.push(row);
    out.push({ ...publicDispatch(row), duplicate: false, refused: false });
  }
  return out;
}

export function createDispatchEngine({ store, now = () => Date.now(), targets = new Map(), timers } = {}) {
  if (!store || typeof store.send !== 'function' || typeof store.transact !== 'function') throw new TypeError('A conversation store is required');
  const registry = targets instanceof Map ? targets : new Map(Object.entries(targets));
  const timerApi = timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (handle) => clearTimeout(handle) };
  if (!timerApi || typeof timerApi.setTimeout !== 'function' || typeof timerApi.clearTimeout !== 'function') {
    throw new TypeError('timers must provide setTimeout and clearTimeout');
  }
  const chains = new Map();
  const failures = new Map();
  const pendingTimers = new Set();
  let closed = false;
  let localEpoch = 0;
  let pumpEpoch = 0;
  const alive = (epoch) => !closed && localEpoch === epoch;
  const pumpAlive = (epoch) => !closed && pumpEpoch === epoch;
  const TIMED_OUT = Symbol('dispatch_deadline_timeout');
  const stale = () => fault(409, 'That dispatch was replaced', 'dispatch_stale');

  /**
   * Race one transport callback against the root deadline. The callback keeps running, but this pump stops
   * waiting at the deadline; a late value/throw is observed here and never reaches a newer attempt. Closing
   * the engine cancels every armed timer, so a closed engine's callbacks are revoked immediately.
   */
  const bounded = (promise, deadline) => {
    const remaining = deadline - now();
    if (remaining <= 0) return Promise.resolve(TIMED_OUT);
    return new Promise((resolve) => {
      const record = { done: false, handle: null };
      const finish = (value) => {
        if (record.done) return;
        record.done = true;
        pendingTimers.delete(record);
        timerApi.clearTimeout(record.handle);
        resolve(value);
      };
      record.cancel = () => finish(TIMED_OUT);
      record.handle = timerApi.setTimeout(() => finish(TIMED_OUT), remaining);
      pendingTimers.add(record);
      Promise.resolve(promise).then(
        (value) => finish({ ok: true, value }),
        (error) => finish({ ok: false, error }),
      );
    });
  };

  const schedule = (roomId) => {
    if (closed) return Promise.resolve();
    const prior = chains.get(roomId) ?? Promise.resolve();
    const run = prior.then(() => pump(roomId));
    const tracked = run.catch((error) => {
      failures.set(roomId, error);
      if (failures.size > DISPATCH_LIMITS.max_tracked_rooms) failures.delete(failures.keys().next().value);
    });
    chains.set(roomId, tracked);
    // A settled room leaves no in-memory chain behind; an entry is only removed if no newer schedule took it.
    tracked.then(() => { if (chains.get(roomId) === tracked) chains.delete(roomId); });
    return run;
  };

  async function drain(roomId) {
    let error = null;
    try { await schedule(roomId); } catch (e) { error = e; }
    if (error) { failures.delete(roomId); throw error; }
    const prior = failures.get(roomId);
    if (prior) { failures.delete(roomId); throw prior; }
  }

  function admitHuman(actor, d, message, duplicate) {
    if (d.owner_id !== actor.id) throw notOwner();
    if (duplicate) {
      // Reuse the durable admission exactly. Never re-route a duplicate against current members: a passive
      // request must not become executable after a rejoin, rename or reply-target change. Older records
      // without a stored admission fall back to the dispatches already committed for this message only.
      const recorded = message.admission && Array.isArray(message.admission.recipients) ? message.admission : null;
      const rows = d.dispatches.filter((x) => x.request_message_id === message.id);
      const recipients = recorded ? recorded.recipients : [...new Set(rows.map((x) => x.target_agent_id))];
      const dispatches = recipients
        .map((target) => rows.find((x) => x.target_agent_id === target && x.dedupe_key === `message:${message.id}:${target}`))
        .filter(Boolean)
        .map((row) => ({ ...publicDispatch(row), duplicate: true }));
      const rule = recorded && ['mention', 'reply', 'none'].includes(recorded.rule)
        ? recorded.rule : (rows.length ? 'recovered' : 'none');
      return { rule, dispatches };
    }
    const routed = routeRoomMessage({ message, messages: d.messages, members: d.members });
    const dispatches = reserveHumanAdmission(d, message, routed.recipients, now());
    message.admission = { rule: routed.rule, recipients: [...routed.recipients] };
    return { rule: routed.rule, dispatches };
  }

  async function submit(roomId, { actor, text, format, mentions, reply_to, client_id } = {}) {
    if (!actor || actor.kind !== 'human' || !HUMAN_ID.test(actor.id ?? '')) throw fault(403, 'A human actor is required', 'actor_forbidden');
    const head = await store.snapshot(roomId);
    if (head.owner_id !== actor.id) throw notOwner();
    const sent = await store.send(roomId, {
      actor, text, format, mentions, reply_to, client_id,
      // This callback runs inside the same room mutation as the message append. A crash or disk failure
      // commits neither the addressed message nor its routing intent.
      admit: (d, message, duplicate) => admitHuman(actor, d, message, duplicate),
    });
    const admitted = sent.admitted ?? { rule: 'none', dispatches: [] };
    void schedule(roomId).catch(() => {});
    return {
      message: sent.message, duplicate: sent.duplicate, rule: admitted.rule,
      dispatches: admitted.dispatches, dispatch_ids: admitted.dispatches.map((d) => d.id),
    };
  }

  async function runHandoff(roomId, request = {}) {
    const actor = request.actor;
    if (!actor || actor.kind !== 'agent' || !AGENT_REF.test(actor.id ?? '')) throw forbidden();
    const result = await store.transact(roomId, (d) => {
      ensure(d);
      const parent = d.dispatches.find((x) => x.id === request.dispatch_id);
      if (parent && parent.run_token === request.run_token && parent.state === 'running') {
        const reason = executionReason(d, parent, now());
        if (reason?.code === 'room_paused') {
          holdPausedTurn(parent, now());
          return { held: true, reason };
        }
      }
      return handoffInDraft(d, {
        actor, dispatchId: request.dispatch_id, runToken: request.run_token,
        sourceMessageId: request.source_message_id, targetAgentId: request.target_agent_id,
        text: request.text, idempotencyKey: request.idempotency_key, nowMs: now(),
      });
    });
    if (result?.held) throw fault(409, result.reason.text, result.reason.code);
    if (!result.refused && !result.duplicate) void schedule(roomId).catch(() => {});
    return result;
  }

  async function handoffForDispatch(roomId, running, request, epoch) {
    if (!alive(epoch)) throw stale();
    const result = await store.transact(roomId, (d) => {
      ensure(d);
      if (!alive(epoch)) throw stale();
      const row = d.dispatches.find((x) => x.id === running.id);
      if (!row) throw fault(409, 'That dispatch is no longer running', 'dispatch_not_running');
      if (row.run_token !== running.run_token) throw stale();
      if (row.state !== 'running') throw fault(409, 'That dispatch is no longer running', 'dispatch_not_running');
      const paused = executionReason(d, row, now());
      if (paused?.code === 'room_paused') {
        holdPausedTurn(row, now());
        return { held: true, reason: paused };
      }
      const member = activeAgent(d, row.target_agent_id);
      if (!member) throw forbidden();
      const sourceId = request.source_message_id ?? row.final_message_id;
      if (!sourceId) throw handoffNotFinal();
      return handoffInDraft(d, {
        actor: { kind: 'agent', id: row.target_agent_id, name: member.name },
        dispatchId: row.id, runToken: row.run_token, sourceMessageId: sourceId,
        targetAgentId: request.target_agent_id, text: request.text,
        idempotencyKey: request.idempotency_key, nowMs: now(),
      });
    });
    if (result?.held) throw fault(409, result.reason.text, result.reason.code);
    if (!result.refused && !result.duplicate) void schedule(roomId).catch(() => {});
    return result;
  }

  function publishFinal(d, row, text, at, token) {
    const prior = row.final_message_id ? d.messages.find((m) => m.id === row.final_message_id) : null;
    if (prior && !prior.deleted_at && prior.final === true && prior.dispatch_id === row.id
      && prior.author_kind === 'agent' && prior.author_id === row.target_agent_id) {
      if (prior.body !== text) {
        prior.body = text;
        prior.revision = (prior.revision ?? 1) + 1;
        pushOutbox(d, { type: 'message.edited', message_id: prior.id, seq: prior.seq, at });
      }
      row.final_message_id = prior.id;
      row.final_run_token = token;
      row.updated_at = at;
      return prior;
    }
    const message = addAgentMessage(d, row, text, 'completed', at, true);
    row.final_message_id = message.id;
    row.final_run_token = token;
    row.updated_at = at;
    return message;
  }

  function contextFor(roomId, running, epoch) {
    const token = running.run_token;
    const rejectStale = (row, reason) => fault(409, reason.text, reason.code);
    return {
      roomId,
      dispatch: publicDispatch(running),
      // The transport keeps this opaque pair for later public engine.handoff calls. It is never added to a
      // message projection or to the result of submit/retry/handoff.
      attempt: Object.freeze({ dispatch_id: running.id, token }),
      /** A partial, in-progress message. It is never a valid handoff source. */
      async say(text) {
        if (!validAgentText(text)) throw invalidText();
        const result = await store.transact(roomId, (d) => {
          ensure(d);
          if (!alive(epoch)) throw stale();
          const row = d.dispatches.find((x) => x.id === running.id);
          if (!row) throw fault(409, 'That dispatch is no longer running', 'dispatch_not_running');
          if (row.run_token !== token) throw stale();
          if (!['accepted', 'running'].includes(row.state)) throw fault(409, 'That dispatch is no longer running', 'dispatch_not_running');
          const reason = executionReason(d, row, now());
          if (reason) {
            if (reason.code === 'room_paused') {
              holdPausedTurn(row, now());
              return { held: true, reason };
            }
            throw rejectStale(row, reason);
          }
          return { message: clone(addAgentMessage(d, row, text, 'running', now())) };
        });
        if (result?.held) throw rejectStale(null, result.reason);
        return result.message;
      },
      /** Publish the turn's committed public message; only this (or a settled outcome) can source a handoff. */
      async finalize(text) {
        if (!validAgentText(text)) throw invalidText();
        const result = await store.transact(roomId, (d) => {
          ensure(d);
          if (!alive(epoch)) throw stale();
          const row = d.dispatches.find((x) => x.id === running.id);
          if (!row) throw fault(409, 'That dispatch is no longer running', 'dispatch_not_running');
          if (row.run_token !== token) throw stale();
          if (row.state !== 'running') throw fault(409, 'That dispatch is no longer running', 'dispatch_not_running');
          const reason = executionReason(d, row, now());
          if (reason) {
            if (reason.code === 'room_paused') {
              holdPausedTurn(row, now());
              return { held: true, reason };
            }
            throw rejectStale(row, reason);
          }
          if (row.final_message_id && row.final_run_token === token) {
            const prior = d.messages.find((m) => m.id === row.final_message_id);
            if (prior && prior.body === text) return { message: clone(prior) };
            throw fault(409, 'This attempt already published its final message', 'dispatch_finalized');
          }
          return { message: clone(publishFinal(d, row, text, now(), token)) };
        });
        if (result?.held) throw rejectStale(null, result.reason);
        return result.message;
      },
      async handoff(request = {}) {
        return handoffForDispatch(roomId, running, request, epoch);
      },
    };
  }

  async function settle(roomId, dispatchId, outcome, runToken = null, epoch = undefined) {
    return store.transact(roomId, (d) => {
      ensure(d);
      if (epoch !== undefined && !pumpAlive(epoch)) return null;
      const row = d.dispatches.find((x) => x.id === dispatchId);
      if (!row || row.state !== 'running') return null;
      if (!runToken || row.run_token !== runToken) return null;
      const at = now();
      const reason = executionReason(d, row, at);
      if (reason) {
        if (reason.code === 'room_paused') {
          holdPausedTurn(row, at);
          return clone(row);
        }
        return clone(markFailed(d, row, reason.code, reason.text, at));
      }
      if (outcome?.waiting_approval) {
        row.state = 'waiting_approval'; row.updated_at = at; row.approval_reason = safeText(outcome.reason, '') || null;
        return clone(row);
      }
      if (outcome?.failed) {
        const code = safeCode(outcome.code, 'agent_failed');
        return clone(markFailed(d, row, code, statusText(code, row.target_agent_id, outcome.reason), at));
      }
      if (outcome?.text !== undefined && outcome?.text !== null) {
        if (!validAgentText(outcome.text)) {
          return clone(markFailed(d, row, 'invalid_request', 'The agent returned an invalid final message.', at));
        }
        // A finalize() call from this attempt is already committed and is not overwritten by the outcome
        // text. A settled answer from a retry revises the retained canonical message in place.
        if (!row.final_message_id || row.final_run_token !== runToken) publishFinal(d, row, outcome.text, at, runToken);
      }
      if (outcome?.handoff) {
        if (!row.final_message_id || row.final_run_token !== runToken) {
          return clone(markFailed(d, row, 'handoff_not_final', 'The agent handed off before this attempt published a final message.', at));
        }
        const source = d.messages.find((m) => m.id === row.final_message_id);
        if (!source) return clone(markFailed(d, row, 'handoff_not_final', 'The agent handed off before publishing a final message.', at));
        try {
          handoffInDraft(d, {
            actor: { kind: 'agent', id: row.target_agent_id, name: activeAgent(d, row.target_agent_id)?.name ?? row.target_agent_id },
            dispatchId: row.id, runToken, sourceMessageId: source.id,
            targetAgentId: outcome.handoff.target_agent_id, text: outcome.handoff.text,
            idempotencyKey: outcome.handoff.idempotency_key, nowMs: at,
          });
        } catch (e) {
          if (e?.status && e.status < 500) return clone(markFailed(d, row, e.code ?? 'invalid_request', e.message, at));
          throw e;
        }
      }
      row.state = 'completed'; row.completed_attempt = row.attempt; row.code = null; row.error = null;
      row.updated_at = at; row.finished_at = at;
      failSupersededChildren(d, row, at);
      return clone(row);
    });
  }

  async function fail(roomId, dispatchId, code, text, { states = null, token = null, epoch = undefined } = {}) {
    return store.transact(roomId, (d) => {
      ensure(d);
      if (epoch !== undefined && !pumpAlive(epoch)) return null;
      const row = d.dispatches.find((x) => x.id === dispatchId);
      if (!row) return null;
      if (token !== null && row.run_token !== token) return null;
      if (states && !states.includes(row.state)) return clone(row);
      if (TERMINAL_STATES.has(row.state)) return clone(row);
      return clone(markFailed(d, row, code, text, now()));
    });
  }
  async function uncertain(roomId, dispatchId, token, code = 'uncertain_after_restart', epoch = undefined) {
    return store.transact(roomId, (d) => {
      ensure(d);
      if (epoch !== undefined && !pumpAlive(epoch)) return null;
      const row = d.dispatches.find((x) => x.id === dispatchId);
      if (!row || TERMINAL_STATES.has(row.state)) return row ? clone(row) : null;
      if (!token || row.run_token !== token) return null;
      if (!['offered', 'accepted', 'running'].includes(row.state)) return clone(row);
      return clone(markUncertain(d, row, now(), code));
    });
  }

  async function pump(roomId) {
    const epoch = pumpEpoch;
    for (;;) {
      if (!pumpAlive(epoch)) return;
      const snap = await store.snapshot(roomId);
      if (!pumpAlive(epoch)) return;
      if (snap.paused) return;
      const rows = snap.dispatches ?? [];
      // A waiting approval consumes wall clock: expiry needs a fresh human message.
      const expiredApproval = rows.find((row) => row.state === 'waiting_approval' && now() >= row.root_deadline);
      if (expiredApproval) { await fail(roomId, expiredApproval.id, 'handoff_expired', statusText('handoff_expired', expiredApproval.target_agent_id), { states: ['waiting_approval'], epoch }); continue; }
      if (rows.some((row) => ACTIVE_STATES.has(row.state))) return;
      const next = rows.filter((row) => row.state === 'queued' && !blockedAncestor(snap, row)).sort(byQueue)[0];
      if (!next) return;
      const pre = admissionReason(snap, next, now());
      if (pre) {
        if (pre.code === 'room_paused') return;
        await fail(roomId, next.id, pre.code, pre.text, { states: ['queued'], epoch });
        continue;
      }

      const claimed = await store.transact(roomId, (d) => {
        ensure(d);
        if (!pumpAlive(epoch)) return null;
        const row = d.dispatches.find((x) => x.id === next.id);
        if (!row || row.state !== 'queued') return null;
        if (d.dispatches.some((x) => x.id !== row.id && ACTIVE_STATES.has(x.state))) return { ok: false, held: true };
        if (blockedAncestor(d, row)) return { ok: false, blocked: true };
        const reason = admissionReason(d, row, now());
        if (reason) {
          if (reason.code === 'room_paused') return { ok: false, paused: true };
          return { ok: false, row: clone(markFailed(d, row, reason.code, reason.text, now())) };
        }
        const at = now();
        // The execution fence is minted at claim time, before any remote callback can observe the offer.
        row.state = 'offered'; row.offered_at = at; row.updated_at = at;
        row.attempt = (row.attempt ?? 0) + 1;
        row.run_token = newId('fr_');
        return { ok: true, row: clone(row) };
      });
      if (!pumpAlive(epoch)) return;
      if (!claimed) continue;
      if (claimed.held) return;
      if (claimed.paused) return;
      if (!claimed.ok) continue;

      const row = claimed.row;
      const token = row.run_token;
      const target = registry.get(row.target_agent_id);
      if (!target || target.online === false) {
        await fail(roomId, row.id, 'agent_offline', statusText('agent_offline', row.target_agent_id), { states: ['offered'], token, epoch });
        continue;
      }

      let offerCall;
      try {
        offerCall = target.offer ? target.offer({ roomId, dispatch: publicDispatch(row) }) : { accepted: true };
      } catch {
        await uncertain(roomId, row.id, token, 'uncertain_delivery', epoch);
        continue;
      }
      let offered;
      const offerResult = await bounded(offerCall, row.root_deadline);
      if (!pumpAlive(epoch)) return;
      if (offerResult === TIMED_OUT) {
        await uncertain(roomId, row.id, token, 'uncertain_timeout', epoch);
        continue;
      }
      if (!offerResult.ok) {
        // The transport may have begun side effects before failing: uncertain, never "cancelled".
        await uncertain(roomId, row.id, token, 'uncertain_delivery', epoch);
        continue;
      }
      offered = offerResult.value;
      if (offered?.accepted === false) {
        const code = safeCode(offered.code, 'agent_refused');
        await fail(roomId, row.id, code, statusText(code, row.target_agent_id, offered.reason), { states: ['offered'], token, epoch });
        continue;
      }

      // Mutations after the asynchronous offer must not turn a stale reservation into execution.
      const accepted = await store.transact(roomId, (d) => {
        ensure(d);
        if (!pumpAlive(epoch)) return null;
        const current = d.dispatches.find((x) => x.id === row.id);
        if (!current || current.state !== 'offered' || current.run_token !== token) return null;
        const at = now();
        const reason = executionReason(d, current, at);
        if (reason) {
          if (reason.code === 'room_paused') { holdPausedTurn(current, at); return { ok: false, paused: true }; }
          return { ok: false, row: clone(markFailed(d, current, reason.code, reason.text, at)) };
        }
        current.state = 'accepted'; current.accepted_at = at; current.updated_at = at;
        return { ok: true, row: clone(current) };
      });
      if (!pumpAlive(epoch)) return;
      if (!accepted) continue;
      if (accepted.paused) return;
      if (!accepted.ok) continue;

      const running = await store.transact(roomId, (d) => {
        ensure(d);
        if (!pumpAlive(epoch)) return null;
        const current = d.dispatches.find((x) => x.id === row.id);
        if (!current || current.state !== 'accepted' || current.run_token !== token) return null;
        const at = now();
        const reason = executionReason(d, current, at);
        if (reason) {
          if (reason.code === 'room_paused') { holdPausedTurn(current, at); return { ok: false, paused: true }; }
          return { ok: false, row: clone(markFailed(d, current, reason.code, reason.text, at)) };
        }
        current.state = 'running'; current.started_at = at; current.updated_at = at;
        return { ok: true, row: clone(current) };
      });
      if (!pumpAlive(epoch)) return;
      if (!running) continue;
      if (running.paused) return;
      if (!running.ok) continue;

      let runCall;
      try {
        runCall = target.run ? target.run(contextFor(roomId, running.row, localEpoch)) : {};
      } catch {
        await uncertain(roomId, row.id, token, 'uncertain_delivery', epoch);
        continue;
      }
      const runResult = await bounded(runCall, row.root_deadline);
      if (!pumpAlive(epoch)) return;
      if (runResult === TIMED_OUT) {
        await uncertain(roomId, row.id, token, 'uncertain_timeout', epoch);
        continue;
      }
      if (!runResult.ok) {
        await uncertain(roomId, row.id, token, 'uncertain_delivery', epoch);
        continue;
      }
      try { await settle(roomId, row.id, runResult.value, token, epoch); }
      catch {
        await uncertain(roomId, row.id, token, 'uncertain_delivery', epoch);
        continue;
      }
    }
  }

  async function expireRoom(roomId) {
    return store.transact(roomId, (d) => {
      ensure(d);
      const t = now();
      let n = 0;
      for (const row of d.dispatches) {
        if (t < row.root_deadline) continue;
        if (['queued', 'waiting_approval'].includes(row.state)) {
          markFailed(d, row, 'handoff_expired', statusText('handoff_expired', row.target_agent_id), t);
          n += 1;
        } else if (['offered', 'accepted', 'running'].includes(row.state)) {
          // Expiry is not cancellation: a remote side effect may already have begun. It is uncertain.
          markUncertain(d, row, t, 'uncertain_timeout');
          n += 1;
        }
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
    handoff: runHandoff,
    drain,
    /** Mark every in-flight turn uncertain and expire queued/waiting turns past their deadline. Never runs an agent. */
    async recover() {
      pumpEpoch += 1;
      for (const record of [...pendingTimers]) record.cancel();
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
    /**
     * Explicit human continuation of uncertain work or a transport/model failure. Policy refusals
     * (handoff_limit, handoff_expired, actor_forbidden, membership/epoch changes, pause) are never retried
     * as a new turn, and retry never refunds or adds root budget.
     */
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
        if (d.owner_id !== actor.id) throw fault(403, 'Only the conversation owner may retry', 'not_conversation_owner');
        const row = d.dispatches.find((x) => x.id === dispatchId);
        if (!row || !['uncertain', 'failed'].includes(row.state)) throw notRetryable('That dispatch cannot be retried');
        if (row.counts_toward_budget === false) throw notRetryable('Policy-refused work cannot be retried as a new dispatch');
        if (row.state === 'failed' && !RETRYABLE_FAILED.has(row.code)) throw notRetryable('That failure cannot be retried');
        const t = now();
        if (t >= row.root_deadline) {
          markFailed(d, row, 'handoff_expired', statusText('handoff_expired', row.target_agent_id), t);
          return { expired: true, dispatch: publicDispatch(row) };
        }
        const reason = reservationReason(d, row, t);
        if (reason) throw fault(409, reason.text, reason.code);
        // The canonical final-message slot is retained so the new attempt revises it in place. Its old
        // attempt binding is revoked (run_token null; final_run_token belongs to the superseded attempt).
        row.state = 'queued'; row.code = null; row.error = null; row.attempts = (row.attempts ?? 0) + 1;
        row.updated_at = t; row.run_token = null;
        row.offered_at = null; row.accepted_at = null; row.started_at = null; row.finished_at = null;
        return { expired: false, dispatch: publicDispatch(row) };
      });
      if (!result.expired) void schedule(roomId).catch(() => {});
      const final = await store.snapshot(roomId);
      return { ...result, dispatch: publicDispatch((final.dispatches ?? []).find((x) => x.id === dispatchId) ?? result.dispatch) };
    },
    close() {
      if (closed) return;
      closed = true;
      localEpoch += 1;
      pumpEpoch += 1;
      for (const record of [...pendingTimers]) record.cancel();
    },
  };
}
