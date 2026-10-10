import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanAvatarPacks, AVATAR_STATES } from '../avatars.js';
import { createHub } from '../index.js';

async function tempBase(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-avatars-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
  return dir;
}

test('scanAvatarPacks discovers packs and prefers webm over mp4', async (t) => {
  const base = await tempBase(t);
  await mkdir(path.join(base, 'Atlas'), { recursive: true });
  await writeFile(path.join(base, 'Atlas', 'idle.webm'), 'x');
  await writeFile(path.join(base, 'Atlas', 'idle.mp4'), 'x');
  await writeFile(path.join(base, 'Atlas', 'working.webm'), 'x');
  await writeFile(path.join(base, 'Atlas', 'offline.webm'), 'x');
  await writeFile(path.join(base, 'Atlas', 'poster.png'), 'x');
  await mkdir(path.join(base, 'Orion'), { recursive: true });
  await writeFile(path.join(base, 'Orion', 'idle.webm'), 'x');
  const packs = await scanAvatarPacks(base);
  assert.equal(packs.length, 2);
  const sumi = packs.find(p => p.agent === 'Atlas');
  assert.equal(sumi.states.idle.src, '/avatars/Atlas/idle.webm');
  assert.ok(!('rank' in sumi.states.idle));
  assert.equal(sumi.poster, '/avatars/Atlas/poster.png');
  const orion = packs.find(p => p.agent === 'Orion');
  assert.deepEqual(Object.keys(orion.states), ['idle']);
});

test('scanAvatarPacks ignores unsafe names, wrong states, empty dirs', async (t) => {
  const base = await tempBase(t);
  await mkdir(path.join(base, '../evil'), { recursive: true }).catch(() => {});
  await mkdir(path.join(base, '..evil'), { recursive: true });
  await writeFile(path.join(base, '..evil', 'idle.webm'), 'x').catch(() => {});
  await mkdir(path.join(base, 'empty-agent'), { recursive: true });
  await mkdir(path.join(base, 'WrongState'), { recursive: true });
  await writeFile(path.join(base, 'WrongState', 'sleeping.webm'), 'x');
  await mkdir(path.join(base, 'ok-agent'), { recursive: true });
  await writeFile(path.join(base, 'ok-agent', 'idle.mp4'), 'x');
  const packs = await scanAvatarPacks(base);
  assert.equal(packs.length, 1);
  assert.equal(packs[0].agent, 'ok-agent');
  assert.equal(packs[0].states.idle.src, '/avatars/ok-agent/idle.mp4');
});

test('scanAvatarPacks on missing directory returns empty', async () => {
  assert.deepEqual(await scanAvatarPacks('/nonexistent-path-xyz'), []);
});

test('avatar API serves packs and static files behind owner auth', async (t) => {
  const base = await tempBase(t);
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-cfg-'));
  t.after(() => rm(configDir, { recursive: true, force: true }));
  await mkdir(path.join(base, 'Atlas'), { recursive: true });
  await writeFile(path.join(base, 'Atlas', 'idle.webm'), 'placeholder-bytes');
  const server = await createHub({ configPath: path.join(configDir, 'config.json'), singleUser: true, avatarDir: base });
  t.after(() => new Promise(r => { server.closeAllConnections?.(); server.close(r); }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  // no password on loopback → authenticated by default; avatarDir override active
  const res = await fetch(origin + '/api/avatars');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.avatars.length, 1);
  assert.equal(data.avatars[0].agent, 'Atlas');
  assert.equal(data.avatars[0].states.idle.src, '/avatars/Atlas/idle.webm');
  // static serve: the clip resolves through the avatar base, not web/
  const clip = await fetch(origin + '/avatars/Atlas/idle.webm');
  assert.equal(clip.status, 200);
  assert.equal(clip.headers.get('content-type'), 'video/webm');
  // traversal is still rejected
  const evil = await fetch(origin + '/avatars/../config.json');
  assert.ok([403, 404].includes(evil.status));
  // unknown agent dir → 404
  const missing = await fetch(origin + '/avatars/Nobody/idle.webm');
  assert.equal(missing.status, 404);
});

test('createHub rejects invalid avatarDir option', async () => {
  await assert.rejects(() => createHub({ avatarDir: 'relative/path' }), /avatar directory/i);
  await assert.rejects(() => createHub({ avatarDir: 42 }), /avatar directory/i);
});

test('AVATAR_STATES stays the supported contract', () => {
  assert.deepEqual(AVATAR_STATES, ['idle', 'working', 'offline', 'making_something', 'milestone_level_up']);
});

test('a bare-array skills response from a real dashboard is normalised to the wrapper', async (t) => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-skills-'));
  t.after(() => rm(configDir, { recursive: true, force: true }));
  const { mockHermes } = await import('./fixtures.js');
  const fixture = await mockHermes(t);
  await writeFile(path.join(configDir, 'config.json'), JSON.stringify({ machines: [fixture.connection] }));
  const server = await createHub({ configPath: path.join(configDir, 'config.json'), singleUser: true });
  t.after(() => new Promise(r => { server.closeAllConnections?.(); server.close(r); }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/agents/fixture/skills`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.skills), 'relay returns {skills:[...]}');
  assert.ok(data.skills.every(s => typeof s.name === 'string'));
  assert.ok(data.skills.some(s => s.name === 'web-search' && s.enabled === true));
});

test('a bare-array skills response from a real dashboard is normalised to the wrapper', async (t) => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'foxfleet-skills-'));
  t.after(() => rm(configDir, { recursive: true, force: true }));
  const { mockHermes } = await import('./fixtures.js');
  const fixture = await mockHermes(t);
  await writeFile(path.join(configDir, 'config.json'), JSON.stringify({ machines: [fixture.connection] }));
  const server = await createHub({ configPath: path.join(configDir, 'config.json'), singleUser: true });
  t.after(() => new Promise(r => { server.closeAllConnections?.(); server.close(r); }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/agents/fixture/skills`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.skills), 'relay returns {skills:[...]}');
  assert.ok(data.skills.every(s => typeof s.name === 'string'));
  assert.ok(data.skills.some(s => s.name === 'web-search' && s.enabled === true));
});
