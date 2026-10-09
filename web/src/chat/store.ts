import { useEffect, useState } from 'preact/hooks';
import type { Client } from '../api/client';
import type { SessionInfo } from '../api/types';
import { ApiError, AuthRequiredError, NetworkError } from '../api/errors';
import type { UiMessage, UiImage } from '../lib/chat';
import { composeWithFiles, type FileRef } from '../lib/files';
import { scrubAddresses } from '../lib/registry';
import { t } from '../i18n/t';
import { clearSaved, loadSaved, saveChat } from '../lib/persist';

export interface ChatState {
  agent: string; messages: UiMessage[]; session?: string; streaming: boolean;
  streamText: string; streamReasoning: string; tool?: string; error?: string; sessions: SessionInfo[]; skills: string[]; loading: boolean;
}
const states = new Map<string, ChatState>(); const aborts = new Map<string, AbortController>(); const runIds = new Map<string, string>(); const subs = new Set<() => void>();
const fresh = (agent: string): ChatState => ({ agent, messages: [], streaming: false, streamText: '', streamReasoning: '', sessions: [], skills: [], loading: false });
export const chatOf = (agent: string): ChatState => { let s = states.get(agent); if (!s) { s = fresh(agent); states.set(agent, s); } return s; };
function patch(agent: string, p: Partial<ChatState>) { states.set(agent, { ...chatOf(agent), ...p }); subs.forEach((f) => f()); }
export function useChat(agent: string): ChatState {
  const [, bump] = useState(0);
  useEffect(() => { const f = () => bump((n) => n + 1); subs.add(f); return () => { subs.delete(f); }; }, []);
  return chatOf(agent);
}
export const resetChats = () => { aborts.forEach((a) => a.abort()); aborts.clear(); runIds.clear(); states.clear(); subs.forEach((f) => f()); };

const friendly = (e: unknown) => e instanceof NetworkError ? t('error.network') : e instanceof ApiError ? scrubAddresses(e.message) : t('error.generic');

export async function loadAgent(client: Client, agent: string, onAuthLost: () => void) {
  patch(agent, { loading: true });
  try {
    const [sessions, skills] = await Promise.all([client.sessions(agent).catch(() => [] as SessionInfo[]), client.skills(agent)]);
    patch(agent, { sessions, skills, loading: false });
  } catch (e) { if (e instanceof AuthRequiredError) onAuthLost(); patch(agent, { loading: false }); }
}
export async function openSession(client: Client, agent: string, id: string, onAuthLost: () => void) {
  detach(agent); saveChat(agent, { session: id, run: undefined, user: undefined }); patch(agent, { loading: true, error: undefined, session: id, messages: [], streaming: false, streamText: '', streamReasoning: '', tool: undefined });
  try { patch(agent, { messages: await client.messages(agent, id), loading: false }); }
  catch (e) { if (e instanceof AuthRequiredError) onAuthLost(); patch(agent, { loading: false, error: friendly(e) }); }
}
export function newChat(agent: string) { detach(agent); clearSaved(agent); patch(agent, { messages: [], session: undefined, error: undefined, streamText: '', streamReasoning: '', tool: undefined }); }
/** Leaves the screen without cancelling anything: the hub keeps the agent running and the reply can be picked up later. */
function detach(agent: string) { aborts.get(agent)?.abort(); aborts.delete(agent); runIds.delete(agent); }
/** The explicit Stop button: cancels the agent's run on the hub, then closes the stream. */
export function stop(agent: string, client?: Client) {
  const run = runIds.get(agent); if (run && client) void client.stopRun(agent, run).catch(() => {});
  aborts.get(agent)?.abort(); aborts.delete(agent); runIds.delete(agent); clearRun(agent);
}
const clearRun = (agent: string) => saveChat(agent, { run: undefined, user: undefined, started: undefined });
const callbacks = (agent: string, ctrl: AbortController, acc: { reply: string; reasoning: string }) => ({
  signal: ctrl.signal,
  onSession: (id: string) => { saveChat(agent, { session: id }); patch(agent, { session: id }); },
  onRun: (id: string) => { runIds.set(agent, id); saveChat(agent, { run: id }); },
  onGap: () => { acc.reply = ''; patch(agent, { streamText: '' }); },
  onContent: (d: string) => { acc.reply += d; patch(agent, { streamText: acc.reply, tool: undefined }); },
  onReasoning: (d: string) => { acc.reasoning += d; patch(agent, { streamReasoning: acc.reasoning }); },
  onTool: (label: string) => patch(agent, { tool: label }),
});

