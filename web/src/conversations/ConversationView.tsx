import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { Client } from '../api/client';
import type { AgentSummary, AuthInfo, Conversation, ConversationMedia, ConversationMember, ConversationMessage } from '../api/types';
import { Icon } from '../components/Icon';
import { navigate } from '../router';
import { clock } from '../lib/time';
import { humanSize } from '../lib/files';
import { t } from '../i18n/t';
import { ConversationDetails } from './ConversationDetails';
import { RequestCards } from '../chat/RequestCards';
import { answerRoomRequest, applyLiveEvent, connectLive, loadOlderRoom, loadRoom, markRoomRead, mentionToken, mentionsIn, refreshRoomRequests, roomView, sendRoomMessage, setActiveRoom, stopRoom, resumeRoom, useConversations } from './store';

const isMine = (m: ConversationMessage, me?: ConversationMember) => Boolean(me && m.sender.id === me.id);
const memberFor = (c: Conversation | undefined, id: string) => c?.members.find((m) => m.id === id || m.name === id);

function MentionText({ message, conversation }: { message: ConversationMessage; conversation?: Conversation }) {
  const spans = (message.mentions ?? []).filter((s) => s.offset >= 0 && s.length > 0 && s.offset + s.length <= message.text.length).sort((a, b) => a.offset - b.offset);
  const parts: JSX.Element[] = [];
  let at = 0;
  spans.forEach((s, i) => {
    if (s.offset < at) return;
    if (s.offset > at) parts.push(<span key={`t${i}`}>{message.text.slice(at, s.offset)}</span>);
    const name = memberFor(conversation, s.id)?.name ?? s.id.replace(/^agent:/, '');
    parts.push(<span key={`m${i}`} class="mention">@{name}</span>);
    at = s.offset + s.length;
  });
  if (at < message.text.length) parts.push(<span key="tail">{message.text.slice(at)}</span>);
  return <p class="room-text">{parts.length ? parts : message.text}</p>;
}

function Media({ m, conversation, client }: { m: ConversationMedia; conversation: Conversation; client: Client }) {
  const url = client.conversationMediaUrl(conversation.id, m.id);
  if (m.kind === 'image') return <a class="room-media" href={url} target="_blank" rel="noreferrer"><img src={url} alt={m.name} loading="lazy" /></a>;
  if (m.kind === 'video') return <video class="room-media" controls preload="metadata" src={url} />;
  if (m.kind === 'audio') return <audio controls preload="metadata" src={url} />;
  return <a class="media-card room-file" href={url} download={m.name}><Icon name="file" size={20} /><span class="grow"><b>{m.name}</b><small class="muted">{humanSize(m.size)}</small></span><Icon name="download" size={18} /></a>;
}

function RoomMessage({ message, conversation, me, target, onJump, onReply, client }: {
  message: ConversationMessage; conversation: Conversation; me?: ConversationMember; target?: ConversationMessage;
  onJump: (id: string) => void; onReply: (m: ConversationMessage) => void; client: Client;
}) {
  const mine = isMine(message, me);
  if (message.system) return <div class="msg notice room-notice" data-mid={message.id} role="status">
    <Icon name={message.code?.startsWith('handoff') ? 'share' : 'info'} size={16} />
    <span class="grow">{message.text}</span>
    {message.code && <small class="muted">{message.code.startsWith('handoff') ? t('rooms.handoff') : message.code}</small>}
  </div>;
  const author = message.sender.name || message.sender.id;
  const handoff = message.sender.kind === 'agent' && Boolean(message.reply_to);
  return <article id={`room-msg-${message.id}`} data-mid={message.id} class={`msg room-msg${mine ? ' mine' : ''}${message.sender.kind === 'agent' ? ' from-agent' : ''}`}>
    <div class="msg-row">
      <div class="room-msg-body">
        <div class="room-author">
          <b>{author}</b>
          {mine && <span class="room-tag">{t('rooms.you')}</span>}
          {message.sender.kind === 'agent' && <span class="room-tag">{t('rooms.agent')}</span>}
          {handoff && <span class="room-tag handoff" title={t('rooms.handoffHint')}><Icon name="share" size={12} />{t('rooms.handoff')}</span>}
          <time class="msg-time muted">{clock(message.created_at)}</time>
          {message.edited && <small class="muted">{t('rooms.edited')}</small>}
        </div>
        <div class="bubble room-bubble">
          {message.reply_to && <button type="button" class="reply-quote" onClick={() => onJump(message.reply_to!)} title={t('rooms.jumpToReply')}>
            <span class="reply-bar" aria-hidden="true" />
            <span class="grow"><b>{target ? (target.sender.id === me?.id ? t('rooms.you') : target.sender.name) : t('rooms.message')}</b><small>{target ? target.text.replace(/\s+/g, ' ').slice(0, 140) : t('rooms.jumpToReply')}</small></span>
          </button>}
          <MentionText message={message} conversation={conversation} />
          {message.media?.length ? <div class="media-cards">{message.media.map((m) => <Media key={m.id} m={m} conversation={conversation} client={client} />)}</div> : null}
        </div>
        <div class="room-msg-actions">
          <button type="button" class="btn text" aria-label={t('msg.reply')} title={t('msg.reply')} onClick={() => onReply(message)}><Icon name="reply" size={16} />{t('msg.reply')}</button>
        </div>
      </div>
    </div>
  </article>;
}

