import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client, OpenRequest } from '../src/api/client';
import type { AuthInfo, Conversation, ConversationMessage } from '../src/api/types';
import { ApiError } from '../src/api/errors';
import { ConversationList } from '../src/conversations/ConversationList';
import { CreateConversation } from '../src/conversations/CreateConversation';
import { ConversationView } from '../src/conversations/ConversationView';
import { applyLiveEvent, connectLive, conversationsState, disconnectLive, loadRoom, markRoomRead, resetConversations, roomView, setActiveRoom } from '../src/conversations/store';

const now = 1_700_000_000_000;
const room = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'fc_abcdefghijklmnop', thread_id: 'fcr_abcdefghijklmnop', chat_type: 'group', title: 'Launch room',
  owner: { id: 'u1', name: 'Ada', kind: 'human', is_bot: false },
  members: [{ id: 'agent:helper', name: 'helper', kind: 'agent', is_bot: true }, { id: 'agent:reviewer', name: 'reviewer', kind: 'agent', is_bot: true }],
  created_at: now, updated_at: now, last_message_at: now, unread_count: 2, ...over,
});
const message = (over: Partial<ConversationMessage> = {}): ConversationMessage => ({
  id: 'fm_aaaaaaaaaaaaaaaa', conversation_id: 'fc_abcdefghijklmnop', sender: { id: 'u1', name: 'Ada', kind: 'human', is_bot: false },
  text: 'Hello', created_at: now, seq: 1, ...over,
});
const info: AuthInfo = { required: true, authenticated: true, setupRequired: false, setupCodeRequired: false, registration: 'closed', user: { id: 'u1', username: 'Ada', role: 'owner' } };
const flush = async () => { for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); }); };
const owner = { id: 'u1', name: 'Ada', kind: 'human' as const, is_bot: false };
const emptyQueue = { items: [], recent: [], halted: false, activeRun: null, modes: ['queue'], openRequests: [] as OpenRequest[], canCancel: false };
const approvalCard: OpenRequest = { id: 'frq_aaaaaaaaaaaaaaaa', kind: 'approval', questions: [], command: 'rm -rf build', description: 'Deploy cleanup' };
const clarifyCard: OpenRequest = { id: 'frq_cccccccccccccccc', kind: 'clarify', questions: [{ id: 'q1', question: 'Which host?', choices: ['prod', 'staging'], multi: false }] };
let host: HTMLDivElement;

function makeClient(over: Record<string, unknown> = {}) {
  return {
    conversation: vi.fn(async () => room()),
    queue: vi.fn(async () => ({ ...emptyQueue })),
    answerRequest: vi.fn(async () => ({ ok: true })),
    conversationMessages: vi.fn(async () => ({ messages: [], has_more: false })),
    conversationMessage: vi.fn(async () => message({ id: 'fm_2', sender: { id: 'agent:helper', name: 'helper', kind: 'agent', is_bot: true }, text: 'On it.' })),
    conversations: vi.fn(async () => ({ conversations: [room()], total: 1 })),
    createConversation: vi.fn(async () => room()),
    sendConversationMessage: vi.fn(async (_id: string, o: any) => ({ message: message({ id: 'fm_sent', text: o.text, sender: owner, mentions: o.mentions }), conversation_id: 'fc_abcdefghijklmnop' })),
    markConversationRead: vi.fn(async () => room({ unread_count: 0 })),
    stopConversation: vi.fn(async () => ({ stopped: true, confirmed: true, state: 'stopped', paused: true })),
    resumeConversation: vi.fn(async () => room({ paused: false })),
    conversationPreferences: vi.fn(async (_id: string, p: any) => p),
    renameConversation: vi.fn(async (_id: string, title: string) => room({ title })),
    addConversationMember: vi.fn(async () => room()),
    removeConversationMember: vi.fn(async () => room()),
    uploadConversationMedia: vi.fn(async () => ({ id: 'fbm_1', kind: 'file', mime: 'text/plain', name: 'notes.txt', size: 12 })),
    conversationMediaUrl: (id: string, m: string) => `/api/conversations/${id}/media/${m}`,
    liveStreamUrl: () => '/api/live/stream?v=2',
    ...over,
  } as unknown as Client;
}
const clientOf = (c: Client) => c as any;
const view = (client: Client, over: Partial<Parameters<typeof ConversationView>[0]> = {}) => act(() => render(<ConversationView client={client} info={info} agents={[]} conversationId={room().id} detailsOpen={false} onAuthLost={() => {}} {...over} />, host));
const text = (sel: string) => host.querySelector(sel)?.textContent ?? '';

