// Room dispatch: durable, serial, budgeted agent turns and structured handoffs.
// Delivery is a test double: targets simulate agent sockets through the same interface Task 4 will use.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
  assert.equal(calls, 1);
  assert.equal(result.dispatches.length, 1);
  assert.equal(result.dispatches[0].target_agent_id, SORA.actor_id);
  assert.equal(result.dispatches[0].state, 'completed');
  const snap = await snapshot(store, room);
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
  assert.equal(toAgent.dispatches.length, 1);
  assert.equal(toAgent.dispatches[0].target_agent_id, SUMI.actor_id);
  assert.equal(calls, 1);
  const toHuman = await submit(engine, room, 'to myself', { reply_to: human.id });
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
  assert.equal(result.dispatches.filter((d) => d.state === 'completed').length, 1);
});

test('atomic budget reservation: concurrent handoffs cannot oversubscribe a root', async (t) => {
  const { store, room, engine } = await setup(t);
  let handoffs;
  engine.register(SUMI.actor_id, { async run(ctx) {
    await ctx.say('working on it');
    handoffs = await Promise.all(['a', 'b', 'c', 'd'].map((key) => ctx.handoff({
      target_agent_id: SORA.actor_id, text: `take ${key}`, idempotency_key: `h-${key}`,
    }).then((r) => ({ key, ...r }), (e) => ({ key, error: e.code }))));
    return { text: 'starting children' };
  } });
  engine.register(SORA.actor_id, { run: async () => ({ text: 'child done' }) });

  const fan = '@Sumi fan out';
  await submit(engine, room, fan, { mentions: [mention(SUMI.actor_id, fan)] });
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
  const first = await submit(engine, room, text, { mentions: [mention(SUMI.actor_id, text)] });
  assert.equal(first.dispatches[0].state, 'waiting_approval');

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
  assert.equal(second.dispatches[0].state, 'completed', 'a human continuation starts a new root with a fresh deadline');
  rows = await dispatches(store, room);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].root_id, second.message.id);
});

test('offline and failed targets produce a visible status and never a fabricated agent answer', async (t) => {
  const { store, room, engine } = await setup(t);
  engine.register(SORA.actor_id, { online: false });
  let text = 'hello @Sora';
  const offline = await submit(engine, room, text, { mentions: [mention(SORA.actor_id, text)] });
  assert.equal(offline.dispatches[0].state, 'failed');
  assert.equal(offline.dispatches[0].code, 'agent_offline');
  let snap = await snapshot(store, room);
  assert.equal(agentMessages(snap, SORA.actor_id).length, 0);
  assert.match(systemMessages(snap).at(-1).body, /offline/i);

  engine.register(SUMI.actor_id, { run: async () => ({ failed: true, reason: 'model unavailable' }) });
  text = 'hello @Sumi';
  const failed = await submit(engine, room, text, { mentions: [mention(SUMI.actor_id, text)] });
  assert.equal(failed.dispatches[0].state, 'failed');
  assert.equal(failed.dispatches[0].code, 'agent_failed');
  snap = await snapshot(store, room);
  assert.equal(agentMessages(snap, SUMI.actor_id).length, 0);
  assert.match(systemMessages(snap).at(-1).body, /model unavailable/);
});

test('duplicates: a repeated client_id and a repeated handoff idempotency key return the existing dispatch', async (t) => {
  const { store, room, engine } = await setup(t);
  let calls = 0;
  engine.register(SORA.actor_id, { run: async () => { calls += 1; return { text: 'once' }; } });
  engine.register(SUMI.actor_id, { async run(ctx) {
    await ctx.say('root');
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
  const two = await submit(engine, room, 'hello @Sora', { mentions: [mention(SORA.actor_id, 'hello @Sora')], client_id: 'c1' });
  assert.equal(two.duplicate, true);
  assert.equal(two.message.id, one.message.id);
  assert.equal(calls, 1);

  const text = '@Sumi hand off';
  await submit(engine, room, text, { mentions: [mention(SUMI.actor_id, text)] });
  const rows = await dispatches(store, room);
  assert.equal(rows.filter((d) => d.source_dispatch_id && d.target_agent_id === SORA.actor_id).length, 1, 'duplicate key made one child');
});

test('handoff validation: self, unknown target, non-current source and forged author are refused', async (t) => {
  const { store, room, engine } = await setup(t);
  const errors = {};
  engine.register(SUMI.actor_id, { async run(ctx) {
    await ctx.say('my committed turn');
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
  assert.equal(firstCalls, 1);
  assert.equal(result.dispatches[0].state, 'uncertain');
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
  let rows = await dispatches(store, room);
  assert.equal(rows[0].state, 'uncertain');

  await restarted.retry(rows[0].id, { actor: HUMAN });
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
