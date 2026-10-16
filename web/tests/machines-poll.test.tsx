import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Machines, MACHINES_POLL_MS } from '../src/agents/Machines';
import type { Client } from '../src/api/client';

let host: HTMLDivElement, hidden = false;
beforeEach(() => { vi.useFakeTimers(); hidden = false; Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') }); host = document.createElement('div'); document.body.append(host); });
afterEach(async () => { await act(() => render(null, host)); host.remove(); vi.useRealTimers(); });

const machine = { id: 'a'.repeat(32), name: 'Desk', os: 'linux', online: true, paired: true, created: 1, lastSeen: 2, profiles: [] };
const pairing = { code: 'ABCDEFGHJK', display: 'ABCDE-FGHJK', expires: Date.now() + 600_000, url: 'https://hub/c/ABCDEFGHJK', link: 'foxfleet://pair', rows: [], commands: { sh: 'sh', powershell: 'ps', node: 'node' } };
function fakeClient(pairState: () => string) {
  const calls = { machines: 0, status: 0 };
  const client = { machines: async () => { calls.machines++; return [machine]; }, createPairing: async () => pairing, pairingStatus: async () => { calls.status++; return { state: pairState(), machine }; } } as unknown as Client;
  return { client, calls };
}
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

it('machines list refreshes every 30 s (was 8 s) and not while the tab is hidden', async () => {
  expect(MACHINES_POLL_MS).toBe(30_000);
  
  const { client, calls } = fakeClient(() => 'waiting');
  await act(() => render(<Machines client={client} onChanged={() => {}} onAuthLost={() => {}} />, host)); await tick(0);
  expect(calls.machines).toBe(1);
  await tick(29_000); expect(calls.machines).toBe(1);
  await tick(1_000); expect(calls.machines).toBe(2);
  hidden = true; await tick(90_000); expect(calls.machines).toBe(2);
});

it('pairing polls every 2 s only while the code waits: never when hidden, and stops once paired', async () => {
  let state = 'waiting'; const { client, calls } = fakeClient(() => state);
  await act(() => render(<Machines client={client} onChanged={() => {}} onAuthLost={() => {}} />, host)); await tick(0);
  await act(async () => { (host.querySelector('button.btn.primary') as HTMLButtonElement).click(); }); await tick(0);
  const first = calls.status; expect(first).toBeGreaterThanOrEqual(1);
  await tick(4_000); expect(calls.status).toBe(first + 2);
  hidden = true; await tick(10_000); expect(calls.status).toBe(first + 2);
  hidden = false; state = 'paired'; await tick(2_000); const atPaired = calls.status;
  await tick(20_000); expect(calls.status).toBe(atPaired);
});
