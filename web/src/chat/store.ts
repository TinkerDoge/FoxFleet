import { useEffect, useState } from 'preact/hooks';
import type { Client, OpenRequest, QueuedMessage, SendMode } from '../api/client';
import type { SessionInfo } from '../api/types';
import { ApiError, AuthRequiredError, NetworkError } from '../api/errors';
import type { UiMessage, UiImage } from '../lib/chat';
import { composeWithFiles, type FileRef } from '../lib/files';
import { scrubAddresses } from '../lib/registry';
import { t } from '../i18n/t';
import { discardDraft, draftKey, moveDraft, resetDrafts, restoreDraft } from './drafts';
import { clearSaved, loadSaved, saveChat } from '../lib/persist';

export interface ChatState {
  agent: string; messages: UiMessage[]; session?: string; streaming: boolean;
  streamText: string; streamReasoning: string; tool?: string; error?: string; sessions: SessionInfo[]; sessionsTotal: number; sessionsLoading: boolean; sessionsError?: string; skills: string[]; loading: boolean;
  runState?: 'submitting' | 'accepted' | 'working' | 'completed' | 'failed' | 'stopped' | 'disconnected' | 'unknown';
  recovery?: 'reload' | 'reconnect' | 'check' | 'retry';
  hasOlder: boolean; loadingOlder: boolean; olderOffset: number;
  /** Messages the hub holds for this conversation (queued, waiting for a stop, guidance accepted) and whether draining is paused. */
  queue: QueueItem[]; halted: boolean;
  /** Questions and approvals the agent is waiting on (native sessions); a card each, answered once. */
  requests: OpenRequest[];
  /** Tools the agent used in the current reply, newest last. */
  toolLog: string[];
  /** False when the agent keeps the queue itself (Hermes): a queued message cannot be taken back from here. */
  canCancel: boolean;
}
export interface QueueItem extends QueuedMessage { images?: UiImage[] }
const dismissed = new Set<string>();
const states = new Map<string, ChatState>(); const aborts = new Map<string, AbortController>(); const runIds = new Map<string, string>(); const subs = new Set<() => void>();
const selections = new Map<string, symbol>();
let account = Symbol();
const selection = (agent: string) => { let key = selections.get(agent); if (!key) { key = Symbol(); selections.set(agent, key); } return key; };
const select = (agent: string) => { const key = Symbol(); selections.set(agent, key); return key; };
const fresh = (agent: string): ChatState => ({ agent, messages: [], streaming: false, streamText: '', streamReasoning: '', sessions: [], sessionsTotal: 0, sessionsLoading: false, skills: [], loading: false, hasOlder: false, loadingOlder: false, olderOffset: 0, queue: [], halted: false, requests: [], toolLog: [], canCancel: true });
export const chatOf = (agent: string): ChatState => { let s = states.get(agent); if (!s) { s = fresh(agent); states.set(agent, s); } return s; };
function patch(agent: string, p: Partial<ChatState>) { states.set(agent, { ...chatOf(agent), ...p }); subs.forEach((f) => f()); }
export function useChat(agent: string): ChatState {
  const [, bump] = useState(0);
  useEffect(() => { const f = () => bump((n) => n + 1); subs.add(f); return () => { subs.delete(f); }; }, []);
  return chatOf(agent);
}
export const resetChats = () => { account = Symbol(); aborts.forEach((a) => a.abort()); aborts.clear(); runIds.clear(); selections.clear(); states.clear(); dismissed.clear(); localImages.clear(); submitting.clear(); resetDrafts(); subs.forEach((f) => f()); };

const friendly = (e: unknown) => e instanceof NetworkError ? t('error.network') : e instanceof ApiError ? scrubAddresses(e.message) : t('error.generic');

