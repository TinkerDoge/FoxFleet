import { describe, expect, it } from 'vitest';
import { createClient } from '../src/api/client';
import { foundLine, profileLine } from '../src/agents/Machines';
import type { Machine } from '../src/api/types';

const machine = (names: string[]): Machine => ({ id: 'a'.repeat(32), name: 'Desk', os: 'linux', online: true, paired: true, created: 1, lastSeen: 2, profiles: names.map((n) => ({ profile: n, agent: n })) });
const fake = (routes: Record<string, unknown>, seen: { url: string; init?: RequestInit }[] = []) => async (url: RequestInfo | URL, init?: RequestInit) => { seen.push({ url: String(url), init }); const key = `${init?.method ?? 'GET'} ${new URL(String(url), 'http://x').pathname}`; return new Response(JSON.stringify(routes[key] ?? {}), { status: 200, headers: { 'Content-Type': 'application/json' } }); };

describe('machines client', () => {
  it('talks to the machine routes and never sends more than it needs', async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const c = createClient({ fetch: fake({ 'GET /api/machines': { machines: [machine(['default'])] }, 'POST /api/machines/pairing': { code: 'ABCDEFGHJK' }, 'GET /api/machines/pairing': { state: 'paired', machine: machine(['a', 'b']) } }, seen) });
    expect((await c.machines())[0].name).toBe('Desk');
    expect((await c.createPairing()).code).toBe('ABCDEFGHJK');
    expect(await c.pairingStatus('ABCDE-FGHJK')).toMatchObject({ state: 'paired' });
    expect(seen.at(-1)!.url).toContain('code=ABCDE-FGHJK');
    await c.rotateMachine('m1'); await c.renameMachine('m1', 'New'); await c.revokeMachine('m1');
    expect(seen.slice(-3).map((s) => `${s.init?.method} ${s.url}`)).toEqual(['POST /api/machines/m1/token', 'PATCH /api/machines/m1', 'DELETE /api/machines/m1']);
  });
  it('maps unknown pairing states to waiting', async () => {
    const c = createClient({ fetch: fake({ 'GET /api/machines/pairing': { state: 'weird' } }) });
    expect(await c.pairingStatus('X')).toEqual({ state: 'waiting' });
  });
});

describe('machine status text', () => {
  it('lists profiles the way the hub reports them, singular and plural', () => {
    expect(profileLine(machine([]))).toBe('No profiles shared yet');
    expect(foundLine(machine(['default']))).toBe('Found 1 profile: default');
    expect(foundLine(machine(['default', 'coder', 'research']))).toBe('Found 3 profiles: default, coder, research');
  });
});
