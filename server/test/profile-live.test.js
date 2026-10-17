// Hermes agents on the default and on a NON-default profile, end to end through the real connector, keyed by the agent name and the
// chat the client holds (stream header, live v1/v2 run events, message.new, runs, history).
// - Regression tests (fail on 53c5046): the HTTP cases against test/profile-hermes.js, a mock of one Hermes install with profiles shaped
//   after the Hermes docs, where a new chat only gets an id if the hub names it.
// - Coverage only (passes before and after; the native gateway names its own chats): the native-gateway case below.
import test from 'node:test';
import assert from 'node:assert/strict';
import { waitFor } from './machine-helpers.js';
import { setup } from './ui-helpers.js';
import { sse } from './live2-helpers.js';
import { profileHermes } from './profile-hermes.js';

test(`non-default profile (native gateway): /chat streams the reply, live run_started/run_finished name that agent and chat, history and runs answer for it`, async (t) => {
  const gateway = true, x = await setup(t, { profiles: ['coder'], gateway });
  const api = async (route, data) => { const r = await fetch(x.base + route, { method: data ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: data ? JSON.stringify(data) : undefined, signal: AbortSignal.timeout(15_000) }); return { status: r.status, headers: r.headers, text: await r.text() }; };
  const agents = await waitFor(async () => { const a = JSON.parse((await api('/api/agents')).text).agents ?? []; return a.length === 2 && a.every((q) => (gateway ? q.capabilities?.nativeUi : q.chatReady)) ? a : null; });
  assert.deepEqual(agents.map((a) => a.name).sort(), ['coder', 'default']);
  const frames = [], ac = new AbortController(); t.after(() => ac.abort());
  let ready; const isReady = new Promise((r) => { ready = r; });
  void fetch(x.base + '/api/live/stream', { signal: ac.signal }).then(async (r) => { const dec = new TextDecoder(); let buf = ''; for await (const c of r.body) { buf += dec.decode(c, { stream: true }); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const raw = buf.slice(0, i); buf = buf.slice(i + 2); if (raw.includes('foxfleet.ready')) ready(); const d = /^data: (.*)$/m.exec(raw)?.[1]; if (/^event: live$/m.test(raw) && d) frames.push(JSON.parse(d)); } } }).catch(() => {});
  await isReady;
  for (const name of ['coder', 'default', 'coder']) {
    const before = frames.length;
    const r = await api(`/api/agents/${name}/chat`, { messages: [{ role: 'user', content: `hello ${name}` }] });
    assert.equal(r.status, 200, r.text); const sid = r.headers.get('x-hermes-session-id'), run = r.headers.get('x-foxfleet-run');
    assert.match(sid, /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/, 'a session id the Android client accepts'); assert.ok(run);
    assert.match(r.text, /"content":"/, `${name}: the reply streamed`);
    const fin = await waitFor(async () => frames.slice(before).find((f) => f.type === 'run_finished' && f.run_id === run) ?? null);
    assert.ok(fin, `${name}: run_finished on the live stream`); assert.equal(fin.agent, name); assert.equal(fin.chat, sid);
    assert.ok(frames.slice(before).some((f) => f.type === 'run_started' && f.agent === name && f.chat === sid && f.run_id === run));
    assert.ok(!frames.slice(before).some((f) => f.agent !== name), 'no event under another agent name');
    const runs = JSON.parse((await api(`/api/agents/${name}/runs?session_id=${encodeURIComponent(sid)}`)).text).runs; assert.ok(runs.some((q) => q.id === run));
    assert.equal((await api(`/api/agents/${name}/sessions/${encodeURIComponent(sid)}/messages`)).status, 200, `${name}: the catch-up page answers for this session`);
  }
});

