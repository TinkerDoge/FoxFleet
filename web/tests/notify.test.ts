import { describe, expect, it } from 'vitest';
import { createClient } from '../src/api/client';
import { activeMutes, MUTE_CHOICES, parseNotifyPrefs } from '../src/lib/notify';

describe('notify prefs', () => {
  it('parses the hub view: master switch, agent and chat mutes, storage flag', () => {
    const p = parseNotifyPrefs({ enabled: false, storage: { ok: false, error: 'ENOSPC' }, agents: [{ agent: 'nova', until: null }], chats: [{ agent: 'nova', chat: 'h_1', until: 99 }, { agent: 'x' }, null] });
    expect(p.enabled).toBe(false); expect(p.storageOk).toBe(false);
    expect(p.mutes).toEqual([{ agent: 'nova', chat: null, until: null }, { agent: 'nova', chat: 'h_1', until: 99 }]);
  });
  it('defaults to on and healthy for an empty answer', () => { expect(parseNotifyPrefs({})).toEqual({ enabled: true, storageOk: true, mutes: [] }); });
  it('drops mutes that already ran out', () => {
    const p = parseNotifyPrefs({ agents: [{ agent: 'a', until: 50 }, { agent: 'b', until: 150 }, { agent: 'c', until: null }] });
    expect(activeMutes(p, 100).map((m) => m.agent)).toEqual(['b', 'c']);
  });
  it('offers 1 h, 8 h, 24 h and until unmuted', () => { expect(MUTE_CHOICES.map((c) => c.ms)).toEqual([3_600_000, 28_800_000, 86_400_000, null]); });
});

describe('notify client', () => {
  const calls: { url: string; init: any }[] = [];
  const client = createClient({ base: 'http://hub.test', retryBaseMs: 1, fetch: (async (url: any, init: any) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify(String(url).endsWith('/test') ? { event: { muted: true } } : { enabled: true, agents: [], chats: [] }), { status: 200, headers: { 'content-type': 'application/json' } }); }) as any });
  it('uses the same routes and bodies as the Android app', async () => {
    await client.setNotifyEnabled(false); await client.notifyMute('nova', 'h_1', true, 3600000); await client.notifyMute('nova', null, false); const r = await client.notifyTest(); await client.notifyPrefs();
    const sent = calls.map((c) => [c.init?.method ?? 'GET', new URL(c.url).pathname, c.init?.body]);
    expect(sent).toEqual([
      ['PUT', '/api/notify/prefs', JSON.stringify({ enabled: false })],
      ['PUT', '/api/notify/mute', JSON.stringify({ agent: 'nova', chat: 'h_1', muted: true, for_ms: 3600000 })],
      ['PUT', '/api/notify/mute', JSON.stringify({ agent: 'nova', muted: false })],
      ['POST', '/api/notify/test', JSON.stringify({})],
      ['GET', '/api/notify/prefs', undefined],
    ]);
    expect(r.muted).toBe(true);
  });
});