/**
 * After a reload, a closed tab or a new device: reopen the remembered session and, if its reply was still being written
 * (or finished while we were away), reattach to the hub's run and keep streaming it.
 */
export async function restore(client: Client, agent: string, wanted: string | undefined, onAuthLost: () => void) {
  const cur = chatOf(agent); if (cur.streaming || cur.messages.length || cur.session) return;
  const saved = loadSaved(agent), session = wanted ?? saved.session; if (!session) return;
  await openSession(client, agent, session, onAuthLost);
  let run; try { run = (await client.runs(agent, session)).sort((a, b) => b.started - a.started)[0]; } catch { return; }
  const history = chatOf(agent).messages, endsWithReply = history[history.length - 1]?.role === 'assistant';
  if (!run || (run.state !== 'running' && endsWithReply)) { clearRun(agent); return; }
  const user = saved.user && history[history.length - 1]?.content !== saved.user ? [{ role: 'user' as const, content: saved.user }] : [];
  const base = [...history, ...user], ctrl = new AbortController(); aborts.set(agent, ctrl); runIds.set(agent, run.id);
  const acc = { reply: '', reasoning: '' };
  patch(agent, { messages: base, streaming: true, streamText: '', streamReasoning: '' });
  try { await client.follow(agent, run.id, 0, callbacks(agent, ctrl, acc)); patch(agent, { messages: acc.reply ? [...base, { role: 'assistant', content: acc.reply, ...(acc.reasoning ? { reasoning: acc.reasoning } : {}) }] : base, streaming: false, streamText: '', streamReasoning: '' }); clearRun(agent); }
  catch (e) { if ((e as Error).name !== 'AbortError') { if (e instanceof AuthRequiredError) onAuthLost(); patch(agent, { messages: acc.reply ? [...base, { role: 'assistant', content: acc.reply }] : base, streaming: false, streamText: '', streamReasoning: '', error: friendly(e) }); } }
  finally { aborts.delete(agent); runIds.delete(agent); }
}

export async function send(client: Client, agent: string, text: string, images: UiImage[], files: FileRef[], onAuthLost: () => void) {
  const cur = chatOf(agent); if (cur.streaming) return;
  const user: UiMessage = { role: 'user', content: composeWithFiles(text, files), ...(images.length ? { images } : {}) };
  const history = [...cur.messages, user];
  patch(agent, { messages: history, streaming: true, streamText: '', streamReasoning: '', tool: undefined, error: undefined });
  const ctrl = new AbortController(); aborts.set(agent, ctrl);
  saveChat(agent, { user: user.content, started: Date.now(), run: undefined });
  const acc = { reply: '', reasoning: '' };
  try {
    const sid = await client.chat(agent, history, { sessionId: cur.session, ...callbacks(agent, ctrl, acc) });
    const reply = acc.reply, reasoning = acc.reasoning; clearRun(agent);
    patch(agent, { messages: [...history, { role: 'assistant', content: reply, ...(reasoning ? { reasoning } : {}) }], streaming: false, streamText: '', streamReasoning: '', tool: undefined, ...(sid ? { session: sid } : {}) });
    void client.sessions(agent).then((sessions) => patch(agent, { sessions })).catch(() => {});
  } catch (e) {
    const reply = acc.reply;
    if ((e as Error).name === 'AbortError') {
      patch(agent, { messages: reply ? [...history, { role: 'assistant', content: reply }] : history, streaming: false, streamText: '', streamReasoning: '', tool: undefined });
    } else {
      if (e instanceof AuthRequiredError) onAuthLost();
      patch(agent, { messages: reply ? [...history, { role: 'assistant', content: reply }] : history, streaming: false, streamText: '', streamReasoning: '', tool: undefined, error: friendly(e) });
    }
  } finally { aborts.delete(agent); runIds.delete(agent); }
}
