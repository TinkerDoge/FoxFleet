// Room Stop/Resume: epoch fencing, durable cancellation, truthful per-agent stop statuses and restart safety.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { conversationStore } from '../conversation-store.js';
import { createDispatchEngine } from '../conversation-dispatch.js';
import { bootBot } from './bot-helpers.js';

const OWNER = { id: 'u_owner', name: 'owner' };
const HUMAN = { kind: 'human', id: OWNER.id, name: OWNER.name };
const SUMI = { actor_id: 'agent:sumi', name: 'Sumi' };
const SORA = { actor_id: 'agent:sora', name: 'Sora' };
const mention = (id, text) => {
  const at = text.toLowerCase().indexOf('@' + id.slice(6).toLowerCase());
  return { kind: 'agent', id, offset: at < 0 ? 0 : at, length: id.slice(6).length + 1 };
};

async function setup(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-stop-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const store = conversationStore(dir);
  await store.ready();
  t.after(() => store.idle());
  const room = await store.create({ owner: OWNER, title: 'Stop', agents: [SUMI, SORA] });
  const other = await store.create({ owner: OWNER, title: 'Other', agents: [SUMI, SORA] });
  const clock = { t: 1_760_000_000_000 };
  const engine = createDispatchEngine({ store, now: () => clock.t, stopWaitMs: 50, ...options });
  t.after(() => engine.close());
  return { dir, store, room, other, engine, clock };
}

const snapshot = (store, room) => store.snapshot(room.id);
const dispatches = async (store, room) => (await snapshot(store, room)).dispatches ?? [];
const rowsFor = async (store, room, id) => (await dispatches(store, room)).filter((d) => d.target_agent_id === id);
const publicMessages = async (store, room) => (await store.messages(room.id, { device: 'd', limit: 500 })).messages;
const submit = (engine, room, text, extra = {}) => engine.submit(room.id, { actor: HUMAN, text, ...extra });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const capture = async (promise) => {
  try { await promise; return 'accepted'; } catch (e) { return e.code; }
};

test('owner-only: a non-owner stop or resume is refused with no durable change', async (t) => {
  const { store, room, engine } = await setup(t);
  const before = await snapshot(store, room);
  for (const fn of ['stop', 'resume']) {
    await assert.rejects(() => engine[fn](room.id, { actor: { kind: 'human', id: 'u_someone_else', name: 'x' } }),
      (e) => e.status === 403 && e.code === 'not_conversation_owner');
    await assert.rejects(() => engine[fn]('fc_AAAAAAAAAAAAAAAA', { actor: HUMAN }),
      (e) => e.status === 404);
  }
  const after = await snapshot(store, room);
  assert.equal(after.epoch, before.epoch);
  assert.equal(after.paused, before.paused);
});

test('stop increments the epoch, pauses and cancels queued work and waiting approvals', async (t) => {
  const { store, room, engine } = await setup(t);
  const reached = deferred(), release = deferred();
  let released = false;
  t.after(() => { if (!released) { released = true; release.resolve(); } });
  engine.register(SUMI.actor_id, {
    run: async () => { reached.resolve(); await release.promise; return { text: 'late sumi' }; },
    cancel: async () => ({ state: 'stopped' }),
  });
  const text = '@Sumi first';
  const submitting = submit(engine, room, text, { mentions: [mention(SUMI.actor_id, text)] });
  await reached.promise;
  const sText = '@Sora queued';
  await submit(engine, room, sText, { mentions: [mention(SORA.actor_id, sText)] });
  const queued = (await rowsFor(store, room, SORA.actor_id))[0];
  assert.equal(queued.state, 'queued');

  const stopped = await engine.stop(room.id, { actor: HUMAN });
  assert.equal(stopped.confirmed, true);
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.epoch, 2);
  assert.equal(stopped.paused, true);
  assert.equal(stopped.agents[SUMI.actor_id], 'stopped');
  assert.equal(stopped.agents[SORA.actor_id], 'stopped');

  const rows = await dispatches(store, room);
  const sumi = rows.find((d) => d.target_agent_id === SUMI.actor_id);
  const sora = rows.find((d) => d.target_agent_id === SORA.actor_id);
  assert.equal(sumi.state, 'cancelled');
  assert.equal(sora.state, 'cancelled');
  assert.equal(sora.code, 'room_stopped');

  release.resolve(); released = true;
  await submitting;
  await engine.drain(room.id);
  assert.deepEqual((await publicMessages(store, room)).filter((m) => m.sender.kind === 'agent' && !m.system), []);
});

