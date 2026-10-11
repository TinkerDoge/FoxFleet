import { Reasoning } from './Reasoning';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Client } from '../api/client';
import type { AgentSummary } from '../api/types';
import { Composer } from './Composer';
import { draftKey } from './drafts';
import { SessionsMenu } from './SessionsMenu';
import { RequestCards } from './RequestCards';
import { ModelPicker, ChoicePicker } from './Pickers';
import { openPicker, closePicker, usePicker } from './picker';
import { AssistantText, Message } from './Message';
import { useReactions } from './Reactions';
import { toolPresentation } from './toolActivity';
import { MediaContext, DiagnoseContext } from './MediaCards';
import { control, createFollow, type Follow, type Role } from './scrollFollow';
import { MediaViewer, type MediaItem } from '../components/MediaViewer';
import { Icon } from '../components/Icon';
import { ActionMenu } from '../components/ActionMenu';
import { chatOf, deleteSession, loadAgent, loadOlder, loadSessions, newChat, renameSession, restore, retryLast, reconnectReply, send, stop, notice, answerRequest, useChat, resumeQueue, cancelQueued, reconcileMessages } from './store';
import { rememberAgent } from '../lib/persist';
import type { LocalCommand } from '../lib/commands';
import { navigate, parseRoute } from '../router';
import { t } from '../i18n/t';
type K = Parameters<typeof t>[0];

export function statusLine(agent: string, tool: string | undefined, _hasText: boolean, hasReasoning: boolean): string | null {
  if (tool) return t('chat.usingTool', { tool });
  return hasReasoning ? t('chat.thinking', { agent }) : t('chat.working', { agent });
}

