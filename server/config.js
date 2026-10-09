import { needsMigration, migrateMachines, backup, REGISTRY_VERSION } from './migrate.js';
import { readFile, writeFile, rename, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';

export const identifier = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value) && value !== '..';
export const fault = (status, message) => Object.assign(new Error(message), { status, safe: true });
export function validHost(value) {
  return typeof value === 'string' && value.length <= 253 && (isIP(value) !== 0 || value.split('.').every((part) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(part)));
}
function endpoint(value) {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 2048) throw fault(400, 'Invalid endpoint URL');
  let url; try { url = new URL(value); } catch { throw fault(400, 'Invalid endpoint URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw fault(400, 'Endpoint must be an HTTPS origin');
  return url.origin;
}
// Provider plugins: `kind` is the plugin id. All http-chat plugins share one OpenAI-style client.
export const CHAT_KINDS = ['openai', 'openrouter', 'zai', 'opencode', 'grok'];
export const KINDS = ['hermes', ...CHAT_KINDS, 'mcp-inbox'];
export const isChatKind = (kind) => CHAT_KINDS.includes(kind);
// Provider presets live here, on the hub; no client ever receives these URLs.
export const PRESETS = {
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
  zai: { general: 'https://api.z.ai/api/paas/v4', coding: 'https://api.z.ai/api/coding/paas/v4', model: 'glm-5.1' },
  opencode: { baseUrl: 'https://opencode.ai/zen/v1', model: '' },
  grok: { baseUrl: 'https://api.x.ai/v1', model: 'grok-4.7' },
};
// Endpoint and credential fields are write-only: only the hub ever reads them back. Clients get
// booleans (hasHost, hasApiKey, …); a blank value on edit keeps the saved one.
export const WRITE_ONLY = ['machineId', 'host', 'dashboardPort', 'apiServerPort', 'dashboardUrl', 'apiServerUrl', 'uploadDir', 'baseUrl', 'dashboardPass', 'apiServerKey', 'apiKey', 'dashboardWsToken', 'inboxTokenHash'];
const hasKey = (key) => key === 'inboxTokenHash' ? 'hasInboxToken' : 'has' + key[0].toUpperCase() + key.slice(1);
// Per-kind schema: drives validation here and the Add-agent forms in the apps (GET /api/agent-kinds).
// `secret`/`private` fields are write-only. `planned` kinds are listed so clients can show them, but can't be created yet.
const COMMON = [
  { key: 'name', label: 'ID', type: 'id', required: true, help: 'Letters, digits, . _ - (used in links; cannot change later)' },
  { key: 'label', label: 'Display name', type: 'text', max: 64 },
  { key: 'description', label: 'Description', type: 'multiline', max: 280 },
  { key: 'avatar', label: 'Avatar hint', type: 'text', max: 64, help: 'Avatar pack name or an emoji' },
];
export const KIND_SPECS = {
  hermes: { label: 'Hermes agent', summary: 'A Hermes Agent install on your network: chat, files, skills, voice and its desktop screen.',
    capabilities: { chat: true, images: true, files: true, screen: true, voice: true, skills: true, sessions: true, mailbox: false },
    fields: [...COMMON,
      { key: 'connection', label: 'Connection', type: 'enum', options: ['direct'], default: 'direct', help: 'Advanced: the hub dials the agent directly. For the normal outbound-only setup use Connect a machine instead, which adds every Hermes profile on a computer in one step.' },
      { key: 'host', label: 'Host or IP', type: 'host', required: true, private: true, advanced: true, when: { connection: 'direct' } },
      { key: 'profile', label: 'Profile', type: 'id', default: 'default' },
      { key: 'dashboardPort', label: 'Dashboard port', type: 'port', default: 9119, private: true, advanced: true, when: { connection: 'direct' } },
      { key: 'dashboardUser', label: 'Dashboard user', type: 'text', default: 'admin' },
      { key: 'dashboardPass', label: 'Dashboard password', type: 'secret', secret: true },
      { key: 'apiServerPort', label: 'Chat API port', type: 'port', default: 8642, private: true, advanced: true, when: { connection: 'direct' } },
      { key: 'apiServerKey', label: 'Chat API key', type: 'secret', secret: true },
      { key: 'dashboardUrl', label: 'Dashboard HTTPS origin', type: 'url', private: true, advanced: true },
      { key: 'apiServerUrl', label: 'Chat API HTTPS origin', type: 'url', private: true, advanced: true },
      { key: 'dashboardWsToken', label: 'Dashboard session token (no-auth dashboards only)', type: 'secret', secret: true, advanced: true },
      { key: 'uploadDir', label: 'Upload folder on the agent', type: 'text', private: true, advanced: true }] },
  openai: { label: 'OpenAI-compatible', summary: 'Any /chat/completions API: GLM, OpenRouter, OpenCode server, local models.',
    capabilities: { chat: true, images: true, files: false, screen: false, voice: false, skills: false, sessions: true, mailbox: false },
    fields: [...COMMON,
      { key: 'baseUrl', label: 'Base URL', type: 'url', required: true, private: true, help: 'The API root including its version path, ending before /chat/completions' },
      { key: 'model', label: 'Model', type: 'text', required: true },
      { key: 'apiKey', label: 'API key', type: 'secret', secret: true }] },
  openrouter: { label: 'OpenRouter', summary: 'Hundreds of models through one OpenRouter API key.', auth: ['api_key'],
    capabilities: { chat: true, images: true, files: false, screen: false, voice: false, skills: false, sessions: true, mailbox: false },
    fields: [...COMMON, { key: 'model', label: 'Model', type: 'text', required: true, default: PRESETS.openrouter.model, help: 'Model id from openrouter.ai/models' }, { key: 'apiKey', label: 'API key', type: 'secret', secret: true, required: true }] },
  zai: { label: 'Z.ai (GLM)', summary: 'GLM models from Z.ai with your API key.', auth: ['api_key'],
    warnings: ['The Coding Plan endpoint is licensed by Z.ai for officially supported coding tools only. Foxfleet is not one of them, so use the general endpoint unless you accept the risk.'],
    capabilities: { chat: true, images: false, files: false, screen: false, voice: false, skills: false, sessions: true, mailbox: false },
    fields: [...COMMON, { key: 'endpoint', label: 'Endpoint', type: 'enum', options: ['general', 'coding'], default: 'general', help: 'General is pay-as-you-go. Coding is for Z.ai Coding Plan keys (see warning).' }, { key: 'model', label: 'Model', type: 'text', required: true, default: PRESETS.zai.model }, { key: 'apiKey', label: 'API key', type: 'secret', secret: true, required: true }] },
  opencode: { label: 'OpenCode', summary: 'OpenCode Zen models with your OpenCode API key.', auth: ['api_key'],
    capabilities: { chat: true, images: true, files: false, screen: false, voice: false, skills: false, sessions: true, mailbox: false },
    fields: [...COMMON, { key: 'model', label: 'Model', type: 'text', required: true, help: 'Model id as listed by OpenCode' }, { key: 'apiKey', label: 'API key', type: 'secret', secret: true, required: true }, { key: 'baseUrl', label: 'Base URL', type: 'url', private: true, advanced: true, help: 'Only if you run your own OpenAI-compatible OpenCode endpoint' }] },
  grok: { label: 'Grok (xAI)', summary: 'Grok models with your xAI API key.', auth: ['api_key'],
    capabilities: { chat: true, images: true, files: false, screen: false, voice: false, skills: false, sessions: true, mailbox: false },
    fields: [...COMMON, { key: 'model', label: 'Model', type: 'text', required: true, default: PRESETS.grok.model }, { key: 'apiKey', label: 'xAI API key', type: 'secret', secret: true, required: true }] },
  'mcp-inbox': { label: 'MCP inbox', summary: 'A mailbox an outside agent (e.g. an outside agent) reads and answers over MCP. The token is shown once.',
    capabilities: { chat: true, images: false, files: false, screen: false, voice: false, skills: false, sessions: true, mailbox: true },
    fields: [...COMMON] },
  a2a: { label: 'A2A agent', summary: 'Google Agent2Agent JSON-RPC endpoint.', planned: true, capabilities: {}, fields: [] },
  webhook: { label: 'Webhook', summary: 'POST a task to a URL and receive the reply on a callback.', planned: true, capabilities: {}, fields: [] },
};
export function kindSpecs() {
  return Object.entries(KIND_SPECS).map(([kind, spec]) => ({ kind, label: spec.label, summary: spec.summary, planned: Boolean(spec.planned), capabilities: spec.capabilities,
    auth: spec.auth || (spec.fields.some((f) => f.secret) ? ['api_key'] : ['none']), ...(spec.warnings ? { warnings: spec.warnings } : {}),
    fields: spec.fields.map(({ key, label, type, required, default: d, secret, private: p, advanced, help, max, options, when }) => ({ key, label, type, required: Boolean(required), writeOnly: Boolean(secret || p), ...(d !== undefined ? { default: d } : {}), ...(advanced ? { advanced: true } : {}), ...(help ? { help } : {}), ...(max ? { max } : {}), ...(options ? { options } : {}), ...(when ? { when } : {}) })) }));
}
const text = (v, max) => typeof v === 'string' && v.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v);
function meta(m, result) {
  for (const [key, max] of [['label', 64], ['description', 280], ['avatar', 64]]) {
    if (m[key] === undefined || m[key] === null || m[key] === '') continue;
    if (!text(m[key], max) || (key !== 'description' && /[\n\r]/.test(m[key]))) throw fault(400, `Invalid ${key}`);
    result[key] = m[key];
  }
  return result;
}
// OpenAI-compatible base URL: http(s), may carry a path (e.g. https://api.z.ai/api/paas/v4), never credentials/query.
function baseUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw fault(400, 'Invalid base URL');
  let url; try { url = new URL(value); } catch { throw fault(400, 'Invalid base URL'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !validHost(url.hostname.replace(/^\[|\]$/g, ''))) throw fault(400, 'Invalid base URL');
  return url.origin + url.pathname.replace(/\/+$/, '');
}
function bridged(m) {
  if (!identifier(m.name)) throw fault(400, 'Invalid name');
  const result = meta(m, { name: m.name, kind: m.kind });
  if (isChatKind(m.kind)) {
    const preset = PRESETS[m.kind] || {};
    if (m.kind === 'zai') {
      const endpointName = m.endpoint ?? 'general'; if (!['general', 'coding'].includes(endpointName)) throw fault(400, 'Invalid endpoint');
      result.endpoint = endpointName; result.baseUrl = preset[endpointName];
    } else result.baseUrl = baseUrl(m.baseUrl ?? preset.baseUrl);
    const model = m.model || preset.model;
    if (typeof model !== 'string' || !model || model.length > 200 || /[\x00-\x1f]/.test(model)) throw fault(400, 'Invalid model');
    result.model = model;
    const key = m.apiKey ?? ''; if (typeof key !== 'string' || key.length > 4096 || /[\x00-\x1f\x7f]/.test(key)) throw fault(400, 'Invalid credentials');
    if (m.kind !== 'openai' && !key) throw fault(400, 'An API key is required');
    result.apiKey = key;
  } else {
    if (typeof m.inboxTokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(m.inboxTokenHash)) throw fault(400, 'Invalid inbox token');
    result.inboxTokenHash = m.inboxTokenHash;
  }
  return result;
}
export function connection(data, previous) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw fault(400, 'Invalid connection');
  // Blank write-only fields on edit keep the saved value (clients never see them to resend).
  if (previous) data = Object.fromEntries(Object.entries(data).filter(([k, v]) => !(WRITE_ONLY.includes(k) && (v === '' || v === null))));
  const m = { ...previous, ...data };
  if (m.kind !== undefined && !KINDS.includes(m.kind)) throw fault(400, KIND_SPECS[m.kind]?.planned ? 'That agent type is not available yet' : 'Invalid agent kind');
  if (previous && data.kind !== undefined && (previous.kind ?? 'hermes') !== data.kind) throw fault(400, 'Agent kind cannot change; delete and re-add');
  if (m.kind && m.kind !== 'hermes') return bridged(m);
  const mode = m.connection ?? 'direct';
  if (!['machine', 'direct'].includes(mode)) throw fault(400, 'Invalid connection mode');
  if (previous && (previous.connection ?? 'direct') !== mode) throw fault(400, 'Connection mode cannot change; delete and re-add');
  if (!identifier(m.name) || !identifier(m.profile ?? 'default') || (mode === 'direct' && !validHost(m.host))) throw fault(400, 'Invalid name, host or profile');
  const result = meta(m, { name: m.name, connection: mode, profile: m.profile ?? 'default' });
  if (mode === 'machine') {
    // Created only by a paired machine's connector; credentials stay on that machine.
    if (!/^[0-9a-f]{32}$/.test(m.machineId ?? '')) throw fault(400, 'Invalid machine');
    result.machineId = m.machineId; return result;
  }
  result.host = m.host;
  if (mode === 'direct') for (const [key, fallback] of [['dashboardPort', 9119], ['apiServerPort', 8642]]) {
    const v = m[key] ?? fallback; if (!Number.isInteger(v) || v < 1 || v > 65535) throw fault(400, 'Invalid port'); result[key] = v;
  }
  for (const [key, fallback, limit] of [['dashboardUser', 'admin', 128], ['dashboardPass', '', 4096], ['apiServerKey', '', 4096]]) {
    const v = previous && data[key] === '' && key !== 'dashboardUser' ? previous[key] : m[key] ?? fallback;
    if (typeof v !== 'string' || v.length > limit || /[\x00-\x1f\x7f]/.test(v)) throw fault(400, 'Invalid credentials'); result[key] = v;
  }
  if (mode === 'direct') for (const key of ['dashboardUrl', 'apiServerUrl']) { const v = endpoint(m[key]); if (v) result[key] = v; }
  // Only for dashboards running without auth (loopback/--insecure), whose gateway socket wants ?token=.
  if (m.dashboardWsToken !== undefined && m.dashboardWsToken !== '') { if (typeof m.dashboardWsToken !== 'string' || m.dashboardWsToken.length > 512 || /[\x00-\x20\x7f]/.test(m.dashboardWsToken)) throw fault(400, 'Invalid credentials'); result.dashboardWsToken = m.dashboardWsToken; }
  if (m.uploadDir !== undefined && m.uploadDir !== '') { if (typeof m.uploadDir !== 'string' || !/^(~|\/)[^\x00-\x1f\x7f]{0,255}$/.test(m.uploadDir) || m.uploadDir.split('/').includes('..')) throw fault(400, 'Invalid upload directory'); result.uploadDir = m.uploadDir.replace(/\/+$/, ''); }
  return result;
}
// What owner clients may see of a saved agent: no endpoints, no credentials (booleans instead).
export function publicConnection(m) {
  const kind = m.kind || 'hermes', out = { name: m.name, kind };
  for (const [key, value] of Object.entries(m)) if (!WRITE_ONLY.includes(key) && key !== 'kind') out[key] = value;
  for (const f of KIND_SPECS[kind].fields) if (f.secret || f.private) out[hasKey(f.key)] = Boolean(m[f.key]);
  if (kind === 'mcp-inbox') out.hasInboxToken = Boolean(m.inboxTokenHash);
  return out;
}
export const capabilitiesOf = (m) => ({ ...KIND_SPECS[m.kind || 'hermes'].capabilities });
export const secretsOf = (m) => [m.dashboardPass, m.apiServerKey, m.apiKey, m.dashboardWsToken];