beforeEach(() => {
  localStorage.clear(); resetConversations(); history.replaceState(null, '', '#/conversations');
  vi.stubGlobal('matchMedia', vi.fn((q: string) => ({ matches: q.includes('760') ? window.innerWidth <= 760 : false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  (HTMLElement.prototype as any).scrollIntoView = vi.fn();
  host = document.createElement('div'); document.body.append(host);
});
afterEach(async () => { await act(() => render(null, host)); host.remove(); resetConversations(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('rooms list and creation', () => {
  it('lists rooms, filters by title or member, and navigates to create', async () => {
    const a = room(), b = room({ id: 'fc_bbbbbbbbbbbbbbbb', title: 'Ops night', members: [{ id: 'agent:ops', name: 'ops', kind: 'agent', is_bot: true }] });
    const client = makeClient({ conversations: vi.fn(async () => ({ conversations: [a, b], total: 2 })) });
    await act(() => render(<ConversationList client={client} onAuthLost={() => {}} />, host)); await flush();
    expect(host.querySelectorAll('.room-row')).toHaveLength(2); expect(text('.rooms-list')).toContain('Launch room'); expect(text('.rooms-list')).toContain('ops');
    const search = host.querySelector<HTMLInputElement>('.rooms-search input')!;
    await act(() => { search.value = 'ops'; search.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(host.querySelectorAll('.room-row')).toHaveLength(1); expect(text('.rooms-list')).toContain('Ops night');
    await act(() => (host.querySelector('.rooms-head button') as HTMLButtonElement).click());
    expect(location.hash).toContain('new=1');
  });

  it('creates a room with a title and chosen agent members', async () => {
    const client = makeClient();
    const agents = [{ id: 'a', name: 'helper', kind: 'hermes', online: true, chatReady: true }, { id: 'b', name: 'reviewer', kind: 'hermes', online: false, chatReady: true }];
    await act(() => render(<CreateConversation client={client} agents={agents} onAuthLost={() => {}} />, host));
    const field = host.querySelector<HTMLInputElement>('#f-room-title')!;
    await act(() => { field.value = 'Planning'; field.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(() => { host.querySelectorAll<HTMLInputElement>('.pick-list input')[1].click(); });
    await act(() => { (host.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); await flush();
    expect(clientOf(client).createConversation).toHaveBeenCalledWith(expect.objectContaining({ title: 'Planning', member_ids: ['reviewer'] }));
    expect(location.hash).toContain('id=fc_abcdefghijklmnop');
  });
});

describe('the group scenario', () => {
  const transcript = [
    message({ id: 'fm_1', text: 'Hello @helper, take a look', mentions: [{ kind: 'agent', id: 'agent:helper', offset: 6, length: 7 }], created_at: now }),
    message({ id: 'fm_2', seq: 2, sender: { id: 'agent:helper', name: 'helper', kind: 'agent', is_bot: true }, text: 'On it.', created_at: now + 1 }),
    message({ id: 'fm_3', seq: 3, sender: { id: 'agent:helper', name: 'helper', kind: 'agent', is_bot: true }, text: 'Reviewer, please check.', reply_to: 'fm_2', created_at: now + 2 }),
    message({ id: 'fm_4', seq: 4, sender: { id: 'agent:reviewer', name: 'reviewer', kind: 'agent', is_bot: true }, text: '', created_at: now + 3, media: [{ id: 'fbm_img', kind: 'image', mime: 'image/png', name: 'shot.png', size: 10 }, { id: 'fbm_file', kind: 'file', mime: 'text/plain', name: 'notes.txt', size: 12 }] }),
    message({ id: 'fm_5', seq: 5, sender: { id: 'agent:reviewer', name: 'reviewer', kind: 'agent', is_bot: true }, system: true, code: 'handoff_limit', text: 'Handoff refused: the chain used its dispatches.', created_at: now + 4 }),
  ];

  it.each([390, 1280])('renders named authors, mentions, reply jump, handoff markers, cards and media at %ipx', async (width) => {
    (window as any).innerWidth = width;
    const client = makeClient({
      conversationMessages: vi.fn(async () => ({ messages: transcript, has_more: false })),
      queue: vi.fn(async (agent: string) => ({ ...emptyQueue, openRequests: agent === 'helper' ? [approvalCard] : [] })),
    });
    await view(client); await flush();
    const authors = [...host.querySelectorAll('.room-author b')].map((n) => n.textContent);
    expect(authors).toContain('Ada'); expect(authors).toContain('helper'); expect(authors).toContain('reviewer'); expect(host.querySelector('.room-author .room-tag')!.textContent).toBe('You');
    expect(host.querySelector('.mention')!.textContent).toBe('@helper');
    expect(text('.room-notice')).toContain('Handoff refused');
    expect(host.querySelectorAll('.room-tag.handoff').length).toBe(1);
    expect(host.querySelector<HTMLImageElement>('.room-media img')!.getAttribute('src')).toContain('/api/conversations/fc_abcdefghijklmnop/media/fbm_img');
    expect(text('.room-file')).toContain('notes.txt');
    expect(text('.request.approval')).toContain('rm -rf build');
    const quote = host.querySelector<HTMLButtonElement>('.reply-quote')!;
    await act(() => { quote.click(); }); await flush();
    expect((HTMLElement.prototype.scrollIntoView as any)).toHaveBeenCalled();
  });

  it('marks read when opened and appends a live message without re-fetching', async () => {
    const client = makeClient({ conversationMessages: vi.fn(async () => ({ messages: [transcript[0]], has_more: false })) });
    await view(client); await flush();
    expect(clientOf(client).markConversationRead).toHaveBeenCalledWith(room().id, undefined);
    setActiveRoom(room().id);
    applyLiveEvent('conversation.message.new', { conversation_id: room().id, message: message({ id: 'fm_live', seq: 9, text: 'LIVE', created_at: now + 9 }) });
    await flush();
    expect(text('.messages')).toContain('LIVE');
    expect(roomView(room().id).messages.some((m) => m.id === 'fm_live')).toBe(true);
  });

  it('owner Stop and Resume call the room controls and reflect the paused state', async () => {
    const client = makeClient({ conversationMessages: vi.fn(async () => ({ messages: [], has_more: false })) });
    await view(client); await flush();
    const stop = [...host.querySelectorAll<HTMLButtonElement>('.room-head button')].find((b) => b.textContent?.includes('Stop'))!;
    await act(() => { stop.click(); }); await flush();
    expect(clientOf(client).stopConversation).toHaveBeenCalledWith(room().id);
    const resume = [...host.querySelectorAll<HTMLButtonElement>('.room-head button')].find((b) => b.textContent?.includes('Resume'))!;
    expect(resume).toBeTruthy();
    await act(() => { resume.click(); }); await flush();
    expect(clientOf(client).resumeConversation).toHaveBeenCalledWith(room().id);
  });

  it('types and sends an @mention with explicit offsets, never an actor/admit', async () => {
    const client = makeClient({ conversationMessages: vi.fn(async () => ({ messages: [], has_more: false })) });
    await view(client); await flush();
    const ta = host.querySelector<HTMLTextAreaElement>('.room-composer textarea')!;
    await act(() => { ta.value = '@hel'; ta.dispatchEvent(new Event('input', { bubbles: true })); }); await flush();
    const option = host.querySelector<HTMLElement>('.room-suggest [role=option]')!;
    expect(option.textContent).toContain('@helper');
    await act(() => { option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); }); await flush();
    await act(() => { ta.value = '@helper hello'; ta.dispatchEvent(new Event('input', { bubbles: true })); }); await flush();
    await act(() => { ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); }); await flush();
    expect(clientOf(client).sendConversationMessage).toHaveBeenCalledWith(room().id, expect.objectContaining({ text: '@helper hello', mentions: [{ kind: 'agent', id: 'agent:helper', offset: 0, length: 7 }] }));
    expect(JSON.stringify(clientOf(client).sendConversationMessage.mock.calls[0][1])).not.toMatch(/actor|admit/);
  });

  it('fetches a replied-to message that is not in the loaded page, then jumps to it', async () => {
    const target = message({ id: 'fm_old', seq: 1, sender: { id: 'agent:helper', name: 'helper', kind: 'agent', is_bot: true }, text: 'Original context', created_at: now });
    const reply = message({ id: 'fm_new', seq: 2, text: 'Following up', reply_to: 'fm_old', created_at: now + 2 });
    const client = makeClient({ conversationMessages: vi.fn(async () => ({ messages: [reply], has_more: false })), conversationMessage: vi.fn(async () => target) });
    await view(client); await flush();
    await act(() => { (host.querySelector('.reply-quote') as HTMLButtonElement).click(); }); await flush();
    expect(clientOf(client).conversationMessage).toHaveBeenCalledWith(room().id, 'fm_old');
    expect(roomView(room().id).messages.some((m) => m.id === 'fm_old')).toBe(true);
    await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
    expect((HTMLElement.prototype.scrollIntoView as any)).toHaveBeenCalled();
  });

  it('details rename, add/remove members, mute and mark read stay on the room owner controls', async () => {
    const client = makeClient({ conversationMessages: vi.fn(async () => ({ messages: [], has_more: false })) });
    const candidates = [{ id: 'c', name: 'ops', kind: 'hermes', online: true, chatReady: true }];
    await view(client, { detailsOpen: true, agents: candidates as any }); await flush();
    const title = host.querySelector<HTMLInputElement>('#f-room-title')!;
    await act(() => { title.value = 'Launch renamed'; title.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(() => { [...host.querySelectorAll<HTMLButtonElement>('.room-details button')].find((b) => b.textContent === 'Save name')!.click(); }); await flush();
    expect(clientOf(client).renameConversation).toHaveBeenCalledWith(room().id, 'Launch renamed');
    const select = host.querySelector<HTMLSelectElement>('.room-add select')!;
    await act(() => { select.value = 'ops'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(() => { [...host.querySelectorAll<HTMLButtonElement>('.room-add button')].find((b) => b.textContent === 'Add')!.click(); }); await flush();
    expect(clientOf(client).addConversationMember).toHaveBeenCalledWith(room().id, 'ops');
    await act(() => { host.querySelector<HTMLButtonElement>('[aria-label="Remove reviewer"]')!.click(); }); await flush();
    expect(clientOf(client).removeConversationMember).toHaveBeenCalledWith(room().id, 'reviewer');
    const mute = host.querySelector<HTMLInputElement>('.room-details input[type=checkbox]')!;
    await act(() => { mute.checked = true; mute.dispatchEvent(new Event('change', { bubbles: true })); }); await flush();
    expect(clientOf(client).conversationPreferences).toHaveBeenCalledWith(room().id, { muted: true });
    await act(() => { [...host.querySelectorAll<HTMLButtonElement>('.room-details button')].find((b) => b.textContent?.includes('Mark as read'))!.click(); }); await flush();
    expect(clientOf(client).markConversationRead).toHaveBeenCalled();
  });

  it('keeps a distinct room not-agent identity: the view takes a conversation id, never AgentSummary', async () => {
    const client = makeClient({ conversationMessages: vi.fn(async () => ({ messages: transcript.slice(0, 2), has_more: false })) });
    await view(client); await flush();
    expect(host.querySelector('.room-view')).toBeTruthy();
    expect(host.querySelector('.chat')!.getAttribute('aria-label')).toBe('Launch room');
    expect(conversationsState().list.some((c) => c.id === room().id)).toBe(true);
    expect((conversationsState().list[0] as any).name).toBeUndefined();
  });
});

describe('room media captions', () => {
  const attachFile = async (name: string) => {
    const input = host.querySelector<HTMLInputElement>('.room-composer input[type=file]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['some notes'], name, { type: 'text/plain' })] });
    await act(() => { input.dispatchEvent(new Event('change', { bubbles: true })); }); await flush();
  };

  it('sends a non-empty caption taken from the first attachment name', async () => {
    const client = makeClient({ conversationMessages: vi.fn(async () => ({ messages: [], has_more: false })) });
    await view(client); await flush();
    await attachFile('notes.txt');
    const send = host.querySelector<HTMLButtonElement>('.room-composer .send')!;
    expect(send.disabled).toBe(false);
    await act(() => { send.click(); }); await flush();
    const body = clientOf(client).sendConversationMessage.mock.calls[0][1];
    expect(body.text).toBe('notes.txt');
    expect(body.text).not.toBe('');
    expect(body.media).toEqual(['fbm_1']);
  });

  it('disables send when there is neither text nor a named attachment', async () => {
    const client = makeClient({
      conversationMessages: vi.fn(async () => ({ messages: [], has_more: false })),
      uploadConversationMedia: vi.fn(async () => ({ id: 'fbm_blank', kind: 'file', mime: 'text/plain', name: '   ', size: 12 })),
    });
    await view(client); await flush();
    await attachFile('notes.txt');
    expect(host.querySelector<HTMLButtonElement>('.room-composer .send')!.disabled).toBe(true);
    expect(clientOf(client).sendConversationMessage).not.toHaveBeenCalled();
  });
});

describe('room request cards', () => {
  it.each([['Allow once', 'once'], ['Deny', 'deny']])('answers an approval with %s and then refreshes the queues', async (label, choice) => {
    let open = [approvalCard];
    const queue = vi.fn(async (agent: string) => ({ ...emptyQueue, openRequests: agent === 'helper' ? open : [] }));
    const answerRequest = vi.fn(async () => { open = []; return { ok: true }; });
    const client = makeClient({ queue, answerRequest });
    await view(client); await flush();
    expect(text('.request.approval')).toContain('Deploy cleanup');
    const button = [...host.querySelectorAll<HTMLButtonElement>('.request.approval button')].find((b) => b.textContent === label)!;
    await act(() => { button.click(); }); await flush();
    expect(answerRequest).toHaveBeenCalledWith('helper', room().id, approvalCard.id, { choice });
    expect(queue.mock.calls.length).toBeGreaterThan(1);
    expect(host.querySelector('.request.approval')).toBeNull();
  });

  it('answers a clarify card with the chosen values', async () => {
    let open = [clarifyCard];
    const queue = vi.fn(async (agent: string) => ({ ...emptyQueue, openRequests: agent === 'helper' ? open : [] }));
    const answerRequest = vi.fn(async () => { open = []; return { ok: true }; });
    const client = makeClient({ queue, answerRequest });
    await view(client); await flush();
    expect(text('.request.clarify')).toContain('Which host?');
    const prod = [...host.querySelectorAll<HTMLInputElement>('.request.clarify input[type=radio]')].find((i) => i.parentElement?.textContent?.includes('prod'))!;
    await act(() => { prod.click(); });
    const send = [...host.querySelectorAll<HTMLButtonElement>('.request.clarify button')].find((b) => b.textContent === 'Send answer')!;
    await act(() => { send.click(); }); await flush();
    expect(answerRequest).toHaveBeenCalledWith('helper', room().id, clarifyCard.id, { answers: { q1: 'prod' } });
    expect(host.querySelector('.request.clarify')).toBeNull();
  });

  it('drops a card when the hub says it is already closed', async () => {
    let open = [approvalCard];
    const queue = vi.fn(async (agent: string) => ({ ...emptyQueue, openRequests: agent === 'helper' ? open : [] }));
    const answerRequest = vi.fn(async () => { open = []; throw new ApiError(404, 'That question is no longer open'); });
    const client = makeClient({ queue, answerRequest });
    await view(client); await flush();
    const deny = [...host.querySelectorAll<HTMLButtonElement>('.request.approval button')].find((b) => b.textContent === 'Deny')!;
    await act(() => { deny.click(); }); await flush();
    expect(answerRequest).toHaveBeenCalled();
    expect(host.querySelector('.request.approval')).toBeNull();
  });

  it('shows request cards only to the conversation owner', async () => {
    const client = makeClient({ queue: vi.fn(async (agent: string) => ({ ...emptyQueue, openRequests: agent === 'helper' ? [approvalCard] : [] })) });
    await view(client, { info: { ...info, user: { id: 'u2', username: 'Bob', role: 'user' } } }); await flush();
    expect(host.querySelector('.request')).toBeNull();
    expect(text('.room-view')).toContain('Launch room');
  });
});

describe('offline, reconnect and read state', () => {
  it('reports offline without EventSource, then reconnects and replays room events from the live v2 stream', async () => {
    const client = makeClient();
    connectLive(client, () => {});
    expect(conversationsState().live).toBe('offline');
    disconnectLive();

    class FakeEventSource {
      static last: FakeEventSource;
      listeners: Record<string, ((e: any) => void)[]> = {};
      url: string;
      constructor(url: string) { this.url = url; FakeEventSource.last = this; }
      addEventListener(t: string, f: (e: any) => void) { (this.listeners[t] ??= []).push(f); }
      close() { /* closed */ }
      emit(t: string, data?: unknown) { for (const f of this.listeners[t] ?? []) f({ data: data === undefined ? undefined : JSON.stringify(data) }); }
    }
    Object.defineProperty(globalThis, 'EventSource', { value: FakeEventSource, configurable: true, writable: true });
    connectLive(client, () => {});
    expect(FakeEventSource.last.url).toContain('/api/live/stream?v=2');
    FakeEventSource.last.emit('open');
    expect(conversationsState().live).toBe('live');
    FakeEventSource.last.emit('foxfleet.ready', { contract: 'foxfleet.live/2', cursor: 'store:7' });
    expect(conversationsState().cursor).toBe('store:7');

    await loadRoom(client, room().id, () => {}); await flush();
    setActiveRoom(room().id);
    FakeEventSource.last.emit('conversation.message.new', { conversation_id: room().id, message: message({ id: 'fm_stream', seq: 11, text: 'from the room stream', created_at: now + 11 }) });
    expect(roomView(room().id).messages.some((m) => m.id === 'fm_stream')).toBe(true);
    FakeEventSource.last.emit('conversation.typing', { conversation_id: room().id, agent: 'agent:helper', state: 'typing' });
    expect(Object.keys(roomView(room().id).typing)).toContain('agent:helper');
    FakeEventSource.last.emit('error');
    expect(conversationsState().live).toBe('offline');
    disconnectLive();
  });

  it('moves the durable read position through the room read route', async () => {
    const client = makeClient();
    await loadRoom(client, room().id, () => {}); await flush();
    await markRoomRead(client, room().id, () => {}, 42);
    expect(clientOf(client).markConversationRead).toHaveBeenCalledWith(room().id, 42);
    expect(conversationsState().list[0].unread_count).toBe(0);
  });
});
