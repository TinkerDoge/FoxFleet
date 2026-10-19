// Room dispatch: durable, serial, budgeted agent turns and structured handoffs.
// Delivery is a test double: targets simulate agent sockets through the same interface Task 4 will use.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { conversationStore } from '../conversation-store.js';
import { createDispatchEngine, DISPATCH_LIMITS } from '../conversation-dispatch.js';

const OWNER = { id: 'u_owner', name: 'owner' };
const SUMI = { actor_id: 'agent:sumi', name: 'Sumi' };
const SORA = { actor_id: 'agent:sora', name: 'Sora' };
const HUMAN = { kind: 'human', id: OWNER.id, name: OWNER.name };
const mention = (id, text) => {
  const name = id.slice(6);
  const at = text.toLowerCase().indexOf(('@' + name).toLowerCase());
  return { kind: 'agent', id, offset: at < 0 ? 0 : at, length: name.length + 1 };
};

async function setup(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-dispatch-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const store = conversationStore(dir);
  await store.ready();
  t.after(() => store.idle());
  const room = await store.create({ owner: OWNER, title: 'Dispatch', agents: [SUMI, SORA] });
  const clock = { t: 1_760_000_000_000 };
  const engine = createDispatchEngine({ store, now: () => clock.t, ...options });
  t.after(() => engine.close());
  return { dir, store, room, engine, clock };
}

const snapshot = (store, room) => store.snapshot(room.id);
const dispatches = async (store, room) => (await snapshot(store, room)).dispatches ?? [];
const agentMessages = (snap, id) => snap.messages.filter((m) => m.author_kind === 'agent' && m.author_id === id && !m.deleted_at && !m.system);
const systemMessages = (snap) => snap.messages.filter((m) => m.system && !m.deleted_at);

async function submit(engine, room, text, extra = {}) {
  return engine.submit(room.id, { actor: HUMAN, text, ...extra });
}

test('store gate: an agent actor must be an active member; removal is refused below HTTP', async (t) => {
  const { store, room } = await setup(t);
  const sumi = { kind: 'agent', id: SUMI.actor_id, name: SUMI.name };
  await store.send(room.id, { actor: sumi, text: 'before removal' });
  await store.removeMember(room.id, { ownerId: OWNER.id, agentId: SUMI.actor_id });
  await assert.rejects(() => store.send(room.id, { actor: sumi, text: 'after removal' }),
    (e) => e.status === 403 && e.code === 'actor_forbidden');
  const ghost = { kind: 'agent', id: 'agent:ghost', name: 'Ghost' };
  await assert.rejects(() => store.send(room.id, { actor: ghost, text: 'never joined' }),
    (e) => e.status === 403 && e.code === 'actor_forbidden');
  await store.addMember(room.id, { ownerId: OWNER.id, agent: { actor_id: SUMI.actor_id, name: 'Sumi renamed' } });
  const again = await store.send(room.id, { actor: sumi, text: 'after rejoin' });
  assert.equal(again.message.sender.id, SUMI.actor_id);
});

test('passive messages are stored, never dispatched: typed text, agent mentions and stream updates do not infer', async (t) => {
  const { store, room, engine } = await setup(t);
  let calls = 0;
  engine.register(SORA.actor_id, { run: async () => { calls += 1; return { text: 'should not run' }; } });

  await submit(engine, room, '@Sora please look'); // looks like a mention, no typed entities
  await submit(engine, room, '`@Sora` and "> @Sora"');
  await store.send(room.id, { actor: HUMAN, text: 'plain room chatter' });
  const agentTurn = { kind: 'agent', id: SUMI.actor_id, name: SUMI.name };
  const streamed = await store.send(room.id, { actor: agentTurn, text: '@Sora is handling this', mentions: [mention(SORA.actor_id, '@Sora is handling this')] });
  assert.equal(streamed.message.sender.kind, 'agent');

  const snap = await snapshot(store, room);
  assert.equal(snap.messages.length, 4);
  assert.deepEqual(snap.dispatches ?? [], []);
  assert.equal(calls, 0);
});

test('mention dispatch: one visible agent response per accepted dispatch, addressed by id even after a rename', async (t) => {
  const { store, room, engine } = await setup(t);
  let calls = 0;
  engine.register(SORA.actor_id, { async run({ dispatch }) { calls += 1; return { text: `answer for ${dispatch.target_agent_id}` }; } });

  await store.removeMember(room.id, { ownerId: OWNER.id, agentId: SORA.actor_id });
  await store.addMember(room.id, { ownerId: OWNER.id, agent: { actor_id: SORA.actor_id, name: 'Completely Different Name' } });
  const text = 'ask @Sora';
  const result = await submit(engine, room, text, { mentions: [mention(SORA.actor_id, text)] });
  await engine.drain(room.id);
  assert.equal(calls, 1);
  assert.equal(result.dispatches.length, 1);
  assert.equal(result.dispatches[0].target_agent_id, SORA.actor_id);
  const snap = await snapshot(store, room);
  assert.equal(snap.dispatches[0].state, 'completed');
  const answers = agentMessages(snap, SORA.actor_id);
  assert.equal(answers.length, 1);
  assert.equal(answers[0].body, `answer for ${SORA.actor_id}`);
  assert.equal(answers[0].dispatch_id, result.dispatches[0].id);
  assert.equal(answers[0].delivery_state, 'completed');
  assert.equal(systemMessages(snap).length, 0);
});

