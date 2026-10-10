import { render } from 'preact';
import { act } from 'preact/test-utils';
import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Reasoning, thoughtTime } from '../src/chat/Reasoning';
import { setReasoning } from '../src/state';

const vec = JSON.parse(readFileSync(pathResolve(__dirname, '../../contract/reasoning.vectors.json'), 'utf8'));
let host: HTMLDivElement;
beforeEach(() => { localStorage.clear(); host = document.createElement('div'); document.body.append(host); });
afterEach(async () => { await act(() => render(null, host)); host.remove(); });
const draw = (p: Parameters<typeof Reasoning>[0]) => act(() => render(<Reasoning {...p} />, host));

it('contract vectors file is present (hub normalisation is tested against the same file)', () => { expect(Array.isArray(vec.vectors ?? vec.cases ?? Object.values(vec))).toBe(true); });
it('formats the thinking time', () => { expect(thoughtTime(0)).toBe(''); expect(thoughtTime(400)).toBe('<1 s'); expect(thoughtTime(8200)).toBe('8 s'); expect(thoughtTime(65000)).toBe('1 min 5 s'); });
it('is collapsed by default, toggles on tap and remembers per message', async () => {
  await draw({ text: 'Step one\n\n- a\n- b', ms: 8000, id: 'm1' });
  const head = () => host.querySelector('.reasoning-head') as HTMLButtonElement;
  expect(head().getAttribute('aria-expanded')).toBe('false');
  expect(head().textContent).toContain('Thought for 8 s');
  await act(() => head().click());
  expect(head().getAttribute('aria-expanded')).toBe('true');
  expect(host.querySelector('.reasoning-text li')).toBeTruthy();
  await act(() => render(null, host));
  await draw({ text: 'Step one\n\n- a\n- b', ms: 8000, id: 'm1' });
  expect(head().getAttribute('aria-expanded')).toBe('true'); // remembered
});
it('shows a shimmering Thinking… label while streaming and nothing when the setting is off', async () => {
  await draw({ text: 'so far', live: true });
  expect(host.querySelector('.shimmer')?.textContent).toBe('Thinking…');
  setReasoning(false);
  await draw({ text: 'so far', live: true });
  expect(host.querySelector('.reasoning')).toBeNull();
});
