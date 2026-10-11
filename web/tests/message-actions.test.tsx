import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Message } from '../src/chat/Message';
import { MessageMenu, clampToView } from '../src/chat/MessageMenu';
import { createDoubleTap, displayText, emptyReply, excerpt, messageActions, newestTargets, nextHeart, nextReaction, splitQuote, visibleMessages, withQuote } from '../src/chat/messageActions';
import type { UiMessage } from '../src/lib/chat';

const opts = { newestAssistant: false, newestUser: false, busy: false, hermes: true, canShare: true, canHide: true, selectable: false };

describe('message actions', () => {
  it('a reply quote round-trips and only a leading "> line + blank line" counts', () => {
    const sent = withQuote({ author: 'Atlas', excerpt: 'Ship it?' }, 'Yes');
    expect(sent).toBe('> Ship it?\n\nYes');
    expect(splitQuote(sent)).toEqual({ quote: 'Ship it?', body: 'Yes' });
    expect(splitQuote('> no blank line\nYes')).toBeNull();
    expect(splitQuote('Yes\n> later')).toBeNull();
    expect(withQuote(null, 'Yes')).toBe('Yes');
  });

  it('display text drops tags, REACT: lines, file lines and the reply quote', () => {
    expect(displayText({ role: 'assistant', content: 'Done\nREACT: ❤️\nMEDIA:/tmp/a.png' })).toBe('Done');
    expect(displayText({ role: 'user', content: '> q\n\nHello\n\n[Attached file: uploads/a.txt (1 KB)]' })).toBe('Hello');
  });

  it('excerpt is one line, at most 140 characters, with a fallback for media-only messages', () => {
    expect(excerpt({ role: 'user', content: 'a\n\n b   c' })).toBe('a b c');
    const long = excerpt({ role: 'user', content: 'x'.repeat(200) });
    expect(Array.from(long).length).toBe(140); expect(long.endsWith('…')).toBe(true);
    expect(excerpt({ role: 'user', content: '', images: [{ dataUrl: 'data:image/png;base64,AA' }] })).toBe('[image]');
    expect(excerpt({ role: 'assistant', content: 'MEDIA:/tmp/v.ogg' })).toBe('[voice]');
    expect(excerpt({ role: 'assistant', content: 'MEDIA:/tmp/r.pdf' })).toBe('[file]');
  });

  it('a reply that is only a REACT: line draws no row; hidden ids are dropped', () => {
    const msgs: UiMessage[] = [{ id: 'u', role: 'user', content: 'hi' }, { id: 'a', role: 'assistant', content: 'REACT: ❤️' }, { id: 'b', role: 'assistant', content: 'Hello' }];
    expect(emptyReply(msgs[1])).toBe(true); expect(emptyReply(msgs[2])).toBe(false);
    expect(visibleMessages(msgs, new Set(['b'])).map((m) => m.id)).toEqual(['u']);
  });

  it('menu actions follow role, recency, agent kind and stable ids', () => {
    const a: UiMessage = { id: 'a', role: 'assistant', content: 'Hello' }, u: UiMessage = { id: 'u', role: 'user', content: 'Hi' };
    expect(messageActions(a, { ...opts, newestAssistant: true })).toEqual(['reply', 'copy', 'share', 'retry', 'delete']);
    expect(messageActions(a, { ...opts, newestAssistant: true, busy: true })).toEqual(['reply', 'copy', 'share', 'delete']);
    expect(messageActions(u, { ...opts, newestUser: true })).toEqual(['reply', 'copy', 'share', 'edit', 'delete']);
    expect(messageActions(u, { ...opts, newestUser: true, hermes: false })).toEqual(['reply', 'copy', 'share', 'delete']);
    expect(messageActions(u, { ...opts, newestUser: true, busy: true })).toEqual(['reply', 'copy', 'share', 'delete']);
    expect(messageActions({ role: 'user', content: 'Hi' }, { ...opts, canShare: false })).toEqual(['reply', 'copy']);
    expect(messageActions({ id: 'i', role: 'user', content: '', images: [{ dataUrl: 'x' }] }, opts)).toEqual(['reply', 'delete']);
  });

  it('Retry is for a reply that is the last message; Edit for the newest user message once a reply follows it', () => {
    const u1: UiMessage = { role: 'user', content: 'a' }, a1: UiMessage = { role: 'assistant', content: 'b' }, u2: UiMessage = { role: 'user', content: 'c' };
    const note: UiMessage = { role: 'system', content: 'Model set' };
    expect(newestTargets([u1, a1])).toEqual({ assistant: a1, user: u1 });
    expect(newestTargets([u1, a1, note])).toEqual({ assistant: a1, user: u1 });
    expect(newestTargets([u1, a1, u2])).toEqual({ assistant: undefined, user: undefined });
    expect(newestTargets([])).toEqual({ assistant: undefined, user: undefined });
  });

  it('picking an emoji you already gave takes it back', () => {
    const me = { id: 'user:u', name: 'Me', kind: 'human' as const };
    expect(nextReaction([{ emoji: '👍', actors: [me] }], me.id, '👍')).toBe(false);
    expect(nextReaction([{ emoji: '👍', actors: [me] }], me.id, '🎉')).toBe(true);
  });

  it('double-tap toggles your heart', () => {
    const me = { id: 'user:u', name: 'Me', kind: 'human' as const };
    expect(nextHeart([], me.id)).toBe(true);
    expect(nextHeart([{ emoji: '❤️', actors: [me] }], me.id)).toBe(false);
    expect(nextHeart([{ emoji: '❤️', actors: [{ ...me, id: 'agent:a', kind: 'agent' }] }], me.id)).toBe(true);
  });

  it('a double tap is two taps within 300 ms and 24 px', () => {
    let now = 0; const tap = createDoubleTap(() => now);
    expect(tap(10, 10)).toBe(false); now = 200; expect(tap(20, 15)).toBe(true);
    now = 1000; expect(tap(10, 10)).toBe(false); now = 1400; expect(tap(10, 10)).toBe(false);
    now = 1500; expect(tap(100, 10)).toBe(false);
  });
});

