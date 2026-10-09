import { describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/api/client';
import { loadSaved, saveChat, clearSaved, lastAgent, rememberAgent, forgetAll } from '../src/lib/persist';

const enc = new TextEncoder();
const ev = (id: number, text: string) => `id: ${id}\ndata: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
const sse = (chunks: string[], { breakAfter = false, headers = {} as Record<string, string> } = {}) => { const q = [...chunks]; return new Response(new ReadableStream({
  pull(c) { const x = q.shift(); if (x !== undefined) c.enqueue(enc.encode(x)); else if (breakAfter) c.error(new TypeError('network')); else c.close(); },
}), { status: 200, headers: { 'Content-Type': 'text/event-stream', ...headers } }); };

describe('chat stream resume', () => {
  it('reconnects from the last event id when the connection drops mid-reply, with no repeated text', async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith('/chat')) return sse([ev(1, 'Hel'), ev(2, 'lo ')], { breakAfter: true, headers: { 'X-Foxfleet-Run': 'run1', 'X-Hermes-Session-Id': 'sess-1' } });
      return sse([ev(3, 'wor'), ev(4, 'ld'), 'data: [DONE]\n\n']);
    });
    const client = createClient({ fetch: fetch as never });
    let text = ''; let run = '';
    const sid = await client.chat('atlas', [{ role: 'user', content: 'hi' }], { onContent: (d) => { text += d; }, onReasoning() {}, onTool() {}, onSession() {}, onRun: (r) => { run = r; } });
    expect(text).toBe('Hello world'); expect(run).toBe('run1'); expect(sid).toBe('sess-1');
    expect(calls[1]).toContain('/runs/run1/events?after=2');
  });
  it('does not resume after an abort, and gives up politely when the run expired', async () => {
    const ctrl = new AbortController();
    const fetch = vi.fn(async (url: string) => { if (url.endsWith('/chat')) { ctrl.abort(); throw new DOMException('Aborted', 'AbortError'); } return sse([]); });
    await expect(createClient({ fetch: fetch as never }).chat('a', [{ role: 'user', content: 'x' }], { signal: ctrl.signal, onContent() {}, onReasoning() {}, onTool() {}, onSession() {} })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    const gone = vi.fn(async (url: string) => (url.endsWith('/chat') ? sse([ev(1, 'a')], { breakAfter: true, headers: { 'X-Foxfleet-Run': 'r' } }) : new Response('{}', { status: 404 })));
    let t = ''; const state = vi.fn(); await createClient({ fetch: gone as never }).chat('a', [{ role: 'user', content: 'x' }], { onContent: (d) => { t += d; }, onReasoning() {}, onTool() {}, onSession() {}, onRunState: state }); expect(t).toBe('a'); expect(state).toHaveBeenCalledWith('unavailable');
  });
  it('follow() replays a finished run from the start, stop sends a POST to the run', async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => url.includes('/stop') ? new Response(JSON.stringify({ run: { id: 'r', state: 'stopped' } }), { status: 200, headers: { 'Content-Type': 'application/json' } }) : sse([ev(1, 'All '), ev(2, 'done'), 'data: [DONE]\n\n'], { headers: { 'X-Foxfleet-Run': 'r' } }));
    const client = createClient({ fetch: fetch as never }); let t = '';
    await client.follow('atlas', 'r', 0, { onContent: (d) => { t += d; }, onReasoning() {}, onTool() {}, onSession() {} }); expect(t).toBe('All done');
    await client.stopRun('atlas', 'r'); expect((fetch.mock.calls.at(-1) as [string, RequestInit])[1].method).toBe('POST');
  });
});

describe('remembered chat', () => {
  it('stores ids per agent and survives a reload; sign-out forgets everything', () => {
    forgetAll(); expect(loadSaved('atlas')).toEqual({});
    saveChat('atlas', { session: 's1' }); saveChat('atlas', { run: 'r1', user: 'hello' }); rememberAgent('atlas');
    expect(loadSaved('atlas')).toMatchObject({ session: 's1', run: 'r1', user: 'hello' }); expect(lastAgent()).toBe('atlas');
    saveChat('atlas', { run: undefined, user: undefined }); expect(loadSaved('atlas')).toEqual({ session: 's1' });
    clearSaved('atlas'); expect(loadSaved('atlas')).toEqual({}); saveChat('nova', { session: 'x' }); forgetAll(); expect(loadSaved('nova')).toEqual({}); expect(lastAgent()).toBeUndefined();
  });
  it('ignores garbage in storage', () => { localStorage.setItem('foxfleet.chat.bad', '{not json'); expect(loadSaved('bad')).toEqual({}); });
});