test('reply fallback dispatches the agent author; unaddressed replies stay passive', async (t) => {
  const { store, room, engine } = await setup(t);
  let calls = 0;
  engine.register(SUMI.actor_id, { run: async () => { calls += 1; return { text: 'reply handled' }; } });
  const sumi = { kind: 'agent', id: SUMI.actor_id, name: SUMI.name };
  const authored = (await store.send(room.id, { actor: sumi, text: 'a room update' })).message;
  const human = (await store.send(room.id, { actor: HUMAN, text: 'human update' })).message;

  const toAgent = await submit(engine, room, 'following up', { reply_to: authored.id });
  await engine.drain(room.id);
  assert.equal(toAgent.dispatches.length, 1);
  assert.equal(toAgent.dispatches[0].target_agent_id, SUMI.actor_id);
  assert.equal(calls, 1);
  const toHuman = await submit(engine, room, 'to myself', { reply_to: human.id });
  await engine.drain(room.id);
  assert.deepEqual(toHuman.dispatches, []);
  assert.equal(calls, 1);
});

test('serial multi-target queue: one active turn per room, stable agent-id order regardless of mention order', async (t) => {
  const { store, room, engine } = await setup(t);
  const log = [];
  let active = 0, maxActive = 0;
  const target = (id) => ({ async run({ dispatch }) {
    active += 1; maxActive = Math.max(maxActive, active);
    log.push(`start:${dispatch.target_agent_id}`);
    await new Promise((r) => setTimeout(r, 5));
    log.push(`end:${dispatch.target_agent_id}`);
    active -= 1;
    return { text: `done ${dispatch.target_agent_id}` };
  } });
  engine.register(SUMI.actor_id, target(SUMI.actor_id));
  engine.register(SORA.actor_id, target(SORA.actor_id));

  const text = '@Sumi then @Sora';
  const result = await submit(engine, room, text, { mentions: [mention(SUMI.actor_id, text), mention(SORA.actor_id, text)] });
  await engine.drain(room.id);
  assert.deepEqual(result.dispatches.map((d) => d.target_agent_id), [SORA.actor_id, SUMI.actor_id]);
  assert.deepEqual(log, ['start:agent:sora', 'end:agent:sora', 'start:agent:sumi', 'end:agent:sumi']);
  assert.equal(maxActive, 1);
  const rows = await dispatches(store, room);
  assert.deepEqual(rows.map((d) => [d.target_agent_id, d.state]), [[SORA.actor_id, 'completed'], [SUMI.actor_id, 'completed']]);
});

test('handoff chain: SUMI -> Sora -> SUMI succeeds inside the 4-dispatch root budget; one more is visibly refused', async (t) => {
  const { store, room, engine } = await setup(t);
  const seen = { sumi: 0, sora: 0 };
  engine.register(SUMI.actor_id, { async run() {
    seen.sumi += 1;
    if (seen.sumi === 1) return { text: 'Sumi takes it', handoff: { target_agent_id: SORA.actor_id, text: 'Sora, continue', idempotency_key: 'h-sora' } };
    return { text: 'Sumi is back', handoff: { target_agent_id: SORA.actor_id, text: 'Sora, one more', idempotency_key: 'h-sora-2' } };
  } });
  engine.register(SORA.actor_id, { async run() {
    seen.sora += 1;
    if (seen.sora === 1) return { text: 'Sora has it', handoff: { target_agent_id: SUMI.actor_id, text: 'Sumi, back to you', idempotency_key: 'h-sumi' } };
    return { text: 'Sora final', handoff: { target_agent_id: SUMI.actor_id, text: 'Sumi, one too many', idempotency_key: 'h-over' } };
  } });

  const start = '@Sumi start the chain';
  const result = await submit(engine, room, start, { mentions: [mention(SUMI.actor_id, start)] });
  await engine.drain(room.id);
  const rows = await dispatches(store, room);
  assert.deepEqual(rows.filter((d) => d.counts_toward_budget !== false).map((d) => d.target_agent_id),
    [SUMI.actor_id, SORA.actor_id, SUMI.actor_id, SORA.actor_id]);
  assert.deepEqual(rows.filter((d) => d.counts_toward_budget !== false).map((d) => d.state), ['completed', 'completed', 'completed', 'completed']);
  assert.equal(rows.filter((d) => d.counts_toward_budget === false).length, 1);
  const refused = rows.find((d) => d.counts_toward_budget === false);
  assert.equal(refused.state, 'failed');
  assert.equal(refused.code, 'handoff_limit');
  const snap = await snapshot(store, room);
  const notice = systemMessages(snap).find((m) => m.dispatch_id === refused.id);
  assert.ok(notice, 'the refusal is visible, not silent');
  assert.match(notice.body, /4 dispatches/);
  assert.equal(rows.filter((d) => result.dispatch_ids.includes(d.id) && d.state === 'completed').length, 1);
});

test('atomic budget reservation: concurrent handoffs cannot oversubscribe a root', async (t) => {
  const { store, room, engine } = await setup(t);
  let handoffs;
  engine.register(SUMI.actor_id, { async run(ctx) {
    await ctx.finalize('working on it');
    handoffs = await Promise.all(['a', 'b', 'c', 'd'].map((key) => ctx.handoff({
      target_agent_id: SORA.actor_id, text: `take ${key}`, idempotency_key: `h-${key}`,
    }).then((r) => ({ key, ...r }), (e) => ({ key, error: e.code }))));
    return { text: 'starting children' };
  } });
  engine.register(SORA.actor_id, { run: async () => ({ text: 'child done' }) });

  const fan = '@Sumi fan out';
  await submit(engine, room, fan, { mentions: [mention(SUMI.actor_id, fan)] });
  await engine.drain(room.id);
  assert.equal(handoffs.filter((h) => !h.error && !h.refused).length, 3, `only three child slots remain: ${JSON.stringify(handoffs)}`);
  assert.equal(handoffs.filter((h) => h.refused).length, 1);
  const rows = await dispatches(store, room);
  const counted = rows.filter((d) => d.counts_toward_budget !== false);
  assert.equal(counted.length, DISPATCH_LIMITS.max_handoff_dispatches_per_root);
  assert.equal(rows.filter((d) => d.target_agent_id === SORA.actor_id && d.counts_toward_budget !== false).length, 3);
  assert.equal(rows.filter((d) => d.code === 'handoff_limit').length, 1);
});

