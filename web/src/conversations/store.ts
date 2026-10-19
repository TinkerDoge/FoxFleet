import { useEffect, useState } from 'preact/hooks';
import type { Client, OpenRequest } from '../api/client';
import type { Conversation, ConversationMedia, ConversationMention, ConversationMessage, ConversationPreferences } from '../api/types';
import { ApiError, AuthRequiredError, NetworkError } from '../api/errors';

/** A room's own transcript state. Rooms never share ChatState with a DM (no AgentSummary anywhere here). */
export interface RoomView {
  conversation?: Conversation;
  messages: ConversationMessage[];
  hasMore: boolean;
  cursor?: number;
  loading: boolean;
  loadingOlder: boolean;
  sending: boolean;
  error?: string;
  preferences?: ConversationPreferences;
  typing: Record<string, number>;
  /** Open Task-5 cards per agent member, keyed by the agent name the answer route expects. */
  requests: Record<string, OpenRequest[]>;
}
export interface ConversationsState {
  list: Conversation[];
  total: number;
  loading: boolean;
  error?: string;
  rooms: Record<string, RoomView>;
  live: 'idle' | 'connecting' | 'live' | 'offline';
  cursor?: string;
}
const emptyRoom = (): RoomView => ({ messages: [], hasMore: false, loading: false, loadingOlder: false, sending: false, typing: {}, requests: {} });
let state: ConversationsState = { list: [], total: 0, loading: false, rooms: {}, live: 'idle' };
const subs = new Set<() => void>();
let activeRoom: string | undefined;
let source: EventSource | undefined;
let typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const conversationsState = () => state;
export function useConversations(): ConversationsState {
  const [, bump] = useState(0);
  useEffect(() => { const f = () => bump((n) => n + 1); subs.add(f); return () => { subs.delete(f); }; }, []);
  return state;
}
function set(next: Partial<ConversationsState>) { state = { ...state, ...next }; subs.forEach((f) => f()); }
function setRoom(id: string, next: Partial<RoomView>) {
  const room = { ...(state.rooms[id] ?? emptyRoom()), ...next };
  set({ rooms: { ...state.rooms, [id]: room } });
}
export const roomView = (id: string): RoomView => state.rooms[id] ?? emptyRoom();
export function setActiveRoom(id: string | undefined) { activeRoom = id; }

const friendly = (e: unknown) => e instanceof NetworkError ? 'Can\'t reach the hub. Check your connection.' : e instanceof ApiError ? e.message : 'Something went wrong.';
const auth = (e: unknown, lost: () => void) => { if (e instanceof AuthRequiredError) { lost(); return true; } return false; };

const when = (c: Conversation) => Math.max(c.last_message_at ?? 0, c.updated_at ?? 0);
export function sortConversations(list: Conversation[]): Conversation[] {
  return [...list].sort((a, b) => when(b) - when(a) || a.title.localeCompare(b.title));
}
function mergeConversation(list: Conversation[], conversation: Conversation): Conversation[] {
  const at = list.findIndex((c) => c.id === conversation.id);
  const next = at < 0 ? [conversation, ...list] : list.map((c) => (c.id === conversation.id ? { ...c, ...conversation } : c));
  return sortConversations(next);
}

export async function loadConversations(client: Client, onAuthLost: () => void): Promise<void> {
  set({ loading: true, error: undefined });
  try {
    const page = await client.conversations();
    set({ list: sortConversations(page.conversations), total: page.total ?? page.conversations.length, loading: false });
  } catch (e) { if (auth(e, onAuthLost)) return; set({ loading: false, error: friendly(e) }); }
}

/** Reads the room cards of every agent member. A failed agent fetch keeps what that agent showed before. */
export async function refreshRoomRequests(client: Client, id: string, onAuthLost: () => void): Promise<void> {
  const room = roomView(id), conversation = room.conversation;
  if (!conversation) return;
  const agents = conversation.members.filter((m) => m.kind === 'agent');
  const rows = await Promise.all(agents.map(async (m) => {
    try { return [m.name, (await client.queue(m.name, id)).openRequests] as const; }
    catch (e) { if (e instanceof AuthRequiredError) onAuthLost(); return [m.name, room.requests[m.name] ?? []] as const; }
  }));
  setRoom(id, { requests: Object.fromEntries(rows) });
}