// 0.4.1: Hermes as its docs describe one install with profiles (test/profile-hermes.js): a shared listener with /p/<profile>/ routing and
// per-profile keys, per-profile sessions and runs, POST /v1/runs answering without the session id, chat completions that only echo a
// session id they were sent. A NEW chat's reply must reach the open chat live (stream header, run.started/run.finished, message.new)
// for the default profile and a named one alike, on both HTTP transports.
for (const [label, mock] of [['runs API', { runs: true }], ['chat completions, no session echo', { runs: false, sessionHeader: false }]]) test(`default and named profile over HTTP (${label}): a new chat has its id at once, live v2 run events and message.new carry it, the reply is stored under that profile`, async (t) => {
  const hermes = await profileHermes(t, mock), x = await setup(t, { profiles: ['coder'], gateway: false, hermes });
  const agents = await waitFor(async () => { const a = (await (await fetch(x.base + '/api/agents')).json()).agents ?? []; return a.length === 2 && a.every((q) => q.chatReady) ? a : null; });
  assert.ok(agents, 'both agents chat-ready'); assert.deepEqual(agents.map((a) => a.capabilities.nativeRuns).sort(), [mock.runs, mock.runs]);
  const s = sse(t, `${x.base}/api/live/stream?v=2`); await s.wait((f) => f.event === 'foxfleet.ready');
  const replies = (name) => s.frames.filter((f) => f.event === 'message.new' && f.data.agent === name && f.data.message.role === 'assistant');
  for (const name of ['coder', 'default']) {
    const profile = name; let sid = null;
    for (const turn of [1, 2]) {
      const before = replies(name).length;
      const r = await fetch(`${x.base}/api/agents/${name}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: `hello ${name} ${turn}` }], ...(sid ? { session_id: sid } : {}) }), signal: AbortSignal.timeout(15_000) });
      const text = await r.text(), got = r.headers.get('x-hermes-session-id'), run = r.headers.get('x-foxfleet-run');
      assert.equal(r.status, 200, text); assert.match(got ?? '', /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/, `${name} turn ${turn}: the stream names its chat`);
      if (sid) assert.equal(got, sid, 'a follow-up stays in the same chat'); sid = got;
      assert.match(text, /"content":"[^"]/, `${name}: the reply streamed`);
      const reply = await s.wait((f) => f.event === 'message.new' && f.data.agent === name && f.data.message.role === 'assistant' && replies(name).indexOf(f) >= before, 8000);
      assert.equal(reply.data.chat, sid, `${name} turn ${turn}: message.new is keyed to the chat the client holds`);
      assert.match(reply.data.message.text, new RegExp(`reply from ${profile} to: hello ${name} ${turn}`), 'the reply came from that profile');
      assert.ok(s.frames.some((f) => f.event === 'run.started' && f.data.agent === name && f.data.run_id === run && f.data.chat === sid), 'run.started names the chat');
      await s.wait((f) => f.event === 'run.finished' && f.data.agent === name && f.data.run_id === run && f.data.chat === sid, 8000);
      assert.ok(hermes.store.get(profile).has(sid), `the chat lives in Hermes under profile ${profile}`);
      for (const other of ['default', 'coder'].filter((p) => p !== profile)) assert.ok(!hermes.store.get(other).has(sid), `and not under ${other}`);
    }
    const page = await (await fetch(`${x.base}/api/agents/${name}/sessions/${encodeURIComponent(sid)}/messages`)).json();
    assert.deepEqual(page.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant'], `${name}: history has both turns`);
  }
  const api = hermes.requests.filter((q) => q.service === 'api');
  assert.ok(api.length && api.every((q) => q.authorized), 'every API call carried the key of the profile it was routed to');
  assert.ok(api.filter((q) => q.profile === 'coder').every((q) => q.path.startsWith('/p/coder/')), 'coder is reached under /p/coder/');
  assert.ok(api.filter((q) => q.profile === 'default').every((q) => !q.path.startsWith('/p/')), 'default stays unprefixed');
});

test('named profile whose key Hermes refuses on /p/<profile>: the agent check says which key to set (never a sign-out 401)', async (t) => {
  const hermes = await profileHermes(t, { runs: true }), x = await setup(t, { profiles: ['coder'], gateway: false, hermes, envKeys: { default: hermes.key('default'), coder: hermes.key('default') } }); // the default key copied into coder's .env
  const coder = await waitFor(async () => ((await (await fetch(x.base + '/api/agents')).json()).agents ?? []).find((a) => a.name === 'coder' && a.checks?.api && !a.checks.api.ok) ?? null);
  assert.ok(coder, 'coder is listed with a failing API check'); assert.match(coder.checks.api.message, /API_SERVER_KEY/); assert.match(coder.checks.api.message, /profiles\/coder\/\.env/);
  assert.ok(!JSON.stringify(coder).includes(hermes.key('default')), 'no key in the agent view');
  const r = await fetch(`${x.base}/api/agents/coder/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) });
  assert.notEqual(r.status, 401, 'an agent refusing the hub is not a sign-out'); await r.body?.cancel();
});

