// The agent list's last-activity line, ordering and pins (hub side).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { previewOf, activityStore, sortAgents } from '../activity.js';
import { mockHermes } from './fixtures.js';
import { createHub } from '../index.js';

test('previews are one short plain line: no Markdown, no MEDIA tags, no secrets, no addresses', () => {
  assert.equal(previewOf('**Done!** See [the docs](https://example.com/x) and `npm test`'), 'Done! See the docs and npm test');
  assert.equal(previewOf('Here you go\nMEDIA:/home/me/chart.png\n[[audio_as_voice]]'), 'Here you go');
  assert.equal(previewOf('```js\nconst a = 1;\n```\nafter'), '[code] after');
  assert.equal(previewOf('# Title\n- one\n- two'), 'Title one two');
  assert.equal(previewOf('![cat](https://cdn.example.com/a.png)'), '[cat]'); assert.equal(previewOf('MEDIA:/tmp/a.png'), 'Photo'); assert.equal(previewOf('[[audio_as_voice]]\nMEDIA:/tmp/a.ogg'), 'Voice message'); assert.equal(previewOf('MEDIA:/tmp/a.png\nMEDIA:/tmp/b.mp4'), 'Photo +1');
  assert.ok(!/sk-abcdefghijklmnop|Bearer abc/.test(previewOf('my key is sk-abcdefghijklmnopqrstuv and Authorization: Bearer abcdef123456')));
  assert.ok(!/192\.168\.1\.5/.test(previewOf('the box at 192.168.1.5 is up')));
  assert.equal(previewOf('see https://hub.example.com/path?token=1 now'), 'see hub.example.com now');
  assert.equal(previewOf('x'.repeat(500)).length, 140); assert.ok(previewOf('x'.repeat(500)).endsWith('…'));
  assert.equal(previewOf('a\u0000b\tc\n\nd'), 'a b c d'); assert.equal(previewOf(null), '');
});

import { readFileSync } from 'node:fs';
const vectors = JSON.parse(readFileSync(new URL('../../contract/agent-list.vectors.json', import.meta.url), 'utf8'));
test('conformance vectors: hub ordering matches the clients', () => { assert.deepEqual(sortAgents(vectors.sort.input).map((a) => a.name), vectors.sort.expect); });

test('order: pinned first in pin order, then newest activity, then quiet agents in registry order', () => {
  const l = [{ name: 'quiet2', order: 3 }, { name: 'old', order: 0, last_activity_at: 100 }, { name: 'p2', order: 5, pin_order: 1, last_activity_at: 1 }, { name: 'new', order: 1, last_activity_at: 900 }, { name: 'p1', order: 6, pin_order: 0 }, { name: 'quiet1', order: 2 }];
  assert.deepEqual(sortAgents(l).map((a) => a.name), ['p1', 'p2', 'new', 'old', 'quiet1', 'quiet2']);
  assert.deepEqual(sortAgents(sortAgents(l)).map((a) => a.name), sortAgents(l).map((a) => a.name), 'stable');
});

test('store: touch keeps the last line, pins keep their order and survive a restart, old history seeds only once', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ff-act-')); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 })); const file = path.join(dir, 'activity.json');
  let now = 1000; const a = await activityStore(file, { now: () => now });
  a.touch('x', { role: 'user', text: 'hello there', session: 's1' }); now = 2000; a.touch('x', { role: 'assistant', text: 'hi!' });
  assert.deepEqual({ ...a.get('x') }, { at: 2000, role: 'assistant', preview: 'hi!', title: '', session: 's1' });
  a.touch('x', { role: 'robot', text: 'nope' }); a.touch('', { role: 'user', text: 'nope' }); assert.equal(a.get('x').preview, 'hi!');
  a.seed('y', { at: 5, text: 'old', title: 'Old chat' }); a.seed('y', { at: 9, text: 'newer' }); assert.equal(a.get('y').preview, 'old');
  await a.pin('b', true); await a.pin('a', true); await a.pin('b', true); assert.deepEqual(a.pins(), ['b', 'a']); await a.flush();
  const again = await activityStore(file); assert.deepEqual(again.pins(), ['b', 'a']); assert.equal(again.get('x').preview, 'hi!');
  await again.pin('b', false); assert.deepEqual(again.pins(), ['a']);
  await assert.rejects(again.pin('ghost', true, () => false), (e) => e.status === 404);
});

async function hubFor(t, connection) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-act-')), configPath = path.join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ machines: [connection] }));
  const server = await createHub({ configPath, singleUser: true }); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); });
  const base = `http://127.0.0.1:${server.address().port}`, call = (route, method = 'GET', data) => fetch(base + route, { method, headers: { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  return { base, call };
}
const frame = (c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`;

test('hub: a chat updates last_* fields, pins persist and sort first, nothing exposes an address', async (t) => {
  const mock = await mockHermes(t, { streamFrames: [frame('**Sure** '), frame('thing\nMEDIA:/tmp/a.png')] }), hub = await hubFor(t, mock.connection);
  const list0 = (await (await hub.call('/api/agents')).json()).agents; assert.equal(list0.length, 1); const name = list0[0].name;
  assert.equal(list0[0].last_activity_at, null); assert.equal(list0[0].pinned, false); assert.equal(list0[0].working, false);
  const before = Date.now();
  const r = await hub.call(`/api/agents/${name}/chat`, 'POST', { messages: [{ role: 'user', content: 'Please do the **thing**' }] }); assert.equal(r.status, 200); await r.text();
  await new Promise((res) => setTimeout(res, 50));
  const a = (await (await hub.call('/api/agents')).json()).agents[0];
  assert.ok(a.last_activity_at >= before); assert.equal(a.last_role, 'assistant'); assert.equal(a.last_message_preview, 'Sure thing'); assert.equal(a.working, false);
  assert.equal((await hub.call(`/api/agents/${name}/pin`, 'PUT', { pinned: 'yes' })).status, 400);
  const pinned = await (await hub.call(`/api/agents/${name}/pin`, 'PUT', { pinned: true })).json(); assert.equal(pinned.pinned, true);
  const a2 = (await (await hub.call(`/api/agents/${name}`)).json()).agent; assert.equal(a2.pinned, true); assert.equal(a2.pin_order, 0);
  await hub.call(`/api/agents/${name}/pin`, 'PUT', { pinned: false }); assert.equal((await (await hub.call('/api/agents')).json()).agents[0].pinned, false);
  assert.equal((await hub.call('/api/agents/nobody/pin', 'PUT', { pinned: true })).status, 404);
  const text = JSON.stringify(a); assert.ok(!/127\.0\.0\.1|localhost|MEDIA:/.test(text.replace(/"description":"[^"]*"/, '')), text.slice(0, 300));
});
