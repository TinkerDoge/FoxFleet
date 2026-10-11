import { describe, expect, it } from 'vitest';
import { createDoubleTap, displayText, emptyReply, excerpt, messageActions, nextHeart, splitQuote, visibleMessages, withQuote } from '../src/chat/messageActions';
import type { UiMessage } from '../src/lib/chat';

const opts = { newestAssistant: false, newestUser: false, streaming: false, hermes: true, canShare: true, canHide: true, selectable: false };

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
    expect(messageActions(a, { ...opts, newestAssistant: true, streaming: true })).toEqual(['reply', 'copy', 'share', 'delete']);
    expect(messageActions(u, { ...opts, newestUser: true })).toEqual(['reply', 'copy', 'share', 'edit', 'delete']);
    expect(messageActions(u, { ...opts, newestUser: true, hermes: false })).toEqual(['reply', 'copy', 'share', 'delete']);
    expect(messageActions({ role: 'user', content: 'Hi' }, { ...opts, canShare: false })).toEqual(['reply', 'copy']);
    expect(messageActions({ id: 'i', role: 'user', content: '', images: [{ dataUrl: 'x' }] }, opts)).toEqual(['reply', 'delete']);
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