export function ConversationView({ client, info, agents, conversationId, detailsOpen, focusMessage, onAuthLost }: {
  client: Client; info: AuthInfo; agents: AgentSummary[] | null; conversationId: string; detailsOpen: boolean; focusMessage?: string; onAuthLost: () => void;
}) {
  const s = useConversations(), room = roomView(conversationId), c = room.conversation;
  const me = c?.members.find((m) => m.id === info.user?.id) ?? (info.user ? { id: info.user.id, name: info.user.username, kind: 'human' as const, is_bot: false } : undefined);
  const owner = Boolean(c && info.user && c.owner.id === info.user.id);
  const scroller = useRef<HTMLDivElement>(null), node = useRef<Record<string, HTMLElement | null>>({});
  const [text, setText] = useState(''), [caret, setCaret] = useState(0), [picking, setPicking] = useState(0), [reply, setReply] = useState<ConversationMessage | null>(null), [attach, setAttach] = useState<ConversationMedia[]>([]), [uploading, setUploading] = useState(false), [flash, setFlash] = useState<string | null>(null), [jumping, setJumping] = useState<string | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null), file = useRef<HTMLInputElement>(null), readAt = useRef(0);

  useEffect(() => {
    setActiveRoom(conversationId);
    void loadRoom(client, conversationId, onAuthLost);
    connectLive(client, onAuthLost);
    return () => setActiveRoom(undefined);
  }, [client, conversationId]);
  useEffect(() => { if (!room.loading && c && readAt.current !== (c.updated_at ?? 0)) { readAt.current = c.updated_at ?? 0; void markRoomRead(client, conversationId, onAuthLost); } }, [client, conversationId, c?.updated_at, room.loading]);
  useEffect(() => { const timer = setInterval(() => { void refreshRoomRequests(client, conversationId, onAuthLost); }, 15_000); return () => clearInterval(timer); }, [client, conversationId]);
  useEffect(() => { const el = scroller.current; if (el && !room.loading) el.scrollTop = el.scrollHeight; }, [room.loading, room.messages.length]);
  useEffect(() => { if (focusMessage) void jump(focusMessage); }, [focusMessage, room.loading]);

  const token = mentionToken(text, caret);
  const agentMembers = (c?.members ?? []).filter((m) => m.kind === 'agent');
  const suggestions = useMemo(() => token ? agentMembers.filter((m) => m.name.toLowerCase().includes(token.query.toLowerCase())).slice(0, 6) : [], [token?.at, token?.query, agentMembers.map((m) => m.name).join(',')]);
  useEffect(() => setPicking(0), [token?.at, token?.query]);

  async function jump(id: string) {
    const found = node.current[id] ?? scroller.current?.querySelector<HTMLElement>(`[data-mid="${id.replace(/"/g, '')}"]`);
    if (found) { found.scrollIntoView({ block: 'center', behavior: 'smooth' }); setFlash(id); setTimeout(() => setFlash((x) => (x === id ? null : x)), 1400); return; }
    setJumping(id);
    try { const m = await client.conversationMessage(conversationId, id); applyLiveEvent('conversation.message.new', { conversation_id: conversationId, message: m }); }
    catch { /* a deleted or inaccessible target leaves the reply quote pointing at nothing */ }
    finally { setJumping(null); setTimeout(() => { const el = scroller.current?.querySelector<HTMLElement>(`[data-mid="${id.replace(/"/g, '')}"]`); if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); setFlash(id); setTimeout(() => setFlash((x) => (x === id ? null : x)), 1400); } }, 40); }
  }
  function insertMention(name: string) {
    const at = token?.at ?? caret, end = at + 1 + (token?.query.length ?? 0);
    const next = `${text.slice(0, at)}@${name} ${text.slice(end)}`, pos = at + name.length + 2;
    setText(next); setCaret(pos);
    const focus = () => { ta.current?.focus(); ta.current?.setSelectionRange(pos, pos); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focus); else setTimeout(focus, 0);
  }
  function key(e: KeyboardEvent) {
    if (token && suggestions.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setPicking((n) => (n + 1) % suggestions.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setPicking((n) => (n - 1 + suggestions.length) % suggestions.length); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); insertMention(suggestions[picking].name); return; }
      if (e.key === 'Escape') { setText(text.slice(0, token.at) + text.slice(token.at + 1 + token.query.length)); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void submit(); }
  }
  async function submit() {
    const body = text.trim(), named = attach.some((m) => m.name.trim().length > 0);
    if ((!body && !named) || room.sending) return;
    const mentions = mentionsIn(body, c?.members ?? []);
    const sent = await sendRoomMessage(client, conversationId, body, { me, mentions, reply_to: reply?.id, media: attach.length ? attach : undefined });
    if (sent) { setText(''); setReply(null); setAttach([]); setCaret(0); }
  }
  async function pickFile(e: Event) {
    const files = Array.from((e.currentTarget as HTMLInputElement).files ?? []); (e.currentTarget as HTMLInputElement).value = '';
    if (!files.length) return;
    setUploading(true);
    for (const f of files.slice(0, 4)) {
      try { const m = await client.uploadConversationMedia(conversationId, f); setAttach((list) => [...list, m]); }
      catch (err) { /* surfaced below through the room error path */ console.warn(err); }
    }
    setUploading(false);
  }
  const typing = Object.keys(room.typing).map((id) => memberFor(c, id)?.name ?? id.replace(/^agent:/, '')).filter(Boolean);
  const byId = useMemo(() => new Map(room.messages.map((m) => [m.id, m])), [room.messages]);

  if (!c && room.loading) return <p class="muted pad">{t('home.loading')}</p>;
  if (!c) return <div class="empty-home"><Icon name="warning" size={40} class="icon-hero" /><h1>{t('rooms.unavailable')}</h1><p class="muted">{room.error ?? t('rooms.unavailableHint')}</p><button type="button" class="btn primary inline" onClick={() => navigate('conversations')}>{t('rooms.back')}</button></div>;

  return <section class="chat room-view" aria-label={c.title}>
    <header class="chat-head room-head">
      <button type="button" class="icon-btn" aria-label={t('rooms.back')} onClick={() => navigate('conversations')}><Icon name="back" /></button>
      <div class="grow chat-identity"><h1 title={c.title}>{c.title}</h1><small class="muted">{t('rooms.memberCount', { n: String(c.members.length) })}{c.paused ? ` · ${t('rooms.paused')}` : ''}</small></div>
      {owner && (c.paused ? <button type="button" class="btn text" onClick={() => void resumeRoom(client, conversationId, onAuthLost)}><Icon name="play" size={18} />{t('rooms.resume')}</button>
        : <button type="button" class="btn text" onClick={() => void stopRoom(client, conversationId, onAuthLost)}><Icon name="stop" size={18} />{t('rooms.stop')}</button>)}
      <button type="button" class="icon-btn" aria-label={t('rooms.details')} title={t('rooms.details')} aria-current={detailsOpen ? 'page' : undefined} onClick={() => navigate('conversations', { id: conversationId, ...(detailsOpen ? {} : { details: '1' }) })}><Icon name="info" /></button>
    </header>
    {s.live === 'offline' && <p class="run-status disconnected" role="status">{t('rooms.offline')} <button type="button" class="btn text" onClick={() => { connectLive(client, onAuthLost); void loadRoom(client, conversationId, onAuthLost, true); }}>{t('home.retry')}</button></p>}
    {room.error && <p class="error pad-sm" role="alert">{room.error}</p>}
    <div class="messages-host">
      <div class="messages" ref={scroller} role="log" aria-label={t('rooms.messages')} aria-live="off" tabIndex={0}>
        {room.hasMore && <button type="button" class="btn text older" disabled={room.loadingOlder} onClick={() => void loadOlderRoom(client, conversationId, onAuthLost)}>{room.loadingOlder ? t('home.loading') : t('chat.loadOlder')}</button>}
        {room.loading && <p class="muted pad-sm" role="status">{t('home.loading')}</p>}
        {!room.loading && room.messages.length === 0 && <div class="empty"><Icon name="users" size={48} class="icon-hero" /><p>{t('rooms.emptyThread')}</p></div>}
        {room.messages.map((m) => <div key={m.id} ref={(el) => { node.current[m.id] = el; }} class={flash === m.id ? 'room-jump-flash' : undefined}>
          <RoomMessage message={m} conversation={c} me={me} target={m.reply_to ? byId.get(m.reply_to) : undefined} onJump={(id) => void jump(id)} onReply={(target) => { setReply(target); ta.current?.focus(); }} client={client} />
        </div>)}
        {typing.length > 0 && <p class="status shimmer" role="status">{typing.join(', ')} {t('rooms.typing')}<span class="typing-dots" aria-hidden="true"><i /><i /><i /></span></p>}
        {jumping && <p class="muted small pad-sm" role="status">{t('rooms.jumping')}</p>}
      </div>
    </div>
    {owner && agentMembers.map((m) => <RequestCards key={m.name} requests={room.requests[m.name] ?? []} agent={m.name} onAnswer={(id, result) => answerRoomRequest(client, conversationId, m.name, id, result, onAuthLost)} />)}
    <div class="composer room-composer">
      {reply && <div class="reply-chip" role="status"><span class="reply-bar" aria-hidden="true" /><div class="grow"><small class="reply-who">{t('msg.replyingTo', { name: reply.sender.id === me?.id ? t('rooms.you') : reply.sender.name })}</small><p class="reply-text">{reply.text.slice(0, 160)}</p></div><button type="button" class="icon-btn" aria-label={t('msg.cancelReply')} onClick={() => { setReply(null); ta.current?.focus(); }}><Icon name="close" size={16} /></button></div>}
      {attach.length > 0 && <div class="attachments">{attach.map((m) => <div class="att file" key={m.id}><Icon name="file" size={16} /><span class="chip-name">{m.name}</span><small>{humanSize(m.size)}</small><button type="button" aria-label={t('chat.remove')} onClick={() => setAttach((list) => list.filter((x) => x.id !== m.id))}><Icon name="close" size={14} /></button></div>)}</div>}
      {token && suggestions.length > 0 && <ul class="suggest room-suggest" role="listbox" aria-label={t('rooms.mention')}>
        {suggestions.map((m, i) => <li key={m.id} role="option" aria-selected={i === picking} class={i === picking ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); insertMention(m.name); }}><b>@{m.name}</b><small>{t('rooms.agent')}</small></li>)}
      </ul>}
      {uploading && <p class="note" role="status">{t('chat.uploading')}</p>}
      <div class="bar">
        <button type="button" class="icon-btn" aria-label={t('chat.attach')} title={t('chat.attach')} onClick={() => file.current?.click()}><Icon name="add" size={22} /></button>
        <input ref={file} type="file" multiple hidden onChange={pickFile} />
        <textarea ref={ta} rows={1} value={text} placeholder={t('rooms.placeholder')} aria-label={t('rooms.message')}
          onInput={(e) => { setText((e.currentTarget as HTMLTextAreaElement).value); setCaret((e.currentTarget as HTMLTextAreaElement).selectionStart ?? 0); }}
          onClick={(e) => setCaret((e.currentTarget as HTMLTextAreaElement).selectionStart ?? 0)}
          onKeyUp={(e) => setCaret((e.currentTarget as HTMLTextAreaElement).selectionStart ?? 0)} onKeyDown={key} />
        <button type="button" class="send" aria-label={t('chat.send')} disabled={room.sending || uploading || (!text.trim() && !attach.some((m) => m.name.trim().length > 0))} onClick={() => void submit()}><Icon name="send" size={22} /></button>
      </div>
    </div>
    {detailsOpen && <ConversationDetails client={client} conversation={c} me={me} agents={agents} onAuthLost={onAuthLost} onClose={() => navigate('conversations', { id: conversationId })} />}
  </section>;
}
