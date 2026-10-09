import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Client } from '../src/api/client';
import { Composer } from '../src/chat/Composer';
import { resetChats } from '../src/chat/store';

let host: HTMLDivElement;
beforeEach(async () => {
  resetChats(); host = document.createElement('div'); document.body.append(host);
  await act(() => render(<Composer client={{ commands: vi.fn(async () => ({ source: 'local', commands: [] })) } as unknown as Client}
    agent={{ id: 'a', name: 'a', kind: 'hermes', online: true, chatReady: true, capabilities: { images: true, files: true, voice: false } }} history={[]} streaming={false} skills={[]} draftKey="menu-test"
    onSend={() => {}} onStop={() => {}} onLocal={() => {}} />, host));
});
afterEach(async () => { await act(() => render(null, host)); host.remove(); resetChats(); });
const trigger = () => host.querySelector<HTMLButtonElement>('[aria-label="Attach"]')!;
const items = () => [...host.querySelectorAll<HTMLButtonElement>('[role=menuitem]')];
const key = async (key: string) => { const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }); await act(() => { document.activeElement!.dispatchEvent(e); }); return e; };

it('opens attachments with an explicit state, focuses an action and restores focus on Escape', async () => {
  await act(() => trigger().click()); expect(trigger().getAttribute('aria-expanded')).toBe('true'); expect(document.activeElement).toBe(items()[0]);
  await key('Escape'); expect(items()).toHaveLength(0); expect(trigger().getAttribute('aria-expanded')).toBe('false'); expect(document.activeElement).toBe(trigger());
});
it('supports arrow opening, wrapping and Home/End', async () => {
  trigger().focus(); await key('ArrowUp'); expect(document.activeElement).toBe(items()[2]);
  await key('ArrowDown'); expect(document.activeElement).toBe(items()[0]); await key('End'); expect(document.activeElement).toBe(items()[2]);
  await key('Home'); expect(document.activeElement).toBe(items()[0]);
});
it('closes before opening a file picker, leaving the trigger focused even if the picker is canceled', async () => {
  const pick = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
  await act(() => trigger().click()); await act(() => items()[2].click());
  expect(pick).toHaveBeenCalledOnce(); expect(items()).toHaveLength(0); expect(document.activeElement).toBe(trigger()); pick.mockRestore();
});
it('dismisses on outside pointer and Tab without preventing normal Tab movement', async () => {
  await act(() => trigger().click()); await act(() => { document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })); }); expect(items()).toHaveLength(0);
  await act(() => trigger().click()); expect((await key('Tab')).defaultPrevented).toBe(false); expect(items()).toHaveLength(0);
});
