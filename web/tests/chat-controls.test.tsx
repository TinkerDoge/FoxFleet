import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '../src/api/client';
import { ApiError } from '../src/api/errors';
import type { AgentSummary } from '../src/api/types';
import { Composer, pickMode } from '../src/chat/Composer';
import { chatOf, newChat, resetChats, send, stop, syncQueue } from '../src/chat/store';
import { argSuggestions, commandSuggestions, parseHub, unavailableReason, type Catalog } from '../src/lib/commands';
import { saveMode } from '../src/lib/persist';
import { setDraftScope } from '../src/chat/drafts';

const cat = (over: Record<string, unknown> = {}): Catalog => ({ source: 'bundled', busy: ['queue', 'steer', 'interrupt'], commands: [
  { name: 'busy', aliases: [], description: 'Control how messages behave while the agent works', category: 'Configuration', args: '[queue|steer|interrupt|status]', subcommands: ['queue', 'steer', 'interrupt', 'status'], availability: 'app', handler: 'hub:busy', executable: true },
  { name: 'queue', aliases: ['q'], description: 'Queue a prompt', category: 'Session', args: '[<prompt>|list|rm N|clear]', subcommands: ['add', 'list', 'rm', 'clear'], availability: 'chat', handler: 'hub:queue', executable: true, unavailableSubcommands: { edit: 'not remote' } },
  { name: 'steer', aliases: ['s'], description: 'Inject guidance', category: 'Session', args: '<prompt>', subcommands: [], availability: 'chat', handler: 'hub:steer', executable: true, ...over },
  { name: 'clear', aliases: [], description: 'Clear', category: 'Session', args: '', subcommands: [], availability: 'unavailable', reason: 'Needs a terminal', executable: false, disabledReason: 'Needs a terminal' },
] });

describe('command arguments', () => {
  it('"/busy " opens the choices and "/busy st" filters them', () => {
    expect(argSuggestions('/busy ', cat()).map((s) => s.label)).toEqual(['queue', 'steer', 'interrupt', 'status']);
    expect(argSuggestions('/busy st', cat()).map((s) => s.label)).toEqual(['steer', 'status']);
    expect(argSuggestions('/busy status', cat())).toEqual([]); // an exact, only match: Enter sends it
    expect(commandSuggestions('/busy st', [], 10, true, cat()).map((s) => s.insert)).toEqual(['/busy steer', '/busy status']);
  });
  it('resolves aliases and leaves free-text arguments alone', () => {
    expect(argSuggestions('/q li', cat()).map((s) => s.insert)).toEqual(['/q list']);
    expect(argSuggestions('/steer use postgres please', cat())).toEqual([]);
    expect(argSuggestions('/queue fix the readme now', cat())).toEqual([]);
    expect(parseHub('/s use PostgreSQL', cat())).toMatchObject({ cmd: 'steer', args: 'use PostgreSQL' });
    expect(parseHub('/q hello world', cat())).toMatchObject({ cmd: 'queue', args: 'hello world' });
    expect(parseHub('/clear', cat())).toBeUndefined();
  });
  it('skills keep working: # lists skills and /skill is offered with the commands', () => {
    expect(commandSuggestions('#we', ['web-search', 'godot'], 5, true, cat()).map((s) => s.label)).toEqual(['#web-search']);
    expect(commandSuggestions('/we', ['web-search'], 5, true, cat()).map((s) => s.label)).toEqual(['/web-search']);
  });
  it('a command the agent cannot run is listed disabled with its reason; steer is disabled without native steering', () => {
    const s = commandSuggestions('/cl', [], 5, true, cat()); expect(s[0]).toMatchObject({ label: '/clear', availability: 'unavailable' });
    expect(unavailableReason('/clear', cat())).toBe('Needs a terminal');
    const off = cat({ executable: false, disabledReason: 'This agent has no native steering' }); expect(unavailableReason('/steer x', off)).toMatch(/no native steering/);
    expect(commandSuggestions('/ste', [], 5, true, off)[0].availability).toBe('unavailable');
  });
  it('mode defaults to Interrupt & send for Hermes, is remembered per conversation and limited to supported modes', () => {
    expect(pickMode('a', 's1', 'hermes', ['queue', 'steer', 'interrupt'])).toBe('interrupt');
    expect(pickMode('a', 's1', 'openai', ['queue', 'interrupt'])).toBe('queue');
    saveMode('a', 's1', 'steer'); expect(pickMode('a', 's1', 'hermes', ['queue', 'steer', 'interrupt'])).toBe('steer');
    expect(pickMode('a', 's1', 'hermes', ['queue', 'interrupt'])).toBe('interrupt'); // a saved mode the agent no longer supports is ignored
    expect(pickMode('a', 's2', 'hermes', ['queue', 'steer', 'interrupt'])).toBe('interrupt');
  });
});