export async function loadAgent(client: Client, agent: string, onAuthLost: () => void) {
  const context = account;
  await Promise.all([loadSessions(client, agent, false, onAuthLost), (async () => {
    try { const skills = await client.skills(agent); if (account === context) patch(agent, { skills }); }
    catch (e) { if (account === context && e instanceof AuthRequiredError) onAuthLost(); }
  })()]);
}
export async function openSession(client: Client, agent: string, id: string, onAuthLost: () => void, discoverRun = false) {
  const key = select(agent);
  detach(agent); saveChat(agent, { session: id, run: undefined, user: undefined }); patch(agent, { loading: true, error: undefined, recovery: undefined, runState: undefined, session: id, queue: [], halted: false, requests: [], toolLog: [], messages: [], streaming: false, streamText: '', streamReasoning: '', tool: undefined, hasOlder: false, loadingOlder: false, olderOffset: 0 });
  try { const page = await client.messages(agent, id); if (selections.get(agent) !== key) return; patch(agent, { messages: page.messages, hasOlder: page.hasMore, olderOffset: PAGE, loading: discoverRun }); }
  catch (e) { if (selections.get(agent) !== key) return; if (e instanceof AuthRequiredError) { onAuthLost(); return; } patch(agent, { loading: false, error: friendly(e), recovery: 'reload' }); }
}
const PAGE = 80;
/** Scrolling up: fetch the next older page and put it in front. */
export async function loadOlder(client: Client, agent: string, onAuthLost: () => void) {
  const c = chatOf(agent); if (!c.session || !c.hasOlder || c.loadingOlder || c.loading) return;
  const key = selection(agent);
  patch(agent, { loadingOlder: true });
  try { const page = await client.messages(agent, c.session, { offset: c.olderOffset }); const cur = chatOf(agent); if (selections.get(agent) !== key) return; patch(agent, { messages: [...page.messages, ...cur.messages], hasOlder: page.hasMore, olderOffset: c.olderOffset + PAGE, loadingOlder: false }); }
  catch (e) { if (selections.get(agent) !== key) return; if (e instanceof AuthRequiredError) { onAuthLost(); return; } patch(agent, { loadingOlder: false, error: friendly(e), recovery: 'reload' }); }
}
/** History list: first page (reset) or the next page appended. */
export async function loadSessions(client: Client, agent: string, more = false, onAuthLost: () => void = () => {}) {
  const c = chatOf(agent); if (c.sessionsLoading) return;
  patch(agent, { sessionsLoading: true });
  const context = account;
  try { const page = await client.sessions(agent, { offset: more ? c.sessions.length : 0 }); if (account !== context) return; patch(agent, { sessions: more ? [...c.sessions, ...page.sessions.filter((s) => !c.sessions.some((x) => x.id === s.id))] : page.sessions, sessionsTotal: page.total, sessionsLoading: false, sessionsError: undefined }); }
  catch (e) { if (account !== context) return; if (e instanceof AuthRequiredError) { patch(agent, { sessionsLoading: false }); onAuthLost(); return; } patch(agent, { sessionsLoading: false, sessionsError: t('chat.historyFailed') }); }
}
export async function renameSession(client: Client, agent: string, id: string, title: string) {
  await client.renameSession(agent, id, title); patch(agent, { sessions: chatOf(agent).sessions.map((s) => (s.id === id ? { ...s, title } : s)) });
}
export async function deleteSession(client: Client, agent: string, id: string) {
  await client.deleteSession(agent, id); discardDraft(draftKey(agent, id)); const c = chatOf(agent); patch(agent, { sessions: c.sessions.filter((s) => s.id !== id), sessionsTotal: Math.max(0, c.sessionsTotal - 1) });
  if (c.session === id) { newChat(agent); return true; }
  return false;
}
/** A small bot-style line in the chat (a confirmation), not sent to the agent. */
export function notice(agent: string, text: string) { patch(agent, { messages: [...chatOf(agent).messages, { role: 'system', content: text, ts: Date.now() }] }); }
export function newChat(agent: string, preserveDraft = false) { select(agent); detach(agent); clearSaved(agent); if (!preserveDraft) discardDraft(draftKey(agent)); // Back to a blank conversation restores its draft; an explicit New starts fresh.
  patch(agent, { messages: [], session: undefined, error: undefined, recovery: undefined, runState: undefined, loading: false, loadingOlder: false, streaming: false, streamText: '', streamReasoning: '', tool: undefined, hasOlder: false, queue: [], halted: false, requests: [], toolLog: [] }); }
