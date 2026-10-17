// 0.4.1 reactions (feature reactionEvents, docs/LIVE-EVENTS.md "Reactions"): hub_id as the message id, idempotent set/remove with
// `changed`, error codes, the stored live v2 event message.reaction (seq, replay, pull), the agent's REACT: line applied when its
// reply is committed, reactions / react / reaction_only on messages and history, reaction-only replies never unread, two accounts
// apart, and the v1 stream and 0.4.0 message frames unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reactionStore, replyReaction, reactionView } from '../reactions.js';
import { hub, hermes, sse, until, sleep, login, PASS } from './live2-helpers.js';

const reply = (text) => [`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`];
const send = (call, text, headers) => call('/api/agents/atlas/messages', { messages: [{ role: 'user', content: text }], session_id: 'sess-1' }, headers ? { headers } : {});
const R = '/api/agents/atlas/sessions/sess-1/reactions';
const put = (call, message_id, emoji, headers) => call(R, { message_id, emoji }, { method: 'PUT', ...(headers ? { headers } : {}) });
const del = (call, message_id, emoji, headers) => call(R, { message_id, emoji }, { method: 'DELETE', ...(headers ? { headers } : {}) });
const ME = { id: 'user:local', name: 'local', kind: 'human' };

/** Hub + mock Hermes ("atlas") + a v2 stream; one user turn already sent and answered with `answer`. */
async function chat(t, answer = 'Sure.') {
  const { mock, opts } = await hermes(t, { streamFrames: reply(answer), streamDelayMs: 5, messages: [] });
  const x = await hub(t); await x.call('/api/connections', { ...mock.connection, name: 'atlas' });
  const s = sse(t, `${x.base}/api/live/stream?v=2`); const ready = await s.wait((f) => f.event === 'foxfleet.ready');
  assert.equal((await send(x.call, 'thanks a lot')).status, 202);
  const a = await s.wait((f) => f.event === 'message.new' && f.data.message.role === 'assistant');
  const u = s.frames.find((f) => f.event === 'message.new' && f.data.message.role === 'user');
  await s.wait((f) => f.event === 'run.finished');
  return { ...x, mock, opts, s, ready, user: u.data.message, answer: a.data.message };
}

test('unit: replyReaction, multi-key store set (changed / idempotent / cleared under every id) and reactionView', async (t) => {
  assert.deepEqual(replyReaction('REACT: ❤️'), { react: '❤️', only: true });
  assert.deepEqual(replyReaction('Nice!\nREACT: 👍'), { react: '👍', only: false });
  assert.deepEqual(replyReaction('REACT: \u2764'), { react: '\u2764\uFE0F', only: true }, 'a bare symbol gets the variation selector');
  assert.deepEqual(replyReaction('REACT: love'), { react: null, only: false }, 'a word is not a reaction');
  assert.deepEqual(replyReaction('```\nREACT: 🦊\n```'), { react: null, only: false }, 'not inside code');
  assert.deepEqual(replyReaction('plain'), { react: null, only: false });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ff-react-keys-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const st = await reactionStore(path.join(dir, 'reactions.json'));
  assert.equal(await st.set('a', 's', ['hX.1'], '👍', ME, true), true, 'stored under the hub id');
  assert.equal(await st.set('a', 's', ['u1', 'hX.1'], '👍', ME, true), false, 'the same message under its upstream id: already there');
  assert.deepEqual(Object.keys(st.list('a', 's')), ['hX.1']);
  const v = reactionView({ rows: st.list('a', 's'), derived: [{ message: 'u1', emoji: '👍', actor: { id: 'agent:a', name: 'A', kind: 'agent' } }], resolve: (k) => (k === 'u1' || k === 'hX.1' ? { n: 1, u: 'u1', hub_id: 'hX.1' } : null), transcriptIds: new Set(['u1']) });
  assert.deepEqual(v.messages.u1, v.by_hub_id['hX.1']); assert.equal(v.messages.u1[0].actors.length, 2, 'stored and derived merge on one message');
  assert.equal(await st.set('a', 's', ['u1', 'hX.1'], '👍', ME, false), true); assert.equal(await st.set('a', 's', ['u1', 'hX.1'], '👍', ME, false), false);
  assert.deepEqual(st.list('a', 's'), {});
  await assert.rejects(async () => st.set('a', 's', [''], '👍', ME, true), (e) => e.code === 'invalid_message_id');
  await assert.rejects(async () => st.set('a', 's', ['m'], 'no', ME, true), (e) => e.code === 'invalid_emoji');
});

