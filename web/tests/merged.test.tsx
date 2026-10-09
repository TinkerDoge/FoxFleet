import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '../src/api/client';
import type { AgentSummary } from '../src/api/types';
import { ChatView } from '../src/chat/ChatView';
import { SessionsMenu } from '../src/chat/SessionsMenu';
import { chatOf, resetChats } from '../src/chat/store';
import { loadSaved, saveChat } from '../src/lib/persist';

// Desktop-dashboard drafts and keyboard menu + resumable runs and history, working together.
let host: HTMLDivElement;
const agent: AgentSummary = { id: 'atlas', name: 'atlas', kind: 'hermes', online: true, chatReady: true, capabilities: { sessions: true } };
const now = Date.now();
const sessions = [{ id: 's1', title: 'First', updated: now - 60_000, preview: 'hello there', messages: 2 }, { id: 's2', title: 'Second', updated: now - 3600_000, preview: 'more', messages: 4 }];
const page = (m: string) => ({ messages: [{ role: 'user' as const, content: `q ${m}` }, { role: 'assistant' as const, content: `a **${m}**` }], hasMore: false });
let hold: (() => void) | undefined;
function fakeClient(over: Record<string, unknown> = {}) {
  return {
    sessions: vi.fn(async () => ({ sessions, total: 2 })), skills: vi.fn(async () => []), messages: vi.fn(async (_a: string, id: string) => page(id)),
    runs: vi.fn(async () => []), stopRun: vi.fn(async () => {}), renameSession: vi.fn(async () => {}), deleteSession: vi.fn(async () => {}),
    chat: vi.fn(), follow: vi.fn(), uploadFile: vi.fn(), ...over,
  } as unknown as Client & Record<string, ReturnType<typeof vi.fn>>;
}
const mount = async (client: Client, session?: string) => { await act(() => render(<ChatView client={client} agent={agent} onAuthLost={() => {}} session={session} />, host)); await flush(); };
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
const editor = () => host.querySelector('textarea')!;
const type = (v: string) => act(() => { editor().value = v; editor().dispatchEvent(new Event('input', { bubbles: true })); });
const trigger = () => host.querySelector<HTMLButtonElement>('[aria-haspopup="menu"][id$="-trigger"]')!;
const items = () => [...host.querySelectorAll<HTMLButtonElement>('.sessions [role="menuitem"]')];
const rowOpen = (id: string) => host.querySelector<HTMLButtonElement>(`[data-sid="${id}"]`)!;

beforeEach(() => { localStorage.clear(); resetChats(); history.replaceState(null, '', '#/'); host = document.createElement('div'); document.body.append(host); });
afterEach(async () => { hold?.(); hold = undefined; await act(() => render(null, host)); host.remove(); resetChats(); });

describe('sessions menu is the single history UI', () => {
  it('lists title, time and preview from the history API and loads a session when chosen; the draft stays with its session', async () => {
    const client = fakeClient(); await mount(client);
    await type('draft for the new chat');
    await act(() => trigger().click()); await flush();
    expect(client.sessions).toHaveBeenCalledTimes(2); // on mount and when the menu opens
    expect(host.querySelector('.sessions')!.textContent).toContain('hello there');
    await act(() => rowOpen('s1').click()); await flush();
    expect(client.messages).toHaveBeenCalledWith('atlas', 's1');
    expect(host.querySelector('.messages')!.textContent).toContain('q s1'); expect(host.querySelector('.messages strong')!.textContent).toBe('s1'); // markdown pipeline
    expect(editor().value).toBe(''); await type('draft in s1');
    await act(() => trigger().click()); await flush(); await act(() => items().find((i) => i.textContent === 'New chat')!.click());
    await act(() => trigger().click()); await flush(); await act(() => rowOpen('s2').click()); await flush();
    expect(editor().value).toBe('');
    await act(() => trigger().click()); await flush(); await act(() => rowOpen('s1').click()); await flush();
    expect(editor().value).toBe('draft in s1'); // per agent + session draft survived the switch
    expect(loadSaved('atlas').session).toBe('s1'); // and the chosen session is what a reload restores
  });

  it('rename, delete, load more and refresh work from the menu; delete discards that session draft', async () => {
    const more = { sessions: [{ id: 's3', title: 'Third' }], total: 3 };
    const client = fakeClient({ sessions: vi.fn(async (_a: string, o?: { offset?: number }) => (o?.offset ? more : { sessions, total: 3 })) });
    await mount(client); await act(() => trigger().click()); await flush();
    expect(items().some((i) => i.getAttribute('aria-label')?.startsWith('Rename'))).toBe(true);
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label^="Rename"]')!.click(); });
    const input = host.querySelector<HTMLInputElement>('.session-edit input')!; input.value = 'Renamed'; await act(async () => { input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { host.querySelector<HTMLFormElement>('.session-edit')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); await flush();
    expect(client.renameSession).toHaveBeenCalledWith('atlas', 's1', 'Renamed'); expect(chatOf('atlas').sessions[0].title).toBe('Renamed');
    await act(async () => { items().find((i) => i.textContent === 'Load more')!.click(); }); await flush();
    expect(chatOf('atlas').sessions.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await act(() => host.querySelector<HTMLButtonElement>('[aria-label^="Delete"]')!.click()); await flush();
    expect(client.deleteSession).toHaveBeenCalledWith('atlas', 's1');
    expect(chatOf('atlas').sessions.some((s) => s.id === 's1')).toBe(false);
  });

  it('keeps the keyboard behaviour: arrows move over rows and actions, Escape closes and returns focus to the trigger', async () => {
    const client = fakeClient(); await mount(client); trigger().focus();
    const key = async (k: string) => act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });
    await key('ArrowDown'); await flush(); expect(document.activeElement).toBe(items()[0]);
    await key('ArrowDown'); expect(document.activeElement).toBe(items()[1]); // rename action of the first row
    await key('End'); expect(document.activeElement).toBe(items().at(-1));
    await key('Home'); expect(document.activeElement).toBe(items()[0]);
    await key('Escape'); expect(host.querySelector('[role="menu"]')).toBeNull(); expect(document.activeElement).toBe(trigger());
  });

  it('the plain list (no handlers) is still exactly one menu item per session', async () => {
    await act(() => render(<SessionsMenu sessions={sessions} current="s2" open onOpenChange={() => {}} onSelect={() => {}} />, host));
    expect(items()).toHaveLength(2); expect(items().map((i) => i.dataset.sid)).toEqual(['s1', 's2']);
  });
});

