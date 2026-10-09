import { describe, expect, it } from 'vitest';
import { createClient } from '../src/api/client';
import { ApiError, AuthRequiredError } from '../src/api/errors';
import { moved, parseKinds, parseSaved, payload, scrubAddresses, validate } from '../src/lib/registry';
import { SseParser } from '../src/lib/sse';

const kinds = parseKinds({ kinds: [{ kind: 'hermes', label: 'Hermes', summary: 's', fields: [
  { key: 'name', label: 'ID', type: 'text', required: true }, { key: 'connection', label: 'Connection', type: 'enum', options: ['connector', 'direct'], default: 'connector' },
  { key: 'host', label: 'Host', type: 'text', required: true, writeOnly: true, when: { connection: 'direct' } }, { key: 'port', label: 'Port', type: 'port', when: { connection: 'direct' } },
  { key: 'apiKey', label: 'Key', type: 'secret', writeOnly: true, required: true }, { key: 'description', label: 'Description', type: 'text' }] }] });
const k = kinds[0];

describe('schema-driven agent forms', () => {
  it('hides conditional fields and omits them from the payload', () => {
    expect(payload(k, { name: 'atlas', apiKey: 'k' }, false)).toEqual({ kind: 'hermes', name: 'atlas', connection: 'connector', apiKey: 'k' });
    expect(payload(k, { name: 'a', connection: 'direct', host: 'h', port: '8642', apiKey: 'k' }, false)).toMatchObject({ host: 'h', port: 8642 });
  });
  it('edit keeps blank write-only fields (omitted) and clears blank plain ones', () => {
    const p = payload(k, { name: 'atlas', connection: 'connector', apiKey: '', description: '' }, true);
    expect(p).not.toHaveProperty('apiKey'); expect(p).not.toHaveProperty('name'); expect(p.description).toBe('');
  });
  it('validates required, ids and ports; a saved secret satisfies required on edit', () => {
    expect(validate(k, { name: 'bad name', apiKey: 'k' }, false)).toMatch(/ID/);
    expect(validate(k, { name: 'ok' }, false)).toBe('Key is required');
    const saved = parseSaved({ name: 'ok', kind: 'hermes', hasApiKey: true, description: 'd' });
    expect(validate(k, { name: 'ok' }, true, saved)).toBeUndefined(); expect(validate(k, { name: 'ok' }, true, { ...saved, saved: [] })).toBe('Key is required');
    expect(validate(k, { name: 'ok', apiKey: 'k', connection: 'direct', host: 'h', port: '70000' }, false)).toMatch(/1–65535/);
  });
  it('parses saved agents without ever seeing secrets, and scrubs addresses from messages', () => {
    expect(parseSaved({ name: 'a', kind: 'hermes', hasHost: true, hasApiKey: false, description: 'd' })).toEqual({ name: 'a', kind: 'hermes', values: { description: 'd' }, saved: ['host'] });
    expect(scrubAddresses('connect to http://10.1.2.3:8642/x failed; host box.example.com:9 down; 192.0.2.7')).not.toMatch(/10\.1|box\.example|192\.0|http/);
  });
  it('reorders', () => { expect(moved(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']); expect(moved(['a', 'b'], 0, -1)).toEqual(['a', 'b']); });
});

describe('sse parser', () => {
  it('handles split chunks, CRLF, comments and multi-line data', () => {
    const got: any[] = []; const p = new SseParser((e) => { got.push(e); });
    p.push('event: x\r\ndata: a\r\ndata: b\r\n\r\n: ping\n'); p.push('data: {"c":1}\n'); p.push('\ndata: [DONE]\n\n'); p.end();
    expect(got).toEqual([{ event: 'x', data: 'a\nb' }, { event: 'message', data: '{"c":1}' }, { event: 'message', data: '[DONE]' }]);
  });
  it('stops when the consumer says so', () => { const p = new SseParser(() => false); expect(p.push('data: 1\n\ndata: 2\n\n')).toBe(false); });
});

const sse = (body: string, status = 200, headers: Record<string, string> = { 'content-type': 'text/event-stream', 'x-hermes-session-id': 'sess_1' }) =>
  (async () => new Response(new ReadableStream({ start(c) { for (const part of body.match(/[^]{1,17}/g) ?? []) c.enqueue(new TextEncoder().encode(part)); c.close(); } }), { status, headers })) as any;
const c = (f: any) => createClient({ base: 'https://hub.example.com', fetch: f });
const cb = () => { const r = { text: '', reason: '', tools: [] as string[], sid: '' }; return { r, o: { onContent: (t: string) => (r.text += t), onReasoning: (t: string) => (r.reason += t), onTool: (t: string) => r.tools.push(t), onSession: (s: string) => (r.sid = s) } }; };

describe('api client: registry and chat', () => {
  it('streams content, reasoning, tool progress and the session id across chunk boundaries', async () => {
    const body = 'data: {"choices":[{"delta":{"reasoning_content":"hm"}}]}\n\nevent: hermes.tool.progress\ndata: {"tool":"search"}\n\ndata: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n';
    const { r, o } = cb(); const sid = await c(sse(body)).chat('atlas', [{ role: 'user', content: 'hi' }], o);
    expect(r).toEqual({ text: 'Hello', reason: 'hm', tools: ['search'], sid: 'sess_1' }); expect(sid).toBe('sess_1');
  });
  it('maps stream errors, 401 and HTTP failures to typed errors', async () => {
    const { o } = cb();
    await expect(c(sse('data: {"error":{"message":"boom 10.0.0.1"}}\n\n')).chat('a', [], o)).rejects.toThrow('The agent reply failed. Check the agent and try again.');
    await expect(c(async () => new Response('{}', { status: 401 })).chat('a', [], o)).rejects.toBeInstanceOf(AuthRequiredError);
    await expect(c(async () => new Response(JSON.stringify({ error: 'Too big' }), { status: 413, headers: { 'content-type': 'application/json' } })).chat('a', [], o)).rejects.toMatchObject({ status: 413, message: 'Too big' });
    await expect(c(sse('x', 200, { 'content-type': 'text/html' })).chat('a', [], o)).rejects.toBeInstanceOf(ApiError);
  });
  it('talks to the registry routes with the right verbs and bodies', async () => {
    const seen: [string, string, any][] = [];
    const f = (async (url: string, init: any = {}) => { seen.push([init.method ?? 'GET', url.replace('https://hub.example.com', ''), init.body ? JSON.parse(init.body) : undefined]); return new Response(JSON.stringify({ kinds: [], connections: [], connection: { name: 'a', kind: 'hermes' }, checks: { api: { ok: false, message: 'refused at 10.0.0.9:80' } } }), { status: 200, headers: { 'content-type': 'application/json' } }); }) as any;
    const cl = c(f);
    await cl.agentKinds(); await cl.savedAgents(); await cl.addAgent({ kind: 'hermes', name: 'a' }); await cl.editAgent('a b', { description: 'x' }); await cl.deleteAgent('a'); await cl.reorderAgents(['b', 'a']);
    const t = await cl.testAgent({ name: 'a' }); await cl.newToken('a');
    expect(seen.map(([m, u]) => `${m} ${u}`)).toEqual(['GET /api/agent-kinds', 'GET /api/connections', 'POST /api/connections', 'PUT /api/connections/a%20b', 'DELETE /api/connections/a', 'POST /api/connections/order', 'POST /api/connections/test', 'POST /api/connections/a/token']);
    expect(seen[5][2]).toEqual({ names: ['b', 'a'] }); expect(t.checks[0][1].message).not.toMatch(/10\.0/);
  });
  it('lists sessions and skills, tolerating shape variants and failures', async () => {
    const ok = (o: unknown) => (async () => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } })) as any;
    expect(await c(ok({ sessions: [{ id: 's1', title: 'T' }, { nope: 1 }] })).sessions('a')).toEqual([{ id: 's1', title: 'T' }]);
    expect(await c(ok({ data: [{ name: 'x' }, 'y', 'x'] })).skills('a')).toEqual(['x', 'y']);
    expect(await c(async () => new Response('{}', { status: 500 }) as any).skills('a')).toEqual([]);
  });
});