test('user reactions by hub_id on a live message: set, repeat, remove; changed; one message.reaction per change; codes', async (t) => {
  const c = await chat(t); const { call, s, user } = c;
  assert.equal(user.upstream_id, null, 'a live message has no upstream id yet');
  const feats = (await call('/api/auth')).body.hub.features; assert.ok(feats.includes('reactionEvents'));
  const a = await put(call, user.hub_id, '👍'); assert.equal(a.status, 200, JSON.stringify(a.body)); assert.equal(a.body.changed, true);
  assert.deepEqual(a.body.by_hub_id[user.hub_id], [{ emoji: '👍', actors: [ME] }]); assert.deepEqual(a.body.messages, {}, 'no upstream id yet: not under messages');
  const ev = await s.wait((f) => f.event === 'message.reaction');
  assert.ok(Number(ev.id.split(':')[1]) === ev.data.seq && ev.data.seq > 0, 'stored with a seq');
  assert.deepEqual({ ...ev.data, seq: 0, at: 0 }, { seq: 0, type: 'message.reaction', at: 0, agent: 'atlas', chat: 'sess-1', hub_id: user.hub_id, reactions: [{ emoji: '👍', actors: [ME] }], change: { emoji: '👍', present: true, actor: ME } });
  const again = await put(call, user.hub_id, '👍'); assert.equal(again.body.changed, false, 'idempotent');
  assert.equal((await put(call, user.hub_id, '❤️')).body.changed, true);
  await sleep(100); assert.equal(s.frames.filter((f) => f.event === 'message.reaction').length, 2, 'the repeat sent no event');
  const off = await del(call, user.hub_id, '👍'); assert.equal(off.body.changed, true); assert.deepEqual(off.body.by_hub_id[user.hub_id], [{ emoji: '❤️', actors: [ME] }]);
  assert.equal((await del(call, user.hub_id, '👍')).body.changed, false);
  const last = await until(() => s.frames.filter((f) => f.event === 'message.reaction')[2]);
  assert.deepEqual(last.data.change, { emoji: '👍', present: false, actor: ME }); assert.deepEqual(last.data.reactions, [{ emoji: '❤️', actors: [ME] }], 'the full current set');
  // a body actor is ignored; codes
  const spoof = await call(R, { message_id: c.answer.hub_id, emoji: '🎉', actor: { id: 'agent:atlas', kind: 'agent', name: 'x' } }, { method: 'PUT' });
  assert.equal(spoof.status, 200); assert.deepEqual(spoof.body.by_hub_id[c.answer.hub_id][0].actors, [ME]);
  for (const [b, status, code] of [[{ message_id: user.hub_id, emoji: 'nope' }, 400, 'invalid_emoji'], [{ message_id: '', emoji: '👍' }, 400, 'invalid_message_id'], [{ emoji: '👍' }, 400, 'invalid_message_id'],
    [{ message_id: user.hub_id.replace(/\.\d+$/, '.99'), emoji: '👍' }, 404, 'message_not_found'], [{ message_id: 'hAAAAAAAAAAAA.1', emoji: '👍' }, 404, 'message_not_found'], [{ message_id: 'u-unknown', emoji: '👍' }, 404, 'message_not_found']]) {
    const r = await call(R, b, { method: 'PUT' }); assert.equal(r.status, status, JSON.stringify(b)); assert.equal(r.body.code, code, JSON.stringify(b));
  }
  // the agent's transcript catches up: the hub binds the ids, the same reaction shows under the upstream id too and can be removed by it
  c.opts.messages = [{ id: 'u1', role: 'user', content: 'thanks a lot' }, { id: 'a1', role: 'assistant', content: 'Sure.' }];
  const snap = (await call(R)).body; assert.deepEqual(snap.messages.u1, [{ emoji: '❤️', actors: [ME] }]); assert.deepEqual(snap.by_hub_id[user.hub_id], snap.messages.u1);
  const edited = await s.wait((f) => f.event === 'message.edited' && f.data.message.hub_id === user.hub_id);
  assert.equal(edited.data.message.upstream_id, 'u1'); assert.deepEqual(edited.data.message.reactions, [{ emoji: '❤️', actors: [ME] }], 'message.edited carries the reactions');
  assert.equal((await put(call, 'u1', '❤️')).body.changed, false, 'same message by its other id');
  const gone = await del(call, 'u1', '❤️'); assert.equal(gone.body.changed, true); assert.deepEqual(gone.body.messages.u1, [], 'emptied in this call: [] (0.4.1 answers)'); assert.deepEqual(gone.body.by_hub_id[user.hub_id], []);
  const quiet = (await call(R)).body; assert.equal(quiet.messages.u1, undefined, 'a plain GET leaves empty messages out'); assert.equal(quiet.by_hub_id[user.hub_id], undefined);
  const ev4 = await until(() => s.frames.filter((f) => f.event === 'message.reaction')[4]); assert.equal(ev4.data.upstream_id, 'u1'); assert.equal(ev4.data.hub_id, user.hub_id); assert.deepEqual(ev4.data.reactions, []);
});