export async function loadRoom(client: Client, id: string, onAuthLost: () => void, force = false): Promise<void> {
  const cur = roomView(id);
  if (cur.loading && !force) return;
  setRoom(id, { loading: true, error: undefined });
  try {
    const [conversation, page] = await Promise.all([client.conversation(id), client.conversationMessages(id)]);
    setRoom(id, {
      conversation, messages: page.messages, hasMore: page.has_more, cursor: page.next_cursor ?? page.messages[0]?.seq,
      loading: false, error: undefined,
    });
    set({ list: mergeConversation(state.list, conversation) });
    await refreshRoomRequests(client, id, onAuthLost);
  } catch (e) { if (auth(e, onAuthLost)) return; setRoom(id, { loading: false, error: friendly(e) }); }
}

/** Answers one room card as the exact agent it belongs to; a 404 means it is already closed. */
export async function answerRoomRequest(client: Client, id: string, agent: string, requestId: string, result: Record<string, unknown>, onAuthLost: () => void): Promise<string | null> {
  let error: string | null = null;
  try { await client.answerRequest(agent, id, requestId, result); }
  catch (e) {
    if (auth(e, onAuthLost)) return 'sign-in';
    if (!(e instanceof ApiError && e.status === 404)) error = friendly(e);
  }
  const room = roomView(id), current = room.requests[agent] ?? [];
  setRoom(id, { requests: { ...room.requests, [agent]: current.filter((x) => x.id !== requestId) } });
  await refreshRoomRequests(client, id, onAuthLost);
  return error;
}

export async function loadOlderRoom(client: Client, id: string, onAuthLost: () => void): Promise<void> {
  const room = roomView(id);
  if (!room.hasMore || room.loadingOlder || room.loading || room.cursor === undefined) return;
  setRoom(id, { loadingOlder: true });
  try {
    const page = await client.conversationMessages(id, { cursor: room.cursor });
    const seen = new Set(room.messages.map((m) => m.id));
    setRoom(id, { messages: [...page.messages.filter((m) => !seen.has(m.id)), ...roomView(id).messages], hasMore: page.has_more, cursor: page.next_cursor ?? page.messages[0]?.seq, loadingOlder: false });
  } catch (e) { if (auth(e, onAuthLost)) return; setRoom(id, { loadingOlder: false, error: friendly(e) }); }
}

const uid = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `c${Date.now()}${Math.random().toString(36).slice(2)}`);
const same = (a: ConversationMessage, b: ConversationMessage) => a.id === b.id;
function addMessage(id: string, message: ConversationMessage) {
  const room = roomView(id);
  if (room.messages.some((m) => same(m, message))) return;
  const messages = [...room.messages, message].sort((a, b) => (a.created_at - b.created_at) || ((a.seq ?? 0) - (b.seq ?? 0)));
  const conversation = room.conversation ? { ...room.conversation, last_message_at: message.created_at, updated_at: Math.max(room.conversation.updated_at, message.created_at) } : undefined;
  setRoom(id, { messages, ...(conversation ? { conversation } : {}) });
  if (conversation) set({ list: mergeConversation(state.list, conversation) });
}

