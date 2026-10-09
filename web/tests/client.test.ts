import { describe, expect, it } from 'vitest';
import { createClient } from '../src/api/client';
import { ApiError, AuthRequiredError, NetworkError, RateLimitedError } from '../src/api/errors';
import { authModeFor } from '../src/lib/authMode';
import { t } from '../src/i18n/t';

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => async () => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers });
const client = (f: typeof fetch) => createClient({ base: 'https://hub.example.com', fetch: f });

describe('api client', () => {
  it('parses auth info and validates it is a hub', async () => {
    const info = await client(reply(200, { required: true, authenticated: false, setupRequired: true, setupCodeRequired: true, registration: 'invite' }) as any).authInfo();
    expect(info).toMatchObject({ setupRequired: true, setupCodeRequired: true, registration: 'invite', authenticated: false });
    await expect(client(reply(200, { hello: 'world' }) as any).authInfo()).rejects.toMatchObject({ code: 'not_hub' });
    expect((await client(reply(200, { required: true, authenticated: true, registration: 'weird', user: { id: '1', username: 'a', role: 'owner' } }) as any).authInfo())).toMatchObject({ registration: 'closed', user: { role: 'owner' } });
  });
  it('maps 401 to AuthRequiredError except on plain auth calls', async () => {
    await expect(client(reply(401, { error: 'Login required' }) as any).agents()).rejects.toBeInstanceOf(AuthRequiredError);
    const e: any = await client(reply(401, { error: 'Invalid username or password' }) as any).login('a', 'b').catch((x: any) => x);
    expect(e).toBeInstanceOf(ApiError); expect(e).not.toBeInstanceOf(AuthRequiredError); expect(e.message).toMatch(/Invalid/);
  });
  it('maps 429 with retry-after, other errors to ApiError, and fetch failures to NetworkError', async () => {
    const r: any = await client(reply(429, { error: 'Too many attempts' }, { 'retry-after': '42' }) as any).login('a', 'b').catch((x: any) => x);
    expect(r).toBeInstanceOf(RateLimitedError); expect(r.retryAfter).toBe(42);
    await expect(client(reply(409, { error: 'Setup already completed' }) as any).setup('a', 'b')).rejects.toMatchObject({ status: 409, message: 'Setup already completed' });
    await expect(client((async () => { throw new TypeError('x'); }) as any).agents()).rejects.toBeInstanceOf(NetworkError);
  });
  it('sends JSON with same-origin credentials to the configured base', async () => {
    let seen: any; const f = (async (url: string, init: any) => { seen = { url, init }; return new Response('{}', { status: 200 }); }) as any;
    await client(f).register('al', 'pw-pw-pw-pw', 'CODE1234');
    expect(seen.url).toBe('https://hub.example.com/api/auth/register'); expect(seen.init.credentials).toBe('same-origin');
    expect(JSON.parse(seen.init.body)).toEqual({ username: 'al', password: 'pw-pw-pw-pw', invite: 'CODE1234', client: 'web' });
  });
  it('lists agents', async () => { expect(await client(reply(200, { agents: [{ id: 'a', name: 'A', kind: 'openai', online: true, chatReady: true }] }) as any).agents()).toHaveLength(1); });
});

describe('auth mode and strings', () => {
  it('matches the Android rules', () => {
    expect(authModeFor({ setupRequired: true, registration: 'open' }, true)).toBe('setup');
    expect(authModeFor({ setupRequired: false, registration: 'closed' }, true)).toBe('signin');
    expect(authModeFor({ setupRequired: false, registration: 'invite' }, true)).toBe('join');
    expect(authModeFor({ setupRequired: false, registration: 'invite' }, false)).toBe('signin');
  });
  it('fills placeholders', () => { expect(t('auth.locked', { seconds: 30 })).toContain('30 s'); });
});
