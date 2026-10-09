import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Client } from '../src/api/client';
import type { AgentSummary } from '../src/api/types';
import { NetworkError } from '../src/api/errors';
import { ChatView } from '../src/chat/ChatView';
import { chatOf, resetChats } from '../src/chat/store';
import { navigate, useRoute } from '../src/router';

let host: HTMLDivElement, client: Client;
const agent: AgentSummary = { id: 'a', name: 'a', displayName: 'Atlas', kind: 'hermes', online: true, chatReady: true, capabilities: { sessions: true } };
function RoutedChat() { const route = useRoute(); return <ChatView client={client} agent={agent} session={route.params.get('new') === '1' ? '' : route.params.get('session') ?? undefined} onAuthLost={() => {}} />; }
const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
const historyButton = () => host.querySelector<HTMLButtonElement>('.sessions-anchor>button')!;
beforeEach(() => {
  localStorage.clear(); resetChats(); history.replaceState(null, '', '#/chat?agent=a&session=s1'); host = document.createElement('div'); document.body.append(host);
  client = { sessions: vi.fn(async () => ({ sessions: [{ id: 's1', title: 'One' }, { id: 's2', title: 'Two' }], total: 2 })), skills: vi.fn(async () => []), messages: vi.fn(async (_a, id) => ({ messages: [{ role: 'assistant', content: `Transcript ${id}` }], hasMore: false })), runs: vi.fn(async () => []), queue: vi.fn(async () => ({ items: [], recent: [], activeRun: null, halted: false, openRequests: [], modes: [], canCancel: true })) } as unknown as Client;
});
afterEach(async () => { await act(() => render(null, host)); host.remove(); resetChats(); });

it('same-agent URL changes select the intended transcript and preserve each session draft', async () => {
  await act(() => render(<RoutedChat />, host)); await flush();
  const editor = () => host.querySelector('textarea')!;
  await act(() => { editor().value = 'Draft one'; editor().dispatchEvent(new Event('input', { bubbles: true })); });
  await act(() => { history.replaceState(null, '', '#/chat?agent=a&session=s2'); window.dispatchEvent(new Event('hashchange')); }); await flush();
  expect(host.querySelector('.messages')!.textContent).toContain('Transcript s2'); expect(editor().value).toBe('');
  await act(() => { editor().value = 'Draft two'; editor().dispatchEvent(new Event('input', { bubbles: true })); });
  await act(() => { history.replaceState(null, '', '#/chat?agent=a&session=s1'); window.dispatchEvent(new Event('hashchange')); }); await flush();
  expect(chatOf('a').session).toBe('s1'); expect(editor().value).toBe('Draft one'); expect(location.hash).toContain('session=s1');
});
it('History selection adds a navigation entry and Back/Forward restore the expected session', async () => {
  await act(() => render(<RoutedChat />, host)); await flush();
  await act(() => historyButton().click()); await flush(); await act(() => host.querySelector<HTMLButtonElement>('[data-sid=s2]')!.click());
  await vi.waitFor(async () => { await flush(); expect(chatOf('a').session).toBe('s2'); expect(location.hash).toContain('session=s2'); });
  await act(async () => { history.back(); await new Promise((r) => setTimeout(r, 25)); }); await flush();
  expect(chatOf('a').session).toBe('s1'); expect(host.querySelector('.messages')!.textContent).toContain('Transcript s1');
  await act(async () => { history.forward(); await new Promise((r) => setTimeout(r, 25)); }); await flush(); expect(chatOf('a').session).toBe('s2');
});
it('a first history failure explains the problem and Retry clears it without showing false empty history', async () => {
  let fail = true; vi.mocked(client.sessions).mockImplementation(async () => { if (fail) throw new NetworkError(); return { sessions: [{ id: 's1', title: 'One' }], total: 1 }; });
  await act(() => render(<RoutedChat />, host)); await flush(); await act(() => historyButton().click()); await flush();
  expect(host.querySelector('.sessions [role=alert]')).not.toBeNull(); expect(host.querySelector('.sessions')!.textContent).not.toContain('No earlier');
  fail = false; const retry = [...host.querySelectorAll<HTMLButtonElement>('.sessions button')].find((b) => b.textContent === 'Retry')!;
  await act(() => retry.click()); await flush(); expect(host.querySelector('.sessions [role=alert]')).toBeNull(); expect(host.querySelector('[data-sid=s1]')).not.toBeNull();
});
it('New chat removes the session from the route and starts with a separate composer', async () => {
  await act(() => render(<RoutedChat />, host)); await flush();
  await act(() => host.querySelector<HTMLButtonElement>('.chat-secondary button')!.click()); await flush();
  expect(chatOf('a').session).toBeUndefined(); expect(location.hash).toBe('#/chat?agent=a&new=1'); expect(host.querySelector('textarea')!.value).toBe('');
  await act(() => navigate('chat', { agent: 'a', session: 's2' }, true)); await flush(); expect(chatOf('a').session).toBe('s2');
});
it('Back returns to a blank New chat with its own draft', async () => {
  await act(() => render(<RoutedChat />, host)); await flush();
  await act(() => host.querySelector<HTMLButtonElement>('.chat-secondary button')!.click()); await flush();
  const editor = () => host.querySelector('textarea')!;
  await act(() => { editor().value = 'Unsent new draft'; editor().dispatchEvent(new Event('input', { bubbles: true })); });
  await act(() => navigate('chat', { agent: 'a', session: 's2' })); await flush();
  await act(async () => { history.back(); await new Promise((r) => setTimeout(r, 25)); }); await flush();
  expect(chatOf('a').session).toBeUndefined(); expect(editor().value).toBe('Unsent new draft'); expect(location.hash).toContain('new=1');
});
it('a late Delete response does not redirect a newer session', async () => {
  let finish!: () => void; client.deleteSession = vi.fn(() => new Promise<void>((r) => { finish = r; })); vi.spyOn(window, 'confirm').mockReturnValue(true);
  await act(() => render(<RoutedChat />, host)); await flush(); await act(() => historyButton().click()); await flush();
  await act(() => host.querySelector<HTMLButtonElement>('[aria-label="Delete: One"]')!.click());
  await act(() => navigate('chat', { agent: 'a', session: 's2' })); await flush();
  await act(async () => { finish(); await Promise.resolve(); }); await flush();
  expect(chatOf('a').session).toBe('s2'); expect(location.hash).toContain('session=s2'); vi.restoreAllMocks();
});