export async function configStore(configPath) {
  let machines = [], migrate = false, fromVersion = 1;
  try {
    if ((await stat(configPath)).size > 1024 * 1024) throw new Error();
    const raw = JSON.parse(await readFile(configPath, 'utf8'));
    if (!raw || !Array.isArray(raw.machines) || raw.machines.length > 32) throw new Error();
    migrate = needsMigration(raw); fromVersion = raw.version ?? 1;
    machines = (migrate ? migrateMachines(raw.machines) : raw.machines).map((m) => connection(m));
    if (new Set(machines.map((m) => m.name)).size !== machines.length) throw new Error();
  } catch (error) { if (error.code !== 'ENOENT') throw fault(500, 'Invalid hub configuration'); }
  let entries = new Map(machines.map((m) => [m.name, m])), pending = Promise.resolve();
  async function mutate(action) {
    const work = pending.then(async () => {
      const next = new Map(entries); const value = action(next);
      await mkdir(path.dirname(configPath), { recursive: true });
      const temp = configPath + '.' + randomUUID() + '.tmp';
      try {
        await writeFile(temp, JSON.stringify({ version: REGISTRY_VERSION, machines: [...next.values()] }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        await rename(temp, configPath); entries = next; return value;
      } catch { await rm(temp, { force: true }).catch(() => {}); throw fault(500, 'Could not save hub configuration'); }
    }); pending = work.catch(() => {}); return work;
  }
  if (migrate) { await backup(configPath, fromVersion); await mutate(() => {}); console.log(`Foxfleet: migrated agent registry to v${REGISTRY_VERSION} (backup: ${path.basename(configPath)}.v${fromVersion}.bak)`); }
  return {
    all: () => [...entries.values()],
    // Reorder: `names` must list every agent exactly once.
    reorder(names) { return mutate((next) => { if (!Array.isArray(names) || names.length !== next.size || new Set(names).size !== names.length || !names.every((n) => next.has(n))) throw fault(400, 'Order must list every agent once'); const old = new Map(next); next.clear(); for (const n of names) next.set(n, old.get(n)); }); },
    // Each successful edit creates a new object, even when its fields are unchanged.
    isCurrent: (m) => entries.get(m.name) === m,
    get(name) { const m = entries.get(name); if (!m) throw fault(404, 'Unknown agent'); return m; },
    add(data) { return mutate((next) => { const m = connection(data); if (next.has(m.name)) throw fault(409, 'Connection already exists'); if (next.size >= 32) throw fault(400, 'Connection limit reached'); next.set(m.name, m); return m; }); },
    edit(name, data) { return mutate((next) => { const prior = next.get(name); if (!prior) throw fault(404, 'Unknown agent'); const m = connection(data, prior); if (m.name !== name && next.has(m.name)) throw fault(409, 'Connection already exists'); const old = [...next]; next.clear(); for (const [k, v] of old) k === name ? next.set(m.name, m) : next.set(k, v); return m; }); }, // keeps the agent's place in the order
    remove(name) { return mutate((next) => { if (!next.delete(name)) throw fault(404, 'Unknown agent'); }); },
  };
}

const secretKey = /(?:password|passwd|secret|token|cookie|authorization|credential|api[_-]?key|api[_-]?server[_-]?key|private[_-]?key|client[_-]?secret|dashboard[_-]?pass)/i;
const metricKey = /^(?:(?:input|output|prompt|completion|total|cache_read|cache_write|reasoning|max|max_output|avg|avg_tokens_per_session|cached)_?tokens?|tokens?_(?:per_second|per_minute|used|count|limit)|avg_tokens_per_session)$/i;
export function redact(value, secrets = []) {
  if (Array.isArray(value)) return value.map((v) => redact(v, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, secretKey.test(k) && !(metricKey.test(k) && typeof v === 'number') ? '[redacted]' : redact(v, secrets)]));
  if (typeof value !== 'string') return value;
  let text = value;
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[redacted]');
  return text.replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [redacted]')
    .replace(/((?:password|passwd|secret|token|api[_-]?key|api[_-]?server[_-]?key|authorization|cookie|credentials?)\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1[redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,})\b/g, '[redacted]');
}
