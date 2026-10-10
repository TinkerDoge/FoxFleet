// MEDIA: tags end to end: connector file policy, hub authorization, real tunnel, range requests, SSRF-guarded URLs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkMedia, mediaRoots, sniffMedia, mediaLimiter } from '../../connector/foxfleet-connector.mjs';
import { mediaHub } from '../media.js';
import { setup } from './ui-helpers.js';
import { waitFor } from './machine-helpers.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const tmp = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ff-media-'));

test('connector policy: roots, traversal, symlinks, size, type, sniffing, secrets', (t) => {
  const root = tmp(), outside = tmp(); t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  const roots = [fs.realpathSync(root)], ok = path.join(root, 'cat.png'), secret = path.join(outside, 'secret.png');
  fs.writeFileSync(ok, PNG); fs.writeFileSync(secret, PNG);
  assert.equal(checkMedia(ok, roots).ok, true); assert.equal(checkMedia(ok, roots).mime, 'image/png');
  assert.equal(checkMedia(secret, roots).code, 'outside', 'a file outside the roots');
  assert.equal(checkMedia(path.join(root, '..', path.basename(outside), 'secret.png'), roots).code, 'outside', 'path traversal resolves first');
  fs.symlinkSync(secret, path.join(root, 'link.png')); assert.equal(checkMedia(path.join(root, 'link.png'), roots).code, 'outside', 'a symlink out of the root is refused');
  fs.symlinkSync(outside, path.join(root, 'dir')); assert.equal(checkMedia(path.join(root, 'dir', 'secret.png'), roots).code, 'outside', 'a symlinked directory too');
  fs.writeFileSync(path.join(root, 'page.png'), '<html><script>alert(1)</script></html>'); assert.equal(checkMedia(path.join(root, 'page.png'), roots).code, 'sniff', 'HTML named .png');
  fs.writeFileSync(path.join(root, 'notes.weird'), 'x'); assert.equal(checkMedia(path.join(root, 'notes.weird'), roots).code, 'type', 'unknown extension');
  fs.writeFileSync(path.join(root, 'page.html'), '<p>'); assert.equal(checkMedia(path.join(root, 'page.html'), roots).code, 'type', 'html is never delivered');
  fs.writeFileSync(path.join(root, 'big.png'), Buffer.concat([PNG, Buffer.alloc(2048)])); assert.equal(checkMedia(path.join(root, 'big.png'), roots, { maxBytes: 1024 }).code, 'too_big', 'huge file');
  assert.equal(checkMedia(path.join(root, 'gone.png'), roots).code, 'missing');
  assert.equal(checkMedia('relative/x.png', roots).code, 'bad_path'); assert.equal(checkMedia('/tmp/a\0b.png', roots).code, 'bad_path'); assert.equal(checkMedia('C:\\Users\\x.png', roots).code, 'bad_path');
  fs.mkdirSync(path.join(root, '.ssh')); fs.writeFileSync(path.join(root, '.ssh', 'id.png'), PNG); assert.equal(checkMedia(path.join(root, '.ssh', 'id.png'), roots).code, 'denied');
  fs.mkdirSync(path.join(root, 'd.png')); assert.equal(checkMedia(path.join(root, 'd.png'), roots).code, 'type', 'a directory');
  const lim = mediaLimiter(3, (() => { let n = 0; return () => n; })()); assert.deepEqual([lim(), lim(), lim(), lim()], [true, true, true, false], 'rate limit');
  assert.ok(mediaRoots({ root, home: root, cfg: { mediaRoots: [outside] } }).includes(fs.realpathSync(outside)), 'extra roots from config');
  assert.equal(sniffMedia(Buffer.from('%PDF-1.7'), 'pdf'), 'application/pdf'); assert.equal(sniffMedia(PNG, 'jpg'), null);
});

const stubConnectors = (files) => ({ fetchMedia: async (machine, agent, p) => { const f = files[p]; if (!f) throw Object.assign(new Error('File not found on this machine'), { status: 404 }); return f; } });
const mkRes = () => { const r = { status: 0, headers: {}, body: undefined, writeHead(s, h) { r.status = s; r.headers = h; }, end(b) { r.body = b; } }; return r; };

