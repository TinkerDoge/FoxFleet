import { useEffect, useRef, useState } from 'preact/hooks';
import type { Client } from '../api/client';
import type { AgentSummary } from '../api/types';
import { Composer } from './Composer';
import { Markdown, Message } from './Message';
import { MediaViewer, type MediaItem } from '../components/MediaViewer';
import { chatOf, loadAgent, newChat, openSession, send, stop, useChat } from './store';
import type { LocalCommand } from '../lib/commands';
import { t } from '../i18n/t';

export function statusLine(agent: string, tool: string | undefined, _hasText: boolean, hasReasoning: boolean): string | null {
  if (tool) return t('chat.usingTool', { tool });
  return hasReasoning ? t('chat.thinking', { agent }) : t('chat.working', { agent });
}

export function ChatView({ client, agent, onAuthLost }: { client: Client; agent: AgentSummary; onAuthLost: () => void }) {
  const c = useChat(agent.name);
  const [viewer, setViewer] = useState<MediaItem | null>(null), [sessionsOpen, setSessionsOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null), stick = useRef(true);
  useEffect(() => { void loadAgent(client, agent.name, onAuthLost); }, [agent.name]);
  useEffect(() => { const el = scroller.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [c.messages, c.streamText, c.streamReasoning, c.tool, agent.name]);
  const local = (cmd: LocalCommand) => { if (cmd === 'new') newChat(agent.name); else if (cmd === 'stop') stop(agent.name); else setSessionsOpen(true); };
  const status = c.streaming ? statusLine(agent.displayName || agent.name, c.tool, c.streamText.length > 0, c.streamReasoning.length > 0) : null;
  const name = agent.displayName || agent.name;
  return (
    <section class="chat" aria-label={name}>
      <header class="chat-head">
        <span class={`dot ${agent.online ? 'on' : 'off'}`} aria-hidden="true" />
        <div class="grow"><b>{name}</b><small class="muted">{status ?? (agent.online ? t('chat.online') : t('chat.offline'))}</small></div>
        <button class="btn text" onClick={() => newChat(agent.name)}>{t('chat.new')}</button>
        {agent.capabilities?.sessions !== false && <button class="btn text" aria-expanded={sessionsOpen} onClick={() => setSessionsOpen(!sessionsOpen)}>{t('chat.sessions')}</button>}
      </header>
      {sessionsOpen && (
        <div class="sessions card" role="menu">
          {c.sessions.length === 0 && <p class="muted small">{t('chat.noSessions')}</p>}
          {c.sessions.map((s) => <button key={s.id} role="menuitem" class={s.id === c.session ? 'on' : ''} onClick={() => { setSessionsOpen(false); void openSession(client, agent.name, s.id, onAuthLost); }}>{s.title || s.id}</button>)}
        </div>
      )}
      <div class="messages" ref={scroller} onLoadCapture={() => { const el = scroller.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }} onScroll={(e) => { const el = e.currentTarget as HTMLElement; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }} aria-live="off">
        {c.loading && <p class="muted center">{t('home.loading')}</p>}
        {!c.loading && c.messages.length === 0 && !c.streaming && <div class="empty"><p>{t('chat.empty', { agent: name })}</p></div>}
        {c.messages.map((m, i) => <Message key={i} m={m} onMedia={setViewer} />)}
        {c.streaming && (
          <div class="msg assistant">
            {c.streamReasoning && <details class="reasoning" open={!c.streamText}><summary>{t('chat.reasoning')}</summary><div class="md plain">{c.streamReasoning}</div></details>}
            {c.streamText && <Markdown text={c.streamText} onMedia={setViewer} />}
            {status && <p class="status shimmer" role="status" aria-live="polite">{status}<span class="dots" aria-hidden="true" /></p>}
          </div>
        )}
        {c.error && <div class="card error-card" role="alert"><p class="error">{c.error}</p></div>}
      </div>
      <Composer client={client} agent={agent} history={c.messages} streaming={c.streaming} skills={c.skills} draftKey={agent.name + (c.session ?? '')}
        onSend={(text, imgs, files) => void send(client, agent.name, text, imgs, files, onAuthLost)} onStop={() => stop(agent.name)} onLocal={local} />
      {viewer && <MediaViewer item={viewer} onClose={() => setViewer(null)} />}
    </section>
  );
}
export { chatOf };
