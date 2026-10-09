// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/** Runs public/sw.js in a sandbox with a fake service-worker scope and returns its listeners plus the cache log. */
function load(version = 'v1') {
  const listeners: Record<string, (e: any) => void> = {}, store = new Map<string, Map<string, unknown>>(), puts: string[] = [], fetched: string[] = [];
  const caches = {
    open: async (name: string) => { const m = store.get(name) ?? new Map(); store.set(name, m); return { addAll: async (l: string[]) => l.forEach((u) => m.set(u, 'x')), put: async (r: any) => { puts.push(r.url); m.set(r.url, 1); } }; },
    keys: async () => [...store.keys()], delete: async (k: string) => store.delete(k),
    match: async (r: any) => { const u = typeof r === 'string' ? r : new URL(r.url).pathname; for (const m of store.values()) if (m.has(u)) return { cached: u }; return undefined; },
  };
  let skipped = false;
  const self: any = { location: { origin: 'https://hub.example.com' }, addEventListener: (t: string, f: any) => (listeners[t] = f), skipWaiting: () => (skipped = true), clients: { claim: async () => {} } };
  const src = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8').replace('__VERSION__', version).replace('__SHELL__', JSON.stringify(['/', '/index.html', '/assets/app-AbCd1234.js']));
  vm.runInNewContext(src, { self, caches, URL, fetch: async (r: any) => { fetched.push(r.url); return { ok: true, type: 'basic', clone() { return this; } }; }, Headers });
  const fire = (req: { url: string; method?: string; mode?: string; headers?: Record<string, string> }) => {
    let handled: Promise<any> | null = null;
    const request = { method: 'GET', mode: 'cors', ...req, headers: new Headers(req.headers) };
    listeners.fetch({ request, respondWith: (p: Promise<any>) => (handled = p) }); return handled;
  };
  return { listeners, store, puts, fetched, fire, skipped: () => skipped, self };
}
const O = 'https://hub.example.com';

describe('service worker', () => {
  it('precaches only the app shell on install, under a versioned cache name', async () => {
    const sw = load('abc'); let done: Promise<any> = Promise.resolve(); await sw.listeners.install({ waitUntil: (p: Promise<any>) => (done = p) }); await done;
    expect([...sw.store.keys()]).toEqual(['foxfleet-shell-abc']); expect([...sw.store.get('foxfleet-shell-abc')!.keys()]).toEqual(['/', '/index.html', '/assets/app-AbCd1234.js']);
  });
  it('NEVER intercepts the API, health, mcp, connector, pairing page or non-GET / cross-origin / range requests', () => {
    const sw = load();
    for (const u of ['/api/agents', '/api/auth', '/api/agents/a/chat', '/api/agents/a/screen/ws', '/health', '/mcp', '/connector.mjs', '/pair', '/avatars/x.png']) expect(sw.fire({ url: O + u }), u).toBeNull();
    expect(sw.fire({ url: O + '/assets/app-AbCd1234.js', method: 'POST' })).toBeNull();
    expect(sw.fire({ url: 'https://cdn.example.net/assets/x.js' })).toBeNull();
    expect(sw.fire({ url: O + '/assets/app-AbCd1234.js', headers: { range: 'bytes=0-9' } })).toBeNull();
    expect(sw.fetched).toEqual([]); expect(sw.puts).toEqual([]);
  });
  it('serves shell assets from cache first and the shell offline for navigations; navigations try the network first', async () => {
    const sw = load(); let done: Promise<any> = Promise.resolve(); await sw.listeners.install({ waitUntil: (p: Promise<any>) => (done = p) }); await done;
    expect(await sw.fire({ url: O + '/assets/app-AbCd1234.js' })).toEqual({ cached: '/assets/app-AbCd1234.js' }); expect(sw.fetched).toEqual([]);
    await sw.fire({ url: O + '/chat', mode: 'navigate' }); expect(sw.fetched).toEqual([O + '/chat']);
  });
  it('drops old versions on activate and only skips waiting when the page asks', async () => {
    const sw = load('new'); sw.store.set('foxfleet-shell-old', new Map()); sw.store.set('other-app', new Map());
    let done: Promise<any> = Promise.resolve(); sw.listeners.activate({ waitUntil: (p: Promise<any>) => (done = p) }); await done;
    expect([...sw.store.keys()]).toEqual(['other-app']);
    expect(sw.skipped()).toBe(false); sw.listeners.message({ data: { type: 'nope' } }); expect(sw.skipped()).toBe(false); sw.listeners.message({ data: { type: 'SKIP_WAITING' } }); expect(sw.skipped()).toBe(true);
  });
});
