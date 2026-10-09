import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '../src/api/client';
import type { AgentSummary } from '../src/api/types';
import { Composer } from '../src/chat/Composer';
import { discardDraft, draftKey, flushDrafts, moveDraft, resetDrafts, setDraftScope, wipeDrafts } from '../src/chat/drafts';
import { deleteSession, newChat, resetChats } from '../src/chat/store';

// Telegram-style drafts: unsent text per agent + session survives reload / closing the browser, per signed-in user.
let host: HTMLDivElement;
const onSend = vi.fn();
const agent = (name: string): AgentSummary => ({ id: name, name, kind: 'hermes', online: true, chatReady: true, capabilities: { files: true, voice: false } });
const stored = () => Object.keys(localStorage).filter((k) => k.startsWith('foxfleet.draft.'));
const reload = () => { resetDrafts(); setDraftScope(undefined); }; // what a fresh page load starts with: nothing in memory
async function show(name: string, session?: string) {
  const key = draftKey(name, session);
  await act(() => render(<Composer key={key} draftKey={key} client={{ uploadFile: vi.fn() } as unknown as Client} agent={agent(name)}
    history={[]} streaming={false} skills={[]} onSend={onSend} onStop={() => {}} onLocal={() => {}} />, host));
}
const editor = () => host.querySelector('textarea')!;
async function type(text: string) { await act(() => { editor().value = text; editor().dispatchEvent(new Event('input', { bubbles: true })); }); }

beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); resetChats(); setDraftScope(undefined); setDraftScope('u1'); onSend.mockClear(); host = document.createElement('div'); document.body.append(host); });
afterEach(async () => { await act(() => render(null, host)); host.remove(); resetChats(); setDraftScope(undefined); vi.useRealTimers(); });

describe('persistent drafts', () => {
  it('writes debounced, and a reload restores the text per agent and session', async () => {
    await show('atlas', 's1'); await type('half a thought');
    expect(stored()).toHaveLength(0); // still inside the debounce window
    await act(() => { vi.advanceTimersByTime(500); });
    expect(stored()).toEqual([`foxfleet.draft.u1:${draftKey('atlas', 's1')}`]);
    await type('half a thought, more'); await act(() => { vi.advanceTimersByTime(500); });
    await act(() => render(null, host)); reload(); setDraftScope('u1'); // full page reload, same user
    await show('atlas', 's1'); expect(editor().value).toBe('half a thought, more');
    await show('atlas', 's2'); expect(editor().value).toBe('');
    await show('nova'); expect(editor().value).toBe('');
  });

  it('closing the page right after typing still keeps the text (flush on pagehide)', async () => {
    await show('atlas'); await type('typed just before closing');
    await act(() => { dispatchEvent(new Event('pagehide')); });
    expect(localStorage.getItem(`foxfleet.draft.u1:${draftKey('atlas')}`)).toBe('typed just before closing');
  });

  it('sending clears the stored draft at once, even inside the debounce window', async () => {
    await show('atlas', 's1'); await type('send me'); flushDrafts(); expect(stored()).toHaveLength(1);
    await type('send me now');
    await act(() => { host.querySelector<HTMLButtonElement>('.send')!.click(); });
    expect(onSend).toHaveBeenCalledWith('send me now', [], [], 'queue'); expect(editor().value).toBe(''); expect(stored()).toHaveLength(0);
    await act(() => { vi.advanceTimersByTime(1000); }); expect(stored()).toHaveLength(0);
  });

  it('is cleared by new chat, discard and delete session (only the matching draft)', async () => {
    await show('atlas'); await type('new chat text'); await show('atlas', 's1'); await type('s1 text'); await show('atlas', 's2'); await type('s2 text'); flushDrafts();
    expect(stored()).toHaveLength(3);
    newChat('atlas'); expect(stored().some((k) => k.endsWith(draftKey('atlas')))).toBe(false); expect(stored()).toHaveLength(2);
    await deleteSession({ deleteSession: vi.fn(async () => {}) } as unknown as Client, 'atlas', 's1'); expect(stored()).toEqual([`foxfleet.draft.u1:${draftKey('atlas', 's2')}`]);
    discardDraft(draftKey('atlas', 's2')); expect(stored()).toHaveLength(0);
  });

  it('moveDraft carries the stored text to the new session id', async () => {
    await show('atlas'); await type('typed while the reply streams'); flushDrafts();
    moveDraft(draftKey('atlas'), draftKey('atlas', 'new1'));
    expect(stored()).toEqual([`foxfleet.draft.u1:${draftKey('atlas', 'new1')}`]); expect(localStorage.getItem(stored()[0])).toBe('typed while the reply streams');
  });

  it('is scoped per user: another account on the same browser sees nothing, and gets its own', async () => {
    await show('atlas', 's1'); await type('alice private note'); flushDrafts();
    await act(() => render(null, host)); setDraftScope('u2');
    await show('atlas', 's1'); expect(editor().value).toBe(''); await type('bob note'); flushDrafts();
    expect(stored().sort()).toEqual([`foxfleet.draft.u1:${draftKey('atlas', 's1')}`, `foxfleet.draft.u2:${draftKey('atlas', 's1')}`]);
    await act(() => render(null, host)); setDraftScope('u1'); await show('atlas', 's1'); expect(editor().value).toBe('alice private note');
  });

  it('sign-out wipes this user\'s stored drafts (and leaves no text behind), but not another account\'s', async () => {
    await show('atlas', 's1'); await type('secret'); flushDrafts();
    setDraftScope('u2'); await show('atlas', 's2'); await type('bob keeps this'); flushDrafts(); setDraftScope('u1');
    wipeDrafts();
    expect(stored()).toEqual([`foxfleet.draft.u2:${draftKey('atlas', 's2')}`]);
    expect(Object.values(localStorage).join('')).not.toContain('secret');
  });

  it('auth lost (session expired) forgets memory but keeps the same user\'s stored text for the next sign-in', async () => {
    await show('atlas', 's1'); await type('survive expiry'); await act(() => { resetChats(); });
    expect(localStorage.getItem(`foxfleet.draft.u1:${draftKey('atlas', 's1')}`)).toBe('survive expiry');
  });

  it('does not persist when nobody is signed in', async () => {
    setDraftScope(undefined); await show('atlas'); await type('anonymous'); flushDrafts(); expect(stored()).toHaveLength(0);
  });
});
