import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyHidden, applyReaction, QUICK, ReactionBar, type ReactionSnapshot } from '../src/chat/Reactions';
import { Message } from '../src/chat/Message';
import { fromHistory } from '../src/lib/chat';

const me = { id: 'user:u', name: 'Owner', kind: 'human' as const }, bot = { id: 'agent:a', name: 'Atlas', kind: 'agent' as const };
let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); vi.stubGlobal('fetch', vi.fn(async () => new Response('[]'))); });
afterEach(async () => { await act(() => render(null, host)); host.remove(); vi.unstubAllGlobals(); });

describe('reactions', () => {
  it('apply is idempotent: adding twice keeps one entry, removing twice leaves none of yours', () => {
    let s: ReactionSnapshot = { actor: me, messages: { m: [{ emoji: '❤️', actors: [bot] }] } };
    s = applyReaction(applyReaction(s, 'm', '❤️', true), 'm', '❤️', true);
    expect(s.messages.m[0].actors).toEqual([bot, me]);
    s = applyReaction(s, 'm', '👍', true);
    expect(s.messages.m.map((g) => g.emoji)).toEqual(['❤️', '👍']);
    s = applyReaction(applyReaction(applyReaction(s, 'm', '❤️', false), 'm', '❤️', false), 'm', '👍', false);
    expect(s.messages.m).toEqual([{ emoji: '❤️', actors: [bot] }]);
  });

  it('pills show counts, mark yours, name humans and agents, and toggle with intent (never a blind flip)', async () => {
    const onReact = vi.fn();
    await act(() => render(<ReactionBar groups={[{ emoji: '🦊', actors: [me, bot] }, { emoji: '👍', actors: [bot] }]} me={me.id} onReact={onReact} />, host));
    const pills = [...host.querySelectorAll<HTMLButtonElement>('.react-pill')];
    expect(pills.map((p) => p.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
    expect(pills[0].getAttribute('aria-label')).toContain('You, Atlas (agent)');
    expect(pills[0].textContent).toContain('2');
    await act(() => pills[0].click()); await act(() => pills[1].click());
    expect(onReact.mock.calls).toEqual([['🦊', false], ['👍', true]]);
  });

  it('a message without a stable id offers no reaction control', async () => {
    await act(() => render(<Message m={{ role: 'assistant', content: 'hi' }} onMedia={() => {}} />, host));
    expect(host.querySelector('.react-add')).toBeNull();
    await act(() => render(<Message m={{ id: 'x', role: 'assistant', content: 'hi' }} onMedia={() => {}} reactions={{ groups: [], me: me.id, onReact: () => {} }} />, host));
    expect(host.querySelector('.react-add')).not.toBeNull();
  });

  it('quick row is like, dislike, heart, confetti, surprise', () => {
    expect(QUICK).toEqual(['👍', '👎', '❤️', '🎉', '😮']);
  });

  it('hiding is optimistic and idempotent', () => {
    let s: ReactionSnapshot = { actor: me, messages: {}, hidden: [] };
    s = applyHidden(applyHidden(s, 'm', true), 'm', true); expect(s.hidden).toEqual(['m']);
    s = applyHidden(applyHidden(s, 'm', false), 'm', false); expect(s.hidden).toEqual([]);
  });
});

describe('completed history stays clean', () => {
  it('keeps stable ids and hides tool-only rows, but keeps text, media and reasoning', () => {
    expect(fromHistory({ id: 'msg_1', role: 'assistant', content: 'hi' })?.id).toBe('msg_1');
    expect(fromHistory({ id: 7, role: 'user', content: 'x' })?.id).toBe('7');
    expect(fromHistory({ role: 'assistant', content: '', tools: [{ name: 'terminal' }] })).toBeNull();
    expect(fromHistory({ role: 'assistant', content: '', reasoning: 'thought' })).not.toBeNull();
  });
  it('renders no tool log under an answer', async () => {
    await act(() => render(<Message m={{ role: 'assistant', content: 'Done.', tools: [{ name: 'terminal', args: 'rm -rf /tmp/x' }] }} onMedia={() => {}} />, host));
    expect(host.querySelector('details.tools')).toBeNull();
    expect(host.textContent).not.toContain('rm -rf');
  });
});