test('deadline: a waiting approval consumes wall clock; expiry is visible and needs a fresh human message', async (t) => {
  const { store, room, engine, clock } = await setup(t);
  let mode = 'wait';
  engine.register(SUMI.actor_id, { run: async () => mode === 'wait'
    ? { waiting_approval: true, reason: 'needs owner approval' }
    : { text: 'fresh turn after expiry' } });

  const text = '@Sumi deploy';
  await submit(engine, room, text, { mentions: [mention(SUMI.actor_id, text)] });
  await engine.drain(room.id);
  assert.equal((await dispatches(store, room))[0].state, 'waiting_approval');

  clock.t += DISPATCH_LIMITS.handoff_chain_ttl_ms + 1;
  await engine.expire(room.id);
  let rows = await dispatches(store, room);
  assert.equal(rows[0].state, 'failed');
  assert.equal(rows[0].code, 'handoff_expired');
  let snap = await snapshot(store, room);
  const expired = systemMessages(snap).find((m) => m.dispatch_id === rows[0].id);
  assert.ok(expired);
  assert.match(expired.body, /deadline|expired/i);

  mode = 'answer';
  const second = await submit(engine, room, text, { mentions: [mention(SUMI.actor_id, text)] });
  await engine.drain(room.id);
  rows = await dispatches(store, room);
  assert.equal(rows.find((d) => second.dispatch_ids.includes(d.id)).state, 'completed', 'a human continuation starts a new root with a fresh deadline');
  assert.equal(rows.length, 2);
  assert.equal(rows[1].root_id, second.message.id);
});

test('offline and failed targets produce a visible status and never a fabricated agent answer', async (t) => {
  const { store, room, engine } = await setup(t);
  engine.register(SORA.actor_id, { online: false });
  let text = 'hello @Sora';
  const offline = await submit(engine, room, text, { mentions: [mention(SORA.actor_id, text)] });
  await engine.drain(room.id);
  const offlineRow = (await dispatches(store, room))[0];
  assert.equal(offlineRow.state, 'failed');
  assert.equal(offlineRow.code, 'agent_offline');
  let snap = await snapshot(store, room);
  assert.equal(agentMessages(snap, SORA.actor_id).length, 0);
  assert.match(systemMessages(snap).at(-1).body, /offline/i);

  engine.register(SUMI.actor_id, { run: async () => ({ failed: true, reason: 'model unavailable' }) });
  text = 'hello @Sumi';
  const failed = await submit(engine, room, text, { mentions: [mention(SUMI.actor_id, text)] });
  await engine.drain(room.id);
  const failedRow = (await dispatches(store, room)).at(-1);
  assert.equal(failedRow.state, 'failed');
  assert.equal(failedRow.code, 'agent_failed');
  snap = await snapshot(store, room);
  assert.equal(agentMessages(snap, SUMI.actor_id).length, 0);
  assert.match(systemMessages(snap).at(-1).body, /model unavailable/);
});

test('duplicates: a repeated client_id and a repeated handoff idempotency key return the existing dispatch', async (t) => {
  const { store, room, engine } = await setup(t);
  let calls = 0;
  engine.register(SORA.actor_id, { run: async () => { calls += 1; return { text: 'once' }; } });
  engine.register(SUMI.actor_id, { async run(ctx) {
    await ctx.finalize('root');
    const a = await ctx.handoff({ target_agent_id: SORA.actor_id, text: 'take over', idempotency_key: 'same' });
    const b = await ctx.handoff({ target_agent_id: SORA.actor_id, text: 'take over', idempotency_key: 'same' });
    assert.equal(b.duplicate, true);
    assert.equal(b.dispatch.id, a.dispatch.id);
    const c = await ctx.handoff({ target_agent_id: SORA.actor_id, text: 'take over' });
    const d = await ctx.handoff({ target_agent_id: SORA.actor_id, text: 'take over' });
    assert.equal(c.duplicate, true);
    assert.equal(d.duplicate, true);
    assert.equal(d.dispatch.id, a.dispatch.id, 'the same source/target/text is one handoff');
    return { text: 'sumi done' };
  } });

  const one = await submit(engine, room, 'hello @Sora', { mentions: [mention(SORA.actor_id, 'hello @Sora')], client_id: 'c1' });
  await engine.drain(room.id);
  const two = await submit(engine, room, 'hello @Sora', { mentions: [mention(SORA.actor_id, 'hello @Sora')], client_id: 'c1' });
  assert.equal(two.duplicate, true);
  assert.equal(two.message.id, one.message.id);
  assert.equal(calls, 1);

  const text = '@Sumi hand off';
  await submit(engine, room, text, { mentions: [mention(SUMI.actor_id, text)] });
  await engine.drain(room.id);
  const rows = await dispatches(store, room);
  assert.equal(rows.filter((d) => d.source_dispatch_id && d.target_agent_id === SORA.actor_id).length, 1, 'duplicate key made one child');
});

