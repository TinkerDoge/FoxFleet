import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '../src/api/client';
import type { AgentSummary } from '../src/api/types';
import { Composer } from '../src/chat/Composer';
import { draftKey } from '../src/chat/drafts';
import { newChat, resetChats } from '../src/chat/store';
import type { FileRef } from '../src/lib/files';

let host: HTMLDivElement;
const onSend = vi.fn();
const uploaded: FileRef = { name: 'notes.txt', path: 'uploads/notes.txt', size: 10 };
let uploadFile: ReturnType<typeof vi.fn>;
const agent = (name: string): AgentSummary => ({ id: name, name, kind: 'hermes', online: true, chatReady: true, capabilities: { files: true, voice: false } });

beforeEach(() => {
  resetChats(); onSend.mockClear();
  uploadFile = vi.fn(async () => uploaded);
  host = document.createElement('div'); document.body.append(host);
});
afterEach(async () => { await act(() => render(null, host)); host.remove(); resetChats(); });

async function show(name: string, session?: string) {
  const key = draftKey(name, session);
  await act(() => render(<Composer key={key} draftKey={key} client={{ uploadFile } as unknown as Client} agent={agent(name)}
    history={[]} streaming={false} skills={[]} onSend={onSend} onStop={() => {}} onLocal={() => {}} />, host));
}
const editor = () => host.querySelector('textarea')!;
async function type(text: string) { await act(() => { editor().value = text; editor().dispatchEvent(new Event('input', { bubbles: true })); }); }
async function attach() {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [new File(['some notes'], 'notes.txt', { type: 'text/plain' })] });
  await act(() => { input.dispatchEvent(new Event('change', { bubbles: true })); });
}

describe('composer drafts across navigation', () => {
  it('restores separate unsent text for each agent and session', async () => {
    await show('atlas'); await type('Atlas draft');
    await show('nova'); expect(editor().value).toBe(''); await type('Nova draft');
    await show('atlas', 's1'); expect(editor().value).toBe(''); await type('Session draft');
    await show('atlas'); expect(editor().value).toBe('Atlas draft');
    await show('atlas', 's1'); expect(editor().value).toBe('Session draft');
    await show('nova'); expect(editor().value).toBe('Nova draft');
  });

  it('finishes an upload while another agent is open and restores the attachment with its draft', async () => {
    let finish!: (file: FileRef) => void;
    uploadFile.mockImplementation(() => new Promise<FileRef>((resolve) => { finish = resolve; }));
    await show('atlas'); await type('Please read these notes'); await attach();
    await show('nova');
    await act(async () => { finish(uploaded); });
    expect(host.querySelector('.att')).toBeNull();
    await show('atlas');
    expect(editor().value).toBe('Please read these notes');
    expect(host.querySelector('.att.file')?.textContent).toContain('notes.txt');
    expect(host.querySelector('progress')).toBeNull();
    await act(() => host.querySelector<HTMLButtonElement>('.send')!.click());
    expect(onSend).toHaveBeenCalledWith('Please read these notes', [], [uploaded]);
    await show('nova'); await show('atlas');
    expect(editor().value).toBe(''); expect(host.querySelector('.att')).toBeNull();
  });

  it('clears all drafts and aborts uploads on sign-out, including late upload completions', async () => {
    let finish!: (file: FileRef) => void;
    uploadFile.mockImplementation(() => new Promise<FileRef>((resolve) => { finish = resolve; }));
    await show('atlas'); await type('Private draft'); await attach();
    const signal = uploadFile.mock.calls[0][3] as AbortSignal;
    await act(() => resetChats());
    expect(signal.aborted).toBe(true);
    await show('nova'); await act(async () => { finish(uploaded); });
    await show('atlas');
    expect(editor().value).toBe(''); expect(host.querySelector('.att')).toBeNull();
  });

  it('starts a blank new chat while keeping drafts in earlier sessions', async () => {
    await show('atlas', 's1'); await type('Earlier session draft');
    await show('atlas'); await type('Unsent new chat');
    await act(() => newChat('atlas'));
    expect(editor().value).toBe('');
    await show('atlas', 's1'); expect(editor().value).toBe('Earlier session draft');
  });
});
