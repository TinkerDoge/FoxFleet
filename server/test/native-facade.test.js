// Existing client entry points (/chat, /messages, /queue, /runs/*) on a native-capable agent: routed server-side, clients do not switch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { waitFor } from './machine-helpers.js';
import { setup, REAL } from './ui-helpers.js';

async function boot(t) {
  const x = await setup(t);
  const api = async (route, data, method = data === undefined ? 'GET' : 'POST') => { const r = await fetch(x.base + route, { method, headers: { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }); return { status: r.status, headers: r.headers, body: await r.json().catch(() => ({})) }; };
  await waitFor(async () => { const a = (await api('/api/agents')).body.agents ?? []; return a.length && a[0].capabilities?.nativeUi ? a : null; });
  const A = '/api/agents/default';
  // read an SSE response into { events:[{event,data}], text, headers, done }
  function sse(route, { body, after } = {}) {
    const ac = new AbortController(), out = { events: [], text: '', headers: null, ended: false }; t.after(() => ac.abort());
    out.done = fetch(x.base + route + (after ? `?after=${after}` : ''), { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: ac.signal }).then(async (r) => {
      out.headers = r.headers; out.status = r.status; if (!r.body) return; const dec = new TextDecoder(); let buf = '';
      for await (const c of r.body) { buf += dec.decode(c, { stream: true }); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const raw = buf.slice(0, i); buf = buf.slice(i + 2); const ev = /^event: (.*)$/m.exec(raw)?.[1] ?? 'message', d = /^data: (.*)$/m.exec(raw)?.[1]; if (!d || d === '[DONE]') { if (d === '[DONE]') out.ended = true; continue; } let j; try { j = JSON.parse(d); } catch { continue; } out.events.push({ event: ev, data: j }); const c0 = j?.choices?.[0]?.delta?.content; if (c0) out.text += c0; } }
      out.ended = true;
    }).catch(() => {});
    out.stop = () => ac.abort(); out.wait = (pred, o = { tries: 150, ms: 100 }) => waitFor(async () => out.events.find(pred) ?? null, o);
    return out;
  }
  return { ...x, api, A, sse };
}
const chat = (text, session) => ({ messages: [{ role: 'user', content: text }], ...(session ? { session_id: session } : {}) });

test('POST /chat on a native agent streams the reply as a normal run and names the stored session', async (t) => {
  const x = await boot(t), s = x.sse(`${x.A}/chat`, { body: chat('hello there') });
  await s.done; assert.equal(s.status, 200); assert.match(s.headers.get('x-hermes-session-id'), /^2026|^[\w.:-]+$/); assert.ok(s.headers.get('x-foxfleet-run'));
  assert.ok(s.text.length > 0); const end = s.events.find((e) => e.event === 'foxfleet.upstream'); assert.equal(end.data.state, 'completed');
  const runs = (await x.api(`${x.A}/runs?session_id=${s.headers.get('x-hermes-session-id')}`)).body.runs; assert.equal(runs.length, 1);
});