test('handoff validation: self, unknown target, non-current source and forged author are refused', async (t) => {
  const { store, room, engine } = await setup(t);
  const errors = {};
  engine.register(SUMI.actor_id, { async run(ctx) {
    await ctx.finalize('my committed turn');
    const check = async (name, fn) => { try { await fn(); errors[name] = 'accepted'; } catch (e) { errors[name] = e.code; } };
    await check('self', () => ctx.handoff({ target_agent_id: SUMI.actor_id, text: 'me' }));
    await check('unknown', () => ctx.handoff({ target_agent_id: 'agent:ghost', text: 'ghost' }));
    await check('missingSource', () => engine.handoff(room.id, { actor: { kind: 'agent', id: SUMI.actor_id, name: 'Sumi' }, source_message_id: 'fm_AAAAAAAAAAAAAAAA', target_agent_id: SORA.actor_id, text: 'bad' }));
    const human = (await store.send(room.id, { actor: HUMAN, text: 'human source' })).message;
    await check('forged', () => engine.handoff(room.id, { actor: { kind: 'agent', id: SUMI.actor_id, name: 'Sumi' }, source_message_id: human.id, target_agent_id: SORA.actor_id, text: 'bad' }));
    return { text: 'done' };
  } });
  const text = '@Sumi start';
  await submit(engine, room, text, { mentions: [mention(SUMI.actor_id, text)] });
  await engine.drain(room.id);
  assert.deepEqual(errors, {
    self: 'handoff_self', unknown: 'handoff_not_found', missingSource: 'handoff_not_found', forged: 'handoff_not_found',
  });
  const rows = await dispatches(store, room);
  assert.equal(rows.length, 1, 'no refused handoff created a child dispatch');
  // Once the source dispatch is terminal it is no longer a current binding.
  const snap = await snapshot(store, room);
  const source = snap.messages.find((m) => m.author_id === SUMI.actor_id && m.body === 'my committed turn');
  await assert.rejects(() => engine.handoff(room.id, { actor: { kind: 'agent', id: SUMI.actor_id, name: 'Sumi' }, source_message_id: source.id, target_agent_id: SORA.actor_id, text: 'late' }),
    (e) => e.code === 'handoff_not_found');
});

test('crash window: an in-flight turn becomes uncertain, never re-executes, and only a human retry runs it again', async (t) => {
  const { store, room, engine } = await setup(t);
  let firstCalls = 0;
  engine.register(SUMI.actor_id, { async run() { firstCalls += 1; throw new Error('socket lost'); } });
  const text = '@Sumi go';
  const result = await submit(engine, room, text, { mentions: [mention(SUMI.actor_id, text)] });
  await engine.drain(room.id);
  assert.equal(firstCalls, 1);
  let rows = await dispatches(store, room);
  assert.equal(rows.find((d) => result.dispatch_ids.includes(d.id)).state, 'uncertain');
  let snap = await snapshot(store, room);
  assert.match(systemMessages(snap).at(-1).body, /uncertain|retry/i);

  // A new process cannot re-run an uncertain turn by itself.
  let secondCalls = 0;
  const restarted = createDispatchEngine({ store, now: () => 1_760_000_000_000 });
  t.after(() => restarted.close());
  restarted.register(SUMI.actor_id, { run: async () => { secondCalls += 1; return { text: 'recovered' }; } });
  await restarted.recover();
  await restarted.drain(room.id);
  assert.equal(secondCalls, 0);
  rows = await dispatches(store, room);
  assert.equal(rows[0].state, 'uncertain');

  await restarted.retry(rows[0].id, { actor: HUMAN });
  await restarted.drain(room.id);
  assert.equal(secondCalls, 1);
  rows = await dispatches(store, room);
  assert.equal(rows[0].state, 'completed');
  snap = await snapshot(store, room);
  assert.equal(agentMessages(snap, SUMI.actor_id).at(-1).body, 'recovered');
  await assert.rejects(() => restarted.retry(rows[0].id, { actor: HUMAN }), (e) => e.status === 409);
});

test('dispatches are durable room records with fd_ ids, root/parent/generation/context binding and deadlines', async (t) => {
  const { store, room, engine } = await setup(t);
  engine.register(SUMI.actor_id, { run: async () => ({ text: 'ok' }) });
  const text = '@Sumi inspect';
  await submit(engine, room, text, { mentions: [mention(SUMI.actor_id, text)] });
  await engine.drain(room.id);
  const [row] = await dispatches(store, room);
  assert.match(row.id, /^fd_[A-Za-z0-9_-]{16}$/);
  assert.equal(row.root_id.length > 0, true);
  assert.equal(row.request_message_id, row.root_id);
  assert.equal(row.epoch, 1);
  assert.equal(row.membership_generation, 1);
  assert.equal(typeof row.context_through_seq, 'number');
  assert.equal(row.root_deadline, 1_760_000_000_000 + DISPATCH_LIMITS.handoff_chain_ttl_ms);
  assert.equal(row.counts_toward_budget, true);
});

// --- Task 3 corrective regressions -------------------------------------------------

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const publicMessages = async (store, room) => (await store.messages(room.id, { device: 'd', limit: 500 })).messages;
const agentAnswers = (page) => page.filter((m) => m.sender.kind === 'agent' && !m.system);
const arrival = (submitting, reached) => {
  let timer;
  return Promise.race([
    reached.promise.then(() => 'reached'),
    submitting.then(() => new Promise(() => {}), () => 'failed'),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the run did not reach the controlled stage')), 2000); }),
  ]).finally(() => clearTimeout(timer));
};
const rowById = async (store, room, id) => (await dispatches(store, room)).find((d) => d.id === id);

test('owner authority: a non-owner human is refused at the engine and store boundary without side effects', async (t) => {
  const { store, room, engine } = await setup(t);
  const intruder = { kind: 'human', id: 'u_not_owner', name: 'Not owner' };
  await assert.rejects(() => engine.submit(room.id, { actor: intruder, text: 'do this' }),
    (e) => e.status === 403 && e.code === 'not_conversation_owner');
  await assert.rejects(() => store.send(room.id, { actor: intruder, text: 'do this' }),
    (e) => e.status === 403 && e.code === 'not_conversation_owner');
  let snap = await snapshot(store, room);
  assert.equal(snap.messages.length, 0);
  assert.equal((snap.dispatches ?? []).length, 0);
  assert.equal(snap.outbox.length, 0);

  engine.register(SUMI.actor_id, { run: async () => ({ text: 'owner speak' }) });
  const text = '@Sumi owner request';
  const result = await submit(engine, room, text, { mentions: [mention(SUMI.actor_id, text)] });
  await engine.drain(room.id);
  snap = await snapshot(store, room);
  assert.equal(result.message.sender.id, OWNER.id);
  assert.equal(snap.messages.filter((m) => m.author_kind === 'human').length, 1);
  assert.equal((snap.dispatches ?? []).length, 1);
  assert.equal((snap.dispatches ?? [])[0].state, 'completed');
});