test('hub: only mentioned refs resolve; tokens are user-bound, expiring and tamper-proof; ranges work; cache is bounded', async () => {
  let t = 1_000_000; const body = Buffer.from('0123456789');
  const hub = mediaHub({ connectors: stubConnectors({ '/tmp/a.png': { body: PNG, mime: 'image/png', name: 'a.png' }, '/tmp/v.mp4': { body, mime: 'video/mp4', name: 'v.mp4' } }), now: () => t, tokenTtlMs: 60_000, cacheBytes: 100 });
  assert.throws(() => hub.resolve({ scope: 'u1', agent: 'a', machineId: 'm1', ref: '/tmp/a.png' }), /not offered/, 'never mentioned');
  hub.note('u1', 'a', 'see MEDIA:/tmp/a.png and\n[[audio_as_voice]]\nMEDIA:/tmp/v.mp4');
  assert.throws(() => hub.resolve({ scope: 'u2', agent: 'a', machineId: 'm1', ref: '/tmp/a.png' }), /not offered/, 'another user mentioned nothing');
  assert.throws(() => hub.resolve({ scope: 'u1', agent: 'other', machineId: 'm1', ref: '/tmp/a.png' }), /not offered/, 'another agent');
  const r = hub.resolve({ scope: 'u1', agent: 'a', machineId: 'm1', profile: 'p', ref: '/tmp/a.png' }); assert.match(r.url, /^\/api\/media\/[\w-]+\.[\w-]+$/); assert.equal(r.kind, 'image'); assert.ok(!JSON.stringify(r).includes('/tmp/a.png') || r.name === 'a.png');
  const token = r.url.split('/').pop();
  const ok = mkRes(); await hub.serve({ token, scope: 'u1', req: { headers: {}, method: 'GET' }, res: ok }); assert.equal(ok.status, 200); assert.equal(ok.headers['Content-Type'], 'image/png'); assert.deepEqual(ok.body, PNG); assert.equal(ok.headers['X-Content-Type-Options'], 'nosniff');
  await assert.rejects(hub.serve({ token, scope: 'u2', req: { headers: {}, method: 'GET' }, res: mkRes() }), (e) => e.status === 404, 'wrong user is denied (and cannot tell it exists)');
  const [p, sig] = token.split('.'); const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), s: 'u2' })).toString('base64url');
  await assert.rejects(hub.serve({ token: `${forged}.${sig}`, scope: 'u2', req: { headers: {}, method: 'GET' }, res: mkRes() }), (e) => e.status === 404, 'tampered token');
  const v = hub.resolve({ scope: 'u1', agent: 'a', machineId: 'm1', ref: '/tmp/v.mp4' }).url.split('/').pop();
  const rg = mkRes(); await hub.serve({ token: v, scope: 'u1', req: { headers: { range: 'bytes=2-5' }, method: 'GET' }, res: rg }); assert.equal(rg.status, 206); assert.equal(String(rg.body), '2345'); assert.equal(rg.headers['Content-Range'], 'bytes 2-5/10');
  const sx = mkRes(); await hub.serve({ token: v, scope: 'u1', req: { headers: { range: 'bytes=-3' }, method: 'GET' }, res: sx }); assert.equal(String(sx.body), '789');
  const bad = mkRes(); await hub.serve({ token: v, scope: 'u1', req: { headers: { range: 'bytes=50-60' }, method: 'GET' }, res: bad }); assert.equal(bad.status, 416);
  t += 61_000; await assert.rejects(hub.serve({ token, scope: 'u1', req: { headers: {}, method: 'GET' }, res: mkRes() }), (e) => e.status === 410, 'expired');
  assert.ok(hub._cache().bytes <= 100, 'cache stays within its limit');
});

test('hub: URL refs go through the SSRF-guarded fetcher with the media allowlist, and only if the agent mentioned them', async () => {
  const calls = []; const hub = mediaHub({ connectors: {}, fetchUrl: async (u, o) => { calls.push([u, o]); return { type: 'video/mp4', body: Buffer.from('v') }; } });
  assert.throws(() => hub.resolve({ scope: 'u', agent: 'a', ref: 'https://evil.example/x.mp4' }), /not offered/, 'not an open proxy');
  hub.note('u', 'a', 'MEDIA:https://cdn.example/x.mp4'); const r = hub.resolve({ scope: 'u', agent: 'a', ref: 'https://cdn.example/x.mp4' }); assert.equal(r.source, 'url');
  const res = mkRes(); await hub.serve({ token: r.url.split('/').pop(), scope: 'u', req: { headers: {}, method: 'GET' }, res }); assert.equal(res.headers['Content-Type'], 'video/mp4'); assert.ok(calls[0][1].types.has('video/mp4') && !calls[0][1].types.has('text/html') && !calls[0][1].types.has('image/svg+xml'));
  hub.note('u', 'a', 'MEDIA:/etc/passwd'); assert.throws(() => hub.resolve({ scope: 'u', agent: 'a', machineId: null, ref: '/etc/passwd' }), /not|cannot/);
});