const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
const qitem = (o: object) => ({ id: 'm1', state: 'queued', mode: 'queue', text: 'later', ...o });
function fake(over: Record<string, unknown> = {}) {
  let release: () => void = () => {}, opts: any; const sent: any[] = [];
  const client = {
    chat: vi.fn((_a: string, _h: unknown, o: any) => { opts = o; o.onSession('sess-1'); o.onRun?.('run-1'); o.onContent('partial '); return new Promise<string>((res, rej) => { release = () => { o.onRunState?.('done'); res('sess-1'); }; o.signal.addEventListener('abort', () => rej(Object.assign(new Error('abort'), { name: 'AbortError' }))); }); }),
    sendMessage: vi.fn(async (_a: string, o: any) => { const message = qitem({ id: 'srv-' + o.mode, mode: o.mode, text: o.messages[0].content, state: o.mode === 'steer' ? 'guidance_accepted' : o.mode === 'interrupt' ? 'awaiting_stop' : 'queued' }); sent.push(message); return { message }; }),
    queue: vi.fn(async () => ({ items: [...sent], recent: [], halted: false, activeRun: sent.length ? 'run-1' : null, modes: ['queue', 'steer', 'interrupt'] })),
    commands: vi.fn(async () => cat()),
    stopRun: vi.fn(async () => ({})), sessions: vi.fn(async () => ({ sessions: [], total: 0 })), follow: vi.fn(), resumeQueue: vi.fn(), cancelQueued: vi.fn(),
    ...over,
  } as unknown as Client & Record<string, any>;
  return { client, release: () => release(), opts: () => opts };
}

beforeEach(() => { localStorage.clear(); resetChats(); setDraftScope('u1'); });
describe('sending while the agent works', () => {
  it('reaches the hub, stays visible, and the streaming reply and transcript are untouched', async () => {
    const f = fake(), p = send(f.client, 'a', 'first', [], [], () => {}, 'queue'); await flush();
    expect(chatOf('a').streaming).toBe(true);
    await send(f.client, 'a', 'second', [], [], () => {}, 'queue');
    expect(f.client.sendMessage).toHaveBeenCalledWith('a', expect.objectContaining({ mode: 'queue', sessionId: 'sess-1', clientId: expect.stringMatching(/.{8}/) }));
    expect(chatOf('a').queue.map((q) => [q.text, q.state])).toEqual([['second', 'queued']]);
    expect(chatOf('a').messages.map((m) => m.content)).toEqual(['first']); expect(chatOf('a').streamText).toBe('partial '); // not overwritten
    f.release(); await p; expect(chatOf('a').messages.map((m) => m.content)).toEqual(['first', 'partial ']);
  });
  it('a rejected send (409) puts the text back in the composer and loses nothing', async () => {
    const f = fake({ sendMessage: vi.fn(async () => { throw new ApiError(409, 'There is no running reply to steer'); }) }), p = send(f.client, 'a', 'x', [], [], () => {}); await flush();
    await send(f.client, 'a', 'use PostgreSQL', [], [], () => {}, 'steer');
    expect(chatOf('a').queue).toEqual([]); expect(chatOf('a').error).toBeTruthy();
    const { useDraftForTest } = await import('./draft-peek'); expect(useDraftForTest('a', 'sess-1')).toBe('use PostgreSQL');
    f.release(); await p;
  });
  it('steer shows "guidance accepted", interrupt shows "waiting for the reply to stop"', async () => {
    const f = fake(), p = send(f.client, 'a', 'go', [], [], () => {}); await flush();
    await send(f.client, 'a', 'use PG', [], [], () => {}, 'steer'); await send(f.client, 'a', 'change plan', [], [], () => {}, 'interrupt');
    expect(chatOf('a').queue.map((q) => q.state)).toEqual(['guidance_accepted', 'awaiting_stop']); f.release(); await p;
  });
  it('Stop keeps the partial reply, marks it interrupted and cancels on the hub', async () => {
    const f = fake(), p = send(f.client, 'a', 'long', [], [], () => {}); await flush();
    stop('a', f.client); await p;
    expect(f.client.stopRun).toHaveBeenCalledWith('a', 'run-1'); expect(chatOf('a').messages.at(-1)).toMatchObject({ role: 'assistant', content: 'partial ', interrupted: true }); expect(chatOf('a').streaming).toBe(false);
  });
  it('late callbacks from an old stream cannot touch the chat that is open now', async () => {
    const f = fake(), p = send(f.client, 'a', 'old', [], [], () => {}); await flush(); const old = f.opts();
    newChat('a'); old.onContent('LATE TEXT'); old.onSession('sess-OLD'); old.onTool('late-tool'); await p;
    expect(chatOf('a').streamText).toBe(''); expect(chatOf('a').session).toBeUndefined(); expect(chatOf('a').messages).toEqual([]); expect(chatOf('a').tool).toBeUndefined();
  });
  it('the queue and its paused state come back from the hub after a reload', async () => {
    const f = fake({ queue: vi.fn(async () => ({ items: Array.from({ length: 3 }, (_, i) => qitem({ id: `m${i}`, text: `q${i}` })), recent: [], halted: true, activeRun: null, modes: ['queue'] })) });
    await syncQueue(f.client, 'a', () => {}); expect(chatOf('a').queue.map((q) => q.text)).toEqual(['q0', 'q1', 'q2']); expect(chatOf('a').halted).toBe(true);
    expect(f.client.follow).not.toHaveBeenCalled(); // paused: nothing starts by itself
  });
  it('follows the next reply when the hub starts the queued message', async () => {
    const running = qitem({ id: 'm9', state: 'running', text: 'queued one', runId: 'run-9' });
    const f = fake({ queue: vi.fn().mockResolvedValueOnce({ items: [running], recent: [], halted: false, activeRun: 'run-9', modes: ['queue'] }).mockResolvedValue({ items: [], recent: [], halted: false, activeRun: null, modes: ['queue'] }),
      follow: vi.fn(async (_a: string, _r: string, _n: number, o: any) => { o.onContent('answer'); }) });
    await syncQueue(f.client, 'a', () => {}); await flush();
    expect(f.client.follow).toHaveBeenCalledWith('a', 'run-9', 0, expect.anything());
    expect(chatOf('a').messages.map((m) => [m.role, m.content])).toEqual([['user', 'queued one'], ['assistant', 'answer']]);
  });
});

