import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '../src/api/client';
import type { AgentSummary } from '../src/api/types';
import { ChatView } from '../src/chat/ChatView';
import { resetChats } from '../src/chat/store';

// The message menu wired into the chat: right-click opens it, Delete for me hides with an Undo line, Reply fills the composer chip.
let host: HTMLDivElement;
const agent: AgentSummary = { id: 'atlas', name: 'atlas', kind: 'hermes', online: true, chatReady: true, capabilities: { sessions: true, reactions: true } };
const me = { id: 'me', name: 'Me', kind: 'human' as const };
const snap = (hidden: string[], messages: Record<string, { emoji: string; actors: typeof me[] }[]> = {}) => ({ actor: me, messages, hidden });
function fakeClient() {
  return {
    sessions: vi.fn(async () => ({ sessions: [], total: 0 })), skills: vi.fn(async () => []), runs: vi.fn(async () => []),
    messages: vi.fn(async () => ({ messages: [{ id: 'u1', role: 'user' as const, content: 'Ship it?' }, { id: 'a1', role: 'assistant' as const, content: 'Shipped.' }], hasMore: false })),
    reactions: vi.fn(async () => snap([])), react: vi.fn(async () => snap([])),
    hide: vi.fn(async (_a: string, _s: string, m: string, present: boolean) => snap(present ? [m] : [])),
    chat: vi.fn(), follow: vi.fn(), uploadFile: vi.fn(),
  } as unknown as Record<string, ReturnType<typeof vi.fn>>;
}
const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
const mount = async (client: object) => { await act(() => render(<ChatView client={client as Client} agent={agent} onAuthLost={() => {}} session="s1" />, host)); await flush(); };
const items = () => [...host.querySelectorAll<HTMLButtonElement>('.msg-menu [role=menuitem]')];
const rightClick = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 })); });

beforeEach(() => { localStorage.clear(); resetChats(); history.replaceState(null, '', '#/'); host = document.createElement('div'); document.body.append(host); });
afterEach(async () => { await act(() => render(null, host)); host.remove(); resetChats(); });

