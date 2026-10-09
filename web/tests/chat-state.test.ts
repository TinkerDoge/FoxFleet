import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client, StreamOpts } from '../src/api/client';
import { ApiError, AuthRequiredError, NetworkError } from '../src/api/errors';
import { chatOf, loadAgent, loadSessions, newChat, openSession, reconnectReply, resetChats, restore, send } from '../src/chat/store';
import { forgetAll, saveChat } from '../src/lib/persist';

const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const page = (text: string) => ({ messages: [{ role: 'user' as const, content: text }], hasMore: false });
const client = (overrides: object = {}) => ({ messages: vi.fn(async (_a: string, id: string) => page(id)), sessions: vi.fn(async () => ({ sessions: [{ id: 's1', title: 'Release' }], total: 2 })), skills: vi.fn(async () => []), runs: vi.fn(async () => []), queue: vi.fn(async () => ({ items: [], recent: [], activeRun: null, halted: false, openRequests: [], canCancel: true, modes: [] })), ...overrides }) as unknown as Client;
beforeEach(() => { resetChats(); forgetAll(); });

describe('conversation selection', () => {
  it('restores an explicitly blank chat instead of the remembered session', async () => {
    await openSession(client(), 'a', 's1', () => {}); await restore(client(), 'a', '', () => {});
    expect(chatOf('a').session).toBeUndefined(); expect(chatOf('a').messages).toEqual([]);
  });
  it('prevents new sends while the selected session is discovering its existing run', async () => {
    const runs = deferred<any[]>(), chat = vi.fn(); const c = client({ runs: vi.fn(() => runs.promise), chat });
    const opening = restore(c, 'a', 's1', () => {}); await vi.waitFor(() => expect(c.runs).toHaveBeenCalled());
    expect(chatOf('a').loading).toBe(true); await send(c, 'a', 'New task', [], [], () => {}); expect(chat).not.toHaveBeenCalled();
    runs.resolve([]); await opening; expect(chatOf('a').loading).toBe(false);
  });
  it('restores an explicit same-agent link even with an existing transcript', async () => {
    const c = client(); await openSession(c, 'a', 's2', () => {});
    await restore(c, 'a', 's1', () => {});
    expect(chatOf('a').session).toBe('s1'); expect(chatOf('a').messages[0].content).toBe('s1');
  });
  it('ignores a slow transcript after selecting another conversation', async () => {
    const old = deferred<ReturnType<typeof page>>();
    const c = client({ messages: vi.fn(async (_a: string, id: string) => id === 's1' ? old.promise : page(id)) });
    const first = openSession(c, 'a', 's1', () => {}); await openSession(c, 'a', 's2', () => {}); old.resolve(page('late s1')); await first;
    expect(chatOf('a').session).toBe('s2'); expect(chatOf('a').messages[0].content).toBe('s2');
  });
  it('New chat invalidates pending loads and clears the active display state', async () => {
    const old = deferred<ReturnType<typeof page>>(); const c = client({ messages: vi.fn(() => old.promise) });
    const first = openSession(c, 'a', 's1', () => {}); newChat('a'); old.resolve(page('late')); await first;
    expect(chatOf('a')).toMatchObject({ messages: [], loading: false, streaming: false }); expect(chatOf('a').session).toBeUndefined();
  });
  it('does not attach a stale run after navigating to another session', async () => {
    const old = deferred<any[]>(); const follow = vi.fn();
    const c = client({ runs: vi.fn((_a: string, id: string) => id === 's1' ? old.promise : Promise.resolve([])), follow });
    const first = restore(c, 'a', 's1', () => {}); await vi.waitFor(() => expect(c.runs).toHaveBeenCalled());
    await restore(c, 'a', 's2', () => {}); old.resolve([{ id: 'r1', started: 1, state: 'running' }]); await first;
    expect(follow).not.toHaveBeenCalled(); expect(chatOf('a').session).toBe('s2');
  });
  it('detaches without stopping the hub run, then follows that run on return', async () => {
    const pending = deferred<string>(); let options!: StreamOpts;
    const c = client({ chat: vi.fn((_a, _h, o) => { options = o; o.onSession('s1'); o.onRun('r1'); return pending.promise; }), stopRun: vi.fn(), runs: vi.fn(async (_a, id) => id === 's1' ? [{ id: 'r1', state: 'running', started: 1 }] : []), follow: vi.fn(async (_a, _r, _after, o) => { o.onContent('Recovered'); }) });
    const task = send(c, 'a', 'Work', [], [], () => {}); await restore(c, 'a', 's2', () => {});
    options.onContent('late'); pending.resolve('s1'); await task;
    expect(chatOf('a').session).toBe('s2'); expect(c.stopRun).not.toHaveBeenCalled();
    await restore(c, 'a', 's1', () => {}); expect(c.follow).toHaveBeenCalledWith('a', 'r1', 0, expect.anything());
    expect(chatOf('a').messages.at(-1)?.content).toBe('Recovered');
  });
  it('reloads the remembered session when there is no explicit session', async () => {
    saveChat('a', { session: 's1' }); await restore(client(), 'a', undefined, () => {}); expect(chatOf('a').session).toBe('s1');
  });
});

