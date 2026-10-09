import { render } from 'preact';
import { useState } from 'preact/hooks';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionsMenu } from '../src/chat/SessionsMenu';
import type { SessionInfo } from '../src/api/types';

let host: HTMLDivElement;
const sessions: SessionInfo[] = [{ id: 'one', title: 'First chat' }, { id: 'two', title: 'Second chat' }, { id: 'three', title: 'Third chat' }];
const onSelect = vi.fn();
function Example({ list = sessions }: { list?: SessionInfo[] }) {
  const [open, setOpen] = useState(false);
  return <><SessionsMenu sessions={list} current="two" open={open} onOpenChange={setOpen} onSelect={onSelect} /><button>Outside</button></>;
}
beforeEach(() => { host = document.createElement('div'); document.body.append(host); onSelect.mockClear(); });
afterEach(async () => { await act(() => render(null, host)); host.remove(); });
const trigger = () => host.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
const items = () => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
async function key(key: string) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  await act(() => { document.activeElement!.dispatchEvent(event); });
  return event;
}

describe('Sessions menu keyboard and dismissal behavior', () => {
  it('focuses the current session on opening and restores the trigger on Escape', async () => {
    await act(() => render(<Example />, host));
    await act(() => trigger().click());
    expect(document.activeElement).toBe(items()[1]);
    await key('Escape');
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('supports arrow opening, wrapping, Home and End, and selecting with the focused item', async () => {
    await act(() => render(<Example />, host)); trigger().focus();
    await key('ArrowDown'); expect(document.activeElement).toBe(items()[0]);
    await key('ArrowUp'); expect(document.activeElement).toBe(items()[2]);
    await key('ArrowDown'); expect(document.activeElement).toBe(items()[0]);
    await key('End'); expect(document.activeElement).toBe(items()[2]);
    await key('Home'); expect(document.activeElement).toBe(items()[0]);
    await act(() => (document.activeElement as HTMLButtonElement).click());
    expect(onSelect).toHaveBeenCalledWith('one'); expect(document.activeElement).toBe(trigger());
    await key('ArrowUp'); expect(document.activeElement).toBe(items()[2]);
  });

  it('dismisses on outside pointer and focus movement without taking focus back', async () => {
    await act(() => render(<Example />, host));
    await act(() => trigger().click());
    await act(() => { document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
    expect(host.querySelector('[role="menu"]')).toBeNull();
    await act(() => trigger().click());
    const outside = host.lastElementChild as HTMLButtonElement;
    await act(() => outside.focus());
    expect(host.querySelector('[role="menu"]')).toBeNull(); expect(document.activeElement).toBe(outside);
  });

  it('closes on Tab without preventing the browser from moving focus', async () => {
    await act(() => render(<Example />, host)); await act(() => trigger().click());
    const event = await key('Tab');
    expect(event.defaultPrevented).toBe(false); expect(host.querySelector('[role="menu"]')).toBeNull();
  });

  it('keeps an empty menu keyboard accessible and dismissible', async () => {
    await act(() => render(<Example list={[]} />, host)); trigger().focus();
    await key('ArrowDown');
    expect(document.activeElement).toBe(host.querySelector('[role="menu"]'));
    await key('Escape'); expect(document.activeElement).toBe(trigger());
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });
});