/** Leaves the screen without cancelling anything: the hub keeps the agent running and the reply can be picked up later. */
function detach(agent: string) { aborts.get(agent)?.abort(); aborts.delete(agent); runIds.delete(agent); }
const stoppedBy = new WeakSet<AbortController>(), localImages = new Map<string, UiImage[]>(), submitting = new Map<string, number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The explicit Stop button: cancels the agent's run on the hub (which then pauses the queue), then closes the stream. The partial reply stays, marked interrupted. */
export function stop(agent: string, client?: Client) {
  const run = runIds.get(agent), ctrl = aborts.get(agent);
  if (ctrl) stoppedBy.add(ctrl);
  if (run && client) void client.stopRun(agent, run).catch(() => {}).then(() => syncQueue(client, agent, () => {}));
  ctrl?.abort(); aborts.delete(agent); runIds.delete(agent); clearRun(agent);
}
const clearRun = (agent: string) => saveChat(agent, { run: undefined, user: undefined, started: undefined });
/** Every callback is bound to one stream: once the user opened another chat, started a new one or pressed Stop, that stream's late events are ignored. */
const callbacks = (agent: string, ctrl: AbortController, acc: Acc) => {
  const live = () => aborts.get(agent) === ctrl;
  return {
    signal: ctrl.signal,
    onSession: (id: string) => { if (!live()) return; const prev = chatOf(agent).session; if (prev !== id) moveDraft(draftKey(agent, prev), draftKey(agent, id)); saveChat(agent, { session: id }); patch(agent, { session: id }); },
    onRun: (id: string) => { if (!live()) return; runIds.set(agent, id); saveChat(agent, { run: id }); patch(agent, { runState: 'accepted' }); },
    onGap: () => { if (!live()) return; acc.reply = ''; patch(agent, { streamText: '' }); },
    onContent: (d: string) => { if (!live()) return; acc.reply += d; patch(agent, { streamText: acc.reply, tool: undefined, runState: 'working' }); },
    onReasoning: (d: string) => { if (!live()) return; acc.reasoning += d; patch(agent, { streamReasoning: acc.reasoning, runState: 'working' }); },
    onTool: (label: string) => { if (live()) { const log = chatOf(agent).toolLog; patch(agent, { tool: label, runState: 'working', toolLog: log[log.length - 1] === label ? log : [...log, label].slice(-12) }); } },
    // cards come and go with the agent's own events; the id is the only key, so a late or repeated event changes nothing
    onRequest: (r: OpenRequest) => { if (live() && !chatOf(agent).requests.some((x) => x.id === r.id)) patch(agent, { requests: [...chatOf(agent).requests, r] }); },
    onRequestClosed: (id: string) => { if (live()) patch(agent, { requests: chatOf(agent).requests.filter((x) => x.id !== id) }); },
    onAck: (id: string, ack: import('../api/client').Ack) => { if (live()) patch(agent, { queue: chatOf(agent).queue.map((q) => (q.id === id ? { ...q, ack } : q)) }); },
    onRunState: (state: string) => { if (live()) acc.state = state; },
  };
};
interface Acc { reply: string; reasoning: string; state?: string; selection: symbol }
/** Ends a stream: the partial or full reply is kept (marked interrupted if it was stopped); a stale stream (another chat is open now) changes nothing. */
function settle(agent: string, ctrl: AbortController, base: UiMessage[], acc: Acc, extra: Partial<ChatState> = {}): boolean {
  if (selections.get(agent) !== acc.selection || (aborts.get(agent) !== ctrl && !stoppedBy.has(ctrl))) return false;
  const interrupted = stoppedBy.has(ctrl) || acc.state === 'stopped';
  const reply: UiMessage[] = acc.reply || acc.reasoning ? [{ role: 'assistant', content: acc.reply, ...(acc.reasoning ? { reasoning: acc.reasoning } : {}), ...(interrupted ? { interrupted: true } : {}) }] : [];
  patch(agent, { messages: [...base, ...reply], streaming: false, streamText: '', streamReasoning: '', tool: undefined, toolLog: [], requests: [], runState: interrupted ? 'stopped' : acc.state === 'error' ? 'failed' : acc.state === 'unavailable' ? 'unknown' : 'completed', ...(acc.state === 'error' || acc.state === 'unavailable' ? { error: t(acc.state === 'error' ? 'chat.runFailed' : 'chat.runUnavailable'), recovery: 'check' as const } : {}), ...extra });
  return true;
}