test('busy messages: Hermes acknowledgement shown as-is, Hermes drains its own queue into a new run, hub keeps no queue of its own', async (t) => {
  const x = await boot(t), first = x.sse(`${x.A}/chat`, { body: chat('slow story') }); await first.wait((e) => e.data?.choices); const sid = first.headers.get('x-hermes-session-id'), run1 = first.headers.get('x-foxfleet-run');
  const idle = await x.api(`${x.A}/chat`, chat('second chat while busy', sid)); assert.equal(idle.status, 409, 'plain chat while busy is refused and points at /messages');
  const q = await x.api(`${x.A}/messages`, { messages: [{ role: 'user', content: 'then bye' }], session_id: sid, mode: 'queue', client_id: 'cid-queue-1' }); assert.equal(q.status, 202); assert.equal(q.body.message.state, 'queued'); assert.equal(q.body.message.ack, 'queued'); assert.equal(q.body.run_id, run1);
  const st = await x.api(`${x.A}/messages`, { messages: [{ role: 'user', content: 'make it about foxes' }], session_id: sid, mode: 'steer' }); assert.equal(st.body.message.state, 'guidance_accepted'); assert.equal(st.body.message.ack, 'queued', 'shown exactly as Hermes answered');
  const rd = await x.api(`${x.A}/messages`, { messages: [{ role: 'user', content: 'redirect now' }], session_id: sid, mode: 'interrupt' }); if (REAL) assert.ok(['rejected', 'guidance_accepted', 'queued'].includes(rd.body.message.state), 'whatever Hermes answered is shown'); else { assert.equal(rd.body.message.state, 'rejected'); assert.match(rd.body.message.note, /Queue, Steer, or Stop/); }
  const dup = await x.api(`${x.A}/messages`, { messages: [{ role: 'user', content: 'then bye' }], session_id: sid, mode: 'queue', client_id: 'cid-queue-1' }); assert.equal(dup.status, 200); assert.equal(dup.body.message.id, q.body.message.id);
  const queue = (await x.api(`${x.A}/queue?session_id=${sid}`)).body; assert.equal(queue.active_run, run1); assert.ok(queue.items.some((i) => i.text === 'then bye' && i.state === 'queued' && i.ack === 'queued')); assert.equal(queue.can_cancel, false);
  assert.equal((await x.api(`${x.A}/queue/${q.body.message.id}?session_id=${sid}`, undefined, 'DELETE')).status, 409, 'cancel is disabled with a reason, not faked');
  await first.done; assert.equal(first.events.find((e) => e.event === 'foxfleet.upstream').data.state, 'completed');
  const next = await waitFor(async () => { const r = (await x.api(`${x.A}/queue?session_id=${sid}`)).body; return r.active_run && r.active_run !== run1 ? r : null; }, { tries: 80, ms: 100 }); assert.ok(next, 'Hermes started the queued turn itself and the hub exposes it as a run');
  const second = x.sse(`${x.A}/runs/${next.active_run}/events`); await second.done; assert.ok(second.text.includes('w0'));
  const after = (await x.api(`${x.A}/queue?session_id=${sid}`)).body; assert.deepEqual(after.items.filter((i) => i.text === 'then bye'), [], 'delivered items leave the queue');
});

test('Stop through the usual /runs/{id}/stop ends the native turn truthfully; a second viewer keeps its own stream', async (t) => {
  const x = await boot(t), a = x.sse(`${x.A}/chat`, { body: chat('slow story') }); await a.wait((e) => e.data?.choices); const sid = a.headers.get('x-hermes-session-id'), run = a.headers.get('x-foxfleet-run');
  const b = x.sse(`${x.A}/runs/${run}/events`); await b.wait((e) => e.data?.choices); a.stop();
  const stop = await x.api(`${x.A}/runs/${run}/stop`, {}); assert.equal(stop.status, 200); assert.equal(stop.body.confirmed, true);
  await b.done; assert.equal(b.events.find((e) => e.event === 'foxfleet.upstream').data.state, 'stopped'); assert.ok(sid);
});