test('membership TOCTOU: removal during an async offer prevents execution and publication', async (t) => {
  const { store, room, engine } = await setup(t);
  const reached = deferred(), release = deferred();
  t.after(() => release.resolve());
  let calls = 0;
  engine.register(SUMI.actor_id, {
    async offer() {
      reached.resolve();
      await release.promise;
      await store.removeMember(room.id, { ownerId: OWNER.id, agentId: SUMI.actor_id });
      return { accepted: true };
    },
    async run() { calls += 1; return { text: 'stale answer' }; },
  });
  const text = '@Sumi review';
  const submitting = submit(engine, room, text, { mentions: [mention(SUMI.actor_id, text)] });
  await reached.promise;
  release.resolve();
  await submitting;
  await engine.drain(room.id);
  const [row] = await dispatches(store, room);
  assert.equal(calls, 0);
  assert.equal(row.state, 'failed');
  assert.equal(row.code, 'actor_forbidden');
  const page = await publicMessages(store, room);
  assert.equal(agentAnswers(page).length, 0);
  const notice = page.find((m) => m.dispatch_id === row.id);
  assert.equal(notice.system, true);
  assert.equal(notice.code, 'actor_forbidden');
});

test('membership generation: remove and rejoin during an async offer invalidates the reservation', async (t) => {
  const { store, room, engine } = await setup(t);
  const reached = deferred(), release = deferred();
  t.after(() => release.resolve());
  let calls = 0;
  engine.register(SUMI.actor_id, {
    async offer() {
      reached.resolve();
      await release.promise;
      await store.removeMember(room.id, { ownerId: OWNER.id, agentId: SUMI.actor_id });
      await store.addMember(room.id, { ownerId: OWNER.id, agent: { actor_id: SUMI.actor_id, name: 'Sumi again' } });
      return { accepted: true };
    },
    async run() { calls += 1; return { text: 'stale answer' }; },
  });
  const text = '@Sumi review';
  const submitting = submit(engine, room, text, { mentions: [mention(SUMI.actor_id, text)] });
  await reached.promise;
  release.resolve();
  await submitting;
  await engine.drain(room.id);
  const [row] = await dispatches(store, room);
  assert.equal(calls, 0);
  assert.equal(row.state, 'failed');
  assert.equal(row.code, 'membership_changed');
});

test('epoch mutation during an async offer invalidates the reservation', async (t) => {
  const { store, room, engine } = await setup(t);
  const reached = deferred(), release = deferred();
  t.after(() => release.resolve());
  let calls = 0;
  engine.register(SUMI.actor_id, {
    async offer() { reached.resolve(); await release.promise; return { accepted: true }; },
    async run() { calls += 1; return { text: 'stale answer' }; },
  });
  const text = '@Sumi review';
  const submitting = submit(engine, room, text, { mentions: [mention(SUMI.actor_id, text)] });
  await reached.promise;
  await store.transact(room.id, (d) => { d.epoch += 1; });
  release.resolve();
  await submitting;
  await engine.drain(room.id);
  const [row] = await dispatches(store, room);
  assert.equal(calls, 0);
  assert.equal(row.state, 'failed');
  assert.equal(row.code, 'epoch_changed');
});

test('pause during an async offer holds the turn queued until the queue resumes', async (t) => {
  const { store, room, engine } = await setup(t);
  const reached = deferred(), release = deferred();
  t.after(() => release.resolve());
  let calls = 0;
  engine.register(SUMI.actor_id, {
    async offer() { reached.resolve(); await release.promise; return { accepted: true }; },
    async run() { calls += 1; return { text: 'after resume' }; },
  });
  const text = '@Sumi review';
  const submitting = submit(engine, room, text, { mentions: [mention(SUMI.actor_id, text)] });
  await reached.promise;
  await store.transact(room.id, (d) => { d.paused = true; });
  release.resolve();
  await submitting;
  await engine.drain(room.id);
  let [row] = await dispatches(store, room);
  assert.equal(calls, 0);
  assert.equal(row.state, 'queued');

  await store.transact(room.id, (d) => { d.paused = false; });
  await engine.drain(room.id);
  [row] = await dispatches(store, room);
  assert.equal(calls, 1);
  assert.equal(row.state, 'completed');
});

test('stale execution cannot publish after an epoch change', async (t) => {
  const { store, room, engine } = await setup(t);
  const reached = deferred(), release = deferred();
  t.after(() => release.resolve());
  const errors = {};
  engine.register(SUMI.actor_id, {
    async run(ctx) {
      await ctx.finalize('committed before the change');
      reached.resolve();
      await release.promise;
      try { await ctx.say('late partial'); } catch (e) { errors.say = e.code; }
      try { await ctx.handoff({ target_agent_id: SORA.actor_id, text: 'late handoff' }); } catch (e) { errors.handoff = e.code; }
      try { await ctx.finalize('late final'); } catch (e) { errors.finalize = e.code; }
      return { text: 'late outcome' };
    },
  });
  const text = '@Sumi start';
  const submitting = submit(engine, room, text, { mentions: [mention(SUMI.actor_id, text)] });
  assert.equal(await arrival(submitting, reached), 'reached', 'the run must reach the controlled stage');
  await store.transact(room.id, (d) => { d.epoch += 1; });
  release.resolve();
  await submitting;
  await engine.drain(room.id);
  const [row] = await dispatches(store, room);
  assert.deepEqual(errors, { say: 'epoch_changed', handoff: 'epoch_changed', finalize: 'epoch_changed' });
  assert.equal(row.state, 'failed');
  assert.equal(row.code, 'epoch_changed');
  const page = await publicMessages(store, room);
  assert.deepEqual(agentAnswers(page).map((m) => m.text), ['committed before the change']);
  assert.equal(page.find((m) => m.system && m.dispatch_id === row.id).system, true);
});

