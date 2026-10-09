import { render } from 'preact';
import { act } from 'preact/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, parseQueue, parseRequest, type Client } from '../src/api/client';
import { ApiError } from '../src/api/errors';
import type { AgentSummary } from '../src/api/types';
import { Composer } from '../src/chat/Composer';
import { RequestCards } from '../src/chat/RequestCards';
import { ChatControls } from '../src/chat/ChatControls';
import { answerRequest, chatOf, resetChats, send } from '../src/chat/store';
import { setDraftScope } from '../src/chat/drafts';

const enc = new TextEncoder();
const frame = (event: string | null, data: unknown) => `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const sse = (chunks: string[], headers: Record<string, string> = {}) => new Response(new ReadableStream({ start(c) { chunks.forEach((x) => c.enqueue(enc.encode(x))); c.close(); } }), { status: 200, headers: { 'Content-Type': 'text/event-stream', ...headers } });
const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
const clarify = { request_id: 'srq-000000000001', kind: 'clarify', questions: [{ id: 'q0', question: 'Which environment?', choices: ['staging', 'production'], multi_select: false }] };
const approval = { request_id: 'srq-000000000002', kind: 'approval', command: 'rm -rf build', description: 'Delete the build folder' };

beforeEach(() => { localStorage.clear(); resetChats(); setDraftScope('u1'); });

describe('parsing what the hub sends', () => {
  it('turns clarify and approval into cards and drops every other kind (the hub already declined those upstream, nothing waits)', () => {
    expect(parseRequest(clarify)).toMatchObject({ id: 'srq-000000000001', kind: 'clarify', questions: [{ id: 'q0', choices: ['staging', 'production'] }] });
    expect(parseRequest(approval)).toMatchObject({ kind: 'approval', command: 'rm -rf build' });
    expect(parseRequest({ request_id: 'x1', kind: 'sudo' })).toBeNull(); expect(parseRequest({ kind: 'clarify' })).toBeNull(); expect(parseRequest({ request_id: '../etc', kind: 'clarify' })).toBeNull();
  });
  it('queue state carries Hermes\'s own acknowledgement, open requests, and whether a queued message can be taken back', () => {
    const q = parseQueue({ items: [{ id: 'a', state: 'queued', mode: 'queue', text: 't', ack: 'queued' }, { id: 'b', state: 'rejected', mode: 'interrupt', text: 'u', ack: 'rejected' }, { id: 'c', state: 'queued', mode: 'queue', text: 'v', ack: 'bogus' }], open_requests: [clarify, { request_id: 'z', kind: 'sudo' }], can_cancel: false });
    expect(q.items.map((i) => i.ack)).toEqual(['queued', 'rejected', undefined]); expect(q.openRequests).toHaveLength(1); expect(q.canCancel).toBe(false);
    expect(parseQueue({ items: [], halted: false }).canCancel).toBe(true);
  });
});

describe('stream events', () => {
  it('request, request_closed and ack events reach the callbacks; a reconnect replays an open request and the card is not duplicated', async () => {
    const fetch = vi.fn(async () => sse([frame('foxfleet.request', clarify), frame('foxfleet.ack', { message_id: 'm1', ack: 'steered' }), frame('foxfleet.request', clarify), frame('foxfleet.request_closed', { request_id: clarify.request_id, reason: 'answered' }), 'data: [DONE]\n\n'], { 'X-Hermes-Session-Id': 'sess-1', 'X-Foxfleet-Run': 'run-1' }));
    const open: string[] = [], closed: string[] = [], acks: string[] = [];
    await createClient({ fetch: fetch as never }).chat('a', [{ role: 'user', content: 'x' }], { onContent() {}, onReasoning() {}, onTool() {}, onSession() {}, onRequest: (r) => open.push(r.id), onRequestClosed: (id, why) => closed.push(`${id}:${why}`), onAck: (id, a) => acks.push(`${id}:${a}`) });
    expect(open).toEqual([clarify.request_id, clarify.request_id]); expect(closed).toEqual([`${clarify.request_id}:answered`]); expect(acks).toEqual(['m1:steered']);
  });
  it('the store keeps one card per id, removes it when the agent cancels it, and a second device sees open cards from /queue', async () => {
    const chat = vi.fn(async (_a: string, _h: unknown, o: any) => { o.onSession('s1'); o.onRun?.('r1'); o.onRequest(parseRequest(clarify)); o.onRequest(parseRequest(clarify)); o.onRequest(parseRequest(approval)); expect(chatOf('a').requests.map((r) => r.id)).toEqual([clarify.request_id, approval.request_id]); o.onRequestClosed(clarify.request_id, 'cancelled'); expect(chatOf('a').requests.map((r) => r.id)).toEqual([approval.request_id]); return 's1'; });
    const queue = vi.fn(async () => ({ items: [], recent: [], halted: false, activeRun: null, modes: [], openRequests: [parseRequest(approval)!], canCancel: false }));
    const client = { chat, queue, sessions: vi.fn(async () => ({ sessions: [], total: 0 })) } as unknown as Client;
    await send(client, 'a', 'go', [], [], () => {}); await flush();
    expect(chatOf('a').requests.map((r) => r.id)).toEqual([approval.request_id]); expect(chatOf('a').canCancel).toBe(false);
    resetChats();
    await send({ chat: vi.fn(async (_a: string, _h: unknown, o: any) => { o.onSession('s1'); return 's1'; }), queue, sessions: client.sessions } as unknown as Client, 'dev2', 'hi', [], [], () => {}); await flush();
    expect(chatOf('dev2').requests.map((r) => r.id)).toEqual([approval.request_id]); // the other device shows the same pending approval
  });
  it('answering sends one answer by id; "already closed" (404) just removes the card; other errors keep it', async () => {
    const answers = vi.fn(async () => ({ ok: true })), client = { answerRequest: answers } as unknown as Client;
    void send({ chat: vi.fn((_a: string, _h: unknown, o: any) => { o.onSession('s1'); o.onRequest(parseRequest(clarify)); o.onRequest(parseRequest(approval)); return new Promise<string>(() => {}); }), queue: vi.fn(async () => ({ items: [], recent: [], halted: false, activeRun: null, modes: [], openRequests: [], canCancel: true })), sessions: vi.fn(async () => ({ sessions: [], total: 0 })) } as unknown as Client, 'a', 'x', [], [], () => {}); await flush();
    expect(await answerRequest(client, 'a', clarify.request_id, { answers: { q0: 'staging' } }, () => {})).toBeNull(); expect(answers).toHaveBeenCalledWith('a', 's1', clarify.request_id, { answers: { q0: 'staging' } });
    expect(chatOf('a').requests.map((r) => r.id)).toEqual([approval.request_id]);
    const gone = { answerRequest: vi.fn(async () => { throw new ApiError(404, 'closed'); }) } as unknown as Client; expect(await answerRequest(gone, 'a', approval.request_id, { choice: 'deny' }, () => {})).toBeNull(); expect(chatOf('a').requests).toEqual([]);
  });
});

describe('stale streams', () => {
  it('a late request or ack from a chat the user already left changes nothing', async () => {
    let opts: any; void send({ chat: vi.fn((_a: string, _h: unknown, o: any) => { opts = o; o.onSession('s1'); return new Promise<string>(() => {}); }), queue: vi.fn(async () => ({ items: [], recent: [], halted: false, activeRun: null, modes: [], openRequests: [], canCancel: true })), sessions: vi.fn(async () => ({ sessions: [], total: 0 })) } as unknown as Client, 'a', 'x', [], [], () => {}); await flush();
    const { newChat } = await import('../src/chat/store'); newChat('a'); opts.onRequest(parseRequest(clarify)); opts.onTool('late'); expect(chatOf('a').requests).toEqual([]); expect(chatOf('a').toolLog).toEqual([]);
  });
});

describe('cards', () => {
  const mount = (ui: any) => { const el = document.createElement('div'); document.body.append(el); act(() => render(ui, el)); return el; };
  it('a clarify card sends the picked answer once; typing overrides; a failure shows the reason and allows retry', async () => {
    const onAnswer = vi.fn(async () => null), el = mount(<RequestCards agent="Atlas" requests={[parseRequest(clarify)!]} onAnswer={onAnswer} />);
    expect(el.textContent).toContain('Which environment?'); const radios = el.querySelectorAll<HTMLInputElement>('input[type=radio]'); expect(radios).toHaveLength(2);
    await act(async () => { radios[1].click(); }); const send = [...el.querySelectorAll('button')].find((b) => /Send answer/.test(b.textContent!))!; await act(async () => { send.click(); send.click(); }); await flush();
    expect(onAnswer).toHaveBeenCalledTimes(1); expect(onAnswer).toHaveBeenCalledWith(clarify.request_id, { answers: { q0: 'production' } });
    const bad = vi.fn(async () => 'Network down'), el2 = mount(<RequestCards agent="Atlas" requests={[parseRequest(clarify)!]} onAnswer={bad} />);
    await act(async () => { (el2.querySelector('button.btn') as HTMLButtonElement).click(); }); await flush(); expect(el2.textContent).toContain('Network down'); expect((el2.querySelector('button.btn') as HTMLButtonElement).disabled).toBe(false);
  });
  it('an approval card offers only Allow once and Deny and names the command', async () => {
    const onAnswer = vi.fn(async () => null), el = mount(<RequestCards agent="Atlas" requests={[parseRequest(approval)!]} onAnswer={onAnswer} />);
    expect(el.textContent).toContain('rm -rf build'); expect([...el.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Allow once', 'Deny']);
    await act(async () => { (el.querySelectorAll('button')[1] as HTMLButtonElement).click(); }); expect(onAnswer).toHaveBeenCalledWith(approval.request_id, { choice: 'deny' });
  });
});

const agent = (nativeUi: boolean): AgentSummary => ({ name: 'a', displayName: 'Atlas', kind: 'hermes', online: true, capabilities: { chat: true, images: false, files: false, screen: false, voice: false, skills: false, sessions: true, mailbox: false, busy: ['queue', 'steer', 'interrupt'], nativeUi } } as AgentSummary);
describe('send mode labels', () => {
  const mount = (a: AgentSummary) => { const el = document.createElement('div'); document.body.append(el); const client = { commands: vi.fn(async () => ({ source: 'local', busy: [], commands: [] })) } as unknown as Client; act(() => render(<Composer client={client} agent={a} history={[]} streaming skills={[]} draftKey="k" session="s" onSend={() => {}} onStop={() => {}} onLocal={() => {}} />, el)); return el; };
  it('native: the third mode is a Redirect that Hermes may refuse; HTTP: it stops the reply and then sends', () => {
    const n = mount(agent(true)), h = mount(agent(false));
    const opts = (el: HTMLElement) => [...el.querySelectorAll('select.mode option')].map((o) => [o.textContent, o.getAttribute('title')]);
    expect(opts(n)[2]).toEqual(['Redirect', expect.stringMatching(/may refuse/)]); expect(opts(n)[0][1]).toMatch(/Hermes holds it/);
    expect(opts(h)[2]).toEqual(['Interrupt & send', expect.stringMatching(/Stops the reply, waits/)]);
  });
});

describe('chat controls', () => {
  const mount = (client: Partial<Client>, session?: string, streaming = false) => { const el = document.createElement('div'); document.body.append(el); act(() => render(<ChatControls client={client as Client} agent="a" session={session} streaming={streaming} />, el)); return el; };
  const models = { providers: [{ slug: 'openrouter', name: 'OpenRouter', models: ['m-one', 'm-two'] }] };
  it('the model picker is disabled with its reason until a chat exists, and changes the chat only (no --global)', async () => {
    const setModel = vi.fn(async () => ({ model: 'm-two', scope: 'session' })), client = { models: vi.fn(async () => models), profileBusy: vi.fn(async () => 'queue'), setModel };
    const none = mount(client); await act(async () => { (none.querySelector('button') as HTMLButtonElement).click(); }); await flush();
    expect(none.querySelector<HTMLSelectElement>('select')!.disabled).toBe(true); expect(none.textContent).toContain('Send the first message first');
    const el = mount(client, 'sess-9'); await act(async () => { (el.querySelector('button') as HTMLButtonElement).click(); }); await flush();
    const sel = el.querySelector<HTMLSelectElement>('select')!; await act(async () => { sel.value = 'openrouter\u0000m-two'; sel.dispatchEvent(new Event('change')); }); await flush();
    await act(async () => { [...el.querySelectorAll('button')].find((b) => b.textContent === 'Use')!.click(); }); await flush();
    expect(setModel).toHaveBeenCalledWith('a', 'sess-9', 'm-two --provider openrouter'); expect(JSON.stringify(setModel.mock.calls)).not.toContain('global');
    const busy = mount(client, 'sess-9', true); await act(async () => { (busy.querySelector('button') as HTMLButtonElement).click(); }); await flush(); expect(busy.querySelector<HTMLSelectElement>('select')!.disabled).toBe(true); expect(busy.textContent).toContain('Not available while the agent is replying');
  });
  it('/busy is shown as a profile-wide setting with a warning, and changing it asks for confirmation', async () => {
    const set = vi.fn(async () => ({})), client = { models: vi.fn(async () => models), profileBusy: vi.fn(async () => 'queue'), setProfileBusy: set };
    const el = mount(client, 's'); await act(async () => { (el.querySelector('button') as HTMLButtonElement).click(); }); await flush();
    expect(el.textContent).toContain('affects every chat of this profile'); expect(el.textContent).toContain('Now: Queue');
    const steer = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Steer')!;
    vi.stubGlobal('confirm', vi.fn(() => false)); await act(async () => { steer.click(); }); expect(set).not.toHaveBeenCalled();
    vi.stubGlobal('confirm', vi.fn(() => true)); await act(async () => { steer.click(); }); await flush(); expect(set).toHaveBeenCalledWith('a', 'steer'); vi.unstubAllGlobals();
  });
});
