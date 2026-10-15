import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient, type Client } from '../src/api/client';
import { Manage } from '../src/agents/Manage';
import { Shell } from '../src/screens/Shell';
import { navigate } from '../src/router';
import type { SavedAgent } from '../src/lib/registry';

const token = 'ffb_' + 'X'.repeat(43); // Synthetic fixture, never a live bot credential.
const bot: SavedAgent = { name: 'native', kind: 'hermes', values: { connection: 'bot' }, saved: [] };
const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
const click = async (el: HTMLElement, label: string) => {
  const b = [...el.querySelectorAll('button')].find((x) => x.textContent === label);
  expect(b, `button ${label}`).toBeTruthy();
  await act(async () => { b!.click(); }); await flush();
};
const mount = async (overrides: Record<string, unknown> = {}) => {
  const client = { authInfo: vi.fn(async () => ({ hub: { features: ['botApi'] } })), savedAgents: vi.fn(async () => [bot]), agentKinds: vi.fn(async () => []), machines: vi.fn(async () => []), mintBotToken: vi.fn(async () => ({ token, botId: 'a'.repeat(24), created: 1 })), revokeBotToken: vi.fn(async () => ({})), addAgent: vi.fn(async () => ({ agent: bot })), ...overrides } as unknown as Client;
  const el = document.createElement('div'); document.body.append(el);
  await act(async () => { render(<Manage client={client} onChanged={vi.fn()} onAuthLost={vi.fn()} />, el); }); await flush();
  return { el, client };
};
const mountShell = async (overrides: Record<string, unknown> = {}) => {
  const { el, client } = await mount({ agents: vi.fn(async () => []), devices: vi.fn(async () => []), ...overrides });
  await act(async () => {
    render(null, el);
    history.replaceState(null, '', '#/manage');
    render(<Shell client={client} info={{ required: true, authenticated: true, setupRequired: false, setupCodeRequired: false, registration: 'closed', user: { id: 'owner', username: 'Owner', role: 'owner' } }} onSignedOut={vi.fn()} />, el);
  }); await flush();
  return { el, client };
};
const go = async (page: 'account' | 'manage') => { await act(async () => navigate(page, undefined, true)); await flush(); };
afterEach(() => { for (const el of [...document.body.children]) { act(() => render(null, el)); el.remove(); } vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear(); });