test('stale execution cannot publish while the room queue is paused', async (t) => {
  const { store, room, engine } = await setup(t);
  const reached = deferred(), release = deferred();
  t.after(() => release.resolve());
  const errors = {};
  engine.register(SUMI.actor_id, {
    async run(ctx) {
      await ctx.finalize('committed before pause');
      reached.resolve();
      await release.promise;
      try { await ctx.say('late partial'); } catch (e) { errors.say = e.code; }
      try { await ctx.handoff({ target_agent_id: SORA.actor_id, text: 'late handoff' }); } catch (e) { errors.handoff = e.code; }
      return { text: 'late outcome' };
    },
  });
  const text = '@Sumi start';
  const submitting = submit(engine, room, text, { mentions: [mention(SUMI.actor_id, text)] });
  assert.equal(await arrival(submitting, reached), 'reached', 'the run must reach the controlled stage');
  await store.transact(room.id, (d) => { d.paused = true; });
  release.resolve();
  await submitting;
  await engine.drain(room.id);
  assert.deepEqual(errors, { say: 'room_paused', handoff: 'room_paused' });
  const [row] = await dispatches(store, room);
  assert.equal(row.state, 'failed');
  assert.equal(row.code, 'room_paused');
  const page = await publicMessages(store, room);
  assert.deepEqual(agentAnswers(page).map((m) => m.text), ['committed before pause']);
});

test('handoff idempotency is scoped to caller and dispatch; conflicting reuse and partial sources are refused', async (t) => {
  const { store, room, engine } = await setup(t);
  let sumiFinal;
  const errors = {};
  let sumiRuns = 0;
  engine.register(SUMI.actor_id, { async run(ctx) {
    sumiRuns += 1;
    if (sumiRuns > 1) return { text: 'sumi follow-up' };
    const partial = await ctx.say('still partial');
    try { await ctx.handoff({ target_agent_id: SORA.actor_id, text: 'partial source' }); } catch (e) { errors.partial = e.code; }
    try { await ctx.handoff({ source_message_id: partial.id, target_agent_id: SORA.actor_id, text: 'explicit partial' }); } catch (e) { errors.explicitPartial = e.code; }
    sumiFinal = (await ctx.finalize('sumi committed')).id;
    const first = await ctx.handoff({ target_agent_id: SORA.actor_id, text: 'take this', idempotency_key: 'shared' });
    errors.scoped = first.dispatch.id;
    try { await ctx.handoff({ target_agent_id: SORA.actor_id, text: 'different text', idempotency_key: 'shared' }); } catch (e) { errors.conflict = e.code; }
    const again = await ctx.handoff({ target_agent_id: SORA.actor_id, text: 'take this', idempotency_key: 'shared' });
    assert.equal(again.duplicate, true);
    assert.equal(again.dispatch.id, first.dispatch.id);
    return { text: 'sumi done' };
  } });
  engine.register(SORA.actor_id, { async run(ctx) {
    await ctx.finalize('sora committed');
    const own = await ctx.handoff({ target_agent_id: SUMI.actor_id, text: 'back to sumi', idempotency_key: 'shared' });
    errors.own = own.dispatch.id;
    try {
      await engine.handoff(room.id, {
        actor: { kind: 'agent', id: SORA.actor_id, name: 'Sora' },
        source_message_id: sumiFinal, target_agent_id: SUMI.actor_id,
        text: 'forged reuse', idempotency_key: 'shared',
      });
    } catch (e) { errors.forged = e.code; }
    return { text: 'sora done' };
  } });
  const text = '@Sumi start';
  await submit(engine, room, text, { mentions: [mention(SUMI.actor_id, text)] });
  await engine.drain(room.id);
  assert.equal(errors.partial, 'handoff_not_final');
  assert.equal(errors.explicitPartial, 'handoff_not_final');
  assert.equal(errors.conflict, 'idempotency_conflict');
  assert.equal(errors.forged, 'handoff_not_found');
  assert.ok(errors.scoped);
  assert.ok(errors.own);
  assert.notEqual(errors.scoped, errors.own, 'the same key from another dispatch is a different handoff');
  const rows = await dispatches(store, room);
  assert.equal(rows.filter((d) => d.source_dispatch_id && d.target_agent_id === SORA.actor_id && d.counts_toward_budget !== false).length, 1);
  assert.equal(rows.filter((d) => d.source_dispatch_id && d.target_agent_id === SUMI.actor_id && d.counts_toward_budget !== false).length, 1);
});

test('retry refuses quota-refused work: no fifth dispatch and no refunded budget', async (t) => {
  const { store, room, engine } = await setup(t);
  let soraCalls = 0;
  engine.register(SUMI.actor_id, { async run(ctx) {
    await ctx.finalize('fanning out');
    for (const key of ['a', 'b', 'c', 'd']) {
      await ctx.handoff({ target_agent_id: SORA.actor_id, text: `take ${key}`, idempotency_key: `h-${key}` });
    }
    return { text: 'root done' };
  } });
  engine.register(SORA.actor_id, { run: async () => { soraCalls += 1; return { text: 'child done' }; } });
  const text = '@Sumi fan out';
  await submit(engine, room, text, { mentions: [mention(SUMI.actor_id, text)] });
  await engine.drain(room.id);
  const rows = await dispatches(store, room);
  const refused = rows.find((d) => d.code === 'handoff_limit');
  assert.ok(refused);
  assert.equal(refused.counts_toward_budget, false);
  const before = soraCalls;
  await assert.rejects(() => engine.retry(refused.id, { actor: HUMAN }),
    (e) => e.status === 409 && e.code === 'dispatch_not_retryable');
  await engine.drain(room.id);
  const after = await rowById(store, room, refused.id);
  assert.equal(soraCalls, before);
  assert.equal(after.state, 'failed');
  assert.equal(after.counts_toward_budget, false);
});

