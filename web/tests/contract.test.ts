// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
// @ts-expect-error plain ESM, shared with the server tests
import { runContract, spec } from '../../contract/run.mjs';
// @ts-expect-error plain ESM mock hub
import { createMock } from '../tools/mock-hub.mjs';
import { parseKinds } from '../src/lib/registry';

let server: ReturnType<typeof createMock>, base = '';
beforeAll(async () => { server = createMock({ dist: '/nonexistent' }); await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
afterAll(() => { server.closeAllConnections?.(); server.close(); });

describe('contract: web mock hub honours contract/openapi.json (same scenario as the real hub)', () => {
  it('passes the shared scenario', async () => { const covered: string[] = await runContract(base); expect(covered.length).toBeGreaterThanOrEqual(21); }, 20000);
  it('the web registry parser accepts what the contract says agent-kinds look like', async () => {
    const cookie = await fetch(base + '/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'a', password: 'b', client: 'app' }) }).then((r) => r.json());
    const kinds = parseKinds(await (await fetch(base + '/api/agent-kinds', { headers: { Authorization: `Bearer ${cookie.token}` } })).json());
    expect(kinds.map((k) => k.kind)).toEqual(['hermes', 'openai', 'openrouter']); expect(spec.paths['/api/agent-kinds']).toBeTruthy();
  });
});