describe('native bot onboarding', () => {
  it('offers native Hermes registration only when the hub advertises the bot API', async () => {
    const { el } = await mount(); expect(el.textContent).toContain('Add native Hermes bot');
    const old = await mount({ authInfo: vi.fn(async () => ({ hub: { features: [] } })) });
    expect(old.el.textContent).not.toContain('Add native Hermes bot');
  });
  it('registers a bot without any host, dashboard credential or connector', async () => {
    const { el, client } = await mount(); await click(el, 'Add native Hermes bot');
    const name = el.querySelector<HTMLInputElement>('input[name="name"]')!; expect(name).toBeTruthy();
    await act(async () => { name.value = 'native'; name.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { el.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); await flush();
    expect(client.addAgent).toHaveBeenCalledWith({ kind: 'hermes', connection: 'bot', name: 'native', label: '', description: '' });
    expect(el.textContent).toContain('Create bot token'); expect(client.mintBotToken).not.toHaveBeenCalled();
  });
  it('reconciles a lost registration response without another registration or token write', async () => {
    const addAgent = vi.fn(async () => { throw new Error('response lost ' + token); });
    const savedAgents = vi.fn(async () => [bot]);
    const { el, client } = await mount({ addAgent, savedAgents }); await click(el, 'Add native Hermes bot');
    const name = el.querySelector<HTMLInputElement>('input[name="name"]')!;
    await act(async () => { name.value = 'native'; name.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { el.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); await flush();
    expect([...el.querySelectorAll('button')].find((b) => b.textContent === 'Create bot')?.disabled).toBe(true);
    expect([...el.querySelectorAll('button')].find((b) => b.textContent === 'Back')?.disabled).toBe(true);
    expect(el.textContent).toContain('may have succeeded'); expect(el.textContent).not.toContain(token);
    await click(el, 'Back'); expect(el.textContent).toContain('Refresh registration status');
    await act(async () => { name.value = 'different'; name.dispatchEvent(new Event('input', { bubbles: true })); el.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); await flush();
    expect(addAgent).toHaveBeenCalledTimes(1);
    let resolve!: (agents: SavedAgent[]) => void;
    savedAgents.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    await click(el, 'Refresh registration status');
    expect([...el.querySelectorAll('button')].find((b) => b.textContent === 'Create bot')?.disabled).toBe(true);
    await act(async () => resolve([bot])); await flush();
    expect(el.textContent).toContain('native: bot token');
    expect(addAgent).toHaveBeenCalledTimes(1); expect(client.mintBotToken).not.toHaveBeenCalled(); expect(client.revokeBotToken).not.toHaveBeenCalled();
    expect(JSON.stringify(localStorage)).not.toContain('native'); expect(JSON.stringify(sessionStorage)).not.toContain(token);
  });
  it('retains an unknown registration across leaving and remounting management', async () => {
    const addAgent = vi.fn(async () => { throw new Error('lost response'); });
    const savedAgents = vi.fn(async () => [bot]);
    const { el, client } = await mount({ addAgent, savedAgents }); await click(el, 'Add native Hermes bot');
    const name = el.querySelector<HTMLInputElement>('input[name="name"]')!;
    await act(async () => { name.value = 'native'; name.dispatchEvent(new Event('input', { bubbles: true })); });
    await click(el, 'Create bot');
    await act(async () => { render(null, el); });
    await act(async () => { render(<Manage client={client} onChanged={vi.fn()} onAuthLost={vi.fn()} />, el); }); await flush();
    await click(el, 'Add native Hermes bot');
    const reopenedName = el.querySelector<HTMLInputElement>('input[name="name"]')!;
    await act(async () => { reopenedName.value = 'different'; reopenedName.dispatchEvent(new Event('input', { bubbles: true })); });
    expect([...el.querySelectorAll('button')].find((b) => b.textContent === 'Create bot')?.disabled).toBe(true);
    await click(el, 'Create bot'); expect(addAgent).toHaveBeenCalledTimes(1);
    await click(el, 'Refresh registration status');
    expect(el.textContent).toContain('native: bot token'); expect(addAgent).toHaveBeenCalledTimes(1); expect(client.mintBotToken).not.toHaveBeenCalled();
  });
  it('cannot reconcile absence while an unmounted registration write is still in flight', async () => {
    let reject!: (error: Error) => void;
    const addAgent = vi.fn(() => new Promise((_, r) => { reject = r; }));
    const savedAgents = vi.fn(async (): Promise<SavedAgent[]> => []);
    const { el, client } = await mount({ addAgent, savedAgents }); await click(el, 'Add native Hermes bot');
    const name = el.querySelector<HTMLInputElement>('input[name="name"]')!;
    await act(async () => { name.value = 'native'; name.dispatchEvent(new Event('input', { bubbles: true })); });
    await click(el, 'Create bot');
    expect([...el.querySelectorAll('button')].find((b) => b.textContent === 'Back')?.disabled).toBe(true);
    await act(async () => { render(null, el); });
    await act(async () => { render(<Manage client={client} onChanged={vi.fn()} onAuthLost={vi.fn()} />, el); }); await flush();
    await click(el, 'Add native Hermes bot');
    const reads = savedAgents.mock.calls.length;
    await click(el, 'Refresh registration status');
    expect(savedAgents).toHaveBeenCalledTimes(reads);
    expect([...el.querySelectorAll('button')].find((b) => b.textContent === 'Create bot')?.disabled).toBe(true);
    await act(async () => reject(new Error('response lost'))); await flush();
    savedAgents.mockResolvedValue([bot]);
    await click(el, 'Refresh registration status');
    expect(el.textContent).toContain('native: bot token'); expect(addAgent).toHaveBeenCalledTimes(1); expect(client.mintBotToken).not.toHaveBeenCalled();
  });
  it('a reopened panel can confirm a registration that succeeded after navigation', async () => {
    let resolve!: (value: { agent: SavedAgent }) => void;
    const addAgent = vi.fn(() => new Promise<{ agent: SavedAgent }>((r) => { resolve = r; }));
    const savedAgents = vi.fn(async (): Promise<SavedAgent[]> => []);
    const { el, client } = await mountShell({ addAgent, savedAgents }); await click(el, 'Add native Hermes bot');
    const input = el.querySelector<HTMLInputElement>('input[name="name"]')!;
    await act(async () => { input.value = 'native'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    await click(el, 'Create bot');
    await go('account'); await go('manage'); await click(el, 'Add native Hermes bot');
    expect(el.textContent).toContain('Refresh registration status');
    savedAgents.mockResolvedValue([bot]);
    await act(async () => resolve({ agent: bot })); await flush();
    const reads = savedAgents.mock.calls.length;
    await click(el, 'Refresh registration status');
    expect(savedAgents.mock.calls.length).toBeGreaterThan(reads); // the hub is actually read, not short-circuited
    expect(el.textContent).toContain('native: bot token');
    expect(addAgent).toHaveBeenCalledTimes(1); expect(client.mintBotToken).not.toHaveBeenCalled();
    await go('account'); await go('manage'); await click(el, 'Add native Hermes bot');
    expect(el.textContent).not.toContain('Refresh registration status'); // settled: nothing left pending
  });
  it.each(['absence', 'matching registration'] as const)('ignores stale registration %s readback after a newer attempt starts', async (status) => {
    let rejectB!: (error: Error) => void;
    const addAgent = vi.fn(async () => ({ agent: bot }))
      .mockRejectedValueOnce(new Error('A response lost'))
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectB = reject; }));
    const savedAgents = vi.fn(async (): Promise<SavedAgent[]> => []);
    const { el, client } = await mountShell({ addAgent, savedAgents }); await click(el, 'Add native Hermes bot');
    const fillName = async () => {
      const input = el.querySelector<HTMLInputElement>('input[name="name"]')!;
      await act(async () => { input.value = 'native'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    };
    await fillName(); await click(el, 'Create bot');
    let resolveR1!: (agents: SavedAgent[]) => void;
    savedAgents.mockImplementationOnce(() => new Promise((resolve) => { resolveR1 = resolve; }));
    await click(el, 'Refresh registration status');
    await go('account'); expect(el.querySelector('main h1')?.textContent).toBe('Devices & security');
    await go('manage'); await click(el, 'Add native Hermes bot');
    await click(el, 'Refresh registration status'); // R2 confirms A absent; only now may B start.
    await click(el, 'Create bot'); expect(addAgent).toHaveBeenCalledTimes(2);
    await act(async () => resolveR1(status === 'absence' ? [] : [bot])); await flush();
    await go('account'); await go('manage'); await click(el, 'Add native Hermes bot'); await fillName();
    expect([...el.querySelectorAll('button')].find((b) => b.textContent === 'Create bot')?.disabled).toBe(true);
    await click(el, 'Create bot'); expect(addAgent).toHaveBeenCalledTimes(2);
    const reads = savedAgents.mock.calls.length;
    await click(el, 'Refresh registration status'); expect(savedAgents).toHaveBeenCalledTimes(reads);
    await act(async () => rejectB(new Error('B response lost'))); await flush();
    await click(el, 'Refresh registration status');
    expect([...el.querySelectorAll('button')].find((b) => b.textContent === 'Create bot')?.disabled).toBe(false);
    expect(addAgent).toHaveBeenCalledTimes(2); expect(client.mintBotToken).not.toHaveBeenCalled();
  });
  it('allows an explicit registration retry only after readback confirms absence', async () => {
    const addAgent = vi.fn(async () => ({ agent: bot })).mockRejectedValueOnce(new Error('lost response'));
    const savedAgents = vi.fn(async (): Promise<SavedAgent[]> => []);
    const { el, client } = await mount({ addAgent, savedAgents }); await click(el, 'Add native Hermes bot');
    const name = el.querySelector<HTMLInputElement>('input[name="name"]')!;
    await act(async () => { name.value = 'native'; name.dispatchEvent(new Event('input', { bubbles: true })); });
    await click(el, 'Create bot');
    expect([...el.querySelectorAll('button')].find((b) => b.textContent === 'Create bot')?.disabled).toBe(true);
    await click(el, 'Refresh registration status');
    expect([...el.querySelectorAll('button')].find((b) => b.textContent === 'Create bot')?.disabled).toBe(false);
    expect(addAgent).toHaveBeenCalledTimes(1);
    savedAgents.mockResolvedValue([bot]);
    await click(el, 'Create bot'); expect(addAgent).toHaveBeenCalledTimes(2);
    expect(client.mintBotToken).not.toHaveBeenCalled(); expect(el.textContent).toContain('native: bot token');
  });
  it.each(['unreachable', 'wrong name', 'wrong transport', 'wrong kind', 'wrong metadata'] as const)('keeps unknown registration blocked on %s readback', async (status) => {
    const addAgent = vi.fn(async () => { throw new Error('lost response ' + token); });
    const savedAgents = vi.fn(async (): Promise<SavedAgent[]> => [bot]);
    const { el, client } = await mount({ addAgent, savedAgents }); await click(el, 'Add native Hermes bot');
    const name = el.querySelector<HTMLInputElement>('input[name="name"]')!;
    await act(async () => { name.value = 'native'; name.dispatchEvent(new Event('input', { bubbles: true })); });
    await click(el, 'Create bot');
    expect([...el.querySelectorAll('button')].find((b) => b.textContent === 'Create bot')?.disabled).toBe(true);
    if (status === 'unreachable') savedAgents.mockRejectedValueOnce(new Error('offline ' + token));
    else if (status === 'wrong name') savedAgents.mockResolvedValueOnce([{ ...bot, name: 'other' }, { ...bot, kind: 'other' }]);
    else savedAgents.mockResolvedValueOnce([{ ...bot, ...(status === 'wrong kind' ? { kind: 'other' } : { values: { connection: status === 'wrong transport' ? 'direct' : 'bot', label: status === 'wrong metadata' ? 'Someone else' : '' } }) }]);
    await click(el, 'Refresh registration status');
    expect([...el.querySelectorAll('button')].find((b) => b.textContent === 'Create bot')?.disabled).toBe(true);
    expect(el.textContent).toContain(status === 'unreachable' ? 'Could not refresh registration status' : 'different connection');
    await click(el, 'Create bot'); expect(addAgent).toHaveBeenCalledTimes(1); expect(client.mintBotToken).not.toHaveBeenCalled();
    expect(el.textContent).not.toContain(token);
    await click(el, 'Refresh registration status');
    expect(el.textContent).toContain('native: bot token'); expect(addAgent).toHaveBeenCalledTimes(1);
  });
  it('shows a token only after explicit mint and forgets it on leaving', async () => {
    const { el, client } = await mount(); await click(el, 'Bot token');
    expect(el.textContent).not.toContain(token); await click(el, 'Create bot token');
    expect(client.mintBotToken).toHaveBeenCalledWith('native');
    const secret = el.querySelector<HTMLInputElement>('input[name="bot-token"]'); expect(secret?.value).toBe(token);
    expect(secret?.getAttribute('autocomplete')).toBe('off'); expect(secret?.readOnly).toBe(true);
    expect(JSON.stringify(localStorage)).not.toContain(token); expect(JSON.stringify(sessionStorage)).not.toContain(token);
    await click(el, 'Done'); expect(el.querySelector('input[name="bot-token"]')).toBeNull();
    await click(el, 'Bot token'); expect(el.querySelector('input[name="bot-token"]')).toBeNull();
  });
  it('asks before rotation and revocation, and never writes on a cancelled confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { el, client } = await mount({ savedAgents: vi.fn(async () => [{ ...bot, saved: ['botToken'] }]) });
    await click(el, 'Bot token'); await click(el, 'Rotate bot token'); await click(el, 'Revoke bot token');
    expect(confirm).toHaveBeenCalledTimes(2); expect(client.mintBotToken).not.toHaveBeenCalled(); expect(client.revokeBotToken).not.toHaveBeenCalled();
  });
  it('edits native metadata without direct-host requirements or changing transport', async () => {
    const editAgent = vi.fn(async () => ({ agent: bot }));
    const { el } = await mount({ editAgent }); await click(el, 'Edit');
    const label = el.querySelector<HTMLInputElement>('input[name="label"]'); expect(label).toBeTruthy();
    expect(el.querySelector('input[name="host"]')).toBeNull();
    await act(async () => { label!.value = 'My Hermes'; label!.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { el.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); await flush();
    expect(editAgent).toHaveBeenCalledWith('native', { label: 'My Hermes', description: '' });
  });
  it('admits only one mint while a request is pending', async () => {
    let resolve!: (x: { token: string; botId: string; created: number }) => void;
    const mintBotToken = vi.fn(() => new Promise((r) => { resolve = r; }));
    const { el } = await mount({ mintBotToken }); await click(el, 'Bot token');
    const button = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Create bot token')!;
    await act(async () => { button.click(); button.click(); });
    expect(mintBotToken).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ token, botId: 'a'.repeat(24), created: 1 })); await flush();
    expect(el.querySelector<HTMLInputElement>('input[name="bot-token"]')?.value).toBe(token);
  });
  it.each(['mint', 'revoke'] as const)('blocks cross-panel writes until an outstanding %s settles and fresh status succeeds', async (operation) => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    let registered: SavedAgent = { ...bot, saved: ['botToken'] };
    let settle!: () => void;
    const mutation = vi.fn(() => new Promise<{ token: string; botId: string; created: number }>((resolve) => {
      settle = () => { registered = { ...bot, saved: operation === 'mint' ? ['botToken'] : [] }; resolve({ token, botId: 'a'.repeat(24), created: 1 }); };
    }));
    const savedAgents = vi.fn(async () => [registered]);
    const { el, client } = await mountShell({ savedAgents, [operation === 'mint' ? 'mintBotToken' : 'revokeBotToken']: mutation });
    await click(el, 'Bot token'); await click(el, operation === 'mint' ? 'Rotate bot token' : 'Revoke bot token');
    await go('account'); expect(el.querySelector('main h1')?.textContent).toBe('Devices & security');
    await go('manage'); await click(el, 'Bot token');
    expect([...el.querySelectorAll('button')].find((b) => b.textContent === 'Rotate bot token')?.disabled).toBe(true);
    const reads = savedAgents.mock.calls.length;
    await click(el, 'Refresh token status');
    expect(savedAgents).toHaveBeenCalledTimes(reads);
    await click(el, 'Rotate bot token'); await click(el, 'Revoke bot token');
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(operation === 'mint' ? client.revokeBotToken : client.mintBotToken).not.toHaveBeenCalled();
    await act(async () => settle()); await flush();
    expect(el.querySelector('input[name="bot-token"]')).toBeNull();
    expect([...el.querySelectorAll('button')].find((b) => b.textContent === 'Rotate bot token')?.disabled).toBe(true);
    savedAgents.mockRejectedValueOnce(new Error('offline ' + token));
    await click(el, 'Refresh token status');
    expect([...el.querySelectorAll('button')].find((b) => b.textContent === 'Rotate bot token')?.disabled).toBe(true);
    await click(el, 'Refresh token status');
    expect([...el.querySelectorAll('button')].find((b) => b.textContent === (operation === 'mint' ? 'Rotate bot token' : 'Create bot token'))?.disabled).toBe(false);
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(el.textContent).not.toContain(token);
    expect(JSON.stringify(localStorage)).not.toContain(token); expect(JSON.stringify(sessionStorage)).not.toContain(token);
  });
  it('rejects token status from an older mutation generation even after the newer write settles', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const savedAgents = vi.fn(async () => [bot]);
    const { el, client } = await mountShell({ savedAgents }); await click(el, 'Bot token');
    const other = document.createElement('div'); document.body.append(other);
    await act(async () => render(<Manage client={client} onChanged={vi.fn()} onAuthLost={vi.fn()} />, other)); await flush();
    let resolve!: (agents: SavedAgent[]) => void;
    savedAgents.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    await click(other, 'Bot token');
    await click(el, 'Create bot token');
    savedAgents.mockResolvedValue([{ ...bot, saved: ['botToken'] }]);
    await act(async () => resolve([bot])); await flush();
    expect([...other.querySelectorAll('button')].find((b) => b.textContent === 'Create bot token')?.disabled).toBe(true);
    await click(other, 'Create bot token'); expect(client.mintBotToken).toHaveBeenCalledTimes(1);
    await click(other, 'Refresh token status');
    expect([...other.querySelectorAll('button')].find((b) => b.textContent === 'Rotate bot token')?.disabled).toBe(false);
    expect(other.querySelector('input[name="bot-token"]')).toBeNull();
    expect(JSON.stringify(localStorage)).not.toContain(token); expect(JSON.stringify(sessionStorage)).not.toContain(token);
  });
  it('blocks another token mutation after an unknown outcome until status is read back', async () => {
    const mintBotToken = vi.fn(async () => { throw new Error('unknown outcome ' + token); });
    const savedAgents = vi.fn(async () => [bot]);
    const { el } = await mount({ mintBotToken, savedAgents }); await click(el, 'Bot token'); await click(el, 'Create bot token');
    expect(el.textContent).not.toContain(token);
    const again = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Create bot token'); expect(again?.disabled).toBe(true);
    expect(el.textContent).toContain('Refresh token status');
    savedAgents.mockResolvedValue([{ ...bot, saved: ['botToken'] }]);
    await click(el, 'Refresh token status'); expect(savedAgents).toHaveBeenCalledTimes(3);
    expect(el.textContent).toContain('Rotate bot token'); expect(mintBotToken).toHaveBeenCalledTimes(1);
  });
  it.each(['mint', 'revoke'] as const)('requires fresh status after closing and reopening an unknown %s outcome', async (operation) => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    let registered = { ...bot, saved: operation === 'revoke' ? ['botToken'] : [] };
    const savedAgents = vi.fn(async () => [registered]);
    const mutation = vi.fn(async () => {
      registered = { ...bot, saved: operation === 'mint' ? ['botToken'] : [] };
      throw new Error('response lost ' + token);
    });
    const { el, client } = await mount({ savedAgents, [operation === 'mint' ? 'mintBotToken' : 'revokeBotToken']: mutation });
    await click(el, 'Bot token');
    confirm.mockReturnValue(true);
    await click(el, operation === 'mint' ? 'Create bot token' : 'Revoke bot token');
    expect(mutation).toHaveBeenCalledTimes(1);
    await click(el, 'Done');
    let resolve!: (agents: SavedAgent[]) => void;
    savedAgents.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    await click(el, 'Bot token');
    expect([...el.querySelectorAll('button')].find((b) => /^(Create|Rotate) bot token$/.test(b.textContent!))?.disabled).toBe(true);
    expect(client.mintBotToken).toHaveBeenCalledTimes(operation === 'mint' ? 1 : 0);
    await act(async () => resolve([registered])); await flush();
    expect(el.querySelector('input[name="bot-token"]')).toBeNull();
    expect(el.textContent).not.toContain(token);
    if (operation === 'mint') {
      confirm.mockReturnValue(false);
      await click(el, 'Rotate bot token');
      expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining('old token stops working immediately'));
    } else {
      expect(el.textContent).toContain('Create bot token');
      expect(el.textContent).not.toContain('Revoke bot token');
    }
    expect(mutation).toHaveBeenCalledTimes(1);
  });
  it.each(['unreachable', 'missing', 'transport replaced', 'kind replaced'] as const)('fails closed when token panel entry status is %s', async (status) => {
    const savedAgents = vi.fn(async (): Promise<SavedAgent[]> => [bot]);
    const { el, client } = await mount({ savedAgents });
    if (status === 'unreachable') savedAgents.mockRejectedValueOnce(new Error('offline ' + token));
    else savedAgents.mockResolvedValueOnce(status === 'missing' ? [] : [{ ...bot, ...(status === 'kind replaced' ? { kind: 'other' } : { values: { connection: 'direct' } }) }]);
    await click(el, 'Bot token');
    expect([...el.querySelectorAll('button')].find((b) => b.textContent === 'Create bot token')?.disabled).toBe(true);
    await click(el, 'Create bot token');
    expect(client.mintBotToken).not.toHaveBeenCalled(); expect(client.revokeBotToken).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Refresh token status'); expect(el.textContent).not.toContain(token);
    await click(el, 'Refresh token status');
    expect([...el.querySelectorAll('button')].find((b) => b.textContent === 'Create bot token')?.disabled).toBe(false);
    expect(client.mintBotToken).not.toHaveBeenCalled();
  });
  it('revoke clears the displayed token and refreshes the list', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { el, client } = await mount(); await click(el, 'Bot token'); await click(el, 'Create bot token'); await click(el, 'Revoke bot token');
    expect(client.revokeBotToken).toHaveBeenCalledWith('native'); expect(el.querySelector('input[name="bot-token"]')).toBeNull();
    expect(el.textContent).toContain('Token revoked'); expect(client.savedAgents).toHaveBeenCalledTimes(4);
  });
});

describe('bot token API client', () => {
  it('mints with POST once, revokes with DELETE once, and safely encodes the agent name', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ token, bot_id: 'a'.repeat(24), created: 42 }), { status: 201 }));
    const client = createClient({ fetch: f as never });
    expect(await client.mintBotToken('a b')).toEqual({ token, botId: 'a'.repeat(24), created: 42 });
    await client.revokeBotToken('a b');
    expect(f.mock.calls[0]).toMatchObject(['/api/agents/a%20b/bot-token', { method: 'POST' }]);
    expect(f.mock.calls[1]).toMatchObject(['/api/agents/a%20b/bot-token', { method: 'DELETE' }]);
  });
});