test('retry revalidates epoch, membership generation, deadline and owner under the room lock', async (t) => {
  const { store, room, engine, clock } = await setup(t);
  let calls = 0;
  engine.register(SUMI.actor_id, { run: async () => { calls += 1; throw new Error('socket lost'); } });
  const text = '@Sumi go';
  await submit(engine, room, text, { mentions: [mention(SUMI.actor_id, text)] });
  await engine.drain(room.id);
  let [row] = await dispatches(store, room);
  assert.equal(row.state, 'uncertain');

  await store.transact(room.id, (d) => { d.epoch += 1; });
  await assert.rejects(() => engine.retry(row.id, { actor: HUMAN }),
    (e) => e.status === 409 && e.code === 'epoch_changed');
  await assert.rejects(() => engine.retry(row.id, { actor: { kind: 'human', id: 'u_not_owner', name: 'Nope' } }),
    (e) => e.status === 403 && e.code === 'not_conversation_owner');
  assert.equal(calls, 1);
  assert.equal((await rowById(store, room, row.id)).state, 'uncertain');

  await store.transact(room.id, (d) => { d.epoch = row.epoch; });
  await store.removeMember(room.id, { ownerId: OWNER.id, agentId: SUMI.actor_id });
  await store.addMember(room.id, { ownerId: OWNER.id, agent: { actor_id: SUMI.actor_id, name: 'Sumi again' } });
  await assert.rejects(() => engine.retry(row.id, { actor: HUMAN }),
    (e) => e.status === 409 && e.code === 'membership_changed');
  assert.equal(calls, 1);

  clock.t = row.root_deadline + 1;
  const expired = await engine.retry(row.id, { actor: HUMAN });
  assert.equal(expired.expired, true);
  await engine.drain(room.id);
  [row] = await dispatches(store, room);
  assert.equal(row.state, 'failed');
  assert.equal(row.code, 'handoff_expired');
  assert.equal(calls, 1);
});

test('admission is atomic: a lost admission transaction leaves no addressed message without intent', async (t) => {
  const { dir, store, room, engine } = await setup(t);
  let calls = 0;
  engine.register(SUMI.actor_id, { run: async () => { calls += 1; return { text: 'ok' }; } });
  const firstText = '@Sumi first';
  const first = await submit(engine, room, firstText, { mentions: [mention(SUMI.actor_id, firstText)], client_id: 'same' });
  const second = await submit(engine, room, firstText, { mentions: [mention(SUMI.actor_id, firstText)], client_id: 'same' });
  assert.equal(second.duplicate, true);
  await engine.drain(room.id);
  assert.equal(calls, 1);
  let snap = await snapshot(store, room);
  assert.equal(snap.messages.filter((m) => m.author_kind === 'human').length, 1);
  assert.equal((snap.dispatches ?? []).length, 1);

  const file = path.join(dir, `${room.id}.json`);
  const disk = JSON.parse(await readFile(file, 'utf8'));
  const human = disk.messages.find((m) => m.author_kind === 'human');
  const row = disk.dispatches.find((d) => d.request_message_id === human.id);
  assert.ok(row, 'the message and its dispatch intent commit together');
  assert.equal(row.target_agent_id, SUMI.actor_id);

  const originalTransact = store.transact.bind(store);
  const originalSnapshot = store.snapshot.bind(store);
  let injected = false;
  store.transact = async (id, fn) => {
    if (!injected) {
      const state = await originalSnapshot(id);
      const lost = state.messages.some((m) => m.author_kind === 'human'
        && !(state.dispatches ?? []).some((d) => d.request_message_id === m.id));
      if (lost) {
        injected = true;
        throw Object.assign(new Error('injected admission failure'), { status: 503, code: 'bot_store_unavailable', safe: true });
      }
    }
    return originalTransact(id, fn);
  };
  let failure = null;
  try {
    await submit(engine, room, '@Sumi injected', { mentions: [mention(SUMI.actor_id, '@Sumi injected')], client_id: 'injected' });
  } catch (e) { failure = e; }
  snap = await snapshot(store, room);
  const addressedWithoutIntent = snap.messages.filter((m) => m.author_kind === 'human'
    && !(snap.dispatches ?? []).some((d) => d.request_message_id === m.id));
  if (failure) assert.deepEqual(addressedWithoutIntent, [], 'a failed admission leaves no addressed message behind');
  else assert.equal((snap.dispatches ?? []).some((d) => d.request_message_id === snap.messages.at(-1).id), true);

  const before = await snapshot(store, room);
  await rm(file);
  await mkdir(file);
  await assert.rejects(() => submit(engine, room, '@Sumi disk', { mentions: [mention(SUMI.actor_id, '@Sumi disk')] }),
    (e) => e.status === 503);
  const after = await snapshot(store, room);
  assert.deepEqual(after.messages, before.messages);
  assert.deepEqual(after.dispatches, before.dispatches);
  assert.deepEqual(after.outbox, before.outbox);
});

test('submission returns a durable receipt before a deferred run finishes; drain is the wait', { timeout: 5000 }, async (t) => {
  const { store, room, engine } = await setup(t);
  const started = deferred(), release = deferred();
  t.after(() => release.resolve());
  let calls = 0;
  engine.register(SUMI.actor_id, { async run() {
    calls += 1; started.resolve(); await release.promise; return { text: 'delayed answer' };
  } });
  const text = '@Sumi delayed';
  let timer;
  const receipt = await Promise.race([
    submit(engine, room, text, { mentions: [mention(SUMI.actor_id, text)] }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('admission waited for the run')), 1000); }),
  ]).finally(() => clearTimeout(timer));
  assert.equal(receipt.dispatches.length, 1);
  assert.ok(['queued', 'offered', 'accepted', 'running'].includes(receipt.dispatches[0].state));
  assert.equal(receipt.dispatch_ids.length, 1);
  await started.promise;
  assert.equal(calls, 1);
  const during = await rowById(store, room, receipt.dispatch_ids[0]);
  assert.equal(during.state, 'running');
  release.resolve();
  await engine.drain(room.id);
  const done = await rowById(store, room, receipt.dispatch_ids[0]);
  assert.equal(done.state, 'completed');
});

