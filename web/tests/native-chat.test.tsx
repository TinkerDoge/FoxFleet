import { render } from 'preact';
import { act } from 'preact/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, parseQueue, parseRequest, type Client } from '../src/api/client';
import { ApiError } from '../src/api/errors';
import type { AgentSummary } from '../src/api/types';
import { Composer } from '../src/chat/Composer';
import { RequestCards } from '../src/chat/RequestCards';
import { ModelPicker } from '../src/chat/Pickers';
import { ProfileBusy } from '../src/chat/ProfileBusy';
import { activePicker, closePicker, openPicker, resetPickers, PICKER_TTL_MS } from '../src/chat/picker';
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
describe('composer without a mode picker', () => {
  const mount = (a: AgentSummary) => { const el = document.createElement('div'); document.body.append(el); const client = { commands: vi.fn(async () => ({ source: 'local', busy: [], commands: [] })) } as unknown as Client; act(() => render(<Composer client={client} agent={a} history={[]} streaming skills={[]} draftKey="k" session="s" onSend={() => {}} onStop={() => {}} onLocal={() => {}} />, el)); return el; };
  it('neither kind of agent shows a mode selector: the composer is text, Send and Stop', () => {
    for (const el of [mount(agent(true)), mount(agent(false))]) { expect(el.querySelector('select')).toBeNull(); expect(el.querySelector('.controls')).toBeNull(); expect(el.querySelectorAll('button.send').length).toBeGreaterThan(0); }
  });
});

describe('model picker and profile setting', () => {
  const models = { providers: [{ slug: 'openrouter', name: 'OpenRouter', models: Array.from({ length: 11 }, (_, i) => `m-${i}`) }, { slug: 'zai', name: 'Z.ai', models: ['glm-x'] }] };
  const mount = (el: HTMLElement, node: any) => act(() => render(node, el));
  const btn = (el: HTMLElement, text: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.startsWith(text))!;
  beforeEach(() => resetPickers());
  it('two steps: provider, then that provider\'s models (paged, searchable); choosing sets the model for this chat only and confirms', async () => {
    const setModel = vi.fn(async () => ({ model: 'm-9', scope: 'session' })), client = { models: vi.fn(async () => models), setModel } as unknown as Client, done = vi.fn();
    const el = document.createElement('div'); document.body.append(el); const p = openPicker({ agent: 'a', session: 'sess-9', kind: 'model' });
    await mount(el, <ModelPicker client={client} picker={p} onDone={done} />); await flush();
    expect(el.textContent).toContain('Choose a provider'); expect(el.textContent).toContain('OpenRouter'); expect(el.textContent).not.toContain('m-0');
    await act(async () => { btn(el, 'OpenRouter').click(); }); expect(el.textContent).toContain('Models from OpenRouter'); expect([...el.querySelectorAll('.choices button')]).toHaveLength(8); expect(el.textContent).toContain('1/2');
    await act(async () => { btn(el, 'Next').click(); }); expect([...el.querySelectorAll('.choices button')].map((b) => b.textContent)).toEqual(['m-8', 'm-9', 'm-10']);
    const q = el.querySelector<HTMLInputElement>('input.search')!; await act(async () => { q.value = 'm-9'; q.dispatchEvent(new Event('input', { bubbles: true })); }); expect([...el.querySelectorAll('.choices button')].map((b) => b.textContent)).toEqual(['m-9']);
    await act(async () => { btn(el, 'Back').click(); }); expect(el.textContent).toContain('Choose a provider'); await act(async () => { btn(el, 'OpenRouter').click(); });
    await act(async () => { btn(el, 'm-0').click(); }); await flush();
    expect(setModel).toHaveBeenCalledWith('a', 'sess-9', 'm-0 --provider openrouter'); expect(JSON.stringify(setModel.mock.calls)).not.toContain('global');
    expect(done).toHaveBeenCalledWith(expect.stringContaining('m-0')); expect(activePicker('a', 'sess-9')).toBeUndefined();
  });
  it('a card belongs to the chat that opened it and expires; Cancel closes it; without a chat nothing can be chosen', async () => {
    const t0 = Date.now(); openPicker({ agent: 'a', session: 's1', kind: 'model' }, t0);
    expect(activePicker('a', 's1', t0 + 1000)).toBeTruthy(); expect(activePicker('a', 's2', t0 + 1000)).toBeUndefined(); expect(activePicker('a', undefined, t0 + 1000)).toBeUndefined();
    expect(activePicker('a', 's1', t0 + PICKER_TTL_MS + 1)).toBeUndefined(); closePicker('a'); expect(activePicker('a', 's1', t0 + 1)).toBeUndefined();
    const client = { models: vi.fn(async () => models), setModel: vi.fn() } as unknown as Client, el = document.createElement('div'); document.body.append(el);
    await mount(el, <ModelPicker client={client} picker={openPicker({ agent: 'a', session: undefined, kind: 'model' })} onDone={() => {}} />); await flush(); await act(async () => { btn(el, 'Z.ai').click(); });
    expect(btn(el, 'glm-x').disabled).toBe(true); expect(el.textContent).toContain('Send the first message first');
  });
  it('the profile-wide busy setting lives in agent settings: warning, current value, confirmation before changing; absent for agents without it', async () => {
    const set = vi.fn(async () => ({})), client = { profileBusy: vi.fn(async () => 'queue'), setProfileBusy: set } as unknown as Client, el = document.createElement('div'); document.body.append(el);
    await mount(el, <ProfileBusy client={client} agent="a" />); await flush();
    expect(el.textContent).toContain('affects every chat of this profile'); expect(el.textContent).toContain('Now: Queue');
    vi.stubGlobal('confirm', vi.fn(() => false)); await act(async () => { btn(el, 'Steer').click(); }); expect(set).not.toHaveBeenCalled();
    vi.stubGlobal('confirm', vi.fn(() => true)); await act(async () => { btn(el, 'Steer').click(); }); await flush(); expect(set).toHaveBeenCalledWith('a', 'steer'); vi.unstubAllGlobals();
    const none = document.createElement('div'); await mount(none, <ProfileBusy client={{ profileBusy: vi.fn(async () => { throw new Error('no'); }) } as unknown as Client} agent="p" />); await flush(); expect(none.textContent).toBe('');
  });
});