test('a running turn is fenced: cancellation is requested, a partial stays visible as interrupted and late output is rejected', async (t) => {
  const { store, room, engine } = await setup(t);
  const reached = deferred(), release = deferred();
  t.after(() => release.resolve());
  let ctx = null;
  const calls = [];
  engine.register(SUMI.actor_id, {
    async run(context) {
      ctx = context;
      await context.say('visible partial');
      reached.resolve();
      await release.promise;
      calls.push(await capture(context.say('late partial')));
      calls.push(await capture(context.finalize('late final')));
      calls.push(await capture(context.handoff({ target_agent_id: SORA.actor_id, text: 'late handoff' })));
      return { text: 'late outcome' };
    },
    cancel: async ({ attempt, actor }) => {
      assert.equal(attempt.dispatch_id, ctx.dispatch.id);
      assert.equal(actor.id, OWNER.id);
      return { state: 'stopped' };
    },
  });
  const text = '@Sumi work';
  const submitting = submit(engine, room, text, { mentions: [mention(SUMI.actor_id, text)] });
  await reached.promise;

  const stopped = await engine.stop(room.id, { actor: HUMAN });
  assert.equal(stopped.confirmed, true);
  assert.equal(stopped.agents[SUMI.actor_id], 'stopped');
  const page = await publicMessages(store, room);
  const partial = page.find((m) => m.text === 'visible partial');
  assert.equal(partial.delivery_state, 'interrupted');

  release.resolve();
  await submitting;
  await engine.drain(room.id);
  assert.deepEqual(calls, ['dispatch_stale', 'dispatch_stale', 'dispatch_stale']);
  const [row] = await rowsFor(store, room, SUMI.actor_id);
  assert.equal(row.state, 'cancelled');
  assert.equal(row.final_message_id, null);
  const after = await publicMessages(store, room);
  assert.equal(after.some((m) => m.text === 'late final' || m.text === 'late outcome'), false);
});

test('no acknowledgement is not success: timeout and refusal stay uncertain until a later acknowledgement', async (t) => {
  const { store, room, engine } = await setup(t);
  const reached = deferred(), release = deferred();
  t.after(() => release.resolve());
  let mode = 'timeout';
  engine.register(SUMI.actor_id, {
    async run() { reached.resolve(); await release.promise; return { text: 'never final' }; },
    cancel: () => (mode === 'timeout' ? new Promise(() => {}) : Promise.resolve({ state: 'refused', reason: 'blocked' })),
  });
  const text = '@Sumi work';
  const submitting = submit(engine, room, text, { mentions: [mention(SUMI.actor_id, text)] });
  await reached.promise;

  const timedOut = await engine.stop(room.id, { actor: HUMAN, waitMs: 20 });
  assert.equal(timedOut.confirmed, false);
  assert.equal(timedOut.stopped, false);
  assert.equal(timedOut.state, 'running');
  assert.equal(timedOut.agents[SUMI.actor_id], 'timeout');
  let [row] = await rowsFor(store, room, SUMI.actor_id);
  assert.equal(row.state, 'uncertain');
  assert.equal(row.code, 'room_stop_timeout');

  release.resolve();
  await submitting;
  await engine.drain(room.id);

  // A second stop has no live attempt to cancel; the uncertain row is not turned into a claim.
  const again = await engine.stop(room.id, { actor: HUMAN });
  assert.equal(again.confirmed, true, 'no active work remains to confirm');
  [row] = await rowsFor(store, room, SUMI.actor_id);
  assert.equal(row.state, 'uncertain');
  assert.equal((await publicMessages(store, room)).some((m) => m.text === 'never final'), false);
});

test('stop cancels a turn that is waiting on a room approval', async (t) => {
  const { store, room, engine } = await setup(t);
  engine.register(SUMI.actor_id, { run: async () => ({ waiting_approval: true, reason: 'approve the command' }) });
  const text = '@Sumi approve';
  await submit(engine, room, text, { mentions: [mention(SUMI.actor_id, text)] });
  await engine.drain(room.id);
  let [row] = await rowsFor(store, room, SUMI.actor_id);
  assert.equal(row.state, 'waiting_approval');
  const stopped = await engine.stop(room.id, { actor: HUMAN });
  assert.equal(stopped.confirmed, true);
  assert.equal(stopped.cancelled_approvals, 1);
  [row] = await rowsFor(store, room, SUMI.actor_id);
  assert.equal(row.state, 'cancelled');
  assert.equal(row.code, 'room_stopped');
});