test('approvals and clarifications: card event, still listed after reconnect, answered once, closed by id; unhandled kinds never hang', async (t) => {
  const x = await boot(t), s = x.sse(`${x.A}/chat`, { body: chat('please clarify env') }); const open = await s.wait((e) => e.event === 'foxfleet.request'); assert.ok(open); const sid = s.headers.get('x-hermes-session-id');
  assert.equal(open.data.kind, 'clarify'); assert.match(open.data.request_id, /^srq-/);
  const q = (await x.api(`${x.A}/queue?session_id=${sid}`)).body; assert.equal(q.open_requests.length, 1, 'the card comes back for a new device or after a reload'); assert.equal(q.open_requests[0].request_id, open.data.request_id);
  const url = `${x.A}/native/sessions/${sid}/requests/${open.data.request_id}`;
  assert.equal((await x.api(url, { result: { answers: { q0: 'staging' } } })).status, 200); assert.equal((await x.api(url, { result: { answers: { q0: 'production' } } })).status, 404);
  assert.ok(await s.wait((e) => e.event === 'foxfleet.request_closed' && e.data.request_id === open.data.request_id && e.data.reason === 'answered')); await s.done;
  const s2 = x.sse(`${x.A}/chat`, { body: chat('clarify again', sid) }); const second = await s2.wait((e) => e.event === 'foxfleet.request'); await x.api(`${x.A}/runs/${s2.headers.get('x-foxfleet-run')}/stop`, {});
  assert.ok(await s2.wait((e) => e.event === 'foxfleet.request_closed' && e.data.request_id === second.data.request_id && e.data.reason === 'interrupted')); assert.equal((await x.api(`${x.A}/queue?session_id=${sid}`)).body.open_requests.length, 0);
  if (REAL) return; // the sudo prompt is produced by the fake gateway only
  const s3 = x.sse(`${x.A}/chat`, { body: chat('need sudo now', sid) }); await s3.done; assert.ok(s3.text.includes('sudo-refused'), 'an unsupported request kind is refused immediately: the turn finished instead of waiting'); assert.ok(!s3.events.some((e) => e.event === 'foxfleet.request'));
});

test('/busy is profile-wide: read freely, changed only with explicit confirmation; /commands says the agent is native', async (t) => {
  const x = await boot(t); const cmds = (await x.api(`${x.A}/commands`)).body; assert.equal(cmds.native, true); assert.deepEqual(cmds.busy, ['queue', 'steer', 'interrupt']);
  const st = await x.api(`${x.A}/native/busy`); assert.equal(st.body.scope, 'profile'); assert.ok(st.body.mode);
  assert.equal((await x.api(`${x.A}/native/busy`, { mode: 'steer' })).status, 400, 'no confirm, no change'); assert.equal((await x.api(`${x.A}/native/busy`, { mode: 'rm', confirm: true })).status, 400);
  if (!REAL) { assert.equal((await x.api(`${x.A}/native/busy`, { mode: 'queue', confirm: true })).body.mode, 'queue'); assert.equal((await x.api(`${x.A}/native/busy`)).body.mode, 'queue'); }
});

test('queued messages keep their order for every device and survive the viewer going away', async (t) => {
  const x = await boot(t), first = x.sse(`${x.A}/chat`, { body: chat('slow story') }); await first.wait((e) => e.data?.choices); const sid = first.headers.get('x-hermes-session-id');
  for (const [i, w] of ['alpha', 'bravo', 'charlie'].entries()) assert.equal((await x.api(`${x.A}/messages`, { messages: [{ role: 'user', content: w }], session_id: sid, mode: 'queue', client_id: `order-${i}-xxxxxx` })).body.message.state, 'queued');
  first.stop(); // the phone goes away; nothing is cancelled
  const order = async () => (await x.api(`${x.A}/queue?session_id=${sid}`)).body.items.map((i) => i.text);
  assert.deepEqual(await order(), ['alpha', 'bravo', 'charlie']); assert.deepEqual(await order(), ['alpha', 'bravo', 'charlie'], 'a second device reads the same order');
  const run = (await x.api(`${x.A}/queue?session_id=${sid}`)).body.active_run; assert.ok(run, 'the turn kept running without any viewer');
});

test('Stop right after the turn was created ends truthfully and starts no second writer', async (t) => {
  const x = await boot(t), a = x.sse(`${x.A}/chat`, { body: chat('slow story') }); await waitFor(async () => a.headers, { tries: 100, ms: 50 }); const run = a.headers.get('x-foxfleet-run'), sid = a.headers.get('x-hermes-session-id');
  const stop = await x.api(`${x.A}/runs/${run}/stop`, {}); assert.equal(stop.body.confirmed, true); await a.done;
  assert.ok(['stopped', 'completed'].includes(a.events.find((e) => e.event === 'foxfleet.upstream').data.state));
  await new Promise((r) => setTimeout(r, 400)); const q = (await x.api(`${x.A}/queue?session_id=${sid}`)).body; assert.equal(q.active_run, null, 'nothing restarted by itself');
});
