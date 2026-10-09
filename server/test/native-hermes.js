// A fake Hermes native run API (POST /v1/runs, GET /events, POST /steer, POST /stop) for the chat-control tests.
// Runs are driven by the test: fake.emit(runId, type, data), fake.finish(runId, terminal, extra).
export const NATIVE_FEATURES = { run_submission: true, run_status: true, run_events_sse: true, run_steer: true, run_stop: true };
const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
const readBody = async (req) => { let t = ''; for await (const c of req) t += c; return JSON.parse(t || '{}'); };

export function fakeNative(opts = {}) {
  const runs = new Map(), byKey = new Map(), calls = []; let n = 0;
  const wake = (r) => { for (const w of [...r.waiters]) w(); };
  const api = {
    runs, calls, opts,
    get writers() { return [...runs.values()].filter((r) => r.state === 'running' || r.state === 'stopping').length; },
    emit(id, type, data = {}) { const r = runs.get(id); r.events.push({ type, data }); wake(r); },
    finish(id, terminal = 'run.completed', extra = {}) { const r = runs.get(id); if (r.state === 'done') return; r.state = 'done'; r.events.push({ type: terminal, data: { run_id: id, ...extra } }); wake(r); },
    last() { return [...runs.keys()].at(-1); },
    async route(req, res, route, u) {
      if (route === '/v1/runs' && req.method === 'POST') {
        const body = await readBody(req), key = req.headers['idempotency-key']; calls.push({ call: 'create', body, key, session: body.session_id });
        if (opts.createStatus) return json(res, opts.createStatus, { error: 'no' });
        if (key && byKey.has(key)) return json(res, 202, { run_id: byKey.get(key), status: 'started' });
        const id = `run_${++n}`; runs.set(id, { id, state: 'running', events: [], waiters: new Set(), input: body.input, session: body.session_id || `sess-${n}`, steers: [] }); if (key) byKey.set(key, id);
        return json(res, 202, { run_id: id, status: 'started', session_id: runs.get(id).session });
      }
      const m = route.match(/^\/v1\/runs\/([^/]+)\/(events|steer|stop)$/); if (!m) return false;
      const r = runs.get(m[1]); if (!r) return json(res, 404, {});
      if (m[2] === 'steer') { const body = await readBody(req); calls.push({ call: 'steer', id: r.id, body }); if (r.state !== 'running') return json(res, 409, { error: 'not running' }); r.steers.push(body.input); return json(res, 202, { status: 'accepted' }); }
      if (m[2] === 'stop') {
        calls.push({ call: 'stop', id: r.id }); if (opts.stopFails) return json(res, 500, {});
        if (r.state === 'running') { r.state = 'stopping'; if (!opts.stopNever) setTimeout(() => { r.state = 'done'; r.events.push({ type: 'run.stopped', data: { run_id: r.id } }); wake(r); }, opts.stopDelayMs ?? 30); }
        return json(res, 202, { status: 'stopping' });
      }
      const after = Number(u.searchParams.get('after') || req.headers['last-event-id'] || 0); calls.push({ call: 'events', id: r.id, after });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); let at = after, closed = false; res.on('close', () => { closed = true; });
      const terminal = (e) => /^run\.(completed|failed|stopped)/.test(e.type);
      for (;;) {
        while (at < r.events.length) { const e = r.events[at++]; res.write(`id: ${at}\nevent: ${e.type}\ndata: ${JSON.stringify({ ...e.data, type: e.type })}\n\n`); if (terminal(e)) return res.end(); }
        if (closed) return; await new Promise((ok) => { const w = () => { r.waiters.delete(w); ok(); }; r.waiters.add(w); res.once('close', w); });
      }
    },
  };
  return api;
}
