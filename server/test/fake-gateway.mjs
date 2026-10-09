// A protocol-faithful stand-in for `python -m tui_gateway.entry` (Hermes), written from the REAL frames observed against hermes-agent
// 0670ba45 (see design/notes/hermes-ui-gateway.md). Newline-delimited JSON-RPC on stdio, `gateway.ready` first, per-session `seq`
// on events, server->client `clarify` requests, busy-submit acks, request.cancel, open_requests / inflight / queued in snapshots.
// Behaviour by prompt text: "slow ..." streams for ~3s, "clarify ..." asks a question first, "crash" kills the process.
import readline from 'node:readline';
let n = 0, srq = 0, busyMode = 'interrupt'; const sessions = new Map(), open = new Map(); let clientCaps = false;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const ok = (id, result) => out({ jsonrpc: '2.0', id, result }), err = (id, code, message) => out({ jsonrpc: '2.0', id, error: { code, message } });
const ev = (s, type, payload) => { const e = { type, session_id: s.rt, ...(payload ? { payload } : {}), seq: ++s.seq }; s.events.push(e); out({ jsonrpc: '2.0', method: 'event', params: e }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
out({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: { skin: { name: 'default' }, change_events: true, replay_epoch: 'epoch-' + process.pid } } });
const snapshot = (s) => ({ session_id: s.rt, session_key: s.stored, info: { model: 'fake-model', running: s.running, stored_session_id: s.stored }, message_count: s.messages.length, messages: s.messages.slice(), running: s.running, inflight: s.running ? { user: s.cur, assistant: s.partial, streaming: true, ...(s.corrections.length ? { corrections: s.corrections } : {}) } : undefined, queued: s.queue[0] ? { user: s.queue[0] } : undefined, open_requests: [...open.values()].filter((r) => r.params.session_id === s.rt && !r.hidden).map((r) => ({ id: r.id, method: r.method, params: r.params })) });
async function turn(s, text) {
  s.running = true; s.cur = text; s.partial = ''; s.corrections = []; s.messages.push({ role: 'user', content: text }); s.interrupted = false; ev(s, 'message.start');
  if (/crash/.test(text)) process.exit(7);
  if (/clarify/.test(text)) {
    const id = 'srq-' + (++srq).toString(16).padStart(12, '0'), params = { session_id: s.rt, questions: [{ qid: 'q0', question: 'Which environment?', choices: ['staging', 'production'], multi_select: false }] };
    ev(s, 'tool.start', { tool_id: 'call_1', name: 'clarify', args: { questions: params.questions } }); open.set(id, { id, method: 'clarify', params, s });
    if (clientCaps !== null) out({ jsonrpc: '2.0', id, method: 'clarify', params });
    await new Promise((res) => { s.wait = () => res(); open.get(id).done = res; }); const was = open.get(id); open.delete(id);
    if (s.interrupted) { ev(s, 'request.cancel', { id, method: 'clarify', reason: 'interrupted' }); return finish(s, 'interrupted'); }
    ev(s, 'tool.complete', { tool_id: 'call_1', name: 'clarify', result: { responses: [was.answer] } });
  }
  if (/sudo/.test(text)) { // a request kind the bridge does not handle: it must be refused at once (-32601), never left to time out
    const id = 'srq-' + (++srq).toString(16).padStart(12, '0'), params = { session_id: s.rt, prompt: 'sudo password' }; open.set(id, { id, method: 'sudo', params, s, hidden: true });
    out({ jsonrpc: '2.0', id, method: 'sudo', params }); await new Promise((res) => { open.get(id).done = res; }); const was = open.get(id); open.delete(id); const note = was.answer === null ? 'sudo-refused ' : 'sudo-answered '; s.partial += note; ev(s, 'message.delta', { text: note });
  }
  const words = /slow/.test(text) ? 30 : 3;
  for (let i = 0; i < words && !s.interrupted; i++) { s.partial += `w${i} `; ev(s, 'message.delta', { text: `w${i} ` }); await sleep(/slow/.test(text) ? 100 : 5); }
  finish(s, s.interrupted ? 'interrupted' : 'done');
}
function finish(s, how) {
  const text = s.partial; if (text) s.messages.push({ role: 'assistant', content: text, ...(how === 'interrupted' ? { interrupted: true } : {}) });
  ev(s, 'message.complete', { text, status: how === 'interrupted' ? 'interrupted' : 'complete' }); s.running = false;
  const next = s.queue.shift(); if (next) setTimeout(() => turn(s, next), 5);
}
const handlers = {
  'client.capabilities': (id, p) => { clientCaps = p?.server_requests === true; ok(id, { server_requests: ['approval', 'clarify', 'sudo', 'secret'], declines_not_shown: true }); },
  'gateway.capabilities': (id) => ok(id, { per_session_exclusive_submit: true }),
  ping: (id) => ok(id, { pong: true }),
  'commands.catalog': (id, p) => ok(id, {
    pairs: [['/new', 'Start a new session'], ['/busy', 'Control how messages behave while Hermes is working'], ['/ship', 'Ship the branch']],
    sub: { ship: ['now'] }, canon: { '/new': '/new', '/busy': '/busy', '/ship': '/ship' },
    commands: { '/ship': { argument_mode: 'text', desktop: null } },
    categories: [{ name: 'Plugins', pairs: [['/ship', 'Ship the branch']] }],
    skills: { '/deploy-notes': { usage: 'notes', origin: 'project' } }, skill_count: 1,
    warning: p.session_id ? 'session catalog' : '',
  }),
  'command.resolve': (id, p) => ok(id, { canonical: String(p.name), description: 'x', category: 'Configuration' }),
  'command.dispatch': (id, p) => (['compress', 'retry', 'undo', 'memory', 'skills', 'queue', 'steer'].includes(p.name) ? ok(id, { type: 'exec', output: `ran /${p.name} ${p.arg ?? ''}`.trim() }) : err(id, 4018, `not a quick/plugin/bundle/skill command: ${p.name}`)),
  'config.set': (id, p) => { if (p.key === 'model') return ok(id, { key: 'model', value: p.value, warning: '', confirm_required: false, scope: 'session' }); if (p.key === 'busy') { busyMode = p.value === 'status' || !p.value ? busyMode : p.value; return ok(id, { key: 'busy', value: busyMode }); } return err(id, 4002, `unknown config key: ${p.key}`); },
  'model.options': (id) => ok(id, { providers: [{ slug: 'custom', name: 'Custom', is_current: true, models: ['fake-model'] }] }),
  'session.list': (id) => ok(id, { sessions: [...sessions.values()].filter((s, i, a) => a.findIndex((x) => x.stored === s.stored) === i).map((s) => ({ id: s.stored, title: s.cur || null, message_count: s.messages.length })) }),
  'session.create': (id, p) => { const key = p.idempotency_key && [...sessions.values()].find((s) => s.idem === p.idempotency_key); if (key) return ok(id, { session_id: key.rt, stored_session_id: key.stored, message_count: 0, messages: [], info: {} });
    const s = { rt: 'rt' + (++n), stored: '20261009_000000_' + n.toString(16).padStart(6, '0'), seq: 0, events: [], messages: [], queue: [], running: false, corrections: [], idem: p.idempotency_key }; sessions.set(s.rt, s); ok(id, { session_id: s.rt, stored_session_id: s.stored, message_count: 0, messages: [], info: { model: 'fake-model', lazy: true } }); },
  'session.resume': (id, p) => { const s = [...sessions.values()].find((x) => x.stored === p.session_id); if (!s) return err(id, 4007, 'session not found'); ok(id, { ...snapshot(s), resumed: true }); },
  'session.activate': (id, p) => { const s = sessions.get(p.session_id); if (!s) return err(id, 4007, 'session not found'); ok(id, snapshot(s)); },
  'session.events.since': (id, p) => { if (typeof p.last_seen !== 'number' && p.last_seen !== undefined) return err(id, 4000, 'invalid params'); const s = sessions.get(p.session_id); if (!s) return err(id, 4007, 'session not found'); ok(id, { events: s.events.filter((e) => e.seq > (p.last_seen ?? 0)), latest_seq: s.seq, truncated: false, count: 0, epoch: 'epoch-' + process.pid, open_requests: snapshot(s).open_requests }); },
  'prompt.submit': (id, p) => { const s = sessions.get(p.session_id); if (!s) return err(id, 4007, 'session not found');
    if (s.running) { if (p.queued || s.busyMode === 'queue' || !s.busyMode) { s.queue.push(p.text); return ok(id, { status: 'queued' }); } s.corrections.push(p.text); return ok(id, { status: s.busyMode === 'steer' ? 'steered' : 'redirected' }); }
    ok(id, { status: 'streaming', user_row_id: s.messages.length + 1 }); void turn(s, p.text); },
  'session.steer': (id, p) => { const s = sessions.get(p.session_id); if (!s) return err(id, 4007, 'session not found'); if (!s.running) return ok(id, { status: 'rejected', text: p.text }); s.corrections.push(p.text); ok(id, { status: 'queued', text: p.text }); },
  'session.redirect': (id, p) => { const s = sessions.get(p.session_id); if (!s) return err(id, 4007, 'session not found'); ok(id, { status: 'rejected', text: p.text }); },
  'session.interrupt': (id, p) => { const s = sessions.get(p.session_id); if (!s) return err(id, 4007, 'session not found'); s.interrupted = true; for (const r of open.values()) if (r.s === s) r.done?.(); ok(id, { status: 'interrupted' }); },
};
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let f; try { f = JSON.parse(line); } catch { return out({ jsonrpc: '2.0', error: { code: -32700, message: 'parse error' }, id: null }); }
  if (f.method === undefined && f.id !== undefined) { const r = open.get(f.id); if (r) { if ('error' in f) { r.answer = null; } else { r.answer = f.result?.answers ?? f.result; } r.done?.(); } return; } // response to a server request
  const h = handlers[f.method]; if (!h) return err(f.id, -32601, `unknown method: ${f.method}`);
  try { h(f.id, f.params ?? {}); } catch (e) { err(f.id, -32000, String(e.message)); }
});
process.stdin.on('end', () => process.exit(0));