test('agent REACT: line: applied to the user message at commit (stored, message.reaction), react / reaction_only on the reply, never unread', async (t) => {
  const c = await chat(t, 'REACT: ❤️'); const { call, s, user, answer } = c;
  assert.equal(answer.react, '❤️'); assert.equal(answer.reaction_only, true); assert.equal(answer.text, 'REACT: ❤️', 'text unchanged');
  const agent = { id: 'agent:atlas', name: 'atlas', kind: 'agent' };
  const ev = await s.wait((f) => f.event === 'message.reaction');
  assert.equal(ev.data.hub_id, user.hub_id); assert.deepEqual(ev.data.change, { emoji: '❤️', present: true, actor: agent }); assert.deepEqual(ev.data.reactions, [{ emoji: '❤️', actors: [agent] }]);
  assert.ok(s.frames.indexOf(ev) > s.frames.findIndex((f) => f.event === 'message.new' && f.data.message.role === 'assistant'), 'after the reply');
  const row = (await call('/api/chats')).body.chats[0]; assert.equal(row.unread_count, 0, 'a reaction-only reply is not unread'); assert.equal(row.last_message.hub_id, user.hub_id, 'nor the preview');
  // stored + derived from the transcript: the agent counts once; the user cannot remove the agent's reaction
  c.opts.messages = [{ id: 'u1', role: 'user', content: 'thanks a lot' }, { id: 'a1', role: 'assistant', content: 'REACT: ❤️' }];
  const snap = (await call(R)).body; assert.deepEqual(snap.messages.u1, [{ emoji: '❤️', actors: [agent] }]); assert.deepEqual(snap.by_hub_id[user.hub_id], snap.messages.u1);
  assert.equal((await del(call, 'u1', '❤️')).body.changed, false, 'your DELETE only removes your own');
  assert.equal((await put(call, 'u1', '❤️')).body.messages.u1[0].actors.length, 2, 'per-user and agent reactions side by side');
  // history: reactions on the user message, react / reaction_only on the reply
  const h = (await call('/api/agents/atlas/sessions/sess-1/messages')).body.messages;
  assert.deepEqual(h[0].reactions, [{ emoji: '❤️', actors: [agent, ME] }]); assert.equal(h[1].react, '❤️'); assert.equal(h[1].reaction_only, true);
  const after = (await call('/api/agents/atlas/sessions/sess-1/messages?after_n=0')).body.messages; assert.deepEqual(after[0].reactions, h[0].reactions); assert.equal(after[1].reaction_only, true);
});

test('a reply with words and a REACT: line: react without reaction_only, unread as usual; a word is no reaction', async (t) => {
  const c = await chat(t, 'Glad it helped!\nREACT: 🎉'); assert.equal(c.answer.react, '🎉'); assert.equal(c.answer.reaction_only, undefined);
  await c.s.wait((f) => f.event === 'message.reaction'); assert.equal((await c.call('/api/chats')).body.chats[0].unread_count, 1);
  const d = await chat(t, 'Done\nREACT: love'); assert.equal(d.answer.react, undefined); await sleep(150); assert.equal(d.s.frames.filter((f) => f.event === 'message.reaction').length, 0);
});

test('message.reaction is stored: replayed after a reconnect (since / Last-Event-ID) and returned by the pull', async (t) => {
  const c = await chat(t); const { call, base, user } = c;
  const cursor = c.ready.data.cursor; const store = cursor.split(':')[0];
  await put(call, user.hub_id, '👍'); const live = await c.s.wait((f) => f.event === 'message.reaction'); c.s.stop();
  const r1 = sse(t, `${base}/api/live/stream?v=2&since=${encodeURIComponent(cursor)}`); await r1.wait((f) => f.event === 'foxfleet.ready');
  const replay = await r1.wait((f) => f.event === 'message.reaction'); assert.equal(replay.id, live.id); assert.deepEqual(replay.data, live.data);
  const r2 = sse(t, `${base}/api/live/stream?v=2`, { 'Last-Event-ID': `${store}:${live.data.seq - 1}` }); await r2.wait((f) => f.event === 'foxfleet.ready');
  assert.equal(r2.events()[0].event, 'message.reaction'); assert.deepEqual(r2.events()[0].data, live.data);
  const pull = await call(`/api/live/events?since=${encodeURIComponent(cursor)}`); assert.deepEqual(pull.body.events.find((e) => e.type === 'message.reaction'), live.data);
});

