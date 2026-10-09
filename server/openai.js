// OpenAI-compatible agents (OpenCode server, GLM, OpenRouter, any /v1/chat/completions).
import { fault } from './config.js';
import { upstreamJson } from './hermes.js';

export function openaiClient(timeoutMs = 5000) {
  const headers = (m, extra = {}) => ({ ...extra, ...(m.apiKey ? { Authorization: `Bearer ${m.apiKey}` } : {}) });
  async function call(m, route, opts = {}) {
    try { return await fetch(m.baseUrl + route, { ...opts, redirect: 'manual', headers: headers(m, opts.headers), signal: opts.signal ?? AbortSignal.timeout(timeoutMs) }); }
    catch { throw fault(502, 'Agent unavailable or timed out'); }
  }
  return {
    chat(m, messages, signal) {
      return call(m, '/chat/completions', { method: 'POST', signal, headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify({ model: m.model, messages, stream: true }) });
    },
    async probe(m) {
      let api;
      try {
        const data = await upstreamJson(await call(m, '/models'));
        const ok = Array.isArray(data?.data);
        api = { ok, message: ok ? 'Models listed' : 'Unexpected models response' };
      } catch { api = { ok: false, message: 'Chat API unavailable or authentication failed' }; }
      return { name: m.name, kind: m.kind || 'openai', label: m.label, model: m.model, online: api.ok, chatReady: api.ok, managementReady: false, checks: { api }, capabilities: { object: 'foxfleet.bridge', features: { chat_completions: true, images: true, files: false, screen: false, sessions: false } } };
    },
  };
}
