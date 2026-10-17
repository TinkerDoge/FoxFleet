// Shared helpers for the 0.4.0 live v2 / chats / notification-reply tests: an SSE reader and a hub on a temp dir with a mock Hermes.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHub } from '../index.js';
import { mockHermes } from './fixtures.js';

export const PASS = 'correct horse battery staple';
export const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Reads an SSE response; frames: { raw, id, event, data, comment }. */
export function sse(t, url, headers = {}) {
  const ac = new AbortController(), frames = [], ping = new Set(); let status = 0, failure = null, done = false;
  (async () => {
    const r = await fetch(url, { headers, signal: ac.signal }); status = r.status; const dec = new TextDecoder(); let buf = '';
    if (!r.body) return;
    for await (const c of r.body) {
      buf += dec.decode(c, { stream: true }); let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2); const f = { raw, id: null, event: 'message', data: null, comment: raw.startsWith(':') ? raw : null };
        for (const line of raw.split('\n')) { if (line.startsWith('id: ')) f.id = line.slice(4); else if (line.startsWith('event: ')) f.event = line.slice(7); else if (line.startsWith('data: ')) { try { f.data = JSON.parse(line.slice(6)); } catch { f.data = line.slice(6); } } }
        frames.push(f); for (const p of ping) p();
      }
    }
    done = true; for (const p of ping) p();
  })().catch((e) => { failure = e; for (const p of ping) p(); });
  t.after(() => ac.abort());
  const wait = (pred, ms = 5000) => new Promise((resolve, reject) => {
    const check = () => { const f = frames.find(pred); if (f) { cleanup(); resolve(f); } };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`timed out; status ${status}, error ${failure?.message}, got ${JSON.stringify(frames.map((x) => x.raw)).slice(0, 4000)}`)); }, ms);
    const cleanup = () => { clearTimeout(timer); ping.delete(check); };
    ping.add(check); check();
  });
  return { frames, wait, stop: () => ac.abort(), get status() { return status; }, get done() { return done; }, events: (type) => frames.filter((f) => f.id && (!type || f.event === type)) };
}

/** A hub on a fresh temp dir (or `dir`), single-user unless `password` is given. Returns { server, base, dir, call, close }. */
export async function hub(t, { dir, password, keepDir = false, ...opts } = {}) {
  const own = !dir; dir ??= await mkdtemp(path.join(os.tmpdir(), 'foxfleet-live2-'));
  const server = await createHub({ configPath: path.join(dir, 'config.json'), ...(password ? { singleUser: false, ownerPassword: password } : { singleUser: true }), ...opts });
  const base = await listen(server); let closed = false;
  const close = () => (closed ? Promise.resolve() : (closed = true, server.closeAllConnections(), new Promise((r) => server.close(r))));
  t.after(async () => { await close(); if (own && !keepDir) await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); });
  const call = async (p, data, { method, headers = {} } = {}) => {
    const r = await fetch(base + p, { method: method ?? (data === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json', ...headers }, body: data === undefined ? undefined : typeof data === 'string' ? data : JSON.stringify(data), signal: AbortSignal.timeout(15_000) });
    const text = await r.text(); let body = {}; try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, body, headers: r.headers };
  };
  return { server, base, dir, call, close };
}

/** Mock Hermes whose transcript can change between requests (options.messages is read on every request). */
export async function hermes(t, options = {}) { const opts = { messages: [], ...options }; const mock = await mockHermes(t, opts); return { mock, opts }; }

export async function login(base, password = PASS) {
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password, client: 'app' }), signal: AbortSignal.timeout(10_000) });
  const b = await r.json(); assert.equal(r.status, 200); return { token: b.token, device: b.deviceId, h: { Authorization: `Bearer ${b.token}` } };
}

/** Poll until fn() returns a truthy value. */
export async function until(fn, { tries = 100, ms = 50 } = {}) { for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(ms); } throw new Error('condition never became true'); }