test('recovery does not run queued descendants of an uncertain dispatch without owner continuation', async (t) => {
  const { store, room, engine } = await setup(t);
  let soraCalls = 0;
  engine.register(SUMI.actor_id, { async run(ctx) {
    await ctx.finalize('taking this');
    await ctx.handoff({ target_agent_id: SORA.actor_id, text: 'Sora, take over' });
    throw new Error('socket lost after handoff');
  } });
  engine.register(SORA.actor_id, { run: async () => { soraCalls += 1; return { text: 'child' }; } });
  const text = '@Sumi start';
  await submit(engine, room, text, { mentions: [mention(SUMI.actor_id, text)] });
  await engine.drain(room.id);
  const rows = await dispatches(store, room);
  const parent = rows.find((d) => d.target_agent_id === SUMI.actor_id && !d.source_dispatch_id);
  const child = rows.find((d) => d.source_dispatch_id === parent.id);
  assert.equal(parent.state, 'uncertain');
  assert.equal(child.state, 'queued');
  assert.equal(soraCalls, 0);

  const restarted = createDispatchEngine({ store, now: () => 1_760_000_000_000 });
  t.after(() => restarted.close());
  restarted.register(SORA.actor_id, { run: async () => { soraCalls += 1; return { text: 'child' }; } });
  await restarted.recover();
  await restarted.drain(room.id);
  assert.equal(soraCalls, 0, 'queued descendants of uncertain work stay blocked');
  assert.equal((await rowById(store, room, child.id)).state, 'queued');

  restarted.register(SUMI.actor_id, { run: async () => ({ text: 'owner continued the root' }) });
  await restarted.retry(parent.id, { actor: HUMAN });
  await restarted.drain(room.id);
  assert.equal(soraCalls, 1, 'the owner continuation unblocks the dependent child');
  assert.equal((await rowById(store, room, parent.id)).state, 'completed');
  assert.equal((await rowById(store, room, child.id)).state, 'completed');
});

test('queue fairness: target-id order only orders recipients inside one root, never older unrelated roots', async (t) => {
  const { store, room, engine } = await setup(t);
  const order = [];
  engine.register(SUMI.actor_id, { run: async () => { order.push('sumi'); return { text: 'sumi' }; } });
  engine.register(SORA.actor_id, { run: async () => { order.push('sora'); return { text: 'sora' }; } });
  await store.transact(room.id, (d) => { d.paused = true; });
  const older = '@Sumi older root';
  const newer = '@Sora newer root';
  await submit(engine, room, older, { mentions: [mention(SUMI.actor_id, older)] });
  await submit(engine, room, newer, { mentions: [mention(SORA.actor_id, newer)] });
  assert.deepEqual(order, [], 'a paused queue runs nothing');
  await store.transact(room.id, (d) => { d.paused = false; });
  await engine.drain(room.id);
  assert.deepEqual(order, ['sumi', 'sora'], 'the older root drains first even though its target id sorts later');
});

test('hub status notices keep system/code provenance in the public projection and never route', async (t) => {
  const { store, room, engine } = await setup(t);
  engine.register(SORA.actor_id, { online: false });
  const text = '@Sora hello';
  await submit(engine, room, text, { mentions: [mention(SORA.actor_id, text)] });
  await engine.drain(room.id);
  const page = await publicMessages(store, room);
  const notice = page.find((m) => m.text.includes('offline'));
  assert.ok(notice);
  assert.equal(notice.system, true);
  assert.equal(notice.code, 'agent_offline');
  assert.equal(agentAnswers(page).length, 0, 'a hub notice is not an agent answer');
  const reply = await submit(engine, room, 'following up', { reply_to: notice.id });
  await engine.drain(room.id);
  assert.deepEqual(reply.dispatches, [], 'replying to a hub notice never routes to an agent');
});

test('agent text limits: say, finalize, handoff and outcome reject oversized or NUL text', async (t) => {
  const { store, room, engine } = await setup(t);
  const max = store.limits.max_text_bytes;
  const errors = {};
  engine.register(SUMI.actor_id, { async run(ctx) {
    const check = async (name, fn) => { try { await fn(); errors[name] = 'accepted'; } catch (e) { errors[name] = e.code; } };
    await check('sayLong', () => ctx.say('a'.repeat(max + 1)));
    await check('sayNul', () => ctx.say('a\u0000b'));
    await check('finalizeLong', () => ctx.finalize('a'.repeat(max + 1)));
    await check('finalizeNul', () => ctx.finalize('a\u0000b'));
    await ctx.finalize('ok');
    await check('handoffLong', () => ctx.handoff({ target_agent_id: SORA.actor_id, text: 'a'.repeat(max + 1) }));
    await check('handoffNul', () => ctx.handoff({ target_agent_id: SORA.actor_id, text: 'a\u0000b' }));
    return { text: 'a'.repeat(max + 1) };
  } });
  const text = '@Sumi limits';
  await submit(engine, room, text, { mentions: [mention(SUMI.actor_id, text)] });
  await engine.drain(room.id);
  assert.deepEqual(errors, {
    sayLong: 'invalid_request',
    sayNul: 'invalid_request',
    finalizeLong: 'invalid_request',
    finalizeNul: 'invalid_request',
    handoffLong: 'invalid_request',
    handoffNul: 'invalid_request',
  });
  const [row] = await dispatches(store, room);
  assert.equal(row.state, 'failed');
  assert.equal(row.code, 'invalid_request');
  const page = await publicMessages(store, room);
  assert.equal(page.some((m) => m.text.length > max), false);
  assert.deepEqual(agentAnswers(page).map((m) => m.text), ['ok']);
});
