import { render } from 'preact';
import { act } from 'preact/test-utils';
import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { avatarSeed, isUnread, listTime, markSeen, previewLine, seedSeen, setSeenScope, sortAgents } from '../src/lib/agentList';
import { AgentList } from '../src/agents/AgentList';
import type { AgentSummary } from '../src/api/types';

const v = JSON.parse(readFileSync(pathResolve(__dirname, '../../contract/agent-list.vectors.json'), 'utf8'));

it('conformance: order is pinned (in pin order), newest activity, then registry order', () => {
  expect(sortAgents(v.sort.input).map((a: any) => a.name)).toEqual(v.sort.expect);
  expect(sortAgents(sortAgents(v.sort.input)).map((a: any) => a.name)).toEqual(v.sort.expect);
});
it.each(v.preview.map((p: any, i: number) => [i, p]) as [number, any][])('conformance: preview %i', (_i, p) => { expect(previewLine(p.agent)).toEqual(p.expect); });
it.each(v.time.map((p: any) => [String(p.at), p]) as [string, any][])('conformance: time %s', (_n, p) => { expect(listTime(p.at, v.now, 'en-US', 'UTC')).toBe(p.expect); });

it('a reply running on this device shows as typing even before the hub says so', () => { expect(previewLine({ last_message_preview: 'old' }, true).kind).toBe('typing'); });
it('time is empty without a timestamp and never throws for nonsense', () => { expect(listTime(undefined)).toBe(''); expect(listTime(NaN)).toBe(''); expect(listTime(0)).toBe(''); });
it('avatars: stable colour per name, initials from two words or two letters', () => {
  expect(avatarSeed('doge-studio', 'Doge Studio').initials).toBe('DS'); expect(avatarSeed('sumin', 'Sumin').initials).toBe('SU');
  expect(avatarSeed('sumin').hue).toBe(avatarSeed('sumin').hue); expect(avatarSeed('', '').initials).toBe('?');
});
it('unread: only an agent reply newer than what you last saw; a new device starts read; the open chat is never unread', () => {
  localStorage.clear(); setSeenScope('u1');
  const a = { name: 'x', last_activity_at: 100, last_role: 'assistant' as const };
  expect(isUnread(a, false)).toBe(false); seedSeen('x', 100); expect(isUnread(a, false)).toBe(false);
  expect(isUnread({ ...a, last_activity_at: 200 }, false)).toBe(true); expect(isUnread({ ...a, last_activity_at: 200 }, true)).toBe(false);
  expect(isUnread({ ...a, last_activity_at: 200, last_role: 'user' }, false)).toBe(false);
  markSeen('x', 200); expect(isUnread({ ...a, last_activity_at: 200 }, false)).toBe(false);
  setSeenScope('u2'); expect(isUnread({ ...a, last_activity_at: 200 }, false)).toBe(false); // another user on this device has their own marks
});

let host: HTMLDivElement;
beforeEach(() => { localStorage.clear(); setSeenScope('t'); host = document.createElement('div'); document.body.append(host); });
afterEach(async () => { await act(() => render(null, host)); host.remove(); });
const ag = (name: string, extra: Partial<AgentSummary> = {}): AgentSummary => ({ id: name, name, displayName: name[0].toUpperCase() + name.slice(1), kind: 'hermes', online: true, chatReady: true, order: 0, ...extra });
const draw = (agents: AgentSummary[] | null, onPin = vi.fn(), selected?: string) => act(() => render(<AgentList agents={agents} selectedName={selected} onPick={() => {}} onPin={onPin} />, host));
const names = () => [...host.querySelectorAll('.agent-row .row-name')].map((n) => n.textContent);