describe('history failures', () => {
  it('keeps stale rows and exposes refresh/pagination errors, clearing them on success', async () => {
    const c = client(); await loadSessions(c, 'a');
    vi.mocked(c.sessions).mockRejectedValueOnce(new NetworkError()); await loadSessions(c, 'a', true);
    expect(chatOf('a').sessions).toHaveLength(1); expect(chatOf('a').sessionsError).toBeTruthy(); expect(chatOf('a').sessionsLoading).toBe(false);
    await loadSessions(c, 'a'); expect(chatOf('a').sessionsError).toBeUndefined();
  });
  it('exposes an initial history failure without losing available skills', async () => {
    await loadAgent(client({ sessions: vi.fn(async () => { throw new NetworkError(); }), skills: vi.fn(async () => ['review']) }), 'a', () => {});
    expect(chatOf('a').sessionsError).toBeTruthy(); expect(chatOf('a').skills).toEqual(['review']);
  });
  it('does not swallow authentication loss from the initial history request', async () => {
    const lost = vi.fn(); await loadAgent(client({ sessions: vi.fn(async () => { throw new AuthRequiredError(); }) }), 'a', lost); expect(lost).toHaveBeenCalledOnce();
  });
});

describe('request status', () => {
  it('does not label an unavailable reply stream as completed', async () => {
    const c = client({ chat: vi.fn(async (_a, _h, o) => { o.onRun('r1'); o.onContent('Partial'); o.onRunState('unavailable'); return 's1'; }) });
    await send(c, 'a', 'Work', [], [], () => {}); expect(chatOf('a').runState).toBe('unknown'); expect(chatOf('a').recovery).toBe('check');
  });
  it('reconnects an identified run without resending or duplicating its partial answer', async () => {
    const c = client({ chat: vi.fn(async (_a, _h, o) => { o.onRun('r1'); o.onContent('Part'); throw new NetworkError(); }), follow: vi.fn(async (_a, _run, _after, o) => { o.onSession('s1'); o.onContent('Part and complete'); }) });
    await send(c, 'a', 'Work', [], [], () => {}); await reconnectReply(c, 'a', () => {});
    expect(c.chat).toHaveBeenCalledOnce(); expect(c.follow).toHaveBeenCalledOnce(); expect(chatOf('a').messages.filter((m) => m.role === 'assistant').map((m) => m.content)).toEqual(['Part and complete']);
  });
  it('distinguishes submission, acceptance, execution and completion using actual callbacks', async () => {
    const done = deferred<string>(); let options!: StreamOpts;
    const c = client({ chat: vi.fn((_a, _h, o) => { options = o; return done.promise; }) });
    const task = send(c, 'a', 'Work', [], [], () => {}); expect(chatOf('a').runState).toBe('submitting');
    options.onRun?.('r1'); expect(chatOf('a').runState).toBe('accepted');
    options.onContent('Answer'); expect(chatOf('a').runState).toBe('working');
    done.resolve('s1'); await task; expect(chatOf('a').runState).toBe('completed');
  });
  it('offers safe reconnection for an accepted run, and retry only for a definite rejection', async () => {
    const c = client({ chat: vi.fn(async (_a, _h, o) => { o.onRun('r1'); throw new NetworkError(); }) });
    await send(c, 'a', 'Work', [], [], () => {}); expect(chatOf('a').recovery).toBe('reconnect');
    newChat('a'); vi.mocked(c.chat).mockRejectedValueOnce(new ApiError(429, 'Busy'));
    await send(c, 'a', 'Work', [], [], () => {}); expect(chatOf('a').recovery).toBe('retry');
    newChat('a'); vi.mocked(c.chat).mockRejectedValueOnce(new NetworkError());
    await send(c, 'a', 'Work', [], [], () => {}); expect(chatOf('a').recovery).toBe('check');
  });
  it('shows a failed terminal event as failure even when the stream closes normally', async () => {
    const c = client({ chat: vi.fn(async (_a, _h, o) => { o.onRun('r1'); o.onRunState('error'); return 's1'; }) });
    await send(c, 'a', 'Work', [], [], () => {}); expect(chatOf('a').runState).toBe('failed'); expect(chatOf('a').error).toBeTruthy();
  });
});
