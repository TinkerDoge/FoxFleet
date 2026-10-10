// Chat scroll behaviour in a DOM simulation: jsdom has no layout, so the scroller's geometry is simulated (height grows with its children).
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Client } from '../src/api/client';
import type { AgentSummary } from '../src/api/types';
import { ChatView } from '../src/chat/ChatView';
import { notice, resetChats } from '../src/chat/store';

let host: HTMLDivElement, client: Client, rows = 30;
const agent: AgentSummary = { id: 'a', name: 'a', displayName: 'Atlas', kind: 'hermes', online: true, chatReady: true, capabilities: { sessions: true } };
const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
const msgs = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'user' : 'assistant', content: `message ${from + i}` }));
const el = () => host.querySelector<HTMLDivElement>('.messages')!, button = () => host.querySelector<HTMLButtonElement>('.to-bottom')!;
/** 100px per child, a 500px viewport; scrollTop is a plain number the test (and the code) can set. */
function geometry(node: HTMLDivElement, state = { top: 0 }) {
  Object.defineProperty(node, 'clientHeight', { get: () => 500, configurable: true });
  Object.defineProperty(node, 'scrollHeight', { get: () => node.children.length * 100 + 40, configurable: true });
  Object.defineProperty(node, 'scrollTop', { get: () => state.top, set: (v: number) => { state.top = Math.max(0, Math.min(v, node.scrollHeight - 500)); }, configurable: true });
  node.scrollTo = ((o: ScrollToOptions) => { state.top = Math.min(o.top ?? 0, node.scrollHeight - 500); node.dispatchEvent(new Event('scroll')); }) as typeof node.scrollTo;
  return state;
}
const scrollTo = async (node: HTMLDivElement, state: { top: number }, top: number) => act(() => { state.top = top; node.dispatchEvent(new Event('scroll')); });
beforeEach(() => {
  localStorage.clear(); resetChats(); rows = 30; history.replaceState(null, '', '#/chat?agent=a&session=s1'); host = document.createElement('div'); document.body.append(host);
  client = { sessions: vi.fn(async () => ({ sessions: [{ id: 's1', title: 'One' }], total: 1 })), skills: vi.fn(async () => []), messages: vi.fn(async () => ({ messages: msgs(rows), hasMore: false })) } as unknown as Client;
});
afterEach(async () => { await act(() => render(null, host)); host.remove(); resetChats(); });

async function open() {
  let state = { top: 0 };
  await act(() => render(<ChatView client={client} agent={agent} session="s1" onAuthLost={() => {}} />, host)); await flush();
  state = geometry(el()); await act(async () => { notice('a', 'warm up'); }); await flush(); // one more render so the simulated geometry is used
  return state;
}

it('opens at the bottom, shows the arrow after scrolling up, and tapping goes back down', async () => {
  const state = await open(); state.top = el().scrollHeight - 500; await scrollTo(el(), state, el().scrollHeight - 500);
  expect(button().classList.contains('show')).toBe(false);
  await scrollTo(el(), state, 1000); // 1000 -> more than 120px from the bottom
  expect(button().classList.contains('arrow')).toBe(true); expect(button().classList.contains('show')).toBe(true); expect(button().getAttribute('aria-hidden')).toBeNull();
  await act(() => button().click()); await flush();
  expect(state.top).toBe(el().scrollHeight - 500); expect(button().classList.contains('show')).toBe(false);
});

it('a message arriving while scrolled up becomes a counted pill and does not move the view; tapping resets it', async () => {
  const state = await open(); await scrollTo(el(), state, 500);
  await act(async () => { notice('a', 'first new'); }); await flush();
  expect(state.top).toBe(500); expect(button().classList.contains('pill')).toBe(true); expect(button().textContent).toContain('New message');
  await act(async () => { notice('a', 'second new'); }); await flush();
  expect(state.top).toBe(500); expect(button().textContent).toContain('2 new messages');
  await act(() => button().click()); await flush();
  expect(state.top).toBe(el().scrollHeight - 500); expect(button().classList.contains('show')).toBe(false);
});

it('while at the bottom a new message keeps the view pinned and shows no control', async () => {
  const state = await open(); await scrollTo(el(), state, el().scrollHeight - 500);
  await act(async () => { notice('a', 'pinned reply'); }); await flush();
  expect(state.top).toBe(el().scrollHeight - 500); expect(button().classList.contains('show')).toBe(false);
});

it('late layout shifts (a picture finishing) keep a pinned view at the bottom', async () => {
  const state = await open(); await scrollTo(el(), state, el().scrollHeight - 500);
  // an <img> inside the list finishing its load bubbles `load` to the scroller (onLoadCapture)
  const row = el().querySelector('.msg')!; const img = document.createElement('img'); row.append(img);
  const extra = document.createElement('div'); el().append(extra); // content grew by 100px
  await act(() => { img.dispatchEvent(new Event('load')); });
  expect(state.top).toBe(el().scrollHeight - 500);
});

it('switching chats starts at the bottom again with no pill', async () => {
  const state = await open(); await scrollTo(el(), state, 300);
  await act(async () => { notice('a', 'unseen'); }); await flush(); expect(button().classList.contains('pill')).toBe(true);
  await act(() => render(<ChatView client={client} agent={{ ...agent, name: 'b', id: 'b' }} session="s9" onAuthLost={() => {}} />, host)); await flush();
  expect(button().classList.contains('show')).toBe(false);
});