export async function sendRoomMessage(client: Client, id: string, text: string, opts: { me?: ConversationMessage['sender']; mentions?: ConversationMention[]; reply_to?: string; media?: ConversationMedia[] } = {}): Promise<ConversationMessage | undefined> {
  const room = roomView(id);
  const body = text.trim();
  // The hub requires at least one character: an attachment-only message uses its first named file as the caption.
  const caption = body || ((opts.media ?? []).map((m) => m.name.trim()).find((name) => name.length > 0) ?? '');
  if (!caption) return undefined;
  const clientId = uid(), localId = `local:${clientId}`, at = Date.now();
  const sender = opts.me ?? room.conversation?.owner ?? { id: '', name: 'You', kind: 'human' as const, is_bot: false };
  const placeholder: ConversationMessage = { id: localId, conversation_id: id, sender, text: caption, created_at: at, mentions: opts.mentions ?? [], ...(opts.reply_to ? { reply_to: opts.reply_to } : {}), ...(opts.media?.length ? { media: opts.media } : {}) };
  setRoom(id, { sending: true, messages: [...room.messages, placeholder], error: undefined });
  try {
    const r = await client.sendConversationMessage(id, { text: caption, mentions: opts.mentions, reply_to: opts.reply_to, media: opts.media?.map((m) => m.id), client_id: clientId });
    setRoom(id, { sending: false, messages: roomView(id).messages.map((m) => (m.id === localId ? r.message : m)) });
    const conversation = roomView(id).conversation;
    if (conversation) set({ list: mergeConversation(state.list, { ...conversation, last_message_at: r.message.created_at, updated_at: Math.max(conversation.updated_at, r.message.created_at) }) });
    return r.message;
  } catch (e) {
    setRoom(id, { sending: false, messages: roomView(id).messages.filter((m) => m.id !== localId), error: friendly(e) });
    return undefined;
  }
}

export async function markRoomRead(client: Client, id: string, onAuthLost: () => void, upTo?: number): Promise<void> {
  try {
    const conversation = await client.markConversationRead(id, upTo);
    const room = roomView(id);
    setRoom(id, { conversation: room.conversation ? { ...room.conversation, ...conversation, unread_count: 0 } : conversation });
    set({ list: mergeConversation(state.list, { ...conversation, unread_count: 0 }) });
  } catch (e) { if (e instanceof AuthRequiredError) onAuthLost(); }
}

export async function setRoomPreferences(client: Client, id: string, preferences: ConversationPreferences, onAuthLost: () => void): Promise<void> {
  const room = roomView(id);
  const previous = room.preferences;
  setRoom(id, { preferences: { ...(previous ?? {}), ...preferences }, error: undefined });
  try {
    const saved = await client.conversationPreferences(id, { ...(previous ?? {}), ...preferences });
    setRoom(id, { preferences: saved });
    if (preferences.archived !== undefined) {
      const conversation = roomView(id).conversation;
      if (conversation) { const updated = { ...conversation, archived: preferences.archived }; setRoom(id, { conversation: updated }); set({ list: mergeConversation(state.list, updated) }); }
    }
  } catch (e) { if (auth(e, onAuthLost)) return; setRoom(id, { preferences: previous, error: friendly(e) }); }
}

async function applyConversation(fn: (c: Conversation) => Promise<Conversation>, id: string, onAuthLost: () => void): Promise<void> {
  try {
    const conversation = await fn(roomView(id).conversation as Conversation);
    const room = roomView(id);
    setRoom(id, { conversation: room.conversation ? { ...room.conversation, ...conversation } : conversation });
    set({ list: mergeConversation(state.list, conversation) });
  } catch (e) { if (auth(e, onAuthLost)) return; setRoom(id, { error: friendly(e) }); }
}

export const renameRoom = (client: Client, id: string, title: string, onAuthLost: () => void) => applyConversation((c) => client.renameConversation(c.id, title), id, onAuthLost);
export const addRoomMember = (client: Client, id: string, agent: string, onAuthLost: () => void) => applyConversation((c) => client.addConversationMember(c.id, agent), id, onAuthLost);
export const removeRoomMember = (client: Client, id: string, agent: string, onAuthLost: () => void) => applyConversation((c) => client.removeConversationMember(c.id, agent), id, onAuthLost);