test('a refusal is reported as refused and never as all-stopped', async (t) => {
  const { store, room, engine } = await setup(t);
  const reached = deferred(), release = deferred();
  t.after(() => release.resolve());
  engine.register(SUMI.actor_id, {
    async run() { reached.resolve(); await release.promise; return { text: 'still running' }; },
    cancel: async () => ({ state: 'refused' }),
  });
  const text = '@Sumi work';
  const submitting = submit(engine, room, text, { mentions: [mention(SUMI.actor_id, text)] });
  await reached.promise;
  const stopped = await engine.stop(room.id, { actor: HUMAN });
  assert.equal(stopped.confirmed, false);
  assert.equal(stopped.agents[SUMI.actor_id], 'refused');
  const [row] = await rowsFor(store, room, SUMI.actor_id);
  assert.equal(row.state, 'uncertain');
  assert.equal(row.code, 'room_stop_refused');
  release.resolve();
  await submitting;
  await engine.drain(room.id);
});

test('stop cancels outstanding room cards and leaves partial rows interrupted', async (t) => {
  const { store, room, engine } = await setup(t);
  const now = 1_760_000_000_000;
  await store.transact(room.id, (d) => {
    d.cards = [
      { id: 'frq_AAAAAAAAAAAAAAAA', owner_id: OWNER.id, target_agent_id: SUMI.actor_id, dispatch_id: 'fd_AAAAAAAAAAAAAAAA', kind: 'approval', state: 'open', expires_at: now + 60_000, created_at: now },
      { id: 'frq_BBBBBBBBBBBBBBBB', owner_id: OWNER.id, target_agent_id: SORA.actor_id, dispatch_id: null, kind: 'clarify', state: 'closed', expires_at: now + 60_000, created_at: now },
    ];
  });
  const stopped = await engine.stop(room.id, { actor: HUMAN });
  assert.equal(stopped.cancelled_cards, 1);
  const snap = await snapshot(store, room);
  assert.equal(snap.cards[0].state, 'closed');
  assert.equal(snap.cards[0].reason, 'room_stopped');
  assert.equal(snap.cards[1].state, 'closed');
});

test('resume unpauses but never revives cancelled roots; a passive message stays passive and a new addressed request runs', async (t) => {
  const { store, room, engine } = await setup(t);
  let runs = 0;
  engine.register(SUMI.actor_id, { run: async () => { runs += 1; return { text: 'ran once' }; } });
  const text = '@Sumi start';
  await submit(engine, room, text, { mentions: [mention(SUMI.actor_id, text)] });
  await engine.drain(room.id);
  assert.equal(runs, 1);

  // Queue a second root, then stop before it starts.
  const held = deferred(), release = deferred();
  t.after(() => release.resolve());
  let blocked = true;
  engine.register(SORA.actor_id, {
    async run() {
      if (blocked) { held.resolve(); await release.promise; return { text: 'blocked run' }; }
      return { text: 'sora later' };
    },
    cancel: async () => ({ state: 'stopped' }),
  });
  const sText = '@Sora hold';
  const sSubmit = submit(engine, room, sText, { mentions: [mention(SORA.actor_id, sText)] });
  await held.promise;
  const qText = '@Sumi queued';
  await submit(engine, room, qText, { mentions: [mention(SUMI.actor_id, qText)] });
  await engine.stop(room.id, { actor: HUMAN });
  release.resolve();
  await sSubmit;
  await engine.drain(room.id);
  assert.equal(runs, 1, 'the queued Sumi root never ran');

  const passive = await submit(engine, room, 'plain chatter after stop');
  await engine.drain(room.id);
  assert.equal(passive.dispatches.length, 0);
  assert.equal((await snapshot(store, room)).paused, true, 'a passive message does not resume the queue');
  assert.equal(runs, 1);

  await engine.resume(room.id, { actor: HUMAN });
  await engine.drain(room.id);
  assert.equal(runs, 1, 'resume does not revive the cancelled root');
  assert.equal((await snapshot(store, room)).paused, false);

  blocked = false;
  const newText = '@Sumi new root';
  const fresh = await submit(engine, room, newText, { mentions: [mention(SUMI.actor_id, newText)] });
  await engine.drain(room.id);
  assert.equal(fresh.dispatches.length, 1);
  assert.equal(runs, 2);
  const row = (await dispatches(store, room)).find((d) => d.id === fresh.dispatches[0].id);
  assert.equal(row.state, 'completed');
  assert.equal(row.epoch, 2);
});