export function ChatView({ client, agent, onAuthLost, session }: { client: Client; agent: AgentSummary; onAuthLost: () => void; session?: string }) {
  const c = useChat(agent.name), picker = usePicker(agent.name, c.session);
  useEffect(() => { closePicker(agent.name); }, [agent.name, c.session]); // a card never outlives the chat that opened it
  const onModel = (args: string) => {
    if (!args) { openPicker({ agent: agent.name, session: c.session, kind: 'model' }); return; }
    if (/(^|\s)--global(\s|$)/.test(args)) { notice(agent.name, t('picker.noGlobal')); return; }
    if (!c.session) { notice(agent.name, t('ctl.modelNeedsChat')); return; }
    void client.setModel(agent.name, c.session, args).then((r) => notice(agent.name, r?.confirm_required ? String(r.confirm_message ?? '') : t('picker.modelSet', { model: String(r?.model ?? args) }))).catch(() => notice(agent.name, t('error.generic')));
  };
  const [viewer, setViewer] = useState<MediaItem | null>(null), [sessionsOpen, setSessionsOpen] = useState(false), [historyError, setHistoryError] = useState('');
  const scroller = useRef<HTMLDivElement>(null), stick = useRef(true), follow = useRef(createFollow()), [jumpUi, setJumpUi] = useState<{ far: boolean; unread: number; pinned: boolean }>({ far: false, unread: 0, pinned: true });
  useEffect(() => { rememberAgent(agent.name); if (agent.capabilities?.sessions !== false) void loadAgent(client, agent.name, onAuthLost); }, [agent.name]);
  useEffect(() => { void restore(client, agent.name, session, onAuthLost); }, [agent.name, session]);
  // The URL always names the open chat, so a reload, a bookmark or the back button returns to it.
  useEffect(() => {
    if (c.loading || chatOf(agent.name).session !== c.session) return;
    const route = parseRoute(location.hash), targetAgent = route.params.get('agent'), targetSession = route.params.get('session');
    if ((route.name !== 'chat' && route.name !== 'agents') || (targetAgent && targetAgent !== agent.name) || (targetSession && targetSession !== c.session)) return;
    navigate('chat', { agent: agent.name, ...(c.session ? { session: c.session } : route.params.get('new') === '1' ? { new: '1' } : {}) }, true);
  }, [agent.name, c.session, c.loading, session]);
  // One history UI: the keyboard-navigable Sessions menu. Opening it refreshes the list from the hub.
  const failHistory = () => setHistoryError(t('chat.historyFailed'));
  const openHistory = (open: boolean) => { setSessionsOpen(open); if (open) { setHistoryError(''); void loadSessions(client, agent.name, false, onAuthLost); } };
  const startNew = () => { newChat(agent.name); navigate('chat', { agent: agent.name, new: '1' }); };
  const selectSession = (id: string) => { navigate('chat', { agent: agent.name, session: id }); void restore(client, agent.name, id, onAuthLost); };
  const before = useRef(0), reduced = () => document.documentElement.dataset.motion === 'reduce' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const show = (f: Follow) => { stick.current = f.pinned; setJumpUi((u) => (u.far === f.far && u.unread === f.unread && u.pinned === f.pinned ? u : { far: f.far, unread: f.unread, pinned: f.pinned })); };
  const toEnd = (smooth = false) => { const el = scroller.current; if (!el) return; if (smooth && !reduced() && el.scrollTo) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); else { el.style.scrollBehavior = 'auto'; el.scrollTop = el.scrollHeight; el.style.scrollBehavior = ''; } };
  const lastRole = c.messages[c.messages.length - 1]?.role as Role | undefined;
  useEffect(() => { // history, a sent message, a reply (streaming or finished): follow only while pinned; otherwise count it for the pill
    const el = scroller.current; if (!el) return;
    const prepending = before.current > 0, f = follow.current.content({ count: c.messages.length, streaming: c.streaming, lastRole, prepending, loading: c.loading });
    if (prepending) { el.scrollTop += el.scrollHeight - before.current; before.current = 0; }
    else if (f.action === 'scroll') toEnd();
    show(f);
  }, [c.messages, c.streaming, c.streamText, c.streamReasoning, c.tool, c.loading]);
  useEffect(() => { show(follow.current.reset()); }, [c.session, agent.name]); // a freshly opened conversation starts at the bottom
  // Late layout shifts (pictures and cards finishing, the keyboard opening, the composer growing) keep a pinned view at the bottom.
  useEffect(() => {
    const el = scroller.current; if (!el || typeof ResizeObserver === 'undefined') return;
    const fix = () => { if (stick.current && before.current === 0) toEnd(); }, ro = new ResizeObserver(fix), watch = () => { ro.disconnect(); ro.observe(el); for (const k of Array.from(el.children)) ro.observe(k); };
    watch(); const mo = new MutationObserver(watch); mo.observe(el, { childList: true });
    const vv = window.visualViewport; vv?.addEventListener('resize', fix);
    return () => { ro.disconnect(); mo.disconnect(); vv?.removeEventListener('resize', fix); };
  }, [agent.name]);
  const jump = () => { show(follow.current.jump()); toEnd(true); };
  const older = () => { const el = scroller.current; if (el && c.hasOlder && !c.loadingOlder) { before.current = el.scrollHeight; void Promise.resolve(loadOlder(client, agent.name, onAuthLost)).finally(() => setTimeout(() => { before.current = 0; }, 400)); } };
  const local = (cmd: LocalCommand, args = '') => { if (cmd === 'new') startNew(); else if (cmd === 'stop') stop(agent.name, client); else if (cmd === 'retry') void retryLast(client, agent.name, onAuthLost); else if (cmd === 'title') { if (c.session) void renameSession(client, agent.name, c.session, args).catch(() => {}); } else openHistory(true); };
  const last = c.messages[c.messages.length - 1];
  // Screen readers get one announcement when a reply starts and one when it ends, never a token-by-token flood.
  const announce = c.streaming ? t('a11y.replying', { agent: agent.displayName || agent.name }) : last?.role === 'assistant' ? t('a11y.replied', { agent: agent.displayName || agent.name, text: last.content.replace(/\s+/g, ' ').slice(0, 300) }) : '';
  const active = c.activity?.active ?? [];
  const status = c.streaming && !active.length ? statusLine(agent.displayName || agent.name, c.tool, c.streamText.length > 0, c.streamReasoning.length > 0) : null;
  // Reactions need stable hub ids: after a live turn ends, swap in the stored page (which carries them), then load reactions.
  const lastId = last?.id, ids = useMemo(() => c.messages.map((m) => m.id ?? '').join(','), [c.messages]);
  useEffect(() => { if (!c.streaming && !c.loading && c.session && last && !lastId && agent.capabilities?.reactions) void reconcileMessages(client, agent.name); }, [c.streaming, c.loading, c.session, lastId]);
  const reactions = useReactions(client, agent.name, c.session, ids, Boolean(agent.capabilities?.reactions) && !c.loading);
  const reactionsFor = (id?: string) => (id && reactions.snap ? { groups: reactions.snap.messages[id] ?? [], me: reactions.snap.actor.id, onReact: (emoji: string, present: boolean) => reactions.react(id, emoji, present) } : undefined);
  const name = agent.displayName || agent.name;
  const recovery = () => {
    if (c.recovery === 'retry') void retryLast(client, agent.name, onAuthLost);
    else if (c.recovery === 'reload' || (c.recovery === 'check' && c.session)) void restore(client, agent.name, c.session, onAuthLost, true);
    else if (c.recovery === 'reconnect') void reconnectReply(client, agent.name, onAuthLost);
    else openHistory(true);
  };
  const secondary = [...(agent.capabilities?.screen && agent.online ? [{ icon: 'screen' as const, label: t('chat.screen'), onSelect: () => navigate('screen', { agent: agent.name }) }] : []), { icon: 'add' as const, label: t('chat.new'), onSelect: startNew }];
  const [live, setLive] = useState(false); // entrance animation only for messages that arrive after the history has loaded
  useEffect(() => { setLive(false); if (c.loading) return; const id = setTimeout(() => setLive(true), 700); return () => clearTimeout(id); }, [c.loading, c.session]);
  const resolveMedia = useMemo(() => (ref: string) => client.media(agent.name, ref), [client, agent.name]);
  const diagnoseMedia = useMemo(() => (url: string) => client.mediaDiagnose(url), [client]);
  return (
    <MediaContext.Provider value={resolveMedia}><DiagnoseContext.Provider value={diagnoseMedia}>
    <section class="chat" aria-label={name}>
      <div class="sr-only" role="status" aria-live="polite" aria-atomic="true">{announce}</div>
      <header class="chat-head">
        <span class={`dot ${agent.online ? 'on' : 'off'}`} aria-hidden="true" />
        <div class="grow chat-identity"><h1 title={name}>{name}</h1><small class="muted">{agent.online ? t('chat.online') : t('chat.offline')}</small></div>
        <div class="chat-secondary">{secondary.map((action) => <button class="btn text" onClick={action.onSelect}><Icon name={action.icon} />{action.label}</button>)}</div>
        <ActionMenu className="chat-overflow" label={t('chat.moreActions')} actions={secondary}><Icon name="more" /></ActionMenu>
        {agent.capabilities?.sessions !== false && <SessionsMenu sessions={c.sessions} current={c.session} open={sessionsOpen} onOpenChange={openHistory}
          total={c.sessionsTotal} loading={c.sessionsLoading} error={historyError || c.sessionsError}
          onSelect={selectSession} onNew={startNew}
          onRefresh={() => { setHistoryError(''); void loadSessions(client, agent.name, false, onAuthLost); }} onLoadMore={() => void loadSessions(client, agent.name, true, onAuthLost)}
          onRename={(id, title) => renameSession(client, agent.name, id, title).catch(failHistory)} onDelete={(id) => deleteSession(client, agent.name, id).then((cleared) => {
            const route = parseRoute(location.hash); if (cleared && route.name === 'chat' && route.params.get('agent') === agent.name && route.params.get('session') === id) navigate('chat', { agent: agent.name, new: '1' });
          }).catch(failHistory)} />}
      </header>
      {c.runState && <p class={`run-status ${c.runState}`} role="status">{t(('chat.run.' + c.runState) as K)}</p>}
      <div class="messages-host">
      <div class={`messages${live ? ' live' : ''}`} ref={scroller} onLoadCapture={() => { if (stick.current) toEnd(); }} onScroll={(e) => { const el = e.currentTarget as HTMLElement; if (before.current === 0) show(follow.current.scroll(el.scrollHeight - el.scrollTop - el.clientHeight)); if (el.scrollTop < 60) older(); }} role="log" aria-label={t('chat.message')} aria-live="off" tabIndex={0}>
        {c.hasOlder && <button class="btn text older" disabled={c.loadingOlder} onClick={older}>{c.loadingOlder ? t('home.loading') : t('chat.loadOlder')}</button>}
        {c.loading && <div class="msg-skeleton" role="status" aria-label={t('home.loading')}><i class="sk-bubble w60" /><i class="sk-bubble me w40" /><i class="sk-bubble w75" /></div>}
        {!c.loading && !c.error && c.messages.length === 0 && !c.streaming && <div class="empty"><Icon name="chat" size={48} class="icon-hero" /><p>{t('chat.empty', { agent: name })}</p></div>}
        {c.messages.map((m, i) => <Message key={m.id ?? i} m={m} onMedia={setViewer} grouped={c.messages[i - 1]?.role === m.role} reactions={reactionsFor(m.id)} />)}
        {reactions.error && <p class="react-error error small" role="alert">{reactions.error}</p>}
        {c.streaming && (
          <div class="msg assistant">
            {(c.streamReasoning || c.streamText) && <div class="msg-card">
              {c.streamReasoning && <Reasoning text={c.streamReasoning} live={!c.streamText} ms={c.reasoningMs} />}
              {c.streamText && <AssistantText text={c.streamText} onMedia={setViewer} streaming />}
            </div>}
            {active.length > 0 && <ul class="activity" aria-label={t('tool.activity')} role="status" aria-live="polite">{active.map((x) => { const p = toolPresentation(x.name); return <li key={x.key} class="activity-row"><Icon name={p.icon} size={16} /><span>{p.label}</span><span class="typing-dots" aria-hidden="true"><i /><i /><i /></span></li>; })}</ul>}
            {status && <p class="status shimmer" key={status} role="status" aria-live="polite">{status}<span class="typing-dots" aria-hidden="true"><i /><i /><i /></span></p>}
          </div>
        )}
        {c.queue.length > 0 && (
          <ul class="queue" aria-label={t('chat.queueList')}>
            {c.queue.map((q) => (
              <li key={q.id} class={`msg user queued ${q.state}`}>
                <div class="bubble"><p class="user-text">{q.text}</p>
                  <small class="muted" role="status">{q.error ?? (q.ack ? t(('chat.ack.' + q.ack) as K) : t(('chat.q.' + q.state) as K))}</small>
                  {(q.state === 'queued' || q.state === 'awaiting_stop') && <button class="btn text" disabled={!c.canCancel} title={c.canCancel ? undefined : t('chat.q.cantCancel')} onClick={() => void cancelQueued(client, agent.name, q.id)}>{t('chat.q.cancel')}</button>}
                </div>
              </li>
            ))}
            {c.halted && c.queue.some((q) => q.state === 'queued') && <li class="queue-paused"><span class="muted">{t('chat.q.paused')}</span> <button class="btn text" onClick={() => void resumeQueue(client, agent.name, onAuthLost)}>{t('chat.q.resume')}</button></li>}
          </ul>
        )}
        {picker?.kind === 'model' && <ModelPicker client={client} picker={picker} onDone={(text) => notice(agent.name, text)} />}
        {picker?.kind === 'choice' && <ChoicePicker picker={picker} onChoose={(text) => void send(client, agent.name, text, [], [], onAuthLost, 'interrupt')} />}
        <RequestCards requests={c.requests} agent={name} onAnswer={(id, result) => answerRequest(client, agent.name, id, result, onAuthLost)} />
        {c.error && <div class="card error-card" role="alert"><p class="error">{c.error}</p>
          {c.recovery && <><p class="muted small">{t(c.recovery === 'retry' ? 'chat.retryHint' : c.recovery === 'reload' ? 'chat.reloadHint' : 'chat.reconnectHint')}</p>
            <button class="btn text" disabled={c.loading || c.streaming} onClick={recovery}>{t(c.recovery === 'retry' ? 'chat.retryRequest' : c.recovery === 'reload' ? 'chat.reloadHistory' : c.recovery === 'reconnect' ? 'chat.reconnectReply' : c.session ? 'chat.checkRequest' : 'chat.checkHistory')}</button></>}
        </div>}
      </div>
      {(() => { const k = control(jumpUi), on = k !== 'none'; return <button type="button" class={`to-bottom ${k}${on ? ' show' : ''}`} aria-hidden={on ? undefined : 'true'} tabIndex={on ? 0 : -1} onClick={jump}
        aria-label={k === 'pill' ? (jumpUi.unread > 1 ? t('chat.newMessages', { n: String(jumpUi.unread) }) : t('chat.newMessage')) : t('chat.toBottom')}>{k === 'pill' ? <><span>{jumpUi.unread > 1 ? t('chat.newMessages', { n: String(jumpUi.unread) }) : t('chat.newMessage')}</span><Icon name="chevronDown" size={18} /></> : <Icon name="chevronDown" size={22} />}</button>; })()}
      </div>
      <Composer key={draftKey(agent.name, c.session)} client={client} agent={agent} history={c.messages} streaming={c.streaming} disabled={c.loading} skills={c.skills} draftKey={draftKey(agent.name, c.session)} session={c.session} queue={c.queue} onCancelQueued={(id) => void cancelQueued(client, agent.name, id)}
        onSend={(text, imgs, files, mode) => void send(client, agent.name, text, imgs, files, onAuthLost, mode)} onStop={() => stop(agent.name, client)} onLocal={local} onModel={onModel} onChoices={(command, options) => openPicker({ agent: agent.name, session: c.session, kind: 'choice', command, options })} />
      {viewer && <MediaViewer item={viewer} onClose={() => setViewer(null)} />}
    </section>
    </DiagnoseContext.Provider></MediaContext.Provider>
  );
}
export { chatOf };
