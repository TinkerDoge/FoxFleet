import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { fetchImage, isPublicIp, parseTarget } from '../media-proxy.js';

test('address classifier blocks private, loopback, link-local, CGNAT, mapped and special ranges', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.2.5',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '64:ff9b::1', '2001:db8::1', '2002:7f00:1::', 'not-an-ip', '']) assert.equal(isPublicIp(ip), false, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.63.0.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPublicIp(ip), true, ip);
});
test('target parser refuses non-https, credentials, odd ports, garbage', () => {
  for (const u of ['http://example.com/a.png', 'ftp://example.com/a', 'https://user:pw@example.com/a.png', 'https://example.com:8443/a.png', 'javascript:alert(1)', 'file:///etc/passwd', 'nope', '']) assert.throws(() => parseTarget(u), (e) => e.status === 400, u);
  assert.equal(parseTarget('https://example.com/a.png?x=1').hostname, 'example.com');
});

// A fake https.request that serves scripted responses.
function fakeRequest(script, seen = []) {
  return (opts, cb) => {
    seen.push(opts); const req = new EventEmitter(); req.destroy = (e) => req.emit('error', e); req.end = () => {
      const r = script.shift(); const body = Readable.from(r.chunks ?? [Buffer.from(r.body ?? '')]); body.statusCode = r.status ?? 200; body.headers = r.headers ?? {}; queueMicrotask(() => cb(body));
    }; return req;
  };
}
const png = Buffer.from('89504e470d0a1a0a', 'hex');
const pub = async () => [{ address: '93.184.216.34', family: 4 }];
test('fetches a public image, pinned to the validated address, with SNI and no cookies', async () => {
  const seen = []; const r = await fetchImage('https://img.example.com/a.png', { lookup: pub, request: fakeRequest([{ headers: { 'content-type': 'image/png; charset=x' }, body: png }], seen) });
  assert.equal(r.type, 'image/png'); assert.deepEqual(r.body, png);
  assert.equal(seen[0].host, '93.184.216.34'); assert.equal(seen[0].servername, 'img.example.com'); assert.equal(seen[0].headers.Host, 'img.example.com'); assert.ok(!('Cookie' in seen[0].headers));
});
test('refuses hosts resolving to any private address (rebinding mix) and IP literals', async () => {
  const mixed = async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }];
  await assert.rejects(fetchImage('https://evil.example.com/a.png', { lookup: mixed, request: fakeRequest([]) }), (e) => e.status === 403);
  for (const u of ['https://127.0.0.1/a.png', 'https://[::1]/a.png', 'https://169.254.169.254/latest/meta-data', 'https://[::ffff:10.0.0.1]/a.png']) await assert.rejects(fetchImage(u, { lookup: pub, request: fakeRequest([]) }), (e) => e.status === 403, u);
});
test('validates every redirect hop and caps hops', async () => {
  const to = (l) => ({ status: 302, headers: { location: l } });
  await assert.rejects(fetchImage('https://a.example.com/x', { lookup: pub, request: fakeRequest([to('https://127.0.0.1/p.png')]) }), (e) => e.status === 403);
  await assert.rejects(fetchImage('https://a.example.com/x', { lookup: pub, request: fakeRequest([to('http://b.example.com/p.png')]) }), (e) => e.status === 400);
  await assert.rejects(fetchImage('https://a.example.com/x', { lookup: pub, request: fakeRequest([to('/1'), to('/2'), to('/3')]) }), (e) => e.status === 502);
  const ok = await fetchImage('https://a.example.com/x', { lookup: pub, request: fakeRequest([to('/final.png'), { headers: { 'content-type': 'image/webp' }, body: 'RIFF' }]) }); assert.equal(ok.type, 'image/webp');
});
test('type and size limits: no SVG/HTML, content-length and streamed overflow both refused', async () => {
  for (const type of ['image/svg+xml', 'text/html', 'application/octet-stream', '']) await assert.rejects(fetchImage('https://a.example.com/x', { lookup: pub, request: fakeRequest([{ headers: { 'content-type': type }, body: 'x' }]) }), (e) => e.status === 415, type);
  await assert.rejects(fetchImage('https://a.example.com/x', { lookup: pub, maxBytes: 10, request: fakeRequest([{ headers: { 'content-type': 'image/png', 'content-length': '11' }, body: 'x' }]) }), (e) => e.status === 413);
  await assert.rejects(fetchImage('https://a.example.com/x', { lookup: pub, maxBytes: 10, request: fakeRequest([{ headers: { 'content-type': 'image/png' }, chunks: [Buffer.alloc(6), Buffer.alloc(6)] }]) }), (e) => e.status === 413);
  await assert.rejects(fetchImage('https://a.example.com/x', { lookup: pub, request: fakeRequest([{ status: 404, headers: {} }]) }), (e) => e.status === 502);
});
test('route: needs a session and refuses bad targets without touching the network', async (t) => {
  const os = await import('node:os'), fs = await import('node:fs/promises'), path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxfleet-mp-')); const { createHub } = await import(`../index.js?mp=${Math.random()}`);
  const server = await createHub({ configPath: path.join(dir, 'config.json'), singleUser: true }); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await fs.rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`, q = (u) => fetch(`${base}/api/media-proxy?url=${encodeURIComponent(u)}`);
  assert.equal((await q('http://example.com/a.png')).status, 400); assert.equal((await q('https://127.0.0.1/a.png')).status, 403); assert.equal((await q('')).status, 400);
});