describe('composer while the agent works', () => {
  let host: HTMLDivElement; beforeEach(() => { host = document.createElement('div'); document.body.append(host); }); afterEach(async () => { await act(() => render(null, host)); host.remove(); });
  const agent: AgentSummary = { id: 'a', name: 'a', kind: 'hermes', online: true, chatReady: true, capabilities: { chat: true, busy: ['queue', 'steer', 'interrupt'] } };
  it('keeps Send and Stop both available, with a mode selector limited to the agent\'s modes and honest labels', async () => {
    const onSend = vi.fn(), onStop = vi.fn(), f = fake();
    await act(() => render(<Composer client={f.client} agent={agent} history={[]} streaming={true} skills={[]} draftKey="k" session="s1" queue={[]} onSend={onSend} onStop={onStop} onLocal={() => {}} />, host)); await flush();
    const ta = host.querySelector('textarea')!; await act(() => { ta.value = 'do it differently'; ta.dispatchEvent(new Event('input', { bubbles: true })); });
    const sel = host.querySelector<HTMLSelectElement>('select.mode')!; expect([...sel.options].map((o) => o.text)).toEqual(['Queue', 'Steer', 'Interrupt & send']); expect(sel.value).toBe('interrupt');
    expect(sel.title).toMatch(/not a live redirect/);
    const send = host.querySelector<HTMLButtonElement>('button.send:not(.stop)')!, stopBtn = host.querySelector<HTMLButtonElement>('button.send.stop')!; expect(send.disabled).toBe(false); expect(stopBtn).toBeTruthy();
    await act(() => send.click()); expect(onSend).toHaveBeenCalledWith('do it differently', [], [], 'interrupt');
    await act(() => stopBtn.click()); expect(onStop).toHaveBeenCalled();
  });
  it('typing /busy opens the choices; /busy steer changes and remembers the mode; /s sends guidance', async () => {
    const onSend = vi.fn(), f = fake({ commands: vi.fn(async () => cat()) });
    await act(() => render(<Composer client={f.client} agent={agent} history={[]} streaming={true} skills={[]} draftKey="k2" session="s2" queue={[]} onSend={onSend} onStop={() => {}} onLocal={() => {}} />, host)); await flush();
    const ta = host.querySelector('textarea')!, type = (v: string) => act(() => { ta.value = v; ta.dispatchEvent(new Event('input', { bubbles: true })); });
    await type('/busy '); expect([...host.querySelectorAll('.suggest [role="option"]')].map((o) => o.querySelector('b')!.textContent)).toEqual(['queue', 'steer', 'interrupt', 'status']);
    await type('/busy st'); expect([...host.querySelectorAll('.suggest [role="option"]')].map((o) => o.querySelector('b')!.textContent)).toEqual(['steer', 'status']);
    await type('/busy steer'); await act(() => host.querySelector<HTMLButtonElement>('button.send:not(.stop)')!.click());
    expect(host.querySelector<HTMLSelectElement>('select.mode')!.value).toBe('steer'); expect(pickMode('a', 's2', 'hermes', ['queue', 'steer', 'interrupt'])).toBe('steer');
    await type('/s use PostgreSQL'); await act(() => host.querySelector<HTMLButtonElement>('button.send:not(.stop)')!.click()); expect(onSend).toHaveBeenCalledWith('use PostgreSQL', [], [], 'steer');
  });
  it('no Steer option for an agent without native steering', async () => {
    const f = fake(); const a2 = { ...agent, kind: 'openai', capabilities: { chat: true, busy: ['queue', 'interrupt'] } } as AgentSummary;
    await act(() => render(<Composer client={f.client} agent={a2} history={[]} streaming={true} skills={[]} draftKey="k3" queue={[]} onSend={() => {}} onStop={() => {}} onLocal={() => {}} />, host)); await flush();
    expect([...host.querySelector<HTMLSelectElement>('select.mode')!.options].map((o) => o.value)).toEqual(['queue', 'interrupt']);
  });
});