test('two accounts: reactions and their events stay in the account; the other one gets no event and cannot react', async (t) => {
  const { mock } = await hermes(t, { streamFrames: reply('ok'), streamDelayMs: 5, messages: [] });
  const x = await hub(t, { password: PASS }); await x.server.accounts.createUser('bob', PASS, 'user', { skipPolicy: true });
  const a = await login(x.base);
  const br = await fetch(x.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bob', password: PASS, client: 'app' }) }); const b = { Authorization: `Bearer ${(await br.json()).token}` };
  assert.equal((await x.call('/api/connections', { ...mock.connection, name: 'atlas' }, { headers: a.h })).status, 201);
  const sa = sse(t, `${x.base}/api/live/stream?v=2`, a.h), sb = sse(t, `${x.base}/api/live/stream?v=2`, b); await sa.wait((f) => f.event === 'foxfleet.ready'); await sb.wait((f) => f.event === 'foxfleet.ready');
  assert.equal((await send(x.call, 'A only', a.h)).status, 202);
  const u = await sa.wait((f) => f.event === 'message.new' && f.data.message.role === 'user'); await sa.wait((f) => f.event === 'run.finished', 8000);
  const ok = await put(x.call, u.data.message.hub_id, '👍', a.h); assert.equal(ok.status, 200); assert.equal(ok.body.actor.id.startsWith('user:'), true);
  const ev = await sa.wait((f) => f.event === 'message.reaction'); assert.equal(ev.data.change.actor.name, 'owner');
  assert.equal((await put(x.call, u.data.message.hub_id, '👍', b)).status, 404, 'bob has no such agent');
  // bob connects the same agent: his own chat, his own ledger and store; A's reaction is not in it
  assert.equal((await x.call('/api/connections', { ...mock.connection, name: 'atlas' }, { headers: b })).status, 201);
  const snapB = await x.call(R, undefined, { headers: b }); assert.equal(snapB.status, 200); assert.deepEqual(snapB.body.by_hub_id, {}); assert.deepEqual(snapB.body.messages, {});
  await sleep(150); assert.equal(sb.frames.filter((f) => f.event === 'message.reaction').length, 0, 'nothing of A reaches B');
});

test('compat: the v1 stream gets no reaction frames; 0.4.0 message.new keys are unchanged for a message without reactions', async (t) => {
  const { mock } = await hermes(t, { streamFrames: reply('fine'), streamDelayMs: 5, messages: [] }); const x = await hub(t);
  await x.call('/api/connections', { ...mock.connection, name: 'atlas' });
  const v1 = sse(t, `${x.base}/api/live/stream`), v2 = sse(t, `${x.base}/api/live/stream?v=2`); await v1.wait((f) => f.event === 'foxfleet.ready'); await v2.wait((f) => f.event === 'foxfleet.ready');
  await send(x.call, 'hello');
  const u = await v2.wait((f) => f.event === 'message.new' && f.data.message.role === 'user'), a = await v2.wait((f) => f.event === 'message.new' && f.data.message.role === 'assistant');
  assert.deepEqual(Object.keys(u.data.message), ['hub_id', 'upstream_id', 'n', 'role', 'text', 'at', 'source', 'status', 'reply_to', 'edited_at', 'run_id'], '0.4.0 user message keys');
  assert.deepEqual(Object.keys(a.data.message), ['hub_id', 'upstream_id', 'n', 'role', 'text', 'at', 'source', 'reply_to', 'edited_at', 'run_id'], '0.4.0 reply keys');
  for (const k of ['reactions', 'react', 'reaction_only']) { assert.ok(!(k in u.data.message), k); assert.ok(!(k in a.data.message), k); }
  await v1.wait((f) => f.event === 'live' && f.data.type === 'run_finished');
  await put(x.call, u.data.message.hub_id, '👍'); await v2.wait((f) => f.event === 'message.reaction'); await sleep(100);
  assert.deepEqual(v1.frames.filter((f) => f.id).map((f) => f.data.type), ['run_started', 'run_finished'], 'v1: only its own types');
  assert.ok(!v1.frames.some((f) => f.raw.includes('reaction')));
});

test('PUT/DELETE answers always list the targeted message: [] when it has none (by hub id, by upstream id, and on a no-op)', async (t) => {
  const c = await chat(t); const { call, user, answer } = c;
  const none = await del(call, user.hub_id, '👍'); assert.equal(none.body.changed, false); assert.deepEqual(none.body.by_hub_id, { [user.hub_id]: [] }, 'a no-op DELETE still lists it');
  await put(call, answer.hub_id, '🎉'); const off = await del(call, answer.hub_id, '🎉'); assert.deepEqual(off.body.by_hub_id[answer.hub_id], []); assert.equal(off.body.by_hub_id[user.hub_id], undefined, 'only the targeted message');
  c.opts.messages = [{ id: 'u1', role: 'user', content: 'thanks a lot' }, { id: 'a1', role: 'assistant', content: 'Sure.' }];
  const byUp = await del(call, 'a1', '🎉'); assert.deepEqual(byUp.body.messages.a1, []); assert.deepEqual(byUp.body.by_hub_id[answer.hub_id], []);
});
