// Message coordinator: one ordering policy per (user, agent, session), shared by the web, the phone and (later) other channels.
//  - Every submission is persisted with a stable id BEFORE it is acknowledged; the client's `client_id` makes retries idempotent.
//  - A short admission chain orders requests; control calls (steer, stop) reach the active run at once and never wait for it.
//  - queue: next turn, FIFO.  steer: guidance to the active run (accepted != consumed).  interrupt: Stop, await confirmed
//    termination, then start the replacement: a failed stop leaves the replacement pending with an error and never creates a second writer.
//  - A user Stop halts automatic draining until an explicit resume or a new submission. Undelivered `pending_steer` comes back as a queued message, once.
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { fault } from './config.js';

const MAX_QUEUE = 50, MAX_TEXT = 100_000, KEEP_DONE_MS = 24 * 3600_000, KEEP_DONE = 200;
const TERMINAL = new Set(['done', 'failed', 'interrupted', 'cancelled']);
export const newMessageId = () => 'm_' + randomBytes(9).toString('base64url');

export async function coordinator(file, { runs, now = () => Date.now(), stopWaitMs = 15_000 } = {}) {
  let items = [];
  try { const raw = JSON.parse(await readFile(file, 'utf8')); items = Array.isArray(raw.items) ? raw.items : []; } catch { /* first run */ }
  // After a hub restart nothing is running: what was in flight is marked interrupted (never silently re-sent), the queue stays in order.
  for (const it of items) if (['sending', 'running', 'awaiting_stop', 'guidance_accepted'].includes(it.state)) it.state = it.state === 'guidance_accepted' ? 'interrupted' : it.state === 'awaiting_stop' ? 'queued' : 'interrupted';
  const slots = new Map(); // key -> { active, halted, chain, replacement }
  let writing = Promise.resolve();
  const keyOf = (scope, agent, session) => `${scope}\u0000${agent}\u0000${session || ''}`;
  const slot = (key) => { let s = slots.get(key); if (!s) { s = { active: null, halted: false, chain: Promise.resolve(), replacement: null }; slots.set(key, s); } return s; };
  // slots that have queued work after a restart start halted until the user resumes (or sends something)
  for (const it of items) if (it.state === 'queued') slot(keyOf(it.scope, it.agent, it.session)).halted = true;

  function save() {
    const t = now(); items = items.filter((i) => !TERMINAL.has(i.state) || t - i.updated < KEEP_DONE_MS);
    const done = items.filter((i) => TERMINAL.has(i.state)); if (done.length > KEEP_DONE) for (const d of done.slice(0, done.length - KEEP_DONE)) items.splice(items.indexOf(d), 1);
    const snap = JSON.stringify({ items }); const tmp = file + '.tmp';
    writing = writing.then(() => writeFile(tmp, snap, { mode: 0o600 }).then(() => rename(tmp, file))).catch(() => {}); return writing;
  }
  const set = (it, patch) => { Object.assign(it, patch, { updated: now() }); };
  const queueOf = (key) => items.filter((i) => keyOf(i.scope, i.agent, i.session) === key && i.state === 'queued');
  const view = (i) => ({ id: i.id, state: i.state, mode: i.mode, text: i.text, created: i.created, ...(i.error ? { error: i.error } : {}), ...(i.run ? { run_id: i.run } : {}), ...(i.note ? { note: i.note } : {}), ...(i.session ? { session_id: i.session } : {}) });
  const rekey = (it, from, to) => { // the hub learns the session id after the first reply started: move the slot with it
    const a = slots.get(from); if (!a || from === to) return; const b = slot(to); b.active ??= a.active; b.halted ||= a.halted; slots.delete(from);
    for (const x of items) if (keyOf(x.scope, x.agent, x.session) === from) x.session = it.session;
  };

  /** deps.launch(item, { rebuild }) -> run (a runs.js run). It must throw before any byte if the agent refuses. */
  async function start(s, key, it, deps) {
    set(it, { state: 'sending' }); await save();
    let run;
    try { run = await deps.launch(it, { rebuild: Boolean(it.behindOthers) }); }
    catch (e) { set(it, { state: 'failed', error: e.safe ? e.message : 'Could not start the reply' }); s.halted = true; await save(); return null; }
    const before = it.session; s.active = run; set(it, { state: 'running', run: run.id, session: run.session || it.session });
    if (it.session !== before) rekey(it, key, keyOf(it.scope, it.agent, it.session));
    await save();
    const prev = run.onFinish; // chain with the history writer set by launch()
    run.onFinish = (r, state) => { try { prev?.(r, state); } catch { /* best effort */ } void finished(deps, it, r, state); };
    if (run.done) void finished(deps, it, run, run.state);
    return run;
  }
  async function finished(deps, it, r, state) {
    if (it.finishedOnce) return; it.finishedOnce = true;
    const key = keyOf(it.scope, it.agent, r.session || it.session), s = slot(key); if (s.active === r) s.active = null;
    set(it, { state: state === 'done' ? 'done' : state === 'stopped' ? 'interrupted' : 'failed', ...(state === 'error' ? { error: r.link?.error || 'The reply failed' } : {}) });
    // guidance the agent accepted but never used comes back once, as the next message
    for (const [n, text] of (r.link?.pendingSteer ?? []).entries()) {
      const pid = `ps_${r.id}_${n}`; if (items.some((x) => x.id === pid)) continue;
      items.push({ id: pid, scope: it.scope, agent: it.agent, session: r.session || it.session, mode: 'queue', text, message: { role: 'user', content: text }, state: 'queued', created: now(), updated: now(), note: 'unused_guidance', behindOthers: true });
    }
    await save();
    if (s.replacement) { const rep = s.replacement; s.replacement = null; await begin(deps, key, s, rep); return; }
    if (state === 'done' && !s.halted) await drain(deps, key, s); else if (state !== 'done' && !s.replacement && queueOf(key).length) s.halted = true;
  }
  async function begin(deps, key, s, it) { const k2 = keyOf(it.scope, it.agent, it.session) ; await start(s, k2 === key ? key : k2, it, deps); }
  async function drain(deps, key, s) {
    if (s.active || s.halted) return;
    const next = queueOf(key)[0]; if (!next) return; next.behindOthers = true;
    const run = await start(s, key, next, deps); if (!run && !s.active) return;
  }

  return {
    keyOf,
    view,
    /** Admission. Resolves with the stored message (and the run id if it started right now). */
    submit(deps, { scope, agent, session, mode, text, message, body, clientId, modes }) {
      const key = keyOf(scope, agent, session), s = slot(key);
      const job = s.chain.then(async () => {
        const dup = clientId && items.find((i) => i.scope === scope && i.agent === agent && i.client === clientId); if (dup) return { message: view(dup), duplicate: true };
        if (!modes.includes(mode)) throw fault(400, mode === 'steer' ? 'This agent cannot be steered while it works' : 'That send mode is not available for this agent');
        if (typeof text !== 'string' || !text.trim() && !(message && Array.isArray(message.content))) throw fault(400, 'Empty message');
        if (text.length > MAX_TEXT) throw fault(413, 'Message too long');
        if (queueOf(key).length >= MAX_QUEUE) throw fault(429, 'The queue is full; wait for the agent or clear it');
        const it = { id: newMessageId(), scope, agent, session: session || '', mode, text: text.slice(0, MAX_TEXT), message, state: 'queued', created: now(), updated: now(), ...(clientId ? { client: clientId } : {}) };
        if (body) Object.defineProperty(it, 'body', { value: body, enumerable: false, writable: true });
        const active = s.active && !s.active.done ? s.active : null;
        items.push(it);
        if (mode === 'steer' && !active?.link?.steer) { items.splice(items.indexOf(it), 1); throw fault(409, 'There is no running reply to steer'); }
        if (active && mode === 'steer') { // control path: straight to the run, no lock held while it works
          try { await active.link.steer(it.text); set(it, { state: 'guidance_accepted', run: active.id, note: 'accepted_not_consumed' }); active.link.steers = [...(active.link.steers ?? []), it.id]; }
          catch (e) { set(it, { state: 'queued', behindOthers: true, note: e.notRunning ? 'steer_rejected_run_ended' : 'steer_failed', error: e.notRunning ? undefined : 'Guidance was not accepted; your text is queued instead' }); }
          await save(); return { message: view(it), run_id: active.id };
        }
        if (active && mode === 'interrupt') {
          if (s.replacement) { it.behindOthers = true; set(it, { state: 'queued', note: 'after_interrupt' }); await save(); return { message: view(it) }; } // never two writers: later messages wait their turn
          set(it, { state: 'awaiting_stop' }); s.replacement = it; await save();
          void (async () => { // the stop may take a while: answer now, finish in the background
            const ok = await runs.stopAndWait(active, stopWaitMs).catch(() => false);
            if (!ok && s.replacement === it) { s.replacement = null; it.behindOthers = true; set(it, { state: 'queued', error: 'The running reply could not be stopped, so your message is waiting. Stop it, or try again.', note: 'stop_failed' }); s.halted = true; await save(); }
            // on success the run's finish handler starts the replacement
          })();
          return { message: view(it) };
        }
        // idle or queue
        if (!active && !s.replacement) { s.halted = false; if (!queueOf(key).filter((x) => x !== it).length) { it.behindOthers = false; const run = await start(s, key, it, deps); return { message: view(it), ...(run ? { run_id: run.id, session_id: run.session || undefined } : {}) }; } }
        it.behindOthers = true; s.halted = false; await save();
        if (!active && !s.replacement) void drain(deps, key, s);
        return { message: view(it) };
      });
      s.chain = job.catch(() => {}); return job;
    },
    list(scope, agent, session) {
      const key = keyOf(scope, agent, session), s = slots.get(key);
      return { items: items.filter((i) => keyOf(i.scope, i.agent, i.session) === key && !TERMINAL.has(i.state)).map(view), recent: items.filter((i) => keyOf(i.scope, i.agent, i.session) === key && TERMINAL.has(i.state)).slice(-10).map(view), halted: Boolean(s?.halted), active_run: s?.active && !s.active.done ? s.active.id : null };
    },
    /** The user pressed Stop: confirm termination, then stop auto-draining. */
    async stop(scope, agent, session, run) {
      const s = slot(keyOf(scope, agent, session)); s.halted = true; if (s.replacement) { const r = s.replacement; s.replacement = null; set(r, { state: 'queued', note: 'stop_pressed' }); await save(); }
      const ok = await runs.stopAndWait(run, stopWaitMs); return ok;
    },
    async resume(deps, scope, agent, session) { const key = keyOf(scope, agent, session), s = slot(key); s.halted = false; await drain(deps, key, s); return this.list(scope, agent, session); },
    async cancel(scope, agent, session, id) { const it = items.find((i) => i.id === id && i.scope === scope && i.agent === agent); if (!it || it.state !== 'queued') throw fault(404, 'That message is not waiting any more'); set(it, { state: 'cancelled' }); await save(); return view(it); },
    async flush() { await save(); await writing; },
    items: () => items,
  };
}
