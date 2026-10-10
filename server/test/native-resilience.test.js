// The machine connector and the native Hermes session survive a tunnel flap: the agent's turn is not restarted, nothing is sent twice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { waitFor } from './machine-helpers.js';
import { setup } from './ui-helpers.js';

const text = (events, sid) => events.filter((e) => e.type === 'message.delta' || e.type === 'message.complete').length;

test('a tunnel flap mid-turn: the connector reconnects with backoff, the same turn finishes, the hub shows one turn and one message', async (t) => {
  const x = await setup(t, { proxy: true });
  const json = async (route, data) => { const r = await fetch(x.base + route, { method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  await waitFor(async () => { const a = (await json('/api/agents')).body.agents ?? []; return a.length && a[0].capabilities?.nativeUi ? a : null; });
  const A = '/api/agents/default/native', sid = (await json(`${A}/sessions`, {})).body.session_id; await json(`${A}/sessions/${sid}/attach`, {});
  const ac = new AbortController(), seen = []; t.after(() => ac.abort());
  void fetch(`${x.base}${A}/sessions/${sid}/events?after=0`, { signal: ac.signal }).then(async (r) => { const dec = new TextDecoder(); let buf = ''; for await (const c of r.body) { buf += dec.decode(c, { stream: true }); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const b = buf.slice(0, i); buf = buf.slice(i + 2); const d = b.split('\n').find((l) => l.startsWith('data:')); if (d) try { seen.push(JSON.parse(d.slice(5))); } catch {} } } }).catch(() => {});
  const sent = await json(`${A}/sessions/${sid}/messages`, { text: 'slow story', client_id: 'client-flap-1' }); assert.equal(sent.status, 202);
  await waitFor(async () => seen.find((e) => e.type === 'message.delta') ?? null, { tries: 100, ms: 100 });
  await x.px.outage(1200); // the tunnel drops and stays down for a moment
  const back = await waitFor(async () => { const m = (await (await x.call('/api/machines')).json()).machines.find((q) => q.online); return m ?? null; }, { tries: 120, ms: 200 }); assert.ok(back, 'the connector found its way back: ' + x.run.out);
  assert.match(x.run.out, /Disconnected; retrying/); assert.match(x.run.out, /Connected to the hub/);
  // the same duplicate send after the flap is still recognised (idempotent), and the turn completes exactly once
  const dup = await json(`${A}/sessions/${sid}/messages`, { text: 'slow story', client_id: 'client-flap-1' }); assert.ok([200, 202].includes(dup.status)); assert.equal(dup.body.message.id, sent.body.message.id);
  const done = await waitFor(async () => seen.find((e) => e.type === 'turn.end') ?? null, { tries: 300, ms: 100 }); assert.ok(done, 'the turn finished after the flap: ' + JSON.stringify(seen.map((e) => e.type + (e.state ?? ''))) + x.run.out);
  const starts = seen.filter((e) => e.type === 'turn.start'); assert.equal(starts.length, 1, 'the turn was not restarted by the reconnect');
  const seqs = seen.map((e) => e.seq).filter(Number.isInteger); assert.deepEqual(seqs, [...new Set(seqs)].sort((a, b) => a - b), 'event numbers never repeat or go backwards');
});

test('a half-open tunnel (silent, not closed) is detected by the connector and replaced', async (t) => {
  const x = await setup(t, { proxy: true, env: { FOXFLEET_LINK_SILENT_MS: '3000' } });
  x.px.freeze(true); // nothing flows either way, but nothing closes
  const quiet = await waitFor(async () => (/went quiet/.test(x.run.out) ? true : null), { tries: 100, ms: 200 }); assert.ok(quiet, 'the connector noticed the silence: ' + x.run.out);
  x.px.freeze(false); x.px.resetAll();
  const back = await waitFor(async () => { const n = (x.run.out.match(/Connected to the hub/g) ?? []).length; return n >= 2 ? n : null; }, { tries: 150, ms: 200 }); assert.ok(back, 'reconnected: ' + x.run.out);
  const m = await waitFor(async () => (await (await x.call('/api/machines')).json()).machines.find((q) => q.online) ?? null); assert.ok(m);
});