describe('drafts, saved runs and Stop together', () => {
  it('a reload re-attaches to the in-progress run, the unsent draft is not lost, and the reply lands in the chat', async () => {
    saveChat('atlas', { session: 's1', run: 'r1', user: 'question', started: now });
    let finish!: () => void;
    const client = fakeClient({
      runs: vi.fn(async () => [{ id: 'r1', session_id: 's1', state: 'running', started: now, events: 1 }]),
      follow: vi.fn(async (_a: string, _r: string, _n: number, cb: { onContent: (t: string) => void }) => { cb.onContent('partial '); await new Promise<void>((r) => { finish = r; }); cb.onContent('done'); }),
    });
    await mount(client, 's1'); await flush();
    expect(client.follow).toHaveBeenCalledWith('atlas', 'r1', 0, expect.anything());
    expect(chatOf('atlas').streaming).toBe(true); expect(host.textContent).toContain('partial');
    await type('typed while the reply streams');
    await act(async () => { finish(); await Promise.resolve(); }); await flush();
    expect(chatOf('atlas').streaming).toBe(false); expect(host.querySelector('.messages')!.textContent).toContain('partial done');
    expect(editor().value).toBe('typed while the reply streams');
    expect(loadSaved('atlas').run).toBeUndefined(); // the finished run is no longer re-attached on the next reload
  });

  it('a draft typed in a brand-new chat follows it when the hub assigns the session id; sending clears it', async () => {
    const client = fakeClient({
      chat: vi.fn(async (_a: string, _h: unknown, cb: { onSession: (id: string) => void; onRun?: (id: string) => void; onContent: (t: string) => void }) => { cb.onSession('new1'); cb.onContent('ok'); return 'new1'; }),
    });
    await mount(client); await type('first message');
    await act(() => host.querySelector<HTMLButtonElement>('.send')!.click()); await flush();
    expect(client.chat).toHaveBeenCalled(); expect(chatOf('atlas').session).toBe('new1'); expect(editor().value).toBe('');
  });

  it('Stop cancels the run on the hub (and only Stop does)', async () => {
    const client = fakeClient({
      chat: vi.fn((_a: string, _h: unknown, cb: { onRun?: (id: string) => void; signal?: AbortSignal }) => new Promise((_res, rej) => { cb.onRun?.('run9'); cb.signal?.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError'))); })),
    });
    await mount(client); await type('go'); await act(() => host.querySelector<HTMLButtonElement>('.send')!.click()); await flush();
    expect(chatOf('atlas').streaming).toBe(true);
    // leaving the view detaches without cancelling
    expect(client.stopRun).not.toHaveBeenCalled();
    await act(() => host.querySelector<HTMLButtonElement>('.send.stop')!.click()); await flush();
    expect(client.stopRun).toHaveBeenCalledWith('atlas', 'run9'); expect(chatOf('atlas').streaming).toBe(false);
  });
});