export async function stopRoom(client: Client, id: string, onAuthLost: () => void): Promise<void> {
  try {
    const r = await client.stopConversation(id);
    const conversation = roomView(id).conversation;
    if (conversation) {
      const updated = { ...conversation, paused: r.paused ?? true };
      setRoom(id, { conversation: updated });
      set({ list: mergeConversation(state.list, updated) });
    }
    await refreshRoomRequests(client, id, onAuthLost);
  } catch (e) { if (auth(e, onAuthLost)) return; setRoom(id, { error: friendly(e) }); }
}
export async function resumeRoom(client: Client, id: string, onAuthLost: () => void): Promise<void> {
  try {
    const conversation = await client.resumeConversation(id);
    setRoom(id, { conversation });
    set({ list: mergeConversation(state.list, conversation) });
  } catch (e) { if (auth(e, onAuthLost)) return; setRoom(id, { error: friendly(e) }); }
}

export async function createRoom(client: Client, title: string, memberIds: string[], onAuthLost: () => void): Promise<Conversation | undefined> {
  const clean = title.trim();
  if (!clean) return undefined;
  try {
    const conversation = await client.createConversation({ title: clean, member_ids: memberIds, client_id: uid() });
    set({ list: mergeConversation(state.list, conversation) });
    setRoom(conversation.id, { conversation, ...emptyRoom() });
    return conversation;
  } catch (e) { if (auth(e, onAuthLost)) return undefined; set({ error: friendly(e) }); return undefined; }
}

/** Explicit typed mentions: the spans the hub expects, found at word boundaries in the composed text. */
export function mentionsIn(text: string, members: Conversation['members']): ConversationMention[] {
  const out: ConversationMention[] = [];
  const agents = members.filter((m) => m.kind === 'agent').sort((a, b) => b.name.length - a.name.length);
  for (const m of agents) {
    const needle = `@${m.name}`;
    let from = 0;
    for (;;) {
      const at = text.indexOf(needle, from);
      if (at < 0) break;
      const end = at + needle.length, after = text[end] ?? '';
      const before = at === 0 ? '' : text[at - 1];
      if (!/[A-Za-z0-9_]/.test(after) && !/[A-Za-z0-9_]/.test(before)) out.push({ kind: 'agent', id: `agent:${m.name}`, offset: at, length: needle.length });
      from = end;
    }
  }
  return out.sort((a, b) => a.offset - b.offset);
}

export const mentionToken = (text: string, caret: number): { at: number; query: string } | null => {
  const before = text.slice(0, caret), at = before.lastIndexOf('@');
  if (at < 0 || (at > 0 && !/\s/.test(before[at - 1]))) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query) || query.length > 64) return null;
  return { at, query };
};

function typing(id: string, agent: string, stateName: string) {
  const key = `${id}\0${agent}`, room = roomView(id), next = { ...room.typing };
  const old = typingTimers.get(key); if (old) clearTimeout(old);
  if (stateName === 'idle') delete next[agent];
  else next[agent] = Date.now() + 6000;
  setRoom(id, { typing: next });
  if (stateName !== 'idle') typingTimers.set(key, setTimeout(() => { const r = roomView(id), t = { ...r.typing }; if ((t[agent] ?? 0) <= Date.now()) { delete t[agent]; setRoom(id, { typing: t }); } typingTimers.delete(key); }, 6100));
  else typingTimers.delete(key);
}

