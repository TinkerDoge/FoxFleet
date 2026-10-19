import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createClient } from '../src/api/client';
import type { Client } from '../src/api/client';
import type { Conversation } from '../src/api/types';
import { navigate, parseRoute } from '../src/router';
import { Shell } from '../src/screens/Shell';
import { resetChats } from '../src/chat/store';
import { mentionsIn, resetConversations } from '../src/conversations/store';

const now = 1_700_000_000_000;
const room: Conversation = {
  id: 'fc_abcdefghijklmnop', thread_id: 'fcr_abcdefghijklmnop', chat_type: 'group', title: 'Launch room',
  owner: { id: 'u1', name: 'Ada', kind: 'human', is_bot: false },
  members: [{ id: 'agent:helper', name: 'helper', kind: 'agent', is_bot: true }],
  created_at: now, updated_at: now, last_message_at: now,
};
const flush = async () => { for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); }); };
let host: HTMLDivElement;
beforeEach(() => {
  localStorage.clear(); resetChats(); resetConversations(); host = document.createElement('div'); document.body.append(host);
  vi.stubGlobal('matchMedia', vi.fn((q: string) => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});
afterEach(async () => { await act(() => render(null, host)); host.remove(); resetChats(); resetConversations(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('parses rooms as their own route, separate from agent and chat routes', () => {
  expect(parseRoute('#/conversations').name).toBe('conversations');
  const view = parseRoute('#/conversations?id=fc_abcdefghijklmnop&details=1');
  expect(view.name).toBe('conversations'); expect(view.params.get('id')).toBe('fc_abcdefghijklmnop'); expect(view.params.get('details')).toBe('1');
  expect(parseRoute('#/conversations?new=1').params.get('new')).toBe('1');
  expect(parseRoute('#/chat?agent=helper').name).toBe('chat');
  navigate('conversations', { id: 'fc_abcdefghijklmnop', details: '1' });
  expect(location.hash).toBe('#/conversations?id=fc_abcdefghijklmnop&details=1');
});

it('client talks to /api/conversations with the cookie owner only (never an actor or admit)', async () => {
  const seen: { url: string; init: any }[] = [];
  const f = (async (url: string, init: any) => { seen.push({ url: String(url), init }); return new Response(JSON.stringify({ message: { id: 'fm_1', conversation_id: room.id, sender: room.owner, text: 'hi', created_at: now }, conversation_id: room.id }), { status: 202 }); }) as any;
  const client = createClient({ base: 'https://hub.example.com', fetch: f });
  await client.conversations({ limit: 10 });
  await client.conversation(room.id);
  await client.conversationMessages(room.id, { limit: 20 });
  await client.sendConversationMessage(room.id, { text: 'hi', mentions: [{ kind: 'agent', id: 'agent:helper', offset: 0, length: 7 }], client_id: 'c1' });
  await client.markConversationRead(room.id, 9);
  await client.stopConversation(room.id);
  await client.resumeConversation(room.id);
  expect(seen.map((s) => s.url.replace('https://hub.example.com', ''))).toEqual([
    '/api/conversations?limit=10&offset=0',
    `/api/conversations/${room.id}`,
    `/api/conversations/${room.id}/messages?limit=20`,
    `/api/conversations/${room.id}/messages`,
    `/api/conversations/${room.id}/read`,
    `/api/conversations/${room.id}/stop`,
    `/api/conversations/${room.id}/resume`,
  ]);
  const body = JSON.parse(seen[3].init.body);
  expect(body).toEqual({ text: 'hi', mentions: [{ kind: 'agent', id: 'agent:helper', offset: 0, length: 7 }], client_id: 'c1' });
  expect(body).not.toHaveProperty('actor'); expect(body).not.toHaveProperty('admit');
  expect(seen.every((s) => s.init.credentials === 'same-origin')).toBe(true);
});

it('the shell shows rooms at #/conversations without inventing a room-agent, and keeps the DM route intact', async () => {
  const client = {
    agents: vi.fn(async () => [{ id: 'a', name: 'helper', displayName: 'Helper', kind: 'hermes', online: true, chatReady: true, capabilities: { sessions: false } }]),
    conversations: vi.fn(async () => ({ conversations: [room], total: 1 })),
    conversation: vi.fn(async () => room),
    conversationMessages: vi.fn(async () => ({ messages: [], has_more: false })),
    markConversationRead: vi.fn(async () => room),
    skills: vi.fn(async () => []),
    sessions: vi.fn(async () => ({ sessions: [], total: 0 })),
  } as unknown as Client;
  history.replaceState(null, '', '#/conversations');
  await act(() => render(<Shell client={client} info={{ required: true, authenticated: true, setupRequired: false, setupCodeRequired: false, registration: 'closed', user: { id: 'u1', username: 'Ada', role: 'owner' } }} onSignedOut={() => {}} />, host)); await flush();
  expect(host.querySelector('.rooms')).toBeTruthy();
  expect(host.querySelector('.rooms-list')!.textContent).toContain('Launch room');
  expect(host.querySelector('.room-link')).toBeTruthy();
  expect(host.querySelector('.chat')).toBeNull();
  expect(host.textContent).not.toContain('Agent unavailable');

  history.replaceState(null, '', '#/chat?agent=helper');
  window.dispatchEvent(new Event('hashchange')); await flush();
  expect(host.querySelector('.chat')).toBeTruthy();
  expect(host.querySelector('.rooms')).toBeNull();
  expect(host.querySelector('.room-link')).toBeTruthy(); // the separate rooms entry stays, the DM path is unchanged
});

it('mention ids are member actor ids, not display names', () => {
  const members = [{ id: 'agent:sumi-native', name: 'Sumi', kind: 'agent' as const, is_bot: true }];
  expect(mentionsIn('@Sumi check this', members)).toEqual([{ kind: 'agent', id: 'agent:sumi-native', offset: 0, length: 5 }]);
  expect(mentionsIn('@sumi too', members)[0].id).toBe('agent:sumi-native');
  expect(mentionsIn('mail@Sumi', members)).toEqual([]);
});
