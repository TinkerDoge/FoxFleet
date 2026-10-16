// nativeHub.list: newest 50 messages of one session, oldest first, without scanning/copying the whole journal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { nativeHub } from '../hermes-ui.js';

test('native list: newest 50 for (scope, agent, session), in order, other sessions and scopes ignored', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-natlist-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const hub = await nativeHub({ connectors: { ui: () => ({}) }, file: path.join(dir, 'j.json') }), j = hub._journal();
  for (let i = 0; i < 120; i++) j.messages.push({ id: `m${i}`, scope: i % 3 === 2 ? 'u2' : 'u1', agent: 'p', session: i % 2 ? 's1' : 's2', text: `t${i}`, mode: 'auto', state: 'acked', ack: 'queued', created: i });
  const got = hub.list('u1', 'p', 's1'), want = j.messages.filter((m) => m.scope === 'u1' && m.agent === 'p' && m.session === 's1').slice(-50).map((m) => m.id);
  assert.deepEqual(got.map((m) => m.id), want); assert.equal(got.length, 40);
  for (let i = 120; i < 300; i++) j.messages.push({ id: `m${i}`, scope: 'u1', agent: 'p', session: 's1', text: `t${i}`, mode: 'auto', state: 'acked', ack: 'queued', created: i });
  const more = hub.list('u1', 'p', 's1'); assert.equal(more.length, 50); assert.equal(more[0].id, 'm250'); assert.equal(more.at(-1).id, 'm299');
  assert.deepEqual(hub.list('u2', 'p', 'nope'), []);
});
