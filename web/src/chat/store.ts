import { useEffect, useState } from 'preact/hooks';
import type { Client } from '../api/client';
import type { SessionInfo } from '../api/types';
import { ApiError, AuthRequiredError, NetworkError } from '../api/errors';
import type { UiMessage, UiImage } from '../lib/chat';
import { composeWithFiles, type FileRef } from '../lib/files';
import { scrubAddresses } from '../lib/registry';
import { t } from '../i18n/t';

export interface ChatState {
  agent: string; messages: UiMessage[]; session?: string; streaming: boolean;
  streamText: string; streamReasoning: string; tool?: string; error?: string; sessions: SessionInfo[]; skills: string[]; loading: boolean;
}
const states = new Map<string, ChatState>(); const aborts = new Map<string, AbortController>(); const subs = new Set<() => void>();
const fresh = (agent: string): ChatState => ({ agent, messages: [], streaming: false, streamText: '', streamReasoning: '', sessions: [], skills: [], loading: false });
export const chatOf = (agent: string): ChatState => { let s = states.get(agent); if (!s) { s = fresh(agent); states.set(agent, s); } return s; };
function patch(agent: string, p: Partial<ChatState>) { states.set(agent, { ...chatOf(agent), ...p }); subs.forEach((f) => f()); }
export function useChat(agent: string): ChatState {
  const [, bump] = useState(0);
  useEffect(() => { const f = () => bump((n) => n + 1); subs.add(f); return () => { subs.delete(f); }; }, []);
  return chatOf(agent);
}
export const resetChats = () => { aborts.forEach((a) => a.abort()); aborts.clear(); states.clear(); subs.forEach((f) => f()); };

const friendly = (e: unknown) => e instanceof NetworkError ? t('error.network') : e instanceof ApiError ? scrubAddresses(e.message) : t('error.generic');

export async function loadAgent(client: Client, agent: string, onAuthLost: () => void) {
  patch(agent, { loading: true });
  try {
    const [sessions, skills] = await Promise.all([client.sessions(agent).catch(() => [] as SessionInfo[]), client.skills(agent)]);
    patch(agent, { sessions, skills, loading: false });
  } catch (e) { if (e instanceof AuthRequiredError) onAuthLost(); patch(agent, { loading: false }); }
}
export async function openSession(client: Client, agent: string, id: string, onAuthLost: () => void) {
  stop(agent); patch(agent, { loading: true, error: undefined, session: id, messages: [] });
  try { patch(agent, { messages: await client.messages(agent, id), loading: false }); }
  catch (e) { if (e instanceof AuthRequiredError) onAuthLost(); patch(agent, { loading: false, error: friendly(e) }); }
}
export function newChat(agent: string) { stop(agent); patch(agent, { messages: [], session: undefined, error: undefined, streamText: '', streamReasoning: '', tool: undefined }); }
export function stop(agent: string) { aborts.get(agent)?.abort(); aborts.delete(agent); }

export async function send(client: Client, agent: string, text: string, images: UiImage[], files: FileRef[], onAuthLost: () => void) {
  const cur = chatOf(agent); if (cur.streaming) return;
  const user: UiMessage = { role: 'user', content: composeWithFiles(text, files), ...(images.length ? { images } : {}) };
  const history = [...cur.messages, user];
  patch(agent, { messages: history, streaming: true, streamText: '', streamReasoning: '', tool: undefined, error: undefined });
  const ctrl = new AbortController(); aborts.set(agent, ctrl);
  let reply = '', reasoning = '';
  try {
    const sid = await client.chat(agent, history, {
      sessionId: cur.session, signal: ctrl.signal,
      onSession: (id) => patch(agent, { session: id }),
      onContent: (d) => { reply += d; patch(agent, { streamText: reply, tool: undefined }); },
      onReasoning: (d) => { reasoning += d; patch(agent, { streamReasoning: reasoning }); },
      onTool: (label) => patch(agent, { tool: label }),
    });
    patch(agent, { messages: [...history, { role: 'assistant', content: reply, ...(reasoning ? { reasoning } : {}) }], streaming: false, streamText: '', streamReasoning: '', tool: undefined, ...(sid ? { session: sid } : {}) });
    void client.sessions(agent).then((sessions) => patch(agent, { sessions })).catch(() => {});
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      patch(agent, { messages: reply ? [...history, { role: 'assistant', content: reply }] : history, streaming: false, streamText: '', streamReasoning: '', tool: undefined });
    } else {
      if (e instanceof AuthRequiredError) onAuthLost();
      patch(agent, { messages: reply ? [...history, { role: 'assistant', content: reply }] : history, streaming: false, streamText: '', streamReasoning: '', tool: undefined, error: friendly(e) });
    }
  } finally { aborts.delete(agent); }
}
