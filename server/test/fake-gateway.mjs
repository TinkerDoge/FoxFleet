// A protocol-faithful stand-in for `python -m tui_gateway.entry` (Hermes), written from the REAL frames observed against hermes-agent
// 0670ba45 (see design/notes/hermes-ui-gateway.md). Newline-delimited JSON-RPC on stdio, `gateway.ready` first, per-session `seq`
// on events, server->client `clarify` requests, busy-submit acks, request.cancel, open_requests / inflight / queued in snapshots.
// Behaviour by prompt text: "slow ..." streams for ~3s, "clarify ..." asks a question first, "crash" kills the process,
// "mediacase" / "mediacase2" make tool files, "nostream" sends the reply only in message.complete.
import readline from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// Like Hermes, stored sessions outlive the process (Hermes keeps them in its state DB; here a small file in HERMES_HOME), while runtime
// ids and confirm tokens do not: a restarted gateway resumes a stored id under a NEW runtime id and has forgotten every old one.
// Sessions are created lazily (`info.lazy`): one is stored only once a turn finished, so a chat that never completed a turn is unknown after a restart.
const STORE = process.env.HERMES_HOME ? join(process.env.HERMES_HOME, 'fake-gateway-sessions.json') : null;
const stored = () => { try { return JSON.parse(readFileSync(STORE, 'utf8')); } catch { return {}; } };
const persist = (s) => { if (!STORE) return; try { const all = stored(); all[s.stored] = { messages: s.messages, rev: s.rev ?? 1 }; writeFileSync(STORE, JSON.stringify(all)); } catch { /* best effort */ } };
const RT = process.pid.toString(36); // runtime ids are per process
let n = 0, srq = 0, busyMode = 'interrupt'; const sessions = new Map(), open = new Map(); let clientCaps = false;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const ok = (id, result) => out({ jsonrpc: '2.0', id, result }), err = (id, code, message) => out({ jsonrpc: '2.0', id, error: { code, message } });
const ev = (s, type, payload) => { const e = { type, session_id: s.rt, ...(payload ? { payload } : {}), seq: ++s.seq }; s.events.push(e); out({ jsonrpc: '2.0', method: 'event', params: e }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
out({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: { skin: { name: 'default' }, change_events: true, replay_epoch: 'epoch-' + process.pid } } });
const snapshot = (s) => ({ session_id: s.rt, revision: s.rev ?? 1, execution_generation: 0, session_key: s.stored, info: { model: 'fake-model', running: s.running, stored_session_id: s.stored }, message_count: s.messages.length, messages: s.messages.slice(), running: s.running, inflight: s.running ? { user: s.cur, assistant: s.partial, streaming: true, ...(s.corrections.length ? { corrections: s.corrections } : {}) } : undefined, queued: s.queue[0] ? { user: s.queue[0] } : undefined, open_requests: [...open.values()].filter((r) => r.params.session_id === s.rt && !r.hidden).map((r) => ({ id: r.id, method: r.method, params: r.params })) });
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
  if (/\[with \d+ image/.test(text)) { s.partial += text + ' '; ev(s, 'message.delta', { text: text + ' ' }); } // echo what the picture attach did
  if (/secretsteps/.test(text)) { // 0.4.1 redaction: FAKE secrets only (never real ones) in args, result, status and commentary
    const SK = 'sk-test-FAKEFAKEFAKE0000000000', GH = 'ghp_FAKEFAKEFAKEFAKE0000000000';
    ev(s, 'message.interim', { text: `Using ${SK} to call the API`, already_streamed: false }); ev(s, 'status.update', { kind: 'info', text: `token ${GH} accepted` });
    ev(s, 'tool.start', { tool_id: 'call_x1', name: 'terminal', args: { command: `mysql -u root -pFAKEpw1111 db; deploy --password=FAKEpw2222 --password FAKEpw3333 --key ${SK}` } }); await sleep(5);
    ev(s, 'tool.complete', { tool_id: 'call_x1', name: 'terminal', result: `ok ${GH} done`, duration_s: 0.1 }); ev(s, 'reasoning.available', { text: `I will use ${SK} and -p in mysql -pFAKEpw1111` });
  } else   if (/steps/.test(text)) { // 0.4.1 step detail: commentary, a status line, one tool with args and a result, reasoning in one piece
    ev(s, 'message.interim', { text: 'Checking the folder first', already_streamed: false }); ev(s, 'status.update', { kind: 'warn', text: 'Context is getting long' });
    ev(s, 'tool.start', { tool_id: 'call_s1', name: 'terminal', args: { command: 'ls -la' } }); await sleep(5);
    ev(s, 'tool.complete', { tool_id: 'call_s1', name: 'terminal', args: { command: 'ls -la' }, result: '{"output":"a b","exit_code":0}', duration_s: 0.5 }); ev(s, 'reasoning.available', { text: 'thought about it' });
  }
  // 0.4.2 N1: a tool-made file ("mediacase"; "mediacase2" makes a second, distinct one) and a profile with streaming.enabled=false
  // ("nostream": no message.delta, only message.complete carries the text).
  if (/mediacase/.test(text)) { ev(s, 'tool.start', { tool_id: 'call_m1', name: 'image_generate', args: { prompt: 'chart' } }); await sleep(5); ev(s, 'tool.complete', { tool_id: 'call_m1', name: 'image_generate', result: '{"path":"/tmp/fake/chart.png"}', duration_s: 0.1 }); }
  if (/mediacase2/.test(text)) { ev(s, 'tool.start', { tool_id: 'call_m2', name: 'image_generate', args: { prompt: 'map' } }); await sleep(5); ev(s, 'tool.complete', { tool_id: 'call_m2', name: 'image_generate', result: '{"path":"/tmp/fake/map.png"}', duration_s: 0.1 }); }
  if (/nostream/.test(text)) { s.partial = /ownmedia/.test(text) ? 'Here is the chart.\nMEDIA:/tmp/fake/chart.png\nAnd a table: MEDIA:/tmp/fake/table.csv' : 'Finished reply without streaming.'; return finish(s, 'done'); }
  const words = /slow/.test(text) ? 30 : 3;
  for (let i = 0; i < words && !s.interrupted; i++) { s.partial += `w${i} `; ev(s, 'message.delta', { text: `w${i} ` }); await sleep(/slow/.test(text) ? 100 : 5); }
  finish(s, s.interrupted ? 'interrupted' : 'done');
}
function finish(s, how) {
  const text = s.partial; if (text) s.messages.push({ role: 'assistant', content: text, ...(how === 'interrupted' ? { interrupted: true } : {}) }); persist(s);
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
  'config.set': (id, p) => { if (p.key === 'model') { const model = String(p.value).split(' --')[0]; if (/expensive/.test(model) && p.confirm_expensive_model !== true) return ok(id, { key: 'model', value: model, warning: 'high price', confirm_required: true, confirm_message: 'This model is expensive. Confirm to switch.', scope: 'session' }); return ok(id, { key: 'model', value: model, warning: '', confirm_required: false, scope: 'session' }); } if (p.key === 'busy') { busyMode = p.value === 'status' || !p.value ? busyMode : p.value; return ok(id, { key: 'busy', value: busyMode }); } if (p.key === 'show_reasoning') return ok(id, { key: 'show_reasoning', value: p.value, scope: 'session' }); return err(id, 4002, `unknown config key: ${p.key}`); },
  'model.options': (id) => ok(id, { providers: [{ slug: 'custom', name: 'Custom', is_current: true, models: ['fake-model'] }] }),
  'session.list': (id) => ok(id, { sessions: [...sessions.values()].filter((s, i, a) => a.findIndex((x) => x.stored === s.stored) === i).map((s) => ({ id: s.stored, title: s.cur || null, message_count: s.messages.length })) }),
  'session.create': (id, p) => { const key = p.idempotency_key && [...sessions.values()].find((s) => s.idem === p.idempotency_key); if (key) return ok(id, { session_id: key.rt, stored_session_id: key.stored, message_count: 0, messages: [], info: {} });
    const s = { rt: `rt${++n}-${RT}`, stored: '20261009_000000_' + RT + '_' + n.toString(16).padStart(6, '0'), seq: 0, events: [], messages: [], queue: [], running: false, corrections: [], idem: p.idempotency_key }; sessions.set(s.rt, s); ok(id, { session_id: s.rt, stored_session_id: s.stored, message_count: 0, messages: [], info: { model: 'fake-model', lazy: true } }); },
  'session.resume': (id, p) => { let s = [...sessions.values()].find((x) => x.stored === p.session_id);
    if (!s) { const old = stored()[p.session_id]; if (!old) return err(id, 4007, 'session not found'); s = { rt: `rt${++n}-${RT}`, stored: p.session_id, seq: 0, events: [], messages: old.messages ?? [], rev: old.rev ?? 1, queue: [], running: false, corrections: [] }; sessions.set(s.rt, s); }
    ok(id, { ...snapshot(s), resumed: true }); },
  'session.activate': (id, p) => { const s = sessions.get(p.session_id); if (!s) return err(id, 4007, 'session not found'); ok(id, snapshot(s)); },
  'session.events.since': (id, p) => { if (typeof p.last_seen !== 'number' && p.last_seen !== undefined) return err(id, 4000, 'invalid params'); const s = sessions.get(p.session_id); if (!s) return err(id, 4007, 'session not found'); ok(id, { events: s.events.filter((e) => e.seq > (p.last_seen ?? 0)), latest_seq: s.seq, truncated: false, count: 0, epoch: 'epoch-' + process.pid, open_requests: snapshot(s).open_requests }); },
  'image.attach_bytes': (id, p) => { const s = sessions.get(p.session_id); if (!s) return err(id, 4007, 'session not found'); if (!p.content_base64) return err(id, 4015, 'content_base64 required'); const bytes = Buffer.from(p.content_base64, 'base64'); if (!bytes.length) return err(id, 4015, 'image is empty'); (s.attached ??= []).push(bytes.length); ok(id, { attached: true, path: '/tmp/upload-' + s.attached.length + '.png', count: s.attached.length, bytes: bytes.length }); },
  'prompt.submit': (id, p) => { const s = sessions.get(p.session_id); if (!s) return err(id, 4007, 'session not found'); if (/^<foxfleet-note>[\s\S]*?<\/foxfleet-note>\s*/.test(p.text)) { s.noted = (s.noted ?? 0) + 1; p = { ...p, text: p.text.replace(/^<foxfleet-note>[\s\S]*?<\/foxfleet-note>\s*/, '') }; } // the connector's first-message awareness note: not the user's words
    if (s.attached?.length) { p = { ...p, text: `${p.text} [with ${s.attached.length} image(s): ${s.attached.join(',')} bytes]` }; s.attached = []; }
    if (s.running) { if (p.queued || s.busyMode === 'queue' || !s.busyMode) { s.queue.push(p.text); return ok(id, { status: 'queued' }); } s.corrections.push(p.text); return ok(id, { status: s.busyMode === 'steer' ? 'steered' : 'redirected' }); }
    ok(id, { status: 'streaming', user_row_id: s.messages.length + 1 }); void turn(s, p.text); },
  'session.steer': (id, p) => { const s = sessions.get(p.session_id); if (!s) return err(id, 4007, 'session not found'); if (!s.running) return ok(id, { status: 'rejected', text: p.text }); s.corrections.push(p.text); ok(id, { status: 'queued', text: p.text }); },
  'session.redirect': (id, p) => { const s = sessions.get(p.session_id); if (!s) return err(id, 4007, 'session not found'); ok(id, { status: 'rejected', text: p.text }); },
  'session.interrupt': (id, p) => { const s = sessions.get(p.session_id); if (!s) return err(id, 4007, 'session not found'); s.interrupted = true; for (const r of open.values()) if (r.s === s) r.done?.(); ok(id, { status: 'interrupted' }); },
  'session.mutate': (id, p) => {
    if (p.operation !== 'model') return err(id, 4002, `unsupported mutate: ${p.operation}`);
    const s = sessions.get(p.session_id) || [...sessions.values()].find((x) => x.stored === p.session_id);
    if (!s) return err(id, 4007, 'session not found');
    // Hermes validate_action (hermes_state_mutations.py at pin f9bdaa30): payload keys within {model, provider, confirm}, every value a
    // non-empty string, else RuntimeStoreError('invalid_params') -> JSON-RPC 4001. So `confirm: true` (a boolean) is refused outright.
    const pl = p.payload;
    if (!pl || typeof pl !== 'object' || !('model' in pl) || Object.keys(pl).some((k) => !['model', 'provider', 'confirm'].includes(k)) || Object.values(pl).some((v) => typeof v !== 'string' || !v.trim())) return err(id, 4001, 'invalid_params');
    const model = String(pl.model).split(' --')[0];
    // session_mutation_model._selection_guard_refusal: the token is bound to the target and the session revision; only that exact token
    // applies the switch, a stale or foreign one gets a fresh refusal (never an error, never a silent apply).
    const token = `tok-${model}-${pl.provider ?? ''}-${s.rev ?? 1}`;
    if (/expensive/.test(model) && pl.confirm !== token) return ok(id, { status: 'confirmation_required', confirm_required: true, confirm: token, target_model: model, confirm_message: 'This model is expensive. Confirm to switch.' });
    s.rev = (s.rev ?? 1) + 1; s.model = model; if (s.messages.length) persist(s);
    return ok(id, { status: 'ok', model, value: model, scope: 'session', revision: s.rev });
  },
};
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let f; try { f = JSON.parse(line); } catch { return out({ jsonrpc: '2.0', error: { code: -32700, message: 'parse error' }, id: null }); }
  if (f.method === undefined && f.id !== undefined) { const r = open.get(f.id); if (r) { if ('error' in f) { r.answer = null; } else { r.answer = f.result?.answers ?? f.result; } r.done?.(); } return; } // response to a server request
  const h = handlers[f.method]; if (!h) return err(f.id, -32601, `unknown method: ${f.method}`);
  try { h(f.id, f.params ?? {}); } catch (e) { err(f.id, -32000, String(e.message)); }
});
process.stdin.on('end', () => process.exit(0));
