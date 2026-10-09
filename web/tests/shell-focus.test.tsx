import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Client } from '../src/api/client';
import { Shell } from '../src/screens/Shell';
import { resetChats } from '../src/chat/store';

let host: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  resetChats(); localStorage.clear(); history.replaceState(null, '', '#/chat?agent=a'); host = document.createElement('div'); document.body.append(host);
  const client = { agents: vi.fn(async () => [{ id: 'a', name: 'a', kind: 'hermes', online: true, chatReady: true, capabilities: { sessions: false } }]), skills: vi.fn(async () => []), sessions: vi.fn(async () => ({ sessions: [], total: 0 })) } as unknown as Client;
  await act(() => render(<Shell client={client} info={{ required: true, authenticated: true, setupRequired: false, setupCodeRequired: false, registration: 'closed', user: { id: 'u1', username: 'Test', role: 'owner' } }} onSignedOut={() => {}} />, host));
});
afterEach(async () => { await act(() => render(null, host)); host.remove(); resetChats(); vi.unstubAllGlobals(); });
const menu = () => host.querySelector<HTMLButtonElement>('[aria-label=Menu]')!;
const drawer = () => host.querySelector<HTMLElement>('.sidebar')!;
const key = async (key: string, shiftKey = false) => { const e = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }); await act(() => { document.activeElement!.dispatchEvent(e); }); return e; };

it('moves focus into the phone drawer, makes the background inactive and wraps Tab', async () => {
  menu().focus(); await act(() => menu().click());
  expect(drawer().getAttribute('role')).toBe('dialog'); expect(drawer().getAttribute('aria-modal')).toBe('true');
  expect(drawer().contains(document.activeElement)).toBe(true); expect(host.querySelector('main')!.hasAttribute('inert')).toBe(true);
  const focusable = [...drawer().querySelectorAll<HTMLElement>('a[href], button')];
  focusable.at(-1)!.focus(); expect((await key('Tab')).defaultPrevented).toBe(true); expect(document.activeElement).toBe(focusable[0]);
  await key('Tab', true); expect(document.activeElement).toBe(focusable.at(-1));
});
it('Escape restores the menu trigger and a closed drawer is inactive', async () => {
  menu().focus(); await act(() => menu().click()); await key('Escape');
  expect(menu().getAttribute('aria-expanded')).toBe('false'); expect(document.activeElement).toBe(menu());
  expect(drawer().hasAttribute('inert')).toBe(true); expect(host.querySelector('main')!.hasAttribute('inert')).toBe(false);
});
it('moves route focus on a same-agent session change', async () => {
  const button = host.querySelector<HTMLButtonElement>('.chat-secondary button')!; button.focus();
  await act(() => { history.replaceState(null, '', '#/chat?agent=a&session=s2'); window.dispatchEvent(new Event('hashchange')); });
  expect(document.activeElement).toBe(host.querySelector('main'));
});
it('an unknown-agent URL shows an unavailable view instead of another agent conversation', async () => {
  await act(() => { history.replaceState(null, '', '#/chat?agent=deleted'); window.dispatchEvent(new Event('hashchange')); });
  expect(host.querySelector('.chat')).toBeNull(); expect(host.textContent).toContain('Agent unavailable'); expect(location.hash).toContain('agent=deleted');
});