/** Follows a hub run (a reply that was already running, or the next queued message that just started) and keeps it in the transcript. */
async function followRun(client: Client, agent: string, run: string, item: QueueItem | undefined, onAuthLost: () => void) {
  const cur = chatOf(agent), replaying = cur.runState === 'disconnected' && loadSaved(agent).run === run;
  const history = replaying && cur.messages.at(-1)?.role === 'assistant' ? cur.messages.slice(0, -1) : cur.messages, last = history[history.length - 1];
  const user: UiMessage[] = item && !(last?.role === 'user' && last.content === item.text) ? [{ role: 'user', content: item.text, ...(item.images?.length ? { images: item.images } : {}) }] : [];
  const base = [...history, ...user], ctrl = new AbortController(); aborts.set(agent, ctrl); runIds.set(agent, run);
  const acc: Acc = { reply: '', reasoning: '', selection: selection(agent) };
  saveChat(agent, { run });
  patch(agent, { messages: base, streaming: true, streamText: '', streamReasoning: '', tool: undefined, error: undefined, recovery: undefined, runState: 'accepted' });
  try { await client.follow(agent, run, 0, callbacks(agent, ctrl, acc)); settle(agent, ctrl, base, acc); if (aborts.get(agent) === ctrl && acc.state !== 'unavailable') clearRun(agent); }
  catch (e) { if ((e as Error).name !== 'AbortError') { if (e instanceof AuthRequiredError) onAuthLost(); settle(agent, ctrl, base, acc, failure(agent, e)); } else settle(agent, ctrl, base, acc); }
  finally { if (aborts.get(agent) === ctrl) { aborts.delete(agent); runIds.delete(agent); } }
  if (selections.get(agent) === acc.selection && !chatOf(agent).error) void syncQueue(client, agent, onAuthLost);
}

/**
 * Reads the hub's queue for this conversation: shows what is waiting, and follows the next reply when the hub has started one
 * (a queued message, or the replacement after Interrupt & send). Safe to call any time: after a send, a finished reply, a reload or a reconnect.
 */
export async function syncQueue(client: Client, agent: string, onAuthLost: () => void, attempts = 0) {
  const c = chatOf(agent), key = selection(agent); let q;
  try { q = await client.queue(agent, c.session); } catch (e) { if (e instanceof AuthRequiredError) onAuthLost(); return; }
  if (selections.get(agent) !== key) return; // the user moved on to another chat
  const running = q.items.find((i) => i.runId && i.runId === q.activeRun);
  const gone = chatOf(agent).queue.filter((x) => (x.state === 'guidance_accepted' || (x.state === 'queued' && x.ack === 'queued')) && !q.items.some((i) => i.id === x.id)); // the run ended (guidance) or Hermes started the queued turn itself // the run ended: the guidance becomes part of the transcript
  if (gone.length) patch(agent, { messages: [...chatOf(agent).messages, ...gone.map((g): UiMessage => ({ role: 'user', content: g.text, ...(g.images?.length ? { images: g.images } : {}) }))] });
  if (!submitting.get(agent)) patch(agent, { queue: q.items.filter((i) => !dismissed.has(i.id) && i !== running && i.state !== 'sending' && i.state !== 'running').map((i) => ({ ...i, images: localImages.get(i.id) })), halted: q.halted, canCancel: q.canCancel, requests: q.openRequests });
  if (q.activeRun && !runIds.has(agent) && !chatOf(agent).streaming) { await followRun(client, agent, q.activeRun, running ? { ...running, images: localImages.get(running.id) } : undefined, onAuthLost); return; }
  if (!q.activeRun && !q.halted && attempts < 12 && q.items.some((i) => i.state === 'queued' || i.state === 'awaiting_stop')) { await sleep(300); return syncQueue(client, agent, onAuthLost, attempts + 1); }
}
export async function resumeQueue(client: Client, agent: string, onAuthLost: () => void) {
  try { await client.resumeQueue(agent, chatOf(agent).session); } catch (e) { if (e instanceof AuthRequiredError) onAuthLost(); }
  await syncQueue(client, agent, onAuthLost);
}
export async function cancelQueued(client: Client, agent: string, id: string) {
  const item = chatOf(agent).queue.find((q) => q.id === id);
  dismissed.add(id); // a message Hermes refused is only hidden here; Hermes keeps no copy to take back
  try { await client.cancelQueued(agent, id, chatOf(agent).session); } catch { /* it may have started meanwhile, or the agent holds the queue itself */ }
  patch(agent, { queue: chatOf(agent).queue.filter((q) => q.id !== id) });
  if (item) restoreDraft(draftKey(agent, chatOf(agent).session), item.text); // taking a message back puts its text in the composer
}