/** Applies one live v2 event. Exported so a test (and a future non-SSE transport) can feed the same reducer. */
export function applyLiveEvent(type: string, data: any): void {
  if (!data || typeof data !== 'object') return;
  const id = typeof data.conversation_id === 'string' ? data.conversation_id
    : typeof data.conversation?.id === 'string' ? data.conversation.id : undefined;
  if (type === 'conversation.updated' && data.conversation?.id) {
    const conversation = data.conversation as Conversation;
    set({ list: mergeConversation(state.list, conversation) });
    const room = roomView(conversation.id);
    if (state.rooms[conversation.id]) setRoom(conversation.id, { conversation: room.conversation ? { ...room.conversation, ...conversation } : conversation });
    return;
  }
  if (type === 'conversation.created' && data.conversation?.id) { set({ list: mergeConversation(state.list, data.conversation) }); return; }
  if (!id) return;
  if (type === 'conversation.message.new' && data.message) {
    addMessage(id, data.message as ConversationMessage);
    const found = roomView(id).conversation ?? state.list.find((c) => c.id === id);
    if (found) set({ list: mergeConversation(state.list, { ...found, last_message_at: data.message.created_at, updated_at: Math.max(found.updated_at, data.message.created_at), unread_count: activeRoom === id || data.message.sender?.kind === 'human' ? 0 : (found.unread_count ?? 0) + 1 }) });
    if (activeRoom === id) setRoom(id, { typing: { ...roomView(id).typing } });
    return;
  }
  if (type === 'conversation.message.edited' && data.message) {
    const message = data.message as ConversationMessage, room = roomView(id);
    setRoom(id, { messages: room.messages.map((m) => (m.id === message.id ? message : m)) });
    return;
  }
  if (type === 'conversation.message.deleted') {
    const room = roomView(id), messageId = data.message_id;
    setRoom(id, { messages: room.messages.filter((m) => m.id !== messageId) });
    return;
  }
  if (type === 'conversation.read') {
    const conversation = roomView(id).conversation;
    if (conversation) {
      const updated = { ...conversation, unread_count: 0 };
      setRoom(id, { conversation: updated });
      set({ list: mergeConversation(state.list, updated) });
    }
    return;
  }
  if (type === 'conversation.member.joined' || type === 'conversation.member.left') {
    // The matching conversation.updated carries the authoritative member list; touch nothing speculative.
    return;
  }
  if (type === 'conversation.typing') typing(id, String(data.agent ?? ''), String(data.state ?? 'typing'));
  if (type === 'conversation.handoff') { /* durable messages carry the visible markers; typing is ephemeral */ }
}

const LIVE_TYPES = ['conversation.created', 'conversation.updated', 'conversation.member.joined', 'conversation.member.left',
  'conversation.message.new', 'conversation.message.edited', 'conversation.message.deleted', 'conversation.read', 'conversation.handoff', 'conversation.typing'];

/** v2 SSE. A browser reconnects by itself; a gap replays nothing, so the store catches up from HTTP instead. */
export function connectLive(client: Client, onAuthLost: () => void): void {
  if (source) return;
  const ES = (globalThis as any).EventSource;
  if (!ES) { set({ live: 'offline' }); return; }
  set({ live: 'connecting' });
  let es: EventSource;
  try { es = new ES(client.liveStreamUrl()); } catch { set({ live: 'offline' }); return; }
  source = es;
  es.addEventListener('open', () => set({ live: 'live' }));
  es.addEventListener('error', () => set({ live: state.live === 'connecting' ? 'offline' : state.live === 'live' ? 'offline' : 'offline' }));
  es.addEventListener('foxfleet.ready', (e: MessageEvent) => {
    set({ live: 'live' });
    try { const d = JSON.parse(e.data); if (typeof d?.cursor === 'string') set({ cursor: d.cursor }); } catch { /* ignore */ }
  });
  es.addEventListener('foxfleet.gap', () => {
    void loadConversations(client, onAuthLost);
    if (activeRoom) void loadRoom(client, activeRoom, onAuthLost, true);
  });
  es.addEventListener('foxfleet.auth', () => onAuthLost());
  for (const type of LIVE_TYPES) es.addEventListener(type, (e: MessageEvent) => { try { applyLiveEvent(type, JSON.parse(e.data)); } catch { /* ignore a malformed frame */ } });
}

export function disconnectLive(): void {
  source?.close(); source = undefined;
  for (const t of typingTimers.values()) clearTimeout(t);
  typingTimers = new Map();
  if (state.live !== 'idle') set({ live: 'idle' });
}

export function resetConversations(): void {
  disconnectLive();
  state = { list: [], total: 0, loading: false, rooms: {}, live: 'idle' };
  activeRoom = undefined;
  subs.forEach((f) => f());
}
