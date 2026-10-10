import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, isTransientStatus, backoff } from '../src/api/client';
import { ApiError, AuthRequiredError, NetworkError } from '../src/api/errors';
import { chatOf, resetChats, send } from '../src/chat/store';

/** A fault-injecting stand-in for "Cloudflare in front of the hub": scripted 502s, resets and streams that die mid-reply. */
const enc = new TextEncoder();
const ev = (id: number, text: string) => `id: ${id}\ndata: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
const sse = (chunks: string[], { cut = false, headers = {} as Record<string, string> } = {}) => { const q = [...chunks]; return new Response(new ReadableStream({
  pull(c) { const x = q.shift(); if (x !== undefined) c.enqueue(enc.encode(x)); else if (cut) c.error(new TypeError('connection reset')); else c.close(); },
}), { status: 200, headers: { 'Content-Type': 'text/event-stream', ...headers } }); };
const json = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const bad = () => json(502, { error: 'Bad gateway' });
const cb = () => { const o = { text: '', reconnecting: 0, run: '' }; return { o, opts: { onContent: (d: string) => { o.text += d; }, onReasoning() {}, onTool() {}, onSession() {}, onRun: (r: string) => { o.run = r; }, onReconnecting: () => { o.reconnecting++; } } }; };

describe('transient failures never sign anyone out', () => {
  it('classifies gateway statuses', () => { for (const s of [408, 502, 503, 504, 520, 522, 524]) expect(isTransientStatus(s)).toBe(true); for (const s of [200, 400, 401, 403, 404, 409, 429, 500]) expect(isTransientStatus(s)).toBe(false); });
  it('backoff grows, is capped and jittered', () => { const v = Array.from({ length: 50 }, () => backoff(10, 400, 8000)); expect(Math.max(...v)).toBeLessThanOrEqual(8000); expect(Math.min(...v)).toBeGreaterThanOrEqual(4000); expect(new Set(v).size).toBeGreaterThan(5); });
  it('an idempotent GET rides out a few 502s and a reset without the caller noticing', async () => {
    const script = [bad, bad, () => { throw new TypeError('reset'); }, () => json(200, { agents: [{ name: 'a' }] })]; const f = vi.fn(async () => script.shift()!());
    expect((await createClient({ fetch: f as never, retryBaseMs: 1 }).agents()).length).toBe(1); expect(f).toHaveBeenCalledTimes(4);
  });
  it('a long outage ends as a plain network/503 error, not a sign-out', async () => {
    const f = vi.fn(async () => json(503)); const e = await createClient({ fetch: f as never, retryBaseMs: 1 }).agents().catch((x) => x);
    expect(e).toBeInstanceOf(ApiError); expect(e).not.toBeInstanceOf(AuthRequiredError); expect(e.status).toBe(503);
  });
  it('writes are never replayed by the transport', async () => {
    const f = vi.fn(async () => bad()); await createClient({ fetch: f as never, retryBaseMs: 1 }).stopRun('a', 'r').catch(() => {}); expect(f).toHaveBeenCalledTimes(1);
  });
  it('a 401 while the hub cannot be reached (502 on /api/auth, reset) is NOT a sign-out', async () => {
    for (const authReply of [bad, () => { throw new TypeError('reset'); }] as (() => Response)[]) {
      const f = vi.fn(async (u: string) => (String(u).endsWith('/api/auth') ? authReply() : json(401, { error: 'x' })));
      const e = await createClient({ fetch: f as never, retryBaseMs: 1 }).agents().catch((x) => x); expect(e).not.toBeInstanceOf(AuthRequiredError); expect(e).toBeInstanceOf(NetworkError);
    }
  });
  it('only the hub saying "not authenticated" signs out', async () => {
    const f = (auth: unknown) => vi.fn(async (u: string) => (String(u).endsWith('/api/auth') ? json(200, auth) : json(401, { error: 'Login required' })));
    await expect(createClient({ fetch: f({ required: true, authenticated: false }) as never, retryBaseMs: 1 }).agents()).rejects.toBeInstanceOf(AuthRequiredError);
    const e = await createClient({ fetch: f({ required: true, authenticated: true }) as never, retryBaseMs: 1 }).agents().catch((x) => x); expect(e).not.toBeInstanceOf(AuthRequiredError); expect(e.status).toBe(502);
  });
});

describe('streams resume through tunnel faults', () => {
  it('the SSE drops mid-reply, the resume gets 502 twice and a reset, then continues from the cursor with no repeated text', async () => {
    const calls: string[] = []; const resume = [bad, bad, () => { throw new TypeError('reset'); }, () => sse([ev(3, 'wor'), ev(4, 'ld'), 'data: [DONE]\n\n'])];
    const f = vi.fn(async (u: string) => { calls.push(u); if (u.endsWith('/chat')) return sse([ev(1, 'Hel'), ev(2, 'lo ')], { cut: true, headers: { 'X-Foxfleet-Run': 'run1' } }); return resume.shift()!(); });
    const { o, opts } = cb(); await createClient({ fetch: f as never, retryBaseMs: 1 }).chat('atlas', [{ role: 'user', content: 'hi' }], opts);
    expect(o.text).toBe('Hello world'); expect(o.reconnecting).toBeGreaterThanOrEqual(4); expect(calls.filter((u) => u.includes('after=2')).length).toBe(4); expect(calls.filter((u) => u.endsWith('/chat')).length).toBe(1);
  });
  it('a gateway-timeout page instead of the stream (Cloudflare 524) is retried, not shown as a failed reply', async () => {
    const resume = [() => json(524), () => sse([ev(2, 'b'), 'data: [DONE]\n\n'])];
    const f = vi.fn(async (u: string) => (u.endsWith('/chat') ? sse([ev(1, 'a')], { cut: true, headers: { 'X-Foxfleet-Run': 'r9' } }) : resume.shift()!()));
    const { o, opts } = cb(); await createClient({ fetch: f as never, retryBaseMs: 1 }).chat('a', [{ role: 'user', content: 'x' }], opts); expect(o.text).toBe('ab');
  });
  it('follow() (page reload or second device) also survives faults', async () => {
    const seq = [bad, () => sse([ev(1, 'x'), ev(2, 'y')], { cut: true }), () => sse([ev(3, 'z'), 'data: [DONE]\n\n'])]; const f = vi.fn(async () => seq.shift()!());
    const { o, opts } = cb(); await createClient({ fetch: f as never, retryBaseMs: 1 }).follow('a', 'run', 0, opts); expect(o.text).toBe('xyz');
  });
});

describe('the store keeps the session and the message through an outage', () => {
  beforeEach(() => { resetChats(); localStorage.clear(); });
  it('the submit dies with a 502; the hub already started the run: we follow it, send nothing twice, no error, still signed in', async () => {
    const started = Date.now(); let posted = 0, auth = 0;
    const f = vi.fn(async (u: string, init?: RequestInit) => {
      if (u.endsWith('/api/auth')) { auth++; return json(200, { required: true, authenticated: true }); }
      if (u.endsWith('/chat')) return bad();
      if (u.includes('/runs?') || u.endsWith('/runs')) return json(200, { runs: [{ id: 'runA', session_id: 's1', state: 'running', started: started + 5, events: 1 }] });
      if (u.includes('/runs/runA/events')) return sse([ev(1, 'All '), ev(2, 'done'), 'data: [DONE]\n\n'], { headers: { 'X-Hermes-Session-Id': 's1' } });
      if (u.includes('/messages')) { posted++; return json(200, { message: { id: 'm', state: 'queued', mode: 'queue', text: 'hi' } }); }
      if (u.includes('/queue')) return json(200, { items: [], recent: [], halted: false, active_run: null });
      if (u.includes('/sessions')) return json(200, { sessions: [], total: 0 });
      return json(404);
    });
    const lost = vi.fn(); await send(createClient({ fetch: f as never, retryBaseMs: 1 }), 'atlas', 'hi', [], [], lost);
    const c = chatOf('atlas'); expect(lost).not.toHaveBeenCalled(); expect(posted).toBe(0); expect(c.error).toBeUndefined();
    expect(c.messages.map((m) => m.role + ':' + m.content)).toEqual(['user:hi', 'assistant:All done']); expect(c.streaming).toBe(false);
  }, 20000);
  it('the hub did not get it: it is re-sent once through /messages with one client_id, even across more 502s', async () => {
    const ids = new Set<string>(); let tries = 0;
    const f = vi.fn(async (u: string, init?: RequestInit) => {
      if (u.endsWith('/api/auth')) return json(200, { required: true, authenticated: true });
      if (u.endsWith('/chat')) throw new TypeError('reset');
      if (u.includes('/runs?') || u.endsWith('/runs')) return json(200, { runs: [] });
      if (u.includes('/messages')) { tries++; ids.add(JSON.parse(String(init?.body)).client_id); if (tries < 3) return bad(); return json(200, { message: { id: 'm1', state: 'running', mode: 'queue', text: 'hi' }, run_id: 'runB', session_id: 's2' }); }
      if (u.includes('/runs/runB/events')) return sse([ev(1, 'Hi!'), 'data: [DONE]\n\n']);
      if (u.includes('/queue')) return json(200, { items: [], recent: [], halted: false, active_run: null });
      if (u.includes('/sessions')) return json(200, { sessions: [], total: 0 });
      return json(404);
    });
    await send(createClient({ fetch: f as never, retryBaseMs: 1 }), 'atlas2', 'hi', [], [], () => {});
    const c = chatOf('atlas2'); expect(tries).toBe(3); expect(ids.size).toBe(1); expect(c.messages.map((m) => m.content)).toEqual(['hi', 'Hi!']); expect(c.error).toBeUndefined();
  }, 30000);
});