/**
 * After a reload, a closed tab or a new device: reopen the remembered session and, if its reply was still being written
 * (or finished while we were away), reattach to the hub's run and keep streaming it. The hub's queue and halted state come back too.
 */
export async function restore(client: Client, agent: string, wanted: string | undefined, onAuthLost: () => void, force = false) {
  const cur = chatOf(agent);
  if (wanted === '') { if (cur.session || cur.messages.length || cur.streaming || cur.loading) newChat(agent, true); return; }
  const saved = loadSaved(agent), session = wanted ?? saved.session; if (!session) return;
  if (!force && cur.session === session && (cur.streaming || cur.loading || !cur.error)) return;
  const opened = openSession(client, agent, session, onAuthLost, true), key = selection(agent); await opened;
  if (selections.get(agent) !== key || chatOf(agent).error) return;
  let run; try { run = (await client.runs(agent, session)).sort((a, b) => b.started - a.started)[0]; }
  catch (e) { if (selections.get(agent) !== key) return; if (e instanceof AuthRequiredError) { onAuthLost(); return; } patch(agent, { loading: false, error: friendly(e), recovery: 'check', runState: 'unknown' }); if (saved.session === session && saved.run) { saveChat(agent, { run: saved.run, user: saved.user }); patch(agent, { recovery: 'reconnect', runState: 'disconnected' }); } return; }
  if (selections.get(agent) !== key) return;
  patch(agent, { loading: false });
  const history = chatOf(agent).messages, endsWithReply = history[history.length - 1]?.role === 'assistant';
  if (!run || ((run.state !== 'running' && run.state !== 'stopping') && endsWithReply)) { clearRun(agent); void syncQueue(client, agent, onAuthLost); return; }
  const item: QueueItem | undefined = saved.session === session && saved.user && history[history.length - 1]?.content !== saved.user ? { id: 'saved', state: 'running', mode: 'queue', text: saved.user } : undefined;
  await followRun(client, agent, run.id, item, onAuthLost);
}

/** A known run can be resumed. An uncertain submission must be checked before any new task is sent. */
const failure = (agent: string, e: unknown): Partial<ChatState> => {
  const known = !!runIds.get(agent);
  const rejected = !known && e instanceof ApiError && [400, 403, 404, 422, 429].includes(e.status);
  return { error: friendly(e), runState: known ? 'disconnected' : rejected ? 'failed' : 'unknown', recovery: known ? 'reconnect' : rejected ? 'retry' : 'check' };
};

export async function reconnectReply(client: Client, agent: string, onAuthLost: () => void) {
  const saved = loadSaved(agent), cur = chatOf(agent); if (cur.streaming || cur.loading) return;
  // A run ID is sufficient even when the original stream dropped before delivering a session ID.
  if (saved.run && !cur.session) { await followRun(client, agent, saved.run, undefined, onAuthLost); return; }
  if (cur.session) await restore(client, agent, cur.session, onAuthLost, true);
}

const PENDING = new Set(['queued', 'awaiting_stop', 'sending', 'failed']);
const uid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `c${Date.now()}${Math.random().toString(36).slice(2)}`);
/**
 * Send. Idle: start the reply and stream it. Busy (a reply is running, or messages are waiting): never dropped, never overwriting the
 * transcript: the hub stores it first and applies the chosen mode (steer / queue / interrupt & send).
 */
