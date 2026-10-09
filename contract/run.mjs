// Shared contract scenario. It drives ANY base URL (the real hub, or the web mock hub) through the API and checks every
// response against contract/openapi.json. Used by server/test/contract.test.js and web/tests/contract.test.ts.
import { readFileSync } from 'node:fs';
import { validate, operations } from './validate.mjs';
export const spec = JSON.parse(readFileSync(new URL('./openapi.json', import.meta.url), 'utf8'));

/** Returns the operationIds that were exercised. Throws on the first contract violation. */
export async function runContract(base, { fetchImpl = fetch, username = 'owner1', password = 'correct horse battery' } = {}) {
  const covered = new Set(); let token = '';
  const ops = new Map(operations(spec).map((o) => [o.operationId, o]));
  async function call(id, path, { method = 'GET', body, status = 200, auth = true, raw = false } = {}) {
    const op = ops.get(id); if (!op) throw new Error(`unknown operation ${id}`);
    const res = await fetchImpl(base + path, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(auth && token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const declared = op.responses[String(res.status)];
    if (res.status !== status) throw new Error(`${id}: expected ${status}, got ${res.status}: ${(await res.text()).slice(0, 200)}`);
    if (!declared) throw new Error(`${id}: status ${res.status} is not declared in the spec`);
    const schema = declared.content?.['application/json']?.schema ?? (declared.$ref ? spec.components.responses.Error.content['application/json'].schema : undefined);
    let data = null;
    if (raw) { await res.arrayBuffer(); } else if (schema) {
      data = await res.json(); const errs = validate(schema, data, spec);
      if (errs.length) throw new Error(`${id} ${res.status} violates the contract:\n  ${errs.join('\n  ')}`);
    } else await res.text();
    covered.add(id); return data;
  }
  await call('health', '/health', { auth: false });
  const info = await call('getAuth', '/api/auth', { auth: false });
  const creds = { username, password, client: 'app', deviceName: 'contract', acceptedTerms: info.termsVersion };
  if (typeof info.termsVersion !== 'string') throw new Error('GET /api/auth must report termsVersion');
  const session = info.setupRequired ? await call('setup', '/api/auth/setup', { method: 'POST', body: creds }) : await call('login', '/api/auth/login', { method: 'POST', body: creds });
  token = session.token; if (!token) throw new Error('login(client=app) must return a token');
  if (info.setupRequired) await call('login', '/api/auth/login', { method: 'POST', body: creds });
  const me = await call('getAuth', '/api/auth'); if (!me.authenticated || me.user?.role !== 'owner') throw new Error('expected an authenticated owner');
  await call('login', '/api/auth/login', { method: 'POST', body: { ...creds, password: 'wrong wrong wrong' }, status: 401, auth: false }).catch(async (e) => { if (!/got 429|got 403/.test(String(e))) throw e; });

  await call('listAgentKinds', '/api/agent-kinds');
  await call('createConnection', '/api/connections', { method: 'POST', status: 201, body: { kind: 'openai', name: 'contract-chat', baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'k' } });
  const list = await call('listConnections', '/api/connections');
  if (!list.connections.some((c) => c.name === 'contract-chat')) throw new Error('created connection is not listed');
  if (JSON.stringify(list).includes('api.example.com') || JSON.stringify(list).includes('"apiKey"')) throw new Error('listConnections leaked an address or secret');
  await call('updateConnection', '/api/connections/contract-chat', { method: 'PUT', body: { model: 'm2' } });
  await call('getHistorySettings', '/api/history/settings'); await call('setHistorySettings', '/api/history/settings', { method: 'PUT', body: { retentionDays: 30 } });
  await call('listSessions', '/api/agents/contract-chat/sessions?limit=10'); await call('listRuns', '/api/agents/contract-chat/runs');
  await call('createConnection', '/api/connections', { method: 'POST', status: 201, body: { kind: 'openai', name: 'contract-two', baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'k' } });
  await call('reorderConnections', '/api/connections/order', { method: 'POST', body: { names: ['contract-two', 'contract-chat'] } });
  await call('listAgents', '/api/agents');
  await call('deleteConnection', '/api/connections/contract-two', { method: 'DELETE' });

  await call('getAdminSettings', '/api/admin/settings');
  await call('putAdminSettings', '/api/admin/settings', { method: 'PUT', body: { registration: 'invite' } });
  await call('getPairing', '/api/admin/pairing');
  const inv = await call('createInvite', '/api/admin/invites', { method: 'POST', status: 201, body: {} });
  const invites = await call('listInvites', '/api/admin/invites');
  if (!invites.invites.length) throw new Error('invite not listed');
  await call('deleteInvite', `/api/admin/invites/${invites.invites[0].id}`, { method: 'DELETE' });
  const users = await call('listUsers', '/api/admin/users'); if (!users.users.some((u) => u.role === 'owner')) throw new Error('owner missing from users');
  await call('patchUser', `/api/admin/users/${users.users[0].id}`, { method: 'PATCH', body: { disabled: false }, status: 200 }).catch((e) => { if (!/got 400/.test(String(e))) throw e; });
  await call('listMachines', '/api/machines');
  const pair = await call('createMachinePairing', '/api/machines/pairing', { method: 'POST', status: 201, body: {} });
  await call('getMachinePairing', `/api/machines/pairing?code=${pair.code}`);
  const redeemed = await call('redeemPairing', '/api/machines/redeem', { method: 'POST', auth: false, body: { code: pair.code, name: 'contract machine', os: 'linux' } });
  if (!/^[0-9a-f]{32}\./.test(redeemed.token)) throw new Error('redeem must return a machine token');
  await call('redeemPairing', '/api/machines/redeem', { method: 'POST', auth: false, body: { code: pair.code }, status: 403 }); // single use
  await call('renameMachine', `/api/machines/${redeemed.machineId}`, { method: 'PATCH', body: { name: 'contract machine 2' } });
  await call('rotateMachineToken', `/api/machines/${redeemed.machineId}/token`, { method: 'POST', status: 201, body: {} });
  await call('deleteMachine', `/api/machines/${redeemed.machineId}`, { method: 'DELETE' });
  await call('listDevices', '/api/auth/devices');
  await call('mediaProxy', '/api/media-proxy?url=' + encodeURIComponent('http://insecure.example.com/a.png'), { status: 400 });
  await call('listAgents', '/api/agents', { status: 401, auth: false });
  await call('changePassword', '/api/auth/password', { method: 'POST', body: { current: 'not the password', next: 'another long passphrase' }, status: 403 });
  await call('deleteConnection', '/api/connections/contract-chat', { method: 'DELETE' });
  await call('logout', '/api/auth/logout', { method: 'POST', body: {} });
  return [...covered];
}
