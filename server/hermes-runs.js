// Hermes native run adapter. When a profile advertises run controls on GET /v1/capabilities
// (run_submission, run_status, run_events_sse, run_steer, run_stop) chat uses POST /v1/runs + GET /v1/runs/{id}/events,
// and Steer/Stop reach the agent's own run. Older Hermes keeps the /v1/chat/completions path (queue + transport abort only).
// Upstream event names below follow the Hermes docs (message.delta, message.interim, tool events, terminal run events); they are
// matched loosely and normalised to the stream the clients already parse. NEEDS a live Hermes check (see docs/HERMES-CHAT-CONTROLS.md).
import { fault } from './config.js';

export const FEATURES = ['run_submission', 'run_status', 'run_events_sse', 'run_steer', 'run_stop'];
const enc = new TextEncoder();
const frame = (obj, event) => enc.encode(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(obj)}\n\n`);
const asText = (v) => (typeof v === 'string' ? v : Array.isArray(v) ? v.map(asText).join('\n') : v && typeof v === 'object' ? asText(v.text ?? v.content ?? '') : '');

/** Which native controls a profile has, from the typed feature map the probe keeps (never arbitrary upstream extras). */
export function nativeFeatures(capabilities) {
  const f = capabilities?.features ?? {};
  const has = Object.fromEntries(FEATURES.map((k) => [k, f[k] === true]));
  const runs = has.run_submission && has.run_events_sse;
  return { runs, steer: runs && has.run_steer, stop: runs && has.run_stop, status: has.run_status };
}
/** The busy-input modes a client may offer for this agent: only what the adapter can really do. */
export function busyModes({ kind, native }) {
  if (kind === 'mcp-inbox') return ['queue'];
  if (kind === 'hermes') return native?.runs ? ['queue', ...(native.steer ? ['steer'] : []), 'interrupt'] : ['queue', 'interrupt'];
  return ['queue', 'interrupt']; // OpenAI-compatible / Grok: queue, or abort the stream and resubmit
}

/** Turns one upstream event into zero or more normalised frames and records terminal state on `link`. */
export function normalise(ev, name, link) {
  const d = ev && typeof ev === 'object' ? ev : {}, type = String(name || d.event || d.type || '');
  const out = [];
  if (typeof d.run_id === 'string' && !link.runId) link.runId = d.run_id;
  if (typeof d.session_id === 'string' && !link.sessionId) link.sessionId = d.session_id;
  if (/reasoning|thinking/.test(type) && /delta/.test(type)) { const t = asText(d.delta ?? d.text); if (t) out.push(frame({ choices: [{ delta: { reasoning_content: t } }] })); }
  else if (type === 'message.delta' || (/delta/.test(type) && !/tool/.test(type))) { const t = asText(d.delta ?? d.text ?? d.content); if (t) { link.streamed = true; out.push(frame({ choices: [{ delta: { content: t } }] })); } }
  else if (type === 'message.interim') { const t = asText(d.text ?? d.message ?? d.content).replace(/\s+/g, ' ').trim().slice(0, 120); if (t) out.push(frame({ tool: t }, 'hermes.tool.progress')); }
  else if (/^tool/.test(type)) { out.push(frame({ tool: String(d.tool ?? d.name ?? 'tool').slice(0, 80) }, 'hermes.tool.progress')); }
  else if (/^run\.(completed|complete|done|finished)$/.test(type)) {
    link.terminal = 'completed'; link.pendingSteer = pendingOf(d);
    const final = asText(d.output ?? d.final ?? d.content);
    if (final && !link.streamed && d.already_streamed !== true) out.push(frame({ choices: [{ delta: { content: final } }] })); // never twice
  } else if (/^run\.(failed|error)$/.test(type)) { link.terminal = 'failed'; link.pendingSteer = pendingOf(d); link.error = asText(d.error ?? d.message).slice(0, 300) || 'The agent run failed'; }
  else if (/^run\.(stopped|cancelled|canceled|interrupted)$/.test(type)) { link.terminal = 'stopped'; link.pendingSteer = pendingOf(d); }
  return out;
}
const pendingOf = (d) => { const v = d.pending_steer ?? d.pendingSteer; return (Array.isArray(v) ? v : v ? [v] : []).map(asText).filter(Boolean).slice(0, 20); };

/** One stream of normalised frames for a native run; `open` posts the run, then follows its events with cursor replay. */
export function nativeRun({ api, m, input, sessionId, idempotencyKey, link, signal, fetchEvents }) {
  const headers = { 'Content-Type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) };
  return (async () => {
    const created = await api(m, '/v1/runs', { method: 'POST', signal, headers, body: JSON.stringify({ input, ...(sessionId ? { session_id: sessionId } : {}) }) });
    if (![200, 201, 202].includes(created.status)) { await created.body?.cancel(); throw fault([403, 404, 405, 409, 413].includes(created.status) ? created.status : 502, 'Agent request failed'); }
    let info; try { info = await created.json(); } catch { throw fault(502, 'Invalid agent response'); }
    const runId = info?.run_id ?? info?.id; if (typeof runId !== 'string' || !/^[\w.:-]{1,200}$/.test(runId)) throw fault(502, 'Invalid agent response');
    link.runId = runId; if (typeof info.session_id === 'string') link.sessionId = info.session_id; link.sessionId ??= sessionId;
    let cursor = 0, tries = 0;
    const body = new ReadableStream({
      async start(ctl) {
        const dec = new TextDecoder(); let buf = '';
        try {
          while (!link.terminal) {
            let r;
            try { r = await (fetchEvents ?? ((id, after, s) => api(m, `/v1/runs/${encodeURIComponent(id)}/events${after ? `?after=${after}` : ''}`, { signal: s, headers: after ? { 'Last-Event-ID': String(after) } : {} })))(runId, cursor, signal); }
            catch (e) { if (signal.aborted) throw e; if (++tries > 5) throw e; await new Promise((x) => setTimeout(x, 200 * tries)); continue; }
            if (!r.ok || !r.body) { await r.body?.cancel(); if (r.status === 404 || ++tries > 5) { if (!link.terminal) { link.terminal = 'failed'; link.error = 'The agent no longer has this run'; } break; } await new Promise((x) => setTimeout(x, 200 * tries)); continue; } // truncated upstream log: bounded recovery, then fail truthfully
            const reader = r.body.getReader();
            for (;;) {
              let chunk; try { chunk = await reader.read(); } catch { break; } // dropped connection: reconnect from the cursor
              if (chunk.done) break;
              buf += dec.decode(chunk.value, { stream: true });
              let m2; while ((m2 = /\r?\n\r?\n/.exec(buf))) {
                const raw = buf.slice(0, m2.index); buf = buf.slice(m2.index + m2[0].length);
                let name = '', data = '', id; for (const line of raw.split(/\r?\n/)) { if (line.startsWith('event:')) name = line.slice(6).trim(); else if (line.startsWith('data:')) data += line.slice(5).trim(); else if (line.startsWith('id:')) id = Number(line.slice(3)); }
                if (Number.isInteger(id) && id > cursor) cursor = id; else if (!Number.isInteger(id)) cursor++;
                if (!data || data === '[DONE]') continue; let ev; try { ev = JSON.parse(data); } catch { continue; }
                for (const f of normalise(ev, name, link)) ctl.enqueue(f);
                if (link.terminal) break;
              }
              if (link.terminal) { await reader.cancel().catch(() => {}); break; }
            }
          }
          if (link.pendingSteer?.length) ctl.enqueue(frame({ pending_steer: link.pendingSteer }, 'foxfleet.pending_steer'));
          ctl.enqueue(frame({ state: link.terminal ?? 'completed', ...(link.error ? { error: link.error } : {}) }, 'foxfleet.upstream'));
          ctl.enqueue(enc.encode('data: [DONE]\n\n')); ctl.close();
        } catch (e) { ctl.error(e); }
      },
      cancel() {},
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream', ...(link.sessionId ? { 'X-Hermes-Session-Id': link.sessionId } : {}) } });
  })();
}
/** Control calls reach the agent immediately; they are never queued behind the run. */
export function nativeControl({ api, m, link }) {
  const post = async (suffix, body) => api(m, `/v1/runs/${encodeURIComponent(link.runId)}/${suffix}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return {
    async steer(text) { const r = await post('steer', { input: text }); await r.body?.cancel(); if (r.status === 409) throw Object.assign(fault(409, 'The run is no longer running'), { notRunning: true }); if (![200, 202].includes(r.status)) throw fault(502, 'Agent request failed'); },
    async stop() { const r = await post('stop'); await r.body?.cancel(); if (![200, 202, 409].includes(r.status)) throw fault(502, 'Agent request failed'); }, // 409: already over, the terminal event confirms
  };
}