export async function send(client: Client, agent: string, text: string, images: UiImage[], files: FileRef[], onAuthLost: () => void, mode: SendMode = 'interrupt') {
  const cur = chatOf(agent), user: UiMessage = { role: 'user', content: composeWithFiles(text, files), ...(images.length ? { images } : {}) };
  if (cur.loading) return;
  if (cur.streaming || cur.queue.some((q) => PENDING.has(q.state))) return submitBusy(client, agent, user, mode, onAuthLost);
  const base = [...cur.messages, user];
  patch(agent, { messages: base, streaming: true, streamText: '', streamReasoning: '', tool: undefined, error: undefined, recovery: undefined, runState: 'submitting' });
  const ctrl = new AbortController(); aborts.set(agent, ctrl);
  saveChat(agent, { user: user.content, started: Date.now(), run: undefined });
  const acc: Acc = { reply: '', reasoning: '', selection: selection(agent) };
  try {
    const sid = await client.chat(agent, base, { sessionId: cur.session, ...callbacks(agent, ctrl, acc) });
    if (settle(agent, ctrl, base, acc, sid ? { session: sid } : {})) { if (acc.state !== 'unavailable') clearRun(agent); void loadSessions(client, agent, false, onAuthLost); }
  } catch (e) {
    if ((e as Error).name === 'AbortError') settle(agent, ctrl, base, acc);
    else { if (e instanceof AuthRequiredError) onAuthLost(); settle(agent, ctrl, base, acc, failure(agent, e)); if (selections.get(agent) === acc.selection && e instanceof ApiError && e.status === 409) void syncQueue(client, agent, onAuthLost); }
  } finally { if (aborts.get(agent) === ctrl) { aborts.delete(agent); runIds.delete(agent); } }
  if (selections.get(agent) === acc.selection && !chatOf(agent).error) void syncQueue(client, agent, onAuthLost);
}
async function submitBusy(client: Client, agent: string, user: UiMessage, mode: SendMode, onAuthLost: () => void) {
  const cur = chatOf(agent), clientId = uid(), images = user.images ?? [];
  const local: QueueItem = { id: clientId, text: user.content, mode, images, state: mode === 'interrupt' ? 'awaiting_stop' : mode === 'queue' ? 'queued' : 'sending' };
  localImages.set(clientId, images); submitting.set(agent, (submitting.get(agent) ?? 0) + 1);
  patch(agent, { queue: [...cur.queue, local], error: undefined });
  try {
    const r = await client.sendMessage(agent, { messages: [user], sessionId: cur.session, mode, clientId });
    localImages.set(r.message.id, images);
    patch(agent, { queue: chatOf(agent).queue.map((q) => (q.id === clientId ? { ...r.message, images } : q)) });
  } catch (e) { // the hub did not take it (e.g. 409/400): the text goes back to the composer, nothing is lost
    patch(agent, { queue: chatOf(agent).queue.filter((q) => q.id !== clientId), error: friendly(e) }); restoreDraft(draftKey(agent, cur.session), user.content);
    if (e instanceof AuthRequiredError) onAuthLost();
  } finally { submitting.set(agent, Math.max(0, (submitting.get(agent) ?? 1) - 1)); }
  void syncQueue(client, agent, onAuthLost);
}

/** /retry: drop the last assistant reply (if any) and send the last user message again. */
export async function retryLast(client: Client, agent: string, onAuthLost: () => void) {
  const c = chatOf(agent); if (c.streaming || c.loading) return;
  const msgs = [...c.messages]; while (msgs.length && msgs[msgs.length - 1].role !== 'user') msgs.pop();
  const last = msgs.pop(); if (!last) return;
  patch(agent, { messages: msgs });
  await send(client, agent, last.content, last.images ?? [], [], onAuthLost);
}

/** Answers a card. The card goes away once the hub took the answer; if it was already closed elsewhere (404) it goes away as well. */
export async function answerRequest(client: Client, agent: string, id: string, result: Record<string, unknown>, onAuthLost: () => void): Promise<string | null> {
  const c = chatOf(agent); if (!c.session) return 'no session';
  const drop = () => patch(agent, { requests: chatOf(agent).requests.filter((x) => x.id !== id) });
  try { await client.answerRequest(agent, c.session, id, result); drop(); return null; }
  catch (e) { if (e instanceof AuthRequiredError) { onAuthLost(); return 'sign-in'; } if (e instanceof ApiError && e.status === 404) { drop(); return null; } return friendly(e); }
}