test('a new addressed human request starts new work under the current epoch without explicit resume', async (t) => {
  const { store, room, engine } = await setup(t);
  let runs = 0;
  engine.register(SUMI.actor_id, { run: async () => { runs += 1; return { text: 'fresh' }; } });
  await engine.stop(room.id, { actor: HUMAN });
  const text = '@Sumi fresh work';
  const result = await submit(engine, room, text, { mentions: [mention(SUMI.actor_id, text)] });
  await engine.drain(room.id);
  assert.equal(runs, 1);
  assert.equal((await snapshot(store, room)).paused, false);
  const row = (await dispatches(store, room)).find((d) => d.id === result.dispatches[0].id);
  assert.equal(row.state, 'completed');
  assert.equal(row.epoch, 2);
});

test('stop is room-scoped: another room and the same agents keep working', async (t) => {
  const { store, room, other, engine } = await setup(t);
  let otherRuns = 0;
  engine.register(SUMI.actor_id, { run: async () => ({ text: 'other answer' }), cancel: async () => ({ state: 'stopped' }) });
  engine.register(SORA.actor_id, { run: async () => { otherRuns += 1; return { text: 'sora answer' }; } });

  await engine.stop(room.id, { actor: HUMAN });
  const text = '@Sora other room';
  await engine.submit(other.id, { actor: HUMAN, text, mentions: [mention(SORA.actor_id, text)] });
  await engine.drain(other.id);
  assert.equal(otherRuns, 1);
  const otherSnap = await store.snapshot(other.id);
  assert.equal(otherSnap.paused, false);
  assert.equal(otherSnap.epoch, 1);
  assert.equal(otherSnap.dispatches[0].state, 'completed');
  const stoppedSnap = await snapshot(store, room);
  assert.equal(stoppedSnap.paused, true);
  assert.equal(stoppedSnap.epoch, 2);
});

test('recover after a stop never auto-runs old work, even in a fresh process', async (t) => {
  const { dir, store, room, engine, clock } = await setup(t);
  let runs = 0;
  engine.register(SUMI.actor_id, { run: async () => { runs += 1; return { text: 'should not run' }; }, cancel: async () => ({ state: 'stopped' }) });
  await engine.stop(room.id, { actor: HUMAN });

  const restartedStore = conversationStore(dir);
  await restartedStore.ready();
  t.after(() => restartedStore.idle());
  const restarted = createDispatchEngine({ store: restartedStore, now: () => clock.t });
  t.after(() => restarted.close());
  let restartedRuns = 0;
  restarted.register(SUMI.actor_id, { run: async () => { restartedRuns += 1; return { text: 'restarted' }; } });
  await restarted.recover();
  await restarted.drain(room.id);
  assert.equal(runs, 0);
  assert.equal(restartedRuns, 0);
  const snap = await restartedStore.snapshot(room.id);
  assert.equal(snap.paused, true);
  assert.equal(snap.epoch, 2);
});

test('races: stop against a final, a handoff and membership removal never publishes stale work', async (t) => {
  const { store, room, engine } = await setup(t);
  const reached = deferred(), release = deferred();
  t.after(() => release.resolve());
  let ctx = null;
  engine.register(SUMI.actor_id, {
    async run(context) {
      ctx = context;
      await context.finalize('committed before stop');
      reached.resolve();
      await release.promise;
      return { text: 'late answer' };
    },
    cancel: async () => ({ state: 'stopped' }),
  });
  const text = '@Sumi race';
  const submitting = submit(engine, room, text, { mentions: [mention(SUMI.actor_id, text)] });
  await reached.promise;
  const [stopped] = await Promise.all([
    engine.stop(room.id, { actor: HUMAN }),
    store.removeMember(room.id, { ownerId: OWNER.id, agentId: SUMI.actor_id }),
  ]);
  assert.equal(stopped.confirmed, true);
  release.resolve();
  await submitting;
  await engine.drain(room.id);
  assert.equal(await capture(ctx.handoff({ target_agent_id: SORA.actor_id, text: 'late handoff' })), 'dispatch_stale');
  const page = await publicMessages(store, room);
  assert.deepEqual(page.filter((m) => m.sender.kind === 'agent' && !m.system).map((m) => m.text), ['committed before stop']);
  const [row] = await rowsFor(store, room, SUMI.actor_id);
  assert.equal(row.state, 'cancelled');
  assert.equal(row.final_message_id !== null, true, 'the final committed before Stop is retained');
});