it('rows: sorted pinned first then by activity, with name, preview ("You: "), a pin mark and the time', async () => {
  const now = Date.now();
  await draw([ag('quiet'), ag('old', { last_activity_at: now - 5 * 86_400_000, last_message_preview: 'older', last_role: 'assistant' }), ag('pin', { pinned: true, pin_order: 0, last_message_preview: 'pinned one', last_activity_at: 1, last_role: 'assistant' }), ag('new', { last_activity_at: now - 60_000, last_message_preview: 'Ship it', last_role: 'user' })]);
  expect(names()).toEqual(['Pin', 'New', 'Old', 'Quiet']);
  const rows = [...host.querySelectorAll('.agent-row')];
  expect(rows[0].querySelector('.row-pin-mark')).toBeTruthy(); expect(rows[1].querySelector('.row-preview')!.textContent).toBe('You: Ship it'); expect(rows[1].querySelector('time')!.textContent).not.toBe('');
  expect(rows[3].querySelector('.row-preview')!.textContent).toBe('No messages yet');
  expect(host.textContent).toContain('Pinned'); expect(host.textContent).toContain('All agents');
});
it('typing and needs-approval replace the preview; an unread agent shows a badge and bold name', async () => {
  const now = Date.now(); localStorage.setItem('foxfleet.seen.t', JSON.stringify({ a: now - 5000 }));
  await draw([ag('a', { last_activity_at: now, last_role: 'assistant', last_message_preview: 'hi' }), ag('b', { working: true, last_message_preview: 'x' }), ag('c', { needs_input: true, working: true })]);
  const byName = (n: string) => [...host.querySelectorAll('.agent-row')].find((r) => r.querySelector('.row-name')!.textContent === n)!;
  expect(byName('A').classList.contains('unread')).toBe(true); expect(byName('A').querySelector('.badge')).toBeTruthy();
  expect(byName('B').querySelector('.row-preview')!.textContent).toContain('Typing'); expect(byName('C').querySelector('.row-preview')!.textContent).toBe('Needs approval');
  await draw([ag('a', { last_activity_at: now, last_role: 'assistant', last_message_preview: 'hi' })], vi.fn(), 'a'); expect(host.querySelector('.badge')).toBeNull(); // the open chat is read
});
it('the pin button toggles through onPin and carries a name for screen readers; long names are clipped by CSS, not cut in the data', async () => {
  const onPin = vi.fn(), long = 'Doge Studio Operations Night Shift Agent';
  await draw([ag('x', { displayName: long })], onPin); const btn = host.querySelector<HTMLButtonElement>('.row-pin')!;
  expect(btn.getAttribute('aria-label')).toBe(`Pin ${long}`); expect(btn.getAttribute('aria-pressed')).toBe('false'); btn.click(); expect(onPin).toHaveBeenCalledOnce();
  expect(host.querySelector('.row-name')!.textContent).toBe(long);
});
it('the context menu (right click) pins and unpins', async () => {
  const onPin = vi.fn(); await draw([ag('x', { pinned: true, pin_order: 0 })], onPin);
  await act(() => { host.querySelector('.agent-row a')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
  const item = host.querySelector<HTMLButtonElement>('.ctx-menu [role=menuitem]')!; expect(item.textContent).toBe('Unpin'); await act(() => { item.click(); }); expect(onPin).toHaveBeenCalledOnce(); expect(host.querySelector('.ctx-menu')).toBeNull();
});
it('search filters by name or preview and says so when nothing matches; loading shows skeleton rows, not a spinner', async () => {
  await draw(null); expect(host.querySelectorAll('.agent-row.sk').length).toBeGreaterThan(2);
  await draw([ag('alpha'), ag('beta', { last_message_preview: 'needle inside' })]);
  const input = host.querySelector<HTMLInputElement>('.search input')!;
  await act(() => { input.value = 'needle'; input.dispatchEvent(new Event('input', { bubbles: true })); }); expect(names()).toEqual(['Beta']);
  await act(() => { input.value = 'zzz'; input.dispatchEvent(new Event('input', { bubbles: true })); }); expect(host.querySelector('.list-empty')?.textContent).toContain('No agent matches');
});