test('end to end: the agent says MEDIA:<file> -> chat reply -> media link -> bytes through the real connector tunnel; unmentioned and out-of-root paths are refused', async (t) => {
  const dir = tmp(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const png = path.join(dir, 'chart.png'), other = path.join(dir, 'never-mentioned.png'); fs.writeFileSync(png, PNG); fs.writeFileSync(other, PNG);
  const frame = (c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`;
  const x = await setup(t, { gateway: false, mock: { streamFrames: [frame('Here is the chart\n'), frame(`MEDIA:${png}\n`), frame('[[audio_as_voice]]MEDIA:/etc/hostname.txt')] } });
  const post = (route, data) => fetch(x.base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const agent = await waitFor(async () => { const a = (await (await fetch(x.base + '/api/agents')).json()).agents.find((q) => q.chatReady); return a ?? null; }); assert.ok(agent, x.run.out + JSON.stringify((await (await fetch(x.base + '/api/agents')).json()).agents.map((q) => ({ n: q.name, o: q.online, c: q.chatReady, k: q.checks }))));
  const chat = await post(`/api/agents/${agent.name}/chat`, { messages: [{ role: 'user', content: 'chart please' }] }); assert.equal(chat.status, 200); const text = await chat.text(); assert.ok(text.includes('MEDIA:'));
  const ref = await post(`/api/agents/${agent.name}/media`, { ref: png }); assert.equal(ref.status, 200); const info = await ref.json(); assert.equal(info.kind, 'image');
  const got = await fetch(x.base + info.url); assert.equal(got.status, 200); assert.equal(got.headers.get('content-type'), 'image/png'); assert.deepEqual(Buffer.from(await got.arrayBuffer()), PNG);
  const rg = await fetch(x.base + info.url, { headers: { Range: 'bytes=0-7' } }); assert.equal(rg.status, 206); assert.equal((await rg.arrayBuffer()).byteLength, 8);
  assert.equal((await post(`/api/agents/${agent.name}/media`, { ref: other })).status, 404, 'a real file the agent never mentioned');
  const etc = await post(`/api/agents/${agent.name}/media`, { ref: '/etc/hostname.txt' }); assert.equal(etc.status, 200, 'mentioned, so a link exists...'); assert.ok([403, 404].includes((await fetch(x.base + (await etc.json()).url)).status), '...but the machine refuses a file outside its roots');
  assert.equal((await fetch(x.base + '/api/media/not-a-token')).status, 404);
});

test('security: nothing that can run in a browser is deliverable; hostile names cannot break headers; documents are attachments, never inline', async () => {
  const { MEDIA_TYPES } = await import('../media-proxy.js');
  for (const bad of ['image/svg+xml', 'text/html', 'application/xhtml+xml', 'application/javascript', 'text/xml']) assert.ok(!MEDIA_TYPES.has(bad), bad);
  const hostile = '/tmp/we;ird é <b>x</b> %0d%0a.txt';
  const hub = mediaHub({ connectors: stubConnectors({ [hostile]: { body: Buffer.from('hi'), mime: 'text/plain', name: 'evil"\r\nSet-Cookie: x=1.txt' } }) });
  hub.note('u', 'a', `MEDIA:"${hostile}"`); hub.note('u', 'a', 'MEDIA:"/tmp/a\r\nSet-Cookie: x.txt"'); assert.throws(() => hub.resolve({ scope: 'u', agent: 'a', machineId: 'm', ref: '/tmp/a\r\nSet-Cookie: x.txt' }), /not offered/, 'control characters in a path are never a tag');
  const r = hub.resolve({ scope: 'u', agent: 'a', machineId: 'm', ref: hostile }), res = mkRes();
  await hub.serve({ token: r.url.split('/').pop(), scope: 'u', req: { headers: {}, method: 'GET' }, res });
  const cd = res.headers['Content-Disposition']; assert.match(cd, /^attachment; filename\*=UTF-8''/); assert.ok(!/[\r\n"]/.test(cd), cd);
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff'); assert.match(res.headers['Content-Security-Policy'], /sandbox/);
  for (const svg of ['/tmp/a.svg', '/tmp/a.html', '/tmp/a.js']) { hub.note('u', 'a', `MEDIA:${svg}`); assert.throws(() => hub.resolve({ scope: 'u', agent: 'a', machineId: 'm', ref: svg }), /not offered|not delivered/); }
});