let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); vi.stubGlobal('fetch', vi.fn(async () => new Response('[]'))); });
afterEach(async () => { await act(() => render(null, host)); host.remove(); vi.unstubAllGlobals(); });
const pointer = (type: string, pointerType: string, x = 10, y = 10) => Object.assign(new Event(type, { bubbles: true, cancelable: true }), { pointerType, clientX: x, clientY: y });

describe('message gestures', () => {
  it('right-click opens the menu at the pointer; a touch double tap hearts; a mouse double click does not', async () => {
    const open = vi.fn(), heart = vi.fn();
    await act(() => render(<Message m={{ id: 'a', role: 'assistant', content: 'Hello' }} onMedia={() => {}} gestures={{ open, heart }} />, host));
    const card = host.querySelector('.msg-card')!;
    await act(() => { card.dispatchEvent(Object.assign(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }))); });
    expect(open).toHaveBeenCalledWith(40, 50);
    await act(() => { card.dispatchEvent(pointer('pointerup', 'mouse')); card.dispatchEvent(pointer('pointerup', 'mouse')); });
    expect(heart).not.toHaveBeenCalled();
    await act(() => { card.dispatchEvent(pointer('pointerup', 'touch')); card.dispatchEvent(pointer('pointerup', 'touch')); });
    expect(heart).toHaveBeenCalledTimes(1);
  });

  it('a touch long press opens the menu at the finger once; a real move cancels it; the lift is not a tap', async () => {
    vi.useFakeTimers();
    try {
      const open = vi.fn(), heart = vi.fn();
      await act(() => render(<Message m={{ id: 'a', role: 'user', content: 'Hi' }} onMedia={() => {}} gestures={{ open, heart }} />, host));
      const bubble = host.querySelector('.bubble')!;
      bubble.dispatchEvent(pointer('pointerdown', 'touch', 20, 30));
      bubble.dispatchEvent(pointer('pointermove', 'touch', 23, 32)); // jitter
      vi.advanceTimersByTime(499); expect(open).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1); expect(open).toHaveBeenCalledWith(20, 30);
      const native = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 });
      bubble.dispatchEvent(native); // Android's own long-press contextmenu: suppressed, no second open
      expect(native.defaultPrevented).toBe(true); expect(open).toHaveBeenCalledTimes(1);
      bubble.dispatchEvent(pointer('pointerup', 'touch', 20, 30));
      bubble.dispatchEvent(pointer('pointerdown', 'touch', 20, 30)); bubble.dispatchEvent(pointer('pointerup', 'touch', 20, 30));
      expect(heart).not.toHaveBeenCalled();
      bubble.dispatchEvent(pointer('pointerdown', 'touch', 20, 30));
      bubble.dispatchEvent(pointer('pointermove', 'touch', 20, 60)); // scroll
      vi.advanceTimersByTime(600); expect(open).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('right-click on a link keeps the browser menu', async () => {
    const open = vi.fn();
    await act(() => render(<Message m={{ id: 'a', role: 'assistant', content: '[site](https://example.com)' }} onMedia={() => {}} gestures={{ open }} />, host));
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
    host.querySelector('.msg-card a')!.dispatchEvent(ev);
    expect(open).not.toHaveBeenCalled(); expect(ev.defaultPrevented).toBe(false);
  });

  it('a touch press blocks text selection only while the finger is down', async () => {
    await act(() => render(<Message m={{ id: 'a', role: 'assistant', content: 'Hello' }} onMedia={() => {}} gestures={{ open: () => {} }} />, host));
    const card = host.querySelector('.msg-card')!;
    card.dispatchEvent(pointer('pointerdown', 'touch')); expect(card.classList.contains('pressing')).toBe(true);
    card.dispatchEvent(pointer('pointerup', 'touch')); expect(card.classList.contains('pressing')).toBe(false);
    card.dispatchEvent(pointer('pointerdown', 'mouse')); expect(card.classList.contains('pressing')).toBe(false);
  });

  it('the ⋯ button says whether its menu is open and which one', async () => {
    await act(() => render(<Message m={{ id: 'a', role: 'assistant', content: 'Hello' }} onMedia={() => {}} gestures={{ open: () => {}, menuId: 'm1' }} />, host));
    const more = host.querySelector('.msg-more')!;
    expect(more.getAttribute('aria-expanded')).toBe('true'); expect(more.getAttribute('aria-controls')).toBe('m1');
    await act(() => render(<Message m={{ id: 'a', role: 'assistant', content: 'Hello' }} onMedia={() => {}} gestures={{ open: () => {} }} />, host));
    expect(more.getAttribute('aria-expanded')).toBe('false'); expect(more.hasAttribute('aria-controls')).toBe(false);
  });

  it('the ⋯ button opens the same menu (keyboard reachable)', async () => {
    const open = vi.fn();
    await act(() => render(<Message m={{ id: 'a', role: 'assistant', content: 'Hello' }} onMedia={() => {}} gestures={{ open, heart: () => {} }} />, host));
    await act(() => host.querySelector<HTMLButtonElement>('.msg-more')!.click());
    expect(open).toHaveBeenCalled();
  });

  it('a user message that starts with a quote shows a reply bubble above its text', async () => {
    await act(() => render(<Message m={{ role: 'user', content: '> Ship it?\n\nYes' }} onMedia={() => {}} />, host));
    expect(host.querySelector('.reply-quote')!.textContent).toBe('Ship it?');
    expect(host.querySelector('.user-text')!.textContent).toBe('Yes');
  });

  it('the menu is clamped to the viewport by its real size', () => {
    expect(clampToView(300, 200, 360)).toBe(152);
    expect(clampToView(2, 200, 360)).toBe(8);
    expect(clampToView(100, 350, 360)).toBe(8); // wider than the view minus margins: pinned at the margin
  });

  it('the picker, measured wider than a narrow phone, sits at the margin', async () => {
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const picker = !!this.querySelector('.emoji-picker');
      return { left: 0, top: 0, right: 0, bottom: 0, x: 0, y: 0, width: picker ? 344 : 240, height: picker ? 420 : 300, toJSON() {} } as DOMRect;
    });
    const w = innerWidth, h = innerHeight; Object.assign(window, { innerWidth: 360, innerHeight: 640 });
    try {
      await act(() => render(<MessageMenu x={200} y={500} actions={['reply']} canReact onReact={() => {}} onAction={() => {}} onClose={() => {}} />, host));
      const menu = host.querySelector<HTMLElement>('.msg-menu')!;
      expect([menu.style.left, menu.style.top]).toEqual(['112px', '332px']);
      await act(() => host.querySelector<HTMLButtonElement>('.msg-menu-quick .more')!.click());
      expect([menu.style.left, menu.style.top]).toEqual(['8px', '212px']);
    } finally { rect.mockRestore(); Object.assign(window, { innerWidth: w, innerHeight: h }); }
  });

  it('focus moving outside closes the menu', async () => {
    const onClose = vi.fn(), outside = document.createElement('button'); document.body.append(outside);
    await act(() => render(<MessageMenu x={10} y={10} actions={['reply']} canReact={false} onReact={() => {}} onAction={() => {}} onClose={onClose} />, host));
    expect(onClose).not.toHaveBeenCalled();
    await act(() => outside.focus()); expect(onClose).toHaveBeenCalled(); outside.remove();
  });

  it('the menu offers the quick row, the picker and the actions', async () => {
    const onReact = vi.fn(), onAction = vi.fn(), onClose = vi.fn();
    await act(() => render(<MessageMenu x={10} y={10} actions={['reply', 'copy', 'delete']} canReact onReact={onReact} onAction={onAction} onClose={onClose} />, host));
    const quick = [...host.querySelectorAll<HTMLButtonElement>('.msg-menu-quick button')];
    expect(quick.length).toBe(6); // 5 emoji + more
    await act(() => quick[2].click()); expect(onReact).toHaveBeenCalledWith('❤️');
    const items = [...host.querySelectorAll<HTMLButtonElement>('[role=menuitem]')];
    expect(items.map((b) => b.textContent)).toEqual(['Reply', 'Copy', 'Delete for me']);
    await act(() => items[1].click()); expect(onAction).toHaveBeenCalledWith('copy');
    await act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); }); expect(onClose).toHaveBeenCalled();
  });
});