describe('message actions in the chat', () => {
  it('right-click opens the menu; Delete for me hides the message and Undo brings it back', async () => {
    const client = fakeClient(); await mount(client);
    await rightClick(host.querySelector('.msg-card')!);
    expect(items().map((b) => b.textContent)).toEqual(['Reply', 'Copy', 'Retry', 'Delete for me']);
    await act(() => items()[3].click()); await flush();
    expect(client.hide).toHaveBeenCalledWith('atlas', 's1', 'a1', true);
    expect(host.querySelector('.msg-menu')).toBeNull();
    expect(host.querySelector('.msg-card')).toBeNull();
    const undo = host.querySelector<HTMLButtonElement>('.hide-undo button')!;
    expect(host.querySelector('.hide-undo')!.textContent).toContain('Message hidden');
    await act(() => undo.click()); await flush();
    expect(client.hide).toHaveBeenLastCalledWith('atlas', 's1', 'a1', false);
    expect(host.querySelector('.msg-card')).not.toBeNull();
    expect(host.querySelector('.hide-undo')).toBeNull();
  });

  it('Reply puts a chip over the composer and focuses it; Escape returns focus to the ⋯ button', async () => {
    const client = fakeClient(); await mount(client);
    const more = host.querySelector<HTMLButtonElement>('.msg.assistant .msg-more')!;
    more.focus(); await act(() => more.click()); await flush();
    expect(host.querySelector('.msg-menu')).not.toBeNull();
    await act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); }); await flush();
    expect(host.querySelector('.msg-menu')).toBeNull();
    expect(document.activeElement).toBe(more);
    await act(() => more.click()); await flush();
    await act(() => items()[0].click()); await flush();
    expect(host.querySelector('.reply-chip')!.textContent).toContain('Shipped.');
    expect(document.activeElement).toBe(host.querySelector('textarea'));
  });

  it('the newest user message on a Hermes agent offers Edit', async () => {
    const client = fakeClient(); await mount(client);
    await rightClick(host.querySelector('.msg.user .bubble')!);
    expect(items().map((b) => b.textContent)).toEqual(['Reply', 'Copy', 'Edit', 'Delete for me']);
    expect(host.querySelector('.msg-menu-quick')).not.toBeNull();
  });

  it('a message without a hub id offers no React or Delete, but Reply and Copy still work', async () => {
    const client = fakeClient();
    client.messages.mockImplementation(async () => ({ messages: [{ role: 'user', content: 'Ship it?' }, { role: 'assistant', content: 'Shipped.' }], hasMore: false }));
    await mount(client);
    await rightClick(host.querySelector('.msg-card')!);
    expect(host.querySelector('.msg-menu-quick')).toBeNull();
    expect(items().map((b) => b.textContent)).toEqual(['Reply', 'Copy', 'Retry']);
  });

  it('a menu opened by right-click gives focus to the messages log when it closes, not the composer', async () => {
    const client = fakeClient(); await mount(client);
    host.querySelector('textarea')!.focus();
    await rightClick(host.querySelector('.msg-card')!);
    await act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); }); await flush();
    expect(document.activeElement).toBe(host.querySelector('.messages'));
  });

  it('the ⋯ button is expanded and controls the menu while it is open', async () => {
    const client = fakeClient(); await mount(client);
    const more = host.querySelector<HTMLButtonElement>('.msg.assistant .msg-more')!;
    await act(() => more.click()); await flush();
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(more.getAttribute('aria-controls')!)).toBe(host.querySelector('.msg-menu'));
  });

  it('the quick row takes back an emoji you already gave', async () => {
    const client = fakeClient(); client.reactions.mockImplementation(async () => snap([], { a1: [{ emoji: '👍', actors: [me] }] })); await mount(client);
    await rightClick(host.querySelector('.msg-card')!);
    await act(() => host.querySelector<HTMLButtonElement>('.msg-menu-quick button')!.click()); await flush();
    expect(client.react).toHaveBeenCalledWith('atlas', 's1', 'a1', '👍', false);
  });

  it('Undo waits for its hide to reach the hub first', async () => {
    const client = fakeClient(); let release!: () => void;
    client.hide.mockImplementationOnce((_a: string, _s: string, m: string) => new Promise((r) => { release = () => r(snap([m])); }));
    await mount(client);
    await rightClick(host.querySelector('.msg-card')!);
    await act(() => items()[3].click()); await flush();
    await act(() => host.querySelector<HTMLButtonElement>('.hide-undo button')!.click()); await flush();
    expect(client.hide).toHaveBeenCalledTimes(1);
    await act(async () => { release(); }); await flush();
    expect(client.hide.mock.calls.map((c) => c[3])).toEqual([true, false]);
    expect(host.querySelector('.msg-card')).not.toBeNull();
  });

  it('a failed hide brings the message back without the Undo line; a failed unhide says so', async () => {
    const client = fakeClient(); client.hide.mockRejectedValueOnce(new Error('x')); await mount(client);
    await rightClick(host.querySelector('.msg-card')!);
    await act(() => items()[3].click()); await flush();
    expect(host.querySelector('.msg-card')).not.toBeNull(); expect(host.querySelector('.hide-undo')).toBeNull();
    expect(host.querySelector('.react-error')!.textContent).toBe("Couldn't hide the message. Try again.");
    client.hide.mockImplementationOnce(async (_a: string, _s: string, m: string) => snap([m])).mockRejectedValueOnce(new Error('y'));
    await rightClick(host.querySelector('.msg-card')!);
    await act(() => items()[3].click()); await flush();
    await act(() => host.querySelector<HTMLButtonElement>('.hide-undo button')!.click()); await flush();
    expect(host.querySelector('.react-error')!.textContent).toBe("Couldn't show the message again.");
  });

  it('Retry needs the reply to be the last message; Edit needs a reply after the user message', async () => {
    const client = fakeClient();
    client.messages.mockImplementation(async () => ({ messages: [{ id: 'u1', role: 'user', content: 'Ship it?' }, { id: 'a1', role: 'assistant', content: 'Shipped.' }, { id: 'u2', role: 'user', content: 'And now?' }], hasMore: false }));
    await mount(client);
    await rightClick(host.querySelector('.msg-card')!);
    expect(items().map((b) => b.textContent)).toEqual(['Reply', 'Copy', 'Delete for me']);
    await act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    await rightClick([...host.querySelectorAll('.msg.user .bubble')].at(-1)!);
    expect(items().map((b) => b.textContent)).toEqual(['Reply', 'Copy', 'Delete for me']);
  });
});