test('a Stop while the bot is disconnected never replays the old room turn on reconnect', async (t) => {
  const boot = await bootBot(t);
  const headers = { 'Sec-WebSocket-Protocol': 'foxfleet.bot.v1.2, foxfleet.bot.v1.1, foxfleet.bot.v1' };
  const created = await boot.h.call('/api/conversations', { data: { title: 'Reconnect', member_ids: ['helper'] } });
  assert.equal(created.status, 201);
  const room = await created.json();
  let c = await boot.connect({ headers });
  await c.next((x) => x.t === 'hello');
  const text = '@helper hold';
  const sent = await boot.h.call(`/api/conversations/${room.id}/messages`, {
    data: { text, mentions: [{ kind: 'agent', id: 'agent:helper', offset: 0, length: 7 }] },
  });
  assert.equal(sent.status, 202);
  const run = await c.next((x) => x.t === 'dispatch.run');
  c.end();

  const stopped = await boot.h.call(`/api/conversations/${room.id}/stop`, { method: 'POST', data: {} });
  assert.equal(stopped.status, 200);
  const body = await stopped.json();
  assert.equal(body.confirmed, false, 'an offline agent is not an acknowledgement');
  assert.equal(body.agents['agent:helper'], 'uncertain');

  c = await boot.connect({ headers });
  await c.next((x) => x.t === 'hello');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(c.texts.filter((x) => x && x.t === 'dispatch.run' && x.dispatch_id === run.dispatch_id).length, 0);
  const late = await c.request({ t: 'message.send', id: 'late-reconnect', chat_id: room.id, text: 'late final', final: true });
  assert.equal(late.ok, false);
  assert.equal(late.error.code, 'dispatch_stale');
});

test('a durable Stop refuses late unbound agent sends and edits before and after a hub restart', async (t) => {
  const boot = await bootBot(t);
  const headers = { 'Sec-WebSocket-Protocol': 'foxfleet.bot.v1.2, foxfleet.bot.v1.1, foxfleet.bot.v1' };
  const created = await boot.h.call('/api/conversations', { data: { title: 'Durable stop', member_ids: ['helper'] } });
  assert.equal(created.status, 201);
  const room = await created.json();
  let c = await boot.connect({ headers });
  await c.next((x) => x.t === 'hello');
  const text = '@helper commit final';
  const sent = await boot.h.call(`/api/conversations/${room.id}/messages`, {
    data: { text, mentions: [{ kind: 'agent', id: 'agent:helper', offset: 0, length: 7 }] },
  });
  assert.equal(sent.status, 202);
  const run = await c.next((x) => x.t === 'dispatch.run');
  const final = await c.request({
    t: 'message.send', id: 'final-before-stop', chat_id: room.id, text: 'committed before stop',
    final: true, dispatch_id: run.dispatch_id, run_token: run.run_token,
  });
  assert.equal(final.ok, true, JSON.stringify(final));

  const stopped = await boot.h.call(`/api/conversations/${room.id}/stop`, { method: 'POST', data: {} });
  assert.equal(stopped.status, 200);
  assert.equal((await stopped.json()).paused, true);

  const refuse = async (socket, id) => {
    const late = await socket.request({ t: 'message.send', id, chat_id: room.id, text: 'late unbound chatter' });
    assert.equal(late.ok, false, 'an unbound send after Stop is never plain chatter');
    assert.equal(late.error.code, 'dispatch_stale');
    const edit = await socket.request({
      t: 'message.edit', id: id + '-edit', chat_id: room.id,
      message_id: final.result.message_id, text: 'late unbound edit',
    });
    assert.equal(edit.ok, false, 'an unbound edit after Stop is never applied');
    assert.equal(edit.error.code, 'dispatch_stale');
  };
  await refuse(c, 'late-same-process');
  let page = await (await boot.h.call(`/api/conversations/${room.id}/messages`)).json();
  assert.equal(page.messages.some((m) => m.text === 'late unbound chatter'), false);
  assert.equal(page.messages.find((m) => m.id === final.result.message_id).text, 'committed before stop');

  c.end();
  await boot.h.restart();
  c = await boot.connect({ headers });
  await c.next((x) => x.t === 'hello');
  await refuse(c, 'late-after-restart');
  page = await (await boot.h.call(`/api/conversations/${room.id}/messages`)).json();
  assert.equal(page.messages.some((m) => m.text === 'late unbound chatter'), false);
  assert.equal(page.messages.find((m) => m.id === final.result.message_id).text, 'committed before stop');
});
